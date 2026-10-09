/**
 * 知识库级可见性判定 —— 纯函数，无副作用、不碰数据库。
 *
 * 4.6：把知识库的隔离从**租户级**下沉到**库级**。
 *
 * `knowledge_bases.visibility` 两个取值（0001 的租户隔离之上再加一层）：
 *
 *     tenant     —— 全租户成员可见（**默认**，升级前行为逐字不变）
 *     restricted —— 只有被显式授权的主体可见
 *
 * 判定语义（四条，顺序即优先级 —— 改这里等于改安全边界，测试穷举钉住）：
 *
 *   1. **受限库 且 未授权 且 非管理员 → 不可见。** 这是本模块存在的全部理由。
 *   2. **管理员（owner / admin）对任何库可见。** 这不是特权，是**防自锁**：
 *      管理员把库设为受限后，若自己也被挡在外面，就再没有任何入口把库改回来 ——
 *      一次"以为很安全的设置"会把数据变成只有改数据库才能访问的孤岛。
 *      （与 `setUserRoles` 的"不许把最后一个 owner 降权"是同一条思路。）
 *   3. **授权在**范围内**放宽，不影响范围外。** 库级角色与全局角色**取并集**，
 *      而不是替换：某人全局是 member（只能读），在某个库上被授了 admin，
 *      则他在**那个库**上能写，在别的库上依旧只能读。这个"并集只作用于本库"
 *      是本函数存在的意义 —— 若合成一个全局角色集，库级 ACL 就退化成了
 *      "把租户角色调一遍"，那等于没做。
 *   4. **读权限与"库级可见性"分层，别混。** 本函数判的是"这个库对这个人**可不可见**"
 *      （ACL 维度），以及"库内能到哪一档"；**能不能读内容**由路由层的
 *      `knowledge:read`（RBAC 维度）把守。因此 `tenant` 库对登录主体**恒可见**，
 *      而 `level` 只用来判**写 / 删**（`canAccessBase`）。把两件事揉在一起
 *      （"没 read 能力就不算可见"）会让 service 在"没有主体上下文的内部调用"
 *      里把**所有**库判成不可见 —— 一次口径混淆会同时污染列表、检索、状态三处。
 *
 * 为什么判定是纯函数：库列表 / 检索 / 文档详情三处都要调它，且它决定"能不能
 * 看见数据"。纯函数才能把"租户 / 受限 / 授权 / 管理员 / 角色档位"这些维度
 * **穷举**成表驱动的测试，而不是靠读代码推。查询职责留给调用方。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { can } from '../identity/permissions.mjs';

/** 合法取值。顺序即文档顺序；第一个是默认。 */
export const BASE_VISIBILITIES = ['tenant', 'restricted'];

/** 默认可见性 —— 与 0013 迁移的列默认值**必须一致**，两处都是"全租户可见"。 */
export const DEFAULT_BASE_VISIBILITY = 'tenant';

/** 永远能看见全部知识库的角色（防自锁，见头注释第 2 条） */
const ADMIN_ROLES = ['owner', 'admin'];

/**
 * 规范化可见性取值。
 *
 * 语义与 `keep` 那道约束同源（见 `operation/backup.mjs` 的 `normalizeKeep`）：
 * **"没有给" 与 "给了个非法值" 必须分开**，否则配置与行为对不上。
 *   · 没给（`undefined` / `null` / 空串）→ 用默认 `tenant`（调用方没意见）；
 *   · 给了但不认识 → **抛错**，而不是静默回退默认。静默回退的后果是：
 *     管理员写 `restricted` 时打错一个字母，系统安静地按**公开**处理 ——
 *     一个本意收紧的操作变成了放开，且没有任何提示。这类错必须当场报出来。
 *
 * @param {string|null|undefined} v
 * @returns {'tenant'|'restricted'}
 */
export function normalizeVisibility(v) {
  if (v == null || String(v).trim() === '') return DEFAULT_BASE_VISIBILITY;
  const s = String(v).trim().toLowerCase();
  if (!BASE_VISIBILITIES.includes(s)) {
    throw new Error('未知的可见性：' + v + '（只支持 ' + BASE_VISIBILITIES.join(' / ') + '）');
  }
  return s;
}

/** 该角色的知识能力档位：manage > write > read > none */
function knowledgeLevel(roles) {
  if (can(roles, 'knowledge', 'delete')) return 'manage';
  if (can(roles, 'knowledge', 'write')) return 'write';
  if (can(roles, 'knowledge', 'read')) return 'read';
  return 'none';
}

/**
 * 判定一个用户对一个知识库的访问。
 *
 * @param {object} input
 * @param {{visibility?:string}} input.base            知识库（缺 visibility 视为默认）
 * @param {string[]} [input.globalRoles]               该用户在**租户级**的角色 key
 * @param {string[]} [input.scopedRoleKeys]            该用户**在这个库上**被授的角色 key
 *                                                     （**已限定到本库**的 `string[]`，含经组获得的；
 *                                                     由调用方经 identity 展开。注意与 `visibleBases`
 *                                                     的入参不同 —— 那个是批量的 `{scopeId, roleKey}[]`）
 * @param {boolean} [input.isAdmin]                    是否 owner/admin（可从 globalRoles 推出，
 *                                                     显式传入便于调用方复用自己的判定）
 * @returns {{visible:boolean, level:string, reason:string}}
 *   level ∈ none | read | write | manage
 *   reason ∈ tenant | restricted_granted | restricted_admin | restricted_denied
 */
export function decideBaseAccess({ base, globalRoles = [], scopedRoleKeys = [], isAdmin = false } = {}) {
  const gRoles = (Array.isArray(globalRoles) ? globalRoles : []).filter((x) => typeof x === 'string');
  // ⚠️ 类型防御，不是洁癖：这里若混进 `{scopeId, roleKey}` 这类对象，`can()` 里的
  //    `String(rk)` 会得到 `"[object Object]"` → 被当"未知角色"跳过 → **静默**退化成
  //    只有全局档位。那种"授权看着没生效"的 bug 极难定位。**过滤掉非字符串元素**，
  //    让错误退化为**无库级授权**（fail-closed，安全侧），而不是伪装成一次正常判定。
  const sRoles = (Array.isArray(scopedRoleKeys) ? scopedRoleKeys : []).filter((x) => typeof x === 'string');
  const admin = isAdmin || ADMIN_ROLES.some((r) => gRoles.includes(r));
  const visibility = (base && base.visibility) ? String(base.visibility) : DEFAULT_BASE_VISIBILITY;

  // ① 开放库：全租户可见（可见性不看个体能力，见头注释第 4 条）；level 只影响"能写到哪一档"
  if (visibility !== 'restricted') {
    const level = knowledgeLevel(gRoles);
    return { visible: true, level, reason: 'tenant' };
  }

  // ② 受限库 + 管理员：始终可见（防自锁）
  if (admin) {
    return { visible: true, level: knowledgeLevel(gRoles), reason: 'restricted_admin' };
  }

  // ③ 受限库 + 有库级授权：全局 ∪ 库级（并集只作用于本库）
  if (sRoles.length) {
    const merged = [...new Set([...gRoles, ...sRoles])];
    const level = knowledgeLevel(merged);
    // 可见性由能力推出（头注释第 4 条）：授了一个没有 read 的角色 ≠ 可见
    return { visible: level !== 'none', level, reason: 'restricted_granted' };
  }

  // ④ 受限库 + 未授权 + 非管理员
  return { visible: false, level: 'none', reason: 'restricted_denied' };
}

/**
 * 批量过滤：从一组库里挑出该用户**可见**的那些。
 * 这是列表接口的落点 —— 让"看不见的库"在响应里**根本不存在**，
 * 而不是"返回了但前端不显示"（后者等于把数据发出去了）。
 *
 * @param {Array<{id:string, visibility?:string}>} bases
 * @param {{globalRoles?:string[], scopedRoles?:Array<{scopeId:string, roleKey:string}>, isAdmin?:boolean}} subject
 * @returns {Array<{base:object, level:string, reason:string}>} 可见库及其档位（保持入参顺序）
 */
export function visibleBases(bases, subject = {}) {
  const scopedRoles = Array.isArray(subject.scopedRoles) ? subject.scopedRoles : [];
  const byBase = new Map();
  for (const r of scopedRoles) {
    if (!r || !r.scopeId) continue;
    const arr = byBase.get(r.scopeId) || [];
    arr.push(r.roleKey);
    byBase.set(r.scopeId, arr);
  }
  const out = [];
  for (const b of (bases || [])) {
    if (!b || !b.id) continue;
    const verdict = decideBaseAccess({
      base: b,
      globalRoles: subject.globalRoles || [],
      scopedRoleKeys: byBase.get(b.id) || [],
      isAdmin: subject.isAdmin,
    });
    if (verdict.visible) out.push({ base: b, level: verdict.level, reason: verdict.reason });
  }
  return out;
}

/**
 * 该用户能否对**指定库**做某个知识动作。写路径（导入/删除/改可见性）用它，
 * 保证"看不见的库"同样"动不了"—— 否则会出现"列表里没有、但能凭 id 删掉"。
 *
 * @param {object} input 同 decideBaseAccess，另加 action
 * @param {'read'|'write'|'delete'} input.action
 */
export function canAccessBase({ action, ...rest }) {
  const v = decideBaseAccess(rest);
  // ⚠️ `visible` 必须一并带出：调用方要靠它区分"**不存在/不可见**（→404）"与
  // "**存在但档位不够**（→403）"。少了这个字段，`!undefined === true`，
  // 所有"档位不够"都会被说成"不存在"—— 功能上仍是否决（不泄漏存在性），
  // 但语义错了，而且会让"库不存在"与"你没权限"这两类问题再也分不开。
  const ctx = { visible: v.visible, level: v.level, reason: v.reason };
  if (!v.visible) return { allowed: false, ...ctx };
  const need = String(action || 'read');
  // 读：只要"看得见"就够（read 能力由路由层的 `knowledge:read` 把守，见头注释第 4 条）
  if (need === 'read') return { allowed: true, ...ctx };
  const rank = { none: 0, read: 1, write: 2, manage: 3 };
  // delete 需要 manage；write 需要 write 及以上
  const requiredRank = need === 'delete' ? 3 : need === 'write' ? 2 : 1;
  return { allowed: rank[v.level] >= requiredRank, ...ctx };
}

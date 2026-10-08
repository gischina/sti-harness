/**
 * 工作区服务 —— 对话工作台树状组织层的业务逻辑（0021 / 0.21.0）。
 *
 * 职责边界：
 *   · 工作区 CRUD 在这里。**工作区是纯组织容器**（0.21.6 起）—— 它只回答
 *     "把会话分堆放"，不回答"谁被允许做什么"；
 *   · 档位判定（纯函数）在 visibility.mjs —— **只按组织角色推导**，没有工作区级授权；
 *   · 会话守卫（`assertSessionAccess`）给 kernel 路由用：会话挂在工作区上之后，
 *     "能不能看 / 能不能改 / 能不能管"由档位说了算，只在这一层校验而不散进每个 handler。
 *
 * ── 0.21.6 删掉了什么，为什么 ─────────────────────────────────────────
 *
 * 删掉了：`visibility`（open / restricted）、工作区级授权名单（`listGrants` / `grant` /
 * `revokeGrant`，载体现已无引用）、以及随之而来的一整层判定分支。
 *
 * 理由（用户裁定，2026-10-06）：**上游 dsh 自己有一份工作区权限三档**。平台这一份是
 * 第二份真相，而平台**没有任何接口去改上游那一份** —— 两边永远对不上，在这里把人调成
 * "完全权限"，上游那侧一动不动。**一份改了不生效的权限配置比没有权限配置更糟**：
 * 它让人以为已经管住了。整块删掉，等想清楚怎么与上游对齐再回来做。
 *
 * 删掉后谁在把门：档位由组织角色推导（见 visibility.mjs 的 `levelFromRoles`），
 * 路由层仍由 `session:read` / `session:write` / `session:execute` 把守。
 * **门禁没有消失，消失的是"这个工作区单独授权"这一层。**
 *
 * 两条不可破的口径（写进 architecture.md §7.12，这里只留短注）：
 *   · **工作区不是上游实体** —— 上游没有工作区 RPC，本服务从不向上游同步；
 *   · **档位是平台自己的访问档** —— 不是上游 permission/preset（那是另一码事，别混）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import * as wsRepo from '../../data/repositories/workspaces.mjs';
import * as sessions from '../../data/repositories/sessions.mjs';
import { all, get } from '../../data/db.mjs';
import { errors } from '../../util/errors.mjs';
import { levelFromRoles, levelAtLeast } from './visibility.mjs';

/** 三档的展示名 —— 只用于**服务端报错文案**（0.21.6 起前端不再展示档位徽片） */
export const LEVEL_LABELS = { view: '仅可查看', write: '工作区内修改', full: '完全权限' };

/**
 * 初始化时自动建立的那个工作区的名字。
 *
 * ⚠️ 0.21.9 起它**不能改名**（用户 2026-10-08 裁定）：这个工作区是所有会话的
 * **兜底去处** —— 删掉任何一个工作区，里面的会话都落进它。能给它改名或把它删掉，
 * "落点"就没有保证了（`is_default` 那一行）。判定"补不补"仍然只看有没有，不看叫什么。
 */
export const DEFAULT_WORKSPACE_NAME = '默认工作区';
export const DEFAULT_WORKSPACE_DESC = '初始化时自动建立 —— 新会话默认落在这里；删除别的工作区时，里面的会话也落回这里。因此它不能重命名、不能删除。';

/* ── DEFAULT_SESSION_TITLE：整块删除（0.21.9）────────────────────────────
 *
 * 这里曾有 `DEFAULT_SESSION_TITLE = '新会话'`，配合下面的 `seedPlaceholderSession`
 * 在默认工作区里播一条**落脚会话**。
 *
 * 用户 2026-10-08 裁定：**默认会话直接删掉；初始化后只有默认工作区，不再有默认会话。**
 *
 * 删掉的两个理由（第二个才是决定性的）：
 *   · 空树焦虑**另有更好的解法**：0.21.6 加它是因为"新装平台左栏是空树，用户以为坏了"。
 *     但现在工作台上那棵树上挂着默认工作区**本身**（有名字、有工作目录、有行尾的「＋」），
 *     左栏根本不是空的 —— 用"替你建一条没内容、没上游会话的会话"来消除焦虑，
 *     代价是用户得先删掉它才能开始，比空树更烦。
 *   · 它是一条**假会话**：`kernel_session_id` 为空、上游那份要等用户第一次发言才补建
 *     （见 kernel 路由的 `requireSession`）。为了填一格空白而种一条"看起来建成了、
 *     其实还没建成"的记录，正是本项目一直在删的那类东西。
 *
 * ⚠️ 删的是**播种动作**，不是能力：`ensureDefaultWorkspace` 仍会建默认工作区
 *    （平台需要一个落点，否则新会话无处可放）；`requireSession` 的"按需补建上游会话"
 *    也原样保留 —— 它对**任何**本地行早于上游的会话都有用，不只是这条被删掉的落脚的。
 *    老库里已经播出来的那条会话**不主动清**（见 ensureDefaultWorkspace 的说明）。
 */

export function createWorkspaceService(deps = {}) {
  const { audit } = deps;

  /** 主体上下文：`{userId, roles}`。roles 是租户级角色 key（middleware/auth.mjs 注入）。 */
  function normSubject(subject) {
    const s = subject || {};
    return { userId: s.userId || null, roles: Array.isArray(s.roles) ? s.roles : [] };
  }

  function auditAppend(subject, action, resourceType, resourceId, detail) {
    if (!audit) return;
    audit.append({
      tenantId: subject?.tenantId || null,
      userId: subject?.userId || null,
      action, resourceType, resourceId,
      result: 'ok',
      detail: detail || {},
    });
  }

  /**
   * 这个人在工作区里的档位 —— **只看组织角色**（0.21.6）。
   *
   * 从前还要把"他在这个工作区上被授了什么"并进来；那一层删了之后，这里的
   * 答案就是 `levelFromRoles(角色)`，所以整件事收敛成一行。
   */
  function levelOf(subject) {
    return levelFromRoles(normSubject(subject).roles);
  }

  /**
   * 校验工作区访问，返回 `{ws, level}`；不通过则抛错。
   *
   * 签名与语义（0.21.6 起）：
   *   · 工作区**不存在** → 404（这条没变）；
   *   · 档位不够 → 403。
   *   · ⚠️ 从前还有一条"存在但不可见 → 也返回 404"（受限工作区）。**那条随可见性一起删了** ——
   *     工作区现在对全组织可见，而 404 在这里只剩下"真的没有这个 id"一种含义。
   *
   * @param {'view'|'write'|'full'} need 档位需求：view=读树/读会话；write=发回合/建会话；full=管别人的会话
   */
  function assertWorkspaceAccess(tenantId, workspaceId, subject, need = 'view') {
    const ws = wsRepo.getWorkspace(tenantId, workspaceId);
    if (!ws) throw errors.notFound('工作区不存在：' + workspaceId);
    const level = levelOf(subject);
    if (!levelAtLeast(level, need)) {
      throw errors.forbidden('对工作区「' + ws.name + '」没有该操作的权限（当前档位：'
        + (LEVEL_LABELS[level] || level) + '，需要：' + (LEVEL_LABELS[need] || need) + '）');
    }
    return { ws, level };
  }

  /**
   * 兜底工作区（`is_default = 1`）。取不到返回 undefined —— 那是"这个租户还没有
   * 任何工作区"（新装、播种之前），调用方各自按语义处理，**不在这里编一个假的**。
   */
  function defaultWorkspaceOf(tenantId) {
    try { return wsRepo.getDefaultWorkspace(tenantId); } catch (e) { return undefined; }
  }

  /**
   * 会话守卫：会话挂在工作区上之后，读/写/管按档位判。
   *
   * ⚠️ **0.21.9 删掉了"未分组一律放行"那条**。它从前是这么写的：
   *   「未分组会话（workspace_id 为空）一律放行 —— 行为与 0.20.1 逐字不变」。
   * 那句话在 0021 引入工作区时是合理的向后兼容（老数据本来就没有归属），
   * 但它同时是一处**看不见的暗门**：进了工作区的会话按档位判，没进工作区的
   * 反而人人可管（`sessionManageRight` 对它直接 can:true）—— 没有档位就等于没有门。
   * 用户 2026-10-08 问"未分组有意义吗"之后，整块删掉：删除工作区时会话落进
   * **默认工作区**，存量空归属由迁移 0024 归位 + 启动对账，所以"没有归属"
   * 在新数据里不可达，老数据里也已经被清干净。
   *
   * 残留的空归属（理论上只剩"租户还没有任何工作区"这一种退化态）按**默认工作区**
   * 判；连默认工作区都没有时放行 —— 那时整棵树还不存在，档位无从谈起，
   * 而这与 0.20.1 的行为一致。这条分支因此**不是后门**：它在正常状态下不可达。
   *
   * @param {'view'|'write'|'full'} need  view=读（events/export/附件列表/检索）；
   *                                      write=发回合/选模型/挂库/传附件/改名删自己的；
   *                                      full=改名删除**别人的**会话与移动他人会话
   */
  function assertSessionAccess(tenantId, sessionRow, subject, need = 'view') {
    if (!sessionRow) return { level: null };
    let wsId = sessionRow.workspace_id;
    if (!wsId) {
      const def = defaultWorkspaceOf(tenantId);
      if (!def) return { level: null };
      wsId = def.id;
    }
    const { ws, level } = assertWorkspaceAccess(tenantId, wsId, subject, need);
    return { ws, level };
  }

  /** 判"这是不是我的会话"（write 档只能动自己的会话，full 才能动别人的） */
  function isOwnSession(sessionRow, subject) {
    const sub = normSubject(subject);
    return !!(sub.userId && sessionRow && sessionRow.owner_user_id === sub.userId);
  }

  /**
   * 一条会话我能不能管（改名 / 删除 / 移动），以及这件事需要什么档位。
   *
   * 为什么要抽成服务层的一个函数：**列表页的回显与动作路由的守卫必须是同一个判据**。
   * 两边各写一遍这条规则（"自己的会话 write 就够、别人的要 full"）迟早漂移，
   * 那时用户看到的就是"按钮亮着，点下去 403"—— 一次看起来像产品坏了的交互。
   *
   * @returns {{need:'write'|'full'|null, can:boolean, reason:string}}
   *   need   —— 这个动作需要的档位（我自己的会话 write；别人的 full）
   *   can    —— 当前主体能不能做
   *   reason —— own / granted / denied
   *             ⚠️ 0.21.9 删掉了 `ungrouped` 这一档（那时它意味着"无档位 = 放行"，
   *                是一条暗门）。现在没有会话是"没有工作区"的 —— 空归属一律按
   *                默认工作区判，见 `assertSessionAccess`。
   */
  function sessionManageRight(tenantId, sessionRow, subject) {
    if (!sessionRow) return { need: null, can: false, reason: 'denied' };
    const mine = isOwnSession(sessionRow, subject);
    const need = mine ? 'write' : 'full';
    try {
      assertSessionAccess(tenantId, sessionRow, subject, need);
      return { need, can: true, reason: mine ? 'own' : 'granted' };
    } catch (e) {
      return { need, can: false, reason: 'denied' };
    }
  }

  /**
   * 批量版：一次把一屏会话的"能不能管"算完，返回 `Map<sessionId, right>`。
   *
   * 逐条调 `sessionManageRight` 结果一样，但每条都要重算一遍档位。这里按
   * `工作区 × 是不是我的` 去重 —— 判定的输入只有这两样，结果必然相同。
   */
  function manageRightsFor(tenantId, sessionRows, subject) {
    const memo = new Map();
    const out = new Map();
    for (const r of (sessionRows || [])) {
      if (!r || !r.id) continue;
      // `key` 里用 `|-` 表示"空归属"（0.21.9：它按默认工作区判，去重键不能与
      // 某个真实 workspace_id 撞上 —— 空串会与"workspace_id 为空串"撞，
      // 而那种行在新数据里不存在，撞了也不会有人发现）。
      const key = (r.workspace_id || '|-') + '|' + (isOwnSession(r, subject) ? '1' : '0');
      let right = memo.get(key);
      if (!right) { right = sessionManageRight(tenantId, r, subject); memo.set(key, right); }
      out.set(r.id, right);
    }
    return out;
  }

  // ── 查询 ────────────────────────────────────────────────────────────

  /**
   * 工作区树数据：**全部**工作区 + 各自会话数。
   *
   * 0.21.6 起不再过滤（从前按可见性 + 授权把"看不见的"筛掉）—— 工作区是全组织可见的
   * 组织容器。也不再下发 `myLevel` / `grantRoles` / `levelLabels`：那是给已删除的
   * 权限界面用的，留着只会让前端有东西可渲染。
   *
   * 0.21.9：`ungroupedCount` 去掉（那个桶整个不存在了），换成 `isDefault` 与
   * `defaultWorkspaceId` —— 前端要靠它们做两件事：**兜底工作区那一行不摆"重命名/删除"**
   * （摆了点了必然 400，读起来像产品坏了），以及删工作区的确认语里说清"会话会移进
   * 「默认工作区」"时那个名字是哪来的。
   */
  function listTree(tenantId) {
    const rows = wsRepo.listWorkspaces(tenantId);
    const counts = wsRepo.countSessionsByWorkspace(tenantId);
    const items = rows.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      cwd: workspace.cwd,
      description: workspace.description,
      ownerUserId: workspace.owner_user_id,
      sessionCount: counts.get(workspace.id) || 0,
      isDefault: !!workspace.is_default,
      createdAt: workspace.created_at,
      updatedAt: workspace.updated_at,
    }));
    const def = items.find((x) => x.isDefault);
    return { items, defaultWorkspaceId: def ? def.id : '' };
  }

  // ── 管理 ────────────────────────────────────────────────────────────

  function createWorkspace({ tenantId, subject, name, cwd = '', description = '' }) {
    const sub = normSubject(subject);
    const n = String(name || '').trim();
    if (!n) throw errors.badRequest('缺少工作区名称');
    if (n.length > 120) throw errors.badRequest('工作区名称过长（≤120 字符）');
    const row = wsRepo.createWorkspaceRow({
      tenantId, ownerUserId: sub.userId, name: n,
      cwd: String(cwd || '').trim(), description: String(description || '').trim(),
    });
    auditAppend({ tenantId, userId: sub.userId }, 'workspace.create', 'workspace', row.id, { name: n });
    return row;
  }

  function updateWorkspace({ tenantId, workspaceId, subject, patch }) {
    const sub = normSubject(subject);
    const { ws } = assertWorkspaceAccess(tenantId, workspaceId, subject, 'full');
    const next = {};
    if (patch.name !== undefined) {
      const n = String(patch.name || '').trim();
      if (!n) throw errors.badRequest('工作区名称不能为空');
      if (n.length > 120) throw errors.badRequest('工作区名称过长（≤120 字符）');
      // 兜底工作区不能改名（0.21.9，用户裁定）：它是"删工作区时会话落到哪"的答案，
      // 而那个答案要能被人一眼认出来。「默认工作区」这个名字就是那个标识。
      // ⚠️ 只在**真的要改**时才拦：`n === ws.name` 的重放请求（前端有时会把原值
      //    一起 PATCH 回来）不该被拒 —— 拦"没变的东西"只会让人以为接口坏了。
      if (ws.is_default && n !== ws.name) {
        throw errors.forbidden('「' + ws.name + '」是兜底工作区：删除别的工作区时，里面的会话会落进它，'
          + '因此它不能重命名（改名之后"会话会落到哪"就没有稳定的答案了）。'
          + '要换一个常用工作区，请另建一个。');
      }
      next.name = n;
    }
    if (patch.cwd !== undefined) {
      const c = String(patch.cwd || '').trim();
      if (c.length > 512) throw errors.badRequest('工作目录过长（≤512 字符）');
      next.cwd = c;
    }
    if (patch.description !== undefined) next.description = String(patch.description || '').trim();
    const row = wsRepo.touchWorkspace(tenantId, workspaceId, next);
    auditAppend({ tenantId, userId: sub.userId }, 'workspace.update', 'workspace', workspaceId,
      { patch: Object.keys(next) });
    return row;
  }

  /**
   * 删除工作区：**会话不级联** —— 原地保留，改挂到**默认工作区**（0.21.9，用户裁定）。
   * 删的是组织容器，不是里面的人。
   *
   * 0.21.9 改了两件事，都不是润色：
   *   · 落点从"未分组"（`workspace_id = NULL`）改成默认工作区。空归属那一桶整个删了，
   *     理由见 `assertSessionAccess` 上方那段；
   *   · **兜底工作区本身不能删**。它要是能被删掉，"落点"就没有保证了 ——
   *     删 A 时落进 B，紧接着把 B 删掉，里面的会话就没有去处。
   */
  function deleteWorkspace({ tenantId, workspaceId, subject }) {
    const sub = normSubject(subject);
    const { ws } = assertWorkspaceAccess(tenantId, workspaceId, subject, 'full');
    if (ws.is_default) {
      throw errors.forbidden('「' + ws.name + '」是兜底工作区：删除别的工作区时，里面的会话会落进它。'
        + '把它删掉，那些会话就没有去处了 —— 所以它不能删除。');
    }
    const def = defaultWorkspaceOf(tenantId);
    if (!def) {
      // 走到这里说明库里一个兜底工作区都没有（正常状态下不可达：启动播种会补）。
      // 此时**不删**：删了就等于把会话丢进空归属，而那正是这一版要消掉的状态。
      throw errors.conflict('本组织还没有兜底工作区（默认工作区），无法安置「' + ws.name
        + '」里的会话 —— 请先重启平台让播种补一个，再删。');
    }
    const moved = wsRepo.moveSessionsTo(tenantId, workspaceId, def.id);
    wsRepo.deleteWorkspaceRow(tenantId, workspaceId);
    auditAppend({ tenantId, userId: sub.userId }, 'workspace.delete', 'workspace', workspaceId,
      { name: ws.name, movedSessions: moved, toWorkspaceId: def.id });
    return { deleted: true, movedSessions: moved, toWorkspaceId: def.id, toWorkspaceName: def.name };
  }

  /**
   * 会话在工作区之间移动（写给目标工作区的 write 档）。
   *
   * 0.21.9：`toWorkspaceId` **必填** —— 从前传空表示"移出到未分组"，而那个去处
   * 已经不存在了。空值在这里直接 400，而不是悄悄塞进默认工作区：用户点的是
   * "移动到…"，界面也不再提供这个选项，能走到这里就是调用方写错了，
   * 静默替他选一个目标会让"这条会话为什么在这个工作区里"变成一个查不清的问题。
   */
  function moveSession({ tenantId, sessionRow, subject, toWorkspaceId }) {
    const to = String(toWorkspaceId == null ? '' : toWorkspaceId).trim();
    if (!to) throw errors.badRequest('移动会话必须给出目标工作区（已没有"移出到未分组"这回事）');
    assertWorkspaceAccess(tenantId, to, subject, 'write');
    return sessions.touchSession(tenantId, sessionRow.id, { workspace_id: to });
  }

  // ── 初始化：只建默认工作区（0.21.1；落脚会话在 0.21.9 删除）────────────
  //
  // 为什么需要它：新装的平台一个工作区也没有，工作台左栏就是一棵空树 ——
  // 用户的第一反应是"这东西坏了"，而不是"我要先建一个工作区"。而工作区的 cwd
  // 又决定上游项目级能力能读写哪一片文件系统，所以这个默认值必须由**运行时的
  // 路径推导**给出（`paths.mjs` 的 WORKSPACE_DIR），不能写死在源码或 SQL 里。
  //
  // 与 `schedule.ensureDefaults` 同一条思路：**只在"空"的时候补**，已经有就一步不动。
  // 也因此它可以在每次启动跑：判定是几次 SELECT，不写库。
  //
  // ⚠️ 0.21.9：这里**不再**顺手播一条落脚会话（用户裁定：初始化后只有默认工作区）。
  //    连带 `platformUnused` 这个判据也没了 —— 它只服务于"要不要补落脚会话"这一件事。
  //    老库里已经播出来的那条**不主动清**：删用户的东西比留一条多余的行危险得多，
  //    真嫌它碍事，会话行的「⋯」→「删除会话」就是为这件事准备的。

  /** 组织的第一个用户（= 初始化时的 owner）—— 默认工作区把 owner 记成他，防自锁 */
  function firstUserIdOf(tenantId) {
    try {
      const r = get('SELECT id FROM users WHERE org_id = ? ORDER BY created_at, username LIMIT 1', [tenantId]);
      return r ? r.id : null;
    } catch (e) {
      return null;
    }
  }

  /* ── seedPlaceholderSession / platformUnused：整块删除（0.21.9）────────────
   *
   * 这里曾有两个函数：
   *   · `seedPlaceholderSession` —— 在某个工作区里放一条空会话当落脚点
   *     （`kernel_session_id` 刻意留空、不在这里建上游会话，理由见下）；
   *   · `platformUnused` —— "这个租户一条会话都没有？"，只服务于"要不要补落脚会话"。
   *
   * 用户 2026-10-08 裁定**默认会话直接删掉**，两者随之删除（完整理由见文件顶部
   * `DEFAULT_SESSION_TITLE` 那段）。保留在记忆里的一条判断是这个函数注释里写对的部分：
   *   **"本地会话行是平台侧的身份，上游会话是按需建立的"** —— 这条口径没变，
   *   它现在由 `kernel.mjs` 的 `requireSession` 单独承担（任何本地行早于上游的会话都走它）。
   * 当初写错的是**推论**：既然本地行可以先于上游存在，就顺手种一条 —
   * 能被种出来的那条"会话"，用户打开它看到的是一格空白，而不是一次对话。
   */

  /**
   * 把仍没有归属的会话挂进兜底工作区（幂等）。
   *
   * 迁移 0024 已经把存量清过一遍了，这一步是补它够不着的那种租户：
   * **迁移跑的时候还没有工作区**（新装 —— main.mjs 里 migrate 在前、播种在后），
   * 他们的默认工作区是启动播种才建的。播种完立刻调一次这里，空归属就清零。
   *
   * 为什么不做成"随时兜底"（比如在列表查询里把空归属当成默认工作区）：
   * 那是把一次性的数据修整摊成一条永久分支 —— 分支会一直在，而"什么时候会有空归属"
   * 就没人说得清了。这里一次性修完，之后空归属只剩"退化态"一种解释。
   */
  function attachOrphansToDefault(tenantId, workspaceId) {
    try { return wsRepo.attachOrphanSessions(tenantId, workspaceId); } catch (e) { return 0; }
  }

  /**
   * 给一个租户补默认工作区（幂等）。
   *
   * ⚠️ 0.21.9：**只建工作区，不建会话**（用户裁定：初始化后只有默认工作区）。
   *    这个函数从前还会在里面顺手播一条落脚会话，那一整块已删除 —— 见本文件顶部
   *    `DEFAULT_SESSION_TITLE` 那段说明。
   *
   * @returns {object|null} 新建的工作区行；已有工作区则 null（调用方据此决定要不要报一句）
   */
  function ensureDefaultWorkspace({
    tenantId, ownerUserId = undefined, cwd = '', name = DEFAULT_WORKSPACE_NAME,
  } = {}) {
    if (!tenantId) return null;
    const existing = wsRepo.listWorkspaces(tenantId);
    if (existing.length) {
      // 已经有工作区：一步不动 —— 除了一件事。
      //
      // ⚠️ 0.21.9：这一支**必须先补 is_default**。老库（0024 之前建的）里可能一条
      //    兜底工作区都没有 —— 0024 只标"当时存在的最早那条"，而如果那个租户当时
      //    一条工作区也没有（迁移先跑、播种后跑），它就是空的，之后再也不会被标上。
      //    补法是就地标**最早建的那一条**（与 0024 同一条判据），不新建：
      //    否则每次启动都会长出一个「默认工作区」。
      if (!defaultWorkspaceOf(tenantId)) {
        const oldest = existing.slice()
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
        if (oldest) wsRepo.markDefaultWorkspace(tenantId, oldest.id);
      }
      const def = defaultWorkspaceOf(tenantId) || existing[0];
      // 空归属的存量会话挂进兜底工作区（0024 够不着"迁移时还没有工作区"的租户）
      if (def) attachOrphansToDefault(tenantId, def.id);
      // ⚠️ 0.21.9：这里从前还有一段"全平台零会话就补一条落脚会话"（判据是
      //    `platformUnused`，刻意定成"全平台"而不是"这个工作区"，为的是不去打扰
      //    被用户清空过的工作区）。排掉落脚会话之后它没有别的用途了，整段删除。
      //    判据本身值得记一笔：**"零会话"是"从没被用过"的唯一诚实判据** ——
      //    换成"这个工作区零会话"就会往人家刚清空的地里反复塞东西。哪天要再加
      //    "空就补点什么"，先回来读这一句。
      return null;
    }
    const owner = ownerUserId === undefined ? firstUserIdOf(tenantId) : (ownerUserId || null);
    const row = wsRepo.createWorkspaceRow({
      tenantId, ownerUserId: owner, name, cwd, description: DEFAULT_WORKSPACE_DESC,
      isDefault: true,
    });
    auditAppend({ tenantId, userId: owner }, 'workspace.default.seed', 'workspace', row.id, { name, cwd });
    attachOrphansToDefault(tenantId, row.id);
    return row;
  }

  /**
   * 启动播种（与 `schedule.ensureDefaultsForAllTenants` 同形）：给还没有工作区的组织各补一个。
   *
   * ⚠️ 副作用说清：如果你把某个组织的工作区**全删了**，下次启动会再得到一个默认工作区。
   *    这是有意的 —— 平台需要一个落点（否则新会话无处可放），
   *    而"用一张表记住我补过了"换来的只是"删光之后树永远是空的"。
   *    真不想要它，改名留用即可。
   *
   * 0.21.9：它**不再连带**播一条落脚会话（用户裁定，见文件顶部 DEFAULT_SESSION_TITLE），
   * 所以"删光工作区"的后果只剩"树里重新长出一个空的默认工作区"这一条。
   */
  function ensureDefaultsForAllTenants({ cwd = '' } = {}) {
    let tenants = [];
    try { tenants = all('SELECT id FROM orgs', []).map((r) => r.id); } catch (e) { tenants = []; }
    const out = {};
    for (const t of tenants) out[t] = ensureDefaultWorkspace({ tenantId: t, cwd });
    return out;
  }

  return {
    listTree, createWorkspace, updateWorkspace, deleteWorkspace, moveSession,
    assertWorkspaceAccess, assertSessionAccess, isOwnSession,
    sessionManageRight, manageRightsFor, levelOf,
    defaultWorkspaceOf, attachOrphansToDefault,
    ensureDefaultWorkspace, ensureDefaultsForAllTenants,
  };
}

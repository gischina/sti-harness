/**
 * 工作区档位推导 —— 纯函数，无副作用、不碰数据库。
 *
 * ── 0.21.6：这个文件曾经有一半是权限模块，那一半删掉了 ───────────────────
 *
 * 从前这里有 `visibility`（open / restricted）与工作区级三档授权：工作区可以建成
 * "仅授权可见"，授权名单复用 `role_bindings`（scope_type='workspace'），
 * 档位是绑定角色的派生值（见 0021_workspaces.sql 与 git 历史）。
 *
 * 删掉它的理由（用户裁定，2026-10-06）：**上游 dsh 自己就有一份工作区权限三档**。
 * 平台这一份是**第二份真相**，而平台**没有任何接口去改上游那一份** ——
 * 于是两边永远对不上：在这里把人调成"完全权限"，上游那侧一动不动。
 * **一份改了不生效的权限配置，比没有权限配置更糟**：它让人以为已经管住了。
 *
 * 所以整块删除：界面、接口、授权名单、可见性一起。等想清楚怎么与上游对齐
 * 再回来做（用户的原话是"先删除啦后面再想想怎么做"）。
 *
 * ── 删完剩下什么 ──────────────────────────────────────────────────────
 *
 * 只剩一个问题：**这个人在这块地上能做什么**。答案由组织角色直接推导
 * （`levelFromRoles`）—— 工作区不再有独立授权，也就不再有"改了不生效"那一层。
 * 工作区退化成**纯组织容器**（一个文件夹），它的语义只剩"把会话分堆放"。
 *
 * 「档位」这个词保留下来，是因为 `assertSessionAccess` 要靠它表达一条规则：
 * **自己的会话 write 就够，别人的要 full**（见 service.mjs）。
 * 判定仍是纯函数，仍可穷举成表驱动测试。
 *
 * ── 与平台 RBAC 的分层（未变）─────────────────────────────────────────
 *
 * 本函数判"这个人对工作区的档位到哪"；能不能调 HTTP 由路由层的 `session:read`
 * 等能力把守。两件事不揉在一起（揉了的后果见 knowledge/visibility.mjs 头注释第 4 条）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { can } from '../identity/permissions.mjs';

/** 档位。展示名在服务层给（view→仅可查看 / write→工作区内修改 / full→完全权限）。 */
export const WORKSPACE_LEVELS = ['none', 'view', 'write', 'full'];

/**
 * 档位从**会话能力**推导：full ← session:delete、write ← session:execute、view ← session:read。
 *
 * 为什么用会话能力而不是新造一个 workspace:* 资源：三档的语义本来就是
 * "在这个工作区里能对**会话**做什么"（看 / 改 / 管到底），会话能力就是它的本义；
 * 新造资源等于让平台同时维护两套"谁能干什么"的真相。
 * 内置角色推导结果：owner→full、admin→full（session:delete 已显式授予）、
 * member→write、viewer→view、未知→none。
 *
 * ⚠️ 未知角色一律推导成 `none`（`can()` 对不认识的角色返回 false）——
 *    数据库里若出现一个拼错的角色 key，不能因此变成"人人有份"。
 */
export function levelFromRoles(roles) {
  const rs = (Array.isArray(roles) ? roles : []).filter((x) => typeof x === 'string');
  if (can(rs, 'session', 'delete')) return 'full';
  if (can(rs, 'session', 'execute')) return 'write';
  if (can(rs, 'session', 'read')) return 'view';
  return 'none';
}

const RANK = { none: 0, view: 1, write: 2, full: 3 };

/** 档位比较：当前档是否够某个动作。view=读；write=写/发回合；full=管别人的会话。 */
export function levelAtLeast(level, need) {
  return (RANK[String(level)] || 0) >= (RANK[String(need)] || 0);
}

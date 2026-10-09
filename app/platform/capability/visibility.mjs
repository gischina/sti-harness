/**
 * 能力可见性判定 —— 纯函数，无副作用、不碰数据库。
 *
 * 治理层级（0.21.10 起是**二级**，见下）：
 *
 *     connection（连接） → server（服务）
 *                          └─ skill（Skill 本身，二级）
 *
 * 语义（三条，顺序即优先级 —— 改这里等于改安全边界，测试穷举钉住）：
 *   1. **显式 deny 永远赢**：血缘上任一层（connection / server / 能力本身）存在
 *      `allow = 0` 的绑定 → 不可见。哪怕另一层写了 allow —— 收紧必须立即生效，
 *      " allow 覆盖 deny "会造成排查地狱。
 *   2. **登记开关（skills.enabled）是第二道闸**：没有绑定说话时，看登记表。
 *      管理员把 Skill 停用（enabled=0）→ 不可见，reason = registry_disabled。
 *   3. **默认放行**：无绑定、登记启用 → 可见。拦截必须是显式动作
 *      （与 tool_policies 审批门同一设计哲学：默认 allow，防误伤）。
 *
 * ── 0.21.10：「工具」作为一级治理对象**整块删除** ─────────────────────
 *
 * 用户裁定：「工具是在内核自己调用，不用单独写这个能力，而且不会单独列出来有哪些工具」。
 * 于是 `tool` 不再是一级可治理对象（`BINDING_LEVELS` 去掉它、`decideToolVisibility`
 * 与 `tools.enabled` 那道闸一并删除）。**保留的是机制，不是概念** ——
 * Skill 与 MCP 都还需要"按血缘做 deny + 登记开关 + 默认放行"这三条，
 * 所以它们各自持有一份自己的判定，而不是共用"工具"那一份。
 *
 * ⚠️ 为什么当初能共用、现在必须拆开：因为三者**血缘形状不同**。
 *   工具曾有 tool → server → connection 三层，所以那套函数最复杂、被复用了；
 *   但 Skill 与 MCP 各自只有一层（skill 本身 / server 本身）。
 *   复用等于让"最简单的两件事"套上"最复杂那件"的形状 —— 工具一删，
 *   它们就会随 `decideToolVisibility` 一起消失。现在各归各位：
 *   Skill 只判自己，MCP 只判 server 那层。
 *
 * 为什么判定不读库：读库的版本没法穷举测试，而且「契约层 gate」每次
 * listSkills / listMcpServers 都要调它 —— 保持纯函数，查询职责留给调用方。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */

/** 合法的绑定层级。capability_bindings.capability_type 的值域（0001 迁移；0.21.10 去掉 tool）。
 *  ⚠️ 0001 里那句注释含 `tool`，这里**不含** —— 迁移文件只增不改（checksum 硬比对），
 *     所以"新库首建"与"老库迁移后"的差异靠 0025 拉平，不靠改 0001。 */
export const BINDING_LEVELS = ['connection', 'server', 'skill'];

/**
 * 判定一个 MCP 服务对模型是否可见。
 *
 * ⚠️ 这是 0.21.10 从 `decideToolVisibility` **拆出来**的，不是新逻辑：
 *   MCP 服务的可见性从前**借用工具判定**（gate 里调 `toolVisibleNow('mcp:'+name)`，
 *   靠给名字加前缀把服务塞进工具那套）。工具那套一删，就必须有这一份，
 *   否则"删工具"会把 MCP 的可见性闸一起弄坏 —— 那是另一个功能。
 *   拆分时**行为逐字不变**：MCP 的血缘只有 server 一层（服务名就是绑定标识）。
 *
 * @param {object} input
 * @param {string} input.serverName         MCP 服务名（绑定标识）
 * @param {Array}  input.bindings           该主体生效的绑定行
 *   （每行 {capability_type, capability_id, allow}，allow: 0|1）
 * @returns {{visible: boolean, reason: string}}
 *   reason ∈ deny:server | explicit_allow | default
 *   ⚠️ 没有 `registry_disabled` 这一档：MCP 的 `mcp_servers.enabled` 是
 *      **连接配置是否启用**，不是可见性开关（从前是靠 tools 表里查不到 `mcp:xxx`
 *      这个"工具名"而隐式成立，现在写明白）。
 */
export function decideMcpVisibility({ serverName, bindings = [] } = {}) {
  if (!serverName) return { visible: false, reason: 'invalid_server' };

  let explicitAllow = false;
  for (const b of bindings) {
    if (!b || b.capability_type !== 'server' || b.capability_id !== serverName) continue;
    if (Number(b.allow) === 0) return { visible: false, reason: 'deny:server' };
    if (Number(b.allow) === 1) explicitAllow = true;
  }
  return { visible: true, reason: explicitAllow ? 'explicit_allow' : 'default' };
}

/**
 * 判定一个 Skill 对模型是否可见（血缘只有一层：skill 本身）。
 *
 * ⚠️ 0.21.10 前它 `return decideToolVisibility(...)` —— 那个委托随工具判定一起没了，
 *   所以这里补上**它自己**的实现。语义与从前完全一致：
 *   deny 赢 → 登记开关 → 默认放行。
 */
export function decideSkillVisibility({ skill, bindings = [], registryEnabled = true } = {}) {
  if (!skill || !skill.name) return { visible: false, reason: 'invalid_skill' };

  let explicitAllow = false;
  for (const b of bindings) {
    if (!b || b.capability_type !== 'skill' || b.capability_id !== skill.name) continue;
    if (Number(b.allow) === 0) return { visible: false, reason: 'deny:skill' };
    if (Number(b.allow) === 1) explicitAllow = true;
  }

  if (!registryEnabled) return { visible: false, reason: 'registry_disabled' };
  return { visible: true, reason: explicitAllow ? 'explicit_allow' : 'default' };
}

/**
 * 把绑定行按主体过滤。subject 维度（tenant | user | role）的展开在这里：
 * 判定函数只认「已展开为该主体的绑定」，谁来展开是服务层的事。
 *
 * @param {Array} rows  capability_bindings 表的行
 * @param {{tenantId: string, userId?: string|null, roles?: string[]}} subject
 * @returns {Array} 该主体生效的绑定（tenant 级 + 本 user 级 + 本角色级）
 */
export function bindingsForSubject(rows, subject) {
  const roles = Array.isArray(subject && subject.roles) ? subject.roles : [];
  return (rows || []).filter((r) => {
    if (!r) return false;
    if (r.subject_type === 'tenant') return r.subject_id === subject.tenantId;
    if (r.subject_type === 'user') return subject.userId != null && r.subject_id === subject.userId;
    if (r.subject_type === 'role') return roles.includes(r.subject_id);
    return false;
  });
}

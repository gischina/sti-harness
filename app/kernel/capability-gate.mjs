/**
 * 契约层能力闸 —— 给 provider 套一层可见性过滤，**不重启进程立即生效**。
 *
 * 这是 roadmap M4 验收标准 1 的落点，0.21.10 起该标准只由 **Skill** 承担：
 * 「关掉某个 Skill 的模型可见性后，契约层 `listSkills` 立即不再返回它
 * （回归断言在契约层，不只在 UI）」。
 *
 * 为什么做成 decorator 而不是改 provider：内核适配层不感知
 * 平台治理 —— 契约是内核与平台的边界，治理是平台自己的事。套一层后
 * `kernel.provider.listSkills()` 的返回值就已经是过滤后的，**所有**走契约的
 * 消费方（会话、能力清单接口）拿到的都是同一份真相。
 *
 * ── 0.21.10：「工具」这一路整块删除 ───────────────────────────────────
 *
 * 用户裁定：「工具是在内核自己调用，不用单独写这个能力，而且不会单独列出来有哪些工具」。
 * 于是这里的 `gated.listTools` 连同它的两档语义（保守并集 / per-tenant）一起删掉 ——
 * 没有清单可过滤，也就没有可闸的东西。详见 `0025_drop_tools.sql`。
 *
 * ⚠️ 删的时候**必须同时把 MCP 那一路接回自己的判定** —— 这是本次最容易出错的地方：
 *    `gated.listMcpServers` 从前调的是 `visibility.toolVisibleNow('mcp:' + name)`，
 *    即**借用工具判定**（靠给名字加 `mcp:` 前缀把服务塞进工具那套血缘）。
 *    工具判定一删，这一路就会连带失效 —— 表现为 MCP 的 deny 悄悄不生效了，
 *    而那是另一个功能，不该被"删工具"波及。现在改调 `mcpVisibleNow` /
 *    `mcpVisibleForTenant`（行为与从前一致，只是不再绕道工具那层）。
 *
 * 语义说明（Skill 与 MCP 各两档）：
 *   · 不带参数：**保守并集** —— 任一租户 deny / 停用即从契约层剔除，防止跨租户泄漏。
 *     给"无法确定调用者租户"的消费方（内核自身、旧消费方）。
 *   · 带 `{ tenantId, userId?, roles? }`：**per-tenant 精确判定** ——
 *     登记开关与绑定只看该租户。给 HTTP 清单接口这类明确知道「谁在问」的消费方。
 *   两档都实时查库，无缓存。
 * 判定器可选提供 `mcpVisibleForTenant / skillVisibleForTenant`；没提供时
 * 带租户的调用自动退回保守并集（如实标注 gatedBy）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

/**
 * @param {object} provider  内核 provider（已通过契约校验）
 * @param {object} visibility  形如 `{ mcpVisibleNow(name), skillVisibleNow(name) }`
 *   的判定器（capability service 提供；测试里可注入桩 —— 判定逻辑本身另有纯函数穷举测试）
 * @returns {object} 包装后的 provider（原方法之外的属性全部透传）
 */
export function applyCapabilityGate(provider, visibility) {
  if (!provider || typeof provider !== 'object') throw new Error('applyCapabilityGate：provider 必须是对象');
  // ⚠️ 门槛从 `toolVisibleNow` 换成 `mcpVisibleNow`：前者已随工具判定删除，
  //    再检查它会变成"永远装不上闸"（而 Skill 闸本身是好的）。
  //    这里按"闸实际要用的能力"来要求 —— 现在真正被闸的是 MCP 与 Skill。
  if (!visibility || typeof visibility.mcpVisibleNow !== 'function') {
    throw new Error('applyCapabilityGate：visibility.mcpVisibleNow 必须是函数 —— 没有判定器就不该装 gate');
  }

  const gated = Object.create(Object.getPrototypeOf(provider) || Object.prototype);
  Object.assign(gated, provider);

  // ⚠️ `gated.listTools` 整块删除（0.21.10）：契约层已经不再有这个方法
  //    （见 contract.mjs），这里再包一层会是"包装一个不存在的方法"——
  //    它会**凭空造出**一个 `listTools` 属性，让契约校验与实际能力对不上。
  //    删得不彻底比不删更糟：`kernel.provider.listTools` 还"存在"、但语义已无人负责。

  gated.listSkills = async function (...args) {
    const r = await provider.listSkills(...args);
    const opts = args[0] && typeof args[0] === 'object' ? args[0] : null;
    const perTenant = !!(opts && opts.tenantId && typeof visibility.skillVisibleForTenant === 'function');
    const skills = [];
    const blocked = [];
    for (const s of (r && r.skills) || []) {
      const v = perTenant
        ? visibility.skillVisibleForTenant(opts.tenantId, s.name, { userId: opts.userId || null, roles: opts.roles || [] })
        : visibility.skillVisibleNow(s.name);
      if (v.visible) skills.push(s);
      else blocked.push({ name: s.name, reason: v.reason });
    }
    return { ...(r || {}), skills, blocked, gatedBy: perTenant ? 'capability:tenant' : 'capability' };
  };

  gated.listMcpServers = async function (...args) {
    const r = await provider.listMcpServers(...args);
    const opts = args[0] && typeof args[0] === 'object' ? args[0] : null;
    const perTenant = !!(opts && opts.tenantId && typeof visibility.mcpVisibleForTenant === 'function');
    const servers = [];
    const blocked = [];
    for (const s of (r && r.servers) || []) {
      // ⚠️ 从这里起走 MCP **自己**的判定，不再 `toolVisibleNow('mcp:' + name)`。
      //    判定标识就是服务名本身（不再需要那个前缀 —— 前缀本来就是"借工具那套"
      //    留下的痕迹：工具血缘匹配 capability_type='tool' 的绑定，所以只能靠改名字绕过）。
      const v = perTenant
        ? visibility.mcpVisibleForTenant(opts.tenantId, s.name, { userId: opts.userId || null, roles: opts.roles || [] })
        : visibility.mcpVisibleNow(s.name);
      if (v.visible) servers.push(s);
      else blocked.push({ name: s.name, reason: v.reason });
    }
    return { ...(r || {}), servers, blocked, gatedBy: perTenant ? 'capability:tenant' : 'capability' };
  };

  gated._capabilityGated = true;
  return gated;
}

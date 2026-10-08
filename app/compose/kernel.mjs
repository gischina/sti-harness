/**
 * 内核装配 —— 「选内核 + 契约层能力闸」从 main.mjs 单点抽出（P2-13）。
 *
 * 三步，顺序即语义：
 *   1. 解密配置里的内核令牌密文（主密钥只有装配层有，所以解密在这一层；
 *      配置装配层刻意不认识密码学、也不读 data/.secret）；
 *   2. selectKernel（有地址就用上游内核，没地址就用"未接入"占位 —— 没有第三种可能）；
 *   3. 给 provider 套能力闸（停用/deny 的工具与 Skill 在契约层立即消失）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { log } from '../log.mjs';
import { loadConfig } from '../config.mjs';
import { decryptSecret } from '../platform/identity/credentials.mjs';
import { selectKernel } from '../kernel/index.mjs';
import { inspectProvider } from '../kernel/contract.mjs';
import { applyCapabilityGate } from '../kernel/capability-gate.mjs';
import * as capsService from '../platform/capability/service.mjs';

/**
 * 契约层能力闸（M4 验收标准 1）。
 *
 * 给 provider 套可见性过滤：被停用 / deny 的 Skill 与 MCP 服务在契约层
 * `listSkills` / `listMcpServers` 里立即消失（现查库、无缓存、不重启进程）。
 * 判定器来自 capability 服务。
 *
 * ⚠️ 0.21.10：「工具」不再走这道闸（用户裁定 —— 工具由内核自己调用、
 *    没有清单可过滤），所以这里也去掉了 `toolVisibleNow` / `toolVisibleForTenant`。
 *    注意 `gated()` 里的 `mcpVisibleNow` **不能顺手删** —— MCP 的可见性从前是
 *    「借用工具判定」，工具那套一去，它必须在这里显式接上自己的判定器，
 *    否则 MCP 的 deny 会静默失效（表现为"界面还能 deny，实际不生效"）。
 *
 * 抽成函数是因为**首次装配、热切换、测试脚手架三处走的是同一条**：能力闸漏在任一路径上，
 * 都会出现"换完内核后，被停用的 Skill 又回来了"这种只有切换过的进程才有的怪状态。
 * 导出它就是为了让 `tools/test-governance.mjs` 直接复用，而不是在测试里再抄一遍 ——
 * 抄一遍的后果是"测试验的是抄的那份"，两者悄悄漂开时谁也发现不了。
 */
export function gated(provider) {
  return applyCapabilityGate(provider, {
    mcpVisibleNow: capsService.mcpVisibleNow,
    skillVisibleNow: capsService.skillVisibleNow,
    mcpVisibleForTenant: capsService.mcpVisibleForTenant,
    skillVisibleForTenant: capsService.skillVisibleForTenant,
  });
}

/**
 * 解密 `config.values.dshTokenCipher` → `config.values.dshToken`（原地改写 config）。
 *
 * 解不开**不拦启动**：本平台的身份/知识/治理都不依赖内核（这正是它的承重设计），
 * 拦下来等于"令牌过个期就整个平台起不来"。但必须把来源标成"解密失败"——
 * 否则状态页显示"令牌来自 config.json"，人会以为它在正常工作，实际它连不上上游。
 */
function unlockKernelToken(config, keyring) {
  if (config.values.dshToken || !config.values.dshTokenCipher) return;
  try {
    config.values.dshToken = decryptSecret(config.values.dshTokenCipher, keyring);
  } catch (e) {
    config.sources.dshToken = 'config.json（密文解密失败）';
    log.warn('内核令牌解密失败：' + e.message + ' —— 已按"未配置令牌"继续。'
      + '多半是 data/.secret 被替换过；请在概览页重新接入内核。');
  }
}

/**
 * 平台 MCP 登记表读取器 —— 注入给内核 provider 用。
 *
 * 为什么需要它：契约层 `listMcpServers` 必须答得出"有哪些 MCP 服务"，
 * 而 MCP 服务是**平台侧配置**（`mcp_servers` 表），上游没有清单 RPC。
 * 早先 provider 那一侧恒返回空，于是能力闸（deny 一个 MCP → 契约层立即看不见）
 * **永远没有东西可过滤** —— 验收标准在回归里等于没测。
 *
 * ⚠️ 跨全部租户读（不带 tenantId）：契约层 `listMcpServers` 不带租户参数时
 *    语义就是**保守并集**（任一租户 deny 即剔除），带租户时走 per-tenant 判定。
 *    这里给的是"全量候选"，判定由闸自己做；预热过滤会**掩盖** deny 的来源租户。
 */
function platformMcpRegistry() {
  try { return capsService.listMcpServersAcrossTenants(); } catch (e) { return []; }
}

/**
 * 装配内核（含能力闸）。
 * @param {{config:object, keyring:object}} args
 * @returns {Promise<object>} `kernel`（provider 已套 applyCapabilityGate）
 * @throws {Error} selectKernel 失败（消息带"内核装配失败"前缀，由 main 统一记日志）
 */
export async function composeKernel({ config, keyring }) {
  unlockKernelToken(config, keyring);

  let kernel;
  try {
    kernel = await selectKernel(config.values, { listMcpServers: platformMcpRegistry });
  } catch (e) {
    throw new Error('内核装配失败：' + e.message);
  }

  // （能力闸见上：首次装配与热切换共用 `gated()`）
  kernel.swap({ provider: gated(kernel.provider) });
  return kernel;
}

/**
 * 热切换内核（0.21.3）—— 保存内核接入配置后**当场生效**，不再等重启。
 *
 * 为什么现在能做了：门面（`kernel/index.mjs` 的 `facade`）内部持有可变 state、
 * 对外全是 getter，所以"换内核"就是把新装配原子写进去 —— 门面引用不变，
 * 路由表不用重接，所有 `kernel.provider.xxx()` 调用点下一行就拿到新值。
 *
 * 三步里有三步都是坑，逐条说明为什么这么写：
 *
 *   ① **重新读盘**。保存动作（`system.kernel.config`）是**直接写文件**的，
 *      内存里的 `config.values` 还是旧值。不重读，切换出来的还是旧内核 ——
 *      表现为"保存提示成功、探测也通过，但内核没换"，最难查的一类。
 *   ② **在副本上算，成功后才回写内存**。`selectKernel` 可能在写回之前就抛错，
 *      那时内存必须与"仍在跑的那个内核"保持一致；否则状态页会报出一个
 *      **根本没发生过的**"配置与运行值不一致，需要重启"。失败就该留原样。
 *   ③ **令牌显式回落再解锁**。`unlockKernelToken` 在"已有令牌"时直接返回，
 *      所以不能只在有密文时清：用户点了"清空令牌"时密文为空，若不清，
 *      内存里会留着上次解密出来的明文 —— **清空变成没清**。
 *
 * 关于资源释放：被换下的 provider **不需要**显式关闭 —— 上游客户端是纯 `fetch`
 * （无长驻连接），会话日志是 `statSync` + 一次性读取（无打开的文件句柄），
 * 整个 provider 只是内存对象。返回它仅供诊断/日志，不是交给调用方去 close。
 *
 * @param {{config:object, keyring:object, kernel:object}} args `kernel` 是**已在跑**的门面
 * @returns {Promise<{applied:true, prev:object, ready:boolean, reason:string, status:object}>}
 * @throws {Error} 重新装配失败（**此时旧内核仍在正常服务**，内存 config 未被动过）
 */
export async function reloadKernel({ config, keyring, kernel }) {
  const live = loadConfig();

  // 目标 values：只换内核相关的键，其余（port / 检索参数…）原样带着走 ——
  // 那些键有自己的保存路径，不该被一次"换内核"顺带搅动。
  const target = {
    ...config.values,
    dshOrigin: live.values.dshOrigin,
    dshProfile: live.values.dshProfile,
    dshTokenCipher: live.values.dshTokenCipher,
    dshToken: live.values.dshToken || '',
  };

  if (!target.dshToken && target.dshTokenCipher) {
    try {
      target.dshToken = decryptSecret(target.dshTokenCipher, keyring);
    } catch (e) {
      // 与启动期同一条容错：解不开**不拦切换**，但绝不假装有令牌 ——
      // 换了密钥（.secret 被替换）时正确的结果就是"连不上"，而不是"用一个错的令牌硬连"。
      log.warn('内核令牌解密失败：' + e.message + ' —— 已按"未配置令牌"继续。');
      target.dshToken = '';
    }
  }

  let next;
  try {
    next = await selectKernel(target, { listMcpServers: platformMcpRegistry });
  } catch (e) {
    throw new Error('内核重新装配失败：' + e.message);
  }

  const provider = gated(next.provider);

  /**
   * 照切。这里**曾经**有一段"保护性判断"：新配置按 `auto` 会降级成内置内核、
   * 而当前正跑着一个可用内核时，就不切（免得把正在用的内核踢下去）。
   *
   * 0.21.4 起它没有存在理由了 —— 那段判断保护的是"不要降级到 mock"，
   * 而 mock 已经不存在。现在照切的结果就是**如实变成"不可用"**。
   *
   * ⚠️ 0.21.5 之后，"目标不可用却仍然走到这里"不再是用户能干出来的事（保存口先检测，
   * 不通过直接 409），但这条路径**仍然必须存在且必须照切**：配置可以被人在服务器上手改，
   * 改完触发重新装配时目标就可能连不上。那时正确的结果是"如实变成不可用 + 前端整页拦住
   * 要求重新接入"，而不是"界面说保存成功、实际还在用旧内核"——后者才是不诚实的那种。
   */
  const wasReady = kernel.ready;
  const prev = kernel.swap({
    ready: next.ready,
    provider,
    reason: next.reason,
    dshStatus: next.dshStatus,
    contract: inspectProvider(provider),
  });

  // 换成了才把新值落进内存 config（见上面第 ② 条：失败要留原样）
  config.values.dshOrigin = target.dshOrigin;
  config.values.dshProfile = target.dshProfile;
  config.values.dshTokenCipher = target.dshTokenCipher;
  config.values.dshToken = target.dshToken;
  delete config.values.kernel;            // 老配置里的残留键，见 connection-config 的合并函数
  for (const k of ['dshOrigin', 'dshProfile', 'dshToken']) {
    config.sources[k] = live.sources[k];
  }

  log.info('内核已热切换：' + (wasReady ? '已接入' : '未接入')
    + ' → ' + (next.ready ? '已接入' : '未接入') + '（' + (next.reason || '可达') + '）');
  return { applied: true, prev, ready: next.ready, reason: next.reason, status: next.dshStatus };
}

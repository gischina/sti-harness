/**
 * 内核接入的**纯逻辑**：地址归一化 → 配置合并 → 状态说成人话。
 *
 * 为什么要把这三件事单独抽出来（而不是写在路由 handler 里）：
 *   ① 它们必须能被**穷举回归**，而且都不需要真的联网 —— 路由里的代码是"跑一下才知道
 *      对不对"，这里的代码是"读一眼就知道对不对"；
 *   ② 用户看到的**每一句话**都从这里的词表出，不允许 handler 现场拼文案 ——
 *      否则同一个状态在概览页、引导弹窗、接口响应里会说出三种不同的话，
 *      而"三处口径不一"正是这个项目最怕的漂移；
 *   ③ 真正联网的那一步只有一件（`index.mjs` 的 `probeKernelConnection()`：问上游），
 *      "问完之后怎么落地、怎么解释"全在这里。分层之后，联网那步换实现不影响这里的回归。
 *
 * ⚠️ 本文件在 `app/kernel/` 根下（`tools/audit-layering.mjs` 的豁免范围），
 * 因此这里可以直呼上游的运维变量名 —— 但**产品层与前端不行**，前端一律从接口拿文案。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { parseDshOrigin } from '../config.mjs';

/**
 * 内核状态的词表 —— **单一真源**。
 *
 * `state` 的取值与内核适配层 `client.mjs` 的 `status()` 保持一致（不另造一套词，
 * 否则"上游说 token-rejected、平台说 鉴权失败"就又成了两套口径）；
 * `stage` 是给用户看的"卡在哪一步"，因为用户不关心状态机，只关心"是网络还是密码"。
 *
 * @type {Record<string,{stage:string,verdict:string,hint:string}>}
 */
export const KERNEL_STATE_TEXT = {
  'bad-origin': {
    stage: '地址',
    verdict: '这个地址填得不对',
    hint: '要形如 http://主机:端口（从内核启动时打印的那行里整段复制过来最省事，'
      + '整段里带的令牌会被自动识别出来）。',
  },
  unreachable: {
    stage: '连通',
    verdict: '连不上这个地址',
    hint: '确认内核进程在跑、端口没写错、防火墙放行；'
      + '如果内核在另一台机器上，还要确认它的 trustedHosts 里包含本平台所在主机。',
  },
  'need-token': {
    stage: '鉴权',
    verdict: '连上了，但它要求令牌',
    hint: '给出带令牌的完整地址（整段粘贴即可，令牌会被单独取出来）。',
  },
  'token-rejected': {
    stage: '鉴权',
    verdict: '连上了，但令牌被拒',
    hint: '令牌多半已过期或来自上一次启动 —— 回内核那边重新取一次启动地址，再整段粘过来。',
  },
  forbidden: {
    stage: '鉴权',
    verdict: '连上了，但它拒绝了本机来源',
    hint: '这通常是内核的 trustedHosts 没包含本平台所在主机；'
      + '在内核侧放开之后重新检测，而不是在这里反复改地址。',
  },
  'not-kernel': {
    stage: '识别',
    verdict: '这个地址有响应，但看起来不是内核',
    hint: '核对端口 —— 常见情况是填成了某个普通 Web 服务或另一个项目的端口。',
  },
  ok: {
    stage: '就绪',
    verdict: '连上了，令牌有效，内核可用',
    // ⚠️ 这句话 0.21.3 起是错的、0.21.5 修掉：内核连接**是热切换的**
    // （见 app/compose/kernel.mjs 的 switchKernel）。真正还需要重启的只有两种情形
    // —— 被环境变量覆盖、当场切换失败 —— 那两种由 describeKernelRestart 单独说。
    hint: '可以保存了：保存即生效，无需重启（正在进行的回合会用切换前的内核跑完）。',
  },
  unknown: {
    stage: '未知',
    verdict: '没能判定这个地址的状态',
    hint: '先确认地址能连通，再重试一次检测。',
  },
};

/**
 * 归一化用户填的地址与令牌。
 *
 * 三个回合的真实输入形态都要吃下：
 *   · `http://127.0.0.1:3080/?token=abc`（**整段粘贴** —— 这是最常见的一种，
 *     因为内核启动时打印的就是这一整行）；
 *   · `127.0.0.1:3080` + 令牌单独填（少写协议、少写斜杠）；
 *   · 反向代理下的带路径形态 `https://gw.corp.example/kernel`（路径要保留）。
 *
 * 拒绝的形态**必须给出理由**，不能悄悄改成别的地址 —— 悄悄改写等于让用户
 * 以为"我填的生效了"，而实际连的是另一个地方。
 *
 * @param {string} rawOrigin 用户填的地址（可整段带令牌）
 * @param {string} [rawToken] 单独填的令牌（有空则优先用整段里的）
 * @param {string} [fallbackOrigin] 留空时回落到哪（内置默认地址）
 * @returns {{origin:string, token:string, invalid:boolean, error:string, empty:boolean, tokenFrom:string}}
 */
export function normalizeKernelInput(rawOrigin, rawToken, fallbackOrigin = '') {
  const raw = String(rawOrigin == null ? '' : rawOrigin).trim();
  const pasted = String(rawToken == null ? '' : rawToken).trim();
  const empty = raw === '';
  const input = empty ? String(fallbackOrigin || '').trim() : raw;

  if (!input) {
    return { origin: '', token: pasted, invalid: true, empty, tokenFrom: pasted ? 'field' : 'none', error: '地址不能为空' };
  }
  // 显式拒绝危险协议：`file:` / `data:` 之类会被 fetch 当成合法 URL，
  // 而它们**不是**"内核地址" —— 让它们走到网络层只会得到一个莫名其妙的错误。
  if (/^(file|data|javascript|ftp|ws|wss):/i.test(input)) {
    return { origin: input, token: pasted, invalid: true, empty, tokenFrom: 'none', error: '只支持 http / https 地址' };
  }
  const parsed = parseDshOrigin(input);
  if (parsed.invalid) {
    return { origin: input, token: pasted, invalid: true, empty, tokenFrom: 'none', error: '这个地址解析不了（形如 http://主机:端口）' };
  }
  let u;
  try {
    u = new URL(parsed.origin);
  } catch {
    return { origin: input, token: pasted, invalid: true, empty, tokenFrom: 'none', error: '这个地址解析不了（形如 http://主机:端口）' };
  }
  if (!u.hostname) {
    return { origin: parsed.origin, token: pasted, invalid: true, empty, tokenFrom: 'none', error: '地址里没有主机名' };
  }
  // 令牌优先级：整段里的 > 单独填的。**反过来会让用户以为新令牌生效了**，
  // 而实际用的还是粘在地址里的旧令牌 —— 那种错极难自查。
  const token = parsed.token || pasted;
  return {
    origin: parsed.origin,
    token,
    invalid: false,
    empty,
    tokenFrom: parsed.token ? 'origin' : (pasted ? 'field' : 'none'),
    error: '',
  };
}

/**
 * 把"要改的那几项"合并进已有的配置文件内容。
 *
 * 三条硬约束（每一条都对应一次真实事故形态）：
 *   ① **不认识的键必须原样保留** —— 运维可能手写了本平台其它配置项（向量、分块参数…），
 *      向导保存一次就把它们抹掉是不可接受的；
 *   ② `token` 落盘一律走**密文**（`dshTokenCipher`），明文键 `dshToken` 会被删掉 ——
 *      否则"配置里没有明文令牌"这条承诺就只对第一次保存成立；
 *   ③ 纯函数：不碰文件系统，因此可以直接喂给回归做穷举（含"已有内容不是对象"这种脏输入）。
 *
 * @param {unknown} existing 现有 config.json 解析结果（可能是任意脏东西）
 * @param {{origin?:string, kernel?:string, tokenCipher?:string|null, keepExistingToken?:boolean}} patch
 * @returns {object} 新的配置对象（**新对象**，不改入参）
 */
export function mergeKernelConfigPatch(existing, patch = {}) {
  const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? { ...existing } : {};

  if (patch.origin) base.dshOrigin = String(patch.origin);
  // 0.21.4：`kernel` 这个键已随模式一起删掉 —— 顺手把老配置里的残留清掉，
  // 否则一份写着 `kernel: 'auto'` 的 config.json 会让后来读它的人以为还有这个开关。
  // 这正是这个键当初自己写进去的，删它属于同一个动作的收尾，不是替用户做主。
  delete base.kernel;

  const hasCipher = typeof patch.tokenCipher === 'string' && patch.tokenCipher !== '';
  if (hasCipher) {
    base.dshTokenCipher = patch.tokenCipher;
    // 明文键必须清掉：留着它就是"密文已生效但有明文副本"，等于白加密。
    delete base.dshToken;
  } else if (patch.tokenCipher === null) {
    // 显式"清空令牌"：两个键都删。
    delete base.dshTokenCipher;
    delete base.dshToken;
  }
  // tokenCipher === undefined → 不动令牌（用户只改地址）
  return base;
}

/**
 * 把探测结果翻译成**用户能照着做**的三段话。
 *
 * `detail` 取自探测本身（上游给的原文），`verdict` / `hint` 取自词表 ——
 * 这样"是什么错"是实测的，"该怎么办"是产品说定的，两者不混。
 *
 * @param {{state?:string, detail?:string, error?:string, versionGate?:{level:string,detail:string}|null, httpStatus?:string}} probe
 */
export function diagnoseKernelState(probe = {}) {
  const state = KERNEL_STATE_TEXT[probe.state] ? probe.state : 'unknown';
  const text = KERNEL_STATE_TEXT[state];
  const detail = String(probe.detail || probe.error || '');
  const gate = probe.versionGate || null;

  const out = {
    state,
    stage: text.stage,
    verdict: text.verdict,
    detail,
    hint: text.hint,
    ok: state === 'ok',
    versionWarning: null,
  };
  // 版本不在已验证矩阵内：**结论仍是"可用"**（黄灯不拦，见 config.mjs 的说明），
  // 但必须把"未经验证"这件事说出来，否则用户会在生产上踩到没人验证过的组合。
  if (state === 'ok' && gate && gate.level === 'warn') {
    out.versionWarning = gate.detail;
    out.hint = '版本不在已验证矩阵内，可以用，但上线前先跑契约核实：'
      + 'node tools/verify-upstream.mjs。' + out.hint;
  }
  return out;
}

/**
 * 把内核地址归一成**可比较的形状**：丢掉协议之后的查询串与井号，去掉尾斜杠，统一小写。
 *
 * 为什么必须丢掉 `?token=…`：历史配置里令牌是**内嵌在地址里**写的
 * （`dshOrigin: "http://127.0.0.1:3080/?token=…"`，见 0.15.0 之前所有部署的 data/config.json），
 * 而运行中的地址是解析后的（令牌已被摘出去单独持有）。不丢查询串就会**恒不相等**，
 * 于是这些部署每次打开概览页都会看到一条假的"需要重启"。
 * 地址上的令牌、以及尾斜杠、大小写，都不是"改了地址"。
 */
function normOrigin(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return (u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * 「配置改了但还没生效」的判定 —— 拿**运行中的真实状态**和**磁盘上的配置**比。
 *
 * 为什么不用"有没有保存过"这种标记位：标记位会在重启后忘记清零，于是永远显示
 * "待重启"；而这里比的是两个**客观值**（运行中内核实际连的地址 vs 文件里写的地址），
 * 重启之后它们自然相等，提示自动消失 —— 不需要任何人去清标记。
 *
 * ⚠️ 前提是**两边真的是同一类东西**。地址要丢掉 `?token=`、尾斜杠、大小写。
 * 这一条被真机验收证伪过一次：地址比较的假阳性会让"需要重启"变成一个
 * **永远为真**的提示，而永远为真的提示等于噪声，用户很快就会学会忽略它 ——
 * 那这个提示就不再是提示了。
 *
 * （从前这里还要比一遍"内核模式"，因为配置里那个 `auto` 不是模式、和运行中的
 * `external` 永远不相等，于是每个默认部署都顶着一条假警报。0.21.4 起模式连同
 * mock 一起删掉了，"改没改"只剩地址这一个客观量 —— 也就不再有那类假阳性。）
 *
 * 还有一条**必须单独说**的情况：地址来自环境变量时，它**覆盖**配置文件，
 * 于是在页面上保存是有可能的"保存了但重启后还是老地址"。不把这件事说出来，
 * 用户会反复保存、反复重启，然后认定"这个功能是坏的"。
 *
 * @param {{runningOrigin?:string, fileOrigin?:string,
 *          originSource?:string, envName?:string}} x
 */
export function describeKernelRestart(x = {}) {
  const changed = [];
  const overriddenByEnv = x.originSource === 'env';
  if (!overriddenByEnv && x.fileOrigin !== undefined && normOrigin(x.runningOrigin) !== normOrigin(x.fileOrigin)) changed.push('dshOrigin');

  const pending = changed.length > 0;
  let note = '';
  if (overriddenByEnv) {
    note = '当前内核地址来自环境变量 ' + (x.envName || '（环境变量）') + '，它会覆盖配置文件 —— '
      + '在页面上保存不会生效。要改就从那个环境变量改，或者去掉它再重启。';
  } else if (pending) {
    note = '配置文件里的内核地址与本进程正在使用的不一致 —— 需要重启本服务才会生效。'
      + '（已发起的对话不受影响；重启会中断正在进行的回合。）';
  }
  return { pending, changed, overriddenByEnv, note };
}

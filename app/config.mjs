/**
 * 配置装配。优先级：环境变量 > 数据目录下的 config.json > 内置默认值。
 *
 * 为什么默认值都偏保守：
 *  - 监听地址默认 `127.0.0.1`（企业多用户部署时由部署者显式改成内网地址，
 *    并**必须**同时配好反向代理与 TLS —— 见 docs/feasibility.md §7.2）；
 *  - 端口默认 `3090`（刻意避开同权利人早期作品占用的 3081，两者可同时运行）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';

/**
 * 本平台已验证的上游内核版本（版本门禁用）。不在矩阵内 → 自检黄灯，不静默放行。
 *
 * 为什么"黄灯但不拦"而不是"直接拒绝"：
 *   实测（2026-09-30）本机上游已是 `0.2.0-rc.2`，而矩阵里只有 0.1.x —— 上游跑得比
 *   我们的验证快是常态。若红灯拒绝启动，等于逼运维去改代码；黄灯则要求"先跑回归再上生产"，
 *   把纪律放在流程里，而不是放在代码里硬拦。
 *
 * ⚠️ 加版本的唯一合法方式是：**真的跑过契约核实**。
 *    2026-10-01：本机上游 0.2.0-rc.2 首次完成**动态**核实
 *    （`node tools/verify-upstream.mjs`，跑通 建会话→改名→选模型→发一轮→技能清单
 *    →取消→分叉→归档 全链路），故正式纳入矩阵。
 *    在此之前它被刻意排除，理由是"没跑过就不许标已验证"——那条纪律现在依然成立，
 *    只是这次真的跑过了。详见 docs/history/assessment-0.6.0.md §5 P0-A。
 */
export const KERNEL_VERIFIED_VERSIONS = ['0.1.5-rc.2', '0.1.6-alpha.1', '0.2.0-rc.2'];

/**
 * 版本门禁判定 —— **单一真源**，供自检 / 状态接口 / 内核接口三处共用。
 *
 * ⚠️ 从前这里必须传 `mode`（内核模式），因为有个"内置内核"分支：
 * `mock-provider.describe().kernelVersion` 返回的是**契约版本**，不是上游版本，
 * 只看版本号会报出「1.0.0 不在已验证矩阵内」——警告一个**根本不存在的上游版本**。
 *
 * 0.21.4 起那个分支连同 mock 一起删了：没有内置内核，就不存在"版本号是假的"
 * 这种情形。现在**版本为空 = 没有上游版本可校验**，如实报 `unknown` 即可 ——
 * 这比从前那条"n/a"更诚实（从前它把"没接内核"也一并算进"无需校验"）。
 *
 * @param {string} version 上游内核版本（未接入 / 读不到时为空）
 * @returns {{level:'ok'|'warn'|'unknown', detail:string}}
 */
export function versionGate(version) {
  if (!version || version === '—' || version === 'unknown') {
    return { level: 'unknown', detail: '未能读取上游内核版本（可能未安装其命令行）' };
  }
  if (KERNEL_VERIFIED_VERSIONS.includes(version)) {
    return { level: 'ok', detail: '在已验证版本矩阵内' };
  }
  return {
    level: 'warn',
    detail: '该版本不在已验证矩阵内（已验证：' + KERNEL_VERIFIED_VERSIONS.join(' / ') + '）——'
      + '功能可能正常，但未经验证。升级/降级前后必跑：'
      + 'node tools/verify-upstream.mjs（契约核实，需上游在跑）、'
      + 'node tools/test-core.mjs（契约与 fixtures 回归）、'
      + 'node tools/audit-layering.mjs（分层审计）。'
      + '⚠️ 新版本应先跑 verify-upstream 确认方法名与参数形状，再新增对应 compat 垫片 —— '
      + '否则会退回"用错垫片却无人察觉"的状态。详见 docs/history/assessment-0.6.0.md §5 P0-A。',
  };
}

/**
 * 运维接口名（环境变量）。**刻意集中在这里**：
 * 产品层与前端需要告诉运维"该设哪个变量"，但不该在自己的代码里直呼上游产品名
 * （否则 tools/audit-layering.mjs 会判定为分层泄漏）。前端从接口拿这些名字即可。
 */
export const ENV_NAMES = {
  origin: 'DSH_ORIGIN',
  token: 'DSH_TOKEN',
  profile: 'DSH_PROFILE',
  bin: 'DSH_BIN',
};

/** Node 版本下限：node:sqlite 自 22.5 起可用，22.13 起不再需要 --experimental-sqlite。 */
export const NODE_MIN = { major: 22, minor: 13, patch: 0 };

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3090,
  /**
   * 内核地址。**默认空 = 未接入**（0.21.4 起）。
   *
   * 从前这里默认 `http://127.0.0.1:3080`，配合 `kernel: 'auto'` 的降级逻辑，
   * 造成"刚解压的平台看起来已经接好了"。现在没有默认指向：**接入是你显式做的一件事**，
   * 没做就在界面上拦住并让你做（见 app/kernel/unconfigured-provider.mjs）。
   */
  dshOrigin: '',
  dshToken: '',
  dshProfile: 'web',
  /** 会话令牌有效期（小时）——M1 使用，这里先定死配置形状 */
  sessionTtlHours: 12,
  /** 收集一轮对话事件的最长等待（毫秒）；超时会如实标记 truncated 而不是假装完整 */
  turnTimeoutMs: 20000,
  /** 首次启动初始化向导是否强制 */
  requireSetup: true,

  /**
   * 是否信任反向代理头（`X-Forwarded-For` / `X-Forwarded-Proto`）。
   *
   * 默认 false：直连形态下这两个头客户端可随意伪造，按伪造来源做限流与
   * "是不是 HTTPS"的判定都会被骗。经反向代理部署时显式打开（config.json
   * 或 STI_TRUST_PROXY=1），见 util/net.mjs。
   */
  trustProxy: false,

  /* ── M2 企业知识与检索 ────────────────────────────────────────── */
  /**
   * 向量模型。**默认空 = 不配向量**，检索退化为纯文本（bigram + FTS5 bm25）。
   * 这是一个刻意的默认值：零依赖、离线可用、结果完全可复现；
   * 需要语义检索时再显式配置（openai-compat | ollama）。
   */
  embeddingProvider: '',
  embeddingBaseUrl: '',
  embeddingModel: '',
  embeddingDim: 0,
  /** 存凭据值的凭据名称（值在 credentials 表里 AES-256-GCM 加密，不在配置文件里） */
  embeddingCredentialName: '',
  embeddingTimeoutMs: 20000,
  /** 分块参数（改动会让已有文档与新建文档的粒度不一致，需重建索引才一致） */
  chunkMaxChars: 800,
  chunkOverlapChars: 120,
  chunkMinChars: 80,
  chunkMaxHeadingDepth: 3,
  /** 解析/分块/向量化的 worker 线程数；0 = 内联执行（主线程），仍可用但会拖慢接口 */
  workerPoolSize: 2,
  /**
   * 向量检索**预过滤**（体检报告 B2）：先用 FTS 把候选缩到几百条，再在候选上算余弦。
   *
   * ⚠️ **默认关**，而且这是刻意的 —— 它不是"纯优化"，是**会改变答案的行为变更**。
   *   实测（tools/bench-search.mjs 阶段 ⑤，5 千 chunk 合成语料）：
   *     · 收益：向量扫描 5000 → 512 条，检索 P95 123 ms → 94 ms（规模越大收益越大，
   *       10 万 chunk 下向量扫描本身约 1.2 s，那才是它真正要解决的量级）；
   *     · 代价：**最终 top-10 与全量精确检索只有 3~5 条重合**（另 5~7 条被换掉）。
   *   那个重合度是**合成语料**下的读数（合成向量与合成文本本就弱相关），
   *   真实语料下应该好得多 —— 但**没有真实语料实测之前，不该把"改变答案"设为默认**。
   *
   * 什么时候该开：库大到暴力扫描成为瓶颈（比如 > 10 万 chunk），且查询以**字面词**为主。
   * 什么时候务必关：召回质量优先、查询常靠语义（近义/换述）命中、或库里向量与文本相关性高。
   *
   * 安全阀（不依赖这个开关）：FTS 候选少于 `limit*3`（且不低于 32）时**自动退化为全量扫描**，
   * 所以开了它之后，纯语义查询也不会静默失效 —— 只是那些查询仍按全量精确跑（慢但召回无损）。
   */
  prefilterVector: false,
  /**
   * 预过滤候选上限：FTS 最多取多少条候选去做余弦。
   * 它同时是 SQL 变量数的安全边界（见 retrievers/vector.mjs 的 SAFE_IN_LIMIT）——
   * 调得过大不会更快，只会撞上限并**如实记一条降级说明**。
   */
  prefilterCandidates: 512,
};

/** 解析 DSH 地址。允许整段带令牌：http://127.0.0.1:3080/?token=… */
export function parseDshOrigin(input) {
  const raw = String(input || '').trim();
  if (!raw) return { origin: DEFAULTS.dshOrigin, token: '' };
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw);
  } catch {
    return { origin: raw, token: '', invalid: true };
  }
  const token = u.searchParams.get('token') || '';
  u.searchParams.delete('token');
  const hadPath = u.pathname && u.pathname !== '/';
  if (!hadPath) u.pathname = '';
  else u.pathname = u.pathname.replace(/\/+$/, '');
  u.search = '';
  u.hash = '';
  return { origin: u.origin + (hadPath ? u.pathname : ''), token, invalid: false };
}

function readConfigFile() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return typeof j === 'object' && j ? j : {};
  } catch {
    return {};
  }
}

/** 磁盘上那份配置的**原样**内容（不给默认值、不做装配）—— 用于"改了但没生效"的对账。 */
export function readRawConfigFile() {
  return readConfigFile();
}

/**
 * 原子写回配置文件（内核接入向导用）。
 *
 * 三个刻意的做法：
 *   · **原子**：先写同目录临时文件再 `rename` —— 直接 `writeFileSync` 覆盖时，
 *     进程若在写到一半被杀，留下的是**半个 JSON**，下次启动整个配置都读不出来
 *     （读者会当成"你没配过"，于是静默回落到默认内核）。这是最难查的一类故障。
 *   · **0600**：文件里有上游地址，也可能是密文令牌。POSIX 下收紧到只读属主；
 *     Windows 上 `chmod` 基本无效 —— 所以令牌**不靠权限保护，靠密文**（见下）。
 *   · **调用方给的是"最终完整对象"**：合并逻辑在 `kernel/connection-config.mjs` 里
 *     （纯函数、有回归），这里只管落盘。配置的"内容对错"与"写得对不对"分开治。
 *
 * @param {object} next 最终要写盘的配置对象
 * @returns {{file:string, bytes:number}}
 */
export function writeConfigFile(next) {
  const dir = path.dirname(CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(next, null, 2) + '\n';
  const tmp = CONFIG_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.renameSync(tmp, CONFIG_FILE); }
  catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不影响结论 */ }
    throw e;
  }
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows：忽略 */ }
  return { file: CONFIG_FILE, bytes: Buffer.byteLength(text) };
}

/**
 * @returns {{values:object, sources:Record<string,string>, configFile:string, exists:boolean}}
 *   `sources` 是「这个值从哪来」的诚实记录，会在自检与状态页上显示。
 */
export function loadConfig() {
  const file = readConfigFile();
  const sources = {};
  const v = { ...DEFAULTS };

  const takeFile = (key) => {
    if (file[key] !== undefined && file[key] !== '') {
      v[key] = file[key];
      sources[key] = 'config.json';
    } else {
      sources[key] = 'default';
    }
  };
  for (const k of ['host', 'dshOrigin', 'dshProfile', 'embeddingProvider', 'embeddingBaseUrl', 'embeddingModel', 'embeddingCredentialName']) takeFile(k);
  if (file.port !== undefined) { v.port = Number(file.port); sources.port = 'config.json'; } else sources.port = 'default';
  if (file.sessionTtlHours !== undefined) v.sessionTtlHours = Number(file.sessionTtlHours);
  for (const k of ['embeddingDim', 'embeddingTimeoutMs', 'chunkMaxChars', 'chunkOverlapChars', 'chunkMinChars', 'chunkMaxHeadingDepth', 'workerPoolSize', 'prefilterCandidates']) {
    if (file[k] !== undefined) { v[k] = Number(file[k]); sources[k] = 'config.json'; }
  }
  // 布尔项要单独处理：`takeFile` 的"空字符串视为未配置"对 `false` 不成立（false !== ''），
  // 但也**不能**用 `if (file[k])` —— 那样显式写 false 会被当成"没配"，于是永远开不回来。
  if (file.prefilterVector !== undefined) { v.prefilterVector = !!file.prefilterVector; sources.prefilterVector = 'config.json'; }
  else sources.prefilterVector = 'default';

  // trustProxy 同为布尔项：空字符串不算配置，显式 false 必须能配回来
  if (file.trustProxy !== undefined) { v.trustProxy = !!file.trustProxy; sources.trustProxy = 'config.json'; }
  else sources.trustProxy = 'default';

  // 环境变量覆盖
  if (process.env.STI_HOST) { v.host = process.env.STI_HOST; sources.host = 'env'; }
  if (process.env.STI_PORT) { v.port = Number(process.env.STI_PORT); sources.port = 'env'; }
  if (process.env.DSH_PROFILE) { v.dshProfile = process.env.DSH_PROFILE; sources.dshProfile = 'env'; }
  if (process.env.STI_EMBED_PROVIDER !== undefined) { v.embeddingProvider = process.env.STI_EMBED_PROVIDER; sources.embeddingProvider = 'env'; }
  if (process.env.STI_EMBED_BASE_URL) { v.embeddingBaseUrl = process.env.STI_EMBED_BASE_URL; sources.embeddingBaseUrl = 'env'; }
  if (process.env.STI_EMBED_MODEL) { v.embeddingModel = process.env.STI_EMBED_MODEL; sources.embeddingModel = 'env'; }
  if (process.env.STI_EMBED_DIM) { v.embeddingDim = Number(process.env.STI_EMBED_DIM); sources.embeddingDim = 'env'; }
  if (process.env.STI_EMBED_CREDENTIAL) { v.embeddingCredentialName = process.env.STI_EMBED_CREDENTIAL; sources.embeddingCredentialName = 'env'; }
  // 预过滤开关的 env 覆盖：`0` / `false` / `off` 三个词都表示关闭（运维不该琢磨该写哪个）
  if (process.env.STI_PREFILTER_VECTOR !== undefined) {
    const raw = String(process.env.STI_PREFILTER_VECTOR).trim().toLowerCase();
    v.prefilterVector = !(raw === '0' || raw === 'false' || raw === 'off' || raw === '');
    sources.prefilterVector = 'env';
  }
  if (process.env.STI_PREFILTER_CANDIDATES) { v.prefilterCandidates = Number(process.env.STI_PREFILTER_CANDIDATES); sources.prefilterCandidates = 'env'; }
  // trustProxy 的 env 覆盖：`0` / `false` / `off` 都表示关闭
  if (process.env.STI_TRUST_PROXY !== undefined) {
    const rawProxy = String(process.env.STI_TRUST_PROXY).trim().toLowerCase();
    v.trustProxy = !(rawProxy === '0' || rawProxy === 'false' || rawProxy === 'off' || rawProxy === '');
    sources.trustProxy = 'env';
  }
  if (process.env.STI_WORKERS !== undefined) { v.workerPoolSize = Number(process.env.STI_WORKERS); sources.workerPoolSize = 'env'; }
  if (process.env.STI_CHUNK_MAX) { v.chunkMaxChars = Number(process.env.STI_CHUNK_MAX); sources.chunkMaxChars = 'env'; }

  // DSH 地址：DSH_ORIGIN（可带 ?token=）> DSH_TOKEN > config.json > 默认
  let rawOrigin = file.dshOrigin || DEFAULTS.dshOrigin;
  if (file.dshOrigin) sources.dshOrigin = 'config.json'; else sources.dshOrigin = 'default';
  if (process.env.DSH_ORIGIN) { rawOrigin = process.env.DSH_ORIGIN; sources.dshOrigin = 'env'; }
  const parsed = parseDshOrigin(rawOrigin);
  v.dshOrigin = parsed.origin;
  v.dshToken = parsed.token || (process.env.DSH_TOKEN || '') || DEFAULTS.dshToken;
  sources.dshToken = parsed.token && process.env.DSH_ORIGIN ? 'env'
    : (process.env.DSH_TOKEN ? 'env' : (file.dshToken ? 'config.json' : 'none'));
  if (file.dshToken && !v.dshToken) { v.dshToken = file.dshToken; sources.dshToken = 'config.json'; }

  /**
   * 密文令牌（接入向导写的那种）。
   *
   * 为什么配置文件里要留一个"密文键"而不是直接写明文：
   *   本项目对**凭据**的既有承诺是"值加密落库、明文永不落盘"（嵌入模型凭据就是这么做的）。
   *   内核令牌的权限级别与它同级（能调上游内核），把它明文写进 `config.json` 是**开倒车**；
   *   而 Windows 上文件权限又基本不可靠 —— 所以这里选密文，不选 0600。
   *
   * 解密**不在这里做**：`config.mjs` 是纯配置装配（不碰密码学、不碰数据库），
   * 主密钥由装配层 `main.mjs` 注入（它已经从 `data/.secret` 读到了）。
   * 这里只负责把"有这么个键"如实报出来。
   */
  v.dshTokenCipher = typeof file.dshTokenCipher === 'string' ? file.dshTokenCipher : '';
  if (!v.dshToken && v.dshTokenCipher) sources.dshToken = 'config.json（密文，启动时解密）';
  else if (!v.dshToken && !v.dshTokenCipher) sources.dshToken = sources.dshToken === 'env' ? 'env' : 'none';

  return { values: v, sources, configFile: CONFIG_FILE, exists: fs.existsSync(CONFIG_FILE) };
}

/**
 * 会话令牌有效期（毫秒）——**配置到身份服务的唯一换算入口**。
 *
 * 为什么单独抽成纯函数（而不是在 `main.mjs` 里就地 `Number(...) * 3600 * 1000`）：
 *   `sessionTtlHours` 曾经只存在于 `config.json` 的默认值里、**从没被读过** ——
 *   会话实际写死 8 小时，运维改了配置却什么都没变。**死配置比没有配置更危险**：
 *   它看起来生效了，于是没人再去查。把换算抽成可单测的纯函数后，
 *   「配置 → 毫秒」这段逻辑有了唯一的、被回归钉住的实现，装配层只负责调用。
 *
 * @param {object} [values] `loadConfig().values`
 * @returns {number|null} 合法正数 → 对应毫秒；否则 `null`（表示"交给身份服务用自身默认值"）
 */
export function sessionTtlMs(values = {}) {
  const hours = Number(values && values.sessionTtlHours);
  return Number.isFinite(hours) && hours > 0 ? hours * 3600 * 1000 : null;
}

/** Node 版本是否满足下限。返回 {ok, current, required} —— 供自检与启动器共用。 */
export function checkNodeVersion(version = process.versions.node) {
  const [maj, min, pat] = version.split('.').map((n) => Number(n));
  const ok = maj > NODE_MIN.major
    || (maj === NODE_MIN.major && min > NODE_MIN.minor)
    || (maj === NODE_MIN.major && min === NODE_MIN.minor && pat >= NODE_MIN.patch);
  return { ok, current: version, required: `${NODE_MIN.major}.${NODE_MIN.minor}.${NODE_MIN.patch}` };
}

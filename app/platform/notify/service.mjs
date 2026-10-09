/**
 * 出站通知（P1-2）—— 平台主动"找上门"的能力。
 *
 * 为什么需要：在它之前，平台**没有任何主动告知手段**。配额被拦、审批积压、
 * 备份失败、模型探活失败 —— 全部只能靠人主动打开页面看。企业运维的基本要求是
 * "异常主动找上门"，而不是"你得记得每隔一小时去刷一下"。
 *
 * ⚠️ 三条诚实边界：
 *
 *   1. **只实装 webhook 一种渠道。** `kind` 列留着，但 SINKS 白名单里只有一个
 *      真会发包的实现。邮件 / 短信 / 企微 SDK 一律不写进去假装支持 ——
 *      "渠道类型可扩展"与"渠道类型已支持"是两句话。
 *
 *   2. **投递先尽力而为，失败就落库重投（0.11.1 起）**：单次投递有界重试
 *      （默认 2 次、指数退避），仍然失败则**写入 `notify_deliveries` 队列**，
 *      由定时任务 `notify.retry` 按指数退避重投，超过上限转 `dead`（**保留可见**，可手动重投）。
 *      边界（如实）：
 *        · **at-least-once，不是 exactly-once** —— 重投时接收方可能收到重复。
 *          每次投递带一个在重试间**保持不变**的 `X-STI-Delivery-Id` 头，接收方据此去重；
 *          平台这边做不到"确认对方处理了一次"，那是分布式事务的范畴，不在本层承诺。
 *        · **试发（testChannel）失败不入队** —— 那是人在旁边看着的动作，失败会立刻显示；
 *          把它丢进重投队列只会让"待处理告警"这个数字被无效测试数据污染。
 *        · 队列是**本机单进程**的重投（与调度器同一约束：无分布式锁）。
 *          平台整体停机期间的告警仍然会丢 —— 那条边界没变，变的只是"上游抖动不再等于告警丢失"。
 *
 *   3. **SSRF 防护的取舍（这一条最容易被写错，值得说清楚）**：
 *      本平台面向**内网部署**，webhook 目标本来就常在内网（10./172.16-31./192.168.）
 *      —— 一律禁私网等于把功能做废。真正必须禁的是**回环、未指定地址与云元数据
 *      地址**（127.0.0.0/8、::1、0.0.0.0、169.254.0.0/16，后者含各家云厂商的
 *      169.254.169.254 元数据服务）。那些不是合法的 webhook 目标，而是 SSRF 的载荷。
 *      另外强制 scheme 只能是 http/https（禁 file: / gopher: / data: 等），
 *      并在**连接前**把主机名解析成 IP 逐一校验 —— 只校验字面量会被
 *      "解析到 127.0.0.1 的域名"绕过。
 *      本机自测需要 loopback 时，显式打开 `allowLoopback`（装配层给，非用户输入）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { run, all, get } from '../../data/db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';
import { parseJsonSafe } from '../../util/json.mjs';
// 租户过滤的落点单点在 data/repositories/rows.mjs（曾与 model/schedule 各留一份拷贝，体检 §A1-#3）
import { rowBy } from '../../data/repositories/rows.mjs';

/** 事件白名单 —— 只有这里列出的事件才可能被投递出去，其它一律拒绝（防"随手 emit 一个别的"）。 */
export const NOTIFY_EVENTS = [
  'quota.blocked',       // 配额拦截
  'backup.failed',       // 备份失败
  'model.probe.failed',  // 模型探活失败
  'audit.anchor',        // 审计链尾锚点（用于把锚点带出这台机器）
];

/**
 * 每个白名单事件**当前有没有产生方**（即：有没有哪段代码真的会 `emit` 它）。
 *
 * 为什么要维护这张表：白名单只说明"这个事件**允许**被投递"，**不说明它真的会发生**。
 * 两者被混为一谈过一次 —— 白名单里有过"躺了多个版本、全项目没有一个 emit 点"的事件名：
 * 运维照文档给渠道订阅了它、以为会告警，实际上那条路永远不会响。
 * **白名单是能力声明，产生方是能力实现** —— 声明与实现分家，正是本项目最不能接受的漂移。
 *
 * 约定：
 *   · 值 = 产生方文件的**仓库相对路径**（该文件里必须能找到以引号包住事件名的 `event` 字段）；
 *   · 值 = `null` = **当前没有产生方** —— 允许存在，但必须显式写在这里，不许默认通过；
 *   · 键集**必须与 `NOTIFY_EVENTS` 完全一致**，由回归钉住（`tools/test-core.mjs`）。
 *
 * ⚠️ `quota.blocked` 是"会成串发生"的事件（配额被撞上后每次提交都被拦），
 *    所以**接它的同时必须定节流**：节流窗口与分键规则由 `producers.mjs` 给，
 *    机制（`emit` 的 `cooldownMs` + `dedupeKey`）在这里，两处不重复实现。
 *    节流合掉的是**通知**，不是**事实** —— 每一次拦截仍逐条进审计。
 */
export const NOTIFY_EVENT_PRODUCERS = {
  'quota.blocked': 'app/platform/notify/producers.mjs',
  'backup.failed': 'app/platform/schedule/tasks.mjs',
  'model.probe.failed': 'app/platform/schedule/tasks.mjs',
  'audit.anchor': 'app/platform/schedule/tasks.mjs',
};

/** 渠道类型白名单（只有实现了的才在里面） */
export const SINK_KINDS = ['webhook'];

const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 250;

/* ── 重投队列（§B5）───────────────────────────────────────────────── */

/**
 * 一条投递记录最多被**重投**几次（不含首次的 2 次内联尝试）。
 * 为什么是 6：按下面的指数退避，6 次覆盖约 10 分钟 → 2 小时 → 6 小时 → 1 天……
 * 足以跨过"上游重启 / 网络抖动 / 对端限流"这类真实故障，又不会让一条永久失效的目标
 * 在队列里无限重试。到上限后转 `dead` —— **不是删除**：它可能正是一条必须被看见的告警。
 */
const RETRY_MAX = 6;
/** 重投退避基准：第 n 次重投等 `RETRY_BASE_MS * 2^(n-1)`，封顶 1 小时。 */
const RETRY_BASE_MS = 10 * 60 * 1000;
const RETRY_CAP_MS = 60 * 60 * 1000;
/** 已成功 / 已死信的记录保留天数（由 `notify.retry` 任务顺带清理，避免表无界增长）。 */
const DELIVERY_KEEP_DAYS = 30;

/**
 * 节流用的"上次出站时刻"（键 = 租户 + 事件 + dedupeKey）。
 *
 * 为什么机制放在这里、规则放在产生方：`emit` 只管"同一个键在窗口内只发一次"这一件事，
 * "哪个事件该按什么分键、窗口多长"是产生方的语义（见 `notify/producers.mjs`）。
 * 默认 `cooldownMs = 0` = **不节流**，所以既有事件（备份失败、探活失败、锚点）行为一字未变。
 *
 * 内存上界：条目数 = 窗口内出现过的不同键。写入时顺带清理过期项，长期运行不会无界增长。
 */
const COOLDOWN = new Map();

function cooldownKey(tenantId, event, dedupeKey) {
  return String(tenantId) + '\u0000' + event + '\u0000' + String(dedupeKey || '');
}

function sweepCooldown(maxMs) {
  const now = Date.now();
  for (const [k, t] of COOLDOWN) if (now - t >= maxMs) COOLDOWN.delete(k);
}

function retryDelayMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** (n - 1)));
}

/* ── SSRF 目标校验（纯函数 + 一次 DNS 解析，可单测）─────────────────── */

/** IPv4 点分十进制 → 是否为回环/未指定/链路本地 */
function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 解析不了一律拒绝
  if (p[0] === 127) return true;                 // 回环
  if (p[0] === 0) return true;                   // 0.0.0.0/8
  if (p[0] === 169 && p[1] === 254) return true; // 链路本地（含 169.254.169.254 云元数据）
  return false;
}

function ipBlocked(raw) {
  const ip = String(raw).split('%')[0];          // 去掉 zone id
  if (net.isIPv4(ip)) return ipv4Blocked(ip);
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    // ::ffff:127.0.0.1 这类 IPv4-mapped 地址要拆出来按 v4 判
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (m) return ipv4Blocked(m[1]);
    if (low.startsWith('fe80:')) return true;    // 链路本地
    return false;
  }
  return true;                                    // 不是 IP 就当拒绝（调用方只应在解析后传 IP）
}

/**
 * 出站目标的**静态**校验：只看 scheme 与形态，**不解析 DNS**（因此是同步的）。
 *
 * 为什么必须与 `assertSafeTarget` 分开、并且**在写入时就跑一次**：
 *   · IP 判定只能在**投递前**做 —— 主机名的解析结果会在"写入渠道"与"真的发告警"
 *     之间变化（DNS 重绑定），所以那部分天然是异步的、必须每次投递重做；
 *   · 但"这压根不是 http(s) 目标"是**配置错误**，没有任何合理场景。
 *     若只在投递时才拦，库里会静默存下一条永远发不出去的渠道，
 *     运维要等到第一次真的该收到告警时才发现 —— 那时信息已经丢了。
 *   —— 与定时任务"非法规则写入时即拒绝"是同一条纪律。
 * @returns {{ok:true, url:URL}|{ok:false, error:string}}
 */
export function assertScheme(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl == null ? '' : rawUrl)); }
  catch { return { ok: false, error: 'URL 无法解析（要形如 http://host/path）' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '只允许 http / https 出站目标（当前：' + u.protocol + '）' };
  }
  if (!u.host) return { ok: false, error: 'URL 缺少主机名' };
  return { ok: true, url: u };
}

/**
 * 校验出站目标。
 * @returns {Promise<{ok:true, url:URL, addresses:string[]}|{ok:false, reason:string, error:string}>}
 */
export async function assertSafeTarget(rawUrl, { allowLoopback = false } = {}) {
  // scheme / 形态判定复用同一条实现 —— 静态校验与动态校验的口径必须一致，
  // 否则会出现"写入时放行、投递时拒绝"（或反过来）这种最难查的不一致。
  const shape = assertScheme(rawUrl);
  if (!shape.ok) return { ok: false, reason: 'bad_request', error: shape.error };
  const u = shape.url;
  // IPv6 字面量在 WHATWG URL 里带方括号（`[::1]`）—— 不剥掉的话 `net.isIP` 判不出来，
  // 会走到 DNS 解析分支并得到"解析失败"，把"这是回环地址"这条准确结论丢掉。
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = [];
  if (net.isIP(host)) {
    addresses.push(host);
  } else {
    try {
      const rs = await dns.lookup(host, { all: true });
      for (const r of rs) addresses.push(r.address);
    } catch (e) {
      // 解析不了就发不出去；如实报，不要"先发了再看"
      return { ok: false, reason: 'unreachable', error: '主机名解析失败：' + host + '（' + (e && e.message) + '）' };
    }
  }
  if (!addresses.length) return { ok: false, reason: 'unreachable', error: '主机名没有解析到任何地址：' + host };
  if (!allowLoopback) {
    const bad = addresses.find((a) => ipBlocked(a));
    if (bad) {
      return {
        ok: false, reason: 'bad_request',
        error: '拒绝向回环 / 未指定 / 链路本地地址出站：' + bad + '（这是 SSRF 的典型载荷，不是合法的 webhook 目标）',
      };
    }
  }
  return { ok: true, url: u, addresses };
}

/* ── 直达机器人的信封适配（纯函数，可单测；2026-10 交付评审 P1）─────────────
 *
 * 问题现场：企微 / 钉钉自定义机器人各自**只认自己的信封**
 * （`{"msgtype":"text","text":{"content":…}}`）。平台通用报文
 * （`{event,at,tenantId,text,data}`）发过去，它们照样回 **HTTP 200**、
 * 但消息**根本不渲染**（企微 errcode 40008 / 钉钉 errcode 300001）——
 * "HTTP 通了"与"消息送达了"在这里是两件事，不识别就会把静默丢失记成投递成功。
 *
 * 做法：host **精确**匹配换信封（`qyapi.weixin.qq.com.evil.example` 那种后缀碰瓷不许命中）；
 * 其余目标原样走平台通用报文；这两类 host 的成败判据是回执 `errcode === 0`，不是 HTTP 状态。
 * 适配点在 `deliverTo`（decrypt 之后）：emit / 重投 / 试发三条路径在此汇合，一处生效三处。
 */

/** 目标 host → 已知的机器人接收端（'' = 通用 webhook，不改报文）。 */
export function robotSinkOf(rawUrl) {
  let host = '';
  try { host = new URL(String(rawUrl == null ? '' : rawUrl)).hostname.toLowerCase(); }
  catch { return ''; }
  if (host === 'qyapi.weixin.qq.com') return 'wecom';
  if (host === 'oapi.dingtalk.com') return 'dingtalk';
  return '';
}

/** 按接收端换信封；`sink` 为空时**原对象原样返回**（通用 webhook 契约一字不变）。 */
export function adaptBodyForSink(sink, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (sink !== 'wecom' && sink !== 'dingtalk') return b;
  // 两类机器人的文本消息字段形状相同：content = 一行摘要（`text`），不塞 JSON 明细。
  return { msgtype: 'text', text: { content: String(b.text == null ? '' : b.text) } };
}

/**
 * 解析机器人回执。这两类接收端**无论成败都回 HTTP 200**，成功判据只能是 `errcode === 0`。
 * @returns {string|null} null = 送达；否则为失败原因（会照常落重投队列）
 */
export function robotReceiptError(rawText) {
  let er = null;
  try { er = JSON.parse(String(rawText)); } catch { er = null; }
  if (er && typeof er === 'object' && Number.isInteger(er.errcode)) {
    if (er.errcode === 0) return null;
    return '机器人回执拒绝：errcode=' + er.errcode + (er.errmsg ? '（' + er.errmsg + '）' : '');
  }
  return '机器人回执无法解析（响应不是带 errcode 的 JSON）—— 按未送达处理';
}

/* ── 服务 ──────────────────────────────────────────────────────────── */

export function createNotifyService(deps = {}) {
  const masterSecret = deps.masterSecret || null;
  const encryptSecret = deps.encryptSecret || null;
  const decryptSecret = deps.decryptSecret || null;
  const resolveCredential = typeof deps.resolveCredential === 'function' ? deps.resolveCredential : null;
  const allowLoopback = !!deps.allowLoopback;
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : 8000;
  const audit = deps.audit || null;

  /* ── 读 ── */

  const TABLE = 'notify_channels';
  const rowById = (tenantId, id) => rowBy(tenantId, TABLE, 'id', id);
  const rowByName = (tenantId, name) => rowBy(tenantId, TABLE, 'name', name);

  function parseEvents(s) {
    const a = parseJsonSafe(s, []);
    return Array.isArray(a) ? a.filter((x) => NOTIFY_EVENTS.includes(x)) : [];
  }

  /** 从加密 URL 里取 host 用于展示 —— **永不回显完整 URL**（它常内嵌 token，等价于密钥）。 */
  function hostOf(cipher) {
    if (!cipher || !decryptSecret || !masterSecret) return null;
    try {
      const u = new URL(decryptSecret(cipher, masterSecret));
      return u.protocol + '//' + u.host + (u.pathname && u.pathname !== '/' ? '/…' : '');
    } catch { return '(无法解析)'; }
  }

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      host: hostOf(row.url_cipher),
      hasUrl: !!row.url_cipher,
      credentialName: row.credential_name || null,
      hasCredential: !!row.credential_name,
      events: parseEvents(row.events_json),
      enabled: !!row.enabled,
      lastDeliveryAt: row.last_delivery_at || null,
      lastStatus: row.last_status || null,
      failCount: Number(row.fail_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listChannels(tenantId) {
    return all('SELECT * FROM notify_channels WHERE tenant_id = ? ORDER BY enabled DESC, name',
      [String(tenantId)]).map(shape);
  }

  function getChannel(tenantId, id) {
    return shape(rowById(tenantId, id));
  }

  /* ── 写 ── */

  function validate(input, { partial = false } = {}) {
    if (!partial || input.name !== undefined) {
      const name = String(input.name || '').trim();
      if (!name) return 'name 不能为空';
      if (name.length > 60) return 'name 过长（上限 60 字符）';
    }
    if (!partial || input.kind !== undefined) {
      const kind = String(input.kind || 'webhook');
      if (!SINK_KINDS.includes(kind)) return 'kind 必须是已实现的渠道：' + SINK_KINDS.join(' / ');
    }
    if (!partial || input.url !== undefined) {
      const raw = String(input.url == null ? '' : input.url).trim();
      if (!raw) return '缺少 url';
      // 写入时就拦掉非 http(s) 目标：只在投递时拦 = 库里静默躺着一条永远发不出去的渠道。
      const s = assertScheme(raw);
      if (!s.ok) return s.error;
    }
    if (input.events !== undefined) {
      if (!Array.isArray(input.events)) return 'events 必须是数组';
      const bad = input.events.find((e) => !NOTIFY_EVENTS.includes(String(e)));
      if (bad) return '未知事件：' + bad + '（可选：' + NOTIFY_EVENTS.join(' / ') + '）';
    }
    return null;
  }

  function createChannel(tenantId, input = {}) {
    const bad = validate(input);
    if (bad) return { ok: false, error: bad };
    if (!encryptSecret || !masterSecret) {
      return { ok: false, error: '平台未装配加解密（装配缺陷），出于"URL 必加密"的红线，拒绝以明文落库' };
    }
    const name = String(input.name).trim();
    if (rowByName(tenantId, name)) return { ok: false, error: '同名渠道已存在：' + name };
    const id = newId('nch');
    const now = nowIso();
    try {
      run(
        `INSERT INTO notify_channels
           (id, tenant_id, name, kind, url_cipher, credential_name, events_json, enabled,
            last_delivery_at, last_status, fail_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
        [id, String(tenantId), name, String(input.kind || 'webhook'),
          encryptSecret(String(input.url).trim(), masterSecret),
          String(input.credentialName || ''),
          JSON.stringify(Array.isArray(input.events) ? input.events.map(String) : []),
          input.enabled === false ? 0 : 1, now, now]
      );
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
    return { ok: true, channel: getChannel(tenantId, id) };
  }

  function updateChannel(tenantId, id, patch = {}) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '渠道不存在：' + id };
    const bad = validate(patch, { partial: true });
    if (bad) return { ok: false, error: bad };

    const name = patch.name !== undefined ? String(patch.name).trim() : row.name;
    const clash = rowByName(tenantId, name);
    if (clash && clash.id !== row.id) return { ok: false, error: '同名渠道已存在：' + name };

    let urlCipher = row.url_cipher;
    if (patch.url !== undefined && String(patch.url).trim()) {
      if (!encryptSecret || !masterSecret) return { ok: false, error: '平台未装配加解密，拒绝以明文落库' };
      urlCipher = encryptSecret(String(patch.url).trim(), masterSecret);
    }
    const events = patch.events !== undefined ? patch.events.map(String) : parseEvents(row.events_json);
    const credentialName = patch.credentialName !== undefined ? String(patch.credentialName || '') : (row.credential_name || '');
    const kind = patch.kind !== undefined ? String(patch.kind) : row.kind;
    const enabled = patch.enabled !== undefined ? !!patch.enabled : !!row.enabled;

    run(
      `UPDATE notify_channels SET name = ?, kind = ?, url_cipher = ?, credential_name = ?,
         events_json = ?, enabled = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
      [name, kind, urlCipher, credentialName, JSON.stringify(events), enabled ? 1 : 0, nowIso(),
        String(tenantId), String(id)]
    );
    return { ok: true, channel: getChannel(tenantId, id) };
  }

  function deleteChannel(tenantId, id) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '渠道不存在：' + id };
    run('DELETE FROM notify_channels WHERE tenant_id = ? AND id = ?', [String(tenantId), String(id)]);
    return { ok: true, deleted: row.name };
  }

  /* ── 重投队列（§B5）─────────────────────────────────────────────── */
  //
  // 这一节做的事只有一个：**把"发不出去"从一个瞬间事件变成一个待办事项**。
  // 在它之前，失败只留一条审计 —— 事后能查到，但没有任何机制会再去发一次，
  // 所以上游抖动就等于告警永久丢失。而丢失的恰恰是 `audit.anchor`（审计链尾锚点，
  // 存在的意义就是"把锚点带出这台机器"）与 `backup.failed` 这类必须被看见的事件。

  const DELIVERY_TABLE = 'notify_deliveries';

  function shapeDelivery(row) {
    if (!row) return null;
    return {
      id: row.id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      event: row.event,
      status: row.status,
      attempts: Number(row.attempts || 0),
      maxAttempts: RETRY_MAX,
      lastError: row.last_error || null,
      lastStatus: row.last_status == null ? null : Number(row.last_status),
      nextRetryAt: row.next_retry_at || null,
      firstFailedAt: row.first_failed_at,
      lastAttemptAt: row.last_attempt_at || null,
      deliveredAt: row.delivered_at || null,
      createdAt: row.created_at,
    };
  }

  function getDelivery(tenantId, id) {
    return shapeDelivery(get(
      `SELECT * FROM ${DELIVERY_TABLE} WHERE tenant_id = ? AND id = ?`,
      [String(tenantId), String(id)]
    ));
  }

  /**
   * 投递记录列表。`status` 传 `'all'` 或空表示不过滤。
   * 默认按创建时间倒序 —— 排障时"最近发生了什么"永远比"最早发生了什么"先要看。
   */
  function listDeliveries(tenantId, { status = 'pending', limit = 50 } = {}) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 50));
    if (status && status !== 'all') {
      return all(
        `SELECT * FROM ${DELIVERY_TABLE} WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
        [String(tenantId), String(status), lim]
      ).map(shapeDelivery);
    }
    return all(
      `SELECT * FROM ${DELIVERY_TABLE} WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
      [String(tenantId), lim]
    ).map(shapeDelivery);
  }

  /** 三个状态各自的条数。页面上的"待重投 N 条"就是它。 */
  function deliveryStats(tenantId) {
    const rows = all(
      `SELECT status, COUNT(*) AS n FROM ${DELIVERY_TABLE} WHERE tenant_id = ? GROUP BY status`,
      [String(tenantId)]
    );
    const out = { pending: 0, delivered: 0, dead: 0 };
    for (const r of rows) if (Object.prototype.hasOwnProperty.call(out, r.status)) out[r.status] = Number(r.n) || 0;
    out.total = out.pending + out.delivered + out.dead;
    return out;
  }

  /**
   * 把一次失败的投递写进队列。
   *
   * 为什么存 `payload` 而不是"重投时重新构造"：失败与重投之间可能隔了几个小时，
   * 而事件的**内容**（"哪份备份失败了"）在调用方那边早就不是当前状态了。
   * 重投的语义是"把这条告警补发出去"，不是"重新生成一条今天的告警"。
   *
   * ⚠️ 调用方**不要把凭据放进 payload**：它会以明文落进本机 SQLite。
   *    它进的是本机库（与审计同级）、不是外部网络，但这个边界要写出来。
   *
   * ⚠️ `attempts` 记的是**已被重投的次数**，从 0 起（**不含**首次投递里的内联尝试）。
   *    为什么不把内联那 2 次算进去：那样 `attempts` 一诞生就是 2，而上限 `RETRY_MAX = 6`
   *    会被提前两次用完 —— 页面显示"最多重投 6 次"、实际只重投 4 次，是最难发现的那种不一致。
   *    内联尝试次数是**策略常量**（`MAX_ATTEMPTS`），不是每条记录的属性。
   */
  function enqueueFailure({ tenantId, row, event, payload, result, deliveryId }) {
    const now = nowIso();
    try {
      run(
        `INSERT INTO ${DELIVERY_TABLE}
           (id, tenant_id, channel_id, channel_name, event, payload_json, status, attempts,
            last_error, last_status, next_retry_at, first_failed_at, last_attempt_at, delivered_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [String(deliveryId), String(tenantId), String(row.id), String(row.name), String(event),
          JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
          0,
          String(result.error || ('HTTP ' + result.status)),
          Number(result.status) || 0,
          new Date(Date.parse(now) + retryDelayMs(1)).toISOString(),
          now, now, now]
      );
      return true;
    } catch {
      // 落库失败（磁盘满 / 表被锁）**吞掉**：调用方在 emit 的错误路径上，
      // 在那里再抛一个错会让"通知发不出去"升级成"业务动作失败" —— 那不是事实。
      // 审计里那条 `notify.deliver`(error) 仍在，所以这次投递不是完全无痕。
      return false;
    }
  }

  /**
   * 收尾一条重投：写回 `delivered` / `dead` / 下一次的 `pending`。
   *
   * `notDeliverable`（渠道被删 / 被停用）**不消耗重试次数** —— 那不是"对方拒绝"，
   * 是"现在不该发"。把它当成失败会让"运维先把渠道删了重配"这个很常见的动作
   * 在 6 次之后把记录打成死信，而那件事本身并不表示告警送达不了。
   */
  function settle(rec, attempts, r, { now, notDeliverable = false, manual = false } = {}) {
    const at = new Date(now).toISOString();
    if (r.ok) {
      run(
        `UPDATE ${DELIVERY_TABLE} SET status='delivered', attempts=?, last_attempt_at=?,
           last_error=NULL, last_status=?, next_retry_at=NULL, delivered_at=? WHERE id = ?`,
        [attempts, at, Number(r.status) || 0, at, rec.id]
      );
      return { status: 'delivered', attempts, httpStatus: Number(r.status) || 0 };
    }
    const nextAttempts = notDeliverable ? Number(rec.attempts || 0) : attempts;
    const err = String(r.error || ('HTTP ' + r.status));
    if (!notDeliverable && !manual && attempts >= RETRY_MAX) {
      run(
        `UPDATE ${DELIVERY_TABLE} SET status='dead', attempts=?, last_attempt_at=?,
           last_error=?, last_status=?, next_retry_at=NULL WHERE id = ?`,
        [attempts, at, err, Number(r.status) || 0, rec.id]
      );
      return { status: 'dead', attempts, error: err, note: '已达重投上限，保留可手动重投' };
    }
    // 手动重投失败时也保持 pending：**人的明确意志不该被自动上限掐掉**，
    // 而且"我修好接收端了、再发一次"通常要试不止一次。
    const next = new Date(now + retryDelayMs(nextAttempts + 1)).toISOString();
    run(
      `UPDATE ${DELIVERY_TABLE} SET status='pending', attempts=?, last_attempt_at=?,
         last_error=?, last_status=?, next_retry_at=? WHERE id = ?`,
      [nextAttempts, at, err, Number(r.status) || 0, next, rec.id]
    );
    return { status: 'pending', attempts: nextAttempts, nextRetryAt: next, error: err };
  }

  /**
   * 重投**一条**记录。
   *
   * 重投时**重新解密 URL、重新做 SSRF 校验**（`deliverTo` 内部每次都做）——
   * 绝不缓存首次投递时解析出的 IP：主机名的解析结果会变（DNS 重绑定），
   * 只在写入时判一次等于把安全边界钉死在过去。
   */
  async function deliverOne(rec, now) {
    const attempts = Number(rec.attempts || 0) + 1;
    // 按 (tenant_id, id) 取渠道，而不是只按 id —— 虽然 `rec` 本身就是从「按租户过滤后的」
    // 投递记录里取出来的，但**静态隔离扫描**看不穿这层推导，它只认 SQL 里有没有租户条件。
    // 与其写一条豁免注释，不如让这条查询本身就带上租户：豁免注释是"这里我们知道自己是安全的"，
    // 而带上条件之后就不需要任何人相信这句话了。
    const row = get(
      'SELECT * FROM notify_channels WHERE tenant_id = ? AND id = ?',
      [String(rec.tenant_id), String(rec.channel_id)]
    );
    if (!row) {
      return settle(rec, attempts, {
        ok: false, status: 0, attempts: 0,
        error: '渠道已被删除（失败记录保留；重配同名渠道后仍可手动重投）',
      }, { now, notDeliverable: true });
    }
    if (!row.enabled) {
      return settle(rec, attempts, {
        ok: false, status: 0, attempts: 0,
        error: '渠道已停用（启用后会继续自动重投）',
      }, { now, notDeliverable: true });
    }
    const body = buildBody(String(rec.event), parseJsonSafe(rec.payload_json, {}), rec.tenant_id);
    const r = await deliverTo(row, body, rec.id);      // ⚠️ 复用同一条记录的 id 作为幂等 id
    recordDelivery(row, r);
    auditDelivery(String(rec.tenant_id), row, rec.event, r, { retry: true });
    return settle(rec, attempts, r, { now, manual: !!rec.__manual });
  }

  /**
   * 重投**已到期**的失败投递（由定时任务 `notify.retry` 调用）。
   *
   * `tenantId` **必填**：定时任务本身就是按组织跑的（`scheduled_jobs` 带 `tenant_id`），
   * 所以没有任何合法场景需要"跨组织一次全投"。而一个可选的 tenantId 意味着
   * "忘传就静默处理别家数据" —— 这种错误不会有任何报错，只会在一段时间后
   * 表现为"某组织的告警被别人的任务发了两次"。从**接口形状**上杜绝它，与
   * `identity/repos/orgs.mjs` 顶部那条纪律同源。
   *
   * @param {{tenantId:string, limit?:number, now?:number}} opts `now` 可注入，
   *   便于回归不靠真的等 10 分钟。
   */
  async function retryPending({ tenantId, limit = 50, now = Date.now() } = {}) {
    if (!tenantId) throw new Error('retryPending 必须给定 tenantId（不做跨租户的全局重投）');
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const iso = new Date(now).toISOString();
    const rows = all(
      `SELECT * FROM ${DELIVERY_TABLE} WHERE tenant_id = ? AND status = 'pending' AND next_retry_at <= ?
       ORDER BY next_retry_at ASC LIMIT ?`,
      [String(tenantId), iso, lim]
    );

    let delivered = 0;
    let failed = 0;
    let dead = 0;
    const results = [];
    for (const rec of rows) {
      const r = await deliverOne(rec, now);
      results.push({ id: rec.id, channel: rec.channel_name, event: rec.event, ...r });
      if (r.status === 'delivered') delivered++;
      else if (r.status === 'dead') dead++;
      else failed++;
    }
    return { ok: failed === 0, picked: rows.length, delivered, failed, dead, results, maxAttempts: RETRY_MAX };
  }

  /**
   * 手动重投（管理员在页面上点一条）。立即投一次，不受 `next_retry_at` 与重投上限约束。
   *
   * 为什么允许"死信复活"：`dead` 表示**平台放弃了自动重试**，不表示"这条告警不重要"。
   * 而人通常是在把接收端修好之后才回来的 —— 那时最自然的动作就是"就这条，再发一次"。
   */
  async function redeliverNow(tenantId, id, { now = Date.now() } = {}) {
    const rec = get(
      `SELECT * FROM ${DELIVERY_TABLE} WHERE tenant_id = ? AND id = ?`,
      [String(tenantId), String(id)]
    );
    if (!rec) return { ok: false, reason: 'not_found', error: '投递记录不存在：' + id };
    const wasDead = rec.status === 'dead';
    const r = await deliverOne({ ...rec, __manual: true }, now);
    return {
      ok: true,
      wasDead,
      result: r,
      delivery: getDelivery(tenantId, id),
    };
  }

  /**
   * 清理**终态**记录（`delivered` / `dead`）中超过保留期的行，避免表无界增长。
   * ⚠️ 只删终态：`pending` 是"还欠着一条告警"，任何情况下都不删 ——
   * 清理任务把待重投的记录删掉，等于把"告警会丢"这件事重新引回来。
   *
   * `tenantId` **必填**（同 `retryPending` 的理由，而且这里更严重：忘传就是**删别家的数据**）。
   */
  function purgeDeliveries({ tenantId, keepDays = DELIVERY_KEEP_DAYS, now = Date.now() } = {}) {
    if (!tenantId) throw new Error('purgeDeliveries 必须给定 tenantId（不做跨租户的全局清理）');
    const days = Number(keepDays) > 0 ? Number(keepDays) : DELIVERY_KEEP_DAYS;
    const before = new Date(now - days * 86400000).toISOString();
    const r = run(
      `DELETE FROM ${DELIVERY_TABLE} WHERE tenant_id = ? AND status IN ('delivered','dead') AND created_at < ?`,
      [String(tenantId), before]
    );
    return { keepDays: days, removed: Number((r && r.changes) || 0) };
  }

  /* ── 投递 ── */

  function buildBody(event, payload, tenantId) {
    const data = payload && typeof payload === 'object' ? payload : {};
    // `text` 是给**通用 webhook** 接收端的一行摘要（人一眼能读懂的那句话）；JSON 明细在 `data` 里。
    // ⚠️ 它**不是**企微/钉钉自定义机器人的渲染依据 —— 那两类接收端只认各自的 `msgtype` 信封，
    //    收到本报文会回 HTTP 200 但不渲染（这正是"静默丢失"的样子，见 robotSinkOf 注释）。
    const text = '[STI HARNESS] ' + event + '：' + (data.note || data.name || data.message || JSON.stringify(data).slice(0, 200));
    return { event, at: nowIso(), tenantId: String(tenantId), text, data };
  }

  async function postOnce(url, body, credential, deliveryId, sink = '') {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    t.unref && t.unref();
    const payload = JSON.stringify(body);
    const headers = {
      'content-type': 'application/json',
      ...(credential ? { authorization: 'Bearer ' + credential } : {}),
      // 幂等提示：同一条投递在**首次尝试与后续所有重投**之间共用这个值。
      // 平台只能做到 at-least-once（见文件头边界 ②），所以把"去重"这件事
      // 明确交到最清楚语义的一方 —— 接收方。这不是补救，是唯一正确的分工。
      ...(deliveryId ? { 'x-sti-delivery-id': String(deliveryId) } : {}),
    };
    // HMAC 请求签名：内网 webhook URL 常内嵌 token（在 query 串里），
    // 同网段的旁观者看得见也重放得了。签名让**持有主密钥的接收方**能确认
    // "包来自这台平台，且 body 与时间戳未被篡改"。验算方式（接收方）：
    //   HMAC-SHA256(masterSecret, `${x-sti-timestamp}.${rawBody}`)
    //     === x-sti-signature 去掉 'sha256=' 前缀（hex，等值比较用 timingSafeEqual）
    // 时间戳进签名串，接收方能拒绝陈旧重放（建议 ±5 分钟窗口）。
    // 每次投递（含重投）独立签：body 相同、时间戳是新的。
    // 未装配主密钥就不签 —— 装配缺陷会先在 deliverTo 被拦，这里只是兜底。
    if (masterSecret) {
      const ts = Math.floor(Date.now() / 1000);
      headers['x-sti-timestamp'] = String(ts);
      headers['x-sti-signature'] = 'sha256='
        + crypto.createHmac('sha256', masterSecret).update(ts + '.' + payload).digest('hex');
    }
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: ctl.signal,
        redirect: 'follow',
      });
      if (!r.ok) return { ok: false, status: r.status };
      // 机器人接收端（企微/钉钉）HTTP 200 只代表"收到了请求"：成败必须读回执 errcode，
      // 否则 key 失效（93000）这类拒绝会被记成"投递成功"—— 消息没到，报表却说到了。
      if (!sink) return { ok: true, status: r.status };
      let receipt = '';
      try { receipt = await r.text(); } catch { receipt = ''; }
      const rejected = robotReceiptError(receipt);
      return rejected ? { ok: false, status: r.status, error: rejected } : { ok: true, status: r.status };
    } catch (e) {
      return { ok: false, status: 0, error: e && e.message ? e.message : String(e) };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * 投递到单个渠道（含重试与结果记账）。
   * @param {object} row notify_channels 行
   * @param {object} body 已构造好的报文
   * @param {string} [deliveryId] 幂等 id（首次投递与重投之间不变，见 postOnce 注释）
   * @returns {Promise<{ok:boolean, status:number, attempts:number, error?:string}>}
   */
  async function deliverTo(row, body, deliveryId) {
    let credential = '';
    if (row.credential_name && resolveCredential) {
      try { credential = resolveCredential(String(row.tenant_id), row.credential_name) || ''; }
      catch { credential = ''; }
    }
    if (!decryptSecret || !masterSecret) {
      return { ok: false, status: 0, attempts: 0, error: '平台未装配解密（装配缺陷）' };
    }
    let url;
    try { url = decryptSecret(row.url_cipher, masterSecret); }
    catch (e) { return { ok: false, status: 0, attempts: 0, error: '渠道 URL 解密失败：' + (e && e.message) }; }

    const safe = await assertSafeTarget(url, { allowLoopback });
    if (!safe.ok) return { ok: false, status: 0, attempts: 0, error: safe.error };

    // 直达企微/钉钉自定义机器人换信封（见 robotSinkOf 注释）—— 必须在 decrypt 之后：
    // host 是识别依据，而 URL 是加密存的。每次投递都重算，重投与试发自然同享。
    const sink = robotSinkOf(url);
    const outbound = adaptBodyForSink(sink, body);

    let last = { ok: false, status: 0, error: '未尝试' };
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      last = await postOnce(url, outbound, credential, deliveryId, sink);
      if (last.ok) return { ok: true, status: last.status, attempts: i + 1 };
      if (i + 1 < MAX_ATTEMPTS) await new Promise((r) => { const s = setTimeout(r, BACKOFF_MS * (i + 1)); s.unref && s.unref(); });
    }
    return { ok: false, status: last.status || 0, attempts: MAX_ATTEMPTS, error: last.error || ('HTTP ' + last.status) };
  }

  function recordDelivery(row, r) {
    run(
      `UPDATE notify_channels SET last_delivery_at = ?, last_status = ?, fail_count = fail_count + ?
         WHERE tenant_id = ? AND id = ?`,
      [nowIso(), r.ok ? 'ok' : 'fail', r.ok ? 0 : 1, String(row.tenant_id), String(row.id)]
    );
  }

  function auditDelivery(tenantId, row, event, r, extra = {}) {
    if (!audit) return;
    try {
      audit.append({
        tenantId, userId: null,
        action: 'notify.deliver',
        resourceType: 'notify', resourceId: row.id,
        result: r.ok ? 'ok' : 'error',
        detail: {
          event, channel: row.name, kind: row.kind,
          attempts: r.attempts, status: r.status,
          ...(extra.retry ? { retry: true } : {}),
          ...(r.error ? { error: r.error } : {}),
        },
      });
    } catch { /* 留痕失败不影响投递 */ }
  }

  /**
   * 发一个事件。找不到任何订阅的启用渠道时返回 `delivered: 0` 且 `ok: true`
   * —— **"没人订阅"不是失败**，把它记成失败会让"投递成功率"这个数字从一开始就是假的。
   *
   * @param {object} p
   * @param {number} [p.cooldownMs] 节流窗口（毫秒）。`0`/省略 = 不节流（既有事件行为不变）
   * @param {string} [p.dedupeKey] 节流分键：同租户 + 同事件 + 同键在窗口内只出站一次
   * @returns {Promise<{ok:boolean, event:string, delivered:number, failed:number, queued:number, throttled?:boolean, results:Array<object>}>}
   *   `queued` = 这次失败中有几条**成功落了重投队列**（落库失败时为 0 —— 那说明磁盘/表出了问题，
   *   调用方看到 `failed > 0 && queued < failed` 就该知道"这几条真的会丢"）。
   */
  async function emit({ tenantId, event, payload = {}, cooldownMs = 0, dedupeKey = '' }) {
    const ev = String(event || '');
    if (!NOTIFY_EVENTS.includes(ev)) return { ok: false, event: ev, delivered: 0, failed: 0, error: '未知事件', results: [] };
    const rows = all('SELECT * FROM notify_channels WHERE tenant_id = ? AND enabled = 1', [String(tenantId)]);
    const targets = rows.filter((r) => parseEvents(r.events_json).includes(ev));
    if (!targets.length) return { ok: true, event: ev, delivered: 0, failed: 0, results: [], note: '没有订阅该事件的启用渠道' };

    // ── 节流（顺序是刻意的）────────────────────────────────────────────
    // ⚠️ 必须在"确认有渠道会收到"**之后**才计时：否则一次**没人订阅**的拦截会把窗口占掉，
    //    等运维事后配好渠道，窗口内真正该收到的那条反而被合并没了。
    //    "没有订阅"不消耗窗口；**产生过一次投递尝试**才消耗 —— 包括失败那一次
    //    （失败已经入了重投队列，再放行只会变成重复投递）。这两件事不能混。
    if (cooldownMs > 0) {
      const key = cooldownKey(tenantId, ev, dedupeKey);
      const now = Date.now();
      const last = COOLDOWN.get(key);
      if (last != null && now - last < cooldownMs) {
        return {
          ok: true, event: ev, delivered: 0, failed: 0, queued: 0, throttled: true, results: [],
          // 如实说清"没发"与"为什么"，以及"下一次什么时候能发"——
          // 否则运维会以为告警链路坏了（这和"不知道"一样难查）。
          note: '节流：同类告警在 ' + Math.round(cooldownMs / 60000) + ' 分钟内已投递过，本次合并；'
            + Math.round((cooldownMs - (now - last)) / 1000) + ' 秒后可再发（每一次拦截本身仍逐条在审计里）',
        };
      }
      COOLDOWN.set(key, now);
      if (COOLDOWN.size > 256) sweepCooldown(cooldownMs);
    }

    const body = buildBody(ev, payload, tenantId);
    const results = [];
    let delivered = 0;
    let failed = 0;
    let queued = 0;
    for (const row of targets) {
      // 先定 id 再投递：它在**首次尝试与之后所有重投**之间保持不变，
      // 作为 `X-STI-Delivery-Id` 让接收方能对重复投递去重（我们只能保证 at-least-once）。
      const deliveryId = newId('ndl');
      const r = await deliverTo(row, body, deliveryId);
      recordDelivery(row, r);
      auditDelivery(String(tenantId), row, ev, r);
      if (r.ok) delivered++;
      else {
        failed++;
        // ⚠️ 只有**真事件**在这里入队。试发（`testChannel`）刻意不入队 ——
        //    那是人在旁边看着的动作，失败会立刻显示给操作者；
        //    把它丢进队列只会让"待处理告警"这个数字被无效测试数据污染。
        if (enqueueFailure({ tenantId, row, event: ev, payload, result: r, deliveryId })) queued++;
      }
      results.push({
        channel: row.name, ok: r.ok, status: r.status, attempts: r.attempts, deliveryId,
        ...(r.ok ? {} : { queued: true }),
        ...(r.error ? { error: r.error } : {}),
      });
    }
    return { ok: failed === 0, event: ev, delivered, failed, queued, results };
  }

  /**
   * 试发（管理员点"测试"按钮）。
   * 与 `emit` 的区别：**不要求渠道订阅了某个具体事件** —— 否则新渠道订阅列表为空时
   * 根本没法测试它通不通。测试结果里带 `event:'notify.test'`，接收方一眼能认出。
   */
  async function testChannel(tenantId, id) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '渠道不存在：' + id };
    const r = await deliverTo(row, buildBody('notify.test', { note: '这是一条测试通知' }, tenantId));
    recordDelivery(row, r);
    auditDelivery(String(tenantId), row, 'notify.test', r);
    return { ok: true, channel: row.name, result: r, channelState: getChannel(tenantId, id) };
  }

  function status(tenantId) {
    const rows = listChannels(tenantId);
    const queue = deliveryStats(tenantId);
    return {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      failing: rows.filter((r) => r.lastStatus === 'fail').length,
      events: NOTIFY_EVENTS.slice(),
      kinds: SINK_KINDS.slice(),
      deliveries: rows.reduce((n, r) => n + r.failCount, 0),
      /** 重投队列的三个状态计数 —— 页面上的"待重投 N 条"就是 `queue.pending` */
      queue,
      boundaries: '投递先尽力而为（单次最多 ' + MAX_ATTEMPTS + ' 次内联尝试），失败落 `notify_deliveries` 队列，'
        + '由定时任务 `notify.retry` 重投（最多 ' + RETRY_MAX + ' 次，指数退避封顶 1 小时，'
        + '超过转 dead 并保留可见、可手动重投）。'
        + '⚠️ 语义是 at-least-once：重投时接收方可能收到重复，请用 `X-STI-Delivery-Id` 去重 ——'
        + '平台做不到"确认对方只处理了一次"，那是分布式事务的范畴。'
        + '⚠️ 重投由本机单进程的调度器执行（与其它定时任务同一约束：无分布式锁）；'
        + '平台整体停机期间的告警仍会丢，变的只是"上游抖动不再等于告警丢失"。'
        + '渠道 URL 加密存放，接口只回显 host。',
    };
  }

  return {
    listChannels, getChannel, createChannel, updateChannel, deleteChannel,
    emit, testChannel, status,
    // 重投队列（§B5）
    listDeliveries, redeliverNow, retryPending, purgeDeliveries,
    /** 供自检与测试复用（纯函数 + DNS 解析） */
    assertSafeTarget,
    /** 同步的 scheme 校验（写入路径用它，见 assertScheme 的注释） */
    assertScheme,
    /** 重投退避曲线的纯函数（回归直接断言它，不用真的等 10 分钟） */
    retryDelayMs,
    /** 常量导出：页面与文档要显示"最多重投几次"，不该各自抄一份 */
    retryPolicy: { maxAttempts: RETRY_MAX, baseMs: RETRY_BASE_MS, capMs: RETRY_CAP_MS, keepDays: DELIVERY_KEEP_DAYS },
    close() { /* 无后台资源 */ },
  };
}

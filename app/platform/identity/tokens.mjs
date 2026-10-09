/**
 * 会话令牌与 API Key —— 服务端**永不存明文**。
 *
 * 设计要点（三条，缺一条都会让"令牌在库里"变成可利用的凭据）：
 *
 *  1. 令牌本身是 32 字节 CSPRNG 随机 → 不可预测、不可枚举。
 *  2. 落库的是 `HMAC-SHA256(masterSecret, token)`，**不是** `sha256(token)`。
 *     差别很关键：主密钥在 `data/.secret`（独立文件、不入版本库、与库分开备份），
 *     所以整个数据库文件被拷走也无法伪造令牌 —— 没有主密钥就算不出匹配的哈希。
 *     sha256 则不需要任何秘密，拿到库就能离线穷举（虽然 32 字节随机穷举不现实，
 *     但"库泄露 = 凭据可离线攻击面"这个性质本身就不该存在）。
 *  3. 校验走等值比较（先 HMAC 再比字符串），不暴露逐字符差异。
 *
 * 令牌格式：`sti_<id>.<secret>` / `stik_<id>.<secret>` / `stc_<id>.<secret>`
 *   · 前缀便于日志里一眼区分令牌类型，也便于泄漏告警扫描；
 *   · `<id>` 只是**便于人看**（哪条记录），校验**不依赖**它 —— 直接用 HMAC 查表；
 *   · `stc_` 是两步登录的**短期票据**（第二步出示，5 分钟过期、单次消费），
 *     刻意不叫 `stit_`：那会与 `sti_` 前缀包含关系纠缠（`authenticate` 里
 *     `startsWith('sti_')` 会把它误收进会话分支），换一个不重叠的前缀省掉这份心算。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import crypto from 'node:crypto';
import { newId } from '../../util/ids.mjs';

export const SESSION_PREFIX = 'sti_';
export const APIKEY_PREFIX = 'stik_';
/** 两步登录票据前缀（TOTP challenge ticket）—— 与上两者无前缀包含关系 */
export const CHALLENGE_PREFIX = 'stc_';
/**
 * 会话 cookie 名。
 *  · `sti_session`：HTTP（本地开发 / 无 TLS 内网）下用；
 *  · `__Host-sti_session`：HTTPS 下用 —— `__Host-` 前缀由浏览器强制校验：
 *    必须 Secure、必须 Path=/、禁止 Domain 属性，因此**其它子域与非安全源
 *    无法设置或覆盖它**（防"兄弟站点/子域注入会话 cookie"这类固定攻击）。
 * 读取时两个名字都认（HTTPS 历史会话仍是旧名），`__Host-` 优先。
 */
export const SESSION_COOKIE = 'sti_session';
export const SESSION_COOKIE_HOST = '__Host-sti_session';

const SECRET_BYTES = 32;
const DEFAULT_TTL_MS = 8 * 3600 * 1000;   // 8 小时

/**
 * 令牌 → 存储用的哈希。**所有**令牌落库前都必须过这个函数。
 * @param {string} token 明文令牌（只在此刻存在于内存）
 * @param {Buffer|string} masterSecret 来自 data/.secret，与数据库分开存放
 */
export function hashToken(token, masterSecret) {
  if (!masterSecret) throw new Error('缺少主密钥，无法计算令牌哈希');
  return crypto.createHmac('sha256', masterSecret).update(String(token)).digest('hex');
}

function mint(prefix, idPrefix) {
  const id = newId(idPrefix);
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { id, token: prefix + id + '.' + secret };
}

/**
 * 签发会话令牌。
 * @returns {{id:string, token:string, tokenHash:string, expiresAt:string}}
 */
export function issueSessionToken(masterSecret, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const { id, token } = mint(SESSION_PREFIX, 'as');
  return {
    id,
    token,
    tokenHash: hashToken(token, masterSecret),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

/**
 * 签发 API Key（给自动化/集成用的长期令牌）。
 * @returns {{id:string, key:string, keyHash:string, expiresAt:string|null}}
 */
export function issueApiKey(masterSecret, { ttlMs = null } = {}) {
  const { id, token } = mint(APIKEY_PREFIX, 'ak');
  return {
    id,
    key: token,
    keyHash: hashToken(token, masterSecret),
    expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null,
  };
}

/**
 * 签发两步登录的"第二步票据"（TOTP 挑战）。
 * 与其它令牌同纪律：CSPRNG 随机 + 落库 HMAC 哈希；单次消费与尝试上限
 * 由 `login_challenges` 的条件更新保证（见 repos/totp.mjs）。
 * @returns {{id:string, ticket:string, ticketHash:string}}
 */
export function issueChallengeTicket(masterSecret) {
  const { id, token } = mint(CHALLENGE_PREFIX, 'tc');
  return { id, ticket: token, ticketHash: hashToken(token, masterSecret) };
}

/**
 * 从请求里取出令牌。支持三种携带方式（顺序即优先级）：
 *   · `Authorization: Bearer <token>`（集成/脚本首选）
 *   · `x-sti-token: <token>`（避免某些代理改写 Authorization）
 *   · Cookie `sti_session`（浏览器）
 *
 * ⚠️ **不支持** query string 携带：URL 会进访问日志、浏览器历史、Referer。
 *     宁可让调用方改 header，也不接受一个"会把令牌写进日志"的入口。
 *
 * @returns {{token:string|null, via:string|null}}
 */
export function extractToken(req) {
  const h = (req && req.headers) || {};
  const auth = h.authorization || h.Authorization;
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) {
    const t = auth.replace(/^bearer\s+/i, '').trim();
    if (t) return { token: t, via: 'authorization' };
  }
  const x = h['x-sti-token'];
  if (typeof x === 'string' && x.trim()) return { token: x.trim(), via: 'x-sti-token' };

  const cookie = h.cookie || h.Cookie;
  if (typeof cookie === 'string') {
    // 两个名字都认（过渡期：HTTPS 升级前签发的会话仍是旧名）；`__Host-` 优先 —— 它更难被伪造/覆盖。
    let host = null;
    let legacy = null;
    for (const part of cookie.split(';')) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      const nm = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (!v) continue;
      if (nm === SESSION_COOKIE_HOST) host = v;
      else if (nm === SESSION_COOKIE) legacy = v;
    }
    const picked = host || legacy;
    if (picked) return { token: decodeURIComponent(picked), via: 'cookie' };
  }
  return { token: null, via: null };
}

/** 显式声明"令牌来自 Cookie" —— 用于 CSRF 判定（见 routes/identity 与 deploy.md） */
export function isCookieAuth(via) {
  return via === 'cookie';
}

/** 只回显前缀，用于"我在看哪个令牌"而不泄漏明文 */
export function tokenHint(token) {
  const s = String(token || '');
  return s.length <= 12 ? '<token>' : s.slice(0, 12) + '…';
}

/**
 * 构造 Set-Cookie。
 * HTTPS 下用 `__Host-sti_session`（浏览器强制 Secure + Path=/ + 无 Domain，
 * 子域与非安全源设置/覆盖不了它）；HTTP（本地开发）回落 `sti_session`。
 */
export function sessionCookie(token, { maxAgeSec = 8 * 3600, secure = false } = {}) {
  const parts = [
    (secure ? SESSION_COOKIE_HOST : SESSION_COOKIE) + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.max(0, Math.floor(maxAgeSec)),
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 清除当前模式下的会话 cookie（登出用同样的名字 + Max-Age=0） */
export function clearSessionCookie({ secure = false } = {}) {
  const parts = [
    (secure ? SESSION_COOKIE_HOST : SESSION_COOKIE) + '=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 清除**两个**名字的历史 cookie —— 过渡期用：HTTPS 下浏览器里可能还留着
 * 升级前签发的 `sti_session`，只清新名会留下一个"看似还活着"的死 cookie。
 * 返回数组（Set-Cookie 支持多条）；HTTP 下只有一个名字，数组也只有一条。
 */
export function clearAllSessionCookies({ secure = false } = {}) {
  return secure
    ? [clearSessionCookie({ secure: true }), clearSessionCookie({ secure: false })]
    : [clearSessionCookie({ secure: false })];
}

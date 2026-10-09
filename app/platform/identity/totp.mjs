/**
 * TOTP 两步验证 —— RFC 6238 纯函数（SHA-1 / 6 位 / 30 秒周期 / ±1 窗口）。
 *
 * 这个模块**不碰数据库、不碰请求**：密钥进、判定出。落库与流程编排在
 * `repos/totp.mjs` 与 `service.mjs` —— 纯函数的正确性可以用 RFC 附录 B 的
 * 测试向量逐条钉死（见 tools/test-core.mjs），不需要任何桩。
 *
 * 三个"必须如此"的设计点：
 *   1. 密钥是 **Base32 字符串**（20 字节随机 → 32 个字符）：验证器 App 扫码/
 *      手输都用这个格式；HMAC 前再解码回字节。
 *   2. 校验**返回命中的步号**而不是布尔 —— 服务层要把步号写进 `last_used_step`
 *      防重放：同一个窗口（或更早）的码不能再用第二次。
 *   3. 恢复码比较前**归一化**（大写、去掉连字符/空格/无关字符）：
 *      用户抄写时会换大小写、丢连字符，归一化让这些差异不构成"码错了"。
 *
 * ⚠️ 为什么不用 `crypto.timingSafeEqual` 之外的比较：6 位数字码比对若用 `===`，
 *    理论上可被逐位计时探测；虽然网络噪声下几乎不可行，但常值比较是零成本的纪律。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import crypto from 'node:crypto';
import { hashToken } from './tokens.mjs';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SEC = 30;
export const TOTP_WINDOW = 1;            // ±1 个步（容忍客户端时钟偏差 ±30s）
export const TOTP_SECRET_BYTES = 20;     // RFC 6238 SHA-1 推荐长度
export const RECOVERY_CODE_COUNT = 10;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';   // RFC 4648 Base32

/** Base32 编码（无填充，字母表大写） */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Base32 解码。宽容输入（大小写、连字符、空格、填充 `=` 一律忽略）——
 * 编码侧永远输出规范形式，这里的宽容只服务于"用户手抄回来的"字符串。
 */
export function base32Decode(str) {
  const s = String(str == null ? '' : str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 生成新密钥：20 字节 CSPRNG → Base32（32 字符，验证器 App 手输友好） */
export function generateSecret(bytes = TOTP_SECRET_BYTES) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** 常值比较（等长前提；长度不同直接 false，长度本身不是秘密） */
function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * HOTP（RFC 4226）：HMAC-SHA1 → 动态截断 → 取末 `digits` 位。
 * `secret` 用**字节**（Base32 解码后的），counter 是 8 字节大端。
 */
export function hotp(secret, counter, digits = TOTP_DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24)
    | ((mac[off + 1] & 0xff) << 16)
    | ((mac[off + 2] & 0xff) << 8)
    | (mac[off + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** 时间 → 步序号（T = floor(unix 秒 / 周期)） */
export function totpStepAt(timeMs = Date.now(), periodSec = TOTP_PERIOD_SEC) {
  return Math.floor(timeMs / 1000 / periodSec);
}

/** 取某时刻的验证码（供测试/自检；登录校验走 verifyTotp） */
export function totpAt(secretBase32, timeMs = Date.now()) {
  const step = totpStepAt(timeMs);
  return { code: hotp(base32Decode(secretBase32), step), step };
}

/**
 * 校验用户输入的验证码。
 *
 * @param {string} secretBase32 存储的 Base32 密钥（服务层先解密再传进来）
 * @param {string} code 用户输入（6 位数字；允许前后空白）
 * @param {{timeMs?:number, window?:number, lastUsedStep?:number|null}} opts
 * @returns {{ok:boolean, step?:number, reason?:string}}
 *   · 命中返回 `{ok:true, step}` —— **调用方必须把 step 写回 last_used_step**；
 *   · `lastUsedStep` 给定时，步号 ≤ 它的一律不匹配（防重放：窗口内同一码只能用一次）。
 */
export function verifyTotp(secretBase32, code, { timeMs = Date.now(), window = TOTP_WINDOW, lastUsedStep = null } = {}) {
  const input = String(code == null ? '' : code).trim();
  if (!/^\d{6}$/.test(input)) return { ok: false, reason: 'format' };
  const secret = base32Decode(secretBase32);
  if (!secret.length) return { ok: false, reason: 'bad-secret' };
  const now = totpStepAt(timeMs);
  // 从**未来**往过去试：时钟稍快的客户端（用了 step+1 的码）优先命中，
  // 避免"未来窗口与本窗口同码"时把防重放判定踩到错误的一侧（理论上虽不可能，顺序仍显式写清）。
  for (let s = now + window; s >= now - window; s--) {
    if (s < 0) continue;
    if (lastUsedStep != null && s <= Number(lastUsedStep)) continue;
    if (safeEqualStr(hotp(secret, s), input)) return { ok: true, step: s };
  }
  return { ok: false, reason: 'mismatch' };
}

/**
 * otpauth:// URI（二维码内容，Google Authenticator / 微软验证器 / 1Password 通用）。
 * label 用 `用户名`，issuer 固定平台名 —— 验证器列表里显示"STI HARNESS: username"。
 */
export function otpauthUri({ secret, label, issuer = 'STI HARNESS' }) {
  const path = encodeURIComponent(issuer) + ':' + encodeURIComponent(String(label || 'user'));
  const qs = 'secret=' + encodeURIComponent(String(secret))
    + '&issuer=' + encodeURIComponent(issuer)
    + '&algorithm=SHA1&digits=' + TOTP_DIGITS + '&period=' + TOTP_PERIOD_SEC;
  return 'otpauth://totp/' + path + '?' + qs;
}

/**
 * 生成一次性恢复码：`XXXX-XXXX`（5 字节随机 → 8 个 Base32 字符，40 位熵）。
 * 一次一批（默认 10 个），**明文只在生成响应里出现这一次**。
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(crypto.randomBytes(5));
    out.push(raw.slice(0, 4) + '-' + raw.slice(4));
  }
  return out;
}

/** 归一化恢复码：大写、去掉连字符/空格/一切非 Base32 字符（用户抄写宽容） */
export function normalizeRecoveryCode(code) {
  return String(code == null ? '' : code).toUpperCase().replace(/[^A-Z2-7]/g, '');
}

/**
 * 恢复码的落库哈希。与令牌同纪律：`HMAC-SHA256(masterSecret, 归一化码)` ——
 * 恢复码熵有限，纯 sha256 会让"拿到库"变成可离线穷举。
 */
export function recoveryCodeHash(code, masterSecret) {
  return hashToken(normalizeRecoveryCode(code), masterSecret);
}

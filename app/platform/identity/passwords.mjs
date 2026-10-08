/**
 * 口令哈希 —— scrypt + 每用户独立 salt + 常量时间比较。
 *
 * 为什么用 scrypt 而不是 sha256：口令是**低熵**输入，快速哈希可被 GPU 暴力枚举。
 * scrypt 有意消耗内存与 CPU（默认 N=16384, r=8, p=1 ≈ 16MB/次），
 * 单机规模下登录耗时可接受（几十毫秒），但暴力破解成本被抬高几个数量级。
 *
 * 为什么把参数编进哈希串：将来若调高参数（或换算法），**旧口令仍必须能验证**。
 * 把参数写进 `pwd_hash` 自身（自描述格式），就不用新增列、也不会因参数变更而失效：
 *
 *     scrypt$N=16384,r=8,p=1,keylen=64$<base64 派生密钥>
 *
 * `pwd_salt` 单独一列（base64）。salt 与哈希分开存，便于轮换与审计。
 *
 * ⚠️ 本模块只做**下限**检查（长度/字符类别），不假装能判断"这个口令够不够安全"。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/** 默认参数。改这里只影响**新**口令，旧口令凭哈希串里的参数继续可验证。 */
export const DEFAULT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

const ALGO = 'scrypt';
const SALT_BYTES = 16;
const MAXMEM = 128 * 1024 * 1024;   // scrypt 的 maxmem 需 > 128*N*r

function encode(hashBuf, params) {
  return ALGO + '$N=' + params.N + ',r=' + params.r + ',p=' + params.p + ',keylen=' + params.keylen
    + '$' + hashBuf.toString('base64');
}

/** 解析自描述哈希串。格式不符 → null（调用方按"验证失败"处理，不抛错）。 */
export function decodeHash(stored) {
  const m = /^scrypt\$([^$]*)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ''));
  if (!m) return null;
  const params = { ...DEFAULT_PARAMS };
  for (const kv of m[1].split(',')) {
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    const k = kv.slice(0, i).trim();
    const v = Number(kv.slice(i + 1));
    if (k && Number.isFinite(v)) params[k] = v;
  }
  if (!(params.N > 1) || !(params.r > 0) || !(params.p > 0) || !(params.keylen > 0)) return null;
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (!buf.length) return null;
  return { params, hash: buf };
}

/**
 * 生成口令哈希。
 * @param {string} password
 * @param {{salt?:Buffer, params?:object}} opts
 * @returns {Promise<{hash:string, salt:string, params:object}>} salt 与 hash 均为 base64/自描述串
 */
export async function hashPassword(password, opts = {}) {
  const params = { ...DEFAULT_PARAMS, ...(opts.params || {}) };
  const salt = opts.salt ? Buffer.from(opts.salt) : crypto.randomBytes(SALT_BYTES);
  const buf = await scrypt(Buffer.from(String(password ?? ''), 'utf8'), salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: MAXMEM,
  });
  return { hash: encode(buf, params), salt: salt.toString('base64'), params };
}

/**
 * 校验口令。任何异常（格式坏、salt 缺、参数非法）都返回 false —— 不抛错、不区分原因，
 * 避免把"这个用户存在但口令错"与"这个哈希坏了"泄漏给调用方。
 */
export async function verifyPassword(password, storedHash, storedSalt) {
  const d = decodeHash(storedHash);
  if (!d) return false;
  let salt;
  try { salt = Buffer.from(String(storedSalt || ''), 'base64'); } catch { return false; }
  if (!salt.length) return false;
  let buf;
  try {
    buf = await scrypt(Buffer.from(String(password ?? ''), 'utf8'), salt, d.params.keylen, {
      N: d.params.N, r: d.params.r, p: d.params.p, maxmem: MAXMEM,
    });
  } catch { return false; }
  if (buf.length !== d.hash.length) return false;
  return crypto.timingSafeEqual(buf, d.hash);
}

/**
 * 口令强度下限检查。**只做下限**，不承诺"通过就是强口令"。
 * @returns {{ok:boolean, reason?:string}}
 */
export function checkPasswordStrength(pw) {
  const s = String(pw ?? '');
  if (s.length < 8) return { ok: false, reason: '口令至少 8 位（当前 ' + s.length + ' 位）' };
  if (s.length > 200) return { ok: false, reason: '口令过长（上限 200 字符）' };
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  if (kinds < 2) return { ok: false, reason: '口令需至少包含两类字符（小写 / 大写 / 数字 / 符号）' };
  if (/^(.)\1+$/.test(s)) return { ok: false, reason: '口令不能是单一字符重复' };
  return { ok: true };
}

/** 供自检/文档显示当前默认 KDF 成本（不暴露任何口令信息） */
export function kdfInfo() {
  return {
    algorithm: ALGO,
    ...DEFAULT_PARAMS,
    approxMemMiB: Math.round((128 * DEFAULT_PARAMS.N * DEFAULT_PARAMS.r) / 1024 / 1024),
  };
}

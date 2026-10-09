/**
 * 凭据加密 —— AES-256-GCM，密钥来自 `data/.secret`（与数据库分开存放）。
 *
 * 信封格式（P1-8 起为 v2）：
 *
 *     SE1. base64( kid(8B) ‖ iv(12B) ‖ authTag(16B) ‖ ciphertext )
 *
 *   · kid = SHA-256(主密钥) 前 8 字节 —— 密文自己标明"由哪把密钥加密"。
 *     密钥轮换后新老密钥可并存（`createSecretKeyring`）：新密文用当前密钥，
 *     老密文按 kid 找旧密钥解密；后台重加密（`operation/keyrotate.mjs`）
 *     在启动后逐步把老密文搬到当前密钥，完成轮换。
 *   · 前缀分隔符用 `.`：base64 字母表不含 `.`，v2 与历史 v1（裸 base64）绝不会混淆。
 *
 * 历史格式（v1，安全评审之前的密文，**必须继续能解**）：
 *
 *     base64( iv(12B) ‖ authTag(16B) ‖ ciphertext )
 *
 *   v1 没有 kid，解密时依次尝试密钥环中的密钥（当前密钥优先）；
 *   后台重加密会在首次升级启动后把它们透明改写成 v2。
 *
 * GCM 是**带认证**的加密：密文被改动会在解密时直接失败，而不是悄悄解出一段乱码。
 * iv 每次加密都重新随机 —— 同一明文两次加密结果不同（也顺带避免"相同凭据可被比对"）。
 *
 * 对外接口的纪律：**永不回显明文**。列表接口只给 `name`/`provider`/`updated_at`
 * 与一个"是否有值"的标记；连掩码都不给（掩码会诱导人去比对猜测）。
 *
 * ⚠️ 主密钥丢失 = 已存凭据不可解密，没有任何后门。备份必须包含 `data/.secret`。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import crypto from 'node:crypto';
import { AppError } from '../../util/errors.mjs';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KID_BYTES = 8;
const ALGO = 'aes-256-gcm';
const ENVELOPE_PREFIX = 'SE1.';

function needKey(masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new AppError('internal_error', '主密钥不可用（应为 32 字节），无法加解密凭据', 500);
  }
  return masterKey;
}

/** 计算一把主密钥的 kid（SHA-256 摘要前 8 字节） */
export function secretKid(masterKey) {
  const key = needKey(masterKey);
  return crypto.createHash('sha256').update(key).digest().subarray(0, KID_BYTES);
}

/** 密文是否为 v2 信封（SE1. 前缀；历史 v1 是裸 base64，不含 '.'） */
export function isEnvelopeV2(cipher) {
  return typeof cipher === 'string' && cipher.startsWith(ENVELOPE_PREFIX);
}

/**
 * 读密文头部的 kid。
 * @returns {Buffer|null} v2 → 8 字节 kid；v1 / 坏格式 → null
 */
export function cipherKid(cipher) {
  if (!isEnvelopeV2(cipher)) return null;
  try {
    const buf = Buffer.from(cipher.slice(ENVELOPE_PREFIX.length), 'base64');
    if (buf.length < KID_BYTES) return null;
    return Buffer.from(buf.subarray(0, KID_BYTES));
  } catch { return null; }
}

/**
 * 构造密钥环（P1-8）。
 * @param {Buffer} active 当前（加密）密钥
 * @param {Buffer[]} older 轮换后保留的旧密钥（仅供解密，按 kid 去重）
 * @returns {{active:Buffer, activeKid:Buffer, kidHex:string, older:Buffer[],
 *            byKid:Map<string,Buffer>, findKey(kid:Buffer):Buffer|null}}
 */
export function createSecretKeyring({ active, older = [] } = {}) {
  const activeKey = needKey(active);
  const activeKid = secretKid(activeKey);
  const byKid = new Map();
  byKid.set(activeKid.toString('hex'), activeKey);
  const oldKeys = [];
  for (const k of Array.isArray(older) ? older : [older]) {
    if (!Buffer.isBuffer(k) || k.length !== 32) continue;
    const kid = secretKid(k);
    const hex = kid.toString('hex');
    if (byKid.has(hex)) continue;
    byKid.set(hex, k);
    oldKeys.push(k);
  }
  return {
    active: activeKey,
    activeKid: Buffer.from(activeKid),
    kidHex: activeKid.toString('hex'),
    older: oldKeys,
    byKid,
    findKey(kid) {
      if (!Buffer.isBuffer(kid)) return null;
      return byKid.get(kid.toString('hex')) || null;
    },
  };
}

/** 第二参数既可能是裸 Buffer（历史调用方式），也可能是密钥环 —— 统一成环。 */
function asKeyring(keyOrRing) {
  if (keyOrRing && typeof keyOrRing === 'object' && keyOrRing.byKid instanceof Map) return keyOrRing;
  return createSecretKeyring({ active: keyOrRing });
}

/**
 * 加密一个明文凭据 —— 输出 v2 信封（带 kid）。
 * @param {string} plaintext
 * @param {Buffer} masterKey 32 字节
 * @returns {string} SE1.base64(kid‖iv‖tag‖ciphertext)
 */
export function encryptSecret(plaintext, masterKey) {
  const key = needKey(masterKey);
  const kid = secretKid(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([c.update(Buffer.from(String(plaintext ?? ''), 'utf8')), c.final()]);
  return ENVELOPE_PREFIX + Buffer.concat([kid, iv, c.getAuthTag(), enc]).toString('base64');
}

/** GCM 解密 v2 信封体（kid‖iv‖tag‖ciphertext）；任何失败都抛异常。 */
function gcmDecryptV2(buf, key) {
  let off = KID_BYTES;
  const iv = buf.subarray(off, off + IV_BYTES); off += IV_BYTES;
  const tag = buf.subarray(off, off + TAG_BYTES); off += TAG_BYTES;
  const data = buf.subarray(off);
  const d = crypto.createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/**
 * 解密。支持：
 *   · v2 信封（SE1. 前缀）→ 按 kid 在密钥环里找密钥；
 *   · 历史 v1（裸 base64，无 kid）→ 依次尝试当前密钥与旧密钥。
 * 密文被篡改 / kid 不在环内 / 格式坏 → 抛 AppError（不返回半截内容）。
 * @param {string} cipher
 * @param {Buffer|object} masterKey 32 字节 Buffer，或 createSecretKeyring() 的密钥环
 * @returns {string} 明文
 */
export function decryptSecret(cipher, masterKey) {
  const ring = asKeyring(masterKey);

  // ── v2 信封：按 kid 找密钥 ────────────────────────────────
  if (isEnvelopeV2(cipher)) {
    let buf;
    try { buf = Buffer.from(cipher.slice(ENVELOPE_PREFIX.length), 'base64'); } catch {
      throw new AppError('internal_error', '凭据解密失败（信封格式已损坏）', 500);
    }
    if (buf.length < KID_BYTES + IV_BYTES + TAG_BYTES + 1) {
      throw new AppError('internal_error', '凭据解密失败（信封长度不足，文件可能已损坏）', 500);
    }
    const key = ring.findKey(buf.subarray(0, KID_BYTES));
    if (!key) {
      throw new AppError('internal_error',
        '凭据解密失败（密文由旧版本密钥加密，当前密钥环不包含该密钥；kid='
          + buf.subarray(0, KID_BYTES).toString('hex') + '）', 500);
    }
    try { return gcmDecryptV2(buf, key); } catch {
      throw new AppError('internal_error', '凭据解密失败（主密钥不匹配或密文已损坏）', 500);
    }
  }

  // ── 历史 v1（裸 base64，无 kid）：依次试环内密钥 ─────────
  let buf;
  try { buf = Buffer.from(String(cipher || ''), 'base64'); } catch {
    throw new AppError('internal_error', '凭据密文格式非法', 500);
  }
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new AppError('internal_error', '凭据密文长度不足，文件可能已损坏', 500);
  }
  for (const key of [ring.active, ...ring.older]) {
    try {
      const iv = buf.subarray(0, IV_BYTES);
      const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const data = buf.subarray(IV_BYTES + TAG_BYTES);
      const d = crypto.createDecipheriv(ALGO, key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data), d.final()]).toString('utf8');
    } catch { /* 这把钥匙不对，换下一把 */ }
  }
  // 区分"密钥不对"与"密文损坏"需要额外信息，且这个区分本身有信息价值 —— 一律笼统报错。
  throw new AppError('internal_error', '凭据解密失败（主密钥不匹配或密文已损坏）', 500);
}

/** 可安全对外返回的凭据元信息 —— 注意这里**没有**任何明文/掩码字段 */
export function credentialInfo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider || '',
    hasValue: !!row.cipher,
    updatedAt: row.updated_at,
  };
}

/** 供自检/文档显示的加密参数（不含任何凭据内容） */
export function cryptoInfo() {
  return {
    algorithm: ALGO, ivBytes: IV_BYTES, tagBytes: TAG_BYTES, keyBytes: 32,
    envelope: ENVELOPE_PREFIX.replace('.', ''), kidBytes: KID_BYTES,
  };
}

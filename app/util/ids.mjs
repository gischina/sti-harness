/**
 * ID 与时间工具。零依赖（只用 node:crypto）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import crypto from 'node:crypto';

/**
 * 带前缀的有序 ID：<prefix>_<base32 时间><随机>。可排序、可读、无第三方依赖。
 *
 * ⚠️ `prefix` **必填**（0.13.1 收尾加的守卫）：此前 `governance/artifacts.mjs` 漏传前缀，
 * 于是 `tool_artifacts.id` 全是 `undefined_…`。这种 ID 唯一、也能排序，**跑起来完全不报错**，
 * 所以它一直没被发现 —— 正因如此才要靠一道守卫当场抛错，而不是靠人记得传参。
 */
export function newId(prefix) {
  if (typeof prefix !== 'string' || prefix === '') {
    throw new Error('newId(prefix) 需要非空前缀，例如 newId(\'usr\')');
  }
  const t = Date.now().toString(36).padStart(9, '0');
  const r = crypto.randomBytes(6).toString('hex');
  return prefix + '_' + t + r;
}

/** ISO 时间戳 —— 落库统一用这个格式（可字符串排序，也是 SQLite 文本比较友好的形式） */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 说明（体检 §A2-(a)）：这里曾导出一个 `safeEqual`（常量时间字符串比较）。
 * 它**全仓无调用** —— 真实的令牌校验走 `identity/tokens.mjs` 的 `hashToken`
 * （HMAC-SHA256 后按 token_hash 索引等值查库），不需要逐字节比较。
 * 留着一个"看起来能防时序侧信道"却没人用的工具，只会让后续开发者误以为已有现成件，故删除。
 *
 * 说明（0.13.1 收尾 · 核查 P2）：**同一条判断这次贯彻到另外三个上** ——
 * `uuid()` / `sha256Hex()` / `hmacHex()` 同样是 `app` + `tools` + `public` 三处零命中。
 * 其中 `hmacHex` 尤其值得删：`identity/tokens.mjs` 里另有一套 HMAC（`hashToken`），
 * 把 `hmacHex` 留着，后来者很可能顺手拿它去校验令牌哈希 ——
 * 而两套 HMAC 的**密钥来源与输入编码口径并不一样**，那会是个"安安静静跑通"的错。
 */

/**
 * 主密钥文件 `data/.secret`。
 *
 * 用途：加密数据库里的凭据（credentials / mcp_servers.config_cipher，AES-256-GCM）。
 *
 * ⚠️ **密钥丢失 = 已存凭据不可解密**（没有任何后门）。因此：
 *   · 生成时写 0600 权限；
 *   · 备份策略必须包含这个文件（docs/deploy.md 里写明）；
 *   · 绝不进入分发包（tools/make-dist.mjs 会排除）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const KEY_BYTES = 32;   // AES-256

export function ensureSecret(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== KEY_BYTES) {
      return { ok: false, created: false, error: `密钥文件长度异常（应为 ${KEY_BYTES} 字节，实际 ${buf.length}）` };
    }
    tighten(file);
    return { ok: true, created: false, bytes: buf.length };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { ok: false, created: false, error: '读取密钥文件失败：' + e.message };
    }
  }
  try {
    const buf = crypto.randomBytes(KEY_BYTES);
    fs.writeFileSync(file, buf.toString('base64'), { mode: 0o600, flag: 'wx' });
    tighten(file);
    return { ok: true, created: true, bytes: KEY_BYTES };
  } catch (e) {
    return { ok: false, created: false, error: '生成密钥文件失败：' + e.message };
  }
}

function tighten(file) {
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 上 chmod 语义有限，忽略 */ }
}

/** 只报告状态，**绝不返回密钥内容** */
export function secretInfo(file) {
  try {
    const st = fs.statSync(file);
    return {
      exists: true,
      bytes: st.size,
      mode: (st.mode & 0o777).toString(8),
      createdAt: st.birthtime ? st.birthtime.toISOString() : null,
      // 提供指纹而不是内容：用于确认"两台机器是否同一个密钥"
      fingerprint: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12),
    };
  } catch {
    return { exists: false };
  }
}

/** 读取密钥（仅供加密模块使用；不要在日志/接口里输出它） */
export function loadSecret(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  return Buffer.from(raw, 'base64');
}

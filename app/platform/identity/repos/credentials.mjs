/**
 * 凭据仓储 —— 读写的是**密文**，明文只在 service 层短暂出现。
 *
 * 纪律：
 *   · `listCredentials()` 不返回 `cipher`（列表接口连密文都不该给前端）；
 *   · `getCredentialForUse()` 才返回 `cipher`，命名上写明"这是要去解密的"，
 *     让调用点在 review 时一眼可见 —— 避免"顺手用了列表结果里的密文"。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { run, all, get } from '../../../data/db.mjs';
import { newId, nowIso } from '../../../util/ids.mjs';

/** 按 (org_id, name) 写入或更新；返回 id */
export function upsertCredential({ orgId, name, provider = '', cipher, id = null }) {
  const exist = get('SELECT id FROM credentials WHERE org_id = ? AND name = ?', [orgId, String(name)]);
  const at = nowIso();
  if (exist) {
    run('UPDATE credentials SET provider = ?, cipher = ?, updated_at = ? WHERE id = ?',
      [String(provider || ''), String(cipher), at, exist.id]);
    return exist.id;
  }
  const nid = id || newId('cred');
  run(
    'INSERT INTO credentials (id, org_id, name, provider, cipher, ref_count, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [nid, orgId, String(name), String(provider || ''), String(cipher), at]
  );
  return nid;
}

export function getCredentialById(orgId, id) {
  return get('SELECT id, org_id, name, provider, ref_count, updated_at FROM credentials WHERE org_id = ? AND id = ?', [orgId, id]);
}

/** ⚠️ 会带出密文。只有需要解密的调用点才配用它（见文件头纪律）。 */
export function getCredentialForUse(orgId, name) {
  return get('SELECT * FROM credentials WHERE org_id = ? AND name = ?', [orgId, String(name)]);
}

export function getCredentialForUseById(orgId, id) {
  return get('SELECT * FROM credentials WHERE org_id = ? AND id = ?', [orgId, id]);
}

/**
 * 列表**不含 cipher**，但给出 `has_cipher` 计算列 —— 这样"到底有没有值"如实可见，
 * 又不必把密文带出仓储层。（早期实现忘了这点，导致刚写入的凭据被报成 hasValue:false。）
 */
export function listCredentials(orgId) {
  return all(
    `SELECT id, org_id, name, provider, ref_count, updated_at,
            (CASE WHEN cipher IS NOT NULL AND cipher <> '' THEN 1 ELSE 0 END) AS has_cipher
       FROM credentials WHERE org_id = ? ORDER BY name ASC`,
    [orgId]
  );
}

export function countCredentials(orgId) {
  const r = get('SELECT COUNT(*) AS n FROM credentials WHERE org_id = ?', [orgId]);
  return r ? Number(r.n) : 0;
}

export function deleteCredential(orgId, id) {
  return run('DELETE FROM credentials WHERE org_id = ? AND id = ?', [orgId, id]);
}

/** 供自检用：确认整表**没有任何明文字段**（列名层面就查不到，这里做一次显式断言） */
export function assertNoPlaintextColumns() {
  const cols = all("PRAGMA table_info('credentials')").map((c) => c.name);
  const suspicious = cols.filter((c) => /plain|secret|token|key|password|value/i.test(c) && c !== 'cipher');
  return { columns: cols, suspicious };
}

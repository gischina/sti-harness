/**
 * 版本化迁移执行器。
 *
 * 三条纪律（违反会被直接拒绝执行，而不是"尽力而为"）：
 *  1. **不改历史迁移**：已应用迁移的校验和与文件内容不符 → 硬失败。
 *  2. **不跳版本**：出现一个版本号小于「已应用最大版本」却未应用的文件 → 硬失败
 *     （意味着有人往中间插了一个迁移，或回退了代码但没回退数据）。
 *  3. **单事务应用**：一个迁移文件整体成功或整体回滚，不留半成品。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MIGRATIONS_DIR } from '../paths.mjs';
import { exec, all, run, tx, get } from './db.mjs';

const MAX_FILE_BYTES = 512 * 1024;

function ensureTable() {
  exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

/** 列出迁移文件并按版本排序。文件名约定：NNNN_描述.sql */
export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^\d{4}_.+\.sql$/i.test(f)) continue;
    const full = path.join(dir, f);
    const st = fs.statSync(full);
    if (st.size > MAX_FILE_BYTES) {
      throw new Error(`迁移文件过大（>${MAX_FILE_BYTES} 字节）：${f}`);
    }
    const sql = fs.readFileSync(full, 'utf8');
    out.push({
      version: f.slice(0, 4),
      name: f.replace(/\.sql$/i, ''),
      file: f,
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16),
    });
  }
  out.sort((a, b) => a.version.localeCompare(b.version));
  return out;
}

export function appliedMigrations() {
  ensureTable();
  try {
    return all('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
  } catch {
    return [];
  }
}

/** 计算待应用 / 校验失败 / 断链的情况，供自检与 migrate 共用 */
export function planMigrations(dir = MIGRATIONS_DIR) {
  const files = listMigrationFiles(dir);
  const applied = appliedMigrations();
  const appliedMap = new Map(applied.map((r) => [r.version, r]));
  const maxApplied = applied.length ? applied[applied.length - 1].version : null;

  const pending = [];
  const problems = [];

  for (const f of files) {
    const a = appliedMap.get(f.version);
    if (!a) {
      if (maxApplied && f.version < maxApplied) {
        problems.push({
          kind: 'gap',
          file: f.file,
          message: `迁移 ${f.file} 的版本早于已应用的最大版本 ${maxApplied}，但尚未应用。`
            + '（历史迁移被插入或代码回退但数据未回退）——拒绝执行以免数据错乱。',
        });
      } else {
        pending.push(f);
      }
      continue;
    }
    if (a.checksum !== f.checksum) {
      problems.push({
        kind: 'modified',
        file: f.file,
        message: `已应用的迁移 ${f.file} 内容已被修改（校验和 ${a.checksum} → ${f.checksum}）。`
          + '迁移纪律要求不改历史迁移：请新增一个迁移文件来表达这次变更。',
      });
    }
  }

  return { files, applied, pending, problems, maxApplied, latest: files.length ? files[files.length - 1].version : null };
}

/**
 * 执行迁移。
 * @param {{dir?:string, dryRun?:boolean, onApply?:(f:object)=>void}} opts
 * @returns {{applied:string[], skipped:number, dryRun:boolean}}
 */
export function migrate(opts = {}) {
  const { dir, dryRun = false, onApply } = opts;
  const plan = planMigrations(dir);

  if (plan.problems.length) {
    const lines = plan.problems.map((p) => '  · ' + p.message).join('\n');
    const e = new Error('迁移被拒绝执行：\n' + lines);
    e.code = 'MIGRATION_REJECTED';
    e.problems = plan.problems;
    throw e;
  }

  const appliedNow = [];
  for (const f of plan.pending) {
    if (dryRun) { appliedNow.push(f.version); continue; }
    tx(() => {
      exec(f.sql);
      run(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [f.version, f.name, f.checksum, new Date().toISOString()]
      );
    });
    appliedNow.push(f.version);
    if (onApply) onApply(f);
  }

  return { applied: appliedNow, skipped: plan.applied.length, dryRun };
}

/** 汇总状态给自检 / 状态页（全部是实测值） */
export function migrationStatus(dir = MIGRATIONS_DIR) {
  ensureTable();
  const plan = planMigrations(dir);
  const row = get('SELECT COUNT(*) AS n FROM schema_migrations');
  return {
    dir,
    appliedCount: row ? Number(row.n) : 0,
    totalFiles: plan.files.length,
    pending: plan.pending.map((f) => f.file),
    problems: plan.problems,
    currentVersion: plan.maxApplied,
    latestVersion: plan.latest,
    upToDate: plan.pending.length === 0 && plan.problems.length === 0,
  };
}

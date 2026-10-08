/**
 * SQLite 数据层 —— **本文件是全项目唯一允许 `import 'node:sqlite'` 的地方**。
 *
 * 为什么收口成 4 个原语（exec / all / get / run）：
 * `node:sqlite` 至今仍是 experimental（Node 22/24 上会打印 ExperimentalWarning）。
 * 把驱动能力限制在极小接口内，将来若必须换驱动（如 better-sqlite3），
 * 只需重写本文件，业务层零改动。这是本项目「唯一允许破例引入第三方依赖」的位置。
 *
 * 补充纪律：只用**稳定的 SQL 子集**（普通表、FTS5、json1、BLOB、WAL），
 * 不用任何近期新增的实验性 API。详见 docs/architecture.md §8。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../paths.mjs';

let _db = null;
let _file = null;

/** 打开（或复用）数据库连接，并施加本项目约定的 PRAGMA。 */
export function openDb(file = DB_FILE) {
  if (_db && _file === file) return _db;
  if (_db) closeDb();
  _db = new DatabaseSync(file);
  _file = file;
  // WAL：读不阻塞写。注意 SQLite 仍是**单写者**，写事务之间会串行 —— 见 §7.4 写合并说明。
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  // 写锁竞争时最多等 5s 再报 SQLITE_BUSY，而不是立刻失败（并发写入的第一道缓冲）
  _db.exec('PRAGMA busy_timeout = 5000');
  _db.exec('PRAGMA synchronous = NORMAL');
  return _db;
}

function need() {
  if (!_db) throw new Error('数据库尚未打开：请先调用 openDb()');
  return _db;
}

/** 执行一段（可含多条）SQL，不返回结果。用于 DDL 与 PRAGMA。 */
export function exec(sql) {
  return need().exec(sql);
}

/** 查询多行 → 普通对象数组 */
export function all(sql, params = []) {
  return need().prepare(sql).all(...params);
}

/** 查询单行 → 对象或 undefined */
export function get(sql, params = []) {
  return need().prepare(sql).get(...params);
}

/** 写入 → { changes, lastInsertRowid } */
export function run(sql, params = []) {
  return need().prepare(sql).run(...params);
}

/**
 * 事务包装。**不支持嵌套**——SQLite 的 BEGIN 不能重入。
 * 需要批量写入时优先用它合并提交，而不是逐条 run()（见 §7.4）。
 */
export function tx(fn) {
  const db = need();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败只能上报原始错误 */ }
    throw e;
  }
}

export function closeDb() {
  if (_db) {
    try { _db.close(); } catch { /* 关闭失败不阻塞退出 */ }
    _db = null;
    _file = null;
  }
}

/** 真实探测数据库状态，供自检与状态页使用（报告实测值，不猜） */
export function dbInfo() {
  if (!_db) return { open: false };
  const j = get('PRAGMA journal_mode') || {};
  const pages = get('PRAGMA page_count') || {};
  const size = get('PRAGMA page_size') || {};
  let tables = 0;
  try {
    const r = get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'");
    tables = r ? Number(r.n) : 0;
  } catch { /* 空库时也算正常 */ }
  let bytes = null;
  try { bytes = fs.statSync(_file).size; } catch { /* 内存库或尚未落盘 */ }
  return {
    open: true,
    file: _file,
    journalMode: j.journal_mode || '—',
    pageCount: pages.page_count != null ? Number(pages.page_count) : null,
    pageSize: size.page_size != null ? Number(size.page_size) : null,
    tables,
    bytes,
    sqliteVersion: (get('SELECT sqlite_version() AS v') || {}).v || '—',
  };
}

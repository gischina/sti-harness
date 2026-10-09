/**
 * 按列取单行 —— **租户过滤的落点，必须单点**。
 *
 * 背景（历史体检 assessment-1.2.0 §A1-#3）：`model` / `notify` / `schedule` 三个平台服务
 * 各自写了一份 `rowById` / `rowByName`，函数体只差**表名**：
 *
 *     get('SELECT * FROM <表> WHERE tenant_id = ? AND <列> = ?', [String(tenantId), String(v)])
 *
 * 三份逐字拷贝的风险不在"多写了 6 行"，而在 **`tenant_id = ?` 这个条件本身是安全边界** ——
 * 哪天有人给其中一份加了 `OR ...`、或漏掉租户过滤，泄漏只发生在那一个模块，
 * 且没有任何一处会报错。把它收成一个函数，等于把这条边界也收成一个点。
 *
 * ⚠️ 为什么 `table` / `column` 走**白名单**而不是直接拼字符串：
 *    这两个参数是**开发者常量**（调用方写死），但拼 SQL 的写法一旦铺开，
 *    下一个改动者很可能顺手把某个**外部输入**传进来。白名单让"传了没登记的表/列"
 *    直接抛错，把潜在注入挡在开发期，而不是留到生产。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { get } from '../db.mjs';

/**
 * 允许被 `rowBy` 查询的「带 `tenant_id` 的表」白名单。
 * ⚠️ 新表要能被 `rowBy` 查，**先在这里登记** —— 这是刻意的一道手动门。
 */
const TENANT_SCOPED_TABLES = new Set([
  'model_providers',   // 模型注册表（platform/model）
  'notify_channels',   // 通知渠道（platform/notify）
  'scheduled_jobs',    // 定时任务（platform/schedule）
]);

/** 允许作为查询条件的列白名单（都建了 `(tenant_id, <列>)` 索引或唯一约束）。 */
const SAFE_COLUMNS = new Set(['id', 'name']);

/**
 * 取一行（自动带租户过滤）。找不到返回 `undefined`。
 *
 * @param {string} tenantId 组织 id
 * @param {string} table 表名（必须在 `TENANT_SCOPED_TABLES` 里）
 * @param {'id'|'name'} column 条件列（必须在 `SAFE_COLUMNS` 里）
 * @param {string} value 条件值
 * @returns {object|undefined}
 */
export function rowBy(tenantId, table, column, value) {
  if (!TENANT_SCOPED_TABLES.has(table)) {
    throw new Error('rowBy：表名未登记（' + table + '）—— 请先在 TENANT_SCOPED_TABLES 里显式加入');
  }
  if (!SAFE_COLUMNS.has(column)) {
    throw new Error('rowBy：列名未登记（' + column + '）—— 请先在 SAFE_COLUMNS 里显式加入');
  }
  return get(`SELECT * FROM ${table} WHERE tenant_id = ? AND ${column} = ?`, [String(tenantId), String(value)]);
}

/** `rowBy` 的 `id` 便捷形式。 */
export function rowById(tenantId, table, id) {
  return rowBy(tenantId, table, 'id', id);
}

/** `rowBy` 的 `name` 便捷形式。 */
export function rowByName(tenantId, table, name) {
  return rowBy(tenantId, table, 'name', name);
}

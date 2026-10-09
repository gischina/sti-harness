/**
 * 运维服务（M5）—— operation 模块的门面。
 *
 * 为什么补这一层（P0-D #9）：五个平台模块里，`operation` 是**唯一**没有 service
 * 门面的 —— `backup.mjs` 被路由直接 import，于是"备份目录列举""文件名合法性校验"
 * 这类**业务逻辑**长在了 handler 里（`routes/operation.mjs` 里出现 fs + 路径拼接）。
 * 项目纪律写的是「路由只做：解析请求 → 调 service → 组织响应」，那条纪律在这里破了例。
 *
 * 收口之后：
 *   · 路由不再 import `node:fs` / `node:path` / `backup.mjs`，只认 `deps.operation`；
 *   · 路径校验（`..` / 分隔符 / 绝对路径）只有一处实现，不可能出现"这个接口防了、那个没防"；
 *   · 数据目录由装配层注入（`createOperationService({ dataDir })`），而不是路由自己去翻 deps.paths。
 *
 * 诚实边界：**恢复依然不做在线接口**，见 `backup.mjs` 顶部注释。恢复是离线动作
 * （`tools/restore-backup.mjs`），这里刻意不暴露 `restoreBackup` —— 一个不存在的入口
 * 比一个"存在但请勿调用"的入口安全得多。
 *
 * 删除是**两级结构，护栏一致**：
 *   · 自动轮转（`pruneBackups({ keep })`）：备份目录只增不减会让磁盘无界增长，
 *     而单进程服务磁盘满即挂 —— 这是无人值守也要跑的那一级；
 *   · 人工点名删除（0.18.0 起，`removeByName`）：补的是"想清掉某一份"的日常动作。
 * 两级共用同一套护栏（只认 `backup-*.zip` 形态、绝不删最后一份、连带清理 64-hex 侧车），
 * 差别只在"删哪几份"：轮转删的永远是最旧的，人工删的是点名的某一份。
 * 护栏细节见 `backup.mjs` 的 `removeBackup` / `pruneBackups`。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createBackup, verifyBackup, pruneBackups as pruneBackupsImpl, removeBackup as removeBackupImpl } from './backup.mjs';

export function createOperationService({ dataDir, backupKey = null } = {}) {
  if (!dataDir) throw new Error('createOperationService 需要 dataDir（数据目录，备份落在其 backups/ 下）');

  const backupsDir = () => path.join(String(dataDir), 'backups');

  /**
   * 创建在线备份。返回文件名单独给出，避免调用方各写一遍 path.basename。
   * backupKey 为 null 时由 backup.mjs 生成一次性密钥（包旁同名 .key）。
   */
  function backupNow({ label = '' } = {}) {
    const r = createBackup({ dataDir: String(dataDir), label, key: backupKey });
    return {
      name: path.basename(r.file), file: r.file, bytes: r.bytes, manifest: r.manifest,
      keyFile: r.keyFile ? path.basename(r.keyFile) : null,
      oneShot: !!r.oneShot,
    };
  }

  /**
   * 列举已有备份。读不到目录**不抛错**，而是把原因写进 note ——
   * 运维页面里"还没有备份"和"读不了备份目录"是两件事，不能都显示成空白列表。
   */
  function listBackups() {
    const dir = backupsDir();
    let items = [];
    let note = '';
    try {
      if (!fs.existsSync(dir)) {
        note = '还没有 backups 目录 —— 从未创建过备份。';
      } else {
        items = fs.readdirSync(dir)
          .filter((f) => f.endsWith('.zip'))
          .map((name) => {
            const st = fs.statSync(path.join(dir, name));
            return { file: name, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() };
          })
          .sort((a, b) => b.mtime.localeCompare(a.mtime));
        if (!items.length) note = 'backups 目录为空 —— 还没创建过备份。';
      }
    } catch (e) {
      note = '读取备份目录失败：' + e.message;
    }
    return { items, dir, note };
  }

  /**
   * 把外部传来的文件名解析成 backups 目录内的绝对路径。
   * **唯一的路径校验点**：分隔符与 `..` 一律拒绝（防目录穿越），
   * 不存在的文件按"不存在"如实报告，而不是先拼路径再看运气。
   * @returns {{ok:true, file:string, name:string} | {ok:false, reason:'bad_request'|'not_found', error:string}}
   */
  function resolveBackup(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n || n.includes('/') || n.includes('\\') || n.includes('..')) {
      return { ok: false, reason: 'bad_request', error: 'file 必须是 backups 目录下的文件名' };
    }
    const file = path.join(backupsDir(), n);
    if (!fs.existsSync(file)) {
      return { ok: false, reason: 'not_found', error: '备份文件不存在：' + n };
    }
    return { ok: true, file, name: n };
  }

  /**
   * 校验备份文件（重算逐文件 SHA256 与 manifest 比对）。
   *
   * 返回形状刻意分两层：`ok` 说的是**这次调用有没有跑成**，
   * 校验结论在 `verdict.ok` 里。合并成一个 `ok` 的话，
   * "文件不存在"与"文件存在但内容被改过"就没法区分了 —— 前者是 404，后者是 200 + 问题清单。
   * @returns {{ok:true, name:string, verdict:{ok:boolean, checked:number, problems:string[]}}
   *          | {ok:false, reason:'bad_request'|'not_found', error:string}}
   */
  function verifyByName(name) {
    const r = resolveBackup(name);
    if (!r.ok) return r;
    return { ok: true, name: r.name, verdict: verifyBackup(r.file, { key: backupKey }) };
  }

  /**
   * 轮转备份：保留最近 `keep` 份，更旧的删除（`dryRun` 可先看清单、不动手）。
   *
   * 轮转不是 HTTP 接口（人工点名删除是 0.18.0 的 `removeByName`，走 `DELETE /api/operation/backup/:file`）。
   * 两者**护栏同源**：都只认 `backup-*.zip` 形态、都绝不删最后一份；差别只在选择方式 ——
   * 轮转删的永远是最旧的，人工删的是点名的某一份。
   * 换句话说，这里删掉的是"按策略早该消失的那几份"，不是"某人以为没用的那份"。
   */
  function pruneBackups({ keep = 30, dryRun = false } = {}) {
    return pruneBackupsImpl({ dir: backupsDir(), keep, dryRun });
  }

  /**
   * 删除单个备份文件（0.18.0，人工点名）。
   * 先走 `resolveBackup` 的路径校验，再走 `removeBackup` 的形态白名单与"绝不删最后一份"。
   * 三层 reason（bad_request / not_found / last_one）如实上抛，由路由层翻成 HTTP 码 ——
   * 这里不吞错、也不猜调用方想看到什么码。
   */
  function removeByName(name) {
    const r = resolveBackup(name);
    if (!r.ok) return r;
    const verdict = removeBackupImpl({ dir: backupsDir(), name: r.name });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, error: verdict.error };
    return { ok: true, name: verdict.name, bytes: verdict.bytes, freedKey: verdict.freedKey, remaining: verdict.remaining };
  }

  return {
    backupNow,
    listBackups,
    resolveBackup,
    verifyByName,
    pruneBackups,
    removeByName,
    backupsDir,
    /** 无后台资源需要释放；轮转由定时任务驱动（`backup.create` 的 `keep` 参数），见 platform/schedule/tasks.mjs */
    close() { /* no-op */ },
  };
}

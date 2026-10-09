/**
 * 运维路由（M5 · 企业化收口）。
 *
 * 分层纪律：与本目录其它路由文件一致 —— **只做**「解析请求 → 调 service → 组织响应」。
 * 备份目录的列举、文件名合法性校验、manifest 比对全部在
 * `app/platform/operation/service.mjs` 里；本文件不 import `node:fs` / `node:path`。
 *
 * 诚实边界：**恢复不做 HTTP 接口** —— 服务进程握着打开的 DB 句柄，
 * 运行中换掉自己脚下的库不是"危险"两个字能概括的。恢复是离线维护动作，
 * 用 `tools/restore-backup.mjs`（停机 → 恢复 → 校验 → 再启动）。
 * HTTP 提供的是：创建备份（在线、VACUUM INTO 一致性快照）与备份文件校验。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { readJsonBody } from '../context.mjs';

export function operationRoutes(deps) {
  const { operation } = deps;
  // 装配漏了就在注册期炸掉，而不是等第一个请求进来才 500 ——
  // 缺依赖属于装配错误，越早暴露越省事（测试自带装配，所以这条会立刻抓到漏配的套件）。
  if (!operation) {
    throw new Error('operationRoutes 需要 deps.operation —— 请用 createOperationService({ dataDir }) 装配');
  }

  return [
    {
      id: 'operation.backup',
      method: 'POST',
      path: '/api/operation/backup',
      scope: 'admin',
      capability: ['operation:write'],
      milestone: 'M5',
      summary: '创建在线备份（VACUUM INTO 一致性快照 + 存储打包，主密钥不进包）',
      handler: (ctx) => {
        const r = operation.backupNow();
        deps.governance.audit.append({
          tenantId: ctx.tenantId,
          userId: ctx.userId || null,
          action: 'operation.backup',
          resourceType: 'backup',
          resourceId: r.name,
          result: 'ok',
          detail: {
            bytes: r.bytes,
            storageFiles: r.manifest.storage.fileCount,
            platformVersion: r.manifest.platformVersion,
          },
        });
        ctx.ok({
          file: r.name,
          bytes: r.bytes,
          manifest: r.manifest,
          note: '主密钥 data/.secret 不在包里，必须单独保管；恢复是离线动作（tools/restore-backup.mjs），不做在线接口',
        });
      },
    },
    {
      // 只读列举 —— 没有它，前端"备份页"只能让人盲打文件名去校验。
      // 删除入口 0.18.0 补上（`operation.backup.remove`，见下一条路由）。早先刻意不给删除接口，
      // 顾虑是"一个误点的按钮把最后的退路删掉"；补上时把那条顾虑做成了**服务层硬护栏**
      // （只认 backup-*.zip 形态 + 绝不删最后一份，见 backup.mjs 的 removeBackup），
      // 而不是靠界面提醒 —— 界面可以被绕开（直接调接口），护栏不行。
      id: 'operation.backup.list',
      method: 'GET',
      path: '/api/operation/backup',
      scope: 'admin',
      capability: ['operation:read'],
      milestone: 'M5',
      summary: '列出已存在的备份文件（只读）',
      handler: (ctx) => {
        ctx.ok(operation.listBackups());
      },
    },
    {
      id: 'operation.backup.verify',
      method: 'POST',
      path: '/api/operation/backup/verify',
      scope: 'admin',
      capability: ['operation:read'],
      milestone: 'M5',
      summary: '校验备份文件（重算逐文件 SHA256 与 manifest 比对，报告全部问题）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = operation.verifyByName(body && body.file);
        if (!r.ok) {
          ctx.fail(r.reason === 'not_found' ? 404 : 400, r.reason, r.error);
          return;
        }
        const v = r.verdict;
        deps.governance.audit.append({
          tenantId: ctx.tenantId,
          userId: ctx.userId || null,
          action: 'operation.backup.verify',
          resourceType: 'backup',
          resourceId: r.name,
          result: v.ok ? 'ok' : 'error',
          detail: { checked: v.checked, problems: v.problems.slice(0, 10) },
        });
        ctx.ok({ ok: v.ok, checked: v.checked, problems: v.problems });
      },
    },
    {
      // 人工点名删除（0.18.0）。护栏全在服务层：形态白名单（backup-*.zip）+
      // 绝不删最后一份（与轮转同一口径，见 backup.mjs 的 removeBackup）。
      // 路由只做 reason → HTTP 码的翻译与审计；`last_one` 给 409 ——
      // 请求本身合法（文件在、形态对），是当前状态不允许（它是最后的退路），
      // 与 identity「不能停用最后一个所有者」同类，用 conflict 而不是 bad_request。
      id: 'operation.backup.remove',
      method: 'DELETE',
      path: '/api/operation/backup/:file',
      scope: 'admin',
      capability: ['operation:delete'],
      milestone: '0.18.0',
      summary: '删除一份备份文件（只认本平台产出的 backup-*.zip；绝不删最后一份；不可逆，连带清理一次性密钥侧车）',
      handler: (ctx) => {
        const r = operation.removeByName(ctx.params.file);
        if (!r.ok) {
          if (r.reason === 'not_found') ctx.fail(404, 'not_found', r.error);
          else if (r.reason === 'last_one') ctx.fail(409, 'conflict', r.error);
          else ctx.fail(400, 'bad_request', r.error);
          return;
        }
        deps.governance.audit.append({
          tenantId: ctx.tenantId,
          userId: ctx.userId || null,
          action: 'operation.backup.remove',
          resourceType: 'backup',
          resourceId: r.name,
          result: 'ok',
          detail: { bytes: r.bytes, freedKey: r.freedKey, remaining: r.remaining },
        });
        ctx.ok({
          name: r.name,
          bytes: r.bytes,
          freedKey: r.freedKey,
          remaining: r.remaining,
          note: '删除不可逆；只动了本平台产出的 backup-*.zip（及其 64-hex 一次性密钥侧车），目录内其它文件一律未碰',
        });
      },
    },
  ];
}

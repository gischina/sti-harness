/**
 * 定时任务路由（P1-2）。
 *
 * 分层纪律：**只做**「解析请求 → 调 service → 组织响应」。
 * 规则解析、下次执行计算、重入保护、执行体派发全在
 * `app/platform/schedule/service.mjs` 与 `tasks.mjs` 里；本文件不 import `node:fs`、
 * 也不自己判断"到没到点"。
 *
 * 权限：`schedule:read` / `schedule:write` / `schedule:delete` —— **三个动作都只给管理员**
 * （`member` 与 `viewer` 的权限表里根本没有 `schedule` 这个资源，一律 403）。
 * 理由：清单会暴露"平台什么时候会自动备份/归档"，而 `run` 会真的执行任务体；
 * 这两件事都不该开放给日常使用者与只读访客。改权限矩阵时要同步看这里。
 *
 * **`run` 用 write 而不是 read** —— 它会真的执行任务体（例如立刻做一次备份或归档），
 * 是"有副作用的动作"，不是只读查询。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { readJsonBody } from '../context.mjs';
// 横切件（auditOf / unwrap）单点在 _shared.mjs —— 三条路由曾各留一份逐字拷贝（体检 §A1-#1/#2）。
import { auditOf, unwrap } from './_shared.mjs';

const TENANT = (ctx) => ctx.tenantId;

export function scheduleRoutes(deps) {
  const { schedule, governance } = deps;
  if (!schedule) {
    throw new Error('scheduleRoutes 需要 deps.schedule —— 请用 createScheduleService({ governance, operation, model, notify }) 装配');
  }

  // 审计留痕 + service 结果 → HTTP 语义：已抽到 routes/_shared.mjs（见该文件顶部）。
  const audit = auditOf('schedule', governance);

  return [
    {
      id: 'schedule.jobs.list',
      method: 'GET',
      path: '/api/schedule/jobs',
      scope: 'session',
      capability: ['schedule:read'],
      summary: '定时任务清单（含上次/下次执行与最近结果）与调度器状态',
      milestone: 'P1',
      handler: (ctx) => {
        ctx.ok({
          jobs: schedule.listJobs(TENANT(ctx)),
          status: schedule.status(TENANT(ctx)),
        });
      },
    },

    {
      id: 'schedule.jobs.create',
      method: 'POST',
      path: '/api/schedule/jobs',
      scope: 'session',
      capability: ['schedule:write'],
      summary: '新建定时任务（规则只支持 interval:<毫秒> 与 dailyAt:HH:MM）',
      milestone: 'P1',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = schedule.createJob(TENANT(ctx), body);
        if (!unwrap(ctx, r)) { audit(ctx, 'schedule.job.create', body && body.name, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'schedule.job.create', r.job.id, 'ok', { kind: r.job.kind, schedule: r.job.schedule });
        ctx.json(201, { ok: true, job: r.job });
      },
    },

    {
      id: 'schedule.jobs.update',
      method: 'PUT',
      path: '/api/schedule/jobs/:id',
      scope: 'session',
      capability: ['schedule:write'],
      summary: '更新任务（改规则会重算下次执行时间）',
      milestone: 'P1',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = schedule.updateJob(TENANT(ctx), ctx.params.id, body);
        if (!unwrap(ctx, r)) { audit(ctx, 'schedule.job.update', ctx.params.id, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'schedule.job.update', r.job.id, 'ok', { fields: Object.keys(body || {}) });
        ctx.ok({ job: r.job });
      },
    },

    {
      id: 'schedule.jobs.delete',
      method: 'DELETE',
      path: '/api/schedule/jobs/:id',
      scope: 'session',
      capability: ['schedule:delete'],
      summary: '删除任务（历史执行结果随行一起消失 —— 审计链里仍有记录）',
      milestone: 'P1',
      handler: (ctx) => {
        const r = schedule.deleteJob(TENANT(ctx), ctx.params.id);
        if (!unwrap(ctx, r)) { audit(ctx, 'schedule.job.delete', ctx.params.id, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'schedule.job.delete', ctx.params.id, 'ok', { name: r.deleted });
        ctx.ok({ deleted: r.deleted });
      },
    },

    {
      id: 'schedule.jobs.run',
      method: 'POST',
      path: '/api/schedule/jobs/:id/run',
      scope: 'session',
      // 有副作用（会真的执行任务体），因此要 write 而不是 read。
      capability: ['schedule:write'],
      summary: '立即执行一次（不校验是否到点；审计里与"定时触发"可区分）',
      milestone: 'P1',
      handler: async (ctx) => {
        const r = await schedule.runNow(TENANT(ctx), ctx.params.id);
        if (!unwrap(ctx, r)) { audit(ctx, 'schedule.job.runNow', ctx.params.id, 'denied', { error: r && r.error }); return; }
        ctx.ok({ job: r.job, status: r.status, detail: r.detail });
      },
    },

    {
      id: 'schedule.tick',
      method: 'POST',
      path: '/api/schedule/tick',
      scope: 'session',
      capability: ['schedule:write'],
      summary: '手动触发一次调度扫描（用于验证与排障；不等同于等待定时器）',
      milestone: 'P1',
      handler: async (ctx) => {
        const r = await schedule.tick();
        audit(ctx, 'schedule.tick', '', 'ok', { due: r.due, ran: r.ran, failed: r.failed, skipped: !!r.skipped });
        ctx.ok({ tick: r });
      },
    },
  ];
}

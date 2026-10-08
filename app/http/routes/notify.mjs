/**
 * 出站通知路由（P1-2）。
 *
 * 分层纪律：只做「解析请求 → 调 service → 组织响应」。SSRF 目标校验、URL 加解密、
 * 重试退避、投递记账全在 `app/platform/notify/service.mjs` 里。
 *
 * 权限：`notify:read` / `notify:write` / `notify:delete`。
 * **`test` 用 write 而不是 read** —— 它会真的往目标地址 POST 一次。
 *
 * ⚠️ 本文件的响应里**永不出现完整 URL**：渠道 URL 可能内嵌 token
 * （钉钉/企微机器人的 `?access_token=` 就是典型），它等价于一个密钥。
 * service 层的 `shape()` 只给 host，路由层不再做二次拼接。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { readJsonBody } from '../context.mjs';
// 横切件（auditOf / unwrap）单点在 _shared.mjs —— 三条路由曾各留一份逐字拷贝（体检 §A1-#1/#2）。
import { auditOf, unwrap, requireBody } from './_shared.mjs';

const TENANT = (ctx) => ctx.tenantId;

export function notifyRoutes(deps) {
  const { notify, governance } = deps;
  if (!notify) {
    throw new Error('notifyRoutes 需要 deps.notify —— 请用 createNotifyService({ masterSecret, encryptSecret, decryptSecret }) 装配');
  }

  // 审计留痕：与其它模块同构，已抽到 routes/_shared.mjs（见该文件顶部）。
  const audit = auditOf('notify', governance);

  return [
    {
      id: 'notify.channels.list',
      method: 'GET',
      path: '/api/notify/channels',
      scope: 'session',
      capability: ['notify:read'],
      summary: '通知渠道清单（只回显 host，不回显完整 URL）与事件白名单',
      milestone: 'P1',
      handler: (ctx) => {
        ctx.ok({
          channels: notify.listChannels(TENANT(ctx)),
          status: notify.status(TENANT(ctx)),
        });
      },
    },

    {
      id: 'notify.channels.create',
      method: 'POST',
      path: '/api/notify/channels',
      scope: 'session',
      capability: ['notify:write'],
      summary: '登记通知渠道（URL 加密落库；events 必须是白名单里的事件）',
      milestone: 'P1',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        requireBody({
          name: { required: true, maxLen: 128, label: '渠道名' },
          url: { required: true, maxLen: 2048, label: 'Webhook URL' },
          events: { type: 'stringArray', maxLen: 32, label: '订阅事件' },
        }, body);
        const r = notify.createChannel(TENANT(ctx), body);
        if (!unwrap(ctx, r)) { audit(ctx, 'notify.channel.create', body && body.name, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'notify.channel.create', r.channel.id, 'ok', { name: r.channel.name, kind: r.channel.kind, events: r.channel.events, host: r.channel.host });
        ctx.json(201, { ok: true, channel: r.channel });
      },
    },

    {
      id: 'notify.channels.update',
      method: 'PUT',
      path: '/api/notify/channels/:id',
      scope: 'session',
      capability: ['notify:write'],
      summary: '更新渠道（url 留空表示不改动，避免"保存时把密钥清掉"）',
      milestone: 'P1',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        requireBody({
          name: { maxLen: 128, label: '渠道名' },
          url: { maxLen: 2048, label: 'Webhook URL' },
          events: { type: 'stringArray', maxLen: 32, label: '订阅事件' },
        }, body);
        const r = notify.updateChannel(TENANT(ctx), ctx.params.id, body);
        if (!unwrap(ctx, r)) { audit(ctx, 'notify.channel.update', ctx.params.id, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'notify.channel.update', r.channel.id, 'ok', { fields: Object.keys(body || {}) });
        ctx.ok({ channel: r.channel });
      },
    },

    {
      id: 'notify.channels.delete',
      method: 'DELETE',
      path: '/api/notify/channels/:id',
      scope: 'session',
      capability: ['notify:delete'],
      summary: '删除渠道',
      milestone: 'P1',
      handler: (ctx) => {
        const r = notify.deleteChannel(TENANT(ctx), ctx.params.id);
        if (!unwrap(ctx, r)) { audit(ctx, 'notify.channel.delete', ctx.params.id, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'notify.channel.delete', ctx.params.id, 'ok', { name: r.deleted });
        ctx.ok({ deleted: r.deleted });
      },
    },

    {
      id: 'notify.channels.test',
      method: 'POST',
      path: '/api/notify/channels/:id/test',
      scope: 'session',
      // 会真的出站 POST 一次 —— 有副作用，因此要 write。
      capability: ['notify:write'],
      summary: '试发一条（不要求渠道订阅了具体事件，否则新渠道没法自测）',
      milestone: 'P1',
      handler: async (ctx) => {
        const r = await notify.testChannel(TENANT(ctx), ctx.params.id);
        if (!unwrap(ctx, r)) { audit(ctx, 'notify.channel.test', ctx.params.id, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'notify.channel.test', ctx.params.id, r.result.ok ? 'ok' : 'error',
          { status: r.result.status, attempts: r.result.attempts, error: r.result.error || null });
        // 试发失败**不是** HTTP 失败：请求本身处理成功了，结论在 result 里。
        // 合并成一个状态码就分不出"渠道不存在(404)"与"渠道存在但发不出去(200+结论)"。
        ctx.ok({ channel: r.channel, result: r.result, channelState: r.channelState });
      },
    },

    // ── 失败重投队列（§B5）────────────────────────────────────────────
    //
    // 为什么把队列**做成可见的接口**而不只是"后台默默重投"：
    // "有多少告警还没发出去"本身就是运维要看的那个数。静默重投只是把丢失
    // 从"立刻"推到"永远没发出去但没人知道"—— 那比不做更糟。
    {
      id: 'notify.deliveries.list',
      method: 'GET',
      path: '/api/notify/deliveries',
      scope: 'session',
      capability: ['notify:read'],
      summary: '投递失败队列（pending / dead / delivered）',
      milestone: 'B5',
      handler: (ctx) => {
        const status = String(ctx.query.status || 'pending');
        ctx.ok({
          status,
          deliveries: notify.listDeliveries(TENANT(ctx), { status, limit: Number(ctx.query.limit || 50) }),
          queue: notify.status(TENANT(ctx)).queue,
          policy: notify.retryPolicy,
          note: '队列只收真事件的失败投递，试发失败不入队（那是人在旁边看着的动作）。'
            + '重投语义是 at-least-once：接收方可能收到重复，请用 `X-STI-Delivery-Id` 去重。',
        });
      },
    },
    {
      id: 'notify.deliveries.redeliver',
      method: 'POST',
      path: '/api/notify/deliveries/:id/redeliver',
      scope: 'session',
      // 会真的出站 POST 一次 —— 有副作用，因此要 write（与 test 同一条理由）。
      capability: ['notify:write'],
      summary: '手动重投一条失败的投递（死信也能复活）',
      milestone: 'B5',
      handler: async (ctx) => {
        const r = await notify.redeliverNow(TENANT(ctx), ctx.params.id);
        if (!unwrap(ctx, r)) {
          audit(ctx, 'notify.delivery.redeliver', ctx.params.id, 'denied', { error: r && r.error });
          return;
        }
        audit(ctx, 'notify.delivery.redeliver', ctx.params.id,
          r.result.status === 'delivered' ? 'ok' : 'error',
          { wasDead: r.wasDead, status: r.result.status, error: r.result.error || null });
        // 与试发同一条判断：**投递没成功不是 HTTP 失败** —— 请求本身处理成功了，
        // 结论在 result 里。合并成一个状态码就分不出"记录不存在(404)"与"记录在但发不出去(200+结论)"。
        ctx.ok({ wasDead: r.wasDead, result: r.result, delivery: r.delivery });
      },
    },
  ];
}

/**
 * 模型中心路由（P1-1）。
 *
 * 分层纪律：**只做**「解析请求 → 调 service → 组织响应」。
 * 校验、默认项的唯一性、降级链排序、探活全在
 * `app/platform/model/service.mjs` 与 `probe.mjs` 里；本文件不 import `node:fs` /
 * 不发网络请求（出网只在 probe.mjs）。
 *
 * 权限：`model:read`（所有内置角色）/ `model:write`（管理员）/ `model:delete`（管理员）。
 * 探活要求 `model:write` 而非 read —— 它会**真的发一次最小请求并产生用量**，
 * 是"有副作用的动作"，不是只读查询。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { readJsonBody } from '../context.mjs';
import { errors } from '../../util/errors.mjs';
// 横切件（auditOf / unwrap）单点在 _shared.mjs —— 三条路由曾各留一份逐字拷贝（体检 §A1-#1/#2）。
import { auditOf, unwrap } from './_shared.mjs';

const TENANT = (ctx) => ctx.tenantId;

export function modelRoutes(deps) {
  const { model, governance } = deps;
  if (!model) {
    throw new Error('modelRoutes 需要 deps.model —— 请用 createModelService({ resolveCredential }) 装配');
  }

  // 审计留痕：与其它模块同构，已抽到 routes/_shared.mjs（见该文件顶部）。
  // 治理服务未装配也不阻塞主流程，只是少一条留痕。
  const audit = auditOf('model', governance);

  return [
    {
      id: 'model.providers.list',
      method: 'GET',
      path: '/api/model/providers',
      scope: 'session',
      capability: ['model:read'],
      summary: '模型注册表：全部条目 + 两种用途的默认与降级链',
      milestone: 'P1',
      handler: (ctx) => {
        const providers = model.listProviders(TENANT(ctx));
        ctx.ok({
          providers,
          sources: { registry: providers.length, note: '本表是平台侧登记；"本机实际能调什么"由内核目录回答，两者不混为一谈' },
          chain: {
            chat: model.resolveDefault(TENANT(ctx), 'chat'),
            embedding: model.resolveDefault(TENANT(ctx), 'embedding'),
          },
          status: model.status(TENANT(ctx)),
        });
      },
    },

    {
      id: 'model.providers.create',
      method: 'POST',
      path: '/api/model/providers',
      scope: 'session',
      capability: ['model:write'],
      summary: '登记一个模型服务（密钥只写凭据名，值走凭据托管）',
      milestone: 'P1',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = model.createProvider(TENANT(ctx), body);
        if (!unwrap(ctx, r)) { audit(ctx, 'model.provider.create', body && body.name, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'model.provider.create', r.provider.id, 'ok', { name: r.provider.name, kind: r.provider.kind, protocol: r.provider.protocol });
        ctx.json(201, { ok: true, provider: r.provider });
      },
    },

    {
      id: 'model.providers.get',
      method: 'GET',
      path: '/api/model/providers/:id',
      scope: 'session',
      capability: ['model:read'],
      summary: '单个模型条目详情',
      milestone: 'P1',
      handler: (ctx) => {
        const p = model.getProvider(TENANT(ctx), ctx.params.id);
        if (!p) throw errors.notFound('模型条目不存在：' + ctx.params.id);
        ctx.ok({ provider: p });
      },
    },

    {
      id: 'model.providers.update',
      method: 'PUT',
      path: '/api/model/providers/:id',
      scope: 'session',
      capability: ['model:write'],
      summary: '更新模型条目（校验与默认项唯一性在服务层）',
      milestone: 'P1',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = model.updateProvider(TENANT(ctx), ctx.params.id, body);
        if (!unwrap(ctx, r)) { audit(ctx, 'model.provider.update', ctx.params.id, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'model.provider.update', r.provider.id, 'ok', { fields: Object.keys(body || {}) });
        ctx.ok({ provider: r.provider });
      },
    },

    {
      id: 'model.providers.delete',
      method: 'DELETE',
      path: '/api/model/providers/:id',
      scope: 'session',
      capability: ['model:delete'],
      summary: '删除模型条目',
      milestone: 'P1',
      handler: (ctx) => {
        const r = model.deleteProvider(TENANT(ctx), ctx.params.id);
        if (!unwrap(ctx, r)) { audit(ctx, 'model.provider.delete', ctx.params.id, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'model.provider.delete', ctx.params.id, 'ok', { name: r.deleted });
        ctx.ok({ deleted: r.deleted, ...(r.note ? { note: r.note } : {}) });
      },
    },

    {
      id: 'model.providers.enabled',
      method: 'POST',
      path: '/api/model/providers/:id/enabled',
      scope: 'session',
      capability: ['model:write'],
      summary: '启用 / 停用模型条目（停用默认项会同时撤掉它的默认标记）',
      milestone: 'P1',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = model.setEnabled(TENANT(ctx), ctx.params.id, body && body.enabled !== false);
        if (!unwrap(ctx, r)) { audit(ctx, 'model.provider.enabled', ctx.params.id, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'model.provider.enabled', r.provider.id, 'ok',
          { enabled: r.provider.enabled, clearedDefault: !!r.clearedDefault });
        // 「停用顺带撤掉默认」是单向的，必须把这句话原样带回前端，不能让它静默发生
        ctx.ok({ provider: r.provider, clearedDefault: !!r.clearedDefault, ...(r.note ? { note: r.note } : {}) });
      },
    },

    {
      id: 'model.providers.default',
      method: 'POST',
      path: '/api/model/providers/:id/default',
      scope: 'session',
      capability: ['model:write'],
      summary: '设为该用途的默认模型（同用途至多一个，由库层唯一索引兜底）',
      milestone: 'P1',
      handler: (ctx) => {
        const r = model.setDefault(TENANT(ctx), ctx.params.id);
        if (!unwrap(ctx, r)) { audit(ctx, 'model.provider.default', ctx.params.id, 'denied', { error: r && r.error }); return; }
        audit(ctx, 'model.provider.default', r.provider.id, 'ok', { kind: r.provider.kind });
        ctx.ok({ provider: r.provider });
      },
    },

    {
      id: 'model.providers.probe',
      method: 'POST',
      path: '/api/model/providers/:id/probe',
      scope: 'session',
      // 探活会真的出网（对话探活产生极少量用量）—— 有副作用，因此要 write 而不是 read。
      capability: ['model:write'],
      summary: '连通性测试：真发一次最小请求，按真实结果给结论（两层：调用跑成 / 连通结论）',
      milestone: 'P1',
      handler: async (ctx) => {
        const r = await model.probeProvider(TENANT(ctx), ctx.params.id);
        if (!r.ok) { ctx.fail(404, 'not_found', r.error); return; }
        const v = r.verdict;
        audit(ctx, 'model.provider.probe', ctx.params.id, v.ok ? 'ok' : 'error', {
          level: v.level, code: v.code, latencyMs: v.latencyMs, endpoint: r.endpoint,
        });
        ctx.ok({ name: r.name, endpoint: r.endpoint, verdict: v });
      },
    },

    {
      id: 'model.chain',
      method: 'GET',
      path: '/api/model/chain',
      scope: 'session',
      capability: ['model:read'],
      summary: '降级链：两种用途各自的默认项与按 priority 排序的启用项序列',
      milestone: 'P1',
      handler: (ctx) => {
        const chat = model.resolveDefault(TENANT(ctx), 'chat');
        const embedding = model.resolveDefault(TENANT(ctx), 'embedding');
        ctx.ok({
          chat: { default: chat.provider, defaultSource: chat.defaultSource, chain: chat.chain },
          embedding: { default: embedding.provider, defaultSource: embedding.defaultSource, chain: embedding.chain },
          note: '降级链是"同用途内按 priority 升序的启用项"。本平台不做请求转发：链的可执行部分属 model gateway（v1.0）。',
        });
      },
    },
  ];
}

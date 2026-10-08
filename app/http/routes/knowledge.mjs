/**
 * 知识路由（M2 / 4.6 库级 ACL）。
 *
 * 全部走 `session` scope（需要登录），并按 capability 声明权限：
 *   · 读（列表/详情/检索/状态）→ `knowledge:read`（所有内置角色都有）
 *   · 建库（组织级动作）        → `knowledge:write`（默认仅管理员）
 *   · 删库（不可逆的组织级动作）→ `knowledge:delete`（默认仅管理员）
 *
 * ⚠️ **库内写动作的权限判定在服务层，不在这层** —— 这是 4.6 的关键设计：
 *   `docs` 的导入/删除、库的可见性变更、库级授权增删，路由只要求 `knowledge:read`，
 *   真正的"能不能动这个库"由 `knowledge.xxx(...subject)` 内部按**库级可见性 + 库级角色**
 *   判定。原因很直接：rbac 中间件只看**租户级**角色，而"某人在某个库上被授了 admin"
 *   这件事只有服务层知道。若这里继续写 `knowledge:write`，一个"库级管理员"会被
 *   路由层直接挡在门外 —— 库级授权就永远进不到需要它的地方，4.6 等于没做。
 *   代价是"判定点后移"，所以**每个写路径都有回归钉住拒绝行为**（test-core 的 4.6 段）。
 *
 * 为什么导入文档默认不给"成员"：知识库是**Agent 引用的语料**，
 * 谁都能往里写就等于谁都能影响 Agent 的回答（语料投毒）。库级 ACL 让这条约束
 * 从"全局"细化到"逐库"：成员可以在**被授权的库**上写（若被授了相应角色），
 * 但默认仍写不了未授权的库。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { readJsonBody } from '../context.mjs';
import { errors } from '../../util/errors.mjs';
import { requireBody } from './_shared.mjs';

/** 导入接口的请求体上限（比普通 JSON 接口大得多：要把文件内容传进来） */
const IMPORT_BODY_LIMIT = 16 * 1024 * 1024;

export function knowledgeRoutes(deps) {
  const { knowledge } = deps;
  if (!knowledge) {
    // 明确报错而不是静默少一组路由：路由表是"唯一真源"，缺一组必须立刻可见
    throw new Error('知识路由装配失败：deps.knowledge 未提供');
  }

  /** 主体描述（4.6）：userId + 租户级角色。库级角色由服务层经身份服务展开。 */
  const subjectOf = (ctx) => ({ userId: ctx.userId, roles: (ctx.user && ctx.user.roles) || [] });

  /** 从 base64 解出文件内容，并做格式校验（错误信息要能让人看懂哪里不对） */
  function decodeBase64(v, filename) {
    const s = String(v || '');
    if (!s) return null;
    const cleaned = s.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
      throw errors.badRequest('contentBase64 不是合法的 base64 内容（文件 ' + (filename || '未命名') + '）');
    }
    return Buffer.from(cleaned, 'base64');
  }

  const routes = [
    {
      id: 'knowledge.status',
      method: 'GET',
      path: '/api/knowledge/status',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '知识层状态：向量模式、解析能力、分块参数、worker 池（计数为可见口径，见响应说明）',
      milestone: 'M2',
      handler: (ctx) => ctx.ok({ knowledge: knowledge.status(ctx.tenantId, subjectOf(ctx)) }),
    },

    {
      id: 'knowledge.bases',
      method: 'GET',
      path: '/api/knowledge/bases',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '知识库列表（4.6：只返回当前用户可见的库，含 visibility 与自身档位）',
      milestone: 'M2',
      handler: (ctx) => {
        const rows = knowledge.listBases(ctx.tenantId, subjectOf(ctx));
        ctx.ok({
          bases: rows.map((b) => ({
            id: b.id,
            name: b.name,
            visibility: b.visibility || 'tenant',
            accessLevel: b.accessLevel,
            embeddingProvider: b.embedding_provider || '',
            embeddingModel: b.embedding_model || '',
            dim: Number(b.dim) || 0,
            documentCount: Number(b.document_count) || 0,
            chunkCount: Number(b.chunk_count) || 0,
            createdAt: b.created_at,
          })),
        });
      },
    },

    {
      id: 'knowledge.bases.create',
      method: 'POST',
      path: '/api/knowledge/bases',
      scope: 'session',
      capability: ['knowledge:write'],
      summary: '新建知识库（可选 visibility：tenant 全租户可见 / restricted 仅授权可见）',
      milestone: 'M2',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        requireBody({
          name: { required: true, maxLen: 128, label: '知识库名' },
          visibility: { enum: ['tenant', 'restricted'], label: '可见性' },
        }, body);
        const b = knowledge.createBase({ tenantId: ctx.tenantId, name: body.name, visibility: body.visibility });
        ctx.json(201, {
          ok: true,
          base: {
            id: b.id,
            name: b.name,
            visibility: b.visibility || 'tenant',
            dim: Number(b.dim) || 0,
            createdAt: b.created_at,
          },
        });
      },
    },

    {
      id: 'knowledge.bases.update',
      method: 'PATCH',
      path: '/api/knowledge/bases/:id',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '改知识库：name 改名 / visibility 改可见性（tenant ↔ restricted）。需该库 write 档；变更强制入审计',
      milestone: 'M2',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        requireBody({
          name: { maxLen: 128, label: '知识库名' },
          visibility: { enum: ['tenant', 'restricted'], label: '可见性' },
        }, body);
        const wantsName = body.name !== undefined;
        const wantsVis = body.visibility !== undefined;
        if (!wantsName && !wantsVis) {
          throw errors.badRequest('至少要给 name（改名）或 visibility（改可见性）之一');
        }
        // 两个字段可以一次改；**各自独立入审计**（改名与改可见性是两件不同的事，
        // 合成一条会让审计链回答不了"这个名字是什么时候被改的"）
        let b = wantsName
          ? knowledge.renameBase(ctx.tenantId, ctx.params.id, body.name, subjectOf(ctx))
          : null;
        if (wantsVis) {
          b = knowledge.setBaseVisibility(ctx.tenantId, ctx.params.id, body.visibility, subjectOf(ctx));
        }
        ctx.ok({ ok: true, base: { id: b.id, name: b.name, visibility: b.visibility } });
      },
    },

    {
      id: 'knowledge.bases.delete',
      method: 'DELETE',
      path: '/api/knowledge/bases/:id',
      scope: 'session',
      capability: ['knowledge:delete'],
      summary: '删除知识库（连同文档、分块、向量）',
      milestone: 'M2',
      handler: (ctx) => {
        const r = knowledge.deleteBase(ctx.tenantId, ctx.params.id, subjectOf(ctx));
        if (!r.deleted) throw errors.notFound('知识库不存在或不属于当前组织：' + ctx.params.id);
        ctx.ok({ deleted: true, documents: r.documents, chunks: r.chunks });
      },
    },

    {
      id: 'knowledge.bases.grants.list',
      method: 'GET',
      path: '/api/knowledge/bases/:id/grants',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '列出该库的库级授权（需该库 write 档 —— 授权名单本身是敏感信息）',
      milestone: 'M2',
      handler: (ctx) => {
        const rows = knowledge.listBaseGrants(ctx.tenantId, ctx.params.id, subjectOf(ctx));
        ctx.ok({
          grants: rows.map((b) => ({
            id: b.id,
            subjectType: b.subject_type,
            subjectId: b.subject_id,
            subjectName: b.username || b.group_name || b.subject_id,
            roleKey: b.role_key,
            createdAt: b.created_at,
          })),
        });
      },
    },

    {
      id: 'knowledge.bases.grants.create',
      method: 'POST',
      path: '/api/knowledge/bases/:id/grants',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '库级授权：把某用户/组在这个库上授为某角色（需该库 write 档）',
      milestone: 'M2',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const b = knowledge.grantBase({
          tenantId: ctx.tenantId,
          kbId: ctx.params.id,
          subjectType: body.subjectType === 'group' ? 'group' : 'user',
          subjectId: body.subjectId,
          roleKey: body.roleKey,
          subject: subjectOf(ctx),
        });
        ctx.json(201, {
          ok: true,
          grant: { id: b.id, subjectType: b.subject_type, subjectId: b.subject_id, roleId: b.role_id },
        });
      },
    },

    {
      id: 'knowledge.bases.grants.delete',
      method: 'DELETE',
      path: '/api/knowledge/bases/:id/grants/:bindingId',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '撤销库级授权（需该库 write 档；绑定必须属于该库，防跨库越权撤权）',
      milestone: 'M2',
      handler: (ctx) => {
        const r = knowledge.revokeBaseGrant({
          tenantId: ctx.tenantId,
          kbId: ctx.params.id,
          bindingId: ctx.params.bindingId,
          subject: subjectOf(ctx),
        });
        ctx.ok(r);
      },
    },

    {
      id: 'knowledge.documents.list',
      method: 'GET',
      path: '/api/knowledge/bases/:id/documents',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '知识库内的文档列表（含解析状态与失败原因）',
      milestone: 'M2',
      handler: (ctx) => {
        const limit = Math.min(Number(ctx.query.limit || 100) || 100, 500);
        const offset = Number(ctx.query.offset || 0) || 0;
        const r = knowledge.listDocuments(
          ctx.tenantId,
          ctx.params.id,
          { limit, offset, status: ctx.query.status || null },
          subjectOf(ctx)
        );
        ctx.ok(r);
      },
    },

    {
      id: 'knowledge.documents',
      method: 'POST',
      path: '/api/knowledge/documents',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '导入文档（text 或 contentBase64），触发解析/分块/索引。需该库 write 档（服务层判定）',
      milestone: 'M2',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req, IMPORT_BODY_LIMIT);
        if (!body.kbId) throw errors.badRequest('缺少 kbId');

        const hasText = body.text != null && String(body.text).length > 0;
        const hasContent = body.contentBase64 != null && String(body.contentBase64).length > 0;
        if (!hasText && !hasContent) throw errors.badRequest('需要提供 text（纯文本）或 contentBase64（文件内容）之一');

        try {
          const r = await knowledge.ingest({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            roles: (ctx.user && ctx.user.roles) || [],
            kbId: String(body.kbId),
            filename: body.filename || (hasText ? 'pasted.txt' : 'document'),
            mime: body.mime || '',
            text: hasText ? String(body.text) : undefined,
            buffer: hasContent ? decodeBase64(body.contentBase64, body.filename) : undefined,
            title: body.title,
            sourceType: hasContent ? 'file' : 'text',
            sourceRef: body.filename || '',
            force: !!body.force,
          });
          // 解析失败 → 422，并**带上文档记录**（状态 failed + 原始错误），前端才能展示原因
          ctx.json(r.duplicate ? 200 : 201, { ok: true, ...r });
        } catch (e) {
          if (e && e.document) {
            return ctx.json(e.httpStatus || 422, {
              ok: false,
              error: { code: e.code || 'parse_failed', message: e.message, detail: e.detail },
              document: e.document,
            });
          }
          throw e;
        }
      },
    },

    {
      id: 'knowledge.documents.get',
      method: 'GET',
      path: '/api/knowledge/documents/:id',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '文档详情',
      milestone: 'M2',
      handler: (ctx) => ctx.ok({ document: knowledge.getDocument(ctx.tenantId, ctx.params.id, subjectOf(ctx)) }),
    },

    {
      id: 'knowledge.documents.update',
      method: 'PATCH',
      path: '/api/knowledge/documents/:id',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '改文档标题（只动显示字段，不重新解析）。需该库 write 档（服务层判定）；变更入审计',
      milestone: '0.18.0',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        requireBody({ title: { required: true, maxLen: 300, label: '文档标题' } }, body);
        const document = knowledge.renameDocument(ctx.tenantId, ctx.params.id, body.title, subjectOf(ctx));
        ctx.ok({ document });
      },
    },

    {
      id: 'knowledge.documents.delete',
      method: 'DELETE',
      path: '/api/knowledge/documents/:id',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '删除文档（连同分块与向量）。需该库 delete 档（服务层判定）',
      milestone: 'M2',
      handler: (ctx) => {
        const r = knowledge.deleteDocument(ctx.tenantId, ctx.params.id, subjectOf(ctx));
        ctx.ok(r);
      },
    },

    {
      id: 'knowledge.documents.chunks',
      method: 'GET',
      path: '/api/knowledge/documents/:id/chunks',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '分块预览（含定位信息与引用标签）',
      milestone: 'M2',
      handler: (ctx) => {
        const limit = Math.min(Number(ctx.query.limit || 50) || 50, 200);
        const offset = Number(ctx.query.offset || 0) || 0;
        ctx.ok(knowledge.previewChunks(ctx.tenantId, ctx.params.id, { limit, offset }, subjectOf(ctx)));
      },
    },

    {
      id: 'knowledge.search',
      method: 'POST',
      path: '/api/knowledge/search',
      scope: 'session',
      capability: ['knowledge:read'],
      summary: '混合检索（bigram + FTS5 bm25 ｜ 向量余弦 ｜ RRF 融合），结果带引用链。只搜可见库',
      milestone: 'M2',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = await knowledge.search({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          roles: (ctx.user && ctx.user.roles) || [],
          kbIds: Array.isArray(body.kbIds) ? body.kbIds : (body.kbId ? [body.kbId] : []),
          query: body.query,
          limit: body.limit,
          // 向量预过滤的请求级覆盖（B2）。**只认真正的布尔值**：
          // JSON 里写 "false"（字符串）是真值，若做真值转换会得到一个静默失效的"关掉"，
          // 而调用方以为它生效了 —— 这类"看着关了其实没关"的开关比没有开关更坏。
          prefilter: typeof body.prefilter === 'boolean' ? body.prefilter : undefined,
        });
        ctx.ok(r);
      },
    },
  ];

  // 统一标注里程碑（逐条漏标会让 /api/system/routes 的统计多出一坨「未标注」）
  return routes.map((r) => ({ milestone: 'M2', ...r }));
}

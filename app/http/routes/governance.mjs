/**
 * 治理与审计路由（M3）。
 *
 * 分层纪律与 identity.mjs 一致：本文件**只做**「解析请求 → 调 service → 组织响应」，
 * 校验、事务、哈希链运算都在下层（governance 各模块）。
 *
 * 审计校验接口有个顺序细节：**先 verify、再写审计** —— verify 自己也会落一条审计，
 * 若先写后验，验到的链里就混进了"为校验而写"的那条，语义不对。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { readJsonBody } from '../context.mjs';
import { requireBody } from './_shared.mjs';
import * as audit from '../../platform/governance/audit.mjs';
import * as sessions from '../../data/repositories/sessions.mjs';
import * as eventsRepo from '../../data/repositories/events.mjs';
import { zipSync } from '../../util/zip.mjs';

/** 查询参数白名单化：审计接口的过滤条件本身就是敏感面，不让任意参数进查询 */
function cleanFilters(q) {
  const out = {};
  if (q.action) out.action = String(q.action).slice(0, 120);
  if (q.result && ['ok', 'denied', 'error'].includes(q.result)) out.result = q.result;
  if (q.userId) out.userId = String(q.userId).slice(0, 80);
  if (q.from) out.from = String(q.from).slice(0, 40);
  if (q.to) out.to = String(q.to).slice(0, 40);
  return out;
}

/** 脱敏：审计 detail 里不该出现敏感字段（写入端已约束，这里再兜一层） */
function maskRow(row) {
  const out = { ...row };
  try {
    const d = JSON.parse(out.detail_json || '{}');
    for (const k of Object.keys(d)) {
      if (/password|secret|token|cipher|apikey|api_key/i.test(k)) d[k] = '(已脱敏)';
    }
    out.detail = d;
  } catch { out.detail = {}; }
  delete out.detail_json;
  return out;
}

export function governanceRoutes(deps) {
  const { governance } = deps;
  if (!governance) throw new Error('治理路由装配失败：deps.governance 未提供');

  return [
    // ── 审计日志 ──────────────────────────────────────────────────────
    {
      id: 'governance.audit',
      method: 'GET',
      path: '/api/governance/audit',
      scope: 'admin',
      capability: ['audit:read'],
      milestone: 'M3',
      summary: '审计日志（按动作/结果/用户/时间过滤，可分页）',
      handler: (ctx) => {
        const f = cleanFilters(ctx.query);
        const limit = Math.min(Number(ctx.query.limit || 100) || 100, 500);
        const offset = Math.max(Number(ctx.query.offset || 0) || 0, 0);
        const page = governance.audit.query(ctx.tenantId, { ...f, limit, offset });
        ctx.ok({
          items: page.items.map(maskRow),
          total: page.total,
          limit, offset,
          filters: f,
          latestHash: page.latestHash,
          // P1-2：链基准（归档起点）+ 已归档数量 + 锚点历史。
          // 页面上必须能同时看到「保留了多少」和「归档了多少」——
          // 只显示前者会让人以为审计少了，只显示后者又说不清当前链从哪起算。
          chain: governance.audit.chainInfo(ctx.tenantId),
          anchors: governance.audit.listAnchors(ctx.tenantId, { limit: 30 }),
          retention: {
            note: '归档与锚定由定时任务驱动（见「调度中心」的 audit.archive / audit.anchor）。'
              + '⚠️ 锚点若未离开这台机器，就防不住"有库权限的人整表重写" —— 这一点不因为启用了锚定而改变。',
          },
          note: '哈希链校验请用 POST /api/governance/audit/verify（列表接口不自动重算全链）',
        });
      },
    },

    {
      id: 'governance.audit.verify',
      method: 'POST',
      path: '/api/governance/audit/verify',
      scope: 'admin',
      capability: ['audit:read'],
      milestone: 'M3',
      summary: '重算本租户审计哈希链，报告首个断裂点',
      handler: (ctx) => {
        const result = governance.audit.verifyChain(ctx.tenantId);
        audit.append({
          tenantId: ctx.tenantId,
          userId: ctx.userId || null,
          action: 'governance.audit.verify',
          resourceType: 'audit',
          resourceId: '',
          result: result.ok ? 'ok' : 'error',
          detail: { checked: result.checked, total: result.total, brokenAt: result.brokenAt || null },
        });
        ctx.ok({
          verify: result,
          note: result.ok
            ? '哈希链完整：' + result.checked + ' 条记录全部重算通过'
            : '哈希链在第 ' + (result.brokenAt.index + 1) + ' 条处断裂 —— 自该条起记录不可信（详见 verify.brokenAt）',
        });
      },
    },

    // ── 配额与用量 ────────────────────────────────────────────────────
    {
      id: 'governance.quotas',
      method: 'GET',
      path: '/api/governance/quotas',
      scope: 'admin',
      capability: ['quota:read'],
      milestone: 'M3',
      summary: '配额清单（附当前周期已用量）',
      handler: (ctx) => {
        ctx.ok({
          items: governance.quotas.list(ctx.tenantId),
          metrics: governance.quotas.METRICS,
          periods: governance.quotas.PERIODS,
          modes: governance.quotas.MODES,
          semantics: {
            turns: '真·事前闸：提交回合前检查本周期已提交回合数',
            input_tokens: '软闸：按已用量（input+cacheRead+cacheWrite）达标后阻断下一次提交；精确事前拦截需 M5 model gateway',
            // P1-2 起并发**真有闸**（内存计数，判定与自增原子，见 concurrency.mjs / withTurnGate）。
            // 此前这里写的是"未实装"—— 代码上线了文案没跟上，属于典型的文档漂移，已改。
            concurrent: '真·事前闸：提交回合前按在途回合数判定（瞬时量，无"本周期累计"语义）',
          },
        });
      },
    },

    {
      id: 'governance.quotas.upsert',
      method: 'POST',
      path: '/api/governance/quotas',
      scope: 'admin',
      capability: ['quota:write'],
      milestone: 'M3',
      summary: '创建/更新配额（同 subject×metric×period 覆盖）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        // 只做形状校验：metric / period 的业务白名单归 service（那边已有 400 语义）
        requireBody({
          subjectType: { required: true, maxLen: 32, label: '配额对象类型' },
          metric: { required: true, maxLen: 64, label: '配额指标' },
          limitValue: { type: 'number', required: true, label: '配额上限' },
          period: { maxLen: 16, label: '配额周期' },
          mode: { maxLen: 16, label: '配额模式' },
        }, body);
        const r = governance.quotas.upsert({
          tenantId: ctx.tenantId,
          subjectType: body.subjectType,
          subjectId: body.subjectId || (body.subjectType === 'tenant' ? ctx.tenantId : null),
          metric: body.metric,
          limitValue: body.limitValue,
          period: body.period || 'month',
          mode: body.mode || 'block',
          enabled: body.enabled !== false,
        });
        if (!r.ok) {
          return ctx.json(400, { ok: false, error: { code: 'bad_request', message: r.error }, requestId: ctx.requestId });
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'governance.quota.upsert', resourceType: 'quota', resourceId: String(r.id || ''),
          result: 'ok',
          detail: {
            subjectType: body.subjectType, subjectId: body.subjectId || ctx.tenantId,
            metric: body.metric, limitValue: body.limitValue,
            period: body.period || 'month', mode: body.mode || 'block',
          },
        });
        ctx.json(201, { ok: true, id: r.id });
      },
    },

    {
      id: 'governance.quotas.remove',
      method: 'DELETE',
      path: '/api/governance/quotas/:id',
      scope: 'admin',
      capability: ['quota:write'],
      milestone: 'M3',
      summary: '删除配额',
      handler: (ctx) => {
        const r = governance.quotas.remove(ctx.tenantId, ctx.params.id);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'governance.quota.remove', resourceType: 'quota', resourceId: String(ctx.params.id),
          result: 'ok', detail: { deleted: r.deleted },
        });
        ctx.ok({ removed: r.deleted });
      },
    },

    {
      id: 'governance.quotas.update',
      method: 'PUT',
      path: '/api/governance/quotas/:id',
      scope: 'admin',
      capability: ['quota:write'],
      milestone: '0.16.0',
      summary: '编辑配额行（只改上限/模式/启用三项；对象与指标是规则身份，不在此改）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const patch = {};
        if (body.limitValue !== undefined) patch.limitValue = body.limitValue;
        if (body.mode !== undefined) patch.mode = String(body.mode);
        if (body.enabled !== undefined) patch.enabled = body.enabled;
        if (!Object.keys(patch).length) {
          return ctx.json(400, { ok: false, error: { code: 'bad_request', message: '没有要改的字段（可改：limitValue / mode / enabled）' }, requestId: ctx.requestId });
        }
        const r = governance.quotas.update(ctx.tenantId, ctx.params.id, patch);
        if (r.notFound) {
          return ctx.json(404, { ok: false, error: { code: 'not_found', message: '配额规则不存在（或不属于当前组织）' }, requestId: ctx.requestId });
        }
        if (!r.ok) {
          return ctx.json(400, { ok: false, error: { code: 'bad_request', message: r.error }, requestId: ctx.requestId });
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'governance.quota.update', resourceType: 'quota', resourceId: String(ctx.params.id),
          result: 'ok', detail: { fields: Object.keys(patch), patch },
        });
        ctx.ok({ ok: true, id: r.id, updated: Object.keys(patch) });
      },
    },

    {
      id: 'governance.usage',
      method: 'GET',
      path: '/api/governance/usage',
      scope: 'admin',
      capability: ['quota:read'],
      milestone: 'M3',
      summary: '用量汇总（总量/按天/按用户/按会话，数字全部来自 usage 事件）',
      handler: (ctx) => {
        const s = governance.usage.summarize(ctx.tenantId, {
          from: ctx.query.from || null,
          to: ctx.query.to || null,
          userId: ctx.query.userId || null,
          sessionId: ctx.query.sessionId || null,
        });
        ctx.ok({
          ...s,
          semantics: {
            input: '未缓存输入（不含缓存）',
            billableInput: '计费输入 = input + cacheRead + cacheWrite',
            reasoning: 'output 的子集，不另计',
            source: '契约层 usage 事件逐字段照抄，无估算',
          },
        });
      },
    },

    // ── 成本核算（P1-3）─────────────────────────────────────────────
    //
    // 为什么单独一条而不是塞进 /usage：两者口径**不同**。
    // usage 是"事件照抄的 token 数"（客观、可逐字段比对）；
    // cost 是"token × 当前单价"的**估算**（依赖配置，会随时间变）。混在一个响应里，
    // 前端就分不清哪个数是可核对的、哪个是估算的。
    {
      id: 'governance.cost',
      method: 'GET',
      path: '/api/governance/cost',
      scope: 'admin',
      // 与配额/用量同一资源：看到成本就能推出用量，无需另开权限面。
      capability: ['quota:read'],
      milestone: 'P1',
      summary: '成本估算（token × 当前单价；未定价的条目金额为 null，不显示为 0）',
      handler: (ctx) => {
        const limit = Math.min(Number(ctx.query.limit || 5000) || 5000, 50000);
        const r = governance.cost.summarize({
          tenantId: ctx.tenantId,
          from: ctx.query.from || null,
          to: ctx.query.to || null,
          limit,
        });
        ctx.ok({
          ...r,
          // ⚠️ 这些文案会被前端**原样转义渲染**（`esc()`），所以不要写 Markdown —— 星号会以字面量出现在页面上。
          semantics: {
            amount: '金额 = Σ(token × 单价) ÷ 1 000 000；单位是「最小货币单位」的整数（分 / 美分）。'
              + '全程整数运算，只在最后一步四舍五入 —— 浮点累加会漂出 0.01 级的误差。',
            pricing: '按当前登记的单价估算 —— 单价不追溯历史（改价不会改写过去的账）。',
            unpriced: '未登记单价的模型：金额为 null 而不是 0；0 元会被读成"免费调用"。',
            cachePrices: '缓存读写各自用各自的价；缓存没配价就记「未定价」，不用输入价顶替。',
            attribution: '归因 = usage_records.model_id（会话上登记的模型名）匹配模型条目的「模型名」列；'
              + '匹配不到进 unattributed，不拿默认模型的价去套（那会给出一个确定但错误的数）。',
            reasoning: 'reasoning 是 output 的子集，不另计。',
          },
          note: '这是估算不是账单：真实计费以供应商结算为准，且本平台不转发请求（不做 model gateway）。',
        });
      },
    },

    // ── 产物留存（M4-0，M3 顺延项）────────────────────────────────────
    {
      id: 'governance.artifacts',
      method: 'GET',
      path: '/api/governance/artifacts',
      scope: 'admin',
      capability: ['artifact:read'],
      milestone: 'M4',
      summary: '会话产物清单（工具调用中提取到的文件路径，可按会话过滤）',
      handler: (ctx) => {
        const sessionId = ctx.query.sessionId ? String(ctx.query.sessionId).slice(0, 80) : null;
        if (!sessionId) {
          return ctx.json(400, { ok: false, error: { code: 'bad_request', message: '缺少 sessionId 参数（产物清单按会话组织，不做全租户大列表）' }, requestId: ctx.requestId });
        }
        const limit = Math.min(Number(ctx.query.limit || 200) || 200, 500);
        const offset = Math.max(Number(ctx.query.offset || 0) || 0, 0);
        const r = governance.artifacts.listForSession(ctx.tenantId, sessionId, { limit, offset });
        if (r.notFound) {
          return ctx.json(404, { ok: false, error: { code: 'not_found', message: '会话不存在（或不属于当前组织）' }, requestId: ctx.requestId });
        }
        ctx.ok({
          sessionId, items: r.items, total: r.total, limit, offset,
          note: '路径来自工具 args/result 的字符串层提取 —— 工具不报就记不到，这个边界在 artifacts.mjs 顶部',
        });
      },
    },

    {
      id: 'governance.artifacts.open',
      method: 'POST',
      path: '/api/governance/artifacts/open',
      scope: 'admin',
      capability: ['artifact:read'],
      milestone: '0.21.9',
      summary: '用系统默认程序打开一个产物文件（在跑平台的那台机器上）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        // 长度直接在这里截断（与清单接口同一口径）—— 路径不是敏感字段，
        // 这里只防"拿它当垃圾桶塞几 MB 进来"。
        const p = String((body && body.path) || '').slice(0, 1024);
        // 副作用动作：先落审计再执行 —— 起进程这一步可能很慢（冷启动一个 Office 要几秒），
        // 顺序反过来会让"开了但审计还没写上"的那一瞬间存在，而这正是最该查的时候。
        audit.append({
          tenantId: ctx.tenantId,
          userId: ctx.userId || null,
          action: 'artifact.open',
          resourceType: 'artifact',
          resourceId: p,
          result: 'ok',
          detail: { path: p },
        });
        // 路径为空 / 不存在 → service 抛带 code 的 Error，由 toHttpError 收敛成 400 / 404
        const r = governance.artifacts.openWithDefaultApp(p);
        ctx.ok({ opened: true, opener: r.opener, platform: r.platform, isDir: !!r.isDir, path: p });
      },
    },

    {
      id: 'governance.sessions.log',
      method: 'GET',
      path: '/api/governance/sessions/:id/log.zip',
      scope: 'admin',
      capability: ['artifact:read'],
      milestone: 'M4',
      summary: '会话日志导出（ZIP：元信息 + 全量事件 + 产物清单 + 审计摘要）',
      handler: (ctx) => {
        const session = sessions.getSession(ctx.tenantId, ctx.params.id);
        if (!session) {
          return ctx.json(404, { ok: false, error: { code: 'not_found', message: '会话不存在（或不属于当前组织）' }, requestId: ctx.requestId });
        }
        const evs = eventsRepo.listEvents(session.id, { limit: 100000 });
        const arts = governance.artifacts.listForSession(ctx.tenantId, session.id, { limit: 5000 });

        const meta = {
          exportedAt: new Date().toISOString(),
          exportedBy: ctx.userId || null,
          tenantId: ctx.tenantId,
          session: {
            id: session.id, title: session.title, kernel: session.kernel,
            kernelSessionId: session.kernel_session_id, cwd: session.cwd,
            modelProvider: session.model_provider, modelId: session.model_id,
            createdAt: session.created_at, updatedAt: session.updated_at,
          },
          counts: { events: evs.length, artifacts: arts.total },
          contents: ['meta.json（本文件）', 'session.json', 'events.jsonl', 'artifacts.json'],
          note: '会话日志导出是快照不是备份：导出后该会话再发生的事不在包里。',
        };
        const zip = zipSync([
          { name: 'meta.json', data: JSON.stringify(meta, null, 2) },
          { name: 'session.json', data: JSON.stringify(session, null, 2) },
          { name: 'events.jsonl', data: evs.map((e) => JSON.stringify(e)).join('\n') },
          { name: 'artifacts.json', data: JSON.stringify({ total: arts.total, items: arts.items }, null, 2) },
        ]);

        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'governance.sessionlog.export', resourceType: 'session', resourceId: session.id,
          result: 'ok', detail: { events: evs.length, artifacts: arts.total, bytes: zip.length },
        });
        ctx.setHeader('content-disposition', 'attachment; filename="session-' + session.id + '-log.zip"');
        ctx.text(200, zip, 'application/zip');
      },
    },
  ];
}

/**
 * OpenAPI 3.0 规格生成（P1-3）。
 *
 * **为什么是"生成"而不是手写一份 `openapi.yaml`**：
 *   手写的规格与实现之间没有任何强制联系，第一天是对的，第二周开始漂移，
 *   第三个月没人敢信它 —— 而"没人敢信"比"没有规格"更糟：集成方会照着错的文档写代码。
 *   本项目已经有**路由表这个唯一真源**（`app/http/router.mjs`），规格只能从它生成：
 *   **新增一条路由，规格里就会自动多一条；删掉一条，规格里也就少一条。**
 *   这不是"顺便省了力气"，而是这份规格唯一可能长期正确的形态。
 *
 * **诚实边界（必须写在规格自己的 description 里，而不是藏着）**：
 *   路由表声明的是 `path / method / scope / capability`，**不含逐字段的请求体与响应体 schema** ——
 *   平台用运行时校验 + service 返回形状，从未为每个接口写过 JSON Schema。
 *   因此本规格给出的是「**接口清单 + 权限模型 + 状态码语义**」，
 *   而**不是逐字段契约**。要逐字段形状，以真实响应与回归用例为准。
 *   编造 schema（写一份看起来很完整但没人维护的 JSON Schema）比空着更危险。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

/** 路由 id 前缀 → 中文分组名（前缀取自路由表事实，缺项回落成前缀本身） */
const TAG_NAMES = {
  system: '平台与自检',
  identity: '身份与权限',
  kernel: '内核会话与回合',
  knowledge: '企业知识与检索',
  governance: '治理与审计',
  capability: '能力分发',
  operation: '备份与恢复',
  model: '模型中心',
  schedule: '调度中心',
  notify: '通知渠道',
};

/** 错误码 → 含义（与 `app/util/errors.mjs` 一一对应；这里只做人类可读说明） */
const ERROR_CODES = [
  'bad_request', 'unauthorized', 'forbidden', 'not_found', 'conflict',
  'quota_exceeded', 'upstream_error', 'capability_degraded', 'internal_error',
];

function tagOf(id) {
  const s = String(id || '');
  const i = s.indexOf('.');
  return i > 0 ? s.slice(0, i) : s;
}

/** `:id` → `{id}`，并给出路径参数列表 */
function toOpenApiPath(p) {
  const params = [];
  const out = String(p).split('/').map((seg) => {
    if (!seg.startsWith(':')) return seg;
    const name = seg.slice(1);
    params.push(name);
    return '{' + name + '}';
  }).join('/');
  return { path: out, params };
}

/**
 * 从路由表构造 OpenAPI 3.0 文档。**纯函数**（无 IO、无时间、无随机）：
 * 同一份路由表必然产出逐字节相同的文档，因此可以被快照回归钉住。
 *
 * @param {{routes:Array, version:string}} args `routes` 用 `router.list()` 的可序列化形状
 */
export function buildOpenApi({ routes = [], version = '0.0.0' } = {}) {
  const list = routes
    .map((r) => ({ ...r, id: String(r.id), method: String(r.method).toUpperCase(), path: String(r.path) }))
    // 排序：先路径后方法 —— 否则"路由注册顺序"这个与语义无关的东西会进规格，快照就会天天变。
    .sort((a, b) => (a.path === b.path ? (a.method < b.method ? -1 : 1) : (a.path < b.path ? -1 : 1)));

  const tags = [...new Set(list.map((r) => tagOf(r.id)))].sort()
    .map((t) => ({ name: t, description: (TAG_NAMES[t] || t) + '（路由 id 前缀 `' + t + '.`）' }));

  const errorResponse = (desc) => ({
    description: desc,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
  });

  const paths = {};
  for (const r of list) {
    const { path, params } = toOpenApiPath(r.path);
    if (!paths[path]) paths[path] = {};

    const cap = Array.isArray(r.capability) ? r.capability : [];
    const isPublic = r.scope === 'public';
    const hasBody = r.method !== 'GET' && r.method !== 'DELETE';

    const op = {
      operationId: r.id,
      summary: r.summary || r.id,
      tags: [tagOf(r.id)],
      // 机器可读的权限模型：集成方靠这几项就能算出"这个接口需要什么角色"
      'x-sti-scope': r.scope,
      'x-sti-capability': cap,
      'x-sti-milestone': r.milestone || '',
      responses: {
        // 用 2XX 区间而不是硬写 200：创建类接口回 201，而路由表**没有**声明成功状态码 ——
        // 与其在这里编一个，不如如实说"2xx，具体见实现"。
        '2XX': {
          description: '成功。多数接口回 200；创建类回 201。未声明逐字段 schema —— '
            + '响应以真实数据为准（见本规格 info.description 的诚实边界）。',
          content: { 'application/json': { schema: { description: '平台统一响应体（形状未逐条声明）' } } },
        },
        '400': errorResponse('请求无法处理（参数/规则校验失败）。校验在服务端执行，前端校验只是为了少一次往返。'),
        '429': errorResponse('被限流或配额拦截（`quota_exceeded`）。降级策略见 `docs/architecture.md` §7.4。'),
        '500': errorResponse('服务内部错误（`internal_error`）。堆栈只进服务端日志，不泄漏给调用方。'),
        '503': errorResponse('能力降级（`capability_degraded`）—— 例如解析依赖未安装、向量后端不可达。这是如实报告，不是伪装成 500。'),
      },
    };

    // 401/403 只对需要认证的路由声明 —— 给 public 路由写 403 等于告诉集成方
    // "这个公开接口会因为权限被拒"，那是错的。
    if (!isPublic) {
      op.responses['401'] = errorResponse('未登录、会话过期或令牌无效。所有失败原因回同一句话 —— 否则接口会变成令牌探测器。');
      op.responses['403'] = errorResponse('已登录但权限不足。返回 `error.detail.needs` 明确列出缺哪个权限键。');
    }
    // 404 只对路径里带参数的接口声明（`/api/x/:id` 才存在"这个 id 不存在"）。
    if (params.length) op.responses['404'] = errorResponse('资源不存在（`not_found`）。');

    if (hasBody) op.requestBody = {
      required: true,
      description: 'JSON 请求体。字段以服务端校验为准（本规格不声明逐字段 schema）。',
      content: { 'application/json': { schema: { type: 'object' } } },
    };

    if (params.length) {
      op.parameters = params.map((n) => ({
        name: n, in: 'path', required: true,
        schema: { type: 'string' },
        description: '路径参数（平台 id 带类型前缀，如 `org_` / `kb_` / `job_`）',
      }));
    }

    // public 的路由**显式**清空 security（空数组 = 明确不需要认证）；
    // 其余路由**不写** security，让它继承顶层 —— 继承是有语义的（"与全局一致"），
    // 而"没写"与"空数组"在 OpenAPI 里是两件不同的事，不能图省事混为一谈。
    if (isPublic) op.security = [];

    paths[path][r.method.toLowerCase()] = op;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'STI HARNESS · 平台接口',
      version: String(version),
      description: [
        '企业级时空智能体生产平台的 HTTP 接口规格。',
        '',
        '这份规格是从路由表生成的（`app/http/router.mjs` 是唯一真源），因此不会与实现漂移。',
        '',
        '## 诚实边界（先读这一段）',
        '路由表声明的是 `path / method / scope / capability`，不含逐字段的请求体与响应体 schema。',
        '平台用运行时校验 + service 返回形状，从未为每个接口写过 JSON Schema。',
        '所以本规格给的是接口清单 + 权限模型 + 状态码语义，不是逐字段契约。',
        '需要逐字段形状时，以真实响应与回归用例为准 —— 编造一份没人维护的 schema 比空着更危险。',
        '',
        '## 认证',
        '两种方式二选一：`Cookie: sti_session=<令牌>`（浏览器；HTTPS 部署下实为 `__Host-sti_session`，读取兼容两名字）或 `Authorization: Bearer <令牌>`（集成）。',
        '长期集成建议用 API Key（`/api/identity/apikeys`）而不是账号密码 —— 它可以单独吊销。',
        'Cookie 方式下写操作还要过 CSRF 判定（`Sec-Fetch-Site` / `Origin`）；Bearer 方式不受此约束。',
        '',
        '## 错误信封',
        '所有错误都是 `{ ok: false, error: { code, message, detail? } }`，`code` 取值：'
          + ERROR_CODES.map((c) => '`' + c + '`').join(' / ') + '。',
        '',
        '## 权限模型',
        '每条操作带 `x-sti-capability`（形如 `["schedule:read"]`）与 `x-sti-scope`。',
        '`scope: public` = 无需登录；`session` = 需登录；`admin` = 需管理员。',
        '权限的空缺是拒绝（未知角色一律拒绝），不是放行。',
        '',
        '## 状态码约定',
        '「条目不存在」回 404、「参数不对」回 400、「连不上」回 2xx + 结论 —— 三层不合并：',
        '把"探活失败"写成 500 会让集成方无法区分"接口坏了"与"被探的东西坏了"。',
      ].join('\n'),
    },
    // 同源部署：前端与接口在同一个进程同一个端口上（`docs/architecture.md` §1）
    servers: [{ url: '/', description: '同源（前端静态页与接口在同一进程）' }],
    // 顶层安全要求：两种方式**二选一**（数组里多个方案 = OR 语义）。
    // 单条路由不需要认证时才在自己身上写 `security: []` 覆盖掉它。
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    tags,
    paths,
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sti_session', description: '浏览器会话 Cookie（HttpOnly + SameSite=Lax；HTTPS 部署下用 __Host-sti_session）' },
        bearerAuth: { type: 'http', scheme: 'bearer', description: '会话令牌或 API Key（`sti_…` / `stik_…`）' },
      },
      schemas: {
        ErrorEnvelope: {
          type: 'object',
          required: ['ok', 'error'],
          properties: {
            ok: { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', enum: ERROR_CODES },
                message: { type: 'string', description: '人类可读摘要；不含堆栈与内部结构' },
                detail: { type: 'object', description: '可选结构化明细（如 `needs: ["schedule:read"]`）' },
              },
            },
            requestId: { type: 'string' },
            elapsedMs: { type: 'number' },
          },
        },
      },
    },
    'x-sti-generated': true,
    'x-sti-source': 'app/http/router.mjs（路由表，唯一真源）',
    'x-sti-route-count': list.length,
    'x-sti-note': '请求/响应体 schema 未逐条声明 —— 见 info.description「诚实边界」。',
  };
}

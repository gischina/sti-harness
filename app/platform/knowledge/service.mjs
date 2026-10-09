/**
 * 知识服务 —— M2 的门面。
 *
 * 一次导入的完整流程：
 *   建文档行(parsing) → worker 解析/分块/向量化 → 单事务写 chunks+vectors → 置 ready
 * 任何一步失败 → 文档置 `failed` 并保留**原始错误**（不是"解析失败"四个字）。
 *
 * 一次检索的完整流程：
 *   FTS5(bigram+bm25) 与 向量(余弦) **各自独立**跑一遍 → RRF 融合 → 组装引用
 *
 * 三条与验收标准直接对应的规则：
 *   · 检索只认 `documents.status='ready'` —— 解析失败的文档不进入结果集（验收 5）；
 *   · 每条结果的引用必须能回溯到 文档 + 页码/锚点/章节；**缺定位信息的会被标记**
 *     而不是静默返回（验收 2）；
 *   · 租户与知识库双重过滤，FTS 与向量**两条路径各写各的过滤**（验收 3）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { UPLOAD_DIR } from '../../paths.mjs';
import { AppError, errors } from '../../util/errors.mjs';
import { safeBaseName } from '../../util/fname.mjs';
import { log } from '../../log.mjs';
import { createWorkerPool } from '../../worker/pool.mjs';

import * as bases from './repos/bases.mjs';
import * as documents from './repos/documents.mjs';
import * as chunks from './repos/chunks.mjs';
// 检索器装配点：service 只依赖 `createVectorIndex/createTextIndex` 返回的 `search(payload)`，
// **不直接 import 具体实现** —— 这样"换 ANN 不改调用方"才是一句真话（见 retrievers/index.mjs）。
import { createVectorIndex, createTextIndex, MAX_PREFILTER_CANDIDATES, retrieverInfo } from './retrievers/index.mjs';
import { reciprocalRankFusion } from './retrievers/fusion.mjs';
import { createEmbeddingProvider, normalizeMode } from './embedding.mjs';
import { parserCapabilities } from './parsers/index.mjs';
import { DEFAULT_OPTIONS } from './chunker.mjs';
// 4.6 库级 ACL：判定是纯函数（可穷举测试），本文件只负责"取主体 → 调判定 → 过滤"
import { visibleBases, canAccessBase, normalizeVisibility, DEFAULT_BASE_VISIBILITY } from './visibility.mjs';

const MAX_IMPORT_BYTES = Number(process.env.STI_IMPORT_MAX_BYTES || 16 * 1024 * 1024);

/**
 * 预过滤候选的**下限**（B2）。
 * 为什么需要它：候选太少时预过滤不仅省不下成本，还会把向量路径**饿死** ——
 * 两三条候选没法参与竞争，混合检索就退化成"FTS 加了个摆设"。
 * 取 `max(32, limit*3)`：既保证候选池能被填满（向量侧原本就取 limit*3，见下方 searchVector 调用），
 * 又给 `limit=1` 这类小请求一个硬下限。
 * 低于这个数就**退化为全量扫描**（召回无损，只是慢）—— 纯语义查询与极短查询会走到这里。
 */
const MIN_PREFILTER_CANDIDATES = 32;

/**
 * @param {{config:object, audit?:object,
 *          resolveCredential?:(tenantId:string, name:string)=>string|null,
 *          resolveEmbedding?:(tenantId:string)=>object|null,
 *          resolveScopedRoles?:(userId:string, scopeType:string)=>Array<{scopeId:string, roleKey:string}>}} deps
 *   `resolveEmbedding` 由模型中心（P1-1）提供：返回该组织的默认向量项配置，
 *   返回 `null` 表示"注册表里没有可用项"，此时回落到 `config.json`。
 *   `resolveScopedRoles` 由身份服务（M1）提供：返回该用户在**库级范围**上被授的角色，
 *   供 4.6 库级 ACL 判定。知识模块**不直接读 `role_bindings`** —— 授权是身份的领域，
 *   知识层只消费"这个人有哪些库级角色"这个结论，避免两处各写一份绑定展开逻辑。
 *
 * 注：本版本 `ctx.tenantId` 就是组织 id（见 middleware/tenant.mjs），
 * 因此凭据查找与数据隔离用的是同一个键。将来若支持「一人多组织」，
 * 只需把传入的 tenantId 换成"当前选择的组织"，本文件无需改动。
 */
export function createKnowledgeService(deps = {}) {
  const config = deps.config || { values: {} };
  const audit = deps.audit || null;
  const values = config.values || {};

  /**
   * 取某用户的库级角色（逐 scope 展开）。
   *
   * ⚠️ **失败必须 fail-closed**：查询抛错时返回 `[]`（=没有任何库级授权），
   * 而不是"当作全都有"。异常路径上的默认值就是安全默认值 ——
   * 这里若反过来（出错就放行），一次数据库抖动会把所有受限库对所有人开放，
   * 而且日志里只会看到一条 warn，没人会把它和"数据泄漏"联系起来。
   */
  function scopedRolesOf(userId) {
    if (!userId || typeof deps.resolveScopedRoles !== 'function') return [];
    try { return deps.resolveScopedRoles(String(userId), 'knowledge_base') || []; }
    catch (e) { log.warn('库级角色查询失败，按"无授权"处理：' + e.message); return []; }
  }

  /**
   * 取某用户在**某一个库**上的库级角色 key（`string[]`）。
   *
   * ⚠️ 这一步的"按库抽取"绝不能省：`scopedRolesOf()` 返回的是**逐 scope 展开**的
   * `[{scopeId, roleKey}]`（列表页要一次拿全、再按库分组），而 `decideBaseAccess`
   * 要的是**已限定到本库**的 `string[]`。两者形态不同，直接把对象数组传下去，
   * 角色 key 会变成 `"[object Object]"`，在 `can()` 里被当"未知角色"跳过 ——
   * 结果是**静默退化成全局档位**（看着像"授权没生效"，其实是类型接错了）。
   */
  function scopedRoleKeysFor(userId, kbId) {
    return scopedRolesOf(userId)
      .filter((r) => r && r.scopeId === kbId)
      .map((r) => r.roleKey);
  }

  /** 主体描述：`{userId, roles}`。roles 是**租户级**角色 key（见 middleware/auth.mjs）。 */
  function normSubject(subject) {
    const s = subject || {};
    return { userId: s.userId || null, roles: Array.isArray(s.roles) ? s.roles : [] };
  }

  /** 该主体在某库上的判定输入 */
  function verdictFor(base, subject, action = 'read') {
    const sub = normSubject(subject);
    return canAccessBase({
      base,
      globalRoles: sub.roles,
      scopedRoleKeys: scopedRoleKeysFor(sub.userId, base.id),
      action,
    });
  }

  /**
   * 校验主体对某知识库的访问，返回 `{base, level}`；不通过则抛错。
   *
   * **不可见 → 404（不是 403）**：403 等于告诉对方"这个库存在，只是不给你看"，
   * 一个受限库的**存在性**本身就是信息。对所有"看不见"的情形统一按不存在处理，
   * 让枚举库 id 这件事拿不到任何额外信号（与 auth 的"不区分具体失败原因"同一原则）。
   */
  function assertBaseAccess(tenantId, kbId, subject, action = 'read') {
    const base = bases.getBase(tenantId, kbId);
    if (!base) throw errors.notFound('知识库不存在：' + kbId);
    const v = verdictFor(base, subject, action);
    if (!v.allowed) {
      if (!v.visible) throw errors.notFound('知识库不存在：' + kbId);
      throw errors.forbidden('对知识库「' + base.name + '」没有该操作的权限（当前档位：' + v.level + '）');
    }
    return { base, level: v.level };
  }

  const pool = createWorkerPool({ size: values.workerPoolSize });

  const chunkOptions = {
    maxChars: Number(values.chunkMaxChars) || DEFAULT_OPTIONS.maxChars,
    overlapChars: Number(values.chunkOverlapChars) || DEFAULT_OPTIONS.overlapChars,
    minChars: Number(values.chunkMinChars) || DEFAULT_OPTIONS.minChars,
    maxHeadingDepth: Number(values.chunkMaxHeadingDepth) || DEFAULT_OPTIONS.maxHeadingDepth,
  };

  /* ── 向量配置解析 ──────────────────────────────────────────────── */

  /** 平台级向量配置（密钥从凭据库取，永不落进配置或日志） */
  function embeddingConfig(tenantId, overrides = {}) {
    // ① 先问模型中心（P1-1）：注册表里的**默认向量项**优先于 config.json。
    //    这一接缝是"模型中心不是装饰"的关键 —— 没有它，页面上配的模型与
    //    检索真正用的模型会是两份配置。
    //    只在有组织上下文时才问：没有 tenantId 时不去猜"全局默认"（猜出来的就是假数据），
    //    此时照旧用 config.json，并在结果里把 source 标成 'config'。
    const fromRegistry = (tenantId && typeof deps.resolveEmbedding === 'function')
      ? deps.resolveEmbedding(tenantId)
      : null;
    const rawProvider = overrides.provider !== undefined
      ? overrides.provider
      : (fromRegistry ? fromRegistry.provider : values.embeddingProvider);
    const provider = normalizeMode(rawProvider);
    const source = fromRegistry ? 'model-registry' : 'config';
    const registryName = fromRegistry ? (fromRegistry.registryName || null) : null;

    if (provider === 'none') return { provider: 'none', source, registryName };

    const credName = (fromRegistry && fromRegistry.credentialName) || values.embeddingCredentialName || '';
    let apiKey = '';
    if (credName && typeof deps.resolveCredential === 'function') {
      try { apiKey = deps.resolveCredential(tenantId, credName) || ''; }
      catch (e) { log.warn('读取向量服务凭据失败：' + e.message); }
    }
    return {
      provider,
      baseUrl: overrides.baseUrl || (fromRegistry && fromRegistry.baseUrl) || values.embeddingBaseUrl || '',
      model: overrides.model || (fromRegistry && fromRegistry.model) || values.embeddingModel || '',
      dim: overrides.dim !== undefined ? overrides.dim : 0,
      apiKey,
      timeoutMs: Number(values.embeddingTimeoutMs) || 20000,
      source,
      registryName,
    };
  }

  /** 供状态页展示：当前向量模式（不发起网络调用，但**如实标注配置来源**） */
  function embeddingDescribe(tenantId) {
    const cfg = embeddingConfig(tenantId, {});
    const p = createEmbeddingProvider(cfg);
    const d = p.describe();
    // source 是"这份配置从哪来"：model-registry（模型中心）还是 config（config.json）。
    // 不标的话，界面就无法区分"注册表里配了但没生效"与"根本没用注册表"。
    d.source = cfg.source || 'config';
    if (cfg.registryName) d.registryName = cfg.registryName;
    return d;
  }

  /** 真实探活（会发起一次网络调用，仅在显式请求时执行） */
  async function embeddingHealth(tenantId) {
    const p = createEmbeddingProvider(embeddingConfig(tenantId, {}));
    return p.health();
  }
  /* ── 知识库 ───────────────────────────────────────────────────── */

  function createBase({ tenantId, name, visibility }) {
    const clean = String(name || '').trim();
    if (!clean) throw errors.badRequest('知识库名称不能为空');
    if (bases.getBaseByName(tenantId, clean)) throw errors.conflict('同名知识库已存在：' + clean);
    // 可见性在**建库时**就能定（默认 tenant）。坏值抛 400 而不是静默按公开处理 ——
    // 建库时把 visibility 打错成 'restrict' 却建成公开库，是一个没人会发现的漏洞。
    let vis = DEFAULT_BASE_VISIBILITY;
    try { vis = normalizeVisibility(visibility); } catch (e) { throw errors.badRequest(e.message); }
    const cfg = embeddingConfig(tenantId);
    return bases.createBase({
      tenantId,
      name: clean,
      visibility: vis,
      embeddingProvider: cfg.provider === 'none' ? '' : cfg.provider,
      embeddingModel: cfg.provider === 'none' ? '' : (cfg.model || ''),
      dim: 0,
    });
  }

  /**
   * 该主体**可见**的知识库（每项附自己的档位 `accessLevel`）。
   *
   * 关键：不可见的库**不出现在返回值里**，而不是"返回了但前端不显示"——
   * 后者等于把数据发出去了，前端的一句话截图就能看到不该看的东西。
   */
  function listBases(tenantId, subject) {
    const sub = normSubject(subject);
    const rows = visibleBases(bases.listBases(tenantId), {
      globalRoles: sub.roles,
      scopedRoles: scopedRolesOf(sub.userId),
    });
    return rows.map((x) => ({ ...x.base, accessLevel: x.level, accessReason: x.reason }));
  }

  /** 取单个库（先过可见性；看不见按不存在处理） */
  function getBase(tenantId, id, subject) {
    return assertBaseAccess(tenantId, id, subject, 'read').base;
  }

  function deleteBase(tenantId, id, subject) {
    assertBaseAccess(tenantId, id, subject, 'delete');
    return bases.deleteBase(tenantId, id);
  }

  /**
   * 改知识库名。
   *
   * 档位取 `write`（与改可见性同档），**刻意不比照删库要 `delete`**：
   * 改名只动一个显示字段，不改变任何访问边界，破坏性与"删库"不在一个量级；
   * 用 delete 档会把"想改个名字"的组织成员挡在外面（而他本来就能改可见性）。
   *
   * 变更入审计的理由：名字是所有人**识别这个库**的依据。被悄悄改掉之后，
   * 别人会以为多了一个新库 / 少了一个旧库 —— 这类"不报错的困惑"必须有痕迹可查。
   */
  function renameBase(tenantId, id, name, subject) {
    assertBaseAccess(tenantId, id, subject, 'write');
    const clean = String(name == null ? '' : name).trim();
    if (!clean) throw errors.badRequest('知识库名称不能为空');
    if (clean.length > 120) throw errors.badRequest('知识库名称过长（上限 120 字符）');
    const row = bases.renameBase(tenantId, id, clean);
    if (audit) {
      audit.append({
        tenantId,
        userId: (subject && subject.userId) || null,
        action: 'knowledge.base.rename',
        resourceType: 'knowledge_base',
        resourceId: id,
        result: 'ok',
        detail: { name: clean },
      });
    }
    return row;
  }

  /**
   * 改可见性。需要 `write` 档（全局管理员，或在该库上被授到 admin/owner）。
   * 变更**强制入审计**：这是安全边界上的开关，事后必须能回答"谁在什么时候
   * 把哪个库从受限改成了公开"——那是一次可能的数据暴露事件。
   */
  function setBaseVisibility(tenantId, id, visibility, subject) {
    assertBaseAccess(tenantId, id, subject, 'write');
    let vis;
    try { vis = normalizeVisibility(visibility); } catch (e) { throw errors.badRequest(e.message); }
    const row = bases.updateBaseVisibility(tenantId, id, vis);
    if (audit) {
      audit.append({
        tenantId,
        userId: (subject && subject.userId) || null,
        action: 'knowledge.base.visibility',
        resourceType: 'knowledge_base',
        resourceId: id,
        result: 'ok',
        detail: { visibility: vis },
      });
    }
    return row;
  }

  /* ── 库级授权（4.6）───────────────────────────────────────────────
   *
   * 写入委托给**身份服务**（`deps.identity`）：授权是身份的领域，绑定表
   * `role_bindings` 也归它管。知识层在这里只做两件事：
   *   ① 用**本库的**可见性判定把关（能管这个库才配管它的授权名单）；
   *   ② 强制入审计（授权/撤权是安全边界上的动作）。
   *
   * 为什么要 `assertBaseAccess(..., 'write')` 而不是 read：一个受限库**授权给了谁**
   * 本身就是敏感信息（名单会暴露组织里的分工与结构）。能读库内容 ≠ 有资格看名单。
   */

  function needIdentity() {
    if (!deps.identity || typeof deps.identity.listScopeBindings !== 'function') {
      throw errors.internal('知识服务未接身份服务（deps.identity），无法管理库级授权');
    }
    return deps.identity;
  }

  function listBaseGrants(tenantId, kbId, subject) {
    assertBaseAccess(tenantId, kbId, subject, 'write');
    return needIdentity().listScopeBindings(tenantId, 'knowledge_base', kbId);
  }

  function grantBase({ tenantId, kbId, subjectType = 'user', subjectId, roleKey, subject }) {
    assertBaseAccess(tenantId, kbId, subject, 'write');
    const b = needIdentity().grantScopedRole({
      orgId: tenantId,
      scopeType: 'knowledge_base',
      scopeId: kbId,
      subjectType,
      subjectId,
      roleKey,
    });
    if (audit) {
      audit.append({
        tenantId,
        userId: (subject && subject.userId) || null,
        action: 'knowledge.base.grant',
        resourceType: 'knowledge_base',
        resourceId: kbId,
        result: 'ok',
        detail: { bindingId: b.id, subjectType, subjectId, roleKey },
      });
    }
    return b;
  }

  /**
   * 撤权。**必须先确认这条绑定属于本库** —— 否则一个对库 A 有 write 档的人，
   * 可以拿库 B 的 bindingId 把库 B 上的授权撤掉（越权）：绑定的归属校验
   * 不能靠"调用方给对了 kbId"来保证。
   */
  function revokeBaseGrant({ tenantId, kbId, bindingId, subject }) {
    assertBaseAccess(tenantId, kbId, subject, 'write');
    const idn = needIdentity();
    const mine = idn.listScopeBindings(tenantId, 'knowledge_base', kbId);
    if (!mine.some((b) => String(b.id) === String(bindingId))) {
      throw errors.notFound('授权不存在：' + bindingId);
    }
    const r = idn.revokeScopedRole(tenantId, bindingId);
    if (audit) {
      audit.append({
        tenantId,
        userId: (subject && subject.userId) || null,
        action: 'knowledge.base.revoke',
        resourceType: 'knowledge_base',
        resourceId: kbId,
        result: 'ok',
        detail: { bindingId },
      });
    }
    return r;
  }

  /* ── 文档导入 ─────────────────────────────────────────────────── */

  function safeExt(filename, mime) {
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(filename || ''));
    if (m) return m[1].toLowerCase();
    return String(mime || '').includes('pdf') ? 'pdf' : 'bin';
  }

  /** 文件名净化已收归 `app/util/fname.mjs` 单点（与 routes/kernel.mjs 共用同一条规则）。 */
  const SAFE_NAME_FALLBACK = 'document';

  function storeFile(docId, filename, buffer) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const base = safeBaseName(filename, SAFE_NAME_FALLBACK);
    const rel = path.posix.join('uploads', docId + '__' + base);
    fs.writeFileSync(path.join(UPLOAD_DIR, docId + '__' + base), buffer);
    return rel;                                   // 存**相对路径**，不泄漏部署机目录结构
  }

  function absoluteStorage(p) {
    if (!p) return null;
    const safe = String(p).replace(/\.\./g, '');
    return path.join(path.dirname(UPLOAD_DIR), safe);
  }

  /**
   * 导入一个文档。
   * @param {{tenantId:string, userId?:string, kbId:string,
   *          filename?:string, mime?:string, buffer?:Buffer|Uint8Array, text?:string,
   *          title?:string, sourceType?:string, sourceRef?:string, force?:boolean}} input
   */
  async function ingest(input) {
    const tenantId = input.tenantId;
    // 导入是**写**动作：看不见的库按 404，看得见但档位不够按 403。
    // 校验放在"取 base"这一处，后面所有路径（去重、落盘、解析）都建立在它之上。
    const { base } = assertBaseAccess(tenantId, input.kbId, { userId: input.userId, roles: input.roles }, 'write');

    const hasBuffer = input.buffer != null;
    const buffer = hasBuffer
      ? (Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer))
      : Buffer.from(String(input.text == null ? '' : input.text), 'utf8');

    if (buffer.length > MAX_IMPORT_BYTES) {
      throw errors.badRequest('文档过大（' + Math.round(buffer.length / 1024 / 1024) + ' MB），上限 '
        + Math.round(MAX_IMPORT_BYTES / 1024 / 1024) + ' MB。请拆分后导入。');
    }
    if (!buffer.length) throw errors.badRequest('文档内容为空');

    const filename = String(input.filename || (hasBuffer ? 'document' : 'pasted.txt'));
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    if (!input.force && hasBuffer) {
      const dup = documents.findBySha(base.id, sha256);
      if (dup) {
        return { duplicate: true, document: publicDocument(dup), note: '该知识库中已存在内容完全相同的文档（sha256 相同），未重复导入' };
      }
    }

    const doc = documents.createDocument({
      kbId: base.id,
      title: String(input.title || filename).slice(0, 300),
      mime: String(input.mime || ''),
      size: buffer.length,
      sha256,
      // ⚠️ 先建行、再落文件、再回填路径：存储路径里含文档 id，
      //    而 id 只有插入之后才存在（早先在参数里直接用 doc.id 触发过 TDZ 报错）。
      storagePath: '',
      sourceType: String(input.sourceType || (hasBuffer ? 'file' : 'text')),
      sourceRef: String(input.sourceRef || filename).slice(0, 500),
      status: 'parsing',
    });

    if (hasBuffer) {
      try {
        documents.setStoragePath(doc.id, storeFile(doc.id, filename, buffer));
      } catch (e) {
        documents.setDocumentStatus(doc.id, 'failed', { error: '文件落盘失败：' + e.message });
        throw errors.internal('文档已登记但保存文件失败：' + e.message);
      }
    }

    const started = Date.now();
    let result;
    try {
      result = await pool.run({
        filename,
        mime: input.mime || '',
        source: hasBuffer ? { kind: 'buffer', bytes: buffer } : { kind: 'text', text: String(input.text || '') },
        options: chunkOptions,
        embed: (() => {
          const cfg = embeddingConfig(tenantId, { dim: Number(base.dim) || 0 });
          return cfg.provider === 'none' ? null : cfg;
        })(),
      });
    } catch (e) {
      const message = describeIngestError(e, filename);
      documents.setDocumentStatus(doc.id, 'failed', { error: message });
      audit?.append?.({
        tenantId, userId: input.userId || null, action: 'knowledge.document.ingest',
        resourceType: 'document', resourceId: doc.id, result: 'failed',
        detail: { kbId: base.id, filename, code: e.code || 'ingest_failed', message },
      });
      const err = new AppError(e.code === 'parser_unavailable' ? 'parser_unavailable' : 'parse_failed', message,
        e.code === 'parser_unavailable' ? 422 : 422);
      err.document = publicDocument(documents.getDocument(null, doc.id));
      err.detail = { documentId: doc.id, parserCode: e.code || null };
      throw err;
    }

    const vectors = result.vectors ? result.vectors.map((v) => v.data) : null;
    const dim = result.dim || 0;
    const written = chunks.insertChunks({ docId: doc.id, kbId: base.id, chunks: result.chunks, vectors, dim });

    // 首次向量化成功 → 记住维度（之后维度不一致会被 embedding provider 直接拒绝）
    if (dim > 0 && !Number(base.dim)) bases.updateBaseEmbedding(tenantId, base.id, { dim });

    // 记下**这篇文档实际的向量来源**（0010）。不记的话，"换过向量模型之后
    // 新旧向量混着比"是完全不可见的 —— 检索只是"变差"，没有任何报错。
    documents.setDocumentEmbedding(doc.id, {
      provider: (result.embedding && result.embedding.mode) || '',
      model: (result.embedding && result.embedding.model) || '',
      dim,
    });

    const finished = documents.finishDocument(doc.id, { chunkCount: written.inserted });

    audit?.append?.({
      tenantId, userId: input.userId || null, action: 'knowledge.document.ingest',
      resourceType: 'document', resourceId: doc.id, result: 'ok',
      detail: {
        kbId: base.id, filename, parser: result.parser, chunks: written.inserted,
        vectors: written.vectors, warnings: result.warnings.length, elapsedMs: Date.now() - started,
      },
    });

    return {
      duplicate: false,
      document: publicDocument(finished),
      report: {
        parser: result.parser,
        meta: result.meta,
        degraded: result.degraded,
        warnings: result.warnings,
        chunkCount: written.inserted,
        vectorCount: written.vectors,
        embedding: result.embedding,
        elapsedMs: Date.now() - started,
      },
    };
  }

  function describeIngestError(e, filename) {
    const code = e && e.code;
    if (code === 'parser_unavailable') return e.message;
    if (code === 'unsupported_format') return e.message;
    if (code === 'parse_failed') return '解析失败：' + e.message;
    return '导入失败：' + (e && e.message ? e.message : String(e));
  }

  function publicDocument(row) {
    if (!row) return null;
    let meta = {};
    try { meta = JSON.parse(row.meta_json || '{}'); } catch { /* 损坏的元信息不影响主体 */ }
    return {
      id: row.id,
      kbId: row.kb_id,
      title: row.title,
      mime: row.mime,
      size: row.size,
      sha256: row.sha256,
      status: row.status,
      error: row.error || null,
      chunkCount: Number(row.chunk_count) || 0,
      sourceType: row.source_type || '',
      sourceRef: row.source_ref || '',
      // 向量来源（0010）：让"两种模型嵌入的向量混在一起比"这件事**可见**。
      // 空字符串表示"未知来源"（0010 之前的文档），绝不替它编一个模型名。
      embeddingProvider: row.embedding_provider || '',
      embeddingModel: row.embedding_model || '',
      embeddingDim: Number(row.embedding_dim) || 0,
      createdAt: row.created_at,
      parsedAt: row.parsed_at || null,
      meta,
    };
  }

  function listDocuments(tenantId, kbId, opts = {}, subject) {
    assertBaseAccess(tenantId, kbId, subject, 'read');
    const rows = documents.listDocuments(kbId, opts);
    return {
      items: rows.map(publicDocument),
      total: documents.countDocuments(kbId),
      statusCounts: documents.statusCounts(kbId),
    };
  }

  function getDocument(tenantId, docId, subject) {
    const row = documents.getDocument(tenantId, docId);
    if (!row) throw errors.notFound('文档不存在或不属于当前组织：' + docId);
    // 文档本身没有租户/可见性字段，它挂在库下 —— 所以校验必须**经库**做。
    // 这条是"文档详情"的唯一入口：漏了它，库看不到、但凭文档 id 能读到全文。
    assertBaseAccess(tenantId, row.kb_id, subject, 'read');
    return publicDocument(row);
  }

  function deleteDocument(tenantId, docId, subject) {
    const row = documents.getDocument(tenantId, docId);
    if (!row) throw errors.notFound('文档不存在或不属于当前组织：' + docId);
    assertBaseAccess(tenantId, row.kb_id, subject, 'delete');
    const removed = chunks.deleteChunksByDoc(docId);
    documents.deleteDocument(docId);
    const abs = absoluteStorage(row.storage_path);
    if (abs) { try { fs.unlinkSync(abs); } catch { /* 文件可能已被清理 */ } }
    return { deleted: true, chunksRemoved: removed };
  }

  /**
   * 改文档标题。
   *
   * 档位取 `write`（经库判定）—— 与改库名同理：只动一个显示字段，
   * 不触发重新解析，sha256 / 分块 / 向量一律不碰。
   *
   * 上限 300 与导入时一致（`ingest` 里 `.slice(0, 300)`）—— 否则会出现
   * "导入时被静默截断、改名时却嫌长"的口径分裂。
   * 变更入审计：标题是引用链（`文档标题 › 章节`）的第一段，
   * 被悄悄改掉之后，旧引用看起来就像指向了另一份文档。
   */
  function renameDocument(tenantId, docId, title, subject) {
    const row = documents.getDocument(tenantId, docId);
    if (!row) throw errors.notFound('文档不存在或不属于当前组织：' + docId);
    assertBaseAccess(tenantId, row.kb_id, subject, 'write');
    const clean = String(title == null ? '' : title).trim();
    if (!clean) throw errors.badRequest('文档标题不能为空');
    if (clean.length > 300) throw errors.badRequest('文档标题过长（上限 300 字符，与导入时一致）');
    const updated = documents.renameDocument(docId, clean);
    if (audit) {
      audit.append({
        tenantId,
        userId: (subject && subject.userId) || null,
        action: 'knowledge.document.rename',
        resourceType: 'document',
        resourceId: docId,
        result: 'ok',
        detail: { title: clean, kbId: row.kb_id },
      });
    }
    return publicDocument(updated);
  }

  /* ── 重试与重建（P1-2）─────────────────────────────────────────
   *
   * 为什么必须有这两件事（都是真实场景，不是"补整齐"）：
   *
   *   ① **重试**：文档解析失败会如实留下错误（这点原本就对），但**没有重试入口** ——
   *      补装 `pdftotext` / LibreOffice 之后只能"删了重传"。企业场景里
   *      "先导一批、发现缺依赖、装完再补"是常态，而重传意味着重新找文件、
   *      重新选库、重新等，且 sha256 去重会把它当成一次全新导入。
   *
   *   ② **重建（重新向量化）**：P1-1 让默认向量模型可以在页面上点一下切换，
   *      于是出现了一个此前只是理论的状态 —— **同一个知识库里两种模型嵌入的
   *      向量混在一起参与余弦比较**。数学上算得出数，语义上毫无意义，
   *      而且**没有任何报错**（结果只是"变差了"）。0010 迁移把每篇文档的
   *      向量来源记了下来，`reindexBase` 是它能派上用场的动作。
   *
   * ⚠️ 边界（如实）：重试/重建都要求**原始文件还在**。粘贴文本导入的文档
   *    （`sourceType='text'`）没有落盘原文，因此**无法重试** ——
   *    这时如实报错并建议"删除后重新粘贴"，而不是假装成功。
   */

  /** 重跑一篇文档的解析 → 分块 → 向量化（重试与重建的**唯一实现**） */
  async function reprocessDocument({ tenantId, row, userId = null, reason = 'retry' }) {
    const base = bases.getBase(tenantId, row.kb_id);
    if (!base) throw errors.notFound('知识库不存在或不属于当前组织：' + row.kb_id);

    const abs = absoluteStorage(row.storage_path);
    if (!abs || !fs.existsSync(abs)) {
      return {
        ok: false, reason: 'no_source_file',
        error: '这篇文档没有可用的原始文件（粘贴文本导入，或文件已被清理），无法重新解析。'
          + '请删除后重新导入。',
      };
    }
    const buffer = fs.readFileSync(abs);
    const filename = String(row.source_ref || row.title || 'document');

    documents.setDocumentStatus(row.id, 'parsing', { error: null });
    const started = Date.now();
    let result;
    try {
      result = await pool.run({
        filename,
        mime: row.mime || '',
        source: { kind: 'buffer', bytes: buffer },
        options: chunkOptions,
        embed: (() => {
          const cfg = embeddingConfig(tenantId, { dim: Number(base.dim) || 0 });
          return cfg.provider === 'none' ? null : cfg;
        })(),
      });
    } catch (e) {
      const message = describeIngestError(e, filename);
      documents.setDocumentStatus(row.id, 'failed', { error: message });
      audit?.append?.({
        tenantId, userId, action: 'knowledge.document.' + reason,
        resourceType: 'document', resourceId: row.id, result: 'failed',
        detail: { kbId: base.id, filename, code: e.code || 'ingest_failed', message },
      });
      return { ok: false, reason: 'parse_failed', error: message, documentId: row.id };
    }

    const vectors = result.vectors ? result.vectors.map((v) => v.data) : null;
    const dim = result.dim || 0;
    // 先删旧块再写新块：顺序不能反 —— 反了会短暂出现"新旧块同时存在"，
    // 而检索是可能在这一瞬间发生的（并发导入时）。
    chunks.deleteChunksByDoc(row.id);
    const written = chunks.insertChunks({ docId: row.id, kbId: base.id, chunks: result.chunks, vectors, dim });
    if (dim > 0 && !Number(base.dim)) bases.updateBaseEmbedding(tenantId, base.id, { dim });

    const emb = result.embedding || {};
    documents.setDocumentEmbedding(row.id, { provider: emb.mode || '', model: emb.model || '', dim });
    const finished = documents.finishDocument(row.id, { chunkCount: written.inserted });

    audit?.append?.({
      tenantId, userId, action: 'knowledge.document.' + reason,
      resourceType: 'document', resourceId: row.id, result: 'ok',
      detail: {
        kbId: base.id, filename, chunks: written.inserted, vectors: written.vectors,
        embedding: emb.mode || null, model: emb.model || null, dim, elapsedMs: Date.now() - started,
      },
    });

    return {
      ok: true,
      documentId: row.id,
      document: publicDocument(finished),
      report: {
        chunkCount: written.inserted, vectorCount: written.vectors,
        embedding: emb, dim, warnings: (result.warnings || []).length,
        elapsedMs: Date.now() - started,
      },
    };
  }

  /** 重试一篇失败（或任意）文档：复用原始文件重新解析。 */
  async function retryDocument(tenantId, docId, { userId = null, roles = [] } = {}) {
    const row = documents.getDocument(tenantId, docId);
    if (!row) throw errors.notFound('文档不存在或不属于当前组织：' + docId);
    // 重试会重跑解析并**覆写**该文档的分块与向量 —— 是写动作
    assertBaseAccess(tenantId, row.kb_id, { userId, roles }, 'write');
    return reprocessDocument({ tenantId, row, userId, reason: 'retry' });
  }

  /**
   * 重建整个知识库的向量（换 embedding 模型之后必须做）。
   *
   * **不做静默跳过**：每一篇文档的结果都逐条返回（成功/失败/原因），
   * 因为"重建跑了但有几篇没成功"是必须让人看见的 —— 否则库里会留下
   * 一批旧模型的向量，而这正是要消除的东西。
   *
   * @returns {{total:number, ok:number, failed:number, skipped:number,
   *            items:Array<{documentId:string, title:string, ok:boolean, reason?:string, error?:string}>}}
   */
  async function reindexBase(tenantId, kbId, { userId = null, roles = [], limit = 500 } = {}) {
    // 重建整个库的向量 = 批量写，需要 write 档
    assertBaseAccess(tenantId, kbId, { userId, roles }, 'write');
    const rows = documents.listDocuments(kbId, { limit: Number(limit) || 500 });
    const items = [];
    let ok = 0; let failed = 0; let skipped = 0;
    for (const row of rows) {
      const r = await reprocessDocument({ tenantId, row, userId, reason: 'reindex' });
      if (r.ok) { ok++; items.push({ documentId: row.id, title: row.title, ok: true, chunks: r.report.chunkCount }); }
      else if (r.reason === 'no_source_file') { skipped++; items.push({ documentId: row.id, title: row.title, ok: false, reason: 'no_source_file', error: r.error }); }
      else { failed++; items.push({ documentId: row.id, title: row.title, ok: false, reason: r.reason, error: r.error }); }
    }
    audit?.append?.({
      tenantId, userId, action: 'knowledge.base.reindex', resourceType: 'knowledge_base', resourceId: kbId,
      result: failed ? 'error' : 'ok',
      detail: { total: rows.length, ok, failed, skipped },
    });
    return { total: rows.length, ok, failed, skipped, items };
  }

  /**
   * 向量一致性检查 —— 库里有没有"两种模型嵌入的向量混着"的情况。
   * 页面据此给出"建议重建"的提示；**不自动重建**（重建会真的花钱调模型）。
   */
  function embeddingConsistency(tenantId, kbId, subject) {
    const { base } = assertBaseAccess(tenantId, kbId, subject, 'read');
    const rows = documents.listDocuments(kbId, { limit: 1000 });
    const groups = new Map();
    for (const r of rows) {
      if (r.status !== 'ready') continue;
      const key = (r.embedding_model || '(未知来源)') + ' · ' + (r.embedding_provider || '—');
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    const byModel = [...groups].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
    const current = embeddingConfig(tenantId, { dim: Number(base.dim) || 0 });
    const currentKey = current.provider === 'none'
      ? '(未配向量)'
      : (current.model || '(未命名模型)') + ' · ' + (current.provider || '—');
    return {
      kbId, reported: base.name,
      current,
      currentKey,
      byModel,
      distinctModels: byModel.filter((g) => g.key !== '(未知来源) · —').length,
      consistent: byModel.length <= 1,
      note: byModel.length <= 1
        ? '库内文档的向量来源一致。'
        : '库内存在多种来源的向量 —— 它们会被放进同一次余弦比较里，结果不可信。建议「重建向量」。',
    };
  }

  /** 分块预览 —— 直接展示引用链的原料（用户可核对分块是否合理） */
  function previewChunks(tenantId, docId, { limit = 50, offset = 0 } = {}, subject) {
    const row = documents.getDocument(tenantId, docId);
    if (!row) throw errors.notFound('文档不存在或不属于当前组织：' + docId);
    // 分块正文是**原文片段** —— 与读全文同等敏感，必须经库可见性把关
    assertBaseAccess(tenantId, row.kb_id, subject, 'read');
    const items = chunks.listChunksByDoc(docId, { limit, offset }).map((c) => {
      let meta = {};
      try { meta = JSON.parse(c.meta_json || '{}'); } catch { /* 忽略 */ }
      return {
        id: Number(c.id),
        ord: Number(c.ord),
        body: c.body,
        tokenCount: Number(c.token_count) || 0,
        hasVector: Number(c.has_vector) > 0,
        meta,
        locationKnown: !!meta.locationKnown,
        citationLabel: citationLabel(row.title, meta),
      };
    });
    return { document: publicDocument(row), items, total: chunks.countChunksByDoc(docId) };
  }

  /* ── 检索 ─────────────────────────────────────────────────────── */

  /**
   * 预过滤策略（B2）的解析：请求级 `args.prefilter` 覆盖 > 配置项 `prefilterVector`。
   *
   * 允许**双向**覆盖（而不是只允许关掉）：压测与对照实验需要能强制打开，
   * 而"这次我就是要召回无损"需要能强制关掉。默认值仍来自配置，不在这里造第二个默认。
   *
   * 候选上限会被**夹到安全上限内**（MAX_PREFILTER_CANDIDATES 转发自 vector.mjs 的
   * SQL 变量上限）—— 配了个过大的值不会变成 SQL 变量爆炸，而是在生效处被夹住，
   * 并由 `clamped` 如实告知调用方。
   */
  function prefilterPolicy(override) {
    const configured = Number(values.prefilterCandidates);
    const wanted = Number.isFinite(configured) && configured > 0 ? configured : 512;
    const maxCandidates = Math.max(MIN_PREFILTER_CANDIDATES, Math.min(wanted, MAX_PREFILTER_CANDIDATES));
    // 缺省即**关**（严格 `=== true`）：没有配置时不该悄悄改变检索答案。
    // 写成 `!== false` 会在 `values` 为空对象（无配置的测试装配）时判定为开 ——
    // 默认值必须 fail-safe 到"行为不变"那一侧。
    const enabled = (override === undefined || override === null)
      ? values.prefilterVector === true
      : !!override;
    return {
      enabled,
      maxCandidates,
      clamped: wanted > MAX_PREFILTER_CANDIDATES,
      source: (override === undefined || override === null) ? 'config' : 'request',
    };
  }

  /**
   * 混合检索。
   * @param {{tenantId:string, kbIds?:string[], query:string, limit?:number, prefilter?:boolean}} args
   *   `prefilter`（B2）：请求级覆盖向量预过滤开关；不传则用配置项 `prefilterVector`。
   */
  async function search(args) {
    const tenantId = args.tenantId;
    const query = String(args.query || '').trim();
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100);
    const notes = [];

    if (!query) throw errors.badRequest('查询内容不能为空');

    // 检索实现从**装配点**取（不 import 具体函数）—— 换索引/换 ANN 只动 retrievers/index.mjs。
    const textIndex = createTextIndex({});
    const vectorIndex = createVectorIndex({});

    // 知识库范围：**先过可见性**，再逐个校验。两点变化（4.6）：
    //   ① 不可见的库即便 id 正确也**不算数** —— 否则"看不见列表、但能检索内容"就是一条裂缝；
    //   ② 不区分"不存在"与"存在但无权"，都只说"不可见或不存在"（不确认存在性）。
    const sub = normSubject({ userId: args.userId, roles: args.roles });
    const viewable = new Set(
      visibleBases(bases.listBases(tenantId), {
        globalRoles: sub.roles,
        scopedRoles: scopedRolesOf(sub.userId),
      }).map((x) => x.base.id)
    );

    let scope = [];
    if (Array.isArray(args.kbIds) && args.kbIds.length) {
      const requested = [...new Set(args.kbIds.map(String))].filter(Boolean);
      const owned = [];
      for (const id of requested) {
        if (viewable.has(id)) owned.push(id);
        else notes.push('已忽略不可见或不存在的知识库：' + id);
      }
      if (!owned.length) throw errors.forbidden('指定的知识库都不可访问');
      scope = owned;
    } else {
      scope = [...viewable];
      if (!scope.length) notes.push('当前没有可见的知识库');
    }

    const timings = {};
    const pf = prefilterPolicy(args.prefilter);

    let fts = { items: [], matchMode: 'none', notes: [] };
    if (scope.length) {
      const t0 = Date.now();
      fts = textIndex.search({ tenantId, kbIds: scope, query, limit: limit * 3 });
      timings.ftsMs = Date.now() - t0;
      notes.push(...fts.notes);
    }

    // 预过滤候选：**单独跑一次只取 id 的文本查询**，与上面的 search 共用同一套匹配语义
    // （同一 kbClause / 同一 SQL / 同一查询阶梯，见 retrievers/fts.mjs 的 runLadder）。
    //
    // 为什么不复用 fts.items：那个列表的 LIMIT 是 `limit*3`（默认 30），
    // 拿 30 条当"候选"等于把向量路径锁死在文本命中的前 30 名里 —— 那不是预过滤，那是废弃向量检索。
    let candidates = null;
    if (pf.enabled && scope.length) {
      const t0 = Date.now();
      candidates = textIndex.ids({ tenantId, kbIds: scope, query, limit: pf.maxCandidates });
      timings.prefilterMs = Date.now() - t0;
      notes.push(...candidates.notes);
      if (pf.clamped) {
        notes.push('prefilterCandidates 配置超过安全上限，本次按 ' + pf.maxCandidates + ' 生效（受 SQL 变量数上限约束）。');
      }
    }

    // 向量路径：与 FTS 完全独立地跑一遍（各自带自己的租户+库过滤）
    let vec = { items: [], notes: [] };
    let vectorMode = 'off';
    let vectorError = null;
    const cfg = embeddingConfig(tenantId, {});
    if (cfg.provider !== 'none' && scope.length) {
      const provider = createEmbeddingProvider(cfg);
      const t0 = Date.now();
      try {
        const qv = await provider.embed([query]);
        if (qv && qv.vectors.length) {
          // 守卫：候选不够喂满候选池 → 退化为**全量扫描**（召回无损，只是慢）。
          // 这一步是整套预过滤的**安全阀**：少了它，纯语义查询（字面 0 命中）会拿到一个
          // 空候选集，结果是"语义检索静默失效"，而调用方从结果里看不出召回被砍了。
          let candidateIds = null;
          if (pf.enabled && candidates) {
            const need = Math.max(MIN_PREFILTER_CANDIDATES, limit * 3);
            if (candidates.ids.length >= need) candidateIds = candidates.ids;
          }
          vec = vectorIndex.search({ tenantId, kbIds: scope, queryVec: qv.vectors[0], limit: limit * 3, candidateIds });
          vectorMode = 'on';
          notes.push(...vec.notes);
        }
      } catch (e) {
        vectorMode = 'failed';
        vectorError = { code: e.code, message: e.message };
        notes.push('向量检索不可用，本次结果仅来自文本检索：' + e.message);
      }
      timings.vectorMs = Date.now() - t0;
    } else if (cfg.provider === 'none') {
      // notes 会原样显示在 UI 上（纯文本渲染）—— 别写 markdown 星号。
      notes.push('未配置向量模型（embedding=none），检索为纯文本模式（bigram + FTS5 bm25）');
    }

    // 预过滤的**如实报告**：一个布尔值说不清"到底有没有生效、为什么没生效"。
    // 这里的取值全部在**最后统一推导**（而不是在多分支里到处赋值）——
    // 状态变量分散赋值最容易漏：新增一个 early-return 分支时没人会记得回去补一句。
    const vpf = vec.prefilter || {};
    const prefilter = {
      enabled: pf.enabled,
      applied: vpf.applied === true,
      reason: (() => {
        if (!pf.enabled) return 'disabled';                    // 配置或请求关掉了
        if (!scope.length) return 'no_scope';                  // 没有可见知识库
        if (cfg.provider === 'none') return 'no_embedding';    // 没配向量，预过滤无从谈起
        if (vectorMode === 'failed') return 'vector_failed';   // 向量路径本身失败了
        if (!vpf.requested) return 'too_few_candidates';       // 候选不足 → 已退化为全量扫描
        if (vpf.applied) return 'applied';
        return 'candidate_cap_exceeded';                       // 候选超安全上限 → 已退化为全量扫描
      })(),
      candidates: vpf.candidates || 0,
      maxCandidates: pf.maxCandidates,
      minCandidates: Math.max(MIN_PREFILTER_CANDIDATES, limit * 3),
      source: pf.source,
    };

    const fused = reciprocalRankFusion(
      [
        { name: 'fts', items: fts.items, weight: 1 },
        { name: 'vector', items: vec.items, weight: 1 },
      ],
      { limit }
    );

    const results = fused.items.map((it) => toResult(it));
    const incomplete = results.filter((r) => !r.citation.locationKnown).length;

    return {
      query,
      limit,
      scope: { kbIds: scope, baseCount: scope.length },
      retrieval: {
        mode: vectorMode === 'on' ? 'hybrid' : 'text-only',
        vectorMode,
        vectorError,
        // 当前实际使用的检索实现（与 retrievers/index.mjs 同源）—— 让"用的是什么索引"可见
        index: { text: textIndex.kind, vector: vectorIndex.kind },
        ftsMatchMode: fts.matchMode,
        ftsAttempted: fts.attempted || [],
        scannedVectors: vec.scanned || 0,
        // 向量预过滤状态（B2）：applied 才代表"只在文本命中里算了余弦"，
        // 其余一律是全量精确扫描 —— 两种情形的召回语义不同，必须让调用方看得见。
        prefilter,
        candidateCounts: fused.listSizes,
        rrfK: fused.k,
        timings,
      },
      results,
      stats: {
        returned: results.length,
        withoutLocation: incomplete,
        note: incomplete
          ? '有 ' + incomplete + ' 条结果缺少定位信息（无页码/锚点/章节），已在 citation.locationKnown 标为 false —— 它们无法被回溯到原文位置。'
          : null,
      },
      notes,
    };
  }

  /** 把融合结果组装成带引用链的结果对象 */
  function toResult(it) {
    const meta = it.meta || {};
    const rows = meta.rowStart != null || meta.rowEnd != null
      ? { start: meta.rowStart != null ? meta.rowStart : null, end: meta.rowEnd != null ? meta.rowEnd : null }
      : null;
    const location = {
      page: meta.page != null ? meta.page : null,
      pages: Array.isArray(meta.pages) ? meta.pages : [],
      heading: meta.heading || null,
      headingPath: Array.isArray(meta.headingPath) ? meta.headingPath : [],
      anchor: meta.anchor || null,
      rows,
      charStart: meta.charStart != null ? meta.charStart : null,
      charEnd: meta.charEnd != null ? meta.charEnd : null,
    };
    const locationKnown = meta.locationKnown !== undefined
      ? !!meta.locationKnown
      : !!(location.page != null || location.anchor || location.heading || location.rows);
    return {
      chunkId: it.chunkId,
      text: it.body,
      score: Number(it.rrf.toFixed(6)),
      scoreType: 'rrf',
      ranks: {
        fts: it.contributions && it.contributions.fts ? it.contributions.fts.rank : null,
        vector: it.contributions && it.contributions.vector ? it.contributions.vector.rank : null,
      },
      signals: {
        bm25: it.ftsScore != null ? it.ftsScore : null,
        cosine: it.vectorScore != null ? Number(it.vectorScore.toFixed(6)) : null,
      },
      via: it.via || null,
      citation: {
        docId: it.docId,
        documentTitle: it.docTitle || '(无标题)',
        kbId: it.kbId,
        kbName: null,
        chunkOrd: it.ord,
        sourceType: it.sourceType || '',
        sourceRef: it.sourceRef || '',
        location,
        locationKnown,
        label: citationLabel(it.docTitle, meta),
      },
    };
  }

  /* ── 状态 ─────────────────────────────────────────────────────── */

  /**
   * 知识层状态。
   *
   * ⚠️ 两处口径必须在文档里说清（否则就是"看着像总数其实是可见数"的假数据）：
   *   1. 没有 `tenantId` 时**不返回 0**，而是返回 null ——「0 个知识库」与「没统计」
   *      是两件事，把后者显示成前者就是假数据（公开状态接口就是这个场景）。
   *   2. `bases` / `documents` / `chunks` 是**该主体可见口径**（4.6）；
   *      本租户的**总量与受限库数**只在 `tenantBases` 里、且**仅管理员可见** ——
   *      对普通成员给出"总数 10、可见 3"这个差值本身就暴露了"有你看不见的库"。
   */
  function status(tenantId, subject) {
    const sub = normSubject(subject);
    const isAdmin = sub.roles.includes('owner') || sub.roles.includes('admin');
    let all = null;
    let list = null;
    if (tenantId) {
      all = bases.listBases(tenantId);
      list = visibleBases(all, { globalRoles: sub.roles, scopedRoles: scopedRolesOf(sub.userId) }).map((x) => x.base);
    }
    return {
      scope: tenantId ? { tenantId, counted: true } : { tenantId: null, counted: false, note: '未指定组织，未统计任何租户数据' },
      bases: list ? list.length : null,
      documents: list ? list.reduce((n, b) => n + Number(b.document_count || 0), 0) : null,
      chunks: list ? list.reduce((n, b) => n + Number(b.chunk_count || 0), 0) : null,
      // 管理员视角的"本租户全量"：普通成员为 null（不回 0 —— 0 会被读成"就是没有"）
      tenantBases: (isAdmin && all)
        ? { total: all.length, restricted: all.filter((b) => b.visibility === 'restricted').length }
        : null,
      totals: tenantId ? { chunksInDb: chunks.countChunks(), vectorsInDb: chunks.countVectors() } : null,
      embedding: embeddingDescribe(tenantId),
      parsers: parserCapabilities(),
      chunking: chunkOptions,
      workerPool: pool.describe(),
      maxImportBytes: MAX_IMPORT_BYTES,
      // 检索实现 + 预过滤策略（与代码同源，不另抄一份数字）。
      // ⚠️ `retrieverInfo()` 在 B1 就导出了，却**一直没有任何调用点** —— 那等于没做：
      //    "换 ANN 只改装配点"这句话要能被运维看见才成立。这里把它接上。
      retrievers: {
        ...retrieverInfo(),
        prefilter: {
          enabled: prefilterPolicy(undefined).enabled,
          maxCandidates: prefilterPolicy(undefined).maxCandidates,
          note: '向量预过滤：先按文本命中缩候选再算余弦。默认关（会改变最终答案）；'
            + '文本候选不足时自动退化为全量精确扫描。实测对照见 docs/benchmark.md §9。',
        },
      },
      limits: {
        note: '检索为精确暴力扫描（无 ANN 索引）。规模到十万分块量级时性能实测值见 docs/benchmark.md；'
          + '更大规模可开预过滤（prefilterVector），代价与实测见同文档 §9。',
      },
      acl: {
        note: '知识库级访问控制（4.6）：库的 visibility 为 tenant（全租户可见）或 restricted（仅授权可见）。',
        levels: ['read', 'write', 'delete'],
      },
    };
  }

  async function close() { await pool.close(); }

  return {
    pool,
    status,
    capabilities: () => parserCapabilities({ refresh: true }),
    embeddingDescribe,
    embeddingHealth,
    createBase, listBases, getBase, deleteBase, renameBase,
    // 4.6 库级 ACL：可见性开关 + 库级授权管理
    setBaseVisibility, listBaseGrants, grantBase, revokeBaseGrant,
    ingest, listDocuments, getDocument, renameDocument, deleteDocument, previewChunks,
    // P1-2：失败重试与向量重建（含"两种模型混着"的一致性检查）
    retryDocument, reindexBase, embeddingConsistency,
    search,
    close,
  };
}

/** 生成人类可读的引用标签：`文档标题 › 章节 › 第 3 页` */
export function citationLabel(title, meta) {
  const parts = [];
  if (title) parts.push(String(title));
  const path = Array.isArray(meta && meta.headingPath) ? meta.headingPath.filter(Boolean) : [];
  if (path.length) parts.push(path.join(' › '));
  else if (meta && meta.heading) parts.push(String(meta.heading));
  if (meta && meta.page != null) parts.push('第 ' + meta.page + ' 页');
  else if (meta && Array.isArray(meta.pages) && meta.pages.length > 1) parts.push('第 ' + meta.pages[0] + '–' + meta.pages[meta.pages.length - 1] + ' 页');
  if (meta && (meta.rowStart != null || meta.rowEnd != null)) {
    parts.push(meta.rowStart === meta.rowEnd ? '第 ' + meta.rowStart + ' 行' : '第 ' + meta.rowStart + '–' + meta.rowEnd + ' 行');
  }
  return parts.join(' › ') || '(无定位信息)';
}

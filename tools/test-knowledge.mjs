/**
 * 知识检索端到端回归（M2）。
 *
 * 为什么单独一个脚本而不是塞进 test-http.mjs：
 *   M2 的验证面与 M1 几乎不重叠（解析、分块、检索、引用、隔离），
 *   混在一起会让两个脚本都变长、失败时不好定位。分开后各自跑得快，
 *   也能单独针对"知识层"回归。
 *
 * 覆盖：
 *   · 未登录 401；成员可读不可写（403）；越权写被拒并留审计
 *   · 建库 → 导入（md / csv / 纯文本）→ 检索 → 引用链可回溯
 *   · 不受支持 / 缺外部命令的格式 → 422 + 文档状态 failed + **原始错误**
 *   · 解析失败的文档**不进入检索集**
 *   · 跨租户隔离：直插另一个租户的库与分块，佐证 FTS 与向量两条 SQL 路径都带租户过滤
 *   · 指定不属于本组织的知识库 → 403
 *   · 分块预览暴露定位信息；无定位信息的分块被标记
 *
 * 全自包含：临时数据目录 + listen(0) 随机端口 + 测试替身，不依赖本机服务、
 * 不占 3090、不碰真实 data/。
 *
 * 用法：node tools/test-knowledge.mjs   → 末行 `DONE fails=0`
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import '../app/util/quiet-warnings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import * as db from '../app/data/db.mjs';
import { migrate } from '../app/data/migrate.mjs';
import { createKernel } from '../app/kernel/index.mjs';
import { createKernelStub } from './kernel-stub.mjs';
import { createIdentityService } from '../app/platform/identity/service.mjs';
import { createKnowledgeService } from '../app/platform/knowledge/service.mjs';
// 0.21.0 起还必须给出工作区服务：工作区路由在**装配期**就要 deps.workspace，
// 少了它这套回归会一行断言都没跑就抛错退出（末行缺失 → 门禁判"没跑到末尾"）。
// 这是"脚手架必须与 app/main.mjs 同构装配"那条纪律的又一次落地。
import { createWorkspaceService } from '../app/platform/workspace/service.mjs';
import * as auditLog from '../app/platform/governance/audit.mjs';
import { createGovernanceService } from '../app/platform/governance/service.mjs';
import { createOperationService } from '../app/platform/operation/service.mjs';
import { createModelService } from '../app/platform/model/service.mjs';
import { createScheduleService } from '../app/platform/schedule/service.mjs';
import { createNotifyService } from '../app/platform/notify/service.mjs';
import { createServer } from '../app/http/server.mjs';
import { toIndexText } from '../app/util/bigram.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-kbt-'));
process.env.STI_DATA_DIR = tmp;

const ADMIN = { username: 'admin', password: 'Adm1n-Pass!23' };
const MEMBER = { username: 'member1', password: 'Memb3r-Pass!23' };

let total = 0;
let fails = 0;
let skips = 0;
const failures = [];
const skipped = [];

async function t(name, fn) {
  total++;
  try {
    const r = await fn();
    if (r && r.skip) {
      total--; skips++; skipped.push({ name, reason: r.skip });
      console.log('  ~ ' + name);
      console.log('      跳过：' + r.skip);
      return;
    }
    console.log('  \u2713 ' + name);
  } catch (e) {
    fails++;
    failures.push({ name, error: e });
    console.log('  \u2717 ' + name);
    for (const line of String((e && e.message) || e).split('\n').slice(0, 6)) console.log('      ' + line);
  }
}

function section(title) {
  console.log('');
  console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 56 - title.length)));
}

/* ── 装配：临时库 + 三件服务 + 真 HTTP 服务器 ───────────────────── */

const dataDir = tmp;
db.openDb(path.join(dataDir, 'kb-test.db'));
migrate();

const config = {
  values: {
    host: '127.0.0.1', port: 0, kernel: 'stub',
    sessionTtlHours: 12, requireSetup: true,
    workerPoolSize: 2,
    chunkMaxChars: 300, chunkOverlapChars: 60, chunkMinChars: 40, chunkMaxHeadingDepth: 3,
    // 刻意不配向量：验证「无 embedding 时自动降级为纯文本」这条验收标准
    embeddingProvider: '', embeddingBaseUrl: '', embeddingModel: '', embeddingDim: 0,
    embeddingCredentialName: '', embeddingTimeoutMs: 5000,
  },
  sources: {}, configFile: path.join(dataDir, 'config.json'), exists: false,
};

const masterSecret = crypto.randomBytes(32);
const identity = createIdentityService({ masterSecret });
const knowledge = createKnowledgeService({ config, audit: auditLog });
// 与 main.mjs 同构：identity + 审计模块。本套回归不测工作区，但它必须在场（见上面的 import 注释）。
const workspace = createWorkspaceService({ identity, audit: auditLog });
// 显式注入测试替身（0.21.4 起没有"没配地址也能用"的内核，见 tools/kernel-stub.mjs）。
const kernel = createKernel({ provider: createKernelStub(), reason: '回归用测试替身（不依赖真实内核）' });
const governance = createGovernanceService();
const { server, router } = createServer({
  config, kernel, identity, knowledge, workspace, governance,
  operation: createOperationService({ dataDir }),
  model: createModelService({}),
  // P1-2：这两个服务只为满足路由装配（本套回归不测它们）
  notify: createNotifyService({}),
  schedule: createScheduleService({}),
  paths: { DATA_DIR: dataDir }, startedAt: Date.now(),
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

/** 统一的请求助手：返回 {status, body, headers} */
async function call(method, p, { token, json, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  let body;
  if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + p, { method, headers: h, body });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

console.log('');
console.log('STI HARNESS 知识检索端到端回归（M2）');
console.log('='.repeat(64));

/* ── 1. 未登录 ─────────────────────────────────────────────────── */

section('未登录：知识接口一律 401');

await t('未登录访问知识接口全部 401，且文案一致（不给探测者信息）', async () => {
  const probes = [
    ['GET', '/api/knowledge/status'],
    ['GET', '/api/knowledge/bases'],
    ['POST', '/api/knowledge/bases'],
    ['POST', '/api/knowledge/search'],
    ['POST', '/api/knowledge/documents'],
  ];
  const msgs = new Set();
  for (const [m, p] of probes) {
    const r = await call(m, p, { json: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, m + ' ' + p + ' 应回 401');
    assert.equal(r.body.error.code, 'unauthorized');
    msgs.add(r.body.error.message);
  }
  assert.equal(msgs.size, 1, '401 文案必须完全一致');
});

/* ── 2. 初始化 + 登录 ──────────────────────────────────────────── */

section('初始化与登录');

let adminToken = null;
let memberToken = null;
let memberId = null;

await t('初始化向导：建组织 + 管理员', async () => {
  const r = await call('POST', '/api/identity/setup', {
    json: {
      orgName: '某某公司', adminUsername: ADMIN.username, adminPassword: ADMIN.password,
      adminDisplayName: '平台管理员',
    },
  });
  assert.equal(r.status, 201, '初始化应成功：' + JSON.stringify(r.body).slice(0, 200));
  assert.ok(r.body.organization || r.body.org || r.body.setup);
});

await t('管理员登录', async () => {
  const r = await call('POST', '/api/identity/login', { json: ADMIN });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  adminToken = r.body.token;
  assert.ok(adminToken, '应返回令牌');
});

await t('建一个成员账号并登录（用于验证「可读不可写」）', async () => {
  const r = await call('POST', '/api/identity/users', {
    token: adminToken,
    json: { username: MEMBER.username, password: MEMBER.password, displayName: '普通成员', roles: ['member'] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  memberId = r.body.user.id;
  const login = await call('POST', '/api/identity/login', { json: MEMBER });
  assert.equal(login.status, 200);
  memberToken = login.body.token;
});

/* ── 3. 知识库与导入 ───────────────────────────────────────────── */

section('知识库、导入与解析');

let kbId = null;
const docIds = {};

await t('建知识库（管理员）', async () => {
  const r = await call('POST', '/api/knowledge/bases', { token: adminToken, json: { name: '企业制度库' } });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  kbId = r.body.base.id;
  assert.ok(kbId);
});

await t('重复建同名库 → 409（不是默默建两个）', async () => {
  const r = await call('POST', '/api/knowledge/bases', { token: adminToken, json: { name: '企业制度库' } });
  assert.equal(r.status, 409);
});

await t('导入 Markdown：解析出标题层级，分块带章节引用', async () => {
  const md = [
    '# 权限管理规范', '',
    '本规范描述平台的权限模型。权限判定由纯函数实现，未知角色一律拒绝。', '',
    '## 角色定义', '',
    '平台内置四个角色：所有者、管理员、成员、只读访客。管理员可以管理凭据与能力。', '',
    '## 检索规则', '',
    '中文检索依赖 bigram 预处理，把连续汉字切成重叠双字串后再交给 FTS5 索引。', '',
  ].join('\n');
  const r = await call('POST', '/api/knowledge/documents', {
    token: adminToken,
    json: { kbId, filename: '权限管理规范.md', mime: 'text/markdown', contentBase64: Buffer.from(md).toString('base64') },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 400));
  docIds.md = r.body.document.id;
  assert.equal(r.body.document.status, 'ready');
  assert.ok(r.body.report.chunkCount >= 2, '应产出多个分块，实际 ' + r.body.report.chunkCount);
  assert.equal(r.body.report.parser, 'markdown');
});

await t('导入 CSV：行号成为定位信息（可回溯到第几行）', async () => {
  const csv = '姓名,部门,主要职责\n张三,市场部,负责华北区客户关系\n李四,技术部,负责平台权限管理模块\n';
  const r = await call('POST', '/api/knowledge/documents', {
    token: adminToken,
    json: { kbId, filename: '人员职责.csv', contentBase64: Buffer.from(csv).toString('base64') },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  docIds.csv = r.body.document.id;
  assert.equal(r.body.report.parser, 'csv');
  const preview = await call('GET', '/api/knowledge/documents/' + docIds.csv + '/chunks', { token: adminToken });
  assert.equal(preview.status, 200);
  const meta = preview.body.items[0].meta;
  assert.ok(meta.rowStart != null, 'CSV 分块应带行号，实际 meta=' + JSON.stringify(meta));
  assert.equal(preview.body.items[0].locationKnown, true, '有行号就必须算"有定位信息"');
});

await t('导入纯文本（粘贴，无文件）', async () => {
  const r = await call('POST', '/api/knowledge/documents', {
    token: adminToken,
    json: { kbId, text: '数据治理要求：所有地理信息数据必须登记空间参考系与精度说明。', title: '数据治理备忘' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  docIds.text = r.body.document.id;
  assert.equal(r.body.document.sourceType, 'text');
});

await t('内容完全相同的文档重复导入 → 识别为重复，不重复建索引', async () => {
  const csv = '姓名,部门,主要职责\n张三,市场部,负责华北区客户关系\n李四,技术部,负责平台权限管理模块\n';
  const r = await call('POST', '/api/knowledge/documents', {
    token: adminToken,
    json: { kbId, filename: '人员职责.csv', contentBase64: Buffer.from(csv).toString('base64') },
  });
  assert.equal(r.status, 200, '重复应回 200 而不是 201');
  assert.equal(r.body.duplicate, true);
});

await t('不支持的格式 → 422，且文档状态为 failed 并带原始错误', async () => {
  const r = await call('POST', '/api/knowledge/documents', {
    token: adminToken,
    json: { kbId, filename: '压缩包.zip', contentBase64: Buffer.from('PK\x03\x04xx').toString('base64') },
  });
  assert.equal(r.status, 422, JSON.stringify(r.body).slice(0, 300));
  assert.ok(r.body.document, '必须带上文档记录，前端才能展示失败原因');
  assert.equal(r.body.document.status, 'failed', '失败文档必须是 failed，不能混进 ready');
  assert.ok(/不支持/.test(r.body.document.error), '原始错误要能看懂，实际：' + r.body.document.error);
  docIds.failed = r.body.document.id;
});

await t('缺失外部命令的格式（PDF）→ 422 并明确说缺什么（不把二进制当文本）', async () => {
  const r = await call('POST', '/api/knowledge/documents', {
    token: adminToken,
    json: { kbId, filename: '报告.pdf', contentBase64: Buffer.from('%PDF-1.4 fake').toString('base64') },
  });
  if (r.status === 201) {
    // 本机装了 pdftotext：那这条只能算"能用"，但断言它没把二进制当文本
    const d = r.body.document;
    assert.ok(d.chunkCount === 0 || !/PDF-1/.test(JSON.stringify(r.body.report.meta)), '不得把 PDF 头当正文');
    return { skip: '本机装有 pdftotext，无法验证"缺失外部命令"的降级路径' };
  }
  assert.equal(r.status, 422);
  assert.equal(r.body.document.status, 'failed');
  assert.ok(/pdftotext|LibreOffice|扫描件/i.test(r.body.document.error),
    '失败原因必须指出缺哪个工具，实际：' + r.body.document.error);
  docIds.pdfFailed = r.body.document.id;
});

await t('状态统计如实区分 ready / failed', async () => {
  const r = await call('GET', '/api/knowledge/bases/' + kbId + '/documents', { token: adminToken });
  assert.equal(r.status, 200);
  const c = r.body.statusCounts;
  assert.ok(c.ready >= 3, '应有 3 个 ready，实际 ' + JSON.stringify(c));
  assert.ok(c.failed >= 1, '应有 failed，实际 ' + JSON.stringify(c));
});

/* ── 4. 检索与引用 ─────────────────────────────────────────────── */

section('检索、引用与降级');

await t('中文 2 字词与 4 字词都能召回（bigram 的核心价值）', async () => {
  for (const q of ['权限', '管理', '角色', '权限管理', '数据治理']) {
    const r = await call('POST', '/api/knowledge/search', { token: adminToken, json: { query: q, kbIds: [kbId] } });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(r.body.results.length >= 1, '查询「' + q + '」应有命中');
  }
});

await t('换序查询也能召回（短语档失败时降级到 OR 档）', async () => {
  const r = await call('POST', '/api/knowledge/search', { token: adminToken, json: { query: '管理权限', kbIds: [kbId] } });
  assert.equal(r.status, 200);
  assert.ok(r.body.results.length >= 1, '「管理权限」应能召回「权限管理规范」');
});

await t('每条结果都带引用链；label 含文档名与章节', async () => {
  const r = await call('POST', '/api/knowledge/search', { token: adminToken, json: { query: '权限管理', kbIds: [kbId] } });
  assert.ok(r.body.results.length >= 1);
  for (const it of r.body.results) {
    assert.ok(it.citation, '缺引用对象');
    assert.ok(it.citation.docId && it.citation.documentTitle, '引用必须能指回文档');
    assert.equal(typeof it.citation.locationKnown, 'boolean');
    assert.ok(it.citation.label, '必须有可读的引用标签');
    assert.ok(it.score > 0, 'rrf 分应为正');
  }
  const withHeading = r.body.results.find((x) => x.citation.location.headingPath && x.citation.location.headingPath.length);
  assert.ok(withHeading, 'Markdown 的分块应带标题路径');
});

await t('未配置向量时如实报告为纯文本模式（不是假装混合）', async () => {
  const r = await call('POST', '/api/knowledge/search', { token: adminToken, json: { query: '权限', kbIds: [kbId] } });
  assert.equal(r.body.retrieval.mode, 'text-only');
  assert.equal(r.body.retrieval.vectorMode, 'off');
  assert.ok(r.body.notes.some((n) => /纯文本|未配置向量/.test(n)), '应明确提示当前是纯文本检索：' + JSON.stringify(r.body.notes));
});

await t('状态接口如实报告向量模式与解析器可用性', async () => {
  const r = await call('GET', '/api/knowledge/status', { token: adminToken });
  assert.equal(r.status, 200);
  const k = r.body.knowledge;
  assert.equal(k.embedding.mode, 'none');
  assert.deepEqual(k.parsers.native, ['text', 'markdown', 'csv', 'json', 'html']);
  assert.equal(typeof k.parsers.external.pdftotext.available, 'boolean');
  assert.ok(k.workerPool.mode === 'worker' || k.workerPool.mode === 'inline');
  assert.equal(k.scope.counted, true, '带租户时应统计');
  assert.ok(k.bases >= 1);
});

await t('单字查询走 LIKE 兜底，并如实标注「不精确」', async () => {
  const r = await call('POST', '/api/knowledge/search', { token: adminToken, json: { query: '权', kbIds: [kbId] } });
  assert.equal(r.status, 200);
  assert.ok(r.body.results.length >= 1, '单字应能召回');
  assert.equal(r.body.retrieval.ftsMatchMode, 'fts:like');
  assert.ok(r.body.notes.some((n) => /兜底/.test(n)), '必须标注用了不精确的兜底：' + JSON.stringify(r.body.notes));
});

await t('解析失败的文档不进入检索集（搜它独有的内容必须 0 命中）', async () => {
  const r = await call('POST', '/api/knowledge/search', {
    token: adminToken, json: { query: 'PK', kbIds: [kbId] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.filter((x) => x.citation.docId === docIds.failed).length, 0,
    'failed 文档的内容绝不能出现在检索结果里');
});

await t('分块预览：暴露定位元数据，且缺定位信息的分块被标记', async () => {
  const r = await call('GET', '/api/knowledge/documents/' + docIds.md + '/chunks', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.total >= 2);
  for (const c of r.body.items) {
    assert.ok(c.body.length > 0);
    assert.equal(typeof c.meta.locationKnown, 'boolean');
    if (c.meta.locationKnown) assert.ok(c.citationLabel && c.citationLabel !== '(无定位信息)');
  }
});

/* ── 5. 权限 ───────────────────────────────────────────────────── */

section('权限：成员可读不可写');

await t('成员可以检索（knowledge:read）', async () => {
  const r = await call('POST', '/api/knowledge/search', { token: memberToken, json: { query: '权限管理', kbIds: [kbId] } });
  assert.equal(r.status, 200, '成员应有读权限：' + JSON.stringify(r.body).slice(0, 200));
  assert.ok(r.body.results.length >= 1);
});

await t('成员建库 / 导入文档被 403（写权限默认收敛到管理员）', async () => {
  const a = await call('POST', '/api/knowledge/bases', { token: memberToken, json: { name: '成员偷偷建的库' } });
  assert.equal(a.status, 403, '成员不应能建库');
  assert.equal(a.body.error.code, 'forbidden');
  assert.deepEqual(a.body.error.detail.needs, ['knowledge:write']);

  const b = await call('POST', '/api/knowledge/documents', {
    token: memberToken, json: { kbId, text: '成员注入的内容' },
  });
  assert.equal(b.status, 403, '成员不应能往语料里写内容（语料投毒）');
});

await t('成员删库被 403（delete 与 write 是不同动作）', async () => {
  const r = await call('DELETE', '/api/knowledge/bases/' + kbId, { token: memberToken });
  assert.equal(r.status, 403);
  const still = await call('GET', '/api/knowledge/bases', { token: adminToken });
  assert.ok(still.body.bases.some((b) => b.id === kbId), '库必须还在 —— 403 不只是个响应码');
});

await t('越权写操作留下了审计（result=denied）', async () => {
  // ⚠️ 桶要用**组织 id**：rbac 写审计时用的是 ctx.tenantId（= 组织 id），
  //    只有"未登录"那类才会落到 ANONYMOUS_TENANT。这里查错桶 = 断言查不到东西。
  const org = db.get('SELECT id FROM orgs LIMIT 1');
  const rows = auditLog.list(org.id);
  const denied = rows.filter((r) => r.action === 'access.denied' && r.result === 'denied');
  assert.ok(denied.length >= 2, '应有至少两条越权记录，实际 ' + denied.length);
  const detail = JSON.parse(denied[denied.length - 1].detail_json);
  assert.deepEqual(detail.needs, ['knowledge:write']);
  assert.deepEqual(detail.roles, ['member'], '审计要记下当时是什么角色');
  assert.ok(denied.every((r) => r.user_id === memberId), '审计要记下"是谁"');
});

/* ── 6. 租户与库级隔离 ─────────────────────────────────────────── */

section('租户与知识库隔离（FTS 与向量两条路径都要挡住）');

const foreignKbId = 'kb_foreign_0001';
await t('直插另一个租户的库、文档与分块（作为"外部语料"）', () => {
  const org = db.get('SELECT id FROM orgs LIMIT 1');
  const otherOrg = 'org_other_0001';
  db.run('INSERT INTO orgs (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [otherOrg, '别的公司', 'other', new Date().toISOString()]);
  db.run('INSERT INTO knowledge_bases (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)', [foreignKbId, otherOrg, '竞品制度库', new Date().toISOString()]);
  db.run('INSERT INTO documents (id, kb_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ['doc_foreign_0001', foreignKbId, '别人的权限管理规范', 'ready', new Date().toISOString()]);
  const secret = '这是别的公司的机密：权限管理口令策略与内部报价体系。';
  const r = db.run('INSERT INTO chunks (doc_id, kb_id, ord, body, bigrams) VALUES (?, ?, ?, ?, ?)',
    ['doc_foreign_0001', foreignKbId, 0, secret, toIndexText(secret)]);
  // 顺便放一条向量，确保"向量路径"也有外部数据可越界
  const v = new Float32Array(8).fill(0.35355339059327373);
  db.run('INSERT INTO chunk_vectors (chunk_id, dim, vec) VALUES (?, ?, ?)',
    [Number(r.lastInsertRowid), 8, Buffer.from(v.buffer, v.byteOffset, v.byteLength)]);
  assert.ok(org, '应能读到本组织');
});

await t('检索不得越界：本组织搜「权限管理」不得召回别的租户的分块', async () => {
  const r = await call('POST', '/api/knowledge/search', { token: adminToken, json: { query: '权限管理', limit: 50 } });
  assert.equal(r.status, 200);
  const leaked = r.body.results.filter((x) => x.citation.kbId === foreignKbId);
  assert.equal(leaked.length, 0, 'FTS 路径不得越界，泄漏 ' + leaked.length + ' 条');
  // 直接确认那条分块确实存在于库中（否则"没召回"可能只是因为没数据）
  const exists = db.get('SELECT COUNT(*) AS n FROM chunks WHERE kb_id = ?', [foreignKbId]);
  assert.ok(Number(exists.n) > 0, '外部分块必须真实存在，否则这条断言没有意义');
});

await t('向量路径同样不得越界（直调检索层，绕过 HTTP）', async () => {
  const { searchVector } = await import('../app/platform/knowledge/retrievers/vector.mjs');
  const org = db.get('SELECT id FROM orgs WHERE slug = ?', ['other']);
  const mine = db.get('SELECT tenant_id FROM knowledge_bases WHERE id = ?', [kbId]);
  const qv = new Float32Array(8).fill(0.35355339059327373);
  // 用"本组织"的 tenant 去查，但把外部库 id 混进 kbIds —— 必须被 tenant 条件挡住
  const r = searchVector({ tenantId: mine.tenant_id, kbIds: [kbId, foreignKbId], queryVec: qv, limit: 10 });
  const leaked = r.items.filter((x) => x.kbId === foreignKbId);
  assert.equal(leaked.length, 0, '向量路径不得越界');
  // 反向确认：用外部租户去查它自己的库，是能查到的（证明过滤条件不是"全都查不到"）
  const r2 = searchVector({ tenantId: org.id, kbIds: [foreignKbId], queryVec: qv, limit: 10 });
  assert.ok(r2.items.length >= 1, '外部租户查自己的库应能命中（否则上面的断言形同虚设）');
});

await t('指定不属于本组织的知识库 → 403（明确拒绝，不是静默返回空）', async () => {
  const r = await call('POST', '/api/knowledge/search', {
    token: adminToken, json: { query: '权限管理', kbIds: [foreignKbId] },
  });
  assert.equal(r.status, 403, JSON.stringify(r.body).slice(0, 200));
});

await t('库与服务端过滤：不传 kbIds 时只搜本组织（外部库仍不可见）', async () => {
  const r = await call('POST', '/api/knowledge/search', { token: adminToken, json: { query: '报价', limit: 50 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 0, '「报价」只存在于外部语料，本组织必须 0 命中');
});

await t('删文档后内容立即不可检索（不留孤儿分块）', async () => {
  const r = await call('DELETE', '/api/knowledge/documents/' + docIds.text, { token: adminToken });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.ok(r.body.chunksRemoved >= 1);
  const s = await call('POST', '/api/knowledge/search', { token: adminToken, json: { query: '空间参考系', kbIds: [kbId] } });
  assert.equal(s.body.results.length, 0, '已删除文档的内容必须搜不到了');
  // FTS 侧也确认一下没有残留
  const left = db.get('SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH ?', ['"空间"']);
  assert.equal(Number(left.n), 0, 'FTS 索引里不应残留已删分块');
});

/* ── 7. 路由与错误语义 ─────────────────────────────────────────── */

section('路由与错误语义');

await t('M2 路由已从"规划中"转为已交付（501 名单里不再有 knowledge）', async () => {
  const r = await call('GET', '/api/system/routes');
  assert.equal(r.status, 200);
  const planned = r.body.routes.filter((x) => x.milestone === 'M2');
  assert.ok(planned.length >= 10, '应有 10 条 M2 路由，实际 ' + planned.length);
  assert.equal(planned.every((x) => !x.planned), true, 'M2 路由不应再是规划占位');
  assert.ok(r.body.stats.byMilestone.M2 >= 10, JSON.stringify(r.body.stats.byMilestone));
  // M3 起审计查询已交付 → 200；M5 起备份也已交付（回 200，真做备份），
  // "规划中回 501" 的断言随 PLANNED_ROUTES 清空而退役 —— 机制本身在 pipeline 保留。
  const g = await call('GET', '/api/governance/audit', { token: adminToken });
  assert.equal(g.status, 200, 'M3 起审计查询应已交付');
  const { PLANNED_ROUTES } = await import('../app/http/routes/index.mjs');
  assert.equal(PLANNED_ROUTES.length, 0, 'M0~M5 全部交付后规划表应为空');
  const m5 = await call('POST', '/api/operation/backup', { token: adminToken });
  assert.equal(m5.status, 200, 'M5 备份路由应已交付');
  assert.ok(m5.body.manifest && m5.body.manifest.db && m5.body.manifest.db.sha256, '备份响应要带 manifest');
});

await t('参数校验：空查询 400、不存在的库 404、缺 kbId 400', async () => {
  const a = await call('POST', '/api/knowledge/search', { token: adminToken, json: { query: '   ' } });
  assert.equal(a.status, 400);
  const b = await call('POST', '/api/knowledge/documents', { token: adminToken, json: { text: 'x' } });
  assert.equal(b.status, 400);
  const c = await call('GET', '/api/knowledge/bases/kb_不存在/documents', { token: adminToken });
  assert.equal(c.status, 404);
});

await t('删除知识库会连同文档与分块一起清掉（不留孤儿）', async () => {
  const before = db.get('SELECT COUNT(*) AS n FROM chunks WHERE kb_id = ?', [kbId]);
  assert.ok(Number(before.n) > 0);
  const r = await call('DELETE', '/api/knowledge/bases/' + kbId, { token: adminToken });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const after = db.get('SELECT COUNT(*) AS n FROM chunks WHERE kb_id = ?', [kbId]);
  assert.equal(Number(after.n), 0, '库删了分块还在 = 已删内容仍可能被召回');
  // FTS 侧也要清干净。注意限定在**被删的这个库**上：
  // 全局搜「权限」还会命中另一个租户的分块（那是真实存在的正常数据，不是残留）。
  const fts = db.get(
    'SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH ? AND rowid IN (SELECT id FROM chunks WHERE kb_id = ?)',
    ['"权限"', kbId]
  );
  assert.equal(Number(fts.n), 0, 'FTS 索引必须同步清理');
});

/* ── 汇总 ──────────────────────────────────────────────────────── */

try { await knowledge.close(); } catch { /* ignore */ }
try { server.close(); } catch { /* ignore */ }
try { db.closeDb(); } catch { /* ignore */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('');
console.log('='.repeat(64));
if (fails) {
  console.log('失败明细：');
  for (const f of failures) {
    console.log('  · ' + f.name);
    console.log('    ' + String((f.error && f.error.message) || f.error).split('\n')[0]);
  }
  console.log('');
}
if (skipped.length) {
  console.log('跳过的用例（**不计入通过**，请自行判断是否可接受）：');
  for (const s of skipped) { console.log('  ~ ' + s.name); console.log('      ' + s.reason); }
  console.log('');
}
console.log('用例 ' + total + ' 个｜失败 ' + fails + ' 个' + (skips ? '｜跳过 ' + skips + ' 个' : ''));
console.log('DONE fails=' + fails);
process.exitCode = fails ? 1 : 0;

/**
 * 核心回归（零依赖：只用 node:assert + 本文件的极简 harness）。
 *
 * 为什么不用 node:test 的默认 reporter：本项目约定**每个回归脚本末行输出 `DONE fails=N`**，
 * 而 node:test 的 reporter 会缓冲输出、把 hook 的打印挤到最前面，
 * 无法保证"DONE 在最后一行"。因此这里用一个顺序执行的极简 harness，
 * 断言仍全部使用 node:assert/strict（严格相等）。
 *
 * 覆盖 M0 的验收点：
 *   · 迁移可重复执行且幂等；改历史迁移会被拒绝
 *   · 契约方法齐全；测试替身 provider 全链路事件可逐条断言
 *   · 事件语义归一 —— 未知类型不丢弃、缺用量不伪造 0
 *   · 上游事件映射 —— 已核实规则命中，未识别类型标 unknown，覆盖率如实区分
 *   · 中文 bigram 检索可召回 2 字词（并锁住"裸用 unicode61 必然 0 命中"这个反例）
 *   · 事件批量写入去重、用量汇总来自真实事件
 *   · 路由匹配优先级与定义校验、仓储租户隔离
 *
 * 用法：node tools/test-core.mjs
 * 末行输出 `DONE fails=0`。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import '../app/util/quiet-warnings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import * as db from '../app/data/db.mjs';
import { ROOT, DB_BASENAME, DB_FILE, findNonCanonicalDb } from '../app/paths.mjs';
import * as migrate from '../app/data/migrate.mjs';
import { toIndexText, buildQueryLadder, tokenize } from '../app/util/bigram.mjs';
import { createKernelStub } from './kernel-stub.mjs';
import { inspectProvider, normalizeEvent, describeContract, EVENT_TYPES } from '../app/kernel/contract.mjs';
import { mapUpstreamEvent, eventMappingReport, upstreamEventSeq, upstreamEventTime } from '../app/kernel/dsh-provider/events.mjs';
import { extractUpstreamContract, diffContract, readSnapshot } from '../app/kernel/dsh-provider/upstream-contract.mjs';
import { createDshClient } from '../app/kernel/dsh-provider/client.mjs';
import {
  normalizeKernelInput, mergeKernelConfigPatch, diagnoseKernelState, describeKernelRestart,
} from '../app/kernel/connection-config.mjs';
import { probeKernelConnection } from '../app/kernel/index.mjs';
import { createDshProvider } from '../app/kernel/dsh-provider/index.mjs';
import { selectKernel } from '../app/kernel/index.mjs';
import { neutralizeUpstreamText } from '../app/kernel/dsh-provider/brand.mjs';
import { versionGate, KERNEL_VERIFIED_VERSIONS, checkNodeVersion, sessionTtlMs, loadConfig } from '../app/config.mjs';
import { createRouter } from '../app/http/router.mjs';
import { rateLimitPolicy, createMiddlewareRegistry } from '../app/http/middleware/registry.mjs';
import { buildOpenApi } from '../app/http/openapi.mjs';
import * as eventRepo from '../app/data/repositories/events.mjs';
import * as sessionRepo from '../app/data/repositories/sessions.mjs';
import * as attachRepo from '../app/data/repositories/attachments.mjs';

// ── M1（身份与权限）────────────────────────────────────────────────
import { hashPassword, verifyPassword, checkPasswordStrength, decodeHash, kdfInfo } from '../app/platform/identity/passwords.mjs';
import { hashToken, issueSessionToken, issueApiKey, extractToken, sessionCookie, clearSessionCookie, clearAllSessionCookies, isCookieAuth, SESSION_COOKIE, SESSION_PREFIX, APIKEY_PREFIX } from '../app/platform/identity/tokens.mjs';
import { can, explain, matrixFor, fullMatrix, describePermissions, knownRole, RESOURCES, ACTIONS, ROLE_KEYS, ROLE_MATRIX } from '../app/platform/identity/permissions.mjs';
import { encryptSecret, decryptSecret, credentialInfo, cryptoInfo, createSecretKeyring, cipherKid } from '../app/platform/identity/credentials.mjs';
import { scopesOf, isUsable as isApiKeyUsable } from '../app/platform/identity/repos/apiKeys.mjs';
import { isUsable as isAuthSessionUsable } from '../app/platform/identity/repos/authSessions.mjs';
import * as orgRepo from '../app/platform/identity/repos/orgs.mjs';
import * as userRepo from '../app/platform/identity/repos/users.mjs';
import * as roleRepo from '../app/platform/identity/repos/roles.mjs';
import * as groupRepo from '../app/platform/identity/repos/groups.mjs';
import { createIdentityService } from '../app/platform/identity/service.mjs';
import {
  base32Encode, base32Decode, generateSecret, hotp, totpAt, totpStepAt, verifyTotp,
  otpauthUri, generateRecoveryCodes, normalizeRecoveryCode, recoveryCodeHash,
  TOTP_DIGITS, TOTP_PERIOD_SEC, TOTP_WINDOW, RECOVERY_CODE_COUNT,
} from '../app/platform/identity/totp.mjs';
import * as totpRepo from '../app/platform/identity/repos/totp.mjs';
import { createOperationService } from '../app/platform/operation/service.mjs';
import { pruneBackups } from '../app/platform/operation/backup.mjs';
/* ── P1-1：模型中心（注册表 / 默认与降级链 / 探活） ──────────────────── */
import { createModelService } from '../app/platform/model/service.mjs';
import { probeModel, endpointFor, PROTOCOLS_BY_KIND, KINDS } from '../app/platform/model/probe.mjs';
import { createKnowledgeService } from '../app/platform/knowledge/service.mjs';
import { computeHash } from '../app/platform/governance/audit.mjs';
import { periodStart } from '../app/platform/governance/usage.mjs';
/* ── P1-2：调度底座 / 出站通知 / 指标 / 并发闸 / 审计保留 ─────────────── */
import {
  createScheduleService, parseSchedule, computeNextRun, describeSchedule, DEFAULT_JOBS,
} from '../app/platform/schedule/service.mjs';
import { TASK_KINDS, TASK_DEFAULTS, runTask, isKnownKind } from '../app/platform/schedule/tasks.mjs';
import {
  createNotifyService, assertSafeTarget, NOTIFY_EVENTS, NOTIFY_EVENT_PRODUCERS, SINK_KINDS,
  robotSinkOf, adaptBodyForSink, robotReceiptError,
} from '../app/platform/notify/service.mjs';
import {
  emitQuotaBlocked,
  QUOTA_BLOCKED_COOLDOWN_MS,
} from '../app/platform/notify/producers.mjs';
import { runCheck } from '../app/diagnostics.mjs';
import * as metrics from '../app/platform/observe/metrics.mjs';
import * as concurrency from '../app/platform/governance/concurrency.mjs';
import * as auditLog from '../app/platform/governance/audit.mjs';
import { createGovernanceService } from '../app/platform/governance/service.mjs';
import * as usageRepo from '../app/platform/governance/usage.mjs';
/* ── P1-3：成本核算（token → 金额）───────────────────────────────────── */
import { computeCost, buildCostReport, formatAmount, TOKEN_CLASSES } from '../app/platform/governance/cost.mjs';
import { extractPaths } from '../app/platform/governance/artifacts.mjs';
import { zipSync, readZipEntries, crc32, extractZip } from '../app/util/zip.mjs';
// ⚠️ 0.21.10：这里原来是 `decideToolVisibility`。工具不再是可登记的能力，
//    判定拆成了两套各自的实现（MCP / Skill），别再把它们合成一个名字测 —— 合了就等于
//    又把"血缘形状不同的两件事"绑在一起，下次谁改 MCP 都会顺手改到 Skill。
import { decideMcpVisibility, decideSkillVisibility, bindingsForSubject } from '../app/platform/capability/visibility.mjs';
import {
  sniffImageMediaType, toImagePart, describeImages, isImageMediaType, humanBytes,
  IMAGE_MEDIA_TYPES,
} from '../app/platform/attachment/content.mjs';
import { csrfVerdict } from '../app/http/middleware/auth.mjs';
import { securityHeaders, isHttps } from '../app/http/security-headers.mjs';
/* ── M2：知识层纯函数（解析 / 分块 / 融合 / 向量降级） ────────────────── */
import { parseText, looksLikeMarkdown } from '../app/platform/knowledge/parsers/text.mjs';
import { parseCsv, parseRows, detectDelimiter } from '../app/platform/knowledge/parsers/csv.mjs';
// 账号批量导入专用的 CSV 解析器。与上面 knowledge 的 parseCsv 是**两件事**：
// 那个面向检索语料（会规整空白、无行号），这个面向导入口令（原样保空白、带物理行号）。
import { parseCsvRecords } from '../app/util/csv.mjs';
import { parseJson } from '../app/platform/knowledge/parsers/json.mjs';
import { parseHtml } from '../app/platform/knowledge/parsers/html.mjs';
import { parseDocument, detectFormat, parserCapabilities, extOf } from '../app/platform/knowledge/parsers/index.mjs';
import { BOM, stripBom, joinWrapped, decodeEntities, splitSentences, estimateTokens } from '../app/platform/knowledge/parsers/util.mjs';
import { chunkBlocks, chunkText, DEFAULT_OPTIONS } from '../app/platform/knowledge/chunker.mjs';
import { reciprocalRankFusion, normalizeRrfScores, DEFAULT_RRF_K } from '../app/platform/knowledge/retrievers/fusion.mjs';
// B2 预过滤：检索器层的三态语义（null=全量 / 数组=候选 / 空数组=如实为空）在这里被穷举钉住
import { searchFts, searchFtsIds } from '../app/platform/knowledge/retrievers/fts.mjs';
import { searchVector } from '../app/platform/knowledge/retrievers/vector.mjs';
import { normalizeMode, createEmbeddingProvider, EMBED_MODES } from '../app/platform/knowledge/embedding.mjs';
import { decideBaseAccess, canAccessBase, visibleBases, normalizeVisibility } from '../app/platform/knowledge/visibility.mjs';
import { levelFromRoles, levelAtLeast } from '../app/platform/workspace/visibility.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-test-'));
const dbFile = path.join(tmp, 'test.db');

let total = 0;
let fails = 0;
let skips = 0;
const failures = [];
const skipped = [];

/**
 * 顺序执行一个用例；失败不中断后续（一次跑完能看到全部问题）。
 *
 * 用例可以返回 `{ skip: '原因' }` 表示**本条无法执行**（例如本机没装上游、没有 fixtures）。
 * 跳过会单独计数、单独打印，**绝不计入通过**——把"没跑"显示成"绿了"是最危险的假信号。
 * 末行仍然是严格的 `DONE fails=N`（约定不变），跳过数放在上一行。
 */
async function t(name, fn) {
  total++;
  try {
    const r = await fn();
    if (r && r.skip) {
      total--;
      skips++;
      skipped.push({ name, reason: r.skip });
      console.log('  ~ ' + name);
      console.log('      跳过：' + r.skip);
      return;
    }
    console.log('  \u2713 ' + name);
  } catch (e) {
    fails++;
    failures.push({ name, error: e });
    console.log('  \u2717 ' + name);
    const msg = (e && e.message) ? String(e.message) : String(e);
    for (const line of msg.split('\n').slice(0, 6)) console.log('      ' + line);
  }
}

function section(title) {
  console.log('');
  console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 56 - title.length)));
}

console.log('');
console.log('STI HARNESS 核心回归');
console.log('='.repeat(64));

/* ── 中文分词 ───────────────────────────────────────────── */
section('中文分词（bigram）');

await t('中文切成重叠双字串，中英混排分别处理', () => {
  assert.deepEqual(tokenize('权限'), ['权限']);
  assert.deepEqual(tokenize('权限管理'), ['权限', '限管', '管理']);
  const idx = toIndexText('企业级 Agent 平台');
  assert.ok(idx.includes('企业') && idx.includes('业级'), '应含中文双字串');
  assert.ok(idx.includes('agent'), '英文应小写保留');
});

await t('查询阶梯：保序短语 → 段内 OR → 全局 OR（三档，都不是 AND）', () => {
  const ladder = buildQueryLadder('权限管理');
  // 单段查询的 or 与 any 本来就是同一个串，去重后只剩两档
  assert.equal(ladder.length, 2);
  assert.equal(ladder[0].mode, 'phrase');
  assert.equal(ladder[0].match, '"权限 限管 管理"');
  assert.equal(ladder[1].mode, 'or');
  // 曾经写成 AND，被实测证伪：查询「管理权限」切出 管理/理权/权限，
  // 而原文「权限管理」里没有「理权」→ AND 直接 0 命中，把"容忍换序"变成"挡住换序"。
  assert.equal(ladder[1].match, '("权限" OR "限管" OR "管理")');

  // 中英混排时，段与段之间仍用 AND（"既要中文词也要英文词"是合理约束）……
  assert.equal(buildQueryLadder('权限 agent')[1].match, '("权限") AND "agent"');
  // ……但压轴还有一档「全局 OR」，把段间 AND 整个放开（真机：整句提问里夹一个文档没提的从句，
  // 前两档会全军覆没，连"备份"这种板上钉钉的命中都召不回来）
  const multi = buildQueryLadder('权限 agent');
  assert.equal(multi.length, 3, '多段查询应多出「全局 OR」一档');
  assert.equal(multi[2].mode, 'any');
  assert.equal(multi[2].match, '("权限" OR "agent")');
});

/* ── 数据库 ─────────────────────────────────────────────── */
section('数据层');

await t('打开数据库并应用全部迁移', () => {
  db.openDb(dbFile);
  const r = migrate.migrate();
  assert.ok(r.applied.length >= 1, '首次应应用至少一个迁移');
  assert.ok(db.dbInfo().tables > 20, '表数量应反映完整 schema');
});

await t('迁移可重复执行且幂等', () => {
  const second = migrate.migrate();
  assert.equal(second.applied.length, 0, '第二次不应再应用任何迁移');
  assert.ok(migrate.migrationStatus().upToDate);
});

await t('SQLite FTS5 + bigram 可召回中文 2 字词（中文检索的关键）', () => {
  db.run("INSERT INTO orgs(id,name,slug,created_at) VALUES('o1','测试','t','2026-01-01')");
  db.run("INSERT INTO knowledge_bases(id,tenant_id,name,created_at) VALUES('kb1','o1','库','2026-01-01')");
  db.run("INSERT INTO documents(id,kb_id,title,status,created_at) VALUES('d1','kb1','手册','ready','2026-01-01')");
  const body = '企业级智能体生产平台的权限管理说明';
  db.run('INSERT INTO chunks(doc_id,kb_id,ord,body,bigrams) VALUES(?,?,?,?,?)', ['d1', 'kb1', 0, body, toIndexText(body)]);

  const hits = (term, mode) => db.all(
    'SELECT c.id FROM chunk_fts f JOIN chunks c ON c.id = f.rowid WHERE f.bigrams MATCH ?',
    [buildQueryLadder(term).find((x) => x.mode === mode).match]
  ).length;

  assert.equal(hits('权限管理', 'phrase'), 1, '4 字词应命中');
  assert.equal(hits('权限', 'phrase'), 1, '2 字词「权限」应命中');
  assert.equal(hits('管理', 'phrase'), 1, '2 字词「管理」应命中');
  assert.equal(hits('平台', 'phrase'), 1, '2 字词「平台」应命中');
  assert.equal(hits('智能体', 'phrase'), 1, '3 字词应命中');
  assert.equal(hits('宇宙飞船', 'phrase'), 0, '无关词不应命中');
  // 换序召回：短语档必然 0 命中（原文没有「理权」），宽松档必须能救回来
  assert.equal(hits('管理权限', 'phrase'), 0, '换序在短语档应不命中（这正是需要降级档的原因）');
  assert.ok(hits('管理权限', 'or') >= 1, '宽松档必须能召回换序查询 —— 这是 M2 中文召回的核心回归');

  // ★ 真机 0.15.0 抓到的漏召：用户不会只输关键词，会输**整句**。
  //   标点把查询切成多段、段间 AND 要求每段都命中，于是文档没提的那个从句
  //   （「只回答一句话」）把整条查询判死 —— 连「权限管理」这种板上钉钉的命中都丢了。
  const sentence = '请问这个平台的权限管理是怎么做的？只回答一句话';
  assert.equal(hits(sentence, 'phrase'), 0, '整句在短语档不命中（正常）');
  assert.equal(hits(sentence, 'or'), 0, '段内 OR 档也不命中 —— 因为「只回答一句话」这一段在文档里一个双字串都没有');
  assert.ok(hits(sentence, 'any') >= 1, '全局 OR 档必须把「权限管理」这段救回来 —— 这是整句提问能用的前提');
});

await t('反例锁定：裸用 unicode61 时子串检索必然 0 命中', () => {
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS raw_probe USING fts5(body)');
  db.run('INSERT INTO raw_probe(body) VALUES(?)', ['企业级智能体生产平台的权限管理说明']);
  const n = db.all('SELECT rowid FROM raw_probe WHERE raw_probe MATCH ?', ['权限管理']).length;
  assert.equal(n, 0, 'unicode61 把整段汉字当一个 token，子串必然 0 命中。'
    + '若此断言失败，说明 SQLite 行为变了，需重新评估中文检索方案（docs/feasibility.md §1.2.1）');
  db.exec('DROP TABLE IF EXISTS raw_probe');
});

await t('迁移纪律：改动已应用的迁移文件会被拒绝执行', () => {
  // 用不冲突的版本号（版本号是迁移的身份，与真实 0001 相同会被判为"同一条被改了"）
  const fakeDir = path.join(tmp, 'mig-tamper');
  fs.mkdirSync(fakeDir, { recursive: true });
  const f = path.join(fakeDir, '0099_probe.sql');
  fs.writeFileSync(f, 'CREATE TABLE IF NOT EXISTS tamper_probe (id INTEGER PRIMARY KEY);');
  const r = migrate.migrate({ dir: fakeDir });
  assert.deepEqual(r.applied, ['0099']);

  fs.writeFileSync(f, 'CREATE TABLE IF NOT EXISTS tamper_probe (id INTEGER PRIMARY KEY, extra TEXT);');
  const plan = migrate.planMigrations(fakeDir);
  assert.equal(plan.problems.length, 1);
  assert.equal(plan.problems[0].kind, 'modified');
  assert.throws(() => migrate.migrate({ dir: fakeDir }), /迁移被拒绝执行/);
});

await t('事件批量写入：同 seq 去重，写入后有真实读数', () => {
  const row = sessionRepo.createSessionRow({
    tenantId: 'o1', kernelSessionId: 'ks_x', title: '写入测试',
  });
  const mk = (seq) => normalizeEvent({ type: 'message', text: 't' + seq, seq });
  const r1 = eventRepo.appendEvents(row.id, [mk(1), mk(2), mk(3)]);
  assert.equal(r1.inserted, 3);
  assert.equal(r1.lastSeq, 3);

  const r2 = eventRepo.appendEvents(row.id, [mk(3), mk(4)]);
  assert.equal(r2.inserted, 1, 'seq=3 应被去重，只写入 seq=4');
  assert.equal(eventRepo.countEvents(row.id), 4);
  assert.deepEqual(eventRepo.listEvents(row.id, {}).map((e) => e.seq), [1, 2, 3, 4]);
});

await t('用量汇总来自 usage 事件，不做估算', () => {
  const row = sessionRepo.createSessionRow({
    tenantId: 'o1', kernelSessionId: 'ks_y', title: '用量测试',
  });
  eventRepo.appendEvents(row.id, [
    normalizeEvent({ type: 'usage', seq: 1, usage: { input: 10, output: 4 } }),
    normalizeEvent({ type: 'usage', seq: 2, usage: { input: 20, output: 6, reasoning: 2 } }),
  ]);
  const u = eventRepo.usageSummary(row.id);
  assert.equal(u.input, 30);
  assert.equal(u.output, 10);
  assert.equal(u.reasoning, 2);
  assert.equal(u.usageEvents, 2);
});

await t('★ 用量汇总：用量挂在助手消息上时也必须汇总（与记账同一条规则）', () => {
  // 这一条钉住的是"同一个数字被两处各算一遍"这件事：`usageSummary`（工作台读它）
  // 与 `recordFromEvents`（写 usage_records）**必须走同一条取数规则**
  // （app/util/usage-pick.mjs）。原先两边各自 `type === 'usage'`，真内核上双双归零。
  const row = sessionRepo.createSessionRow({
    tenantId: 'o1', kernel: 'external', kernelSessionId: 'ks_usage_msg', title: '真实形状用量',
  });
  eventRepo.appendEvents(row.id, [
    normalizeEvent({ type: 'turn-start' }, { seq: 1, turnId: 'T1' }),
    normalizeEvent({ type: 'message', role: 'assistant', text: '2', usage: { input: 562, cacheRead: 6656, cacheWrite: 0, output: 2, reasoning: 0 } },
      { seq: 2, turnId: 'T1' }),
    normalizeEvent({ type: 'turn-end' }, { seq: 3, turnId: 'T1' }),
  ]);
  const u = eventRepo.usageSummary(row.id);
  assert.equal(u.input, 562, '挂在助手消息上的用量必须被汇总到');
  assert.equal(u.cacheRead, 6656);
  assert.equal(u.output, 2);
  assert.equal(u.usageEvents, 1, '这是**一笔**用量，不是 0 笔也不是 2 笔');

  // 同一轮里独立 usage 事件优先：两个都算就是把一笔账记两遍
  const row2 = sessionRepo.createSessionRow({
    tenantId: 'o1', kernelSessionId: 'ks_usage_both', title: '重复计数',
  });
  eventRepo.appendEvents(row2.id, [
    normalizeEvent({ type: 'message', role: 'assistant', usage: { input: 100, output: 10 } }, { seq: 1, turnId: 'T2' }),
    normalizeEvent({ type: 'usage', usage: { input: 100, output: 10 } }, { seq: 2, turnId: 'T2' }),
  ]);
  assert.equal(eventRepo.usageSummary(row2.id).input, 100, '独立 usage 事件存在时不许重复计数');
  assert.equal(eventRepo.usageSummary(row2.id).usageEvents, 1);
});

await t('仓储强制租户过滤：跨租户取不到数据', () => {
  const row = sessionRepo.createSessionRow({
    tenantId: 'tenant-A', kernelSessionId: 'ks_z', title: '隔离测试',
  });
  assert.ok(sessionRepo.getSession('tenant-A', row.id), '本租户应能取到');
  assert.equal(sessionRepo.getSession('tenant-B', row.id), undefined, '跨租户必须取不到');
});

/* ── 契约 ───────────────────────────────────────────────── */
section('契约与 provider');

await t('测试替身 provider 方法齐全且无越界扩展', () => {
  const r = inspectProvider(createKernelStub());
  assert.equal(r.ok, true, '缺少方法：' + r.missing.join(','));
  assert.deepEqual(r.extra, [], '出现了契约外的扩展方法（应登记进 PROVIDER_EXTENSIONS）');
  assert.equal(describeContract().version, '1.1.0');
  assert.ok(EVENT_TYPES.length >= 9);
  assert.ok(EVENT_TYPES.includes('lifecycle'), '骨架事件类型必须在契约里（否则轨迹页会把它们显示成未知）');
});

await t('测试替身 全链路：创建 → 提交 → 流式，事件序列可逐条断言', async () => {
  const p = createKernelStub();
  const { sessionId } = await p.createSession({ title: 'T' });
  await p.submitTurn({ sessionId, content: '你好' });
  const got = [];
  for await (const ev of p.streamTurns({ sessionId, fromSeq: 0 })) got.push(ev);

  assert.deepEqual(got.map((e) => e.type), [
    'turn-start', 'reasoning', 'message', 'tool-call', 'tool-result', 'message', 'usage', 'turn-end',
  ]);
  assert.deepEqual(got.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8], 'seq 必须连续');
  assert.ok(got.every((e) => e.known), '所有事件类型都应被识别');
  const usage = got.find((e) => e.type === 'usage');
  assert.deepEqual(usage.usage, { input: 128, cacheRead: 0, cacheWrite: 0, output: 64, reasoning: 16 });
});

await t('测试替身 增量流：从 fromSeq 续读不会重放已读事件', async () => {
  const p = createKernelStub();
  const { sessionId } = await p.createSession({});
  await p.submitTurn({ sessionId, content: 'a' });
  await p.submitTurn({ sessionId, content: 'b' });
  const got = [];
  for await (const ev of p.streamTurns({ sessionId, fromSeq: 8 })) got.push(ev);
  assert.deepEqual(got.map((e) => e.seq), [9, 10, 11, 12, 13, 14, 15, 16], '应只续读第二轮');
});

/* ── 事件归一 ───────────────────────────────────────────── */
section('事件归一与上游映射');

await t('未知事件类型不丢弃，标 known:false', () => {
  const ev = normalizeEvent({ type: 'brand/new-event', text: 'x' });
  assert.equal(ev.type, 'brand/new-event');
  assert.equal(ev.known, false);
  assert.equal(ev.text, 'x');
});

await t('usage 只保留语义字段；没有用量信息时为 null（不伪造 0）', () => {
  const ev = normalizeEvent({ type: 'usage', usage: { input: 10, output: 5 } });
  assert.deepEqual(ev.usage, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 });
  assert.equal(normalizeEvent({ type: 'usage' }).usage, null);
});

await t('上游映射：已核实规则命中，识别不到的标 unknown', () => {
  const a = mapUpstreamEvent({ type: 'assistant/chunk', delta: '你' });
  assert.equal(a.type, 'message');
  assert.equal(a.delta, '你');
  assert.equal(a._verified, true);

  const b = mapUpstreamEvent({ type: 'assistant/message', data: { usage: { cacheReadTokens: 5, inputTokens: 10 } } });
  assert.equal(b.type, 'message');
  assert.equal(b.usage.input, 10);
  assert.equal(b.usage.cacheRead, 5);

  assert.equal(mapUpstreamEvent({ type: 'compaction/start' })._ruleId, 'compaction');

  const d = mapUpstreamEvent({ type: 'totally/unknown' });
  assert.equal(d.type, 'unknown');
  assert.equal(d.known, false);
  assert.equal(d._upstreamType, 'totally/unknown');
});

await t('映射覆盖率如实区分已核实与未核实（不允许全绿掩盖）', () => {
  const rep = eventMappingReport();
  assert.ok(rep.ruleCount >= 8);
  assert.ok(rep.verified.length >= 3);
  assert.ok(rep.unverified.length >= 1, '未核实项必须被报出来');
  assert.ok(rep.unverified.every((u) => typeof u.id === 'string' && typeof u.note === 'string'));
});

/* ── 上游契约（没有 fixtures 时的替代防线） ─────────────────── */
section('上游契约快照');

await t('快照文件可解析，且含关键事件与字段', () => {
  const snap = readSnapshot();
  assert.ok(snap, '快照缺失 —— 跑 `node tools/snapshot-upstream-contract.mjs --update` 生成基线');
  assert.ok(snap.sessionEventTypes['turn/start'], '快照应含 turn/start');
  assert.ok(snap.sessionEventTypes['tool/result'], '快照应含 tool/result');
  assert.ok(snap.sessionEventTypes['assistant/message'], '快照应含 assistant/message');
  assert.ok(snap.tokenUsageFields.includes('inputTokens'), 'TokenUsage 应含 inputTokens');
  assert.ok(snap.turnTokenUsageFields.includes('uncachedInputTokens'), 'TurnTokenUsage 应含 uncachedInputTokens');
});

await t('快照与当前安装的上游包一致（本机未装上游时跳过）', () => {
  const client = createDshClient({ origin: 'http://127.0.0.1:1/' });
  const hit = client.discover().find((f) => f.packageDir);
  if (!hit) return { skip: '本机未安装 @deepseek-ai/dsh，无法重新提取比对' };
  const cur = extractUpstreamContract(hit.packageDir);
  if (!cur.available) return { skip: '找到上游包但提取失败：' + cur.reason };
  const d = diffContract(readSnapshot(), cur);
  assert.ok(d.ok, '上游契约与快照不一致（' + d.changes.length + ' 处），逐条确认影响面后再更新基线：\n'
    + d.changes.map((c) => '  [' + c.kind + '] ' + c.item + '：' + c.before + ' → ' + c.after).join('\n'));
});

await t('events.mjs 覆盖上游全部日志事件类型（覆盖率下降＝上游加了新事件）', () => {
  const rep = eventMappingReport();
  assert.ok(rep.journalCoverage, '未算出覆盖率：' + (rep.journalCoverageNote || '未知原因'));
  assert.ok(rep.journalCoverage.total >= 14, '上游日志事件类型数应 >= 14，实际 ' + rep.journalCoverage.total);
  assert.deepEqual(rep.journalCoverage.uncovered, [],
    '以下上游事件类型没有任何规则识别，会整体落成 unknown：'
    + (rep.journalCoverage.uncovered || []).join(', '));
});

await t('回归锁定：tool/result 的真实字段是 message（曾因只找 result 而静默变空）', () => {
  const ev = mapUpstreamEvent({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }], isError: false } } });
  assert.equal(ev.type, 'tool-result');
  assert.ok(ev.tool.result, '工具结果不应为空 —— 为空说明字段名又与上游对不上了');
  assert.equal(ev.tool.status, 'ok');
  assert.equal(ev.text, 'ok', '内容块数组应被展开成文本（不是 [object Object]，也不是空）');

  // 失败标记有两种来源，任一存在即判失败并留痕
  const byIsError = mapUpstreamEvent({ type: 'tool/result', data: { message: { isError: true } } });
  assert.equal(byIsError.tool.status, 'error');
  assert.ok(byIsError.warnings.includes('tool_result_is_error'));

  const byErrorField = mapUpstreamEvent({ type: 'tool/result', data: { error: { name: 'E', code: 'X' } } });
  assert.equal(byErrorField.tool.status, 'error');
  assert.ok(byErrorField.warnings.includes('tool_result_is_error'));
});

await t('回归锁定：tool/result 不带工具名，配对只能靠 callId（曾因此每轮多出一张 (未命名工具)）', () => {
  // ⚠️ 这条钉的是一个**真出过的 bug**（0.21.10 用户报"轨迹里显示完成(未命名工具)"）：
  //    上游 `tool/result` 事件里**没有名字**，只有 `message.toolCallId`。
  //    契约层此前用 toolName(raw) 去取，一路取空 → name: ''；
  //    而前端靠**名字相等**把 result 并回 call 那张卡 —— 空名对不上任何卡，
  //    于是每调一次工具就凭空多出一张空名孤儿卡，并且 call 那张永远停在"执行中"。
  //    ⚠️ 所以这里钉的是**两条**：① result 侧如实留空名；② 两侧都带出同一个 callId。
  //    只钉①会让"孤儿卡"这个症状重现而测试不红；只钉②则测不到"名字本来就没有"这个前提。

  // call 侧：`data.callId` + `data.name`
  const call = mapUpstreamEvent({ type: 'tool/call', data: { callId: 'cid-1', name: 'fs.read', arguments: '{"p":1}' } });
  assert.equal(call.type, 'tool-call');
  assert.equal(call.tool.name, 'fs.read');
  assert.equal(call.tool.callId, 'cid-1', 'call 侧必须带出 callId（配对凭据）');

  // result 侧：只有 `message.toolCallId`，**没有** name
  const res = mapUpstreamEvent({ type: 'tool/result', data: { message: { toolCallId: 'cid-1', content: [{ type: 'text', text: 'ok' }], isError: false } } });
  assert.equal(res.type, 'tool-result');
  assert.equal(res.tool.name, '', 'result 侧本来就没有名字 —— 如实留空，不许拿别的东西顶上');
  assert.equal(res.tool.callId, 'cid-1', 'result 侧必须带出 toolCallId，且与 call 侧同值');
  assert.equal(res.tool.callId, call.tool.callId, '两侧必须是同一个值，否则配不上对');

  // 取不到配对凭据时是 null（"上游没给"），**不是**空串（"给了个空 id"）——
  // 前端据此决定"退回按名字配对"而不是"按空串去配一堆匿名卡"
  const noId = mapUpstreamEvent({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'x' }] } } });
  assert.equal(noId.tool.callId, null, '没有 toolCallId 时应是 null');

  // 契约层的形状归一化必须**保留** callId —— 落库/回放都走这里，丢了就等于没取
  const norm = normalizeEvent(call, { seq: 1 });
  assert.equal(norm.tool.callId, 'cid-1', 'normalizeEvent 不许把 callId 过滤掉（否则前端拿不到）');
  const normNull = normalizeEvent(noId, { seq: 2 });
  assert.equal(normNull.tool.callId, null, '缺失的 callId 归一化后仍是 null，不许变成字符串 "null"');
});

await t('回归锁定：内容块数组必须展开（否则文本会静默全丢）', () => {
  const ev = mapUpstreamEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一段' }, { type: 'tool_use' }, { type: 'text', text: '第二段' }] } } });
  assert.equal(ev.text, '第一段\n第二段', '应只拼文本块，并跳过非文本块');
  // 全非文本块 → null（不编造空串冒充内容）
  const none = mapUpstreamEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'image' }] } } });
  assert.equal(none.text, null);
});

await t('回归锁定：思考块（reasoning）与正文块必须分开 —— 0.15.1 真机审计抓出', () => {
  // 上游 content 块带 type（实证见 app/kernel/fixtures/dsh-0.2.0-rc.2-session.json）。
  // 此前全部拼进 text，工作台就把模型的思考过程当成答案正文亮给用户。
  const ev = mapUpstreamEvent({ type: 'assistant/message', data: { message: { content: [
    { type: 'reasoning', text: '先想一下：用户要一句备份说明' },
    { type: 'text', text: '在备份页一键创建 ZIP 备份。' },
  ] } } });
  assert.equal(ev.text, '在备份页一键创建 ZIP 备份。', '正文只装 text 块');
  assert.equal(ev.reasoning, '先想一下：用户要一句备份说明', '思考块要单独给 reasoning 字段');

  // 只有思考块：text 必须是 null —— 不把思考冒充成正文（宁缺勿假，与诚实数据源同一条纪律）
  const only = mapUpstreamEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '只有思考' }] } } });
  assert.equal(only.text, null);
  assert.equal(only.reasoning, '只有思考');

  // 没有 type 的块按正文处理（老版本上游 / 纯标量 text 的兼容路径不回退）
  const plain = mapUpstreamEvent({ type: 'assistant/message', data: { message: { content: [{ text: '裸文本块' }] } } });
  assert.equal(plain.text, '裸文本块');
  assert.equal(plain.reasoning, null);

  // 没有块数组时退回老路径（标量 text 照旧）
  const scalar = mapUpstreamEvent({ type: 'assistant/message', data: { text: '标量正文' } });
  assert.equal(scalar.text, '标量正文');
});

await t('回归锁定：turn/end 的 reason 是对象，必须取 .kind', () => {
  const ev = mapUpstreamEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(ev.kind, 'reason:completed', 'reason 是对象 —— 直接取文本会得到 null，导致结束原因静默丢失');
  assert.equal(mapUpstreamEvent({ type: 'turn/end', data: { reason: 'cancelled' } }).kind, 'reason:cancelled',
    '字符串形式也应兼容');
});

await t('信封：上游 seq 与毫秒 time 能被正确提取', () => {
  const raw = { type: 'turn/start', seq: 7, time: 1790733513669, data: { turn: 1 } };
  const ev = mapUpstreamEvent(raw);
  assert.equal(ev._upstreamSeq, 7);
  assert.equal(ev._upstreamTime, new Date(1790733513669).toISOString());
  // 缺失时不编造
  assert.equal(upstreamEventTime({ type: 'x' }), null);
  assert.equal(upstreamEventSeq({ type: 'x' }), null);
  // 秒级时间戳也能吃下
  assert.equal(upstreamEventTime({ time: 1790733513 }), new Date(1790733513000).toISOString());
});

await t('回归锁定：usage 未缓存输入语义 + total 交叉校验', () => {
  // 上游 TokenUsage：inputTokens 是**未缓存输入**；计费输入 = input + cacheRead + cacheWrite
  const ok = mapUpstreamEvent({
    type: 'assistant/message',
    usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 3, totalTokens: 18 },
  });
  assert.equal(ok.usage.input, 10);
  assert.equal(ok.usage.cacheRead, 5);
  assert.deepEqual(ok.warnings, [], '18 = 10+5+3，分项与 total 一致时不应有任何警告');

  // 对不上时必须留痕，而不是默默采用某个数
  const bad = mapUpstreamEvent({
    type: 'assistant/message',
    usage: { inputTokens: 10, outputTokens: 3, totalTokens: 999 },
  });
  assert.ok(bad.warnings.some((w) => w.startsWith('usage_total_mismatch')),
    'total 与分项不符必须留痕，实际 warnings=' + JSON.stringify(bad.warnings));
});

await t('TurnTokenUsage 的 uncachedInputTokens 别名也能识别', () => {
  const ev = mapUpstreamEvent({ type: 'usage', usage: { uncachedInputTokens: 7, outputTokens: 2, totalTokens: 9 } });
  assert.equal(ev.usage.input, 7);
});

await t('不把对象 String() 成 "[object Object]" 这种假内容', () => {
  const ev = mapUpstreamEvent({ type: 'assistant/message', text: { blocks: [] } });
  assert.equal(ev.text, null, '对象形状的文本应返回 null（不猜），绝不能产出 "[object Object]"');
});

await t('骨架事件显式识别为 lifecycle，而不是混进 unknown', () => {
  for (const [type, kind] of [['step/start', 'step-start'], ['step/end', 'step-end'],
    ['request/header', 'request-header'], ['request/context', 'request-context'],
    ['session/end-seed', 'session-end-seed'], ['assistant/attempt', 'assistant-attempt']]) {
    const ev = mapUpstreamEvent({ type });
    assert.equal(ev.type, 'lifecycle', type + ' 应映射为 lifecycle');
    assert.equal(ev.kind, kind, type + ' 的 kind 应为 ' + kind);
  }
  // 真正的未知仍然必须是 unknown（骨架识别不能把未知也吞掉）
  assert.equal(mapUpstreamEvent({ type: 'wat/is/this' }).type, 'unknown');
});

await t('turn/end 的 reason 落进 kind，可区分正常/取消/失败', () => {
  const ev = mapUpstreamEvent({ type: 'turn/end', turn: 1, reason: 'cancelled' });
  assert.equal(ev.type, 'turn-end');
  assert.equal(ev.kind, 'reason:cancelled');
});

/* ── fixtures（真实上游事件流） ────────────────────────────── */
section('fixtures（真实上游事件流）');

await t('fixtures 目录下每条真实事件流都能被正确归一化', () => {
  const dir = path.join(ROOT, 'app', 'kernel', 'fixtures');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch { /* 目录不存在，走下面的 skip */ }
  if (!files.length) {
    return {
      skip: '尚无 fixtures（M0 缺口，见 docs/roadmap.md「M0 缺口」）——'
        + '这是当前唯一能发现"运行事件流字段被改名"的手段，拿到可认证的上游后跑 '
        + '`node tools/record-fixtures.mjs` 录制即可自动纳入本用例',
    };
  }
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(Array.isArray(raw.events) && raw.events.length, f + ' 应含非空 events 数组');
    assert.ok(raw.meta && raw.meta.upstreamVersion, f + ' 必须记录上游版本，否则无法判断它属于哪个上游');
    for (let i = 0; i < raw.events.length; i++) {
      const m = mapUpstreamEvent(raw.events[i]);
      assert.notEqual(m.type, 'unknown',
        f + ' 第 ' + i + ' 条事件（' + (m._upstreamType || '?') + '）未被任何规则识别');
      assert.ok(m._verified,
        f + ' 第 ' + i + ' 条命中的是未核实规则 —— 既然有了真实事件流，就该把该规则升级为已核实');
    }
  }
});

/* ── 路由 ───────────────────────────────────────────────── */
section('路由');

await t('静态段优先于参数段', () => {
  const r = createRouter();
  r.add({ id: 'a', method: 'GET', path: '/api/kernel/status', scope: 'public', handler: () => {} });
  r.add({ id: 'b', method: 'GET', path: '/api/kernel/:id', scope: 'public', handler: () => {} });

  assert.equal(r.match('GET', '/api/kernel/status').route.id, 'a');
  const p = r.match('GET', '/api/kernel/abc');
  assert.equal(p.route.id, 'b');
  assert.equal(p.params.id, 'abc');
  assert.equal(r.match('GET', '/api/kernel/status/extra'), null);
  assert.deepEqual(r.allowedMethods('/api/kernel/status'), ['GET']);
});

await t('非法路由定义被拒绝（id 重复 / scope 非法 / path 非法 / 缺 handler）', () => {
  const r = createRouter();
  r.add({ id: 'x', method: 'GET', path: '/api/x', scope: 'public', handler: () => {} });
  assert.throws(() => r.add({ id: 'x', method: 'GET', path: '/api/y', scope: 'public', handler: () => {} }), /重复/);
  assert.throws(() => r.add({ id: 'z', method: 'GET', path: '/api/z', scope: 'root', handler: () => {} }), /scope/);
  assert.throws(() => r.add({ id: 'w', method: 'GET', path: 'api/w', scope: 'public', handler: () => {} }), /\/ 开头/);
  assert.throws(() => r.add({ id: 'v', method: 'POST', path: '/api/v', scope: 'public' }), /handler/);
});

/* ── M1：身份与权限（纯函数层） ────────────────────────────── */

section('M1 · 口令哈希');

await t('scrypt 往返：正确口令通过、错误口令拒绝、异常输入不抛错', async () => {
  const h = await hashPassword('Corr3ct-Pass!');
  assert.equal(await verifyPassword('Corr3ct-Pass!', h.hash, h.salt), true);
  assert.equal(await verifyPassword('corr3ct-pass!', h.hash, h.salt), false, '大小写不同必须拒绝');
  assert.equal(await verifyPassword('', h.hash, h.salt), false);
  assert.equal(await verifyPassword('Corr3ct-Pass!', h.hash, 'AAAA'), false, 'salt 不对必须拒绝');
  assert.equal(h.salt, Buffer.from(h.salt, 'base64').toString('base64'), 'salt 应是 base64');
});

await t('哈希串自描述：参数编进串里，**调默认参数不会让旧口令失效**', async () => {
  const h = await hashPassword('Corr3ct-Pass!', { params: { N: 8192 } });
  assert.match(h.hash, /^scrypt\$N=8192,r=8,p=1,keylen=64\$/);
  const d = decodeHash(h.hash);
  assert.equal(d.params.N, 8192, '参数应能从串里读回来');
  // 默认参数是 16384；用 8192 生成的旧哈希仍必须能验证 —— 这正是"参数编进哈希串"要解决的问题
  assert.equal(await verifyPassword('Corr3ct-Pass!', h.hash, h.salt), true);
});

await t('损坏/伪造的哈希串一律返回 false（不抛错，也不泄漏内部结构）', async () => {
  for (const bad of ['', 'not-a-hash', 'sha256$abc$zz', 'scrypt$N=0,r=0,p=0,keylen=0$AAAA',
    'scrypt$N=16384,r=8,p=1,keylen=64$', null, undefined]) {
    assert.equal(await verifyPassword('x', bad, 'AAAA'), false, '哈希 ' + JSON.stringify(bad) + ' 应返回 false');
  }
  assert.equal(decodeHash('scrypt$N=0,r=8,p=1,keylen=64$AAAA'), null, '参数非法（N<=1）应判为不可解析');
});

await t('口令强度只做下限（不假装能判断"够不够安全"）', () => {
  assert.equal(checkPasswordStrength('short1!').ok, false, '少于 8 位应拒绝');
  assert.equal(checkPasswordStrength('aaaaaaaaaaaa').ok, false, '单一字符重复应拒绝');
  assert.equal(checkPasswordStrength('alllowercase').ok, false, '只有一类字符应拒绝');
  assert.equal(checkPasswordStrength('Passw0rd').ok, true);
  assert.equal(checkPasswordStrength('a'.repeat(300)).ok, false, '超长应拒绝');
  assert.ok(kdfInfo().approxMemMiB >= 1, '应报告 scrypt 的内存成本（供运维评估）');
});

section('M1 · 令牌');

await t('令牌哈希：确定性 + 依赖主密钥 + 不含明文', () => {
  const A = Buffer.alloc(32, 1), B = Buffer.alloc(32, 2);
  const tk = 'sti_demo.token';
  assert.equal(hashToken(tk, A), hashToken(tk, A), '同一输入必须得到同一哈希');
  assert.notEqual(hashToken(tk, A), hashToken(tk, B), '换主密钥必须不同 —— 这是"库被拷走也伪造不了令牌"的依据');
  assert.notEqual(hashToken(tk, A), tk);
  assert.match(hashToken(tk, A), /^[0-9a-f]{64}$/);
  assert.throws(() => hashToken(tk, null), /主密钥/, '没有主密钥必须报错，不许悄悄退化成 sha256');
});

await t('签发：前缀区分类型、每次不同、过期时间合理', () => {
  const M = Buffer.alloc(32, 9);
  const s1 = issueSessionToken(M), s2 = issueSessionToken(M);
  assert.ok(s1.token.startsWith(SESSION_PREFIX) && !s1.token.startsWith(APIKEY_PREFIX));
  assert.notEqual(s1.token, s2.token, '两次签发必须不同（CSPRNG）');
  assert.notEqual(s1.tokenHash, s2.tokenHash);
  assert.ok(s1.token.length >= 40, '32 字节随机 + id 应足够长');
  assert.ok(Date.parse(s1.expiresAt) > Date.now());

  const k = issueApiKey(M, { ttlMs: null });
  assert.ok(k.key.startsWith(APIKEY_PREFIX));
  assert.equal(k.expiresAt, null, '不指定 TTL 的 API Key 永不过期（这是明确语义，不是"忘了填"）');
});

await t('extractToken：三种携带方式，且**拒绝** query string', () => {
  assert.deepEqual(extractToken({ headers: { authorization: 'Bearer abc' } }), { token: 'abc', via: 'authorization' });
  assert.deepEqual(extractToken({ headers: { authorization: 'bearer abc' } }), { token: 'abc', via: 'authorization' }, '大小写不敏感');
  assert.deepEqual(extractToken({ headers: { 'x-sti-token': 'abc' } }), { token: 'abc', via: 'x-sti-token' });
  assert.deepEqual(extractToken({ headers: { cookie: 'a=1; sti_session=abc; b=2' } }), { token: 'abc', via: 'cookie' });
  assert.deepEqual(extractToken({ headers: { cookie: '__Host-sti_session=abc' } }), { token: 'abc', via: 'cookie' }, 'HTTPS 的 __Host- 前缀名也认');
  assert.deepEqual(
    extractToken({ headers: { cookie: 'sti_session=old; __Host-sti_session=new' } }),
    { token: 'new', via: 'cookie' },
    '两个名字都在时 __Host- 优先（它更难被伪造）'
  );
  assert.deepEqual(extractToken({ headers: { authorization: 'Basic abc' } }), { token: null, via: null }, '只认 Bearer');
  // URL 里的令牌必须取不到 —— 否则会进访问日志、浏览器历史、Referer
  assert.deepEqual(extractToken({ headers: {}, url: '/x?token=abc' }), { token: null, via: null });
  assert.equal(isCookieAuth('cookie'), true);
  assert.equal(isCookieAuth('authorization'), false);
});

await t('会话 Cookie 属性：HttpOnly + SameSite=Lax；Secure 只在 HTTPS 下加', () => {
  const c = sessionCookie('sti_x.y', { maxAgeSec: 3600, secure: false });
  assert.ok(c.startsWith(SESSION_COOKIE + '='));
  assert.match(c, /HttpOnly/, '必须 HttpOnly（防 XSS 读走令牌）');
  assert.match(c, /SameSite=Lax/, '必须 SameSite=Lax（CSRF 第一道防线）');
  assert.match(c, /Max-Age=3600/);
  assert.ok(!/Secure/.test(c), '非 HTTPS 下不能加 Secure —— 否则本地开发根本登不上');
  assert.match(sessionCookie('t', { secure: true }), /Secure/);
  const hs = sessionCookie('t', { secure: true });
  assert.ok(hs.startsWith('__Host-sti_session='), 'HTTPS 下用 __Host- 前缀（浏览器强制：防子域注入/覆盖会话 cookie）');
  assert.ok(!/Domain=/.test(hs), '__Host- 前缀禁止 Domain 属性');
  assert.ok(!sessionCookie('t', { secure: false }).startsWith('__Host-'), 'HTTP 下回落明名');
  assert.match(clearSessionCookie(), /Max-Age=0/);
  const clears = clearAllSessionCookies({ secure: true });
  assert.equal(clears.length, 2, 'HTTPS 登出要同时清两个历史名字');
  assert.ok(clears[0].startsWith('__Host-sti_session=') && clears[1].startsWith(SESSION_COOKIE + '='));
  assert.equal(clearAllSessionCookies({ secure: false }).length, 1, 'HTTP 只有一个名字');
});

section('M1 · 权限判定（穷举全覆盖）');

/**
 * 独立重写的参考实现：故意写得笨、写得直白。
 * 它的作用是**对照** `can()` —— 如果两者在任意一格上不一致，就说明实现里有隐含行为。
 */
function refCan(roles, resource, action) {
  const list = Array.isArray(roles) ? roles : (roles == null ? [] : [roles]);
  for (const rk of list) {
    const def = ROLE_MATRIX[String(rk)];
    if (!def) continue;                                     // 未知角色跳过（不默认允许）
    const g = def.grants || {};
    const acts = Object.prototype.hasOwnProperty.call(g, resource) ? g[resource] : (g['*'] || []);
    if (acts.indexOf('*') >= 0 || acts.indexOf(action) >= 0) return true;
  }
  return false;
}

await t('全矩阵穷举：内置角色 × 全部资源 × 全部动作 与参考实现逐格一致', () => {
  const actions = [...ACTIONS, 'delete-all'];   // 多带一个非法动作，确认不会"任何动作都放行"
  let checked = 0;
  for (const role of ROLE_KEYS) {
    for (const res of RESOURCES) {
      for (const act of actions) {
        assert.equal(can([role], res, act), refCan([role], res, act),
          '判定不一致：' + role + ' / ' + res + ' / ' + act);
        checked++;
      }
    }
  }
  assert.equal(checked, ROLE_KEYS.length * RESOURCES.length * actions.length);
  assert.ok(checked >= 300, '覆盖格数应足够（实际 ' + checked + ' 格）');
});

await t('多角色取并集；非法入参一律拒绝', () => {
  assert.equal(can(['viewer', 'member'], 'session', 'execute'), true, '并集：member 有就通过');
  assert.equal(can(['viewer'], 'session', 'execute'), false, '单个 viewer 没有');
  assert.equal(can([], 'session', 'read'), false, '空角色列表必须拒绝');
  assert.equal(can(null, 'session', 'read'), false);
  assert.equal(can(['owner'], '', 'read'), false, '资源为空必须拒绝');
  assert.equal(can(['owner'], 'org', ''), false, '动作为空必须拒绝');
  assert.equal(can(['owner'], 'nope', 'read'), true, 'owner 的 "*" 覆盖未知资源（有意为之：owner 是全权）');
});

await t('未知角色一律拒绝（拼错的角色绝不能变成"人人有份"）', () => {
  for (const r of ['root', 'superadmin', 'OWNER', 'Admin', '', 'owner ']) {
    assert.equal(can([r], 'system', 'read'), false, '未知角色 ' + JSON.stringify(r) + ' 必须被拒');
    assert.equal(knownRole(r), false);
  }
  assert.equal(knownRole('owner'), true);
  assert.equal(can(['root', 'owner'], 'system', 'read'), true, '混在合法角色里也不影响合法那个生效');
});

await t('具体资源优先于默认档 "*"：admin 的 org 权限被收窄（关键安全规则）', () => {
  // admin 的 '*' 给了 read/write/execute，但 org 单独声明为 ['read'] → write 必须为 false。
  // 若这条挂了，说明"具体资源优先"被改成了"并集"，管理员就能改名/删除组织了。
  assert.equal(can(['admin'], 'org', 'write'), false, 'admin 不该能改组织');
  assert.equal(can(['admin'], 'org', 'read'), true);
  assert.equal(can(['admin'], 'user', 'write'), true, '未单独声明的资源走 "*"');
  assert.equal(can(['admin'], 'credential', 'delete'), true, 'credential 单独声明里有 delete');
  assert.equal(can(['owner'], 'org', 'delete'), true, '只有 owner 能给组织"判死刑"');
  assert.equal(can(['member'], 'role', 'write'), false, 'member 不能改角色');
  assert.equal(can(['viewer'], 'knowledge', 'read'), true);
  assert.equal(can(['viewer'], 'knowledge', 'write'), false, 'viewer 只能看');
});

await t('资源与动作大小写不敏感，但角色 key 精确匹配（安全方向：宁可拒绝）', () => {
  assert.equal(can(['viewer'], 'USER', 'READ'), true);
  assert.equal(can(['viewer'], 'user', 'READ'), true);
  assert.equal(can(['VIEWER'], 'user', 'read'), false, '角色 key 大小写不同 → 视为未知角色 → 拒绝');
});

await t('explain() 给出"凭哪个角色放行的"，供审计记录', () => {
  const ok = explain(['viewer', 'admin'], 'credential', 'delete');
  assert.equal(ok.allowed, true);
  assert.equal(ok.by, 'admin', '应指出是 admin 放行的');
  const no = explain(['viewer'], 'credential', 'delete');
  assert.equal(no.allowed, false);
  assert.equal(no.by, null);
  assert.ok(no.checked.length >= 1 && Array.isArray(no.checked[0].actions));
  assert.equal(explain(['root'], 'user', 'read').checked[0].note, '未知角色，已忽略');
});

await t('权限矩阵 / 机器可读描述自洽（前端角色页直接用这份数据）', () => {
  const m = matrixFor(['viewer']);
  assert.equal(Object.keys(m).length, RESOURCES.length);
  for (const res of RESOURCES) {
    assert.deepEqual(Object.keys(m[res]).sort(), ACTIONS.slice().sort(), res + ' 的动作集应完整');
  }
  assert.equal(m.session.read, true);
  assert.equal(m.session.write, false);
  assert.equal(m.session.execute, false);

  assert.deepEqual(Object.keys(fullMatrix()).sort(), ROLE_KEYS.slice().sort());
  const d = describePermissions();
  assert.equal(d.resources.length, RESOURCES.length);
  assert.match(d.rules, /未知角色一律拒绝/);
});

await t('每个内置角色都对至少若干资源有读权限（否则该角色登录后什么都看不到）', () => {
  for (const r of ROLE_KEYS) {
    const readable = RESOURCES.filter((res) => can([r], res, 'read'));
    assert.ok(readable.length >= 3, r + ' 可读资源太少：' + readable.join(','));
  }
});

section('M1 · 凭据加密');

await t('AES-256-GCM：可往返、每次不同、换密钥与篡改都解不开', () => {
  const k1 = Buffer.alloc(32, 3), k2 = Buffer.alloc(32, 4);
  const plain = 'sk-must-not-leak-1234567890';
  const c1 = encryptSecret(plain, k1);
  const c2 = encryptSecret(plain, k1);
  assert.notEqual(c1, c2, '同一明文两次加密必须不同（每次新 IV）');
  assert.ok(!c1.includes(plain), '密文里不得出现明文片段');
  assert.equal(decryptSecret(c1, k1), plain);

  assert.throws(() => decryptSecret(c1, k2), /解密失败/, '换密钥必须解不开');
  const buf = Buffer.from(c1, 'base64');
  buf[buf.length - 1] ^= 0x01;                                   // 改掉最后一个字节
  assert.throws(() => decryptSecret(buf.toString('base64'), k1), /解密失败/,
    'GCM 是带认证的加密：被篡改必须直接失败，而不是悄悄解出一段乱码');
  assert.throws(() => decryptSecret('', k1), /长度不足/);
  assert.throws(() => encryptSecret('x', Buffer.alloc(8)), /主密钥/, '密钥长度不对必须报错');
});

await t('v2 信封：SE1. 前缀带 kid；历史 v1 密文继续可解（P1-8 兼容）', () => {
  const k1 = Buffer.alloc(32, 5);
  const plain = 'secret-v2-compat';
  const c = encryptSecret(plain, k1);
  assert.ok(c.startsWith('SE1.'), '新加密必须输出 v2 信封');
  const ring = createSecretKeyring({ active: k1 });
  const kid = cipherKid(c);
  assert.ok(Buffer.isBuffer(kid) && kid.length === 8);
  assert.deepEqual(kid, ring.activeKid);
  assert.equal(decryptSecret(c, ring), plain);
  assert.equal(decryptSecret(c, k1), plain, '裸 Buffer 作为第二参数的旧调用方式必须继续可用');

  // 手工构造历史 v1 密文（裸 base64：iv‖tag‖ct，2026-10 评审之前的落库格式）
  const iv = crypto.randomBytes(12);
  const cc = crypto.createCipheriv('aes-256-gcm', k1, iv);
  const ct = Buffer.concat([cc.update(Buffer.from(plain, 'utf8')), cc.final()]);
  const v1 = Buffer.concat([iv, cc.getAuthTag(), ct]).toString('base64');
  assert.equal(cipherKid(v1), null, 'v1 没有 kid');
  assert.equal(decryptSecret(v1, k1), plain);
  assert.equal(decryptSecret(v1, ring), plain);
});

await t('密钥环轮换：旧 kid 密文可解、缺失 kid 必须拒绝、重加密后归位', () => {
  const oldKey = Buffer.alloc(32, 7);
  const newKey = Buffer.alloc(32, 8);
  const plain = 'rotate-me';
  const oldCipher = encryptSecret(plain, oldKey);

  const ring = createSecretKeyring({ active: newKey, older: [oldKey] });
  assert.equal(ring.older.length, 1);
  assert.equal(decryptSecret(oldCipher, ring), plain, '旧 kid 密文必须能按环找到旧密钥');

  const loneRing = createSecretKeyring({ active: newKey });
  assert.throws(() => decryptSecret(oldCipher, loneRing), /解密失败/, '环里没有该 kid → 解不开');
  assert.throws(() => decryptSecret(oldCipher, newKey), /解密失败/, '裸新密钥也解不开旧密文');

  // 用当前密钥重加密后 kid 归位
  const re = encryptSecret(decryptSecret(oldCipher, ring), newKey);
  assert.deepEqual(cipherKid(re), ring.activeKid);
  assert.equal(decryptSecret(re, loneRing), plain);

  // 同一把旧密钥在环里按 kid 去重
  assert.equal(createSecretKeyring({ active: newKey, older: [oldKey, oldKey] }).older.length, 1);
});

await t('v2 信封篡改：改 kid 或密文字节一律解密失败', () => {
  const k1 = Buffer.alloc(32, 9);
  const c = encryptSecret('tamper-v2', k1);
  const payload = Buffer.from(c.slice('SE1.'.length), 'base64');

  const a = Buffer.from(payload);
  a[0] ^= 0xff;                                        // kid 变了：环里找不到
  assert.throws(() => decryptSecret('SE1.' + a.toString('base64'), k1), /解密失败/);

  const b = Buffer.from(payload);
  b[b.length - 1] ^= 0x01;                              // 密文尾字节变了：GCM 认证失败
  assert.throws(() => decryptSecret('SE1.' + b.toString('base64'), k1), /解密失败/);
});

await t('credentialInfo 只输出元信息：无明文、无密文、连掩码都没有', () => {
  const info = credentialInfo({ id: 'cred_1', name: 'k', provider: 'p', cipher: 'xxx', updated_at: '2026-01-01' });
  assert.deepEqual(Object.keys(info).sort(), ['hasValue', 'id', 'name', 'provider', 'updatedAt'].sort());
  assert.equal(info.hasValue, true);
  assert.equal(credentialInfo({ id: 'a', name: 'n', cipher: '' }).hasValue, false);
  assert.equal(credentialInfo(null), null);
  assert.equal(cryptoInfo().algorithm, 'aes-256-gcm');
});

section('M1 · 令牌有效性判定（纯函数）');

await t('API Key 的 scopes 解析与过期判定', () => {
  assert.deepEqual(scopesOf({ scopes: 'a,b , c' }), ['a', 'b', 'c']);
  assert.deepEqual(scopesOf({ scopes: '' }), []);
  assert.deepEqual(scopesOf(null), []);
  assert.equal(isApiKeyUsable({ expires_at: null }), true, '无过期时间 = 永不过期');
  assert.equal(isApiKeyUsable({ expires_at: '2000-01-01T00:00:00.000Z' }), false, '过期必须失效');
  assert.equal(isApiKeyUsable({ expires_at: '2999-01-01T00:00:00.000Z' }), true);
  assert.equal(isApiKeyUsable(null), false);
});

await t('登录会话的有效性：未吊销且未过期才算可用', () => {
  const future = '2999-01-01T00:00:00.000Z';
  const past = '2000-01-01T00:00:00.000Z';
  assert.equal(isAuthSessionUsable({ revoked_at: null, expires_at: future }), true);
  assert.equal(isAuthSessionUsable({ revoked_at: '2026-01-01T00:00:00.000Z', expires_at: future }), false, '已吊销必须失效');
  assert.equal(isAuthSessionUsable({ revoked_at: null, expires_at: past }), false, '已过期必须失效');
  assert.equal(isAuthSessionUsable(null), false);
});

section('M1 · CSRF 判定（纯函数）');

await t('csrfVerdict：跨站拒绝、同源放行、无来源头不拦（否则误伤脚本）', () => {
  assert.equal(csrfVerdict({ headers: { 'sec-fetch-site': 'cross-site' } }).ok, false);
  assert.equal(csrfVerdict({ headers: { 'sec-fetch-site': 'same-origin' } }).ok, true);
  assert.equal(csrfVerdict({ headers: { 'sec-fetch-site': 'same-site' } }).ok, true);
  assert.equal(csrfVerdict({ headers: { 'sec-fetch-site': 'none' } }).ok, true);

  assert.equal(csrfVerdict({ headers: { origin: 'http://a.test', host: 'a.test' } }).ok, true);
  assert.equal(csrfVerdict({ headers: { origin: 'http://b.test', host: 'a.test' } }).ok, false);
  assert.equal(csrfVerdict({ headers: { origin: 'http://a.test:3090', host: 'a.test:3090' } }).ok, true);
  assert.equal(csrfVerdict({ headers: { origin: 'not-a-url', host: 'a.test' } }).ok, false);

  assert.equal(csrfVerdict({ headers: {} }).ok, true, '没有来源信息就不拦 —— curl/脚本不发这些头');
  assert.equal(csrfVerdict({ headers: { origin: 'null' } }).ok, true, 'Origin: null 不提供可用信息');

  // Sec-Fetch-Site 优先于 Origin（浏览器两者都给时，以更权威的那个为准）
  const both = csrfVerdict({ headers: { 'sec-fetch-site': 'cross-site', origin: 'http://a.test', host: 'a.test' } });
  assert.equal(both.ok, false);
  assert.equal(both.source, 'sec-fetch-site');
});

/* ── P0-D：安全响应头（纯函数）────────────────────────────────────── */

await t('安全响应头：必设 nosniff / DENY / 无来源 / CSP；script-src 无 unsafe-inline；HSTS 只在 HTTPS 下发', () => {
  const h = securityHeaders();
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['x-frame-options'], 'DENY');
  assert.equal(h['referrer-policy'], 'no-referrer');
  const csp = h['content-security-policy'];
  assert.ok(/default-src 'self'/.test(csp));
  assert.ok(/object-src 'none'/.test(csp), '禁止 object/embed（老式插件注入面）');
  assert.ok(/base-uri 'none'/.test(csp), '禁止 base 劫持相对路径');
  assert.ok(/frame-ancestors 'none'/.test(csp), '禁止被 iframe 嵌套（与 X-Frame-Options 双保险）');
  // P1-3 / 3.4：内联事件属性已全部改成事件委托、首屏内联脚本已外链 —— script-src 必须收到 'self'。
  assert.ok(/script-src 'self'/.test(csp), 'script-src 应为 self');
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'script-src 不得再含 unsafe-inline（3.4 已去）');
  // style-src 保留 unsafe-inline 是**明知的取舍**（120 处内联样式属性，0.15.2 重写契约页后从 123 降下来），如实钉住，防被"顺手改掉"。
  assert.ok(/style-src 'self' 'unsafe-inline'/.test(csp), 'style-src 仍保留 unsafe-inline（见 security-headers 说明）');
  assert.ok(!/[\r\n]/.test(csp), 'HTTP 头值不允许换行');

  // 明文 HTTP 上不得发 HSTS：浏览器要求经 TLS 收到才记，明文发不仅无效还误导"已上 TLS"
  assert.equal(h['strict-transport-security'], undefined, 'HTTP 下不应出现 HSTS');
  const s = securityHeaders({ secure: true });
  assert.match(s['strict-transport-security'], /^max-age=\d+/);
});

await t('isHttps：识别 x-forwarded-proto 与 TLS socket，缺字段不抛', () => {
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': 'https, http' } }), true, '反代链只认第一段');
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': 'http' } }), false);
  assert.equal(isHttps({ headers: {}, socket: { encrypted: true } }), true);
  assert.equal(isHttps({ headers: {}, socket: {} }), false);
  assert.equal(isHttps({}), false, '缺 headers/socket 不得抛');
});

section('M1 · 审计哈希链（纯函数）');

await t('computeHash：确定、且对**每一个**字段敏感', () => {
  const row = {
    tenant_id: 't', user_id: 'u', action: 'a', resource_type: 'r',
    resource_id: 'i', result: 'ok', detail_json: '{}', at: '2026-01-01T00:00:00.000Z',
  };
  const h = computeHash('prev', row);
  assert.equal(computeHash('prev', row), h, '同样输入必须同样哈希');
  assert.equal(h.length, 64);
  assert.notEqual(computeHash('other', row), h, 'prev_hash 变了必须变（链断了要能发现）');
  for (const f of Object.keys(row)) {
    const mutated = { ...row, [f]: row[f] + 'X' };
    assert.notEqual(computeHash('prev', mutated), h, '字段 ' + f + ' 没被算进哈希 —— 改它就发现不了了');
  }
});

section('配置与版本门禁');
await t('★ 版本门禁：没有上游版本时不得报出"上游版本未验证"（曾经的真实 bug）', async () => {
  // 背景：早期版本门禁只看版本号。而内核 provider 的 `describe().kernelVersion` 是**上游内核**
  // 的版本 —— 一个没有上游的 provider（本地替身、未接入时的占位）若在这里填了自己的契约版本，
  // 门禁就会警告「1.0.0 不在已验证矩阵内」：警告一个**根本不存在的上游版本**。
  //
  // 产品从前靠"内核模式 = mock → 跳过版本门禁"盖住它。0.21.4 把模式和内置内核一起删了，
  // 于是判据不再是模式，而是**provider 自己**：要么报出一个真实的上游版本号，
  // 要么如实报空 —— 空 ⇒ 门禁得出 `unknown`（"读不到上游版本"），而不是 `warn`。
  //
  // 这条不能用字面量 `versionGate('1.0.0')` 断言（那只是在测一个字符串），
  // 必须穿过真实的 provider，否则"某个 provider 又填了自己的版本"这个 bug 会重现而无人察觉。
  const { createUnconfiguredProvider } = await import('../app/kernel/unconfigured-provider.mjs');
  const { createKernelStub } = await import('./kernel-stub.mjs');
  for (const p of [createUnconfiguredProvider(), createKernelStub()]) {
    const desc = await p.describe();
    assert.ok(!desc.kernelVersion, p.name + ' 没有上游内核，不该报出一个上游版本号');
    const g = versionGate(desc.kernelVersion);
    assert.notEqual(g.level, 'warn', p.name + ' 不许报出"上游版本未验证"');
    assert.ok(!/不在已验证矩阵内/.test(g.detail), '不应出现"不在已验证矩阵内"的措辞');
  }
});

await t('版本门禁：外部内核在矩阵内 → ok；不在矩阵内 → warn（不静默放行）', () => {
  const inMatrix = versionGate(KERNEL_VERIFIED_VERSIONS[0]);
  assert.equal(inMatrix.level, 'ok');
  // ⚠️ 不要写死一个"越界版本"字面量 —— 它随时可能被真的验证通过而进入矩阵
  // （2026-10-01 就发生过：0.2.0-rc.2 从越界样本变成了矩阵成员，用例随之失败）。
  // 正确做法是**构造**一个必然不在矩阵内的版本。
  let absent = '99.0.0-unverified';
  while (KERNEL_VERIFIED_VERSIONS.includes(absent)) absent += '-x';
  const outside = versionGate(absent);
  assert.equal(outside.level, 'warn', '未核实的版本必须黄灯，不能假装正常');
  assert.ok(/不在已验证矩阵内/.test(outside.detail));
  // 提示必须给出**真实存在**的核实办法，不能只让运维去跑一个不存在的脚本
  assert.ok(/verify-upstream/.test(outside.detail), '应指向真实存在的契约核实脚本');
});

await t('版本门禁：读不到版本 → unknown（与"越界"区分开）', () => {
  for (const v of [undefined, '', '—', 'unknown']) {
    assert.equal(versionGate(v).level, 'unknown', '版本值为 ' + JSON.stringify(v) + ' 时应为 unknown');
  }
});

await t('Node 版本下限判定：边界值正确', () => {
  assert.equal(checkNodeVersion('22.13.0').ok, true, '正好等于下限应通过');
  assert.equal(checkNodeVersion('22.12.9').ok, false, '低于下限应拒绝');
  assert.equal(checkNodeVersion('24.10.0').ok, true);
  assert.equal(checkNodeVersion('18.20.0').ok, false);
  assert.ok(/22\.13\.0/.test(checkNodeVersion('18.20.0').required));
});

/* ── P0-D：sessionTtlHours 曾是"死配置"（改了配置什么都不会变）──────────── */

await t('会话有效期换算：sessionTtlHours → 毫秒，非法值安全回退为"交给默认值"', () => {
  // 背景（P0-D 第 1 项）：`sessionTtlHours` 曾经只存在于默认值里、**从没被读过** ——
  // 会话实际写死 8 小时。修复把换算收口到纯函数 `sessionTtlMs()`，本条钉住它的行为。
  assert.equal(sessionTtlMs({ sessionTtlHours: 12 }), 12 * 3600 * 1000);
  assert.equal(sessionTtlMs({ sessionTtlHours: 1 }), 3600 * 1000);
  assert.equal(sessionTtlMs({ sessionTtlHours: '3' }), 3 * 3600 * 1000, '字符串数字也应接受（config.json 里可能是字符串）');
  assert.equal(sessionTtlMs({ sessionTtlHours: 0.5 }), 1800 * 1000, '支持半小时这类小数');
  // 非法/缺失一律 null（= 用身份服务自身默认值）。绝不能退化成 0 或 NaN：
  // 那会让会话"刚签发就过期"，比死配置更难查。
  for (const bad of [0, -1, 'abc', '', null, undefined, NaN]) {
    assert.equal(sessionTtlMs({ sessionTtlHours: bad }), null, JSON.stringify(bad) + ' 应回退为 null');
  }
  assert.equal(sessionTtlMs(), null, '无参数应回退');
  assert.equal(sessionTtlMs({}), null);
});

await t('默认配置里 sessionTtlHours 是配置形状的一部分且可换算', () => {
  const v = loadConfig().values;
  assert.ok(v.sessionTtlHours !== undefined, 'sessionTtlHours 必须存在于配置形状中（否则换算必然回退到内置默认）');
  assert.ok(Number(v.sessionTtlHours) > 0, '默认值应为正数，实际 ' + JSON.stringify(v.sessionTtlHours));
  assert.equal(sessionTtlMs(v), Number(v.sessionTtlHours) * 3600 * 1000, '默认配置应能换算成毫秒');
});

await t('装配层真的把配置传进身份服务（防"死配置"回归）', () => {
  // 这是本项修复的**要害**：换算函数再对，装配层不调用也白搭。
  // 单测无法直接 import 装配模块，因此对源码做结构断言。
  // （P2-13 后装配图单点在 app/compose/services.mjs，main.mjs 只剩启动步骤。）
  const src = fs.readFileSync(new URL('../app/compose/services.mjs', import.meta.url), 'utf8');
  assert.ok(/sessionTtlMs\s*\(/.test(src), '装配层必须调用 sessionTtlMs() 换算配置，而不是写死 TTL');
  assert.ok(/createIdentityService\(\{[\s\S]{0,400}?sessionTtlMs/.test(src),
    'createIdentityService 必须收到 sessionTtlMs —— 否则同"配置不生效"的老问题');
  // 反向断言：不得再出现写死的毫秒魔法数（8 小时 = 28800000）
  assert.ok(!/8\s*\*\s*3600\s*\*\s*1000/.test(src), '装配层不应再写死 TTL 毫秒数');
  assert.ok(!/\b28800000\b/.test(src), '装配层不应再出现写死的 28800000');
});

await t('身份服务：注入的 sessionTtlMs 真的决定会话过期时刻（配置 → 会话 闭环）', async () => {
  // 用一个刻意"不像任何默认值"的 TTL 建服务：若服务内部写死 8h，delta 会是 28800000，断言立刻失败。
  const ttl = 42 * 60 * 1000;               // 42 分钟
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32), sessionTtlMs: ttl });
  const org = orgRepo.listOrgs()[0];
  assert.ok(org, '前置条件：本文件「数据层」段已建好一个组织');
  const pwd = await hashPassword('Adm1n-Pass!23');
  userRepo.createUser({
    orgId: org.id, username: 'ttl_probe', displayName: 'ttl probe',
    pwdHash: pwd.hash, pwdSalt: pwd.salt,
  });
  const res = await svc.login({ username: 'ttl_probe', password: 'Adm1n-Pass!23' });
  const delta = Date.parse(res.expiresAt) - Date.now();
  assert.ok(Math.abs(delta - ttl) < 5000,
    '过期时刻应≈注入的 TTL（' + ttl + 'ms），实际差 ' + (delta - ttl) + 'ms —— 说明服务没读 sessionTtlMs');
  // 顺带钉住：会话令牌真的能通过同一服务的校验（TTL 改动没有把令牌搞坏）
  assert.ok(svc.authenticate(res.token), '登录签发的令牌应能通过本服务校验');
});

/* ══════════════════════════════════════════════════════════════════
   P0-D #8 · 用户组（组级角色绑定必须真的生效）
   ══════════════════════════════════════════════════════════════════ */

section('P0-D #8 · 用户组与组级绑定');

const grpOrg = orgRepo.listOrgs()[0];
roleRepo.ensureBuiltinRoles(grpOrg.id);

await t('组：建组 → 加成员 → 组上的角色对成员**真的生效**（认证路径也带上）', async () => {
  // 这是本缺陷的核心：0007 之前 `subject_type='group'` 能写进库，但判定只看 'user'，
  // 于是"授权成功"与"权限没变"同时成立，且没有任何报错。
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const u = await svc.createUser({ orgId: grpOrg.id, username: 'grp_probe1', password: 'Adm1n-Pass!23', roleKeys: ['member'] });
  assert.deepEqual(u.roles, ['member'], '新建用户初始只有 member');
  assert.deepEqual(u.groups, [], '还没进任何组');

  const g = svc.createGroup(grpOrg.id, { name: '回归组-A' });
  svc.setGroupMembers(grpOrg.id, g.id, [u.id]);
  svc.setGroupRoles(grpOrg.id, g.id, ['admin']);

  const after = svc.listUsers(grpOrg.id).find((x) => x.id === u.id);
  assert.deepEqual(after.roles.slice().sort(), ['admin', 'member'],
    '生效角色 = 直接绑定 ∪ 组绑定（组带来的不能覆盖、也不能丢掉直接的）');
  assert.deepEqual(after.groups.map((x) => x.name), ['回归组-A'], '要能看出角色是从哪个组来的');
  assert.equal(after.isAdmin, true, '凭组当上管理员 → 展示层必须如实说"是管理员"');
  // 迁移 0015 已删除 `users.is_admin`：这是刻意的 —— "谁是管理员"只有 role_bindings 一处真源。
  // 若这列又冒出来，说明有人把"维护着却从不被读"的冗余真相又加回来了。
  assert.equal(userRepo.getUserById(u.id).is_admin, undefined,
    'is_admin 列必须已删除（0015）；冗余的物化真相不该复活');

  // **最关键的一条**：认证路径（每个请求都走）必须带上组角色 —— 否则 RBAC 层看不见它们
  const res = await svc.login({ username: 'grp_probe1', password: 'Adm1n-Pass!23' });
  assert.ok(res.user.roles.includes('admin'), '登录返回的角色必须包含组带来的 admin');
  const auth = svc.authenticate(res.token);
  assert.ok(auth.roles.includes('admin'), 'authenticate 也必须带上（中间件读的就是它）');
});

await t('「最后一个 owner」保护穿透到组：摘角色 / 移成员 / 删组都会被整体回滚', () => {
  const o = orgRepo.createOrg({ name: 'C 公司', slug: 'c-corp-grp' });
  roleRepo.ensureBuiltinRoles(o.id);
  const u = userRepo.createUser({ orgId: o.id, username: 'c_owner', displayName: 'c', pwdHash: 'x', pwdSalt: 'y' });
  const g = groupRepo.createGroup({ orgId: o.id, name: 'C 的 owner 组' });
  groupRepo.addMember({ orgId: o.id, groupId: g.id, userId: u.id });
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  svc.setGroupRoles(o.id, g.id, ['owner']);

  assert.equal(roleRepo.countHolders(o.id, 'owner'), 1,
    '凭组持有的 owner 必须被数进来 —— 数不到的话保护会误判成"本来就没 owner"而放行');

  assert.throws(() => svc.setGroupRoles(o.id, g.id, ['member']), /一个生效的所有者都不剩/);
  assert.deepEqual(groupRepo.roleKeysOfGroup(o.id, g.id), ['owner'], '被拒后必须整体回滚，角色不能真被摘掉');

  assert.throws(() => svc.setGroupMembers(o.id, g.id, []), /一个生效的所有者都不剩/);
  assert.equal(groupRepo.memberIdsOf(o.id, g.id).length, 1, '回滚后成员必须还在（不能"先删了再报错"）');

  assert.throws(() => svc.deleteGroup(o.id, g.id), /一个生效的所有者都不剩/);
  assert.ok(groupRepo.getGroup(o.id, g.id), '组也不能被删掉');

  // 有人接手之后就是"从有到有"，应当放行 —— 保护的是**转变**，不是"有 owner 就永远不能动"
  const u2 = userRepo.createUser({ orgId: o.id, username: 'c_owner2', displayName: 'c2', pwdHash: 'x', pwdSalt: 'y' });
  svc.setUserRoles(o.id, u2.id, ['owner']);
  svc.setGroupRoles(o.id, g.id, ['member']);
  assert.deepEqual(groupRepo.roleKeysOfGroup(o.id, g.id), ['member'], '有接手者后应当允许摘');
  assert.equal(roleRepo.countHolders(o.id, 'owner'), 1);

  // 删组：成员关系与角色绑定必须一起清干净，不留"借尸还魂"的脏数据
  groupRepo.addMember({ orgId: o.id, groupId: g.id, userId: u2.id });
  svc.deleteGroup(o.id, g.id);
  assert.equal(groupRepo.getGroup(o.id, g.id), undefined);
  assert.equal(roleRepo.bindingsForSubject('group', g.id).length, 0, '组没了，绑定必须跟着没');
  assert.equal(groupRepo.memberIdsOf(o.id, g.id).length, 0);
});

await t('跨组织：别家的组不能挂本组织的角色；别家的人不能拉进本组织的组', () => {
  const o = orgRepo.createOrg({ name: 'D 公司', slug: 'd-corp-grp' });
  roleRepo.ensureBuiltinRoles(o.id);
  const g = groupRepo.createGroup({ orgId: o.id, name: 'D 的组' });
  const outsider = userRepo.createUser({ orgId: grpOrg.id, username: 'outsider_d', displayName: 'o', pwdHash: 'x', pwdSalt: 'y' });

  // ① 主体与角色必须同组织 —— 否则拿到别家的 id 就能把别家的身份绑到本组织的角色上
  const roleHere = roleRepo.getRoleByKey(o.id, 'member');
  const groupThere = groupRepo.createGroup({ orgId: grpOrg.id, name: '别家的组' });
  assert.throws(() => roleRepo.bindRole({ subjectType: 'group', subjectId: groupThere.id, roleId: roleHere.id }),
    /跨组织绑定被拒绝/);
  assert.throws(() => roleRepo.bindRole({ subjectType: 'user', subjectId: outsider.id, roleId: roleHere.id }),
    /跨组织绑定被拒绝/);

  // ② 成员必须属于本组织
  const add = groupRepo.addMember({ orgId: o.id, groupId: g.id, userId: outsider.id });
  assert.equal(add.ok, false);
  assert.match(add.error, /必须属于本组织/);
  assert.equal(groupRepo.memberIdsOf(o.id, g.id).length, 0, '不能留下半条成员关系');

  // ③ 服务层的"整组替换"遇到非法成员必须整体回滚，不做部分成功
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const insider = userRepo.createUser({ orgId: o.id, username: 'insider_d', displayName: 'i', pwdHash: 'x', pwdSalt: 'y' });
  groupRepo.addMember({ orgId: o.id, groupId: g.id, userId: insider.id });
  assert.throws(() => svc.setGroupMembers(o.id, g.id, [outsider.id]), /无法加入/);
  assert.deepEqual(groupRepo.memberIdsOf(o.id, g.id), [insider.id],
    '整体回滚：原有成员不能被"先删后加"清空');
});

await t('未知 subjectType / 不存在的角色与主体一律拒绝（不再"写进去了但没人读"）', () => {
  const role = roleRepo.getRoleByKey(grpOrg.id, 'member');
  for (const bad of ['role', 'dept', 'GROUP', '', 'User']) {
    assert.throws(() => roleRepo.bindRole({ subjectType: bad, subjectId: 'x', roleId: role.id }),
      /subjectType/, '未知主体类型必须当场报错：' + JSON.stringify(bad));
  }
  assert.throws(() => roleRepo.bindRole({ subjectType: 'group', subjectId: 'no-such-group', roleId: role.id }), /组不存在/);
  assert.throws(() => roleRepo.bindRole({ subjectType: 'user', subjectId: 'no-such-user', roleId: role.id }), /用户不存在/);
  assert.throws(() => roleRepo.bindRole({ subjectType: 'user', subjectId: 'no-such-user', roleId: 'no-such-role' }), /角色不存在/);
});

await t('批量取角色 / 组与逐个查完全一致（列表页的 N+1 优化不能改语义）', () => {
  // 批量版的组分支必须从 group_members 取 user_id —— 写成 b.subject_id 会把**组 id**
  // 当成用户 id，键对不上就静默丢角色。这条把两种写法钉成一致。
  const ids = userRepo.listUsers(grpOrg.id).map((u) => u.id);
  const rolesBatch = roleRepo.roleKeysForUsers(ids);
  const groupsBatch = groupRepo.groupsForUsers(grpOrg.id, ids);
  for (const id of ids) {
    assert.deepEqual((rolesBatch.get(id) || []).slice().sort(), roleRepo.roleKeysForUser(id).slice().sort(),
      '用户 ' + id + ' 的生效角色：批量与逐个不一致');
    assert.deepEqual((groupsBatch.get(id) || []).map((x) => x.id).sort(),
      groupRepo.groupsForUser(grpOrg.id, id).map((x) => x.id).sort(),
      '用户 ' + id + ' 的组：批量与逐个不一致');
  }
  // 空输入不能炸，也不能返回别人的数据
  assert.equal(roleRepo.roleKeysForUsers([]).size, 0);
  assert.equal(groupRepo.groupsForUsers(grpOrg.id, []).size, 0);
});

await t('permissions：group 已进资源矩阵，且 admin 的删除权是**显式**声明的', () => {
  assert.ok(RESOURCES.includes('group'), 'group 必须在资源清单里（否则路由声明 group:read 永远没人能过）');
  assert.equal(can(['admin'], 'group', 'read'), true);
  assert.equal(can(['admin'], 'group', 'write'), true);
  assert.equal(can(['admin'], 'group', 'delete'), true, '删组会连带撤掉它承载的绑定，必须给管理员明确的能力位');
  assert.equal(can(['member'], 'group', 'delete'), false);
  assert.equal(can(['member'], 'group', 'write'), false, 'member 只能看组，不能改组');
  assert.equal(can(['viewer'], 'group', 'write'), false);
  assert.ok(ROLE_MATRIX.admin.grants.group.includes('delete'),
    '必须写在 admin.grants.group 里 —— 靠默认档 "*" 是拿不到 delete 的（那会变成"以为能删其实不能"）');
});

/* ══════════════════════════════════════════════════════════════════
   P0-D #9 · 运维模块门面（operation/service.mjs）
   ══════════════════════════════════════════════════════════════════ */

section('P0-D #9 · 运维模块门面');

await t('分层：备份路由不再自己碰 fs / 不再直接 import backup.mjs（必须经门面）', () => {
  const routeSrc = fs.readFileSync(new URL('../app/http/routes/operation.mjs', import.meta.url), 'utf8');
  assert.ok(!/from 'node:fs'/.test(routeSrc), '路由不应 import node:fs（目录列举属于业务逻辑）');
  assert.ok(!/from 'node:path'/.test(routeSrc), '路由不应 import node:path（路径拼接属于业务逻辑）');
  assert.ok(!/operation\/backup\.mjs/.test(routeSrc), '路由不应直接 import backup.mjs');
  assert.ok(/deps\.operation\b/.test(routeSrc), '路由应通过 deps.operation 使用服务');
  // 反向：装配层必须真的建这个服务，否则"有门面"只是文件存在而已
  const composeSrc = fs.readFileSync(new URL('../app/compose/services.mjs', import.meta.url), 'utf8');
  assert.ok(/createOperationService\(/.test(composeSrc), '装配层（app/compose）必须真的装配 operation 服务');
  assert.ok(/createOperationService\([\s\S]{0,80}?dataDir/.test(composeSrc), '装配必须把数据目录注入进去（不能让它自己去翻全局常量）');
});

await t('备份目录不存在时如实说明原因，而不是给一个空列表', () => {
  const empty = path.join(tmp, 'no-such-data-dir');
  const op = createOperationService({ dataDir: empty });
  const r = op.listBackups();
  assert.deepEqual(r.items, []);
  assert.match(r.note, /没有 backups 目录|从未创建过备份|读取备份目录失败/, '必须说明"为什么是空的"');
  assert.equal(op.backupsDir(), path.join(empty, 'backups'));
  // 装配漏参数要在建服务时就炸，而不是等请求进来才 500
  assert.throws(() => createOperationService({}), /dataDir/);
});

await t('文件名解析：../、分隔符、绝对路径一律拒绝；"文件不存在"与"文件名非法"分开报告', () => {
  const op = createOperationService({ dataDir: tmp });
  for (const bad of ['../secret', 'a/b.zip', 'a\\b.zip', '', '   ', null, undefined]) {
    const r = op.resolveBackup(bad);
    assert.equal(r.ok, false, JSON.stringify(bad) + ' 应被拒绝');
    assert.equal(r.reason, 'bad_request', JSON.stringify(bad) + ' 应被判为参数非法');
  }
  const miss = op.resolveBackup('nope.zip');
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'not_found', '目录内合法的文件名但不存在 → 是 404，不是 400');
});

await t('真备份 → 校验通过；篡改一个字节 → 校验失败并指名（verifyByName 两层结论不混）', async () => {
  // 用一个干净的新数据目录自己做一次真备份，避免动到本文件前面的库
  const dataDir = path.join(tmp, 'op-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const fresh = new DatabaseSync(path.join(dataDir, 'sti-harness.db'));
  fresh.exec("CREATE TABLE probe (id TEXT PRIMARY KEY); INSERT INTO probe(id) VALUES ('a');");
  fresh.close();

  const opBackupKey = crypto.randomBytes(32).toString('hex');
  const op = createOperationService({ dataDir, backupKey: opBackupKey });
  const made = op.backupNow();
  assert.ok(/\.zip$/.test(made.name), '返回的是文件名（不是绝对路径）');
  assert.ok(made.bytes > 0);
  assert.equal(op.listBackups().items.length, 1, '刚建的备份必须出现在列表里');

  const good = op.verifyByName(made.name);
  assert.equal(good.ok, true, '文件存在 → 调用本身应当成功');
  assert.equal(good.verdict.ok, true, '完整包应通过校验：' + JSON.stringify(good.verdict.problems));
  assert.ok(good.verdict.checked >= 2, '至少 manifest + db 两个条目，实际 ' + good.verdict.checked);

  // 篡改：重建 zip 时把 db 条目改一个字节 → 校验必须失败并指名道姓
  const abs = path.join(dataDir, 'backups', made.name);
  const entries = readZipEntries(fs.readFileSync(abs));
  const tampered = entries.map((e) => {
    if (e.name !== 'sti-harness.db.enc') return e;
    const d = Buffer.from(e.data);
    d[100] = d[100] ^ 0xff;
    return { name: e.name, data: d };
  });
  fs.writeFileSync(abs, zipSync(tampered));

  const bad = op.verifyByName(made.name);
  assert.equal(bad.ok, true, '"文件存在"这一层仍然是成功的（两层结论不能混成一个 ok）');
  assert.equal(bad.verdict.ok, false, '内容被改过 → 校验结论必须是否定的');
  assert.ok(bad.verdict.problems.some((p) => /sti-harness\.db/.test(p)),
    '问题清单要指名被改的那个文件：' + JSON.stringify(bad.verdict.problems));
});

/* ══════════════════════════════════════════════════════════════════
   0.10.2 · 备份保留策略（轮转）
   —— "自动备份只在写、没有回收"是磁盘无界增长的来源；本段钉住回收的**边界**。
   ══════════════════════════════════════════════════════════════════ */

section('0.10.2 · 备份保留策略（轮转）');

await t('轮转只裁自己的产物：干扰文件（手工放的 zip / 临时快照 / 同名目录）一律不碰，删最旧留最新', () => {
  const dir = path.join(tmp, 'prune-dir');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 5; i++) {
    const f = path.join(dir, `backup-2026-10-0${i}T00-00-00-000Z.zip`);
    fs.writeFileSync(f, 'x'.repeat(i * 10));              // 字节数：10/20/30/40/50
    const t0 = Date.UTC(2026, 9, i) / 1000;               // mtime 递增 = i 越大越新
    fs.utimesSync(f, t0, t0);
  }
  fs.writeFileSync(path.join(dir, 'random.zip'), 'nope');   // 运维手工放进来的
  fs.writeFileSync(path.join(dir, '.vacuum-tmp.db'), 'tmp'); // createBackup 的临时快照
  fs.mkdirSync(path.join(dir, 'backup-dir.zip'));            // 名字像备份、其实是目录

  const dry = pruneBackups({ dir, keep: 2, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.total, 5, '候选只算 backup-*.zip 的**文件**；干扰项不得计入');
  assert.deepEqual(dry.removed.map((r) => r.file), [
    'backup-2026-10-03T00-00-00-000Z.zip',
    'backup-2026-10-02T00-00-00-000Z.zip',
    'backup-2026-10-01T00-00-00-000Z.zip',
  ], '删的必须是**最旧**的三份（按 mtime，不是按列举顺序）');
  assert.equal(fs.readdirSync(dir).length, 8, 'dry-run 之后磁盘必须原封不动');

  const real = pruneBackups({ dir, keep: 2 });
  assert.equal(real.kept, 2);
  assert.equal(real.freedBytes, 10 + 20 + 30, 'freedBytes 必须等于被删文件字节之和（给运维一个"省了多少"的数）');
  const left = fs.readdirSync(dir).sort();
  assert.ok(left.includes('backup-2026-10-05T00-00-00-000Z.zip')
    && left.includes('backup-2026-10-04T00-00-00-000Z.zip'), '最新的两份必须留下：' + left.join(', '));
  for (const mustStay of ['random.zip', '.vacuum-tmp.db', 'backup-dir.zip']) {
    assert.ok(left.includes(mustStay), '非本模块产物不得被删：' + mustStay);
  }
});

await t('保留下限是 1：keep 给 0 / 负数也绝不清理成"零备份"（磁盘满是问题，没有备份是灾难）', () => {
  const dir = path.join(tmp, 'prune-keep0');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(dir, `backup-a${i}.zip`), 'x');

  const r = pruneBackups({ dir, keep: 0 });
  assert.equal(r.keep, 1, 'keep:0 必须落成 1 —— **不是**回退默认 30（否则配 0 却留 30 份，配置与行为对不上）');
  assert.equal(r.kept, 1, '清理后必须至少剩 1 份');
  assert.equal(fs.readdirSync(dir).length, 1);

  const neg = pruneBackups({ dir, keep: -5 });
  assert.equal(neg.kept, 1, '负数同样抬到 1');

  // 目录不存在 = 没什么可裁的，不该抛错（第一次备份之前就是这种状态）
  const missing = pruneBackups({ dir: path.join(tmp, 'no-such-prune-dir'), keep: 2 });
  assert.equal(missing.ok, true);
  assert.equal(missing.total, 0);
  assert.equal(missing.removed.length, 0);
});

await t('顺序：备份创建失败时**绝不**轮转（先删后建 = 旧备份白删的净损失）', async () => {
  let pruneCalled = false;
  const stub = {
    backupNow() { throw new Error('磁盘满了'); },
    pruneBackups() { pruneCalled = true; return { ok: true, keep: 1, total: 0, kept: 0, removed: [], freedBytes: 0 }; },
  };
  const r = await runTask('backup.create', { tenantId: 't-order', params: {}, deps: { operation: stub } });
  assert.equal(r.status, 'fail', '创建抛错 → 任务必须记 fail');
  assert.equal(pruneCalled, false, '创建没成功就轮转，等于把旧备份白删了 —— 这是这里唯一不能颠倒的顺序');
});

await t('轮转的删除动作单独入审计；没删任何东西时不产生审计噪音', async () => {
  const seen = [];
  const audit = { append: (e) => { seen.push(e); } };
  const mkOp = (removed) => ({
    backupNow: () => ({ name: 'backup-x.zip', file: '/nowhere/backup-x.zip', bytes: 1, manifest: {} }),
    pruneBackups: () => ({ ok: true, keep: 2, total: 3, kept: 2, removed, freedBytes: 42 }),
  });

  const r1 = await runTask('backup.create', {
    tenantId: 't-audit', params: {},
    deps: { operation: mkOp([{ file: 'backup-old.zip', bytes: 42, mtime: '2026-09-01T00:00:00.000Z' }]), governance: { audit } },
  });
  assert.equal(r1.status, 'ok');
  assert.equal(r1.detail.keep, 2, '回报的必须是**实际生效**的保留份数');
  assert.equal(r1.detail.rotated.removed.length, 1);
  const pruneEvents = seen.filter((e) => e.action === 'operation.backup.prune');
  assert.equal(pruneEvents.length, 1, '删除是不可逆动作，必须单独一条审计（不能只藏在 schedule.job.run 里）');
  assert.equal(pruneEvents[0].result, 'ok');
  assert.equal(pruneEvents[0].tenantId, 't-audit', '审计必须落在正确的租户上');

  seen.length = 0;
  const r2 = await runTask('backup.create', {
    tenantId: 't-audit', params: {},
    deps: { operation: mkOp([]), governance: { audit } },
  });
  assert.equal(r2.status, 'ok');
  assert.equal(r2.detail.rotated.removed.length, 0);
  assert.equal(seen.length, 0, '没有删任何东西时不该留下审计噪音');
});

await t('轮转失败不上抛：备份仍算成功（fail_count 不被污染），错误如实回报而非吞掉', async () => {
  const stub = {
    backupNow: () => ({ name: 'backup-y.zip', file: '/nowhere/backup-y.zip', bytes: 5, manifest: {} }),
    pruneBackups() { throw new Error('EPERM 权限不足'); },
  };
  const r = await runTask('backup.create', { tenantId: 't-fail', params: {}, deps: { operation: stub } });
  assert.equal(r.status, 'ok', '备份确实做成了 → 不记 fail（记了会让失败计数失去意义）');
  assert.match(String(r.detail.rotateError), /EPERM/, '失败原因必须如实回报');
  assert.equal(r.detail.rotated, null);
  assert.equal(r.detail.keep, null, '轮转没跑成 → "生效份数"如实为 null，不猜一个数糊上去');
});

await t('默认参数与单点：backup.create 默认保留 30 份；库名走 DB_BASENAME 不硬编码', () => {
  assert.equal(TASK_DEFAULTS['backup.create'].keep, 30, '轮转要有默认值，否则"配了任务就自动有边界"不成立');

  const src = fs.readFileSync(new URL('../app/platform/operation/backup.mjs', import.meta.url), 'utf8');
  assert.ok(/dbEntry = DB_BASENAME \+ '\.enc'/.test(src),
    '包内加密库文件名必须来自 DB_BASENAME 单点（hardcode 会在下次改名时漏掉这里）');
  assert.ok(/path\.join\(dataDir, DB_BASENAME\)/.test(src), 'VACUUM 快照的源库路径同样必须走单点');

  // 反向：轮转原语**只**暴露在服务门面与任务执行体上，不得开成 HTTP 入口
  const routeSrc = fs.readFileSync(new URL('../app/http/routes/operation.mjs', import.meta.url), 'utf8');
  assert.ok(!/pruneBackups/.test(routeSrc), '删除备份不得有 HTTP 入口（误点即不可逆，轮转只走无人值守的定时任务）');
});

await t('端到端：真 operation 门面 + 真轮转 —— 新备份进、最旧的两份出，且门面确实暴露了轮转', async () => {
  const dataDir = path.join(tmp, 'prune-e2e');
  const bdir = path.join(dataDir, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  // 3 份"旧备份"（轮转只认文件名与 mtime，内容无关紧要）
  for (let i = 1; i <= 3; i++) {
    const f = path.join(bdir, `backup-2026-09-0${i}T00-00-00-000Z.zip`);
    fs.writeFileSync(f, 'x');
    const t0 = Date.UTC(2026, 8, i) / 1000;
    fs.utimesSync(f, t0, t0);
  }
  // 真库：备份会对它跑 VACUUM INTO
  const { DatabaseSync } = await import('node:sqlite');
  const fresh = new DatabaseSync(path.join(dataDir, DB_BASENAME));
  fresh.exec("CREATE TABLE probe (id TEXT PRIMARY KEY); INSERT INTO probe(id) VALUES ('a');");
  fresh.close();

  const before = new Set(fs.readdirSync(bdir));
  const audit = { seen: [], append(e) { this.seen.push(e); } };
  // ⚠️ 用**真**门面而不是桩 —— 这条同时钉住"门面真的暴露了 pruneBackups"这类装配缺陷
  // （桩会让"门面漏了方法"永远测不出来，正是 test-core 里"装配必须真的建这个服务"那条的思路）。
  const r = await runTask('backup.create', {
    tenantId: 't-e2e', params: { keep: 2 },
    deps: { operation: createOperationService({ dataDir, backupKey: crypto.randomBytes(32).toString('hex') }), governance: { audit } },
  });
  assert.equal(r.status, 'ok', '端到端必须成功：' + JSON.stringify(r.detail));
  assert.equal(r.detail.keep, 2);
  assert.ok(r.detail.bytes > 0, '真备份必须有内容');

  const after = fs.readdirSync(bdir);
  assert.equal(after.length, 2, 'keep=2 → 轮转后恰好剩 2 份：' + after.sort().join(', '));
  assert.equal(after.filter((n) => !before.has(n)).length, 1, '本次新建的备份必须还在（轮转不能把它自己删掉）');
  assert.ok(after.includes('backup-2026-09-03T00-00-00-000Z.zip'), '应保留"第二旧"那份 —— 删的是最旧的两份');
  assert.equal(audit.seen.filter((e) => e.action === 'operation.backup.prune').length, 1, '真服务路径同样要落审计');
});


/* ══════════════════════════════════════════════════════════════════
   M2 · 知识层纯函数
   ══════════════════════════════════════════════════════════════════ */

section('M2 · 解析器公共工具');

await t('stripBom：剥掉 UTF-8 BOM —— 不剥的话文件里第一个标题认不出来', () => {
  assert.equal(stripBom(BOM + '# 标题'), '# 标题');
  assert.equal(stripBom('# 本来就没有 BOM'), '# 本来就没有 BOM');
  assert.equal(stripBom(null), '');
  assert.equal(stripBom(BOM), '');
});

await t('joinWrapped：中文硬换行处**不加空格**（加了会把 bigram「限管」切断）', () => {
  assert.equal(joinWrapped(['权限', '管理']), '权限管理');
  assert.equal(joinWrapped(['hello', 'world']), 'hello world');
  assert.equal(joinWrapped(['中文', 'abc']), '中文 abc');
  assert.equal(joinWrapped(['abc', '中文']), 'abc 中文');
  assert.equal(joinWrapped(['  ', '甲']), '甲');
});

await t('decodeEntities：先解实体再切 bigram，否则 &amp; 这类噪声会污染索引', () => {
  assert.equal(decodeEntities('A&amp;B'), 'A&B');
  assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeEntities('&#x4e2d;&#25991;'), '中文');
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;');   // 不认识的保持原样，不猜
});

await t('splitSentences / estimateTokens：断句边界与 token 估算可用', () => {
  assert.deepEqual(splitSentences('第一句。第二句！第三句？'), ['第一句。', '第二句！', '第三句？']);
  assert.deepEqual(splitSentences('没有标点的一段'), ['没有标点的一段']);
  assert.ok(estimateTokens('中文四个字') >= 5);
  assert.ok(estimateTokens('abcdefgh') < estimateTokens('中文四个字') + 3);
});

section('M2 · Markdown / 纯文本解析');

await t('ATX 标题被识别为 heading，且 `#` 不残留在正文里', () => {
  const md = ['# 权限管理规范', '', '本规范描述权限模型。', '', '## 检索', '', '检索按组织隔离。', ''].join('\n');
  const r = parseText(Buffer.from(md, 'utf8'), { filename: 'a.md', markdown: true });
  const heads = r.blocks.filter((b) => b.kind === 'heading');
  assert.equal(heads.length, 2, '应识别出 2 个标题');
  assert.equal(heads[0].text, '权限管理规范');
  assert.equal(heads[0].level, 1);
  assert.equal(heads[1].level, 2);
  assert.equal(r.meta.format, 'markdown');
  assert.equal(r.parser, 'markdown');
  for (const b of r.blocks) assert.ok(!b.text.includes('#'), '标题标记不应留在块文本里：' + b.text);
});

await t('围栏代码块里的 `#` 不算标题', () => {
  const md = ['# 真标题', '', '```js', '# 这是代码里的井号', '```', '', '正文。', ''].join('\n');
  const r = parseText(Buffer.from(md, 'utf8'), { filename: 'a.md', markdown: true });
  const heads = r.blocks.filter((b) => b.kind === 'heading');
  assert.equal(heads.length, 1, '只有 1 个真标题');
  const code = r.blocks.filter((b) => b.kind === 'code');
  assert.equal(code.length, 1, '应有一个代码块');
  assert.ok(code[0].text.includes('这是代码里的井号'), '井号注释应留在代码块里');
});

await t('looksLikeMarkdown：只对真有 ATX 标题或围栏的文本为真（不能见谁都说是 Markdown）', () => {
  assert.equal(looksLikeMarkdown('# 标题\n正文'), true);
  assert.equal(looksLikeMarkdown('```\ncode\n```'), true);
  assert.equal(looksLikeMarkdown('就是一段普通中文，没有井号也没有围栏。'), false);
  assert.equal(looksLikeMarkdown('井号在中间 # 不在行首'), false);
});

section('M2 · CSV / TSV 解析');

await t('parseRows 是 RFC 4180 状态机：引号里的换行不会把一行拆成两行', () => {
  const rows = parseRows('姓名,备注\n张三,"第一行\n第二行"\n', ',');
  const zhang = rows.find((r) => r[0] === '张三');
  assert.ok(zhang, '应解析出「张三」这一行');
  assert.equal(zhang[1], '第一行\n第二行', '引号内的换行必须保留在同一格子里');
});

await t('detectDelimiter：按表头列数一致性投票，认不出来也不装作正常', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.equal(detectDelimiter('a;b;c\n1;2;3\n'), ';');
});

await t('每个数据行输出「列名：值；…」并带行号（按列名检索与按行回溯都要成立）', () => {
  const csv = '姓名,部门\n张三,市场部\n李四,技术部\n';
  const r = parseCsv(Buffer.from(csv, 'utf8'), { filename: '人员.csv' });
  assert.equal(r.parser, 'csv');
  assert.equal(r.meta.columns, 2);
  assert.equal(r.meta.rows, 2);
  const rowBlocks = r.blocks.filter((b) => b.kind === 'table');
  assert.equal(rowBlocks.length, 2);
  assert.equal(rowBlocks[0].text, '姓名：张三；部门：市场部');
  assert.equal(rowBlocks[0].loc.row, 2, '数据行从第 2 行开始（第 1 行是表头）');
  assert.equal(rowBlocks[1].loc.row, 3);
  assert.ok(r.blocks.some((b) => b.kind === 'table-header'), '表头本身也要可检索');
});

await t('列数不规则时给 warning，不静默截断', () => {
  const csv = 'a,b,c\n1,2\n3,4,5,6\n';
  const r = parseCsv(Buffer.from(csv, 'utf8'), { filename: 'x.csv' });
  assert.ok(r.warnings.some((w) => /列数与表头不一致/.test(w)), '应提示不规则行，实际：' + JSON.stringify(r.warnings));
});

section('M2 · JSON / JSONL 解析');

await t('叶子输出「路径 = 值」—— 最有检索价值的是路径，不是那一坨 JSON 花括号', () => {
  const obj = { 负责人: '张三', nested: { level: 2 }, tags: ['a', 'b'] };
  const r = parseJson(Buffer.from(JSON.stringify(obj), 'utf8'), { filename: 'a.json' });
  assert.equal(r.parser, 'json');
  const texts = r.blocks.map((b) => b.text);
  assert.ok(texts.includes('负责人 = 张三'), '缺少「负责人 = 张三」，实际：' + JSON.stringify(texts));
  assert.ok(texts.includes('nested.level = 2'), '缺少嵌套路径');
  assert.ok(texts.some((x) => /tags\[0\] = a/.test(x)), '数组元素应带下标');
  assert.ok(r.blocks.every((b) => b.kind === 'field'));
});

await t('整体不是合法 JSON 时自动退到 JSONL，并如实说明', () => {
  const r = parseJson(Buffer.from('{"a":1}\n{"a":2}\n', 'utf8'), { filename: 'a.jsonl' });
  assert.equal(r.parser, 'jsonl');
  assert.ok(r.warnings.some((w) => /JSON Lines/.test(w)), '应说明是按 JSONL 解析的');
  assert.equal(r.blocks.length, 2);
});

await t('两种都解析不了就抛错（带原始错误），**不能返回空内容冒充成功**', () => {
  assert.throws(
    () => parseJson(Buffer.from('这既不是 JSON 也不是 JSONL', 'utf8'), { filename: 'a.json' }),
    (e) => /JSON/.test(e.message)
  );
});

section('M2 · HTML 解析');

await t('head 里的内容（含 title）不得泄漏成正文，title 单独放进 meta', () => {
  const html = '<html><head><title>标题在此</title></head><body><p>正文在这里。</p></body></html>';
  const r = parseHtml(Buffer.from(html, 'utf8'), { filename: 'a.html' });
  assert.equal(r.meta.title, '标题在此');
  assert.ok(r.blocks.some((b) => b.text.includes('正文在这里')), '应抽出正文');
  for (const b of r.blocks) {
    assert.ok(!b.text.includes('标题在此'), 'title 不该出现在正文块里（否则会被当正文索引）');
  }
});

await t('表格带表头时渲染成「列名：值；…」', () => {
  const html = '<table><tr><th>姓名</th><th>部门</th></tr><tr><td>张三</td><td>市场部</td></tr></table>';
  const r = parseHtml(Buffer.from(html, 'utf8'), { filename: 'a.html' });
  const rows = r.blocks.filter((b) => b.kind === 'table');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '姓名：张三；部门：市场部');
  assert.ok(r.blocks.some((b) => b.kind === 'table-header'), '表头应单独成块');
});

await t('每个 li 各自成块（并成一块会让「条目二」无法单独被召回）', () => {
  const html = '<ul><li>条目一</li><li>条目二</li></ul>';
  const r = parseHtml(Buffer.from(html, 'utf8'), { filename: 'a.html' });
  const items = r.blocks.filter((b) => b.kind === 'list');
  assert.equal(items.length, 2, '应有两个 list 块，实际：' + JSON.stringify(r.blocks.map((b) => [b.kind, b.text])));
  assert.equal(items[0].text, '条目一');
  assert.equal(items[1].text, '条目二');
});

section('M2 · 格式判定与统一入口 parseDocument');

await t('扩展名优先于 mime（浏览器上传 .md 常报 text/plain，.csv 常报 excel）', () => {
  assert.equal(detectFormat('权限管理规范.md', 'text/plain'), 'markdown');
  assert.equal(detectFormat('人员.csv', 'application/vnd.ms-excel'), 'csv');
  assert.equal(detectFormat('a.TSV', ''), 'csv');
  assert.equal(detectFormat('a.jsonl', ''), 'json');
  assert.equal(detectFormat('', 'application/json'), 'json');
  assert.equal(detectFormat('a.zip', ''), 'unsupported');
  assert.equal(extOf('a.b.MD'), 'md');
});

await t('**只有文本、没有 buffer** 时也必须尊重格式线索（曾经这里一律按纯文本处理）', () => {
  // 真实缺陷：早先写成 `hasBuffer || !input.text ? detectFormat(...) : 'text'`，
  // 于是把 Markdown 粘进来（或按 .md 走文本接口）时，`# 标题` 原样留在正文里、
  // 标题层级丢失 → 分块的 headingPath 为空、locationKnown=false → 引用链退化。
  const md = '# 权限管理规范\n\n本规范描述权限模型。\n';
  const r = parseDocument({ text: md, filename: '权限管理规范.md' });
  assert.equal(r.parser, 'markdown', '带 .md 文件名的文本输入必须走 markdown 解析器，实际 ' + r.parser);
  assert.ok(r.blocks.some((b) => b.kind === 'heading'), '应识别出标题');
  assert.ok(!r.blocks.map((b) => b.text).join('').includes('# 权限管理'), '`#` 不该留在正文里');
});

await t('声明为纯文本但内容明显是 Markdown → 自动按 Markdown 切，并把判定写进 warnings', () => {
  const md = '# 数据治理\n\n所有数据必须登记。\n';
  const r = parseDocument({ text: md, filename: '笔记.txt' });
  assert.equal(r.parser, 'markdown');
  assert.ok(r.warnings.some((w) => /识别为 Markdown/.test(w)),
    '自动判定必须可审计，实际 warnings=' + JSON.stringify(r.warnings));
});

await t('有文本但格式识别不出来 → 退化为纯文本，不当成错误', () => {
  const r = parseDocument({ text: '就是一段没有格式线索的文字。', filename: '' });
  assert.equal(r.parser, 'text');
  assert.equal(r.blocks.length, 1);
});

await t('buffer 路径下不支持的格式要明确抛 unsupported_format（不把二进制当文本索引）', () => {
  assert.throws(
    () => parseDocument({ buffer: Buffer.from('PK\u0003\u0004 不是文本'), filename: 'x.zip' }),
    (e) => e.code === 'unsupported_format' && /不支持/.test(e.message)
  );
});

await t('parserCapabilities 如实列出能力与不支持项', () => {
  const cap = parserCapabilities();
  for (const f of ['text', 'markdown', 'csv', 'json', 'html']) assert.ok(cap.native.includes(f), '缺少原生格式 ' + f);
  for (const e of ['md', 'csv', 'json', 'html']) assert.ok(cap.nativeExtensions.includes(e), '缺少扩展名 ' + e);
  assert.equal(typeof cap.external.pdftotext.available, 'boolean', 'PDF 可用性必须是实测布尔值，不能是"应该有"');
  assert.equal(typeof cap.external.office.available, 'boolean');
  assert.ok(cap.notes.length > 0);
});

section('M2 · 分块器');

await t('标题边界必断，且每块带 headingPath（引用链靠它）', () => {
  const blocks = [
    { text: '甲章节', kind: 'heading', level: 2 },
    { text: '甲的内容。', kind: 'text' },
    { text: '乙章节', kind: 'heading', level: 2 },
    { text: '乙的内容。', kind: 'text' },
  ];
  const chunks = chunkBlocks(blocks, { ...DEFAULT_OPTIONS, minChars: 0, overlapChars: 0 });
  assert.equal(chunks.length, 2, '两个章节必须切成两块');
  assert.deepEqual(chunks[0].meta.headingPath, ['甲章节']);
  assert.deepEqual(chunks[1].meta.headingPath, ['乙章节']);
  assert.equal(chunks[0].meta.locationKnown, true);
});

await t('页边界必断（跨页合块会让「第 5 页」这个引用变成错的）', () => {
  const blocks = [
    { text: '第一页的内容甲。', kind: 'text', loc: { page: 1 } },
    { text: '第二页的内容乙。', kind: 'text', loc: { page: 2 } },
  ];
  const chunks = chunkBlocks(blocks, { ...DEFAULT_OPTIONS, minChars: 0, overlapChars: 0 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].meta.page, 1);
  assert.equal(chunks[1].meta.page, 2);
  assert.deepEqual(chunks[0].meta.pages, [1], '不得跨页');
});

await t('超长文本按 maxChars 切，相邻块有重叠且 charStart 单调不减', () => {
  const text = Array.from({ length: 40 }, (_, i) => '第' + (i + 1) + '句内容测试。').join('');
  const maxChars = 120;
  const chunks = chunkText(text, { maxChars, overlapChars: 30, minChars: 10, maxHeadingDepth: 3 });
  assert.ok(chunks.length > 1, '应切成多块');
  for (const c of chunks) {
    assert.ok(c.body.length <= maxChars + 60, '单块不应远超 maxChars，实际 ' + c.body.length);
    assert.ok(c.meta.charEnd > c.meta.charStart, 'charStart/charEnd 应是有效的半开区间');
  }
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].meta.charStart >= chunks[i - 1].meta.charStart, 'charStart 应单调不减');
  }
  const overlapped = chunks.slice(1).filter((c, i) => {
    const prev = chunks[i].body.replace(/\s+/g, '');
    return prev.length >= 8 && c.body.replace(/\s+/g, '').includes(prev.slice(-8));
  }).length;
  assert.ok(overlapped === chunks.length - 1,
    '每一块的开头都应带上上一块的尾部内容（实际只有 ' + overlapped + '/' + (chunks.length - 1) + ' 处有重叠）');
  assert.ok(chunks.slice(1).every((c) => c.meta.kinds.includes('overlap')),
    '重叠部分要被标出来（kinds 含 overlap），而不是伪装成原文');
});

await t('locationKnown：没有标题/页码/行号的块必须被标成"无定位信息"', () => {
  const none = chunkText('一段既没有标题也没有页码的普通文字。', { minChars: 0, overlapChars: 0 });
  assert.equal(none[0].meta.locationKnown, false, '无定位信息必须标出来（验收标准 ②）');

  const byRow = chunkBlocks([{ text: '姓名：张三', kind: 'table', loc: { row: 3 } }], { minChars: 0, overlapChars: 0 });
  assert.equal(byRow[0].meta.locationKnown, true, '行号也算定位信息（能回溯到第几行）');
  assert.equal(byRow[0].meta.rowStart, 3);
});

section('M2 · RRF 融合');

await t('RRF：两路都出现的排最前；分数 = Σ 1/(k+rank)，k 默认 60', () => {
  const lists = [
    { name: 'fts', items: [{ chunkId: 1 }, { chunkId: 2 }, { chunkId: 3 }] },
    { name: 'vector', items: [{ chunkId: 2 }, { chunkId: 1 }, { chunkId: 4 }] },
  ];
  const r = reciprocalRankFusion(lists, { limit: 10 });
  assert.equal(DEFAULT_RRF_K, 60);
  assert.equal(r.k, 60);
  // 1 与 2 都同时出现在两路 → 1/61 + 1/62，并列第一；
  // 3（只有 fts rank3）与 4（只有 vector rank3）都是 1/63 → 平局，按 chunkId 升序收尾。
  assert.deepEqual(r.items.map((x) => x.chunkId), [1, 2, 3, 4]);
  const top = r.items[0];
  assert.ok(Math.abs(top.rrf - (1 / 61 + 1 / 62)) < 1e-12, '首条应是两路相加，实际 ' + top.rrf);
  assert.ok(top.rrf > r.items[2].rrf * 2, '两路都命中的必须显著高于单路命中（否则融合没起作用）');
  assert.equal(top.contributions.fts.rank, 1);
  assert.equal(top.contributions.vector.rank, 2);
});

await t('平局按 chunkId 升序：同一查询两次结果顺序必须一致（否则回归测试没意义）', () => {
  const lists = [
    { name: 'fts', items: [{ chunkId: 7 }, { chunkId: 3 }] },
    { name: 'vector', items: [{ chunkId: 3 }, { chunkId: 7 }] },
  ];
  const a = reciprocalRankFusion(lists, { limit: 10 }).items.map((x) => x.chunkId);
  const b = reciprocalRankFusion([...lists].reverse(), { limit: 10 }).items.map((x) => x.chunkId);
  assert.deepEqual(a, [3, 7]);
  assert.deepEqual(a, b, '换一下列表顺序也不该改变结果的相对次序');
});

await t('normalizeRrfScores：归一化只影响展示，不改排序', () => {
  const lists = [{ name: 'fts', items: [{ chunkId: 1 }, { chunkId: 2 }] }];
  const items = reciprocalRankFusion(lists).items;
  const norm = normalizeRrfScores(items);
  assert.equal(norm[0].rrfNormalized, 1);
  assert.ok(norm[1].rrfNormalized < 1);
  assert.deepEqual(norm.map((x) => x.chunkId), items.map((x) => x.chunkId));
});

section('M2 · 向量降级（诚实边界）');

await t('normalizeMode：不认识的模式一律落到 none（宁可退化，也不猜用户想要什么）', () => {
  assert.deepEqual(EMBED_MODES, ['openai-compat', 'ollama', 'none']);
  assert.equal(normalizeMode('openai-compat'), 'openai-compat');
  assert.equal(normalizeMode('OLLAMA'), 'ollama');
  assert.equal(normalizeMode('azure'), 'none');
  assert.equal(normalizeMode(''), 'none');
  assert.equal(normalizeMode(undefined), 'none');
});

await t('未配置向量时 embed() 返回 null —— **绝不能返回零向量**（那会让向量路径看起来在工作）', async () => {
  const p = createEmbeddingProvider({ provider: 'none' });
  const r = await p.embed(['权限管理']);
  assert.equal(r, null);
  const d = p.describe();
  assert.equal(d.mode, 'none');
  assert.equal(d.hasApiKey, false);
  assert.ok(/纯文本/.test(d.note), 'describe 应说明会退化为纯文本检索');
});

await t('describe() 只报"有没有密钥"，绝不回显密钥值', () => {
  const secret = 'sk-SECRET-DO-NOT-LEAK-1234';
  const p = createEmbeddingProvider({
    provider: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: secret,
  });
  const d = p.describe();
  assert.equal(d.hasApiKey, true);
  assert.ok(!JSON.stringify(d).includes(secret), 'describe() 泄漏了密钥值');
  assert.ok(!JSON.stringify(d).includes('SECRET'), 'describe() 泄漏了密钥片段');
});

await t('向量服务不可达时抛明确错误（不是静默返回零向量，也不是假装成功）', async () => {
  const p = createEmbeddingProvider({
    provider: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', timeoutMs: 2000,
  });
  await assert.rejects(
    () => p.embed(['权限管理']),
    (e) => /embedding_unreachable|embedding_timeout|embedding_http_error/.test(String(e.code))
  );
  assert.ok(p.describe().lastError, '失败原因应能被 describe() 报出来');
});

/* ── M3：治理纯函数（用量周期边界） ───────────────────── */
section('M3 · 治理纯函数');

await t('periodStart：必须用 UTC 边界 —— 本地时区在 UTC+8 会把账错切 8 小时', () => {
  // day → 今天 UTC 零点；month → 本月 1 号 UTC 零点；total/未知 → null（不限时间）
  const day = periodStart('day');
  const month = periodStart('month');
  assert.match(day, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/, 'day 边界应是 UTC 零点');
  assert.match(month, /^\d{4}-\d{2}-01T00:00:00\.000Z$/, 'month 边界应是本月 1 号 UTC 零点');
  const now = new Date();
  assert.equal(day, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString());
  assert.equal(month, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString());
  assert.equal(periodStart('total'), null);
  assert.equal(periodStart('unknown-period'), null, '未知周期宁可不限时间，也不猜');
  // 与 nowIso()（toISOString）可比：边界 <= 现在
  assert.ok(day <= now.toISOString(), '边界必须早于等于当前时刻，否则把已发生的用量排除在账外');
});

await t('periodStart 不依赖 DB：纯函数可独立验证（保护它不被偷偷改成查库）', () => {
  // 这里没有初始化任何治理表 —— 若有人在这个函数里偷偷查库，本用例会直接抛错。
  assert.equal(typeof periodStart('day'), 'string');
});

/* ── M4：产物留存纯函数（ZIP 构建/读取 / 路径提取） ───────────────────── */
section('M4 · 产物留存纯函数');

await t('crc32：用教科书锚定向量钉住（"123456789" → 0xCBF43926）', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926 >>> 0);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

await t('zipSync → readZipEntries 往返：中文名、多层目录、二进制、不可压缩内容都完好', () => {
  const random = crypto.randomBytes(4096);   // 真随机：deflate 无收益，应退回 STORE
  const entries = [
    { name: 'meta.json', data: JSON.stringify({ hello: '世界', n: 1 }) },
    { name: 'logs/events.jsonl', data: '{"a":1}\n{"a":2}\n' },
    { name: 'bin/gray.wav', data: random },          // 伪随机 → 压缩无收益，应退回 STORE
    { name: '中文 目录/报告.txt', data: '产物留存的往返测试' },
  ];
  const zip = zipSync(entries);
  // ZIP 魔数：local header 以 PK\x03\x04 开头、EOCD 以 PK\x05\x06 结尾
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  const read = readZipEntries(zip);
  assert.equal(read.length, 4);
  for (let i = 0; i < entries.length; i++) {
    assert.equal(read[i].name, entries[i].name);
    const expect = Buffer.isBuffer(entries[i].data) ? entries[i].data : Buffer.from(entries[i].data, 'utf8');
    assert.ok(read[i].data.equals(expect), '条目内容必须逐字节一致：' + entries[i].name);
  }
  // 伪随机数据应该走了 STORE（method 0）：deflate 收益为负时绝不硬压
  const gray = read.find((e) => e.name === 'bin/gray.wav');
  assert.equal(gray.method, 0, '不可压缩数据应退回 STORE，而不是白白膨胀');
});

await t('readZipEntries：坏输入必须抛明确错误（不猜着解析）', () => {
  assert.throws(() => readZipEntries(Buffer.from('这不是 zip')), /ZIP/);
  assert.throws(() => readZipEntries(Buffer.alloc(10)), /ZIP/);
  // ZIP 头 + 垃圾 EOCD → 找不到 central directory
  const junk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 7)]);
  assert.throws(() => readZipEntries(junk), /central directory|ZIP/);
  assert.throws(() => zipSync([]), /至少要有一个条目/);
});

await t('extractPaths：Windows / POSIX 都能提，URL 与孤立斜杠不误报，句尾标点不吞进路径', () => {
  // Windows（正斜杠与反斜杠）
  assert.deepEqual(extractPaths('报告在 C:\\Users\\lw\\Desktop\\报告.txt 里'),
    ['C:\\Users\\lw\\Desktop\\报告.txt']);
  assert.deepEqual(extractPaths('写到 D:/data/out.json 即可'), ['D:/data/out.json']);
  // POSIX：内部点号必须保住（/var/log/app.log 不能被截成 /var/log/app.lo）
  assert.deepEqual(extractPaths('日志在 /var/log/app.log，请查看'), ['/var/log/app.log']);
  // 句尾标点：/tmp/x. → /tmp/x（结尾的句号不是路径的一部分）
  assert.deepEqual(extractPaths('先写 /tmp/x. 再说'), ['/tmp/x']);
  // URL 不误报（:// 后面不触发 POSIX 规则）
  assert.deepEqual(extractPaths('参考 https://example.com/a/b 的说明'), []);
  // 孤立斜杠 / 单字符不算路径
  assert.deepEqual(extractPaths('根目录 / 之下'), []);
  // 去重且保序
  assert.deepEqual(extractPaths('/a/b.txt 然后 /a/b.txt'), ['/a/b.txt']);
  // 空输入
  assert.deepEqual(extractPaths(null), []);
  assert.deepEqual(extractPaths(''), []);
});

/* ── M4：能力可见性纯函数（二级 allow/deny 判定穷举） ─────────────────── */
section('M4 · 能力可见性纯函数（decideMcpVisibility / decideSkillVisibility / bindingsForSubject / extractZip 防穿越）');

await t('decideMcpVisibility：默认放行；血缘 deny 全部赢过 allow；服务名非法一律拒', () => {
  // 默认放行（无绑定）
  assert.deepEqual(
    decideMcpVisibility({ serverName: 'svc', bindings: [] }),
    { visible: true, reason: 'default' });
  // ⚠️ 0.21.10：MCP 不再借道工具判定，因此这里**不再有** registry_disabled 这一档 ——
  //    mcp_servers.enabled 是连接配置（配好了才有这个服务），不是可见性开关。
  //    这条断言就是"闸门归位"的钉子：谁把 registryEnabled 重新塞回来，它会立刻红。
  assert.equal(decideMcpVisibility({ serverName: 'svc', bindings: [], registryEnabled: false }).reason,
    'default');
  // 各层 deny 都赢过其他层的 allow（deny 优先与层顺序无关）
  //
  // ⚠️ 0.21.10：这个循环里原本有两档 —— `server` 与 `connection`。工具那套
  //    `tool → server → connection` 三层血缘一删，MCP 只剩 **server 一层**
  //    （服务名就是绑定标识，见 visibility.mjs 头注释）。`connection` 仍留在
  //    `BINDING_LEVELS` 里，但它现在**没有判定含义**：没有哪个函数会去读
  //    `capability_type='connection'` 的行。所以这里不能再用它来断言
  //    "deny 赢" —— 它给出的 `default` 不是 bug，而是"这一层不参与判定"。
  //    下面补一条**反向断言**把这个事实钉住：connection 层写 deny 也不生效，
  //    谁将来把 connection 接回 MCP 判定，这条会立刻红、逼他先想清楚为什么。
  for (const [level, meta, lineageId] of [
    ['server', { serverName: 'svc' }, 'svc'],
  ]) {
    // 被测层一条 deny；更具体的层给 allow —— deny 仍必须赢
    const bindings = [{ capability_type: level, capability_id: lineageId, allow: 0 }];
    if (level !== 'server') bindings.push({ capability_type: 'server', capability_id: 'svc', allow: 1 });
    const v = decideMcpVisibility({ ...meta, bindings });
    assert.equal(v.visible, false, level + ' 层 deny 必须赢');
    assert.equal(v.reason, 'deny:' + level);
  }
  // 反向断言：`connection` 层不参与 MCP 判定（它只是 BINDING_LEVELS 里的合法取值，
  // 不是 MCP 的血缘）。写了 deny 也照样 default —— 这是**当前设计**，不是漏判。
  assert.deepEqual(
    decideMcpVisibility({ serverName: 'svc', bindings: [{ capability_type: 'connection', capability_id: 'conn', allow: 0 }] }),
    { visible: true, reason: 'default' });
  // 显式 allow（无 deny）→ explicit_allow
  assert.deepEqual(
    decideMcpVisibility({ serverName: 'svc', bindings: [{ capability_type: 'server', capability_id: 'svc', allow: 1 }] }),
    { visible: true, reason: 'explicit_allow' });
  // 无关绑定不干扰
  assert.deepEqual(
    decideMcpVisibility({ serverName: 'svc', bindings: [{ capability_type: 'server', capability_id: 'other', allow: 0 }] }),
    { visible: true, reason: 'default' });
  // 无名服务一律拒绝
  assert.equal(decideMcpVisibility({ serverName: '', bindings: [] }).visible, false);
  assert.equal(decideMcpVisibility({ serverName: '', bindings: [] }).reason, 'invalid_server');
  // 工具名不再被任何判定接受：'tool' 这一层已经不存在，混进来的行必须完全无效
  assert.deepEqual(
    decideMcpVisibility({ serverName: 'svc', bindings: [{ capability_type: 'tool', capability_id: 'svc', allow: 0 }] }),
    { visible: true, reason: 'default' });
});

await t('decideSkillVisibility 与 bindingsForSubject：主体展开（tenant/user/role）正确', () => {
  // ⚠️ Skill 有自己的实现（0.21.10 前是 return decideToolVisibility(...) 转发）；
  //    registry_disabled 这一档是 Skill 独有的 —— 它以 skill_registry 登记表为准。
  assert.deepEqual(
    decideSkillVisibility({ skill: { name: 's' }, bindings: [], registryEnabled: false }),
    { visible: false, reason: 'registry_disabled' });
  assert.equal(decideSkillVisibility({ skill: { name: '' }, bindings: [] }).reason, 'invalid_skill');
  assert.deepEqual(
    decideSkillVisibility({ skill: { name: 's' }, bindings: [{ capability_type: 'skill', capability_id: 's', allow: 0 }] }),
    { visible: false, reason: 'deny:skill' });
  assert.deepEqual(
    decideSkillVisibility({ skill: { name: 's' }, bindings: [{ capability_type: 'skill', capability_id: 's', allow: 1 }] }),
    { visible: true, reason: 'explicit_allow' });

  // 主体展开用 server/skill 两种仍然存在的层，避免测试把已删除的 'tool' 层"养"回来
  const rows = [
    { subject_type: 'tenant', subject_id: 't1', capability_type: 'server', capability_id: 'a', allow: 0 },
    { subject_type: 'user', subject_id: 'u1', capability_type: 'server', capability_id: 'a', allow: 1 },
    { subject_type: 'role', subject_id: 'dev', capability_type: 'server', capability_id: 'a', allow: 1 },
    { subject_type: 'user', subject_id: 'u2', capability_type: 'server', capability_id: 'a', allow: 0 },
  ];
  // tenant 主体只吃 tenant 行
  const forTenant = bindingsForSubject(rows, { tenantId: 't1' });
  assert.equal(forTenant.length, 1);
  // u1（dev 角色）吃 tenant + user(u1) + role(dev)
  const forU1 = bindingsForSubject(rows, { tenantId: 't1', userId: 'u1', roles: ['dev'] });
  assert.equal(forU1.length, 3);
  // u2 吃 tenant + user(u2)，不含 role(dev)
  const forU2 = bindingsForSubject(rows, { tenantId: 't1', userId: 'u2', roles: [] });
  assert.equal(forU2.length, 2);
  // 未知 subject_type 的行一律不生效
  assert.equal(bindingsForSubject([{ subject_type: 'galaxy', subject_id: 'x' }], { tenantId: 't1' }).length, 0);
});

await t('extractZip：路径穿越条目（../、绝对路径、盘符）必须拒绝，正常包解出真实文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-zip-'));
  try {
    const zip = zipSync([
      { name: 'a/b.txt', data: Buffer.from('1') },
      { name: 'c.txt', data: Buffer.from('22') },
    ]);
    const written = extractZip(zip, dir);
    assert.equal(written.length, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'a', 'b.txt'), 'utf8'), '1');
    // 三种穿越形态全部拒绝
    for (const evil of ['../evil.txt', '/abs.txt', 'C:win.ini']) {
      assert.throws(() => extractZip(zipSync([{ name: evil, data: Buffer.from('x') }]), dir), /越界/,
        evil + ' 必须被拒绝');
    }
    // 拒绝时不留半成品文件
    assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 4.6 知识库级 ACL ────────────────────────────────────── */

section('4.6 · 知识库级 ACL（库级可见性 + 库级授权）');

await t('可见性取值规范化：默认 tenant；给了非法值**抛错**而不是静默按公开处理', () => {
  assert.equal(normalizeVisibility(undefined), 'tenant');
  assert.equal(normalizeVisibility(null), 'tenant');
  assert.equal(normalizeVisibility(''), 'tenant');
  assert.equal(normalizeVisibility(' RESTRICTED '), 'restricted');
  assert.equal(normalizeVisibility('tenant'), 'tenant');
  for (const bad of ['restrict', 'private', 'public', 'TENANT_ONLY', '1']) {
    // 静默回退的后果：管理员本意"收紧"，打错一个字母 → 系统按**公开**处理且毫无提示
    assert.throws(() => normalizeVisibility(bad), /未知的可见性/, bad + ' 必须当场报错');
  }
});

await t('判定表：tenant 恒可见；restricted 需授权；管理员防自锁；库级角色只放宽本库', () => {
  const T = { visibility: 'tenant' };
  const R = { visibility: 'restricted' };

  // tenant 库：登录主体恒可见（读权限由路由层 `knowledge:read` 把守）
  assert.deepEqual(decideBaseAccess({ base: T, globalRoles: ['viewer'] }),
    { visible: true, level: 'read', reason: 'tenant' });
  assert.equal(decideBaseAccess({ base: T, globalRoles: ['member'] }).level, 'read');
  assert.equal(decideBaseAccess({ base: T, globalRoles: ['admin'] }).level, 'write');
  assert.equal(decideBaseAccess({ base: T, globalRoles: ['owner'] }).level, 'manage');
  // 缺 visibility 字段（未 SELECT 到 / 更早的历史行）按默认 tenant 处理
  assert.equal(decideBaseAccess({ base: {}, globalRoles: ['viewer'] }).visible, true);

  // restricted 库：未授权 → 不可见
  const denied = decideBaseAccess({ base: R, globalRoles: ['member'] });
  assert.equal(denied.visible, false);
  assert.equal(denied.reason, 'restricted_denied');

  // 授权后可见；档位由**库级角色**决定（与全局角色取并集，且只在**本库**生效）
  const asViewer = decideBaseAccess({ base: R, globalRoles: ['member'], scopedRoleKeys: ['viewer'] });
  assert.equal(asViewer.visible, true);
  assert.equal(asViewer.level, 'read');
  assert.equal(decideBaseAccess({ base: R, globalRoles: ['member'], scopedRoleKeys: ['admin'] }).level, 'write');

  // 管理员对受限库始终可见 —— 否则一次"以为安全的收紧"会让库变成没人能改回来的孤岛
  const adminOnR = decideBaseAccess({ base: R, globalRoles: ['admin'] });
  assert.equal(adminOnR.visible, true);
  assert.equal(adminOnR.reason, 'restricted_admin');

  // 库内写权限的边界
  assert.equal(canAccessBase({ base: T, globalRoles: ['member'], action: 'write' }).allowed, false);
  assert.equal(canAccessBase({ base: R, globalRoles: ['member'], scopedRoleKeys: ['viewer'], action: 'write' }).allowed, false,
    'viewer 档不能写');
  assert.equal(canAccessBase({ base: R, globalRoles: ['member'], scopedRoleKeys: ['admin'], action: 'write' }).allowed, true,
    '库级 admin 能在**本库**写');
  // ⚠️ "可见但档位不够"必须能区分于"不可见"（一个 403、一个 404）。
  //    曾因 canAccessBase 漏带 visible 字段，`!undefined === true` 把全部 403 退化成 404。
  assert.equal(canAccessBase({ base: T, globalRoles: ['member'], action: 'write' }).visible, true);
  assert.equal(canAccessBase({ base: R, globalRoles: ['member'], action: 'read' }).visible, false);
});

await t('visibleBases：按库展开授权，**库级角色不外溢**到别的库', () => {
  const list = [
    { id: 'b1', visibility: 'tenant' },
    { id: 'b2', visibility: 'restricted' },
    { id: 'b3', visibility: 'restricted' },
  ];
  const seen = visibleBases(list, { globalRoles: ['member'], scopedRoles: [{ scopeId: 'b2', roleKey: 'viewer' }] });
  assert.deepEqual(seen.map((x) => x.base.id), ['b1', 'b2'], '只在 b2 被授权 → b3 不可见（授权不可外溢）');
  assert.equal(seen.find((x) => x.base.id === 'b2').level, 'read');
  // 顺序保持入参顺序（过滤不该打乱列表页）
  assert.deepEqual(visibleBases(list, { globalRoles: ['admin'] }).map((x) => x.base.id), ['b1', 'b2', 'b3']);
});

await t('迁移 0013：visibility 列存在，且**存量行落在 tenant**（升级后行为与升级前一致）', () => {
  const cols = db.all('PRAGMA table_info(knowledge_bases)').map((c) => c.name);
  assert.ok(cols.includes('visibility'), 'knowledge_bases 必须有 visibility 列');
  const o = orgRepo.createOrg({ name: '迁移探针公司', slug: 'mig-probe' });
  // 显式**不写** visibility 的 INSERT = 模拟"0013 之前就存在的历史行"
  db.run(
    'INSERT INTO knowledge_bases (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)',
    ['kb_legacy_probe', o.id, '历史库', new Date().toISOString()]
  );
  const row = db.get('SELECT visibility FROM knowledge_bases WHERE id = ?', ['kb_legacy_probe']);
  assert.equal(row.visibility, 'tenant', '默认必须是 tenant —— 默认 restricted 会让升级即"全组织看不见"');
  // 默认值本身也钉住（未来有人改动迁移里的 DEFAULT，这里立刻红）
  const dflt = db.get("SELECT dflt_value AS v FROM pragma_table_info('knowledge_bases') WHERE name = 'visibility'");
  assert.equal(String(dflt.v).replace(/'/g, ''), 'tenant');
});

await t('迁移 0021：workspaces 表存在；agent_sessions 有 workspace_id / reasoning_effort 列', () => {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  assert.ok(tables.includes('workspaces'), 'workspaces 表必须在（0021）');
  const cols = db.all('PRAGMA table_info(agent_sessions)').map((c) => c.name);
  assert.ok(cols.includes('workspace_id'), 'agent_sessions.workspace_id 必须在（0.21.0）');
  assert.ok(cols.includes('reasoning_effort'), 'agent_sessions.reasoning_effort 必须在（0.21.0）');
  // 存量行形状：workspace_id 为 NULL（未分组）—— 0.21.0 前的老会话行为逐字不变
  // 迁移 0023：workspaces.visibility 已删 —— 平台不再持有"第二份工作区权限真相"。
  // 钉住"列已不存在"：否则 0023 被回退、或迁移顺序被打乱时，这里会静默通过。
  const wsCols = db.all('PRAGMA table_info(workspaces)').map((c) => c.name);
  assert.ok(!wsCols.includes('visibility'),
    'workspaces.visibility 应当已被迁移 0023 删除 —— 上游 dsh 自己有一份工作区权限三档，'
    + '而平台没有任何接口能改那一份；留着这份配置只会让人以为已经管住了');
});

await t('端到端：受限库对未授权成员不可见 → 授权后可见 → 撤权后又不可见', async () => {
  const o = orgRepo.createOrg({ name: 'ACL 公司', slug: 'acl-corp' });
  roleRepo.ensureBuiltinRoles(o.id);
  const idSvc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const admin = await idSvc.createUser({ orgId: o.id, username: 'acl_admin', password: 'Adm1n-Pass!23', roleKeys: ['admin'] });
  const member = await idSvc.createUser({ orgId: o.id, username: 'acl_member', password: 'Memb3r-Pass!23', roleKeys: ['member'] });
  assert.deepEqual(member.roles, ['member']);

  const kbSvc = createKnowledgeService({
    config: { values: {} },
    identity: idSvc,
    resolveScopedRoles: (userId, scopeType) => idSvc.scopedRolesForUser(userId, scopeType),
  });
  try {
    const aSub = { userId: admin.id, roles: admin.roles };
    const mSub = { userId: member.id, roles: member.roles };

    const openBase = kbSvc.createBase({ tenantId: o.id, name: '公开库' });
    const pinBase = kbSvc.createBase({ tenantId: o.id, name: '财务库', visibility: 'restricted' });
    assert.equal(pinBase.visibility, 'restricted', '受限库要真的落成 restricted');

    // ① 未授权成员：只看得到公开库
    const before = kbSvc.listBases(o.id, mSub).map((b) => b.id);
    assert.ok(before.includes(openBase.id));
    assert.ok(!before.includes(pinBase.id), '受限库不得出现在未授权成员的列表里（不是"返回后前端不显示"）');

    // ② 未授权成员直接按 id 访问受限库 → 404（不可见按不存在处理，不确认存在性）
    assert.throws(() => kbSvc.getBase(o.id, pinBase.id, mSub), (e) => e.code === 'not_found');
    await assert.rejects(
      () => kbSvc.search({ tenantId: o.id, userId: member.id, roles: member.roles, query: '报销', kbIds: [pinBase.id] }),
      (e) => e.code === 'forbidden',
      '按 id 硬指定受限库也必须被挡（否则列表与检索之间就有一条裂缝）'
    );

    // ③ 同一成员对**公开库**的写也要被拒（member 无 knowledge:write）—— 既有语义不能被 ACL 削弱
    await assert.rejects(
      () => kbSvc.ingest({ tenantId: o.id, userId: member.id, roles: member.roles, kbId: openBase.id, text: '成员注入' }),
      (e) => e.code === 'forbidden',
      '成员对公开库仍是只读（语料投毒防线不变）'
    );

    // ④ 授权 viewer → 可见、可读、仍不可写
    const grant = kbSvc.grantBase({
      tenantId: o.id, kbId: pinBase.id, subjectType: 'user', subjectId: member.id, roleKey: 'viewer', subject: aSub,
    });
    assert.ok(grant && grant.id, '授权应返回绑定行');
    const after = kbSvc.listBases(o.id, mSub);
    const pinView = after.find((b) => b.id === pinBase.id);
    assert.ok(pinView, '授权后受限库应出现在列表里');
    assert.equal(pinView.accessLevel, 'read', 'viewer 档 = 只读');
    assert.equal(kbSvc.listDocuments(o.id, pinBase.id, {}, mSub).total, 0, '能读（空库）');
    await assert.rejects(
      () => kbSvc.ingest({ tenantId: o.id, userId: member.id, roles: member.roles, kbId: pinBase.id, text: '想写' }),
      (e) => e.code === 'forbidden',
      'viewer 档不能写'
    );

    // ⑤ 升到库级 admin → 能在**本库**写，且**只在**本库
    kbSvc.grantBase({ tenantId: o.id, kbId: pinBase.id, subjectType: 'user', subjectId: member.id, roleKey: 'admin', subject: aSub });
    const r = await kbSvc.ingest({ tenantId: o.id, userId: member.id, roles: member.roles, kbId: pinBase.id, text: '财务制度：报销需三人审批。' });
    assert.ok(r && (r.document || r.duplicate), '库级 admin 应能写入本库');
    assert.equal(kbSvc.listDocuments(o.id, pinBase.id, {}, mSub).total, 1);
    // 但公开库的写档**没变**（member 全局仍只有 read）
    await assert.rejects(
      () => kbSvc.ingest({ tenantId: o.id, userId: member.id, roles: member.roles, kbId: openBase.id, text: '越界' }),
      (e) => e.code === 'forbidden',
      '库级授权只能放宽**被授权的那个库**，不得波及其它库'
    );

    // ⑥ 撤销全部授权 → 又看不见了
    for (const b of kbSvc.listBaseGrants(o.id, pinBase.id, aSub)) {
      kbSvc.revokeBaseGrant({ tenantId: o.id, kbId: pinBase.id, bindingId: b.id, subject: aSub });
    }
    assert.ok(!kbSvc.listBases(o.id, mSub).some((b) => b.id === pinBase.id), '撤权后必须重新不可见');

    // ⑦ 管理员始终看得见（防自锁）
    assert.ok(kbSvc.listBases(o.id, aSub).some((b) => b.id === pinBase.id), '管理员不得把自己锁在库外');
  } finally {
    await kbSvc.close();
  }
});

await t('跨库越权撤权被拒：拿别的库的 bindingId 撤不动本库授权', async () => {
  const o = orgRepo.createOrg({ name: 'ACL 越权公司', slug: 'acl-x' });
  roleRepo.ensureBuiltinRoles(o.id);
  const idSvc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const admin = await idSvc.createUser({ orgId: o.id, username: 'acl_x_admin', password: 'Adm1n-Pass!23', roleKeys: ['admin'] });
  const member = await idSvc.createUser({ orgId: o.id, username: 'acl_x_member', password: 'Memb3r-Pass!23', roleKeys: ['member'] });
  const kbSvc = createKnowledgeService({
    config: { values: {} },
    identity: idSvc,
    resolveScopedRoles: (userId, scopeType) => idSvc.scopedRolesForUser(userId, scopeType),
  });
  try {
    const aSub = { userId: admin.id, roles: admin.roles };
    const b1 = kbSvc.createBase({ tenantId: o.id, name: '库一', visibility: 'restricted' });
    const b2 = kbSvc.createBase({ tenantId: o.id, name: '库二', visibility: 'restricted' });
    const g2 = kbSvc.grantBase({ tenantId: o.id, kbId: b2.id, subjectType: 'user', subjectId: member.id, roleKey: 'viewer', subject: aSub });

    // 用 b2 的授权 id 去走 b1 的接口 → 必须 404（绑定归属校验不能靠"调用方给对了 kbId"）
    assert.throws(
      () => kbSvc.revokeBaseGrant({ tenantId: o.id, kbId: b1.id, bindingId: g2.id, subject: aSub }),
      (e) => e.code === 'not_found'
    );
    assert.ok(kbSvc.listBaseGrants(o.id, b2.id, aSub).length === 1, '越权尝试不得真的删掉那条授权');

    // 反向：授权名单是敏感信息 —— 未授权成员不能读（403，不是 404：库本身对他不可见 → 走 404）
    assert.throws(() => kbSvc.listBaseGrants(o.id, b2.id, { userId: member.id, roles: member.roles }));
  } finally {
    await kbSvc.close();
  }
});

await t('授权主体必须真实存在且属于本组织：不存在的 id 要 404，不能是 500（§B9 新增护栏）', async () => {
  // 为什么需要这条：仓储层的 `bindRole` 会校验主体存在与同组织，但它抛的是**裸 Error**，
  // 出网会被 `toHttpError` 收敛成 `500 internal_error` —— 于是"这个人已经被删了"在调用方
  // 看到的是"服务器坏了"。授权入口有界面之后（§B9），下拉里的 id 在"页面加载之后那个人
  // 被删掉"这种竞态下会陈旧，这条路**真实可达**。修法是在**服务层**把它翻译成带 HTTP 语义的
  // 错误（仓储抛裸 Error、服务层翻译 —— 见 util/errors.mjs 顶部那条纪律）。
  const o = orgRepo.createOrg({ name: '授权主体校验公司', slug: 'acl-subj' });
  roleRepo.ensureBuiltinRoles(o.id);
  const other = orgRepo.createOrg({ name: '别家公司', slug: 'acl-subj-x' });
  roleRepo.ensureBuiltinRoles(other.id);
  const idSvc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const admin = await idSvc.createUser({ orgId: o.id, username: 'acl_s_admin', password: 'Adm1n-Pass!23', roleKeys: ['admin'] });
  const outsider = await idSvc.createUser({ orgId: other.id, username: 'acl_s_out', password: 'Adm1n-Pass!23', roleKeys: ['admin'] });
  const kbSvc = createKnowledgeService({
    config: { values: {} },
    identity: idSvc,
    resolveScopedRoles: (userId, scopeType) => idSvc.scopedRolesForUser(userId, scopeType),
  });
  try {
    const aSub = { userId: admin.id, roles: admin.roles };
    const kb = kbSvc.createBase({ tenantId: o.id, name: '财务库', visibility: 'restricted' });
    const grant = (subjectType, subjectId) => kbSvc.grantBase({
      tenantId: o.id, kbId: kb.id, subjectType, subjectId, roleKey: 'viewer', subject: aSub,
    });

    // ① 不存在的用户 / 组 → 404（不是 500）
    assert.throws(() => grant('user', 'no_such_user'),
      (e) => e.code === 'not_found' && e.httpStatus === 404,
      '不存在的用户应 404/not_found，不能是 500 internal_error');
    assert.throws(() => grant('group', 'no_such_group'), (e) => e.code === 'not_found',
      '不存在的组应 404');

    // ② **存在于别的组织**的主体也按不存在处理（404）。
    //    不能回 400/403 说"跨组织绑定被拒绝" —— 那就等于确认"这个 id 在别处存在"，
    //    这里会变成一个跨租户 id 探测器（与 revokeScopedRole 同一条纪律）。
    assert.throws(() => grant('user', outsider.id), (e) => e.code === 'not_found',
      '别的组织的用户必须按"不存在"处理，不得回一句"跨组织绑定被拒绝"');

    // ③ 空主体 → 400（请求本身不对，不是"资源不存在"）
    assert.throws(() => grant('user', ''), (e) => e.code === 'bad_request', '空 subjectId 应 400');
    assert.throws(() => grant('user', '   '), (e) => e.code === 'bad_request', '纯空白 subjectId 也应 400');

    // ④ 未知角色 → 400。这里刻意把"角色打错"和"主体也不存在"放在同一个请求里，
    //    钉住**校验顺序**：先查参数形状（角色 key 是否已知）、再查资源存在性（主体是否存在）。
    //    一个两者都错的请求，说"请求参数有误"比说"用户不存在"更接近事实。
    assert.throws(
      () => kbSvc.grantBase({
        tenantId: o.id, kbId: kb.id, subjectType: 'user',
        subjectId: 'no_such_user', roleKey: 'not_a_role', subject: aSub,
      }),
      (e) => e.code === 'bad_request',
      '未知角色应 400，且优先于"主体不存在"报出来'
    );

    // ⑤ 被拒的授权一律不得落库 —— "静默存下一条永不生效的授权"是最难查的形态
    assert.equal(kbSvc.listBaseGrants(o.id, kb.id, aSub).length, 0, '被拒的授权不得留下任何绑定');

    // ⑥ 正路仍然通：授权成功后可列、可撤
    const g = grant('user', admin.id);
    assert.ok(g && g.id, '合法授权应返回绑定行');
    assert.equal(kbSvc.listBaseGrants(o.id, kb.id, aSub).length, 1);
    kbSvc.revokeBaseGrant({ tenantId: o.id, kbId: kb.id, bindingId: g.id, subject: aSub });
    assert.equal(kbSvc.listBaseGrants(o.id, kb.id, aSub).length, 0);
  } finally {
    await kbSvc.close();
  }
});

await t('知识库改名（0.13.0 补出口）：需该库 write 档、空名 400、变更入审计、看不见仍 404', async () => {
  // 为什么补它：`renameBase` 在仓储层 0.11.0 就写好了，但**一条出口都没有** ——
  // "删库"都能点，"改个名字"反而不能，属 A2(b)「有实现没出口」里最不该留着的那一类。
  const o = orgRepo.createOrg({ name: '改名公司', slug: 'kb-rename' });
  roleRepo.ensureBuiltinRoles(o.id);
  const idSvc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const admin = await idSvc.createUser({ orgId: o.id, username: 'kb_rn_admin', password: 'Adm1n-Pass!23', roleKeys: ['admin'] });
  const member = await idSvc.createUser({ orgId: o.id, username: 'kb_rn_member', password: 'Memb3r-Pass!23', roleKeys: ['member'] });
  const audits = [];
  const kbSvc = createKnowledgeService({
    config: { values: {} },
    identity: idSvc,
    resolveScopedRoles: (userId, scopeType) => idSvc.scopedRolesForUser(userId, scopeType),
    audit: { append: (e) => audits.push(e) },
  });
  try {
    const aSub = { userId: admin.id, roles: admin.roles };
    const kb = kbSvc.createBase({ tenantId: o.id, name: '原名', visibility: 'restricted' });

    // ① 管理员改名成功，两端空白去掉，且**落审计**
    //    （名字是所有人识别这个库的依据，被悄悄改掉之后别人会以为库换了一个 —— 必须有痕迹）
    const auditBefore = audits.length;
    const r = kbSvc.renameBase(o.id, kb.id, '  新名字  ', aSub);
    assert.equal(r.name, '新名字', '两端空白应被去掉');
    assert.equal(audits.length, auditBefore + 1, '改名必须落一条审计');
    assert.equal(audits[audits.length - 1].action, 'knowledge.base.rename');

    // ② 空名 / 纯空白 → 400（请求不对，不是"库不存在"）
    assert.throws(() => kbSvc.renameBase(o.id, kb.id, '   ', aSub), (e) => e.code === 'bad_request');
    // ③ 过长 → 400（上限 120，防把列表撑爆）
    assert.throws(() => kbSvc.renameBase(o.id, kb.id, 'x'.repeat(121), aSub), (e) => e.code === 'bad_request');

    // ④ 档位：改名要**该库** write 档。受限库对未授权成员不可见 → **404**（与库级授权同一口径，不是 403）
    assert.throws(
      () => kbSvc.renameBase(o.id, kb.id, '偷改的人', { userId: member.id, roles: member.roles }),
      (e) => e.code === 'not_found',
      '对看不见这个库的人，改名要走 404（存在性本身是信息，不确认它存在）'
    );
    // ⑤ 被拒的调用不得真的把名字改掉
    assert.equal(kbSvc.getBase(o.id, kb.id, aSub).name, '新名字');
  } finally {
    await kbSvc.close();
  }
});

await t('写路径的权限判定**下移到服务层**（否则库级管理员永远进不来）', () => {
  const src = fs.readFileSync(new URL('../app/http/routes/knowledge.mjs', import.meta.url), 'utf8');
  const capOf = (id) => {
    const i = src.indexOf("id: '" + id + "'");
    assert.ok(i > 0, '路由表里必须还有 ' + id);
    const m = /capability:\s*\[([^\]]*)\]/.exec(src.slice(i, i + 900));
    return m ? m[1] : '';
  };
  // 库内写：路由门只能是 knowledge:read，真正的"能不能动这个库"由服务层按库判定。
  // 理由：rbac 中间件只看**租户级**角色，而"某人在某个库上被授了 admin"只有服务层知道。
  assert.ok(capOf('knowledge.documents').includes('knowledge:read'));
  assert.ok(!capOf('knowledge.documents').includes('knowledge:write'),
    '若改回 knowledge:write，库级管理员会被路由层挡死（4.6 等于没做）');
  assert.ok(!capOf('knowledge.documents.delete').includes('knowledge:delete'));
  assert.ok(!capOf('knowledge.bases.update').includes('knowledge:write'));
  assert.ok(!capOf('knowledge.bases.grants.create').includes('knowledge:write'));
  // 组织级动作仍在路由层把门（这些不该被下放）
  assert.ok(capOf('knowledge.bases.create').includes('knowledge:write'), '建库是组织级动作');
  assert.ok(capOf('knowledge.bases.delete').includes('knowledge:delete'), '删库不可逆，路由层要求 delete');
});

/* ── 汇总 ───────────────────────────────────────────────── */

section('P1-1 · 模型中心：探活分类、注册表隔离、默认与降级链、知识层接缝');

await t('探活纯函数：用途×协议组合校验、端点拼接（不重复 /v1）、失败分类', async () => {
  assert.deepEqual(KINDS.slice().sort(), ['chat', 'embedding'], '只有两种用途');
  assert.deepEqual(PROTOCOLS_BY_KIND.chat, ['anthropic-messages', 'openai-compat'],
    '对话不认 ollama 的向量接口 —— 协议集合必须按用途收窄');
  assert.ok(PROTOCOLS_BY_KIND.embedding.includes('none'), '向量允许"显式不配"');

  // 未知用途 / 用途与协议不匹配 —— 一律拒绝，不猜
  assert.equal((await probeModel({ kind: 'tts', protocol: 'openai-compat' })).code, 'bad_kind');
  assert.equal((await probeModel({ kind: 'chat', protocol: 'ollama' })).code, 'bad_protocol');

  // 端点拼接：末段已是 /v1 时不得再叠一层（叠了会变成 /v1/v1/messages，静默 404）
  assert.equal(endpointFor('chat', 'anthropic-messages', 'https://api.example.com'), 'https://api.example.com/v1/messages');
  assert.equal(endpointFor('chat', 'anthropic-messages', 'https://api.example.com/v1/'), 'https://api.example.com/v1/messages');
  assert.equal(endpointFor('embedding', 'ollama', 'http://127.0.0.1:11434'), 'http://127.0.0.1:11434/api/embed');
  assert.equal(endpointFor('embedding', 'openai-compat', 'http://h:8080/v1'), 'http://h:8080/v1/embeddings');

  // 缺配置不是"连不上"：两者必须是不同的 code（否则运维分不清该改配置还是该查网络）
  assert.equal((await probeModel({ kind: 'chat', protocol: 'openai-compat', model: 'm' })).code, 'not_configured');
  assert.equal((await probeModel({ kind: 'embedding', protocol: 'ollama', baseUrl: 'http://h' })).code, 'not_configured');

  // 「显式不配向量」是**预期状态**：ok=true + level='skipped'，且不发请求、不产生用量
  const none = await probeModel({ kind: 'embedding', protocol: 'none' });
  assert.equal(none.level, 'skipped');
  assert.equal(none.ok, true, '跳过不是失败');
  assert.equal(none.billedRequest, false, '没发请求就不能标"已产生用量"');

  // 真实失败：指向一个必然被拒的端口，必须分类到 unreachable（而不是笼统的 probe_failed）
  const bad = await probeModel({ kind: 'embedding', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'm' });
  assert.equal(bad.ok, false);
  assert.ok(/unreachable/.test(bad.code), '不可达要单独分类，实际：' + bad.code + ' / ' + bad.message);
});

await t('注册表：登记 / 校验 / 同名拒绝 / 形状里没有密钥出口', () => {
  const o = orgRepo.createOrg({ name: 'M 公司', slug: 'm-corp-model' });
  const svc = createModelService({});

  // 校验：缺 baseUrl / 缺模型名 / 未知 kind / 协议与用途不匹配，全部拒绝
  assert.ok(svc.createProvider(o.id, { name: 'x', kind: 'chat', protocol: 'openai-compat' }).error, '缺 baseUrl 应拒绝');
  assert.ok(svc.createProvider(o.id, { name: 'x', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://h' }).error, '缺模型名应拒绝');
  assert.ok(svc.createProvider(o.id, { name: 'x', kind: 'tts', protocol: 'openai-compat' }).error, '未知 kind 应拒绝');
  assert.ok(svc.createProvider(o.id, { name: 'x', kind: 'chat', protocol: 'ollama', baseUrl: 'http://h', model: 'm' }).error,
    '用途与协议不匹配应拒绝（对话没有 ollama 这个协议）');
  assert.ok(svc.createProvider(o.id, { name: '', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://h', model: 'm' }).error,
    '空名字应拒绝');

  // 「不配向量」不需要 baseUrl/model —— 它是合法配置，不是漏填
  const noneRow = svc.createProvider(o.id, { name: 'nokey-embed', kind: 'embedding', protocol: 'none' });
  assert.equal(noneRow.ok, true, JSON.stringify(noneRow));

  const r = svc.createProvider(o.id, {
    name: 'chat-a', kind: 'chat', protocol: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:1', model: 'rec', credentialName: 'super-secret-name',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.provider.endpoint, 'http://127.0.0.1:1/v1/messages', '接口要把真实端点算出来给运维看');
  assert.equal(r.provider.hasCredential, true);

  // 同名拒绝（租户内唯一）
  assert.ok(svc.createProvider(o.id, { name: 'chat-a', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://h', model: 'm' }).error,
    '同名应拒绝');

  // 形状纪律：只出"凭据名"，不出任何值；也不该把 meta 原样吐出去
  const shaped = svc.listProviders(o.id)[0];
  assert.equal(shaped.credentialName, 'super-secret-name', '凭据**名**是可以出的（运维要认得出用的是哪条）');
  assert.ok(!('credentialValue' in shaped) && !('apiKey' in shaped), '形状里不允许出现任何"值"字段');
  assert.ok(!/super-secret/.test(JSON.stringify(r.provider)) || r.provider.credentialName === 'super-secret-name',
    '凭据名以外的任何地方都不该出现它');
});

await t('注册表：按组织隔离（别家看不到、取不到、删不掉、改不动）', () => {
  const a = orgRepo.createOrg({ name: 'M2-A 公司', slug: 'm2a-model' });
  const b = orgRepo.createOrg({ name: 'M2-B 公司', slug: 'm2b-model' });
  const svc = createModelService({});

  const created = svc.createProvider(a.id, {
    name: 'a-chat', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'm',
  });
  assert.equal(created.ok, true);
  const id = created.provider.id;

  assert.equal(svc.listProviders(b.id).length, 0, '别家列表里不应出现');
  assert.equal(svc.getProvider(b.id, id), null, '别家按 id 取不到');
  assert.equal(svc.deleteProvider(b.id, id).reason, 'not_found', '别家删不掉');
  assert.equal(svc.updateProvider(b.id, id, { name: 'hacked' }).reason, 'not_found', '别家改不动');
  assert.equal(svc.setDefault(b.id, id).reason, 'not_found', '别家也设不了默认');
  assert.ok(svc.getProvider(a.id, id), '本家的必须还在（上面那些操作一条都不能真的生效）');
});

await t('默认与降级链：按 priority 排序；默认来源要如实区分"显式设置"与"取链首"', () => {
  const o = orgRepo.createOrg({ name: 'M3 公司', slug: 'm3-model' });
  const svc = createModelService({});
  const mk = (name, priority) => svc.createProvider(o.id, {
    name, kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: name, priority,
  });
  mk('p30', 30); mk('p10', 10); mk('p20', 20);

  const d0 = svc.resolveDefault(o.id, 'chat');
  assert.equal(d0.defaultSource, 'chain-head', '没人设默认 → 如实说"取链首"，而不是假装它是被配置的默认');
  assert.equal(d0.provider.name, 'p10', '链首是 priority 最小的那个');
  assert.deepEqual(d0.chain.map((x) => x.name), ['p10', 'p20', 'p30'], '链按 priority 升序');

  const s = svc.setDefault(o.id, svc.listProviders(o.id).find((x) => x.name === 'p30').id);
  assert.equal(s.ok, true);
  const d1 = svc.resolveDefault(o.id, 'chat');
  assert.equal(d1.defaultSource, 'explicit');
  assert.equal(d1.provider.name, 'p30', '显式默认优先于链首');
  assert.deepEqual(d1.chain.map((x) => x.name), ['p10', 'p20', 'p30'], '设默认不改链的顺序');

  // 库层唯一索引兜底：同用途至多一个默认
  const again = svc.createProvider(o.id, {
    name: 'p40', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'p40', priority: 40, isDefault: true,
  });
  assert.equal(again.ok, true);
  const defaults = svc.listProviders(o.id).filter((x) => x.kind === 'chat' && x.isDefault);
  assert.equal(defaults.length, 1, '同用途只能有一个默认，实际：' + defaults.map((x) => x.name).join(','));
  assert.equal(defaults[0].name, 'p40');
});

await t('停用默认项：默认标记被撤掉，且**显式回报**（不让"关一下再开一下"静默换默认）', () => {
  const o = orgRepo.createOrg({ name: 'M4 公司', slug: 'm4-model' });
  const svc = createModelService({});
  const a = svc.createProvider(o.id, {
    name: 'dl-a', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'a', priority: 10, isDefault: true,
  });
  const b = svc.createProvider(o.id, {
    name: 'dl-b', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'b', priority: 20,
  });
  // 第三条只用来验证"停用项不能设为默认"，随后就停用它（不参与默认/链的断言）
  const c = svc.createProvider(o.id, {
    name: 'dl-c', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'c', priority: 30,
  });
  assert.equal(svc.resolveDefault(o.id, 'chat').defaultSource, 'explicit');

  // 不能把停用项设为默认
  svc.setEnabled(o.id, c.provider.id, false);
  assert.ok(svc.setDefault(o.id, c.provider.id).error, '已停用项不能设为默认');

  // 停用**当前默认项** → 默认标记被撤，并且必须显式回报（含 note）
  const off = svc.setEnabled(o.id, a.provider.id, false);
  assert.equal(off.ok, true);
  assert.equal(off.clearedDefault, true, '停用默认项必须回报"默认被撤掉了"');
  assert.ok(/重新启用不会自动恢复/.test(off.note || ''), '要写清这是单向的：' + off.note);

  const d = svc.resolveDefault(o.id, 'chat');
  assert.equal(d.defaultSource, 'chain-head', '默认没了 → 如实回落到链首');
  assert.equal(d.provider.name, 'dl-b', '链首应是剩下那条启用的');
  assert.deepEqual(d.chain.map((x) => x.name), ['dl-b'], '被停用的项不能出现在链里');

  // 重新启用**不会**自动恢复默认 —— 这是刻意行为，必须被钉住
  const on = svc.setEnabled(o.id, a.provider.id, true);
  assert.equal(on.provider.isDefault, false, '重新启用不恢复默认（避免"我以为还是它"）');
  assert.equal(svc.resolveDefault(o.id, 'chat').defaultSource, 'chain-head',
    '此时无显式默认，因为 dl-a 的 priority=10 已回到链首');
  assert.equal(svc.resolveDefault(o.id, 'chat').provider.name, 'dl-a');
});

await t('删除条目：不自动提升下一个为默认（悄悄改行为比"报个提示"危险）', () => {
  const o = orgRepo.createOrg({ name: 'M5 公司', slug: 'm5-model' });
  const svc = createModelService({});
  const a = svc.createProvider(o.id, {
    name: 'del-a', kind: 'embedding', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'a', priority: 10, isDefault: true,
  });
  svc.createProvider(o.id, { name: 'del-b', kind: 'embedding', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'b', priority: 20 });

  const r = svc.deleteProvider(o.id, a.provider.id);
  assert.equal(r.ok, true);
  assert.ok(/不再有显式默认/.test(r.note || ''), '删默认项要如实说明后续行为：' + r.note);

  const others = svc.listProviders(o.id).filter((x) => x.isDefault);
  assert.equal(others.length, 0, '不应自动把下一个提升为默认');
  const d = svc.resolveDefault(o.id, 'embedding');
  assert.equal(d.defaultSource, 'chain-head');
  assert.equal(d.provider.name, 'del-b');
});

await t('探活两层结论：条目不存在 vs 条目存在但连不上（不能合并成一个 ok）', async () => {
  const o = orgRepo.createOrg({ name: 'M6 公司', slug: 'm6-model' });
  // 凭据解析器是**唯一**能拿到密钥的地方：用一个探针记录它被怎么调用
  const calls = [];
  const svc = createModelService({
    resolveCredential: (tenantId, name) => { calls.push([tenantId, name]); return 'S3CR3T-VALUE-should-never-leak'; },
  });

  // ① 条目不存在 → 调用本身失败（reason=not_found，前端据此回 404）
  const nf = await svc.probeProvider(o.id, 'no-such-id');
  assert.equal(nf.ok, false);
  assert.equal(nf.reason, 'not_found');

  // ② 条目存在但连不上 → 调用跑成（ok=true），结论在 verdict 里
  const withCred = svc.createProvider(o.id, {
    name: 'probe-a', kind: 'chat', protocol: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:1', model: 'm', credentialName: 'chat-key',
  });
  const r = await svc.probeProvider(o.id, withCred.provider.id);
  assert.equal(r.ok, true, '条目存在 → 这一次调用是跑成了的');
  assert.equal(r.verdict.ok, false, '结论是"连不上" —— 与上面那个 ok 是两件事');
  assert.deepEqual(calls, [[o.id, 'chat-key']], '必须按 (组织, 凭据名) 去取密钥');
  assert.ok(!JSON.stringify(r).includes('S3CR3T'), '密钥值绝不允许出现在探活结果里（哪怕失败时）');

  // ③ 记录最近一次探活，供界面显示；但它不是"长期结论"
  const after = svc.getProvider(o.id, withCred.provider.id);
  assert.ok(after.lastProbe && after.lastProbe.level, '要记下最近一次探活（带级别）');
  assert.ok(after.lastProbe.at, '并带时间戳（连通性随时会变，不能说"它一直是好的"）');
});

await t('知识层接缝：注册表的默认向量项**真的**被检索路径使用，且来源可辨', async () => {
  const o = orgRepo.createOrg({ name: 'M7 公司', slug: 'm7-model' });

  // ① 注册表给了默认向量项 → embedding 描述必须标注来源是 model-registry（不是 config）
  const k1 = createKnowledgeService({
    config: { values: {} },
    resolveEmbedding: () => ({ provider: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'reg-embed', credentialName: '', dim: 0, source: 'model-registry', registryName: 'reg-embed' }),
  });
  try {
    const s1 = k1.status(o.id);
    assert.equal(s1.embedding.mode, 'openai-compat', '注册表里的向量项要真的生效（否则模型中心只是能存能看的表）');
    assert.equal(s1.embedding.source, 'model-registry', '必须标明配置来源，否则界面分不清"配了没生效"与"根本没用注册表"');
    assert.equal(s1.embedding.registryName, 'reg-embed');

    // ② 没有组织上下文时不问注册表、也不猜全局默认 —— 回落到 config 并标明来源
    assert.equal(k1.status(null).embedding.source, 'config',
      '没有租户时不做猜测，如实说这份配置来自 config（而不是声称某个组织的默认）');

    // ③ 「不配向量」也要能从注册表来（这是合法的显式配置，不是"没配"）
    const k2 = createKnowledgeService({
      config: { values: {} },
      resolveEmbedding: () => ({ provider: 'none', source: 'model-registry', registryName: 'nope' }),
    });
    try {
      const s2 = k2.status(o.id);
      assert.equal(s2.embedding.mode, 'none');
      assert.equal(s2.embedding.source, 'model-registry', '显式的"不配"也来自注册表，来源照样要标出来');
    } finally { await k2.close(); }

    // ④ 注册表返回 null → 回落 config.json（老路径不能被破坏）
    const k3 = createKnowledgeService({ config: { values: {} }, resolveEmbedding: () => null });
    try {
      assert.equal(k3.status(o.id).embedding.source, 'config');
    } finally { await k3.close(); }
  } finally { await k1.close(); }
});

await t('分层与装配：模型路由不自己出网、不碰数据库；装配层真的装配了模型服务', () => {
  const routeSrc = fs.readFileSync(new URL('../app/http/routes/model.mjs', import.meta.url), 'utf8');
  assert.ok(!/from 'node:fs'/.test(routeSrc), '路由不应 import node:fs');
  assert.ok(!/\bfetch\(/.test(routeSrc), '路由不应自己发请求（出网只在 probe.mjs，一处收口）');
  assert.ok(!/data\/db\.mjs/.test(routeSrc), '路由不应直接碰数据库（必须经 service）');
  assert.ok(/deps\.model\b/.test(routeSrc), '路由应通过 deps.model 使用服务');
  // 探活是"有副作用的写动作"（会出网并产生用量），必须要求 write 而不是 read
  assert.ok(/capability:\s*\['model:write'\][\s\S]{0,400}?probe/.test(routeSrc) || /probe[\s\S]{0,300}?capability:\s*\['model:write'\]/.test(routeSrc),
    '探活接口必须要求 model:write（它会真的发请求）');

  const composeSrc = fs.readFileSync(new URL('../app/compose/services.mjs', import.meta.url), 'utf8');
  assert.ok(/createModelService\(/.test(composeSrc), '装配层（app/compose）必须真的装配模型服务');
  assert.ok(/createModelService\([\s\S]{0,60}?resolveCredential/.test(composeSrc),
    '装配必须注入凭据解析器（否则探活永远拿不到密钥，只能报"未带密钥"）');
  assert.ok(/resolveEmbedding:\s*\(tenantId\)\s*=>\s*model\.resolveEmbeddingForIdentity/.test(composeSrc),
    '知识层的向量配置必须接到模型注册表上（否则模型中心是装饰）');
  // 顺序纪律：模型服务必须在知识服务之前创建（知识层装配时要拿得到它）
  assert.ok(composeSrc.indexOf('createModelService(') < composeSrc.indexOf('createKnowledgeService('),
    '模型服务必须先于知识服务装配');

  // 权限矩阵：model 资源必须显式出现在四个内置角色里（不能靠默认档"顺带"给）
  for (const rk of ROLE_KEYS) {
    assert.ok(can([rk], 'model', 'read'), rk + ' 应能读模型中心');
  }
  assert.ok(can(['admin'], 'model', 'write'), 'admin 应能改');
  assert.ok(can(['admin'], 'model', 'delete'), 'admin 应能删');
  assert.ok(!can(['member'], 'model', 'write'), 'member 不应能改（登记模型是管理动作）');
  assert.ok(!can(['viewer'], 'model', 'write'), 'viewer 不应能改');
  assert.ok(RESOURCES.includes('model'), 'RESOURCES 必须显式列出 model（否则矩阵与文档会漂移）');
});

/* ══ P1-2：定时任务 / 通知 / 指标 / 并发闸 / 审计保留 ═══════════════════ */

section('P1-2 · 定时任务底座');

await t('调度规则解析与下次执行计算（纯函数，按 UTC 口径）', () => {
  // interval
  assert.equal(parseSchedule('interval:3600000').ms, 3600000);
  assert.equal(parseSchedule('interval:999').ok, false, '低于 1 秒应拒绝（更密的调度没有意义）');
  assert.equal(parseSchedule('interval:99999999999').ok, false, '超过 30 天应拒绝');
  // dailyAt
  assert.deepEqual(
    { hh: parseSchedule('dailyAt:03:00').hh, mm: parseSchedule('dailyAt:03:00').mm },
    { hh: 3, mm: 0 }
  );
  assert.equal(parseSchedule('dailyAt:24:00').ok, false);
  assert.equal(parseSchedule('* * * * *').ok, false, '这不是 cron —— cron 表达式必须被拒绝，而不是被静默当成无效');

  // computeNextRun：interval 就是 now + n
  const base = Date.UTC(2026, 9, 1, 12, 0, 0);
  assert.equal(computeNextRun('interval:60000', base), base + 60000);
  // dailyAt：今天该时刻还没到 → 今天；已经到了 → 明天
  assert.equal(computeNextRun('dailyAt:13:00', base), Date.UTC(2026, 9, 1, 13, 0, 0));
  assert.equal(computeNextRun('dailyAt:11:00', base), Date.UTC(2026, 9, 2, 11, 0, 0));
  // 非法规则没有"下次" —— 返回 null 而不是猜一个
  assert.equal(computeNextRun('bogus', base), null);

  assert.ok(/每 1 小时/.test(describeSchedule('interval:3600000')));
  assert.ok(/UTC/.test(describeSchedule('dailyAt:00:10')), 'dailyAt 必须标出 UTC，否则会被当成本地时间');
});

await t('执行体白名单：未知 kind 如实报 fail，不缺数据也不硬跑', async () => {
  // 白名单与默认参数必须一一对应（避免"登记了却没有实现"）
  assert.deepEqual(Object.keys(TASK_DEFAULTS).sort(), TASK_KINDS.slice().sort());
  assert.equal(isKnownKind('audit.archive'), true);
  assert.equal(isKnownKind('rm -rf /'), false);

  const r = await runTask('does.not.exist', { tenantId: 't', params: {}, deps: {} });
  assert.equal(r.status, 'fail');
  assert.equal(r.detail.error, 'unknown-kind');
  assert.ok(Array.isArray(r.detail.known) && r.detail.known.length, '要把可用执行体带回去，便于运维照着改');

  // 依赖未装配 → fail + 说明（装配缺陷不是数据问题，两者要能区分）
  const r2 = await runTask('audit.archive', { tenantId: 't', params: {}, deps: {} });
  assert.equal(r2.status, 'fail');
  assert.ok(/依赖未装配/.test(r2.detail.error), r2.detail.error);
});

await t('任务 CRUD：校验 / 同名拒绝 / 改规则重算下次执行 / 手动执行区分于定时', async () => {
  const o = orgRepo.createOrg({ name: 'S 公司', slug: 's-corp-sched' });
  const svc = createScheduleService({ governance: createGovernanceService() });

  assert.ok(svc.createJob(o.id, { name: '', kind: 'audit.anchor', schedule: 'dailyAt:00:10' }).error, '空名应拒绝');
  assert.ok(svc.createJob(o.id, { name: 'x', kind: 'nope', schedule: 'interval:60000' }).error, '未知执行体应拒绝');
  assert.ok(svc.createJob(o.id, { name: 'x', kind: 'audit.anchor', schedule: 'cron * * *' }).error, '非法规则应拒绝');

  const c = svc.createJob(o.id, { name: '锚定', kind: 'audit.anchor', schedule: 'dailyAt:00:10' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.ok(c.job.nextRunAt, '新建后必须算出下次执行时间（否则页面只能显示"—"）');
  assert.equal(svc.createJob(o.id, { name: '锚定', kind: 'audit.anchor', schedule: 'interval:60000' }).error !== undefined, true,
    '同名应拒绝');

  const upd = svc.updateJob(o.id, c.job.id, { schedule: 'interval:3600000' });
  assert.equal(upd.ok, true);
  assert.ok(upd.job.nextRunAt > new Date().toISOString(), '改规则后下次执行必须重算');

  // 立即执行：锚点没有审计也能成功跑（空链的链尾就是空串 —— 这是事实，不是错误）
  const run = await svc.runNow(o.id, c.job.id);
  assert.equal(run.ok, true);
  assert.equal(run.status, 'ok');
  assert.equal(run.job.lastDetail.manual, true, '手动执行必须在明细里标出来（否则事后分不清是自动还是手动）');
  assert.equal(run.job.runCount, 1);

  // 审计留痕：任务执行必须入链
  const logs = auditLog.list(o.id, { limit: 10 });
  assert.equal(logs.length >= 1, true, '任务执行应留下审计记录');
  assert.ok(logs.some((l) => l.action === 'schedule.job.run' && l.detail_json.includes('"manual":true')));

  // tick：不到点就不跑（due=0），且重入保护字段存在
  const tick = await svc.tick();
  assert.equal(typeof tick.due, 'number');

  assert.ok(svc.deleteJob(o.id, c.job.id).ok);
  assert.equal(svc.listJobs(o.id).length, 0);
  svc.close();
});

await t('默认任务播种：幂等，且覆盖"平台承诺过"的三件事', () => {
  const o = orgRepo.createOrg({ name: 'D 公司', slug: 'd-corp-sched' });
  const svc = createScheduleService({});
  const created = svc.ensureDefaults(o.id);
  assert.equal(created.length, DEFAULT_JOBS.length, '首次应播种全部默认任务');
  assert.equal(svc.ensureDefaults(o.id).length, 0, '重复调用必须幂等（不能每次启动都插一遍）');
  const kinds = svc.listJobs(o.id).map((j) => j.kind).sort();
  for (const k of ['audit.archive', 'audit.anchor']) {
    assert.ok(kinds.includes(k), '默认任务必须包含 ' + k + '（这是"承诺过就要做到"的两件事）');
  }
  assert.equal(svc.runningNow(), false, '未 start 时不能自称在运行');
  svc.start();
  assert.equal(svc.runningNow(), true);
  svc.close();
  assert.equal(svc.runningNow(), false, 'close 后必须停掉定时器（否则进程退不出去）');
});

section('P1-2 · 审计保留、归档与链尾锚定');

await t('归档后哈希链**仍然可校验**（链基准是这件事的关键）', () => {
  const o = orgRepo.createOrg({ name: 'C 公司', slug: 'c-corp-audit' });
  for (let i = 0; i < 5; i++) {
    auditLog.append({ tenantId: o.id, userId: 'u', action: 'test.act.' + i, resourceType: 'x', resourceId: String(i) });
  }
  assert.equal(auditLog.verifyChain(o.id).ok, true, '基线：全链应通过');

  // 把前 3 条的时间改到很久以前，让它们进入归档范围
  const rows = auditLog.list(o.id, { limit: 100 }).slice().reverse();
  for (let i = 0; i < 3; i++) {
    db.run('UPDATE audit_logs SET at = ? WHERE id = ?', ['2020-01-01T00:00:0' + i + '.000Z', rows[i].id]);
  }

  const archiveDir = path.join(tmp, 'archive');
  const r = auditLog.archive({ tenantId: o.id, retentionDays: 30, dir: archiveDir });
  assert.equal(r.archived, 3, JSON.stringify(r));
  assert.ok(fs.existsSync(r.file), '归档文件必须真的落盘（先落盘、后删除）');
  const lines = fs.readFileSync(r.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(JSON.parse(lines[0]).hash, '归档副本要带 hash，外部工具才能独立复算');

  // 关键断言：归档**删掉了最旧的行**，此时若没有链基准，verifyChain 会在第 0 行报断裂
  const info = auditLog.chainInfo(o.id);
  assert.equal(info.retained, 3, '主表应只剩 3 条（另外还有归档动作自己那条，见下）');
  assert.ok(info.baseHash, '链基准必须被写上 —— 否则归档等于把可校验性破坏掉');
  assert.equal(info.archivedCount, 3);

  const v = auditLog.verifyChain(o.id);
  assert.equal(v.ok, true, '归档之后链必须仍可校验：' + JSON.stringify(v.brokenAt || {}));
  assert.equal(v.base, info.baseHash, '校验必须从链基准起算，并把它回报出来');

  // 归档动作本身入链 —— 否则"审计少了 3 条"在链上毫无痕迹
  assert.ok(auditLog.list(o.id, { limit: 10 }).some((l) => l.action === 'audit.archive'),
    '归档动作必须写进审计链');

  // 归档之后继续追加也不能断链
  auditLog.append({ tenantId: o.id, action: 'after.archive' });
  assert.equal(auditLog.verifyChain(o.id).ok, true, '归档后新追加的记录要链在剩余链尾上');

  // 再次归档：没有任何超期记录 → archived=0（不是失败）
  assert.equal(auditLog.archive({ tenantId: o.id, retentionDays: 30, dir: archiveDir }).archived, 0);
});

await t('链尾锚定：落文件 + 落表 + 报出链基准（只给链尾等于给了一半信息）', () => {
  const o = orgRepo.createOrg({ name: 'N 公司', slug: 'n-corp-anchor' });
  auditLog.append({ tenantId: o.id, action: 'anchor.me' });
  const anchorDir = path.join(tmp, 'anchor');
  const r = auditLog.anchor({ tenantId: o.id, dir: anchorDir });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.recordCount, 1);
  assert.ok(r.tailHash, '链尾 hash 必须非空');
  assert.ok('baseHash' in r, '必须同时报出链基准（否则无法判断链有没有被截断）');
  assert.ok(fs.existsSync(r.file), '锚点必须落盘（表里那行只是便于展示，不是最终手段）');
  const payload = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(payload.tailHash, r.tailHash);
  assert.ok(/离开这台机器/.test(payload.note) || /截断/.test(payload.note), '锚点文件里要带上这条诚实边界');

  const list = auditLog.listAnchors(o.id, { limit: 10 });
  assert.equal(list.length, 1);
  assert.equal(list[0].tailHash, r.tailHash);
  // 同一天重复锚定 → 覆盖而不是新增（唯一键是 tenant+day）
  auditLog.anchor({ tenantId: o.id, dir: anchorDir });
  assert.equal(auditLog.listAnchors(o.id, { limit: 10 }).length, 1, '同一天只能有一条锚点');
});

section('P1-2 · 并发闸（concurrent 真闸）');

await t('并发计数成对增减；enterConcurrent 在超限时拒绝且不计数', () => {
  const o = orgRepo.createOrg({ name: 'Q 公司', slug: 'q-corp-conc' });
  const gov = createGovernanceService();

  // 没配配额 = 不限流，但仍然计数（/metrics 要看到真实在途数）
  assert.equal(concurrency.activeForTenant(o.id), 0);
  const g0 = gov.quotas.enterConcurrent({ tenantId: o.id, userId: 'u1' });
  assert.equal(g0.ok, true);
  assert.equal(g0.unlimited, true, '没配额时应如实标"不限流"，而不是编一个上限');
  assert.equal(concurrency.activeForTenant(o.id), 1);
  gov.quotas.leaveConcurrent({ tenantId: o.id, userId: 'u1' });
  assert.equal(concurrency.activeForTenant(o.id), 0, 'leave 后必须归零（成对是硬要求）');

  // 配上限 2
  const up = gov.quotas.upsert({
    tenantId: o.id, subjectType: 'tenant', subjectId: o.id,
    metric: 'concurrent', limitValue: 2, period: 'total', mode: 'block',
  });
  assert.equal(up.ok, true, JSON.stringify(up));

  assert.equal(gov.quotas.enterConcurrent({ tenantId: o.id, userId: 'u1' }).ok, true);
  assert.equal(gov.quotas.enterConcurrent({ tenantId: o.id, userId: 'u1' }).ok, true);
  const third = gov.quotas.enterConcurrent({ tenantId: o.id, userId: 'u2' });
  assert.equal(third.ok, false, '第 3 个必须被拒（上限 2）');
  assert.equal(third.reason, 'concurrent_blocked');
  assert.equal(third.limit, 2);
  assert.equal(concurrency.activeForTenant(o.id), 2, '被拒的那次**不能**把计数加上去（否则计数会越漂越高）');

  // 释放一个就能再进
  gov.quotas.leaveConcurrent({ tenantId: o.id, userId: 'u1' });
  assert.equal(gov.quotas.enterConcurrent({ tenantId: o.id, userId: 'u2' }).ok, true);

  // 用量口径：concurrent 现在**真有计量**（不再是 unknownMetric:true）
  const c = usageRepo.consumed(o.id, { userId: null, metric: 'concurrent', period: 'total' });
  assert.equal(c.used, 2);
  assert.ok(!c.unknownMetric, '并发已实装，不能再带"未实装"标记');
  assert.equal(c.instantaneous, true, '并发是瞬时量，要标明（否则会被读成周期累计）');

  // 收尾：清干净，避免污染后面的用例
  gov.quotas.leaveConcurrent({ tenantId: o.id, userId: 'u1' });
  gov.quotas.leaveConcurrent({ tenantId: o.id, userId: 'u2' });
  assert.equal(concurrency.activeForTenant(o.id), 0);
});

section('P1-2 · 出站通知与指标');

await t('SSRF 校验：回环/云元数据/非 http(s) 被拒；内网地址放行（本平台就是内网部署）', async () => {
  const bad1 = await assertSafeTarget('http://127.0.0.1:9999/hook');
  assert.equal(bad1.ok, false, '回环必须被拒');
  assert.ok(/回环/.test(bad1.error));
  const bad2 = await assertSafeTarget('http://169.254.169.254/latest/meta-data/');
  assert.equal(bad2.ok, false, '云元数据地址必须被拒（这是 SSRF 的典型载荷）');
  const bad3 = await assertSafeTarget('file:///etc/passwd');
  assert.equal(bad3.ok, false, '只允许 http/https');
  const bad4 = await assertSafeTarget('http://[::1]:8080/x');
  assert.equal(bad4.ok, false, 'IPv6 回环同样要拦');

  // ⚠️ 内网地址**必须放行**：本平台面向内网部署，一律禁私网等于把功能做废。
  const ok1 = await assertSafeTarget('http://10.1.2.3:8080/hook');
  assert.equal(ok1.ok, true, '内网地址应放行（否则 webhook 功能在主要场景下不可用）');
  const ok2 = await assertSafeTarget('http://192.168.1.10/hook');
  assert.equal(ok2.ok, true);

  // 显式允许回环（本机自测场景）
  const loop = await assertSafeTarget('http://127.0.0.1:9999/hook', { allowLoopback: true });
  assert.equal(loop.ok, true);
});

await t('通知渠道：URL 加密落库且接口只回显 host；事件白名单挡住瞎写', () => {
  const o = orgRepo.createOrg({ name: 'W 公司', slug: 'w-corp-notify' });
  // masterSecret 必须与 app/data/secret.mjs 的 loadSecret() 同构：32 字节 AES-256 密钥。
  // 传 hex 字符串会得到 64 字节 → needKey() 直接拒绝（这正是"密钥格式不对不许静默降级"的行为）。
  const key = crypto.randomBytes(32);
  const svc = createNotifyService({ masterSecret: key, encryptSecret, decryptSecret });

  assert.ok(svc.createChannel(o.id, { name: 'x', url: '' }).error, '缺 url 应拒绝');
  assert.ok(svc.createChannel(o.id, {
    name: 'x', url: 'http://10.0.0.1/h?token=abc', events: ['not.a.real.event'],
  }).error, '未知事件必须被拒（否则"随手 emit 一个别的"会静默发出去）');

  const c = svc.createChannel(o.id, {
    name: '运维群', url: 'http://10.0.0.1/hook?access_token=SUPERSECRET',
    events: ['quota.blocked'], credentialName: 'ops-bearer',
  });
  assert.equal(c.ok, true, JSON.stringify(c));

  // 密钥没有出口：形状里只有 host，没有完整 URL、没有 token
  const json = JSON.stringify(c.channel);
  assert.ok(!/SUPERSECRET/.test(json), '完整 URL（含 token）绝不能出现在响应里');
  assert.ok(!/access_token/.test(json), '连 query 都不能带出来');
  assert.equal(c.channel.host, 'http://10.0.0.1/…', '只回显 host，够运维认人即可');
  // 库里存的也是密文
  const row = db.get('SELECT url_cipher FROM notify_channels WHERE id = ?', [c.channel.id]);
  assert.ok(!/SUPERSECRET/.test(row.url_cipher), '库里必须是密文');

  // 未订阅该事件 → delivered=0 且 ok=true（"没人订阅"不是失败）
  return svc.emit({ tenantId: o.id, event: 'backup.failed', payload: {} }).then((r) => {
    assert.equal(r.delivered, 0);
    assert.equal(r.ok, true, '"没人订阅"不能记成投递失败，否则成功率从一开始就是假的');
    assert.ok(/没有订阅/.test(r.note || ''));
  });
});

await t('通知：未装配加解密时拒绝以明文落库（红线，不是"能降级就降级"）', () => {
  const o = orgRepo.createOrg({ name: 'X 公司', slug: 'x-corp-notify' });
  const svc = createNotifyService({});
  const r = svc.createChannel(o.id, { name: 'plain', url: 'http://10.0.0.1/hook' });
  assert.equal(r.ok, false);
  assert.ok(/明文/.test(r.error), r.error);
});

await t('★ 通知适配：直达企微/钉钉自定义机器人换 msgtype 信封，并按回执 errcode 判成败（2026-10 交付评审 P1）', () => {
  // 现场：通用报文（{event,at,text,data}）发给企微/钉钉机器人，它们回 HTTP 200 但**不渲染**
  // （errcode 40008 / 300001）—— 不识别就会把静默丢失记成投递成功。适配的唯一依据是 host。

  // ① 识别：精确匹配 host（含大小写归一），后缀碰瓷与子域一律不许命中
  assert.equal(robotSinkOf('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k'), 'wecom');
  assert.equal(robotSinkOf('https://OAPI.DINGTALK.COM/robot/send?access_token=t'), 'dingtalk',
    'host 大小写不敏感（URL 规范里 host 本就该归一成小写）');
  assert.equal(robotSinkOf('https://qyapi.weixin.qq.com.evil.example/send'), '',
    '后缀碰瓷域名不许命中 —— 精确匹配的意义就在这里');
  assert.equal(robotSinkOf('https://sub.qyapi.weixin.qq.com/send'), '', '子域不是官方机器人端点');
  assert.equal(robotSinkOf('https://hooks.example.com/sti'), '', '通用 webhook 原样走平台报文');
  assert.equal(robotSinkOf('not a url'), '', '解析不了的不许崩，判为非机器人');
  assert.equal(robotSinkOf(''), '');

  // ② 换信封：只有 msgtype + content（一行摘要），不塞 JSON 明细；两类接收端字段形状相同
  const generic = { event: 'backup.failed', at: '2026-10-05T00:00:00.000Z', text: '[STI HARNESS] backup.failed：磁盘满', data: { secretish: 'x' } };
  assert.deepEqual(adaptBodyForSink('wecom', generic),
    { msgtype: 'text', text: { content: '[STI HARNESS] backup.failed：磁盘满' } });
  assert.deepEqual(adaptBodyForSink('dingtalk', generic),
    { msgtype: 'text', text: { content: '[STI HARNESS] backup.failed：磁盘满' } });
  assert.equal(adaptBodyForSink('', generic), generic, '非机器人目标必须是**同一个对象**原样放行（报文契约一字不改）');
  // 缺 text 也不许把 undefined 拼进信封
  assert.deepEqual(adaptBodyForSink('wecom', { event: 'x' }), { msgtype: 'text', text: { content: '' } });

  // ③ 回执判定：成败看 errcode，不看 HTTP 状态（HTTP 200 已由 postOnce 前置检查过）
  assert.equal(robotReceiptError('{"errcode":0,"errmsg":"ok"}'), null, 'errcode=0 才是送达');
  assert.ok(/93000/.test(robotReceiptError('{"errcode":93000,"errmsg":"invalid webhook key"}')),
    'key 失效（93000）必须判失败 —— 否则"消息没到、报表却说到了"');
  assert.ok(/300001/.test(robotReceiptError('{"errcode":300001,"errmsg":"keywords not in content"}')),
    '钉钉信封不合法（300001）必须判失败');
  assert.ok(/无法解析/.test(robotReceiptError('<html>proxy error</html>')),
    '回执不是 JSON（如中间有代理）→ 按未送达处理，宁可见失败不可静默成功');
  assert.ok(/无法解析/.test(robotReceiptError('{"errcode":"0"}')),
    'errcode 类型不对（字符串 "0"）也算不可信回执，不许当成成功');
  assert.ok(/无法解析/.test(robotReceiptError('')), '空回执按未送达处理');
});

await t('指标：Prometheus 文本格式，关键指标齐全且按组织给链长', () => {
  metrics.reset();
  metrics.recordHttpRequest({ method: 'get', routeId: 'demo.route', status: 200, durationMs: 12 });
  metrics.recordHttpRequest({ method: 'get', routeId: 'demo.route', status: 500, durationMs: 9000 });
  metrics.inc('sti_turns_total', { result: 'ok' });
  metrics.inc('sti_tokens_total', { direction: 'output' }, 42);
  metrics.setGauge('sti_active_turns', 3);

  const o = orgRepo.createOrg({ name: 'M 公司', slug: 'm-corp-metrics' });
  auditLog.append({ tenantId: o.id, action: 'metrics.probe' });
  const text = metrics.render({ tenantId: o.id });

  assert.ok(/# TYPE sti_uptime_seconds gauge/.test(text), '必须有 TYPE 行（采集端靠它建元数据）');
  assert.ok(/sti_uptime_seconds \d+/.test(text));
  assert.ok(/sti_http_requests_total\{method="GET",route="demo.route",status="200"\} 1/.test(text),
    '标签必须稳定有序，否则每次抓到的是不同的时间序列：\n' + text.slice(0, 400));
  assert.ok(/sti_http_request_duration_ms_count\{route="demo.route"\} 2/.test(text), '直方图要有 _count');
  assert.ok(/sti_http_request_duration_ms_bucket\{route="demo.route",le="5000"\} 1/.test(text), '12ms 应落进 5000 桶');
  assert.ok(/sti_turns_total\{result="ok"\} 1/.test(text));
  assert.ok(/sti_tokens_total\{direction="output"\} 42/.test(text));
  assert.ok(/sti_active_turns 3/.test(text));
  assert.ok(new RegExp('sti_audit_chain_length\\{tenant="' + o.id + '"\\} \\d+').test(text), '链长要按调用方组织给');
  assert.ok(/sti_db_size_bytes -?\d+/.test(text));
  // 没有出现过的计数器也要给 0：采集端的告警规则不能因为"事件还没发生"而失效
  assert.ok(/^sti_quota_blocked_total 0$/m.test(text), '未发生的计数器要给 0 而不是缺席');
  metrics.reset();
});

await t('分层与装配：调度/通知路由只调 service；装配层装配并启动调度器', () => {
  for (const f of ['schedule.mjs', 'notify.mjs']) {
    const src = fs.readFileSync(new URL('../app/http/routes/' + f, import.meta.url), 'utf8');
    assert.ok(!/from 'node:fs'/.test(src), f + ' 路由不应 import node:fs');
    assert.ok(!/\bfetch\(/.test(src), f + ' 路由不应自己发请求（出网只在 platform/notify 里收口）');
    assert.ok(!/data\/db\.mjs/.test(src), f + ' 路由不应直接碰数据库（必须经 service）');
  }

  const composeSrc = fs.readFileSync(new URL('../app/compose/services.mjs', import.meta.url), 'utf8');
  assert.ok(/createScheduleService\(/.test(composeSrc), '装配层（app/compose）必须装配调度服务');
  assert.ok(/createNotifyService\(/.test(composeSrc), '装配层（app/compose）必须装配通知服务');
  const mainSrc = fs.readFileSync(new URL('../app/main.mjs', import.meta.url), 'utf8');
  assert.ok(/schedule\.ensureDefaultsForAllTenants\(\)/.test(mainSrc), '启动时要为已存在的组织播种默认任务');
  assert.ok(/schedule\.start\(\)/.test(mainSrc), '服务模式下要真的启动调度器');
  assert.ok(/schedule\.close\(\)/.test(mainSrc), '优雅退出时必须停掉调度器');
  // 通知必须拿到加解密（否则 URL 只能明文落库 —— 那是红线）
  assert.ok(/createNotifyService\(\{[\s\S]{0,200}?encryptSecret/.test(composeSrc),
    '通知服务必须注入加密函数');
  assert.ok(/onConcurrentChange/.test(composeSrc), '并发计数的 gauge 要在装配层接线到指标');

  // 权限矩阵：两个新资源必须显式出现在角色里；成员只能读调度、读不到通知
  assert.ok(RESOURCES.includes('schedule'), 'RESOURCES 必须列出 schedule');
  assert.ok(RESOURCES.includes('notify'), 'RESOURCES 必须列出 notify');
  assert.ok(can(['admin'], 'schedule', 'write') && can(['admin'], 'schedule', 'delete'));
  assert.ok(can(['admin'], 'notify', 'write') && can(['admin'], 'notify', 'delete'));
  assert.ok(!can(['viewer'], 'schedule', 'write'), 'viewer 不应能改任务');
  assert.ok(!can(['member'], 'notify', 'write'), 'member 不应能改通知渠道（URL 里可能带 token）');
});

section('P1-3 · OpenAPI 规格（从路由表生成）');

await t('规格从路由表生成：路径/参数/权限/状态码逐条对上，且是纯函数（两次调用逐字节相同）', () => {
  const demoRoutes = [
    { id: 'demo.things.list', method: 'GET', path: '/api/demo/things', scope: 'session', capability: ['demo:read'], summary: '清单', milestone: 'P1' },
    { id: 'demo.things.get', method: 'GET', path: '/api/demo/things/:id', scope: 'session', capability: ['demo:read'], summary: '详情', milestone: 'P1' },
    { id: 'demo.things.create', method: 'POST', path: '/api/demo/things', scope: 'session', capability: ['demo:write'], summary: '新建', milestone: 'P1' },
    { id: 'system.health', method: 'GET', path: '/api/health', scope: 'public', capability: [], summary: '探针', milestone: 'M0' },
  ];
  const doc = buildOpenApi({ routes: demoRoutes, version: '9.9.9' });

  assert.equal(doc.openapi, '3.0.3');
  assert.equal(doc.info.version, '9.9.9', '版本必须来自 VERSION（单点），不是硬编码');
  assert.equal(doc['x-sti-generated'], true, '要标明"这是生成的"—— 否则下一个人会手改它');

  // 路径参数：`:id` 必须转成 `{id}` 并声明 parameter，否则 OpenAPI 文档非法
  assert.ok(doc.paths['/api/demo/things/{id}'], '路径参数要转成大括号形式');
  const getOne = doc.paths['/api/demo/things/{id}'].get;
  assert.deepEqual(getOne.parameters.map((p) => p.name), ['id']);
  assert.equal(getOne.parameters[0].required, true);

  // 权限模型必须机器可读（集成方靠它算"需要什么角色"）
  assert.deepEqual(doc.paths['/api/demo/things'].post['x-sti-capability'], ['demo:write']);
  assert.equal(doc.paths['/api/demo/things'].post['x-sti-scope'], 'session');
  // public 的路由要**显式**清空 security（空数组 = 明确不需要认证，与"未声明"有语义差别）
  assert.deepEqual(doc.paths['/api/health'].get.security, []);
  assert.equal(doc.paths['/api/demo/things'].get.security, undefined, '非 public 不写 = 继承顶层安全方案');

  // 状态码语义：写操作要有 400 与 requestBody；带参数的有 404；错误信封统一
  assert.ok(doc.paths['/api/demo/things'].post.requestBody, '写操作必须有 requestBody');
  assert.ok(!doc.paths['/api/demo/things'].get.requestBody, 'GET 不应有 requestBody');
  assert.ok(doc.paths['/api/demo/things/{id}'].get.responses['404'], '带路径参数的接口要有 404');
  assert.ok(doc.paths['/api/demo/things'].get.responses['403'], '声明了 capability 的接口要有 403');
  assert.ok(doc.paths['/api/demo/things'].get.responses['2XX'], '成功用 2XX 区间，而不是硬编一个 200');
  assert.equal(doc.paths['/api/demo/things'].get.responses['200'], undefined);
  assert.ok(doc.components.schemas.ErrorEnvelope, '错误信封存在，$ref 才不悬空');

  // 纯函数：排序稳定，任何与语义无关的输入顺序都不该进规格
  const shuffled = buildOpenApi({ routes: [...demoRoutes].reverse(), version: '9.9.9' });
  assert.equal(JSON.stringify(doc), JSON.stringify(shuffled), '路由注册顺序不应影响规格（否则快照会天天变）');
  assert.equal(doc['x-sti-route-count'], 4);

  // tags 由路由 id 前缀推导
  assert.ok(doc.tags.some((t) => t.name === 'demo'));
  assert.ok(doc.tags.some((t) => t.name === 'system'));
});

await t('规格生成对残缺输入不崩，且分层上必须是纯函数（无 IO / 无时间 / 无随机）', () => {
  // 路由表是"生成的输入"，它可能缺字段（例如新加的 summary 忘了写）。
  // 生成器不能因此崩掉 —— 规格挂了会连累整个服务起不来，而"少一句话"根本不值得。
  const sparse = buildOpenApi({ routes: [{ id: 'x.y', method: 'get', path: '/api/x' }] });
  assert.equal(sparse.paths['/api/x'].get.operationId, 'x.y');
  assert.ok(sparse.paths['/api/x'].get.summary, 'summary 缺省时回落成 id，而不是留空');
  assert.equal(sparse.paths['/api/x'].get['x-sti-scope'], undefined, '缺 scope 就如实缺席，不编一个 public');

  const empty = buildOpenApi({});
  assert.deepEqual(empty.paths, {});
  assert.equal(empty['x-sti-route-count'], 0);

  // 分层：规格模块是纯函数，不许碰 IO / 时间 / 随机
  const src = fs.readFileSync(new URL('../app/http/openapi.mjs', import.meta.url), 'utf8');
  assert.ok(!/from 'node:fs'/.test(src), 'openapi.mjs 必须是纯函数（无 IO）');
  assert.ok(!/Date\.now\(\)|new Date\(/.test(src), '不许把时间写进规格（否则同样的路由表每次都产出不同文档）');
  assert.ok(!/Math\.random/.test(src), '不许有随机性');
  assert.ok(!/data\/db\.mjs/.test(src), '规格生成不应碰数据库');
});

/* ══════════════════════════════════════════════════════════════════
 * P1-3 · 成本核算（token → 金额）
 *
 * 这一段的用例不是为了"证明能算钱"，而是为了钉住**三条会算错的路径**：
 *   ① 没配单价被当成 0 元（算出一个偏低但看起来正常的总额）；
 *   ② 缓存 token 被按输入价算（缓存价常与输入价差一个数量级，偏离方向还取决于用量结构）；
 *   ③ 归因不到模型的用量被摊到某个模型头上（给出一个确定但错误的数）。
 * 这三条任意一条失守，报表都会"看起来对" —— 所以必须有用例把它们钉死。
 * ══════════════════════════════════════════════════════════════════ */
section('P1-3 · 成本核算：null≠0、缓存价不顶替、币种分开、未归因不摊派');

await t('computeCost：没配单价是"不知道"（null）而不是 0 元；0 是合法的"免费"，两者必须分开', () => {
  // ① 完全没定价 → amountMinor 必须是 null
  const none = computeCost({ tokens: { input: 1000, output: 500 }, price: null });
  assert.equal(none.amountMinor, null, '没配单价 → null；写成 0 会被读成"这些调用免费了"');
  assert.equal(none.amount, null);
  assert.equal(none.pricedTokens, 0);
  assert.equal(none.unpricedTokens, 1500, '未定价的 token 要如实计数，否则页面上看不出"有多少没算进去"');
  assert.equal(none.partial, true, '不完整必须标出来');
  assert.ok(/不是 0 元/.test(none.note || ''), 'note 要把"null ≠ 0"直接写出来');

  // ② 单价配了 0 → 那是**真的免费**，金额就是 0，与"未定价"完全不同
  const free = computeCost({ tokens: { input: 1_000_000 }, price: { currency: 'CNY', priceInMinor: 0 } });
  assert.equal(free.amountMinor, 0, '0 是合法单价（免费），必须算成 0 而不是 null');
  assert.equal(free.pricedTokens, 1_000_000);
  assert.equal(free.amount, 'CNY 0.00');
  assert.equal(free.partial, false, '0 价是完整信息，不是"部分定价"');

  // ③ 只配了输入/输出价，没配缓存价 → 缓存 token 单列"未定价"，**绝不按输入价算**
  const partial = computeCost({
    tokens: { input: 1_000_000, cacheRead: 5_000_000, cacheWrite: 0, output: 1_000_000 },
    price: { currency: 'CNY', priceInMinor: 50, priceOutMinor: 200 },
  });
  // 输入 1M × 50 / 1e6 = 50 分；输出 1M × 200 / 1e6 = 200 分 → 250 分
  assert.equal(partial.amountMinor, 250, '缓存读 5M 未定价 → 不许按输入价 50 算进去');
  assert.equal(partial.amount, 'CNY 2.50');
  assert.equal(partial.pricedTokens, 2_000_000);
  assert.equal(partial.unpricedTokens, 5_000_000);
  assert.deepEqual(partial.missingPrices, ['cacheRead'], '要指名道姓说缺哪个价，否则运维不知道该补哪一格');
  const cr = partial.classes.find((c) => c.key === 'cacheRead');
  assert.equal(cr.priceMinor, null);
  assert.equal(cr.amountMinor, null, '未定价的那一类，金额也必须是 null（不是 0）');

  // ④ reasoning 不在计价类别里 —— 它是 output 的子集，另计就是重复收费
  assert.deepEqual(TOKEN_CLASSES.map((c) => c.key), ['input', 'cacheRead', 'cacheWrite', 'output']);
  assert.ok(!TOKEN_CLASSES.some((c) => c.key === 'reasoning'), 'reasoning 不单独计价');
});

await t('computeCost：配了价必须能表达成金额（缺币种 → null）；坏单价一律按"没配"处理', () => {
  // 配了价但没币种：默认按人民币算等于替客户做决定（他可能以为是美元）
  const noCur = computeCost({ tokens: { input: 1_000_000 }, price: { priceInMinor: 50 } });
  assert.equal(noCur.amountMinor, null, '没有币种的金额无法表达，宁可为 null');
  assert.ok(/币种/.test(noCur.note || ''), '要明确提示去补币种');
  assert.equal(noCur.partial, true);

  // 坏单价：负数 / 小数 / 非数字 / 无穷 —— 一律当"没配"。宁可不算，不可算错。
  for (const bad of [-1, 1.5, -0.01, 'abc', NaN, Infinity, {}]) {
    const r = computeCost({ tokens: { input: 1_000_000 }, price: { currency: 'CNY', priceInMinor: bad } });
    assert.equal(r.amountMinor, null, '坏单价 ' + String(bad) + ' 必须按"没配"处理');
    assert.equal(r.unpricedTokens, 1_000_000);
  }

  // 金额格式化：null 就是 null（页面据此显示"未定价"）；整数分 → 两位小数，不做浮点累加
  assert.equal(formatAmount(null, 'CNY'), null);
  assert.equal(formatAmount(0, 'CNY'), 'CNY 0.00');
  assert.equal(formatAmount(5, 'CNY'), 'CNY 0.05');
  assert.equal(formatAmount(123456, 'CNY'), 'CNY 1234.56');
  // 负号在币种之前（与 `-$1.25` 的写法一致）。单价非负，所以这只是防御性分支 ——
  // 但正因为平时走不到，才要钉住它的输出，免得哪天被顺手改成"USD -1.25"而无人察觉。
  assert.equal(formatAmount(-125, 'USD'), '-USD 1.25');
});

await t('buildCostReport：归因按模型名匹配、同模型名取链首、币种分开合计、未归因不摊派', () => {
  const providers = [
    // 同模型名两条（不同 priority）—— 用来验证"取哪一条"是确定的
    { id: 'p2', name: 'B', kind: 'chat', model: 'shared', priority: 200, currency: 'CNY', priceInMinor: 100, priceOutMinor: 100 },
    { id: 'p1', name: 'A', kind: 'chat', model: 'shared', priority: 10, currency: 'CNY', priceInMinor: 50, priceOutMinor: 50 },
    { id: 'pu', name: 'U', kind: 'chat', model: 'usd-model', priority: 100, currency: 'USD', priceInMinor: 7, priceOutMinor: 7 },
    { id: 'pn', name: 'N', kind: 'chat', model: 'noprice', priority: 100 },   // 有条目、没单价
  ];
  const rows = [
    { model_id: 'shared', input: 1_000_000, cache_read: 0, cache_write: 0, output: 0, usageRows: 1 },
    { model_id: 'usd-model', input: 0, cache_read: 0, cache_write: 0, output: 1_000_000, usageRows: 1 },
    { model_id: 'noprice', input: 2_000_000, cache_read: 0, cache_write: 0, output: 0, usageRows: 1 },
    { model_id: 'never-registered', input: 3_000_000, cache_read: 0, cache_write: 0, output: 0, usageRows: 1 },
    { model_id: '', input: 1_000, cache_read: 2_000, cache_write: 3_000, output: 4_000, usageRows: 2 },
  ];
  const rep = buildCostReport({ rows, providers });
  assert.equal(rep.items.length, 4, 'model_id 非空的四组各自成条');

  const shared = rep.items.find((x) => x.modelId === 'shared');
  assert.equal(shared.provider.id, 'p1', '同模型名多条 → 取 priority 最小的（与降级链的选法一致）');
  assert.equal(shared.providerCandidates.length, 2, '候选要如实列出，否则"为什么是这条"没法解释');
  assert.equal(shared.amountMinor, 50);
  assert.equal(shared.amount, 'CNY 0.50');

  // 币种分开合计：CNY 与 USD 加在一起是个无意义的数
  assert.deepEqual(Object.keys(rep.totalsByCurrency).sort(), ['CNY', 'USD']);
  assert.equal(rep.mixedCurrency, true, '混合币种必须标出来');
  assert.equal(rep.totalsByCurrency.CNY.amountMinor, 50);
  assert.equal(rep.totalsByCurrency.USD.amountMinor, 7);

  // "条目有、价没配" 与 "条目根本不存在" 是两件事，必须能区分
  const np = rep.items.find((x) => x.modelId === 'noprice');
  assert.equal(np.provider.id, 'pn', '条目找得到');
  assert.equal(np.amountMinor, null, '只是没配价 → null');
  const nr = rep.items.find((x) => x.modelId === 'never-registered');
  assert.equal(nr.provider, null, '注册表里没有这个名字 → **不许**拿别的条目的价去套');
  assert.equal(nr.amountMinor, null);

  // 空 model_id → 单独成桶，token 照算，但不进任何金额
  assert.equal(rep.unattributed.usageRows, 2);
  assert.equal(rep.unattributed.tokens, 10000, '未归因 token = input+cacheRead+cacheWrite+output 之和');
  assert.ok(rep.notes.some((n) => /未计入任何金额/.test(n)), 'notes 要明确说这部分没进金额');
});

await t('成本端到端：单价校验/落库/归因全链路；未装配 providers 时如实降级为"未定价"', () => {
  const o = orgRepo.createOrg({ name: 'C 公司', slug: 'c-corp-cost' });
  const model = createModelService({});

  // 登记时带单价：币种归一成大写，没配的那几格**保持 null**（不许补 0）
  const created = model.createProvider(o.id, {
    name: 'cost-chat', kind: 'chat', protocol: 'openai-compat',
    baseUrl: 'http://h', model: 'cost-demo',
    currency: 'cny', priceInMinor: 100, priceOutMinor: 200,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.provider.currency, 'CNY', '币种要归一成大写');
  assert.equal(created.provider.priced, true);
  assert.equal(created.provider.priceCacheReadMinor, null, '没配就是 null —— 不许把 null 变成 0');
  assert.equal(created.provider.priceCacheWriteMinor, null);

  // 写入时即拒：负数 / 小数 / 配了价缺币种 —— 这三种输入都会让金额算错
  const badBase = { kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://h', model: 'm' };
  assert.ok(model.createProvider(o.id, { name: 'bad1', ...badBase, currency: 'CNY', priceInMinor: -1 }).error,
    '负数单价应拒');
  assert.ok(model.createProvider(o.id, { name: 'bad2', ...badBase, currency: 'CNY', priceInMinor: 1.5 }).error,
    '小数单价应拒（金额用整数存就是为了不留浮点漂移）');
  assert.ok(model.createProvider(o.id, { name: 'bad3', ...badBase, priceInMinor: 100 }).error,
    '配了价却缺币种应拒（否则只能默认按人民币算，等于替客户做决定）');
  assert.ok(model.createProvider(o.id, { name: 'bad4', ...badBase, currency: 'RMBY', priceInMinor: 100 }).error,
    '币种必须是 3 位字母（ISO 4217）');

  // 真写两行用量（照抄事件）：一行带模型名，一行没带（= 没给会话选过模型）
  usageRepo.recordFromEvents({
    tenantId: o.id, userId: 'u1', sessionId: 'ses-cost-1', turnId: 't1', modelId: 'cost-demo',
    events: [{
      type: 'usage',
      usage: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 500_000, reasoning: 100_000 },
    }],
  });
  usageRepo.recordFromEvents({
    tenantId: o.id, userId: 'u1', sessionId: 'ses-cost-2', turnId: 't2',
    events: [{ type: 'usage', usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 10 } }],
  });
  // 第三条未归因用量（另一个会话）—— 用来钉住"行数统计"这件事：
  // `summarizeCost` 走的是 `GROUP BY model_id`，未归因的那一组是**一行代表多行记录**。
  // 曾经这里把"分组行数"当成"用量记录数"，页面就会永远显示"1 行用量"。
  usageRepo.recordFromEvents({
    tenantId: o.id, userId: 'u2', sessionId: 'ses-cost-3', turnId: 't3',
    events: [{ type: 'usage', usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 0 } }],
  });
  const stored = db.get('SELECT model_id FROM usage_records WHERE tenant_id = ? AND session_id = ?',
    [o.id, 'ses-cost-1']);
  assert.equal(stored.model_id, 'cost-demo', '归因信息必须真的落到 usage_records.model_id 上，否则整条链路是空转');
  const stored2 = db.get('SELECT model_id FROM usage_records WHERE tenant_id = ? AND session_id = ?',
    [o.id, 'ses-cost-2']);
  assert.equal(stored2.model_id, '', '没登记模型 → 空串（如实），不是随便编一个默认模型名');

  // 装配了 providers：1M×100/1e6 = 100 分；0.5M×200/1e6 = 100 分 → 200 分
  const gov = createGovernanceService({ resolveProviders: (tid) => model.listProviders(tid) });
  const r = gov.cost.summarize({ tenantId: o.id });
  const item = r.summary.items.find((x) => x.modelId === 'cost-demo');
  assert.equal(item.amountMinor, 200, '金额 = Σ(token×单价)/1e6，实际：' + JSON.stringify(item.classes));
  assert.equal(item.amount, 'CNY 2.00');
  assert.equal(item.tokens.reasoning, undefined, 'reasoning 不进成本口径（它是 output 的子集）');
  assert.equal(r.summary.unattributed.tokens, 25, '没归因的 token（20+5）不许摊到 cost-demo 头上');
  // 行数必须是**用量记录数**，不是"分组行数"（后者恒为 1，页面会显示"1 行用量"）
  assert.equal(r.summary.unattributed.usageRows, 2, '未归因桶要如实报出两条记录，而不是"一组"');
  assert.equal(item.usageRows, 1, 'cost-demo 那条聚合里只有 1 条记录');

  // 没装配 providers（装配缺陷）→ 如实降级为"未定价"，**绝不显示为 0**
  const bare = createGovernanceService();
  const rb = bare.cost.summarize({ tenantId: o.id });
  const itb = rb.summary.items.find((x) => x.modelId === 'cost-demo');
  assert.equal(itb.provider, null);
  assert.equal(itb.amountMinor, null, '缺装配时降级为"不知道花了多少"，而不是 0');
  assert.ok(itb.note, '降级也要有可读的说明，不能只是空值');

  // 只改 enabled 不该把单价冲掉（patch 语义 = 只改给定的字段）
  const off = model.setEnabled(o.id, created.provider.id, false);
  assert.equal(off.ok, true);
  assert.equal(off.provider.priceInMinor, 100, '停用不该顺手清掉单价');
  assert.equal(off.provider.currency, 'CNY');

  // 五个字段一起清空 → 回到"未定价"（null），而不是 0
  const cleared = model.updateProvider(o.id, created.provider.id, {
    currency: '', priceInMinor: '', priceCacheReadMinor: '', priceCacheWriteMinor: '', priceOutMinor: '',
  });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(cleared.provider.priced, false);
  assert.equal(cleared.provider.priceInMinor, null, '清空后是 null，不是 0');
});

await t('★ 用量采集：用量挂在助手消息上时也必须记账（真机漏账的根因）', () => {
  // 上游**没有独立的 usage 事件** —— 用量挂在 `assistant/message` 的 `data.usage` 上
  // （契约层 events.mjs 顶部早已写明）。而这里原先只认 `type === 'usage'`，
  // 于是真内核上每一轮都记 0 行，工作台却显示"累计 tokens 0" ——
  // 那不是"没数据"，是一句与事实相反的话（模型确实烧了 token，账上是 0）。
  // fixtures 与 测试替身 provider 恰好会发独立的 usage 事件，所以回归一直绿：
  // **桩数据形状与真实形状漂移**的又一例。
  const org = orgRepo.createOrg({ name: '用量归因对账公司', slug: 'usage-attr-corp' });
  const shape = { input: 562, cacheRead: 6656, cacheWrite: 0, output: 2, reasoning: 0 };

  // ① 真实形状：用量挂在 message 事件上
  const r1 = usageRepo.recordFromEvents({
    tenantId: org.id, sessionId: 'ses-usage-msg', turnId: 't1',
    events: [
      { type: 'turn-start' },
      { type: 'message', role: 'assistant', text: '\n2', usage: shape },
      { type: 'turn-end' },
    ],
  });
  assert.equal(r1.written, 1, '挂在助手消息上的用量必须记一行');
  assert.equal(r1.totals.input, 562);
  assert.equal(r1.totals.cacheRead, 6656);
  assert.equal(r1.totals.output, 2);

  // ② 同一轮里独立 usage 事件优先 —— 两个都记就是把**一笔账记两遍**（比漏账更难发现）
  const r2 = usageRepo.recordFromEvents({
    tenantId: org.id, sessionId: 'ses-usage-both', turnId: 't2',
    events: [
      { type: 'message', role: 'assistant', usage: shape },
      { type: 'usage', usage: shape },
    ],
  });
  assert.equal(r2.written, 1, '有独立 usage 事件时只认它，不许重复计数');
  assert.equal(r2.totals.input, 562);

  // ③ 没有任何用量数字时不许编一行出来（"缺就是缺"）
  const r3 = usageRepo.recordFromEvents({
    tenantId: org.id, sessionId: 'ses-usage-none', turnId: 't3',
    events: [{ type: 'message', role: 'assistant', text: '无用量' }, { type: 'turn-end' }],
  });
  assert.equal(r3.written, 0);
  assert.equal(r3.totals.input, 0);

  // ④ 脏 usage（不是对象）→ 计入 skipped，不写行，也不抛
  const r4 = usageRepo.recordFromEvents({
    tenantId: org.id, sessionId: 'ses-usage-dirty', turnId: 't4',
    events: [{ type: 'message', usage: '不是对象' }],
  });
  assert.equal(r4.written, 0);
  assert.equal(r4.skipped, 1);
});

await t('成本模块的分层：不碰 HTTP、不认识 model 模块、不做网络请求（providers 只能靠注入）', () => {
  const src = fs.readFileSync(new URL('../app/platform/governance/cost.mjs', import.meta.url), 'utf8');
  assert.ok(!/node:http|node:https|\.\.\/\.\.\/http\//.test(src), '成本核算不许碰 HTTP 层');
  assert.ok(!/platform\/model/.test(src),
    'governance 不认识 model —— providers 必须靠装配层注入（否则两个模块硬耦合，测试也没法自包含）');
  assert.ok(!/fetch\s*\(/.test(src), '成本核算是纯计算 + 一次 SQL 聚合，不做网络请求');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(/.test(src), '不许有随机/时间依赖（否则同样的数据两次算出的金额不同）');
});

/* ── P1-3 · 工作台最后一公里（3.6）────────────────────────────────── */
section('P1-3 · 工作台最后一公里：停止不该串轮、附件仓储双重过滤');

await t('测试替身 回合起点：上一轮被中途停止后，下一轮**不许**吐出上一轮的尾巴', async () => {
  // 这是一个**真实缺陷**的钉住用例（不是预防性代码）。
  // 缺陷形态：测试替身 把调用方给的 fromSeq 直接当事件数组下标用。fromSeq 是"平台库已落库的
  // 最大 seq"；上一轮被停止/超时截断时它**小于**上游已产出的事件数，于是本轮从中间插进去，
  // 把上一轮的尾巴当成自己的事件吐出来，并在上一轮的 turn-end 处收流 ——
  // 本轮真正的事件永远落不了库，且表现为"答非所问"。真实 provider 早已用 turnBase 处理，
  // 测试替身 没有 → 同一份契约两种语义，本身就是缺陷。
  const p = createKernelStub();
  const { sessionId } = await p.createSession({});

  // 第一轮：只读前 4 条就"停止"（模拟前端 abort）
  await p.submitTurn({ sessionId, content: '第一轮' });
  const first = [];
  for await (const ev of p.streamTurns({ sessionId, fromSeq: 0 })) {
    first.push(ev);
    if (first.length === 4) break;                    // 中途停止
  }
  assert.deepEqual(first.map((e) => e.seq), [1, 2, 3, 4], '停止时只拿到前 4 条');
  assert.notEqual(first[first.length - 1].type, 'turn-end', '这一轮是**没跑完**的（没拿到 turn-end）');

  // 平台库里只有 4 条 → 下一轮 runTurn 会传 fromSeq = 4
  await p.submitTurn({ sessionId, content: '第二轮' });
  const second = [];
  for await (const ev of p.streamTurns({ sessionId, fromSeq: 4 })) second.push(ev);

  assert.deepEqual(second.map((e) => e.seq), [9, 10, 11, 12, 13, 14, 15, 16],
    '必须只吐第二轮（seq 9 起）。吐 5~8 就是把上一轮的尾巴当成了本轮事件');
  assert.equal(second[0].type, 'turn-start', '本轮的收流起点必须是 turn-start');
  assert.equal(second.filter((e) => e.type === 'turn-end').length, 1, '只能有一个本轮 turn-end');
  assert.equal(second.find((e) => e.type === 'turn-start').text, '第二轮');
});

await t('测试替身 回合起点：没走过 submitTurn 时（补看历史）仍按 fromSeq 续读', async () => {
  // 兜底路径不能被这次修复弄坏。
  const p = createKernelStub();
  const { sessionId } = await p.createSession({});
  await p.submitTurn({ sessionId, content: 'a' });
  await p.submitTurn({ sessionId, content: 'b' });
  const got = [];
  for await (const ev of p.streamTurns({ sessionId, fromSeq: 8 })) got.push(ev);
  assert.deepEqual(got.map((e) => e.seq), [9, 10, 11, 12, 13, 14, 15, 16], '无 lastTurn 时退回 fromSeq 语义');
});

await t('附件仓储：每条语句都带 tenant_id，且 hydrate 不泄漏部署机路径', () => {
  const row = sessionRepo.createSessionRow({ tenantId: 'tenant-A', kernelSessionId: 'ks-att-1', title: 'A 的会话' });
  const rec = attachRepo.createAttachment({
    tenantId: 'tenant-A', sessionId: row.id, userId: 'u1',
    name: 'notes.md', mime: 'text/markdown', bytes: 12, kind: 'text',
    storedPath: 'uploads/sessions/tenant-A/' + row.id + '/att_x__notes.md', sha256: 'abc',
  });
  assert.ok(rec && rec.id, '写入应回读得到');

  // 仓储层的三重过滤：租户 + 会话 + id，缺一不可。
  // 附件是**按 id 直接寻址**的资源，若只按 id 查，就变成"知道 id 就能下载别家文件"。
  assert.ok(attachRepo.getAttachment('tenant-A', row.id, rec.id), '本租户本会话应能取到');
  assert.equal(attachRepo.getAttachment('tenant-B', row.id, rec.id), undefined, '换个租户必须取不到');
  assert.equal(attachRepo.getAttachment('tenant-A', 'ses_not_mine', rec.id), undefined, '换个会话必须取不到');
  assert.equal(attachRepo.listAttachments('tenant-B', row.id).length, 0, '跨租户列表必须为空');
  assert.equal(attachRepo.countAttachments('tenant-B', row.id), 0);
  // 跨租户删除必须删不动（否则"删除"本身成了越权写入口）
  attachRepo.deleteAttachment('tenant-B', row.id, rec.id);
  assert.ok(attachRepo.getAttachment('tenant-A', row.id, rec.id), '跨租户删除必须无效');
  assert.equal(attachRepo.getAttachmentsByIds('tenant-B', row.id, [rec.id]).length, 0, '按 id 批量取也要过滤');

  // 响应形状不得包含 stored_path —— 那是部署机的目录结构，换机器就成死链，也没必要外泄
  const h = attachRepo.hydrate(rec);
  assert.equal(h.storedPath, undefined, 'hydrate 不得输出 storedPath');
  assert.equal(JSON.stringify(h).includes('uploads/'), false, '整个响应体里不许出现存储路径');
  assert.equal(h.kind, 'text');
  assert.equal(h.bytes, 12);

  assert.equal(attachRepo.deleteAttachment('tenant-A', row.id, rec.id).id, rec.id);
  assert.equal(attachRepo.getAttachment('tenant-A', row.id, rec.id), undefined, '本租户删除应真的生效');
});

await t('附件仓储的分层：不碰 fs / 不碰 paths（落盘属于路由层的事）', () => {
  const src = fs.readFileSync(new URL('../app/data/repositories/attachments.mjs', import.meta.url), 'utf8');
  assert.ok(!/node:fs|node:path/.test(src), '仓储层不许碰文件系统 —— 字节落盘是运行时的事（paths.mjs 在路由层）');
  assert.ok(!/STORAGE_DIR|UPLOAD_DIR/.test(src), '仓储层不认识存储目录');
});

/* ── 0.10.0 · 图片附件（A 档：把图真的送到模型）──────────────────────── */

section('0.10.0 · 图片附件：按魔数嗅探、白名单硬约束、测试替身 真的收到图片块');

await t('图片嗅探：四种白名单格式按**文件魔数**认出，与扩展名/声明类型无关', () => {
  // 每种格式造一个"魔数正确"的最小字节串。嗅探只读头部，不需要是完整可解码的图 ——
  // 这是**嗅探**的单元测试；"整张图能不能被上游接受"是上游的事，不在这里假装验证。
  const mk = (bytes, tail = 16) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(tail, 0x11)]);
  assert.equal(sniffImageMediaType(mk([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffImageMediaType(mk([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageMediaType(mk([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif');
  assert.equal(sniffImageMediaType(mk([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])), 'image/gif', 'GIF87a 也要认');
  // WebP 是 RIFF 容器：必须**两段都判**，否则 .wav / .avi 会被认成图片
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
  assert.equal(sniffImageMediaType(webp), 'image/webp');
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]);
  assert.equal(sniffImageMediaType(wav), '', 'RIFF 但不是 WEBP → 不是图片（只判 RIFF 会把音频认成图）');
  // GIF 后面必须是 '7' 或 '9'：GIF8 后跟别的字节不是合法 GIF
  assert.equal(sniffImageMediaType(mk([0x47, 0x49, 0x46, 0x38, 0x58, 0x61])), '');

  // 不认识的、太短的、空的 —— 一律返回空串，**绝不猜**
  assert.equal(sniffImageMediaType(Buffer.from('%PDF-1.7')), '', 'PDF 不是图片');
  assert.equal(sniffImageMediaType(Buffer.from([0x50, 0x4b, 0x03, 0x04])), '', 'zip 不是图片');
  assert.equal(sniffImageMediaType(Buffer.alloc(3)), '', '太短不判');
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), '');
  assert.equal(sniffImageMediaType(null), '');
});

await t('toImagePart：mediaType 必须命中白名单 —— 这是硬约束，不允许调用方绕过', () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const p = toImagePart({ data: buf, mediaType: 'image/png', name: 'logo.png' });
  assert.equal(p.type, 'image');
  assert.equal(p.mediaType, 'image/png');
  assert.equal(p.name, 'logo.png');
  // base64 必须能逐字节还原（上游按"规范 base64"解码，多一个换行都会失败）
  assert.equal(Buffer.from(p.data, 'base64').equals(buf), true, 'base64 往返必须逐字节一致');
  assert.equal(/[\s]/.test(p.data), false, '不许有空白字符 —— 上游要求的是规范 base64');

  // 非白名单一律抛。**这是故意的**：调用方自报的类型一旦与字节不符，
  // 上游会让**整条消息失败**（连文本一起不发），代价远大于少送一张图。
  assert.throws(() => toImagePart({ data: buf, mediaType: 'image/bmp' }), /白名单/);
  assert.throws(() => toImagePart({ data: buf, mediaType: 'image/svg+xml' }), /白名单/, 'SVG 不在上游白名单里');
  assert.throws(() => toImagePart({ data: buf, mediaType: '' }), /白名单/);

  assert.equal(isImageMediaType('image/png'), true);
  assert.equal(isImageMediaType('IMAGE/JPEG'), true, '大小写不敏感');
  assert.equal(isImageMediaType('image/png; charset=binary'), true, '带参数也能认');
  assert.equal(isImageMediaType('image/bmp'), false);
  assert.deepEqual(IMAGE_MEDIA_TYPES, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    '白名单必须与上游 PromptContentPart 的 ImageMediaType 逐字一致');
});

await t('describeImages：把"这轮带了哪几张图"写进正文，且不谎报', () => {
  assert.equal(describeImages([]), '', '没有图片就不该产生这一段');
  assert.equal(describeImages(null), '');
  const text = describeImages([
    { name: 'logo.png', mediaType: 'image/png', bytes: 2048 },
    { name: 'shot.webp', mediaType: 'image/webp', bytes: 3 * 1024 * 1024 },
  ]);
  assert.ok(/2 张图片/.test(text), '要报出张数');
  assert.ok(/logo\.png/.test(text) && /shot\.webp/.test(text), '每张都要点名');
  assert.ok(/png/.test(text) && /webp/.test(text), '要说明格式');
  assert.ok(/2\.0KB/.test(text) && /3\.0MB/.test(text), '要给出人类可读的大小');
  assert.ok(/已作为图片内容块提交给模型/.test(text), '要明确说这是**真的送出去了**，不是"仅登记"');

  assert.equal(humanBytes(512), '512B');
  assert.equal(humanBytes(2048), '2.0KB');
  assert.equal(humanBytes(1048576), '1.0MB');
});

await t('测试替身：如实收下图片块并回执，但**不假装看见了图**（它没有视觉能力）', async () => {
  const p = createKernelStub();
  assert.equal(p.imageAttachments, true, '测试替身 必须声明支持，否则图片链路在无上游环境下没有回归');

  const { sessionId } = await p.createSession({});
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 7)]);
  await p.submitTurn({
    sessionId, content: '看看这张图',
    attachments: [toImagePart({ data: png, mediaType: 'image/png', name: 'a.png' })],
  });
  const got = [];
  for await (const ev of p.streamTurns({ sessionId })) { got.push(ev); if (ev.type === 'turn-end') break; }

  const all = JSON.stringify(got);
  assert.ok(/收到 1 个图片内容块/.test(all), '测试替身 要如实回报收到了几个图片块 —— 这是"平台确实把图送到了 provider"的铁证');
  assert.ok(/image\/png/.test(all), '要报出真实的 mediaType');
  assert.ok(/4KB/.test(all), '要报出解码后的字节数（不是 base64 长度）');
  // 最关键的一条：测试替身 没有视觉能力，**不能**编造对图片内容的描述。
  // 编一句"我看到图片里有一只猫"会让回归断言一个不存在的理解力，
  // 也会让"图片真的被理解了"这件事在演示里看起来成立 —— 那是假陈述。
  assert.ok(/没有视觉能力/.test(all), '测试替身 必须明说自己看不懂图，不许编造图片内容');

  // 不带图片时不许出现这段回执（否则等于每轮都在提"收到 0 个图片块"）
  await p.submitTurn({ sessionId, content: '纯文字' });
  const got2 = [];
  for await (const ev of p.streamTurns({ sessionId })) { got2.push(ev); if (ev.type === 'turn-end') break; }
  assert.equal(/图片内容块/.test(JSON.stringify(got2)), false, '没带图就不该有图片回执');
});

await t('图片通路的分层：平台层只做"嗅探 + 白名单"，不认识上游的块形状', () => {
  // ⚠️ 扫描源码的断言必须**先剥注释**。
  // 这不是洁癖：本轮就踩了一次 —— 旧垫片的注释里为了说明"上一版猜着传了什么"，
  // 把那个被禁的写法原样写进了注释，于是 `!/attachments: i\.attachments/` 直接误报。
  // 教训与 3.4 那次（断言被 HTML 注释里的 `<script>` 字样骗到）是同一类：
  // **凡扫源码文本的断言，先剥掉注释**，否则测的是"注释怎么写"而不是"代码怎么写"。
  const stripComments = (s) => String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

  const src = read('../app/platform/attachment/content.mjs');
  // 这个模块要能在**没有内核**的环境里单测，所以不许碰 IO / 时间 / 随机
  assert.ok(!/node:fs|node:path|node:crypto/.test(src), 'content.mjs 必须是纯函数，不许碰 IO');
  assert.ok(!/Date\.now|Math\.random|new Date/.test(src), '不许读时间或随机数（否则两次调用结果可能不同）');
  // 反向：它也不该知道"上游方法名"这类东西 —— 那是 dsh-provider 的职责
  assert.ok(!/session\/prompt|session\/submit|UPSTREAM_METHODS/.test(src), '平台层不认识上游 RPC 方法名');

  // provider 侧：图片块的并进必须发生在垫片里（越靠上游越晚），而不是在平台层
  const compat = read('../app/kernel/dsh-provider/compat/0.2.0-rc.2.mjs');
  assert.ok(/toBlocks\(i\.content, i\.attachments\)/.test(compat), '0.2.0 垫片要把图片块并进 content 数组');
  assert.ok(/SUPPORTS_IMAGE_ATTACHMENTS = true/.test(compat), '要声明支持该能力');
  // 旧垫片必须**明确否认**，不能猜着传（猜错的形状会让上游拒绝整个请求）
  const oldCompat = read('../app/kernel/dsh-provider/compat/0.1.5-rc.2.mjs');
  assert.ok(/SUPPORTS_IMAGE_ATTACHMENTS = false/.test(oldCompat), '未核实的旧垫片必须如实声明"不支持"');
  assert.ok(!/attachments: i\.attachments/.test(oldCompat), '不许再猜着透传 attachments（上一版就是猜的）');
  // ⚠️ 上游 `session/selectModel` 只认**非空字符串**的 provider 与 model（2026-10-08 对运行中的
  //    上游实测：`provider: null` / 缺 provider / 缺 model 三种都得到同一句
  //    `wire field "request" failed boundary validation`）。所以垫片不许把"可能是空"的 provider
  //    无条件写进 request —— 那一刀曾经让**新建会话必 500**（建会话时会把选择器的值一起提交），
  //    而且错误信息完全不提是哪个字段。
  assert.ok(!/provider:\s*i\.provider,/.test(compat),
    'selectModel 的 provider 不许无条件透传（空值会被上游拒掉整个请求）');
  assert.ok(/\.\.\.\(i\.provider \? \{ provider: i\.provider \} : \{\}\)/.test(compat),
    'provider 要按"有才带上"写进 request（缺省的形状与上游契约一致）');
});

/* ── 0.10.1 · 产品更名 ────────────────────────────────────
 *
 * ⚠️ 这里**刻意不写**"扫描全库禁止出现旧名"的断言。
 * 那种断言必须把**旧名本身**写进源码，等于在这次更名里又引入一次 ——
 * 就是本文件前面反复踩过的那个坑（"被测物包含测量结果"）。
 * 替代方案：对**新命名的常量与字面量**做正向断言 —— 一旦有人把命名回退，
 * 下面的字符串就找不到了，回归同样会红，而且不必写下任何要被清掉的东西。
 */
section('0.10.1 · 产品更名：规范命名钉住（正向断言，回退即红）');

await t('库文件名：规范名唯一，非规范名只被**报告**、不被自动采纳', () => {
  assert.equal(DB_BASENAME, 'sti-harness.db', '库文件规范名');
  assert.equal(path.basename(DB_FILE), DB_BASENAME, 'DB_FILE 必须落在规范名上');

  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-adopt-'));
  try {
    assert.deepEqual(findNonCanonicalDb(d), [], '空目录不该报出任何东西');
    fs.writeFileSync(path.join(d, 'other-name.db'), 'x');
    assert.deepEqual(findNonCanonicalDb(d), ['other-name.db'], '非规范 .db 必须被列出');
    fs.writeFileSync(path.join(d, DB_BASENAME), 'x');
    assert.deepEqual(findNonCanonicalDb(d), ['other-name.db'], '规范名自己不算"非规范"');
    fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
    assert.deepEqual(findNonCanonicalDb(d), ['other-name.db'], '非 .db 文件不该被列进来');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

await t('环境变量 / 指标名 / 响应头 / cookie / 令牌前缀 全部落在新命名上', () => {
  const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  assert.ok(/STI_PORT/.test(src('../app/config.mjs')), '配置层读的是 STI_PORT');
  assert.ok(/STI_DATA_DIR/.test(src('../app/paths.mjs')), '数据目录变量是 STI_DATA_DIR');
  assert.ok(/sti_http_requests_total/.test(src('../app/platform/observe/metrics.mjs')), '指标名前缀是 sti_');
  assert.ok(/x-sti-token/.test(src('../app/platform/identity/tokens.mjs')), '令牌头前缀是 x-sti-');
  // 真响应头（区别于开放接口规格里的 x-* 扩展字段，两者命名同一前缀但落点不同）
  assert.ok(/x-sti-quota-warning/.test(src('../app/http/middleware/registry.mjs')), '配额预警响应头');
  assert.ok(/x-sti-passthrough/.test(src('../app/http/pipeline.mjs')), '透传痕迹响应头');
  assert.ok(/x-sti-route-count/.test(src('../app/http/openapi.mjs')), '开放接口规格的 x-* 扩展字段');
  assert.equal(SESSION_COOKIE, 'sti_session', '会话 cookie 名');
  assert.equal(SESSION_PREFIX, 'sti_', '会话令牌前缀');
  assert.equal(APIKEY_PREFIX, 'stik_', 'API Key 前缀');
});

await t('格式串按**形态**校验：接纳更名前的前缀，但仍挡得住"随手给的 zip / JSON"', () => {
  const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const b = src('../app/platform/operation/backup.mjs');
  // 反向：不许退回等值比对 —— 那会让更名前产出的备份包一律被判"不是本平台的包"
  assert.ok(!/manifest\.format !== BACKUP_FORMAT\b/.test(b), 'format 不许退回等值比对');
  assert.ok(/BACKUP_FORMAT_RE/.test(b), '备份 format 必须走形态校验');
  assert.ok(/DB_ENTRY_RE/.test(b), '包内库文件条目名必须按形态找，不写死');
  const c = src('../app/http/routes/capability.mjs');
  assert.ok(!/body\.format !== /.test(c), '能力清单导入不许写死 format 等值比对');
  assert.ok(/CAPABILITY_FORMAT_RE/.test(c), '能力清单 format 必须走形态校验');

  // 形态正则的行为：接旧、拒乱、不串类
  const shape = /^[a-z0-9][a-z0-9-]*\/backup$/;
  assert.ok(shape.test('sti-harness/backup'), '规范前缀要过');
  assert.ok(shape.test('legacy-name/backup'), '更名前那种前缀的**形态**要过');
  assert.ok(!shape.test('random.zip'), '随便一个名字不能过');
  assert.ok(!shape.test('sti-harness/capabilities'), '不能把另一类清单当备份包');
  const capShape = /^[a-z0-9][a-z0-9-]*\/capabilities$/;
  assert.ok(capShape.test('sti-harness/capabilities') && capShape.test('legacy-name/capabilities'));
  assert.ok(!capShape.test('sti-harness/backup'), '反向也不行');
});

await t('注入标记：写出去用规范标记，识别时按形态认（更名前落库的原文仍可读）', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const k = read('../app/http/routes/kernel.mjs');
  const m = k.match(/ATTACH_INJECT_BEGIN = '([^']+)'/);
  assert.ok(m, '必须能取到服务端注入标记');
  assert.ok(m[1].includes('<<<STI-ATTACHMENTS>>>'), '服务端写出去的标记用规范名');

  // 前端自 0.11.2 起按域分成 public/app/*.js 多片 —— 常量落在哪一片都算数，扫**全部**分片。
  const feDir = new URL('../public/app/', import.meta.url);
  const fe = fs.readdirSync(feDir).filter((f) => f.endsWith('.js')).sort()
    .map((f) => fs.readFileSync(new URL(f, feDir), 'utf8')).join('\n');
  assert.ok(/WB_ATTACH_MARKER_RE/.test(fe), '前端必须有一个**按形态**识别的标记正则');
  assert.ok(/WB_ATTACH_MARKER_RE\.exec\(/.test(fe), '附件数的回读要走形态识别，而不是 indexOf 死比一个字面量');
  assert.ok(!/s\.indexOf\(WB_ATTACH_MARKER\)/.test(fe), '不许退回"只认规范字面量"（那会让更名前的会话把注入正文全露出来）');

  // 形态识别必须同时吃下"规范标记"与"其它前缀的同形态标记"
  const re = /<<<[A-Z0-9]+-ATTACHMENTS>>>/;
  assert.ok(re.test('\n\n<<<STI-ATTACHMENTS>>>\n'), '规范标记要认');
  assert.ok(re.test('\n\n<<<ZZZ-ATTACHMENTS>>>\n'), '更名前那种形态的标记也要认');
  assert.ok(!re.test('<<<sti-attachments>>>'), '小写形态**不**认（避免把随口打的东西当标记）');

  // ── 知识注入标记（0.14.0）──────────────────────────────────
  // 与附件标记同一对契约：**服务端写出去的**与**前端识别用的**都必须存在，
  // 且前端剥注入段必须走"认第一个出现的标记"的**通用**形态 ——
  // 0.14.0 起 content 的形状是 `用户原文 + 知识段 + 附件段`，
  // 若分别剥两次（先附件后知识），知识段会留在用户气泡里被当成他自己打的字。
  const km = k.match(/KB_INJECT_BEGIN = '([^']+)'/);
  assert.ok(km, '必须能取到服务端知识注入标记');
  assert.ok(km[1].includes('<<<STI-KNOWLEDGE>>>'), '服务端写出去的知识标记用规范名');
  assert.ok(km[1] !== m[1], '知识标记与附件标记必须是**两个不同**的字面量 —— 否则前端分不出哪段是哪段');
  assert.ok(/WB_KB_MARKER\s*=/.test(fe), '前端必须有知识标记的字面量副本');
  assert.ok(/WB_KB_MARKER_RE/.test(fe), '前端必须有知识标记的形态正则');
  assert.ok(/WB_INJECT_MARKER_RE\.exec\(/.test(fe), '剥注入段要走**通用**形态识别，一次切干净');

  const any = /<<<[A-Z0-9]+-(?:KNOWLEDGE|ATTACHMENTS)>>>/;
  assert.ok(any.test('\n\n<<<STI-KNOWLEDGE>>>\n'), '知识标记要认');
  assert.ok(any.test('\n\n<<<STI-ATTACHMENTS>>>\n'), '附件标记要认');
  assert.ok(any.test('\n\n<<<ZZZ-KNOWLEDGE>>>\n'), '更名前那种前缀形态的知识标记也要认');
  assert.ok(!any.test('<<<STI-SOMETHINGELSE>>>'), '不认其它类别（只有这两类会被注入）');
  assert.ok(!any.test('<<<sti-knowledge>>>'), '小写形态不认');
});

await t('显示名与产物名：界面、进程横幅、自检、NOTICE、开放接口规格、打包脚本一致', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  assert.ok(/<title>STI HARNESS/.test(read('../public/index.html')), '浏览器标题');
  assert.ok(/STI HARNESS/.test(read('../app/main.mjs')), '进程入口横幅');
  assert.ok(/STI HARNESS/.test(read('../app/diagnostics.mjs')), '部署自检首行');
  assert.ok(/title: 'STI HARNESS/.test(read('../app/http/openapi.mjs')), 'OpenAPI info.title');
  assert.ok(/^STI HARNESS$/m.test(read('../NOTICE')), 'NOTICE 首行');
  assert.ok(/sti-harness-\$\{VERSION\}\.zip/.test(read('../tools/pack-release.mjs')), '发布产物名');
  assert.ok(/STI Harness/.test(read('../start.cmd')) && /STI Harness/.test(read('../start.sh')), '启动器显示名');
});

await t('署名：全库一个口径 —— 一律完整形式（认形态，不回写实体名）', () => {
  // ⚠️ 刻意用 join 拼出被检串：若直接写字面量，本文件自己就会成为"裸署名"的唯一命中处
  //    —— 正是本项目反复踩过的「被测物包含测量结果」（这次是第 5 次变体）。
  const NEEDLE = ['Copyright', '2026', 'liwei'].join(' ');

  const EXTS = new Set(['.mjs', '.js', '.md', '.css', '.html', '.sh', '.sql']);
  const walk = (dirUrl, out) => {
    for (const e of fs.readdirSync(dirUrl, { withFileTypes: true })) {
      if (e.isDirectory()) walk(new URL(e.name + '/', dirUrl), out);
      else if (EXTS.has(path.extname(e.name))) out.push({ url: new URL(e.name, dirUrl), name: e.name });
    }
    return out;
  };

  const files = ['../app/', '../public/', '../docs/', '../tools/']
    .flatMap((r) => walk(new URL(r, import.meta.url), []))
    .concat(['../README.md', '../NOTICE', '../LICENSE', '../start.sh']
      .map((r) => ({ url: new URL(r, import.meta.url), name: r.slice(3) })));

  assert.ok(files.length > 50, '扫描面不应为空（实际 ' + files.length + ' 个文件）');

  let full = 0;
  const bare = [];
  for (const f of files) {
    const text = fs.readFileSync(f.url, 'utf8');
    for (let i = text.indexOf(NEEDLE); i !== -1; i = text.indexOf(NEEDLE, i + 1)) {
      // 「完整形式」= 署名后紧跟全角括号里的权利人名称；否则就是口径分裂
      if (text[i + NEEDLE.length] === '（') { full++; continue; }
      bare.push(f.name + ' @' + i);
    }
  }

  assert.ok(full > 50, '完整署名应当遍布源码头（实际 ' + full + ' 处）');
  assert.deepEqual(bare, [], '出现"裸"署名（缺权利人括注）＝署名口径分裂：' + bare.slice(0, 3).join(' | '));
  // 说明：`start.cmd` / `check.cmd` 因 **PURE ASCII** 约束刻意保留拼音署名形态，故不在本条扫描面内。
});

/* ── P0（体检修复）：登录爆破防护 + 会话清理定时任务 ────────── */

section('P0 · 登录爆破防护与会话清理');

await t('限流策略：登录路由有**独立**阈值，且默认档严于通用档', () => {
  const p = rateLimitPolicy();
  // ① 与环境无关的不变式：登录有**自己的**阈值键，且为正数。
  //    键是 route.id（不是路径）—— 否则路径别名能绕开专属阈值。
  assert.ok(p.routeLimits['identity.login'] > 0,
    '登录必须有专属阈值（键是 route.id，不是路径 —— 否则别名能绕开）');
  // ② 与环境无关的不变式：**两个旋钮互不串味**。
  //    收紧登录**不许**把通用档一起带下去，调通用档也不许把登录档顶上去 ——
  //    这条在"运维显式覆盖了登录档"时**依然成立**，是真正的不变式。
  const expectedDefault = Number(process.env.STI_RATE_LIMIT || 600);
  assert.equal(p.defaultPerMinute, expectedDefault,
    '通用档只应由 STI_RATE_LIMIT 决定；若被 STI_RATE_LIMIT_LOGIN 带偏，说明两个旋钮耦合了：'
    + p.defaultPerMinute + ' vs ' + expectedDefault);
  // ③ "默认档更严"是**默认值**的性质，不是运行值的性质。
  //    回归脚本起服务时会合法地把 STI_RATE_LIMIT_LOGIN 调到很大（逃生口），
  //    此时按运行值比大小必然为假 —— 那是**环境造成的假红**，不是缺陷。
  //    回归不该随环境变色，所以这条严格断言只在没有显式覆盖时生效，并说明为何不做。
  if (process.env.STI_RATE_LIMIT_LOGIN) {
    console.log('      （本机设了 STI_RATE_LIMIT_LOGIN=' + process.env.STI_RATE_LIMIT_LOGIN
      + '，默认值断言"30 < 600"在此不适用，已跳过；上面两条不变式仍然生效）');
  } else {
    assert.ok(p.routeLimits['identity.login'] < p.defaultPerMinute,
      '登录默认阈值必须严于通用默认（否则等于没做）：'
      + p.routeLimits['identity.login'] + ' vs ' + p.defaultPerMinute);
  }
});

await t('账号级退避：连错到阈值后回 429（且不再跑口令校验），对不存在账号同样计数', async () => {
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const org = orgRepo.listOrgs()[0];
  assert.ok(org, '前置条件：前面已建好组织');
  roleRepo.ensureBuiltinRoles(org.id);

  const uname = 'lock_probe_' + Date.now();
  await svc.createUser({ orgId: org.id, username: uname, password: 'Adm1n-Pass!23', roleKeys: ['member'] });
  const slug = org.slug;   // 到本段时库里已不止一个组织，登录必须指明组织（否则 400）

  // 阈值前：错误口令一律 401（还没到锁定）
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => svc.login({ username: uname, password: 'definitely-wrong', orgSlug: slug }),
      (e) => e.httpStatus === 401, '第 ' + (i + 1) + ' 次错误口令应是 401');
  }
  // 阈值后：429（退避），且是 login_throttled 而不是 401
  await assert.rejects(() => svc.login({ username: uname, password: 'definitely-wrong', orgSlug: slug }), (e) => {
    assert.equal(e.httpStatus, 429, '达到阈值后应回 429（退避），而不是 401');
    assert.equal(e.code, 'login_throttled');
    return true;
  });
  // 退避窗口内**即使口令正确**也必须被挡 —— 否则爆破者可在"锁定"后突然用对口令通过
  await assert.rejects(() => svc.login({ username: uname, password: 'Adm1n-Pass!23', orgSlug: slug }),
    (e) => e.httpStatus === 429, '退避与口令对错无关');

  // 对**不存在**的账号走同一套退避（行为一致 → 不泄漏"账号是否存在"）
  const ghost = 'ghost_' + Date.now();
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => svc.login({ username: ghost, password: 'x', orgSlug: slug }), (e) => e.httpStatus === 401);
  }
  await assert.rejects(() => svc.login({ username: ghost, password: 'x', orgSlug: slug }), (e) => e.httpStatus === 429,
    '不存在的账号也必须走同一套退避（否则"是否被锁"会成为账号枚举信号）');
});

await t('session.purge：白名单已登记，且只删"已失效且超保留期"的会话（有效会话与别家组织都不受伤）', async () => {
  assert.ok(TASK_KINDS.includes('session.purge'), 'TASK_KINDS 必须含 session.purge');
  assert.ok(isKnownKind('session.purge'), '必须有对应执行体（登记了却没实现会红）');

  const orgA = orgRepo.createOrg({ name: '会话清理A', slug: 'purge-a-' + Date.now() });
  roleRepo.ensureBuiltinRoles(orgA.id);
  const orgB = orgRepo.createOrg({ name: '会话清理B', slug: 'purge-b-' + Date.now() });
  roleRepo.ensureBuiltinRoles(orgB.id);
  const ua = userRepo.createUser({ orgId: orgA.id, username: 'purge_a', displayName: 'a', pwdHash: 'x', pwdSalt: 'y' });
  const ub = userRepo.createUser({ orgId: orgB.id, username: 'purge_b', displayName: 'b', pwdHash: 'x', pwdSalt: 'y' });

  const old = new Date(Date.now() - 30 * 86400 * 1000).toISOString();       // 30 天前建
  const past = new Date(Date.now() - 86400 * 1000).toISOString();            // 已过期
  const future = new Date(Date.now() + 86400 * 1000).toISOString();          // 仍有效
  const nowIso2 = new Date().toISOString();
  const ins = (id, uid, expires, created, revoked) => db.run(
    'INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, revoked_at) VALUES (?,?,?,?,?,?)',
    [id, uid, 'th_' + id, expires, created, revoked || null]);

  ins('as_dead', ua.id, past, old);              // ① 过期 → 应清
  ins('as_revoked', ua.id, future, old, nowIso2); // ② 已吊销 → 应清
  ins('as_live', ua.id, future, old);            // ③ 仍有效 → **不能**清（保留期只按"已失效"算）
  ins('as_other', ub.id, past, old);             // ④ 别家组织的过期 → 本次（orgA）不能清

  const cnt = (id) => Number(db.get('SELECT COUNT(*) AS n FROM auth_sessions WHERE id = ?', [id]).n);
  assert.equal(cnt('as_dead'), 1, '前置：已插入');

  const identitySvc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const res = await runTask('session.purge', { tenantId: orgA.id, params: { keepDays: 7 }, deps: { identity: identitySvc } });

  assert.equal(res.status, 'ok', '应报 ok（有东西被清），实际：' + JSON.stringify(res.detail));
  assert.equal(cnt('as_dead'), 0, '过期会话应被清');
  assert.equal(cnt('as_revoked'), 0, '已吊销且超保留期的会话应被清');
  assert.equal(cnt('as_live'), 1, '仍有效的会话**不能**被清（哪怕它建得很早）');
  assert.equal(cnt('as_other'), 1, '别家组织的记录不能被本组织的任务清掉（orgId 收窄）');
});

await t('凭据表安全自检：assertNoPlaintextColumns 已接通（列名层面无任何明文字段）', () => {
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const a = svc.assertNoPlaintextColumns();
  assert.ok(Array.isArray(a.columns) && a.columns.includes('cipher'), '应有 cipher 密文列');
  assert.deepEqual(a.suspicious, [], '凭据表不应有任何明文字段列：' + JSON.stringify(a.suspicious));
});

/* ── P1（体检修复）：横切件单点化（A1）+ 死代码清理（A2）───── */

section('P1 · 横切件单点化（A1）与死代码清理（A2）');

await t('A1 · unwrap / auditOf 单点在 _shared.mjs：三条路由不再各留一份逐字拷贝', async () => {
  const sh = await import('../app/http/routes/_shared.mjs');
  assert.equal(typeof sh.unwrap, 'function');
  assert.equal(typeof sh.auditOf, 'function');

  // 三条路由都从 _shared 引入横切件，且**不再**自带实现（改一处忘一处＝永久漂移）
  for (const f of ['model', 'notify', 'schedule']) {
    const src = fs.readFileSync(new URL('../app/http/routes/' + f + '.mjs', import.meta.url), 'utf8');
    assert.ok(/from '\.\/_shared\.mjs'/.test(src), f + '.mjs 必须从 _shared.mjs 引入横切件');
    assert.ok(!/function unwrap\(/.test(src), f + '.mjs 不该再自带 unwrap 实现');
    assert.ok(!/function audit\(ctx/.test(src), f + '.mjs 不该再自带 audit 实现');
    assert.ok(!/const USER = /.test(src), f + '.mjs 的 USER 辅助（只服务旧 audit）应已删除');
  }

  // 行为四态：ok / not_found→404 / 其余→400 / 空结果→400
  const seen = [];
  const ctx = { fail: (s, c, m) => seen.push([s, c, m]) };
  assert.equal(sh.unwrap(ctx, { ok: true }), true, 'ok 必须放行');
  assert.equal(sh.unwrap(ctx, { ok: false, reason: 'not_found', error: '没了' }), false);
  assert.deepEqual(seen[0], [404, 'not_found', '没了']);
  assert.equal(sh.unwrap(ctx, { ok: false, error: '坏了' }), false);
  assert.deepEqual(seen[1], [400, 'bad_request', '坏了']);
  assert.equal(sh.unwrap(ctx, null), false);
  assert.deepEqual(seen[2], [400, 'bad_request', '请求无法处理'], '空结果要给缺省文案，不是 undefined');

  // auditOf：治理未装配不抛；留痕抛错也不改变业务结果
  const audit = sh.auditOf('demo', null);
  audit(ctx, 'demo.act', 'r1', 'ok', null);           // 不抛即算过
  const recorded = [];
  const audit2 = sh.auditOf('demo', { audit: { append: (e) => recorded.push(e) } });
  audit2({ tenantId: 't1', userId: 'u1' }, 'demo.act', 'r2', 'ok', { k: 1 });
  assert.deepEqual(recorded[0], {
    tenantId: 't1', userId: 'u1', action: 'demo.act', resourceType: 'demo',
    resourceId: 'r2', result: 'ok', detail: { k: 1 },
  });
  const audit3 = sh.auditOf('demo', { audit: { append: () => { throw new Error('留痕坏了'); } } });
  audit3({ tenantId: 't1', userId: null }, 'demo.act', 'r3', 'ok', null);   // 必须吞掉
});

await t('A1 · safeBaseName 单点（安全件）：路径穿越被吃掉，且两处调用共用同一实现', async () => {
  const { safeBaseName } = await import('../app/util/fname.mjs');
  assert.equal(safeBaseName('../../etc/passwd'), 'passwd');
  assert.equal(safeBaseName('..\\..\\etc\\passwd'), 'passwd');
  assert.equal(safeBaseName('/a/b/c.txt'), 'c.txt');
  assert.equal(safeBaseName('', 'attachment'), 'attachment');
  assert.equal(safeBaseName('a b:c?d.txt'), 'a_b_c_d.txt', '非法字符替换为下划线');
  assert.ok(!safeBaseName('x/y').includes('/'), '结果里不许再有目录分隔');
  assert.ok(!safeBaseName('a\\b').includes('\\'), '结果里不许再有反斜杠');
  assert.ok(safeBaseName('a'.repeat(300)).length <= 120, '必须截断到 120');
  assert.equal(safeBaseName('中文名.pdf'), '中文名.pdf', '中文必须保留');

  // 两处调用方不再自带实现（安全件的"加固一处漏一处"就出在这）
  const k = fs.readFileSync(new URL('../app/http/routes/kernel.mjs', import.meta.url), 'utf8');
  const s = fs.readFileSync(new URL('../app/platform/knowledge/service.mjs', import.meta.url), 'utf8');
  assert.ok(/from '\.\.\/\.\.\/util\/fname\.mjs'/.test(k), 'kernel 必须引公共 fname');
  assert.ok(/from '\.\.\/\.\.\/util\/fname\.mjs'/.test(s), 'knowledge/service 必须引公共 fname');
  assert.ok(!/function safeBaseName/.test(k) && !/function safeBaseName/.test(s), '不该再有本地拷贝');
});

await t('A1 · parseJsonSafe 单点：坏值/空值/JSON null 一律兜底（与旧 6 份变体语义一致）', async () => {
  const { parseJsonSafe } = await import('../app/util/json.mjs');
  assert.deepEqual(parseJsonSafe('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonSafe(''), {}, '空串兜底');
  assert.deepEqual(parseJsonSafe(null), {}, 'null 兜底');
  assert.deepEqual(parseJsonSafe(undefined), {}, 'undefined 兜底');
  assert.deepEqual(parseJsonSafe('{oops'), {}, '语法错误兜底');
  assert.deepEqual(parseJsonSafe('null'), {}, 'JSON 字面量 null 也归兜底 —— 否则下游 meta.foo 会抛');
  assert.deepEqual(parseJsonSafe('null', []), [], '兜底值由调用方给');
  assert.deepEqual(parseJsonSafe('[]', {}), []);
  assert.equal(parseJsonSafe('42', 0), 42, '合法标量要原样返回');
  // 与真解析器划清界限：文档解析器失败必须**抛**（那是另一件事，不能合并）
  const docParser = await import('../app/platform/knowledge/parsers/json.mjs');
  assert.throws(() => docParser.parseJson(Buffer.from('{ 坏 )')), /JSON 解析失败/,
    '文档解析器必须如实抛错，不能被容错版吞掉');
});

await t('A1 · rowBy 单点：表名/列名走白名单，未登记的直接抛错', async () => {
  const rows = await import('../app/data/repositories/rows.mjs');
  assert.equal(typeof rows.rowBy, 'function');
  assert.throws(() => rows.rowBy('t', 'users', 'id', '1'), /未登记/, '未登记的表名必须拒（替身：把外部输入传进来）');
  assert.throws(() => rows.rowBy('t', 'model_providers', 'secret', '1'), /未登记/, '未登记的列名必须拒');
  assert.throws(() => rows.rowBy('t', 'users; DROP TABLE users', 'id', '1'), /未登记/, '注入串也是"未登记表名"');

  for (const f of ['model', 'notify', 'schedule']) {
    const src = fs.readFileSync(new URL('../app/platform/' + f + '/service.mjs', import.meta.url), 'utf8');
    assert.ok(/from '\.\.\/\.\.\/data\/repositories\/rows\.mjs'/.test(src), f + ' 服务必须用公共 rowBy');
    assert.ok(!/function rowById\(/.test(src), f + ' 服务不该再自带 rowById（租户过滤是安全边界，必须单点）');
  }
});

await t('A2 · 死代码已清（正向断言：被改回就报红）；in-flight 指标已真接线', async () => {
  const ids = await import('../app/util/ids.mjs');
  assert.equal(ids.safeEqual, undefined, 'safeEqual 应已删除（真实令牌比对走 tokens.hashToken）');
  assert.equal(ids.uuid, undefined, 'uuid 全仓零调用（ID 一律走带前缀的 newId）');
  assert.equal(ids.sha256Hex, undefined, 'sha256Hex 全仓零调用');
  assert.equal(ids.hmacHex, undefined, 'hmacHex 全仓零调用 —— 令牌哈希只走 tokens.hashToken，两套 HMAC 口径不同');
  assert.throws(() => ids.newId(), /prefix/, 'newId 漏传前缀必须当场抛错（此前 artifacts 漏传，落库成了 undefined_…）');
  assert.throws(() => ids.newId(''), /prefix/, '空前缀同样抛错');
  assert.match(ids.newId('usr'), /^usr_/, '正常前缀仍必须可用');

  const roles = await import('../app/platform/identity/repos/roles.mjs');
  assert.equal(roles.getBinding, undefined, 'getBinding 是上一轮我自己留下的死导出');
  assert.equal(typeof roles.orgIdOfBinding, 'function', '撤销授权真正用的是 orgIdOfBinding，它必须在');

  const db = await import('../app/data/db.mjs');
  assert.equal(db.currentFile, undefined, 'currentFile 与 dbInfo().file 重复，应已删除');

  const contract = await import('../app/kernel/contract.mjs');
  assert.equal(contract.eventPayload, undefined, 'eventPayload 无人调用（落库走 events.mjs 的字段白名单）');

  const concurrency = await import('../app/platform/governance/concurrency.mjs');
  assert.equal(concurrency.activeTotal, undefined, 'activeTotal 是 totalAll 的冗余别名');
  const quotas = await import('../app/platform/governance/quotas.mjs');
  assert.equal(quotas.concurrentActive, undefined, 'concurrentActive 无人调用');
  const cost = await import('../app/platform/governance/cost.mjs');
  assert.equal(cost.PRICE_COLUMNS, undefined, 'PRICE_COLUMNS 无人调用（迁移里是硬编码列名）');
  assert.ok(Array.isArray(cost.PRICE_FIELDS) && cost.PRICE_FIELDS.length, 'PRICE_FIELDS 是在用的那个，必须留');

  const emb = await import('../app/platform/knowledge/embedding.mjs');
  assert.equal(emb.keywordVectors, undefined, 'keyword 降级实现已废弃（EMBED_MODES 里根本没有 keyword）');
  assert.ok(emb.EMBED_MODES.every((m) => m !== 'keyword'), '模式白名单确认不含 keyword');
  const parsers = await import('../app/platform/knowledge/parsers/index.mjs');
  assert.equal(parsers.EXTERNAL_FORMATS, undefined);
  assert.ok(Array.isArray(parsers.NATIVE_FORMATS) && parsers.NATIVE_FORMATS.length, 'NATIVE_FORMATS 是在用的那个，必须留');
  const qw = await import('../app/util/quiet-warnings.mjs');
  assert.equal(qw.SUPPRESSED, undefined);

  // in-flight 计数：导出保留，且真的接到请求管线的进出口（成对）
  const metrics = await import('../app/platform/observe/metrics.mjs');
  assert.equal(typeof metrics.beginInflight, 'function');
  assert.equal(typeof metrics.endInflight, 'function');
  const pipe = fs.readFileSync(new URL('../app/http/pipeline.mjs', import.meta.url), 'utf8');
  assert.ok(/metrics\.beginInflight\(\)/.test(pipe) && /metrics\.endInflight\(\)/.test(pipe),
    'in-flight 必须在 run 的进出口成对 —— 否则 sti_process_inflight_requests 是个恒 0 的假指标');
});

/* ── 出口补齐：把"能力已实现但没出口"的两条真正接上 ───────────── */

section('出口补齐：删除用户 / 移出组（A2-(b) 的"补出口"）');

await t('删除用户：真删 + 依赖行一起清干净 + 自删/最后一个 owner/跨组织三道守卫', async () => {
  const apiKeyRepo = await import('../app/platform/identity/repos/apiKeys.mjs');
  const sessRepo = await import('../app/platform/identity/repos/authSessions.mjs');

  const o = orgRepo.createOrg({ name: '出口公司', slug: 'outlet-corp' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });

  const own = await svc.createUser({ orgId: o.id, username: 'out_own', password: 'Own3r-Pass!23', roleKeys: ['owner'] });
  const gone = await svc.createUser({ orgId: o.id, username: 'out_gone', password: 'Gone-Pass!234', roleKeys: ['member'] });

  // 造真实依赖行：这些表都带 `REFERENCES users(id)`（外键 RESTRICT），不清就删不掉人
  const sess = await svc.login({ orgSlug: 'outlet-corp', username: 'out_gone', password: 'Gone-Pass!234', ip: '127.0.0.1', ua: 't' });
  assert.ok(sess && sess.token, '前置：应能登录拿到会话');
  svc.createApiKeyFor(gone.id, { name: 'k1' });
  const g = svc.createGroup(o.id, { name: '临时组' });
  svc.setGroupMembers(o.id, g.id, [gone.id]);
  assert.equal(svc.describeGroup(o.id, g.id).members.length, 1);
  // 两步验证三表（user_totp / user_recovery_codes / login_challenges）同样带 RESTRICT：
  // 登记一套 + 留一张未完成登录票据，删除时必须一并清（0.17.0 新增，见 deleteUser 的 removed 形状）
  const begin = await svc.totpBeginEnroll(o.id, gone.id, { password: 'Gone-Pass!234' });
  await svc.totpConfirmEnroll(o.id, gone.id, { code: hotp(base32Decode(begin.secret), totpStepAt()) });
  const pending2fa = await svc.login({ orgSlug: 'outlet-corp', username: 'out_gone', password: 'Gone-Pass!234' });
  assert.ok(pending2fa.ticket, '前置：留一张未完成的第二步票据');

  // ① 自删守卫：actor 就是被删的人
  assert.throws(() => svc.deleteUser(o.id, own.id, { actorUserId: own.id }), (e) => e.code === 'conflict',
    '不能删当前登录账号（会把自己锁在外面）');
  // ② 最后一个 owner：删了他组织就没人能管 —— 冲突，且**整体回滚**
  assert.throws(() => svc.deleteUser(o.id, own.id, { actorUserId: gone.id }), (e) => e.code === 'conflict',
    '删掉唯一 owner 必须被拦');
  assert.ok(svc.listUsers(o.id).some((u) => u.id === own.id), '守卫命中后必须回滚，owner 仍在册');

  // ③ 跨组织：拿别家的 id 来删 → 404（不是"删掉了别人家的人"）
  const o2 = orgRepo.createOrg({ name: '别家公司', slug: 'other-corp' });
  roleRepo.ensureBuiltinRoles(o2.id);
  const foreign = await svc.createUser({ orgId: o2.id, username: 'foreign_1', password: 'For3ign-Pass!2', roleKeys: ['member'] });
  assert.throws(() => svc.deleteUser(o.id, foreign.id, { actorUserId: own.id }), (e) => e.code === 'not_found',
    '别家组织的 id 在本组织里就是"不存在"');
  assert.ok(svc.listUsers(o2.id).some((u) => u.id === foreign.id), '而且别家的人必须毫发无伤');

  // ④ 正常删除：依赖行一起清干净（这就是"真删"与"停用"的区别；含两步验证三表）
  const r = svc.deleteUser(o.id, gone.id, { actorUserId: own.id });
  assert.deepEqual(r.removed, {
    roleBindings: 1, groupMemberships: 1, apiKeys: 1, sessions: 1,
    totp: 1, recoveryCodes: RECOVERY_CODE_COUNT, loginChallenges: 1,
  });
  assert.ok(!svc.listUsers(o.id).some((u) => u.id === gone.id), '删除后不该还在用户列表里');
  assert.equal(roleRepo.bindingsForSubject('user', gone.id).length, 0, '角色绑定要一起清');
  assert.equal(apiKeyRepo.listForUser(gone.id).length, 0, 'API Key 要一起清');
  assert.equal(sessRepo.listActiveForUser(gone.id).length, 0, '会话要一起清');
  assert.equal(svc.describeGroup(o.id, g.id).members.length, 0, '组关系要一起清');
  assert.equal(totpRepo.getTotp(gone.id), undefined, 'TOTP 密钥行要一起清（RESTRICT 表，漏一张就删不掉人）');
  assert.equal(totpRepo.countUnusedRecoveryCodes(gone.id), 0, '恢复码要一起清');
  assert.equal(totpRepo.listChallengesForUser(gone.id).length, 0, '未完成的第二步票据要一起清');

  // ⑤ 再删一次 → 404（如实报"不存在"，不装作又删了一次）
  assert.throws(() => svc.deleteUser(o.id, gone.id, { actorUserId: own.id }), (e) => e.code === 'not_found');
});

await t('移出组：定点移除（不等于整组替换）；owner 只能经组得到时不许把最后一人移出', async () => {
  const o = orgRepo.createOrg({ name: '移出公司', slug: 'kick-corp' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });

  const u1 = await svc.createUser({ orgId: o.id, username: 'kick_1', password: 'Kick-Pass!2345', roleKeys: ['member'] });
  const u2 = await svc.createUser({ orgId: o.id, username: 'kick_2', password: 'Kick-Pass!2345', roleKeys: ['member'] });
  const g = svc.createGroup(o.id, { name: 'G1' });
  svc.setGroupMembers(o.id, g.id, [u1.id, u2.id]);
  assert.equal(svc.describeGroup(o.id, g.id).members.length, 2);

  // 定点移除一个，另一个**不受影响** —— 这正是它不能被"整组替换"替代的理由
  const r = svc.removeGroupMember(o.id, g.id, u1.id);
  assert.equal(r.userId, u1.id);
  assert.deepEqual(svc.describeGroup(o.id, g.id).members.map((m) => m.userId), [u2.id]);
  // 再移一次 / 移一个不在组里的 / 组不存在 → 都是 404
  assert.throws(() => svc.removeGroupMember(o.id, g.id, u1.id), (e) => e.code === 'not_found');
  assert.throws(() => svc.removeGroupMember(o.id, 'g_nope', u1.id), (e) => e.code === 'not_found');

  // owner 只经组得到时：把组里最后一个成员移出 = 组织没人能管 → 拦下
  const o3 = orgRepo.createOrg({ name: '组主公司', slug: 'grp-owner-corp' });
  roleRepo.ensureBuiltinRoles(o3.id);
  const solo = await svc.createUser({ orgId: o3.id, username: 'solo_1', password: 'Solo-Pass!2345', roleKeys: ['member'] });
  const og = svc.createGroup(o3.id, { name: 'OwnerOnly' });
  svc.setGroupRoles(o3.id, og.id, ['owner']);
  svc.setGroupMembers(o3.id, og.id, [solo.id]);
  assert.equal(roleRepo.countHolders(o3.id, 'owner'), 1, '前置：该组织此刻只有 1 个生效 owner（经组）');
  assert.throws(() => svc.removeGroupMember(o3.id, og.id, solo.id), (e) => e.code === 'conflict',
    '最后一个 owner 不能被移出组（withOwnerGuard 数的是生效 owner，含组带进来的）');
});

/* ──────────────────────────────────────────────────────────── */
section('B2 · 向量预过滤：默认关、安全阀、代价可见（不许静默改变答案）');

// 造一副专供预过滤测试的语料：40 条含查询词 + 20 条不含，**每条都有向量**。
// 这样"全量扫描 60 条"与"候选 40 条"是两个可区分的数字 —— 否则根本证明不了预过滤真的在缩范围。
const PF_TENANT = 'org_pf';
const PF_KB = 'kb_pf';
const PF_DOC = 'doc_pf';
const PF_DIM = 8;
const PF_HITS = 40;
const PF_MISS = 20;

db.run("INSERT INTO orgs(id,name,slug,created_at) VALUES('org_pf','预过滤','pf','2026-01-01')");
db.run("INSERT INTO knowledge_bases(id,tenant_id,name,created_at) VALUES('kb_pf','org_pf','预过滤库','2026-01-01')");
db.run("INSERT INTO documents(id,kb_id,title,status,created_at) VALUES('doc_pf','kb_pf','预过滤文档','ready','2026-01-01')");

function pfVec(seed) {
  const f = new Float32Array(PF_DIM);
  for (let i = 0; i < PF_DIM; i++) f[i] = Math.sin((seed + 1) * (i + 1));
  let n = 0;
  for (let i = 0; i < PF_DIM; i++) n += f[i] * f[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < PF_DIM; i++) f[i] /= n;
  return f;
}

const pfChunkIds = [];
for (let i = 0; i < PF_HITS + PF_MISS; i++) {
  const body = i < PF_HITS
    ? ('预过滤测试文本 第' + i + '段 权限管理 数据治理')
    : ('无关内容占位 第' + i + '段 别的主题');
  db.run('INSERT INTO chunks(doc_id,kb_id,ord,body,bigrams,meta_json,token_count) VALUES(?,?,?,?,?,?,?)',
    [PF_DOC, PF_KB, i, body, toIndexText(body), '{}', 5]);
  const id = Number(db.get('SELECT id FROM chunks WHERE doc_id = ? AND ord = ?', [PF_DOC, i]).id);
  pfChunkIds.push(id);
  db.run('INSERT INTO chunk_vectors(chunk_id,dim,vec) VALUES(?,?,?)', [id, PF_DIM, Buffer.from(pfVec(i).buffer)]);
}

// 本机 stub 向量服务：让"预过滤真的生效"这条路能在**没有外部模型**的机器上被回归覆盖。
// 不起它的话，这条链路就只能靠 bench-search 覆盖 —— 而基准脚本不在门禁里，等于没有回归。
let pfStub = null;
let pfPort = 0;
{
  pfStub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* 按缺字段处理 */ }
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input == null ? '' : parsed.input];
      const data = inputs.map((text, idx) => {
        let h = 0;
        for (const ch of String(text == null ? '' : text)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
        return { index: idx, embedding: Array.from(pfVec((h + idx) % 977)) };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data, model: 'pf-stub' }));
    });
  });
  await new Promise((r) => pfStub.listen(0, '127.0.0.1', r));
  pfPort = pfStub.address().port;
}

const pfValues = (extra = {}) => ({
  embeddingProvider: 'openai-compat',
  embeddingBaseUrl: 'http://127.0.0.1:' + pfPort + '/v1',
  embeddingModel: 'pf-stub',
  workerPoolSize: 0,                      // 内联执行：本用例不碰解析/分块，不需要 worker
  ...extra,
});
const pfSvc = createKnowledgeService({ config: { values: pfValues() } });

await t('预过滤默认关：缺省时行为与改动前一致（默认值不许悄悄改变检索答案）', async () => {
  const r = await pfSvc.search({ tenantId: PF_TENANT, roles: [], query: '预过滤', limit: 10, kbIds: [PF_KB] });
  assert.equal(r.retrieval.prefilter.enabled, false, '缺省必须关（严格 === true 才开）');
  assert.equal(r.retrieval.prefilter.applied, false);
  assert.equal(r.retrieval.prefilter.reason, 'disabled');
  assert.equal(r.retrieval.prefilter.source, 'config');
  assert.equal(r.retrieval.scannedVectors, PF_HITS + PF_MISS,
    '关掉时是全量精确扫描，必须扫到全部 ' + (PF_HITS + PF_MISS) + ' 条');
});

await t('预过滤显式打开：只扫候选、文本路径不受影响、代价写在结果里', async () => {
  const off = await pfSvc.search({ tenantId: PF_TENANT, roles: [], query: '预过滤', limit: 10, kbIds: [PF_KB], prefilter: false });
  const on = await pfSvc.search({ tenantId: PF_TENANT, roles: [], query: '预过滤', limit: 10, kbIds: [PF_KB], prefilter: true });

  assert.equal(on.retrieval.prefilter.enabled, true);
  assert.equal(on.retrieval.prefilter.source, 'request', '请求级覆盖要如实标注来源');
  assert.equal(on.retrieval.prefilter.reason, 'applied');
  assert.equal(on.retrieval.prefilter.applied, true);
  assert.equal(on.retrieval.prefilter.candidates, PF_HITS, '候选应等于文本命中数');
  assert.equal(on.retrieval.scannedVectors, PF_HITS, '应恰好只扫候选');
  assert.ok(on.retrieval.scannedVectors < off.retrieval.scannedVectors,
    '预过滤必须真的少扫：' + on.retrieval.scannedVectors + ' vs ' + off.retrieval.scannedVectors);
  // 预过滤只动向量侧：文本匹配档必须一模一样，否则它就在偷偷改另一条路径
  assert.equal(on.retrieval.ftsMatchMode, off.retrieval.ftsMatchMode, 'FTS 匹配档不得因预过滤而改变');
  // 代价必须可见 —— "丢了什么"要写在结果里，不能只活在文档里
  assert.ok(on.notes.some((n) => n.includes('已预过滤')), '结果 notes 里必须有一条预过滤说明');
  assert.ok(on.notes.some((n) => n.includes('纯语义召回')), '那条说明必须点明代价是纯语义召回');
});

await t('安全阀：字面 0 命中时必须退化为全量扫描，向量路径不得被饿死', async () => {
  const q = '完全不存在的词汇zzz';
  const ids = searchFtsIds({ tenantId: PF_TENANT, kbIds: [PF_KB], query: q, limit: 512 });
  assert.equal(ids.ids.length, 0, '构造前提：该查询字面 0 命中');

  const r = await pfSvc.search({ tenantId: PF_TENANT, roles: [], query: q, limit: 10, kbIds: [PF_KB], prefilter: true });
  assert.equal(r.retrieval.prefilter.applied, false, '候选不足时**不许**预过滤');
  assert.equal(r.retrieval.prefilter.reason, 'too_few_candidates');
  assert.equal(r.retrieval.scannedVectors, PF_HITS + PF_MISS,
    '必须退化为全量扫描 —— 否则纯语义查询会静默失效（这正是整套预过滤最容易坏的地方）');
  assert.ok(r.results.length > 0, '退化后向量路径必须仍有结果，不能被饿死');
});

await t('检索器层：candidateIds 的三态语义（null=全量 / 数组=候选 / 空数组=如实为空）', () => {
  const qv = pfVec(3);

  const full = searchVector({ tenantId: PF_TENANT, kbIds: [PF_KB], queryVec: qv, limit: 5 });
  assert.equal(full.scanned, PF_HITS + PF_MISS, 'null → 全量扫描');
  assert.equal(full.prefilter.requested, false);

  const some = pfChunkIds.slice(0, 7);
  const pre = searchVector({ tenantId: PF_TENANT, kbIds: [PF_KB], queryVec: qv, limit: 5, candidateIds: some });
  assert.equal(pre.scanned, 7, '数组 → 只扫候选');
  assert.equal(pre.prefilter.applied, true);
  assert.ok(pre.items.length <= 7);

  const empty = searchVector({ tenantId: PF_TENANT, kbIds: [PF_KB], queryVec: qv, limit: 5, candidateIds: [] });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.scanned, 0);
  assert.ok(empty.notes.some((n) => n.includes('候选集为空')), '空候选要如实说明，不能静默退回全扫');

  const huge = Array.from({ length: 901 }, (_, i) => i + 1);
  const capped = searchVector({ tenantId: PF_TENANT, kbIds: [PF_KB], queryVec: qv, limit: 5, candidateIds: huge });
  assert.equal(capped.prefilter.requested, true);
  assert.equal(capped.prefilter.applied, false, '超过 SQL 变量安全上限必须退化为全扫描');
  assert.ok(capped.notes.some((n) => n.includes('安全上限')), '退化原因必须写出来');
  assert.equal(capped.scanned, PF_HITS + PF_MISS, '退化后确实是全量');
});

await t('候选口径与文本结果同源：不许两套匹配语义（否则候选与结果会各自漂移）', () => {
  const f = searchFts({ tenantId: PF_TENANT, kbIds: [PF_KB], query: '预过滤', limit: 10 });
  const ids = searchFtsIds({ tenantId: PF_TENANT, kbIds: [PF_KB], query: '预过滤', limit: 512 });
  assert.equal(f.matchMode, ids.matchMode, '同一查询必须走同一档匹配');
  assert.equal(ids.ids.length, PF_HITS, '候选不截断时应拿到全部命中');
  assert.ok(f.items.every((it) => ids.ids.includes(it.chunkId)), '文本结果里的每个 chunk 都必须在候选集内');
});

await t('候选上限被夹到安全上限内（配置写大不会变成 SQL 变量爆炸）', async () => {
  const svc = createKnowledgeService({
    config: { values: pfValues({ prefilterVector: true, prefilterCandidates: 99999 }) },
  });
  try {
    const r = await svc.search({ tenantId: PF_TENANT, roles: [], query: '预过滤', limit: 10, kbIds: [PF_KB] });
    assert.equal(r.retrieval.prefilter.enabled, true, '配置里显式 true 要真的生效');
    assert.ok(r.retrieval.prefilter.maxCandidates <= 900,
      '候选上限必须被夹住（SQL 变量数上限），实际 ' + r.retrieval.prefilter.maxCandidates);
    assert.ok(r.notes.some((n) => n.includes('安全上限')), '被夹这件事要如实说明，不能静默截断');
  } finally {
    await svc.close();
  }
});

await pfSvc.close();
await new Promise((r) => pfStub.close(r));

section('B8 · 部门：是「组织归属」，不是权限载体（补出口，不删表）');

await t('部门：创建 / 列出 / 成员数真实 —— countDepartments 不再是恒 0 的假数', async () => {
  const o = orgRepo.createOrg({ name: '部门公司', slug: 'b8-dept-corp' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });

  assert.equal(svc.listDepartments(o.id).length, 0, '新组织不该有任何部门');

  const d1 = svc.createDepartment(o.id, { name: '测绘一室' });
  const d2 = svc.createDepartment(o.id, { name: '测绘二室', parentId: d1.id });
  assert.equal(d1.parentId, null, '不传 parentId 时必须是顶层（null，不是 undefined）');
  assert.equal(d2.parentId, d1.id, 'parentId 要规范化成部门 id');
  // 创建接口与列表接口的字段形状必须一致：否则前端 `d.memberCount + ' 人'`
  // 会在创建路径上渲染出 "null 人" 这种只有仔细看才发现的东西。
  assert.equal(d1.memberCount, 0, '新建部门的成员数是 0（数字），与列表同形状');

  const list = svc.listDepartments(o.id);
  assert.equal(list.length, 2);
  // memberCount 必须是**数字**：null 会被前端渲染成"—"，那就分不清
  // "这个部门没人"与"成员数没查出来"。这两种状态需要用完全不同的方式处理。
  assert.equal(typeof list[0].memberCount, 'number', '成员数必须是数字，不能是 null');

  await svc.createUser({ orgId: o.id, username: 'b8_deng_a', password: 'Adm1n-Pass!23', roleKeys: ['member'], deptId: d1.id });
  await svc.createUser({ orgId: o.id, username: 'b8_deng_b', password: 'Adm1n-Pass!23', roleKeys: ['member'], deptId: d2.id });

  const after = svc.listDepartments(o.id);
  assert.equal(after.find((x) => x.id === d1.id).memberCount, 1, '成员数要真的数出来（否则又是一个"公开着却恒为 0"的假指标）');
  assert.equal(after.find((x) => x.id === d2.id).memberCount, 1);
  // 没有直属部门的用户不该被算进任何部门（SQL 里 dept_id IS NOT NULL 那一条）
  await svc.createUser({ orgId: o.id, username: 'b8_no_dept', password: 'Adm1n-Pass!23', roleKeys: ['member'] });
  const total = svc.listDepartments(o.id).reduce((s, x) => s + x.memberCount, 0);
  assert.equal(total, 2, '没有任何部门归属的人不该被摊派到某个部门头上');
});

await t('部门：重名 / 空名 / 超长一律拒绝，且唯一性只在组织内（不同组织可同名）', async () => {
  const o = orgRepo.createOrg({ name: '部门公司2', slug: 'b8-dept-corp2' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });

  svc.createDepartment(o.id, { name: '综合处' });
  assert.throws(() => svc.createDepartment(o.id, { name: '综合处' }), /同名部门/, '同组织重名必须拒绝');
  assert.throws(() => svc.createDepartment(o.id, { name: '   ' }), /不能为空/, '只有空格的名字等于空名');
  assert.throws(() => svc.createDepartment(o.id, { name: 'x'.repeat(65) }), /过长/, '超长名字要拒（避免把界面撑坏）');

  const o2 = orgRepo.createOrg({ name: '部门公司3', slug: 'b8-dept-corp3' });
  roleRepo.ensureBuiltinRoles(o2.id);
  assert.ok(svc.createDepartment(o2.id, { name: '综合处' }).id, '同名部门在不同组织之间互不影响');
});

await t('★ 跨租户守卫：别家组织的 deptId 必须被拒（写入端拦掉，不产生"看起来没事的错"）', async () => {
  const oA = orgRepo.createOrg({ name: '甲单位', slug: 'b8-dept-a' });
  const oB = orgRepo.createOrg({ name: '乙单位', slug: 'b8-dept-b' });
  roleRepo.ensureBuiltinRoles(oA.id);
  roleRepo.ensureBuiltinRoles(oB.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const dB = svc.createDepartment(oB.id, { name: '乙的部门' });
  const dA = svc.createDepartment(oA.id, { name: '甲的部门' });

  // 建人时塞别家的部门 id → 必须拒。
  // 为什么这条比一般的"参数校验"重要：`users.dept_id` 是弱引用，任何组织的部门 id
  // 在语法上都合法，不拦就会安静地写进去一个永远对不上的跨租户引用。
  await assert.rejects(
    () => svc.createUser({ orgId: oA.id, username: 'b8_cross_a', password: 'Adm1n-Pass!23', roleKeys: ['member'], deptId: dB.id }),
    /不属于本组织/,
    '建人时跨组织的 deptId 必须被拒'
  );

  // 改归属时同一道守卫
  const u = await svc.createUser({ orgId: oA.id, username: 'b8_cross_b', password: 'Adm1n-Pass!23', roleKeys: ['member'] });
  assert.throws(() => svc.setUserProfile(oA.id, u.id, { deptId: dB.id }), /不属于本组织/);
  // 正对照：本组织的部门必须能挂上 —— 否则上面的"拒绝"可能只是"功能全坏了"
  assert.equal(svc.setUserProfile(oA.id, u.id, { deptId: dA.id }).deptId, dA.id, '本组织的部门必须能挂上');
});

await t('改归属：undefined=不改、null=清空 —— 两者混了会得到一个"改不掉的部门"', async () => {
  const o = orgRepo.createOrg({ name: '部门公司4', slug: 'b8-dept-corp4' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const d = svc.createDepartment(o.id, { name: '资料室' });
  const u = await svc.createUser({ orgId: o.id, username: 'b8_p1', password: 'Adm1n-Pass!23', roleKeys: ['member'], deptId: d.id });

  // 只改姓名、不带 deptId → 部门必须留着。
  // 这正是 `body.deptId || null` 这种写法会踩的坑：一次改姓名就把归属抹掉，还回 200 说成功。
  const r1 = svc.setUserProfile(o.id, u.id, { displayName: '新名字' });
  assert.equal(r1.deptId, d.id, '只改姓名不该把部门清空');
  assert.equal(r1.displayName, '新名字');

  assert.equal(svc.setUserProfile(o.id, u.id, { deptId: null }).deptId, null, 'null 必须能清空归属');
  assert.equal(svc.setUserProfile(o.id, u.id, { deptId: '' }).deptId, null, '空串等同清空（前端下拉的"不归属"就是空串）');
  assert.throws(() => svc.setUserProfile(o.id, u.id, {}), /没有要修改的字段/, '空 patch 要拒绝，不能"啥也没干还回 200"');
  assert.throws(() => svc.setUserProfile(o.id, u.id, { displayName: '  ' }), /不能为空/);
});

await t('★ 部门不改变权限：挂进「管理员部」也不会得到任何权限', async () => {
  const o = orgRepo.createOrg({ name: '部门公司5', slug: 'b8-dept-corp5' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const d = svc.createDepartment(o.id, { name: '管理员部' });   // 名字故意带"管理员"
  const u = await svc.createUser({ orgId: o.id, username: 'b8_p2', password: 'Adm1n-Pass!23', roleKeys: ['member'] });

  const before = roleRepo.roleKeysForUser(u.id);
  svc.setUserProfile(o.id, u.id, { deptId: d.id });
  const after = roleRepo.roleKeysForUser(u.id);
  assert.deepEqual(after, before, '★ 部门归属不得改变角色 —— 部门不是权限载体');
  assert.ok(!after.includes('admin'), '"管理员部"只是一个名字，不会给人任何权限（这正是最容易被误解的地方）');
});

await t('权限矩阵：部门有出口就要有权能，且不该列出用不上的动作', () => {
  assert.equal(can(['admin'], 'department', 'read'), true);
  assert.equal(can(['admin'], 'department', 'write'), true, 'admin 不能写部门的话，"新建部门"按钮就是个摆设');
  assert.equal(can(['member'], 'department', 'read'), true, '成员可看组织架构');
  assert.equal(can(['member'], 'department', 'write'), false, '成员不能改组织架构');
  assert.equal(can(['viewer'], 'department', 'write'), false);
  // 0.17.0 补齐了删除出口，权能表按上一条断言的约定**一起改**：
  // 有出口却不给权能，等于界面上那个按钮永远 403。
  assert.equal(can(['admin'], 'department', 'delete'), true, '删除出口已补齐 → admin 必须能删');
  assert.equal(can(['owner'], 'department', 'delete'), true, 'owner 走通配符，全权');
  assert.equal(can(['member'], 'department', 'delete'), false, '成员不能删组织架构');
  assert.equal(can(['viewer'], 'department', 'delete'), false);
});

await t('★ 部门改名（0.17.0 出口补齐）：空名 / 超长 / 重名（排除自己）/ 跨租户 一律拒绝', async () => {
  const o = orgRepo.createOrg({ name: '部门公司6', slug: 'b8-dept-corp6' });
  const o2 = orgRepo.createOrg({ name: '部门公司7', slug: 'b8-dept-corp7' });
  roleRepo.ensureBuiltinRoles(o.id);
  roleRepo.ensureBuiltinRoles(o2.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const d = svc.createDepartment(o.id, { name: '测绘处' });
  svc.createDepartment(o.id, { name: '资料处' });

  const renamed = svc.renameDepartment(o.id, d.id, { name: '测绘一处' });
  assert.equal(renamed.name, '测绘一处', '改名要真的写进去');
  assert.equal(typeof renamed.memberCount, 'number', '改名响应与列表同形状（成员数是数字，不是 null）');
  assert.equal(typeof renamed.childCount, 'number', '改名响应与列表同形状（子部门数是数字，不是 null）');

  // 改成自己现在的名字**不算冲突**：重名检查排除自己。不排除的话，"值没动"
  // 会被自己的名字挡下，报一句"已有同名部门"却指的就是它自己 —— 把人绕晕的错误。
  assert.equal(svc.renameDepartment(o.id, d.id, { name: '测绘一处' }).name, '测绘一处', '改成自己现在的名字必须放行');

  assert.throws(() => svc.renameDepartment(o.id, d.id, { name: '资料处' }), /同名部门/, '与其它部门重名必须拒绝');
  assert.throws(() => svc.renameDepartment(o.id, d.id, { name: '   ' }), /不能为空/);
  assert.throws(() => svc.renameDepartment(o.id, d.id, { name: 'x'.repeat(65) }), /过长/);
  assert.throws(() => svc.renameDepartment(o.id, 'dep_not_exists', { name: '新名' }), /不存在/);
  // 跨租户：别家组织的部门 id 在本组织根本不存在 —— 改名必须先能看见它。
  assert.throws(() => svc.renameDepartment(o2.id, d.id, { name: '越权改名' }), /不存在/, '跨租户改不动');
  assert.equal(svc.listDepartments(o.id).find((x) => x.id === d.id).name, '测绘一处',
    '被拒的改名不得动到原部门（不是"报错但已经改了"）');
});

await t('★ 部门删除：有成员 / 有子部门都拒（人话理由），引用解除后才删得掉', async () => {
  const o = orgRepo.createOrg({ name: '部门公司8', slug: 'b8-dept-corp8' });
  const o2 = orgRepo.createOrg({ name: '部门公司9', slug: 'b8-dept-corp9' });
  roleRepo.ensureBuiltinRoles(o.id);
  roleRepo.ensureBuiltinRoles(o2.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const parent = svc.createDepartment(o.id, { name: '总部' });
  const child = svc.createDepartment(o.id, { name: '分部', parentId: parent.id });
  const u = await svc.createUser({
    orgId: o.id, username: 'b8_del_1', password: 'Adm1n-Pass!23', roleKeys: ['member'], deptId: parent.id,
  });

  // 子部门数必须如实出现在列表里 —— 删除护栏与界面提示都依赖这个数
  const listed = svc.listDepartments(o.id);
  assert.equal(listed.find((x) => x.id === parent.id).childCount, 1, '父部门应如实数出 1 个子部门');
  assert.equal(listed.find((x) => x.id === child.id).childCount, 0, '叶子部门的子部门数是 0（数字），不是 null');

  // 有成员 → 拒绝，理由必须带**人数**（这是人话与 SQLite 错误的差别所在）。
  // 这条场景正是 FK 约束会拦下的那个（PRAGMA foreign_keys = ON），
  // 但 `FOREIGN KEY constraint failed` 是给机器看的，护栏必须先给人话。
  assert.throws(() => svc.deleteDepartment(o.id, parent.id), /还有 1 个成员/, '有成员的部门必须拒绝删除并说明人数');
  assert.ok(svc.listDepartments(o.id).some((x) => x.id === parent.id), '被拒之后部门必须原封不动');

  // 成员清掉 → 轮到子部门挡着（拒绝理由要**换成**子部门，不能还是成员）
  svc.setUserProfile(o.id, u.id, { deptId: null });
  assert.throws(() => svc.deleteDepartment(o.id, parent.id), /还有 1 个子部门/, '成员清掉后轮到子部门挡着');

  // 跨租户：必须先"看不见"别家的部门 —— 否则 delete 就成了跨租户删除
  const foreign = svc.createDepartment(o2.id, { name: '乙的部门' });
  assert.throws(() => svc.deleteDepartment(o.id, foreign.id), /不存在/, '跨租户删不动');
  assert.equal(svc.listDepartments(o2.id).length, 1, '被拒的跨租户删除不得动到别家的部门');

  // 引用解除后必须真的能删 —— 护栏是"有引用才拦"，不是"一律拒绝"
  assert.equal(svc.deleteDepartment(o.id, child.id).ok, true, '没有引用的叶子部门必须删得掉');
  assert.equal(svc.deleteDepartment(o.id, parent.id).ok, true, '子部门没了、成员清空后父部门必须删得掉');
  assert.equal(svc.listDepartments(o.id).length, 0, '全删完之后列表该是空的');
  assert.throws(() => svc.deleteDepartment(o.id, child.id), /不存在/, '已删掉的再删要报"不存在"，不是静默成功');

  // 兜底证据：绕过服务层护栏直接 DELETE 一个**被引用**的部门，数据库会拦住它
  // （PRAGMA foreign_keys = ON）。护栏不是唯一防线：服务层万一漏了，也不会产生悬空引用。
  const ref = svc.createDepartment(o.id, { name: '有人的部门' });
  await svc.createUser({ orgId: o.id, username: 'b8_del_2', password: 'Adm1n-Pass!23', roleKeys: ['member'], deptId: ref.id });
  assert.throws(() => db.run('DELETE FROM departments WHERE id = ?', [ref.id]), /FOREIGN KEY|constraint/i,
    'FK 必须仍然兜住"被引用部门的裸删除" —— 护栏之上还有数据库这道底线');
});

/* ══════════════════════════════════════════════════════════════════
   0.17.0 · CSV 批量导入账号（解析保真 + 逐行独立）
   ══════════════════════════════════════════════════════════════════ */

section('0.17.0 · CSV 批量导入：解析保真、逐行独立、上限先于哈希');

await t('parseCsvRecords：行号、引号转义、引号内换行、CRLF/BOM、空白原样保留', () => {
  // 简单两行 + 尾随换行：不产生幽灵记录，行号物理可见
  assert.deepEqual(parseCsvRecords('a,b\nc,d\n').map((x) => [x.line, x.cells]),
    [[1, ['a', 'b']], [2, ['c', 'd']]], '尾随换行不该产出一行"空记录"');

  // BOM / CRLF / 裸 CR。BOM 不剥 = 第一个表头永远认不出来（「\uFEFF账号」≠「账号」）
  assert.deepEqual(parseCsvRecords('\uFEFFa,b\r\nc,d\r').map((x) => x.cells),
    [['a', 'b'], ['c', 'd']], 'BOM 必须剥掉；CRLF 与裸 CR 都要当行界');

  // 引号包裹 + "" 成对转义 + 引号里的逗号
  assert.deepEqual(parseCsvRecords('"a,b",c\n"say ""hi""",d').map((x) => x.cells),
    [['a,b', 'c'], ['say "hi"', 'd']], '引号里的逗号/成对引号是字段内容，不是分隔符/转义残留');

  // 引号内换行：一条记录吃掉两个物理行，下一条记录的行号必须跳过被吃掉的行
  const multiline = parseCsvRecords('"第一行\n第二行",x\nnext,y');
  assert.deepEqual(multiline.map((x) => [x.line, x.cells]),
    [[1, ['第一行\n第二行', 'x']], [3, ['next', 'y']]],
    '引号里的换行属于字段内容；后续记录的物理行号要如实 +1（否则报"第 3 行失败"其实是第 4 行）');

  // ★ 空白原样保留 —— 口令里的空格是口令的一部分。
  // 这正是不能复用 knowledge parseCsv 的原因（那个会规整空白，导入的人从此登不上）。
  assert.deepEqual(parseCsvRecords('" Abc123! ",x').map((x) => x.cells), [[' Abc123! ', 'x']],
    '引号里的前后空格必须一个不少 —— 解析器替谁 trim，谁的口令就被改了');

  // 空行跳过；空尾列保留；`,,,` 这种"有列的空记录"解析器不替调用方做决定
  assert.equal(parseCsvRecords('a,b\n\n\nc,d').length, 2, '空行不能算数据行（否则报表里全是"账号为空"的噪音）');
  assert.deepEqual(parseCsvRecords('a,').map((x) => x.cells), [['a', '']], '空尾列要保留（列数不齐由导入端报错）');
  assert.equal(parseCsvRecords(',,,').length, 1, ',,, 是有列的空记录 —— 算不算数据由 importUsers 过滤，不是解析器吞掉');
});

await t('parseCsvRecords：引号没闭合必须抛 400 并指认起始行（不许安静地串成一个巨字段）', () => {
  assert.throws(() => parseCsvRecords('a,b\nc,"d\n' + 'x'.repeat(50)), (e) => {
    assert.equal(e.httpStatus, 400, '未闭合引号是"文件格式错"，不是服务器内部错');
    assert.match(e.message, /引号没有闭合/);
    assert.match(e.message, /第 2 行/, '要指向**引号开启**的那一行，不是文件末尾 —— 不然 500 行的文件没法排查');
    return true;
  });
});

await t('importUsers：全列导入 —— 部门按名称解析、角色多分隔符、报表带物理行号与 id', async () => {
  const o = orgRepo.createOrg({ name: '导入公司', slug: 'b8-import-corp' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  svc.createDepartment(o.id, { name: '测绘室' });

  const csv = '账号,口令,姓名,部门,角色\n'
    + 'imp_a,Adm1n-Pass!23,甲,测绘室,viewer\n'
    + 'imp_b,Adm1n-Pass!23,乙,,member;viewer\n';
  const rep = await svc.importUsers(o.id, { csv });
  assert.equal(rep.total, 2);
  assert.equal(rep.created, 2);
  assert.equal(rep.failed, 0);
  assert.deepEqual(rep.rows.map((x) => x.line), [2, 3], '报表行号 = CSV 物理行号（表头是第 1 行）');
  assert.ok(rep.rows.every((x) => x.ok && x.id), '成功行必须带回 id（HTTP 层审计拿它当 resourceId）');

  const users = svc.listUsers(o.id);
  const a = users.find((u) => u.username === 'imp_a');
  const b = users.find((u) => u.username === 'imp_b');
  const d = svc.listDepartments(o.id).find((x) => x.name === '测绘室');
  assert.equal(a.deptId, d.id, '部门列要按**名称**解析成本组织的 id（CSV 里没人去抄 32 位 id）');
  assert.deepEqual(a.roles, ['viewer']);
  assert.deepEqual([...b.roles].sort(), ['member', 'viewer'], '分号/逗号分隔的角色都要认');
  assert.equal(b.deptId, null, '部门留空 = 不归属（不是随便摊派一个部门）');
});

await t('importUsers：逐行独立 —— 坏行只跳自己、原因是人话，重跑安全（不重复创建）', async () => {
  const o = orgRepo.createOrg({ name: '导入公司2', slug: 'b8-import-corp2' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });

  const csv = [
    'username,password,displayName,dept,roles',  // 英文表头别名
    'imp_ok1,Adm1n-Pass!23,好行一,,',
    'imp_ok1,Adm1n-Pass!23,重名行,,',
    ',Adm1n-Pass!23,空账号行,,',
    'imp_ok2,,空口令行,,',
    'bad name,Adm1n-Pass!23,非法账号名,,',
    'imp_ok3,short,弱口令行,,',
    'imp_ok4,Adm1n-Pass!23,未知角色行,,nope',
    'imp_ok5,Adm1n-Pass!23,部门不存在,营销部,',
    'imp_ok6,Adm1n-Pass!23,好行二,,',
  ].join('\n');

  const rep = await svc.importUsers(o.id, { csv });
  assert.equal(rep.total, 9);
  assert.equal(rep.created, 2, '好行照常创建（imp_ok1 / imp_ok6）—— 一行失败不许把整批拖下水');
  assert.equal(rep.failed, 7);
  const at = (line) => rep.rows.find((x) => x.line === line);
  assert.match(at(3).error, /已存在/, '重名行：原因要能直接看懂');
  assert.equal(at(4).error, '账号为空');
  assert.equal(at(5).error, '口令为空');
  assert.match(at(6).error, /账号需为/, '非法账号名走 createUser 的既有校验（本层不重复一套规则）');
  assert.match(at(7).error, /口令不符合要求/);
  assert.match(at(8).error, /未知角色/);
  assert.match(at(9).error, /部门不存在：营销部/);
  assert.ok(at(2).ok && at(10).ok, '失败行**之间**的成功行必须不受影响（按物理行号定位到具体是哪两行）');

  // 重跑安全：整份文件再导一遍 → 已创建的两行按"账号已存在"拒绝，账号数不变。
  // 这是报表文案"修好后重新导入整份文件即可"的依据 —— 不成立的话那句话就是骗人。
  const again = await svc.importUsers(o.id, { csv });
  assert.equal(again.created, 0, '重跑不得重复创建');
  assert.equal(again.failed, 9);
  assert.equal(svc.listUsers(o.id).length, 2, '账号数必须原封不动');
});

await t('importUsers：表头校验 —— 未知列 / 重复列 / 缺列 / 空表头列都拒绝，且拒绝时零创建', async () => {
  const o = orgRepo.createOrg({ name: '导入公司3', slug: 'b8-import-corp3' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });

  await assert.rejects(() => svc.importUsers(o.id, { csv: '' }), /没有内容/);
  await assert.rejects(() => svc.importUsers(o.id, { csv: '账号,口令,备注\nimp_x,Adm1n-Pass!23,嗨' }),
    /无法识别的列「备注」/, '拼错的列名必须拒绝 —— 静默忽略等于让用户以为那列生效了');
  await assert.rejects(() => svc.importUsers(o.id, { csv: '账号,username,口令\nimp_x,imp_y,Adm1n-Pass!23' }),
    /列重复/, '同一含义两列（账号+username）是歧义，不能"取第一个"糊弄过去');
  await assert.rejects(() => svc.importUsers(o.id, { csv: '口令,姓名\nAdm1n-Pass!23,甲' }), /缺少「账号」列/);
  await assert.rejects(() => svc.importUsers(o.id, { csv: '账号,姓名\nimp_x,甲' }), /缺少「口令」列/);
  await assert.rejects(() => svc.importUsers(o.id, { csv: '账号,,口令\nimp_x,,Adm1n-Pass!23' }), /表头第 2 列是空的/);
  await assert.rejects(() => svc.importUsers(o.id, { csv: '账号,口令' }), /只有表头/, '只有表头 = 没有数据行，要拒绝而不是回一份"0 行成功"的空报表');
  assert.equal(svc.listUsers(o.id).length, 0, '表头整体错了就是整份文件拒收 —— 拒绝时不许有任何一行偷偷被创建');
});

await t('importUsers：501 行必须先于任何哈希被拒（零创建）—— 上限这道闸挡住的就是 25 秒级的请求', async () => {
  const o = orgRepo.createOrg({ name: '导入公司4', slug: 'b8-import-corp4' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });

  const row = (i) => 'imp_n' + i + ',Adm1n-Pass!23\n';
  let csv501 = '账号,口令\n';
  for (let i = 0; i < 501; i++) csv501 += row(i);

  // ⚠️ 这条断言的价值在**耗时**：500 次 scrypt 哈希 ≈ 25 秒。
  // 上限若被挪到逐行循环之后，本用例会先跑 25 秒再返回同一句错误 —— 且必然伴随半批账号落库，
  // 所以"零创建"是"上限先于哈希"的可观察证据。
  // （正例 500 行**不**在这里真跑：那正是 25 秒。上限逻辑只有 `> 500` 一条分支，反例覆盖边界即可。）
  await assert.rejects(() => svc.importUsers(o.id, { csv: csv501 }), /最多导入 500 行/);
  assert.equal(svc.listUsers(o.id).length, 0, '被上限拒绝时不许有任何一行被创建（半批导入比全拒更糟）');
});

await t('importUsers：口令原样保留 —— " Abc123! " 建出来的就是带空格的这个口令', async () => {
  const o = orgRepo.createOrg({ name: '导入公司5', slug: 'b8-import-corp5' });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });

  const rep = await svc.importUsers(o.id, { csv: '账号,口令\nimp_space," Abc123! "\n' });
  assert.equal(rep.created, 1, '带空格的口令通过强度检查（9 位、四类字符）');

  // 精确密文能登录 → 口令没被规整；trim 后的版本必须**登不上**。
  const res = await svc.login({ orgSlug: o.slug, username: 'imp_space', password: ' Abc123! ' });
  assert.ok(res && res.token, '带空格的口令必须原样可用 —— 这条就是"不能复用知识层解析器"的实证');
  await assert.rejects(
    () => svc.login({ orgSlug: o.slug, username: 'imp_space', password: 'Abc123!' }),
    (e) => e.httpStatus === 401,
    'trim 版登得上 = 口令被偷偷改过，正是当初要避免的那类缺陷');
});

/* ══════════════════════════════════════════════════════════════════
   0.17.0 · 两步验证（TOTP，安全评审 §4.1）
   ══════════════════════════════════════════════════════════════════ */

section('0.17.0 · 两步验证（TOTP）：RFC 向量 + 两步登录全流程');

/**
 * 现取现用：动态码必须落在 ±1 窗口内，且步号只能**单调上升**（每次消费把 last_used_step
 * 推进到命中步）。每个用户在本段落里最多消费 2 个步号（登记确认 + 后续某一动作），
 * 取码与提交相邻 —— 跨 30 秒边界时自适应，不会 flake。
 */
function freshTotpCode(secretBase32, lastUsed = null) {
  const now = totpStepAt();
  const step = Math.max(now, (lastUsed == null ? -1 : Number(lastUsed)) + 1);
  assert.ok(step - totpStepAt() <= TOTP_WINDOW,
    '测试自身动作跨出了 TOTP 窗口（step=' + step + '，now=' + totpStepAt() + '），重跑即可');
  return { code: hotp(base32Decode(secretBase32), step), step };
}

await t('RFC 4226 附录 D：HOTP 计数器 0–9 的官方向量逐条吻合（App 与平台"算码"的算法根基）', () => {
  assert.equal(TOTP_DIGITS, 6, 'RFC 6238 默认 6 位');
  assert.equal(TOTP_PERIOD_SEC, 30, 'RFC 6238 默认 30 秒周期（步进单位）');
  assert.equal(TOTP_WINDOW, 1, '容差 ±1 步（容忍客户端时钟偏差 ±30s）');

  const b32 = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  assert.equal(b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    'RFC 测试密钥（ASCII "12345678901234567890"）的 Base32 表示必须与 RFC 6238 附录 B 一致');
  const vectors = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  vectors.forEach((want, counter) => {
    assert.equal(hotp(base32Decode(b32), counter), want, 'HOTP(counter=' + counter + ')');
  });
});

await t('RFC 6238 附录 B：SHA-1 六个时刻的官方向量吻合，步号 = floor(T/30)', () => {
  const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [sec, want] of vectors) {
    const got = totpAt(b32, sec * 1000);
    assert.equal(got.code, want, 'T=' + sec + '（步号 ' + got.step + '）');
    assert.equal(got.step, totpStepAt(sec * 1000), '步号必须是 floor(T/30)');
  }
});

await t('verifyTotp：±1 窗口命中、窗外拒绝、已用步号防重放、输入宽容而格式严格', () => {
  const secret = generateSecret();
  const t0 = 1_700_000_000_000;           // 固定时刻：纯函数的时间行为不依赖真实时钟
  const nowStep = totpStepAt(t0);
  const codeAt = (s) => hotp(base32Decode(secret), s);

  // 窗口：本步、未来 1 步、过去 1 步都算命中 —— 且必须回带命中的步号（调用方要写回防重放）
  assert.deepEqual(verifyTotp(secret, codeAt(nowStep), { timeMs: t0 }), { ok: true, step: nowStep });
  assert.deepEqual(verifyTotp(secret, codeAt(nowStep + 1), { timeMs: t0 }), { ok: true, step: nowStep + 1 },
    '客户端时钟稍快（step+1）在窗口内');
  assert.deepEqual(verifyTotp(secret, codeAt(nowStep - 1), { timeMs: t0 }), { ok: true, step: nowStep - 1 },
    '稍慢（step-1）也在窗口内');
  assert.equal(verifyTotp(secret, codeAt(nowStep + 2), { timeMs: t0 }).reason, 'mismatch', '窗外（+2）必须拒绝');
  assert.equal(verifyTotp(secret, codeAt(nowStep - 2), { timeMs: t0 }).reason, 'mismatch', '窗外（-2）必须拒绝');

  // 防重放：lastUsedStep 之后只认更大的步号 —— 包括"同一个码在同一窗口内第二次用"
  assert.equal(verifyTotp(secret, codeAt(nowStep), { timeMs: t0, lastUsedStep: nowStep }).reason, 'mismatch',
    '用过的步号不得二次命中');
  assert.deepEqual(verifyTotp(secret, codeAt(nowStep + 1), { timeMs: t0, lastUsedStep: nowStep }),
    { ok: true, step: nowStep + 1 }, '同等宽度的下一格仍应可通行');

  // 格式：5 位/7 位/非数字/空 → format；坏密钥 → bad-secret；前后空白宽容（从 App 复制常带）
  for (const bad of ['12345', '1234567', 'abcdef', '', null]) {
    assert.equal(verifyTotp(secret, bad, { timeMs: t0 }).reason, 'format', '非法输入: ' + JSON.stringify(bad));
  }
  assert.equal(verifyTotp('', codeAt(nowStep), { timeMs: t0 }).reason, 'bad-secret');
  assert.equal(verifyTotp('!!!!', codeAt(nowStep), { timeMs: t0 }).reason, 'bad-secret');
  assert.deepEqual(verifyTotp(secret, ' ' + codeAt(nowStep) + '\n', { timeMs: t0 }), { ok: true, step: nowStep },
    '用户从 App 复制常带空白，必须宽容');
});

await t('otpauth URI 与恢复码：二维码参数合规、抄写容错归一化、哈希归一化后稳定', () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/, '20 字节 → 32 个 Base32 字符');

  const uri = otpauthUri({ secret, label: 'alice' });
  assert.match(uri, /^otpauth:\/\/totp\/STI%20HARNESS:alice\?/, 'label 是 "issuer:用户名"');
  assert.match(uri, new RegExp('secret=' + secret + '(?=&)'), '密钥必须原样在 secret 参数里');
  assert.match(uri, /&issuer=STI%20HARNESS&algorithm=SHA1&digits=6&period=30$/,
    '算法参数必须显式写全 —— 缺省值随 App 而异，写全才能跨 App 一致');

  const codes = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT, '默认一批 ' + RECOVERY_CODE_COUNT + ' 张');
  assert.equal(new Set(codes).size, codes.length, '一批之内不得重复（重复 = 凭空少一份熵）');
  for (const c of codes) assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/, '恢复码形如 XXXX-XXXX: ' + c);

  // 归一化（大写 + 忽略一切非 Base32 字符）是"手抄容错"的全部依据；哈希必须建在归一化之上
  const one = codes[0];
  const ms = crypto.randomBytes(32);
  assert.equal(normalizeRecoveryCode(one.toLowerCase()), one.replace('-', ''));
  assert.equal(normalizeRecoveryCode(' ' + one.replace('-', ' ') + ' '), one.replace('-', ''),
    '连字符写成空格、带前后空白 —— 都要能对回同一张码');
  assert.equal(recoveryCodeHash(' ' + one.toLowerCase() + ' ', ms), recoveryCodeHash(one, ms),
    '哈希前先归一化：否则大小写/空格差异会让同一张码对不上');
  assert.notEqual(recoveryCodeHash(codes[1], ms), recoveryCodeHash(one, ms), '不同码的哈希不同');
});

await t('登记与两步登录主流程：第一步只发票据不发会话；动态码完成会话；重放/复用/泛化错误全链验证', async () => {
  const o = orgRepo.createOrg({ name: '两步A', slug: 'totp-a-' + Date.now() });
  roleRepo.ensureBuiltinRoles(o.id);
  const masterSecret = crypto.randomBytes(32);
  const svc = createIdentityService({ masterSecret });
  const pw = 'Adm1n-Pass!23';
  const u = await svc.createUser({ orgId: o.id, username: 'tp_a', password: pw, roleKeys: ['member'] });

  // 未启用 TOTP：登录行为与从前逐字一致（0.17.0 的硬边界 —— 不开启就不受任何影响）
  const plain = await svc.login({ orgSlug: o.slug, username: 'tp_a', password: pw });
  assert.ok(plain.token, '未启用 TOTP 时第一步即完成登录');
  assert.ok(!('twoFactorRequired' in plain), '未启用账号的登录响应不得多出字段');
  assert.equal(svc.totpStatus(u.id).enabled, false);

  // 开始登记：必须重输口令 —— 被偷的会话不能替受害者装第二因子
  await assert.rejects(() => svc.totpBeginEnroll(o.id, u.id, { password: 'Wrong-Pass!99' }),
    (e) => e.httpStatus === 401, '登记要求重输口令，且错误记入账号退避');
  const begin = await svc.totpBeginEnroll(o.id, u.id, { password: pw });
  assert.match(begin.secret, /^[A-Z2-7]{32}$/, '登记响应里给出密钥（唯一一次）');
  assert.match(begin.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(svc.totpStatus(u.id).pending, true, '确认前只算 pending，不生效');
  assert.equal(svc.totpStatus(u.id).enabled, false);
  assert.ok(!('secret' in svc.totpStatus(u.id)), '状态接口不得回显密钥');

  // 确认登记：当步动态码 → 启用 + 一批明文恢复码（唯一一次）
  const c1 = freshTotpCode(begin.secret);
  const conf = await svc.totpConfirmEnroll(o.id, u.id, { code: c1.code });
  assert.equal(conf.enabled, true);
  assert.equal(conf.recoveryCodes.length, RECOVERY_CODE_COUNT);
  const st = svc.totpStatus(u.id);
  assert.equal(st.enabled, true);
  assert.equal(st.recoveryCodesLeft, RECOVERY_CODE_COUNT);
  assert.equal(Number(totpRepo.getTotp(u.id).last_used_step), c1.step,
    '确认成功必须写回步号（否则确认时用的码还能拿去登录一次）');
  const listed = svc.listUsers(o.id).find((x) => x.id === u.id);
  assert.equal(listed.totpEnabled, true, '用户列表要给管理员"谁还裸奔"的视角（管理动作 = resetUserTotp）');

  // 两步登录：第一步只回 twoFactorRequired + 票据（**绝不发 token**）
  const step1 = await svc.login({ orgSlug: o.slug, username: 'tp_a', password: pw });
  assert.equal(step1.twoFactorRequired, true);
  assert.ok(step1.ticket && step1.ticket.startsWith('stc_'), '票据有独立前缀，与会话令牌（sti_）无包含关系');
  assert.ok(!step1.token, '第一步不得发会话令牌');
  const t1row = totpRepo.findChallengeByTicketHash(hashToken(step1.ticket, masterSecret));
  assert.ok(t1row && !t1row.consumed_at, '票据只存 HMAC 哈希 —— 用同一主密钥能定位到行，且未消费');

  // 泛化错误：票据格式不符 / 空码 —— 一句同文的 401，不给探测器任何差异信号
  await assert.rejects(() => svc.loginTotp({ ticket: 'not-a-ticket', code: '123456' }),
    (e) => e.httpStatus === 401, '票据格式不符回泛化 401');
  await assert.rejects(() => svc.loginTotp({ ticket: step1.ticket, code: '' }),
    (e) => e.httpStatus === 401, '空码同样泛化 401');
  assert.equal(Number(totpRepo.findChallengeByTicketHash(hashToken(step1.ticket, masterSecret)).attempts), 1,
    '失败尝试在库里计数（先扣次数再验码 —— 空码这次占了 1 次机会）');

  // 重放确认时用过的码：防重放贯穿"登记确认 → 登录"
  await assert.rejects(() => svc.loginTotp({ ticket: step1.ticket, code: c1.code }),
    (e) => e.httpStatus === 401, '确认时用过的码不能再拿去登录');

  // 换新票据（同账号同时只有一个待验证窗口），用下一格码完成登录
  const step1b = await svc.login({ orgSlug: o.slug, username: 'tp_a', password: pw });
  assert.notEqual(step1b.ticket, step1.ticket);
  const c2 = freshTotpCode(begin.secret, c1.step);
  const ok2 = await svc.loginTotp({ ticket: step1b.ticket, code: c2.code });
  assert.ok(ok2.token, '动态码正确 → 第二步发会话');
  assert.equal(ok2.viaRecoveryCode, false);
  assert.equal(ok2.recoveryCodesLeft, null, '非恢复码登录不回带剩余数');
  assert.equal(ok2.user.username, 'tp_a');
  assert.ok(svc.authenticate(ok2.token), '第二步的会话必须立刻可用');

  // 票据一次性：同一票据再来一次（哪怕码是好的）也必须失败
  await assert.rejects(() => svc.loginTotp({ ticket: step1b.ticket, code: c2.code }),
    (e) => e.httpStatus === 401, '已消费的票据不得复用');

  // 恢复码：一次性、归一化后即同一张、成功后回带剩余数
  const step1c = await svc.login({ orgSlug: o.slug, username: 'tp_a', password: pw });
  const rec = conf.recoveryCodes[0];
  const ok3 = await svc.loginTotp({ ticket: step1c.ticket, code: rec });
  assert.ok(ok3.token, '恢复码可用于完成登录');
  assert.equal(ok3.viaRecoveryCode, true);
  assert.equal(ok3.recoveryCodesLeft, RECOVERY_CODE_COUNT - 1, '用掉一张，剩 ' + (RECOVERY_CODE_COUNT - 1));
  const step1d = await svc.login({ orgSlug: o.slug, username: 'tp_a', password: pw });
  await assert.rejects(() => svc.loginTotp({ ticket: step1d.ticket, code: rec }),
    (e) => e.httpStatus === 401, '恢复码一次性：用过即废');
  const step1e = await svc.login({ orgSlug: o.slug, username: 'tp_a', password: pw });
  await assert.rejects(() => svc.loginTotp({ ticket: step1e.ticket, code: rec.toLowerCase().replace('-', ' ') }),
    (e) => e.httpStatus === 401, '"小写 + 空格"归一化后就是同一张已废码');
});

await t('单张票据 5 次机会用尽：第 6 次即使码正确也被拒；新票据重置额度（票据级 ≠ 账号级）', async () => {
  // 本用例只测"票据级上限"，先把账号级退避阈值调高，避免退避先到把信号混进 429。
  // env 在 createIdentityService 工厂内读取 —— 设置必须发生在建实例之前。
  const prevMax = process.env.STI_LOGIN_FAIL_MAX;
  process.env.STI_LOGIN_FAIL_MAX = '100000';
  try {
    const o = orgRepo.createOrg({ name: '两步B', slug: 'totp-b-' + Date.now() });
    roleRepo.ensureBuiltinRoles(o.id);
    const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
    const pw = 'Adm1n-Pass!23';
    const u = await svc.createUser({ orgId: o.id, username: 'tp_b', password: pw, roleKeys: ['member'] });
    const begin = await svc.totpBeginEnroll(o.id, u.id, { password: pw });
    const c1 = freshTotpCode(begin.secret);
    await svc.totpConfirmEnroll(o.id, u.id, { code: c1.code });

    const step1 = await svc.login({ orgSlug: o.slug, username: 'tp_b', password: pw });
    const wrong = c1.code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 5; i++) {
      await assert.rejects(() => svc.loginTotp({ ticket: step1.ticket, code: wrong }),
        (e) => e.httpStatus === 401, '第 ' + i + ' 次尝试应失败');
    }
    // 第 6 次：机会已在 SQL 条件（attempts < 5）里用尽 —— 正确的码也不能再救活这张票据
    const c2 = freshTotpCode(begin.secret, c1.step);
    await assert.rejects(() => svc.loginTotp({ ticket: step1.ticket, code: c2.code }),
      (e) => e.httpStatus === 401, '尝试次数用尽后，正确的码也必须被拒');

    // 重新走第一步拿新票据：额度重置 —— 票据级上限不是账号级封禁
    const step2 = await svc.login({ orgSlug: o.slug, username: 'tp_b', password: pw });
    assert.notEqual(step2.ticket, step1.ticket);
    const ok = await svc.loginTotp({ ticket: step2.ticket, code: c2.code });
    assert.ok(ok.token, '新票据 + 尚未用过的下一格码 → 登录成功');
  } finally {
    if (prevMax == null) delete process.env.STI_LOGIN_FAIL_MAX;
    else process.env.STI_LOGIN_FAIL_MAX = prevMax;
  }
});

await t('管理员重置 TOTP：未完成票据作废、会话存活、口令不动、回单步登录', async () => {
  const o = orgRepo.createOrg({ name: '两步C', slug: 'totp-c-' + Date.now() });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const pw = 'Adm1n-Pass!23';
  const u = await svc.createUser({ orgId: o.id, username: 'tp_c', password: pw, roleKeys: ['member'] });
  const begin = await svc.totpBeginEnroll(o.id, u.id, { password: pw });
  const c1 = freshTotpCode(begin.secret);
  await svc.totpConfirmEnroll(o.id, u.id, { code: c1.code });

  // 先完成一次两步登录拿到会话 —— 重置是"丢设备"轻处置，不该把已登录会话踢下线
  const step1 = await svc.login({ orgSlug: o.slug, username: 'tp_c', password: pw });
  const c2 = freshTotpCode(begin.secret, c1.step);
  const okLogin = await svc.loginTotp({ ticket: step1.ticket, code: c2.code });
  assert.ok(okLogin.token);

  // 再开一张未完成票据（模拟"正卡在第二步"）：重置必须把它一并作废
  const pending = await svc.login({ orgSlug: o.slug, username: 'tp_c', password: pw });
  assert.ok(totpRepo.listChallengesForUser(u.id).some((x) => !x.consumed_at), '前置条件：有一张未消费票据');

  const r = svc.resetUserTotp(o.id, u.id);
  assert.equal(r.hadTotp, true);
  assert.equal(r.codesRemoved, RECOVERY_CODE_COUNT, '恢复码整批清掉');
  assert.equal(r.challengesInvalidated, 1, '未完成票据一并作废');
  assert.equal(svc.totpStatus(u.id).enabled, false, '回到未启用');
  assert.equal(svc.totpStatus(u.id).recoveryCodesLeft, 0);
  assert.equal(totpRepo.listChallengesForUser(u.id).every((x) => x.consumed_at), true,
    '库里每张票据都已消费/作废（不留"半开窗口"）');

  // 卡住的票据：即便给当前时刻的合法码也必须失败（挑战已作废 + 密钥已删，双保险）
  await assert.rejects(() => svc.loginTotp({ ticket: pending.ticket, code: totpAt(begin.secret).code }),
    (e) => e.httpStatus === 401, '重置后旧票据不得再能完成第二步');

  assert.ok(svc.authenticate(okLogin.token), '重置不动会话（更强处置是重置口令，那条路才吊销会话）');
  const back = await svc.login({ orgSlug: o.slug, username: 'tp_c', password: pw });
  assert.ok(back.token && !('twoFactorRequired' in back), '重置后回到单步登录 —— 与未开启账号逐字一致');
});

await t('停用两步验证：口令 + 动态码双证；停用即回单步账号（恢复码与票据一并清）', async () => {
  const o = orgRepo.createOrg({ name: '两步D', slug: 'totp-d-' + Date.now() });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const pw = 'Adm1n-Pass!23';
  const u = await svc.createUser({ orgId: o.id, username: 'tp_d', password: pw, roleKeys: ['member'] });
  const begin = await svc.totpBeginEnroll(o.id, u.id, { password: pw });
  const c1 = freshTotpCode(begin.secret);
  await svc.totpConfirmEnroll(o.id, u.id, { code: c1.code });

  // 双证缺一不可：只有口令（码错）→ 400；只有动态码（口令错）→ 401
  await assert.rejects(() => svc.totpDisable(o.id, u.id, { password: pw, code: '000000' }),
    (e) => e.httpStatus === 400, '码不对不能停用 —— 会话被偷者拆不掉第二因子');
  const c2 = freshTotpCode(begin.secret, c1.step);
  await assert.rejects(() => svc.totpDisable(o.id, u.id, { password: 'Wrong-Pass!99', code: c2.code }),
    (e) => e.httpStatus === 401, '口令不对也不能停用');

  const off = await svc.totpDisable(o.id, u.id, { password: pw, code: c2.code });
  assert.equal(off.enabled, false);
  assert.equal(svc.totpStatus(u.id).enabled, false);
  assert.equal(svc.totpStatus(u.id).recoveryCodesLeft, 0, '恢复码随停用一并清掉');
  assert.equal(totpRepo.getTotp(u.id), undefined, '密钥行删除（停用不是"挂着不用"）');

  const back = await svc.login({ orgSlug: o.slug, username: 'tp_d', password: pw });
  assert.ok(back.token && !('twoFactorRequired' in back), '停用后与未开启账号逐字一致');
});

await t('重发恢复码：只认动态码（恢复码不能自我续命）、旧批整批作废、新批一次性可用', async () => {
  const o = orgRepo.createOrg({ name: '两步E', slug: 'totp-e-' + Date.now() });
  roleRepo.ensureBuiltinRoles(o.id);
  const svc = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  const pw = 'Adm1n-Pass!23';
  const u = await svc.createUser({ orgId: o.id, username: 'tp_e', password: pw, roleKeys: ['member'] });
  const begin = await svc.totpBeginEnroll(o.id, u.id, { password: pw });
  const c1 = freshTotpCode(begin.secret);
  const conf = await svc.totpConfirmEnroll(o.id, u.id, { code: c1.code });
  const oldCode = conf.recoveryCodes[0];

  // 恢复码不能换出新的恢复码 —— 否则"偷到一张"就能自我续命成永不过期
  assert.throws(() => svc.totpRegenerateRecoveryCodes(o.id, u.id, { code: oldCode }),
    (e) => e.httpStatus === 400, '非 6 位数字输入在格式检查就被拒');
  assert.equal(svc.totpStatus(u.id).recoveryCodesLeft, RECOVERY_CODE_COUNT, '被拒后旧批必须原封不动');

  const c2 = freshTotpCode(begin.secret, c1.step);
  const regen = svc.totpRegenerateRecoveryCodes(o.id, u.id, { code: c2.code });
  assert.equal(regen.recoveryCodes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(regen.recoveryCodes).size, RECOVERY_CODE_COUNT);
  assert.equal(regen.recoveryCodes.filter((x) => conf.recoveryCodes.includes(x)).length, 0, '新批与旧批不得重叠');
  assert.equal(svc.totpStatus(u.id).recoveryCodesLeft, RECOVERY_CODE_COUNT);

  // 旧码已作废；新码可登录（一次性语义不变）
  const s1 = await svc.login({ orgSlug: o.slug, username: 'tp_e', password: pw });
  await assert.rejects(() => svc.loginTotp({ ticket: s1.ticket, code: oldCode }),
    (e) => e.httpStatus === 401, '旧批恢复码必须已整批作废');
  const s2 = await svc.login({ orgSlug: o.slug, username: 'tp_e', password: pw });
  const ok = await svc.loginTotp({ ticket: s2.ticket, code: regen.recoveryCodes[0] });
  assert.ok(ok.token && ok.viaRecoveryCode === true);
  assert.equal(ok.recoveryCodesLeft, RECOVERY_CODE_COUNT - 1);

  // 重发时用掉的步号已推进：同一码不能再去登录（步号单调上升贯穿所有消费点）
  const s3 = await svc.login({ orgSlug: o.slug, username: 'tp_e', password: pw });
  await assert.rejects(() => svc.loginTotp({ ticket: s3.ticket, code: c2.code }),
    (e) => e.httpStatus === 401, '重发用过的步号已推进，同码登录必须失败');
});

section('B5 · 通知失败重投队列：告警不能因为"上游抖一下"就永久丢失');

/**
 * 可编程桩接收端：`failRemaining` 次返回 503，之后转 200。
 * 用它驱动重投时**不需要真的等 10 分钟** —— 时间是注入给 `retryPending({ now })` 的。
 */
function b5Sink() {
  const state = { hits: [], failRemaining: 0 };
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      state.hits.push({ headers: req.headers, body: buf });
      if (state.failRemaining > 0) { state.failRemaining--; res.statusCode = 503; res.end('busy'); return; }
      res.statusCode = 200; res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.url = 'http://127.0.0.1:' + server.address().port + '/hook';
      state.close = () => new Promise((r) => server.close(r));
      resolve(state);
    });
  });
}

const B5_MASTER = crypto.randomBytes(32);

async function b5Setup({ failRemaining = 0 } = {}) {
  const org = orgRepo.createOrg({ name: '通知重投公司', slug: 'b5-' + Math.random().toString(36).slice(2, 8) });
  const sink = await b5Sink();
  sink.failRemaining = failRemaining;
  // `allowLoopback: true` 只在测试里给：生产默认禁止回环出站（SSRF 载荷）。
  const svc = createNotifyService({
    masterSecret: B5_MASTER, encryptSecret, decryptSecret, allowLoopback: true, timeoutMs: 2000,
  });
  const ch = svc.createChannel(org.id, { name: '探针渠道', url: sink.url, events: ['backup.failed'] });
  assert.ok(ch.ok, '建渠道应成功：' + (ch.error || ''));
  return { org, sink, svc, channelId: ch.channel.id };
}

await t('★ 投递失败**落库入队**（不再只留一条审计）：pending 且排在 10 分钟后重投', async () => {
  const { svc, org, sink } = await b5Setup({ failRemaining: 999 });
  try {
    const r = await svc.emit({ tenantId: org.id, event: 'backup.failed', payload: { note: '备份失败', file: 'auto-1.zip' } });
    assert.equal(r.delivered, 0);
    assert.equal(r.failed, 1);
    assert.equal(r.queued, 1, '失败必须入队（queued=1）—— 否则这条告警就永久丢了');

    const rows = svc.listDeliveries(org.id, { status: 'pending' });
    assert.equal(rows.length, 1);
    const d = rows[0];
    assert.equal(d.status, 'pending');
    assert.equal(d.event, 'backup.failed');
    assert.equal(d.channelName, '探针渠道');
    assert.equal(d.attempts, 0, 'attempts 记的是"已重投次数"，从 0 起（不含首次内联的 2 次尝试）');
    assert.equal(d.lastStatus, 503, '最后一次的 HTTP 状态要如实记下来');
    // 下一次重投排在**未来**（10 分钟档）—— 不是"立刻重试"：
    // 上游只要一直 503，立刻重试就会变成我们自己去打爆它。
    assert.ok(Date.parse(d.nextRetryAt) > Date.now() + 9 * 60000,
      '首次重投应排在约 10 分钟后，实际 ' + d.nextRetryAt);
    assert.equal(svc.status(org.id).queue.pending, 1, 'status().queue.pending 要能一眼看到');

    // 没到期就不投 —— 这是"退避"能成立的前提
    const early = await svc.retryPending({ tenantId: org.id, now: Date.now() + 60000 });
    assert.equal(early.picked, 0, '未到期的记录不该被重投');
  } finally { await sink.close(); }
});

await t('★ 试发失败**不入队**（那是人在旁边看着的动作，不该污染"待处理告警"这个数）', async () => {
  const { svc, org, sink, channelId } = await b5Setup({ failRemaining: 999 });
  try {
    const r = await svc.testChannel(org.id, channelId);
    assert.equal(r.result.ok, false, '试发应当失败（桩一直 503）');
    assert.equal(svc.listDeliveries(org.id, { status: 'all' }).length, 0,
      '试发失败绝不能进队列 —— 否则"待重投 N 条"会混进无效测试数据');
    assert.equal(svc.status(org.id).queue.pending, 0);
  } finally { await sink.close(); }
});

await t('★ 重投：上游恢复后送达；且 `X-STI-Delivery-Id` 在首次与重投之间**保持不变**', async () => {
  const { svc, org, sink } = await b5Setup({ failRemaining: 999 });
  try {
    await svc.emit({ tenantId: org.id, event: 'backup.failed', payload: { note: '备份失败' } });
    const id = svc.listDeliveries(org.id)[0].id;

    sink.failRemaining = 0;                       // 上游恢复了
    const r = await svc.retryPending({ tenantId: org.id, now: Date.now() + 11 * 60000 });
    assert.equal(r.picked, 1);
    assert.equal(r.delivered, 1, '上游恢复后应送达');
    assert.equal(r.dead, 0);

    const after = svc.listDeliveries(org.id, { status: 'all' })[0];
    assert.equal(after.status, 'delivered');
    assert.ok(after.deliveredAt, '送达时间要落库');

    // 幂等 id：首次的 2 次内联尝试 + 1 次重投 = 3 次请求，必须**共用一个** id。
    // 这是我们唯一能对 at-least-once 做的事 —— 把去重能力交给最清楚语义的一方（接收方）。
    const ids = new Set(sink.hits.map((h) => h.headers['x-sti-delivery-id']));
    assert.equal(sink.hits.length, 3, '桩应收到 2（内联）+ 1（重投）次请求，实际 ' + sink.hits.length);
    assert.equal(ids.size, 1, '同一条投递的所有尝试必须共用一个 delivery id');
    assert.equal([...ids][0], id, '这个 id 就是记录 id 本身');
  } finally { await sink.close(); }
});

await t('★ 重投上限：满 6 次转 dead —— **保留可见、可手动重投**，不是删除', async () => {
  const { svc, org, sink } = await b5Setup({ failRemaining: 99999 });
  try {
    await svc.emit({ tenantId: org.id, event: 'backup.failed', payload: { note: '一直失败' } });
    let now = Date.now();
    for (let i = 0; i < 5; i++) {
      now += 8 * 3600 * 1000;              // 步长 8 小时 > 封顶 1 小时，保证每次都已到期
      const r = await svc.retryPending({ tenantId: org.id, now });
      assert.equal(r.picked, 1, '第 ' + (i + 1) + ' 次重投应被取到');
    }
    let d = svc.listDeliveries(org.id, { status: 'all' })[0];
    assert.equal(d.status, 'pending', '5 次之后仍应 pending');
    assert.equal(d.attempts, 5);

    now += 8 * 3600 * 1000;
    const last = await svc.retryPending({ tenantId: org.id, now });
    assert.equal(last.dead, 1, '第 6 次应转 dead');
    d = svc.listDeliveries(org.id, { status: 'all' })[0];
    assert.equal(d.status, 'dead');
    assert.equal(d.attempts, 6, 'attempts 应正好等于上限 6（不被首次的 2 次内联尝试提前吃掉）');

    // dead ≠ 删除：它可能正是一条**必须被看见**的告警
    assert.equal(svc.listDeliveries(org.id, { status: 'dead' }).length, 1, 'dead 记录必须留在列表里');
    assert.equal(svc.status(org.id).queue.dead, 1);

    // 人在修好接收端之后回来点它 —— 上游已恢复，应当能救回来
    sink.failRemaining = 0;
    const manual = await svc.redeliverNow(org.id, d.id);
    assert.equal(manual.wasDead, true, '要如实告诉调用方"这条本来是死信"');
    assert.equal(manual.delivery.status, 'delivered', '手动重投成功后应转 delivered');
  } finally { await sink.close(); }
});

await t('渠道被停用 / 被删除：**不消耗重投次数**（那不是"对方拒绝"，是"现在不该发"）', async () => {
  const { svc, org, sink, channelId } = await b5Setup({ failRemaining: 999 });
  try {
    await svc.emit({ tenantId: org.id, event: 'backup.failed', payload: { note: 'x' } });
    svc.updateChannel(org.id, channelId, { enabled: false });     // 运维先把渠道停掉
    await svc.retryPending({ tenantId: org.id, now: Date.now() + 11 * 60000 });
    let d = svc.listDeliveries(org.id, { status: 'all' })[0];
    assert.equal(d.status, 'pending', '停用期间保持 pending（启用后要继续投）');
    assert.equal(d.attempts, 0, '不该消耗次数：否则"先停用、修好再启用"会把告警打成死信');
    assert.ok(/停用/.test(d.lastError || ''), '要如实说明为什么没发，实际：' + d.lastError);

    svc.deleteChannel(org.id, channelId);                          // 直接删掉渠道
    await svc.retryPending({ tenantId: org.id, now: Date.now() + 40 * 60000 });
    d = svc.listDeliveries(org.id, { status: 'all' })[0];
    assert.equal(d.attempts, 0);
    assert.ok(/删除/.test(d.lastError || ''));
    assert.equal(d.status, 'pending', '记录要留着 —— 历史不该因为删了个渠道就消失');
  } finally { await sink.close(); }
});

await t('★ 清理只删**终态**：`pending` 任何情况下都不删（删了就是把"告警会丢"重新引回来）', async () => {
  const { svc, org, sink } = await b5Setup({ failRemaining: 999 });
  try {
    await svc.emit({ tenantId: org.id, event: 'backup.failed', payload: { note: 'x' } });
    const FAR = Date.now() + 365 * 24 * 3600 * 1000;
    const p = svc.purgeDeliveries({ keepDays: 30, now: FAR, tenantId: org.id });
    assert.equal(p.removed, 0, 'pending 不该被清理掉，哪怕"一年后"');
    assert.equal(svc.listDeliveries(org.id, { status: 'all' }).length, 1);

    sink.failRemaining = 0;
    await svc.retryPending({ tenantId: org.id, now: Date.now() + 11 * 60000 });
    assert.equal(svc.listDeliveries(org.id, { status: 'delivered' }).length, 1);
    const p2 = svc.purgeDeliveries({ keepDays: 30, now: FAR, tenantId: org.id });
    assert.equal(p2.removed, 1, '超过保留期的 delivered 记录应当被清掉（表不能无界增长）');
  } finally { await sink.close(); }
});

await t('重投退避：指数上升且封顶 1 小时（纯函数，不用真的等）', () => {
  const svc = createNotifyService({});
  const f = svc.retryDelayMs;
  assert.equal(f(1), 10 * 60 * 1000, '第 1 次重投 10 分钟');
  assert.equal(f(2), 20 * 60 * 1000);
  assert.equal(f(3), 40 * 60 * 1000);
  assert.equal(f(4), 60 * 60 * 1000, '第 4 次就撞到 1 小时封顶');
  assert.equal(f(9), 60 * 60 * 1000, '封顶后不再增长（否则最终会变成"永远不再重投"）');
  assert.equal(f(0), 10 * 60 * 1000, '非法输入兜底到 10 分钟 —— **不能返回 0**，那会变成忙等');
  // 上限与保留期一并钉住：页面与文档都引用它们，改这里必须同步改文档
  assert.equal(svc.retryPolicy.maxAttempts, 6);
  assert.equal(svc.retryPolicy.keepDays, 30);
});

await t('★ 重投 / 清理接口**强制带租户**：忘传必须抛错，不许静默处理别人的数据', async () => {
  // 这条不是形式主义 —— 写用例时我自己就漏传过一次，表现是 `picked` 比预期多 1：
  // 它悄悄把**另一个组织**的待重投记录也投了。没有任何报错，只是数据被处理了两次。
  const svc = createNotifyService({});
  await assert.rejects(() => svc.retryPending({}), /必须给定 tenantId/, '忘传 tenantId 必须抛错');
  assert.throws(() => svc.purgeDeliveries({}), /必须给定 tenantId/,
    '清理更是如此 —— 忘传就是**删别家的数据**');
});

await t('★ 定时任务 `notify.retry`：没到期记 skipped、"上游还不通"记 ok、**只有新死信才记 fail**', async () => {
  // "任务状态怎么记"本身就是一条**判断**，必须钉住：把"上游还是不通"记成 fail，
  // 会让调度页的失败数变成"上游健康度"曲线 —— 那时真正的任务故障就淹没在噪声里了。
  // 反过来，把"放弃了一条告警"记成 ok，则是把红点吃掉。
  const { svc, org, sink } = await b5Setup({ failRemaining: 99999 });
  const push = () => db.run(
    "UPDATE notify_deliveries SET status='pending', next_retry_at=? WHERE tenant_id=?",
    [new Date(Date.now() - 1000).toISOString(), org.id]);
  try {
    // ① 队列空（没有到期的）→ skipped：把"没事干"记成失败会让失败计数失去意义
    const empty = await runTask('notify.retry', { tenantId: org.id, params: {}, deps: { notify: svc } });
    assert.equal(empty.status, 'skipped', JSON.stringify(empty.detail));
    assert.equal(empty.detail.due, 0);
    assert.ok(/没有到期/.test(empty.detail.note || ''), empty.detail.note);

    // ② 有到期的、上游仍 503 → ok（"上游还不通"不是任务失败）
    await svc.emit({ tenantId: org.id, event: 'backup.failed', payload: { note: 'x' } });
    await push();
    const stillFailing = await runTask('notify.retry', { tenantId: org.id, params: {}, deps: { notify: svc } });
    assert.equal(stillFailing.status, 'ok', '上游还不通不是任务失败：' + JSON.stringify(stillFailing.detail));
    assert.equal(stillFailing.detail.stillPending, 1);
    assert.equal(stillFailing.detail.dead, 0);

    // ③ 打到上限 → 出现新的死信 → fail（"平台放弃了一条告警"值得一个红点）
    db.run('UPDATE notify_deliveries SET attempts = 6 WHERE tenant_id = ?', [org.id]);
    await push();
    const deadRun = await runTask('notify.retry', { tenantId: org.id, params: {}, deps: { notify: svc } });
    assert.equal(deadRun.status, 'fail', '出现新死信必须记 fail：' + JSON.stringify(deadRun.detail));
    assert.equal(deadRun.detail.dead, 1);
    assert.ok(/人工排查/.test(deadRun.detail.note || ''), '要告诉人下一步做什么：' + deadRun.detail.note);
  } finally { await sink.close(); }
});

await t('定时任务：`notify.retry` 必须在默认任务里（不播种 = 队列只进不出）', () => {
  const kinds = DEFAULT_JOBS.map((j) => j.kind);
  assert.ok(kinds.includes('notify.retry'), '默认任务必须包含通知重投，实际：' + kinds.join(', '));
  const job = DEFAULT_JOBS.find((j) => j.kind === 'notify.retry');
  assert.ok(/^interval:\d+$/.test(job.schedule),
    '必须是 interval 规则（若写成 dailyAt，"10 分钟后重投"会变成一天一次），实际 ' + job.schedule);
});

/* ── §B10：备份的生产化落差（0.12.1）────────────────────────
 * 这一组钉三件事：① 备份失败**真的会出站**（此前 `backup.failed` 只是白名单里的一个空名字）；
 * ② 白名单与"产生方"**对得上**（声明与实现不许分家）；③ 自检能把"没配备份 / 没有备份 /
 * 没人订阅告警"如实问出来 —— 备份是唯一"不做也不会报错"的运维必需项，自检是唯一的防线。
 * ------------------------------------------------------------------ */

await t('★ §B10：自动备份失败必须**出站告警** —— `backup.failed` 不再是"白名单里的空名字"', async () => {
  const org = orgRepo.createOrg({ name: '备份告警公司', slug: 'b10-' + Math.random().toString(36).slice(2, 8) });
  const emitted = [];
  const notify = { emit: async (m) => { emitted.push(m); return { ok: true, delivered: 0 }; } };
  const BOOM = 'unable to open database file: E:\\sti\\data\\sti-harness.db';

  // ① 失败 → 必须恰好出站一次，且**任务仍如实记 fail**
  const r1 = await runTask('backup.create', {
    tenantId: org.id, params: {},
    deps: { operation: { backupNow() { throw new Error(BOOM); } }, notify },
  });
  assert.equal(r1.status, 'fail', '备份失败必须记成 fail —— 吞掉它就等于"连续失败"在调度页上也看不见');
  assert.equal(emitted.length, 1, '备份失败必须恰好出站一次');
  assert.equal(emitted[0].event, 'backup.failed');
  assert.equal(emitted[0].tenantId, org.id, '必须带对租户 —— 否则告警会发到另一个组织的渠道');
  assert.equal(emitted[0].payload.error, BOOM, '原始错误要原样带上（藏着原因，运维只能猜）');
  assert.ok(String(emitted[0].payload.note).includes('自动备份失败'), 'note 是钉钉/企微接收端直接渲染的那一行');

  // ② 出站自己炸了，**绝不许顶替**原始错误 —— 否则排查方向会被带偏
  const r2 = await runTask('backup.create', {
    tenantId: org.id, params: {},
    deps: { operation: { backupNow() { throw new Error(BOOM); } }, notify: { emit: async () => { throw new Error('webhook down'); } } },
  });
  assert.equal(r2.status, 'fail');
  assert.equal(r2.detail.error, BOOM, '出站失败不许掩盖原始错误');

  // ③ 没配通知（`deps.notify` 缺席）时**不许因此崩掉** —— 备份失败本身仍要如实上报
  const r3 = await runTask('backup.create', {
    tenantId: org.id, params: {},
    deps: { operation: { backupNow() { throw new Error(BOOM); } } },
  });
  assert.equal(r3.status, 'fail', '没有通知渠道时，备份失败也要如实记 fail');

  // ④ 成功时**不出站** —— 否则告警通道会被"一切正常"刷屏（同"试发不入队"的判断）
  const r4 = await runTask('backup.create', {
    tenantId: org.id, params: {},
    deps: {
      operation: {
        backupNow: () => ({ name: 'backup-x.zip', bytes: 1, manifest: { storage: { fileCount: 0 } } }),
        pruneBackups: () => ({ ok: true, keep: 30, total: 1, kept: 1, removed: [], freedBytes: 0 }),
      },
      notify,
    },
  });
  assert.equal(r4.status, 'ok');
  assert.equal(emitted.length, 1, '备份成功不该产生任何告警');
});

await t('★ §B10：通知白名单每个事件的**产生方**必须对得上（白名单 ≠ 有实现）', () => {
  const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

  // ① 键集必须与白名单完全一致 —— 少一个，就等于"新加的事件没人管它有没有产生方"
  assert.deepEqual(Object.keys(NOTIFY_EVENT_PRODUCERS).sort(), [...NOTIFY_EVENTS].sort(),
    '对账表的键集必须与 NOTIFY_EVENTS 完全一致');

  // ② 表里声明的产生方，那个文件里必须**真的**能找到一个 emit 点
  for (const ev of NOTIFY_EVENTS) {
    const rel = NOTIFY_EVENT_PRODUCERS[ev];
    if (rel == null) continue;   // 显式写下的"当前没有产生方"（见 §D2，属产品裁决不是遗漏）
    assert.ok(src('../' + rel).includes("event: '" + ev + "'"),
      '对账表说 `' + ev + '` 由 ' + rel + ' 产生，但那里找不到 `event: \'' + ev + '\'` —— 声明与实现分家了');
  }

  // ③ 反向：全 `app/` 里所有字面 emit 的事件，集合必须**恰好等于**表里非 null 的那些
  //    （多出来 = 有人 emit 了没登记的事件；少一个 = 表在说谎）
  //
  // ⚠️ 必须先**剥掉注释**再扫：试发用的表面事件名（见 `testChannel`）只出现在注释与
  //    别名调用里，留在里面会让这条守卫随"某人改了一句注释"而假红 —— 会假红的守卫，
  //    最后一定被人关掉，那还不如没有。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // `[^:]` 是为了不误伤 `https://` 这类字符串里的斜杠
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : (d.name.endsWith('.mjs') ? [p] : []);
  });
  const found = new Set();
  for (const abs of walk(fileURLToPath(new URL('../app/', import.meta.url)))) {
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const m of code.matchAll(/event:\s*'([^']+)'/g)) found.add(m[1]);
  }
  const declared = new Set(NOTIFY_EVENTS.filter((e) => NOTIFY_EVENT_PRODUCERS[e] != null));
  assert.deepEqual([...found].sort(), [...declared].sort(),
    '实际 emit 的事件集必须与对账表里"有产生方"的那批完全一致');
  for (const ev of found) {
    assert.ok(NOTIFY_EVENTS.includes(ev), '有人 emit 了白名单外的事件：' + ev + '（会被 notify 直接拒投）');
  }

  // ④ 试发专用的事件名**刻意不在白名单里**：渠道订阅列表不该出现"测试"这种东西
  assert.ok(!NOTIFY_EVENTS.includes('notify.test'),
    'notify.test 是试发用的表面事件名，不该进白名单（进了就能被订阅，等于多出一个常规事件）');

  // ⑤ 手工备份接口**刻意不**报同一个事件：那是"人在旁边看着"的动作，错误会直接显示给操作者；
  //    把它也出站只会让告警通道被操作者的试错刷屏（同"试发不入队"的判断）。
  assert.ok(!stripComments(src('../app/http/routes/operation.mjs')).includes('backup.failed'),
    '手工备份接口不该出站 backup.failed —— 出站只归定时任务');
});

/* ── §B11：会成串发生的告警必须**既发得出去、又不刷屏**（0.13.0）
 * `quota.blocked` 从 0.8.0 起就在白名单里、却全项目没有产生方。
 * 补产生方时最容易做错的两头：① 补了但没人知道它被**节流**（运维以为链路坏了）；
 * ② 逐次出站，把告警通道刷成噪音（刷屏的告警等于没有告警）。这一组就是钉这两头。
 * ------------------------------------------------------------------ */

/** 建一个租户 + 一个只订阅指定事件的渠道 + 真实通知服务（可反复用，不互相污染节流窗口）。 */
async function producerSetup(events) {
  const org = orgRepo.createOrg({ name: '产生方公司', slug: 'pr-' + Math.random().toString(36).slice(2, 8) });
  const sink = await b5Sink();
  const svc = createNotifyService({
    masterSecret: crypto.randomBytes(32), encryptSecret, decryptSecret, allowLoopback: true, timeoutMs: 2000,
  });
  const ch = svc.createChannel(org.id, { name: '产生方探针', url: sink.url, events });
  assert.ok(ch.ok, '建渠道应成功：' + (ch.error || ''));
  return { org, sink, svc };
}

await t('★ §B11：配额拦截**真的会出站**，并按「同租户 + 同指标」合并（合并的是通知，不是事实）', async () => {
  const { org, sink, svc } = await producerSetup(['quota.blocked']);
  try {
    const deps = { notify: svc };

    // ① 第一次：必须真的到达接收端（这是"有产生方"的可验证含义 —— 不是"代码里有个函数"）
    const r1 = await emitQuotaBlocked(deps, { tenantId: org.id, metric: 'turns', reason: 'turns(day) 100/100 · block', routeId: 'kernel.turns' });
    assert.equal(r1.delivered, 1, '第一次配额拦截必须出站：' + JSON.stringify(r1));
    assert.equal(sink.hits.length, 1);
    const body1 = JSON.parse(sink.hits[0].body);
    assert.equal(body1.event, 'quota.blocked');
    assert.equal(body1.tenantId, org.id, '必须带对租户 —— 否则告警会发到另一个组织的渠道');
    assert.equal(body1.data.metric, 'turns');
    assert.ok(/配额拦截/.test(body1.data.note), 'note 是钉钉/企微直接渲染的那一行：' + body1.data.note);
    assert.ok(body1.data.note.includes('100/100'), '人话原因要带上真实用量，收到的人才知道拦在哪：' + body1.data.note);

    // ② 同一指标再拦三次 → **一条都不再发**，但**如实说明为什么没发**（最不能接受的是静默）
    for (let i = 0; i < 3; i++) {
      const r = await emitQuotaBlocked(deps, { tenantId: org.id, metric: 'turns', reason: '仍然超限' });
      assert.equal(r.throttled, true, '窗口内应被合并：' + JSON.stringify(r));
      assert.equal(r.delivered, 0);
      assert.equal(r.ok, true, '"我们决定不发"不是投递失败 —— 记成失败会让投递成功率这个数字从一开始就是假的');
      assert.ok(/节流/.test(r.note) && /秒后可再发/.test(r.note),
        '必须说清"没发"与"多久之后能发"，否则运维会以为告警链路坏了：' + r.note);
    }
    assert.equal(sink.hits.length, 1, '窗口内只应出站一次（刷屏的告警等于没有告警）');

    // ③ 换一个指标 → 另一个键 → 必须再出站：turns 被限住不代表 token 也被限住，两件事
    await emitQuotaBlocked(deps, { tenantId: org.id, metric: 'input_tokens', reason: 'token 达标' });
    assert.equal(sink.hits.length, 2, '不同指标各有各的键，不能被前一个的窗口吞掉');
    assert.equal(JSON.parse(sink.hits[1].body).data.metric, 'input_tokens');

    // ④ 换一个租户 → 另一个键（一个组织的噪音不该让另一个组织的告警消失）
    const other = orgRepo.createOrg({ name: '另一家', slug: 'pr2-' + Math.random().toString(36).slice(2, 8) });
    const ch2 = svc.createChannel(other.id, { name: '另一家探针', url: sink.url, events: ['quota.blocked'] });
    assert.ok(ch2.ok, '建渠道应成功：' + (ch2.error || ''));
    const r4 = await emitQuotaBlocked(deps, { tenantId: other.id, metric: 'turns', reason: 'x' });
    assert.equal(r4.delivered, 1, '另一个租户也有订阅渠道 → 必须送达');
    assert.notEqual(r4.throttled, true,
      '节流键含租户：A 组织刚发过的告警不能让 B 组织的同类告警消失（那是一次静默的漏报）');
    assert.equal(sink.hits.length, 3);
    assert.equal(JSON.parse(sink.hits[2].body).tenantId, other.id);

    // ⑤ 没人订阅时**不消耗节流窗口** —— 顺序是刻意的：
    //    若先计时再看订阅，一次"还没配渠道"的拦截会把窗口占掉，等运维配好渠道后
    //    窗口内真正该收到的那条反而被合并没了。
    const { org: org2, sink: sink2, svc: svc2 } = await producerSetup(['backup.failed']);   // 订阅的是别的事件
    try {
      const a = await emitQuotaBlocked({ notify: svc2 }, { tenantId: org2.id, metric: 'turns', reason: 'x' });
      const b = await emitQuotaBlocked({ notify: svc2 }, { tenantId: org2.id, metric: 'turns', reason: 'x' });
      assert.notEqual(a.throttled, true, '没有订阅 = 没人收到 = 不该计时');
      assert.notEqual(b.throttled, true, '同上：两次都不该被判成节流（窗口从来没被占用）');
      assert.equal(sink2.hits.length, 0, '没有订阅这个事件 → 一个包都不该发');
    } finally { await sink2.close(); }

    // ⑥ 两个节流窗口的取值是**声明出来的常量**，不是散落在调用点里的魔数
    assert.ok(QUOTA_BLOCKED_COOLDOWN_MS >= 60_000, '配额告警窗口至少 1 分钟，否则等于没节流');
  } finally { await sink.close(); }
});

await t('★ §B11：产生方在"没装配通知 / 没租户"时**如实降级**，绝不让告警把业务请求打挂', async () => {
  // 装配缺陷不许以"崩掉一次业务请求"的形式暴露（同"审计留痕失败不影响拦截本身"）：
  // 配额该拦的还是要拦住 —— 只是没有人会收到告警。
  const a = await emitQuotaBlocked({}, { tenantId: 'org-x', metric: 'turns' });
  assert.equal(a.ok, false);
  assert.equal(a.skipped, 'notify_unwired');
  assert.ok(/装配缺陷/.test(a.note) && /审计/.test(a.note),
    '要说清"拦截仍然生效、只是没人收到告警" —— 否则读日志的人会以为拦截也失效了：' + a.note);

  const b = await emitQuotaBlocked({ notify: { emit: async () => ({ ok: true }) } }, { tenantId: '', metric: 'turns' });
  assert.equal(b.skipped, 'no_tenant', '没有租户就无从决定发给谁 —— 宁可如实跳过，也不要瞎发到一个默认租户');

  // 出站自己抛错 → 收敛成返回值，不向业务路径抛
  const c = await emitQuotaBlocked({ notify: { emit: async () => { throw new Error('webhook down'); } } },
    { tenantId: 'org-x', metric: 'turns' });
  assert.equal(c.ok, false);
  assert.equal(c.skipped, 'emit_failed');
  assert.equal(c.error, 'webhook down');
});

await t('★ §B11：产生方**接在真正的拦截点上**（配额中间件拦下即出站；缺装配不许崩）', async () => {
  // 只测产生方函数是不够的：它可能写得很好，却**没有被任何拦截点调用**（这正是
  // `backup.failed` 那一类"白名单里的空名字"的成因）。所以这里直接把中间件拉起来跑。
  const emitted = [];
  const mkCtx = () => ({
    chain: [], route: { id: 'kernel.turns', quotaMetric: 'turns' },
    tenantId: 'org-1', userId: 'usr-1', middleware: {},
    json: (status, body) => { mkCtx.lastStatus = status; mkCtx.lastBody = body; },
    setHeader: () => {}, passthrough: [], requestId: 'req-1',
  });

  // ① 判定为 block → 放行被终止 + 403 + 出站一条
  const reg1 = createMiddlewareRegistry({
    governance: { quotas: { evaluate: () => ({ action: 'block', reason: 'turns(day) 5/5 · block', checked: [] }) } },
    notify: { emit: async (m) => { emitted.push(m); return { ok: true, delivered: 1 }; } },
  });
  const ctx1 = mkCtx();
  assert.equal(await reg1.quota(ctx1), 'stop', '被拦截必须终止链（否则 handler 照样跑 = 治理表演）');
  assert.equal(mkCtx.lastStatus, 403);
  assert.equal(mkCtx.lastBody.error.code, 'quota_blocked');
  // 出站刻意不 await（一次 webhook 超时不该拖住已经决定要拒绝的请求），所以等一拍再看
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(emitted.length, 1, '配额拦截必须出站 —— 这是"白名单事件有产生方"的可验证含义');
  assert.equal(emitted[0].event, 'quota.blocked');
  assert.equal(emitted[0].tenantId, 'org-1');
  assert.equal(emitted[0].payload.metric, 'turns', '报文体要带上是哪个指标被拦（收到的人只看得懂这一层）');
  assert.equal(emitted[0].dedupeKey, 'turns', '节流键必须落到指标上，否则不同指标的告警会互相吞掉');

  // ② 判定为 pass → 不出站、不终止
  const reg2 = createMiddlewareRegistry({
    governance: { quotas: { evaluate: () => ({ action: 'pass', checked: [] }) } },
    notify: { emit: async () => { emitted.push({ event: '不该发生' }); } },
  });
  assert.equal(await reg2.quota(mkCtx()), undefined, '放行时不该终止链');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(emitted.length, 1, '放行不是事件 —— 一次都不该发');

  // ③ 没装配 governance.quotas → 如实标 degraded 并放行，**不许崩**（缺装配是缺陷，不是策略）
  const reg3 = createMiddlewareRegistry({ notify: {} });
  const ctx3 = mkCtx();
  await reg3.quota(ctx3);
  assert.equal(ctx3.middleware.quota, 'degraded');
  assert.deepEqual(ctx3.passthrough, ['quota'], '缺装配要在链状态里如实留痕，绝不假装检查过');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(emitted.length, 1, '缺装配时不可能有告警，也不该有');
});

await t('★ §B10：自检第 [14] 项把「没配备份 / 没有备份 / 没人订阅告警」如实问出来', async () => {
  // 自检是**唯一**能在"上线前"发现"这台机器其实没有任何备份"的地方 ——
  // 备份没配不会让服务报错、页面上也看不出异常，直到真的需要恢复那天。
  const cfg = { values: { host: '127.0.0.1', port: 0 } };
  // 只做替身的最小 kernel：本用例只断言第 [14] 项，其余项（[7]/[8]）判什么都不影响。
  const kernel = {
    ready: true, reason: '', provider: {}, dshStatus: {}, mapping: null,
    async describe() { return { kernel: '', contractVersion: '1.0.0', kernelVersion: '' }; },
  };
  // `listJobs` 只对**第一个**组织返回任务：诊断内部是按组织循环的，恒返回会让份数随组织数虚增。
  const jobOnce = (list) => { let seen = 0; return { listJobs: () => (++seen === 1 ? list : []) }; };
  const pick14 = (r) => r.items.find((i) => i.n === 14);

  // ① 什么都没配（最危险的状态：一切"正常"）
  const r1 = await runCheck({
    config: cfg, kernel,
    operation: { listBackups: () => ({ items: [], dir: 'D:\\sti\\data\\backups', note: '还没有 backups 目录 —— 从未创建过备份。' }) },
    schedule: jobOnce([]), notify: { listChannels: () => [] },
  });
  const it1 = pick14(r1);
  assert.ok(it1, '自检必须有第 [14] 项（否则"没配备份"没有任何地方能看见）');
  assert.equal(it1.title, '备份与恢复');
  assert.equal(it1.level, 'warn', '完全没备份必须给 warn，不能是 ok（"没问题"与"没检查"必须区分开）');
  const t1 = it1.lines.join('\n');
  assert.ok(t1.includes('**未配置**'), '要直说自动备份任务没配：' + t1);
  assert.ok(t1.includes('没有任何可恢复的还原点'), '要直说没有还原点');
  assert.ok(t1.includes('restore-backup.mjs'), '恢复是**离线**动作这条必须在自检里能看到（光写在文档里没人读）');
  assert.ok(t1.includes('不在备份包内'), '主密钥不进包、要单独保管这条也要在');
  assert.ok(t1.includes('dailyAt:03:00'), '要给出可直接照做的配置建议，而不是只说"请配置备份"');

  // ② 配齐了：任务启用 + 有备份 + 有人订阅 backup.failed
  // ⚠️ 第 [14] 项还会看**备份加密密钥**（源：STI_BACKUP_KEY → data/backup.key → 都没有则 warn）。
  //    那是**环境**输入，不是本用例的参数 —— 不显式钉住，它就会随"本机 data/backup.key 在不在"
  //    漂移：没清过库的机器上绿、清过库（重置成"刚解压"）的机器上红。用例的结论不能由环境决定。
  const prevBackupKey = process.env.STI_BACKUP_KEY;
  process.env.STI_BACKUP_KEY = 'a'.repeat(64);
  let r2;
  try {
    r2 = await runCheck({
      config: cfg, kernel,
      operation: { listBackups: () => ({ items: [{ file: 'backup-2026-10-02T03-00-00-000Z.zip', bytes: 1048576, mtime: '2026-10-02T03:00:00.000Z' }], dir: 'D:\\sti\\data\\backups', note: '' }) },
      schedule: jobOnce([{ id: 'j1', name: '自动备份', kind: 'backup.create', scheduleText: '每天 03:00', enabled: true, params: { keep: 30 } }]),
      notify: { listChannels: () => [{ name: '运维群', enabled: true, events: ['backup.failed'] }] },
    });
  } finally {
    if (prevBackupKey === undefined) delete process.env.STI_BACKUP_KEY;
    else process.env.STI_BACKUP_KEY = prevBackupKey;
  }
  const it2 = pick14(r2);
  assert.equal(it2.level, 'ok', '配齐后应当是 ok：' + it2.lines.join('\n'));
  const t2 = it2.lines.join('\n');
  assert.ok(t2.includes('1 条启用'), '要报出实际启用的任务条数与规则');
  assert.ok(t2.includes('1.0 MB'), '要报出最近一份备份的大小');
  assert.ok(t2.includes('订阅了 `backup.failed`'), '要确认告警链路真的有人收');

  // ③ 建了但停用 / 有备份但没人订阅 —— 两种"看着配了、其实没有"都要被抓出来
  const r3 = await runCheck({
    config: cfg, kernel,
    operation: { listBackups: () => ({ items: [{ file: 'backup-x.zip', bytes: 2048, mtime: '2026-10-01T00:00:00.000Z' }], dir: 'D:\\sti\\data\\backups', note: '' }) },
    schedule: jobOnce([{ id: 'j1', name: '自动备份', kind: 'backup.create', scheduleText: '每天 03:00', enabled: false, params: {} }]),
    notify: { listChannels: () => [{ name: '运维群', enabled: true, events: ['audit.anchor'] }] },
  });
  const it3 = pick14(r3);
  assert.equal(it3.level, 'warn');
  const t3 = it3.lines.join('\n');
  assert.ok(t3.includes('全部处于停用状态'), '停用 ≠ 已配置，这条必须点出来：' + t3);
  assert.ok(t3.includes('没有任何启用渠道订阅'), '没人订阅 backup.failed 要如实说（否则"备份失败会告警"是句空话）');
  assert.ok(t3.includes('不会被自动清理'), '手工备份不参与轮转这条边界要写出来');
});

await t('★ 0.15.0：自检第 [15] 项把「明文令牌还躺在 config.json 里」问出来', async () => {
  // 这条缺陷的形态是"**什么都不报错**"：服务照起、对话照跑、页面照显示"已接入"。
  // 0.15.0 之后写出去的都是密文，但**在这之前写下的配置不会自己变** ——
  // 于是那份明文副本会一直留在盘上，连带被每一份备份包与快照带走。
  // 自检是唯一能在"上线前"把它问出来的地方（同 [14] 的备份：不做也不会报错）。
  const kernel = {
    ready: true, reason: '', provider: {}, dshStatus: {}, mapping: null,
    async describe() { return { kernel: '', contractVersion: '1.0.0', kernelVersion: '' }; },
  };
  const pick15 = (r) => r.items.find((i) => i.n === 15);

  // ① 老配置的形状：令牌内嵌在地址里（0.15.0 之前所有部署都是这样）
  const r1 = await runCheck({
    config: { values: { host: '127.0.0.1', port: 0 }, sources: { dshOrigin: 'config.json', dshToken: 'config.json' } },
    kernel,
    rawConfig: { dshOrigin: 'http://127.0.0.1:3080/?token=not-a-real-token' },
  });
  const it1 = pick15(r1);
  assert.ok(it1, '自检必须有第 [15] 项（否则"明文令牌留在盘上"没有任何地方能看见）');
  assert.equal(it1.title, '内核令牌落盘卫生');
  assert.equal(it1.level, 'warn', '明文令牌必须给 warn——给 ok 就等于说它没问题');
  const t1 = it1.lines.join('\n');
  assert.ok(t1.includes('明文'), '要点名"明文"：' + t1);
  assert.ok(t1.includes('seal-kernel-token.mjs'), '必须给出可照着做的修法，而不是只说"请处理"');
  assert.ok(t1.includes('备份包'), '要说清代价落在哪（备份包与快照会把它一起带走）');
  // ⚠️ 反向断言：自检**只读**，不得打印令牌原文、更不得改写配置
  assert.ok(!t1.includes('not-a-real-token'), '自检输出里不许出现令牌原文（终端会被录屏、被贴进工单）');
  // 说明文字里会提到 `?token=` 这个**键名**（那是必要的解释），但不许出现"键名 + 值"的形状
  assert.ok(!/\?token=[^\s`）]/.test(t1), '连地址里的令牌片段也不该被原样打印出来：' + t1);
  assert.deepEqual(r1.items.filter((i) => i.n === 15 && i.level === 'fail'), [], '这是提醒不是阻塞，不能给 fail');

  // ② 独立的 dshToken 键（另一种老形状）
  const r2 = await runCheck({
    config: { values: { host: '127.0.0.1', port: 0 }, sources: {} }, kernel,
    rawConfig: { dshOrigin: 'http://127.0.0.1:3080', dshToken: 'not-a-real-token' },
  });
  const t2 = pick15(r2).lines.join('\n');
  assert.equal(pick15(r2).level, 'warn', '独立的明文键同样是明文');
  assert.ok(t2.includes('dshToken'), '要说清是哪一种形状（键 vs 地址内嵌），两种修法解释不同：' + t2);

  // ③ 已封存 / 未接入 —— 都必须是 ok，不能被上面的规则误伤
  const r3 = await runCheck({
    config: { values: { host: '127.0.0.1', port: 0 }, sources: { dshToken: 'config.json（密文，启动时解密）' } }, kernel,
    rawConfig: { dshOrigin: 'http://127.0.0.1:3080', dshTokenCipher: 'AAAA' },
  });
  assert.equal(pick15(r3).level, 'ok', '密文落盘就是 ok：' + pick15(r3).lines.join('\n'));
  assert.ok(pick15(r3).lines.join('\n').includes('密文'), '要肯定地报出"已经是密文"');

  const r4 = await runCheck({
    config: { values: { host: '127.0.0.1', port: 0 }, sources: {} }, kernel, rawConfig: {},
  });
  assert.equal(pick15(r4).level, 'ok', '没接入内核不该报警（否则每个 测试替身 部署都常亮一条噪声）');
});

/* ── 汇总 ───────────────────────────────────────────────── */
try { db.closeDb(); } catch { /* ignore */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

/* ── P0 · 内核接入向导 ─────────────────────────────────────
 *
 * 这一组钉的是"把 config.json 变成页面表单"背后的**纯逻辑**与**权限边界**。
 * 为什么值得单独一组：
 *   · 接入失败的分类（连不上 / 要令牌 / 令牌被拒 / 不是内核）**决定用户下一步做什么** ——
 *     分类错了，用户就会去改一个没问题的东西；
 *   · 写配置是**覆盖式**的，合并逻辑写错一次就会把运维手写的别的配置项抹掉；
 *   · 探测是服务端主动连向调用方指定的地址（SSRF 形状），**谁能发起**必须钉住。
 */
section('P0 · 内核接入向导：地址归一化 / 配置合并 / 诊断分类（纯函数）');

await t('地址归一化：三种真实输入形态都要吃下（整段粘贴 / 裸地址 / 反代带路径）', () => {
  // ① 最常见：把内核启动时打印的那一整行粘进来
  const a = normalizeKernelInput('http://127.0.0.1:3080/?token=abc-123', '');
  assert.equal(a.invalid, false);
  assert.equal(a.origin, 'http://127.0.0.1:3080');
  assert.equal(a.token, 'abc-123');
  assert.equal(a.tokenFrom, 'origin', '整段里的令牌要能被认出来');

  // ② 少写协议、令牌单独填
  const b = normalizeKernelInput('127.0.0.1:3080', 'tok-9');
  assert.equal(b.origin, 'http://127.0.0.1:3080');
  assert.equal(b.token, 'tok-9');
  assert.equal(b.tokenFrom, 'field');

  // ③ 反向代理下的带路径形态：路径必须保留（否则请求会打到错的地方）
  const c = normalizeKernelInput('https://gw.corp.example/kernel/', '');
  assert.equal(c.origin, 'https://gw.corp.example/kernel', '结尾斜杠去掉，路径保留');

  // ④ 优先级：地址里的令牌**优先于**单独填的。反过来会让用户以为新令牌生效了，
  //    而实际用的还是粘在地址里的旧令牌 —— 那种错极难自查。
  const d = normalizeKernelInput('http://h:1/?token=fromUrl', 'fromField');
  assert.equal(d.token, 'fromUrl');
});

await t('★ 地址归一化：危险协议与非地址必须**被拒并说清理由**（不许悄悄改写）', () => {
  const f = normalizeKernelInput('file:///etc/passwd', '');
  assert.equal(f.invalid, true);
  assert.match(f.error, /http/);
  assert.equal(normalizeKernelInput('javascript:alert(1)', '').invalid, true);
  assert.equal(normalizeKernelInput('data:text/plain,x', '').invalid, true);

  const empty = normalizeKernelInput('', '');
  assert.equal(empty.invalid, true);
  assert.equal(empty.empty, true);
  assert.match(empty.error, /不能为空/);

  const junk = normalizeKernelInput('::: 不是地址 :::', '');
  assert.equal(junk.invalid, true);
  assert.match(junk.error, /解析不了/);
});

await t('★ 配置合并：不认识的键必须原样保留（向导保存一次不该抹掉运维手写的配置）', () => {
  const before = {
    dshOrigin: 'http://old:1',
    dshToken: '明文旧令牌',
    embeddingModel: 'text-embedding-3-small',
    chunkMaxChars: 900,
    prefilterVector: true,
  };
  const after = mergeKernelConfigPatch(before, { origin: 'http://new:2', tokenCipher: 'CIPHER' });
  assert.equal(after.dshOrigin, 'http://new:2');
  assert.equal(after.embeddingModel, 'text-embedding-3-small', '别的配置项不许被抹掉');
  assert.equal(after.chunkMaxChars, 900);
  assert.equal(after.prefilterVector, true);
  // 入参不得被改（纯函数）
  assert.equal(before.dshOrigin, 'http://old:1');
  assert.equal(before.dshToken, '明文旧令牌');
});

await t('★ 配置合并：令牌一律走密文键，且**明文键必须被清掉**', () => {
  const after = mergeKernelConfigPatch({ dshToken: '明文旧令牌', dshOrigin: 'http://a:1' }, { origin: 'http://a:1', tokenCipher: 'CIPHER' });
  assert.equal(after.dshTokenCipher, 'CIPHER');
  assert.ok(!('dshToken' in after), '留着明文副本 = 白加密');

  // 显式清空令牌：两个键都不该留
  const cleared = mergeKernelConfigPatch({ dshTokenCipher: 'C', dshToken: 'P' }, { tokenCipher: null });
  assert.ok(!('dshTokenCipher' in cleared) && !('dshToken' in cleared));

  // 只改地址（不给令牌动作）：令牌两个键都保持原样
  const kept = mergeKernelConfigPatch({ dshTokenCipher: 'C' }, { origin: 'http://b:2' });
  assert.equal(kept.dshTokenCipher, 'C');

  // 脏输入（文件被外部改坏）不许把整个保存流程炸掉
  assert.deepEqual(mergeKernelConfigPatch('不是对象', { origin: 'http://x:1' }), { dshOrigin: 'http://x:1' });
  assert.deepEqual(mergeKernelConfigPatch(null, { origin: 'http://x:1' }), { dshOrigin: 'http://x:1' });
  assert.deepEqual(mergeKernelConfigPatch([1, 2], { origin: 'http://x:1' }), { dshOrigin: 'http://x:1' });
});

await t('★ 诊断文案：六类失败各自给出**不同的下一步**（分类错 = 让人去改没坏的东西）', () => {
  const hints = new Set();
  const stages = new Set();
  for (const s of ['unreachable', 'need-token', 'token-rejected', 'forbidden', 'not-kernel', 'bad-origin']) {
    const d = diagnoseKernelState({ state: s });
    assert.equal(d.ok, false, s + ' 不该被判成可用');
    assert.ok(d.verdict && d.hint, s + ' 必须同时有结论和下一步');
    hints.add(d.hint);
    stages.add(d.stage);
  }
  // **下一步**必须六类各不相同 —— 那才是"分类"的意义所在。
  assert.equal(hints.size, 6, '六类失败的"下一步"必须互不相同');
  // "卡在哪一步"可以合并（need-token / token-rejected / forbidden 都卡在鉴权），
  // 但四类阶段都要覆盖到：地址 / 连通 / 鉴权 / 识别。
  assert.deepEqual([...stages].sort(), ['地址', '连通', '识别', '鉴权'].sort());

  // 未知状态要有兜底，不能漏出一句空话
  const u = diagnoseKernelState({ state: '某个没见过的新状态' });
  assert.equal(u.state, 'unknown');
  assert.ok(u.hint.length > 0);
  // 上游给的原文要原样透出（那是实测），不能替换成我们编的话
  const withDetail = diagnoseKernelState({ state: 'unreachable', error: 'connect ECONNREFUSED 127.0.0.1:3080' });
  assert.match(withDetail.detail, /ECONNREFUSED/, '上游原文要照实带出来');
});

await t('★ 诊断：版本未验证时结论仍是"可用"，但必须把"未经验证"说出来', () => {
  const d = diagnoseKernelState({
    state: 'ok',
    versionGate: { level: 'warn', detail: '该版本不在已验证矩阵内' },
  });
  assert.equal(d.ok, true, '黄灯不拦 —— 版本跑得比我们验证得快是常态');
  assert.equal(d.versionWarning, '该版本不在已验证矩阵内');
  assert.match(d.hint, /verify-upstream/, '要给出核实手段，而不是只说一句"未验证"');

  // 已验证版本：不该无中生有地警告
  const clean = diagnoseKernelState({ state: 'ok', versionGate: { level: 'ok', detail: '在已验证版本矩阵内' } });
  assert.equal(clean.versionWarning, null);
});

await t('待重启判定：比的是"运行中实际连的地址"与"文件里写的地址"两个客观值', () => {
  const p = describeKernelRestart({ runningOrigin: 'http://a:1', fileOrigin: 'http://b:2' });
  assert.equal(p.pending, true);
  assert.deepEqual(p.changed, ['dshOrigin']);
  assert.match(p.note, /重启/);

  // 尾斜杠与大小写不该被当成"改了"
  const same = describeKernelRestart({ runningOrigin: 'http://A:1/', fileOrigin: 'http://a:1' });
  assert.equal(same.pending, false);
  assert.equal(same.note, '');
});

await t('★ 待重启判定：默认配置（没配地址 = 未接入）绝不许常亮"需要重启"', () => {
  // 真机验收当场看到的**假警报**：配置文件里是默认值，概览页却一直说"配置文件与运行中不一致"。
  // 根因是把**解析策略**（曾经的 `auto`）当成**模式**去和运行值比 —— `auto` 与它解析出来的结果
  // 永远不相等，于是这条提示对**每一个默认部署**恒真。恒真的提示等于噪声：
  // 用户很快学会忽略它，那它就不再是提示了。
  //
  // 0.21.4 把"内核模式"整个概念删了（见 app/config.mjs 的注释），判据只剩地址一个。
  // 但这条教训仍然要钉住 —— **任何对每个默认部署都恒真的提示都是噪声**：
  // 现在的默认配置是"没有地址"（未接入），它绝不该被判成"改了地址"。
  const dft = describeKernelRestart({ runningOrigin: '', fileOrigin: '', originSource: 'default' });
  assert.equal(dft.pending, false, '默认配置（未接入）不该被判成"改了地址"');
  assert.deepEqual(dft.changed, []);

  // 老配置里连 `dshOrigin` 这个键都没有（0.21.4 之前的默认值曾是一条 127.0.0.1 地址，
  // 已删）—— "缺键"与"空地址"是同一件事：没接入。也不许报待重启。
  const absent = describeKernelRestart({ runningOrigin: '', fileOrigin: undefined });
  assert.equal(absent.pending, false, '缺键 = 没配地址，不是"改了地址"');

  // 反向：文件里真的写了另一个地址 —— 这才是待重启
  const real = describeKernelRestart({ runningOrigin: 'http://a:1', fileOrigin: 'http://b:2' });
  assert.equal(real.pending, true);
  assert.deepEqual(real.changed, ['dshOrigin']);
  assert.match(real.note, /重启/, '要说清改的是哪一项，不能只说"不一致"');
});

await t('★ 待重启判定：历史配置把令牌写在地址里，不该被判成"改了地址"', () => {
  // 0.15.0 之前所有部署的 data/config.json 都是 `http://127.0.0.1:3080/?token=…` 这个形状，
  // 而运行中的地址是解析后的（令牌已摘出单独持有）。不丢查询串就会**恒不相等**，
  // 于是这些部署每次打开概览页都看到一条假的"需要重启"。
  // ⚠️ 这里的令牌**必须是假的、且要短**。它曾经是一条**真实令牌**（从本机
  // `data/config.json` 整行抄过来的），而 `tools/` 里的内容会**随发布包分发** ——
  // 那就是把客户的内核令牌印在发布包里。打包扫描原先只扫 `app/`，没拦住；
  // 现在 `pack-release.mjs` 的令牌形态扫描已覆盖 `tools/`，这条用例本身就是它的守卫。
  const legacy = describeKernelRestart({
    runningOrigin: 'http://127.0.0.1:3080',
    fileOrigin: 'http://127.0.0.1:3080/?token=abc',
  });
  assert.equal(legacy.pending, false, '地址上内嵌的令牌不是"改了地址"');
  assert.deepEqual(legacy.changed, []);

  // 但换端口 / 换主机**是**改了地址，不许被这条宽容掉
  assert.deepEqual(
    describeKernelRestart({ runningOrigin: 'http://127.0.0.1:3080', fileOrigin: 'http://127.0.0.1:3099/?token=x' }).changed,
    ['dshOrigin']);
  assert.deepEqual(
    describeKernelRestart({ runningOrigin: 'http://a:1', fileOrigin: 'https://a:1/' }).changed,
    ['dshOrigin'], '协议变了也是变了');
});

await t('★ 待重启判定：地址来自环境变量时必须明说"在页面上保存不会生效"', () => {
  const p = describeKernelRestart({
    runningOrigin: 'http://a:1', fileOrigin: 'http://b:2',
    originSource: 'env', envName: 'DSH_ORIGIN',
  });
  // 环境变量覆盖配置文件 → 此时"文件与运行中不一致"是**假警报**，
  // 真正该说的是"你在这儿改没用"。不这么说，用户会反复保存反复重启，然后认定功能坏了。
  assert.equal(p.pending, false);
  assert.equal(p.overriddenByEnv, true);
  assert.match(p.note, /DSH_ORIGIN/);
  assert.match(p.note, /不会生效/);
});

await t('★ 权限：只有管理员能改内核接入；成员与访客连探测都不该能发起', () => {
  // 探测是服务端主动连向调用方指定的地址（SSRF 形状），保存是改平台连到哪台引擎。
  assert.equal(can(['owner'], 'system', 'write'), true);
  assert.equal(can(['admin'], 'system', 'write'), true, '管理员是这个平台的运维角色，接入内核是运维动作');
  assert.equal(can(['member'], 'system', 'write'), false, '成员不得探测/改写内核接入');
  assert.equal(can(['viewer'], 'system', 'write'), false);
  // 读不受影响：状态页仍要能看
  assert.equal(can(['member'], 'system', 'read'), true);
  assert.equal(can(['viewer'], 'system', 'read'), true);
});

section('P0 · 内核接入向导：探测分类要对着**真实 HTTP 响应**判（本地桩，不打外网）');

/**
 * 起一个可编程桩服务端，让它扮演"上游内核"的几种真实响应形态。
 * 为什么不 伪造 fetch：分类依据的是**响应状态码 + 响应体特征**，
 * 把 fetch 换掉等于把待验证的判据自己写了一遍 —— 那就什么都没验证。
 */
async function withStub(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try { return await fn(port); } finally { await new Promise((r) => srv.close(r)); }
}

await t('探测分类：要求鉴权 → need-token（并明确"连上了"）', async () => {
  await withStub((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required');
  }, async (port) => {
    const p = await probeKernelConnection({ origin: 'http://127.0.0.1:' + port, timeoutMs: 3000 });
    assert.equal(p.state, 'need-token');
    assert.equal(p.reachable, true, '"连上了但要令牌"必须与"连不上"分开');
    assert.equal(p.ok, false);
    assert.equal(p.stage, '鉴权');
    assert.equal(p.hasToken, false);
  });
});

await t('探测分类：可认证可达 → ok（令牌被识别，且不回显令牌）', async () => {
  await withStub((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><script>window.__DSH_BOOT__={"rev":"abcdef123456"}</script>DeepSeek Harness</html>');
  }, async (port) => {
    const p = await probeKernelConnection({ origin: 'http://127.0.0.1:' + port + '/?token=t-1', timeoutMs: 3000 });
    assert.equal(p.state, 'ok');
    assert.equal(p.ok, true);
    assert.equal(p.authed, true);
    assert.equal(p.hasToken, true);
    assert.equal(p.rev, 'abcdef123456', '上游给的 rev 要如实带出来');
    // ★ 响应里绝不能出现令牌明文（探测结果会原样进 HTTP 响应体）
    assert.ok(!JSON.stringify(p).includes('t-1'), '探测结果不得回显令牌');
  });
});

await t('探测分类：有响应但不像内核 → not-kernel（并且与"连不上"分开）', async () => {
  await withStub((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', server: 'nginx' });
    res.end('<html><body>欢迎访问公司内网首页</body></html>');
  }, async (port) => {
    const p = await probeKernelConnection({ origin: 'http://127.0.0.1:' + port, timeoutMs: 3000 });
    assert.equal(p.state, 'not-kernel');
    assert.equal(p.reachable, true);
    assert.equal(p.authed, false);
    assert.equal(p.stage, '识别');
  });
});

await t('探测分类：端口没人听 → unreachable（如实带出底层错误）', async () => {
  // 先占一个端口再关掉，拿到一个确定没人听的端口号
  const port = await withStub((req, res) => res.end('x'), (p) => p);
  const p = await probeKernelConnection({ origin: 'http://127.0.0.1:' + port, timeoutMs: 3000 });
  assert.equal(p.state, 'unreachable');
  assert.equal(p.reachable, false);
  assert.equal(p.stage, '连通');
  assert.ok(p.detail.length > 0, '连不上也要说清是什么错');
});

await t('探测：地址非法时**不打网络**就给出结论（bad-origin）', async () => {
  const p = await probeKernelConnection({ origin: 'file:///etc/passwd' });
  assert.equal(p.state, 'bad-origin');
  assert.equal(p.stage, '地址');
  assert.equal(p.reachable, false);
  assert.match(p.hint, /http/);
});

/* ── 运行期抹名：静态审计看不见的那一类泄漏 ──────────────────────────────
 * `tools/audit-layering.mjs` 是**源码静态扫描** —— 它只能证明"产品层的源码里没写上游名"。
 * 真机验收抓到的却是另一条路：上游名藏在**运行期字符串**里（provider 的散文、上游错误体），
 * 一路穿过契约层显示在用户屏幕上，而审计全程是绿的。
 * 下面三条把这一类钉住：抹名函数本身、降级原因（概览页上那句话）、探测结果整体。
 */

await t('★ 抹名函数：上游产品名换成中性词，且幂等、不误伤运维变量名', () => {
  const raw = '该地址有响应，但不像是 DSH（HTTP 200）';
  const once = neutralizeUpstreamText(raw);
  assert.ok(!/dsh/i.test(once), '抹完还留着上游名：' + once);
  assert.ok(once.includes('内核'), '要换成中性词而不是删掉（读起来还得是句人话）：' + once);
  assert.ok(!/像是\s+内核/.test(once), '抹名后中文里不该剩一个孤零零的空格：' + once);
  assert.equal(neutralizeUpstreamText(once), once, '抹名必须幂等（会被多层重复调用）');

  // 运维接口名（DSH_HOME 这类环境变量）**故意不动**：词边界挡得住，
  // 而把它也换掉会让"该设哪个变量"这件事在报错里说不清。
  assert.equal(neutralizeUpstreamText('或换过 DSH_HOME'), '或换过 DSH_HOME');
  assert.equal(neutralizeUpstreamText(''), '');
  assert.equal(neutralizeUpstreamText(null), '');
});

await t('★ 不可用原因是人话（不是机器状态 id），且不含上游产品名', async () => {
  // 占一个端口再放掉 —— 拿到一个确定没人听的地址，走"有地址但连不上"这条路。
  //
  // 0.21.4 之前这里钉的是"降级原因"（auto 探测失败 → 降级内置内核）。降级已删除，
  // 所以现在钉的是同一件事的另一面：**已配置但不可用**时给出的那句话，
  // 同样不许贴机器状态 id、不许带上游产品名 —— 它出现在整页阻断页上，
  // 是用户能看到的最重要的一句话（见 public/app/60-page-platform.js 的 pageKernelGate）。
  const port = await withStub((req, res) => res.end('x'), (p) => p);
  const k = await selectKernel({ dshOrigin: 'http://127.0.0.1:' + port, dshToken: '' });
  assert.equal(k.ready, false, '连不上就该如实报"不可用"');
  assert.ok(!/dsh/i.test(k.reason), '那句话里出现了上游产品名：' + k.reason);
  assert.ok(!/need-token|unreachable|token-rejected|not-kernel/.test(k.reason),
    '把机器状态 id 直接贴给用户 = 词表白建了：' + k.reason);
  assert.ok(k.reason.includes('连通'), '要说清卡在哪一步（这一步的 stage 是"连通"）：' + k.reason);
});

await t('★ 没配地址 = 未接入：如实报不可用，且不假装有内核', async () => {
  // 0.21.4 的核心语义。从前这里会返回一个内置内核（mock），
  // 让平台"看起来能工作" —— 那层已被整个删掉。
  const k = await selectKernel({ dshOrigin: '', dshToken: '' });
  assert.equal(k.ready, false, '没配地址就必须是"未接入"');
  assert.match(k.reason, /尚未接入/, '要说清是"没接入"而不是"连不上"（两者对用户的下一步不同）');
  // 占位 provider 的每一个契约方法都必须**如实拒绝**，不许返回"看起来正常的空结果"，
  // 否则"没接入"和"接入了但确实没有会话"就分不开了 —— 那正是被删掉的降级犯的错。
  const p = k.provider;
  assert.throws(() => p.listSessions({}), /尚未接入/, '没接入时 listSessions 不许返回空列表');
  let asyncThrew = false;
  try { await p.submitTurn({ sessionId: 'x' }); } catch (e) { asyncThrew = /尚未接入/.test(e.message); }
  assert.equal(asyncThrew, true, '没接入时 submitTurn 必须抛错，不能静默成功');
});

await t('★ 真机缺陷钉住：端口上是个普通 Web 服务时，探测结果里不得出现上游产品名', async () => {
  // 这一条复现的是真机验收看到的那一屏：
  //   「该地址有响应，但不像是 DSH（HTTP 200，Server: …）」
  // 那句话的字面在 dsh-provider（审计豁免）里，靠**运行期字符串**穿到界面 ——
  // 所以只有"跑一遍再扫结果"才抓得到它。这里把上游名与它一起塞进响应头与响应体。
  await withStub((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', server: 'DSH-Edge' });
    res.end('<html><body>DSH 内部首页</body></html>');
  }, async (port) => {
    const p = await probeKernelConnection({ origin: 'http://127.0.0.1:' + port, timeoutMs: 3000 });
    assert.equal(p.state, 'not-kernel');
    assert.equal(p.reachable, true);
    const blob = JSON.stringify(p);
    assert.ok(!/dsh/i.test(blob), '探测结果整体里出现了上游产品名：' + blob);
    assert.ok(p.server && p.server.includes('内核'), '响应头的服务名也要抹：' + p.server);
    assert.ok(p.detail.includes('HTTP 200'), '抹名不许把有用的观测值一起抹掉：' + p.detail);
  });
});

await t('★ 被拒那条路上的上游名也要抹（响应头 + 上游原文两处一起来）', async () => {
  // 401：state 走 token-rejected 分支。这条路上有两处可能带上游名 ——
  //   ① 响应头 Server（**只有运行期抹名这一道防线管它**：它不是散文，产品层没法"自己拼"）；
  //   ② 上游回的错误体（我们控制不了的内容）。
  // 两处一起塞，确保任一处漏抹都会红。
  await withStub((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain', server: 'DSH-Edge' });
    res.end('dsh web authentication required');
  }, async (port) => {
    const p = await probeKernelConnection({ origin: 'http://127.0.0.1:' + port, token: 't-1', timeoutMs: 3000 });
    assert.equal(p.state, 'token-rejected');
    assert.equal(p.server, '内核-Edge', '响应头里的上游名只能靠运行期抹名挡 —— 这里漏了：' + p.server);
    assert.ok(!/dsh/i.test(JSON.stringify(p)), '上游原文原样外露了：' + JSON.stringify(p));
  });
});

/* ── 工作区档位推导（0.21.0 / 0.21.6 收敛）────────────────────────────
 *
 * 0.21.6 把这一层从"工作区三档授权"收敛成了**一个纯函数**：档位只由组织角色推导。
 * 删掉的那半（可见性 open/restricted、工作区级授权名单、管理员/建档人防自锁、
 * 并集放宽）连同整个工作区权限模块一起没了 —— 理由见 platform/workspace/
 * visibility.mjs 头注释与迁移 0023：上游 dsh 自己有一份工作区权限三档，
 * 平台这份是第二份真相，改了不生效。
 *
 * 这张表因此短了很多，但**分量一点没变**：它仍然是"这个人在这块地上能做什么"的判据，
 * `assertWorkspaceAccess` 直接调它。改 visibility.mjs 任何一行都要过这张表。
 */
await t('★ 档位推导：内置角色 → 三档（owner/admin=full、member=write、viewer=view、未知=none）', () => {
  assert.equal(levelFromRoles(['owner']), 'full');
  assert.equal(levelFromRoles(['admin']), 'full', 'admin 有 session:delete（权限矩阵显式授予）→ full');
  assert.equal(levelFromRoles(['member']), 'write');
  assert.equal(levelFromRoles(['viewer']), 'view');
  // ⚠️ 未知角色必须落到 none（fail-closed）。数据库里一个拼错的角色 key
  //    不能因此变成"人人有份" —— 与 permissions.mjs 的 can() 同一条纪律。
  assert.equal(levelFromRoles(['membre']), 'none', '拼错的角色 → none，不是 write');
  assert.equal(levelFromRoles([]), 'none');
  assert.equal(levelFromRoles(null), 'none');
  // 多角色取最高的那一档（并集语义）
  assert.equal(levelFromRoles(['viewer', 'member']), 'write');
  assert.equal(levelFromRoles(['viewer', 'nonsense']), 'view', '未知角色不污染结果，也不把已有的档抹掉');
  // 类型防御：混进对象要退化，不能变成 "[object Object]" 去撞某个角色 key
  assert.equal(levelFromRoles([{ key: 'admin' }]), 'none');
});

await t('★ 档位比较：够就是够；未知档与 undefined 一律不够（fail-closed）', () => {
  assert.equal(levelAtLeast('write', 'view'), true);
  assert.equal(levelAtLeast('view', 'write'), false);
  assert.equal(levelAtLeast('full', 'full'), true);
  assert.equal(levelAtLeast(undefined, 'view'), false);
  assert.equal(levelAtLeast('nonsense', 'view'), false, '未知档位按 0 算');
  assert.equal(levelAtLeast('view', undefined), true, '不需要任何档位时恒通过');
});

console.log('');
console.log('='.repeat(64));
if (fails) {
  console.log('失败明细：');
  for (const f of failures) {
    console.log('  · ' + f.name);
    console.log('    ' + String(f.error && f.error.message || f.error).split('\n')[0]);
  }
  console.log('');
}
if (skipped.length) {
  console.log('跳过的用例（**不计入通过**，请自行判断是否可接受）：');
  for (const s of skipped) {
    console.log('  ~ ' + s.name);
    console.log('      ' + s.reason);
  }
  console.log('');
}
console.log('用例 ' + total + ' 个｜失败 ' + fails + ' 个' + (skips ? '｜跳过 ' + skips + ' 个' : ''));
console.log('DONE fails=' + fails);
process.exitCode = fails ? 1 : 0;

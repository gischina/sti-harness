/**
 * 上游方法核实工具 —— 对着**运行中的 DSH** 逐条验证 compat 映射是否成立。
 *
 * 为什么需要它（docs/history/assessment-0.6.0.md P0-A）：
 *   `compat/*.mjs` 里的 `verified` 标记原先来自**对基线实现源码的静态核查**，
 *   不是对运行中 DSH 的动态验证。静态核查会漏掉两类错误：
 *     ① 方法名猜错（如把 `session/prompt` 猜成 `session/submit`）
 *     ② 参数形状猜错（真实 DSH 要求 `{request:{…}}` 信封，不是裸参数）
 *   只有真的打过去，才能知道。
 *
 * 本工具做四件事：
 *   1. **存在性探测**：对每个契约方法列出若干候选上游方法名，逐个打过去，
 *      用响应区分「不存在」（unknown-method 类错误）与「存在但参数不对」。
 *   2. **端到端跑一遍会话生命周期**：建会话 → 改名 → 选模型 → 发回合 → 取消 → 分叉，
 *      记录每一步的真实响应。这是"对话能不能用"的唯一证据。
 *   3. **B 档探针（阶段 3）**：探测通用文件的"只读保存路径"通路的写入通道
 *      （`fileUploads/upload`）与只读侧候选。**只探不接线** —— 决定是否做 B 档看这里的实测结果。
 *      ⚠️ 会**真的往上游存一个 1 字节文件**（名字带 `sti-verify-` 前缀），`--read-only` 时整段跳过。
 *   4. **输出可直接抄进 compat 的结论**：每个契约方法 → 确认的上游方法名 + args 构造。
 *
 * 用法：
 *   node tools/verify-upstream.mjs                 # 完整核实（会真实建一个会话并清理 + 存一个 1 字节探测文件）
 *   node tools/verify-upstream.mjs --read-only     # 只探不写（不建会话，也不上传探测文件）
 *   node tools/verify-upstream.mjs --json          # 机器可读输出
 *   node tools/verify-upstream.mjs --keep          # 保留测试会话（排障用）
 *
 * 目标地址与令牌解析顺序（与 app/config.mjs 一致，再补一个开发期回退）：
 *   STI_DSH_ORIGIN / STI_DSH_TOKEN 环境变量
 *   → data/config.json 的 dshOrigin / dshToken
 *   → 开发回退：同级工程的 dsh-config.json（仅当显式传 --dev-config 时启用）
 *
 * 末行输出 `DONE fails=N`。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import '../app/util/quiet-warnings.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDshClient } from '../app/kernel/dsh-provider/client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const READ_ONLY = has('read-only');
const AS_JSON = has('json');
const KEEP = has('keep');
const DEV_CONFIG = has('dev-config');

function line(s = '') { if (!AS_JSON) console.log(s); }

// ── 目标解析 ─────────────────────────────────────────────────────────

function resolveTarget() {
  const envOrigin = process.env.STI_DSH_ORIGIN || process.env.DSH_ORIGIN || '';
  const envToken = process.env.STI_DSH_TOKEN || process.env.DSH_TOKEN || '';
  if (envOrigin) return { origin: envOrigin, token: envToken, source: 'env' };

  const cfgFile = path.join(ROOT, 'data', 'config.json');
  try {
    const j = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (j.dshOrigin) return { origin: String(j.dshOrigin), token: String(j.dshToken || ''), source: 'data/config.json' };
  } catch { /* 没配就是没配 */ }

  if (DEV_CONFIG) {
    // 开发回退：复用同级另一个工程的 DSH 配置（同权利人早期作品）。
    // ⚠️ 不写死工程名 —— 用 STI_DEV_CONFIG 显式指定，未设时取同级 dsh-config.json。
    const dev = process.env.STI_DEV_CONFIG || path.join(ROOT, '..', 'dsh-config.json');
    try {
      const j = JSON.parse(fs.readFileSync(dev, 'utf8'));
      if (j.origin) return { origin: String(j.origin), token: String(j.token || ''), source: path.basename(dev) + '（开发回退）' };
    } catch { /* ignore */ }
  }
  return null;
}

// ── RPC 探测 ─────────────────────────────────────────────────────────

/**
 * 打一次上游 RPC，返回结构化结果（不抛异常，便于分类）。
 * 与 client.remoteCall 不同：这里保留错误码，用来区分「方法不存在」与「参数不对」。
 */
async function rpc(client, method, args) {
  const st = client.state;
  const body = {
    type: 'client-request',
    rpcId: 'verify-' + crypto.randomUUID().slice(0, 8),
    method,
    payload: { args: args || {} },
  };
  let r;
  try {
    r = await fetch(st.origin + '/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(st.cookie ? { cookie: st.cookie } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { transport: 'error', message: e.message };
  }
  const txt = await r.text().catch(() => '');
  let j = null;
  try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
  const result = j && j.result;
  return {
    httpStatus: r.status,
    envelope: j ? j.type : null,
    ok: !!(result && result.ok),
    value: result ? result.value ?? null : null,
    errorCode: result && result.error ? (result.error.code || '') : '',
    errorMessage: result && result.error ? (result.error.message || '') : '',
    raw: txt.slice(0, 400),
  };
}

/** 把响应归类：不存在 / 存在但参数不对 / 成功 */
function classify(res) {
  if (res.transport === 'error') return 'unreachable';
  if (res.httpStatus === 401) return 'unauthorized';
  if (res.httpStatus === 404) return 'not-found';
  if (res.ok) return 'ok';
  const code = String(res.errorCode || '').toLowerCase();
  const msg = String(res.errorMessage || '').toLowerCase();
  if (/unknown|not.?found|no.?such|unregistered|unmapped|no.?handler/.test(code + ' ' + msg)) return 'not-found';
  if (/invalid|require|missing|need|schema|unexpected|参数/.test(code + ' ' + msg)) return 'exists-bad-args';
  return 'error';
}

/** 对同一契约方法的一组候选上游方法名逐个探测，返回第一个"存在"的 */
async function probeCandidates(client, candidates) {
  const tried = [];
  for (const c of candidates) {
    const res = await rpc(client, c.method, c.args);
    const kind = classify(res);
    tried.push({ method: c.method, kind, errorCode: res.errorCode, errorMessage: res.errorMessage });
    if (kind === 'ok' || kind === 'exists-bad-args') {
      return { found: c.method, kind, res, tried };
    }
  }
  return { found: null, kind: 'not-found', res: null, tried };
}

// ── 契约方法 → 候选上游方法名 ────────────────────────────────────────
// 候选来源：基线实现前端分片的 API.MAP（权威）+ compat 里的猜测（待证伪）

const CONTRACT_PROBES = [
  // 只读，不需要会话
  { contract: 'listSessions', readOnly: true, candidates: [
    { method: 'session/list', args: { _request: {} } },
  ] },
  { contract: 'modelCatalog', readOnly: true, candidates: [
    { method: 'session/modelCatalog', args: {} },
    { method: 'llm/listConfigurableProviders', args: {} },
  ] },
  { contract: 'listMcpServers', readOnly: true, candidates: [
    { method: 'pluginInventory/list', args: {} },
    { method: 'mcp/list', args: {} },
  ] },
  { contract: 'agentPresets(list)', readOnly: true, candidates: [
    { method: 'agentPresets/list', args: {} },
  ] },

  // 会话生命周期（写）
  { contract: 'createSession', candidates: [
    { method: 'session/create', args: { request: { cwd: null, sessionId: null } } },   // 占位，主流程会重填
  ] },
];

// ── 主流程 ───────────────────────────────────────────────────────────

line('');
line('STI HARNESS 上游方法核实');
line('='.repeat(70));

const target = resolveTarget();
if (!target) {
  line('');
  line('  未找到上游地址。请任选其一：');
  line('    · 设环境变量 STI_DSH_ORIGIN=http://127.0.0.1:3080 与 STI_DSH_TOKEN=…');
  line('    · 在 data/config.json 里写 dshOrigin / dshToken');
  line('    · 开发期加 --dev-config 复用同级工程的 dsh-config.json');
  line('');
  line('DONE fails=1 skipped=1');
  process.exitCode = 1;
  process.exit();
}

line('');
line('  目标    : ' + target.origin);
line('  令牌来源: ' + target.source + (target.token ? '（已提供）' : '（无令牌）'));

const client = createDshClient({ origin: target.origin, token: target.token });

const auth = await client.ensureAuth(true);
if (!auth.ok) {
  line('');
  line('  ✗ 换取会话 cookie 失败：' + (auth.error || auth.mode));
  line('DONE fails=1');
  process.exitCode = 1;
  process.exit();
}

const status = await client.status();
line('  上游状态: ' + status.state + '｜' + status.detail);
line('  上游版本: ' + (status.version || '—') + (status.rev ? '（rev ' + status.rev + '）' : ''));
if (status.state !== 'ok') {
  line('');
  line('  ✗ DSH 未处于可用状态，无法核实。');
  line('DONE fails=1');
  process.exitCode = 1;
  process.exit();
}

// ── 阶段 1：只读方法存在性探测 ───────────────────────────────────────

const report = { target: { origin: target.origin, version: status.version, rev: status.rev }, readOnly: [], lifecycle: [], bTier: [] };

// 阶段 2 建出来的会话 id；阶段 3（B 档探针）要用。READ_ONLY 或建会话失败时为 null。
let sid = null;

line('');
line('阶段 1 · 只读方法探测');
line('-'.repeat(70));
line('  ' + '契约方法'.padEnd(22) + '候选上游方法'.padEnd(34) + '判定');
line('  ' + '-'.repeat(66));

for (const spec of CONTRACT_PROBES) {
  const r = await probeCandidates(client, spec.candidates);
  const last = r.tried[r.tried.length - 1];
  const verdict = r.kind === 'ok' ? '✓ 可用'
    : r.kind === 'exists-bad-args' ? '△ 存在（参数待补）'
      : '✗ 不存在';
  const shown = r.found || (last ? last.method : '—');
  line('  ' + spec.contract.padEnd(22) + shown.padEnd(34) + verdict);
  if (r.kind === 'exists-bad-args') {
    line('  ' + ''.padEnd(22) + '└─ 上游说：' + (last.errorCode || '') + ' ' + (last.errorMessage || '').slice(0, 80));
  }
  report.readOnly.push({
    contract: spec.contract, found: r.found, kind: r.kind,
    tried: r.tried, value: r.res ? r.res.value : null,
  });
}

// ── 阶段 2：会话生命周期端到端 ───────────────────────────────────────

if (READ_ONLY) {
  line('');
  line('  （--read-only：跳过会话生命周期探测）');
} else {
  line('');
  line('阶段 2 · 会话生命周期端到端（真实建一个会话，结束前清理）');
  line('-'.repeat(70));

  const cwd = path.join(os.tmpdir(), 'sti-verify-' + Date.now());
  try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* ignore */ }
  const sessionId = 'sti-verify-' + crypto.randomUUID().slice(0, 8);

  const step = async (name, method, args, note = '') => {
    const res = await rpc(client, method, args);
    const kind = classify(res);
    const mark = kind === 'ok' ? '✓' : kind === 'exists-bad-args' ? '△' : '✗';
    line('  ' + mark + ' ' + name.padEnd(18) + method.padEnd(26) + (kind === 'ok' ? '' : (res.errorCode || kind) + ' ' + String(res.errorMessage || '').slice(0, 60)));
    if (note) line('    ' + note);
    report.lifecycle.push({ name, method, args, kind, errorCode: res.errorCode, errorMessage: res.errorMessage, value: res.value });
    return { kind, res };
  };

  // 2.1 建会话
  const created = await step('建会话', 'session/create',
    { request: { cwd, sessionId } });
  sid = (created.res && created.res.value && (created.res.value.sessionId || created.res.value.id)) || sessionId;
  line('    会话 id：' + sid + (created.kind === 'ok' ? '' : '（建会话未成功，后续步骤用客户端预置 id 试）'));

  // 2.2 改名
  await step('改名', 'session/rename', { request: { sessionId: sid, title: 'sti 核实用会话' } });

  // 2.3 选模型（先拿目录）
  const cat = await rpc(client, 'session/modelCatalog', {});
  const cur = cat.ok && cat.value && cat.value.default ? cat.value.default : null;
  if (cur && cur.provider && cur.model) {
    await step('选模型', 'session/selectModel',
      { request: { sessionId: sid, provider: cur.provider, model: cur.model } },
      '用目录里的当前默认：' + cur.provider + '/' + cur.model);
  } else {
    line('  − 选模型          跳过（模型目录里没有 default，无法确定该选哪个）');
  }

  // 2.4 发一轮（这是"对话能不能用"的核心证据）
  // ⚠️ 实测（0.2.0-rc.2）：`content` 必须是**内容块数组**，不是字符串。
  //    传字符串会得到 `gateway/input-invalid  wire field "request" failed boundary validation`。
  const promptStep = await step('发一轮', 'session/prompt', {
    request: {
      requestId: 'sti-verify-' + crypto.randomUUID().slice(0, 8),
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: '回复两个字：收到' }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });

  // 2.5 技能清单（需要会话）
  await step('技能清单', 'skills/list', { request: { sessionId: sid } });

  // 2.6 子代理清单
  await step('子代理清单', 'subagents/list', { parentSessionId: sid });

  // 2.7 取消会话
  await step('取消会话', 'session/cancel', { request: { sessionId: sid } });

  // 2.8 分叉（在 0 号位分叉，得到一个空副本）
  if (created.kind === 'ok' || promptStep.kind === 'ok') {
    await step('分叉', 'session/fork', { request: { sessionId: sid, atSeq: 0 } });
  }

  // 2.9 探测若干个"compat 里猜过但不确定存在"的方法 + 尚未定位的能力
  line('');
  line('  附加存在性探测（含 compat 里曾猜测的名字）：');
  const guesses = [
    // compat 里猜过的（预期多半不存在）
    'session/submit', 'session/interrupt', 'session/dispose', 'session/history',
    'session/setModel', 'agents/skills', 'approval/request', 'approval/respond', 'deliverables/presented',
    // 中断回合的正确名字候选
    'session/stop', 'session/abort', 'session/turnCancel', 'session/interruptTurn', 'session/updateQueue',
    // 子代理
    'subagents/list', 'subagents/children', 'subagents/snapshot', 'agent/children',
    // 工具清单
    'tools/list', 'capabilities/tools', 'pluginInventory/tools', 'tool/list',
    // 待审批
    'approvals/list', 'approval/pending', 'approval/list',
    // 附件 / 产物
    'session/attachment', 'deliverables/list', 'artifacts/list',
    // 事件历史
    'session/follow', 'session/page', 'session/control',
  ];
  for (const m of guesses) {
    const res = await rpc(client, m, {});
    const kind = classify(res);
    const mark = kind === 'not-found' ? '✗ 不存在' : kind === 'exists-bad-args' ? '△ 存在' : kind === 'ok' ? '✓ 可用' : '? ' + kind;
    line('    ' + m.padEnd(26) + mark + (kind === 'exists-bad-args' ? '（' + (res.errorCode || '') + '：' + String(res.errorMessage || '').slice(0, 50) + '）' : ''));
    report.lifecycle.push({ name: 'probe:' + m, method: m, kind, errorCode: res.errorCode });
  }

  // 清理
  if (!KEEP) {
    line('');
    line('  清理：');
    await step('删会话(dispose)', 'session/dispose', { request: { sessionId: sid } });
    await step('归档会话', 'workspace/archiveSession', { request: { sessionId: sid } });
    line('    （若两个都不可用，测试会话会留在 DSH 里；用 --keep 可显式保留）');
  } else {
    line('');
    line('  （--keep：保留测试会话 ' + sid + '）');
  }
}

// ── 阶段 3：B 档探针 —— 通用文件的"只读保存路径"通路 ─────────────────
//
// 背景（docs/architecture.md §7.7）：上游对**图片**与**通用文件**是两条根本不同的通路。
//   · 图片     → 字节随 `submitTurn` 的 content 内容块**真正到达模型**（平台 0.10.0 已接通）；
//   · 通用文件 → 上游把字节**原样存盘**，并给模型**一行只读路径**（模型用文件工具读）。
//     写入通道是 typert remote 方法 `fileUploads/upload`，落盘在 `<DSH_HOME>/attachments/v1`。
//
// 这一阶段**只探测、不接线**：决定"要不要做 B 档"要看这里的实测结果。
//
// ⚠️ 3.2 会**真的往上存储存一个 1 字节文件**（名字带 `sti-verify-` 前缀）；
//    `--read-only` 时整段跳过。**不做自动清理** —— "上游有没有删除接口"本身就是待测项，
//    宁可留一个可辨认的小垃圾，也不要"假装清理成功"。

const BTIER_NAME = 'sti-verify-1byte.txt';
const BTIER_B64 = Buffer.from('g').toString('base64');   // 1 字节：空文件可能被准入规则直接拒掉，测不出通道

line('');
line('阶段 3 · B 档探针：通用文件的"只读保存路径"通路');
line('-'.repeat(70));

// 3.1 只读候选（总是探测）：能不能"读回 / 定位"一个已存文件
line('  3.1 只读候选（探测"能不能读回 / 定位已存文件"）');
const BTIER_READ_CANDIDATES = [
  // 名字来源：官方包族 dsh-attachment-local 的 file-store 暴露了 fileLeafName / storedFilePath / saveFileVerbatim
  'fileUploads/list', 'fileUploads/read', 'fileUploads/stat', 'fileUploads/resolvePath',
  'attachments/list', 'attachments/read', 'attachment/filePath', 'attachment/hostPath', 'attachments/fileHostPath',
];
for (const m of BTIER_READ_CANDIDATES) {
  const res = await rpc(client, m, {});
  const kind = classify(res);
  const mark = kind === 'not-found' ? '✗ 不存在'
    : kind === 'ok' ? '✓ 可用'
      : kind === 'exists-bad-args' ? '△ 存在'
        : '? ' + kind;
  line('    ' + m.padEnd(26) + mark
    + (kind === 'exists-bad-args' ? '（' + (res.errorCode || '') + '：' + String(res.errorMessage || '').slice(0, 46) + '）' : ''));
  report.bTier.push({ phase: '3.1-read', method: m, kind, errorCode: res.errorCode, errorMessage: res.errorMessage });
}

// 3.2 写入候选（--read-only 时跳过）
if (READ_ONLY) {
  line('  3.2 写入候选：跳过（--read-only；探测会真的往上游存一个文件）');
} else {
  line('  3.2 写入候选（会把 1 字节文件 ' + BTIER_NAME + ' 真的存到上游）');
  // typert remote 的签名是**位置参数** `upload(agentId, request)`，但"怎么塞进 payload.args"有几种可能 ——
  // 逐个试，靠响应区分「方法不存在」与「参数形状不对」。
  const probeSid = sid || 'sti-verify-probe';
  const breq = { data: BTIER_B64, name: BTIER_NAME };
  const SHAPES = [
    ['对象 {agentId, request}', { agentId: probeSid, request: breq }],
    ['对象 {agentId, data, name}', { agentId: probeSid, data: BTIER_B64, name: BTIER_NAME }],
    ['位置数组 [agentId, request]', [probeSid, breq]],
    ['裸 request', breq],
  ];
  const WRITE_METHODS = ['fileUploads/upload', 'fileUploads/create', 'attachments/upload', 'session/uploadFileBinary'];
  for (const m of WRITE_METHODS) {
    let best = null;
    for (const [label, args] of SHAPES) {
      const res = await rpc(client, m, args);
      const kind = classify(res);
      report.bTier.push({
        phase: '3.2-write', method: m, shape: label, kind,
        errorCode: res.errorCode, errorMessage: res.errorMessage, value: res.value,
      });
      if (kind === 'ok' || kind === 'exists-bad-args') { best = { label, kind, res }; break; }
    }
    if (!best) {
      line('    ' + m.padEnd(26) + '✗ 不存在（四种参数形状都不认）');
      continue;
    }
    line('    ' + m.padEnd(26) + (best.kind === 'ok' ? '✓ 可用' : '△ 存在（参数待补）') + '（形状：' + best.label + '）');
    if (best.res.value) {
      line('      └─ 返回：' + JSON.stringify(best.res.value).slice(0, 200));
      line('      └─ ⚠️ B 档能否成立只看一件事：返回里**有没有一个模型能用的只读路径**（file / storedPath / hostPath…）。');
    } else if (best.res.errorMessage) {
      line('      └─ 上游说：' + (best.res.errorCode || '') + ' ' + String(best.res.errorMessage).slice(0, 90));
    }
  }
  line('    （探测文件：' + BTIER_NAME + '，1 字节 —— 上游若没有删除接口，请人工清理）');
}

// ── 汇总 ─────────────────────────────────────────────────────────────

const okCount = report.readOnly.filter((r) => r.kind === 'ok').length
  + report.lifecycle.filter((r) => r.kind === 'ok').length;
const failCount = report.readOnly.filter((r) => r.kind === 'not-found').length
  + report.lifecycle.filter((r) => r.kind === 'not-found').length;

const bOk = report.bTier.filter((r) => r.kind === 'ok').length;
const bExists = report.bTier.filter((r) => r.kind === 'exists-bad-args').length;
const bMissing = report.bTier.filter((r) => r.kind === 'not-found').length;

line('');
line('='.repeat(70));
line('汇总：可用 ' + okCount + ' 项｜判定不存在 ' + failCount + ' 项');
line('B 档探针：可用 ' + bOk + ' 项｜存在（参数待补）' + bExists + ' 项｜不存在 ' + bMissing + ' 项');
if (bOk === 0 && bExists === 0) {
  line('  → 本轮**没有**找到 `fileUploads/upload` 或任何只读路径方法：B 档暂不具备条件，');
  line('    维持现状（通用文件只登记 + 如实标注"不提交"），**不猜着接**。');
} else {
  line('  → 找到了候选：先确认返回里的**只读路径**能否被模型的文件工具读到，再决定是否接 B 档。');
  line('    （"方法存在"≠"模型读得到路径" —— 这两件事必须分别实证。）');
}
line('结论请抄进 docs/architecture.md §7.7 与 docs/roadmap.md 的 B 档待办条目。');

line('');
line('DONE fails=0');

if (AS_JSON) console.log(JSON.stringify(report, null, 2));

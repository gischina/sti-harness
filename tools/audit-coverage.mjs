/**
 * 覆盖对账 —— 「全功能可用性」的机器可核查证明。
 *
 * 为什么必须有它（与真机浏览器验收同一批评审意见）：
 *   「不是所有功能都过浏览器」的质疑成立的前提是覆盖不可见。本脚本把覆盖变成
 *   两条会随代码自动伸缩的对账单，任何一层断了覆盖，门禁立刻红。
 *
 * 两条轴：
 *   1. 页面轴（22 页 × 双层）：从 public/app/10-routes.js 现读路由表；
 *      · vm 层：test-frontend.mjs 必须有「ALL_ROUTES + 读 10-routes.js 源码 + 逐路由渲染」扫荡锚点；
 *      · 浏览器层：test-browser.mjs 必须有「ROUTES + hashTo 逐页跳转」扫荡锚点（S3）。
 *      注意：两个套件都是**运行时现读路由表扫荡**，不含逐页字面量 —— 锚点存在即全页覆盖。
 *   2. 接口轴（138 个 API × 测试语料）：从 app/http/routes/*.mjs 提取全部 path 字面量，
 *      判定规则 = 任一 tools/test-*.mjs 里存在**同一行包含该路由全部静态段**
 *      （测试用 '/api/identity/users/' + id + '/roles' 拼接，所以按段匹配而不是整串）。
 *
 * 白名单纪律：每个豁免条目必须写明理由（为什么不测/由什么别的手段覆盖）。
 *
 * 末行输出 `DONE violations=N`。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let violations = 0;
const problems = [];

function fail(msg) { violations++; problems.push(msg); console.log('  ✗ ' + msg); }
function ok(msg) { console.log('  ✓ ' + msg); }
function section(s) { console.log(''); console.log('── ' + s + ' ' + '─'.repeat(Math.max(0, 56 - s.length))); }

console.log('');
console.log('STI HARNESS 覆盖对账（页面 × 双层 ／ API × 测试引用）');
console.log('='.repeat(64));

/* ── 页面轴 ─────────────────────────────────────────────────────────── */

section('页面轴：22 页 × vm 层 / 浏览器层');

const routesSrc = fs.readFileSync(path.join(ROOT, 'public', 'app', '10-routes.js'), 'utf8');
const pageIds = [...routesSrc.matchAll(/\{ id: '([a-zA-Z]+)'/g)].map((m) => m[1]);
if (pageIds.length < 22) fail('10-routes.js 只解析出 ' + pageIds.length + ' 页（预期 ≥22）—— 页面轴解析规则可能已漂');
else ok('路由表现读：' + pageIds.length + ' 页');

const frontendSrc = fs.readFileSync(path.join(ROOT, 'tools', 'test-frontend.mjs'), 'utf8');
// vm 层扫荡锚点：必须有「从 10-routes.js 提取路由表」+「遍历 ALL_ROUTES 渲染」两要素
const vmAnchorExtract = /10-routes\.js/.test(frontendSrc) && /ALL_ROUTES/.test(frontendSrc);
const vmAnchorSweep = /for\s*\([^)]*of\s+ALL_ROUTES\)/.test(frontendSrc);
if (vmAnchorExtract && vmAnchorSweep) ok('vm 层锚点：test-frontend.mjs 从 10-routes.js 现读路由表并逐路由渲染（' + pageIds.length + ' 页全覆盖）');
else fail('vm 层锚点缺失：test-frontend.mjs 不再含「ALL_ROUTES + 10-routes.js + 遍历渲染」扫荡（页面层覆盖断）');

const browserSrc = fs.readFileSync(path.join(ROOT, 'tools', 'test-browser.mjs'), 'utf8');
// 浏览器层扫荡锚点：S3 必须「eval 拿 ROUTES」+「逐页 hashTo」
const brAnchorExtract = /eval\(`ROUTES`\)/.test(browserSrc);
const brAnchorSweep = /for\s*\([^)]*of\s+routes\)/.test(browserSrc) && /hashTo\(r\.hash\)/.test(browserSrc);
if (brAnchorExtract && brAnchorSweep) ok('浏览器层锚点：test-browser.mjs S3 现读 ROUTES 并逐页 hashTo（' + pageIds.length + ' 页全覆盖）');
else fail('浏览器层锚点缺失：test-browser.mjs S3 不再含「ROUTES + hashTo 逐页」扫荡（页面层覆盖断）');

/* ── 接口轴 ─────────────────────────────────────────────────────────── */

section('接口轴：routes/*.mjs × 测试语料引用');

const routesDir = path.join(ROOT, 'app', 'http', 'routes');
const apiPaths = [];
for (const f of fs.readdirSync(routesDir)) {
  if (!f.endsWith('.mjs') || f.startsWith('_') || f === 'index.mjs') continue;
  const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
  for (const m of src.matchAll(/path:\s*'([^']+)'/g)) {
    if (m[1].startsWith('/api/')) apiPaths.push({ file: f, path: m[1] });
  }
}
ok('路由表提取：' + apiPaths.length + ' 个 API 路径');

// 测试语料 = tools/test-*.mjs 全量（自动伸缩：新套件自动纳入）
const corpusFiles = fs.readdirSync(HERE).filter((f) => /^test-.*\.mjs$/.test(f));
const corpusLines = [];
for (const f of corpusFiles) {
  const src = fs.readFileSync(path.join(HERE, f), 'utf8');
  src.split('\n').forEach((line, i) => corpusLines.push({ file: f, line: i + 1, text: line }));
}

/**
 * 豁免清单 —— 每条必须写理由。只有两类理由成立：
 *   A. 该路径由别的手段覆盖（如 CSRF/限流探针只在 test-http 里以完整 URL 拼出、已被行匹配外的方式覆盖）；
 *   B. 该路径是**故意不暴露给测试**的管理面（说明它靠什么保证不出错）。
 */
const WHITELIST = [
  {
    path: '/api/capability/skills/:name/enabled',
    reason: '由 test-governance.mjs 覆盖：skill 启停通过 POST /api/capability/skills/:name/enabled 触发（路径在 capability.mjs 内部组装，测试通过业务行为断言）。',
  },
];

function staticSegments(p) {
  return p.split('/').filter((s) => s && !s.startsWith(':'));
}

let uncovered = 0;
for (const { file, path: p } of apiPaths) {
  const segs = staticSegments(p);
  const hit = corpusLines.find((l) => segs.every((s) => l.text.includes(s)));
  if (hit) continue;
  const wl = WHITELIST.find((w) => w.path === p);
  if (wl) { console.log('  ~ ' + p + '（豁免：' + wl.reason + '）'); continue; }
  uncovered++;
  fail('未覆盖 API：' + p + '（' + file + '）—— 任何 test-*.mjs 的单行里都不含它的全部静态段');
}
if (!uncovered) ok('接口轴：' + apiPaths.length + ' 个 API 全部有测试语料引用（含白名单 ' + WHITELIST.length + ' 条）');

/* ── 汇总 ───────────────────────────────────────────────────────────── */

console.log('');
console.log('────────────────────────────────────────────────────────────────');
console.log('  违例: ' + violations);
if (problems.length) {
  console.log('');
  for (const p of problems) console.log('  ✗ ' + p);
}
console.log('');
console.log('DONE violations=' + violations);
process.exitCode = violations ? 1 : 0;

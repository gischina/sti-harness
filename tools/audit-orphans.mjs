/**
 * 模块孤儿与断链审计 —— 回答两个「平时看不出来」的问题。
 *
 *  ① **孤儿模块**：`app/` 下有没有**没有任何入口能到达**的 .mjs？
 *     静态 `import` 断掉之后，文件不会报错、不会被打包扫描拦下（它在白名单目录里），
 *     只会一直躺在那里。它是"死代码"里最难自己被发现的一类 —— 死**导出**至少还能
 *     扫到没有引用（0.11.1 §A1 做的就是这个），死**模块**连扫描都扫不到，
 *     因为它自己就是那个"没被引用的东西"。
 *
 *  ② **断链 import**：相对 import 指向的文件不存在。
 *     Node 的 ESM 是在**加载时**解析的，所以这条通常会在测试里炸；
 *     但工具脚本（`tools/*.mjs`）与很少被走到的分支不会 ——
 *     而那正是"发版时才发现上一版留了个错路径"的来源。
 *
 *  ③ **前端分片 ↔ `index.html` 双向对账**（这一节是顺手补的，但价值不低于前两节）：
 *     前端是**经典脚本 + 零构建**，分片靠 `index.html` 里的 `<script>` **顺序**加载。
 *     如果新加了一片却没写进 `index.html`，后果是**运行时函数未定义**，
 *     而 `test-frontend` 的分片清单是**现读 `index.html`** 的 —— 它不会发现少了谁。
 *     所以"磁盘上有、页面里没有"与"页面里有、磁盘上没有"都必须在这里被抓住，
 *     顺带核对**加载顺序与文件名的数字前缀顺序一致**（顺序错 = 后一片用了前一片还没定义的东西）。
 *
 * ## 为什么白名单要带"根据"（而不是写死一串文件名）
 * `compat/` 下的垫片是按上游版本命名的，加载点是一句**运行时拼接**：
 * `await import('./' + want + '.mjs')` —— 静态扫描看不见这条边。
 * 所以必须有一份白名单；但**一份不会过期的白名单就是一份假白名单**：
 * 哪天有人把那句拼接改成硬编码，白名单里的条目就成了"掩盖孤儿"的挡箭牌。
 * 因此每条白名单都必须声明 `loadedBy` + `evidence`，本审计会去 `loadedBy` 里
 * **核对 evidence 是否还在**（先剥注释再核对）—— 根据没了，白名单条目自己就变成违规。
 *
 * 末行：`DONE violations=N`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(ROOT, p).split('\\').join('/');

const violations = [];
const bad = (file, kind, detail) => violations.push({ file, kind, detail });

/**
 * 剥注释 —— 必须做，否则两边的结论都会错，而且是**方向相反的两个错**：
 *   · 注释里的 `import 'x'` 会造出一条**假边** → 真孤儿被读成"可达"（漏报）；
 *   · 注释里的路径会被当成**真断链** → 无中生有一条违规（误报）。
 * 本仓库里两条都真实发生过（`schedule/tasks.mjs` 与 `bench-concurrency.mjs`
 * 各有一处写在注释里的示例路径）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // 行注释（避开 `://` 这种协议前缀）
}

// ── 收集模块 ───────────────────────────────────────────────
function collect(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (['.mjs', '.js', '.cjs'].includes(extname(e.name))) out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const modules = collect('app');
const moduleSet = new Set(modules);
// ⚠️ **`tools/` 的 import 边也必须追**：入口清单里包含 tools 下的全部脚本，
// 而有的 app 模块**只**被工具用到（例如 `app/util/quiet-warnings.mjs` 被多处工具引用）。
// 不追 tools 的边，就会把"只有工具在用"的正常模块报成孤儿。
const allScanned = [...modules, ...collect('tools')];

// ── 静态边 ─────────────────────────────────────────────────
// **必须认全所有 import 形态** —— 漏一种的后果不是"少一条边"，而是把一个正常模块
// 报成孤儿（假红），而假红会让人开始不信这个审计。本审计第一次跑就踩了这一条：
// `app/main.mjs` 用的是无 `from` 的副作用 import（`import './util/quiet-warnings.mjs';`），
// 于是它被报成孤儿。五种形态逐一列出，各自可独立核对：
const SPEC_RES = [
  /\bfrom\s*(['"])([^'"]+)\1/g,                                        // import … from '…' / export … from '…'
  /\bimport\s*\(\s*(['"])([^'"]+)\1/g,                                 // await import('…')
  /\brequire\s*\(\s*(['"])([^'"]+)\1/g,                                // require('…')
  /\bimport\s+(['"])([^'"]+)\1/g,                                      // 副作用 import '…'（没有 from）
  // worker 入口就是用它加载的；不认它同样会把一个完全正常的模块报成孤儿。
  /\bnew\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g,
];
const KNOWN_EXT = ['.mjs', '.js', '.cjs', '.json'];

/** 把相对 specifier 解析成磁盘上的真实文件；解析不到返回 null。 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;                 // node: 内置 / 裸模块，不管
  const t = resolve(dirname(fromFile), spec);
  const cands = [t, t + '.mjs', t + '.js', t + '.cjs', join(t, 'index.mjs'), join(t, 'index.js')];
  return cands.find((c) => { try { return statSync(c).isFile(); } catch { return false; } }) || null;
}

const edges = new Map();
const fileSrc = new Map();
for (const f of allScanned) {
  const raw = readFileSync(f, 'utf8');
  const src = stripComments(raw);
  fileSrc.set(f, src);
  const outs = new Set();
  for (const re of SPEC_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[2];
      if (!spec || !spec.startsWith('.')) continue;
      const hit = resolveSpec(f, spec);
      if (hit && moduleSet.has(hit)) outs.add(hit);
      // 断链判定：只认**带明确扩展名**的 specifier。
      // 本仓库所有相对 import 都写全了扩展名（已核：0 例外），所以这条既不漏也不误伤；
      // 而运行时拼接出来的 `'./' + name + '.mjs'` 这类不是字面量，本来也匹配不到。
      else if (!hit && KNOWN_EXT.includes(extname(spec))) {
        bad(rel(f), '断链', '相对 import 指向不存在的文件：' + spec);
      }
    }
  }
  edges.set(f, outs);
}

// ── 可达性 ─────────────────────────────────────────────────
// 入口：app/main.mjs（服务本体）+ tools/ 下的全部脚本（都能被命令行直接跑）。
const entries = [join(ROOT, 'app', 'main.mjs'), ...collect('tools')];
const seen = new Set();
const stack = entries.filter((f) => moduleSet.has(f) || f === join(ROOT, 'app', 'main.mjs'));
while (stack.length) {
  const cur = stack.pop();
  if (seen.has(cur)) continue;
  seen.add(cur);
  for (const n of (edges.get(cur) || [])) stack.push(n);
}

/**
 * 动态加载白名单 —— `match` 命中且 `evidence` 在 `loadedBy` 里**确实存在**时才豁免。
 * evidence 不在了 → 这条白名单本身记违规（见文件头「为什么白名单要带根据」）。
 */
const DYNAMIC_ALLOW = [
  {
    match: (r) => /^app\/kernel\/dsh-provider\/compat\/.+\.mjs$/.test(r) && basename(r) !== 'index.mjs',
    loadedBy: 'app/kernel/dsh-provider/compat/index.mjs',
    evidence: "await import('./' + want + '.mjs')",
    why: '垫片按上游版本号命名，文件名只在运行时拼出来，静态看不见这条边。',
  },
];

for (const r of DYNAMIC_ALLOW) {
  const holder = join(ROOT, r.loadedBy);
  const src = fileSrc.get(holder) ?? (() => { try { return stripComments(readFileSync(holder, 'utf8')); } catch { return ''; } })();
  if (!src.includes(r.evidence)) {
    bad(r.loadedBy, '白名单过期',
      '这条动态加载白名单的根据没了（找不到 `' + r.evidence + '`）。'
      + '白名单条目自己过期 = 它开始掩盖孤儿，请重新判断这条豁免还要不要。');
  }
}

for (const f of modules) {
  if (seen.has(f)) continue;
  const r = rel(f);
  const allow = DYNAMIC_ALLOW.find((a) => a.match(r));
  if (allow) continue;   // 已被"有根据的白名单"豁免
  bad(r, '孤儿模块',
    '从任何入口（app/main.mjs 与 tools/*）都到达不了它。'
    + '要么把它接回去，要么删掉 —— 留着不会报错，只会让人以为它在生效。');
}

// ── 前端分片 ↔ index.html 双向对账 ─────────────────────────
const htmlPath = join(ROOT, 'public', 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const loaded = [...html.matchAll(/<script[^>]*src="\.\/([^"]+\.js)"/g)].map((m) => m[1]);
const loadedSlices = loaded.filter((s) => s.startsWith('app/'));

const onDisk = readdirSync(join(ROOT, 'public', 'app'))
  .filter((n) => n.endsWith('.js'))
  .map((n) => 'app/' + n);

for (const f of onDisk) {
  if (!loaded.includes(f)) {
    bad('public/index.html', '分片未加载',
      '磁盘上有 public/' + f + '，但 index.html 里没有它 —— 这片代码在浏览器里**永远不会执行**'
      + '（test-frontend 的分片清单是现读 index.html 的，所以它发现不了这件事）。');
  }
}
for (const f of loadedSlices) {
  if (!onDisk.includes(f)) {
    bad('public/index.html', '分片缺失',
      'index.html 引用了 public/' + f + '，但磁盘上没有这个文件 —— 浏览器会 404，'
      + '该片定义的函数全部未定义。');
  }
}

// 顺序必须与文件名的数字前缀顺序一致：后一片依赖前一片已定义的东西。
const byNumber = [...onDisk].sort((a, b) => {
  const n = (s) => Number((basename(s).match(/^(\d+)/) || [0, '0'])[1]);
  return n(a) - n(b) || a.localeCompare(b);
});
if (byNumber.join(',') !== loadedSlices.join(',')) {
  bad('public/index.html', '分片顺序不一致',
    'index.html 的加载顺序与文件名的数字前缀顺序不一致。\n'
    + '      index.html：' + loadedSlices.join(' → ') + '\n'
    + '      按前缀排：  ' + byNumber.join(' → '));
}
if (loaded.filter((s) => !s.startsWith('app/')).length === 0) {
  bad('public/index.html', '首屏引导缺失', 'index.html 里没有引用 boot.js（首屏上色与 file:// 兜底全靠它）。');
}

// ── 输出 ───────────────────────────────────────────────────
console.log('模块孤儿与断链审计');
console.log('  扫描范围：app/ 下 ' + modules.length + ' 个模块｜前端分片 ' + onDisk.length + ' 片（对照 public/index.html）');
console.log('  入口：app/main.mjs 与 tools/ 下全部脚本；动态加载走了 ' + DYNAMIC_ALLOW.length + ' 条白名单（每条都要有根据，见文件头）');
console.log('');

if (violations.length) {
  console.log('结果：发现 ' + violations.length + ' 处：');
  for (const v of violations) {
    console.log('');
    console.log('  [' + v.kind + '] ' + v.file);
    console.log('    ' + v.detail);
  }
  console.log('');
} else {
  console.log('结果：0 处（没有孤儿模块、没有断链 import、分片与 index.html 双向对齐）');
  console.log('');
}

console.log('DONE violations=' + violations.length);
process.exitCode = violations.length ? 1 : 0;

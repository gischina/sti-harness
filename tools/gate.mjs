/**
 * 统一门禁 —— 一条命令跑完「发布 / 改动后必跑的检查」，只回一个退出码。
 *
 * 为什么要有它（而不是每次手敲一串命令）：
 *   发布 SOP 要求跑的检查有 14 项（1 项版本号一致性 + 1 个部署自检 + 6 个主回归 +
 *   4 个静态审计 + 2 个"要真上游"的外部验收）。
 *   （项数只是这一行说明；**权威值是 `--list` 的现读值**，别手抄。）
 *   在此之前它们只能靠人工按顺序敲 —— 「上一次发版到现在少跑了一个脚本」不会有任何信号，
 *   而漏掉的那一个恰好可能是唯一会发现当前改动的那个（0.12.1 的 `backup.failed` 空话、
 *   0.13.0 的压测对账假红，都属于"只有跑到了才会发现"的那一类）。
 *   把清单写进代码，就有了唯一的、可核对的执行顺序。
 *
 * 为什么必须解析末行，而不是只看退出码（**这一条是防"假绿"的**）：
 *   本项目约定「每个脚本末行输出 `DONE fails=N` / `DONE violations=N` / `DONE leaks=N`」。
 *   如果某个脚本因为装配失败、路径写错、提前 `return` 而**根本没跑到末尾**，
 *   它的退出码也可能是 0。只看退出码会把「什么也没检查」读成「全部通过」——
 *   这正是本项目最怕的一类失败（假绿比红更坏）。
 *   所以每一项必须同时满足三条：① 退出码为 0；② 找到约定的末行；③ 末行里的数字是 0。
 *   三条里任一条不成立即记该项失败；**退出码与末行互相矛盾时，一律按"不通过"处理**。
 *
 * ⚠️ **SKIP ≠ 通过。** 两个外部内核验收要真上游；上游不在场时它们自报 SKIP，
 *   门禁如实记 `~`（跳过）并**不计入通过数**。要知道"这次到底验收了几项"，
 *   请读汇总行里的 `checks=<通过>/<总项>` 与单独的 `skipped=N`。
 *
 * 用法：
 *   node tools/gate.mjs                    # 全部（无上游的两项会如实 SKIP）
 *   node tools/gate.mjs --only=core,http   # 只跑其中几项（改动面小的时候省时间）
 *   node tools/gate.mjs --quiet            # 不转发子进程输出，只看汇总
 *   node tools/gate.mjs --list             # 只列清单，不跑
 *
 * 末行：`GATE DONE checks=<通过>/<总项> skipped=<跳过> fails=<失败>`
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * 版本号一致性（本项不是子进程，是就地检查）。
 *
 * 为什么需要它：`VERSION` 被代码读取（`app/paths.mjs` 的 `readVersion()`）并出现在
 * `deploy.md` §10 的三个标题里、`roadmap.md` 版本表的末行。这几处**靠人对着改**，
 * 而它漂移过一次 —— 标题写着「本版（1.6.0）」而内容早已是 1.7.0，一路没人发现。
 * 漂移的代价是"读者以为在说这一版，其实在说上一版"，与本项目最忌讳的
 * 「陈述与事实不一致」同类。
 *
 * 附带守住 `docs/versioning.md` 规则 1：**`1.0.0` 保留给正式版**。
 * 产品没 GA 就自称 1.x，等于在版本号里写了一句与事实不符的话。
 * 真要 GA 时这条会红 —— 那是**故意的**，它要求你同时去改 `versioning.md` 的规则 1，
 * 而不是悄悄把号改了。
 */
function checkVersion() {
  const out = [];
  let fails = 0;
  const no = (msg) => { fails++; out.push('  ✗ ' + msg); };
  const yes = (msg) => out.push('  ✓ ' + msg);

  const version = (() => { try { return read('VERSION').trim(); } catch { return ''; } })();
  if (!version) { no('读不到 VERSION 文件（或为空）'); out.push('DONE fails=' + fails); return out.join('\n'); }
  yes('VERSION = ' + version);

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) no('VERSION 不是语义化版本形：' + version);

  // 规则 1：未 GA 必须待在 0.x
  if (!/^0\./.test(version)) {
    no('VERSION 是 `' + version + '`，但本产品尚未 GA —— `docs/versioning.md` 规则 1 规定 '
      + '`1.0.0` 及以上的号**保留给正式版**。若确实要 GA，请先改 versioning.md 规则 1，'
      + '再改号（只改号＝在版本号里写了一句与事实不符的话）');
  } else {
    yes('符合 versioning.md 规则 1（未 GA → 0.x 线）');
  }

  const deploy = (() => { try { return read('docs/deploy.md'); } catch { return ''; } })();
  const road = (() => { try { return read('docs/roadmap.md'); } catch { return ''; } })();

  // deploy.md §10 的三个标题
  const deployHits = [
    ['本版（' + version + '）', /本版（/],
    ['当前版本（' + version + '）', /当前版本（/],
  ];
  for (const [want, anyRe] of deployHits) {
    if (deploy.includes(want)) { yes('deploy.md 里有「' + want + '」'); continue; }
    const found = [...deploy.matchAll(new RegExp(anyRe.source + '([^）]+)）', 'g'))].map((m) => m[1]);
    no('deploy.md 里找不到「' + want + '」' + (found.length ? '（找到的是：' + [...new Set(found)].join(' / ') + '）' : ''));
  }

  // roadmap 版本表末行 = 当前版本
  const rows = [...road.matchAll(/^\|\s*`(\d+\.\d+\.\d+)`\s*\|/gm)].map((m) => m[1]);
  if (!rows.length) no('roadmap.md 里没找到版本表行');
  else if (rows[rows.length - 1] !== version) {
    no('roadmap.md 版本表末行是 `' + rows[rows.length - 1] + '`，与 VERSION（`' + version + '`）不一致 —— '
      + '新版本要**追加一行**（旧行不动，那是决策证据）');
  } else yes('roadmap.md 版本表末行 = ' + version);

  // 三个序列不许混淆：VERSION 落在内核契约版本上就是配错了
  const contract = (read('app/kernel/contract.mjs').match(/CONTRACT_VERSION\s*=\s*'([^']+)'/) || [])[1];
  if (contract && contract === version) {
    no('VERSION（`' + version + '`）与内核契约版本 `CONTRACT_VERSION` 同值 —— '
      + '这两个是**不同的序列**（见 versioning.md 规则 3），同值说明有人把契约版本填进了 VERSION');
  } else if (contract) yes('与内核契约版本（' + contract + '）不是同一个序列，未混淆');

  out.push('DONE fails=' + fails);
  return out.join('\n');
}

/**
 * 检查清单 —— **顺序即执行顺序**，也是这份清单唯一的定义处。
 *   script / entry+args ：怎么跑
 *   metric              ：末行里要核对的数字叫什么（fails / violations / exit0）
 *   needsUpstream       ：该项要真上游；无上游时脚本自报 SKIP，门禁如实记跳过
 */
const CHECKS = [
  { id: 'version',          label: '版本号一致性（VERSION ↔ 文档 ↔ 0.x 线）', local: checkVersion, metric: 'fails' },
  { id: 'check',            label: '部署自检（含路由数 / 迁移号的现读值）', entry: 'app/main.mjs', args: ['--check'], metric: 'exit0' },
  { id: 'core',             label: '核心回归',            script: 'tools/test-core.mjs',              metric: 'fails' },
  { id: 'unit',             label: '纯函数快速单测',      script: 'tools/test-unit.mjs',              metric: 'fails' },
  { id: 'http',             label: 'HTTP 端到端',         script: 'tools/test-http.mjs',              metric: 'fails' },
  { id: 'knowledge',        label: '知识层端到端',        script: 'tools/test-knowledge.mjs',         metric: 'fails' },
  { id: 'governance',       label: '治理与审计端到端',    script: 'tools/test-governance.mjs',        metric: 'fails' },
  { id: 'stream',           label: '回合流式',            script: 'tools/test-stream.mjs',            metric: 'fails' },
  { id: 'frontend',         label: '前端行为（vm 逐片真跑）', script: 'tools/test-frontend.mjs',       metric: 'fails' },
  // 真机浏览器验收（0.15.3 新增）：连续四版抓到门禁漏网缺陷 —— 真实 DOM/JS 执行是
  // vm 层结构性盲区。找不到本机浏览器时脚本自报 SKIP（不是通过）。
  { id: 'browser',          label: '真机浏览器验收（23 场景）', script: 'tools/test-browser.mjs',      metric: 'fails' },
  { id: 'layering',         label: '分层审计',            script: 'tools/audit-layering.mjs',         metric: 'fails' },
  { id: 'tenant',           label: '多租户隔离审计',      script: 'tools/audit-tenant-isolation.mjs', metric: 'violations' },
  { id: 'orphans',          label: '模块孤儿与断链审计',  script: 'tools/audit-orphans.mjs',          metric: 'violations' },
  // 覆盖对账（0.15.3 新增）：22 页 × vm/浏览器双层锚点 + 138 个 API × 测试语料引用 ——
  // 「全功能可用性」不再是口头承诺，漏网即红。
  { id: 'coverage',         label: '覆盖对账（页面×层/API×测试）', script: 'tools/audit-coverage.mjs', metric: 'violations' },
  // 发布包泄漏扫描 —— 0.15.0 补进门的。它差点没进来：这一项此前**只是发版 SOP 里的一个手敲步骤**，
  // 而 step 里的扫描范围只覆盖 `app/`，于是 `tools/test-core.mjs` 里一枚**真实内核令牌**
  // 明明会随包分发，打包全程却报"泄漏 0"。教训：**人会漏，所以它必须进清单**。
  { id: 'packscan',         label: '发布包泄漏扫描',      script: 'tools/pack-release.mjs',           metric: 'leaks' },
  { id: 'external',         label: '外部内核端到端',      script: 'tools/test-external.mjs',          metric: 'fails', needsUpstream: true },
  { id: 'external-stream',  label: '外部内核流式',        script: 'tools/test-external-stream.mjs',   metric: 'fails', needsUpstream: true },
];

const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : null;

if (argv.includes('--list')) {
  console.log('可跑的检查项（' + CHECKS.length + ' 项，顺序即执行顺序）：');
  for (const c of CHECKS) {
    console.log('  ' + c.id.padEnd(18) + c.label + (c.needsUpstream ? '   [需真上游，无则 SKIP]' : ''));
  }
  process.exit(0);
}

if (only) {
  const unknown = only.filter((id) => !CHECKS.some((c) => c.id === id));
  if (unknown.length) {
    console.error('未知的检查项：' + unknown.join(', ') + '（用 --list 看全部）');
    process.exit(2);
  }
}

/** 跑一个检查：转发子进程输出（除非 --quiet），同时把输出留下来解析末行。 */
function run(check) {
  if (check.local) {
    const t0 = Date.now();
    let out = '';
    let code = 0;
    try { out = check.local(); } catch (e) { out = '就地检查抛异常：' + (e && e.message); code = 1; }
    if (!quiet) process.stdout.write(out + '\n');
    return Promise.resolve({ code, out, ms: Date.now() - t0 });
  }
  const cmd = check.entry ? [check.entry, ...(check.args || [])] : [check.script];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        out += chunk;
        if (!quiet) process.stdout.write(chunk);
      });
    }
    child.on('error', (e) => resolve({ code: 127, out: out + '\n' + e.message, ms: Date.now() - t0 }));
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

/**
 * 判定一项是否通过。三条同时成立才算通过（见文件头「为什么必须解析末行」）。
 * 返回 { status: 'pass'|'fail'|'skip', detail, cases }
 */
function judge(check, code, out) {
  if (check.metric === 'exit0') {
    return code === 0
      ? { status: 'pass', detail: '退出码 0' }
      : { status: 'fail', detail: '退出码 ' + code };
  }

  // 末行里那个数字**叫什么由 metric 决定**（fails / violations / leaks …）。
  // ⚠️ 刻意不写"枚举式"（`metric === 'violations' ? … : fails`）：那种写法会把**任何新指标
  // 静默降级成 fails**，于是"末行名字对不上"被报成"没找到末行"——报错信息指错方向，
  // 排查的人会去怀疑脚本没跑完，而不是怀疑自己忘了在这个函数里登记新指标。
  const name = check.metric;
  const re = new RegExp('DONE ' + name + '=(\\d+)', 'g');

  const hits = [...out.matchAll(re)];
  const cases = (() => {
    const m = [...out.matchAll(/用例 (\d+) 个｜失败 (\d+) 个(?:｜跳过 (\d+) 个)?/g)].pop();
    return m ? { total: Number(m[1]), fails: Number(m[2]), skips: Number(m[3] || 0) } : null;
  })();

  if (!hits.length) {
    // 脚本自报 SKIP：这是**有意的**"不验收"，不是通过。
    if (/^SKIP\s*$/m.test(out) && code === 0) {
      return { status: 'skip', detail: '脚本自报 SKIP（缺少它需要的外部条件，**不计入通过**）' };
    }
    return {
      status: 'fail',
      detail: '没找到约定的末行 `DONE ' + name + '=N` —— 脚本可能没跑到末尾。'
        + '**"什么都没检查"不等于"通过"**，请单独跑一次看它停在哪',
    };
  }

  const n = Number(hits[hits.length - 1][1]);
  /**
   * ⚠️ 取"末行"必须取**整行**，不能取上面那条正则的匹配结果。
   * 匹配结果是 `DONE fails=0` 这一段 —— 而 `skipped=1` 在**同一行的后面**，
   * 于是"跳过"又一次被读成"通过"。
   * （这个坑是我自己踩的：第一版写成 `hits[…][0]`，改红实验里它仍然是绿的 ——
   *   守卫不能只写、必须看着它红一次，说的就是这种。）
   */
  const doneLines = out.match(/^DONE .*$/gm) || [];
  const last = doneLines.length ? doneLines[doneLines.length - 1] : '';

  /**
   * **末行里的 `skipped=N` 必须记成"跳过"，不是"通过"。**
   *
   * 这一条是 0.15.0 抓出来的**假绿**：外部内核验收在"上游不在场"时会自报
   * `DONE fails=0 skipped=1`，而那串数字**读起来就是全绿** ——
   * 于是"这次一项都没验收"被记成 ✓，汇总里的"通过 13 / 14"也跟着虚高。
   *
   * 讽刺的是文件头早就写着「**SKIP ≠ 通过**」，但实现只认一种拼法：
   * `^SKIP$` 单独一行（那是 `test-external-stream` 的写法）。
   * 判据不该依赖**各脚本自己怎么排版那句提示** —— 提示会被人改措辞，
   * 而 `skipped=N` 是末行的**结构化字段**，改措辞不会动它。
   * 所以：**优先认结构化字段，文本匹配只作兜底**。
   */
  const skipHit = /skipped=(\d+)/.exec(last);
  const skipped = skipHit ? Number(skipHit[1]) : 0;
  if (skipped > 0) {
    return {
      status: 'skip',
      detail: '自报跳过 ' + skipped + ' 项（末行 `' + last.trim() + '`）—— **未验收，不计入通过**',
    };
  }

  if (n > 0) {
    const tip = code !== 0 ? '' : '（注意：退出码是 0，末行却说有失败 —— 两者矛盾，按不通过处理）';
    return { status: 'fail', detail: '末行 ' + name + '=' + n + tip, cases };
  }
  if (code !== 0) {
    return { status: 'fail', detail: '末行说 ' + name + '=0，但退出码是 ' + code + ' —— 两者矛盾，按不通过处理', cases };
  }
  return { status: 'pass', detail: '退出码 0 且末行 ' + name + '=0', cases };
}

// 汇总里要现读的数字（路由数 / 迁移号）——**不手抄**，从 `--check` 的输出里取。
function readFacts(allOut) {
  const routes = (allOut.match(/路由 (\d+) 条（public (\d+)，session (\d+)，admin (\d+)）/) || null);
  const mig = (allOut.match(/当前版本 (\d+)/) || null);
  return {
    routes: routes ? { total: Number(routes[1]), pub: Number(routes[2]), session: Number(routes[3]), admin: Number(routes[4]) } : null,
    migration: mig ? mig[1] : null,
  };
}

const selected = only ? CHECKS.filter((c) => only.includes(c.id)) : CHECKS;
const results = [];
let allOut = '';

console.log('');
console.log('════════════════════ 门禁开始 ════════════════════');
console.log('  ' + selected.length + ' 项，顺序即下方清单顺序；末行 `GATE DONE …` 是唯一的通过判据。');
console.log('');

for (const c of selected) {
  if (!quiet) {
    console.log('──────── ' + c.id + ' · ' + c.label + ' ────────');
  }
  const { code, out, ms } = await run(c);
  allOut += out;
  const v = judge(c, code, out);
  results.push({ check: c, ...v, ms, code });
  if (!quiet) console.log('');
}

const facts = readFacts(allOut);

console.log('════════════════════ 门禁汇总 ════════════════════');
for (const r of results) {
  const mark = r.status === 'pass' ? '\u2713' : r.status === 'skip' ? '~' : '\u2717';
  let extra = '';
  if (r.cases) {
    extra = '  ' + r.cases.total + ' 用例 / ' + r.cases.fails + ' 失败' + (r.cases.skips ? ' / ' + r.cases.skips + ' 跳过' : '');
  } else if (r.status === 'skip') {
    extra = '  （跳过）';
  }
  console.log('  ' + mark + ' ' + r.check.id.padEnd(18) + r.check.label.padEnd(34) + extra + '  ' + (r.ms / 1000).toFixed(1) + 's');
}
for (const r of results) {
  if (r.status !== 'pass') console.log('      ' + r.check.id + ' → ' + r.detail);
}

const passed = results.filter((r) => r.status === 'pass').length;
const skipped = results.filter((r) => r.status === 'skip').length;
const failed = results.filter((r) => r.status === 'fail').length;
const casesTotal = results.reduce((a, r) => a + (r.cases ? r.cases.total : 0), 0);

console.log('──────────────────────────────────────────────────');
console.log('  用例合计（只统计产出用例数的项）：' + casesTotal);
if (facts.routes) {
  console.log('  现读：路由 ' + facts.routes.total + ' 条（public ' + facts.routes.pub
    + '，session ' + facts.routes.session + '，admin ' + facts.routes.admin + '）｜迁移 ' + (facts.migration || '?'));
}
console.log('  通过 ' + passed + ' / 跳过 ' + skipped + ' / **失败 ' + failed + '**');

// 这个门禁**测不出什么** —— 必须自己说出来，否则读者会把"没测"读成"没问题"。
console.log('');
console.log('这个门禁测不出什么（如实列出，别当已经验过）：');
console.log('  · **多机 / 多进程**：当前架构单进程、无分布式锁，不支持横向扩 —— 不是"欠一次压测"。');
console.log('  · **开环定速与 30 分钟长稳**：要独占机器静跑，见 docs/benchmark-concurrency.md；');
console.log('    且它必须配 `--open-sender=process`，同进程模式问不出拐点。');
console.log('  · **真实上游下的对话可用性**：external 两项无上游时是 SKIP —— **SKIP 不是通过**。');
console.log('  · **浏览器里的真实渲染**：vm 层逐片真跑脚本，browser 层真机无头驱动 DOM/JS；');
console.log('    但布局、CSS、真实鼠标轨迹与多标签页并发不在覆盖内。');
console.log('  · **对外服务的 TLS 边界**：需要真实反向代理，见 docs/deploy.md §10。');
console.log('');
console.log('GATE DONE checks=' + passed + '/' + results.length + ' skipped=' + skipped + ' fails=' + failed);
process.exitCode = failed ? 1 : 0;

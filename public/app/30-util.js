/* STI HARNESS 前端 · 小工具与共用小件（转义 / card / kv / 加载与错误态）
 * Copyright 2026 liwei（易智瑞西安）.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 小工具 ───────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 把一个"应该是数组"的字段安全地当数组用。
 *
 * ⚠️ 这不是可有可无的洁癖。曾经 `/api/system/contract` 的 `compat` 段改了字段名
 * （`unverified` → `partial`/`refuted` 四态），前端仍按旧名读 `compat.unverified.length`，
 * 于是**渲染整页抛 TypeError**；而 `render()` 是先算 `body` 再写 `innerHTML`，
 * 异常一抛，`innerHTML` 根本没机会执行 —— 症状就是"点侧栏没反应"（hash 变了、画面不动），
 * 严重时刷新直接白屏。所以：**取值一律过 `arr()`，读不到的字段退化成空态**，
 * 页面显示"这里没有数据"永远比整站假死好。配套的回归钉是「逐路由渲染不抛异常」。
 */
function arr(v) { return Array.isArray(v) ? v : []; }

/* ── `ORIGIN_LABEL` / `originText()`：整块删除（0.21.10）───────────────
 *
 * 这里从前有一张工具来源的中文名对照表（`builtin | mcp | skill` → 内置 / MCP / 技能）
 * 与它的取值函数 `originText()`。它翻译的是 `tools.origin` 这个字段 ——
 * 而那张表连字段一起被删了（用户裁定：工具由内核自己调用、不用单独写这个能力、
 * 也不会单独列出来有哪些工具，见 0025_drop_tools.sql）。
 *
 * 它删掉之前有且只有两个消费者，都随工具登记表一起消失：
 *   ① 工作台工具卡的「来源对账」徽标（84-workbench.js）；
 *   ② 能力清单页工具表的「来源」列 + 来源页的工具来源分组（81-pages-capability.js）。
 * 所以这里删掉之后**没有任何调用方变成悬空** —— 它是最后一块。
 *
 * ⚠️ 保留这段记录而不是删干净：下一个人如果看到"某处还提 tools.origin"，
 *    应当能立刻查到那张表已经不存在，而不是去补一个只有注释在用的翻译表。
 */

function card(label, value, hint) {
  return '<div class="card"><div class="label">' + label + '</div>'
    + '<div class="value">' + value + '</div>'
    + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
}

/**
 * 相对时间（0.21.0，工作区树用）：「28分钟 / 1小时 / 3天」—— 与原生 Harness 同一显示习惯。
 * 会话树一屏十几条，绝对时间戳（2026-10-06 14:03）读起来太费劲；
 * 超过 30 天退回绝对日期 —— "几个月前"没有信息量，日期才有。
 */
function relTime(iso) {
  const t = Date.parse(String(iso == null ? '' : iso));
  if (isNaN(t)) return esc(iso);
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + '分钟';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '小时';
  const d = Math.floor(h / 24);
  if (d < 30) return d + '天';
  return esc(ts(iso));
}

function kv(k, v) {
  return '<dt>' + esc(k) + '</dt><dd>' + (v == null ? '—' : v) + '</dd>';
}

/**
 * 从一条路径取"最后一段目录名"，用作**工作区名称的默认值**（0.21.9）。
 *
 * 为什么要有它、为什么要放在公共小件里：0.21.9 起「新建工作区」就是一个**文件夹选择器**
 * （用户裁定："就搞成这种选择文件夹框就行啦"），名称不再让人输 —— 取所选目录的名字。
 * 于是"路径 → 名称"这条推导出现在两处：选择器里的那行提示（"工作区名称：proj-x"）
 * 与真正提交时的名称。**两处各写一遍必然漂**（提示说 proj-x、建出来叫别的），
 * 所以只留这一份。
 *
 * 边界：末尾的分隔符先剥掉（否则 `C:\a\b\` 会取到空串）；Windows 盘根 `C:\` 剥完是
 * `C:`，那是一个说得过去的名字（不是一个空名）。剥到空（理论上只有 `""`）时返回空串，
 * 由调用方自己决定退什么 —— 这里不编一个"新工作区"，那会让"名字是哪来的"说不清。
 */
function wbPathName(p) {
  const s = String(p == null ? '' : p).replace(/[\\/]+$/, '');
  if (!s) return '';
  return s.split(/[\\/]/).pop() || '';
}

function loadingOrError() {
  if (State.error) {
    return '<div class="note fail"><b>数据加载失败：</b>' + esc(State.error)
      + '<br>如果页面是刚打开的，稍等再刷新；若持续失败，请在服务端执行 <code>node app/main.mjs --check</code>。</div>';
  }
  return '<div class="panel"><span class="spinner"></span> <span class="muted">正在读取…</span></div>';
}

/**
 * 单页渲染失败时的兜底视图（错误边界）。
 *
 * 为什么必须有它：`render()` 是"先算 body，再写 `innerHTML`"。任何一页抛异常，
 * `innerHTML` 那一步就**不会执行** —— 整站停在上一屏：点侧栏 hash 变了、画面不动
 * （用户说的"点了没反应"）；若当前 hash 就是那页，刷新后连导航都出不来。
 *
 * 把"整站假死"降级成"单页报错、其余照常"，是这种 `状态 → innerHTML` 架构必须付的成本。
 * 触发它的真实案例与回归钉见 `pageContract` 的注释与 test-frontend「逐路由渲染」。
 */
function pageRenderFailed(route, err) {
  const msg = (err && (err.message || String(err))) || '未知错误';
  return '<div class="panel"><h2>本页渲染失败</h2>'
    + '<div class="note fail"><b>' + esc(route ? route.title : '未知页面') + '</b> 渲染时抛了异常：'
    + '<br><span class="mono">' + esc(msg) + '</span></div>'
    + '<div class="faint">其余页面<b>不受影响</b>，可以从左侧继续操作。'
    + '这类问题几乎都是「接口返回的字段名变了、页面还在按旧名字读」——'
    + '请把上面的错误信息连同版本号一并反馈，它能直接定位到那一行。</div></div>';
}

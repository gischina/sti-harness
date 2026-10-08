/* STI HARNESS 前端 · 事件委托（CSP 敢去掉 unsafe-inline 的前提）
 * Copyright 2026 liwei（易智瑞西安）.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 事件委托（CSP 敢去掉 'unsafe-inline' 的前提）────────────────────────
 * 原先满屏都在内联事件属性里直接调 App 方法，逼得 CSP 的 `script-src` 必须放开 `'unsafe-inline'`；
 * 而内联脚本一旦放开，XSS 防护基本就没了 —— 攻击者只要能把一段 `<script>` 或
 * `onclick` 送进页面就能执行。改成事件委托后：
 *   · 属性里只剩**数据**（`data-act` + `data-a1`/`data-a2`），没有可执行代码；
 *   · 监听器只挂一次（在 document 上），重绘不必重新绑定 —— 顺手消掉"重绘丢监听"那一整类 bug；
 *   · 参数统一是字符串，`"true"`/`"false"` 还原成布尔。本项目需要布尔的参数只有"启停"一类，
 *     其余字符串参数的取值里不会出现裸的 true/false，因此这个还原不产生歧义。
 * ⚠️ 这只是**把内联脚本挪走**，不是"前端变安全了"：真正的鉴权仍在服务端（见文件头第 4 条）。
 */
function act(name) {
  let s = ' data-act="' + esc(name) + '"';
  for (let i = 1; i < arguments.length; i++) {
    const v = arguments[i];
    if (v === undefined) continue;
    s += ' data-a' + i + '="' + esc(String(v)) + '"';
  }
  return s;
}
function actCh(name) { return ' data-change="' + esc(name) + '"'; }
function navAttr(hash) {
  // role + tabindex：侧栏项是 div（不是 <a>），不加这两个属性键盘用户就
  // 完全到不了导航 —— Tab 不聚焦、Enter 不生效、读屏器也不认为它是链接。
  // 配套的键盘触发在 bindDelegates 的 keydown 委托里。
  return ' data-nav="' + esc(hash) + '" role="link" tabindex="0"';
}

/** 从事件目标向上找带指定 data-* 的祖先（等价 closest，但 DOM 垫片里也能跑）。 */
function findData(node, attr) {
  for (let n = node, i = 0; n && i < 40; i++, n = n.parentNode) {
    if (typeof n.getAttribute === 'function' && n.getAttribute(attr)) return n;
  }
  return null;
}
function dataArg(el, n) {
  const v = el.getAttribute('data-a' + n);
  if (v === null) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}
function bindDelegates() {
  document.addEventListener('click', (e) => {
    const nav = findData(e.target, 'data-nav');
    if (nav) { e.preventDefault(); location.hash = nav.getAttribute('data-nav'); return; }
    const el = findData(e.target, 'data-act');
    if (!el) {
      // 点空白处收起侧栏的行内「⋯」菜单（0.21.1）与顶栏账号下拉（0.21.11）。
      // 不做这件事的话，菜单只能靠再点一次入口收起 —— 用户点别处没反应，会以为界面卡住了。
      // 常态是两者都关着，这里是一次 no-op（不重绘、不冒泡出别的行为）。
      // ⚠️ 0.21.11：工作台那个账号下拉已删（改成"点名字直接跳我的账号"的链接），
      //    所以这里只剩 rowMenu 与顶栏的 topbarMenu 两个。
      let shut = false;
      if (State.wb && State.wb.rowMenu) { State.wb.rowMenu = null; shut = true; }
      // 顶栏账号下拉：顶层字段，在 `State` 上而不在 `State.wb` 上。
      if (State.topbarMenu) { State.topbarMenu = false; shut = true; }
      if (shut) render();
      return;
    }
    const fn = App[el.getAttribute('data-act')];
    if (typeof fn !== 'function') return;          // 名字写错不该静默吞掉整页交互
    e.preventDefault();
    fn(dataArg(el, 1), dataArg(el, 2));
  });
  document.addEventListener('change', (e) => {
    const el = findData(e.target, 'data-change');
    if (!el) return;
    const fn = App[el.getAttribute('data-change')];
    if (typeof fn === 'function') fn(el.value);
  });
  // 键盘触发（与 click 委托同语义）：导航项现在是可聚焦的（tabindex=0），
  // Enter / 空格必须真的能导航 —— 聚焦却无响应比不能聚焦更糟。
  document.addEventListener('keydown', (e) => {
    // Esc 关掉应用内对话框。放在**最前面**：弹层开着时它是当前唯一的"上面一层"，
    // 其余键盘语义（导航）都应让位。
    if (e.key === 'Escape' && Dlg.isOpen()) { e.preventDefault(); Dlg.close(null); return; }
    // Tab 焦点陷阱：弹层开着时焦点必须圈在弹层内（实现见 15-dialog.js 的 dlgTrapFocus）。
    if (e.key === 'Tab' && Dlg.isOpen()) { dlgTrapFocus(e); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const nav = findData(e.target, 'data-nav');
    if (!nav) return;
    e.preventDefault();
    location.hash = nav.getAttribute('data-nav');
  });
}

function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function dur(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟';
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
}

function ts(v) {
  return v ? String(v).replace('T', ' ').slice(0, 19) : '—';
}

/** 读取本地文件为 base64（导入接口收 base64，不收 multipart —— 少一个解析器） */
function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('读取文件失败：' + (file && file.name)));
    fr.onload = () => {
      const s = String(fr.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.readAsDataURL(file);
  });
}

/**
 * 读取本地 CSV 为**已解码文本**（账号批量导入用；服务端不收字节，只收解码后的文本）。
 * 解码链：UTF-8（fatal）→ GBK → UTF-8（非致命）。
 *   · 先试 UTF-8 且 fatal：能把"这不是 UTF-8"与"是 UTF-8 但有坏字节"区分开；
 *   · GBK 兜底是现实需要：Excel 中文版"另存为 CSV"默认就是 GBK，直接按 UTF-8 读
 *     会得到满屏乱码的账号名（还是"看起来导入成功"的那种）；
 *   · 最后非致命 UTF-8：宁可让用户看到乱码自己改，也好过卡在一句"解码失败"上没路走。
 */
async function readCsvText(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

/** 导入结果转成一句人能看懂的话（含解析器、分块数、耗时与告警） */
function describeImport(r) {
  if (r.duplicate) return '内容完全相同的文档已存在，未重复导入：' + ((r.document && r.document.title) || '');
  const d = r.document || {};
  const rep = r.report || {};
  let s = '「' + d.title + '」已导入：解析器 ' + rep.parser + '，' + rep.chunkCount + ' 个分块';
  if (rep.vectorCount) s += '、' + rep.vectorCount + ' 条向量';
  s += '，状态 ' + d.status + '，耗时 ' + (rep.elapsedMs || 0) + 'ms。';
  if (rep.warnings && rep.warnings.length) s += ' 注意：' + rep.warnings.join('；');
  return s;
}

/** 文档状态徽章 —— 失败要把原因摆出来，不能只显示一个红点 */
function docStatusBadge(status) {
  const map = {
    ready: ['ok', '可检索'],
    parsing: ['warn', '解析中'],
    pending: ['dim', '待处理'],
    failed: ['fail', '解析失败'],
  };
  const [cls, text] = map[status] || ['dim', status];
  return '<span class="badge ' + cls + '">' + esc(text) + '</span>';
}

/**
 * 统一的接口调用。
 * `credentials: 'same-origin'` 是必须的：浏览器版登录态全靠 httpOnly cookie，
 * 不显式带上就会一登录就 401。跨站请求由服务端 rbac 前的 CSRF 判定拦掉。
 */
async function api(path, opts) {
  const o = opts || {};
  // `raw` 走**原始字节**上传：body 就是文件本身（元数据走 query）。
  // 这条路径必须**删掉** JSON 的 content-type —— 否则浏览器不会带上文件自己的类型，
  // 服务端就只能靠扩展名猜，而它的"文本/二进制"判定是看内容的（见 classifyBuffer）。
  if (o.raw != null) {
    const body = o.raw;
    const rest = Object.assign({}, o);
    delete rest.raw;
    const r0 = await fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: {},
    }, rest, { body }));
    let j0 = null;
    try { j0 = await r0.json(); } catch (e) { /* 非 JSON */ }
    if (!r0.ok) {
      const msg0 = j0 && j0.error ? (j0.error.message || j0.error.code) : ('HTTP ' + r0.status);
      const err0 = new Error(msg0);
      err0.status = r0.status;
      err0.payload = j0;
      throw err0;
    }
    return j0;
  }
  const r = await fetch(path, Object.assign({
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
  }, o));
  let j = null;
  try { j = await r.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (!r.ok) {
    const msg = j && j.error ? (j.error.message || j.error.code) : ('HTTP ' + r.status);
    const err = new Error(msg);
    err.status = r.status;
    err.payload = j;
    throw err;
  }
  return j;
}

function levelBadge(level) {
  const map = { ok: ['ok', '正常'], warn: ['warn', '注意'], fail: ['fail', '异常'], info: ['dim', '提示'], unknown: ['dim', '未知'] };
  const [cls, text] = map[level] || ['dim', level];
  return '<span class="badge ' + cls + '">' + esc(text) + '</span>';
}

function topic() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

function toggleTheme() {
  const next = topic() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('sti.theme', next); } catch (e) { /* 隐私模式下忽略 */ }
  render();
}

/** 服务端给的权限矩阵：`allowed('user','write')`。取不到就一律 false（不要乐观放行）。 */
function allowed(res, act) {
  const m = State.me && State.me.permissions;
  return !!(m && m[res] && m[res][act]);
}

/**
 * 落地页 = 打不开具体地址时去哪。
 *
 * 为什么不直接写 `ROUTES[0]`：数组第一项的语义会被这一处隐式占用，改来改去容易漂。
 * 这里显式声明"首选工作台，无权限才退回概览"—— 让最终用户一进来就是对话框，
 * 而审计/观摩类账号（无 session 权限时）退回概览，不至于看到一个用不了的页面。
 */
function defaultRoute() {
  const wb = ROUTES.find((x) => x.id === 'workbench');
  if (wb && (!wb.need || allowed(wb.need[0], wb.need[1]))) return wb;
  return ROUTES.find((x) => x.id === 'overview') || ROUTES[0];
}

function myRoles() {
  return (State.me && State.me.user && State.me.user.roles) || [];
}

/* STI HARNESS 前端 · 渲染入口与启动（bindDelegates / hashchange / boot）
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';

/**
 * 内核接入表单的三个输入框：**输入即写状态**，不能等提交时读 DOM ——
 * 点「检测连接」会重绘一张诊断卡，输入框随之被重建，那时读 DOM 只会拿到空值
 * （用户刚粘的地址会消失）。
 *
 * @param {string} pfx 元素 id 前缀（`kf` = 概览页的接入面板；`kg` = 未接入时的阻断页）。
 *   两处**不会同时在场**（阻断页会整页替换掉一切），但共用 id 仍然会出问题，所以留着这个前缀。
 */
function bindKernelFormInputs(pfx) {
  const o = $('#' + pfx + '-origin');
  if (o) o.addEventListener('input', (e) => {
    State.kernelForm.origin = e.target.value;
    resetKernelProbeOnEdit(pfx, 'origin');
  });
  const t = $('#' + pfx + '-token');
  if (t) t.addEventListener('input', (e) => {
    State.kernelForm.token = e.target.value;
    resetKernelProbeOnEdit(pfx, 'token');
  });
}

/**
 * 地址 / 令牌被改动 ⇒ 上一次的检测结论**当场作废**（0.21.5）。
 *
 * 为什么必须作废：保存的前提是"这一次检测通过"。若改完地址还能按着旧结论保存，
 * 那条"必须检测可用才能保存"的规矩就只剩一层皮 —— 绕过它的办法只是"先探一个好地址，
 * 再改成另一个"。
 *
 * 为什么要顺手把焦点放回去：这条路径**每次输入都会走**，而 `render()` 是整片 innerHTML
 * 重建，天生丢焦点与光标位置。不补回来，用户改一个字母就得重新点一次输入框，
 * 手感是"输入框自己会跳走" —— 比灰一个按钮糟得多。
 * （只在"确实有检测结论要作废"时才重绘一次；连续打字期间 `State.kernelProbe` 已是空，
 * 第二次起就不再重绘了。）
 */
function resetKernelProbeOnEdit(pfx, field) {
  if (!State.kernelProbe && !State.kernelProbeError) return;
  State.kernelProbe = null;
  State.kernelProbeError = null;
  render();
  const el = $('#' + pfx + '-' + field);
  if (!el) return;
  if (typeof el.focus === 'function') el.focus();
  // 光标摆到末尾：用户是在**接着打字**，不是在重选。
  if (typeof el.setSelectionRange === 'function') {
    const n = String(el.value || '').length;
    try { el.setSelectionRange(n, n); } catch { /* 某些 input 类型不支持选区，忽略 */ }
  }
}

/** 输入框回车即提交：全量重绘后元素是新的，必须重挂（文档级委托接不了这个语义）。 */
function bindEnterSubmit() {
  for (const [id, fn] of [['loginPass', App.login], ['loginTotpCode', App.loginTotp], ['adminPassword', App.runSetup], ['kb-q', App.runSearch]]) {
    const el = $('#' + id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } });
  }
}

function render() {
  // ⚠️ 这三个"全屏视图"的提前返回**也必须带上 dlgOverlay()**。
  //    漏掉它们的后果不是"样式难看"，而是：弹层没被渲染 → 用户看不到任何东西 →
  //    那个 await 永远等不到答复（`Dlg.confirm` 的 promise 永不 settle）→
  //    整条动作链**静默挂住**，症状就是"点了没反应"。这条不变式有回归钉着
  //    （test-frontend「每个渲染分支都带上弹层」）。
  //    ⚠️ 同理，回车提交绑定也必须在这三个分支里各调一次：loginPass / loginTotpCode /
  //    adminPassword 都住在这些视图里（没有 <form>，浏览器不会替你提交），漏掉的话
  //    输入框按回车**毫无反应** —— 这也是回归在钉的。
  if (State.view === 'boot') { $('#app').innerHTML = pageBoot() + dlgOverlay(); bindEnterSubmit(); return; }
  if (State.view === 'setup') { $('#app').innerHTML = pageSetup() + dlgOverlay(); bindEnterSubmit(); return; }
  if (State.view === 'login') { $('#app').innerHTML = pageLogin() + dlgOverlay(); bindEnterSubmit(); return; }

  /**
   * 内核未接入 → **全平台拦住**（0.21.4）。
   *
   * 为什么排在这里（登录/初始化**之后**）：锁在门外就没人能配了 ——
   * 接入内核是管理员在已登录状态下做的动作。
   *
   * 为什么是"整页"而不是浮层：浮层背后是"看起来正常、实际点不动"的界面；
   * 而且浮层可以被关掉，关掉之后平台并不会变得可用。整页没有关闭按钮，
   * 唯一出口是「退出登录」（见 pageKernelGate）。
   *
   * `State.status` 还没拿到时**不拦** —— 那一瞬间显示的是加载态，
   * 状态到手后 `render()` 会再跑一次，那时才决定放行还是拦住。
   */
  if (State.status && State.status.kernel && !State.status.kernel.ready) {
    $('#app').innerHTML = pageKernelGate(State.status.kernel) + dlgOverlay();
    bindKernelFormInputs('kg');
    bindEnterSubmit();
    return;
  }

  const cur = App.currentRoute();
  const pageMap = {
    workbench: pageWorkbench,
    overview: pageOverview,
    contract: pageContract, routes: pageRoutes, middleware: pageMiddleware,
    knowledge: pageKnowledge,
    users: pageUsers, groups: pageGroups, roles: pageRoles, creds: pageCreds, me: pageMe,
    audit: pageAudit, quotas: pageQuotas, sessionlogs: pageSessionLogs,
    capabilities: pageCapabilities, capSources: pageCapSources, capPolicies: pageCapPolicies,
    backup: pageBackup,
    models: pageModels,
    schedules: pageSchedules,
    notify: pageNotify,
    settings: pageSettings,
  };
  const body = (() => {
    // 错误边界：单页渲染失败不能让整个应用假死。
    // 这里必须 try —— 因为下面是"先算 body 再写 innerHTML"，异常一抛 innerHTML 就不执行，
    // 症状是"点侧栏没反应"（hash 变了画面不动）。真实案例见 pageContract 的注释。
    try {
      return (pageMap[cur.id] || pageOverview)();
    } catch (err) {
      try { console.error('[sti-harness] 页面渲染失败：', cur.id, err); } catch { /* 控制台不可用就算了 */ }
      return pageRenderFailed(cur, err);
    }
  })();

  // 侧栏滚动位置必须跨重绘保持：render 是全量重建 #app.innerHTML，
  // .sidebar 是新 DOM，不保存的话每次点导航（或任何触发 render 的动作）
  // 滚动条都会跳回顶部 —— 用户滚到下面点功能就得重新滚一遍。
  // 主内容区不保存：换页回顶部是预期行为。
  const oldSidebar = document.querySelector('.sidebar');
  const savedSidebarTop = oldSidebar ? oldSidebar.scrollTop : 0;

  // 工作台是**全屏视图**（0.21.2）：与原生 Harness 的第一屏同一布局 —— 左栏就是工作区树，
  // 不套管理后台的顶栏 / 侧栏 / 页面标题。此前它被塞在管理外壳里：
  // 顶栏 + 22 页导航 + 页标题 + 右栏面板层层包着中间一棵树，用户原话是"样式乱七八糟"。
  // 其余 21 页维持原外壳不变（管理页要的是信息密度，不是沉浸感）。
  const fullBleed = cur.id === 'workbench';
  $('#app').innerHTML = fullBleed
    ? (State.error ? '<div class="note fail">' + esc(State.error) + '</div>' : '')
      + (State.notice ? '<div class="note">' + esc(State.notice) + '</div>' : '')
      + body
      + dlgOverlay()
    : topbar()
    + '<div class="layout">'
    + '<div class="sidebar">' + navHtml() + '</div>'
    + '<div class="content">'
    + '<h1 class="page-title">' + esc(cur.title) + '</h1>'
    + '<p class="page-sub">' + esc(cur.sub) + '</p>'
    // 操作反馈：应用内的动作（批准/删除/保存…）此前只刷新数据不给提示，
    // 用户不知道"刚才那下到底成没成"。诚实反馈和诚实数据一样重要。
    + (State.error ? '<div class="note fail">' + esc(State.error) + '</div>' : '')
    + (State.notice ? '<div class="note">' + esc(State.notice) + '</div>' : '')
    + body
    + '</div></div>'
    // 应用内对话框是**盖在整页之上**的一层，因此追加在最外面（不是塞进内容区）。
    // （内核接入页是整页替换，不是这一层 —— 见上面的阻断分支。）
    + dlgOverlay();

  // 全屏视图没有管理侧栏，滚动保持无从谈起（fullBleed 时 savedSidebarTop 本来就是 0，
  // 这里显式跳过以免误绑到工作台左栏上 —— 左栏自己管自己的滚动）。
  if (!fullBleed) {
    const sidebarEl = document.querySelector('.sidebar');
    if (sidebarEl && savedSidebarTop > 0) sidebarEl.scrollTop = savedSidebarTop;
  }

  bindKernelFormInputs('kf');
  bindEnterSubmit();

  // 对话框输入框：输入时把值写回状态（**不重绘**，否则每敲一个字就丢焦点），
  // 回车等同于点确认。取值时仍以 DOM 为准（见 Dlg.submit 的说明）。
  const dlgIn = $('#dlg-input');
  if (dlgIn) {
    dlgIn.addEventListener('input', (e) => { if (State.dlg) State.dlg.value = e.target.value; });
    dlgIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); App.dlgOk(); }
    });
  }
  // 只显示一次的值（API Key）：聚焦即全选，用户按 Ctrl+C 就能拿走。
  const dlgMono = $('#dlg-mono');
  if (dlgMono) {
    dlgMono.addEventListener('focus', () => { try { dlgMono.select(); } catch { /* 垫片无选区 */ } });
  }

  // 工作台：输入框回车发送；并做一次**惰性**数据加载（只在没加载过时发请求）。
  // 注意 render 本身保持"只读状态"——数据加载走 App.wbEnsureLoaded()，它自带
  // loaded/loading 闸，加载完再触发一次 render，不会形成循环。
  if (cur.id === 'workbench') {
    const wbIn = $('#wb-input');
    if (wbIn) {
      wbIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); App.wbSend(); }
      });
    }
    App.wbEnsureLoaded();
    // ── 工作台：整页重建之后**补一次滚到底**（0.21.9）──────────────────────
    //
    // 用户 2026-10-08 报两件事，都指向这一句：
    //   「每次对话提交后就跑到会话的最上面」+「查看每个对话默认查看最新也就是滚动到
    //    最下面的内容」。
    //
    // 根因就是上面那句 `$('#app').innerHTML = …`：它是**全量重建**，新建出来的
    // `#wb-stream` 的 `scrollTop` 天然是 **0 = 最上面**。而工作台一回合至少重建两次
    // （`wbRunTurn` 首发 `render(); wbPaint();`；收尾 `render();` →
    // `wbRefreshContext();` 内部又 `render()`），切会话同样走 `render()` ——
    // 于是"提交后跑到最上面""打开会话停在最上面"是**同一个根因**。
    //
    // 为什么要补在这里而不是让 `wbPaint` 兜住：收尾那次路径是
    // `render() → wbRefreshContext() → render()`，**全程没有 `wbPaint`**，
    // 只靠 `wbPaint` 永远兜不住。凡"重建过 `#wb-stream`"的路径都必须自己补。
    //
    // ⚠️ 为什么不沿用上面侧栏那段"先存旧值再恢复"的写法：`#wb-stream` 这时
    //    已经被换掉了，旧节点进不了文档，它身上的 `scrollTop` 读出来也没意义
    //    （且那正是"恢复成 0"的来源）。这里的语义不是"保持原处"，而是
    //    **"永远停在最新一轮"** —— 这是消息流的正确默认，与侧栏"保持用户滚到的地方"不同。
    // ⚠️ 判据「轨迹」页签不滚在 `wbStickToBottom` 里统一做，不在本处重复。
    wbStickToBottom();
  }
}

bindDelegates();
window.addEventListener('hashchange', render);
window.App = App;
// 弹层 API 也挂到 window 上：与 window.App 同一个理由 —— 分片是**经典脚本**，
// 顶层 `const` 只进全局词法环境、不会成为 window 的属性，不显式挂出去就既拿不到、
// 也无法在浏览器控制台里驱动（排查"点了没反应"时这一步很值钱）。
window.Dlg = Dlg;
boot();

/* STI HARNESS 前端 · 启动、登录流程与登录 / 初始化页
 * Copyright 2026 liwei（易智瑞西安）.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 启动与登录流程 ───────────────────────────────────── */

async function boot() {
  State.view = 'boot';
  render();
  // ① 初始化状态是 public 接口 —— 全新机器上这一步必须能通
  try {
    State.setup = (await api('/api/identity/setup')).setup;
  } catch (e) {
    State.error = '无法读取初始化状态：' + e.message;
    State.view = 'boot';
    render();
    return;
  }
  if (!State.setup || State.setup.needsSetup) {
    State.view = 'setup';
    render();
    return;
  }
  // ② 已初始化 → 看有没有登录态
  try {
    State.me = await api('/api/identity/me');
    State.view = 'app';
    render();
    await loadAll();
  } catch (e) {
    if (e.status === 401) {
      State.view = 'login';
      State.error = null;
    } else {
      State.error = '无法读取当前身份：' + e.message;
      State.view = 'login';
    }
    render();
  }
}

/**
 * 一次性加载全部页面数据。
 *
 * ⚠️ 必须经 `App.xxx()` 调用：这些加载函数只定义在 App 对象上，
 * 早先这里写成裸的 `loadStatus()`，在浏览器里会直接抛
 * `ReferenceError: loadStatus is not defined` —— 而当时的验证是 curl 做的，
 * 没执行过浏览器 JS，所以一直没被发现。**接口自测通了不代表页面能跑。**
 */
async function loadAll() {
  await Promise.all([
    App.loadStatus(), App.loadRoutes(), App.loadContract(), App.loadMiddleware(),
    App.loadUsers(), App.loadRoles(), App.loadGroups(), App.loadCreds(), App.loadApiKeys(), App.loadTotp(), App.loadKnowledge(),
    App.loadDepartments(),
    App.loadAudit(), App.loadQuotas(), App.loadSessionLogs(), App.loadCapability(), App.loadBackup(),
    App.loadModels(), App.loadSchedules(), App.loadNotify(),
    App.loadSettings(),
    // 内核状态单独拉一次：概览页要拿它的 `restart`（"配置改了但还没生效"）——
    // 那个结论对账的是"运行中内核实际连的地址"与"配置文件里写的地址"两个客观值。
    App.loadKernelStatus(),
  ]);
}

/* ── 页面渲染：登录 / 初始化向导 ───────────────────────── */

function shell(inner) {
  return '<div class="auth-wrap"><div class="auth-card">' + inner + '</div></div>';
}

function pageBoot() {
  if (State.error) {
    return shell('<h1>打不开</h1><div class="note fail">' + esc(State.error) + '</div>'
      + '<div class="faint">若是刚启动服务，稍等再刷新；若持续失败，请在服务端执行 '
      + '<code>node app/main.mjs --check</code>。</div>');
  }
  return shell('<span class="spinner"></span> <span class="muted">正在读取平台状态…</span>');
}

function pageSetup() {
  let html = '<h1>初始化 STI HARNESS</h1>'
    + '<p class="faint">这台机器上还没有任何组织与账号。下面的信息用于建立<b>第一个组织</b>与'
    + '<b>第一个所有者账号</b> —— 它会成为整个平台权限的起点。</p>';

  if (State.error) html += '<div class="note fail">' + esc(State.error) + '</div>';
  if (State.notice) html += '<div class="note">' + esc(State.notice) + '</div>';

  html += '<div class="form">'
    + field('orgName', '组织名称', 'text', '例如：某某公司')
    + field('adminDisplayName', '管理员姓名', 'text', '显示在界面上的名字')
    + field('adminUsername', '管理员账号', 'text', '2–64 位字母 / 数字 / . _ - @')
    + field('adminPassword', '管理员口令', 'password', '至少 8 位，且至少含两类字符')
    + '<details><summary class="faint">可选：现在就配一个模型凭据（AES-256-GCM 加密落库）</summary>'
    + '<div style="margin-top:10px">'
    + field('credName', '凭据名称', 'text', '例如：model-key')
    + field('credProvider', '提供方', 'text', '例如：openai-compatible（可留空）')
    + field('credValue', '凭据值', 'password', '只在这一刻经过内存，之后无法取出')
    + '</div></details>'
    + '<div class="row" style="margin-top:14px">'
    + '<button class="primary" ' + act('runSetup') + (State.busy ? ' disabled' : '') + '>建立组织并继续</button>'
    + (State.busy ? '<span class="spinner"></span>' : '')
    + '</div></div>'
    + '<div class="note">'
    + '<b>口令不会以任何形式回显。</b>服务端用 scrypt（N=16384, r=8, p=1）+ 每用户独立 salt 保存，'
    + '常量时间比较。忘记口令只能由管理员重置，没有后门。'
    + '</div>';
  return shell(html);
}

function pageLogin() {
  // ⚠️ 这是**未认证**页面，因此只显示组织名 —— 它是必要上下文（多组织部署时
  // 用户要知道自己连的是哪台）。曾经这里还回显"已建账号 N 个"，那是把
  // "这家公司有多大"送给任何能碰到端口的人，没有收益只有风险，已去掉。
  const orgName = State.setup && State.setup.org ? State.setup.org.name : '—';
  let html = '<h1>登录</h1>'
    + '<p class="faint">组织：<b>' + esc(orgName) + '</b></p>';

  if (State.error) html += '<div class="note fail">' + esc(State.error) + '</div>';
  if (State.notice) html += '<div class="note">' + esc(State.notice) + '</div>';

  // 第二阶段（TOTP）：口令已过、拿到一次性票据，等验证码。见 App.loginTotp。
  // 这里刻意**不显示账号名**：票据不绑定"给它看的页面"，回显只是白送信息。
  if (State.mfa) {
    html += '<div class="form">'
      + field('loginTotpCode', '验证码', 'text', '验证器上的 6 位动态码；丢了设备也可以用一张一次性恢复码（XXXX-XXXX）')
      + '<div class="row">'
      + '<button class="primary" ' + act('loginTotp') + (State.busy ? ' disabled' : '') + '>验证并登录</button>'
      + '<button ' + act('cancelMfa') + '>返回上一步</button>'
      + (State.busy ? '<span class="spinner"></span>' : '')
      + '</div></div>'
      + '<div class="note">口令已通过，只差第二因子。若验证码被拒，可以重试，或'
      + '<b>返回上一步</b>重新开始（票据 ' + esc(ts(State.mfa.expiresAt)) + ' 前有效）。</div>';
    return shell(html);
  }

  html += '<div class="form">'
    + field('loginUser', '账号', 'text', '')
    + field('loginPass', '口令', 'password', '')
    + '<div class="row" style="margin-top:14px">'
    + '<button class="primary" ' + act('login') + (State.busy ? ' disabled' : '') + '>登录</button>'
    + (State.busy ? '<span class="spinner"></span>' : '')
    + '</div></div>'
    + '<div class="note">登录成功后，会话令牌以 <b>httpOnly + SameSite=Lax</b> 的 Cookie 下发；'
    + '服务端只保存它的 <b>HMAC 哈希</b>，因此库文件被拷走也伪造不出令牌。</div>';
  return shell(html);
}

function field(id, label, type, hint) {
  return '<label class="field"><span class="field-label">' + esc(label) + '</span>'
    + '<input id="' + id + '" type="' + type + '" autocomplete="off">'
    + (hint ? '<span class="field-hint">' + esc(hint) + '</span>' : '')
    + '</label>';
}

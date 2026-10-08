/* STI HARNESS 前端 · App 对象：动作层（数据加载与写操作）
 * Copyright 2026 liwei（易智瑞西安）.
 *
 * ⚠️ 这里只放"列表页 / 表单页"的动作。**对话工作台**的动作（会话选择、附件、流式回合、
 * 引用回溯 —— 25 个 `wb*` 方法）已按域拆到 `71-app-workbench.js`，由该片 `Object.assign`
 * 归并回同一个 `App` 对象：`40-delegate.js` 的事件委托按 `App.<action>` 取函数，
 * 所以"拆文件"不能变成"换命名空间"。
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 应用 ─────────────────────────────────────────────── */
const App = {
  currentRoute() {
    const h = location.hash || defaultRoute().hash;
    const r = ROUTES.find((x) => x.hash === h) || defaultRoute();
    // 无权访问的页面回落到默认页：入口本来就藏了，这里兜住手敲 hash 的情况
    if (r.need && !allowed(r.need[0], r.need[1])) return defaultRoute();
    return r;
  },

  /* ── 对话框（15-dialog.js 的渲染出口）────────────────────────
     这三个方法必须是 App 的成员：事件委托按 `App[data-act]` 取函数
     （见 40-delegate.js），写成普通全局函数会变成"点了没反应"。 */
  dlgOk() { Dlg.submit(); },
  dlgCancel() { Dlg.close(null); },

  /* ── 目录选择器（0.21.7，15-dialog.js 的 browse 弹层用）──────────
     同样必须是 App 的成员：事件委托按 `App[data-act]` 取函数。
     ⚠️ 0.21.9 删掉了 `dlgBrowseSkip`（「不设工作目录」）—— 见 `Dlg.browse` 的注释。
        事件委托是**按名字取函数**的，所以删动作时只删 `App` 上的那一项就够；
        但弹层里那行按钮的 `data-act="dlgBrowseSkip"` 必须一起删 —— 否则会留下一个
        "点了没反应"的死按钮（`App[act]` 取到 undefined）。 */

  /** 进一个目录 / 回上一级 / 跳到某个常用起点 —— 三个动作对服务端是同一件事 */
  dlgBrowseGo(target) { Dlg._browseLoad(target == null ? '' : String(target)); },

  /**
   * 单选/多选里勾了一项。`data-change` 委托只传 `el.value`，
   * 所以选项的 value 是**索引**（见 dlgOverlay 里的注释）。
   * ⚠️ 刻意不重绘：控件自己的勾选状态已经变了，再 render 会把焦点从刚点的控件上拿走。
   */
  dlgToggle(idx) {
    const d = State.dlg;
    if (!d || d.kind !== 'pick') return;
    const opt = (d.options || [])[Number(idx)];
    if (!opt) return;
    const cur = (d.selected || []).slice();
    if (d.multiple) {
      const at = cur.indexOf(opt.value);
      if (at >= 0) cur.splice(at, 1); else cur.push(opt.value);
    } else {
      cur.length = 0;
      cur.push(opt.value);
    }
    State.dlg = Object.assign({}, d, { selected: cur, error: null });
  },

  /* ── 初始化 / 登录 ── */
  async runSetup() {
    const orgName = ($('#orgName') || {}).value || '';
    const adminUsername = ($('#adminUsername') || {}).value || '';
    const adminPassword = ($('#adminPassword') || {}).value || '';
    const adminDisplayName = ($('#adminDisplayName') || {}).value || '';
    const credName = ($('#credName') || {}).value || '';
    const credProvider = ($('#credProvider') || {}).value || '';
    const credValue = ($('#credValue') || {}).value || '';

    State.busy = true; State.error = null; State.notice = null;
    render();
    try {
      const body = { orgName, adminUsername, adminPassword, adminDisplayName };
      if (credName && credValue) body.credential = { name: credName, provider: credProvider, value: credValue };
      const r = await api('/api/identity/setup', { method: 'POST', body: JSON.stringify(body) });
      State.setup = (await api('/api/identity/setup')).setup;
      State.view = 'login';
      State.notice = '组织「' + r.org.name + '」已建立，内置角色：' + (r.rolesCreated || []).join('、')
        + '。现在用管理员账号登录。'
        + (r.credential ? ' 凭据「' + r.credential.name + '」已加密保存（有值：' + r.credential.hasValue + '）。' : '');
    } catch (e) {
      State.error = e.message;
    } finally {
      State.busy = false; render();
    }
  },

  async login() {
    const username = ($('#loginUser') || {}).value || '';
    const password = ($('#loginPass') || {}).value || '';
    State.busy = true; State.error = null; State.notice = null;
    render();
    try {
      const r = await api('/api/identity/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      // 两步账号：口令对但登录**还没完成** —— 服务端只回一次性票据、不发 Cookie。
      // 这里**绝不能**去拉 /me：此刻还没有任何会话，拉也拉不到，还会把错误显示错。
      if (r && r.twoFactorRequired) {
        State.mfa = { ticket: r.ticket, expiresAt: r.expiresAt };
        State.notice = r.note || '该账号启用了两步验证：请输入验证器上的 6 位动态码。';
        return;   // finally 里会 render 出第二阶段
      }
      State.me = await api('/api/identity/me');
      State.view = 'app';
      State.notice = null;
      render();
      await loadAll();
    } catch (e) {
      State.error = e.status === 401 ? '账号或口令不正确。' : e.message;
    } finally {
      State.busy = false; render();
    }
  },

  /**
   * 两步登录第二步：票据 + 动态码/恢复码 → 会话。
   * 错误文案按状态码分流：401（码不对/票据失效）给一句能行动的话，
   * 其余（429 退避、500）原样透出 —— 那些不是用户敲错什么造成的。
   */
  async loginTotp() {
    const mfa = State.mfa;
    if (!mfa) return;
    const code = ($('#loginTotpCode') || {}).value || '';
    State.busy = true; State.error = null; State.notice = null;
    render();
    try {
      const r = await api('/api/identity/login/totp', {
        method: 'POST', body: JSON.stringify({ ticket: mfa.ticket, code }),
      });
      State.mfa = null;
      State.me = await api('/api/identity/me');
      State.view = 'app';
      // 用恢复码登录要**立即**说清楚：那张码已经烧掉了，剩几张也要报出来 ——
      // 否则用户会以为恢复码还是满的，等真丢设备时才发现不够用。
      State.notice = r.viaRecoveryCode
        ? '已用一张恢复码完成登录（剩余 ' + r.recoveryCodesLeft + ' 张，每张只能用一次）。建议到「我的账号」重新生成一批。'
        : null;
      render();
      await loadAll();
    } catch (e) {
      State.error = e.status === 401 ? '验证码不正确、已用过，或票据已过期。' : e.message;
    } finally {
      State.busy = false; render();
    }
  },

  /** 放弃第二阶段，回账号/口令输入（票据留在服务端自然过期，不必显式作废）。 */
  cancelMfa() {
    State.mfa = null; State.error = null; State.notice = null;
    render();
  },

  async logout() {
    try { await api('/api/identity/logout', { method: 'POST', body: '{}' }); } catch (e) { /* 已经失效也一样继续 */ }
    State.mfa = null; State.me = null; State.view = 'login';
    State.users = State.roles = State.creds = State.apikeys = null;
    State.error = null;
    State.notice = '已登出。';
    render();
  },

  /* ── 加载 ── */
  async loadStatus() {
    try { State.status = await api('/api/system/status'); } catch (e) { State.error = e.message; }
    // 没有"要不要弹引导"这一步了（0.21.4）：内核没接入就是整页拦住，
    // 由 render() 直接判 `State.status.kernel.ready` —— 见 90-start.js。
    render();
  },

  /* ── 内核接入向导（P0）──────────────────────────────────────
   *
   * 三条动作 = 页面上的三步：填 → 检测 → 保存。
   *
   * 为什么"检测"是**独立**一步，而不是保存时顺带做：
   *   接入失败分五类（地址写错 / 连不上 / 要令牌 / 令牌被拒 / 不是内核），
   *   而它们的处置**完全不同**（改地址 vs 查进程 vs 补令牌 vs 换来源 vs 换端口）。
   *   让用户在动手改配置之前就看见是哪一类，比"保存完告诉你没成"省掉一整轮排查。
   *
   * 另有一条纪律：**保存成功 ≠ 内核已可用**。保存可能成功而内核照样连不上
   * （服务端会照切并如实报"不可用"），所以界面照服务端回的 `switched.ready` / `reason` 说话，
   * 不替它乐观。
   */
  async loadKernelStatus() {
    try { State.kernelStatus = await api('/api/kernel/status'); } catch (e) { State.kernelStatus = null; }
    render();
  },

  async kernelProbe() {
    const f = State.kernelForm;
    State.kernelProbeBusy = true;
    State.kernelProbe = null; State.kernelProbeError = null;
    State.kernelSaved = null; State.kernelSaveError = null;
    render();
    try {
      const r = await api('/api/system/kernel/probe', {
        method: 'POST',
        body: JSON.stringify({ origin: f.origin, token: f.token }),
      });
      State.kernelProbe = r.probe;
    } catch (e) {
      State.kernelProbeError = e.message;
    } finally {
      State.kernelProbeBusy = false;
      render();
    }
  },

  async kernelSave() {
    const f = State.kernelForm;
    /**
     * 保存前提：**这一次检测通过了**（0.21.5）。
     *
     * 页面上那个键本来就是灰的，为什么这里还要再拦一道：灰键是"把话说在前面"，
     * 不是防线 —— 键盘回车、脚本、以及"探完 A 又改成 B"都能绕开它。
     * 而服务端同样会拒（它会自己重探一次），所以这里拦下来的意义是
     * **给出人话**：告诉用户为什么没保存，而不是把一个 409 原样丢给 echo 出去。
     */
    if (!State.kernelProbe || !State.kernelProbe.ok) {
      State.kernelSaveError = State.kernelProbe
        ? '没有保存：这次检测的结果是「' + (State.kernelProbe.verdict || '未通过') + '」。'
          + '请按上面的提示处理，重新检测通过后再保存。'
        : '没有保存：还没做检测。先点「检测连接」，检测通过后才能保存并启用。';
      render();
      return;
    }
    State.kernelSaving = true; State.kernelSaved = null; State.kernelSaveError = null;
    render();
    try {
      const r = await api('/api/system/kernel/config', {
        method: 'POST',
        // 不带 `force`：0.21.5 起没有"跳过检测直接保存"这条口子（见 kernelFormHtml）。
        body: JSON.stringify({ origin: f.origin, token: f.token }),
      });
      State.kernelSaved = r;
      if (r.probe) State.kernelProbe = r.probe;
      // 令牌已经加密落到服务端了，浏览器里留一份明文没有任何用处，只有风险。
      State.kernelForm.token = '';
      // ⚠️ 必须**同时**刷 `/api/system/status`：未接入内核时的整页阻断页（pageKernelGate）
      // 判的是 `State.status.kernel.ready`，而它只由 `/api/system/status` 提供
      // （`/api/kernel/status` 给的是 State.kernelStatus，供概览页的接入面板用）。
      // 少刷这一个的后果很具体：用户刚在阻断页上接入成功，却**被永远关在门外** ——
      // 平台明明是好的，他只能刷页面或退出重登。
      await App.loadKernelStatus();
      await App.loadStatus();
      /**
       * 接入成功 ⇒ **当场关掉接入界面、落到首页**（0.21.5）。
       *
       * 为什么只在 `switched.ready` 为真时跳：服务端会把"写盘成功"与"内核当场可用"
       * 分开说 —— 保存成功而内核仍旧连不上是**真实存在的一种结果**（照切、如实报不可用）。
       * 那种情况下阻断页必须继续留着（否则用户会落进一个用不了的工作台），
       * 所以这里不能拿"请求返回 200"当跳转条件，只能拿"内核真的可用"。
       *
       * 为什么用 `defaultRoute()` 而不是写死某一页：阻断页是**整页替换** ——
       * 用户进来时并没有"当前页"，所以没有"回到刚才那页"这回事。
       * 落地页的规则只有一处（见 40-delegate.js：首选工作台，无 session:read 才退回概览），
       * 这里照它落，规则改了这一行不用跟着改。
       */
      if (r.switched && r.switched.ready) {
        const home = defaultRoute();
        if (location.hash !== home.hash) location.hash = home.hash;
      }
    } catch (e) {
      State.kernelSaveError = e.message;
      // 409（检测未通过）会**连同诊断一起**回来 —— 直接用，不再多探测一次。
      const p = e.payload && e.payload.error && e.payload.error.detail && e.payload.error.detail.probe;
      if (p) State.kernelProbe = p;
    } finally {
      State.kernelSaving = false;
      render();
    }
  },

  // 0.21.4：`kernelDismissGuide` / `kernelOpenSetup` 两个动作连同那个可关闭的引导弹窗
  // 一并删掉了。引导弹窗的前提是"平台有个内置内核可以先用着"，而那个内置内核已经删除；
  // 现在没接入就是整页拦住（pageKernelGate），没有"关掉继续用"这条路径。

  async loadRoutes() {
    try { State.routes = await api('/api/system/routes'); } catch (e) { /* 概览页会提示 */ }
    render();
  },
  async loadContract() {
    try { State.contract = await api('/api/system/contract'); } catch (e) { /* ignore */ }
    render();
  },
  async loadMiddleware() {
    try { State.middleware = await api('/api/system/middleware'); } catch (e) { /* ignore */ }
    render();
  },
  async loadUsers() {
    if (!allowed('user', 'read')) { State.users = null; return; }
    try { State.users = await api('/api/identity/users?limit=200'); } catch (e) { State.users = null; }
    render();
  },
  async loadRoles() {
    if (!allowed('role', 'read')) { State.roles = null; return; }
    try { State.roles = await api('/api/identity/roles'); } catch (e) { State.roles = null; }
    render();
  },
  async loadGroups() {
    if (!allowed('group', 'read')) { State.groups = null; return; }
    try { State.groups = await api('/api/identity/groups'); } catch (e) { State.groups = null; }
    render();
  },
  async loadCreds() {
    if (!allowed('credential', 'read')) { State.creds = null; return; }
    try { State.creds = await api('/api/identity/credentials'); } catch (e) { State.creds = null; }
    render();
  },
  /** 部门（组织归属，**不是权限载体**）。与 users 一样需要 read 能力才能拉。 */
  async loadDepartments() {
    if (!allowed('department', 'read')) { State.departments = null; return; }
    try { State.departments = await api('/api/identity/departments'); } catch (e) { State.departments = null; }
    render();
  },
  async loadApiKeys() {
    try { State.apikeys = await api('/api/identity/apikeys'); } catch (e) { State.apikeys = null; }
    render();
  },
  /** 我的两步验证状态（「我的账号」面板用）。不含密钥与恢复码明文 —— 那些只在动作响应里出现一次。 */
  async loadTotp() {
    try { State.totp = await api('/api/identity/totp'); } catch (e) { State.totp = null; }
    render();
  },

  /* ── 治理与审计（M3）── */
  /* ── 能力分发（M4）── */
  async loadCapability() {
    if (!allowed('skill', 'read')) { State.capSkills = null; State.capMcp = null; State.capPolicies = null; return; }
    try { State.capSkills = await api('/api/capability/skills'); } catch (e) { State.capSkills = null; }
    try { State.capMcp = await api('/api/capability/mcp'); } catch (e) { State.capMcp = null; }
    try {
      State.capPolicies = allowed('capability', 'read') ? await api('/api/capability/policies') : null;
    } catch (e) { State.capPolicies = null; }
    render();
  },
  // ⚠️ 0.21.10：`toggleTool` 删除 —— 随"启用/停用工具"端点一起没了
  //    （用户裁定：工具由内核自己调用、不用单独写这个能力、也不会单独列出来有哪些工具）。
  //    这里留一段说明而不是留一个空函数：空函数会让"工具还能被停用"这件事看起来仍然存在。
  //    详见 app/data/migrations/0025_drop_tools.sql 与 81-pages-capability.js 的工具段说明。
  async toggleSkill(name, enabled) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      await api('/api/capability/skills/' + encodeURIComponent(name) + '/enabled',
        { method: 'POST', body: JSON.stringify({ enabled }) });
      State.notice = 'Skill ' + name + (enabled ? ' 已启用' : ' 已停用');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadCapability();
  },
  async checkUpdate(name) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/capability/skills/' + encodeURIComponent(name) + '/check-update', { method: 'POST' });
      const label = { unchanged: '与安装时一致', changed: '⚠ 安装目录被改动过', missing: '⚠ 安装目录已不存在', not_checkable: '无从比对' }[r.status] || r.status;
      State.notice = '更新检测（' + name + '）：' + label + ' —— ' + (r.detail || '');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    render();
  },
  async removeSkill(name) {
    if (!await Dlg.confirm({
      title: '卸载 Skill',
      body: ['卸载「' + name + '」？zip 来源的安装目录会随之一并删除（本机目录引用/导入来源只注销登记、不动目录），不可恢复。',
        '只是暂时不想用它，请改用「停用」—— 停用不动磁盘上的任何内容。'],
      ok: '卸载', danger: true,
    })) return;
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/capability/skills/' + encodeURIComponent(name), { method: 'DELETE' });
      State.notice = '已卸载 Skill「' + name + '」。' + (r.note || '');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadCapability();
  },
  async installSkill() {
    const name = ($('#skill-name') || {}).value || '';
    const file = ($('#skill-zip') || {}).files && ($('#skill-zip').files)[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) { State.error = 'name 只允许字母/数字/点/连字符'; render(); return; }
    if (!file) { State.error = '请选择 Skill 的 ZIP 包'; render(); return; }
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const buf = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const r = await api('/api/capability/skills/install',
        { method: 'POST', body: JSON.stringify({ name, zipBase64: btoa(binary) }) });
      State.notice = 'Skill ' + name + ' 安装成功（' + r.files + ' 个文件已落盘并登记）';
    } catch (e) { State.error = '安装失败：' + e.message; }
    State.busy = false;
    await App.loadCapability();
  },
  async probeMcp(name) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/capability/mcp/' + encodeURIComponent(name) + '/probe', { method: 'POST' });
      const label = { ok: '✓ 可达', error: '✗ 不可达', unknown: '未探测' }[r.health] || r.health;
      State.notice = '探测（' + name + '）：' + label + ' —— ' + (r.detail || '');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadCapability();
  },

  /**
   * 启用/停用 MCP 服务。
   * `enabled` 由事件委托还原成**真布尔**（`data-a2="false"` → `false`）——
   * 所以这里 `!!` 只是防御，不是转换。停用**不删登记**：连接配置与健康历史都留着，
   * 想彻底清掉请用「注销」（那是不可逆的，所以分成两个动作）。
   */
  async setMcpEnabled(name, enabled) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      await api('/api/capability/mcp/' + encodeURIComponent(name), {
        method: 'PATCH', body: JSON.stringify({ enabled: !!enabled }),
      });
      State.notice = (enabled ? '已启用' : '已停用') + ' MCP 服务「' + name + '」'
        + (enabled ? '。' : '（内核不再拉起它；登记记录与健康历史保留）。');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadCapability();
  },

  async removeMcpServer(name) {
    if (!await Dlg.confirm({
      title: '注销 MCP 服务',
      body: ['注销「' + name + '」？它的连接配置密文会一并删除，不可恢复。',
        '如果只是暂时不想用它，请改用「停用」。'],
      ok: '注销', danger: true,
    })) return;
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      await api('/api/capability/mcp/' + encodeURIComponent(name), { method: 'DELETE' });
      State.notice = '已注销 MCP 服务「' + name + '」。';
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadCapability();
  },
  /**
   * 登记 / 重新配置 MCP 服务（0.16.0）：POST /api/capability/mcp 本就是 upsert，
   * 这里补上界面入口。三个坑都在这个方法里挡住：
   *   · 配置必须是合法 JSON（服务端只收对象）；
   *   · 给**已有**服务保存时留空配置 = 清掉它已存的加密配置 —— 必须先确认；
   *   · 名称规则与 Skill 一致（服务端 NAME_RE），这里先挡一轮少跑一趟。
   */
  async registerMcp() {
    const name = (($('#mcp-name') || {}).value || '').trim();
    const transport = (($('#mcp-transport') || {}).value || 'stdio');
    const enabled = !!(($('#mcp-enabled') || {}).checked);
    const rawCfg = (($('#mcp-config') || {}).value || '').trim();
    if (!name) { State.error = '请填写 MCP 服务名称'; render(); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      State.error = '名称只允许字母/数字/点/连字符（1-64 位，字母或数字开头）'; render(); return;
    }
    let config = null;
    if (rawCfg !== '') {
      try { config = JSON.parse(rawCfg); } catch (e) {
        State.error = '连接配置不是合法 JSON：' + e.message; render(); return;
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        State.error = '连接配置必须是 JSON 对象（如 {"command":"…"} 或 {"url":"…"}）'; render(); return;
      }
    } else {
      const known = ((State.capMcp && State.capMcp.registry) || []).some((m) => m.name === name);
      if (known) {
        const go = await Dlg.confirm({
          title: '清除已存配置？',
          body: ['「' + name + '」已登记。这次保存没有填连接配置 —— 同名即覆盖，它已存的配置会被清空，之后探测会如实报"无从探测"。',
            '如果只是想临时停用它，请点列表里的「停用」。'],
          ok: '仍然保存', danger: true,
        });
        if (!go) return;
      }
    }
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const body = { name, transport, enabled };
      if (config !== null) body.config = config;
      await api('/api/capability/mcp', { method: 'POST', body: JSON.stringify(body) });
      State.notice = '已保存 MCP 服务「' + name + '」。'
        + (config !== null ? '连接配置已加密落库（不再回显）。' : '');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadCapability();
  },

  /** 行内「改配置」：把名称/传输填进表单（配置无法回显，让用户填新的整体覆盖）。 */
  editMcpConfig(name, transport) {
    const ni = $('#mcp-name');
    const ts = $('#mcp-transport');
    if (ni) ni.value = name;
    if (ts && transport) ts.value = transport;
    State.notice = '正在重新配置「' + name + '」：已存配置无法回显，填好后整体覆盖保存。';
    render();
    if (ni) { try { ni.focus(); } catch { /* 垫片无焦点 */ } }
  },

  async setBinding() {
    const subjectType = ($('#bind-subjecttype') || {}).value || 'tenant';
    const subjectId = ($('#bind-subjectid') || {}).value || '';
    const capabilityType = ($('#bind-captype') || {}).value || '';
    const capabilityId = ($('#bind-capid') || {}).value || '';
    const allow = (($('#bind-allow') || {}).value || '0') === '1' ? 1 : 0;
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      await api('/api/capability/bindings', {
        method: 'POST',
        body: JSON.stringify({ subjectType, subjectId: subjectId || undefined, capabilityType, capabilityId, allow }),
      });
      State.notice = '绑定已保存（deny 永远赢；契约层与执行面立即生效）';
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadCapability();
  },
  async removeBinding(id) {
    if (!await Dlg.confirm({
      title: '删除策略绑定',
      body: ['删除这条绑定？删除后回到"默认放行 / 登记开关"决定的状态。'],
      ok: '删除', danger: true,
    })) return;
    try { await api('/api/capability/bindings/' + encodeURIComponent(id), { method: 'DELETE' }); State.notice = '已删除'; }
    catch (e) { State.error = e.message; }
    await App.loadCapability();
  },
  /** 行内切换判定（0.16.0）：a2 是当前 allow（'1'/'0'），提交时翻转。 */
  async toggleBinding(id, allow) {
    const cur = String(allow) === '1';
    await guard(async () => {
      const r = await api('/api/capability/bindings/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify({ allow: !cur }),
      });
      await App.loadCapability();
      const nowDeny = r.binding && Number(r.binding.allow) === 0;
      return '判定已切换为 ' + (nowDeny ? 'deny（拦截）' : 'allow（放行）') + ' —— 契约层与执行面立即生效。';
    });
  },
  async exportCaps() {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      State.capExport = await api('/api/capability/export');
      const blob = new Blob([JSON.stringify(State.capExport, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'capabilities-' + (State.capExport.tenant || 'export') + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      State.notice = '已导出（MCP 连接配置不随清单导出 —— 这是脱敏红线，导入端需补配）';
    } catch (e) { State.error = e.message; }
    State.busy = false;
    render();
  },
  async importCaps() {
    const ta = ($('#import-json') || {}).value || '';
    if (!ta.trim()) { State.error = '请粘贴导出的 JSON'; render(); return; }
    let payload;
    try { payload = JSON.parse(ta); } catch (e) { State.error = '不是合法 JSON：' + e.message; render(); return; }
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/capability/import', { method: 'POST', body: JSON.stringify(payload) });
      const i = r.imported || {};
      // ⚠️ 0.21.10：通知里的「工具 N」去掉了 —— 服务端已不再回报 `tools` 计数。
      //    旧导出包里的 tools 段会被静默忽略（见 capability.mjs 的导入处理器），
      //    所以这里也**不该**提它：报一句"工具 0"会让人以为"导了但一个都没进来"。
      State.notice = '导入完成：Skill 装回 ' + (i.skills && i.skills.installed || 0) + '（失败 ' + (i.skills && i.skills.failed ? i.skills.failed.length : 0) + '）｜MCP ' + (i.mcp || 0) + '（需补配连接）｜绑定 ' + (i.bindings || 0);
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadCapability();
  },

  async loadAudit() {
    if (!allowed('audit', 'read')) { State.auditData = null; return; }
    try { State.auditData = await api('/api/governance/audit?limit=200'); } catch (e) { State.auditData = null; }
    render();
  },
  async loadQuotas() {
    if (!allowed('quota', 'read')) { State.quotasData = null; State.usageData = null; State.costData = null; return; }
    try { State.quotasData = await api('/api/governance/quotas'); } catch (e) { State.quotasData = null; }
    try { State.usageData = await api('/api/governance/usage'); } catch (e) { State.usageData = null; }
    // 成本单独取、单独失败：它依赖模型条目上的单价配置，取不到不该把用量一起打掉 ——
    // 用量是客观数（有账可对），成本是估算，两者可用性互不牵连。
    try { State.costData = await api('/api/governance/cost'); }
    catch (e) { State.costData = { error: e.message }; }
    render();
  },
  async loadBackup() {
    if (!allowed('operation', 'read')) { State.backupList = null; return; }
    try { State.backupList = await api('/api/operation/backup'); }
    catch (e) { State.backupList = { items: [], note: '读取失败：' + e.message }; }
    render();
  },
  /**
   * 会话日志页（治理 → 会话日志）的数据源：**会话清单** —— 让人挑要给哪一场导 log.zip。
   *
   * 两个权限档位在这里是**独立**的，不能假装一回事：
   *   · `artifact:read` 是 log.zip / 产物清单的门槛（也是本页的入口门槛）；
   *   · `session:read` 才有会话列表（`GET /api/kernel/sessions`）。
   * 有前者没后者时列出不来会话 —— 页面把这件事说清楚，而不是给一个空表。
   */
  async loadSessionLogs() {
    if (!allowed('artifact', 'read')) { State.sessionLogsData = null; return; }
    if (!allowed('session', 'read')) { State.sessionLogsData = { noSessionRead: true }; return; }
    try { State.sessionLogsData = await api('/api/kernel/sessions?limit=200'); }
    catch (e) { State.sessionLogsData = { error: e.message }; }
    render();
  },
  /**
   * 下载某场会话的 log.zip（全量轨迹：meta.json / session.json / events.jsonl / artifacts.json）。
   *
   * 不能走 `api()`：它只 `json()`，而这里是**二进制 ZIP**。走原始 fetch + `blob()` 落盘 ——
   * 与服务端 `content-disposition: attachment` 的语义一致（浏览到就是下载文件）。
   * 这个动作在服务端会记一条审计（`governance.sessionlog.export`，含事件数/产物数/字节数），
   * 所以回执里如实说"下载会记审计"；ZIP 不在页面里预览，直接落盘。
   */
  async downloadSessionLog(id, title) {
    return guard(async () => {
      const url = '/api/governance/sessions/' + encodeURIComponent(id) + '/log.zip';
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) {
        let j = null;
        try { j = await r.json(); } catch (e) { /* 非 JSON */ }
        const msg = j && j.error ? (j.error.message || j.error.code) : ('HTTP ' + r.status);
        const err = new Error(msg);
        err.status = r.status;
        err.payload = j;
        throw err;
      }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'session-' + id + '-log.zip';
      a.click();
      URL.revokeObjectURL(a.href);
      return '已下载「' + (title || id) + '」的会话日志 ZIP（' + fmtN(blob.size) + ' 字节）——'
        + '快照不是备份：导出后该会话再发生的事不在包里。此次导出已在服务端记审计。';
    });
  },
  async loadSettings() {
    if (!allowed('system', 'read')) { State.settings = null; return; }
    try { State.settings = await api('/api/system/settings'); } catch (e) { State.settings = null; }
    render();
  },
  /** 保存平台设置（0.16.0）：收集页面上全部未锁定的键整体提交；env 锁定项由服务端兜底拒绝。 */
  async saveSettings() {
    const items = ((State.settings || {}).settings) || [];
    const patch = {};
    for (const s of items) {
      if (!s || s.envLocked) continue;
      const el = $('#st-' + s.key);
      if (!el) continue;
      if (s.type === 'boolean') { patch[s.key] = !!el.checked; continue; }
      if (s.type === 'number') {
        const n = Number(el.value);
        if (!Number.isFinite(n)) { State.error = '「' + (s.label || s.key) + '」必须是数字'; render(); return; }
        patch[s.key] = n;
        continue;
      }
      patch[s.key] = el.value;
    }
    await guard(async () => {
      const r = await api('/api/system/settings', { method: 'PUT', body: JSON.stringify({ settings: patch }) });
      await App.loadSettings();
      return '已保存 ' + ((r.updated || []).length) + ' 项到 config.json —— 重启服务后生效。';
    });
  },
  async createBackup() {
    State.busy = true; State.error = null; render();
    try {
      State.backupResult = await api('/api/operation/backup', { method: 'POST' });
      State.notice = '备份已创建：' + State.backupResult.file;
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadBackup();
  },
  async verifyBackup(file) {
    const name = file || (($('#bk-file') || {}).value || '').trim();
    if (!name) { State.error = '请填写要校验的备份文件名'; render(); return; }
    State.busy = true; State.error = null; render();
    try {
      State.backupVerify = await api('/api/operation/backup/verify',
        { method: 'POST', body: JSON.stringify({ file: name }) });
      State.notice = State.backupVerify.ok ? '校验通过' : '校验未通过（见问题清单）';
    } catch (e) { State.error = e.message; State.backupVerify = null; }
    State.busy = false;
    render();
  },
  async deleteBackup(file) {
    const name = String(file || '').trim();
    if (!name) return;
    if (!await Dlg.confirm({
      title: '删除备份文件',
      body: ['删除「' + name + '」？删除不可逆 —— 删了就没了，没有回收站。',
        '若它带同名一次性密钥（.key），会随包一并删除。平台护栏：只删本平台产出的 backup-*.zip，且绝不会删掉最后一份备份。'],
      ok: '删除', danger: true,
    })) return;
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/operation/backup/' + encodeURIComponent(name), { method: 'DELETE' });
      State.notice = '已删除备份「' + r.name + '」，释放 ' + fmtBytes(r.bytes)
        + (r.freedKey ? '（含一次性密钥侧车）' : '') + '；目录内还剩 ' + r.remaining + ' 份。';
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadBackup();
  },
  /* ── 模型中心（P1-1）── */
  async loadModels() {
    if (!allowed('model', 'read')) { State.models = null; return; }
    try { State.models = await api('/api/model/providers'); }
    catch (e) { State.models = null; }
    render();
  },
  /**
   * 新建表单里切换用途。协议的可选值随用途变化（对话不能选 ollama 的向量接口），
   * 所以这里必须**重渲染**把下拉换成合法集合 —— 只在客户端"提示一下"然后让服务端去拒，
   * 是让人白填一遍。
   */
  switchModelKind(kind) {
    State.modelKind = kind === 'embedding' ? 'embedding' : 'chat';
    render();
  },
  async createModel() {
    const val = (id) => (($('#' + id) || {}).value || '').trim();
    const dflt = $('#md-default');
    const body = {
      name: val('md-name'),
      kind: State.modelKind,
      protocol: val('md-protocol'),
      baseUrl: val('md-base'),
      model: val('md-model'),
      credentialName: val('md-cred'),
      label: val('md-label'),
      priority: Number(val('md-priority') || 100),
      isDefault: dflt ? !!dflt.checked : false,
    };
    // 单价：**留空就一个字都不发**（后端据此写 NULL = 未定价）。
    // 绝不能把空串变成 0 —— 0 是"免费"，null 是"不知道"，这两个数在成本报告里天差地别。
    Object.assign(body, priceFieldsFromForm('md-'));
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/model/providers', { method: 'POST', body: JSON.stringify(body) });
      State.notice = '已登记模型条目：' + r.provider.name
        + (r.provider.priced ? '' : '（未配单价：该条目产生的用量在成本报告里金额为「未定价」，不是 0）');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadModels();
  },

  /**
   * 改一条模型条目的单价（P1-3）。
   *
   * 只发单价相关的键 —— 服务端的 `updateProvider` 会把"现值 + 补丁"拼齐再校验，
   * 所以这里**不需要**把整条条目回传。回传整条反而危险：页面上没渲染的字段
   * （比如凭据名）会以空串覆盖掉真值。
   */
  async setModelPrice(id) {
    const body = priceFieldsFromForm('mp-' + id + '-');
    const cur = (State.models && (State.models.providers || []).find((p) => p.id === id)) || {};
    const willClear = body.currency === '' && ['priceInMinor', 'priceCacheReadMinor', 'priceCacheWriteMinor', 'priceOutMinor']
      .every((k) => body[k] === '');
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/model/providers/' + encodeURIComponent(id),
        { method: 'PUT', body: JSON.stringify(body) });
      State.notice = '已更新「' + r.provider.name + '」的单价：'
        + (r.provider.priced
          ? (r.provider.currency + ' 每百万 token：输入 ' + fmtUnitPrice(r.provider.priceInMinor)
            + ' / 缓存读 ' + fmtUnitPrice(r.provider.priceCacheReadMinor)
            + ' / 缓存写 ' + fmtUnitPrice(r.provider.priceCacheWriteMinor)
            + ' / 输出 ' + fmtUnitPrice(r.provider.priceOutMinor))
          : '已清空 → 该条目回到「未定价」（金额显示为「未定价」，不是 0）')
        // 这条提醒比"改价生效了"重要得多，而且容易被想反：
        // 金额**不是**在用量产生时算好存下来的，而是每次按**当前**单价重算 ——
        // 所以改价会让历史用量的金额一起变。这才是"单价不追溯"的真实含义，必须说出来。
        + (r.provider.priced && cur.priced
          ? '　⚠️ 单价不追溯、也不快照：金额每次都按当前单价重算，因此改价会让历史用量的金额一起变。要留证请在改价前先导出。'
          : '');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadModels();
    // 成本面板里的金额是按单价算的 —— 改完价必须把面板也刷一遍，
    // 否则会出现"上面写着 ¥12.30，我刚把价改成 0，下面还是 ¥12.30"。
    if (allowed('quota', 'read')) await App.loadQuotas();
  },

  /**
   * 编辑模型条目主字段（0.16.0）：名称 / 协议 / 地址 / 模型名 / 凭据名 / 降级序号 / 备注。
   * PUT /api/model/providers/:id 是"现值+补丁合并后再校验"，因此表单**全量提交**
   * （含用户清空的字段 —— 清空凭据名就是解除关联，是有效动作，不能当"没改"跳过）。
   */
  async updateModel(id) {
    const read = (k) => { const el = $('#me-' + id + '-' + k); return el ? el.value : null; };
    const p = ((State.models && State.models.providers) || []).find((x) => x.id === id);
    if (!p) return;
    const name = (read('name') || '').trim();
    const priority = Number(read('priority'));
    if (!name) { State.error = '名称不能为空'; render(); return; }
    if (!Number.isFinite(priority) || priority < 0) {
      State.error = '降级序号必须是不小于 0 的数字'; render(); return;
    }
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/model/providers/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify({
          name,
          protocol: read('protocol') || p.protocol,
          baseUrl: (read('baseUrl') || '').trim(),
          model: (read('model') || '').trim(),
          credentialName: (read('credentialName') || '').trim(),
          priority,
          label: (read('label') || '').trim(),
        }),
      });
      State.notice = '已更新「' + r.provider.name + '」。'
        + (r.provider.enabled ? '' : '该条目当前是停用状态 —— 停用的条目不进降级链。');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadModels();
  },

  async probeModel(id) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/model/providers/' + encodeURIComponent(id) + '/probe',
        { method: 'POST', body: '{}' });
      State.modelProbe = r;
      const v = r.verdict || {};
      // 结论照抄服务端：ok=false 时 message 里就有真实原因（超时/鉴权/不可达）
      State.notice = '探活「' + r.name + '」：' + (v.message || '（无结论）');
    } catch (e) { State.error = e.message; State.modelProbe = null; }
    State.busy = false;
    await App.loadModels();
  },
  async setModelDefault(id) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/model/providers/' + encodeURIComponent(id) + '/default', { method: 'POST', body: '{}' });
      State.notice = '已设为「' + r.provider.kind + '」的默认：' + r.provider.name;
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadModels();
  },
  async toggleModel(id, enabled) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/model/providers/' + encodeURIComponent(id) + '/enabled',
        { method: 'POST', body: JSON.stringify({ enabled }) });
      // 服务端在"停用顺带撤掉默认"时会带回 note；必须显示出来 ——
      // 不显示的话，运维会以为关一下再开一下什么都没变。
      State.notice = (enabled ? '已启用：' : '已停用：') + r.provider.name + (r.note ? '　⚠️ ' + r.note : '');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadModels();
  },
  async deleteModel(id, name) {
    if (!await Dlg.confirm({
      title: '删除模型条目',
      body: ['确定删除「' + name + '」？该条目上的默认与链位置一并消失。'],
      ok: '删除', danger: true,
    })) return;
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/model/providers/' + encodeURIComponent(id), { method: 'DELETE' });
      State.notice = '已删除：' + r.deleted + (r.note ? '（' + r.note + '）' : '');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadModels();
  },

  /* ── 调度中心（P1-2）────────────────────────────────────── */
  async loadSchedules() {
    // 与其它 loader 同一纪律：无读权限时**连请求都不发**。
    // 少了这一句，viewer 每次登录都会打出两个注定 403 的请求 —— 页面看起来没坏，
    // 但服务端会把它记成"有人越权访问"，把审计信噪比搞坏。
    if (!allowed('schedule', 'read')) { State.schedules = null; return; }
    try { State.schedules = await api('/api/schedule/jobs'); }
    catch (e) { State.schedules = { jobs: [], status: {}, error: e.message }; }
    // 必须重渲染：动作（创建/执行/启停/删除）都是"先 render 出忙碌态 → 等接口 → 写 notice"，
    // 少了这一句，`State.notice` 永远画不出来 —— 用户看到的是"点了没反应"。
    // 其它 loader（loadModels / loadAudit / loadBackup …）都有这一句，这是同一纪律。
    render();
  },
  async runJob(id, name) {
    if (!await Dlg.confirm({
      title: '立即执行一次',
      body: ['立即执行「' + name + '」一次？它会真的干活（例如做一次备份或归档），不是演练。'],
      ok: '立即执行',
    })) return;
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/schedule/jobs/' + encodeURIComponent(id) + '/run', { method: 'POST' });
      State.scheduleRun = { name, status: r.status, detail: r.detail || {} };
      // 结果里带 status 而不是 HTTP 状态码 —— 任务"跑了但失败"与"没跑成"是两件事，
      // 这里照抄服务端的结论，不自己判断成没成。
      State.notice = '「' + name + '」执行结束：' + r.status + '（' + JSON.stringify(r.detail || {}).slice(0, 160) + '）';
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadSchedules();
  },
  async tickNow() {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/schedule/tick', { method: 'POST' });
      const t = r.tick || {};
      State.notice = '调度扫描完成：到期 ' + (t.due || 0) + ' 个，执行 ' + (t.ran || 0) + ' 个，失败 ' + (t.failed || 0) + ' 个'
        + (t.skipped ? '（本轮跳过：' + t.reason + '）' : '');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadSchedules();
  },
  async toggleJob(id, enabled) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/schedule/jobs/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify({ enabled: enabled }),
      });
      State.notice = '已' + (enabled ? '启用' : '停用') + '：' + r.job.name + '（下次执行 ' + (r.job.nextRunAt || '—') + '）';
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadSchedules();
  },
  /**
   * 行内编辑任务（0.18.0）：PUT 是部分更新，但表单按"全量提交"处理 ——
   * 输入框里预填的就是现值，用户没动过的字段提交现值等于没改；被清空的字段
   * （含 params）也照发：清空 params = 回到执行体内置默认，是有效动作不是"没改"。
   */
  async saveJob(id) {
    // ⚠️ 与 createJob 同一纪律：必须在 render() **之前**读表单（render 重建 DOM）。
    const v = (k) => { const el = $('#je-' + id + '-' + k); return el ? el.value : null; };
    const name = (v('name') || '').trim();
    if (!name) { State.error = '任务名不能为空'; render(); return; }
    const body = { name, kind: v('kind'), schedule: (v('schedule') || '').trim(), params: {} };
    const paramsRaw = (v('params') || '').trim();
    if (paramsRaw) {
      // 坏 JSON 必须**当场拦住并说清原因**，不能发出去让服务端报"params 必须是一个对象" ——
      // 那句话对着一串手滑打坏的文字毫无帮助，用户不知道错在第几个字符。
      try { body.params = JSON.parse(paramsRaw); }
      catch (e) { State.error = '参数不是合法 JSON：' + e.message; State.notice = null; render(); return; }
    }
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/schedule/jobs/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify(body),
      });
      State.notice = '已保存「' + r.job.name + '」：规则 ' + r.job.schedule
        + '，下次执行 ' + (r.job.nextRunAt || '—') + (r.job.enabled ? '' : '（当前是停用状态）');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadSchedules();
  },
  async createJob() {
    const v = (id) => (($('#' + id) || {}).value || '').trim();
    // ⚠️ 必须在 render() **之前**读表单：render 会重建 DOM，输入框被重置为空，
    //    先 render 再读等于把用户刚填的内容全部丢掉（真机浏览器验收 S17 抓到）。
    const body = { name: v('job-name'), kind: v('job-kind'), schedule: v('job-schedule'), params: {} };
    const paramsRaw = v('job-params');
    if (paramsRaw) {
      // 坏 JSON 给可见错误，不能让 JSON.parse 的异常直接冒泡 —— 那是一条无人接住的
      // Promise 异常：页面上没有任何变化，用户只会以为"点了没反应"。
      try { body.params = JSON.parse(paramsRaw); }
      catch (e) { State.error = '参数不是合法 JSON：' + e.message; render(); return; }
    }
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      await api('/api/schedule/jobs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      State.notice = '已创建任务：' + body.name;
    } catch (e) { State.error = '创建失败：' + e.message; }
    State.busy = false;
    await App.loadSchedules();
  },
  async deleteJob(id, name) {
    if (!await Dlg.confirm({
      title: '删除任务',
      body: ['删除任务「' + name + '」？它的历史执行结果会随行消失（审计链里仍有记录）。'],
      ok: '删除', danger: true,
    })) return;
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/schedule/jobs/' + encodeURIComponent(id), { method: 'DELETE' });
      State.notice = '已删除：' + r.deleted;
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadSchedules();
  },

  /* ── 通知渠道（P1-2）────────────────────────────────────── */
  async loadNotify() {
    if (!allowed('notify', 'read')) { State.notifyData = null; State.deliveries = null; return; }
    try {
      // 两个请求一起发：渠道清单是**配置**，失败队列是**运维要看的那个数**。
      // 队列刻意不并进 /channels 的响应里 —— 它随重投实时变化，不该让"配置"跟着一起抖。
      const [ch, dl] = await Promise.all([
        api('/api/notify/channels'),
        api('/api/notify/deliveries?status=all&limit=100'),
      ]);
      State.notifyData = ch;
      State.deliveries = dl;
    } catch (e) {
      State.notifyData = { channels: [], status: {}, error: e.message };
      State.deliveries = null;
    }
    render();     // 与 loadSchedules 同一理由：不重渲染则动作反馈（notice）永远不可见
  },
  async createChannel() {
    const v = (id) => (($('#' + id) || {}).value || '').trim();
    // 事件清单从页面数据取（服务端下发哪些就可订阅哪些），不再硬编码 ——
    // 硬编码那份一旦服务端加了事件，页面上根本不会出现它的复选框。
    // id 经 notifyEventInputId 净化：事件名里的点在 querySelector 里会被解析成 class（见该函数注释）。
    const events = (((State.notifyData || {}).status || {}).events || [])
      .filter((e) => { const el = $('#' + notifyEventInputId('nc-e-', e)); return el && el.checked; });
    // ⚠️ 必须在 render() **之前**读表单：render 会重建 DOM，输入框被重置为空，
    //    先 render 再读等于把用户刚填的内容全部丢掉（真机浏览器验收 S18 抓到）。
    const ncName = v('nc-name');
    const ncUrl = v('nc-url');
    const ncCred = v('nc-cred');
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      await api('/api/notify/channels', {
        method: 'POST',
        body: JSON.stringify({
          name: ncName, kind: 'webhook', url: ncUrl,
          credentialName: ncCred, events,
        }),
      });
      // 服务端只回 host，不回显完整 URL —— 这里也照抄这句话，别让用户以为是我们藏了
      State.notice = '已登记渠道：' + ncName + '（URL 已加密落库；接口只回显 host）';
    } catch (e) { State.error = '登记失败：' + e.message; }
    State.busy = false;
    await App.loadNotify();
  },
  async testChannel(id, name) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/notify/channels/' + encodeURIComponent(id) + '/test', { method: 'POST' });
      State.notifyTest = { name, result: r.result };
      // 试发失败**不是**接口失败：结论在 result 里，照实显示。
      State.notice = r.result.ok
        ? '「' + name + '」试发成功（HTTP ' + r.result.status + '，尝试 ' + r.result.attempts + ' 次）'
        : '「' + name + '」试发失败：' + (r.result.error || ('HTTP ' + r.result.status)) + '（尝试 ' + r.result.attempts + ' 次）';
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadNotify();
  },
  async toggleChannel(id, enabled) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      // url 留空 = 不改动（避免"一保存就把密钥清掉"这个经典坑）
      await api('/api/notify/channels/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify({ enabled: enabled }),
      });
      State.notice = '已' + (enabled ? '启用' : '停用');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadNotify();
  },
  /**
   * 行内编辑渠道（0.18.0）：PUT 是部分更新，表单只提交"名字 + 订阅事件"。
   * URL **只有填了才提交** —— 留空 = 不改动，与 toggleChannel 同一条语义：
   * 服务端不回显完整 URL（常内嵌 token），表单就永远不可能把它填回来，
   * 提交空串等于把密钥清掉 —— 那是最难发现的一种"保存即破坏"。
   */
  async saveChannel(id) {
    // ⚠️ 与 createChannel 同一纪律：必须在 render() **之前**读表单（render 重建 DOM）。
    const prefix = 'ce-' + id + '-';
    const name = (($('#' + prefix + 'name') || {}).value || '').trim();
    const url = (($('#' + prefix + 'url') || {}).value || '').trim();
    const events = (((State.notifyData || {}).status || {}).events || [])
      .filter((e) => { const el = $('#' + notifyEventInputId(prefix, e)); return el && el.checked; });
    if (!name) { State.error = '渠道名不能为空'; render(); return; }
    const body = { name, events };
    if (url) body.url = url;
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/notify/channels/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify(body),
      });
      State.notice = '已保存渠道「' + (r.channel ? r.channel.name : name) + '」：订阅 ' + events.length + ' 个事件；'
        + (url ? 'URL 已更新（加密落库，页面仍只回显 host）' : 'URL 未改动');
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadNotify();
  },
  async deleteChannel(id, name) {
    if (!await Dlg.confirm({
      title: '删除通知渠道',
      body: ['删除通知渠道「' + name + '」？之后这些事件不会再出站。'],
      ok: '删除', danger: true,
    })) return;
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/notify/channels/' + encodeURIComponent(id), { method: 'DELETE' });
      State.notice = '已删除：' + r.deleted;
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadNotify();
  },
  async redeliver(id) {
    State.busy = true; State.error = null; State.notice = null; render();
    try {
      const r = await api('/api/notify/deliveries/' + encodeURIComponent(id) + '/redeliver', { method: 'POST' });
      // 与试发同一条判断：**投递没成功不是接口失败** —— 请求本身处理成功了，结论在 result 里。
      State.notice = r.result.status === 'delivered'
        ? '重投成功（HTTP ' + r.result.httpStatus + '）'
        : '重投仍未成功：' + (r.result.error || ('HTTP ' + r.result.status))
          + '（已重投 ' + r.delivery.attempts + ' 次'
          + (r.wasDead ? '；这条原本是死信' : '') + '，会继续按退避重投）';
    } catch (e) { State.error = '重投失败：' + e.message; }
    State.busy = false;
    await App.loadNotify();
  },

  async verifyAudit() {
    State.busy = true; render();
    try {
      const r = await api('/api/governance/audit/verify', { method: 'POST' });
      State.auditVerify = r.verify;
      State.notice = r.note;
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadAudit();
  },
  async filterAudit() {
    const action = ($('#audit-f-action') || {}).value || '';
    const result = ($('#audit-f-result') || {}).value || '';
    const qs = '?limit=200' + (action ? '&action=' + encodeURIComponent(action) : '') + (result ? '&result=' + encodeURIComponent(result) : '');
    try { State.auditData = await api('/api/governance/audit' + qs); } catch (e) { /* 保留旧数据 */ }
    render();
  },
  async upsertQuota() {
    const subjectType = ($('#q-subjecttype') || {}).value || 'tenant';
    const subjectId = ($('#q-subjectid') || {}).value || '';
    const metric = ($('#q-metric') || {}).value || '';
    const period = ($('#q-period') || {}).value || 'month';
    const mode = ($('#q-mode') || {}).value || 'block';
    const limitValue = Number(($('#q-limit') || {}).value);
    if (!metric || !(limitValue > 0)) { State.error = '请填写 metric 与大于 0 的上限'; render(); return; }
    State.busy = true; render();
    try {
      await api('/api/governance/quotas', { method: 'POST', body: JSON.stringify({ subjectType, subjectId, metric, period, mode, limitValue }) });
      State.error = null; State.notice = '配额已保存';
    } catch (e) { State.error = e.message; }
    State.busy = false;
    await App.loadQuotas();
  },
  async removeQuota(id) {
    if (!await Dlg.confirm({
      title: '删除配额规则',
      body: ['删除这条配额规则？删除后该维度不再受限（不再有告警，也不再拦截）。'],
      ok: '删除', danger: true,
    })) return;
    try { await api('/api/governance/quotas/' + encodeURIComponent(id), { method: 'DELETE' }); State.notice = '已删除'; }
    catch (e) { State.error = e.message; }
    await App.loadQuotas();
  },
  /** 行内编辑配额（0.16.0）：读行内编辑器的 limit/mode/enabled，身份字段不提交。 */
  async updateQuota(id) {
    const limitEl = $('#qe-' + id + '-limit');
    const modeEl = $('#qe-' + id + '-mode');
    const enabledEl = $('#qe-' + id + '-enabled');
    const limitValue = Number(limitEl ? limitEl.value : NaN);
    if (!(limitValue > 0)) { State.error = '上限必须填大于 0 的数字'; render(); return; }
    await guard(async () => {
      await api('/api/governance/quotas/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify({
          limitValue,
          mode: modeEl ? modeEl.value : undefined,
          enabled: enabledEl ? !!enabledEl.checked : undefined,
        }),
      });
      await App.loadQuotas();
      return '配额规则已更新。';
    });
  },

  /* ── 知识库（M2）── */
  async loadKnowledge() {
    if (!allowed('knowledge', 'read')) { State.kbStatus = null; State.bases = null; return; }
    try { State.kbStatus = await api('/api/knowledge/status'); } catch (e) { State.kbStatus = null; }
    try {
      const r = await api('/api/knowledge/bases');
      State.bases = r.bases || [];
      // 当前选中的库若已不存在（被别人删了），不要继续显示它的文档
      if (State.currentBase && !State.bases.some((b) => b.id === State.currentBase)) {
        State.currentBase = null; State.documents = null; State.chunks = null;
      }
      if (!State.currentBase && State.bases.length) State.currentBase = State.bases[0].id;
    } catch (e) { State.bases = null; }
    if (State.currentBase) {
      try {
        State.documents = await api('/api/knowledge/bases/' + encodeURIComponent(State.currentBase) + '/documents?limit=200');
      } catch (e) { State.documents = null; }
    } else {
      State.documents = null;
    }
    await App.loadBaseGrants(State.currentBase);
    render();
  },

  /**
   * 当前库的**库级授权名单**（体检 §B9）。
   *
   * ⚠️ 这一处的权限口径与全站别处都不一样，是本面板存在的前提：
   * 接口的门是 `knowledge:read`，但**判定在服务层**（`assertBaseAccess(…, 'write')`）——
   * 所以"能不能列/改这份名单"= 你在**这个库**上有没有 write 档，
   * 而**不是**"你全局有没有 `knowledge:write`"。
   *
   * 前端的 `allowed()` 只看**租户级**角色，因此这里**不做预判**：
   * 若拿 `allowed('knowledge','write')` 去预先禁用，会把"全局是 viewer、本库被授成 admin"
   * 的**库级管理员**挡在门外 —— 而他恰恰是这个面板唯一的服务对象。
   * 正确做法是直接调，把服务端的结论原样落下（`ok:false` + 原因），由页面如实呈现。
   */
  async loadBaseGrants(kbId) {
    if (!kbId || !allowed('knowledge', 'read')) { State.baseGrants = null; return; }
    try {
      const r = await api('/api/knowledge/bases/' + encodeURIComponent(kbId) + '/grants');
      State.baseGrants = { kbId, ok: true, items: r.grants || [] };
    } catch (e) {
      State.baseGrants = { kbId, ok: false, reason: e.message, status: e.status || 0 };
    }
  },

  /** 在**当前库**上给某主体授一个库级角色。角色下拉的取值来自服务端角色表，不接受手填。 */
  async grantBaseAccess() {
    const kb = State.currentBase;
    if (!kb) return;
    const subjectType = State.grantSubjectType === 'group' ? 'group' : 'user';
    const subjectId = ($('#grant-subject') || {}).value || '';
    const roleKey = ($('#grant-role') || {}).value || '';
    if (!subjectId) { State.error = '请选择要授权的' + (subjectType === 'group' ? '用户组' : '成员') + '。'; render(); return; }
    if (!roleKey) { State.error = '请选择要授的角色。'; render(); return; }
    const who = grantSubjectLabel(subjectType, subjectId, grantSubjectName(subjectType, subjectId));
    await guard(async () => {
      await api('/api/knowledge/bases/' + encodeURIComponent(kb) + '/grants', {
        method: 'POST',
        body: JSON.stringify({ subjectType, subjectId, roleKey }),
      });
      await App.loadBaseGrants(kb);
      App.wbInvalidate(); // 授权可能改变"我"对这个 restricted 库的可见性 —— 工作台列表要跟上
      return '已授权：' + who + ' 在本库成为「' + roleName(roleKey) + '」。'
        + '（这是他在本库的档位，不影响他在别处或全局的角色。）';
    });
  },

  /**
   * 撤销一条库级授权。
   * `label` 只是给人看的一句话（确认框与结果提示里用），真正下发的只有 bindingId ——
   * 服务层还会再验一次"这条绑定属于本库"，防的是"拿 A 库的 write 去撤 B 库的权"。
   */
  async revokeGrant(bindingId, label) {
    const kb = State.currentBase;
    if (!kb) return;
    if (!await Dlg.confirm({
      title: '撤销库级授权',
      body: ['撤销 ' + label + ' 在本库上的授权？',
        '撤权后他立即回到"看不见这个库"，不残留。'],
      ok: '撤销授权', danger: true,
    })) return;
    await guard(async () => {
      await api('/api/knowledge/bases/' + encodeURIComponent(kb) + '/grants/' + encodeURIComponent(bindingId),
        { method: 'DELETE' });
      await App.loadBaseGrants(kb);
      App.wbInvalidate(); // 撤了自己的授权会让库从工作台消失（撤别人的不影响自己，但重拉无成本）
      return '已撤销：' + label + '。';
    });
  },

  /** 切换授权表单的主体类型（成员 / 用户组）—— 候选下拉随之重渲染。 */
  switchGrantSubjectType(v) {
    State.grantSubjectType = v === 'group' ? 'group' : 'user';
    render();
  },

  async createBase() {
    const name = ($('#kb-name') || {}).value || '';
    // 可见性在建库时就能定（默认"全组织可见"）。服务端会校验取值，
    // 打错/非法值会 400 而不是静默建成公开库。
    const visibility = ($('#kb-visibility') || {}).value || 'tenant';
    await guard(async () => {
      const r = await api('/api/knowledge/bases', { method: 'POST', body: JSON.stringify({ name, visibility }) });
      State.currentBase = r.base.id;
      await App.loadKnowledge();
      App.wbInvalidate(); // 工作台的知识库条要能看到新库（不然用户建完库回去发现"没有可见的知识库"）
      return r.base.visibility === 'restricted'
        ? '知识库「' + r.base.name + '」已创建（受限：目前只有管理员可见，需给成员授权后他们才能看到）。'
        : '知识库「' + r.base.name + '」已创建。现在可以导入文档了。';
    });
  },

  async selectBase(id) {
    State.currentBase = id;
    State.chunks = null; State.previewDoc = null; State.search = null;
    // 立刻丢掉上一个库的授权名单：不等 `loadBaseGrants` 回来就重渲染时，
    // 旧名单会短暂显示在**新库**的面板里 —— 授权名单是不可出错的信息。
    State.baseGrants = null;
    await App.loadKnowledge();
  },

  async deleteBase(id, name) {
    if (!await Dlg.confirm({
      title: '删除知识库',
      body: ['删除知识库「' + name + '」？',
        '它下面的全部文档、分块与向量都会一并删除，且不可恢复。'],
      ok: '删除知识库', danger: true,
    })) return;
    await guard(async () => {
      const r = await api('/api/knowledge/bases/' + encodeURIComponent(id), { method: 'DELETE' });
      if (State.currentBase === id) { State.currentBase = null; State.documents = null; }
      await App.loadKnowledge();
      App.wbInvalidate(); // 挂着这个库的会话在新回合里会被 ACL 丢弃 —— 工作台列表必须跟上
      return '已删除知识库「' + name + '」（连同 ' + r.documents + ' 个文档、' + r.chunks + ' 个分块）。';
    });
  },

  /**
   * 改知识库名。
   * 用弹层而不是行内编辑：改名是低频动作，为它引入一套"就地编辑"的状态机
   * （进入编辑 → 校验 → 提交 → 回滚）不划算，且行内编辑在重绘时容易丢输入。
   * 取消（null）与"改成空/没改"都**不发请求** —— 空名会被服务端拒，没必要走一趟。
   */
  async renameBase(id, name) {
    const next = await Dlg.prompt({
      title: '重命名知识库',
      label: '知识库名称',
      value: name, required: true, ok: '保存',
      validate: (v) => (v.length > 80 ? '名称最多 80 个字符' : null),
    });
    if (next === null) return;
    const clean = String(next).trim();
    if (!clean || clean === name) return;
    await guard(async () => {
      const r =       await api('/api/knowledge/bases/' + encodeURIComponent(id), {
        method: 'PATCH', body: JSON.stringify({ name: clean }),
      });
      await App.loadKnowledge();
      App.wbInvalidate(); // 工作台知识库条显示的是库名
      return '知识库已改名为「' + r.base.name + '」。';
    });
  },

  async importFile() {
    const el = $('#kb-file');
    const file = el && el.files && el.files[0];
    if (!file) { State.error = '请先选择一个文件。'; render(); return; }
    await guard(async () => {
      const contentBase64 = await readFileBase64(file);
      const r = await api('/api/knowledge/documents', {
        method: 'POST',
        body: JSON.stringify({
          kbId: State.currentBase, filename: file.name, mime: file.type || '', contentBase64,
        }),
      });
      return describeImport(r);
    });
    // 成功与失败都要刷新：失败时那条 failed 文档必须出现在列表里（带着原因）
    await App.loadKnowledge();
  },

  async importText() {
    const title = ($('#kb-doc-title') || {}).value || '';
    const text = ($('#kb-text') || {}).value || '';
    if (!text.trim()) { State.error = '文本是空的。'; render(); return; }
    await guard(async () => {
      const r = await api('/api/knowledge/documents', {
        method: 'POST',
        body: JSON.stringify({ kbId: State.currentBase, text, title, filename: (title || 'pasted') + '.txt' }),
      });
      return describeImport(r);
    });
    await App.loadKnowledge();
  },

  async previewChunks(docId) {
    try {
      State.chunks = await api('/api/knowledge/documents/' + encodeURIComponent(docId) + '/chunks?limit=50');
      State.previewDoc = docId;
      State.error = null;
    } catch (e) { State.error = '读取分块失败：' + e.message; }
    render();
  },

  closeChunks() { State.chunks = null; State.previewDoc = null; render(); },

  async deleteDocument(docId) {
    // 弹层里带上**文档标题**：列表里同一屏可能有好几个"删除"，只写"这个文档"
    // 会让人不敢点（或点错）。标题从已加载的文档列表里取，取不到就退回 id。
    // ⚠️ 形状是 `{items,...}`（loadKnowledge 原样存的是 API 响应）—— 早先这里读的
    //    是 `documents`，永远取不到标题、注释里的承诺从未生效，回归用例钉住这条。
    const doc = ((State.documents || {}).items || []).find((d) => d.id === docId);
    const what = doc && doc.title ? '「' + doc.title + '」' : '这个文档';
    if (!await Dlg.confirm({
      title: '删除文档',
      body: ['删除' + what + '？',
        '连同它的全部分块与向量一并移除，不可恢复。'],
      ok: '删除', danger: true,
    })) return;
    await guard(async () => {
      const r = await api('/api/knowledge/documents/' + encodeURIComponent(docId), { method: 'DELETE' });
      if (State.previewDoc === docId) { State.chunks = null; State.previewDoc = null; }
      await App.loadKnowledge();
      return '已删除文档（移除 ' + r.chunksRemoved + ' 个分块）。';
    });
  },

  /**
   * 改文档标题（只动显示字段，不重新解析）。
   * 弹层而不是行内编辑（与改库名同理：低频动作，行内编辑容易在重绘时丢输入）。
   * 取消（null）与"改成空/没改"都**不发请求**；上限 300 与服务端一致
   * （与导入时 `.slice(0, 300)` 同口径）—— 免得"导入能过、改名嫌长"。
   */
  async renameDocument(docId, title) {
    const next = await Dlg.prompt({
      title: '重命名文档',
      label: '文档标题',
      value: title, required: true, ok: '保存',
      validate: (v) => (v.length > 300 ? '标题最多 300 个字符' : null),
    });
    if (next === null) return;
    const clean = String(next).trim();
    if (!clean || clean === title) return;
    await guard(async () => {
      const r = await api('/api/knowledge/documents/' + encodeURIComponent(docId), {
        method: 'PATCH', body: JSON.stringify({ title: clean }),
      });
      await App.loadKnowledge();
      return '文档已改名为「' + r.document.title + '」。';
    });
  },

  async runSearch() {
    const query = ($('#kb-q') || {}).value || '';
    const limit = Number(($('#kb-limit') || {}).value || 10);
    // 预过滤三态：空 = 跟随服务端配置（请求体里不放这个键），on/off = 显式覆盖。
    // 记进 State 是因为重渲染会把 select 冲回默认项 —— 那样"强制关"就只生效一次。
    const pfRaw = ($('#kb-prefilter') || {}).value || '';
    State.kbPrefilter = pfRaw;
    const prefilter = pfRaw === 'on' ? true : (pfRaw === 'off' ? false : undefined);
    if (!query.trim()) { State.error = '请输入查询内容。'; render(); return; }
    State.busy = true; State.error = null; State.notice = null;
    render();
    try {
      State.search = await api('/api/knowledge/search', {
        method: 'POST',
        body: JSON.stringify({ query, limit, kbIds: State.currentBase ? [State.currentBase] : [], prefilter }),
      });
    } catch (e) {
      State.error = e.status === 403 ? '没有权限检索该知识库。' : e.message;
      State.search = null;
    } finally {
      State.busy = false; render();
    }
  },

  /* ── 账号管理 ── */
  async createUser() {
    const username = ($('#nu-user') || {}).value || '';
    const displayName = ($('#nu-name') || {}).value || '';
    const password = ($('#nu-pass') || {}).value || '';
    const roles = [($('#nu-role') || {}).value || 'member'];
    // 部门下拉只在"有部门"时才渲染，所以这里要容忍它不存在
    const deptEl = $('#nu-dept');
    const deptId = (deptEl && deptEl.value) ? deptEl.value : null;
    await guard(async () => {
      await api('/api/identity/users', {
        method: 'POST',
        body: JSON.stringify({ username, displayName, password, roles, deptId }),
      });
      await App.loadUsers();
      return '账号 ' + username + ' 已创建。';
    });
  },

  /* ── 批量导入账号（0.17.0）── */

  /** 触发器：点按钮 = 点隐藏的文件输入（用户选完文件才会触发 change → usersCsvChosen） */
  importUsers() {
    const el = $('#nu-file');
    if (el) el.click();
  },

  /**
   * CSV 文件选中之后：解码 → 提交 → 结果弹层。
   * 报表**绝不回显口令** —— 服务端的 report 里本就没有，前端也不拼。
   * 失败行按物理行号列出，是给用户回 Excel 里定位用的。
   */
  async usersCsvChosen() {
    const el = $('#nu-file');
    if (!el || !el.files || !el.files.length) return;
    const file = el.files[0];
    el.value = '';                                   // 允许重选同一个文件再导一遍
    // 与服务端 512KB 上限对齐的**先行**提示：这一步不该让用户白等一次上传再被 400。
    // 最终以服务端为准（前端校验从不作为边界）。
    if (file.size > 512 * 1024) {
      State.error = 'CSV 文件过大（' + bytes(file.size) + '，上限 512KB）—— 请拆分后分批导入。';
      render();
      return;
    }
    let csv;
    try {
      csv = await readCsvText(file);
    } catch (e) {
      State.error = '读取文件失败：' + ((e && e.message) || '未知错误');
      render();
      return;
    }
    let report = null;
    await guard(async () => {
      const r = await api('/api/identity/users/import', { method: 'POST', body: JSON.stringify({ csv }) });
      report = r.report;
      await App.loadUsers();
      return '导入完成：成功 ' + report.created + ' 个、失败 ' + report.failed + ' 个。';
    });
    if (!report) return;                             // 出错了（400/403/…）—— guard 已把原因显示出来
    const failed = report.rows.filter((x) => !x.ok);
    await Dlg.notice({
      title: '批量导入结果',
      body: [
        '共 ' + report.total + ' 行：成功 ' + report.created + ' 个、失败 ' + report.failed + ' 个。',
        '失败行没有创建。修好后重新导入整份文件即可 —— 已创建的行会按「账号已存在」逐行拒绝，不会重复创建。',
      ],
      mono: failed.length ? failed.map((x) => '第 ' + x.line + ' 行  ' + x.username + '：' + x.error).join('\n') : undefined,
      monoRows: 10,
      warn: failed.length ? '失败的是文件里的行，不是已创建的数据。' : undefined,
      ok: '知道了',
    });
  },

  /* ── 部门 ── */

  async createDepartment() {
    const name = (($('#nd-name') || {}).value || '').trim();
    if (!name) { State.error = '请输入部门名称。'; render(); return; }
    await guard(async () => {
      await api('/api/identity/departments', { method: 'POST', body: JSON.stringify({ name }) });
      await Promise.all([App.loadDepartments(), App.loadUsers()]);
      return '部门「' + name + '」已创建。';
    });
  },

  /**
   * 部门改名。长度上限（64）与服务端 `DEPT_NAME_MAX` 对齐：前端先拦一道，
   * 但**最终以服务端为准**（同一套规则写两遍不可避免，前端校验从不作为安全边界）。
   * maxlength 之外还留 validate —— DOM 垫片不强制 maxlength，回归要能测到超长路径。
   */
  async renameDepartment(id) {
    const d = deptList().find((x) => x.id === id);
    if (!d) return;
    const name = await Dlg.prompt({
      title: '部门改名',
      body: ['把「' + d.name + '」改成什么？', '改名不影响任何人的归属与权限。'],
      label: '部门名称',
      value: d.name, maxlength: 64, required: true, ok: '保存',
      validate: (v) => (v.length > 64 ? '部门名称最多 64 字（当前 ' + v.length + ' 字）' : null),
    });
    if (name === null) return;
    await guard(async () => {
      await api('/api/identity/departments/' + encodeURIComponent(id), {
        method: 'PATCH', body: JSON.stringify({ name }),
      });
      await App.loadDepartments();
      return '部门已改名为「' + name + '」。';
    });
  },

  /**
   * 删除部门。
   *
   * 有成员或有子部门时**不发请求**，直接弹「无法删除」并解释 —— 这只是提前告知
   * （本地列表可能已被别的管理员改过），**最终判定在服务端**：它同样会拒绝，
   * 由 `guard()` 把那条人话错误原样显示出来。
   */
  async deleteDepartment(id) {
    const d = deptList().find((x) => x.id === id);
    if (!d) return;
    const members = d.memberCount || 0;
    const children = d.childCount || 0;
    if (members || children) {
      const why = [];
      if (members) why.push('还有 ' + members + ' 个成员 —— 先把他们改到别的部门（或清空归属）');
      if (children) why.push('还有 ' + children + ' 个子部门 —— 先处理子部门');
      await Dlg.notice({
        title: '无法删除',
        body: ['部门「' + d.name + '」' + why.join('；') + '。',
          '直接删除会让这些引用变成悬空引用，所以带引用的部门要先解除引用。'],
        ok: '知道了',
      });
      return;
    }
    if (!await Dlg.confirm({
      title: '删除部门',
      body: ['删除部门「' + d.name + '」？',
        '只删除这个组织归属视图本身 —— 部门不是权限载体，不会影响任何人的权限。'],
      ok: '删除', danger: true,
    })) return;
    await guard(async () => {
      await api('/api/identity/departments/' + encodeURIComponent(id), { method: 'DELETE' });
      await App.loadDepartments();
      return '部门「' + d.name + '」已删除。';
    });
  },

  /**
   * 改某个人的部门归属。
   *
   * 用弹层单选而不是让用户**手输部门名**：先前那版是原生 prompt，用户得照着提示
   * 把部门名一字不差敲进去，敲错就得到一句"没有叫 XX 的部门"。现在选项是渲染出来的，
   * 选不中不存在的情况本身就不存在了。
   * 传 `deptId: null`（而不是省略该键）表示清空归属，这与后端「undefined=不改、
   * null=清空」的语义严格对应。
   */
  async setUserDept(id) {
    const u = ((State.users || {}).users || []).find((x) => x.id === id);
    if (!u) return;
    const list = deptList();
    if (!list.length) {
      State.error = '还没有任何部门，请先在下方「部门」里新建一个。';
      render();
      return;
    }
    const options = [{ value: '', label: '（不归属任何部门）', desc: '部门只表示归属，不影响权限' }]
      .concat(list.map((d) => ({ value: d.id, label: d.name })));
    const picked = await Dlg.pick({
      title: '改部门归属',
      body: ['把 ' + u.username + ' 归属到哪个部门？'],
      options,
      selected: [u.deptId || ''],
      ok: '保存',
    });
    // ⚠️ 取消才是 null。空串是「（不归属任何部门）」这个**有效选择**，不能混为一谈。
    if (picked === null) return;
    const hit = picked ? list.find((d) => d.id === picked) : null;
    await guard(async () => {
      await api('/api/identity/users/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify({ deptId: hit ? hit.id : null }),
      });
      await Promise.all([App.loadUsers(), App.loadDepartments()]);
      return u.username + (hit ? ' 已归属到「' + hit.name + '」。' : ' 的部门归属已清空。');
    });
  },

  /**
   * 改姓名（displayName）。这与"改账号"是两回事：username 是登录标识，
   * 后端没有提供改它的路径；这里改的只是显示名，登录账号不受影响。
   * 服务端只要求"trim 后非空"，没有长度上限 —— 前端照抄该规则，不发明额外限制。
   */
  async setUserName(id) {
    const u = ((State.users || {}).users || []).find((x) => x.id === id);
    if (!u) return;
    const name = await Dlg.prompt({
      title: '改姓名',
      body: ['把 ' + u.username + ' 的姓名改成什么？', '姓名只是显示名，登录账号（' + u.username + '）不变。'],
      label: '姓名',
      value: u.displayName || '', required: true, ok: '保存',
    });
    if (name === null) return;
    await guard(async () => {
      await api('/api/identity/users/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify({ displayName: name }),
      });
      await App.loadUsers();
      return u.username + ' 的姓名已改为「' + name + '」。';
    });
  },

  async editRoles(id) {
    const u = ((State.users || {}).users || []).find((x) => x.id === id);
    if (!u) return;
    const list = (State.roles && State.roles.roles) || [];
    // 角色名单取不到时退回 roleOptions()（它有内置兜底），但**不编造描述**。
    const options = (list.length
      ? list.map((x) => ({ value: x.key, label: x.name, desc: x.description || '' }))
      : roleOptions().map((o) => ({ value: o.key, label: o.name })));
    const picked = await Dlg.pick({
      title: '改角色',
      body: ['把 ' + u.username + ' 的角色改成哪些？',
        '组织级角色对所有对象生效；某一个知识库上的权限请在知识库页单独授权。'],
      options, multiple: true, selected: (u.roles || []).slice(), ok: '保存',
    });
    if (picked === null) return;
    const roles = picked;
    await guard(async () => {
      await api('/api/identity/users/' + encodeURIComponent(id) + '/roles', {
        method: 'PUT', body: JSON.stringify({ roles }),
      });
      await App.loadUsers();
      return u.username + ' 的角色已更新。';
    });
  },

  async resetPassword(id) {
    const u = ((State.users || {}).users || []).find((x) => x.id === id);
    if (!u) return;
    // 口令栏一律 `type=password`（遮蔽）。先前用原生 prompt 收口令，是**明文显示**在屏幕上的。
    // 校验规则与服务端 `checkPasswordStrength` 对齐（同一套要求写两遍不可避免，
    // 但这里只是"提前拦"，最终仍以服务端为准 —— 前端校验从不作为安全边界）。
    const pw = await Dlg.prompt({
      title: '重置口令',
      body: ['为 ' + u.username + ' 设置新口令。',
        '提交后该用户全部会话立即失效，他需要用新口令重新登录。'],
      label: '新口令',
      type: 'password', required: true, ok: '重置口令', danger: true,
      placeholder: '≥8 位，含小写/大写/数字/符号中的至少两类',
      validate: (v) => {
        if (v.length < 8) return '口令至少 8 位（当前 ' + v.length + ' 位）';
        const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
        if (kinds < 2) return '口令需至少包含两类字符（小写 / 大写 / 数字 / 符号）';
        return null;
      },
    });
    if (pw === null) return;
    await guard(async () => {
      await api('/api/identity/users/' + encodeURIComponent(id) + '/password', {
        method: 'POST', body: JSON.stringify({ password: pw }),
      });
      return u.username + ' 的口令已重置，其旧会话已全部失效。';
    });
  },

  /**
   * 重置某个用户的两步验证（0.17.0）：用户丢了手机/验证器时的**轻处置** ——
   * 只清他的第二因子与未完成的登录票据，**不动口令、不吊销会话**。
   * 为什么不做成"顺手也重置口令"：那会把这件小事升级成一次全端下线（用户所有设备被踢），
   * 而真正的强处置本来就单独存在（重置口令）。两件事分开，各自可解释。
   */
  async resetUserTotp(id, username) {
    const u = ((State.users || {}).users || []).find((x) => x.id === id);
    if (!u) return;
    if (!await Dlg.confirm({
      title: '重置两步验证',
      body: ['重置 ' + u.username + ' 的两步验证？',
        '· 他的验证器与一次性恢复码全部作废，下次登录只需口令；',
        '· 口令不变、现有会话不受影响；',
        '· 他需要重新登记一台验证器。'],
      ok: '重置', danger: true,
    })) return;
    await guard(async () => {
      const r = await api('/api/identity/users/' + encodeURIComponent(id) + '/totp-reset', { method: 'POST', body: '{}' });
      await App.loadUsers();
      return u.username + (r.hadTotp ? ' 的两步验证已重置' : ' 本来就没有启用两步验证')
        + '（清掉恢复码 ' + (r.codesRemoved || 0) + ' 张' + (r.challengesInvalidated ? '、未完成票据 ' + r.challengesInvalidated + ' 张' : '') + '）。';
    });
  },

  async setStatus(id, status) {
    const u = ((State.users || {}).users || []).find((x) => x.id === id);
    if (!u) return;
    if (status === 'disabled' && !await Dlg.confirm({
      title: '停用账号',
      body: ['停用 ' + u.username + '？其全部会话会立即失效。'],
      ok: '停用', danger: true,
    })) return;
    await guard(async () => {
      await api('/api/identity/users/' + encodeURIComponent(id) + '/status', {
        method: 'PUT', body: JSON.stringify({ status }),
      });
      await App.loadUsers();
      return u.username + ' 已' + (status === 'active' ? '启用' : '停用') + '。';
    });
  },

  /**
   * 删除账号（0.16.0）。真删：连带清掉其会话 / API Key / 组关系 / 角色绑定；
   * 审计保留。这是 user:delete 权限的动作（admin 矩阵显式声明，member/viewer 没有），
   * 后端会再拦"删自己"与"删最后一个所有者"—— 界面的确认只负责让人想清楚。
   */
  async deleteUser(id, username) {
    if (!await Dlg.confirm({
      title: '删除账号',
      body: ['删除 ' + (username || id) + '？这是真删，不可恢复：',
        '· 该账号的会话、API Key、组关系、角色绑定一并清除；',
        '· 审计日志保留（哈希链不断）；',
        '· 若只是暂时不让登录，请改用「停用」。'],
      ok: '删除', danger: true,
    })) return;
    await guard(async () => {
      await api('/api/identity/users/' + encodeURIComponent(id), { method: 'DELETE' });
      await App.loadUsers();
      return (username || id) + ' 已删除（其审计记录保留）。';
    });
  },

  /* ── 用户组 ── */
  async createGroup() {
    const name = ($('#ng-name') || {}).value || '';
    const description = ($('#ng-desc') || {}).value || '';
    await guard(async () => {
      await api('/api/identity/groups', { method: 'POST', body: JSON.stringify({ name, description }) });
      await App.loadGroups();
      return '组「' + name + '」已创建。它还没有任何角色 —— 挂上角色才会产生权限。';
    });
  },

  /**
   * 组改名。长度上限（64）与服务端校验对齐：前端先拦一道，但**最终以服务端为准**
   * （同一套规则写两遍不可避免，前端校验从不作为安全边界）。maxlength 之外还留
   * validate —— DOM 垫片不强制 maxlength，回归要能测到超长路径。
   */
  async renameGroup(id) {
    const g = ((State.groups || {}).groups || []).find((x) => x.id === id);
    if (!g) return;
    const name = await Dlg.prompt({
      title: '组改名',
      body: ['把组「' + g.name + '」改成什么？', '改名不影响权限 —— 组上的角色绑定不受影响。'],
      label: '组名',
      value: g.name, maxlength: 64, required: true, ok: '保存',
      validate: (v) => (v.length > 64 ? '组名最多 64 字（当前 ' + v.length + ' 字）' : null),
    });
    if (name === null) return;
    await guard(async () => {
      await api('/api/identity/groups/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify({ name }),
      });
      await App.loadGroups();
      return '组已改名为「' + name + '」。';
    });
  },

  /**
   * 改组的说明。**不设 required** —— 说明允许清空，空串是有效值（与后端
   * 「空串 = 清空」的语义一致）；取消返回 null 才是"什么都不做"。
   */
  async editGroupDesc(id) {
    const g = ((State.groups || {}).groups || []).find((x) => x.id === id);
    if (!g) return;
    const desc = await Dlg.prompt({
      title: '改组的说明',
      body: ['写一句这个组是做什么的。', '留空保存 = 清空说明。'],
      label: '组说明',
      value: g.description || '', ok: '保存',
    });
    if (desc === null) return;
    await guard(async () => {
      await api('/api/identity/groups/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify({ description: desc }),
      });
      await App.loadGroups();
      return desc ? '组「' + g.name + '」的说明已保存。' : '组「' + g.name + '」的说明已清空。';
    });
  },

  async editGroupRoles(id) {
    const g = ((State.groups || {}).groups || []).find((x) => x.id === id);
    if (!g) return;
    const list = (State.roles && State.roles.roles) || [];
    const options = (list.length
      ? list.map((x) => ({ value: x.key, label: x.name, desc: x.description || '' }))
      : roleOptions().map((o) => ({ value: o.key, label: o.name })));
    const roles = await Dlg.pick({
      title: '改组的角色',
      body: ['组上的角色对它全部成员生效（成员的有效角色 = 直接绑定 ∪ 组绑定）。',
        '留空 = 这个组不带任何权限。'],
      options, multiple: true, selected: (g.roles || []).slice(), ok: '保存',
    });
    if (roles === null) return;
    await guard(async () => {
      await api('/api/identity/groups/' + encodeURIComponent(id) + '/roles', {
        method: 'PUT', body: JSON.stringify({ roles }),
      });
      // 组角色会改变成员的有效角色与"是不是管理员"，两个列表都要重取
      await Promise.all([App.loadGroups(), App.loadUsers()]);
      return '「' + g.name + '」的角色已更新为：' + (roles.length ? roles.map(roleName).join('、') : '（无）');
    });
  },

  async editGroupMembers(id) {
    const g = ((State.groups || {}).groups || []).find((x) => x.id === id);
    if (!g) return;
    const users = ((State.users || {}).users) || [];
    if (!users.length) {
      State.error = '看不到账号列表（需要 user:read），无法选择成员。请让管理员开权限，或用 API 直接设置。';
      State.notice = null;
      render();
      return;
    }
    const current = users.filter((u) => (u.groups || []).some((x) => x.id === id)).map((u) => u.id);
    // 选项直接用**账号列表**（勾选），不再让用户照着提示敲一串用户名：
    // 手输既记不住有哪些人、也一定会打错字，而打错时整条请求会被服务端拒。
    const userIds = await Dlg.pick({
      title: '改组成员',
      body: ['勾选「' + g.name + '」的成员。全部取消勾选 = 清空成员。'],
      options: users.map((u) => ({
        value: u.id,
        label: u.displayName || u.username,
        desc: u.username + (deptName(u.deptId) ? '｜' + deptName(u.deptId) : '') + (u.status === 'disabled' ? '｜已停用' : ''),
      })),
      multiple: true, selected: current, ok: '保存',
    });
    if (userIds === null) return;
    await guard(async () => {
      await api('/api/identity/groups/' + encodeURIComponent(id) + '/members', {
        method: 'PUT', body: JSON.stringify({ userIds }),
      });
      await Promise.all([App.loadGroups(), App.loadUsers()]);
      return '「' + g.name + '」的成员已更新为 ' + userIds.length + ' 人。';
    });
  },

  async deleteGroup(id) {
    const g = ((State.groups || {}).groups || []).find((x) => x.id === id);
    if (!g) return;
    const n = ((State.users || {}).users || []).filter((u) => (u.groups || []).some((x) => x.id === id)).length;
    if (!await Dlg.confirm({
      title: '删除用户组',
      body: ['删除组「' + g.name + '」？',
        '它的角色绑定会一并撤销' + (n ? '，' + n + ' 位成员将失去该组带来的角色' : '') + '。',
        '此操作不可撤销。'],
      ok: '删除', danger: true,
    })) return;
    await guard(async () => {
      await api('/api/identity/groups/' + encodeURIComponent(id), { method: 'DELETE' });
      await Promise.all([App.loadGroups(), App.loadUsers()]);
      return '组「' + g.name + '」已删除。';
    });
  },

  /* ── 凭据 ── */
  async setCred() {
    const name = ($('#cd-name') || {}).value || '';
    const provider = ($('#cd-provider') || {}).value || '';
    const value = ($('#cd-value') || {}).value || '';
    await guard(async () => {
      await api('/api/identity/credentials', { method: 'POST', body: JSON.stringify({ name, provider, value }) });
      await App.loadCreds();
      return '凭据「' + name + '」已加密保存。';
    });
  },

  async delCred(id, name) {
    if (!await Dlg.confirm({
      title: '删除凭据',
      body: ['删除凭据「' + name + '」？', '使用它的任务与连接会失去这把密钥。'],
      ok: '删除', danger: true,
    })) return;
    await guard(async () => {
      await api('/api/identity/credentials/' + encodeURIComponent(id), { method: 'DELETE' });
      await App.loadCreds();
      return '凭据「' + name + '」已删除。';
    });
  },

  /* ── API Key ── */
  async createApiKey() {
    const name = ($('#ak-name') || {}).value || '';
    const days = ($('#ak-days') || {}).value || '';
    await guard(async () => {
      const body = { name };
      if (days) body.ttlDays = Number(days);
      const r = await api('/api/identity/apikeys', { method: 'POST', body: JSON.stringify(body) });
      await App.loadApiKeys();
      // 明文 key 只出现这一次。**先把它亮出来再报"成功"** —— 顺序反了的话，
      // 下面那句 notice 会先重绘一次页面，用户可能已经把弹层点掉了。
      await Dlg.notice({
        title: 'API Key 已创建',
        body: ['这是「' + name + '」的密钥明文。'],
        mono: r.apiKey.key, monoRows: 3,
        warn: '这个值只显示这一次。服务端只保存它的哈希，之后无法再取出 —— 请现在就复制走。',
        ok: '我已复制',
      });
      return 'API Key「' + name + '」已创建（明文只显示过一次）。';
    });
  },

  async revokeApiKey(id) {
    if (!await Dlg.confirm({
      title: '吊销 API Key',
      body: ['吊销这个 API Key？使用它的脚本会立刻失效。'],
      ok: '吊销', danger: true,
    })) return;
    await guard(async () => {
      await api('/api/identity/apikeys/' + encodeURIComponent(id), { method: 'DELETE' });
      await App.loadApiKeys();
      return 'API Key 已吊销。';
    });
  },

  /* ── 两步验证（TOTP，自助）───────────────────────────────────────────
   *
   * 三个动作（登记 / 停用 / 重发恢复码）都要求**现场凭证**（重输口令或动态码）——
   * 服务端不认"仅凭会话"：会话被窃者不能替受害者登记自己的验证器，也不能把
   * 第二因子拆掉。界面这边的两次弹层只是如实转达这件事，安全边界在服务端，
   * 但用户看到"为什么要再输一次"才不会觉得是产品在刁难。
   */

  /**
   * 开启两步验证（两段式）：
   *   ① 重输口令 → 服务端生成密钥，返回 Base32 密钥与 otpauth URI；
   *   ② 把密钥录入验证器 App，回填 App 显示的 6 位动态码 → 启用 + 一次性恢复码。
   * 为什么确认必须回填动态码：「密钥生成成功」只证明服务端备好了一对密钥，
   * 不证明用户手里那台验证器真的能出码 —— 不确认就启用等于把自己锁在门外。
   */
  async totpBeginEnroll() {
    const me = (State.me && State.me.user) || {};
    const pw = await Dlg.prompt({
      title: '开启两步验证',
      body: ['先确认是你本人：请输入 ' + (me.username || '当前账号') + ' 的当前口令。',
        '开启后，登录 = 口令 + 验证器动态码两道。'],
      label: '当前口令', type: 'password', required: true, ok: '下一步',
    });
    if (pw === null) return;
    await guard(async () => {
      const r = await api('/api/identity/totp/enroll', { method: 'POST', body: JSON.stringify({ password: pw }) });
      const e = r.enroll;
      await Dlg.notice({
        title: '登记验证器',
        body: ['打开验证器 App（Google Authenticator / 微软验证器 / 1Password…），选择「手动输入密钥」，'
          + '把下面的密钥录进去（不区分大小写，建议直接复制）。',
          '支持 otpauth URI 的验证器也可以改用这个地址：' + e.otpauthUri],
        mono: e.secret, monoRows: 2,
        warn: '密钥是第二因子的根 —— 不要截图、不要发给任何人。下一步要回填 App 上显示的 '
          + e.digits + ' 位动态码才算完成。',
        ok: '我录好了，下一步',
      });
      return null;   // 还没有完成 —— 不报"成功"，紧接着走确认
    });
    if (State.error) return;   // 登记失败（口令错等）→ 到此为止
    await App.totpConfirm();
  },

  /** 第二步：回填验证器上的动态码完成启用；成功时**一次性**亮出恢复码。 */
  async totpConfirm() {
    const code = await Dlg.prompt({
      title: '确认登记',
      body: ['输入验证器 App 上现在显示的 6 位动态码。确认成功后两步验证立即生效。'],
      label: '动态码', required: true, ok: '确认启用', placeholder: '6 位数字',
      validate: (v) => (/^\d{6}$/.test(v) ? null : '请输入 6 位数字（App 上每 30 秒换一次）'),
    });
    if (code === null) return;
    await guard(async () => {
      const r = await api('/api/identity/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) });
      await Dlg.notice({
        title: '两步验证已开启',
        body: ['下面是 ' + r.recoveryCodes.length + ' 张一次性恢复码 —— 丢了验证器时，每张可以顶一次动态码。'],
        mono: r.recoveryCodes.join('\n'), monoRows: Math.min(12, r.recoveryCodes.length + 2),
        warn: '恢复码只显示这一次。请立刻抄写/打印，并存到与手机分开的地方（每张只能用一次）。',
        ok: '我已保存',
      });
      await App.loadTotp();
      return '两步验证已开启（恢复码只显示过这一次，请确认已保存）。';
    });
  },

  /** 停用（安全降级）：口令 + 当前动态码**双证**。恢复码故意不能用 ——它只服务于登录。 */
  async totpDisable() {
    const pw = await Dlg.prompt({
      title: '停用两步验证',
      body: ['停用是安全降级，需要同时提供口令与当前动态码。'],
      label: '当前口令', type: 'password', required: true, ok: '下一步',
    });
    if (pw === null) return;
    const code = await Dlg.prompt({
      title: '停用两步验证',
      body: ['再输入验证器上当前的 6 位动态码。停用后恢复码一并作废。'],
      label: '动态码', required: true, ok: '停用', danger: true, placeholder: '6 位数字',
      validate: (v) => (/^\d{6}$/.test(v) ? null : '请输入 6 位数字'),
    });
    if (code === null) return;
    await guard(async () => {
      await api('/api/identity/totp/disable', { method: 'POST', body: JSON.stringify({ password: pw, code }) });
      await App.loadTotp();
      return '两步验证已停用（恢复码一并作废）。要重新开启请再走一次登记。';
    });
  },

  /** 重发恢复码：只认动态码（恢复码不能自我续命）。旧的整批作废。 */
  async totpRegenCodes() {
    const code = await Dlg.prompt({
      title: '重新生成恢复码',
      body: ['输入验证器上当前的 6 位动态码。旧的一批恢复码会全部作废。'],
      label: '动态码', required: true, ok: '生成', placeholder: '6 位数字',
      validate: (v) => (/^\d{6}$/.test(v) ? null : '请输入 6 位数字'),
    });
    if (code === null) return;
    await guard(async () => {
      const r = await api('/api/identity/totp/recovery-codes', { method: 'POST', body: JSON.stringify({ code }) });
      await Dlg.notice({
        title: '新的恢复码',
        body: ['旧恢复码已全部作废。下面是新的一批（' + r.recoveryCodes.length + ' 张）。'],
        mono: r.recoveryCodes.join('\n'), monoRows: Math.min(12, r.recoveryCodes.length + 2),
        warn: '只显示这一次，请立刻抄写/打印保存。',
        ok: '我已保存',
      });
      await App.loadTotp();
      return '已生成新的一批恢复码（旧的已作废）。';
    });
  },

  toggleTheme,

  /* ── 顶栏账号下拉（0.21.11）──────────────────────────────────
   * 只有**顶栏**这一份下拉（工作台左栏那个已按用户裁定退回成"点名字跳我的账号"的链接，
   * 见 84-workbench.js 的 wbAccountHtml）。状态在顶层 `State.topbarMenu`。
   */
  toggleTopbarMenu() {
    State.topbarMenu = !State.topbarMenu;
    render();
  },

  /** 顶栏菜单里的「我的账号」。先收起菜单再跳（不然菜单会挂在新页面上）。 */
  goMe() {
    State.topbarMenu = false;
    location.hash = '#/me';
  },
};

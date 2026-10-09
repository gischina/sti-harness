/* STI HARNESS 前端 · 平台页：概览（含系统明细）/ 接口清单 / 契约与映射 / 中间件
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 页面渲染：平台页（已登录） ─────────────────────────── */

function pageOverview() {
  const s = State.status;
  if (!s) return loadingOrError();
  const k = s.kernel;
  const db = s.database || {};
  const mig = s.migrations || {};
  const gate = k.versionGate || {};

  // 内核只有两种状态（0.21.4）：接入了 / 没接入。
  // ⚠️ 没接入时**根本走不到这一页** —— render() 会先渲染全平台阻断页（见 pageKernelGate）。
  const kernelBadge = k.ready
    ? '<span class="badge ok">已接入</span>'
    : '<span class="badge fail">未接入</span>';

  let html = '';
  html += '<div class="cards">';
  html += card('平台版本', esc(s.platform.version), 'Node ' + esc(s.platform.node.current));
  html += card('Node 版本', s.platform.node.ok ? '<span class="badge ok">满足</span>' : '<span class="badge fail">过低</span>', '要求 ≥ ' + esc(s.platform.node.required));
  html += card('Agent 内核', kernelBadge, esc(k.ready ? '内核可用' : (k.reason || '未接入内核')));
  html += card('数据库', db.open ? esc(db.journalMode + '') : '未打开', (db.tables || 0) + ' 张表 · ' + bytes(db.bytes));
  html += card('数据库迁移', mig.upToDate ? '<span class="badge ok">最新</span>' : '<span class="badge warn">待处理</span>', '当前 ' + esc(mig.currentVersion || '—') + ' / 最新 ' + esc(mig.latestVersion || '—'));
  html += card('已运行', esc(dur(s.platform.uptimeMs)), 'PID ' + s.platform.pid);
  html += '</div>';

  // 能走到这里 = 内核已接入且可用，所以这里只报"版本在不在已验证矩阵内"。
  if (gate.level === 'warn') {
    html += '<div class="note warn"><b>内核版本未经验证。</b>' + esc(gate.detail) + '</div>';
  } else {
    html += '<div class="note">' + levelBadge(gate.level) + ' ' + esc(gate.detail || '') + '</div>';
  }
  html += kernelConnectPanel(k, gate, s);

  const pending = ((s.middleware || []).filter((m) => m.state !== 'active') || []);
  if (pending.length) {
    html += '<div class="note warn"><b>以下防护环节尚未启用，对应场景目前不产生拦截或审计记录：</b>'
      + pending.map((m) => esc(m.name)).join('、')
      + '<br>账号登录与权限校验不受影响，已正常生效。</div>';
  }

  // 「尚未交付的能力」面板已移除（0.15.7）：这是交给部署使用者的产品界面，
  // 里程碑与交付过程的叙事留在 docs/roadmap.md。未交付项如果将来真出现，
  // 由 PLANNED 驱动的侧栏「尚未交付」组仍是唯一显式出口（PLANNED 为空则整组不渲染）。

  // 系统明细（0.15.5 起并入本页：原「系统状态」独立页，诊断细节默认折叠）
  html += systemDetailsHtml(s);

  return html;
}

/* ── 内核接入（P0）────────────────────────────────────────
 *
 * 这一段的存在理由：在此之前，"接上真实内核"的唯一办法是登上服务器改
 * `data/config.json` 再重启 —— 等于**只有写这套代码的人**能完成第一次部署。
 * 现在它是一个表单，而且每一步的结论都来自真实网络探测。
 *
 * 四处刻意的设计：
 *   ① **没有权限的人看到的是说明，不是表单。** 给一个点了必然 403 的按钮，
 *      比不给更糟 —— 用户会先怀疑"平台坏了"，再怀疑自己。
 *   ② 检测结果按"**卡在哪一步**"呈现（地址 / 连通 / 鉴权 / 识别 / 版本），
 *      而不是按状态机词表 —— 用户要的是"下一步干嘛"，不是"状态叫什么"。
 *   ③ 保存后**明说发生了什么**：0.21.3 起保存即生效（门面热切换），界面照服务端回的
 *      `switched.ready` / `reason` 说话；只有"env 覆盖 / 当场切换失败"两种情形才说需要重启。
 *   ④ 表单值来自 `State.kernelForm`，不读 DOM —— 检测后会重绘一张诊断卡，
 *      那时 DOM 里的输入框已经被重建，读它只会得到空值。
 *
 * ⚠️ 这一整套（详细诊断卡 + 可核对项 + 保存回执）只给**概览页**用。
 * 未接入时的弹框走同一个组件的 `compact` 形态，只有三行结论（见 pageKernelGate）——
 * 那里的人要的是"填哪儿、点哪个键"，把排查表塞进去只会把这三行淹掉。
 */

/**
 * 诊断卡：把一次探测的结论、原因、下一步摊开。
 *
 * `compact` = 给**弹框**（未接入时的阻断页）用的简短形态：只留「通过没通过 / 一句话原因 /
 * 下一步干嘛」三行。砍掉可核对项与版本附注是有意的 —— 那两张表是给"正在排查一次
 * 接不通"的人用的（他会拿 HTTP 码、服务名、版本号去别处比对），而弹框上的人是
 * **第一次把平台跑起来**，他要的是"填完点哪个键"。把一个排查表塞进弹框，
 * 代价是真正要看的那三行被淹掉。
 */
function kernelProbeCard(p, compact) {
  if (!p) return '';
  const cls = p.ok ? 'ok' : (p.state === 'unreachable' || p.state === 'not-kernel' ? 'fail' : 'warn');
  let h = '<div class="kb-probe ' + cls + '">';
  h += '<div class="kb-probe-head"><span class="badge ' + cls + '">' + esc(p.stage || '结果') + '</span>'
    + '<b>' + esc(p.verdict || '') + '</b></div>';
  if (p.detail) h += '<div class="kb-probe-detail">' + esc(p.detail) + '</div>';
  // 通过时不再说"下一步"：下一步就是点「保存并启用」，而那个键就在下面亮着。
  // 话说满了反而让人以为还有别的动作要做。
  if (p.hint && !(compact && p.ok)) h += '<div class="kb-probe-hint">下一步：' + esc(p.hint) + '</div>';
  if (compact) { h += '</div>'; return h; }
  if (p.versionWarning) h += '<div class="kb-probe-hint">' + esc(p.versionWarning) + '</div>';
  if (p.versionNote) h += '<div class="kb-probe-hint">' + esc(p.versionNote) + '</div>';
  // 探测结果的**可核对项**：地址、HTTP 状态码、对面报的服务名与内容类型、上游版本、令牌有没有被识别到。
  // 摆出来是因为"连不上"和"连上了但令牌没被识别"在界面上必须能一眼分开；
  // 而「服务 / 类型」是"这端口上跑的到底是什么"最直接的两项（填错端口时靠它认出来）。
  h += '<div class="kb-probe-facts">'
    + '<span>地址 ' + esc(p.origin || '—') + '</span>'
    + '<span>HTTP ' + esc(String(p.httpStatus || '—')) + '</span>'
    + (p.server && p.server !== '—' ? '<span>服务 ' + esc(p.server) + '</span>' : '')
    + (p.contentType ? '<span>类型 ' + esc(p.contentType) + '</span>' : '')
    + '<span>版本 ' + esc(p.version || '—') + '</span>'
    + '<span>令牌 ' + (p.hasToken ? '已识别（' + esc(p.tokenSource === 'origin' ? '来自地址' : '单独填写') + '）' : '未提供') + '</span>'
    + '</div>';
  h += '</div>';
  return h;
}

/**
 * 接入表单。
 * @param {string} pfx 元素 id 前缀 —— 两处会用它：概览页的「改指向」面板（`kf`）
 *   与未接入时的整页阻断页（`kg`）。二者**不会同时在场**（阻断页会整页替换掉一切），
 *   但共用 id 仍然会出问题（HTML 里 id 必须唯一），所以这个前缀留着。
 */
function kernelFormHtml(pfx, compact) {
  const f = State.kernelForm;
  /**
   * 保存的前置条件 = **这次检测通过了**。
   *
   * 从前这里有个「跳过检测直接保存」的勾选框，它的唯一作用是让用户把一条
   * 当场已被证伪的配置存进去（0.21.5 删除）。那笔交易是赔的：用户省下一次点击，
   * 换到的是"平台保存成功、却没接入上"——而那个状态最难自查，因为界面会显示"已保存"。
   * 所以现在**没有旁路**：先把检测点绿，保存键才亮。
   *
   * 服务端同样按这个前提拒（见 routes/system.mjs 的保存口）——
   * 前端禁用只是把话说在前面，不是唯一防线。
   */
  const probed = State.kernelProbe;
  const canSave = !!(probed && probed.ok);
  let h = '<div class="kernel-form">'
    + '<label class="field"><span class="field-label">内核地址</span>'
    + '<input id="' + pfx + '-origin" type="text" autocomplete="off" spellcheck="false"'
    + ' value="' + esc(f.origin) + '"'
    + ' placeholder="http://127.0.0.1:3080/?token=…（从内核启动那行整段粘过来最省事）">'
    + '<span class="field-hint">整段里带的令牌会被自动识别；支持反代带路径的形态。</span></label>'
    + '<label class="field"><span class="field-label">令牌（可选）</span>'
    + '<input id="' + pfx + '-token" type="password" autocomplete="off"'
    + ' value="' + esc(f.token) + '" placeholder="地址里已经带了就留空">'
    + '<span class="field-hint">以密文（AES-256-GCM）写入配置文件，界面与日志都不回显它。</span></label>'
    + '<div class="row kernel-actions">'
    + '<button ' + act('kernelProbe') + (State.kernelProbeBusy ? ' disabled' : '') + '>'
    + (State.kernelProbeBusy ? '检测中…' : '检测连接') + '</button>'
    + '<button class="primary" ' + act('kernelSave')
    + (State.kernelSaving || !canSave ? ' disabled' : '') + '>'
    + (State.kernelSaving ? '保存中…' : '保存并启用') + '</button>'
    + (State.kernelProbeBusy || State.kernelSaving ? '<span class="spinner"></span>' : '')
    + '</div>'
    // 为什么保存键是灰的 —— 灰着不说话是另一种不礼貌（用户会反复点，然后认定"按钮坏了"）。
    // 弹框上这句话按 `compact` 收敛成一行：那边没有多余位置，也没必要解释"为什么没有旁路"。
    + (canSave || State.kernelSaving ? ''
      : (compact
        ? '<div class="faint">保存前要先<b>检测连接</b>，通过后这个键才会亮。</div>'
        : '<div class="faint">「保存并启用」要先通过检测：点一次<b>检测连接</b>，绿色的结果出现后这个键才会亮。'
          + '（没有"跳过检测"的口子 —— 把连不上的地址存进去，只会得到一个显示"已保存"却没接入上的平台。）</div>'))
    + (compact
      ? ''
      : '<div class="faint"><b>保存即生效</b>，无需重启（0.21.3 起内核可热切换：正在进行的回合会用'
        + '切换前的内核跑完）。只有被环境变量覆盖时保存才不改变当前进程。'
        + ' 检测会由本服务主动去连你填的地址，因此这是管理员权限的动作，且会记审计。</div>')
    + '</div>';
  return h;
}

/** 一次接入尝试的反馈区（检测错误 / 检测结果 / 保存错误 / 保存结果） */
function kernelFeedbackHtml(compact) {
  let h = '';
  if (State.kernelProbeError) h += '<div class="note fail">检测没能完成：' + esc(State.kernelProbeError) + '</div>';
  h += kernelProbeCard(State.kernelProbe, compact);
  if (State.kernelSaveError) {
    // 弹框上**不重复**：保存被拒时服务端会把同一份诊断塞回 `State.kernelProbe`
    // （见 App.kernelSave 的 catch），上面的探针卡已经把「为什么没通过 + 下一步」说完了。
    // 两处都说一遍，读起来像两个独立的问题，反而要多想一步。
    // （`kernelProbe` 为空时不跳过 —— 那是"还没检测就点保存"，那句话只在 saveError 里。）
    const saidByCard = compact && !!State.kernelProbe;
    if (!saidByCard) h += '<div class="note fail">' + esc(State.kernelSaveError) + '</div>';
  }
  if (State.kernelSaved) {
    const r = State.kernelSaved;
    if (compact) {
      // 弹框上只剩一种情形会走到这里：写盘成功但内核**当场不可用**（可用的话弹框已经关了，
      // 见 App.kernelSave）。所以这里只如实说这一句，不铺开"已写入哪个文件、多少字节"。
      if (r.switched && !r.switched.ready) {
        h += '<div class="note warn">已保存，但内核当前不可用'
          + (r.switched.reason ? '（' + esc(r.switched.reason) + '）' : '')
          + '。确认内核起来后，重新检测一次即可。</div>';
      }
      return h;
    }
    // 0.21.3：保存即生效。只有两种情形还要重启（env 覆盖 / 当场切换失败），
    // 后端那时才置 restartRequired —— 这里不再无条件地写"重启后生效"。
    const box = r.switched ? '' : (r.restartRequired ? ' warn' : '');
    h += '<div class="note' + box + '">已写入 <code>' + esc(r.file) + '</code>（' + esc(String(r.bytes)) + ' 字节）。';
    if (r.switched) {
      h += '<br><b>已当场生效</b>：内核' + (r.switched.ready ? '<b>可用</b>' : '<b>不可用</b>')
        + (r.switched.reason ? '（' + esc(r.switched.reason) + '）' : '');
      if (r.switched.note) h += '<br><span class="faint">' + esc(r.switched.note) + '</span>';
    } else if (r.restartRequired) {
      h += '<br><b>需要重启</b>：' + esc(r.restartNote || '');
    }
    h += '</div>';
  }
  return h;
}

/** 「配置改了但还没生效 / 地址来自环境变量」—— 两个客观值对账出来的结论 */
function kernelRestartNoteHtml() {
  const r = State.kernelStatus && State.kernelStatus.restart;
  if (!r || !r.note) return '';
  return '<div class="note ' + (r.overriddenByEnv ? 'fail' : 'warn') + '">' + esc(r.note) + '</div>';
}

/**
 * 概览页的「Agent 内核」面板。
 *
 * ⚠️ 走到这里时内核**一定已经接入且可用** —— 没接入的话 `render()` 会先渲染全平台
 * 阻断页（pageKernelGate），概览页根本不渲染。所以这一段只回答"换一个地址"。
 */
function kernelConnectPanel(k, gate, s) {
  const canWrite = allowed('system', 'write');
  const hints = (s.config && s.config.connectHints) || {};
  let h = '<div class="panel"><h2>内核接入</h2>';

  h += '<div class="note">内核已接入（' + levelBadge(gate.level) + ' ' + esc(gate.detail || '') + '）。'
    + '下面是"换一个地址"的入口 —— 只有在需要改指向时才用它。</div>';

  h += kernelRestartNoteHtml();
  h += kernelFeedbackHtml();

  if (canWrite) {
    /**
     * 表单**恒收起**（0.21.5）。
     *
     * 从前写的是一句 `if (!State.kernelSaved) … else 展开` —— 于是"保存成功"反而把
     * 表单摊开放在那儿。那个分支是反的：走到这一页时内核已经可用，这里的动作是
     * "换一个地址"，正常态本来就该是收起的一条摘要；保存结果由上面的
     * `kernelFeedbackHtml()` 说，不需要靠把表单留在屏幕上再暗示一次
     * （用户看到输入框还在，第一反应是"是不是没存上"）。
     */
    h += '<details><summary class="faint">改指向 / 重新接入</summary><div class="kernel-details-body">'
      + kernelFormHtml('kf') + '</div></details>';
  } else {
    h += '<div class="note">接入内核需要<b>管理员</b>权限（它会由服务端主动连向一个任意地址，属高权限动作）。'
      + '请联系管理员完成，或由运维在服务器上配置：'
      + (hints.originEnv
        ? '设置 <code>' + esc(hints.originEnv) + '</code>（可整段带 <code>?token=…</code>），'
          + '或写入 <code>' + esc(hints.configFile || 'data/config.json') + '</code>。'
        : '在配置文件里填入内核地址与令牌。')
      + '</div>';
  }
  h += '</div>';
  return h;
}

/**
 * 内核不可用时的**全平台阻断页**（0.21.4 起是整页，0.21.5 起收敛成一个弹框）。
 *
 * ── 它取代了什么 ─────────────────────────────────────────────────────────
 * 从前这里是一个**可以关掉**的引导弹窗，还带一个逃生口「先用内置内核试用」。
 * 那个设计的前提是"平台有一个内置内核可以凑合用"，而那个内置内核已经删掉了
 * （见 app/kernel/unconfigured-provider.mjs 的说明）：没接入就是没有执行引擎，
 * 对话、技能、MCP 一概不可用。给一个"先试用"的按钮等于给一条走不通的路。
 *
 * ── 0.21.5 的收敛：一屏说清，别写成一篇说明文 ─────────────────────────────
 * 上一版把这一段写成了四五屏：内核是什么、平台哪些功能不依赖它、为什么整页拦住、
 * 可核对项表格、保存回执、切换语义的两条须知…… 结果是**真正要做的两件事**
 * （填地址、点检测）被埋在解释里。而这一段面对的人是**第一次把平台跑起来的管理员**：
 * 他手里已经拿着内核启动打印的那一行，需要的是"粘哪儿、点哪个键"。
 * 于是砍到一屏：标题 / 一句话 / 两个输入框 / 检测(带短结论) / 保存 / 退出登录。
 * 想看细节的人去概览页那张接入面板 —— 那里仍然是一张完整的诊断表。
 *
 * 三条仍然坚持的：
 *   · **没有关闭按钮**：关掉它并不能让平台变可用，只会让人多绕一圈；
 *   · 不挡登录与初始化向导（`render()` 里排在它们之后），锁在门外就没人能配了；
 *   · 非管理员看到的是说明而不是表单：给一个点了必然 403 的按钮，比不给更糟。
 *
 * ⚠️ 唯一出口是「退出登录」：这台平台不能用，得先换个人或者去配内核
 * （接入成功后这一页会自己消失 —— 见 App.kernelSave）。
 */
function pageKernelGate(k) {
  const canWrite = allowed('system', 'write');
  const u = (State.me && State.me.user) || null;
  // 这一页承担两种情形（内核只有"能用 / 不能用"两种状态）：没配地址 / 配了但连不上。
  // 标题跟着走 —— 配了却连不上时说"尚未接入"是句假话，会把人的排查方向带偏
  // （他会去翻配置文件，而问题在内核进程没起来）。
  const configured = !!k.reason && !/^尚未接入/.test(k.reason);

  let h = '<div class="kg-page"><div class="kg-card">';
  h += '<div class="kg-brand">STI HARNESS<small>企业级时空智能体生产平台</small></div>';
  h += '<h1>' + (configured ? '内核当前不可用' : '尚未接入内核') + '</h1>';
  h += '<p class="kg-lead">' + esc(configured
    ? (k.reason || '内核连不上')
    : '填入内核地址，检测通过后保存即可开始使用。') + '</p>';

  if (canWrite) {
    h += kernelFeedbackHtml(true);
    h += kernelFormHtml('kg', true);
  } else {
    h += '<div class="note">接入内核需要<b>管理员</b>权限（它会由服务端主动连向一个任意地址，属高权限动作）。'
      + '请联系管理员完成接入。</div>';
  }

  h += '<div class="kg-foot">'
    + (u ? '<span class="faint">当前登录：' + esc(u.username) + '</span>' : '<span></span>')
    + '<button ' + act('logout') + '>退出登录</button>'
    + '</div>';
  h += '</div></div>';
  return h;
}

/* ── 系统明细（0.15.5 并入概览页）─────────────────────────
 *
 * 为什么从独立页改成折叠区：原「系统状态」页与概览卡片是**同一批数据的
 * 摘要版与细节版**，两页并存让用户要记两个入口；合并后摘要在上、细节随用展开，
 * 导航少一项，诊断能力一项不少。旧书签 #/system 由路由回落兜底，不会死页。
 */
function systemDetailsHtml(s) {
  let html = '<div class="panel"><h2>系统明细（诊断用）</h2>'
    + '<div class="faint">原「系统状态」页的全部实测细节，按排查问题的顺序分成四块、默认折叠。</div>';

  // ── 明细 1：平台信息 + 配置来源 ─────────────────────────
  html += '<details class="sys-details"><summary>平台信息与配置来源（每项实际从哪来）</summary>'
    + '<dl class="kv">'
    + kv('版本', s.platform.version) + kv('Node', s.platform.node.current)
    + kv('进程', s.platform.pid + ' · ' + esc(s.platform.startedAt))
    + kv('已运行', dur(s.platform.uptimeMs))
    + kv('数据目录', '<span class="mono">' + esc(s.platform.dataDir) + '</span>')
    + '</dl>'
    + '<div class="faint">每一项都标明它<b>实际从哪来</b>，避免"改了没生效"的困惑。</div>'
    + '<div class="table-wrap"><table><thead><tr><th>项</th><th>值</th><th>来源</th></tr></thead><tbody>';
  const src = s.config.sources || {};
  for (const k of Object.keys(src)) {
    const val = k === 'dshToken' ? (s.config.values.hasToken ? '（已配置，不回显）' : '（未配置）') : (s.config.values[k] != null ? s.config.values[k] : '—');
    html += '<tr><td>' + esc(k) + '</td><td class="mono">' + esc(val) + '</td><td><span class="badge dim">' + esc(src[k]) + '</span></td></tr>';
  }
  html += '</tbody></table></div>'
    + '<div class="faint">配置文件 <span class="mono">' + esc(s.config.file) + '</span>'
    + (s.config.exists ? '（存在）' : '（不存在，全部走默认值/环境变量）') + '</div>'
    + '</details>';

  // ── 明细 2：数据库 + 迁移 ─────────────────────────────
  const db = s.database || {};
  const mig = s.migrations || {};
  html += '<details class="sys-details"><summary>数据库与迁移（SQLite 实测 / 迁移版本）</summary>'
    + '<dl class="kv">'
    + kv('SQLite', db.sqliteVersion) + kv('日志模式', db.journalMode)
    + kv('表 / 视图', db.tables) + kv('页', (db.pageCount || 0) + ' × ' + (db.pageSize || 0) + ' 字节')
    + kv('文件大小', bytes(db.bytes)) + kv('文件', '<span class="mono">' + esc(db.file || '—') + '</span>')
    + '</dl><dl class="kv">'
    + kv('已应用', mig.appliedCount + ' / ' + mig.totalFiles)
    + kv('当前版本', mig.currentVersion || '—') + kv('最新版本', mig.latestVersion || '—')
    + kv('待应用', (mig.pending && mig.pending.length) ? mig.pending.join(', ') : '无')
    + '</dl>';
  if (mig.problems && mig.problems.length) {
    html += '<div class="note fail">' + mig.problems.map((p) => esc(p.message)).join('<br>') + '</div>';
  }
  html += '</details>';

  // ── 明细 3：前端产物 ─────────────────────────────────
  const assets = s.staticAssets || [];
  const missingAssets = assets.filter((a) => !a.exists);
  const appPieces = assets.filter((a) => a.file.indexOf('app/') === 0).length;
  html += '<details class="sys-details"><summary>前端产物对账（' + appPieces + ' 个分片是否就位）</summary>'
    + '<div class="faint">清单由 <span class="mono">index.html</span> 现读：页面真的会去取的每个文件都在这里。'
    + '前端按域分成 ' + appPieces + ' 片、按顺序加载（拆分依据见 <span class="mono">docs/architecture.md</span> §7.8）。</div>';
  if (missingAssets.length) {
    html += '<div class="table-wrap"><table><thead><tr><th>文件</th><th>状态</th><th>大小</th></tr></thead><tbody>';
    for (const a of missingAssets) {
      html += '<tr><td class="mono">' + esc(a.file) + '</td><td><span class="badge fail">缺失</span></td><td>' + bytes(a.size) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  } else {
    html += '<p><span class="badge ok">就位</span> index.html 引用的 ' + assets.length
      + ' 个资源全部存在（其中 <span class="mono">public/app/</span> 分片 ' + appPieces + ' 个）。</p>';
  }
  html += '</details>';

  // ── 明细 4：原始响应 ─────────────────────────────────
  html += '<details class="sys-details"><summary>原始响应 JSON（/api/system/status 完整返回）</summary>'
    + '<div class="mono-block">' + esc(JSON.stringify(s, null, 2)) + '</div></details>';

  html += '</div>';
  return html;
}

function pageRoutes() {
  const r = State.routes;
  if (!r) return loadingOrError();
  let html = '<div class="panel"><h2>路由表（' + r.routes.length + ' 条）</h2>'
    + '<div class="faint">表中每一条都是运行中的服务当前真实提供的接口 —— 条数读自服务本身，不是手写文档。</div>'
    + '<div class="table-wrap"><table><thead><tr><th>方法</th><th>路径</th><th>scope</th><th>声明权限</th><th>说明</th></tr></thead><tbody>';
  for (const x of r.routes) {
    html += '<tr>'
      + '<td class="mono">' + esc(x.method) + '</td>'
      + '<td class="mono">' + esc(x.path) + '</td>'
      + '<td><span class="badge dim">' + esc(x.scope) + '</span></td>'
      + '<td class="mono faint">' + esc((x.capability || []).join(', ') || '—') + '</td>'
      + '<td class="muted">' + esc(x.summary || '') + '</td></tr>';
  }
  html += '</tbody></table></div>';
  html += '<div class="faint" style="margin-top:10px">按 scope：'
    + Object.entries(r.stats.byScope).map(([k, v]) => esc(k) + ' ' + v).join('，') + '</div></div>';

  // OpenAPI：**从上面这张表生成的**，所以新增路由它自动就有 —— 这是"不会漂移"的唯一可行形态。
  html += '<div class="panel"><h2>OpenAPI 规格</h2>'
    + '<div class="faint">需要对接的外部系统可以直接拿这份规格：'
    + '<a href="/api/system/openapi.json" target="_blank" rel="noreferrer"><b>下载 /api/system/openapi.json</b></a>'
    + '（OpenAPI 3.0，可导入 Postman / Insomnia / Swagger UI）。</div>'
    + '<div class="note">⚠️ 它<b>由上面这张路由表生成</b>：接口有增减时，规格自动同步。</div>'
    + '<div class="faint">本平台的请求体/响应体是<b>运行时校验</b>，没有逐字段 JSON Schema。'
    + '因此这份规格给的是<b>接口清单 + 权限模型 + 状态码语义</b>，'
    + '<b>不是逐字段契约</b> —— 字段形状以真实响应为准。</div></div>';
  return html;
}

/* 契约与映射页
 *
 * ⚠️ 这页曾经**整页崩**，症状是"点侧栏没反应"。链条：
 *   后端 `compat` 段早已是四态（verified / partial / streamSourced / refuted），
 *   且基线版本键名是 `compatVersion`；前端却仍按 `compat.version` / `compat.mapped` /
 *   `compat.unverified.length` 读 → `undefined.length` 抛 TypeError → `render()`
 *   是"先算 body、再写 innerHTML"，异常一抛 innerHTML 根本没执行 → hash 变了、画面不动。
 *
 * 现在的纪律：**只读后端真实返回的字段**，且数组一律过 `arr()`。
 * 后端将来再改字段名，这页最多少显示一块，不会把整个应用带下去。
 * 回归钉：test-frontend「逐路由渲染：每一页都不抛异常」。
 */
function pageContract() {
  const c = State.contract;
  if (!c) return loadingOrError();
  const ct = c.contract || {};
  const map = c.mapping || null;
  const compat = c.compat || null;

  const methods = arr(ct.methods);
  const optional = arr(ct.optionalMethods);
  const eventTypes = arr(ct.eventTypes);
  const usageFields = arr(ct.usageFields);
  const roles = arr(ct.roles);

  const chips = (list, cls) => '<div class="chip-wrap">' + (list.length
    ? list.map((m) => '<span class="chip' + (cls ? ' ' + cls : '') + '">' + esc(m) + '</span>').join('')
    : '<span class="muted">—</span>') + '</div>';

  // ── 面板 1：契约本身 ──────────────────────────────────
  let html = '<div class="panel"><h2>契约（版本 ' + esc(ct.version) + '）</h2>'
    + '<div class="faint">产品层与前端<b>只认识这份契约</b>；上游专有概念一律在<b>内核适配层</b>里被翻译成它的形状，'
    + '因此换内核时改动范围是可枚举的 —— 这一页就是把"可枚举"摊开给你看。</div>'
    + '<div class="cards">'
    + card('必选方法', methods.length, '内核必须实现')
    + card('可选方法', optional.length, '内核可以不实现')
    + card('事件类型', eventTypes.length, '流式事件')
    + card('消息角色', roles.length, '')
    + '</div>'
    + '<h3>必选方法（' + methods.length + '）</h3>' + chips(methods);
  if (optional.length) html += '<h3>可选方法（' + optional.length + '）</h3>' + chips(optional, 'dim');
  html += '<h3>事件类型（' + eventTypes.length + '）</h3>' + chips(eventTypes)
    + '<h3>用量语义字段</h3>' + chips(usageFields)
    + '<div class="note">用量字段的<b>计费口径</b>（计费输入 = 输入 + 缓存读 + 缓存写）'
    + '与「配额与用量」页共用同一套规则，此处不重复定义 —— 两处各写一份必然漂移。</div>'
    + '</div>';

  // ── 面板 2：事件映射覆盖率 ────────────────────────────
  if (map) {
    const mVerified = arr(map.verified);
    const mUnverified = arr(map.unverified);
    const bySource = (map.bySource && typeof map.bySource === 'object') ? map.bySource : null;
    const jc = (map.journalCoverage && typeof map.journalCoverage === 'object') ? map.journalCoverage : null;
    const pluginTypes = arr(map.pluginEventTypes);

    html += '<div class="panel"><h2>事件映射覆盖率</h2>'
      + '<div class="faint">上游事件类型 → 内核事件的映射规则。'
      + '<b>未核实的规则会明确标出</b> —— 它们是对着真实上游核实之前的推测，请以实测为准。</div>'
      + '<div class="cards">'
      + card('规则总数', map.ruleCount == null ? '—' : map.ruleCount, '')
      + card('已核实', '<span class="badge ok">' + mVerified.length + '</span>', '对着真实事件流验证过')
      + card('未核实', '<span class="badge warn">' + mUnverified.length + '</span>', '需要真实环境验证')
      + '</div>';

    if (bySource) {
      html += '<h3>规则来源</h3><div class="table-wrap"><table>'
        + '<thead><tr><th>来源</th><th>条数</th><th>规则</th></tr></thead><tbody>';
      for (const [src, list] of Object.entries(bySource)) {
        const l = arr(list);
        html += '<tr><td class="mono">' + esc(src) + '</td><td>' + l.length + '</td>'
          + '<td class="mono">' + esc(l.join('  ')) + '</td></tr>';
      }
      html += '</tbody></table></div>'
        + '<div class="faint">来源标记的含义：带版本号的（如 <span class="mono">live@…</span> / <span class="mono">types@…</span>）'
        + '来自对该版本上游的实测；<span class="mono">baseline</span> 来自基线实现的既有代码'
        + '（有代码依据，但不是对本版本上游的动态验证）；<span class="mono">guess</span> 是尚未核实的推测，'
        + '上面"未核实"一栏列的就是它们。</div>';
    }

    if (mVerified.length) html += '<h3>已核实（' + mVerified.length + '）</h3>' + chips(mVerified, 'ok');
    html += '<h3>未核实（' + mUnverified.length + '）</h3>';
    if (mUnverified.length) {
      html += '<div class="table-wrap"><table><thead><tr><th>规则</th><th>说明</th></tr></thead><tbody>';
      for (const u of mUnverified) {
        html += '<tr><td class="mono">' + esc(u && u.id) + '</td><td class="muted">' + esc((u && u.note) || '（未附说明）') + '</td></tr>';
      }
      html += '</tbody></table></div>';
    } else {
      html += '<div class="faint">全部规则均已核实。</div>';
    }

    if (jc) {
      const uncov = arr(jc.uncovered);
      html += '<h3>日志事件覆盖（' + (jc.covered == null ? '—' : jc.covered) + ' / ' + (jc.total == null ? '—' : jc.total) + '）</h3>'
        + (uncov.length
          ? '<div class="note warn">尚未覆盖：<span class="mono">' + esc(uncov.join('  ')) + '</span></div>'
          : '<div class="faint">上游写入会话日志的每一类事件，平台都已能落到本地库 —— 回放不会丢段。</div>');
      if (map.journalCoverageNote) html += '<div class="faint">' + esc(map.journalCoverageNote) + '</div>';
    }

    if (pluginTypes.length) {
      html += '<h3>内核插件事件类型（' + pluginTypes.length + '）</h3>' + chips(pluginTypes, 'dim')
        + '<div class="faint">这些类型由上游的插件机制产生。平台<b>原样记录</b>以便排查，但不为它们定义业务语义。</div>';
    }

    if (map.note) html += '<div class="note">' + esc(map.note) + '</div>';
    html += '</div>';
  }

  // ── 面板 3：兼容基线 ──────────────────────────────────
  if (compat) {
    const cVerified = arr(compat.verified);
    const cPartial = arr(compat.partial);
    const cStream = arr(compat.streamSourced);
    const cRefuted = arr(compat.refuted);

    html += '<div class="panel"><h2>兼容基线（' + esc(compat.compatVersion) + '）</h2>'
      + '<div class="faint">契约方法 → 上游方法的对应关系。'
      + (compat.verifiedBy ? '核实方式：<b>' + esc(compat.verifiedBy) + '</b>。' : '')
      + '未核实的映射默认<b>拒绝调用</b>，以免"看着能跑、实际静默错误"。</div>'
      + (compat.summary ? '<div class="note">' + esc(compat.summary) + '</div>' : '')
      + '<div class="cards">'
      + card('已核实', '<span class="badge ok">' + cVerified.length + '</span>', '可直接调用')
      + card('部分核实', '<span class="badge warn">' + cPartial.length + '</span>', '可用但有已知限制')
      + card('事件流来源', '<span class="badge warn">' + cStream.length + '</span>', '不走 RPC，从事件流取')
      + card('已证伪', '<span class="badge fail">' + cRefuted.length + '</span>', '实测不存在，禁止调用')
      + '</div>'
      + '<h3>已核实（' + cVerified.length + '）</h3>' + chips(cVerified, 'ok');
    if (cPartial.length) html += '<h3>部分核实（' + cPartial.length + '）</h3>' + chips(cPartial, 'warn');
    if (cStream.length) {
      html += '<h3>事件流来源（' + cStream.length + '）</h3>' + chips(cStream, 'warn')
        + '<div class="faint">这几项能力上游<b>没有对应的 RPC</b>，平台从事件流里取 —— '
        + '所以它们不会出现在"方法"调用统计里。</div>';
    }
    html += '<h3>已证伪（' + cRefuted.length + '）</h3>';
    if (cRefuted.length) {
      html += chips(cRefuted, 'fail')
        + '<div class="faint">这些名字<b>看着像上游方法、实测并不存在</b> —— 平台显式禁止调用，避免误用。</div>';
    } else {
      html += '<div class="faint">无。</div>';
    }
    if (compat.selected) {
      html += '<div class="note">当前选中基线：<span class="mono">' + esc(compat.selected) + '</span>'
        + (compat.exact ? '（与运行中上游版本<b>精确匹配</b>）' : '（<b>非精确匹配</b>，请留意差异）') + '</div>';
    }
    if (compat.warning) html += '<div class="note fail">' + esc(compat.warning) + '</div>';
    html += '</div>';
  }

  return html;
}

function pageMiddleware() {
  const m = State.middleware;
  if (!m) return loadingOrError();
  let html = '<div class="panel"><h2>中间件链</h2>'
    + '<div class="faint">每个 scope 的请求按下面的顺序经过一组处理环节（鉴权、审计、配额等都在这一层完成）。</div>'
    + '<h3>各 scope 的执行顺序</h3><div class="mono-block">';
  for (const [scope, chain] of Object.entries(m.chains || {})) {
    html += esc(scope.padEnd(8)) + '  ' + esc((chain || []).join(' → ')) + '\n';
  }
  html += '</div>';
  html += '<h3>状态</h3><div class="table-wrap"><table><thead><tr><th>中间件</th><th>状态</th><th>职责</th></tr></thead><tbody>';
  for (const x of m.middlewares) {
    const cls = x.state === 'active' ? 'ok' : (x.state === 'partial' ? 'warn' : 'warn');
    const text = x.state === 'active' ? '已启用' : (x.state === 'partial' ? '部分（写入可用）' : '未启用');
    html += '<tr><td class="mono">' + esc(x.name) + '</td>'
      + '<td><span class="badge ' + cls + '">' + esc(text) + '</span></td>'
      + '<td class="muted">' + esc(x.note) + '</td></tr>';
  }
  html += '</tbody></table></div>';
  html += '<div class="note warn">' + esc(m.note) + '</div></div>';
  return html;
}

/* STI HARNESS 前端 · 外壳与治理页：写操作收口 / 顶栏 / 审计 / 配额与用量 / 成本 / 会话日志
 * Copyright 2026 liwei（易智瑞西安）.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/** 写操作统一收口：401 就回登录页，403 明确说清缺什么，其余原样提示。 */
async function guard(fn) {
  State.busy = true; State.error = null; State.notice = null;
  render();
  try {
    State.notice = await fn();
  } catch (e) {
    if (e.status === 401) {
      State.me = null; State.view = 'login';
      State.error = '会话已失效，请重新登录。';
    } else if (e.status === 403) {
      const d = (e.payload && e.payload.error && e.payload.error.detail) || {};
      State.error = '没有权限执行该操作。' + (d.needs ? '需要：' + JSON.stringify(d.needs) : '')
        + (d.roles ? '；当前角色：' + JSON.stringify(d.roles) : '');
    } else {
      State.error = e.message;
    }
  } finally {
    State.busy = false; render();
  }
}

/* ── 渲染 ─────────────────────────────────────────────── */
function navHtml() {
  const cur = App.currentRoute();
  let html = '';
  const groups = [];
  for (const r of ROUTES) {
    if (r.need && !allowed(r.need[0], r.need[1])) continue;   // 没权限就不显示入口
    let g = groups.find((x) => x.name === r.group);
    if (!g) { g = { name: r.group, items: [] }; groups.push(g); }
    g.items.push(r);
  }
  for (const g of groups) {
    html += '<div class="group"><div class="group-title">' + esc(g.name) + '</div>';
    for (const r of g.items) {
      html += '<div class="nav-item' + (r.id === cur.id ? ' active' : '') + '"' + navAttr(r.hash) + '>'
        + esc(r.title) + '</div>';
    }
    html += '</div>';
  }
  if (PLANNED.length) {
    html += '<div class="group"><div class="group-title">尚未交付</div>';
    for (const p of PLANNED) {
      html += '<div class="nav-item disabled" title="计划在 ' + esc(p.milestone) + ' 交付">'
        + esc(p.title) + '<span class="tag">' + esc(p.milestone) + '</span></div>';
    }
    html += '</div>';
  }
  return html;
}

/* 顶栏（0.21.10 重排）。
 *
 * 用户原话：「标题栏右侧有点乱重新改一下布局，重新组织显示一下（内核已接入、v0.21.7、
 * 亮色、geoscene 所有者、登出）样式很难看，一堆平铺这里也不美观」。
 *
 * 旧写法的病根**不是样式不够好看，而是把五种不同性质的东西做成了同一种东西**：
 *   内核已接入（**状态**）｜v0.21.7（**版本**）｜亮色（**动作**）｜geoscene 所有者（**身份**）｜登出（**动作**）
 * 五个都平铺成 badge / button，等宽等高排在一条线上，于是：
 *   · 分不清哪个能点哪个不能点（badge 和 button 长得几乎一样）；
 *   · 「亮色」是个**动词**却和「已接入」这种**名词**并排，读上去像在描述当前主题；
 *   · 身份被拆成两截（"geoscene" 一截、"所有者"一截）还夹着登出，扫读时对不上号。
 * 所以这一版不做"美化"，做**归类**：把右侧收成三个组，组内同质、组间异质。
 *
 *   ① 内核状态（状态，只读）
 *   ② 版本（元信息，只读）
 *   ③ 账号区（身份 + 它自己的动作）—— 内部分两行：上行是"我是谁"，下行是"我能做啥"
 *
 * ⚠️ 两个**不许动**的口径：
 *   · 「内核已接入」这句文案与 `badge ok` / `badge fail` 的档位映射原样保留 ——
 *     `render()` 先整页拦住未接入的情形，所以走到这里几乎必然是 ok，但**保留 fail 分支**：
 *     内核可以热切换后变不可用（0.21.3），那时这一格是唯一的提示。
 *   · `data-act="toggleTheme"` / `data-act="logout"` 两个动作名是**接口**（事件委托按名字找），
 *     换布局不许改名，否则按钮点了没反应。
 */
function topbar() {
  const s = State.status;
  // 内核只有两种状态（0.21.4）；未接入时走不到这里（render 会先整页拦住）。
  const kernelTag = s
    ? (s.kernel.ready ? '<span class="badge ok">内核已接入</span>' : '<span class="badge fail">内核未接入</span>')
    : '<span class="badge dim">…</span>';
  const u = (State.me && State.me.user) || null;
  const themeLabel = topic() === 'dark' ? '亮色' : '暗色';

  // ⚠️ 角色**整个去掉**（用户 2026-10-08：「角色就不用再单独显示啦 直接去掉」）。
  //    这里不再算 roleTxt、也不再引用 myRoles/roleName —— 要恢复的话应做成下拉里的
  //    一行只读小字，而不是塞回这一行（长名字 + 长角色串同行必然互相抢位置，
  //    那正是用户最初说"一堆平铺"的来源之一）。

  return '<div class="topbar">'
    + '<div class="brand">STI <b>HARNESS</b><small>企业级时空智能体生产平台</small></div>'
    + '<div class="spacer"></div>'
    // ① 状态组：内核可用性 + 版本号 + 主题切换。
    //    用户 2026-10-08：「亮色暗色放到版本显示旁边」—— 所以它跟版本走。
    + '<div class="topbar-group">'
    + kernelTag
    + (s ? '<span class="badge dim">v' + esc(s.platform.version) + '</span>' : '')
    // ⚠️ 主题切换**不受 `u` 影响**：它是纯显示偏好，跟"我是谁"无关。
    + '<button class="ghost" ' + act('toggleTheme') + ' title="切换主题">' + themeLabel + '</button>'
    + '</div>'
    // ② 账号区：**名字就是下拉入口**，点开才有「我的账号 / 登出」。
    //    用户 2026-10-08：「geoscene 下拉登出 可以吗」+「下拉显示我的账号、登出，
    //    角色就不用再单独显示啦 直接去掉」—— 所以这里不再是"名字 + 角色徽标 + 登出按钮"
    //    三个东西平铺，而是**一个**入口，里面两项。
    + (u ? wbAccountMenuHtml(u) : '')
    + '</div>';
}

/**
 * 顶栏的账号下拉（0.21.11）。
 *
 * 与工作台左栏那个 `wbAccountHtml` 是**同一个交互**、但**不是同一个函数**：
 * 两处的容器布局不同（这里在横向的 `.topbar` 里，那里在纵向的侧栏底部），
 * 定位方向也相反（这里朝下弹，那里朝上弹）。共用会逼出一个"根据父容器改行为"
 * 的参数，比各写一份更绕。**外观与菜单项两处必须一致**（都由 `.wb-menu` 给）。
 *
 * 状态：`State.topbarMenu`。与 `State.wb.accountMenu` 分开，因为两者可以同时存在
 * （工作台不渲染顶栏，反之亦然），共用会让"在后台开菜单、切到工作台"互相干扰。
 */
function wbAccountMenuHtml(u) {
  const nm = u.displayName || u.username || '';
  const open = !!State.topbarMenu;

  let h = '<div class="topbar-account' + (open ? ' menu-open' : '') + '">'
    + '<button class="topbar-account-id" ' + act('toggleTopbarMenu')
    + ' title="账号" aria-haspopup="menu" aria-expanded="' + (open ? 'true' : 'false') + '">'
    + '<span class="topbar-avatar" aria-hidden="true">' + esc(String(nm).slice(0, 1)) + '</span>'
    + '<span class="topbar-name">' + esc(nm) + '</span>'
    + wbIcon('chevronDown', 'sm')
    + '</button>';

  if (open) {
    // ⚠️ 用 `.wb-menu`（工作台那套）保持外观一致。它是 `position:absolute` +
    //    `top:100%`，正是顶栏要的**向下弹** —— 所以这里不用覆盖定位。
    //    ⚠️ 但 `.wb-menu` 默认 `min-width:132px`、`right:4px`：顶栏这颗入口更窄，
    //    需要 `.topbar-account-menu` 调一下对齐（见 style.css）。
    h += '<div class="wb-menu topbar-account-menu" role="menu">'
      + '<button ' + act('goMe') + '>我的账号</button>'
      + '<div class="wb-menu-sep"></div>'
      + '<button class="danger" ' + act('logout') + '>登出</button>'
      + '</div>';
  }
  return h + '</div>';
}

/* ── 治理与审计（M3）──────────────────────────────────── */

function resultBadge(result) {
  const map = { ok: ['ok', '成功'], denied: ['fail', '拒绝'], error: ['fail', '错误'] };
  const [cls, text] = map[result] || ['dim', result || '—'];
  return '<span class="badge ' + cls + '">' + esc(text) + '</span>';
}

function fmtN(n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); }

function auditStatusHtml() {
  const v = State.auditVerify;
  const latest = State.auditData && State.auditData.latestHash;
  let html = '<div class="panel"><h2>哈希链状态</h2>';
  html += '<dl class="kv">'
    + kv('链尾哈希（最新一条）', latest ? '<span class="mono">' + esc(String(latest).slice(0, 16)) + '…</span>' : '—（本租户还没有审计记录）')
    + '</dl>';
  if (v) {
    html += v.ok
      ? '<div class="note">✓ 上次校验：' + esc(String(v.checked)) + ' 条记录全部重算通过（' + esc(String(v.total)) + ' 条）</div>'
      : '<div class="note fail"><b>哈希链在第 ' + esc(String((v.brokenAt && v.brokenAt.index) + 1)) + ' 条断裂</b>：'
        + esc(String(v.brokenAt && v.brokenAt.action)) + '（' + esc(String(v.brokenAt && v.brokenAt.id)) + '）'
        + ' —— 自该条起记录不可信，请立即排查谁改了库。</div>';
  }
  html += '<div class="row" style="margin-top:10px"><button class="primary" ' + act('verifyAudit') + (State.busy ? ' disabled' : '') + '>重算并校验整条链</button></div>';
  html += '<div class="faint" style="margin-top:8px">校验会重算全部 hash（审计多了会稍慢）；"校验审计链"这个动作本身也会落一条审计。</div></div>';
  return html;
}

function pageAudit() {
  if (!State.auditData) return loadingOrError();
  let html = auditStatusHtml();
  html += '<div class="panel"><h2>审计记录（' + esc(fmtN(State.auditData.total)) + ' 条，显示最近 ' + esc(String(State.auditData.items.length)) + ' 条）</h2>';
  html += '<div class="row">'
    + '<input id="audit-f-action" placeholder="按动作前缀过滤，如 governance." style="width:220px" value="' + esc((State.auditData.filters && State.auditData.filters.action) || '') + '">'
    + '<select id="audit-f-result"><option value="">全部结果</option>'
    + ['ok', 'denied', 'error'].map((r) => '<option value="' + r + '"' + ((State.auditData.filters && State.auditData.filters.result) === r ? ' selected' : '') + '>' + ({ ok: '成功', denied: '拒绝', error: '错误' }[r]) + '</option>').join('')
    + '</select>'
    + '<button ' + act('filterAudit') + '>应用过滤</button>'
    + '</div><div class="table-wrap" style="margin-top:10px"><table><thead><tr>'
    + '<th>时间</th><th>动作</th><th>结果</th><th>操作者</th><th>资源</th><th>详情</th></tr></thead><tbody>';
  for (const a of State.auditData.items) {
    const d = a.detail && typeof a.detail === 'object' ? a.detail : {};
    const brief = [d.method, d.path ? '(' + d.path + ')' : '', d.reason || '', d.decision || '', d.metric || '', d.policy || '']
      .filter(Boolean).join(' ');
    html += '<tr><td class="mono" style="white-space:nowrap">' + esc(String(a.at || '').replace('T', ' ').slice(0, 19)) + '</td>'
      + '<td class="mono">' + esc(a.action) + '</td>'
      + '<td>' + resultBadge(a.result) + '</td>'
      + '<td class="mono">' + esc(a.user_id || '（匿名）') + '</td>'
      + '<td class="mono">' + esc(a.resource_type ? a.resource_type + (a.resource_id ? ':' + a.resource_id : '') : '—') + '</td>'
      + '<td class="muted">' + esc(brief || '—') + '</td></tr>';
  }
  html += '</tbody></table></div>';
  html += '<div class="note">每条记录的 hash 覆盖前一条的 hash —— 改任何一行，从那一行起整条链都会对不上。'
    + '但它防的是"事后改数据"；有写权限的人整表重写链防不住 —— 那需要把链尾 hash 定期外发到平台之外。'
    + '<b>P1-2 补上了这条腿</b>（见下方「链状态与锚点」）：归档把超期记录写成可独立复算的副本，'
    + '锚定每日固定链尾 hash。但请注意 —— <b>锚点与链在同一台机器上等于没锚</b>：'
    + '只有把锚点放到只读介质/异地，或通过「通知渠道」出站到外部，"防整表重写"这句话才真正成立。</div></div>';

  /* 链状态与锚点（P1-2） */
  const chain = State.auditData.chain || null;
  const anchors = State.auditData.anchors || [];
  if (chain) {
    html += '<div class="panel"><h2>链状态与锚点</h2>';
    html += '<div class="table-wrap"><table><thead><tr>'
      + '<th>主表保留</th><th>已归档</th><th>链基准（归档段链尾）</th><th>最近归档</th></tr></thead><tbody><tr>'
      + '<td class="mono">' + esc(fmtN(chain.retained)) + ' 条</td>'
      + '<td class="mono">' + esc(fmtN(chain.archivedCount)) + ' 条</td>'
      + '<td class="mono faint" style="word-break:break-all">' + esc(chain.baseHash ? chain.baseHash.slice(0, 24) + '…' : '（从未归档，起点为空串）') + '</td>'
      + '<td>' + (chain.archivedAt ? esc(ts(chain.archivedAt)) : '<span class="faint">从未归档</span>') + '</td>'
      + '</tr></tbody></table></div>';
    html += '<div class="faint" style="margin-top:8px">归档会删掉主表里最旧的记录 —— 因此"链基准"记录着被归档那一段的链尾 hash，'
      + '它是剩余链的起点。列表上方「校验链」正是从这里起算的，否则归档之后每次校验都会误报断裂。</div>';

    if (anchors.length) {
      html += '<h3 style="margin-top:14px">锚点历史（最近 ' + anchors.length + ' 天）</h3>'
        + '<div class="table-wrap"><table><thead><tr><th>日期</th><th>链尾 hash</th><th>当时记录数</th><th>落盘</th></tr></thead><tbody>';
      for (const a of anchors) {
        html += '<tr><td class="mono">' + esc(a.day) + '</td>'
          + '<td class="mono faint" style="word-break:break-all">' + esc(String(a.tailHash || '').slice(0, 32)) + '…</td>'
          + '<td class="mono">' + esc(fmtN(a.recordCount)) + '</td>'
          + '<td class="faint">' + esc(a.filePath ? '已写入 data/anchor/' : '未写文件（未装配目录）') + '</td></tr>';
      }
      html += '</tbody></table></div>';
    } else {
      html += '<div class="empty">还没有锚点。启用「调度中心」里的 <span class="mono">audit.anchor</span> 任务后，每日会固定一份。</div>';
    }
    html += '<div class="note">' + esc((State.auditData.retention && State.auditData.retention.note) || '') + '</div></div>';
  }
  return html;
}

/** 配额行内编辑器（0.16.0）：只编辑「多严（上限）、怎么严（模式）、开没开（启用）」。
 *  对象/指标/周期是规则的业务身份，改身份=删旧建新，走删除+新增而不是这里。 */
function quotaEditorHtml(q) {
  const id = esc(q.id);
  return '<details style="margin-bottom:6px"><summary>编辑</summary>'
    + '<div class="row" style="margin-top:6px;flex-wrap:wrap;align-items:flex-end">'
    + '<label>上限<input id="qe-' + id + '-limit" type="number" min="1" step="1" value="'
    + esc(String(q.limitValue)) + '" style="width:110px"></label>'
    + '<label>模式<select id="qe-' + id + '-mode" style="width:auto">'
    + '<option value="block"' + (q.mode === 'warn' ? '' : ' selected') + '>block（拦截）</option>'
    + '<option value="warn"' + (q.mode === 'warn' ? ' selected' : '') + '>warn（提醒）</option>'
    + '</select></label>'
    + '<label><input id="qe-' + id + '-enabled" type="checkbox"' + (q.enabled ? ' checked' : '') + '> 启用</label>'
    + '<button class="primary" ' + act('updateQuota', id) + (State.busy ? ' disabled' : '') + '>保存</button>'
    + '</div>'
    + '<div class="faint">对象 / 指标 / 周期是这条规则的身份，不能在此改 —— 换对象请删除后重新新增，审计上才看得清"给谁加了什么"。</div>'
    + '</details>';
}

function pageQuotas() {
  if (!State.quotasData) return loadingOrError();
  const u = State.usageData;
  let html = '<div class="panel"><h2>配额规则</h2>';
  // 语义**逐条来自服务端**（`semantics`），不再只写死 turns/token 两句：
  // 早先那种写法漏掉了 concurrent —— 于是在这里配了并发上限的人，
  // 页面上找不到任何解释，只能猜"已用 0/5"是什么意思（它是瞬时在途数，不是周期累计）。
  // 语义文案与判定逻辑必须同源，否则"文案说是闸、代码没闸"这类漂移没人能发现。
  const semantics = State.quotasData.semantics || {};
  const semKeys = Object.keys(semantics);
  if (semKeys.length) {
    html += '<div class="faint">' + semKeys.map((k) =>
      '<span class="mono">' + esc(k) + '</span>：' + esc(semantics[k])).join('<br>') + '</div>';
  } else {
    html += '<div class="faint">turns 是真·事前闸；token 类是软闸：按已用量在提交前拦截 —— 平台目前没有逐 token 的实时计费闸门。</div>';
  }
  html += '<div class="table-wrap" style="margin-top:10px"><table><thead><tr>'
    + '<th>对象</th><th>指标</th><th>周期</th><th>上限</th><th>已用量</th><th>模式</th><th></th></tr></thead><tbody>';
  for (const q of (State.quotasData.items || [])) {
    const pct = (q.evaluated && q.limitValue) ? Math.min(100, Math.round((q.used / q.limitValue) * 100)) : null;
    html += '<tr><td class="mono">' + esc(q.subjectType === 'tenant' ? '整个组织' : '用户 ' + q.subjectId) + '</td>'
      // 逐行的 note（如"并发是瞬时在途回合数"）也要出得来，否则只有指标名可看
      + '<td class="mono">' + esc(q.metric)
      + (q.note ? '<div class="faint">' + esc(q.note) + '</div>' : '') + '</td>'
      + '<td>' + esc(q.period) + '</td>'
      + '<td class="mono">' + esc(fmtN(q.limitValue)) + '</td>'
      + '<td class="mono">' + esc(fmtN(q.used)) + (pct != null ? ' <span class="badge ' + (pct >= 100 ? 'fail' : pct >= 80 ? 'warn' : 'dim') + '">' + pct + '%</span>' : '') + '</td>'
      + '<td>' + esc(q.mode === 'warn' ? 'warn（提醒）' : 'block（拦截）') + '</td>'
      + '<td>' + (allowed('quota', 'write') ? quotaEditorHtml(q) : '')
      + '<button ' + act('removeQuota', esc(q.id)) + '>删除</button></td></tr>';
  }
  if (!(State.quotasData.items || []).length) {
    html += '<tr><td colspan="7" class="muted">还没有配额规则 —— 平台当前不限制任何用量。</td></tr>';
  }
  html += '</tbody></table></div>';

  html += '<h3 style="margin-top:16px">新增 / 更新配额</h3><div class="row">'
    + '<select id="q-subjecttype"><option value="tenant">整个组织</option><option value="user">按用户</option></select>'
    + '<input id="q-subjectid" placeholder="用户 id（按组织时留空）" style="width:180px">'
    + '<select id="q-metric">' + (State.quotasData.metrics || []).map((m) => '<option>' + esc(m) + '</option>').join('') + '</select>'
    + '<select id="q-period">' + (State.quotasData.periods || []).map((p) => '<option>' + esc(p) + '</option>').join('') + '</select>'
    + '<input id="q-limit" placeholder="上限" style="width:110px">'
    + '<select id="q-mode"><option value="block">block</option><option value="warn">warn</option></select>'
    + '<button class="primary" ' + act('upsertQuota') + (State.busy ? ' disabled' : '') + '>保存</button>'
    + '</div></div>';

  html += '<div class="panel"><h2>用量（来自 usage 事件，逐字段照抄，无估算）</h2>';
  if (!u) { html += '<div class="muted">用量读取失败或暂无权限。</div></div>'; return html; }
  const t = u.totals || {};
  html += '<div class="cards">'
    + card('计费输入<br><span class="faint">input+cacheRead+cacheWrite</span>', fmtN(t.billableInput))
    + card('输出', fmtN(t.output), 'reasoning ' + fmtN(t.reasoning) + '（已含在输出里，不另计）')
    + card('缓存读', fmtN(t.cacheRead))
    + card('缓存写', fmtN(t.cacheWrite))
    + '</div>';
  const rows = u.byUser || [];
  if (rows.length) {
    html += '<h3>按用户</h3><div class="table-wrap"><table><thead><tr><th>用户</th><th>输入</th><th>输出</th><th>回合</th></tr></thead><tbody>';
    for (const r of rows) {
      // 用户列显示**用户名**（服务端 JOIN 带出），裸 ID 只是兜底 ——
      // 治理面板是给人看的对账单，逼管理员去账号页逐个对号是浪费。
      const who = r.username && r.username !== '(已删除用户)'
        ? r.username + (r.displayName ? '（' + r.displayName + '）' : '')
        : String(r.userId || '(未登录)');
      html += '<tr><td>' + esc(who) + '</td><td class="mono">' + esc(fmtN(r.input + r.cacheRead + r.cacheWrite))
        + '</td><td class="mono">' + esc(fmtN(r.output)) + '</td><td class="mono">' + esc(fmtN(r.turns)) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  } else {
    html += '<div class="muted">还没有任何回合产生 usage 事件（提交一轮对话后这里会有真实数字）。</div>';
  }
  html += '</div>';

  html += costPanelHtml();
  return html;
}

/**
 * 成本估算面板（P1-3 / 4.4）。**独立成函数**，因为它与上面的用量面板口径不同：
 * 用量是事件里照抄的 token（客观），成本是 token × 当前单价（估算、依赖配置）。
 *
 * 三处最容易出错、因此必须在界面上直说的地方：
 *   · 未定价条目金额为 **null**，显示「未定价」而**不是 ¥0.00**；
 *   · 缓存读写各自用各自的价，没配就记未定价，**不用输入价顶替**；
 *   · 不同币种**分开合计**（CNY 与 USD 加一起是无意义的数）。
 */
function costPanelHtml() {
  const c = State.costData;
  let html = '<div class="panel"><h2>成本估算（token × 当前单价）</h2>';
  // 单位与公式写在最前面：这张表上的每个数都依赖它们，
  // 而"每百万 token 多少分"填成"多少元"会差 100 倍 —— 算错的金额看着和算对的一模一样。
  html += '<div class="faint">单位：<b>最小货币单位 / 每 100 万 token</b>'
    + '（人民币即"分 / 百万 token"）；金额 = Σ(token × 单价) ÷ 1 000 000。'
    + '单价在「模型中心」逐条登记。</div>';
  if (!c) { return html + '<div class="muted">成本读取失败或暂无权限（需要 quota:read）。</div></div>'; }
  if (c.error) {
    return html + '<div class="note fail">读取失败：' + esc(c.error) + '</div></div>';
  }
  const s = c.summary || {};
  const sem = c.semantics || {};

  // 合计**按币种分开** —— 把 CNY 与 USD 加在一起是个无意义的数，所以不做一个"总额"卡片。
  const totals = Object.values(s.totalsByCurrency || {});
  html += '<div class="cards">';
  if (totals.length) {
    for (const t of totals) {
      html += card('合计 <span class="faint">' + esc(t.currency || '（无币种）') + '</span>',
        esc(t.amount == null ? '未定价' : t.amount),
        t.models + ' 个模型条目｜已定价 token ' + esc(fmtN(t.pricedTokens)));
    }
  } else {
    html += card('合计', '<span class="faint">未定价</span>',
      '没有任何条目配了单价 —— 这不是"花了 0 元"，是"我们还不知道花了多少"');
  }
  if (s.mixedCurrency) {
    html += card('⚠️ 混合币种', '<span class="badge warn">分开合计</span>',
      '用量横跨多个币种，本页不把它们加总（加出来没有意义）');
  }
  const un = s.unattributed || {};
  if (un.usageRows) {
    html += card('未归因', esc(fmtN(un.tokens)) + ' <span class="faint">token</span>',
      un.usageRows + ' 行用量没记模型 → 不计入任何金额（拿默认模型的价去套会给出一个确定但错误的数）');
  }
  html += '</div>';

  // 逐模型明细：每一行都必须能回答"这个数是怎么来的"
  const items = s.items || [];
  if (items.length) {
    html += '<div class="table-wrap" style="margin-top:12px"><table><thead><tr>'
      + '<th>用量记录的模型名</th><th>归因到的条目</th><th>token（输入/缓存读/缓存写/输出）</th>'
      + '<th>单价（输入/缓存读/缓存写/输出）</th><th>金额</th><th>说明</th></tr></thead><tbody>';
    for (const it of items) {
      const tok = it.tokens || {};
      const cls = it.classes || [];
      const priceCellTxt = cls.map((x) =>
        '<span class="faint">' + esc(x.label) + '</span> '
        + (x.priceMinor === null
          ? '<span class="badge dim">未定价</span>'
          : '<span class="mono">' + esc(String(x.priceMinor)) + '</span>')).join('　');
      const cand = (it.providerCandidates || []);
      const provTxt = it.provider
        ? '<span class="mono">' + esc(it.provider.name) + '</span>'
          + '<div class="faint">' + esc(it.provider.kind) + '｜币种 ' + esc(it.provider.currency || '（缺）') + '｜'
          + '序号 ' + esc(String((cand[0] && cand[0].priority) != null ? cand[0].priority : '—')) + '</div>'
          + (cand.length > 1
            ? '<div class="faint">同模型名有 ' + cand.length + ' 条登记，按序号取第一条：'
              + cand.map((x) => esc(x.name) + '(' + esc(String(x.priority)) + ')').join('、') + '</div>'
            : '')
        : '<span class="badge fail">未登记</span><div class="faint">注册表里没有这个模型名 —— 不拿别的条目的价去套</div>';
      html += '<tr>'
        + '<td class="mono">' + esc(it.modelId) + '<div class="faint">' + esc(fmtN(it.usageRows)) + ' 行用量</div></td>'
        + '<td>' + provTxt + '</td>'
        + '<td class="mono">' + esc(fmtN(tok.input)) + ' / ' + esc(fmtN(tok.cacheRead)) + ' / '
        + esc(fmtN(tok.cacheWrite)) + ' / ' + esc(fmtN(tok.output)) + '</td>'
        + '<td>' + priceCellTxt + '</td>'
        + '<td class="mono">' + (it.amountMinor === null
          ? '<span class="badge dim" title="未定价 —— 不是 0 元">未定价</span>'
          : '<b>' + esc(it.amount) + '</b>') + '</td>'
        + '<td class="faint">' + esc(it.note || '') + '</td>'
        + '</tr>';
    }
    html += '</tbody></table></div>';
  } else {
    html += '<div class="empty" style="margin-top:12px">这段时间没有任何带模型归因的用量'
      + (un.usageRows ? '（另有 ' + esc(fmtN(un.tokens)) + ' token 未归因，见上方卡片）' : '') + '。</div>';
  }

  if ((s.notes || []).length) {
    html += '<div class="note" style="margin-top:10px">' + s.notes.map(esc).join('<br>') + '</div>';
  }
  // 口径逐条列出：这一段是给要拿这个数去汇报的人看的，不能省。
  html += '<div class="faint" style="margin-top:10px">'
    + '口径：' + esc(sem.amount || '') + '<br>'
    + esc(sem.pricing || '') + '<br>'
    + esc(sem.cachePrices || '') + '<br>'
    + esc(sem.attribution || '')
    + (c.window && (c.window.from || c.window.to)
      ? '<br>时间窗：' + esc(c.window.from || '不限') + ' ~ ' + esc(c.window.to || '不限')
      : '')
    + '</div>';
  html += '<div class="note">' + esc(c.note || '')
    + '<br>要让它有意义，必须给会话<b>登记模型</b>（工作台的模型下拉）—— '
    + '没登记过的会话，用量会落进上面的「未归因」桶，而不是被摊到某个模型的头上。</div>';
  return html + '</div>';
}

/* ── 会话日志（治理 → 会话日志）──────────────────────────── */

/**
 * 全量轨迹 log.zip 的唯一入口页。
 *
 * 此前这个能力只存在于后端（`GET /api/governance/sessions/:id/log.zip`，admin + artifact:read），
 * 前端零引用 —— 而工作台的导出截断提示却写着"完整轨迹请到「治理 → 会话日志」下载"，
 * 把用户指向一个不存在的页面。本页就是补上那个指路牌指向的地方。
 *
 * 呈现纪律：
 *   · 双权限（artifact:read 页闸门 / session:read 会话清单）**分开如实说**，不假装一回事；
 *   · ZIP 是二进制包，**不在页面里解包预览** —— 包内容逐项写清楚，落盘后用 ZIP 工具打开；
 *   · "快照不是备份""下载会记审计"两条边界必须在点击前可见（用户的知情权在动作之前）。
 */
function pageSessionLogs() {
  const d = State.sessionLogsData;
  if (!d) return loadingOrError();
  let html = '<div class="panel"><h2>这个 ZIP 里有什么</h2>'
    + '<div class="faint">一次导出 = 一场会话的全量轨迹：'
    + '<span class="mono">meta.json</span>（导出人 / 时间 / 条数）｜'
    + '<span class="mono">session.json</span>（会话元信息）｜'
    + '<span class="mono">events.jsonl</span>（全量事件，一行一条）｜'
    + '<span class="mono">artifacts.json</span>（产物清单）。'
    + '二进制包不在此页解包预览 —— 下载后用任何 ZIP 工具打开。</div>'
    + '<div class="note">两点边界先说：① 它是<b>快照不是备份</b> —— 导出之后该会话再发生的事不在包里；'
    + '② 每次下载都会在服务端记一条审计（<span class="mono">governance.sessionlog.export</span>，'
    + '含事件数 / 产物数 / 字节数）—— 谁导过哪场会话是事后可查的。</div></div>';
  if (d.noSessionRead) {
    return html + '<div class="panel"><h2>会话清单</h2><div class="note fail">'
      + '你当前没有 <span class="mono">session:read</span> 权限，列不出本组织的会话，'
      + '因此无法在这里挑要导出哪一场。log.zip 本身只需要 <span class="mono">artifact:read</span>（你有）；'
      + '会话清单要能看，请让管理员补上 session:read。</div></div>';
  }
  if (d.error) {
    return html + '<div class="panel"><h2>会话清单</h2>'
      + '<div class="note fail">读取失败：' + esc(d.error) + '</div></div>';
  }
  const items = arr(d.items);
  html += '<div class="panel"><h2>会话清单（' + esc(fmtN(items.length)) + ' 场，按最近活动排序）</h2>';
  if (!items.length) {
    html += '<div class="empty">这里还没有任何会话 —— 先去「对话工作台」问一次话，再回来导出它的轨迹。</div></div>';
    return html;
  }
  html += '<div class="table-wrap"><table><thead><tr>'
    + '<th>会话</th><th>事件数</th><th>最近活动</th><th>模型</th><th>轨迹导出</th>'
    + '</tr></thead><tbody>';
  for (const s of items) {
    const title = s.title || '(未命名会话)';
    html += '<tr>'
      + '<td><b>' + esc(title) + '</b><div class="faint mono">' + esc(s.id) + '</div></td>'
      + '<td class="mono">' + esc(fmtN(s.eventCount)) + '</td>'
      + '<td class="muted">' + esc(ts(s.updatedAt)) + '</td>'
      + '<td class="faint">' + (s.modelId
        ? esc(s.modelId) + '<div class="faint">' + esc(s.modelProvider || '') + '</div>'
        : '未登记') + '</td>'
      + '<td><button ' + act('downloadSessionLog', String(s.id), title)
      + (State.busy ? ' disabled' : '') + '>下载 log.zip</button></td>'
      + '</tr>';
  }
  html += '</tbody></table></div>'
    + '<p class="faint">包内是下载那一刻的快照，不含之后的新事件。</p></div>';
  return html;
}

/* STI HARNESS 前端 · 调度中心与通知渠道
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 平台设置（0.16.0）：config.json 运行参数的界面入口 ─────────────── */

function pageSettings() {
  if (!State.settings) return loadingOrError();
  const r = State.settings;
  const canWrite = allowed('system', 'write');
  const items = r.settings || [];

  const SECTIONS = [
    { title: '通用', keys: ['host', 'port', 'sessionTtlHours', 'trustProxy'] },
    {
      title: '知识与检索',
      keys: ['embeddingProvider', 'embeddingBaseUrl', 'embeddingModel', 'embeddingDim',
        'embeddingCredentialName', 'embeddingTimeoutMs', 'chunkMaxChars', 'chunkOverlapChars',
        'chunkMinChars', 'chunkMaxHeadingDepth', 'workerPoolSize', 'prefilterVector', 'prefilterCandidates'],
    },
  ];
  const byKey = {};
  for (const s of items) byKey[s.key] = s;

  const row = (s) => {
    if (!s) return '';
    const locked = !!s.envLocked;
    const dis = locked || !canWrite ? ' disabled' : '';
    const id = 'st-' + s.key;
    const input = s.type === 'boolean'
      ? '<input id="' + id + '" type="checkbox"' + (s.value ? ' checked' : '') + dis + '>'
      : '<input id="' + id + '" type="' + (s.type === 'number' ? 'number' : 'text') + '" step="any"'
        + ' value="' + esc(s.value == null ? '' : String(s.value)) + '"' + dis + '>';
    const src = locked
      ? '<span class="badge warn" title="由环境变量覆盖，改配置文件不生效，本页不允许提交">环境变量锁定</span>'
      : s.source === 'config.json'
        ? '<span class="badge dim">config.json</span>'
        : '<span class="badge dim">默认值</span>';
    return '<tr><td>' + esc(s.label) + (s.note ? '<div class="faint">' + esc(s.note) + '</div>' : '') + '</td>'
      + '<td class="mono">' + input + '</td>'
      + '<td class="mono">' + esc(s.key) + '</td>'
      + '<td>' + src + '</td></tr>';
  };

  let html = '<div class="panel"><h2>这是什么</h2>'
    + '<div class="faint">这里管理的是 <span class="mono">' + esc(r.file) + '</span> 里的运行参数。'
    + '保存即写盘（合并写，未收录的键原样保留），<b>重启服务后生效</b>。'
    + '环境变量优先级高于配置文件 —— 被覆盖的键会显示「环境变量锁定」且不可提交；'
    + '内核接入（地址 / 令牌 / 模式）不在此页，用平台概览的接入向导；密钥走「凭据托管」。</div>'
    + (r.exists ? '' : '<div class="note">配置文件尚不存在，首次保存会创建它。</div>')
    + '</div>';

  for (const sec of SECTIONS) {
    html += '<div class="panel"><h2>' + esc(sec.title) + '</h2><div class="table-wrap"><table>'
      + '<thead><tr><th>配置项</th><th>值</th><th>键名</th><th>来源</th></tr></thead><tbody>'
      + sec.keys.map((k) => row(byKey[k])).join('')
      + '</tbody></table></div></div>';
  }

  html += '<div class="row" style="margin-bottom:14px">'
    + (canWrite
      ? '<button class="primary" ' + act('saveSettings') + (State.busy ? ' disabled' : '') + '>保存全部可改项</button>'
      : '<span class="badge dim" title="缺少 system:write">只读</span>')
    + '<span class="faint">保存后需重启服务才生效；「环境变量锁定」的项不会提交。</span>'
    + '</div>';
  return html;
}

/* ── 调度中心（P1-2）──────────────────────────────────────── */

const JOB_STATUS_BADGE = {
  ok: ['ok', '成功'], fail: ['fail', '失败'], skipped: ['dim', '无待处理'],
};

/**
 * 单条任务的行内编辑器（0.18.0）：PUT /api/schedule/jobs/:id 一直在（服务端接受
 * name / kind / schedule / params 的部分更新），此前界面上只有启停一个入口 ——
 * 名字打错、规则要调、参数要改，都只能删了重建（连着执行历史一起丢）。
 * 用 `<details>` 收起，不改动任何 JS 状态；前端只拦"空名 / 坏 JSON"这两件
 * 不必麻烦服务端的事，规则语法与字段合法性的真正裁决在服务端。
 */
function jobEditorHtml(j, st) {
  const prefix = 'je-' + j.id + '-';
  const kinds = st.kinds || [];
  const info = st.info || {};
  // 未知执行体的 kind 不在白名单里 —— 也必须出现在下拉里，否则 select 会默默
  // 落到第一项，用户只是改个名字就把执行体换掉了（"保存"变成破坏性操作）。
  const kindOpts = (kinds.includes(j.kind) ? kinds : [j.kind].concat(kinds));
  return '<details class="mt-8"><summary class="faint">编辑任务</summary>'
    + '<div class="row mt-8">'
    + '<input class="input-md" id="' + esc(prefix) + 'name" placeholder="名称" value="' + esc(j.name) + '">'
    + '<select id="' + esc(prefix) + 'kind">'
    + kindOpts.map((k) => '<option value="' + esc(k) + '"' + (k === j.kind ? ' selected' : '') + '>'
      + esc((info[k] || {}).title || k) + '</option>').join('')
    + '</select>'
    + '<input class="input-md" id="' + esc(prefix) + 'schedule" placeholder="规则（interval:毫秒 / dailyAt:HH:MM）" value="' + esc(j.schedule) + '">'
    + '<input class="input-md" id="' + esc(prefix) + 'params" placeholder="参数 JSON" value="' + esc(JSON.stringify(j.params || {})) + '">'
    + '<button class="primary" ' + act('saveJob', esc(j.id)) + (State.busy ? ' disabled' : '') + '>保存</button>'
    + '</div>'
    + '<div class="faint">规则只支持 <span class="mono">interval:&lt;毫秒&gt;</span> 与 '
    + '<span class="mono">dailyAt:HH:MM</span>（UTC）。params 是 JSON 对象，'
    + '清空 = 回到执行体内置默认（运行时与默认参数合并）；'
    + '改执行体会按新执行体解释 params —— 保存前先确认参数的键是它认识的。</div></details>';
}

function pageSchedules() {
  const r = State.schedules;
  if (!r) return loadingOrError();
  const canWrite = allowed('schedule', 'write');
  const canDel = allowed('schedule', 'delete');
  const jobs = r.jobs || [];
  const st = r.status || {};

  let html = '';
  html += '<div class="panel"><h2>这是什么</h2>'
    + '<div class="faint">按时间自动执行的任务。它存在的意义是：<b>该定时做的事不需要人记得</b> ——'
    + '审计归档与链尾锚定、定期备份、模型探活巡检全部挂在这里。</div>'
    + '<div class="note">⚠️ ' + esc(st.boundaries || '') + '</div>'
    + '<div class="faint">调度器：' + (st.running ? '<span class="badge ok">运行中</span>' : '<span class="badge fail">未运行</span>')
    + ' ｜ 扫描间隔 ' + esc(String(st.tickMs || '—')) + ' ms'
    + ' ｜ 任务 ' + esc(String(st.total || 0)) + ' 个（启用 ' + esc(String(st.enabled || 0)) + '，失败 ' + esc(String(st.failing || 0)) + '）'
    + (st.lastTickAt ? ' ｜ 上次扫描 ' + esc(ts(st.lastTickAt)) : '')
    + '</div></div>';

  if (canWrite) {
    html += '<div class="panel"><h2>新建任务</h2>'
      + '<div class="row">'
      + '<input id="job-name" placeholder="名称（如「每日备份」）" style="width:170px">'
      + '<select id="job-kind">'
      + (st.kinds || []).map((k) => {
        const info = (st.info || {})[k] || {};
        return '<option value="' + esc(k) + '">' + esc(info.title || k) + '</option>';
      }).join('')
      + '</select>'
      + '<input id="job-schedule" placeholder="规则：interval:3600000 或 dailyAt:03:00" style="width:290px">'
      + '<input id="job-params" placeholder=\'参数 JSON（如 {"retentionDays":90}）\' style="width:250px">'
      + '<button class="primary" ' + act('createJob') + (State.busy ? ' disabled' : '') + '>创建</button>'
      + '<button ' + act('tickNow') + (State.busy ? ' disabled' : '') + '>立即扫描一次</button>'
      + '</div>'
      + '<div class="faint" style="margin-top:8px">规则只支持两种（不是 cron）：'
      + '<span class="mono">interval:&lt;毫秒&gt;</span> 与 <span class="mono">dailyAt:HH:MM</span>（按 <b>UTC</b> 解释）。'
      + '各执行体的可用参数见下方任务卡片的说明。</div></div>';
  }

  html += '<div class="panel"><h2>任务（' + jobs.length + ' 个）</h2>';
  if (!jobs.length) {
    html += '<div class="empty">还没有任务。' + (canWrite ? '组织建立时通常会播种三个默认任务；若这里是空的，说明它们被删掉了。' : '') + '</div>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr>'
      + '<th>名称</th><th>执行体</th><th>规则</th><th>上次执行</th><th>下次执行</th>'
      + '<th>累计</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    for (const j of jobs) {
      const [cls, label] = JOB_STATUS_BADGE[j.lastStatus] || ['dim', j.lastStatus || '—'];
      const detail = j.lastDetail && Object.keys(j.lastDetail).length
        ? JSON.stringify(j.lastDetail).slice(0, 120) : '';
      let ops = '';
      if (canWrite) {
        ops += '<button ' + act('runJob', esc(j.id), esc(j.name)) + (State.busy ? ' disabled' : '') + '>立即执行</button> ';
        ops += '<button ' + act('toggleJob', esc(j.id), (j.enabled ? 'false' : 'true')) + '>'
          + (j.enabled ? '停用' : '启用') + '</button> ';
      }
      if (canDel) ops += '<button class="danger" ' + act('deleteJob', esc(j.id), esc(j.name)) + '>删除</button>';
      html += '<tr>'
        + '<td><span class="mono">' + esc(j.name) + '</span>'
        + (j.known ? '' : ' <span class="badge fail">未知执行体</span>') + '</td>'
        + '<td><span class="mono">' + esc(j.kind) + '</span><div class="faint">' + esc(j.title || '') + '</div></td>'
        + '<td><span class="mono">' + esc(j.schedule) + '</span><div class="faint">' + esc(j.scheduleText || '') + '</div></td>'
        + '<td>' + (j.lastRunAt
          ? '<span class="badge ' + cls + '">' + esc(label) + '</span><div class="faint">' + esc(ts(j.lastRunAt)) + '</div>'
          : '<span class="faint">未执行过</span>')
        + (detail ? '<div class="faint mono">' + esc(detail) + '</div>' : '') + '</td>'
        + '<td class="mono">' + (j.enabled
          ? esc(j.nextRunAt ? String(j.nextRunAt).replace('T', ' ').slice(0, 19) : '—')
            + (j.overdue ? ' <span class="badge warn">已过期未跑</span>' : '')
          : '<span class="faint">已停用</span>') + '</td>'
        + '<td class="mono">' + esc(String(j.runCount)) + ' 次'
        + (j.failCount ? '<div class="faint">失败 ' + esc(String(j.failCount)) + '</div>' : '') + '</td>'
        + '<td>' + (j.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge dim">停用</span>') + '</td>'
        + '<td>' + (canWrite ? jobEditorHtml(j, st) : '') + (ops || '<span class="faint">—</span>') + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '<div class="note">「已过期未跑」表示下次执行时间已过但调度器还没跑到它 —— '
    + '常见原因是进程刚启动（第一次扫描最多等一个 tick），或任务被上一轮长时间任务挡住（重入保护）。</div></div>';

  /* 执行体说明（让"能配什么"有出口，而不是让运维去读代码） */
  if (st.info) {
    html += '<div class="panel"><h2>可用的执行体</h2><div class="table-wrap"><table><thead><tr>'
      + '<th>key</th><th>说明</th></tr></thead><tbody>';
    for (const k of (st.kinds || [])) {
      const info = st.info[k] || {};
      html += '<tr><td class="mono">' + esc(k) + '</td><td>' + esc(info.title || '') + ' —— ' + esc(info.desc || '') + '</td></tr>';
    }
    html += '</tbody></table></div>'
      + '<div class="note">执行结果会写进审计链（动作 <span class="mono">schedule.job.run</span>），'
      + '并且区分是定时触发还是有人在页面上点了一下 —— 事后没人分得清这两者是很麻烦的事。</div></div>';
  }
  return html;
}

/* ── 通知渠道（P1-2）──────────────────────────────────────── */

/**
 * 事件名 → 可直接用于 id 的片段。
 *
 * 为什么不能拿事件名直拼 id：事件名里有点（`quota.blocked`），而 `#nc-e-quota.blocked`
 * 在 CSS 选择器里会被解析成"id=nc-e-quota 且 class=blocked" —— `querySelector` 永远
 * 匹配不到，读出来恒为 null，勾了事件也登记不上订阅。回归里的 DOM 垫片按字面精确匹配，
 * 恰好把这个真实缺陷盖住（0.18.0 用真机浏览器复核时抓到）。`getElementById` 本没有这个
 * 问题，但前端读表单统一走 `$`（querySelector），所以 id 本身就不该带点。
 */
function notifyEventInputId(prefix, ev) {
  return prefix + String(ev).replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * 单条渠道的行内编辑器（0.18.0）：PUT /api/notify/channels/:id 一直在（服务端接受
 * name / url / events / enabled 的部分更新），此前界面上只有启停一个入口 ——
 * 名字写错、订阅事件要调、token 轮换了，都只能删了重建。用 `<details>` 收起。
 *
 * ⚠️ URL 输入框**刻意不预填**：服务端本来就不回显完整 URL（它常内嵌 token，等价于密钥），
 * 留空 = 不改动 —— 这既是服务端的语义，也是这里唯一正确的做法。
 */
function channelEditorHtml(c, st) {
  const prefix = 'ce-' + c.id + '-';
  const events = st.events || [];
  return '<details class="mt-8"><summary class="faint">编辑渠道</summary>'
    + '<div class="row mt-8">'
    + '<input class="input-md" id="' + esc(prefix) + 'name" placeholder="名称" value="' + esc(c.name) + '">'
    + '<input class="input-md" id="' + esc(prefix) + 'url" placeholder="新 Webhook URL（留空 = 不改动）">'
    + '<button class="primary" ' + act('saveChannel', esc(c.id)) + (State.busy ? ' disabled' : '') + '>保存</button>'
    + '</div>'
    + '<div class="row mt-8"><span class="faint">订阅事件：</span>'
    + events.map((e) => '<label class="faint"><input type="checkbox" id="' + esc(notifyEventInputId(prefix, e)) + '"'
      + ((c.events || []).includes(e) ? ' checked' : '') + '> ' + esc(e) + '</label>').join('')
    + '</div>'
    + '<div class="faint">保存会按勾选<b>整体替换</b>订阅列表（都不勾 = 不再订阅任何事件）。'
    + 'URL 加密存放，页面只回显 host；新 URL 留空表示不改动 —— 只改名字或订阅时不要把 URL 重填一遍。</div></details>';
}

function pageNotify() {
  const r = State.notifyData;
  if (!r) return loadingOrError();
  const canWrite = allowed('notify', 'write');
  const canDel = allowed('notify', 'delete');
  const channels = r.channels || [];
  const st = r.status || {};

  let html = '';
  html += '<div class="panel"><h2>这是什么</h2>'
    + '<div class="faint">平台主动出站告知的能力。在这之前，配额被拦、备份失败、模型探活失败 ——'
    + '全靠人主动打开页面看。企业运维的基本要求是<b>异常主动找上门</b>。</div>'
    + '<div class="note">⚠️ ' + esc(st.boundaries || '') + '</div>'
    + '<div class="faint">渠道 ' + esc(String(st.total || 0)) + ' 个（启用 ' + esc(String(st.enabled || 0)) + '，最近失败 ' + esc(String(st.failing || 0)) + '）'
    + ' ｜ 可订阅事件：' + (st.events || []).map((e) => '<span class="mono">' + esc(e) + '</span>').join('、') + '</div></div>';

  if (canWrite) {
    html += '<div class="panel"><h2>登记渠道</h2>'
      + '<div class="row">'
      + '<input id="nc-name" placeholder="名称（如「运维群机器人」）" style="width:180px">'
      + '<input id="nc-url" placeholder="Webhook URL（含 token 也可以，会加密落库）" style="width:330px">'
      + '<input id="nc-cred" placeholder="Bearer 凭据名（可留空）" style="width:170px">'
      + '<button class="primary" ' + act('createChannel') + (State.busy ? ' disabled' : '') + '>登记</button>'
      + '</div>'
      + '<div class="row" style="margin-top:8px"><span class="faint">订阅事件：</span>'
      + (st.events || [])
        .map((e) => '<label class="faint"><input type="checkbox" id="' + esc(notifyEventInputId('nc-e-', e)) + '"> ' + esc(e) + '</label>').join('')
      + '</div>'
      + '<div class="faint" style="margin-top:8px">URL <b>加密存放</b>（出站 URL 常内嵌 token，它等价于一个密钥），'
      + '接口只回显 host。只允许 http/https；回环与云元数据地址（127./::1/169.254.）会被拒绝 —— '
      + '那些不是合法的 webhook 目标，而是 SSRF 的典型载荷。内网地址（10./192.168.）是允许的。<br>'
      + '填 <b>企微 / 钉钉自定义机器人</b>地址（qyapi.weixin.qq.com / oapi.dingtalk.com）时，'
      + '平台会自动换成它们要求的 msgtype 信封，并按回执 errcode 判定成败 —— 这两类接收端对不合规报文也回 HTTP 200，'
      + '只看状态码会把「没渲染」记成「已送达」。其余目标原样收到平台通用 JSON 报文。</div></div>';
  }

  html += '<div class="panel"><h2>渠道（' + channels.length + ' 个）</h2>';
  if (!channels.length) {
    html += '<div class="empty">还没有渠道 —— 当前平台不会主动通知任何异常。</div>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr>'
      + '<th>名称</th><th>目标</th><th>凭据</th><th>订阅事件</th><th>最近投递</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    for (const c of channels) {
      let ops = '';
      if (canWrite) {
        ops += '<button ' + act('testChannel', esc(c.id), esc(c.name)) + (State.busy ? ' disabled' : '') + '>试发</button> ';
        ops += '<button ' + act('toggleChannel', esc(c.id), (c.enabled ? 'false' : 'true')) + '>'
          + (c.enabled ? '停用' : '启用') + '</button> ';
      }
      if (canDel) ops += '<button class="danger" ' + act('deleteChannel', esc(c.id), esc(c.name)) + '>删除</button>';
      html += '<tr>'
        + '<td><span class="mono">' + esc(c.name) + '</span><div class="faint">' + esc(c.kind) + '</div></td>'
        + '<td class="mono faint">' + esc(c.host || '（未配置或无法解析）') + '</td>'
        + '<td>' + (c.hasCredential ? '<span class="badge ok">' + esc(c.credentialName || '有') + '</span>' : '<span class="badge dim">无</span>') + '</td>'
        + '<td>' + (c.events && c.events.length
          ? c.events.map((e) => '<span class="mono faint">' + esc(e) + '</span>').join('<br>')
          : '<span class="badge warn">未订阅任何事件</span>') + '</td>'
        + '<td>' + (c.lastDeliveryAt
          ? '<span class="badge ' + (c.lastStatus === 'ok' ? 'ok' : 'fail') + '">' + esc(c.lastStatus || '—') + '</span>'
            + '<div class="faint">' + esc(ts(c.lastDeliveryAt)) + '</div>'
          : '<span class="faint">未投递过</span>')
        + (c.failCount ? '<div class="faint">累计失败 ' + esc(String(c.failCount)) + '</div>' : '') + '</td>'
        + '<td>' + (c.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge dim">停用</span>') + '</td>'
        + '<td>' + (canWrite ? channelEditorHtml(c, st) : '') + (ops || '<span class="faint">—</span>') + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '<div class="note">「试发」不要求渠道订阅了具体事件 —— 否则新渠道订阅列表为空时根本没法自测它通不通。'
    + '试发失败不是接口报错：请求本身处理成功了，结论在结果里（渠道不存在才是 404）。</div></div>';

  /* ── 投递失败队列（§B5）───────────────────────────────────
   *
   * 为什么它必须**可见**：后台默默重投只是把"告警丢了"换成"告警丢了但没人知道" ——
   * 那比不做更糟。"有多少条还没发出去"本身就是运维要看的那个数，它是一等公民，
   * 不是一个藏在日志里的细节。 */
  html += '<div class="panel"><h2>投递失败队列</h2>';
  if (!State.deliveries) {
    html += '<div class="empty">读不到队列（需要 notify:read）。</div>';
  } else {
    const q = State.deliveries.queue || {};
    const pol = State.deliveries.policy || {};
    const pend = Number(q.pending || 0);
    const dead = Number(q.dead || 0);
    html += '<div class="faint">待重投 <span class="badge ' + (pend ? 'warn' : 'dim') + '">' + esc(String(pend)) + '</span>'
      + ' ｜ 已放弃(dead) <span class="badge ' + (dead ? 'fail' : 'dim') + '">' + esc(String(dead)) + '</span>'
      + ' ｜ 已送达 <span class="badge dim">' + esc(String(q.delivered || 0)) + '</span>'
      + ' ｜ 最多重投 ' + esc(String(pol.maxAttempts == null ? '—' : pol.maxAttempts)) + ' 次，'
      + '指数退避（10 分钟起、封顶 1 小时）→ 超过转 dead，<b>保留可见、可手动重投</b>（不是删除）。</div>'
      + '<div class="note">' + esc(State.deliveries.note || '') + '</div>';
    // 只列"还欠着的"与"已放弃的"：delivered 是历史，条数在上面的摘要里就够了，
    // 混进来只会把两条真正要处理的记录淹掉。
    const pend_rows = (State.deliveries.deliveries || []).filter((d) => d.status !== 'delivered');
    if (!pend_rows.length) {
      html += '<div class="empty">队列是空的 —— 当前没有发不出去的告警。</div>';
    } else {
      html += '<div class="table-wrap"><table><thead><tr>'
        + '<th>事件</th><th>渠道</th><th>已重投</th><th>上次结果</th><th>下次重投</th><th>状态</th><th>操作</th></tr></thead><tbody>';
      for (const d of pend_rows) {
        html += '<tr>'
          + '<td><span class="mono">' + esc(d.event) + '</span></td>'
          + '<td>' + esc(d.channelName) + '</td>'
          + '<td class="mono">' + esc(String(d.attempts)) + ' / ' + esc(String(d.maxAttempts)) + '</td>'
          + '<td class="faint">' + esc(d.lastStatus == null ? '—' : ('HTTP ' + d.lastStatus))
            + (d.lastError ? '<div class="faint">' + esc(d.lastError) + '</div>' : '') + '</td>'
          + '<td class="faint">' + (d.status === 'dead' ? '—' : esc(ts(d.nextRetryAt))) + '</td>'
          + '<td>' + (d.status === 'dead' ? '<span class="badge fail">已放弃</span>' : '<span class="badge warn">待重投</span>') + '</td>'
          + '<td>' + (canWrite
            ? '<button ' + act('redeliver', esc(d.id)) + (State.busy ? ' disabled' : '') + '>立即重投</button>'
            : '<span class="faint">—</span>') + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    html += '<div class="faint mt-8">队列由定时任务 <span class="mono">notify.retry</span> 定期扫（进程停了就不扫）。'
      + '「试发」失败<b>不入队</b> —— 那是人在旁边看着的动作，丢进队列只会把上面这个数污染掉。</div>';
  }
  html += '</div>';

  if (State.notifyTest) {
    const q = State.notifyTest.result || {};
    html += '<div class="panel"><h2>最近一次试发</h2><div class="note' + (q.ok ? '' : ' fail') + '">'
      + '<span class="badge ' + (q.ok ? 'ok' : 'fail') + '">' + (q.ok ? '成功' : '失败') + '</span> '
      + esc(State.notifyTest.name) + '：HTTP ' + esc(String(q.status))
      + '，尝试 ' + esc(String(q.attempts)) + ' 次'
      + (q.error ? '｜' + esc(q.error) : '') + '</div></div>';
  }
  return html;
}

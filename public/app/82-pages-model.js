/* STI HARNESS 前端 · 模型中心与单价
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 模型中心（P1-1）──────────────────────────────────────────
 *
 * 这页回答四个问题，每一项都对应 roadmap P1-1 的一条：
 *   1. 配了哪些模型服务？      → 注册表表格
 *   2. 哪个是默认？            → 「默认与降级链」面板（并说明默认是显式设的、还是取链首）
 *   3. 挂了哪条降级链？        → 同面板按 priority 排出顺序
 *   4. 通不通？                → 逐条「探活」，结论照抄服务端（含真实失败原因）
 *
 * ⚠️ 页面顶部必须写下**它不是什么**：本模块不做请求转发，因此不能拦配额。
 *    不写这句，看到"模型中心"四个字就会以为配额已经能事前拦截了。
 */
const MODEL_KIND_LABEL = { chat: '对话', embedding: '向量' };
const MODEL_PROTOCOL_LABEL = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-compat': 'OpenAI 兼容',
  ollama: 'Ollama',
  none: '不配向量',
};
const MODEL_PROTOCOLS_BY_KIND = {
  chat: ['anthropic-messages', 'openai-compat'],
  embedding: ['openai-compat', 'ollama', 'none'],
};

function defaultSourceLabel(src) {
  if (src === 'explicit') return '显式设置';
  if (src === 'chain-head') return '未显式设置，取链首';
  return '—';
}

/* ── 单价（P1-3 / 成本核算）─────────────────────────────────
 *
 * 三条规则，页面上必须看得见，因为它们决定了金额对不对：
 *   1. **留空 = 未定价**：表单里空着就不发这个键，后端写 NULL。
 *      绝不把空串变成 0 —— 0 是"免费"，NULL 是"不知道"。
 *   2. **单位是「最小货币单位 / 每 100 万 token」**：如人民币就是"分/百万 token"。
 *      直接填"每百万 token 多少元"会算错 100 倍，所以输入框上写死了单位提示。
 *   3. **配了任一项就必须填币种**（后端会拒；这里先在前端把话说清楚）。
 */
const PRICE_FIELDS = [
  ['priceInMinor', '输入价'], ['priceCacheReadMinor', '缓存读价'],
  ['priceCacheWriteMinor', '缓存写价'], ['priceOutMinor', '输出价'],
];

/** 从表单读单价。**空就是空**（不发这个键），不是 0。 */
function priceFieldsFromForm(prefix) {
  const out = {};
  const cur = (($('#' + prefix + 'currency') || {}).value || '').trim().toUpperCase();
  for (const [key, ] of PRICE_FIELDS) {
    const v = (($('#' + prefix + key) || {}).value || '').trim();
    if (v !== '') out[key] = v;                       // 字符串原样发；服务端负责"必须是非负整数"
  }
  // 币种总是发（含空串）—— "把币种清空"是一个有意义的动作（会连带变成未定价）。
  out.currency = cur;
  return out;
}

/** 单价显示：null/undefined → 「未定价」（**不是** 0）；0 是合法值，要显示成 0。 */
function fmtPriceMinor(v) {
  if (v === null || v === undefined) return null;
  return String(Number(v));
}

function priceCell(p) {
  if (!p.priced) return '<span class="badge dim" title="该条目没登记单价：成本报告里这部分金额为 null，不是 0 元">未定价</span>';
  const parts = PRICE_FIELDS.map(([k, label]) => {
    const v = fmtPriceMinor(p[k]);
    return '<span class="faint">' + esc(label) + '</span> '
      + (v === null ? '<span class="badge dim">缺</span>' : '<span class="mono">' + esc(v) + '</span>');
  }).join('　');
  return '<span class="badge ok">' + esc(p.currency || '?') + '</span><div class="faint" style="margin-top:2px">'
    + parts + '<br>单位：最小货币单位 / 每 100 万 token</div>';
}

/** 成本面板里显示"某类 token 的单价"：null → 「未定价」，不显示成 0 */
function fmtUnitPrice(v) { return (v === null || v === undefined) ? '未定价' : String(Number(v)); }

/** 单条模型的内联单价编辑器（用 `<details>` 收起，不改动任何 JS 状态） */
function priceEditorHtml(p) {
  const f = (k) => (p[k] === null || p[k] === undefined) ? '' : String(Number(p[k]));
  const prefix = 'mp-' + p.id + '-';
  return '<details style="margin-top:6px"><summary class="faint" style="cursor:pointer">改单价</summary>'
    + '<div class="row" style="margin-top:6px">'
    + '<input id="' + esc(prefix) + 'currency" placeholder="币种" style="width:70px" value="' + esc(p.currency || '') + '">'
    + PRICE_FIELDS.map(([k, label]) =>
      '<input id="' + esc(prefix + k) + '" placeholder="' + esc(label) + '" style="width:90px" value="' + esc(f(k)) + '">').join('')
    + '<button class="primary" ' + act('setModelPrice', esc(p.id)) + ''
    + (State.busy ? ' disabled' : '') + '>保存</button>'
    + '</div><div class="faint">全部清空 = 回到「未定价」。留空 ≠ 0：0 是免费，空是不知道。</div></details>';
}

/**
 * 单条模型的主字段编辑器（0.16.0）：PUT /api/model/providers/:id 一直存在，
 * 此前端只有单价编辑在用它 —— 名称 / 目标地址 / 模型名 / 凭据名 / 降级序号只能命令行改。
 * 同样用 `<details>` 收起；kind 不提供改（后端会拒绝：改 kind 会让"默认"落空），
 * protocol 限制在同 kind 的合法集合内。priority 即降级链顺序，越小越先。
 */
function modelEditorHtml(p) {
  const prefix = 'me-' + p.id + '-';
  const protos = MODEL_PROTOCOLS_BY_KIND[p.kind] || [p.protocol];
  const inp = (k, label, val, width, extra) =>
    '<input id="' + esc(prefix + k) + '" placeholder="' + esc(label) + '" style="width:' + width + '" value="' + esc(val == null ? '' : String(val)) + '"' + (extra || '') + '>';
  return '<details style="margin-top:6px"><summary class="faint" style="cursor:pointer">编辑条目</summary>'
    + '<div class="row" style="margin-top:6px;flex-wrap:wrap">'
    + inp('name', '名称', p.name, '150px')
    + '<select id="' + esc(prefix) + 'protocol">'
    + protos.map((x) => '<option value="' + esc(x) + '"' + (x === p.protocol ? ' selected' : '') + '>'
      + esc(MODEL_PROTOCOL_LABEL[x] || x) + '</option>').join('')
    + '</select>'
    + inp('baseUrl', 'Base URL', p.baseUrl, '220px')
    + inp('model', '模型名', p.model, '140px')
    + inp('credentialName', '凭据名（清空=解除关联）', p.credentialName, '150px')
    + '</div>'
    + '<div class="row" style="margin-top:6px">'
    + inp('priority', '降级序号（越小越先）', p.priority, '120px', ' type="number"')
    + inp('label', '备注', p.label, '150px')
    + '<button class="primary" ' + act('updateModel', esc(p.id)) + (State.busy ? ' disabled' : '') + '>保存</button>'
    + '</div>'
    + '<div class="faint">用途（' + esc(MODEL_KIND_LABEL[p.kind] || p.kind) + '）不可改 —— 改用途会让"默认"落空，'
    + '要换用途请新登记一条。序号即降级链顺序：同用途内按序号升序排列启用的条目。</div></details>';
}

function pageModels() {
  const r = State.models;
  if (!r) return loadingOrError();
  const canWrite = allowed('model', 'write');
  const canDel = allowed('model', 'delete');
  const providers = r.providers || [];
  const status = r.status || {};

  let html = '';
  html += '<details class="panel"><summary style="cursor:pointer;font-weight:600">这是什么</summary>'
    + '<div class="faint" style="margin-top:8px">平台侧模型注册表：登记有哪些模型服务、哪个是默认、按什么顺序降级，'
    + '并对每一条做真探活。它是"配了什么"的答案，与"本机实际能调什么"（内核目录）是两回事。</div>'
    + '<div class="note">⚠️ ' + esc(status.boundaries || '') + '</div></details>';

  /* 登记表单（无 model:write 就不显示 —— 但真正的拦截在服务端） */
  if (canWrite) {
    const protos = MODEL_PROTOCOLS_BY_KIND[State.modelKind] || [];
    html += '<div class="panel"><h2>登记模型服务</h2>'
      + '<div class="row">'
      + '<label class="faint">用途</label>'
      + '<select id="md-kind" ' + actCh('switchModelKind') + '>'
      + ['chat', 'embedding'].map((k) => '<option value="' + k + '"' + (k === State.modelKind ? ' selected' : '') + '>'
        + esc(MODEL_KIND_LABEL[k]) + '</option>').join('')
      + '</select>'
      + '<input id="md-name" placeholder="名称（如 my-chat-model）" style="width:190px">'
      + '<select id="md-protocol">'
      + protos.map((p) => '<option value="' + esc(p) + '">' + esc(MODEL_PROTOCOL_LABEL[p] || p) + '</option>').join('')
      + '</select>'
      + '</div>'
      + '<div class="row" style="margin-top:8px">'
      + '<input id="md-base" placeholder="Base URL（根地址，不带 /v1）" style="width:300px">'
      + '<input id="md-model" placeholder="模型名" style="width:170px">'
      + '<input id="md-cred" placeholder="凭据名（可留空）" style="width:170px">'
      + '<input id="md-priority" type="number" value="100" title="降级链序号，越小越先" style="width:80px">'
      + '<input id="md-label" placeholder="备注（可留空）" style="width:150px">'
      + '<label class="faint"><input type="checkbox" id="md-default"> 设为默认</label>'
      + '<button class="primary" ' + act('createModel') + (State.busy ? ' disabled' : '') + '>登记</button>'
      + '</div>'
      // 单价（P1-3）：单位写死在输入框上，因为"每百万 token 多少分"写成"多少元"会差 100 倍，
      // 而这种错算出来的金额看着完全正常，没人能一眼看出来。
      + '<div class="row" style="margin-top:8px">'
      + '<span class="faint">单价（可留空 = 未定价）：</span>'
      + '<input id="md-currency" placeholder="币种 CNY" style="width:90px">'
      + PRICE_FIELDS.map(([k, label]) =>
        '<input id="md-' + k + '" placeholder="' + esc(label) + '" style="width:110px">').join('')
      + '</div>'
      + '<div class="faint" style="margin-top:6px">单价单位＝<b>最小货币单位 / 每 100 万 token</b>'
      + '（人民币即"分/百万 token"，如 0.5 元/百万 token 填 <span class="mono">50</span>）。'
      + '留空表示<b>未定价</b>：成本报告里那部分金额显示为「未定价」而<b>不是 0 元</b> ——'
      + '0 元会被读成"免费"。配了任一项就必须填币种。'
      + '另外：<b>缓存读写要各自配价</b>，平台不会拿输入价去顶替缓存价（两者常差一个数量级）。</div>'
      + '<div class="faint" style="margin-top:8px">凭据这里只填名称（值在「凭据托管」里加密存放，本页永不接收明文）。'
      + '降级链 = 同用途内按序号升序的启用项。'
      + (State.modelKind === 'embedding'
        ? ' 向量条目若选「设为默认」，必须同时选「不配向量」或填好地址与模型名 —— 它会被检索路径直接使用。'
        : '') + '</div></div>';
  }

  /* 注册表 */
  html += '<div class="panel"><h2>已登记（' + providers.length + ' 条）</h2>';
  if (!providers.length) {
    html += '<div class="empty">还没有登记任何模型服务。' + (canWrite ? '用上面的表单添加第一条。' : '') + '</div>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr>'
      + '<th>名称</th><th>用途</th><th>协议</th><th>目标</th><th>凭据</th><th>单价</th>'
      + '<th>序号</th><th>默认</th><th>状态</th><th>最近探活</th><th>操作</th></tr></thead><tbody>';
    for (const p of providers) {
      const lp = p.lastProbe;
      const lpBadge = lp
        ? '<span class="badge ' + (lp.ok ? 'ok' : 'fail') + '">' + esc(lp.level) + '</span> '
          + '<span class="faint">' + esc(ts(lp.at)) + '</span>'
        : '<span class="faint">未探活</span>';
      let ops = '';
      if (canWrite) {
        ops += '<button ' + act('probeModel', esc(p.id)) + (State.busy ? ' disabled' : '') + '>探活</button> ';
        if (!p.isDefault) ops += '<button ' + act('setModelDefault', esc(p.id)) + '>设为默认</button> ';
        ops += '<button ' + act('toggleModel', esc(p.id), (p.enabled ? 'false' : 'true')) + '>'
          + (p.enabled ? '停用' : '启用') + '</button> ';
      }
      if (canDel) ops += '<button class="danger" ' + act('deleteModel', esc(p.id), esc(p.name)) + '>删除</button>';
      html += '<tr>'
        + '<td><span class="mono">' + esc(p.name) + '</span>'
        + (p.label ? '<div class="faint">' + esc(p.label) + '</div>' : '') + '</td>'
        + '<td>' + esc(MODEL_KIND_LABEL[p.kind] || p.kind) + '</td>'
        + '<td>' + esc(MODEL_PROTOCOL_LABEL[p.protocol] || p.protocol) + '</td>'
        + '<td class="mono faint">' + esc(p.baseUrl || '—') + (p.model ? '<br>' + esc(p.model) : '') + '</td>'
        + '<td>' + (p.hasCredential
          ? '<span class="badge ok">' + esc(p.credentialName || '有') + '</span>'
          : '<span class="badge dim">无</span>') + '</td>'
        + '<td>' + priceCell(p) + (canWrite ? priceEditorHtml(p) : '') + '</td>'
        + '<td class="mono">' + esc(String(p.priority)) + '</td>'
        + '<td>' + (p.isDefault ? '<span class="badge ok">默认</span>' : '') + '</td>'
        + '<td>' + (p.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge warn">停用</span>') + '</td>'
        + '<td>' + lpBadge + '</td>'
        + '<td>' + (canWrite ? modelEditorHtml(p) : '') + (ops || '<span class="faint">—</span>') + '</td>'
        + '</tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '<div class="note">' + esc((r.sources && r.sources.note) || '') + '</div></div>';

  /* 默认与降级链 */
  html += '<div class="panel"><h2>默认与降级链</h2>';
  for (const kind of ['chat', 'embedding']) {
    const c = (r.chain && r.chain[kind]) || {};
    const p = c.provider;
    const chain = c.chain || [];
    html += '<h3 style="margin-top:12px">' + esc(MODEL_KIND_LABEL[kind]) + '</h3>';
    html += '<div>默认：' + (p
      ? '<span class="mono">' + esc(p.name) + '</span> <span class="faint">（' + esc(defaultSourceLabel(c.defaultSource)) + '）</span>'
      : '<span class="faint">无（该用途没有启用的条目）</span>') + '</div>';
    html += chain.length
      ? '<div class="faint">链（' + chain.length + ' 项）：'
        + chain.map((x) => esc(x.name) + '(' + esc(String(x.priority)) + ')').join(' → ') + '</div>'
      : '<div class="empty">该用途没有启用的条目。</div>';
  }
  html += '<div class="note">降级链是「同用途内按序号升序的启用项」。'
    + '本平台不做请求转发 —— 链里"真正会去试下一个"的那一步属于 model gateway（v1.0）。</div></div>';

  /* 最近一次探活 */
  if (State.modelProbe) {
    const v = State.modelProbe.verdict || {};
    html += '<div class="panel"><h2>最近一次探活</h2><div class="note ' + (v.level === 'fail' ? 'fail' : '') + '">'
      + '<span class="badge ' + (v.level === 'ok' ? 'ok' : (v.level === 'skipped' ? 'dim' : 'fail')) + '">' + esc(v.level || '—') + '</span> '
      + esc(State.modelProbe.name || '') + '：' + esc(v.message || '')
      + '<div class="faint">code ' + esc(v.code || '—')
      + '｜耗时 ' + esc(v.latencyMs == null ? '—' : v.latencyMs + ' ms')
      + '｜端点 ' + esc(State.modelProbe.endpoint || '—')
      + (v.billedRequest ? '｜已产生最小请求用量（max_tokens:1）' : '')
      + (v.credentialNote ? '｜' + esc(v.credentialNote) : '')
      + '</div></div></div>';
  }
  return html;
}

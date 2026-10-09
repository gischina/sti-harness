/* STI HARNESS 前端 · 知识页与会话页
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
function prefilterLabel(pf) {
  if (!pf) return '—';
  if (pf.reason === 'disabled') return '关（全量精确扫描）';
  if (pf.applied) return '生效（候选 ' + pf.candidates + ' 条）';
  if (pf.reason === 'too_few_candidates') return '退化为全量（候选不足）';
  if (pf.reason === 'candidate_cap_exceeded') return '退化为全量（候选超上限）';
  if (pf.reason === 'no_embedding') return '不适用（未配向量模型）';
  if (pf.reason === 'vector_failed') return '不适用（向量检索失败）';
  if (pf.reason === 'no_scope') return '不适用（没有可见知识库）';
  return pf.reason;   // 未知原因**原样透出**（不吞、不猜），调用方负责转义
}

/* ── 库级授权（体检 §B9）─────────────────────────────────────────────
 * 这个面板存在的理由：0.11.0 交付了「受限」库的后端（能设可见性、能调接口授权），
 * 但**没有界面**给人授权 —— 于是"把库设成受限"这个动作很容易变成"把自己也锁在外面"。
 *
 * 三条必须被页面说清楚的事：
 *   ① **判定口径不是租户级**：「能不能列/改这份名单」取决于你在**这个库**上有没有 write 档。
 *      所以这里不拿 `allowed('knowledge','write')` 预判（详见 App.loadBaseGrants 的注释）。
 *   ② **授权名单本身是敏感信息**：它暴露组织分工（"法务库里都有谁"是个情报）。
 *   ③ **库级角色只在本库生效**：本库有效档位 = 全局角色 ∪ 库级角色；撤权即失效，不残留。
 */

/** 授权主体的显示名，形如 `组「法务」` / `成员「zhang」`。`name` 缺失时退回 id。 */
function grantSubjectLabel(type, id, name) {
  return (type === 'group' ? '组' : '成员') + '「' + (name || id) + '」';
}

/** 从前端已有的两份清单里查主体名（用于"刚授完"的结果提示）。查不到返回 null。 */
function grantSubjectName(type, id) {
  const list = type === 'group' ? (((State.groups || {}).groups) || []) : (((State.users || {}).users) || []);
  const hit = list.find((x) => String(x.id) === String(id));
  return hit ? (hit.name || hit.username) : null;
}

/**
 * 授权表单的主体候选。
 * 返回 `null`（而不是空字符串）表示**列不出候选人** —— 调用方必须如实说明缺哪项权限，
 * 不能渲染一个只有空选项的下拉（那看起来像"功能坏了"，实则是"你没权限看名单"）。
 */
function grantSubjectOptions() {
  const type = State.grantSubjectType === 'group' ? 'group' : 'user';
  const list = type === 'group' ? (((State.groups || {}).groups) || []) : (((State.users || {}).users) || []);
  if (!list.length) return null;
  return list.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name || x.username || x.id) + '</option>').join('');
}

/**
 * 可授的库级角色。
 * 取值与全局角色**同一套**（服务端 `grantScopedRole` 会按 `knownRole` 白名单复核），
 * 本地不扩写、也不兜底 —— 调用方已确保 `State.roles` 存在。
 */
function grantRoleOptions() {
  return roleOptions()
    .map((o) => '<option value="' + esc(o.key) + '">' + esc(o.name) + '（' + esc(o.key) + '）</option>')
    .join('');
}

/** 库级授权面板。`base` 是当前选中的库。 */
function grantPanel(base) {
  // 只认**属于当前库**的那份名单：切库瞬间旧名单可能还在内存里，宁可显示"读取中"也不能张冠李戴。
  const g = (State.baseGrants && State.baseGrants.kbId === base.id) ? State.baseGrants : null;
  const restricted = base.visibility === 'restricted';

  let html = '<div class="panel"><h2>库级授权</h2>'
    + '<div class="faint">'
    + (restricted
      ? '「' + esc(base.name) + '」是 <b>受限</b>知识库：只有被显式授权的成员（与管理员）'
        + '能在列表里看到它、并检索其内容；未获授权的成员访问它一律按「不存在」处理 —— '
        + '<b>下面的名单就是唯一的放行依据</b>。<br>'
      : '')
    + '把某个<b>成员或用户组</b>在这个库上授一个角色。本库上的有效档位 = '
    + '<b>全局角色 ∪ 库级角色</b>，并集<b>只作用于这个库</b>，所以"全局是 viewer、本库授成 admin"是合法组合；'
    + '撤权后立即回到「看不见」，不残留。<br>'
    + '列这份名单本身也要求你在<b>本库</b>有 write 档 —— 谁能管这个库，等于谁掌握了组织分工的一部分。'
    + '</div>';

  // 「全组织可见」时库级授权是**空转**的：明说，免得有人配了半天发现没效果。
  if (!restricted) {
    html += '<div class="note warn mt-8">本库当前是 <b>全组织可见</b>，所以下面的授权'
      + '<b>暂时不改变任何人的可见性</b>（能看见的人本来就都能看见）。'
      + '把上方可见性切成「受限」之后，这份名单才成为放行依据 —— 可以先在这里把名单配好，再切。</div>';
  }

  if (!g) return html + '<div class="empty mt-8">读取中…</div></div>';

  // `ok:false` 是一种**正常结果**（你在本库没有 write 档），不是加载异常。
  // ⚠️ 这里刻意用**中性** `.note` 而不是 `.note fail`：对绝大多数人（普通成员）来说，
  // "管不了这个库"是预期之内的事，用红色故障样式去渲染它属于**夸大**。
  // 同样刻意的是**不把面板藏起来** —— 藏掉就正好藏掉了"全局 viewer、本库 admin"的
  // 库级管理员（他恰恰是唯一需要这块面板的人）。宁可让多数人多看两行字。
  if (!g.ok) {
    return html + '<div class="note mt-8"><b>列不出这份名单</b>：' + esc(g.reason) + '<br>'
      + '<span class="faint">这通常意味着你在<b>这个库</b>上没有 write 档。'
      + '注意它与「全局有没有 knowledge:write」是两件事：被单独授成本库管理员的成员，同样可以管理这里。</span></div></div>';
  }

  const items = g.items || [];
  if (!items.length) {
    html += '<div class="empty mt-8">本库还没有任何库级授权。'
      + (restricted ? '<b>也就是说，目前除了管理员，没有人能看到它。</b>' : '') + '</div>';
  } else {
    html += '<div class="table-wrap mt-8"><table><thead><tr>'
      + '<th>主体</th><th>类型</th><th>在本库的角色</th><th>授权于</th><th>操作</th>'
      + '</tr></thead><tbody>';
    for (const it of items) {
      html += '<tr><td>' + esc(it.subjectName || it.subjectId) + '</td>'
        + '<td class="muted">' + (it.subjectType === 'group' ? '用户组' : '成员') + '</td>'
        + '<td><span class="badge ok">' + esc(roleName(it.roleKey)) + '</span>'
        + '<span class="faint"> ' + esc(it.roleKey) + '</span></td>'
        + '<td class="muted">' + esc(ts(it.createdAt)) + '</td>'
        + '<td><a href="#" ' + act('revokeGrant', esc(it.id),
          esc(grantSubjectLabel(it.subjectType, it.subjectId, it.subjectName))) + '>撤销</a></td></tr>';
    }
    html += '</tbody></table></div>';
  }

  /* ── 新增授权 ──
   * 主体与角色都**只能从下拉选**：手填 id 既容易错（错了是静默落库一条永不生效的授权），
   * 也把内部标识泄漏给使用者。 */
  const subjects = grantSubjectOptions();
  if (!subjects) {
    html += '<div class="note warn mt-8">没法选择要授权给谁：读不到候选人清单。'
      + '列出成员需要 <code>user:read</code>、列出用户组需要 <code>group:read</code>。'
      + '若你没有这两项读权限，请让管理员在「身份与权限」页处理，或直接调用库级授权接口。</div>';
  } else if (!State.roles) {
    html += '<div class="note warn mt-8">没法选择角色：读不到角色表（需要 <code>role:read</code>）。'
      + '<b>这里刻意不给一个"默认角色"兜底</b> —— 那样授出去的档位会是个猜出来的值。</div>';
  } else {
    html += '<div class="row mt-8">'
      + '<select id="grant-subject-type"' + actCh('switchGrantSubjectType') + '>'
      + '<option value="user"' + (State.grantSubjectType !== 'group' ? ' selected' : '') + '>成员</option>'
      + '<option value="group"' + (State.grantSubjectType === 'group' ? ' selected' : '') + '>用户组</option>'
      + '</select>'
      + '<select id="grant-subject">' + subjects + '</select>'
      + '<select id="grant-role">' + grantRoleOptions() + '</select>'
      + '<button class="primary" ' + act('grantBaseAccess') + (State.busy ? ' disabled' : '') + '>授权</button>'
      + (State.busy ? '<span class="spinner"></span>' : '')
      + '</div>';
  }
  return html + '</div>';
}

function pageKnowledge() {
  const ks = State.kbStatus;
  const canWrite = allowed('knowledge', 'write');
  const canDelete = allowed('knowledge', 'delete');

  let html = '';
  // State.notice / State.error 由 render() 外壳统一画（90-start.js），页面里不再重复 ——
  // 重复渲染会让"知识库已创建"这类提示连续出现两次（真机实测抓到）。

  /* ── 检索模式：这一块是「当前到底怎么检索」的唯一说明处 ── */
  const emb = ks && ks.knowledge ? ks.knowledge.embedding : null;
  const parsers = ks && ks.knowledge ? ks.knowledge.parsers : null;
  const pool = ks && ks.knowledge ? ks.knowledge.workerPool : null;
  const chunking = ks && ks.knowledge ? ks.knowledge.chunking : null;

  if (emb) {
    const modeText = emb.mode === 'none'
      ? '<span class="badge warn">纯文本检索</span> bigram + FTS5 bm25'
      : '<span class="badge ok">混合检索</span> 文本 bm25 + 向量余弦（' + esc(emb.mode) + (emb.model ? ' / ' + esc(emb.model) : '') + '，' + (emb.dim || '?') + ' 维）';
    html += '<div class="panel"><h2>当前检索模式</h2><dl class="kv">'
      + kv('检索', modeText)
      + kv('分块', chunking ? ('上限 ' + chunking.maxChars + ' 字符 / 重叠 ' + chunking.overlapChars + ' / 标题层级 ' + chunking.maxHeadingDepth) : '—')
      + kv('解析并发', pool ? (pool.mode === 'worker'
        ? '<span class="badge ok">worker 线程</span> ' + pool.workers + ' 个（不阻塞接口）'
        : '<span class="badge warn">内联（主线程）</span> 解析大文件时接口会变慢') : '—')
      + '</dl>'
      + '<div class="faint" style="margin-top:8px">' + esc((emb && emb.note) || '') + '</div>';

    if (parsers) {
      const ext = parsers.external || {};
      html += '<div style="margin-top:12px"><div class="faint">解析能力（实测，不是"应该支持"）：</div>'
        + '<div style="margin-top:6px">'
        + '<span class="badge ok">纯 Node</span> ' + esc(parsers.nativeExtensions.join(' / '))
        + '<br>'
        + (ext.pdftotext && ext.pdftotext.available
          ? '<span class="badge ok">PDF 可用</span> <span class="faint">' + esc(ext.pdftotext.version || '') + '</span>'
          : '<span class="badge fail">PDF 不可用</span> <span class="faint">' + esc((ext.pdftotext && ext.pdftotext.hint) || '') + '</span>')
        + '<br>'
        + (ext.office && ext.office.available
          ? '<span class="badge ok">Office 可用</span> <span class="faint">' + esc(ext.office.version || '') + '</span>'
          : '<span class="badge fail">Office 不可用</span> <span class="faint">' + esc((ext.office && ext.office.hint) || '') + '</span>')
        + '</div></div>';
    }
    html += '</div>';
  } else {
    html += '<div class="panel"><h2>当前检索模式</h2><div class="empty">读取中…（若一直空白，说明 <code>/api/knowledge/status</code> 取不到）</div></div>';
  }

  /* ── 知识库列表 ── */
  html += '<div class="panel"><h2>知识库</h2>';
  if (canWrite) {
    html += '<div class="row">'
      + '<input id="kb-name" placeholder="新建知识库名称" style="width:240px">'
      + '<select id="kb-visibility">'
      + '<option value="tenant">全组织可见</option>'
      + '<option value="restricted">受限（仅授权成员）</option>'
      + '</select>'
      + '<button class="primary" ' + act('createBase') + (State.busy ? ' disabled' : '') + '>新建</button>'
      + '<span class="faint">导入与建库需要 knowledge:write（默认仅管理员）。</span>'
      + '</div>';
    html += '<div class="faint">'
      + '「受限」库只有被<b>显式授权</b>的成员（或管理员）能看到与检索到 —— 适合财务/法务/薪酬这类库。'
      + '建好后在下方「库级授权」里把成员或用户组加进去。'
      + '</div>';
  }
  const bases = State.bases || [];
  if (!bases.length) {
    html += '<div class="empty" style="margin-top:12px">还没有知识库。' + (canWrite ? '用上面的输入框建一个，然后导入文档。' : '请联系管理员创建。') + '</div>';
  } else {
    html += '<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>名称</th><th>可见性</th><th>文档</th><th>分块</th><th>向量</th><th>创建于</th><th>操作</th></tr></thead><tbody>';
    for (const b of bases) {
      const cur = State.currentBase === b.id;
      const restricted = b.visibility === 'restricted';
      html += '<tr' + (cur ? ' style="background:var(--hover)"' : '') + '>'
        + '<td><a href="#" ' + act('selectBase', esc(b.id)) + '>' + esc(b.name) + '</a>'
        + (cur ? ' <span class="badge dim">当前</span>' : '') + '</td>'
        + '<td>' + (restricted
          ? '<span class="badge warn">受限</span>'
          : '<span class="badge dim">全组织</span>') + '</td>'
        + '<td class="muted">' + b.documentCount + '</td>'
        + '<td class="muted">' + b.chunkCount + '</td>'
        + '<td>' + (b.dim > 0 ? '<span class="badge ok">' + b.dim + ' 维</span>' : '<span class="badge dim">无</span>') + '</td>'
        + '<td class="muted">' + esc(ts(b.createdAt)) + '</td>'
        + '<td>'
        + (canWrite ? '<button ' + act('renameBase', esc(b.id), esc(b.name)) + '>改名</button> ' : '')
        + (canDelete ? '<button ' + act('deleteBase', esc(b.id), esc(b.name)) + '>删除</button>' : '')
        + ((!canWrite && !canDelete) ? '<span class="faint">—</span>' : '')
        + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '</div>';

  /* ── 当前库：授权 + 导入 + 文档列表 ── */
  if (State.currentBase) {
    const curBase = (State.bases || []).find((b) => b.id === State.currentBase);
    // 授权面板对**所有**当前库都渲染（不只是受限的）：`tenant` 库上可以先把名单配好再切可见性；
    // 而"列不出名单"本身也是一条要如实显示的信息。
    if (curBase) html += grantPanel(curBase);
    if (canWrite) {
      html += '<div class="panel"><h2>导入文档</h2>'
        + '<div class="row">'
        + '<input type="file" id="kb-file" style="width:320px">'
        + '<button class="primary" ' + act('importFile') + (State.busy ? ' disabled' : '') + '>导入文件</button>'
        + '</div>'
        + '<div class="faint" style="margin-top:6px">支持 txt / md / csv / tsv / json / jsonl / html；'
        + 'pdf 与 docx/xlsx/pptx 需要服务端装好 pdftotext / LibreOffice（装不上时导入会明确失败并说明缺什么）。'
        + '内容完全相同的文档会被识别为重复，不会重复建索引。</div>'
        + '<div style="margin-top:14px"><div class="faint">或者直接粘贴文本：</div>'
        + '<input id="kb-doc-title" placeholder="标题（可留空）" style="width:280px;margin-top:6px">'
        + '<textarea id="kb-text" rows="5" placeholder="把文本粘在这里…" style="width:100%;margin-top:6px"></textarea>'
        + '<div class="row" style="margin-top:8px"><button ' + act('importText') + (State.busy ? ' disabled' : '') + '>导入这段文本</button>'
        + (State.busy ? '<span class="spinner"></span>' : '')
        + '</div></div></div>';
    }

    const d = State.documents;
    html += '<div class="panel"><h2>文档' + (d ? '（' + d.total + '）' : '') + '</h2>';
    if (!d) {
      html += '<div class="empty">读取中…</div>';
    } else {
      if (d.statusCounts && (d.statusCounts.failed > 0 || d.statusCounts.ready > 0)) {
        html += '<div class="row" style="margin-bottom:10px">'
          + '<span class="badge ok">可检索 ' + d.statusCounts.ready + '</span>'
          + (d.statusCounts.failed ? '<span class="badge fail">解析失败 ' + d.statusCounts.failed + '</span>' : '')
          + (d.statusCounts.parsing ? '<span class="badge warn">解析中 ' + d.statusCounts.parsing + '</span>' : '')
          + '</div>';
      }
      if (!d.items.length) {
        html += '<div class="empty">这个库还是空的。</div>';
      } else {
        html += '<div class="table-wrap"><table><thead><tr><th>标题</th><th>状态</th><th>分块</th><th>来源</th><th>创建于</th><th>操作</th></tr></thead><tbody>';
        for (const doc of d.items) {
          html += '<tr><td>' + esc(doc.title)
            + (doc.error ? '<div class="faint" style="max-width:420px">' + esc(doc.error) + '</div>' : '')
            + '</td>'
            + '<td>' + docStatusBadge(doc.status) + '</td>'
            + '<td class="muted">' + doc.chunkCount + '</td>'
            + '<td class="muted">' + esc(doc.sourceType || '—') + '</td>'
            + '<td class="muted">' + esc(ts(doc.createdAt)) + '</td>'
            + '<td><a href="#" ' + act('previewChunks', esc(doc.id)) + '>分块</a>'
            // 改名与删除一样属"写"动作；act() 内部会做转义，这里传原值（esc 再套一层会双重转义）
            + (canWrite ? ' · <a href="#" ' + act('renameDocument', doc.id, doc.title || '') + '>改名</a>' : '')
            + (canDelete ? ' · <a href="#" ' + act('deleteDocument', esc(doc.id)) + '>删除</a>' : '')
            + '</td></tr>';
        }
        html += '</tbody></table></div>';
      }
    }
    html += '</div>';
  }

  /* ── 分块预览 ── */
  if (State.chunks) {
    const c = State.chunks;
    html += '<div class="panel"><h2>分块预览：' + esc((c.document && c.document.title) || '') + '（共 ' + c.total + '）</h2>'
      + '<div class="faint">下面是真正进入索引的内容单元。引用能不能回溯，取决于这里的定位信息：'
      + '<b>缺定位信息的分块会被标出来</b>，它无法被指回原文位置。</div>'
      + '<div style="margin-top:10px">';
    for (const it of c.items) {
      html += '<div class="note" style="margin-bottom:8px">'
        + '<div class="row"><span class="badge dim">#' + it.ord + '</span>'
        + (it.hasVector ? '<span class="badge ok">有向量</span>' : '<span class="badge dim">无向量</span>')
        + (it.locationKnown ? '' : '<span class="badge fail">无定位信息</span>')
        + '<span class="faint">' + esc(it.citationLabel) + '</span></div>'
        + '<pre style="white-space:pre-wrap;margin:6px 0 0">' + esc(it.body) + '</pre>'
        + '</div>';
    }
    html += '</div>'
      + '<div class="row"><button ' + act('closeChunks') + '>收起</button></div></div>';
  }

  /* ── 检索 ── */
  const pfSel = State.kbPrefilter || '';
  html += '<div class="panel"><h2>召回测试</h2>'
    + '<div class="row">'
    + '<input id="kb-q" placeholder="输入查询，例如：权限管理 / 管理权限 / 权" style="width:320px">'
    + '<input id="kb-limit" type="number" min="1" max="50" value="10" style="width:80px">'
    + '<select id="kb-prefilter" title="向量预过滤：先按文本命中把候选缩到几百条，再在候选上算余弦。快，但会牺牲纯语义召回">'
    + '<option value=""' + (pfSel === '' ? ' selected' : '') + '>预过滤：跟随配置</option>'
    + '<option value="on"' + (pfSel === 'on' ? ' selected' : '') + '>预过滤：强制开</option>'
    + '<option value="off"' + (pfSel === 'off' ? ' selected' : '') + '>预过滤：强制关</option>'
    + '</select>'
    + '<button class="primary" ' + act('runSearch') + (State.busy ? ' disabled' : '') + '>检索</button>'
    + '<span class="faint">只搜当前组织的知识库；指定不属于本组织的库会被拒。</span>'
    + '</div>';
  if (State.busy) html += '<div class="row" style="margin-top:8px"><span class="spinner"></span><span class="faint">检索中…</span></div>';

  const s = State.search;
  if (s) {
    const r = s.retrieval || {};
    html += '<div class="note" style="margin-top:12px">'
      + '模式 <b>' + esc(r.mode) + '</b>'
      + '｜文本档 <span class="mono">' + esc(r.ftsMatchMode || '—') + '</span>'
      + (r.ftsAttempted && r.ftsAttempted.length ? '（依次尝试：' + esc(r.ftsAttempted.join(' → ')) + '）' : '')
      + '｜向量 <b>' + esc(r.vectorMode || '—') + '</b>'
      + (r.scannedVectors ? '（扫描 ' + r.scannedVectors + ' 条）' : '')
      + '｜预过滤 <b>' + esc(prefilterLabel(r.prefilter)) + '</b>'
      + '｜候选 ' + esc(JSON.stringify(r.candidateCounts || {}))
      + (r.timings ? '｜耗时 文本 ' + (r.timings.ftsMs || 0) + 'ms'
        + (r.timings.prefilterMs != null ? ' / 候选 ' + r.timings.prefilterMs + 'ms' : '')
        + (r.timings.vectorMs != null ? ' / 向量 ' + r.timings.vectorMs + 'ms' : '') : '')
      + '</div>';
    if (s.stats && s.stats.note) html += '<div class="note warn">' + esc(s.stats.note) + '</div>';
    if (s.notes && s.notes.length) {
      html += '<div class="note">' + s.notes.map((n) => esc(n)).join('<br>') + '</div>';
    }

    if (!s.results.length) {
      html += '<div class="empty" style="margin-top:10px">没有命中。换一个说法，或先确认文档状态是「可检索」。</div>';
    } else {
      for (const it of s.results) {
        const cit = it.citation || {};
        const loc = cit.location || {};
        const locParts = [];
        if (loc.headingPath && loc.headingPath.length) locParts.push('章节：' + loc.headingPath.join(' › '));
        if (loc.page != null) locParts.push('第 ' + loc.page + ' 页');
        else if (loc.pages && loc.pages.length > 1) locParts.push('第 ' + loc.pages[0] + '–' + loc.pages[loc.pages.length - 1] + ' 页');
        if (loc.anchor) locParts.push('锚点：' + loc.anchor);
        if (loc.rows) locParts.push(loc.rows.start === loc.rows.end ? '第 ' + loc.rows.start + ' 行' : '第 ' + loc.rows.start + '–' + loc.rows.end + ' 行');
        html += '<div class="note" style="margin-top:10px">'
          + '<div class="row"><span class="badge ok">' + it.score.toFixed(4) + '</span>'
          + '<span class="faint">rrf｜文本排名 ' + (it.ranks.fts == null ? '—' : it.ranks.fts)
          + '｜向量排名 ' + (it.ranks.vector == null ? '—' : it.ranks.vector) + '</span>'
          + (cit.locationKnown ? '' : '<span class="badge fail">无定位信息</span>')
          + '</div>'
          + '<div style="margin-top:6px"><b>' + esc(cit.label || '') + '</b></div>'
          + (locParts.length ? '<div class="faint">' + esc(locParts.join('｜')) + '</div>' : '')
          + '<pre style="white-space:pre-wrap;margin:6px 0 0">' + esc(it.text) + '</pre>'
          + '</div>';
      }
    }
  }
  html += '</div>';

  return html;
}

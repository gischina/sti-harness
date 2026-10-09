/* STI HARNESS 前端 · 组织页：部门 / 用户组 / 角色 / 凭据 / 我的账号
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 部门（组织归属）──
 *
 * ⚠️ 界面上必须说清：部门**不是权限载体**。否则会有人把"把人挪进管理员部"
 * 当成一种授权，然后奇怪为什么权限没变。权限只来自角色与用户组。
 */

function deptList() {
  return (State.departments && State.departments.departments) || [];
}

/** 部门 id → 名称。查不到给 null，调用方自己决定怎么显示（不要编一个名字）。 */
function deptName(id) {
  if (!id) return null;
  const hit = deptList().find((x) => x.id === id);
  return hit ? hit.name : null;
}

/** 部门下拉选项。`empty` 决定是否带"（不归属）"这一项（= null）。 */
function deptOptions(selectedId, { empty = false, emptyLabel = '（不归属任何部门）' } = {}) {
  const opts = [];
  if (empty) {
    opts.push('<option value=""' + (selectedId ? '' : ' selected') + '>' + esc(emptyLabel) + '</option>');
  }
  for (const d of deptList()) {
    opts.push('<option value="' + esc(d.id) + '"' + (d.id === selectedId ? ' selected' : '') + '>'
      + esc(d.name) + '</option>');
  }
  return opts.join('');
}

/**
 * 用户组页。
 *
 * 组的「成员」不单独请求 —— 从账号列表里的 `user.groups` **反查**出来。
 * 两个理由：① 同一份事实只有一处来源，不会出现"组页说 3 人、账号页说 2 人"；
 * ② 少一次请求。代价是：没有 `user:read` 的人看不到成员名单 —— 那就**如实说**，
 * 不能显示成空。
 */
function pageGroups() {
  const r = State.groups;
  if (!r) return loadingOrError();
  const canWrite = allowed('group', 'write');
  const canDelete = allowed('group', 'delete');
  const canRole = allowed('role', 'write');
  const userList = ((State.users || {}).users) || [];
  const canSeeUsers = !!State.users;

  let html = '';
  if (canWrite) {
    html += '<div class="panel"><h2>新建组</h2>'
      + '<div class="row">'
      + '<input id="ng-name" placeholder="组名（唯一，≤64 字）" style="width:220px">'
      + '<input id="ng-desc" placeholder="说明（可留空）" style="width:280px">'
      + '<button class="primary" ' + act('createGroup') + '>创建</button>'
      + '</div>'
      + '<div class="faint" style="margin-top:8px">组本身<b>不含任何权限</b>；'
      + '给组挂上角色之后，组里每个人都会获得该角色。</div>'
      + '</div>';
  } else {
    html += '<div class="note">你可以查看组，但<b>没有修改权限</b>（需要 <code>group:write</code>）。</div>';
  }

  html += '<div class="panel"><h2>组（' + r.groups.length + ' 个）</h2>';
  if (!r.groups.length) {
    html += '<div class="empty">这个组织里还没有用户组。' + (canWrite ? '用上面的表单建一个。' : '') + '</div>';
  } else if (!canSeeUsers) {
    html += '<div class="note">没有 <code>user:read</code>，因此<b>无法列出组成员姓名</b>'
      + '（成员数由服务端给出，仍是真的）。</div>';
  }
  if (r.groups.length) {
    html += '<div class="table-wrap"><table><thead><tr><th>组名</th><th>说明</th><th>成员</th>'
      + '<th>组持有的角色</th><th>创建于</th><th>操作</th></tr></thead><tbody>';
    for (const g of r.groups) {
      const members = userList.filter((u) => (u.groups || []).some((x) => x.id === g.id));
      const memberCell = canSeeUsers
        ? (members.length
          ? members.map((u) => '<span class="badge dim">' + esc(u.displayName || u.username) + '</span>').join(' ')
          : '<span class="faint">（空组）</span>')
        : '<span class="muted">' + g.memberCount + ' 人</span>';
      html += '<tr>'
        + '<td><b>' + esc(g.name) + '</b></td>'
        + '<td class="muted">' + esc(g.description || '—') + '</td>'
        + '<td>' + memberCell + '</td>'
        + '<td>' + ((g.roles || []).length
          ? g.roles.map((k) => '<span class="badge ok">' + esc(roleName(k)) + '</span>').join(' ')
          : '<span class="faint">— 无权限</span>') + '</td>'
        + '<td class="muted">' + esc(ts(g.createdAt)) + '</td>'
        + '<td>' + groupActions(g, { canWrite, canDelete, canRole }) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '</div>';

  html += '<div class="note">'
    + '<b>有效角色 = 直接绑定 ∪ 所属组绑定。</b>组上的角色对该组全部成员生效，'
    + '并且会随请求实时生效（权限判定每次请求现查库，不需要重新登录）。<br>'
    + '<b>三条组织级保护会穿透到组：</b>摘掉组的「所有者」角色、把最后一位所有者移出组、'
    + '删除唯一承载所有者的组 —— 这三种操作都会被<b>整体回滚</b>并报错，'
    + '因为它们都会让这个组织一个能管的人都不剩。'
    + '</div>';
  return html;
}

function groupActions(g, { canWrite, canDelete, canRole }) {
  const out = [];
  // 改名 / 改说明（0.18.0）：后端 PUT /api/identity/groups/:id 一直在（group:write），
  // 此前界面上没有入口 —— 组名打错字或说明要改，只能删组重建（连带丢角色与成员）。
  if (canWrite) out.push('<button ' + act('renameGroup', esc(g.id)) + '>改名</button>');
  if (canWrite) out.push('<button ' + act('editGroupDesc', esc(g.id)) + '>改说明</button>');
  if (canRole) out.push('<button ' + act('editGroupRoles', esc(g.id)) + '>改角色</button>');
  if (canWrite) out.push('<button ' + act('editGroupMembers', esc(g.id)) + '>改成员</button>');
  if (canDelete) out.push('<button class="danger" ' + act('deleteGroup', esc(g.id)) + '>删除</button>');
  return out.length ? '<div class="row" style="gap:6px">' + out.join('') + '</div>' : '<span class="faint">—</span>';
}

function pageRoles() {
  const r = State.roles;
  if (!r) return loadingOrError();
  const meta = r.meta || {};

  let html = '<div class="panel"><h2>权限模型</h2>'
    + '<div class="faint">' + esc(meta.rules || '') + '</div>'
    + '<div class="row" style="margin-top:10px">'
    + '<span class="faint">资源 ' + (meta.resources || []).length + ' 项</span>'
    + '<span class="faint">动作 ' + (meta.actions || []).map((a) => esc(ACTION_LABEL[a] || a)).join(' / ') + '</span>'
    + '</div></div>';

  for (const role of r.roles) {
    html += '<div class="panel"><h2>' + esc(role.name) + ' <span class="mono faint">' + esc(role.key) + '</span>'
      + (role.builtin ? ' <span class="badge dim">内置</span>' : '') + '</h2>'
      + '<div class="faint">' + esc(role.description || '') + '</div>'
      + '<div style="margin-top:10px">' + matrixTable(role.matrix, meta) + '</div></div>';
  }

  html += '<div class="note">权限判定规则：具体资源优先于默认档 <code>"*"</code>；动作 <code>"*"</code> 表示全权；'
    + '<b>未知角色一律拒绝</b>。</div>';
  return html;
}

function matrixTable(matrix, meta) {
  const resources = (meta && meta.resources) || Object.keys(matrix || {});
  const actions = (meta && meta.actions) || ['read', 'write', 'delete', 'execute'];
  let html = '<div class="table-wrap"><table><thead><tr><th>资源</th>';
  for (const a of actions) html += '<th>' + esc(ACTION_LABEL[a] || a) + '</th>';
  html += '</tr></thead><tbody>';
  for (const res of resources) {
    html += '<tr><td class="mono">' + esc(res) + ' <span class="faint">' + esc(RESOURCE_LABEL[res] || '') + '</span></td>';
    for (const a of actions) {
      const ok = !!(matrix && matrix[res] && matrix[res][a]);
      html += '<td>' + (ok ? '<span class="badge ok">✓</span>' : '<span class="faint">—</span>') + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function pageCreds() {
  const r = State.creds;
  if (!r) return loadingOrError();
  const canWrite = allowed('credential', 'write');

  let html = '';
  // State.notice / State.error 由 render() 外壳统一画（90-start.js），页面里不再重复 ——
  // 重复渲染会让"已创建/已删除"这类提示连续出现两次。
  if (canWrite) {
    html += '<div class="panel"><h2>写入 / 更新凭据</h2>'
      + '<div class="row">'
      + '<input id="cd-name" placeholder="名称（如 model-key）" style="width:180px">'
      + '<input id="cd-provider" placeholder="提供方（可留空）" style="width:180px">'
      + '<input id="cd-value" type="password" placeholder="凭据值" style="width:280px">'
      + '<button class="primary" ' + act('setCred') + '>保存</button>'
      + '</div>'
      + '<div class="faint" style="margin-top:8px">同名凭据会被覆盖。值以 AES-256-GCM 加密落库，'
      + '主密钥在 <code>data/.secret</code>（与数据库分开存放，备份时必须一起带上）。</div>'
      + '</div>';
  }

  html += '<div class="panel"><h2>凭据（' + r.credentials.length + ' 条）</h2>';
  if (!r.credentials.length) {
    html += '<div class="empty">还没有凭据。</div>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>名称</th><th>提供方</th><th>有值</th><th>引用</th><th>更新时间</th><th>操作</th></tr></thead><tbody>';
    for (const c of r.credentials) {
      html += '<tr><td class="mono">' + esc(c.name) + '</td>'
        + '<td>' + esc(c.provider || '—') + '</td>'
        + '<td>' + (c.hasValue ? '<span class="badge ok">是</span>' : '<span class="badge warn">否</span>') + '</td>'
        + '<td class="muted">' + (c.refCount || 0) + '</td>'
        + '<td class="muted">' + esc(ts(c.updatedAt)) + '</td>'
        + '<td>' + (canWrite ? '<button ' + act('delCred', esc(c.id), esc(c.name)) + '>删除</button>' : '<span class="faint">—</span>') + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '<div class="note">' + esc(r.note) + '</div></div>';
  return html;
}

function pageMe() {
  const me = State.me;
  if (!me) return loadingOrError();
  const u = me.user || {};
  const meta = me.permissionsMeta || {};

  let html = '<div class="panel"><h2>我的账号</h2><dl class="kv">'
    + kv('账号', '<span class="mono">' + esc(u.username) + '</span>')
    + kv('姓名', esc(u.displayName))
    + kv('角色', (u.roles || []).map((x) => '<span class="badge dim">' + esc(roleName(x)) + '</span>').join(' ') || '—')
    + kv('状态', u.status === 'active' ? '<span class="badge ok">启用</span>' : '<span class="badge fail">停用</span>')
    + kv('最近登录', esc(ts(u.lastLoginAt)))
    + kv('创建于', esc(ts(u.createdAt)))
    + kv('令牌携带方式', '<span class="mono">' + esc((me.auth && me.auth.via) || '—') + '</span>')
    + kv('凭证种类', '<span class="mono">' + esc((me.auth && me.auth.credential) || '—') + '</span>')
    + '</dl></div>';

  html += '<div class="panel"><h2>我的权限</h2>'
    + '<div class="faint">下面是服务端按你的角色算出来的实际权限。'
    + '前端只是据此隐藏入口；<b>真正的拦截在服务端</b>，藏起来不等于安全。</div>'
    + '<div style="margin-top:10px">' + matrixTable(me.permissions, meta) + '</div></div>';

  const keys = State.apikeys;
  html += '<div class="panel"><h2>我的 API Key</h2>'
    + '<div class="row">'
    + '<input id="ak-name" placeholder="用途说明（如 ci-pipeline）" style="width:220px">'
    + '<input id="ak-days" type="number" min="0" placeholder="有效天数（留空=长期）" style="width:180px">'
    + '<button class="primary" ' + act('createApiKey') + '>创建</button>'
    + '</div>';
  if (keys && keys.keys && keys.keys.length) {
    html += '<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>名称</th><th>ID</th><th>过期</th><th>最近使用</th><th>创建于</th><th>操作</th></tr></thead><tbody>';
    for (const k of keys.keys) {
      html += '<tr><td>' + esc(k.name) + '</td>'
        + '<td class="mono faint">' + esc(k.id) + '</td>'
        + '<td class="muted">' + esc(k.expiresAt ? ts(k.expiresAt) : '长期') + '</td>'
        + '<td class="muted">' + esc(ts(k.lastUsedAt)) + '</td>'
        + '<td class="muted">' + esc(ts(k.createdAt)) + '</td>'
        + '<td><button ' + act('revokeApiKey', esc(k.id)) + '>吊销</button></td></tr>';
    }
    html += '</tbody></table></div>';
  } else if (keys) {
    html += '<div class="empty" style="margin-top:12px">还没有 API Key。给脚本/集成用一个，别用你的登录口令。</div>';
  }
  html += '<div class="note">' + esc((keys && keys.note) || '明文 key 只在创建时返回一次；服务端只保存它的 HMAC 哈希。')
    + '</div></div>';

  // ── 两步验证（TOTP，0.17.0）──
  // 三种状态各给一条明确的下一步，**不压成一个开关**：
  //   已启用（换恢复码 / 停用）、未完成登记（继续确认 / 换新密钥重来）、未启用（开启）。
  // 密钥与恢复码明文永远不会出现在这里 —— 它们只在登记/重发的那一次响应里出现。
  const t = State.totp && State.totp.totp;
  html += '<div class="panel"><h2>两步验证</h2>';
  if (!t) {
    html += '<div class="faint">读不到两步验证状态，刷新页面重试。</div>';
  } else if (t.enabled) {
    html += '<div class="row">'
      + '<span class="badge ok">已启用</span>'
      + '<span class="faint">启用时间：' + esc(ts(t.enabledAt)) + '</span>'
      + '<span class="faint">恢复码剩余：' + Number(t.recoveryCodesLeft || 0) + ' 张</span>'
      + '</div>'
      + '<div class="row mt-8">'
      + '<button' + (t.recoveryCodesLeft <= 3 ? ' class="primary"' : '') + ' '
      + act('totpRegenCodes') + '>重新生成恢复码</button>'
      + '<button class="danger" ' + act('totpDisable') + '>停用</button>'
      + '</div>'
      + (t.recoveryCodesLeft <= 3
        ? '<div class="note">恢复码只剩 ' + Number(t.recoveryCodesLeft || 0)
          + ' 张 —— 真丢了设备时，恢复机会不多了。建议现在重新生成一批。</div>'
        : '');
  } else if (t.pending) {
    html += '<div class="row"><span class="badge warn">未完成登记</span></div>'
      + '<div class="faint">密钥已生成、但还没用动态码确认 —— 确认之前两步验证不生效。</div>'
      + '<div class="row mt-8">'
      + '<button class="primary" ' + act('totpConfirm') + '>继续确认</button>'
      + '<button ' + act('totpBeginEnroll') + '>重新登记（换新密钥）</button>'
      + '</div>';
  } else {
    html += '<div class="faint">当前未启用。开启后，即使口令泄露，没有你的验证器也登不进来。</div>'
      + '<div class="row mt-8">'
      + '<button class="primary" ' + act('totpBeginEnroll') + '>开启两步验证</button>'
      + '</div>';
  }
  html += '<div class="note">开启后登录 = 口令 + 验证器上的 6 位动态码；恢复码是丢设备时的备用通道，'
    + '每张只能用一次。<b>登记、停用、重发恢复码都要现场再验一次身份</b>（重输口令或动态码）——'
    + '仅凭登录会话不能改动第二因子。真丢了设备的用户可以请管理员在「账号管理」里重置（重置不动口令、不吊销会话）。'
    + '</div></div>';
  return html;
}

/**
 * 向量预过滤状态的**人话**（B2）。
 * 关键是把「退化」与「关」分开说：两者结果都是全量扫描，但原因完全不同 ——
 * "我关了"是选择，"候选不足自动退化"是事实，混成一句会让使用者以为开关没生效。
 */

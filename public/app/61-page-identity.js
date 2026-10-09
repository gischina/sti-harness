/* STI HARNESS 前端 · 身份页：账号管理
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 页面渲染：身份 ───────────────────────────────────── */

function pageUsers() {
  const r = State.users;
  if (!r) return loadingOrError();
  const canWrite = allowed('user', 'write');
  const canRole = allowed('role', 'write');

  let html = '';
  // State.notice / State.error 由 render() 外壳统一画在页头下（90-start.js）——
  // 这里曾再各画一遍，用户看到"已创建"提示连续出现两次。别在页面模板里重复渲染。

  if (canWrite) {
    html += '<div class="panel"><h2>新建账号</h2>'
      + '<div class="row">'
      + '<input id="nu-user" placeholder="账号（字母/数字/._-@）" style="width:200px">'
      + '<input id="nu-name" placeholder="姓名（可留空）" style="width:150px">'
      + '<input id="nu-pass" type="password" placeholder="口令（≥8 位，含两类字符）" style="width:240px">'
      + '<select id="nu-role">' + roleOptions().map((o) => '<option value="' + esc(o.key) + '">' + esc(o.name) + '</option>').join('') + '</select>'
      // 部门只在**存在部门**时才出现在这里：一个只有"（不归属）"一项的下拉，
      // 只会让人以为功能坏了。没有部门时下方有"新建部门"面板指路。
      + (deptList().length ? '<select id="nu-dept">' + deptOptions(null, { empty: true }) + '</select>' : '')
      + '<button class="primary" ' + act('createUser') + '>创建</button>'
      + '</div>'
      + '<div class="faint" style="margin-top:8px">默认角色是<b>成员</b>。角色决定能看什么、能做什么（见「角色与权限」页）。'
      + (deptList().length ? '部门只表示归属，<b>不影响权限</b>。' : '') + '</div>'
      + '</div>';
    // ── 批量导入（0.17.0）──
    // 与「新建账号」是同一件事的批量形态，放同一块里。文件输入藏起来（.hidden 放 style.css ——
    // 内联 style 有冻结计数，只减不增），按钮只是触发器；读取与提交在 usersCsvChosen（70-app.js）。
    html += '<div class="panel"><h2>批量导入账号</h2>'
      + '<div class="row">'
      + '<button ' + act('importUsers') + '>选择 CSV 文件…</button>'
      + '<input type="file" id="nu-file" accept=".csv,text/csv" class="hidden" ' + actCh('usersCsvChosen') + '>'
      + '</div>'
      + '<div class="faint">列：<b>账号</b>、<b>口令</b>（这两列必填）、姓名、部门、角色（多个用逗号分隔，默认成员）。'
      + '部门填<b>名称</b>（不是 ID）；单次最多 500 行；UTF-8 / GBK 编码均可；'
      + '一行出错只跳过该行、其余照常创建，结束后会列出失败的行号。</div>'
      + '</div>';
  } else {
    html += '<div class="note">你可以查看账号列表，但<b>没有修改权限</b>（需要 <code>user:write</code>）。</div>';
  }

  html += '<div class="panel"><h2>账号（' + r.users.length + ' 个）</h2>';
  if (!r.users.length) {
    html += '<div class="empty">这个组织里还没有其他账号。</div>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>所属组</th><th>部门</th><th>状态</th>'
      + '<th>最近登录</th><th>创建于</th><th>操作</th></tr></thead><tbody>';
    for (const u of r.users) {
      const isMe = State.me && State.me.user && State.me.user.id === u.id;
      // 角色来自组时要标出来：同一个「管理员」角标，一个是本人被授的、一个是组的，
      // 不标的话管理员根本不知道该去哪个地方撤销它。
      const viaGroups = new Map();
      for (const g of (u.groups || [])) {
        for (const k of (g.roles || [])) {
          if (!viaGroups.has(k)) viaGroups.set(k, []);
          viaGroups.get(k).push(g.name);
        }
      }
      const roleCell = (u.roles || []).map((x) => {
        const from = viaGroups.get(x);
        return from
          ? '<span class="badge ok" title="来自组：' + esc(from.join('、')) + '">' + esc(roleName(x)) + ' ⤴</span>'
          : '<span class="badge dim">' + esc(roleName(x)) + '</span>';
      }).join(' ');
      const groupCell = (u.groups || []).length
        ? u.groups.map((g) => '<span class="badge dim">' + esc(g.name) + '</span>').join(' ')
        : '<span class="faint">—</span>';
      // 有 deptId 但查不到名字 = 指向了一个本组织已不存在的部门（脏数据）。
      // 这时**如实标"已失效"**，不要显示一个空白格 —— 空白会让人以为"没设部门"，
      // 而这两种状态需要完全不同的处置。
      const deptCell = u.deptId
        ? (deptName(u.deptId)
          ? '<span class="badge dim">' + esc(deptName(u.deptId)) + '</span>'
          : '<span class="badge fail" title="' + esc(u.deptId) + '">已失效</span>')
        : '<span class="faint">—</span>';
      html += '<tr>'
        + '<td class="mono">' + esc(u.username) + (isMe ? ' <span class="badge dim">我</span>' : '') + '</td>'
        + '<td>' + esc(u.displayName) + '</td>'
        + '<td>' + roleCell + '</td>'
        + '<td>' + groupCell + '</td>'
        + '<td>' + deptCell + '</td>'
        + '<td>' + (u.status === 'active' ? '<span class="badge ok">启用</span>' : '<span class="badge fail">停用</span>')
        + (u.totpEnabled ? ' <span class="badge dim" title="已启用两步验证（TOTP）">两步</span>' : '') + '</td>'
        + '<td class="muted">' + esc(ts(u.lastLoginAt)) + '</td>'
        + '<td class="muted">' + esc(ts(u.createdAt)) + '</td>'
        + '<td>' + rowActions(u, canWrite, canRole) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '</div>';

  html += '<div class="note">'
    + '<b>两条组织级保护：</b>不能移除最后一个所有者的角色，也不能停用最后一个所有者 —— '
    + '否则这个组织就没人能管了。两者都按<b>生效角色</b>算：凭「用户组」持有的所有者一样计入。'
    + '改口令或停用账号会<b>立即吊销该用户全部会话</b>，不是等他下次登录才生效。'
    + '用户丢了验证器用「重置两步验证」：只清第二因子，<b>不动口令、不吊销会话</b>；要更强处置就用「重置口令」。<br>'
    + '角色角标带 <span class="badge ok">⤴</span> 表示这个角色<b>来自用户组</b>（鼠标悬停看是哪个组）；'
    + '要撤销得去<a href="#/groups">用户组</a>页，改这个人的角色是撤不掉的。'
    + '</div>';

  // ── 部门 ──
  //
  // 放在账号页而不是单开一页：部门的唯一用途就是"人挂在哪个单位"，
  // 与账号列表是同一件事的两个视角，分开会让人在两页之间来回跳。
  const depts = deptList();
  const canDeptWrite = allowed('department', 'write');
  const canDeptDelete = allowed('department', 'delete');
  html += '<div class="panel"><h2>部门（' + depts.length + ' 个）</h2>';
  if (canDeptWrite) {
    html += '<div class="row">'
      + '<input id="nd-name" class="input-md" placeholder="部门名称">'
      + '<button class="primary" ' + act('createDepartment') + '>新建部门</button>'
      + '</div>';
  }
  if (!depts.length) {
    html += '<div class="empty">还没有部门。部门是<b>可选</b>的 —— 组织只有一层（所有人直属）时不需要它。</div>';
  } else {
    // 「子部门」列只在真的存在子部门时才出现：单层组织（常态）里一列全是「—」，
    // 只会让人以为哪里漏了配置。
    const hasChildren = depts.some((d) => (d.childCount || 0) > 0);
    html += '<div class="table-wrap"><table><thead><tr><th>名称</th><th>成员</th>'
      + (hasChildren ? '<th>子部门</th>' : '') + '<th>创建于</th><th>操作</th></tr></thead><tbody>';
    for (const d of depts) {
      html += '<tr><td>' + esc(d.name) + '</td>'
        + '<td>' + (d.memberCount == null ? '<span class="faint">—</span>' : d.memberCount + ' 人') + '</td>'
        + (hasChildren ? '<td>' + ((d.childCount || 0) ? d.childCount + ' 个' : '<span class="faint">—</span>') + '</td>' : '')
        + '<td class="muted">' + esc(ts(d.createdAt)) + '</td>'
        + '<td>' + deptActions(d, canDeptWrite, canDeptDelete) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '<div class="note"><b>部门不是权限载体。</b>它只表示「这个人在哪个单位」，用于组织视图与人数统计；'
    + '把谁挪进哪个部门<b>不会改变他的任何权限</b> —— 权限只来自角色与用户组。<br>'
    + '删除与改名都在表格里操作（改名不改变任何人的归属）。删除是<b>带引用护栏</b>的：'
    + '部门下还有成员或有子部门时会被<b>拒绝</b>并说明原因 —— 部门是组织视图的一部分，'
    + '直接删掉会让这些引用变成悬空引用。要清理就先改人的归属、先处理子部门。</div>';
  html += '</div>';

  return html;
}

function deptActions(d, canWrite, canDelete) {
  const out = [];
  if (canWrite) out.push('<button ' + act('renameDepartment', esc(d.id)) + '>改名</button>');
  if (canDelete) out.push('<button class="danger" ' + act('deleteDepartment', esc(d.id)) + '>删除</button>');
  // 用 .row（不加内联 gap）——上方账号行的 gap:6px 是历史写法，
  // 而内联 style 总数被回归冻结，这里不再新增。
  return out.length ? '<div class="row">' + out.join('') + '</div>' : '<span class="faint">—</span>';
}

function rowActions(u, canWrite, canRole) {
  const out = [];
  if (canRole) {
    out.push('<button ' + act('editRoles', esc(u.id)) + '>改角色</button>');
  }
  if (canWrite) {
    // 改姓名（0.18.0）：后端 PUT /api/identity/users/:id 接受 displayName 已久，
    // 此前界面只传 deptId —— 姓名打错了没有地方改。
    out.push('<button ' + act('setUserName', esc(u.id)) + '>改姓名</button>');
    out.push('<button ' + act('setUserDept', esc(u.id)) + '>改归属</button>');
    out.push('<button ' + act('resetPassword', esc(u.id)) + '>重置口令</button>');
    // 只有启用了两步的账号才给这个入口：没启用就没什么可重置的，
    // 多一个永远无效的按钮只会让人猜它到底做什么。
    if (u.totpEnabled) out.push('<button ' + act('resetUserTotp', esc(u.id), esc(u.username)) + '>重置两步验证</button>');
    out.push(u.status === 'active'
      ? '<button ' + act('setStatus', esc(u.id), 'disabled') + '>停用</button>'
      : '<button ' + act('setStatus', esc(u.id), 'active') + '>启用</button>');
  }
  // 删除账号（0.16.0）：后端 DELETE /api/identity/users/:id 一直存在（独立 user:delete 权限，
  // 默认档不含 —— 所以用 allowed('user','delete') 判定，而不是 canWrite），此前没有界面入口。
  // 自己不能删自己（也不该由界面提供），后端同样会拦。
  if (allowed('user', 'delete') && !(State.me && State.me.user && State.me.user.id === u.id)) {
    out.push('<button class="danger" ' + act('deleteUser', esc(u.id), esc(u.username)) + '>删除</button>');
  }
  return out.length ? '<div class="row" style="gap:6px">' + out.join('') + '</div>' : '<span class="faint">—</span>';
}

function roleOptions() {
  const list = (State.roles && State.roles.roles) || [];
  if (!list.length) return [{ key: 'member', name: '成员' }];
  return list.map((x) => ({ key: x.key, name: x.name }));
}

function roleName(key) {
  const list = (State.roles && State.roles.roles) || [];
  const hit = list.find((x) => x.key === key);
  return hit ? hit.name : key;
}

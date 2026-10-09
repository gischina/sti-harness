/* STI HARNESS 前端 · 能力三页与备份恢复页
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 能力分发三页（M4）────────────────────────────────── */

function pageCapabilities() {
  if (!State.capSkills) return loadingOrError();
  const reg = (State.capSkills.registry || []);
  const canSkillWrite = allowed('skill', 'write');
  const kern = State.capSkills.kernel || { skills: [], blocked: [] };
  let html = '<div class="panel"><h2>Skill（平台登记 ' + reg.length + ' 个）</h2>';
  html += '<div class="table-wrap"><table><thead><tr><th>名称</th><th>来源</th><th>版本</th><th>状态</th><th>安装时间</th><th></th></tr></thead><tbody>';
  for (const s of reg) {
    html += '<tr><td class="mono">' + esc(s.name) + '</td>'
      + '<td>' + esc(s.source) + '</td>'
      + '<td class="mono">' + esc(s.version || '—') + '</td>'
      + '<td>' + (s.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge dim">停用</span>') + '</td>'
      + '<td class="mono">' + esc(String(s.installedAt || '').replace('T', ' ').slice(0, 19)) + '</td>'
      + '<td><button ' + act('toggleSkill', esc(s.name), (!s.enabled)) + '>' + (s.enabled ? '停用' : '启用') + '</button> '
      + '<button ' + act('checkUpdate', esc(s.name)) + '>更新检测</button>'
      + (canSkillWrite ? ' <button class="danger" ' + act('removeSkill', esc(s.name)) + '>卸载</button>' : '')
      + '</td></tr>';
  }
  if (!reg.length) html += '<tr><td colspan="6" class="muted">还没有登记任何 Skill —— 用下面的 ZIP 安装，或在来源页导入。</td></tr>';
  html += '</tbody></table></div>';
  html += '<h3 style="margin-top:14px">从 ZIP 包安装</h3><div class="row">'
    + '<input id="skill-name" placeholder="名称（字母/数字/点/连字符）" style="width:200px">'
    + '<input id="skill-zip" type="file" accept=".zip">'
    + '<button class="primary" ' + act('installSkill') + (State.busy ? ' disabled' : '') + '>安装</button>'
    + '</div>';
  html += '<details style="margin-top:8px"><summary class="faint">安装行为说明</summary>'
    + '<div class="note">安装失败会整体回滚（不落半成品）并记审计；ZIP 内含路径穿越条目（../、绝对路径）会被直接拒绝。</div></details></div>';

  // 分段顺序（0.20.0 试用反馈）：Skill → MCP 服务 → 插件。
  // ⚠️ 0.21.10：原来的第三段「工具」整块删除（用户裁定 —— 工具由内核自己调用、
  //    不用单独写这个能力、也不会单独列出来有哪些工具）。详见 0025_drop_tools.sql。
  //    留下一句话而不是零个字：这一段被**有意**拿掉了，不是"渲染少了"。
  const mcp = (State.capMcp && State.capMcp.registry) || [];
  const canMcpWrite = allowed('mcp', 'write');
  html += '<div class="panel"><h2>MCP 服务（' + mcp.length + ' 个；健康为真实探测结果）</h2>';
  // 登记 / 重新配置（0.16.0）：POST /api/capability/mcp 本来就是 upsert（同名覆盖），
  // 此前只有命令行能调它 —— 页面上只能看不能登记，治理入口缺了一半。
  if (canMcpWrite) {
    html += '<h3 style="margin-top:4px">登记 / 重新配置</h3><div class="row">'
      + '<input id="mcp-name" placeholder="名称（字母/数字/点/连字符）" style="width:210px">'
      + '<select id="mcp-transport">'
      + '<option value="stdio">stdio（本机命令）</option><option value="sse">sse</option><option value="http">http</option>'
      + '</select>'
      + '<label class="faint"><input type="checkbox" id="mcp-enabled" checked> 登记后立即启用</label>'
      + '<button class="primary" ' + act('registerMcp') + (State.busy ? ' disabled' : '') + '>保存</button>'
      + '</div>'
      + '<textarea id="mcp-config" rows="3" style="width:100%;margin-top:8px;font-family:monospace" '
      + 'placeholder=\'连接配置 JSON：stdio 填 {"command":"…"}；http/sse 填 {"url":"…"}。留空 = 清除已存配置\'></textarea>'
      + '<div class="faint" style="margin-top:4px">同名即覆盖（upsert）。配置以 AES-256-GCM 加密落库，'
      + '<b>保存后无法回显</b> —— 给已有服务重新配置时，留空会把它已存的配置清掉，界面会先确认。</div>';
  }
  html += '<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>名称</th><th>传输</th><th>状态</th><th>健康</th><th>详情</th><th></th></tr></thead><tbody>';
  for (const m of mcp) {
    const hb = m.health === 'ok' ? '<span class="badge ok">ok</span>' : m.health === 'error' ? '<span class="badge fail">error</span>' : '<span class="badge dim">unknown</span>';
    html += '<tr><td class="mono">' + esc(m.name) + '</td><td>' + esc(m.transport) + '</td>'
      + '<td>' + (m.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge dim">停用</span>') + '</td>'
      + '<td>' + hb + '</td>'
      + '<td class="muted">' + esc(m.healthDetail || '—') + '</td>'
      + '<td><button ' + act('probeMcp', esc(m.name)) + '>立即探测</button> '
      + '<button ' + act('setMcpEnabled', esc(m.name), m.enabled ? 'false' : 'true') + '>'
      + (m.enabled ? '停用' : '启用') + '</button> '
      + (canMcpWrite ? '<button ' + act('editMcpConfig', esc(m.name), esc(m.transport)) + '>改配置</button> ' : '')
      + '<button ' + act('removeMcpServer', esc(m.name)) + '>注销</button></td></tr>';
  }
  if (!mcp.length) html += '<tr><td colspan="6" class="muted">还没有登记 MCP 服务 —— 状态列是真实探测结果（TCP 连接 / 命令验证），探测不了会明确报错。</td></tr>';
  html += '</tbody></table></div></div>';

  // ── 工具段：整块删除（0.21.10）────────────────────────────────────────
  //
  // 这里从前是一张「工具」表，两个来源合并（登记表 `registryTools` + 内核探测
  // `kernel.tools`），含来源列、登记/探测双列、差距行、"已被可见性闸住"徽标，
  // 每行一颗"停用/启用"按钮，空表时用 `toolsNote` 说明为什么空。
  //
  // 删掉的理由（用户裁定 2026-10-08）：
  //   「工具是在内核自己调用，不用单独写这个能力，而且不会单独列出来有哪些工具」
  // 三条事实：平台侧没有工具执行路径、上游没有工具清单 RPC（候选探测全部 404）、
  // 因此"有哪些工具"这个问题本身不存在。
  //
  // ⚠️ 删掉的是**清单**，不是"工具调用"这件事本身：
  //    某轮真的调了什么活在会话事件流里，在工作台的**轨迹**选项卡里照常显示工具卡。
  //    这一页从前想做的是"拿事件流里的调用去和登记表对账" —— 那个对账的**一端**
  //    （登记表）没有了，所以整件事不成立，不是"界面少了一块"。
  //    两边是两回事：这一页是"企业登记了什么"，工作台轨迹是"这一轮跑了什么"。

  // 插件独立成段（0.20.0 试用反馈：与工具分开，不再埋在工具表下面）。
  // ⚠️ 0.21.10：数据源是 `kernel.plugins` —— 它本来就只该报插件。
  //    从前这一段读的是 `kernel.tools` 里的 `plugins` 字段（因为那条路是个叫
  //    `listTools()` 的方法在报插件），工具段一删，这里直接读自己的字段名。
  //    插件与工具**不是一回事**：插件是装进来的扩展包（上游 `pluginInventory/list`
  //    是真实 RPC，实测 200），工具是内核在回合内的一次调用。
  //    所以删工具段**不该**把插件段带走 —— 删的是"工具清单"，不是"所有跟工具有关的东西"。
  const kernTools = State.capSkills.kernel || {};
  if (kernTools.pluginCount != null) {
    html += '<div class="panel"><h2>插件（上游插件目录：本机 ' + esc(kernTools.pluginCount) + ' 个条目'
      + ((kernTools.plugins || []).length ? '，其中启用 ' + esc(kernTools.plugins.length) + ' 个' : '') + '）</h2>';
    if ((kernTools.plugins || []).length) {
      html += '<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>启用插件</th><th>模块</th></tr></thead><tbody>';
      for (const p of kernTools.plugins) {
        html += '<tr><td class="mono">' + esc(p.title || p.entryId) + '</td><td class="mono faint">' + esc(p.moduleName || '—') + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    html += '</div>';
  }
  return html;
}

function pageCapSources() {
  const reg = State.capSkills ? (State.capSkills.registry || []) : [];
  const bySource = {};
  for (const s of reg) (bySource[s.source] = bySource[s.source] || []).push(s);
  let html = '<div class="panel"><h2>Skill 来源分组</h2>';
  const srcLabel = { zip: 'ZIP 包安装（内容随平台，可重打包导出）', local: '本机目录引用（内容不随导出）', market: '市场（暂未提供）', import: '清单导入（无内容，需重新提供）' };
  for (const src of Object.keys(bySource).sort()) {
    html += '<h3>' + esc(srcLabel[src] || src) + '（' + bySource[src].length + '）</h3><div class="row">'
      + bySource[src].map((s) => '<span class="badge ' + (s.enabled ? 'ok' : 'dim') + '">' + esc(s.name) + '</span>').join(' ')
      + '</div>';
  }
  if (!reg.length) html += '<div class="muted">还没有登记任何 Skill。</div>';
  html += '<div class="note">当前「市场」即本页：来源只有本机安装、ZIP 上传与清单导入；'
    + '可浏览、可搜索、带签名校验的外部市场暂未提供。</div></div>';

  // ── 工具来源分组：整块删除（0.21.10）────────────────────────────────────
  // 这一整段（`registryTools` 按 `origin` 分组，内置 / MCP / 技能三类）随工具登记表
  // 一起删除。它存在的唯一理由是回答"这个工具从哪来" —— 而"有哪些工具"这个问题
  // 本身已经不成立了（见上面能力清单页那段注释）。

  html += '<div class="panel"><h2>导出（脱敏）</h2>'
    + '<p class="faint">导出能力清单为 JSON：Skill 内容（zip 来源）重打包随行；绑定原样；'
    + '<b>MCP 连接配置绝不导出</b> —— 那是密钥，跨部署带走等于泄露。</p>'
    // ⚠️ 0.21.10：这句里原来的"工具与绑定原样"去掉了"工具"。
    //    导出的东西必须都能导回来 —— 已经没有工具这一节可导了。
    + '<button class="primary" ' + act('exportCaps') + (State.busy ? ' disabled' : '') + '>导出并下载 JSON</button></div>';

  html += '<div class="panel"><h2>导入</h2>'
    + '<p class="faint">粘贴另一套部署导出的 JSON。upsert 语义：同名覆盖；导入的 MCP 没有连接配置，需要重新配置后才能探测。</p>'
    // ⚠️ 向后兼容（0.21.10）：旧版本的导出包里有 `tools` 段，导入时会被**静默忽略**
    //    （见 app/http/routes/capability.mjs 的导入处理器）。这里如实说明一句，
    //    否则拿旧包导入的人会以为"工具没导进来"是坏了。
    + '<p class="faint">旧版本导出包里若含 <code>tools</code> 段：会被忽略（工具已不是可导入的能力），其余照常导入。</p>'
    // 0.21.10：这里原来写的是内联 style（`style="width:100%;font-family:monospace"`）与
    // 下面那行的 `style="margin-top:8px"`。内联样式有一份**冻结计数**（见 §7.6 与
    // test-frontend 的护栏），每加一处都会让"将来收紧 style-src"更难 —— 而这两处
    // 全是纯布局，早就有现成的类（`.mono-block` 的宽度语义 + `.mt-8`）。
    // 换成类之后内联计数**只减不增**，是这次顺手的净收益。
    + '<textarea id="import-json" class="import-box" rows="8" placeholder=\'{"format":"sti-harness/capabilities", ...}\'></textarea>'
    + '<div class="row mt-8"><button class="primary" ' + act('importCaps') + (State.busy ? ' disabled' : '') + '>导入</button></div></div>';
  return html;
}

function pageCapPolicies() {
  if (!State.capPolicies) return loadingOrError();
  const b = State.capPolicies.bindings || [];
  const st = State.capPolicies.stats || {};
  let html = '<div class="panel"><h2>可见性绑定（' + b.length + ' 条；deny ' + (st.bindingsDeny || 0) + ' 条）</h2>';
  html += '<div class="table-wrap"><table><thead><tr><th>主体</th><th>层级</th><th>能力</th><th>判定</th><th></th></tr></thead><tbody>';
  for (const x of b) {
    const subj = x.subject_type === 'tenant' ? '整个组织' : (x.subject_type === 'user' ? '用户 ' + x.subject_id : '角色 ' + x.subject_id);
    html += '<tr><td>' + esc(subj) + '</td>'
      + '<td>' + esc({ connection: '连接', server: '服务', skill: 'Skill' }[x.capability_type] || x.capability_type) + '</td>'
      + '<td class="mono">' + esc(x.capability_id) + '</td>'
      + '<td>' + (Number(x.allow) === 0 ? '<span class="badge fail">deny</span>' : '<span class="badge ok">allow</span>') + '</td>'
      + '<td>'
      + (allowed('capability', 'write')
        ? '<button ' + act('toggleBinding', esc(x.id), Number(x.allow) === 0 ? '0' : '1') + '>'
          + (Number(x.allow) === 0 ? '改为放行' : '改为拦截') + '</button> '
        : '')
      + '<button ' + act('removeBinding', esc(x.id)) + '>删除</button></td></tr>';
  }
  if (!b.length) html += '<tr><td colspan="5" class="muted">还没有绑定 —— 所有能力按登记开关与默认放行运作（拦截必须是显式动作，不搞默认封锁）。</td></tr>';
  html += '</tbody></table></div>';
  html += '<h3 style="margin-top:14px">新增 / 覆盖绑定</h3><div class="row">'
    + '<select id="bind-subjecttype"><option value="tenant">整个组织</option><option value="user">按用户</option><option value="role">按角色</option></select>'
    + '<input id="bind-subjectid" placeholder="主体 id（组织级留空）" style="width:150px">'
    // ⚠️ 0.21.10：下拉里的 `tool` 选项删除（工具不再是一级可治理对象）。
    //    Skill 在前 —— 现在它是最常用的那一项，也是这道闸唯一服务的能力本身。
    + '<select id="bind-captype"><option value="skill">Skill</option><option value="server">MCP 服务</option><option value="connection">连接</option></select>'
    + '<input id="bind-capid" placeholder="能力名（如 rec-record）" style="width:170px">'
    + '<select id="bind-allow"><option value="0">deny（不可见且不可执行）</option><option value="1">allow（显式放行）</option></select>'
    + '<button class="primary" ' + act('setBinding') + (State.busy ? ' disabled' : '') + '>保存</button>'
    + '</div>';
  html += '<details style="margin-top:8px"><summary class="faint">判定顺序与生效范围</summary>'
    + '<div class="note">判定顺序：<b>deny 永远赢</b>（任一层 deny 即不可见）→ 登记开关（enabled=0）→ 默认放行。'
    + '生效范围：清单（契约层 listSkills / listMcpServers 立即消失）。'
    + '契约层用保守并集：任一租户/用户/角色收紧即对内核生效 —— 先挡住，不做精确到人的放行。</div></details></div>';
  return html;
}

/* ── 备份与恢复（P0-D 补页：/api/operation/backup* 此前没有 UI）──────── */

function fmtBytes(n) {
  if (n == null) return '—';
  const b = Number(n);
  if (!Number.isFinite(b)) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

function pageBackup() {
  if (!allowed('operation', 'read')) {
    return '<div class="panel"><h2>备份与恢复</h2><div class="muted">当前账号没有 operation:read 权限，看不到本页。</div></div>';
  }
  const canWrite = allowed('operation', 'write');
  const canDelete = allowed('operation', 'delete');
  let html = '<div class="panel"><h2>创建备份</h2>';
  html += '<div class="faint">备份 = 一个 ZIP：<code>sti-harness.db</code>（VACUUM INTO 在线一致性快照）'
    + ' + <code>storage/</code> 全量文件 + <code>manifest.json</code>（逐文件 SHA256，校验的唯一真相源）。</div>';
  html += '<div class="row" style="margin-top:10px">'
    + '<button class="primary" ' + act('createBackup') + (State.busy || !canWrite ? ' disabled' : '') + '>立即创建备份</button>';
  if (!canWrite) html += ' <span class="badge dim" title="缺少 operation:write">只读</span>';
  html += '<button ' + act('loadBackup') + '>刷新列表</button></div>';

  if (State.backupResult) {
    const r = State.backupResult;
    const mf = r.manifest || {};
    const storageCount = (mf.storage && mf.storage.fileCount != null) ? mf.storage.fileCount : '—';
    html += '<div class="note" style="margin-top:10px">已创建 <b class="mono">' + esc(r.file) + '</b>（' + fmtBytes(r.bytes) + '）'
      + '<div class="faint">平台版本 ' + esc(mf.platformVersion || '—')
      + ' · 存储文件 ' + esc(storageCount) + ' 个 · 创建于 '
      + esc(String(mf.createdAt || '').replace('T', ' ').slice(0, 19)) + '</div>'
      + (r.note ? '<div class="faint">' + esc(r.note) + '</div>' : '')
      + '</div>';
  }
  html += '<div class="note">⚠️ 主密钥 <code>data/.secret</code> <b>不进备份包</b>（进了包就等于凭据明文搬家），'
    + '必须单独保管；丢了它，备份里的密文凭据谁也无法解密。</div></div>';

  html += '<div class="panel"><h2>已存在的备份</h2>';
  if (!State.backupList) {
    html += '<div class="muted">正在读取备份目录…</div></div>';
    return html;
  }
  const items = State.backupList.items || [];
  if (items.length) {
    html += '<div class="table-wrap"><table><thead><tr><th>文件</th><th>大小</th><th>修改时间</th><th></th></tr></thead><tbody>';
    for (const b of items) {
      html += '<tr><td class="mono">' + esc(b.file) + '</td>'
        + '<td class="mono">' + fmtBytes(b.bytes) + '</td>'
        + '<td class="mono">' + esc(String(b.mtime || '').replace('T', ' ').slice(0, 19)) + '</td>'
        + '<td><button ' + act('verifyBackup', esc(b.file)) + '>校验</button>'
        + (canDelete ? ' <button class="danger" ' + act('deleteBackup', b.file) + '>删除</button>' : '')
        + '</td></tr>';
    }
    html += '</tbody></table></div>';
    if (canDelete) {
      html += '<div class="faint">删除只对本平台产出的 <code>backup-*.zip</code> 生效（目录内其它文件一律不动），'
        + '且<b>绝不删最后一份</b>；带同名一次性密钥（<code>.key</code>）的备份会连侧车一并删除。不可逆，没有回收站。</div>';
    }
  } else {
    html += '<div class="muted">' + esc(State.backupList.note || '还没有备份文件。') + '</div>';
  }
  html += '<div class="faint">备份目录：<code class="mono">' + esc(State.backupList.dir || '—') + '</code></div>';

  html += '<h3 style="margin-top:14px">校验任意备份文件</h3><div class="row">'
    + '<input id="bk-file" placeholder="backups 目录下的文件名，如 backup-2026-...zip" style="width:320px">'
    + '<button ' + act('verifyBackup') + '>校验</button></div>';
  if (State.backupVerify) {
    const v = State.backupVerify;
    html += '<div class="note ' + (v.ok ? '' : 'fail') + '">校验' + (v.ok ? '通过' : '未通过')
      + '：检查 ' + esc(fmtN(v.checked)) + ' 个条目'
      + (v.problems && v.problems.length
        ? '<ul>' + v.problems.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>' : '')
      + '</div>';
  }
  html += '<div class="note">恢复<b>不做在线接口</b>：服务进程握着打开的数据库句柄，运行中换库不是"危险"两个字能概括的。'
    + '恢复是离线维护动作 —— 停机后执行 <code>node tools/restore-backup.mjs &lt;备份包&gt; --dest &lt;数据目录&gt;</code>，'
    + '它会先校验再落盘，恢复后立即跑 <code>integrity_check</code> 自证。</div></div>';
  return html;
}

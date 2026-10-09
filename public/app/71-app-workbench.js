/* STI HARNESS 前端 · App 对象：对话工作台动作层
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 *
 * 为什么单独成片：工作台是 `App` 里最大且最独立的一块（会话选择 / 附件 / 流式回合 /
 * 引用回溯），与"列表页动作"没有共享状态。它挂在 `App` 上而不是自成命名空间，
 * 是因为 `40-delegate.js` 的事件委托与页面渲染都按 `App.<action>` 取函数 ——
 * 换命名空间等于把"哪个动作在哪"这件事散到三处。
 */
'use strict';

/* 归并进同一个 App 对象：本片由 index.html 排在 70-app.js 之后加载，
   所以这里的 `App` 一定已经存在。 */
Object.assign(App, {
  /* ── 对话工作台（P0-B）── */
  //
  // 惰性加载：只在"没加载过"时发请求。render() 会调它，所以它自带
  // loaded/loading 双闸 —— 否则 render→加载→render 会形成死循环。
  async wbEnsureLoaded(force) {
    const w = State.wb;
    if (w.loading) return;
    if (w.loaded && !force) return;
    w.loading = true;
    try {
      const ss = await api('/api/kernel/sessions?limit=50').catch((e) => ({ __err: e }));
      const mc = await api('/api/kernel/models').catch((e) => ({ __err: e }));
      if (ss && ss.__err) { w.error = '读取会话列表失败：' + ss.__err.message; w.sessions = []; }
      else { w.error = ''; w.sessions = ss.items || []; }

      const models = [];
      if (mc && mc.catalog && Array.isArray(mc.catalog.groups)) {
        for (const g of mc.catalog.groups) {
          // ⚠️ 分组里标识供应商的键是 **`id`**，`provider` 不一定有（上游 0.2.0-rc.2 实测只有 id）。
          //    0.21.9 之前这里只读 `g.provider`，于是 value 拼成了 `|deepseek-flash` ——
          //    provider 段是空串，选模型时上游收到 `provider: null`，被边界校验拒掉，
          //    而那句错误只说 `wire field "request" failed boundary validation`。
          //    表现就是：**新建会话必报 500**（建会话时会把选择器的值一起提交）+ 每次
          //    打开会话都刷一串 500（0.21.7 起会为未绑定的会话补绑一次模型）。
          const prov = g.provider || g.id || '';
          for (const m of (g.models || [])) {
            models.push({
              provider: prov || null,
              id: m.id,
              value: prov + '|' + m.id,
              // catalog 分组没带 provider 时只显示模型名 —— 不拼「（未知来源）」这种
              // 听起来像产品缺陷的词（0.20.0 试用反馈：它和「未登记模型」是同一个观感问题）。
              label: prov ? (m.label || m.id) + '（' + prov + '）' : (m.label || m.id),
              // 推理等级（0.21.0）：模型目录报告了 reasoning.efforts 才有 —— 前端不发明档位。
              efforts: (m.reasoning && Array.isArray(m.reasoning.efforts)) ? m.reasoning.efforts : [],
              defaultEffort: (m.reasoning && m.reasoning.defaultEffort) || '',
            });
          }
        }
      }
      w.models = models;
      if (!w.modelValue && models.length) w.modelValue = models[0].value;
      // 推理等级跟随模型：模型换了，旧档位可能不属于新模型 —— 回到它的默认档。
      const cur = models.find((x) => x.value === w.modelValue);
      if (cur && cur.efforts.length && !cur.efforts.some((e) => e.id === w.effort)) {
        w.effort = cur.defaultEffort || (cur.efforts[0] ? cur.efforts[0].id : '');
      }

      // 工作区树（0.21.0）：纯组织容器 —— 0.21.6 起服务端不再下发档位 / 授权名单 /
      // 可见性（那套已随"工作区权限"模块一起删除，理由见 app/platform/workspace/
      // visibility.mjs 头注释）。前端也就不该有东西可渲染它。
      try {
        const ws = await api('/api/workspaces');
        w.workspaces = ws.items || [];
        // 兜底工作区的 id（服务端下发的那一个，前端不自己按 `isDefault` 再找一遍 ——
        // 两处会漂，而"会话该落到哪个工作区"只有一个答案）。
        w.defaultWorkspaceId = ws.defaultWorkspaceId || '';
        w.wsError = '';
        // 0.21.2：**首次**加载且用户没选过时，默认落进第一个工作区 ——
        // 初始化向导刚建了「默认工作区」，新会话就该进那里（与原生 Harness 一致）。
        // 只在首次加载做：用户此后明确选了某个工作区，强刷列表也不夺走他的选择。
        // （0.21.9：这里的"第一个"改成**兜底工作区优先** —— 列表按 updated_at 排序，
        //  能改动的工作区（改 cwd 之类）会把它顶下去，于是"新会话默认落在哪"
        //  会随一次无关的改动而变。找不到兜底时才退回第一个。）
        if (!w.wsLoaded && w.wsActiveId == null && (w.workspaces || []).length) {
          const def = (w.workspaces || []).find((x) => x.isDefault);
          w.wsActiveId = (def || w.workspaces[0]).id;
        }
        // 兜底再兜一层：选中的那个工作区可能已被删除（或此刻列表为空又被补上），
        // 而 `wsActiveId` 是个跨渲染存活的旧值 —— 它指向一个不存在的 id 时，
        // 新建会话会被服务端按"工作区不存在"拒掉。这里就地归位。
        if (w.wsActiveId && !(w.workspaces || []).some((x) => x.id === w.wsActiveId)) {
          const def = (w.workspaces || []).find((x) => x.isDefault);
          w.wsActiveId = def ? def.id : ((w.workspaces || [])[0] || {}).id || null;
        }
      } catch (e) {
        w.workspaces = []; w.defaultWorkspaceId = '';
        w.wsError = '读取工作区失败：' + e.message;
      }
      w.wsLoaded = true;

      // 0.21.9：模式清单（0.21.0 起拉 `/api/kernel/presets`）**不再拉** —— 模式整块从界面
      // 拿掉了（用户裁定）。端点本身还在（服务端能力没减），只是前端不再需要它。

      // 可见知识库（0.14.0）：工作台的「知识库」条要用它。
      // 权限不足时**不发请求也不报错** —— 如实留空，那条 UI 整体不显示
      // （与附件、产物同一个做法：没有能力就不显示入口，而不是显示一个点了会 403 的按钮）。
      if (allowed('knowledge', 'read')) {
        try {
          const kb = await api('/api/knowledge/bases');
          // ⚠️ 服务端返回的已经是**经库级 ACL 过滤**的可见库，前端**不再自己过滤一遍** ——
          // 那会变成第二个真相（前端按 visibility 猜、服务端按授权判），
          // 而用户只会看到其中一个。这里只负责显示"服务端说你能看见哪些"。
          w.kbList = (kb && kb.bases) || [];
          w.kbError = '';
        } catch (e) {
          w.kbList = [];
          w.kbError = '读取可见知识库失败：' + e.message;
        }
        w.kbLoaded = true;
      }

      // MCP 清单：右栏「可用能力」面板里 MCP 那一段的数据源。
      // 按 mcp:read 权限拉；没权限就如实不显示（与知识库条同一纪律：
      // 不显示入口，而不是点了 403）。
      //
      // ⚠️ 0.21.10：这里从前还有一次 `GET /api/capability/skills`（存进 `w.caps`）。
      //    它当时是**仅为工具卡的来源对账**而拉的 —— 0.21.7 右栏「可用能力」面板
      //    被删时，就是因为"工具卡来源徽标还要用它"才把这行留了下来。
      //    现在对账整块删除（工具登记表已不存在），`w.caps` 一个读者都没有了，
      //    所以这次请求也去掉：一次没有任何消费者的 HTTP 往返，只会让
      //    "能力清单在哪儿被用到"这件事更难查（而且它跑在每次进工作台的路径上）。
      //    ⚠️ 注意与 `State.capSkills` 区分：那是**能力清单页**自己的加载，
      //       页面照常工作，不受这里影响。
      if (allowed('mcp', 'read')) {
        try { w.capsMcp = await api('/api/capability/mcp'); }
        catch (e) { w.capsMcp = null; if (!w.capsError) w.capsError = '读取 MCP 清单失败：' + e.message; }
      }
      w.capsLoaded = true;

      // 没选中会话时默认打开最近一个，且把它的历史回放出来（否则右侧上下文是空的）
      if (!w.sessionId && w.sessions.length) {
        w.sessionId = w.sessions[0].id;
        await App.wbLoadHistory();
        // 还要拉一次会话详情（用量 / **已归因的模型**）。
        // 少了这一句，首次打开时"已归因模型"徽标恒显示成"模型未归因" ——
        // 而用户看到的是一句关于成本归因的**错误**结论（他会以为这轮用量不会被计到模型上）。
        await App.wbRefreshContext();
        await App.wbLoadAttachments();
      }
    } catch (e) {
      w.error = '工作台数据加载失败：' + e.message;
    }
    w.loading = false;
    w.loaded = true;
    // `ready` 只在**第一次**跑完时置位（0.21.9）：它说的是"这一屏至少拿到过一次数据"，
    // 用来把"刷新时先画出来的那个假状态"挡掉（见 84-workbench.js 的中间态说明）。
    // `wbInvalidate()` 会把 `loaded` 置回 false（知识库增删后要重拉），但**不动 ready** ——
    // 那时界面上已经有上一份数据，整块退回"加载中"才是新的闪烁。
    w.ready = true;
    render();
  },

  /**
   * 工作台缓存置脏（0.14.0 补）：知识库页的建库 / 删库 / 改名 / 授权 / 撤权
   * 都会改变"这个用户在工作台上能挂哪些库"。调用方在**成功回调**里调它，
   * 用户切回工作台时 wbEnsureLoaded 会整体重拉。
   *
   * 不这么做的话（真机实测抓到）：建完库回到工作台，知识库条仍显示
   * "当前账号没有可见的知识库" —— 服务端明明返回了新库，前端 `w.loaded`
   * 单次闸门把重拉挡掉了。用户只能靠猜"点一下刷新"自救。
   *
   * 流式进行中不置脏：此刻重拉会与正在接收的帧互相踩（消息区被整体重绘）。
   */
  wbInvalidate() {
    const w = State.wb;
    if (w && !w.streaming) w.loaded = false;
  },

  async wbNewSession() {
    if (State.wb.streaming) return;
    // 新会话默认**沿用当前会话的挂载**（用户上一轮挂了手册库，开新对话八成还是要用它）；
    // 只有当用户在没有会话时明确勾选过（`kbPicked` 非空）才以勾选为准。
    const kbForNew = (State.wb.kbPicked && State.wb.kbPicked.length)
      ? State.wb.kbPicked.slice()
      : (State.wb.kbMounted || []).slice();
    const w = State.wb;
    // 新建时把工作区 / 模型 / 推理等级**一并提交**（0.21.0）——
    // 模型与等级虽可后改，但一次提交能让"新建即归因"，不会出现半截状态。
    // ⚠️ 0.21.9：`presetId` 不再提交 —— 模式从界面拿掉之后，前端没有一个"用户选了什么"可提交。
    //    服务端仍接受这个字段（缺省即 null），请求体的形状因此**更窄**、不是换了个形状。
    const modelParts = (w.modelValue || '').split('|');
    const body = {
      title: '对话 ' + new Date().toLocaleString('zh-CN'),
      kbIds: kbForNew,
      // 0.21.9：三级兜底 — 树上选中的 → 服务端给的兜底工作区 → null。
      // 最后那层只是"服务端会自己决定"，不是一条正常路径：新会话总要落进一个工作区
      // （未分组已经删了）。真走到 null，服务端也会把它放进兜底工作区。
      workspaceId: w.wsActiveId || w.defaultWorkspaceId || null,
      reasoningEffort: w.effort || null,
    };
    if (modelParts[1]) { body.model = modelParts[1]; body.provider = modelParts[0] || null; }
    try {
      const r = await api('/api/kernel/sessions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      State.wb.sessionId = r.session.id;
      // 服务端回显的就是真相（工作区档位不足会被拒、模型可能没登记上）。
      State.wb.kbMounted = Array.isArray(r.session.kbIds) ? r.session.kbIds.slice() : [];
      State.wb.wsActiveId = r.session.workspaceId || null;
      // 0.21.9：`presetRecorded` 不再回填（那个字段随模式一起删了）—— 服务端回执里的
      // `presetId` 仍照实收下，只是界面不再显示它。
      if (r.session.reasoningEffort) State.wb.effort = r.session.reasoningEffort;
      State.wb.msgs = [];
      State.wb.usage = null;
      State.wb.artifacts = null;
      State.wb.error = '';
      State.wb.kbError = '';
      App.wbFocusChat();   // 新会话 = 看它自己的对话
      State.wb.notice = '已新建会话；直接在下面提问即可。'
        + (State.wb.kbMounted.length ? '（已挂载 ' + State.wb.kbMounted.length + ' 个知识库，提问时会先检索）' : '')
        + (State.wb.wsActiveId ? '（工作区：' + ((State.wb.workspaces || []).find((x) => x.id === State.wb.wsActiveId) || { name: State.wb.wsActiveId }).name + '）' : '');
      App.wbResetPickers();
      await App.wbEnsureLoaded(true);
      await App.wbRefreshContext();
      await App.wbLoadAttachments();
    } catch (e) {
      State.wb.error = '新建会话失败：' + e.message;
    }
    render();
  },

  async wbPickSession(id) {
    if (State.wb.streaming) return;
    App.wbCloseRowMenu();
    State.wb.sessionId = id;
    State.wb.msgs = [];
    State.wb.usage = null;
    State.wb.error = '';
    State.wb.notice = '';
    App.wbFocusChat();   // 换会话 = 看这个会话的对话（上一个会话停在「轨迹」不算数）
    App.wbResetPickers();
    render();
    await App.wbLoadHistory();
    await App.wbRefreshContext();
    await App.wbLoadAttachments();
  },

  /**
   * 会话改名：PATCH 接口 + session:write 门槛 —— 在哪儿对话就在哪儿管会话。
   *
   * 走 Dlg.prompt 而不是原生 prompt：对话框是渲染出来的，取消与"提交空值"必须分得开；
   * 成功之后就重拉列表 —— 显示的新标题只能来自服务端回执，不做本地乐观改名。
   */
  async wbRenameSession(id, title) {
    const w = State.wb;
    if (w.streaming) return;
    App.wbCloseRowMenu();
    const next = await Dlg.prompt({
      title: '重命名会话',
      label: '新标题',
      value: title || '',
      maxlength: 200,
      required: true,
    });
    if (next == null || next === title) { render(); return; }
    try {
      await api('/api/kernel/sessions/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: JSON.stringify({ title: next }),
      });
      w.error = '';
      w.notice = '会话已改名为「' + next + '」。';
      await App.wbEnsureLoaded(true);
    } catch (e) {
      w.error = '重命名失败：' + e.message;
      render();
    }
  },

  /**
   * 删除会话：真删（平台侧事件 / 附件（含落盘字节）/ 产物记录 / 会话行一并清除；
   * 用量台账保留、上游内核侧不动）。
   *
   * 删的若是当前会话：清空会话级状态后交给 wbEnsureLoaded(true) 重拉 ——
   * 它会把最近一个自动打开（与"首次进入工作台"同一条路），
   * 而不是留一个已死的会话继续显示。
   */
  async wbDeleteSession(id, title) {
    const w = State.wb;
    if (w.streaming) return;
    App.wbCloseRowMenu();
    if (!await Dlg.confirm({
      title: '删除会话',
      body: ['删除「' + (title || id) + '」？这是真删，不可恢复：',
        '· 平台侧事件、附件（含落盘字节）、产物记录、会话行一并清除；',
        '· 用量台账保留 —— 配额核算和审计依据不受影响；',
        '· 上游内核侧的会话不在此删除。'],
      ok: '删除', danger: true,
    })) return;
    try {
      const r = await api('/api/kernel/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
      if (State.wb.sessionId === id) {
        State.wb.sessionId = null;
        State.wb.msgs = [];
        State.wb.usage = null;
        State.wb.artifacts = null;
        State.wb.modelRecorded = '';
        State.wb.modelRecordedProvider = '';
        State.wb.kbMounted = [];
        App.wbResetPickers();
      }
      const c = r.cascaded || {};
      const n = (v) => (v != null ? String(v) : '—');
      w.error = '';
      w.notice = '会话已删除：事件 ' + n(c.events) + ' 条、附件 ' + n(c.attachments)
        + ' 个（字节 ' + n(r.bytesDeleted) + '）、产物记录 ' + n(c.artifacts)
        + ' 条；用量台账保留。';
      await App.wbEnsureLoaded(true);
    } catch (e) {
      w.error = '删除会话失败：' + e.message;
      render();
    }
  },

  /**
   * 导出会话（md / json）：走服务端的转录接口，浏览器直接落盘。
   *
   * ⚠️ 界面上的名字是**「导出会话」**（0.21.9，用户裁定）—— 此前叫「导出转录」。
   *    "转录"是服务端**怎么生成这份文件**的说法（按轮重建"谁说了什么"、剥掉注入段），
   *    不是用户想要的**东西**；用户点这一项时想的是"把这次对话带走"。
   *    口径与全站一致：对外说的是用户拿到的那个东西，实现细节留在注释与文档里。
   *
   * 为什么不是原样转储事件：事件流里混着注入段、推理片段、工具入参原文；
   * 面向"把这次对话带走"的诉求，服务端把注入段剥出并注明、按发言人分节。
   * 要全量原始轨迹（含附件字节）的是另一个能力：「治理 → 会话日志」的 log.zip。
   *
   * 走 Dlg.pick 单选而不是并排两个按钮：两个格式各有一句说明（人读 / 机读），
   * 弹层里放得下，按钮上写不下。取消（null）什么都不做 —— 不能把"取消"当成"默认格式"。
   */
  async wbExportSession(id, title) {
    const w = State.wb;
    if (w.streaming) return;
    App.wbCloseRowMenu();
    const fmt = await Dlg.pick({
      title: '导出会话',
      label: '导出格式',
      body: '把「' + (title || id) + '」这次对话导出为文件：',
      options: [
        { value: 'md', label: 'Markdown（.md）', desc: '按「用户 / 助手」分节的文档，适合存档与流转阅读。' },
        { value: 'json', label: 'JSON（.json）', desc: '同一份内容的结构化形态（含工具调用与用量），适合程序处理。' },
      ],
      selected: ['md'],
      ok: '导出',
    });
    if (fmt == null) return;
    try {
      const r = await api('/api/kernel/sessions/' + encodeURIComponent(id) + '/export?format=' + encodeURIComponent(fmt));
      const text = fmt === 'json' ? JSON.stringify(r.content, null, 2) : String(r.content == null ? '' : r.content);
      const blob = new Blob([text], { type: fmt === 'json' ? 'application/json' : 'text/markdown' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.filename || ('session-' + id + (fmt === 'json' ? '.json' : '.md'));
      a.click();
      URL.revokeObjectURL(a.href);
      w.error = '';
      w.notice = '已导出「' + (title || id) + '」：' + fmt + '，' + r.eventCount + ' 条事件'
        + (r.truncated ? '（已达导出上限，只含前 ' + r.eventCount + ' 条 —— 完整轨迹请到「治理 → 会话日志」下载）' : '') + '。';
      render();
    } catch (e) {
      w.error = '导出失败：' + e.message;
      render();
    }
  },

  /**
   * 清掉所有"属于上一个会话"的临时选择（附件勾选 / 检索结果 / 回合 id）。
   *
   * 为什么必须显式清：这三样都是**会话级**状态，切会话时若留在内存里，
   * 下一次发送就会带上前一个会话的附件 id —— 服务端会因租户+会话过滤而拒收一部分，
   * 但"我明明选了它却没进去"这种半成功比直接失败更难查。
   */
  wbResetPickers() {
    const w = State.wb;
    w.attachPicked = [];
    w.attachError = '';
    w.attachmentList = [];
    w.lastTurnId = null;
  },

  /** 拉本会话附件列表（服务端为准，不缓存本地推断） */
  async wbLoadAttachments() {
    const w = State.wb;
    if (!w.sessionId) { w.attachmentList = []; return; }
    try {
      const r = await api('/api/kernel/sessions/' + encodeURIComponent(w.sessionId) + '/attachments');
      w.attachmentList = r.items || [];
      // 勾选里可能有已被删除的 id —— 以服务端列表为准收敛一次
      const alive = new Set(w.attachmentList.map((a) => a.id));
      w.attachPicked = w.attachPicked.filter((id) => alive.has(id));
      w.attachError = '';
    } catch (e) {
      w.attachmentList = [];
      w.attachError = '读取附件列表失败：' + e.message;
    }
  },

  /**
   * 把已落库的事件回放成消息流。
   *
   * 诚实边界：回放的是**本地库里的语义事件**（不是上游回放），因此事件被
   * 归一化时丢掉的细节不会在这里凭空出现。
   */
  async wbLoadHistory() {
    const w = State.wb;
    if (!w.sessionId) return;
    try {
      const r = await api('/api/kernel/sessions/' + encodeURIComponent(w.sessionId) + '/events?limit=2000');
      w.msgs = wbMessagesFromEvents(r.items || []);
    } catch (e) {
      // 读不到历史就保持空 —— 绝不"假装有一轮对话"
    }
    App.wbPaint();
  },

  /** 会话用量 / 产物（按权限逐项获取，无权限就如实不显示） */
  async wbRefreshContext() {
    const w = State.wb;
    if (!w.sessionId) { render(); return; }
    try {
      const d = await api('/api/kernel/sessions/' + encodeURIComponent(w.sessionId));
      w.usage = d.usage || null;
      // 服务端登记在会话上的模型（P1-3）——它是用量归因的依据，必须如实呈现。
      const s = (d && d.session) || {};
      w.modelRecorded = s.modelId || '';
      w.modelRecordedProvider = s.modelProvider || '';
      // 0.19.0 模型区整合：服务端记下的模型在目录里**找得到**时，下拉同步指过去 —
      // 「你选了什么」与「服务端记下了什么」不再各说各话（此前下拉停在旧选项上，
      // 徽标却说登记的是另一个，看起来像登记没生效）。找不到（目录缺该模型、
      // 或目录还没加载）时**不强选** —— 不伪造一个不存在的选项，徽标仍如实显示。
      if (w.modelRecorded && (w.models || []).length) {
        const hit = w.models.find((m) => m.id === w.modelRecorded
          && (!w.modelRecordedProvider || m.provider === w.modelRecordedProvider));
        if (hit) w.modelValue = hit.value;
      }
      // 0.21.7：会话**没有**绑模型时，按选择器当前值补绑一次。
      //
      // 为什么必须补：发回合的请求体里**不带模型**（只有 content + attachmentIds），
      // 用量归因取的是 `agent_sessions.model_id`（见 kernel.mjs 里 runTurn 的注释）。
      // 也就是说"选择器显示什么"与"会话绑了什么"一旦不一致，用户看到的模型就**不是**
      // 真正在用的那个 —— 而那正是"模型未归因"那颗徽标想解释、却解释不动的东西。
      // 补绑之后两者恒等：选择器是会话的绑定项，不需要第三个概念。
      //
      // 静默失败是有意的：只有 session:read 的角色在这里会 403，那不是错误状态，
      // 是"这个账号本来就没有登记模型的权限"—— 弹一个红条反而是噪音。
      if (!w.modelRecorded && w.modelValue && w.sessionId) {
        const parts = String(w.modelValue).split('|');
        if (parts[1]) {
          try {
            const rec = await api('/api/kernel/sessions/' + encodeURIComponent(w.sessionId) + '/model', {
              method: 'POST',
              body: JSON.stringify({
                provider: parts[0] || null, model: parts[1], reasoningEffort: w.effort || null,
              }),
            });
            w.modelRecorded = (rec.recorded && rec.recorded.modelId) || parts[1];
            w.modelRecordedProvider = (rec.recorded && rec.recorded.modelProvider) || '';
          } catch (e) { /* 无权限 / 会话已删 —— 保持未绑定，不打扰用户 */ }
        }
      }
      // 挂载的知识库（0.14.0）：切会话时必须一起刷新 —— 否则会把上一个会话的
      // 挂载状态带到这个会话上显示，用户看到的"已挂 2 个"是别人的事实。
      w.kbMounted = Array.isArray(s.kbIds) ? s.kbIds.slice() : [];
      // 工作区 / 推理等级（0.21.0）：切会话同步 —— 选择器条显示的是
      // **这个会话**的事实（在哪个工作区、什么等级），不是上一个会话的。
      // ⚠️ 0.21.9：模式不在这一列了（界面上没有它了）。
      w.wsActiveId = s.workspaceId || null;
      if (s.reasoningEffort) w.effort = s.reasoningEffort;
    } catch (e) {
      w.usage = null; w.modelRecorded = ''; w.modelRecordedProvider = ''; w.kbMounted = [];
    }
    if (allowed('artifact', 'read')) {
      try { w.artifacts = await api('/api/governance/artifacts?sessionId=' + encodeURIComponent(w.sessionId)); }
      catch (e) { w.artifacts = null; }
    }
    render();
  },

  /* ── 会话挂载知识库（0.14.0）──────────────────────────────
   *
   * 两种模式，判据只有一个：**当前有没有会话**。
   *   · 没会话 → 只改本地 `kbPicked`，等「＋ 新对话」时一并提交（此时还没有会话行可改）；
   *   · 有会话 → **立即提交**。界面显示"已挂载"就一定是服务端记下了 ——
   *     这与全站"服务端返回什么就显示什么，前端不做乐观补全"是同一条纪律。
   */
  wbToggleKbPanel() {
    State.wb.kbPanelOpen = !State.wb.kbPanelOpen;
    render();
  },

  async wbToggleKb(id) {
    const w = State.wb;
    const key = String(id || '');
    if (!key || w.kbBusy) return;

    if (!w.sessionId) {
      const i = w.kbPicked.indexOf(key);
      if (i >= 0) w.kbPicked.splice(i, 1); else w.kbPicked.push(key);
      render();
      return;
    }

    const next = (w.kbMounted || []).map(String).slice();
    const i = next.indexOf(key);
    if (i >= 0) next.splice(i, 1); else next.push(key);

    w.kbBusy = true; w.kbError = '';
    try {
      const r = await api('/api/kernel/sessions/' + encodeURIComponent(w.sessionId) + '/kb', {
        method: 'POST',
        body: JSON.stringify({ kbIds: next }),
      });
      // 以**服务端回显**为准：它可能丢掉了不可见的库、也可能截断了超量的库。
      w.kbMounted = Array.isArray(r.kbIds) ? r.kbIds.slice() : [];
      w.notice = (r.notes && r.notes.length) ? r.notes.join('；') : (r.effect || '');
    } catch (e) {
      w.kbError = '挂载失败：' + e.message;
    }
    w.kbBusy = false;
    render();
  },

  /**
   * 只重绘消息流容器：不碰输入框（这就是"流式聊天"能用的前提）。
   *
   * ⚠️ 0.21.9 定版：重绘的是**当前选项卡**的内容（对话 或 轨迹）。
   *    轨迹搬回会话框之后，它又成了流式期间的实时内容 —— 工具卡是"边跑边出"的，
   *    不重绘就等于"轨迹停在这一轮开头"。这一点与它在消息流里的那些年没有区别。
   *
   * ⚠️ 0.21.9 修一个**用户报的宽度闪动**（「提交对话的一瞬间会很快变宽，然后又恢复正常」）：
   *    本函数从前写的是 `el.innerHTML = wbViewBodyHtml()` —— **不套 `.wb-stream-inner`**，
   *    而 `render()`（`wbRenderStream` 那一段）套了。于是同一个 `#wb-stream` 在两种写法之间
   *    来回切：
   *      · `render()` 写 → 内容在 `.wb-stream-inner` 里（宽 = min(1200, stream 内容盒)，
   *        「内容盒」已经扣掉了 `.wb-stream` 自己的 `padding: 0 24px`）；
   *      · `wbPaint()` 写 → 内容直接挂 `#wb-stream` 下（宽 = 整个 padding 盒，
   *        **比上面宽 48px**）。
   *    提交一轮的时序恰好把两者压在相邻的两帧上：
   *      `render()` → `wbPaint()`（此刻宽 48px）→ 第一帧回来 `wbPaint()`（还宽 48px）
   *      → 本轮结束 `finally { render() }`（缩回去）。
   *    用户看到的"宽一下又恢复"就是这条 **48px**。`scrollbar-gutter` 治不了它 ——
   *    那不是滚动条引起的，是**两个写入口的公式不同**。
   *
   *    修法不是在 `wbPaint` 里把公式抄一遍（那就是第三份手抄），而是**让两个写入口
   *    产出同一段 HTML**：见 `wbStreamShellHtml`。它现在是这一层的唯一真相源。
   *
   * ⚠️ **滚到底只对「对话」tab 做**。轨迹是"用户自己在翻"的一份记录：
   *    每来一帧就把它滚到底，等于不让人看上面的内容（与消息流必须自动滚到底正好相反）。
   *    两个 tab 共用 `#wb-stream` 这一个滚动容器，所以这个判断必须写在这里。
   *
   * ⚠️ 0.21.9 修第二个滚动缺陷（用户报「每次对话完自动给我滚动到会话最上面去」）：
   *    见 `wbStickToBottom`（84-workbench.js）—— 那里是"滚到底"这件事的**唯一真相源**，
   *    本函数与 `render()` 的工作台分支共用它。
   *    要点：写 `innerHTML` 的同一帧里读 `scrollHeight` 会读到旧/0 的高度
   *    （`scrollTop` 上限 = `scrollHeight - clientHeight`，读到 0 上限就是 0 → 跳顶部），
   *    所以要推迟到重排之后；而**真正**把提交后的画面拽到顶部的是
   *    `render()` 重建 `#wb-stream` 元素本身（新节点 scrollTop 天然是 0）——
   *    那条路径也在 `render()` 里补了滚到底。
   */
  wbPaint() {
    const el = $('#wb-stream');
    if (!el) return;
    el.innerHTML = wbStreamShellHtml();
    // 内容写完了才滚（滚的是刚写完的这个节点，把 `el` 传进去让这件事在代码上看得见）。
    // 「轨迹」页签的例外判据在 `wbStickToBottom` 里，不在这里重复一遍。
    wbStickToBottom(el);
  },

  /** 处理一帧 NDJSON（帧协议见 app/http/stream.mjs 顶部） */
  wbFrame(msg, frame) {
    if (!frame || !frame.kind) return;
    if (frame.kind === 'event') {
      wbApplyEvent(msg, frame.event, State.wb.msgs);
      App.wbPaint();
    } else if (frame.kind === 'turn') {
      // 记下本轮的 turnId —— 「停止」要靠它告诉上游"取消**哪一轮**"。
      // 不带 turnId 的取消只能取消"当前回合"，而上游此刻可能已经在跑下一轮了。
      if (frame.turnId) State.wb.lastTurnId = frame.turnId;
    } else if (frame.kind === 'attachments') {
      // 服务端对"送出了哪些、注入了哪些、跳过了哪些"的回执。没送到**不静默** ——
      // 用户以为把文件给出去了、其实模型没看到，这是最坏的一类误解。
      msg.attach = {
        sent: frame.sent || [],
        injected: frame.attached || [], skipped: frame.skipped || [], missing: frame.missing || [],
      };
      // 同时把**用户气泡上的回执**改成服务端的真实结果。
      // 为什么必须同步：气泡那两行数字在发送前是按附件列表的 delivery 预估的，
      // 而"预算超限""文件读失败"只有服务端知道。若不同步，同一个回合会出现
      // "气泡说 2 张图 / 回执说只送了 1 张"——两个真相，用户不知道该信哪个。
      // 而且回放时气泡数字是**从落库正文里读的**（那正是由同一份 sent/injected 生成），
      // 同步之后"实时"与"回放"渲染出的气泡才逐字一致。
      for (let i = State.wb.msgs.length - 1; i >= 0; i--) {
        if (State.wb.msgs[i].role === 'user') {
          State.wb.msgs[i].attachImages = (frame.sent || []).length;
          State.wb.msgs[i].attachCount = (frame.attached || []).length;
          break;
        }
      }
      if (msg.attach.skipped.length || msg.attach.missing.length) {
        State.wb.notice = '部分附件未提交给模型：'
          + msg.attach.skipped.map((s) => s.name + '（' + s.note + '）').join('；')
          + (msg.attach.missing.length ? '；未找到：' + msg.attach.missing.join(', ') : '');
      }
      App.wbPaint();
    } else if (frame.kind === 'knowledge') {
      // 知识检索回执（0.14.0）。**挂了库就一定会收到这一帧** —— 哪怕命中 0 条、
      // 哪怕检索失败（失败原因在 notes 里）。它同时同步到用户气泡的计数上，
      // 理由与附件回执完全相同：气泡上的数字是发送前按"挂载数"预估的，
      // 而真实命中数只有服务端知道；不同步就会出现"气泡说注入了 3 条、
      // 回执说命中 0 条"两个真相。
      msg.kb = {
        kbIds: frame.kbIds || [],
        usedKbIds: frame.usedKbIds || [],
        hits: frame.hits || [],
        dropped: Number(frame.dropped) || 0,
        elapsedMs: frame.elapsedMs,
        mode: frame.mode || null,
        notes: frame.notes || [],
      };
      for (let i = State.wb.msgs.length - 1; i >= 0; i--) {
        if (State.wb.msgs[i].role === 'user') {
          State.wb.msgs[i].kbCount = (frame.hits || []).length;
          break;
        }
      }
      // 库级 ACL 挡掉了勾选的库 / 检索失败 → 必须让用户看见，不能只在助手块里躺一条灰字。
      const notes = frame.notes || [];
      if (notes.length) State.wb.notice = '知识库检索：' + notes.join('；');
      App.wbPaint();
    } else if (frame.kind === 'done') {
      if (frame.usageCollected && frame.usageCollected.totals) msg.usage = frame.usageCollected.totals;
      if (frame.attachments) {
        // ⚠️ 形状必须与上面 `attachments` 帧完全一致（四个数组一个不少）。
        // 这里曾漏掉 `sent` —— 服务端的 done 帧**每一轮都带 attachments**（kernel.mjs
        // 的回执是恒定构造的，不是"有附件才有"），于是每轮对话结束后 wbMsgHtml
        // 读 `at.sent.length` 必崩 → render 抛异常 → **整页 DOM 冻结在旧状态**
        // （用户看到的是"流式接收中…"永不消失、后续点击不再刷新）。
        // 渲染层随后也补了全字段容错作为最后防线，但形状对齐才是正修。
        msg.attach = {
          sent: (frame.attachments && frame.attachments.sent) || [],
          injected: (frame.attachments && frame.attachments.injected) || [],
          skipped: (frame.attachments && frame.attachments.skipped) || [],
          missing: (frame.attachments && frame.attachments.missing) || [],
        };
      }
      if (frame.truncated) msg.error = msg.error || '本轮事件未完整收集（可能超时）';
      App.wbPaint();
    } else if (frame.kind === 'warning') {
      msg.error = msg.error || frame.message;
      App.wbPaint();
    } else if (frame.kind === 'error') {
      msg.error = frame.message || frame.code || '本轮失败';
      App.wbPaint();
    }
    // meta / ping：不改变气泡内容，无需重绘
  },

  async wbSend() {
    const w = State.wb;
    if (w.streaming) return;
    if (!allowed('session', 'execute')) return;
    const el = $('#wb-input');
    const content = el && el.value ? el.value.trim() : '';
    const attachIds = (w.attachPicked || []).slice();
    // "只发一个附件"是合理的提问方式（服务端也允许 content 为空时只要带附件）。
    if (!content && !attachIds.length) return;
    if (el) el.value = '';
    await App.wbRunTurn({ content, attachIds, label: content || '（仅附件）' });
  },

  /**
   * ── wbRegenerate：整块删除（0.21.9）───────────────────────────
   *
   * 用户 2026-10-08 裁定：「另外重生成也直接去掉」。
   *
   * 它当时长在**最后一条助手消息**底下（`wbMsgHtml` 里的 `.wb-msg-ops`），
   * 做的是"取回上一次的用户输入，再提交一次"。删它的判据：
   *   · **同一件事有两个入口**：要再问一遍，输入卡里重新打一次（或复制上一条）
   *     就是同一回事 —— 那个入口是常驻的、显眼的，而消息底下那颗是"翻上去才看见"的。
   *   · 它带着一个**只有作者知道的副作用**：不撤销上一轮。按钮上那句 title 写得很老实
   *     （"这是再花一次钱"），但一个要读完 title 才能正确理解的动作，
   *     在界面上的默认读法是"重来一次、上一条不算" —— 两轮并排的观感会强化这个误读。
   *   · 它还要求"删掉视图里的助手回复再重发"，也就是渲染层替用户做了一次
   *     "看起来像回退"的动作，而库里一个字都没动。这类"视图与数据不一致"的动作，
   *     留下就得每次解释一遍。
   *
   * 一起删掉的还有：`wbMsgHtml` 末尾那段 `.wb-msg-ops`、`wbHasTrace`（它只服务
   * 那句话）、以及 `public/style.css` 里的 `.wb-msg-ops` 两条规则。
   */

  /**
   * 跑一轮并流式接收 —— 发送（`wbSend`）的唯一实现。
   *
   * ⚠️ 0.21.9：签名从 `{ content, attachIds, label, reuseUserBubble }` 收成
   *    `{ content, attachIds, label }` —— `reuseUserBubble` 唯一的真调用方就是
   *    被删掉的「重生成」（它复用上一条用户气泡，不插新的）。现在只剩发送一个调用方，
   *    那个参数永远为假，留着就是**一个没人读的开关**：下一个人会以为还有第二条路径，
   *    于是照着它写测试甚至照着它加功能。
   *
   * "要不要插一个用户气泡"现在**只**由 `label` 决定：给了就插，没给就只推助手消息
   *   （`label == null` 的路径仍在，是留给将来"不重复用户气泡"的调用方用的，
   *   它不需要额外参数 —— 见下面 `if (label != null)`）。
   */
  async wbRunTurn({ content, attachIds, label }) {
    const w = State.wb;
    if (!w.sessionId) {
      await App.wbNewSession();
      if (!w.sessionId) return;
    }
    if (label != null) {
      // 气泡上的回执要在**发送那一刻**就正确显示，不能等落库回放。
      //
      // 这里只算"会送给模型"的两类（图片 / 注入正文）——因为**只有这两类能从
      // 落库正文里重新读出来**（图片清单行 + `<attachment ` 引用块）。
      // 「不会交给模型的」那类不进气泡：它在正文里没有痕迹，若在这里显示、
      // 回放时又消失，同一个回合会有两种长相 —— 让它只出现在助手的回执里，
      // 那里本来就是逐条列结局的地方。
      //
      // 预估值只负责"先有个样子"：流一开始服务端就会推 `attachments` 帧，
      // 用**真实回执**覆盖它（见 wbFrame）。预算超限、文件读失败这类边角
      // 只有服务端知道，所以最终以服务端的为准。
      const picked = (w.attachmentList || []).filter((a) => (attachIds || []).indexOf(a.id) >= 0);
      const nImg = picked.filter((a) => a.delivery === 'image').length;
      const nTxt = picked.filter((a) => a.delivery === 'text').length;
      w.msgs.push({
        id: 'u' + (++w.seq), role: 'user', text: label,
        attachCount: nTxt, attachImages: nImg,
      });
    }
    const msg = wbNewAssistant('a' + (++w.seq));
    msg.streaming = true;
    w.msgs.push(msg);
    w.streaming = true;
    w.error = '';
    w.notice = '';
    w.lastTurnId = null;
    // 发一轮 = 立刻回到「对话」：用户刚打完字，要看的当然是回答。
    // 若他正停在「轨迹」页，不切回来的话这一整轮的正文会"发出去就看不见"。
    App.wbFocusChat();
    render();
    App.wbPaint();

    const ac = new AbortController();
    w.abort = ac;
    try {
      const res = await fetch('/api/kernel/sessions/' + encodeURIComponent(w.sessionId) + '/turns/stream', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ content, attachmentIds: attachIds }),
        signal: ac.signal,
      });
      if (!res.ok) {
        let m = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.error) m = j.error.message || j.error.code; } catch (e) { /* 非 JSON */ }
        throw new Error(m);
      }
      await wbConsumeStream(res, (frame) => App.wbFrame(msg, frame));
    } catch (e) {
      if (e && e.name === 'AbortError') msg.error = msg.error || '已停止（本轮可能不完整）';
      else msg.error = (e && e.message) ? e.message : String(e);
    } finally {
      msg.streaming = false;
      w.streaming = false;
      w.abort = null;
      // 附件用过了就清掉勾选 —— 留着会让下一轮"莫名其妙地"又带上它
      if (attachIds.length) { w.attachPicked = []; await App.wbLoadAttachments(); }
      render();
      await App.wbRefreshContext();
    }
  },

  /**
   * 停止（3.6）：**两件事一起做**，缺一不可。
   *   ① 通知上游取消（POST …/cancel，带上本轮的 turnId）—— 省的是上游的算力/token；
   *   ② abort 掉本地读取 —— 平台不再接收，界面立刻收敛。
   * 只做 ② 的"停止"是假的：界面停了，上游还在烧。因此这里先发取消（不等它返回，
   * 否则一个慢的上游会让"停止"按钮卡住），再 abort；取消的结果随后异步回报到界面上。
   */
  wbStop() {
    const w = State.wb;
    const turnId = w.lastTurnId;
    const sessionId = w.sessionId;
    if (sessionId && allowed('session', 'execute')) {
      // 刻意不 await：停止必须"立刻"生效，不能等一个可能很慢的上游。
      api('/api/kernel/sessions/' + encodeURIComponent(sessionId) + '/cancel', {
        method: 'POST', body: JSON.stringify({ turnId }),
      }).then((r) => {
        const up = (r && r.upstream) || {};
        State.wb.notice = up.ok
          ? '已停止：本地不再接收，并已通知上游取消本轮。'
          : '已停止本地接收，但上游取消失败' + (up.error ? '（' + up.error + '）' : '') + '：上游可能仍在消耗 token，请以用量页数字为准。';
        render();
      }).catch((e) => {
        State.wb.notice = '已停止本地接收；通知上游失败（' + e.message + '）：上游可能仍在消耗 token。';
        render();
      });
    }
    if (w.abort) { try { w.abort.abort(); } catch (e) { /* 已结束 */ } }
  },

  /* ── 附件（3.6）────────────────────────────────────────────── */

  /** 打开系统文件选择框（隐藏 input 由渲染层提供） */
  wbPickFiles() {
    const el = document.getElementById('wb-file');
    if (el) el.click();
  },

  /** 文件选择框的 change：逐个上传（串行，避免大文件并发打爆内存） */
  async wbFilesChosen() {
    const w = State.wb;
    const el = document.getElementById('wb-file');
    if (!el || !el.files || !el.files.length) return;
    if (!w.sessionId) {
      await App.wbNewSession();
      if (!w.sessionId) return;
    }
    const files = [];
    for (let i = 0; i < el.files.length; i++) files.push(el.files[i]);
    el.value = '';                                  // 允许再次选同一个文件
    w.attachBusy = true;
    w.attachError = '';
    render();
    const failed = [];
    // 上传完**立刻**分三类告诉用户"这些附件发送时会怎样"。
    // 不等到发送那一刻再说：用户上传一张图，最想知道的就是"模型看得见吗"。
    // 三类计数分开，因为它们的结局根本不同（图片送字节、文本送正文、其余不送）。
    const modes = { image: 0, text: 0, none: 0 };
    for (const f of files) {
      try {
        // 元数据走 query，body 就是文件本身 —— 不用 multipart（理由见服务端 readRawBody 注释）
        const r = await api('/api/kernel/sessions/' + encodeURIComponent(w.sessionId)
          + '/attachments?filename=' + encodeURIComponent(f.name), { method: 'POST', raw: f });
        if (r.attachment && r.attachment.id) {
          w.attachPicked.push(r.attachment.id);
          const mode = (r.delivery && r.delivery.mode) || 'none';
          modes[mode] = (modes[mode] || 0) + 1;
        }
      } catch (e) {
        failed.push(f.name + '：' + e.message);
      }
    }
    await App.wbLoadAttachments();
    w.attachBusy = false;
    const bits = [];
    if (modes.image) bits.push(modes.image + ' 张图片将在发送时作为图片块送给模型');
    if (modes.text) bits.push(modes.text + ' 个文本附件将把正文注入本轮上下文');
    if (modes.none) bits.push(modes.none + ' 个文件不会被交给模型（只登记与下载）');
    if (bits.length) w.notice = '已上传：' + bits.join('；') + '。';
    if (failed.length) w.attachError = '有 ' + failed.length + ' 个文件未上传成功 —— ' + failed.join('；');
    render();
  },

  /** 勾选/取消勾选一个附件（决定它要不要进本轮上下文） */
  wbToggleAttach(id) {
    const w = State.wb;
    const i = w.attachPicked.indexOf(id);
    if (i >= 0) w.attachPicked.splice(i, 1); else w.attachPicked.push(id);
    render();
  },

  wbAttachUrl(id) {
    return '/api/kernel/sessions/' + encodeURIComponent(State.wb.sessionId) + '/attachments/' + encodeURIComponent(id);
  },

  /** 删除附件：元数据与落盘字节一起删（服务端会如实回报哪些删掉了） */
  async wbDeleteAttach(id) {
    const w = State.wb;
    if (w.streaming) return;
    try {
      const r = await api('/api/kernel/sessions/' + encodeURIComponent(w.sessionId) + '/attachments/' + encodeURIComponent(id), { method: 'DELETE' });
      w.notice = r.bytesDeleted
        ? '附件已删除（含落盘字节）。'
        : '附件元数据已删除；落盘字节未删成功' + (r.bytesError ? '（' + r.bytesError + '）' : '') + ' —— 请检查存储目录。';
    } catch (e) {
      w.attachError = '删除附件失败：' + e.message;
    }
    await App.wbLoadAttachments();
    render();
  },

  /* ── 会话内检索：整块删除（0.21.7）────────────────────────────
   *
   * 这里曾有 wbRunSearch / wbJumpToHit / wbClearSearch / wbToggleSearch 四个动作，
   * 对应「主区右上 ⌕ 浮层 → 服务端 `/api/kernel/sessions/:id/search` → 命中列表
   * 跳转 + 消息卡左边框高亮」这一整套。
   *
   * 删掉的理由（用户裁定，2026-10-06）：**右上角不该为一个低频动作常驻一颗图标**。
   * 而"只把按钮删掉、实现留着"是本项目一直在清的东西 —— 没有入口的实现会一直躺在那里
   * 被当成"平台有这个功能"。所以连服务端路由、State 字段、命中高亮与样式一起删。
   *
   * ⚠️ 留这段注释是为了让下一个想加"在会话里搜"的人知道：**服务端检索本身是好的设计**
   *    （前端只回放最近 2000 条事件，纯前端过滤会在长会话里给出"搜不到"的错误结论）。
   *    要加回来，把 `kernel.sessions.search` 路由与这里一起复活即可 ——
   *    它当时的口径（只扫已落库的事件载荷、如实转述 scope/note）请一并沿用。
   */
  /* ── 「清屏」：整块删除（0.21.7）────────────────────────────────
   *
   * 这里曾有 `wbReset()`，对应右上角那颗 ⌫ 钮：把 `State.wb.msgs` 清空、只重绘本地消息流。
   * 用户裁定「清屏删除」（与本文件上面那段检索一起），于是**动作一起删**，不留壳子 ——
   * "只删按钮、实现留着"就是本项目一直在清的那种"藏起来的那份"。
   *
   * 值得记一笔它当时为什么要那样写（万一要加回来）：
   *   它**只清前端内存里的 msgs，不删服务端事件**。所以清屏之后再打开这个会话，
   *   内容会原样回来 —— 那正是它容易被误读成"删除会话"的地方。真删会话是另一个动作
   *   （工作区行「⋯」→ 删除会话，走 `DELETE /api/kernel/sessions/:id`）。
   *   要恢复这个功能，先把"这只清屏、不删数据"写进 title 或按钮文案，再复活本动作。
   */

  wbToggleRail() {
    State.wb.railOpen = !State.wb.railOpen;
    render();
  },

  /**
   * 会话框里切换选项卡（0.21.9 定版）：'chat' = 对话正文；'trace' = 轨迹。
   *
   * ⚠️ 走**整页** `render()`，不是 `wbPaint()`：换的是 `#wb-stream` 的**内容来源**，
   *    而 tab 条自己的选中态也在 `#wb-stream` 之外（它是页面结构的一部分）。
   *    只重绘流容器的话，点了没反应 —— 内容换了、页签还亮着上一个。
   */
  wbViewTab(name) {
    State.wb.viewTab = (name === 'trace') ? 'trace' : 'chat';
    render();
  },

  /**
   * 回到「对话」选项卡 —— **换会话 / 建会话 / 发一轮**时都调它（不发 render，由调用方自己发）。
   *
   * 为什么要收成一个小函数：这三件事的共同点是"用户此刻要看的就是**对话**"——
   *   · 发一轮   → 他刚打完字，要看的当然是回答；
   *   · 换 / 建会话 → 上一个会话停在「轨迹」是上一个会话的事，新会话是新的内容。
   * 判断散在四处各写一遍的话，迟早只改到其中两三处，症状是"偶尔一进来停在轨迹页"，
   * 而那种偶发最容易被读成"随机坏了"。
   */
  wbFocusChat() { State.wb.viewTab = 'chat'; },

  async wbSelectModel() {
    const el = $('#wb-model');
    const v = el ? el.value : '';
    State.wb.modelValue = v || '';
    if (!v || !State.wb.sessionId) { render(); return; }
    const parts = v.split('|');
    try {
      const r = await api('/api/kernel/sessions/' + encodeURIComponent(State.wb.sessionId) + '/model', {
        method: 'POST', body: JSON.stringify({ provider: parts[0] || null, model: parts[1], reasoningEffort: State.wb.effort || null }),
      });
      // 用**服务端回报的落库值**更新"已登记"标记，而不是用我们发出去的值 ——
      // 发出去 ≠ 存下来了，两件事必须分开，否则失败时界面会显示成功。
      const rec = r.recorded || {};
      State.wb.modelRecorded = rec.modelId || parts[1];
      State.wb.modelRecordedProvider = rec.modelProvider || '';
      if (rec.reasoningEffort) State.wb.effort = rec.reasoningEffort;
      State.wb.notice = '已为本会话登记模型：' + parts[1]
        + '（后续回合的用量按这个模型名归因；模型注册表里要有一条「模型名」相同的条目，金额才算得出来）';
    } catch (e) {
      State.wb.error = '切换模型失败：' + e.message;
    }
    render();
  },

  /* ── 工作区树与选择器（0.21.0）────────────────────────────── */

  /* ── 行内「⋯」菜单（0.21.1）──────────────────────────────── */

  /**
   * 开/关一条行内菜单。同时只开一个 —— 两排菜单同时摊开，树就被盖住了。
   * 点同一行的「⋯」再点是收起（与授权面板同一个手感）。
   */
  wbToggleRowMenu(kind, id) {
    const w = State.wb;
    const k = String(kind == null ? '' : kind);
    const i = String(id == null ? '' : id);
    const cur = w.rowMenu;
    const same = !!(cur && cur.kind === k && cur.id === i);
    w.rowMenu = same ? null : { kind: k, id: i };
    render();
  },

  /**
   * 收起菜单（菜单里的动作一执行就收起）。
   * 刻意只改状态、不自己 render：调用方随后几乎都会 render（或弹层会触发重绘），
   * 在这里再 render 一次会让"点菜单 → 先闪一下收起 → 再弹对话框"。
   */
  wbCloseRowMenu() {
    if (State.wb.rowMenu) State.wb.rowMenu = null;
  },

  // 0.21.11：这里的 `wbToggleAccountMenu` / `wbGoMe` 已删 —— 工作台左栏账号条回退成
  // **一个链接**（`<a>` + `navAttr('#/me')`，走 data-nav 委托，不需要 App 动作）。
  // 保留这段注释是为了说明：如果将来又要加动作，别把状态塞回 `State.wb.accountMenu`
  // （那个字段也已删），顶栏的下拉用的是顶层 `State.topbarMenu`。

  /** 侧栏过滤词（输入即过滤，不打服务端 —— 数据已整树在前端） */
  wbTreeFilter() {
    const el = $('#wb-tree-filter');
    State.wb.treeFilter = el ? el.value : '';
    render();
  },

  /**
   * 0.21.2：左栏收起 / 展开。收起后主区吃满剩下的宽度（左侧留 56px 给入口栏，0.21.9 前是 44px）。
   * 0.21.7 修了一个真 bug：收起钮住在 `.wb-side` 里，而 `.wb.side-closed .wb-side{display:none}`
   * 把整栏（含那颗钮）一起藏掉 —— 收起之后**没有任何可达的展开入口**。
   * 0.21.8：入口不再是一颗孤钮，而是左侧**竖排入口栏**（`.wb-siderail`）——
   * 「展开左栏 / 管理后台 / 设置 / 我的账号」。理由是同一件事的第二半：那三个入口
   * 也住在 `.wb-side` 底部，收起时一起消失，"收起左栏"等于把治理面导航整个丢掉。
   * 本动作两个方向共用（品牌的收起钮与栏里的展开钮都调它），保持一个入口一个动作。
   */
  wbToggleSide() {
    State.wb.sideOpen = State.wb.sideOpen === false;
    render();
  },

  /**
   * 0.21.2：过滤输入框默认收起（节头的放大镜切换）。
   * 展开后立刻聚焦 —— 点放大镜的人下一步必然是打字，让他不用再点一次。
   */
  wbToggleTreeFilter() {
    const w = State.wb;
    w.treeFilterOpen = !w.treeFilterOpen;
    if (!w.treeFilterOpen) w.treeFilter = '';
    render();
    if (w.treeFilterOpen) {
      const el = $('#wb-tree-filter');
      if (el && el.focus) el.focus();
    }
  },

  /** 展开/收起一个树节点（收起时顺手把菜单收掉：菜单挂在行下，行都藏了再摊着它很怪） */
  wbToggleWs(id) {
    const k = String(id || '');
    const w = State.wb;
    const open = !(w.wsOpen[k] !== false);
    w.wsOpen[k] = open;
    if (!open && w.rowMenu && w.rowMenu.kind === 'ws' && w.rowMenu.id === k) w.rowMenu = null;
    render();
  },

  /** 选中"新对话要建进的工作区"（点树上的工作区行） */
  wbPickWorkspace(id) {
    // ⚠️ 0.21.9：空 id **不接受** —— 从前空 id 是"未分组"那个桶，它已经不存在了。
    // 静默吞掉一次空点击，用户看到的是"点了这一行但什么都没选中"，而真相是
    // 这个动作已经没有一个合法的空值语义。宁可不改状态（也不把已有的选择清掉）。
    const next = String(id == null ? '' : id);
    if (!next) return;
    State.wb.wsActiveId = next;
    App.wbCloseRowMenu();
    render();
  },

  /* 0.21.6 删掉了 wbWorkspacePick（输入卡上方那个工作区下拉）。
   * 它和左侧树改的是同一个值（`wsActiveId`）—— 两个入口会让"哪个算数"变成
   * 一个要靠试的问题（实际是树赢，因为点树会重写它）。现在只留树一个入口，
   * 见 84-workbench.js 里 wbComposeHtml 徽片行那段说明。
   */

  /* 0.21.9 删掉了 wbPresetPick（模式下拉的 change 处理）。
   * 下拉本身随模式整块从界面拿掉（用户裁定）—— 留一个没有控件的处理函数，
   * 下一个读到它的人会以为界面上还有那个控件。
   */

  /**
   * 推理等级：有会话 → 立即登记（模型 + 当前等级一起发，服务端一次落库）；
   * 没会话 → 只存本地，等新建时随会话提交。模型没选就先给一句人话提示。
   */
  async wbEffortPick() {
    const w = State.wb;
    const el = $('#wb-effort');
    w.effort = el ? el.value : '';
    if (!w.sessionId) { render(); return; }
    const parts = (w.modelValue || '').split('|');
    if (!parts[1]) {
      w.notice = '本会话还没有登记模型；先在上方选模型，推理等级会随模型一起登记。';
      render();
      return;
    }
    try {
      const r = await api('/api/kernel/sessions/' + encodeURIComponent(w.sessionId) + '/model', {
        method: 'POST',
        body: JSON.stringify({ provider: parts[0] || null, model: parts[1], reasoningEffort: w.effort || null }),
      });
      const rec = r.recorded || {};
      if (rec.reasoningEffort) w.effort = rec.reasoningEffort;
      w.notice = '已登记推理等级：' + (w.effort || '（模型默认）') + '。';
      w.error = '';
    } catch (e) {
      w.error = '登记推理等级失败：' + e.message;
    }
    render();
  },

  /**
   * 在工作区行里新建会话（工作区行右侧的「＋」）。
   *
   * 与顶部「新会话」的关系：**同一个动作**，只是先把"新对话建在哪"定成这一行。
   * （0.21.6 起顶部那个胶囊删了 —— 左栏最上面原本一横排两个入口，新会话与插件，
   * 现在新会话只从工作区行进：**每一行都自带"在这里新建"**，比先选行再点顶部少一步，
   * 也不再有"顶部那个按钮建到哪去了"的疑问。）
   * 刻意不复制一份建会话逻辑 —— 那样两处会各自演化（一边记得提交模式 / 模型 / 推理等级，
   * 另一边忘了），而"新对话建在哪"的真相只有一个：`wsActiveId`。
   */
  async wbNewSessionIn(wsId) {
    if (State.wb.streaming) return;
    App.wbCloseRowMenu();
    const next = String(wsId == null ? '' : wsId);
    if (!next) return;      // 同上：没有"建进未分组"这回事了
    State.wb.wsActiveId = next;
    // 建会话时这行必须是展开的：建完它会以子节点形式出现在这里，
    // 收起状态下看不到新会话，用户会以为"没建成"。
    State.wb.wsOpen[next] = true;
    await App.wbNewSession();
  },

  /**
   * 新建工作区：**选一个文件夹**（0.21.9）。
   *
   * 这条动作改过三版，值得把用户的原话按顺序记下来 —— 它解释了为什么最后是这个形状：
   *   · 0.21.7 拆两步（先弹名称、再弹目录）→「新建工作区弹框还是以前的输名称不是选择文件夹」；
   *   · 0.21.9 合成一个框（名称在上、目录在下）→「新建工作区不要搞这么复杂，
   *     就搞成这种选择文件夹框就行啦」；
   *   · 现在：名字不再问，**取所选目录的末段名**，弹框里如实显示出来。
   *
   * 取值**两态**（与 prompt/pick 同一条纪律）：
   *   · 路径字符串（保证非空）→ 用它当 cwd；名称由 `wbPathName` 从它推出来；
   *   · `null`                → 取消，整件事别做
   * ⚠️ 0.21.9 起**不再有第三个取值**：用户裁定去掉「不设工作目录」（原话：「新建工作区弹框，
   *    去掉最下面的不设置工作目录」），弹框不会再把空串交出来。
   *
   * ⚠️ 名称与弹框里那行提示必须是**同一个函数**算的（`wbPathName`）：提示说
   *    "工作区名称：proj-x" 而建出来叫别的，比不显示那行还糟。
   */
  async wbNewWorkspace() {
    const w = State.wb;
    if (w.streaming) return;
    const picked = await Dlg.browse({
      title: '新建工作区',
      label: '工作目录',
      body: ['工作目录是**服务器**上的路径 —— 它决定上游项目级能力能读写哪一片。',
        '点进目标目录即可；工作区名称取目录名，建好后可在左侧树上重命名。'],
    });
    if (picked == null) return;
    const cwd = String(picked || '').trim();
    // ⚠️ 空路径到这里只可能是"弹框出了问题"（它自己已经拦过一道），所以**拦住并说出来**。
    //    不能照常发请求：服务端把空 cwd 当成"没给 cwd"，会**静默**建出一个没有工作目录的
    //    工作区 —— 用户点的是「创建」，没看到任何报错，却得到一个不绑目录的工作区。
    //    （0.21.9 去掉「不设工作目录」之前，空串是**用户明确选的**；现在它不是任何人的选择。）
    if (!cwd) {
      w.error = '没有拿到工作目录 —— 请重新打开「新建工作区」再选一次';
      render();
      return;
    }
    const name = wbPathName(cwd) || '新工作区';
    try {
      const r = await api('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: name, cwd: cwd }),
      });
      w.wsActiveId = r.workspace.id;
      w.notice = '已创建工作区「' + r.workspace.name + '」'
        + (r.workspace.cwd ? '（工作目录：' + r.workspace.cwd + '）' : '（未设工作目录）')
        + '，新对话将建在这里。';
      w.error = '';
      await App.wbEnsureLoaded(true);
    } catch (e) {
      w.error = '创建工作区失败：' + e.message;
      render();
    }
  },

  /* 0.21.6 删掉了 wbEditWsCwd（工作区菜单里的「工作目录…」）。
   *
   * 用户的裁定是那个菜单只留"重命名工作区 / 删除工作区"。cwd 是"上游项目级能力的
   * 作用范围"，但它只在**建工作区**时问一次就够（那时会问），事后改的场景极少，
   * 却占着菜单的位置把两个日常项淹掉。
   * 要改 cwd：删了这个工作区重建 —— 里面的会话会落回"未分组"，本体不会丢。
   *
   * ⚠️ 服务端 `PATCH /api/workspaces/:id` 仍然接受 `cwd`。这里删的是**界面入口**，
   *    不是能力 —— 哪天要把它加回来，接上那个接口即可。
   */

  async wbRenameWs(id, name) {
    const w = State.wb;
    if (w.streaming) return;
    App.wbCloseRowMenu();
    const next = await Dlg.prompt({ title: '重命名工作区', label: '新名称', value: name || '', maxlength: 120, required: true });
    if (next == null || next === name) { render(); return; }
    try {
      await api('/api/workspaces/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ name: next }) });
      w.error = '';
      w.notice = '工作区已改名为「' + next + '」。';
      await App.wbEnsureLoaded(true);
    } catch (e) {
      w.error = '重命名失败：' + e.message;
      render();
    }
  },

  /** 删除工作区：会话**不删**，全部移进默认工作区（服务端同一语义，这里只把话说清） */
  async wbDeleteWs(id, name) {
    const w = State.wb;
    if (w.streaming) return;
    App.wbCloseRowMenu();
    // 落点写**名字**而不是"未分组"（0.21.9）：用户要能在按下去之前知道会话会去哪个工作区，
    // 而不是先从菜单里看出来再猜。取不到名字就退一句不带名字的说法 —— 不编一个假名字。
    const def = (w.workspaces || []).find((x) => x.id === w.defaultWorkspaceId)
      || (w.workspaces || []).find((x) => x.isDefault);
    const toName = def ? def.name : '';
    if (!await Dlg.confirm({
      title: '删除工作区',
      body: ['删除工作区「' + (name || id) + '」？',
        '· 里面的会话**不会被删除**，会移入' + (toName ? '「' + toName + '」' : '默认工作区') + '；',
        '· 此操作不可恢复。'],
      ok: '删除', danger: true,
    })) return;
    try {
      const r = await api('/api/workspaces/' + encodeURIComponent(id), { method: 'DELETE' });
      // 选中的工作区被删掉了 → 归位到会话实际落进去的那一个（服务端回报的 toWorkspaceId），
      // 而不是置空。置空会让"接着点 ＋ 新建会话"建到别处，用户还没有机会察觉。
      if (w.wsActiveId === id) w.wsActiveId = r.toWorkspaceId || w.defaultWorkspaceId || null;
      w.error = '';
      w.notice = '工作区已删除：' + (r.movedSessions || 0) + ' 个会话移入「'
        + (r.toWorkspaceName || toName || '默认工作区') + '」（会话本体未删除）。';
      await App.wbEnsureLoaded(true);
    } catch (e) {
      w.error = '删除工作区失败：' + e.message;
      render();
    }
  },

  /**
   * 用**系统默认程序**打开一个产物文件（0.21.9）。
   *
   * 为什么必须由服务端来开：这些路径是**服务器上的路径** —— 浏览器拿不到它，
   * 也没有任何浏览器 API 能"用系统程序打开一个磁盘文件"（`file://` 被 CSP 与
   * 同源策略挡死，而且就算放行，打开的也是**客户端**的路径，跟这里记录的不是一回事）。
   * 所以这一步是服务端替用户在**跑平台的那台机器**上把文件交给 shell。
   *
   * 因此它是一条**有副作用、且副作用在服务端**的接口，权限跟产物清单同一把尺：
   * `artifact:read`。不另设更严的门 —— 能看这份清单的人，本来就能让 agent 去写这些文件。
   *
   * ⚠️ 失败一律**如实报**，不假装成功：文件不存在、路径不是文件、这台机器没有图形
   *    会话能收这个请求 —— 三种都由服务端回 4xx/5xx 带原因，这里原样显示。
   *    "点了没反应"是最坏的一种，因为用户会以为自己没点中。
   */
  async wbOpenArtifact(path) {
    const w = State.wb;
    const p = String(path == null ? '' : path);
    if (!p) return;
    try {
      await api('/api/governance/artifacts/open', {
        method: 'POST',
        body: JSON.stringify({ path: p }),
      });
      w.error = '';
      // ⚠️ 成功时**什么都不播报**（用户 2026-10-08：「点击打开后，不要写"已交给系统默认程序
      //    打开：cmd · C:\…\hello-dsh.txt"，去掉，增加复杂性」）。
      //    他是对的，而且理由不止"啰嗦"：这条提示要用户先读一句"已交给…"、再读一个
      //    `cmd`、再读一整条路径 —— 三样东西没有一样是他此刻需要的。**系统默认程序
      //    已经弹到屏幕上了**，那才是这次操作的回执，而且是自证的。再来一条文字是噪音。
      //    顺带：`opener` 是**服务端实现细节**（Win 上恰好是 cmd），界面不该认识它。
      //    它仍在响应体里 —— 真出问题时不改代码也能从网络面板看到，只是不上界面。
      //    ⚠️ 失败**照旧要说**：那条提示是唯一能告诉他"为什么没反应"的东西。
    } catch (e) {
      w.error = '打开失败：' + e.message;
    }
    render();
  },

  /* 0.21.9 删掉了 wbMoveSession（移动会话到别的工作区）。
   *
   * 用户裁定删除。理由与 0.21.6 删掉"输入卡上方那个工作区下拉"完全一样：
   * **同一个值不许有两个写入口**。会话的归属现在只有一个入口 —— 在哪一行点「＋」就建在哪；
   * 再留一个"事后挪"的动作，用户会面对"这条会话到底属于哪"这样一个要靠试的问题，
   * 而这恰恰是"工作区"这个概念存在的意义（它是组织容器，不是可以随手贴的标签）。
   * 要换工作区就新开一条会话。
   *
   * ⚠️ 删的是**前端动作**，服务端能力没减：`PATCH /api/kernel/sessions/:id` 仍接受
   *    `workspaceId`（删工作区时的会话归位正是走它，见 workspace.mjs / kernel.mjs 的
   *    `moveSession`）。哪天要在别处用它（例如批量整理），能力还在。
   */

  /* ── 工作区权限：整块删除（0.21.6）───────────────────────────────
   *
   * 这里曾经有 wbToggleGrants / wbSessionGrants / wbGrantAdd / wbGrantRevoke /
   * wbWsVisibility / wbReloadGrants / wbGrantSubjectType 七个动作，对应
   * "工作区三档授权 + 可见性"那一整套。
   *
   * 删掉的理由（用户裁定，2026-10-06）：**上游 dsh 自己有一份工作区权限三档**，
   * 平台这份是第二份真相，而平台**没有任何接口去改上游那一份** —— 两边永远对不上：
   * 在这里把人调成"完全权限"，上游那侧一动不动。**一份改了不生效的权限配置
   * 比没有权限配置更糟**：它让人以为已经管住了。
   *
   * ⚠️ 留这段注释而不是清空到什么都没有，是为了让下一个想加"工作区权限"的人
   * 先看到"这里加过、为什么删了"。要加回来，请先回答一个问题：
   * **改了之后上游那侧会不会跟着变？** 不会，就别加。
   */
});

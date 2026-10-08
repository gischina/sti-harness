/* STI HARNESS 前端 · 应用内对话框（0.15.0）
 * Copyright 2026 liwei（易智瑞西安）.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 为什么要有这一层 ───────────────────────────────────────────────────
 * 此前 19 处行内动作（删知识库、删凭据、删文档、改角色、改归属、改组成员、重置口令…）
 * 全靠浏览器原生的 `window.prompt / confirm / alert`。对一个**要交付给企业**的产品，
 * 这有三宗罪：
 *
 *   ① **让人手输标识符**：「改角色」要输 `member,viewer`，「改组成员」要输一串账号名。
 *      原生 prompt 只能给一段纯文字提示，**给不了选项** —— 用户看不到有哪些可选，
 *      输错一个字整条请求被拒，也不知道错在哪。
 *   ② **新口令不遮蔽**：「重置口令」用原生 prompt 收密码，屏幕上明文显示，且没有二次确认。
 *   ③ **不可样式化、阻塞整页**：原生弹窗与主题、品牌完全脱节；在嵌入式浏览器／部分客户端里
 *      还会被静默丢弃（静默返回 null），用户看到的是"点了没反应"。
 *
 * ── 做法 ──────────────────────────────────────────────────────────────
 * 弹层是**状态**（`State.dlg`），由 `render()` 渲染，按钮走既有事件委托
 * （data-act / data-change，见 40-delegate.js）。好处有三：
 *   · 与全站同一套渲染与交互模型，不引入任何 DOM 库；
 *   · 它是**渲染出来的 HTML**，因此回归里那套 DOM 垫片能直接驱动它
 *     （反过来，原生 prompt 在垫片里只是一个返回 null 的桩，测不出真实流程）；
 *   · 主题、遮罩、层级全部复用既有样式，不另起一套。
 *
 * ── 用法（在 async 方法里直接 await）──────────────────────────────────
 *   if (!await Dlg.confirm({ title:'删除知识库', body:[…], danger:true, ok:'删除' })) return;
 *   const name = await Dlg.prompt({ title:'改名为', label:'知识库名称', value:old, required:true });
 *   const roles = await Dlg.pick({ title:'角色', multiple:true, options:[{value,label,desc}], selected:[…] });
 *   await Dlg.notice({ title:'API Key 已创建', body:[…], mono:key, warn:'这个值只显示这一次。' });
 * 取消一律返回 null（`confirm` 返回 false、`pick` 返回 null）—— 调用方据此**什么都不做**。
 * ⚠️ 判断"用户取消了"必须用 `=== null`，不能写成 `if (!v)`：单选里「（不归属任何部门）」
 *    的取值就是空串，那是**一个有效的选择**，不是取消。
 */
let dlgResolve = null;

const Dlg = {
  isOpen() { return !!State.dlg; },

  _open(spec) {
    return new Promise((resolve) => {
      dlgResolve = resolve;
      State.dlg = Object.assign({
        kind: 'confirm', value: '', selected: [], error: null,
        danger: false, ok: '确定', cancel: '取消',
      }, spec);
      render();
      // 打开就把焦点放到"能立刻动手"的地方：输入框优先，其次是只读值，最后是确认按钮。
      // 这样按 Enter 就能确认，不必先摸鼠标。
      const el = $('#dlg-input') || $('#dlg-mono') || $('#dlg-ok');
      if (el) { try { el.focus(); } catch { /* DOM 垫片里没有真实焦点，忽略 */ } }
    });
  },

  /** 关闭并把结果交给等待方。**先清状态再 render**，否则会闪一下残影。 */
  close(value) {
    const r = dlgResolve;
    dlgResolve = null;
    State.dlg = null;
    render();
    if (r) r(value);
  },

  confirm(spec) { return Dlg._open(Object.assign({ kind: 'confirm' }, spec)).then((v) => v === true); },
  prompt(spec) { return Dlg._open(Object.assign({ kind: 'prompt' }, spec)); },
  pick(spec) { return Dlg._open(Object.assign({ kind: 'pick', multiple: false }, spec)); },
  notice(spec) { return Dlg._open(Object.assign({ kind: 'notice' }, spec)); },

  /**
   * 目录选择器（0.21.7 引入；0.21.9 起**就是一个文件夹选择器**）。
   *
   * 打开即异步拉一次目录列表（服务端 `/api/workspaces/browse`，只读、只列子目录）。
   * 取值**两态**（与 prompt/pick 同一条纪律）：
   *   · 一个**路径字符串** → 选中的目录（保证非空，见下面的拦阻）；
   *   · `null`              → 取消，整件事别做
   * ⚠️ 判"取消"只能用 `=== null`，不能写 `if (!v)`。
   *
   * ── 0.21.9 为什么去掉「不设工作目录」────────────────────────────
   * 它存在过一版：点亮它 → 关窗时返回空串 → 建一个 `cwd` 为空的工作区。
   * 用户裁定去掉（原话：「新建工作区弹框，去掉最下面的不设置工作目录」）。理由站得住：
   *   · 这个弹框叫「新建**工作区**」，而"工作目录"就是工作区唯一有实质影响的属性 ——
   *     一个不绑任何目录的"工作区"没有说清自己是什么；
   *   · 它还让取值多出一个**看不见后果的分支**（空串 vs 路径），而这个区别只在
   *     建完之后才显形；
   *   · 服务端能力**没减**：`workspace.create` 仍接受空 cwd（API 层照旧），
   *     少的只是界面上这个出口。
   * 于是 `submit()` 里"路径还没读出来"那道拦阻也从"两态之一"变成**唯一的**一道校验。
   *
   * ── 0.21.9 为什么去掉名称输入框 ────────────────────────────────
   * 它的历史：0.21.7 = 先弹"输名称"再弹目录（用户："还是输名称不是选择文件夹"）；
   * 0.21.9 第一版 = 两个合成一个框（名称在上、目录在下）。
   * 用户看了那个合成框的反馈是：「新建工作区不要搞这么复杂，就搞成这种选择文件夹框就行啦」
   * （附了一张 Windows 原生选择文件夹对话框的截图）。
   *
   * 那句"不要搞这么复杂"点得对：那个框里**只有一样东西是要用户决定的** —— 哪个目录。
   * 名称是它的函数（末段目录名），却被摆成了一个必填输入框，于是整件事读起来
   * 仍然是"填表"。现在名称不再问：**取所选目录的末段名**（`wbPathName`，30-util.js），
   * 弹框里把它**如实显示出来**（不是输入框，是那行说明），想改名的去树上那一行的「⋯」。
   * 于是这个弹框只剩它本来该有的那一样东西。
   */
  browse(spec) {
    const p = Dlg._open(Object.assign({ kind: 'browse', ok: '创建', browseBusy: true }, spec));
    // _open 是同步建状态的（Promise executor 立即执行），所以这里 State.dlg 已经就位
    Dlg._browseLoad(spec.start || '');
    return p;
  },

  /* ⚠️ 0.21.9 删掉了 `_browseSkip`（「不设工作目录」）。
   *
   * 它是"一个有效结果"（关窗时返回空串）而不是取消 —— 但只要这个出口在，
   * 弹框的取值就多出一个分支，而两个分支的后果在建完之后才显形。
   * 用户裁定去掉之后，`submit()` 只剩一道校验、调用方只剩两种输入。
   * 服务端**照旧**接受空 cwd：变的是界面，不是能力。
   *
   * ⚠️ 0.21.9 删掉了 `_browseSyncName` 与 `_browseSuggestName` 两个助手。
   *
   * 它们存在的原因是**弹框里有一个输入框**：每次重绘都会按 `State.dlg.name.value`
   * 重建它，所以重绘前必须把 DOM 里的字救回状态；而"点进目录就把目录名填进名称"
   * 这条建议也要记住"用户动过没有"。名称不再由用户输入（取目录末段名）之后，
   * 这两件事**没有对象了** —— 留着它们只会让人以为弹框里还有输入框要同步。
   *
   * 教训值得留一句：那两处代码不是写错了，是**设计变了之后它们失去了前提**。
   * 删掉比留着便宜 —— 留着的代码会一直假装自己还有用。 */

  /** 拉一个目录的子目录列表。导航（进子目录 / 回上级 / 点常用位置）都走这里。 */
  _browseLoad(target) {
    if (!State.dlg || State.dlg.kind !== 'browse') return Promise.resolve();
    State.dlg = Object.assign({}, State.dlg, { browseBusy: true, browseError: '' });
    render();
    const url = '/api/workspaces/browse' + (target ? '?path=' + encodeURIComponent(target) : '');
    return api(url)
      .then((r) => {
        // 用户可能在请求飞行期间关掉了弹层 —— 那就什么都不做。
        // （不判这一下会在关窗后凭空重绘出一个"幽灵弹层"。）
        if (!State.dlg || State.dlg.kind !== 'browse') return;
        State.dlg = Object.assign({}, State.dlg, {
          browseBusy: false, browseError: '', browseLoaded: true,
          browsePath: r.path, browseParent: r.parent || '',
          browseEntries: r.entries || [], browseRoots: r.roots || [],
          browseTruncated: !!r.truncated,
        });
        render();
      })
      .catch((e) => {
        if (!State.dlg || State.dlg.kind !== 'browse') return;
        // 失败时**保留上一次的列表**：让用户还能从原地退出去，而不是对着一片空白
        State.dlg = Object.assign({}, State.dlg, {
          browseBusy: false, browseError: '读取目录失败：' + ((e && e.message) || '未知原因'),
        });
        render();
      });
  },

  /** 确认按钮。校验不过就**把错误写进弹层、不关窗** —— 关掉让人从头再来最气人。 */
  submit() {
    const d = State.dlg;
    if (!d) return;
    if (d.kind === 'prompt') {
      // 取值优先读 DOM、退回状态：真实浏览器里 DOM 是权威（用户刚敲的字在这里）；
      // 而"因校验失败重绘过"的情况下，DOM 里的值本来就是从状态回填的，两者一致。
      const el = $('#dlg-input');
      const dom = el && typeof el.value === 'string' ? el.value : null;
      const raw = dom != null ? dom : (d.value == null ? '' : String(d.value));
      const v = raw.trim();
      if (d.required && !v) return Dlg._err(d, '这一项不能为空');
      if (typeof d.validate === 'function') {
        const msg = d.validate(v);
        if (msg) return Dlg._err(d, msg);
      }
      return Dlg.close(v);
    }
    if (d.kind === 'pick') {
      const sel = d.selected || [];
      if (d.required && !sel.length) return Dlg._err(d, '至少要选一个');
      return Dlg.close(d.multiple ? sel.slice() : (sel[0] == null ? null : sel[0]));
    }
    if (d.kind === 'browse') {
      // 「确定」= 用**当前所在的这个目录**。
      // 还没读完就点，说清楚而不是返回一个空路径 —— 空路径到了服务端会被当成
      // "没给 cwd"，于是静默建出一个没有工作目录的工作区。
      // ⚠️ 0.21.9 去掉「不设工作目录」之后，这是**唯一**的一道校验：空路径不再是一个
      //    有效取值，它只意味着"列表还没读出来"。
      // ⚠️ 返回值就是**路径本身**（不再是一个 `{name, cwd}` 对象）——
      //    名称是路径的函数，由调用方用同一个 `wbPathName()` 推出来，
      //    不在这里再算一遍（两处算必然漂，见 30-util.js 里那条注释）。
      if (!d.browsePath) {
        return Dlg._err(d, '目录还没读出来 —— 稍等一下，或先点一个常用位置');
      }
      return Dlg.close(d.browsePath);
    }
    return Dlg.close(true);
  },

  _err(d, msg) {
    State.dlg = Object.assign({}, d, { error: msg });
    render();
  },
};

/**
 * Tab 焦点陷阱：`role="dialog" aria-modal="true"` 只是**声明**，浏览器不会因此拦住 Tab ——
 * 弹层开着时背后整页仍在 DOM 里，焦点一旦溜出去，键盘用户就会在"看不见的界面"里迷路
 * （连按十几次 Tab 也绕不回来）。做法：Tab 在弹层首尾两个可聚焦元素间循环；
 * 若焦点当前不在弹层内（例如校验失败重绘后落回了 body），直接拉回第一个。
 * DOM 垫片里 querySelectorAll 恒返回空列表 → 自然不生效（垫片本来也不模拟焦点）。
 */
function dlgTrapFocus(e) {
  const els = document.querySelectorAll(
    '.modal.dlg button, .modal.dlg input, .modal.dlg textarea, .modal.dlg select');
  if (!els.length) return;
  const first = els[0], last = els[els.length - 1];
  const active = document.activeElement;
  const inside = active && typeof active.closest === 'function' && active.closest('.modal.dlg');
  if (!inside) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

/** 弹层：盖在整页之上（与内核引导同一套 .modal-wrap 层级，不另起一套 z-index 体系）。 */
function dlgOverlay() {
  const d = State.dlg;
  if (!d) return '';

  const lines = Array.isArray(d.body) ? d.body : (d.body ? [d.body] : []);
  const body = lines.map((t) => '<p>' + esc(t) + '</p>').join('');

  let field = '';
  if (d.kind === 'prompt') {
    field = '<div class="dlg-field">'
      + (d.label ? '<label class="field-label" for="dlg-input">' + esc(d.label) + '</label>' : '')
      + '<input id="dlg-input" type="' + (d.type === 'password' ? 'password' : 'text') + '"'
      + ' value="' + esc(d.value == null ? '' : d.value) + '"'
      + (d.placeholder ? ' placeholder="' + esc(d.placeholder) + '"' : '')
      + (d.maxlength ? ' maxlength="' + esc(String(d.maxlength)) + '"' : '')
      + ' autocomplete="off" spellcheck="false">'
      + '</div>';
  } else if (d.kind === 'pick') {
    // 单选也是**列表**而不是下拉：这些选项各自带一句说明（"管理员：可改接入与用户"），
    // 下拉框里放不下；而且选项数量有限（角色 4 个、部门几到十几个），列表更好扫。
    field = '<div class="dlg-choices" role="group"'
      + (d.label ? ' aria-label="' + esc(d.label) + '"' : '') + '>'
      + (d.options || []).map((o, i) => (
        '<label class="dlg-choice" for="dlg-opt-' + i + '">'
        + '<input id="dlg-opt-' + i + '" type="' + (d.multiple ? 'checkbox' : 'radio') + '"'
        + (d.multiple ? '' : ' name="dlg-radio"')
        // value 用**索引**：change 委托把 `el.value` 当唯一实参传下去，索引最短也最不会歧义
        // （选项值本身可能是空串或含引号的名字）。
        + ' value="' + esc(String(i)) + '" data-change="dlgToggle"'
        + ((d.selected || []).indexOf(o.value) >= 0 ? ' checked' : '')
        + '>'
        + '<span class="dlg-choice-main">'
        + '<b>' + esc(o.label) + '</b>'
        + (o.desc ? '<span class="dlg-choice-desc">' + esc(o.desc) + '</span>' : '')
        + '</span>'
        + '</label>'
      )).join('')
      + '</div>';
  } else if (d.kind === 'browse') {
    // 文件夹选择器 —— 布局按 **Windows 的「浏览文件夹」** 排（用户 2026-10-08：
    // 「新建工作区弹框不能做成 Windows 那种选择文件夹框样式吗」）：
    //
    //   ┌ 新建工作区 ──────────────────────────────┐
    //   │ 选择工作目录：                            │   ← 一行说明（Windows 也有一行）
    //   │ [默认工作区目录][用户主目录][盘符 C:\]…   │   ← 常用位置（Windows 靠左树，这里用胶囊）
    //   │ ┌ 📁 上一级 ──────────────────────────┐   │
    //   │ │ 📁 proj-a                           │   │   ← 主区是一个**大列表**
    //   │ │ 📁 proj-b                           │   │
    //   │ └─────────────────────────────────────┘   │
    //   │ 文件夹(F):  C:\demo\proj-a                │   ← 路径在**列表下面**，带标签前缀
    //   │ 工作区名称：proj-a（取目录名…）            │
    //   │                        [取消]  [创建]     │   ← 右下两个按钮
    //   └───────────────────────────────────────────┘
    //
    // ⚠️ 与上一版的差别只有一处是真的：**路径从列表上方挪到了下方**。
    //    上面那版是"当前路径 → 名称 → 常用位置 → 列表"，路径在最顶上 —— 读起来像
    //    "一个表单，第一格是路径"。Windows 那个框里路径是**结果行**（"你正指着哪个文件夹"），
    //    所以它在列表下面。这一挪，整个框就从"填表"变成了"在树里走到哪、下面告诉你"。
    //
    // 选择目录的交互刻意只有"点进去 / 退出去"两种 —— 不做路径输入框：
    // 手打的路径就是 0.21.7 要消掉的东西（打错一个字就得到一条指向不存在目录的工作区）。
    // 名称也不再问，**如实显示**在那行提示里（不是输入框），要改名去树上那一行的「⋯」。
    // 底部原来还有一行「不设工作目录」，0.21.9 按用户裁定删掉（理由见 `Dlg.browse` 注释）。
    const ents = d.browseEntries || [];
    const nameHint = wbPathName(d.browsePath || '');
    field = '<div class="dlg-field">'
      + '<div class="field-label">' + esc(d.label || '选择文件夹') + '</div>'
      + '<div class="dlg-roots">'
      + (d.browseRoots || []).map((r) => '<button class="dlg-root"' + act('dlgBrowseGo', r.path)
        + ' title="' + esc(r.path) + '">' + esc(r.label) + '</button>').join('')
      + '</div>'
      // ⚠️ role 保持 `group`，不改成 `listbox`：listbox 的子项必须是 `option`，
      //    而这里的每一项都是**按钮**（点进去 / 退出去是导航，不是选中）。声明成 listbox
      //    会让读屏软件按"选项列表"念，而实际是一个可以逐层进入的目录树。
      + '<div class="dlg-list" role="group" aria-label="子目录">'
      + (d.browseParent ? '<button class="dlg-item up"' + act('dlgBrowseGo', d.browseParent) + '>'
        + wbIcon('arrowUp', 'sm') + '上一级</button>' : '')
      + (d.browseBusy ? '<div class="dlg-item-none">正在读取…</div>' : '')
      + (!d.browseBusy && d.browsePath && !ents.length
        ? '<div class="dlg-item-none">这个目录下没有子目录。</div>' : '')
      + ents.map((e) => '<button class="dlg-item"' + act('dlgBrowseGo', e.path) + ' title="' + esc(e.path) + '">'
        + wbIcon('folder', 'sm') + '<span class="dlg-item-name">' + esc(e.name) + '</span></button>').join('')
      + (d.browseTruncated ? '<div class="dlg-item-none">子目录过多，只列了前 ' + ents.length + ' 个。</div>' : '')
      + '</div>'
      // ── 结果行（Windows 的 `文件夹(F):` 那一行）──────────────────────────
      // 只读展示、可整块选中复制（排查"到底在哪一层"时很值钱）。
      // 没读出来时如实说"正在读取…"，不留一格空白 —— 空白会被读成"这里没有东西"。
      + '<div class="dlg-pathrow">'
      + '<span class="dlg-pathrow-label" aria-hidden="true">文件夹(F):</span>'
      + '<span class="dlg-path mono" title="' + esc(d.browsePath || '') + '">'
      + esc(d.browsePath || '正在读取…')
      + '</span>'
      + '</div>'
      + (d.browseError ? '<div class="dlg-err" role="alert">' + esc(d.browseError) + '</div>' : '')
      // 工作区名称的**结果**（不是输入框）。与提交时用的是同一个 `wbPathName`——
      // 提示里说叫什么，建出来就叫什么。空名（路径为空 / 盘根算不出末段）时如实说
      // "会叫「新工作区」"，而不是留一行空白让用户猜。
      + '<div class="dlg-name-hint">工作区名称：<b>' + esc(nameHint || '新工作区') + '</b>'
      + '<span class="faint">（取目录名；建好后可在左侧树上重命名）</span></div>'
      + '</div>';
  }

  // 只显示一次的值（API Key 明文）：用**只读 textarea** 而不是 alert() ——
  // 原生 alert 关掉就没了、也没法整块选中复制；textarea 里可以一键全选。
  const mono = d.mono
    ? '<textarea id="dlg-mono" class="dlg-mono" readonly rows="' + esc(String(d.monoRows || 3)) + '"'
      + ' spellcheck="false" aria-label="只显示一次的值">' + esc(d.mono) + '</textarea>'
    : '';

  return '<div class="modal-wrap dlg">'
    // 点遮罩 = 取消。遮罩是**独立的绝对定位层**（不是外框本身）：
    // 否则点面板内部也会冒泡到外框、把窗户关掉。
    + '<div class="dlg-backdrop"' + act('dlgCancel') + '></div>'
    // `kind-browse` 只为一件事存在：文件夹选择器要**宽**一些（Windows 那个框就是宽的，
    // 窄了目录名一眼就被截断）。用显式的 kind 类而不是 `:has()` —— 后者能少改一处，
    // 但"这个弹框宽在哪一条规则里"会变成一次推断，而类名是可以直接搜到的。
    + '<div class="modal dlg' + (d.kind === 'browse' ? ' kind-browse' : '') + '" role="dialog" aria-modal="true"'
    + ' aria-label="' + esc(d.title || '对话框') + '">'
    + '<h2>' + esc(d.title || '') + '</h2>'
    + (body ? '<div class="dlg-body">' + body + '</div>' : '')
    + field
    + (d.error ? '<div class="dlg-err" role="alert">' + esc(d.error) + '</div>' : '')
    + mono
    + (d.warn ? '<div class="note fail dlg-warn">' + esc(d.warn) + '</div>' : '')
    + '<div class="dlg-actions">'
    + (d.kind === 'notice' ? '' : '<button' + act('dlgCancel') + '>' + esc(d.cancel) + '</button>')
    + '<button id="dlg-ok" class="' + (d.danger ? 'danger' : 'primary') + '"'
    + act('dlgOk') + '>' + esc(d.ok) + '</button>'
    + '</div>'
    + '</div></div>';
}

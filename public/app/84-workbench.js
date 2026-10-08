/* STI HARNESS 前端 · 对话工作台
 * Copyright 2026 liwei（易智瑞西安）.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 对话工作台（P0-B）──────────────────────────────────────
 *
 * 与后台各页的关系：**并存**，不是替代。后台管"治理与配置"，工作台管"用"。
 *
 * 渲染策略（与后台页不同，值得说明）：
 *   后台页是"改数据 → render() 整页重绘"。这对聊天不适用 —— 每来一帧就整页重绘
 *   会把输入框里的字、滚动位置、展开的 details 全部打回原形。
 *   因此工作台采用**局部重绘**：`wbPaint()` 只更新 `#wb-stream` 的内容，
 *   输入框与右侧面板不受影响。整页 render() 只在结构变化（切会话/停止流）时发生。
 */

/* ── 图标集（0.21.7）────────────────────────────────────────────
 *
 * 此前这里的"图标"是一个个 Unicode 字形（⇤ ⌕ ⟳ ＋ ⋯ ▾ ▸ 📁 ▦ ⚙ ▤ ⊕ ↑ ⌫）。
 * 三个问题，全都是这一套散字带来的：
 *   1. **大小不一**：⇤ ⌕ ⟳ ▤ 这些符号出自不同字体块、基线各异，并排看着像大小不一；
 *   2. **字形缺失**：`⌗`（U+2317）在 Windows 中文字体里没有字形，真机渲染成豆腐块
 *      （0.21.2 真机层抓到过一次）；
 *   3. **语义靠猜**：`▤` / `▦` / `⌫` 各自能被读成好几种意思。
 *
 * 现在收成一套**内联 SVG**：同一个 16×16 视口、同一条线宽、`currentColor` 取色
 * （颜色仍由 CSS 决定，主题翻转自动跟随），尺寸由 `.wb-ico` 统一给。
 * 不引任何资源文件：`img-src 'self' data: blob:` 本来就允许内联 SVG。
 *
 * 用法：`wbIcon('folder')` 返回一段 `<svg>`；`cls` 传 `'sm'` 得到行内小号。
 */
const WB_ICONS = {
  // 工作区（文件夹）—— 左栏树与输入卡徽片共用同一个，两处形状必须一致
  folder: '<path d="M2 5.3c0-.7.5-1.2 1.2-1.2h2.4l1.4 1.7h5.8c.7 0 1.2.5 1.2 1.2v5.2c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2z"/>',
  // 新建工作区：文件夹 + 加号
  folderPlus: '<path d="M2 5.3c0-.7.5-1.2 1.2-1.2h2.4l1.4 1.7h5.8c.7 0 1.2.5 1.2 1.2v5.2c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2z"/><path d="M8 7.6v3.6M6.2 9.4h3.6"/>',
  // 树节点折叠 / 展开
  chevronRight: '<path d="M6.4 4.2 10.2 8l-3.8 3.8"/>',
  chevronDown: '<path d="M4.2 6.4 8 10.2l3.8-3.8"/>',
  // 过滤
  search: '<circle cx="7.2" cy="7.2" r="3.7"/><path d="M9.9 9.9 13.2 13.2"/>',
  // 行尾「＋」（新建会话 / 新建）
  plus: '<path d="M8 3.6v8.8M3.6 8h8.8"/>',
  // 行尾「⋯」（更多操作）—— 三个圆点，用圆头短笔画画，避免字体抖动
  more: '<path d="M3.9 8h.02M8 8h.02M12.1 8h.02"/>',
  // 左栏开合（矩形 + 左侧内栏）/ 右栏开合（镜像）
  sidebar: '<rect x="1.8" y="3.3" width="12.4" height="9.4" rx="1.2"/><path d="M6 3.3v9.4"/>',
  sidebarRight: '<rect x="1.8" y="3.3" width="12.4" height="9.4" rx="1.2"/><path d="M10 3.3v9.4"/>',
  // 管理后台（四格网格）
  grid: '<rect x="2.6" y="2.6" width="4.5" height="4.5" rx=".8"/><rect x="8.9" y="2.6" width="4.5" height="4.5" rx=".8"/><rect x="2.6" y="8.9" width="4.5" height="4.5" rx=".8"/><rect x="8.9" y="8.9" width="4.5" height="4.5" rx=".8"/>',
  // 设置（齿轮）
  // ⚠️ 这里返工过**两次**，原因值得记下来：
  //   第一版：半径 2.1 的小圆 + 8 根**与小圆分离**的短射线 —— 视觉上就是 ☀（太阳），
  //   用户读作"调亮度"。
  //   第二版：细圆环（r=3.8）+ 6 根短射线 + 轴心孔 —— 修掉了"分离"，但**齿还是线不是面**：
  //   细环配一圈径向短线，读感仍是太阳 / 表盘。用户看了一眼仍是"这不是齿轮"。
  //   第三版（本版）：**齿必须是面**。用一条闭合多边形同时勾出"齿顶 + 齿根环"的剪影
  //   （8 颗齿，齿顶 r=6.3 / 齿根 r=4.4），加轴心孔。真齿轮与太阳的分界线就一条：
  //   **齿占掉了周长的一大半**（这版齿宽 ≈ 周长 45%）—— 线状齿再密也到不了这个占比。
  //   候选是截图后肉眼定的（6/8/10 齿 × 三档齿深），8 齿这档在 16px 实际渲染下仍读得出齿形。
  //   外接框 1.8..14.2，与 sidebar / user 对齐（差 ≤0.4px），不破坏"尺寸要一致"。
  gear: '<path d="M6.89 1.8L9.11 1.8L9.15 3.75L10.19 4.18L11.6 2.83L13.17 4.4L11.82 5.81L12.25 6.85L14.2 6.89L14.2 9.11L12.25 9.15L11.82 10.19L13.17 11.6L11.6 13.17L10.19 11.82L9.15 12.25L9.11 14.2L6.89 14.2L6.85 12.25L5.81 11.82L4.4 13.17L2.83 11.6L4.18 10.19L3.75 9.15L1.8 9.11L1.8 6.89L3.75 6.85L4.18 5.81L2.83 4.4L4.4 2.83L5.81 4.18L6.85 3.75Z"/>'
    + '<circle cx="8" cy="8" r="1.5"/>',
  // 我的账号（单人）—— 收起态入口栏里那一项；不用头像首字，是为了四项保持同一尺寸
  user: '<circle cx="8" cy="5.6" r="2.6"/><path d="M2.9 13.4a5.1 5.1 0 0 1 10.2 0"/>',
  // 附件（回形针）
  clip: '<path d="M11.9 7.4l-4.5 4.5a3 3 0 0 1-4.3-4.3l4.9-4.9a2 2 0 0 1 2.9 2.9l-4.9 4.9a1 1 0 0 1-1.4-1.4l4.4-4.4"/>',
  // 单个文件（产物行）—— 一张折角的纸；与 folder 同一外接框，行内并排不会一高一矮
  file: '<path d="M9.3 1.9H4.9a1.2 1.2 0 0 0-1.2 1.2v9.8a1.2 1.2 0 0 0 1.2 1.2h6.2a1.2 1.2 0 0 0 1.2-1.2V5.1z"/>'
    + '<path d="M9.3 1.9v3.2h3"/>',
  // 发送 / 停止
  arrowUp: '<path d="M8 12.7V3.5M4.3 7.2 8 3.5l3.7 3.7"/>',
  stop: '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.2"/>',
};

/**
 * @param {string} name WB_ICONS 的键
 * @param {string} [cls] 额外类（`sm` = 行内小号）
 * @param {string} [title] 给了就带 `<title>`（图标本身无文字语义时，读屏器靠它）
 */
function wbIcon(name, cls, title) {
  const body = WB_ICONS[name] || '';
  return '<svg class="wb-ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 16 16" width="16" height="16"'
    + ' fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
    + ' aria-hidden="true" focusable="false">' + (title ? '<title>' + esc(title) + '</title>' : '') + body + '</svg>';
}

/**
 * 工具卡：状态 + 工具名 + 入参 + 结果。
 *
 * ⚠️ 0.21.10：**来源对账徽标整块删除**（用户裁定：工具由内核自己调用、
 *    不用单独写这个能力、也不会单独列出来有哪些工具）。
 *    这里从前还有一格「登记表：内置 / 未登记（上游未报告来源）」—— 它靠
 *    `wbAttributeTool(t.name, wbCatalog(State.wb))` 把这次调用去和**登记工具表**对账。
 *    登记表没有了，对账的另一端不存在，整件事随之不成立。
 *
 * ⚠️ 删掉的是**对账**，不是工具卡本身 —— 这一张卡回答的是"这一轮真的调了什么、
 *    入参是什么、结果是什么"，那是**会话事实**（来自事件流里的 `tool-call` /
 *    `tool-result`），和"企业登记过哪些工具"是两件事。前者照常显示，
 *    而且从前是唯一一处显示它的地方（右栏「实际调用」面板 0.21.7 已删）。
 *
 * ⚠️ `.wb-tool-head` 这个容器与它里面"状态徽标 + 工具名"两项**保持原样**：
 *    回归里逐个工具卡取 head 做断言，改了结构那条用例就会失去着力点。
 *
 * ⚠️ 0.21.10 名字兜底改口径：`t.name` 为空时不再一律渲染 `(未命名工具)`。
 *    那个占位符的成因是上游 `tool/result` 里**没有名字**（已由 callId 配对修掉，见
 *    上面的归并逻辑）；真出现空名时，说"未命名工具"是把**我们自己的缺口**说成
 *    上游的一种工具 —— 与"未归因/已归因"当年被删是同一类问题（见 30-util.js）。
 *    现在：有 id 就显示 `工具 #<id 尾 6 位>`（**如实**指认是哪一次调用，可与原始事件对照），
 *    连 id 都没有才写 `(名字与 id 都未报告)`。
 */
function wbToolHtml(t) {
  const status = t.status || (t.result != null ? 'ok' : 'running');
  const cls = status === 'ok' ? 'ok' : (status === 'error' || status === 'failed' ? 'fail' : 'dim');
  const label = status === 'running' ? '执行中' : (status === 'ok' ? '完成' : status);
  const name = t.name || (t.callId
    ? '工具 #' + String(t.callId).slice(-6)
    : '(名字与 id 都未报告)');
  let s = '<div class="wb-tool"><div class="wb-tool-head">'
    + '<span class="badge ' + cls + '">' + esc(label) + '</span>'
    + '<span class="mono wb-tool-name">' + esc(name) + '</span>'
    + '</div>';
  if (t.args != null) s += '<div class="wb-tool-row">入参　' + STIRender.toolJsonHtml(t.args) + '</div>';
  if (t.result != null) s += '<div class="wb-tool-row">结果　' + STIRender.toolJsonHtml(t.result) + '</div>';
  s += '</div>';
  return s;
}

/** 一条原始事件（落库语义事件；未知事件加 unknown 标记） */
function wbEventHtml(e) {
  // ⚠️ 工具事件的名字要**兜底**（0.21.10）：`tool/result` 本来就不带名字，
  //    直接拼 `e.tool.name` 会得到一行以空格开头的正文，看着像渲染坏了。
  //    这里与工具卡同口径：有名字用名字，只有 id 就显示 id（这是"哪一次调用"的凭据）。
  const toolLabel = (t) => t.name || (t.callId ? '#' + String(t.callId).slice(-6) : '(未报告名字)');
  const body = e.delta != null ? ('delta: ' + e.delta)
    : e.tool ? (toolLabel(e.tool) + ' ' + JSON.stringify(e.tool.args == null ? e.tool.result : e.tool.args))
      : e.usage ? JSON.stringify(e.usage)
        : (e.text || e.kind || '');
  return '<div class="ev' + (e.known === false ? ' unknown' : '') + '">'
    + '<span class="t">' + esc(e.seq) + '</span>'
    + '<span class="t">' + esc(e.type) + '</span>'
    + '<span>' + esc(body) + '</span></div>';
}

/* ── 实际调用 ↔ 清单对账：整块删除（0.21.10）─────────────────────────
 *
 * 这一段（0.20.0 引入）的完整思路留档，因为它是"两件事被混成一件"的典型标本：
 *
 *   工作台能看见「这一轮调了哪些工具」（工具卡）与「背后有哪些能力」（可用能力面板），
 *   但两者**从不相遇** —— 用户看到工具卡里的 `some.tool` 时，无从知道它属于哪一类能力
 *   （内置 / MCP / 技能），也无从知道它压根没被登记过。于是补了三个函数做归因：
 *     · `wbCatalog(w)`         —— 把三份清单收成一个对账用的小结构；
 *     · `wbAlsoIn(name, cat)`  —— 同名提示（"名字也在技能清单里"，只提示不断言血缘）；
 *     · `wbAttributeTool(...)` —— 单个工具名的三态归因（登记表命中 / 仅内核探测到 / 未登记）。
 *   归因只做**精确同名**，刻意不做前缀 / 子串匹配 —— 上游 `tool/call` 事件里根本没有
 *   来源字段（真事件只有 `name` / `arguments` / `callId`），按名字猜能造出看起来像
 *   事实的结论，这与 `normalizeEvent` 用 `known:false` 而不丢弃未知事件是同一条纪律。
 *
 * **为什么现在整块删掉**（用户裁定 2026-10-08：「工具是在内核自己调用，不用单独写这个
 * 能力，而且不会单独列出来有哪些工具」）：
 *   归因的**两端之一**是"登记工具表"，而那张表随本次改动整表删除 ——
 *   没有清单可对，对账这个动作就没有宾语。三态里有两态（登记表命中 / 未登记）
 *   直接失去依据，剩下"仅内核探测到"也不成立（内核根本没有工具清单 RPC）。
 *   所以这不是"界面少了一块"，是"这件事不成立"。
 *
 * ⚠️ 连带删除的还有：
 *   · `originText()` / `ORIGIN_LABEL`（30-util.js）—— 它翻译的是 `tools.origin`
 *     那三个取值（builtin | mcp | skill），而那个字段随登记表一起没了。
 *     保留一个只在注释里被提到的翻译表，会让下一个人以为 origin 还在某处被读。
 *   · `w.caps` 这次加载（71-app-workbench.js）—— 它此前**仅为这个对账**而拉取
 *     （0.21.7 右栏两个面板删掉时，它就是因为"工具卡来源徽标还要用"才留着的）。
 *     现在它没有任何读者了，见那边的注释。
 *
 * ⚠️ **保留**的一项：工具卡本身。它回答"这一轮真的调了什么、入参、结果"，
 *   那是事件流事实，与清单无关。删掉的是"拿它去对账"。
 */
/* ── wbCallsHtml / wbCollectCalls：整块删除（0.21.7）─────────────────
 *
 * 右栏「实际调用（本会话）」面板：把消息流里的工具调用聚合起来，逐行按登记清单
 * 「精确同名」对账（登记 / 仅探测到 / 未登记三态），并与工具卡上的徽标共用同一份判据。
 *
 * 用户裁定删除它的面板呈现（2026-10-06）。当时**保留**了
 * `wbAttributeTool` / `wbCatalog` / `wbAlsoIn`（工具卡上的来源徽标还在用）——
 * 注意这是**当时**的事实，不是现在的：0.21.10 连那三个函数也删了，见下。
 * 删掉的只是"把整会话的调用再列一遍"那一份重复呈现（对话流里本来就逐条看得见）。
 * 于是 `wbCollectCalls` 也没有调用方了，一并删（没有调用方的函数会一直被当成"平台的能力"）。
 *
 * ⚠️ 0.21.10 更新：当时保留下来的那三个函数与那句口径**现在也删了** ——
 *    它们的另一端（登记工具表）整表删除，见上面那一段。所以这一段注释里
 *    "徽标仍在用"的描述已经过期，留着原话是为了看清这条链是怎么一步步走完的：
 *    0.21.7 删掉了"重复列一遍"（呈现），0.21.10 删掉了"对账"本身（判据）。
 *    工具卡本身两次都没动 —— 它一直是那个"会话事实"。
 *
 * ⚠️ 那三个函数在 0.21.10 **只存在于注释里**，源码中一个都不剩 ——
 *    搜到本段命中时别以为它们还在。`test-frontend` 有一条反向断言钉着
 *    "工具卡上不该再有徽标"，所以谁把它们粘回来，回归会立刻响。
 */

/**
 * 附件注入正文与用户原始输入之间的**分界标记**。
 *
 * ⚠️ 与服务端 `app/http/routes/kernel.mjs` 的 `ATTACH_INJECT_BEGIN` **必须一字不差**，
 * 由 `test-frontend` 的契约对账用例钉住（两边都改才不红）。
 *
 * 为什么需要它：注入之后 `turn-start` 事件的 text 就是"用户输入 + 附件正文"，
 * 而工作台要把它回放成用户气泡。把 60KB 文件糊进气泡里没法用；
 * 假装用户只打了那几个字又是说谎。所以精确切两段：
 *   气泡 = 用户真正打的字 +「＋N 个附件已注入」，「轨迹」里仍是完整原文。
 */
const WB_ATTACH_MARKER = '\n\n<<<STI-ATTACHMENTS>>>\n';

/**
 * **识别用**的标记形态（前端只读不写；写出去的是上面那个字面量）。
 *
 * 为什么识别要放宽：更名前写进**落库原文**的标记用的是另一个产品名前缀，而那些
 * `turn-start` 事件的 text 已经躺在 append-only 的事件表里（不回写历史）。
 * 若这里只认规范标记，历史会话的气泡会把整段注入正文露出来 —— 数据没错，但没法看。
 * 于是：**写出去用规范标记，识别时按形态认** `<<<大写标识-ATTACHMENTS>>>`。
 *
 * ⚠️ 代价说清：标记识别从"等于常量"放宽为"形态匹配"。用户若在输入框里手打
 *    `<<<ABC-ATTACHMENTS>>>`，其后内容会被当注入段隐藏 —— 影响仅限该用户自己的显示，
 *    且这不是任何正常输入形态。换来的是历史会话仍可读。
 */
const WB_ATTACH_MARKER_RE = /<<<[A-Z0-9]+-ATTACHMENTS>>>/;

/**
 * 服务端 `app/http/routes/kernel.mjs` 的 `KB_INJECT_BEGIN` 副本 —— 与上面那条一样，
 * **必须一字不差**，由 `test-frontend` 的契约对账用例钉住。
 *
 * 0.14.0 起，一轮 content 的完整形状是：
 *
 *     用户原文 + <<<STI-KNOWLEDGE>>> + 知识段 + <<<STI-ATTACHMENTS>>> + 附件段
 *
 * 知识段排在**附件段之前**是有意的：用户原文仍在最前，气泡切分逻辑不变；
 * 而且人读起来也是"先看检索到的要点，再看附件全文"。
 */
const WB_KB_MARKER = '\n\n<<<STI-KNOWLEDGE>>>\n';

/** 识别用的知识标记形态（与 `WB_ATTACH_MARKER_RE` 同一条放宽理由）。 */
const WB_KB_MARKER_RE = /<<<[A-Z0-9]+-KNOWLEDGE>>>/;

/**
 * **剥掉平台注入段的通用形态**（只用于显示，不改数据）。
 *
 * ⚠️ 取的是**第一个**出现的标记，不是"分别剥两次"。因为注入段是**顺序拼接**的：
 * 先剥附件、后剥知识，就会出现"知识段在附件段之前，剥完附件却把知识段留在气泡里"，
 * 用户会在自己的提问气泡里看到一大段参考资料 —— 那是把发给模型的东西错当成用户打的字。
 * 认第一个标记，一次切干净。
 */
const WB_INJECT_MARKER_RE = /<<<[A-Z0-9]+-(?:KNOWLEDGE|ATTACHMENTS)>>>/;

/**
 * 图片清单那一行的形状（用于从落库原文里回放出"这轮带了几张图"）。
 *
 * ⚠️ 这是**第二条跨端契约**：必须与服务端 `app/platform/attachment/content.mjs`
 * 的 `describeImages()` 输出前缀"本轮随附 N 张图片"一字不差，
 * 同样由 `test-frontend` 的契约对账用例钉住。
 *
 * 为什么不另存一个字段（比如在 turn-start 事件里加 `imageCount`）：
 * 事件表是 append-only 的轨迹，加字段要迁移、要回填、还要考虑老数据。
 * 而"正文里写着几张图"与"当时真的送了几张图"本来就是同一件事的两个视图 ——
 * 从正文里读，就**不可能**出现"字段说 2 张、正文说 3 张"的矛盾。
 */
const WB_IMAGES_RE = /本轮随附 (\d+) 张图片/;

/** 从一条 turn-start 文本里剥掉平台注入的段落（只用于**显示**，不改数据） */
function wbStripInjected(text) {
  const s = String(text == null ? '' : text);
  const m = WB_INJECT_MARKER_RE.exec(s);
  return m ? s.slice(0, m.index) : s;
}

/**
 * 从一条 turn-start 原文里**数出本轮注入了几条知识片段**。
 *
 * 与附件数同一个做法（见 `WB_IMAGES_RE` 的注释）：**从落库正文里读，不另存字段**。
 * 于是"气泡显示 N 条"与"当时真注进去几条"是同一份事实的两个视图，
 * 不可能出现"字段说 3 条、正文只有 2 条"这种自相矛盾。
 *
 * 数的是知识段**内部**的 `[n] ` 行号 —— 必须先把范围切到"知识标记之后、
 * 附件标记之前"，否则附件段的正文里若出现行首 `[1] `（附件是 Markdown 时完全可能）
 * 就会被多算进去。
 */
function wbCountKbHits(text) {
  const s = String(text == null ? '' : text);
  const k = WB_KB_MARKER_RE.exec(s);
  if (!k) return 0;
  const rest = s.slice(k.index + k[0].length);
  const a = WB_ATTACH_MARKER_RE.exec(rest);
  const seg = a ? rest.slice(0, a.index) : rest;
  return (seg.match(/^\[\d+\] /gm) || []).length;
}

/**
 * 本轮挂载了几个知识库、实际参与检索了几个、命中几条、有没有值得说的 note。
 *
 * 数据来源有两个，**优先用实时的**（`msg.kb`，来自 `kind:'knowledge'` 帧），
 * 回放时退回落库正文里数出来的条数。两者不一致时以帧为准 —— 帧是服务端
 * 当场给出的结论，正文只是它的一个投影。
 */
function wbKbSummary(m) {
  if (m && m.kb) {
    return {
      mounted: (m.kb.kbIds || []).length,
      used: (m.kb.usedKbIds || []).length,
      hits: (m.kb.hits || []).length,
      dropped: Number(m.kb.dropped) || 0,
      notes: m.kb.notes || [],
      elapsedMs: m.kb.elapsedMs,
    };
  }
  if (m && m.kbCount) {
    return { mounted: null, used: null, hits: m.kbCount, dropped: 0, notes: [], elapsedMs: null };
  }
  return null;
}

/** 新的助手消息壳（含流式与历史回放共用的字段） */
function wbNewAssistant(id) {
  return {
    id: id, role: 'assistant',
    text: '', reasoning: '', finals: [], tools: [],
    usage: null, error: '', streaming: false, events: [], attach: null,
  };
}

/**
 * 上游以 `message user` 事件回放的**注入上下文**（不是用户打的字）：
 * 平台/上游的运行时上下文快照与技能提醒。它们是轨迹材料，不进气泡、不进正文。
 * 用前缀识别 —— 与 `wbStripInjected` 的 `<attachment ` 标记是同一类做法：
 * 显示层按标记化简，数据层保留原文。
 */
const WB_INJECTED_MSG_RE = /^Current runtime context\.|^<system-reminder>/;

/** 把用户真正打的字并进**最近一条用户气泡**；没有气泡（turn-start 没带文本的上游）
 *  就在本条助手消息前面**插一个** —— 气泡是显示层的必需品，不能让用户的话没有落点。 */
/**
 * 把一条 user 事件的原文拆成「气泡该显示的」与「徽标该显示的」。
 *
 * **历史回放与实时路径共用这一份拆分** —— 不共用就会"正在看直播"与"切回来看重放"
 * 长成两个样子（0.15.1 真机抓到的正是这个：回放剥了注入段、实时没剥，
 * 于是用户在自己的提问气泡里看到整段知识库参考资料，而且原话还重复了两遍）。
 */
function wbSplitUserText(raw) {
  const t = String(raw == null ? '' : raw);
  const stripped = wbStripInjected(t);
  const injected = t === stripped ? 0 : (t.match(/<attachment /g) || []).length;
  const imgMatch = WB_IMAGES_RE.exec(t);
  return {
    text: stripped,
    attachCount: injected,
    attachImages: imgMatch ? Number(imgMatch[1]) : 0,
    kbCount: wbCountKbHits(t),
  };
}

function wbAppendToUserBubble(msgs, rawText, beforeMsg) {
  const parts = wbSplitUserText(rawText);
  const t = parts.text;
  if (!t.trim()) return;
  // 只认**同一回合**里的气泡：助手块按回合创建（回放按 turn-start、实时按提交），
  // 所以从 beforeMsg 往前扫，一跨过上一回合的助手块就停。
  // 否则"turn-start 不带文本"的上游（真实形态）会把每一轮的提问
  // 全都并进第一个气泡 —— 历史越聊越长，全糊成一个气泡（真机抓到）。
  const at = beforeMsg ? msgs.indexOf(beforeMsg) : -1;
  for (let i = (at >= 0 ? at : msgs.length) - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') break;   // 上一回合的边界
    if (msgs[i].role === 'user') {
      const cur = String(msgs[i].text || '');
      // 回显去重：实时路径在发送时已把用户输入放进气泡（本地乐观更新），
      // 上游随后回放的同一句话不能再贴一遍。
      if (!cur.includes(t)) msgs[i].text = cur ? cur + '\n' + t : t;
      // 徽标是"这一轮到底注入了什么"的事实 —— 就算原话重复（去重跳过），徽标也要跟上：
      // 乐观气泡在发送时还不知道检索结果有几条，只有上游回放的事件里有。
      msgs[i].kbCount = Math.max(Number(msgs[i].kbCount) || 0, Number(parts.kbCount) || 0);
      msgs[i].attachCount = Math.max(Number(msgs[i].attachCount) || 0, Number(parts.attachCount) || 0);
      msgs[i].attachImages = Math.max(Number(msgs[i].attachImages) || 0, Number(parts.attachImages) || 0);
      return;
    }
  }
  if (beforeMsg && msgs) {
    const at2 = msgs.indexOf(beforeMsg);
    msgs.splice(at2 >= 0 ? at2 : msgs.length, 0, Object.assign(
      { id: 'h-u-x-' + (beforeMsg.seq || msgs.length), role: 'user', text: t, rawText: String(rawText == null ? '' : rawText) },
      parts,
    ));
  }
}

/**
 * 把一条语义事件并入助手消息 —— **流式与历史回放共用这一份逻辑**。
 * 共用是刻意的：否则"正在实时接收"与"切回来看到的回放"会长成两个样子。
 *
 * 0.15.1：`message` 事件要**按角色分拣**（0.15.0 真机审计抓出）——
 * 上游会把系统提示词（role=system）、注入的运行时上下文与技能提醒（role=user）
 * 全都以 message 事件回放；不分拣的话，"最新消息"面板会把系统提示词原文
 * 当成助手发言亮给用户。助手块的正文只收 role=assistant 的文本。
 */
function wbApplyEvent(msg, ev, msgs) {
  if (!ev) return;
  msg.events.push(ev);
  if (ev.type === 'reasoning' && ev.delta) {
    msg.reasoning += ev.delta;
  } else if (ev.type === 'message') {
    const role = ev.role || 'assistant';
    if (role === 'system') {
      // 系统提示词等系统级注入：是轨迹不是对话（要看原文去「轨迹」折叠里）。
    } else if (role === 'user') {
      const t = String(ev.text || '');
      if (t && !WB_INJECTED_MSG_RE.test(t)) wbAppendToUserBubble(msgs, t, msg);
    } else {
      // 思考过程与正文是**两个字段**（0.15.1 起契约层按上游块类型拆开）：
      // 思考进折叠区，正文才是答案。此前全部拼进 text，用户会先读到一段
      // 模型的英文自我推演，答案混在里面。
      if (ev.reasoning) msg.reasoning += (msg.reasoning ? '\n' : '') + String(ev.reasoning);
      if (ev.delta) msg.text += ev.delta;
      else if (ev.text && String(ev.text).trim() && !msg.text.includes(String(ev.text))) {
        // 完整文本块（非增量）：去重后单列，避免与已累积的 delta 重复显示
        msg.finals.push(String(ev.text));
      }
    }
  } else if (ev.type === 'tool-call') {
    msg.tools.push({
      name: (ev.tool && ev.tool.name) || '', args: ev.tool ? ev.tool.args : null,
      result: null, status: (ev.tool && ev.tool.status) || 'running',
      // 配对 id（0.21.10）：`tool/call` 与 `tool/result` 各带一半，靠它把结果并回**正确**那张卡
      callId: (ev.tool && ev.tool.callId) || null,
    });
  } else if (ev.type === 'tool-result' && ev.tool) {
    // ⚠️ 配对的**第一判据是 callId**，名字只在"上游没给 id"时兜底。
    //
    // 为什么必须改成这样（0.21.10 抓出的真 bug）：
    //   · 上游 `tool/result` 事件里**根本没有工具名**（真事件只有
    //     `message.toolCallId` / `content` / `isError`），只有 `tool/call` 带 `name`。
    //   · 此前只用**名字相等**配对 —— 空名对不上任何卡，于是每调一次工具就
    //     **凭空多出一张 (未命名工具) 的孤儿卡**；更坏的是它带着 `status: 'ok'`，
    //     看起来像"有一个名字显示不出来的工具跑完了"。
    //   · 同一轮**两次调同名工具**时，第二个 result 会并到第一张已完成的卡上
    //     （倒序找第一张 `result == null` 的），于是两张卡的结果张冠李戴。
    //   · 真上游一直给着 `toolCallId`，它与 call 侧的 `callId` 是同一个值 ——
    //     配对凭据一直都在，只是此前没取出来。
    const cid = ev.tool.callId || null;
    let t = null;
    if (cid) {
      for (let i = msg.tools.length - 1; i >= 0; i--) {
        if (msg.tools[i].callId === cid) { t = msg.tools[i]; break; }
      }
    }
    if (!t) {
      // 兜底：没有 id（老数据 / 上游改版）才退回按名字找最近一张未完成的卡。
      // 名字为空时**不**参与兜底 —— 否则又会退化成"任意一张卡对上任意一个空名"。
      const nm = ev.tool.name || '';
      if (nm) {
        for (let i = msg.tools.length - 1; i >= 0; i--) {
          if (msg.tools[i].name === nm && msg.tools[i].result == null) { t = msg.tools[i]; break; }
        }
      }
    }
    if (!t) {
      // 只有**确实拿到了名字或 id**才新建卡。两者都没有时这张卡没有任何可显示的信息
      // （名字空、也没有入参），建出来就是一张 (未命名工具) —— 那正是要消灭的东西。
      // 上游真给了这样一条事件时，它会在下面的原始事件列表里照样看得见，不会丢。
      if (cid || ev.tool.name) {
        t = { name: ev.tool.name || '', args: ev.tool.args, result: null, status: 'running', callId: cid };
        msg.tools.push(t);
      }
    }
    if (t) {
      t.result = ev.tool.result == null ? '' : ev.tool.result;
      t.status = ev.tool.status || 'ok';
      // 名字能补上就补：result 侧通常没有名字，个别上游会补一个
      if (!t.name && ev.tool.name) t.name = ev.tool.name;
    }
  } else if (ev.type === 'usage' && ev.usage) {
    msg.usage = ev.usage;
  } else if (ev.type === 'error') {
    msg.error = ev.text || '本轮出错';
  }
}

/** 已落库事件 → 消息流（按 turn-start / turn-end 切分回合） */
function wbMessagesFromEvents(list) {
  const msgs = [];
  let cur = null;
  // 两个布尔量，管的是**两件不同的事**，别合并（合并过一次，见下面 ⚠️）：
  //
  //   · `sawTurnStart`：**整个流**里见过 turn-start 没有。
  //     它回答的是"这条流到底有没有回合边界"。没有边界（上游只给了中段事件、
  //     流被截断）时，回合外的零散事件**仍要收下来**，否则整轮内容凭空消失。
  //
  //   · `inFirstTurn`：**已经进过第一个回合**没有。
  //     它回答的是"现在还在不在开头那段噪声里"。开头那段（第一个 turn-start
  //     之前的 lifecycle）要整段丢掉 —— 用户 2026-10-08：「每个会话最开始的
  //     闪烁的 wb-caret.idle 直接删掉」。
  //
  // ⚠️ 这两个量看着像，判的事完全不同：前者管"流有没有边界"，后者管"进没进第一个回合"。
  //    用前者去代替后者（`!cur && !sawTurnStart`）是**错的** —— 那会把"流被截断"
  //    那种情况也当成开头噪声一起丢掉，整轮内容消失。改这里之前先读这段。
  let sawTurnStart = false;
  let inFirstTurn = false;
  for (const ev of (list || [])) {
    if (!ev) continue;
    if (ev.type === 'turn-start') {
      sawTurnStart = true;
      inFirstTurn = true;
      // 气泡只显示**用户真正打的字**：平台拼进去的附件正文（有标记）在这里剥掉。
      // 轨迹（助手块里的「轨迹」折叠）仍然是完整原文 —— 显示层可以化简，数据层不许。
      // 注入附件数**从落库原文里数出来**，而不是另存一个字段：回放时不依赖任何额外状态，
      // 且"标记在 = 当时真注入过"是同一份事实的两个视图，不会互相矛盾。
      // 与实时路径共用同一份拆分（见 wbSplitUserText 的说明）——
      // 这里曾是一份手写的重复实现，实时路径没剥注入段就是那次漂移的产物。
      const parts = ev.text ? wbSplitUserText(ev.text) : null;
      if (parts) {
        msgs.push({
          id: 'h-u-' + ev.seq, role: 'user', text: parts.text, rawText: ev.text,
          seq: ev.seq, attachCount: parts.attachCount,
          attachImages: parts.attachImages,
          kbCount: parts.kbCount,
        });
      }
      cur = wbNewAssistant('h-a-' + ev.seq);
      // 知识条数要**传给本轮的助手块**：知识检索回执卡片渲染在助手块上（它是
      // "这轮答案的输入侧事实"）。回放时没有 `kind:'knowledge'` 帧（那是实时流的
      // 增量帧，不落库），若不从 turn-start 继承，同一条消息就会出现
      // "实时看得到引用卡片、切走再切回来就没了"的不一致。
      // ⚠️ 没有 turn-start 文本（纯附件轮）时必须归零 —— 沿用上一轮的值是错的。
      cur.kbCount = parts ? parts.kbCount : 0;
      cur.events.push(ev);
      msgs.push(cur);
      continue;
    }
    // ── 回合边界之后的"无主事件"：**丢掉，不新开助手块**（0.21.9 修）──────
    //
    // 用户 2026-10-08 真机报：「对话完之后显示的样式没有 wb-caret idle，
    // 切换会话或者刷新页面后这条对话才出现这个样式」+「正文好好的，下面多出一个
    // 空心长条（像光标，带高亮色，会慢慢呼吸闪烁）」。
    //
    // 根因**不是**渲染层，是这里：上游的会话日志里，**每个 turn-end 后面还跟着
    // 若干 lifecycle 事件**（真机落库实测：某会话 10 次 turn-end，10 次后面都紧跟
    // 一个 lifecycle，一个不落；事件类型分布 lifecycle 68 / message 27 / turn-start 11
    // / turn-end 11）。上面的 `if (ev.type === 'turn-end') cur = null;` 一清空游标，
    // 紧接着的 lifecycle 就走到下面那句"游标为空就新开一个助手块"，
    // **凭空造出一个没有正文的助手块** —— 它渲染出来正好就是一个
    // 光秃秃的 `wb-caret.idle`（那个会呼吸的空心长条）。
    // 每轮后面一个，于是用户看到"正文还在、下面多一个光标"。
    //
    // 为什么**实时**看不到：实时走 `/turns/stream`，lifecycle 不落流（只进本地库），
    // 而且实时路径**不按 turn-end 切块**。所以同一个会话"实时一份、回放另一份"，
    // 回放那边每轮多一个空块 —— 这正是用户说的"两套样式"。
    //
    // 判据为什么**不是**"type === 'lifecycle' 就丢"（本段的主体）：
    //   ① 认事件类型是治标 —— 将来上游再加一种回合后事件，同一个 bug 原样复现；
    //   ② `turn-start` 已经出现过，就说明这条流**有**回合边界，那么"边界之外
    //      的事件"就是无主的，无主即丢弃。这是下面 `sawTurnStart` 那条判据；
    //   ③ 而 `turn-start` 从未出现（上游只给了中段事件 / 流被截断）时，
    //      那些事件是**有主的、只是边界丢了** —— 必须新开块把它们收下来，
    //      否则整轮内容会凭空消失。这就是 `sawTurnStart` 必须为假的含义：
    //      "没见过 turn-start"时**不许**把回合外事件判成无主。
    //
    // ── 会话开头那批事件：整段丢掉（0.21.9，用户第二次裁定）──────────────
    //
    // 用户 2026-10-08：「每个会话最开始的闪烁的 wb-caret.idle 直接删掉」。
    //
    // 那就是**第一个 turn-start 之前**那批 `lifecycle` 落成的空块：真机落库实测
    // 某会话的前几条就是 `lifecycle`（seq 4-18 全是），第一个 `turn-start` 在第 5 条。
    // 那个块没有正文 → 渲染成一个孤立的 `wb-caret.idle`，**挂在会话最上面**、
    // 一进会话就看见它在呼吸。
    //
    // 判据为什么是"第一个回合之前"而不是"`type === 'lifecycle'` 就丢"：
    //   · 用户要删的是"会话最开头那个光标"，它成立的唯一条件是"它前面没有任何一轮"；
    //   · 认事件类型是治标 —— 上游将来再加一种开头事件，同一个 bug 原样复现
    //     （与上面 ② 的同一条理由）。
    //
    // ⚠️ 注意"第一个回合之前"这句话有两种读法，这里取**后者**：
    //    (a) "整个流里还没见过 turn-start"（= `!sawTurnStart`）→ 会把**流被截断**
    //        （上游只给了中段事件）那种情况也一起丢掉 —— 那是错的，
    //        因为那样一丢，"整轮内容凭空消失"，见上面 ③。
    //    (b) "**本轮之前**确实有过 turn-start，但现在还没进第一个回合" —— 这才是
    //        要丢的开头噪声。这就是 `!inFirstTurn` 表达的东西。
    //    两个量在代码上必须分开：`sawTurnStart` 用于"流有没有回合边界"，
    //    `inFirstTurn` 用于"在不在开头那段"。用前者代替后者就是读法 (a)，是曾被写错过的形式。
    //
    // ⚠️⚠️ 0.21.12 修正：`!inFirstTurn` **单独一条并不够**，它是循环内的**后置**量 ——
    //    在"这条流从头到尾没有 turn-start"（流被截断 / 上游只给了中段事件）时，
    //    它恒为 false，于是**每一条事件都被当成开头噪声丢掉**，`msgs` 回来是空的。
    //    这正是读法 (a) 的后果，只是这次不是"用 `!sawTurnStart` 代替 `!inFirstTurn`"
    //    这种写法错误，而是 `!inFirstTurn` 在这种流上**恰好恒真**（同一件事从另一条路回来）。
    //    判据修正：开头噪声之所以是噪声，前提是"**后面还有正经回合**" —— 也就是说
    //    这条流**至少存在一个 turn-start**。整条流一个都没有时，"开头"这个概念不成立，
    //    此刻的每一条事件都是仅有的内容，必须收下来（`hasTurnBoundary` 为此预扫一次）。
    //    预扫而不是靠循环内的 `sawTurnStart`：后者只说明"到此刻为止见过"，
    //    而"这条流有没有回合边界"是**整条流**的属性，必须在进循环之前就知道。
    const hasTurnBoundary = (list || []).some((ev) => ev && ev.type === 'turn-start');
    //
    // 回合一：还没进过第一个回合 → 这是会话开头那批噪声，整段丢掉。
    if (!cur && !inFirstTurn && hasTurnBoundary) continue;
    // 回合二：见过 turn-start（= 这条流有回合边界）而游标是空的 → 这是回合边界之外的
    // 无主事件，丢掉。（`sawTurnStart` 只在"流被截断"时才为假；那种情况下游标虽空，
    // 事件却有主，要落到下面那句新开块里收着。）
    if (!cur && sawTurnStart) continue;
    if (!cur) {
      cur = wbNewAssistant('h-a-' + ev.seq); msgs.push(cur);
    }
    wbApplyEvent(cur, ev, msgs);
    if (ev.type === 'turn-end') cur = null;
  }
  // 回放出来的助手消息也要能定位到事件 seq（会话内检索的"跳过去"要靠它）
  for (let i = 0; i < msgs.length; i++) {
    if (!msgs[i].seq && msgs[i].events && msgs[i].events.length) msgs[i].seq = msgs[i].events[0].seq;
  }
  return msgs;
}

/**
 * 消费 NDJSON 响应体，逐行解析并回调。
 *
 * 兜底：环境不支持 `res.body`（或其不是可读流）时退化为"等整包再解析"——
 * 那不是流式，但也不该让功能整体不可用。前端不做假装：若走了兜底，
 * 用户看到的仍是最终结果（只是没有逐字出现的过程）。
 */
async function wbConsumeStream(res, onFrame) {
  const dec = new TextDecoder();
  let buf = '';
  const feed = (text) => {
    buf += text;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let f = null;
      try { f = JSON.parse(line); } catch (e) { continue; }   // 半行/坏行跳过，不炸整轮
      onFrame(f);
    }
  };
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      feed(dec.decode(step.value, { stream: true }));
    }
  } else {
    feed(await res.text());
  }
  if (buf.trim()) { try { onFrame(JSON.parse(buf)); } catch (e) { /* 尾部残行 */ } }
}

/** 一条消息：用户气泡 / 助手块（含推理、正文、工具卡、用量、轨迹） */
/**
 * 一轮里"这一轮带进去/取回了什么"的计数条（0.21.9 起住在**轨迹**里）。
 *
 * 附件与知识注入的存在必须看得见：否则用户无法区分"这一轮带了文件"和"这一轮只是
 * 打了几个字"，而这两件事在账上（token 数）差别很大。
 * 而且**图片与文件必须分开说** —— 它们的结局根本不同：
 *   图片  = 作为图片内容块提交，模型**能直接看到**；
 *   文本  = 正文被拼进 prompt，模型读到的是文字；
 *   （通用文件既不送字节也不送路径，会出现在助手块里的附件回执里）
 * 把三者混成一句"＋N 个附件"会掩盖这个差别。
 *
 * ⚠️ 0.21.9 它从**用户气泡下面**搬进轨迹：用户裁定"消息流里只留正文"。
 *    气泡旁边挂一行"＋ 2 条知识库片段已注入本轮上下文"，读起来像用户自己说的话，
 *    而它其实是平台的动作 —— 归到轨迹里，主语才对得上。
 */
function wbInjectReceiptHtml(m) {
  const nImg = Number(m.attachImages) || 0;
  const nInj = Number(m.attachCount) || 0;
  const nKb = Number(m.kbCount) || (m.kb && m.kb.hits ? m.kb.hits.length : 0);
  if (!nKb && !nImg && !nInj) return '';
  const parts = [];
  if (nKb) parts.push('＋ ' + nKb + ' 条知识库片段已注入本轮上下文');
  if (nImg) parts.push('＋ ' + nImg + ' 张图片已作为图片块送给模型');
  if (nInj) parts.push('＋ ' + nInj + ' 个附件正文已注入本轮上下文');
  return '<div class="wb-attach-receipt">' + esc(parts.join('　·　')) + '</div>';
}

/**
 * 这一条助手消息在**消息流这一侧**有没有可显示的内容（0.21.12 补）。
 *
 * 为什么需要它：`wbStreamHtml` 要丢掉"会话最开头那个空孤儿块"，而"空"必须与
 * **渲染层真正会画什么**用同一个判据 —— 否则两处各自演化，必然出现
 * "判据说空、渲染层其实画得出来"（于是内容被丢掉）或反过来的假绿。
 *
 * 判据**故意**只覆盖消息流这一侧会画的两样东西（正文 / 错误）：
 *   · 正文 = `m.text` 剥掉平台注入段之后，加上 `m.finals` 各段 —— 与 `wbMsgHtml` 逐字同一份拆分；
 *   · 错误 = `m.error`（它是"只留正文"里唯一一处刻意的例外）。
 * ⚠️ **不含**推理 / 工具卡 / 用量 —— 它们住在「轨迹」页签（`wbTraceMsgHtml`），
 *    不属于这一侧的可见内容。把它们算进来会得到"明明什么都没画却说有内容"，
 *    于是开头那个纯粹的 lifecycle 空块（它带 events，但不带正文）就删不掉了 ——
 *    那正是用户报的"每个会话最开始闪烁的光标"。
 *    简言之：**这一侧画什么，这里就只认什么。**
 */
function wbMsgHasContent(m) {
  if (!m || m.role === 'user') return true;
  if (m.error) return true;
  const body = [wbStripInjected(m.text)].concat((m.finals || []).map((x) => wbStripInjected(x)))
    .filter(Boolean).join('\n\n');
  return !!body;
}

/**
 * 消息流里的一条消息（0.21.9 起**只画正文**）。
 *
 * 用户在 2026-10-08 分两步把这件事说定的（两次都记下来，因为中间的半成品很容易被当成设计）：
 *   ①「轨迹要显示在会话内容中吗，不能在右侧显示一个选项卡对话、轨迹分开（这个是参考原生 dsh）」
 *      → 裁定：**消息流只留正文，工具卡与轨迹拆出去**。
 *   ②「轨迹不要放到右侧栏，放到会话框中（会话框中选项卡对话、轨迹）」
 *      → 拆出去之后放在**哪**：不是右栏，而是**这个会话框自己的一个选项卡**。
 *
 * 所以这个函数现在只产出两样东西：
 *   · 用户气泡（用户自己打的字，以及"仅附件"这个如实说法）；
 *   · 助手正文（安全 markdown 子集渲染）+ 出错时的红条。
 * 知识库检索回执 / 推理过程 / 工具卡 / 附件回执 / 用量徽标 / 原始事件折叠
 * **全部**搬去了 `wbTraceMsgHtml`（同一份数据，两个视图）。
 *
 * ⚠️ 错误（`m.error`）**留在正文这一侧**：那不是"轨迹材料"，是这一轮失败了 ——
 *    用户不该为了看见失败去翻另一个选项卡。这是"只留正文"里唯一一处刻意的例外。
 *
 * ⚠️ 0.21.9：这里**不再产出任何操作按钮**（「重生成」已按用户裁定整块删除，
 *    理由见 71-app-workbench.js 里 `wbRegenerate` 那段删除说明 —— 要点是
 *    "再跑一轮"与输入卡里重新发一次**是同一件事**，摆在消息底下等于
 *    同一件事有两个入口，而且它有个只有作者知道的副作用：不撤销上一轮）。
 *    因此本函数不再需要 `i` / `total` 两个参数。
 */
function wbMsgHtml(m) {
  const seqAttr = m.seq ? ' data-seq="' + Number(m.seq) + '"' : '';
  if (m.role === 'user') {
    return '<div class="wb-msg user"' + seqAttr + '><div class="wb-bubble">' + esc(m.text || '（仅附件）') + '</div></div>';
  }
  let inner = '';
  // 助手正文同样要剥注入段：mock 内核会**原样回显**收到的 content（"(mock) 收到：…"
  // 后面跟着整段知识资料），把回答糊成一大片；真实模型不会复读资料，
  // 但兜底剥一次没有代价（不含标记时原样返回）。
  // 与用户气泡同一条纪律：显示层可以化简，数据层不许 —— 轨迹里仍是完整原文。
  const body = [wbStripInjected(m.text)].concat((m.finals || []).map((x) => wbStripInjected(x)))
    .filter(Boolean).join('\n\n');
  if (body) {
    // 0.19.0：助手正文走安全 markdown 子集渲染（先转义后变换，见 79-wb-render.js）；
    // 流式中途的不完整语法按字面显示，光标仍挂在末尾。
    inner += '<div class="wb-text wb-md">' + STIRender.renderMarkdown(body) + (m.streaming ? '<span class="wb-caret"></span>' : '') + '</div>';
  }
  // 错误**留在正文这一侧**（0.21.9 唯一一处刻意的例外）：失败不是"轨迹材料"，
  //    用户不该为了看见"这一轮挂了"去翻另一个 tab。
  if (m.error) inner += '<div class="note fail">' + esc(m.error) + '</div>';
  if (!inner) {
    // 这一轮助手**一个字的回复都没有**（只调用了工具 / 只产生了推理）时，
    // 消息流这一侧**只留一个转圈光标**，不再写任何句子。
    //
    // ⚠️ 这里删掉过两版措辞，两版都别再写回来（用户 2026-10-08 的两次裁定）：
    //   第一版「（本轮没有正文 —— 推理与工具调用见右侧「轨迹」）」
    //     → 用户：「"没有正文"是什么意思」。三个毛病："正文"是平台内部叫法，
    //       界面上别处没用过；只说了"没有"没说为什么；指路方向半天就过时了。
    //   第二版「这一轮没有文字回复 —— 过程记在「轨迹」选项卡里。」
    //     → 用户：「什么叫没有文字回复，有歧义，直接去掉这行文字」。
    //       歧义在哪：**平台并不知道模型有没有"做过文字回复"** —— 这一侧没有正文，
    //       只说明助手这一段内容为空（工具卡与推理都在轨迹里），
    //       把它写成"没有文字回复"等于替模型下了一个它没法证的结论。
    //
    // 所以现在的口径是：**没有正文就什么都不说**。想过程去哪了，
    // 就在会话框上切「轨迹」选项卡 —— 那是这个会话自己的第二页，
    // 不需要一句会过期的指路语，也不需要替模型下结论。
    inner = m.streaming
      ? '<span class="faint">正在等待模型响应<span class="wb-caret"></span></span>'
      : '<span class="wb-caret idle"></span>';
  }
  return '<div class="wb-msg assistant"' + seqAttr + '>' + inner + '</div>';
}

/* ── 会话框里的「轨迹」选项卡（0.21.9）────────────────────────────────
 *
 * 这里装的是从消息流里**搬出来**的那几块：知识库检索回执 / 推理过程 / 工具卡 /
 * 附件回执 / 用量徽标 / 原始事件折叠。搬的理由与边界写在 `wbMsgHtml` 的头注释里。
 *
 * ⚠️ 它一度住在**右栏**（0.21.9 的第一版），被用户否掉了：
 *    「轨迹不要放到右侧栏，放到会话框中（会话框中选项卡对话、轨迹）」。
 *    否得对 —— 轨迹是**这个会话的内容**，右栏装的是"会话旁边的材料"（用量 / 产物）。
 *    放在右栏等于把会话的一部分挪到了会话外面。
 *
 * 一条纪律：**同一份数据、两个视图**，不是两份数据。轨迹里的这些块用的还是
 * 消息对象上的同一批字段（`m.kb` / `m.reasoning` / `m.tools` / `m.attach` / `m.usage`
 * / `m.events`），所以"正文里说的"与"轨迹里说的"不可能对不上。
 * 这也意味着**轨迹不需要自己的接口** —— 它读的就是 `State.wb.msgs`。
 */

/** 轨迹里的一段：知识库检索回执（0.14.0 起的内容，0.21.9 换了个容器） */
function wbTraceKbHtml(m) {
  const kbs = wbKbSummary(m);
  if (!kbs) return '';
  const bits = [];
  if (kbs.used != null) bits.push('检索 ' + kbs.used + ' 个库');
  else if (kbs.mounted != null) bits.push('挂载 ' + kbs.mounted + ' 个库');
  if (kbs.hits) bits.push('命中 ' + kbs.hits + ' 条');
  else bits.push('未命中相关片段');
  if (kbs.dropped) bits.push('另有 ' + kbs.dropped + ' 条因预算未注入');
  if (kbs.elapsedMs != null) bits.push(kbs.elapsedMs + ' ms');
  let html = '<div class="wb-kb"><div class="wb-kb-head">'
    + '<span class="badge ' + (kbs.hits ? 'ok' : 'dim') + '">知识库</span> '
    + esc(bits.join('　·　')) + '</div>';
  if (kbs.notes && kbs.notes.length) {
    html += '<div class="faint">' + esc(kbs.notes.join('；')) + '</div>';
  }
  const hits = (m.kb && Array.isArray(m.kb.hits)) ? m.kb.hits : [];
  if (hits.length) {
    html += '<details class="wb-raw"><summary>引用的片段（' + hits.length + '）</summary><div class="events">'
      + hits.map((h) => '<div class="ev' + (h.locationKnown ? '' : ' unknown') + '">'
        + '<span class="t">[' + esc(h.n) + ']</span>'
        + '<span>' + esc(h.label) + '</span>'
        + '<span class="faint">'
        + (h.score != null ? 'rrf ' + esc(String(h.score)) : '')
        + (h.truncated ? ' · 已截断' : '')
        + (h.locationKnown ? '' : ' · 无定位信息')
        + '</span></div>').join('')
      + '</div></details>';
  }
  return html + '</div>';
}

/**
 * 轨迹里的一段：附件回执（服务端逐条回报"送出了哪些、注入了哪些、跳过了哪些"）。
 *
 * ⚠️ 四个数组全部容错取 —— 这里曾是 `at.sent.length` 直接读，done 帧的 attach
 * 一旦缺 `sent` 字段（已修，但保不齐哪天又漂移），渲染函数抛 TypeError，
 * **整页 render 崩掉、DOM 冻结在旧状态**。渲染层是显示的最后防线，不许崩。
 * （这条注释随代码搬过来：搬了家，风险一点没少。）
 */
function wbTraceAttachHtml(m) {
  const at = m.attach || null;
  const atSent = (at && at.sent) || [];
  const atInjected = (at && at.injected) || [];
  const atSkipped = (at && at.skipped) || [];
  const atMissing = (at && at.missing) || [];
  if (!at || !(atSent.length || atInjected.length || atSkipped.length || atMissing.length)) return '';
  let html = '<div class="wb-attach-receipt">';
  if (atSent.length) {
    html += '<div>已作为图片块送给模型：' + atSent.map((a) => esc(a.name)
      + ' <span class="faint">(' + esc(String(a.mediaType || '').replace(/^image\//, ''))
      + ' · ' + esc(fmtBytes(a.bytes)) + ')</span>').join('、') + '</div>';
  }
  if (atInjected.length) {
    html += '<div>附件正文已注入：' + atInjected.map((a) => esc(a.name)).join('、') + '</div>';
  }
  if (!atSent.length && !atInjected.length) html += '<div>没有附件被交给模型</div>';
  if (atSkipped.length) {
    html += '<div class="faint">未提交：' + atSkipped.map((s) => esc(s.name) + '（' + esc(s.note) + '）').join('；') + '</div>';
  }
  if (atMissing.length) {
    html += '<div class="faint">未找到（可能已被删除）：' + atMissing.map(esc).join(', ') + '</div>';
  }
  return html + '</div>';
}

/** 轨迹里的一段：这一轮的用量徽标 */
function wbTraceUsageHtml(m) {
  if (!m.usage) return '';
  return '<div class="wb-usage">'
    + '<span class="badge dim">输入 ' + fmtN(m.usage.input) + '</span>'
    + '<span class="badge dim">输出 ' + fmtN(m.usage.output) + '</span>'
    + (m.usage.cacheRead ? '<span class="badge dim">缓存读 ' + fmtN(m.usage.cacheRead) + '</span>' : '')
    + (m.usage.reasoning ? '<span class="badge dim">推理 ' + fmtN(m.usage.reasoning) + '</span>' : '')
    + '</div>';
}

/**
 * 轨迹里的一条消息。
 *
 * 用户那一条只作**分段标题**（"这一轮问的是什么"）—— 轨迹是按回合读的，
 * 少了它，下面那一堆工具卡就不知道属于哪一问。
 * 助手那一条是主体：推理过程 → 知识库回执 → 工具卡 → 附件回执 → 用量 → 原始事件。
 * 顺序与从前在消息流里的一致（它本来就是按"读起来最顺"排的）。
 */
function wbTraceMsgHtml(m) {
  if (m.role === 'user') {
    const q = wbStripInjected(m.text || '') || '（仅附件）';
    return '<div class="wb-trace-turn">'
      + '<div class="wb-trace-who">提问</div>'
      + '<div class="wb-trace-q">' + esc(q) + '</div>'
      + wbInjectReceiptHtml(m)
      + '</div>';
  }
  let html = '';
  if (m.reasoning) {
    html += '<details class="wb-reasoning" open><summary>推理过程</summary>'
      + '<div class="mono-block">' + esc(m.reasoning) + '</div></details>';
  }
  html += wbTraceKbHtml(m);
  if (m.tools && m.tools.length) html += '<div class="wb-tools">' + m.tools.map(wbToolHtml).join('') + '</div>';
  html += wbTraceAttachHtml(m);
  html += wbTraceUsageHtml(m);
  if (m.events && m.events.length) {
    html += '<details class="wb-raw"><summary>事件（' + m.events.length + ' 条）</summary>'
      + '<div class="events">' + m.events.map(wbEventHtml).join('') + '</div></details>';
  }
  if (m.error) html += '<div class="note fail">' + esc(m.error) + '</div>';
  if (!html) return '';
  return '<div class="wb-trace-block">' + html + '</div>';
}

/**
 * 「轨迹」选项卡的全部内容（读的就是消息流那一份 `State.wb.msgs`，不另拉接口）。
 *
 * ⚠️ 现在它住在**会话框里**（不再是右栏的那个窄面板），所以呈现方式跟着变了三处：
 *   · 外层**不再是 `.panel` 卡片** —— 它就是这一帧的内容本身，套一张卡片等于
 *     "画框里再画一个框"；
 *   · 去掉了 `<h2>轨迹</h2>` —— 页签上已经写着「轨迹」，正文里再说一遍是重复；
 *   · 空态改用与「对话」同一个 `.wb-empty` 版式，两边空起来长相一致。
 */
function wbTraceHtml() {
  const w = State.wb;
  if (!w.sessionId) {
    return '<div class="wb-empty"><h3>还没有选中会话</h3>'
      + '<p class="muted">在左侧树上点一条会话，这里就会显示它每一轮的过程记录。</p></div>';
  }
  if (!w.msgs.length) {
    return '<div class="wb-empty"><h3>本会话还没有记录</h3>'
      + '<p class="muted">在下面提问 —— 推理过程、知识库检索、工具调用与用量会<b>随流</b>出现在这里。</p></div>';
  }
  const parts = w.msgs.map(wbTraceMsgHtml).filter(Boolean);
  if (!parts.length) {
    return '<div class="wb-empty"><h3>没有过程记录</h3>'
      + '<p class="muted">这个会话只有来回的文字，模型没有产生推理、工具调用或检索。</p></div>';
  }
  return '<div class="wb-trace">'
    + '<div class="wb-trace-lead faint">这个会话每一轮里平台实际做了什么：推理、知识库检索、'
    + '工具调用、附件回执与用量。<b>原文一字不改</b>（「对话」那一侧才是给你读的整理稿）。</div>'
    + parts.join('') + '</div>';
}

/** 消息流容器内容 */
function wbStreamHtml() {
  const w = State.wb;
  if (!w.msgs.length) {
    // 0.21.9：这里曾按"有没有会话"分两种提示 —— 没会话时**一个字都不渲染**
    //（那是空态品牌页的地盘）。品牌页随空态分支一起删了，所以只剩这一种。
    // 品牌页随空态分支一起删了，所以这里只剩一种：**这一格永远说一句话**。
    // 为什么不能留空：主区此时是个有页签、有输入卡、中间一片空白的框 ——
    // 空白会被读成"没加载出来"，而它其实是一句实话（这个会话还没有消息）。
    let html = '<div class="wb-empty"><h3>开始一段对话</h3>'
      + '<p class="muted">在下面输入问题，回车发送。事件是<b>流式</b>到达的（不是等整轮跑完再一次性显示），'
      + '工具调用、推理过程与 token 用量会随流出现。</p>';
    // 权限边界不是引导文案 —— 它必须在发问**之前**就被看见（与从前"没会话也要说"同一条）。
    if (!allowed('session', 'execute')) {
      html += '<div class="note warn">当前账号只有「会话 · 查看」权限，<b>不能发起对话</b>（发送按钮不可用）。'
        + '若要提问，请让管理员把你加到「成员」或以上角色。</div>';
    }
    html += '<div class="faint">事件落本地库，右侧可查看产物与用量。</div></div>';
    return html;
  }
  // 0.21.7：这里原本按检索命中（`searchResult.items[].seq`）给消息卡加 `.hit` 左边框高亮，
  //   随「会话内检索」整块删除。消息渲染回到"一份输入一份输出"，不再有第二份显示层标记。
  //
  // ── 轮次分隔条：横线 + 「已完成 [· 用时 N 秒]」（0.21.9）──────────────
  //
  // 用户 2026-10-08 分两次说定（第二次改掉了第一次的位置）：
  //   ① 「每轮对话加个横线区分一下」     → 我画在**提问之前**；
  //   ② 「每轮对话横线是放到大模型回复的上面，并标记已完成，用时多少秒
  //      （看是否能取到时间，取不到只显示已完成）」
  //      → 位置改成**模型回复的上面**，线上带状态与用时。
  //
  // 为什么"回复上面"和"提问上面"在**位置**上其实是同一条缝：
  //   一轮 = 用户气泡 → 助手块。"助手块之前"与"用户气泡之后"是同一处；
  //   真正变的是这条是**给这个回答盖章**（已完成），而不是"下一轮的开头"。
  //
  // ⚠️ **用时当前取不到，所以只显示「已完成」**（用户给的口径：取不到就只显示已完成）。
  //    查证过程与结论（别再来回试）：
  //      · `events.created_at` 是**整轮写入那一刻**的批量值 —— 实测某会话
  //        121 条事件里，同一轮的所有事件时间戳**逐字相同**（turn-start 与
  //        turn-end 之差恒为 0s），算不出用时；
  //      · `usage_records.created_at` 同样是同轮同值（同一 turn_id 的多行时间
  //        一模一样），`ttft_ms` / `tps` 两列**全是 null**（上游没给）；
  //      · `events.turn_id` 也全是 null，连"哪些事件属于哪一轮"都取不到。
  //    唯一**跨轮**真实的时间是"上一轮提问 → 本轮提问"的间隔（实测
  //    07:20 → 07:37 → 07:48…），但那里面混着**用户自己思考/打字的时间**，
  //    把它标成"模型用时"是撒谎。所以：**宁可只说"已完成"**。
  //    真要用时到手，得让上游在回合回执里带 `ttft_ms`/结束时间 —— 那是
  //    服务端与契约层的事，不是显示层能补出来的（届时在这里接上即可）。
  //
  // ⚠️ 首屏那个**孤儿助手块不画分隔条、也不画光标**（用户 2026-10-08：
  //    「每个会话最开始的闪烁的 wb-caret.idle 直接删掉」）。它是
  //    `turn-start` 之前那批 `lifecycle` 事件落成的空块，没有任何内容 ——
  //    给一个"空回合"盖"已完成"章毫无意义。判据：它前面**一个用户气泡都没有**。
  //    这比"按 type 过滤 lifecycle"更稳（不认事件类型，见 wbMessagesFromEvents）。
  //
  // ⚠️⚠️ 0.21.12 修正：这条判据**必须连"空"一起判**，只看"前面有没有用户气泡"是过宽的。
  //    用户要删的是"最开头那个**闪烁的空光标**"，而这一条一旦只认 `!seenUser`，
  //    就会连带把**有正文**的孤儿块一起吞掉 —— 真实的形态是"流被截断 / 上游只给了
  //    中段事件"（一个 turn-start 都没有，见 wbMessagesFromEvents 的 `hasTurnBoundary`）：
  //    那时整条流的内容都住在一个"前面没有用户气泡"的块里，按旧判据会被**整块丢掉**，
  //    界面上就是"这个会话有事件但一个字都不显示" —— 比多一个光标严重得多。
  //    正确判据 = "孤儿"**且**"没有任何可显示内容"，两个条件缺一不可：
  //      · `wbMsgHasContent(m)` 复用的是渲染层同一份拆分（正文 / 推理 / 工具 / 错误），
  //        所以"有内容"的判定与"会不会画出来"是同一件事，不会两处漂移。
  let seenUser = false;
  const out = [];
  for (const m of w.msgs) {
    if (m.role === 'user') { seenUser = true; out.push(wbMsgHtml(m)); continue; }
    // 还没出现过用户气泡 **且** 这个块没有任何内容 → 开头那个空孤儿块，整块跳过（连光标一起）。
    if (!seenUser && !wbMsgHasContent(m)) continue;
    out.push(wbTurnSepHtml(m) + wbMsgHtml(m));
  }
  return out.join('');
}

/**
 * 一轮分隔条：**左上角**一个「已完成」/「进行中」标签（+ 用时，若将来取得到），
 * 标签**下面**一条整宽的横线。
 *
 * 位置由用户三次裁定（后一次改掉前一次，详见 style.css 那段）：
 *   ① 画在提问之前 → ② 挪到**模型回复的上面**并带状态 → ③ 「已完成标记到
 *   横线左上」。第三步我先做成了"标签与线同一行、标签靠左"，被用户立刻纠正：
 *   「是上面，不是和横线在一行」—— 所以这里是**两行**：标签一行，线一行。
 *
 * ⚠️ DOM 里标签写在线**之前**，线由 CSS 的 `::after` 补在末尾 ——
 *    HTML 顺序 = 视觉顺序 = 读屏顺序，三者同向。不用 `order` 翻序
 *    （它只改视觉位置、不改读屏顺序，会让屏幕阅读器先念线再念状态）。
 *
 * 用时为什么固定为空：见 `wbStreamHtml` 里那段查证记录 —— 三个候选来源
 * （`events.created_at` / `usage_records.created_at` / `ttft_ms`）实测都取不到
 * 真实用时，唯一跨轮真实的时间混着用户思考时间，标成模型用时就是撒谎。
 * 这里的 `m.elapsedMs` 是**留给将来的接口**：上游哪天在回执里给了真实耗时，
 * 填进来就能显示；现在恒为 undefined → 只显示状态。
 */
function wbTurnSepHtml(m) {
  const running = !!m.streaming;
  const label = running ? '进行中' : '已完成';
  // 只认**正数**：0 或负数说明确实没拿到，或拿到的不可信（时间戳被压平）
  // —— 不能把 0 显示成"用时 0 秒"（那读起来像"瞬间就答完了"，是假信息）。
  const ms = Number(m.elapsedMs);
  const dt = (Number.isFinite(ms) && ms > 0) ? ' · 用时 ' + (ms / 1000).toFixed(1) + ' 秒' : '';
  // 标签在前（第一行、靠左），线由 CSS 的 `::after` 补在其后（第二行、整宽）。
  return '<div class="wb-turn-sep' + (running ? ' running' : '') + '" role="separator">'
    + '<span class="wb-turn-meta">' + esc(label + dt) + '</span></div>';
}

/**
 * 会话内检索结果面板。
 *
 * ⚠️ 口径必须**原样转述服务端的 scope/note**，不能自己写一句"已搜索全部消息"：
 * 检索只覆盖**已落库的事件载荷**，人工写一句更动听的话就变成了对能力的夸大。
 */
/* ── wbSearchPanelHtml：整块删除（0.21.7）───────────────────────────
 *
 * 会话内检索的浮层（输入框 + 命中列表 + 「跳到该回合」）。随「会话内检索」整块删除
 * （用户裁定：右上角不该为一个低频动作常驻一颗图标）。一起删的还有它的服务端路由
 * `kernel.sessions.search`、State 里的四个字段、以及消息卡上的 `.hit` 命中高亮。
 *
 * 当时的口径值得留一句：检索只覆盖**已落库的事件载荷**，面板原样转述服务端的
 * `scope` / `note`，不自己写一句"已搜索全部消息" —— 要把它加回来时沿用这条。
 */

/**
 * 输入框上方的**知识库条**（0.14.0）。
 *
 * 为什么放在这里而不是塞进右侧「当前会话」面板：它是**发问前**最该确认的一件事 ——
 * "我这次问，它会不会去查我的手册"。放到右侧折叠面板里，等于让用户在提问之后
 * 才发现"原来刚才没查知识库"，而那时钱已经花了。
 *
 * 「已挂几个」与「可见几个」是两回事，所以两个数都显示：库被管理员改成受限之后，
 * 会话行上仍留着它的 id（那是历史事实），但检索会忽略它 —— 此时若只显示"已挂 3 个"，
 * 用户会以为三份资料都在起作用。
 */
function wbKbStripHtml() {
  const w = State.wb;
  if (!allowed('knowledge', 'read')) return '';
  const list = w.kbList || [];
  // 0.21.2：账号里一个库都没有、面板也没开时**整条不渲染** ——
  // 空态品牌页上挂一行"当前账号没有可见的知识库…"，等于把系统的边界顶在最显眼的地方；
  // 等真的建了库（或面板被展开）它自然回来。行为本身一字不变。
  if (!list.length && !w.kbPanelOpen && !w.kbBusy && !w.kbError) return '';
  // 有会话 → 看服务端**记下的**挂载；没会话 → 看本地勾选（建会话时一并提交）。
  const mounted = w.sessionId ? (w.kbMounted || []) : (w.kbPicked || []).slice();
  const mountedIds = mounted.map(String);

  let html = '<div class="wb-kb-strip">';
  html += '<span class="wb-kb-label">知识库</span>';

  if (!list.length) {
    html += '<span class="faint">' + (w.kbLoaded
      ? '当前账号没有可见的知识库。未挂库时对话不做知识检索，行为与以前完全一致。'
      : '正在读取可见知识库…') + '</span>';
    if (w.kbError) html += ' <span class="note fail">' + esc(w.kbError) + '</span>';
    return html + '</div>';
  }

  if (w.kbBusy) html += '<span class="faint">提交中…</span>';

  const names = mountedIds.map((id) => {
    const b = list.find((x) => String(x.id) === id);
    return b ? b.name : id;
  });
  html += '<button ' + act('wbToggleKbPanel') + ' title="选择这个会话要检索哪些知识库">'
    + (mountedIds.length ? '已挂 ' + mountedIds.length + ' 个：' + esc(names.join('、')) : '未挂库')
    + (w.kbPanelOpen ? '　▴' : '　▾') + '</button>';

  if (!mountedIds.length) {
    html += '<span class="faint">未挂库时，提问不会检索知识库。</span>';
  } else if (!w.sessionId) {
    html += '<span class="faint">（点「＋ 新对话」时生效）</span>';
  }
  if (w.kbError) html += ' <span class="note fail">' + esc(w.kbError) + '</span>';

  if (w.kbPanelOpen) {
    html += '<div class="wb-kb-panel">';
    for (const b of list) {
      const on = mountedIds.indexOf(String(b.id)) >= 0;
      const restricted = b.visibility === 'restricted';
      html += '<span class="wb-chip' + (on ? ' on' : '') + '">'
        + '<label ' + act('wbToggleKb', esc(b.id)) + ' title="'
        + esc('可见性：' + (restricted ? '受限（仅被授权的成员可见）' : '全组织可见')
          + '｜文档 ' + (b.documentCount || 0) + ' 篇 · 分块 ' + (b.chunkCount || 0)
          + (b.accessLevel ? '｜你在本库的档位：' + b.accessLevel : '')) + '">'
        + '<span class="wb-check">' + (on ? '☑' : '☐') + '</span> ' + esc(b.name)
        + ' <span class="faint">' + (b.documentCount || 0) + ' 篇'
        + (restricted ? ' · 受限' : '') + '</span></label></span>';
    }
    html += '<div class="faint">勾选后，<b>后续每一轮</b>提问都会先用你的问题检索这些库，'
      + '把命中的片段注入本轮上下文，并在回答上方列出引用与命中数。'
      + '挂载<b>不清空历史</b> —— 已发生的回合不受影响。</div>';
    html += '</div>';
  }

  html += '</div>';
  return html;
}

/** 输入框上方的附件区：已上传列表（可勾选进本轮）+ 本轮已选提示
 *  0.21.2：没事可说时**整条不渲染** —— 空态品牌页上顶着一行"没附件，点「＋附件」…"，
 *  等于把操作说明顶在最显眼的地方；「＋」的 title 里已有一模一样的话，出错了才回来。 */
function wbAttachStripHtml() {
  const w = State.wb;
  const list = w.attachmentList || [];
  if (!w.attachError && !list.length) return '';
  let html = '<div class="wb-attach-strip">';
  if (w.attachError) html += '<div class="note fail">' + esc(w.attachError) + '</div>';
  if (!w.sessionId) return html + '</div>';
  if (!list.length) return html + '</div>';
    let nImg = 0, nTxt = 0;
    for (const a of list) {
      const picked = (w.attachPicked || []).indexOf(a.id) >= 0;
      // 「发送时会怎样」**原样采信服务端的结论**（列表响应里的 `delivery`），
      // 前端不自己按扩展名/大小再推一遍 —— 那会变成第二个真相：
      // 服务端按魔数判、前端按名字判，两边迟早不一致，而用户只会看到其中一个。
      const mode = a.delivery || (a.kind === 'text' ? 'text' : 'none');
      if (picked && mode === 'image') nImg++;
      if (picked && mode === 'text') nTxt++;
      const hint = mode === 'image'
        ? '图片：发送时作为图片内容块提交，模型能直接看到'
        : (mode === 'text'
          ? '文本附件：发送时正文会被拼进本轮上下文'
          : '不会被交给模型：仅登记、展示与下载');
      const tail = mode === 'image' ? ' · 送给模型'
        : (mode === 'text' ? '' : ' · 不提交');
      // 勾选态用**文本符号**而不是原生 checkbox：整个页面是"状态变了就整页重绘"，
      // 原生 checkbox 的浏览器内部勾选态会在重绘前先翻一次 —— 用户看到双击般的闪烁，
      // 而 data-act 又会再翻一次，两者叠加变成"点一下没反应/点一下翻两下"。
      // 纯文本符号没有内部状态，显示什么完全由 State 决定，不存在两个真相。
      html += '<span class="wb-chip' + (picked ? ' on' : '') + (mode === 'image' ? ' wb-chip-img' : '') + '">'
        + '<label ' + act('wbToggleAttach', a.id) + ' title="点击' + (picked ? '取消勾选' : '勾选进本轮') + '｜'
        + esc(hint)
        + '"><span class="wb-check">' + (picked ? '☑' : '☐') + '</span> '
        + esc(a.name) + ' <span class="faint">' + esc(fmtBytes(a.bytes)) + esc(tail) + '</span></label>'
        + ' <a class="wb-chip-dl" href="' + esc(App.wbAttachUrl(a.id)) + '" title="下载">下载</a>'
        + ' <button class="wb-chip-x" ' + act('wbDeleteAttach', a.id) + ' title="删除（元数据与落盘字节一起删）">×</button>'
        + '</span>';
    }
    if (nImg || nTxt) {
      const bits = [];
      if (nImg) bits.push(nImg + ' 张图片送给模型');
      if (nTxt) bits.push(nTxt + ' 个附件正文注入');
      html += '<span class="badge ok">本轮将 ' + esc(bits.join(' · ')) + '</span>';
  }
  html += '</div>';
  return html;
}

/* ── 0.21.0 工作区树 ─────────────────────────────────────────────
 *
 * 左栏从"会话平铺列表"改成"工作区树"：工作区节点 → 会话子节点，外加一个
 * 「未分组」桶接住没有工作区的会话（含 0.20.1 的全部存量会话）。
 * 数据全部来自 GET /api/workspaces（含我在每个工作区的三档档位）——
 * 前端不推断权限：服务端说我的档是什么就显示什么。
 */

/* ── 0.21.6 删掉了 wbLevelText / wbLevelCls ───────────────────────────
 *
 * 这两个函数把三档（view / write / full）翻译成"仅可查看 / 工作区内修改 / 完全权限"。
 * 那三档是**工作区权限模块**的产物，已整体删除 —— 理由见 app/platform/workspace/
 * visibility.mjs 头注释（上游 dsh 自己有一份工作区权限三档，平台这份改了不生效）。
 * 界面上的档位徽片、三档下拉、授权面板随之一起没了，这两个函数也就失去了调用方。
 *
 * ⚠️ 服务端仍保留这三档（`assertSessionAccess` 用它们表达"自己的会话 write 就够、
 *    别人的要 full"）。**那是内部判据，不是界面概念** —— 前端不需要知道。
 */

/* ── 模式的三个显示函数：整块删除（0.21.9）─────────────────────────────
 *
 * 这里曾有 `wbPresetLabel` / `wbPresetText` / `wbPresetTitle`：把内核上报的 preset id
 * （`standard` / `ptc` / `minimal` / `cordis`）翻译成「标准模式」…，并在没登记时如实说
 * 「未指定（跟随内核默认）」。
 *
 * 用户 2026-10-08 裁定：**暂时先把"模式"这一整块内容从界面上拿掉。**
 * 拿掉的三个位置：
 *   · 输入卡上方的模式徽片（有会话时那条「标准模式」事实陈述）；
 *   · 会话行副行里的 ` · 标准模式` 段；
 *   · 没有会话时的模式下拉（连它一起去 —— 同一个概念只留一半会更难理解）。
 *
 * ⚠️ 拿掉的是**界面**，不是事实：`preset_id` 这一列仍在、会话详情仍回报 `presetId`
 *    （与服务端"服务端返回什么就显示什么"的纪律一致 —— 只是现在**不显示**）。
 *    哪天要把它放回来，从这里恢复即可，不必重新推一遍"未指定该怎么写"。
 */

/** 当前选中模型的推理等级选项（模型目录 reasoning.efforts；模型没报告就是空 —— 不伪造档位） */
function wbEffortOptions() {
  const w = State.wb;
  const m = (w.models || []).find((x) => x.value === w.modelValue);
  return (m && m.efforts) || [];
}

/**
 * 工作台左栏底部的账号条（0.21.11 定稿：**不做下拉了**）。
 *
 * 用户原话：「对话工作台的那个账号下拉框我的账号 登出不行就去掉，还是保留原来只显示用户名，
 * 点击用户名称跳转到我的账号」。
 *
 * 所以这里回到**最简单**的形态：一行"头像 + 用户名"，点它去个人页。没有下拉、没有菜单、
 * 没有登出。前两版（胶囊 → 下拉）试下来在下拉这件事上反复出问题（先是弹在栏外被
 * `overflow:hidden` 裁掉，再是宽度撑满整栏），用户在**顶栏**已经有同样的下拉可用，
 * 工作台这一个就不必再重复一套 —— 它只需要"能到我的账号"这一个用途。
 *
 * ⚠️ **工作台里没有「登出」入口了**（这是本次的已知后果，不是漏接线）：
 *    0.21.2 加账号条，正是因为全屏工作台不渲染顶栏、登出会变得不可达；0.21.11 起
 *    登出收进了下拉，而下拉现在被取消 —— 于是工作台登不出去。
 *    要登出：回管理后台（左栏底部「管理后台」入口 → 顶栏账号下拉 → 登出）。
 *    若将来要在工作台内登出，正确做法是把「登出」作为**同行一颗独立的小按钮**摆回来
 *    （0.21.2 的原样），而不是再引入一次下拉。
 *
 * 用 `<a>` + `navAttr('#/me')` 而不是 `<button>`+`data-act`：这一版它的语义就是
 * **一个链接**（点了跳页），用链接让浏览器原生支持"新标签页打开 / 悬停看地址"，
 * 也让读屏器如实播报。`navAttr` 已带 `role="link"` + `tabindex="0"`，键盘可达。
 */
function wbAccountHtml(me) {
  const nm = me.displayName || me.username || '';
  return '<div class="wb-account">'
    + '<a class="wb-account-id" ' + navAttr('#/me') + ' title="我的账号">'
    + '<span class="wb-avatar" aria-hidden="true">' + esc(String(nm).slice(0, 1)) + '</span>'
    + '<span class="wb-account-name">' + esc(nm) + '</span>'
    + '</a>'
    + '</div>';
}

/* ── 行内「⋯」菜单（0.21.1）──────────────────────────────────────
 *
 * 起因：工作区行与会话行各自摊着 3~4 个按钮（改名 / 权限 / 删除 / 移动 / 导出），
 * 一行文本被挤成两行，树的层级也就看不出来了。改成"名字右侧一个「⋯」，点开才出菜单"。
 *
 * 三条设计约束（都不是审美问题）：
 *   1. **菜单是状态**（`State.wb.rowMenu`），不是往 DOM 里插的浮层 —— 与全站同一套
 *      渲染模型：重绘即真相，回归里的 DOM 垫片也能直接驱动它（见 40-delegate.js 文件头）。
 *      同时只开一个（两排菜单摊开会盖住整棵树）。
 *   2. **入口按权限收敛**：服务端说不能做的动作，菜单里**不摆**（或摆成禁用+说明），
 *      因为"点了必然 403 的按钮"读起来像产品坏了（与 view 档工作区同一纪律）。
 *   3. **不嵌套可点区域**：菜单按钮挂在行**内部**但各自带 `data-act`，事件委托取最近的
 *      那个 —— 点菜单项不会顺手把会话打开、把工作区选中。
 */

/** 这个行内菜单是不是开着的 */
function wbRowMenuOpen(kind, id) {
  const m = State.wb.rowMenu;
  return !!(m && m.kind === kind && String(m.id) === String(id));
}

/**
 * 行尾的「⋯」（工作区行 / 会话行共用）。
 *
 * ⚠️ 提示文案**不要**在这里罗列菜单里有什么（0.21.9）。罗列就是把菜单抄一遍，
 * 而菜单内容会变（＋ 被提走、权限项被删）—— 抄的那份不会跟着变，于是用户看到
 * "功能变更了描述还是以前的"。默认就是"更多操作"这一句功能本身。
 * 只有"这一行的 ⋯ 因为权限而不完整"时才多带一句**当前档位**（那是事实，不是描述）。
 */
function wbMoreButton(kind, id, title) {
  return '<button class="wb-row-more" ' + act('wbToggleRowMenu', kind, id)
    + ' title="' + esc(title || '更多操作') + '" aria-haspopup="menu">' + wbIcon('more', 'sm') + '</button>';
}

/**
 * 行尾的「＋」：在**这一行**里新建会话（0.21.6）。
 *
 * 为什么从菜单里提出来做成一个独立按钮：用户的原话是"工作区右侧……再右侧一个加号
 * （新会话）"。留在菜单里意味着"点开 ⋯ 才知道这里能建会话"，而建会话是这一行上
 * **最高频**的动作 —— 高频动作不该藏在二级菜单里。
 *
 * 顺序也有讲究：⋯ 在左、＋ 在右（同样按用户描述）。两者都是**鼠标划过这一行才出现**
 * （CSS 的 `.wb-ws-row:hover`），平时不占视觉 —— 树的层级因此看得清。
 *
 * 只有工作区行调用它；会话行不能再嵌套会话。
 */
function wbRowAdd(wsId) {
  const busy = State.wb.streaming;
  // 能不能在这里建会话：路由层的 `session:write` **加上**服务层的档位判定。
  // 档位现在由组织角色推导，与 `session:write` 同源 —— 但访客（viewer）没有 write，
  // 所以这里仍要判：摆一个点了必然 403 的按钮，用户读作"系统坏了"。
  if (!allowed('session', 'write')) {
    // 禁用态要**说清为什么禁用**（0.21.9 收短）：这不是"功能描述"，而是"这颗钮为什么
    // 现在按不动"的事实 —— 摆一颗说不出理由的灰钮，用户读作"系统坏了"。
    return '<button class="wb-row-add" disabled title="不能新建会话：当前角色没有 session:write">'
      + wbIcon('plus', 'sm') + '</button>';
  }
  return '<button class="wb-row-add" ' + act('wbNewSessionIn', wsId) + (busy ? ' disabled' : '')
    + ' title="新建会话">' + wbIcon('plus', 'sm') + '</button>';
}

/**
 * 工作区行的菜单。
 *
 * 0.21.6 起只剩两项：**重命名工作区 / 删除工作区**（用户裁定）。
 * 移走的三项各有去处与理由：
 *   · 「＋ 新会话」→ 提到行右侧的加号（高频动作，见 wbRowAdd）；
 *   · 「工作区权限…」→ 连同整个工作区权限模块一起删除（见本文件顶部那段说明）；
 *   · 「工作目录…」→ 一并删掉。cwd 决定上游项目级能力能读写哪片文件系统，但它只在
 *     **建工作区**时才真正重要（那时会问一次），事后改的场景极少；而它占着菜单会把
 *     "重命名 / 删除"这两个日常项淹掉。要改 cwd，现在删了重建即可 ——
 *     会话会落进默认工作区，本体不会丢。
 *
 * ⚠️ **兜底工作区（`isDefault`）的两项一律禁用并写明原因**（0.21.9）。它是
 *    "删工作区时里面的会话落到哪"的答案，能改名或删掉的话那个答案就没有保证了，
 *    服务端因此会 403。这里**不把菜单项撤掉**：撤掉之后用户只会看到"这一行没有 ⋯"，
 *    然后再来找人问为什么 —— 摆出来、灰掉、写清理由（当前通用纪律：禁用优先于 403，
 *    但前提是**说得出理由**）。
 */
function wbWsMenuHtml(ws) {
  const busy = State.wb.streaming;
  const locked = !!ws.isDefault;
  const why = '「' + (ws.name || '') + '」是兜底工作区：删除别的工作区时，里面的会话会落进它，'
    + '所以它不能重命名、不能删除。';
  return '<div class="wb-menu" role="menu">'
    + '<button ' + (locked ? '' : act('wbRenameWs', ws.id, ws.name || ''))
    + (busy || locked ? ' disabled' : '')
    + ' title="' + esc(locked ? why : '重命名这个工作区') + '">重命名工作区</button>'
    // 提示收成一句（0.21.9，见 wbSessionMenuHtml 头注释）：删工作区**不删会话**是这件事里
    // 唯一猜不到的后果，留下；剩下那半句解释（"不会被删除"）是同一个事实的重复，去掉。
    + '<button class="danger" ' + (locked ? '' : act('wbDeleteWs', ws.id, ws.name || ''))
    + (busy || locked ? ' disabled' : '')
    + ' title="' + esc(locked ? why : '只删工作区，里面的会话移进默认工作区') + '">删除工作区</button>'
    + (locked ? '<div class="wb-menu-note">' + esc('兜底工作区：不能重命名、不能删除') + '</div>' : '')
    + '</div>';
}

/**
 * 会话行的菜单。
 *
 * 改名 / 删除 / 移动是否出现，**只听服务端下发的 `canManage`** —— 它是用与动作守卫
 * 同一个函数（`workspace.sessionManageRight`）算出来的。此前这里按全局 `session:write`
 * 亮按钮：在"我在这个工作区只有 write 档、而这条会话是别人建的"情况下，
 * 会亮出一个点了必然 403 的按钮（用户读作"系统坏了"）。
 * 取不到 `canManage` 一律按 false 处理 —— 不乐观放行（与 `allowed()` 同一条）。
 *
 * ⚠️ 悬停提示一律收成**一句功能本身**（0.21.9，用户裁定）。从前这几条后面各挂了一长串
 * 解释（"Markdown / JSON 任选""内容不变，只换组织位置""事件 / 附件 / 产物一并清除"）——
 * 那是把**实现细节抄进提示**：实现一改它就成了一句假话，而用户扫菜单时要知道的只有
 * "点它会怎样"。只留两类例外：① 这颗钮现在**按不动的原因**（当前档位 / 没有管理权），
 * ② 删除动作里**没被删掉的那一件**（用量台账）—— 两者都是事实，不是描述。
 */
function wbSessionMenuHtml(s, canManage) {
  const busy = State.wb.streaming;
  let html = '<div class="wb-menu" role="menu">'
    + '<button ' + act('wbExportSession', s.id, s.title || '') + (busy ? ' disabled' : '')
    + ' title="导出这次对话">导出会话</button>';
  if (canManage) {
    // 0.21.9：这里原本还有一项「移动到…」（把会话挪进另一个工作区）。用户裁定删除 ——
    // 工作区的落点已经由**在哪一行点 ＋** 决定，再留一个"事后改归属"的入口，等于把
    // "这个会话属于谁"变成两处可写的东西（与 0.21.6 删掉输入卡上方工作区下拉是同一条理由：
    // 同一个值不许有两个写入口）。要换工作区就新开一条会话。
    // ⚠️ 服务端能力没减：PATCH /api/kernel/sessions/:id 的 `workspaceId` 仍接受
    //     （删工作区时的会话归位正走它），只是前端不再摆这个动作。
    html += '<button ' + act('wbRenameSession', s.id, s.title || '') + (busy ? ' disabled' : '')
      + ' title="重命名这个会话">重命名</button>'
      + '<button class="danger" ' + act('wbDeleteSession', s.id, s.title || '') + (busy ? ' disabled' : '')
      + ' title="删除这个会话（用量台账保留）">删除会话</button>';
  }
  // 0.21.6：这里原本还有一项「工作区权限…」（就近设置这条会话所在工作区的三档）。
  // 那套模块已整体删除，整段随之拿掉 —— 理由见本文件顶部与
  // app/platform/workspace/visibility.mjs 头注释。
  html += '</div>';
  return html;
}

/**
 * 一条会话行（树上会话子节点；操作收在名字右侧的「⋯」里）
 *
 * ⚠️ 悬停提示挂在**标题与副行**上，不挂在外层 `.wb-session` 上（0.21.9 修）。
 * 为什么必须补：会话行是树里**面积最大**的一块，而此前**它整行没有一句提示** ——
 * 划过名字、划过"N 事件 · 5 分钟前"都不弹任何东西，只有右上那颗小小的「⋯」有。
 * 用户读到的就是"划过有时候弹不出来"（划过 ⋯ 弹、划过名字不弹）。
 *
 * 为什么随后**不放在外层容器**上：`.wb-session` 里还装着菜单，菜单项有自己的一句提示；
 * 放到外层会让"没有自己提示的那几项"回落到"打开这个会话"这句 —— 点"重命名"却看到
 * "打开这个会话"，比不弹还糟。挂在两个文本格上，覆盖面积一样、语义不串。
 *
 * 文案只写**功能本身**（用户 2026-10-08 裁定）：描述一改就过期，而扫树时要知道的
 * 只有"点它会怎样"。
 */
function wbSessionRowHtml(s) {
  const w = State.wb;
  const canManage = !!s.canManage;
  let html = '<div class="wb-session' + (s.id === w.sessionId ? ' active' : '')
    + (wbRowMenuOpen('session', s.id) ? ' menu-open' : '') + '" '
    + act('wbPickSession', esc(s.id)) + '>'
    + '<div class="wb-session-title" title="打开这个会话">' + esc(s.title || '(未命名)') + '</div>'
    + '<div class="wb-session-meta" title="打开这个会话">' + esc(s.eventCount) + ' 事件 · ' + relTime(s.updatedAt)
    // 0.21.9：这里曾有 ` · 模式` 一段（没登记时说「未指定」）。用户裁定把"模式"这一整块
    // 从界面上拿掉 —— 副行只剩"多少事件、多久以前"这两件扫树时真要看的事。
    + '</div>'
    + wbMoreButton('session', s.id, canManage ? '更多操作' : '更多操作（本会话没有管理权）');
  if (wbRowMenuOpen('session', s.id)) html += wbSessionMenuHtml(s, canManage);
  html += '</div>';
  return html;
}

/* ── wbGrantsPanelHtml：整块删除（0.21.6）───────────────────────────
 *
 * 它是"工作区权限"的内联面板：成员名单 + 三档下拉 + 可见性开关 + 授权表单。
 * 随整个工作区权限模块一起删除（用户裁定，2026-10-06）—— 理由见本文件顶部
 * 以及 app/platform/workspace/visibility.mjs 头注释。
 *
 * 服务端的对应部分也没了：/api/workspaces/:id/grants 两个端点、workspaces.visibility
 * 列（迁移 0023）、role_bindings 里的 workspace 级绑定。整条链一起删，不留半截。
 */

/** 左侧：工作区树（工作区节点 → 会话子节点 + 未分组桶） */
function wbTreeHtml() {
  const w = State.wb;
  let html = '';

  const q = String(w.treeFilter || '').trim().toLowerCase();
  const hitS = (s) => !q || String(s.title || '').toLowerCase().indexOf(q) >= 0;
  const wss = (w.workspaces || []);
  const sessions = (w.sessions || []);

  html += '<div class="wb-tree">';
  for (const ws of wss) {
    const kids = sessions.filter((s) => s.workspaceId === ws.id && hitS(s));
    const selfHit = !q || String(ws.name || '').toLowerCase().indexOf(q) >= 0;
    if (!selfHit && !kids.length) continue;
    const open = w.wsOpen[ws.id] !== false;
    const menuOpen = wbRowMenuOpen('ws', ws.id);
    html += '<div class="wb-ws">';
    html += '<div class="wb-ws-row' + (w.wsActiveId === ws.id ? ' active' : '')
      + (menuOpen ? ' menu-open' : '') + '">'
      // 展开三角也要有提示（0.21.9）：它是一颗 14px 的方块、又是这一行**最左侧**的一格 ——
      // 鼠标从左边扫进来最先落到它身上，而它此前没有提示，扫过去"什么都没弹"。
      // 文案只写功能本身：它是开合，不是"选择工作区"（那是它右边名字的事）。
      + '<span class="wb-ws-caret" ' + act('wbToggleWs', ws.id) + ' role="button" tabindex="0"'
      + ' title="展开或收起">'
      + (open ? wbIcon('chevronDown', 'sm') : wbIcon('chevronRight', 'sm')) + '</span>'
      + '<span class="wb-ws-name" ' + act('wbPickWorkspace', ws.id) + ' role="button" tabindex="0"'
      // 悬停提示显示**工作目录**（0.21.9，用户裁定原话：「默认工作区鼠标划过显示个路径就可以啦」）。
      // 中途试过"只写功能本身"（选择这个工作区），被这条裁定推翻 —— 理由站得住：
      // 工作区名字本身看不出它管着哪片文件系统，而 `cwd` 恰恰是它**唯一有实质影响的属性**
      // （决定上游项目级能力能读写哪一片）。仍不拼 `description`：描述会过期，路径是事实。
      // ⚠️ cwd 允许为空（空 = 不设工作目录，是**有效值**不是缺失），所以空值要如实说出来，
      //    不能显示成空白 —— 空白看起来像"没读到"。
      //    0.21.9 界面上不再提供"不设工作目录"这个出口（`Dlg.browse` 的注释里有理由），
      //    但**数据层与服务端照旧接受**空 cwd（API、以及这一版之前建出来的老数据），
      //    所以这一行不是死代码 —— 它报的是事实，不是某个按钮的产物。
      + ' title="' + esc(ws.cwd || '未设置工作目录') + '">'
      + wbIcon('folder', 'sm') + '<span class="wb-ws-label">' + esc(ws.name) + '</span></span>'
      // 行尾两个动作（0.21.6）：⋯（重命名 / 删除）在左、＋（新会话）在右。
      // 平时收着（CSS 里 hover 才出现）—— 树是靠"名字"读的，不是靠一排图标。
      // 从前这里是两个常驻徽片（会话数 / 我的档位）；档位随权限模块删掉，会话数也不是
      // 每行都值得占一格，于是空出来的位置正好给这两个动作用。
      + '<span class="wb-row-ops">'
      // ⚠️ 提示只写"更多操作"（0.21.9）。从前这里写着"重命名工作区 / 删除工作区"——
      //    那是**把菜单内容抄了一遍**，而菜单内容已经改过两轮（＋ 提走、权限项删除），
      //    抄的这一份没跟着改，正好撞上用户说的"功能变更了描述还是以前的"。
      + wbMoreButton('ws', ws.id, '更多操作')
      + wbRowAdd(ws.id)
      + '</span>'
      // ⚠️ 菜单必须渲染在**这一行里面**（0.21.9 修）。原因纯 CSS：
      //    `.wb-menu` 是 `position:absolute; top:100%`，它的定位祖先得是 `.wb-ws-row`
      //    （唯一带 `position:relative` 的那一层）。从前它渲染在行**外面**、挂在
      //    `.wb-ws` 上，而 `.wb-ws` 没有定位 —— 于是定位祖先一路退到视口（初始包含块），
      //    `top:100%` 折算成整页高度：菜单被放到视口下方（还被 `.wb-tree` 的 overflow 裁掉），
      //    点「⋯」看起来**毫无反应**。会话行的菜单一直是正常的，就因为它渲染在
      //    `.wb-session`（有 position:relative）里面 —— 两处差别只有这一条，所以别把它挪出去。
      + (menuOpen ? wbWsMenuHtml(ws) : '')
      + '</div>';
    if (open) {
      html += kids.length ? kids.map(wbSessionRowHtml).join('')
        : '<div class="faint wb-ws-empty">还没有会话 —— 点这一行右侧的「＋」。</div>';
    }
    html += '</div>';
  }

  /* ── 未分组桶：整块删除（0.21.9）──────────────────────────────────
   *
   * 这里原本是树的最下面一行「未分组」（没有 `workspace_id` 的会话构成的虚拟桶）。
   * 删掉的理由（用户 2026-10-08 原话：「删除工作区，其下面的会话移动到未分组，
   * 未分组有意义吗」）：
   *   · 它**不是一条工作区记录** —— 没有 id、没有 cwd、不能改名、不能删除，
   *     所以它在各处的呈现必然不一致（用户紧接着就发现"当前工作区小节也没显示未分组"）；
   *   · 更要紧的是它在权限上是一条**暗门**：服务端对未分组的会话直接 `can:true`
   *     （无档位 = 放行），进了工作区的会话反而有档位。没有门不是"更自由"，
   *     是"没人说得清这里该谁管"。
   *
   * 它接住的那件事——"删工作区时里面的会话去哪"——改由**默认工作区**承接：
   * 服务端把会话改挂到 `is_default` 那条工作区上，存量空归属由迁移 0024 归位。
   * 于是树上的每一行都是一条真实的工作区，不再有"半行"。
   */
  return html;
}

/* ── wbCapsHtml：整块删除（0.21.7）─────────────────────────────────
 *
 * 右栏「可用能力」面板（0.19.0）：把技能 / 工具 / 插件 / MCP 四段清单并在会话旁边，
 * 让对话的人看得见"这轮对话背后站着什么"。用户裁定删除（2026-10-06）。
 *
 * 为什么可以删而不丢事实：同一份数据在**能力清单页**（#/capabilities）与**能力来源页**
 * （#/capability-source）上都是完整的管理员视图 —— 那里才是"登记了什么、探测到什么、
 * 差在哪一条"该待的地方。会话旁边再列一遍，等于把管理面的清单搬进使用面。
 *
 * ⚠️ 0.21.7 时这里还写着"`w.caps` / `w.capsMcp` 的拉取不能删：工具卡上的来源徽标要拿
 *    登记工具表对账"。**这条理由在 0.21.10 失效了** —— 徽标与登记工具表一起删除，
 *    于是 `w.caps` 的拉取也没有读者了，已从 71-app-workbench.js 删掉。
 *    `w.capsMcp` 仍然保留（右栏的 MCP 材料另有消费者）。
 */


/**
 * 右栏（0.21.2 起就是这一块）—— 会话**旁边**的材料：用量、产物。
 *
 * ⚠️ 它一度是个"选项卡外壳"（0.21.9 第一版：「上下文 | 轨迹」），被用户否掉了：
 *    「轨迹不要放到右侧栏，放到会话框中（会话框中选项卡对话、轨迹）」。
 *    所以「轨迹」搬去了主区的 `wbViewTabsHtml`，这里回到**只有一块内容**的样子 ——
 *    一个只有单个页签的选项卡外壳是纯装饰，删掉它反而少一层要维护的选中态。
 *
 * 分工因此变得很干净、也正好对应两个不同的问法：
 *   · 主区（会话框）—— **这个会话本身**：说了什么（对话）、以及过程（轨迹）。
 *   · 右栏          —— **这个会话之外的事实**：花了多少、产出了哪些文件。
 *
 * 为什么右栏不再有 tab 之后仍然保留：
 *   它装的东西（用量 / 产物）是"会话的事实"，不是"会话的内容"—— 与对话并排看才方便
 *   （一边聊一边看 token 在涨），塞进主区反而会把对话顶掉。
 */
function wbRailHtml() {
  return '<div class="wb-rail-inner">' + wbContextHtml() + '</div>';
}

/**
 * 会话框自己的选项卡（0.21.9 定版）—— 「对话 | 轨迹」。
 *
 * 用户 2026-10-08：「轨迹不要放到右侧栏，放到会话框中（会话框中选项卡对话、轨迹）」。
 * 这与右栏那版的区别不只是位置：轨迹是**这个会话的内容**（同一份 `State.wb.msgs` 的
 * 另一个视图），而右栏装的是会话旁边的材料。把它放回会话框里，"对话 / 轨迹"才真的是
 * 同一件事的两个看法。
 *
 * ── 三处刻意的选择 ─────────────────────────────────────────────────
 *   · 位置：**消息流正上方**，与正文列（`.wb-stream-inner`）同宽同轴居中。tab 条要是
 *     贴在主区最顶上，它读起来就是"整个页面的页签"，而不是"这个会话框的页签"。
 *   · **恒渲染**（0.21.9，用户裁定）：从前"没有会话时不画"，因为那时主区是另一套
 *     空态布局（品牌页 + 居中输入卡）。空态分支已整体删除，主区只有一套布局，
 *     于是它跟着恒在 —— 否则"新建会话"时页签会从无到有跳一次，那还是两套样子。
 *   · "轨迹"里**没有**任何设备/调试术语：它就是"这一轮平台实际做了什么"。
 *
 * ⚠️ tab 条**不参与流式局部重绘**（`wbPaint` 只重绘 `#wb-stream`）：它没有随流变化的
 *    东西，每次重建一遍只会平白丢掉键盘焦点。切换 tab 走整页 `render()`。
 */
function wbViewTabsHtml() {
  const tab = State.wb.viewTab === 'trace' ? 'trace' : 'chat';
  const btn = (id, label) => '<button class="wb-tab' + (tab === id ? ' on' : '') + '"'
    + ' role="tab" aria-selected="' + (tab === id ? 'true' : 'false') + '"'
    + act('wbViewTab', id) + '>' + esc(label) + '</button>';
  return '<div class="wb-view-tabs"><div class="wb-tabs" role="tablist" aria-label="会话框">'
    + btn('chat', '对话') + btn('trace', '轨迹')
    + '</div></div>';
}

/**
 * 会话框当前这个选项卡的**内容**。
 *
 * 一处必须写下来的细节：两个 tab 都会往 `#wb-stream` 里渲染，因此**滚动位置共用**。
 * 切到轨迹会把滚动条留在对话读到的地方（反之亦然）——这是可接受的：两者是同一个会话
 * 的前后两个时刻，用户不会期望"切回来还在原处"，而 `wbPaint` 的"滚到底"会把对话那侧
 * 修正回来（轨迹那侧不滚，见 71-app 的 wbPaint）。
 */
function wbViewBodyHtml() {
  return State.wb.viewTab === 'trace' ? wbTraceHtml() : wbStreamHtml();
}

/**
 * `#wb-stream` 的**完整内容**（含与输入卡同宽同轴的那层 `.wb-stream-inner`）。
 *
 * ⚠️ 这个函数存在的唯一理由是**堵住"两个写入口"**（0.21.9，用户报的宽度闪动）。
 *
 * `#wb-stream` 的 innerHTML 有两个写入者：
 *   · `render()` 走整页重建（`wbRenderStream` 那一段）；
 *   · `App.wbPaint()` 走流式局部重绘（每帧一次）。
 * 从前两边**各写一遍**，而且写的不一样：整页那条套了 `.wb-stream-inner`，
 * 局部重绘那条没套。结果同一个容器在"有没有套那一层"之间来回切，
 * 而那一层恰好决定宽度（`.wb-stream` 自己带 `padding: 0 24px`）——
 * 于是提交一轮的瞬间宽度跳 48px 再跳回来。见 `wbPaint` 的注释（那段有时序）。
 *
 * 所以现在**只有这一个**函数决定"流容器里长什么样"，两个写入者都调它。
 * 改这一层（加一层壳、换个类名、改空态判据）只改这里。
 */
function wbStreamShellHtml() {
  const body = wbViewBodyHtml();
  // 空内容时不套空壳：一个空的居中容器会占位（`.wb-stream-inner` 带 `margin: 0 auto`
  // 与宽度），凭空多出一块 —— 而且它与"没有内容"这件事在 DOM 上看不出区别，
  // 排查时只会让人以为漏渲染了。
  return body ? '<div class="wb-stream-inner">' + body + '</div>' : '';
}

/**
 * 把消息流滚到底（= 显示最新一轮）。**`#wb-stream` 的滚动只认这一个函数。**
 *
 * ⚠️ 0.21.9 用户第二条滚动反馈：「每次对话提交后就跑到会话的最上面」。
 *    前一版只修了 `wbPaint` 里的**滚动时机**（同一帧读 `scrollHeight` 会读到 0），
 *    那个修复是对的、但**不够** —— 因为"跑回合"这条路上真正把画面拽到顶部的
 *    根本不是 `wbPaint`，而是 **`render()` 重建了 `#wb-stream` 这个元素本身**：
 *
 *      · `wbRunTurn` 首发时     `render(); wbPaint();`
 *      · `wbRunTurn` 收尾时     `render();` → `wbRefreshContext();`（内部又 `render()`）
 *
 *    `render()` 是 `$('#app').innerHTML = …` **全量重建**，新建出来的
 *    `#wb-stream` 的 `scrollTop` 天然是 **0**，也就是**最上面**。
 *    一回合至少重建两次，所以提交后必定停在顶部 —— 与 `wbPaint` 怎么滚无关
 *    （它滚的是**上一个**已经被丢弃的节点）。
 *
 *    所以判据不是"在哪儿滚"，而是"**谁来滚**"：凡是重建过 `#wb-stream` 的路径，
 *    都必须补一次滚到底。于是把这件事收成一个函数，`wbPaint` 与 `render()`
 *    的**工作台分支**共用它 —— 与 `wbStreamShellHtml` 同一个理由（唯一真相源）。
 *
 * ── 三处刻意的选择 ─────────────────────────────────────────────────────
 *
 * ① **推迟到重排之后**（`requestAnimationFrame`）。写 `innerHTML` 只是挂节点，
 *    浏览器还没重排；同一同步块里读 `scrollHeight` / `clientHeight` 会强制同步重排，
 *    而在"内容刚被整体替换、高度从很小变成很大"这个窗口里读到的是**旧的/0 的**尺寸。
 *    `scrollTop` 的上限 = `scrollHeight - clientHeight`：读到 0 上限就是 0，
 *    赋任何值都会被钳成 0 → 跳到顶部。下一帧里 `scrollHeight` 才是真实高度。
 *
 * ② 写 `scrollHeight` 而不是 `scrollHeight - clientHeight`：超出上限的值由浏览器
 *    自己钳到最大值，这是"滚到底"最省事也最不会算错的一种写法（自己减反而多读一次
 *    布局，且 `clientHeight` 在滚动条出现与否的边界上同样可能读到旧值）。
 *
 * ③ **只在「对话」页签滚**（`viewTab === 'trace'` 时直接返回）。轨迹是"用户自己在翻"
 *    的一份记录：每来一帧就把它滚到底，等于不让人看上面的内容 —— 与消息流必须
 *    自动滚到底正好相反。这个判断放在这里（而不是各调用点各判一次），
 *    免得两处判据漂移成"一处滚、一处不滚"。
 *
 * ⚠️ 参数 `el` 允许调用方传进来（`wbPaint` 手上已经有这个节点）；不传就现查。
 *    传节点而不是每次现查，是为了让"滚的就是刚写完的那一个"这件事在代码上看得见。
 */
function wbStickToBottom(el) {
  if (State.wb.viewTab === 'trace') return;   // 理由 ③
  const node = el || $('#wb-stream');
  if (!node) return;
  const stick = () => {
    // 读到 0 就跳过：那是"没有布局信息"（元素不在文档里 / 测试替身），
    // 此时赋值只会把 scrollTop 写成 0。留着 `if` 是有意的。
    try { if (node.scrollHeight) node.scrollTop = node.scrollHeight; } catch (e) { /* 无布局信息时忽略 */ }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(stick);   // 理由 ①
  else stick();   // 极老环境 / 无 rAF 的替身：退回同步（退化成修复前，但不抛）
}

/** 「上下文」面板：这个会话的事实（会话用量 / 产物） */
function wbContextHtml() {
  const w = State.wb;
  let html = '';
  html += '<div class="panel"><h2>当前会话</h2>';
  if (!w.sessionId) {
    html += '<div class="faint">还没有选中会话。</div>';
  } else {
    html += '<dl class="kv">'
      + kv('会话 id', '<span class="mono">' + esc(w.sessionId) + '</span>')
      + kv('消息', w.msgs.length)
      + kv('用量事件', w.usage ? fmtN(w.usage.usageEvents) : '—')
      // 「累计 tokens」把**缓存读/写也算进去**：缓存读是真实处理过的 token（只是按便宜价计费，
      // 见成本模块的"计费输入 = input + cacheRead + cacheWrite"）。只加 input+output 的话，
      // 一轮实际吞了 7,215 token 的会话会显示成 559 —— 少读一个数量级，
      // 而那正是本平台**最想让人看清**的那个数。
      + kv('累计 tokens', w.usage ? fmtN((w.usage.input || 0) + (w.usage.cacheRead || 0)
        + (w.usage.cacheWrite || 0) + (w.usage.output || 0)) : '—')
      + '</dl>';
    if (w.usage) {
      html += '<div class="cards" style="margin-top:10px">'
        + card('输入', fmtN(w.usage.input), '') + card('输出', fmtN(w.usage.output), '')
        // 只有真的发生了缓存才显示这一格 —— 恒显示一个 0 只会占地方
        + ((w.usage.cacheRead || 0) > 0 ? card('缓存读', fmtN(w.usage.cacheRead), '') : '')
        + '</div>';
    }
  }
  html += '</div>';

  // 0.21.7：这里曾有「实际调用（本会话）」与「可用能力」两段（0.20.0 / 0.19.0）。
  //   用户裁定都删掉 —— 面板只剩"这个会话的事实"（用量 + 产物）。
  //   两段各自的去处与保留物见 wbCallsHtml / wbCapsHtml 那两段删除说明：
  //   工具卡上的来源徽标仍在、清单仍在能力页，删掉的只是"在会话旁边再列一遍"。

  // 产物：需要 artifact:read（member 默认没有 —— 那就如实不显示，而不是显示空表）
  //
  // ── 0.21.9 重做（用户 2026-10-08：「右侧栏产物（工具写出的文件），感觉重复混乱，
  //    样式也有问题，另外写出文件点击可以用默认程序打开」）──────────────────────
  //
  // ⚠️ 标题就叫「产物」，**不加任何括注**（用户 2026-10-08 追加裁定：「直接改成产物，
  //    不要加（工具写出的文件），因为有的是读的不一定是写出的」）。
  //    他说得对：这块面板按方向分了「写出 / 读入」两组，括注却只说"写出的" ——
  //    一句与自己的内容相矛盾的注解，比没有注解更糟。何况下面那句边界说明
  //    （"路径来自工具入参/结果的字符串层提取"）已经把"这些是什么"讲清楚了。
  //
  // **"重复混乱"是排版本身造成的，不是数据脏。** 旧版把 (方向徽标 / 完整路径 / 工具名)
  // 挤进一张**三列表格**，而右栏内宽只有约 264px、`.table-wrap` 还是 `overflow-x:auto`：
  //   · `C:\Users\lw\…\out.html` 这种长路径在 100px 出头的格子里放不下 → 横向滚动条；
  //     滚动条一出来，工具名那一列就被推出可视区 —— 看着像"每一行内容都不一样、对不齐"；
  //   · 同一轮里工具常常先读后写同一个文件，于是"输入 x.txt"和"产出 x.txt"两行**上下并排**
  //     且都只显示完整的同一串路径 —— 用户看到的就是"重复"。
  //
  // 重做的三处（都是"把三列压成一列、把重复的东西只留一次"）：
  //   ① **按方向分组、每组一个小标题**，行里只显示**文件名**（大号、可点）、
  //      完整路径降级成悬停提示 + 行内小字 —— 不再让 264px 去吞 80 个字符；
  //   ② 工具名收成行尾的小字（它是**出处**，不是主体）；同一文件同方向出现多次
  //      由服务端已去重，这里再做一次同 key 合并，避免同一工具重复调用时刷屏；
  //   ③ 整行可点 → **用系统默认程序打开**（新能力，见 `wbOpenArtifact`）。
  //      不能打开时**不摆这颗钮**（不摆一个点了必然失败的入口），行变成纯展示。
  const arts = (w.artifacts && w.artifacts.items) || [];
  if (allowed('artifact', 'read') && w.sessionId) {
    html += '<div class="panel"><h2>产物</h2>';
    if (!arts.length) {
      html += '<div class="faint">本会话暂无产物。路径来自工具入参/结果的字符串层提取 —— 工具不报就记不到。</div>';
    } else {
      // 同一个 (方向, 路径) 只留最后一条 —— 工具重复调用同一个文件时不刷屏。
      // 保留**最后**一条的 tool_name：那是"最后动它的那个工具"，比第一条更贴近现状。
      const uniq = [];
      const at = new Map();
      for (const a of arts) {
        const key = (a.direction || '') + '\u0000' + (a.path || '');
        if (at.has(key)) { uniq[at.get(key)] = a; continue; }
        at.set(key, uniq.length);
        uniq.push(a);
      }
      const groups = [
        { dir: 'output', label: '写出', hint: '工具**写**出的文件' },
        { dir: 'input', label: '读入', hint: '工具**读**到的文件' },
      ];
      for (const g of groups) {
        const rows = uniq.filter((x) => (x.direction || '') === g.dir);
        if (!rows.length) continue;
        html += '<h3>' + esc(g.label) + '<span class="faint"> · ' + rows.length + '</span></h3>';
        html += '<ul class="wb-art">';
        for (const a of rows) {
          const p = String(a.path || '');
          const name = wbPathName(p) || p;      // 与工作区弹框同一个"取末段名"（不另写一份）
          const dir = p.slice(0, p.length - name.length).replace(/[\\/]+$/, '');
          // 能不能打开由**服务端**判（它才知道那个路径在不在、是不是文件）——
          // 前端不猜。`wbOpenArtifact` 打开失败时如实报一句，不假装成功。
          const btn = '<button class="wb-art-row" ' + act('wbOpenArtifact', p)
            + ' title="用系统默认程序打开\n' + esc(p) + '">'
            + wbIcon('file', 'sm')
            + '<span class="wb-art-name">' + esc(name) + '</span>'
            + '</button>';
          html += '<li>' + btn
            + '<div class="wb-art-meta">'
            + '<span class="wb-art-dir mono" title="' + esc(p) + '">' + esc(dir || p) + '</span>'
            + (a.tool_name ? '<span class="wb-art-tool">' + esc(a.tool_name) + '</span>' : '')
            + '</div></li>';
        }
        html += '</ul>';
      }
      // 底部说清这条清单的边界（原文保留，只是从"每行都重复一遍"改成"整块说一次"）
      html += '<div class="faint wb-art-note">路径来自工具入参/结果的字符串层提取 —— 工具不报就记不到。</div>';
    }
    html += '</div>';
  }

  // ⚠️ 这里**不要**再补收尾的 `</div>`。0.21.9 之前本函数自带 `.wb-rail-inner` 外壳，
  //    现在外壳由 `wbRailHtml` 负责（只有一层），本函数只产出面板内容。
  //    多写一个 `</div>` 的后果不是"样式难看"：右栏之后的所有兄弟节点会被带进这一层里，
  //    主区/输入卡的网格位置全乱 —— 而那看起来"跟右栏没什么关系"，最难往这里想。
  return html;
}

/** 工作台整页（0.21.2 起是**全屏视图**，不再套管理后台外壳 —— 见 90-start.js 的 fullBleed 分支）
 *
 * 布局对齐原生 Harness 第一屏：
 *   左栏 = 品牌头（含收起钮）/「工作区」节头（划过才现的过滤与新建）/ 树 / 底部（管理后台·设置·账号条）
 *   主区 = 右上「上下文面板」开合钮 / 空态品牌页 / **会话框的选项卡（对话·轨迹）** / 消息流或轨迹 / 徽片行 + 输入卡
 *   右栏 = 上下文面板（当前会话用量 + 产物）
 * 功能一概不减：原来摊在页头的一排按钮收进「⋯」菜单与右上图标钮（0.21.1 已做了大半）。
 *
 * ⚠️ 「对话 / 轨迹」这两个选项卡**属于主区**，不属于右栏（0.21.9 定版，用户 2026-10-08 裁定）：
 *    轨迹是这个会话的内容，右栏装的是会话旁边的材料（花了多少、产出了哪些文件）。
 * ⚠️ 0.21.7 起**唯一**一个"减掉的入口"是会话内检索（整块删除）与清屏 —— 那是用户裁定，
 *    两者都不是被藏起来，是连同实现与服务端路由一起删掉（见文件内各自那段删除说明）。
 * 图标一律走 `wbIcon()`（内联 SVG）—— 不再用 ⇤ ⌕ ⟳ ＋ 这类散装 Unicode 字形。
 */
function pageWorkbench() {
  const w = State.wb;
  // ── 数据没回来之前：什么都不画（0.21.9）─────────────────────────────
  //
  // 用户 2026-10-08：「整个页面在刷新过程中可以隐约看到左侧有未分组、右侧会话框显示到
  // 中间（还有模式可选），感觉很乱，这又是什么」。
  //
  // 那不是另一个页面，是**同一页按"空状态"先画了一遍**：数据还没到，`sessions` 是空的、
  // `wsActiveId` 是 null —— 于是左树按"正停在未分组上"渲染出那一行，主区按"没有会话"
  // 渲染出品牌页 + 居中输入卡（模式下拉只在这个态出现）。数据一到，整页换装。
  //
  // 修法不是把某个元素藏起来，而是**承认这一刻什么都不该画**：中间态不该长得像一个
  // 可用状态。`ready` 只在第一次加载跑完后置位（见 71-app-workbench.js 的 wbEnsureLoaded），
  // 所以之后的重拉（`wbInvalidate`）不会让界面退回这里 —— 那时用户手里已有上一份数据。
  if (!w.ready) {
    return '<div class="wb"><div class="wb-boot">'
      + '<span class="spinner"></span><span>正在读取工作区与会话…</span>'
      + '</div></div>';
  }
  const canSend = allowed('session', 'execute');
  const canWrite = allowed('session', 'write');

  let html = '<div class="wb' + (w.railOpen ? '' : ' rail-closed') + (w.sideOpen === false ? ' side-closed' : '') + '">';

  // ── 左：工作区树 ──────────────────────────────────────────────
  html += '<aside class="wb-side">';
  html += '<div class="wb-brand">'
    + '<span class="wb-logo">STI <b>HARNESS</b></span>'
    + '<button class="wb-iconbtn" ' + act('wbToggleSide') + ' title="收起左栏">' + wbIcon('sidebar') + '</button>'
    + '</div>';
  // 0.21.6：这里原本有一个「✦ 新会话」胶囊和一个「🧩 插件」入口，两个都删了（用户裁定）。
  //   · 新会话 → 移到每个工作区行右侧的 ＋。理由不是"少一个按钮"，而是它**必须依附一个
  //     工作区**，而顶部那个胶囊建到哪去取决于树上当前选中谁 —— 于是"点顶部按钮"之前
  //     还得先回头看树上选中的是谁。放进行里之后，"在哪建"由"在哪点"直接回答。
  //   · 插件 → 删了。它指向的是能力清单页（`#/capabilities`），那页仍在底部
  //     「管理后台」里可达；左栏顶部这些位置留给树本身。
  // 0.21.7：节头两个动作**划过这一行才出现**（用户裁定）。第三个「⟳ 重新拉取工作区与会话列表」
  //   整个删掉了 —— 树在切会话、建/删/改之后都会自己重拉，"手动刷新"是个多余且容易误判的入口
  //   （点了没变化时用户会以为"坏了"）。`wbEnsureLoaded` 本身仍被这些路径调用，删的只是这个按钮。
  html += '<div class="wb-sec-head">'
    + '<span class="wb-sec-title">工作区</span>'
    + '<span class="wb-sec-tools">'
    + '<button class="wb-iconbtn" ' + act('wbToggleTreeFilter') + ' title="过滤">'
    + wbIcon('search', 'sm') + '</button>'
    + '<button class="wb-iconbtn" ' + act('wbNewWorkspace') + (canWrite && !w.streaming ? '' : ' disabled')
    + ' title="新建工作区">' + wbIcon('folderPlus', 'sm') + '</button>'
    + '</span></div>';
  // 过滤输入框默认收起：一进来先看到树本身，而不是一排控件（节头的 ⌕ 切换）。
  if (w.treeFilterOpen) {
    html += '<input id="wb-tree-filter" class="wb-tree-filter" type="search" placeholder="过滤工作区 / 会话"'
      + ' value="' + esc(w.treeFilter || '') + '"' + actCh('wbTreeFilter') + '>';
  }
  if (w.wsError) html += '<div class="note fail">' + esc(w.wsError) + '</div>';
  if (w.error) html += '<div class="note fail">' + esc(w.error) + '</div>';
  html += '<div class="wb-tree">' + wbTreeHtml() + '</div>';
  // 底部：管理后台 / 设置 / **账号条**。
  // ⚠️ 账号条不是装饰，是补一个**真实缺陷**：全屏视图（0.21.2）不再渲染顶栏，
  //    而「登出」此前**只存在于顶栏**里 —— 进了工作台就再也登不出去，只能先绕去别的页。
  //    整屏改动砍掉既有能力是不可接受的，所以登出必须在这里有一个可达入口。
  const me = (State.me && State.me.user) || null;
  html += '<div class="wb-side-foot">'
    + '<a class="wb-sideitem" ' + navAttr('#/overview') + '><span class="wb-sideitem-ico">' + wbIcon('grid', 'sm') + '</span>管理后台</a>'
    + '<a class="wb-sideitem" ' + navAttr('#/settings') + '><span class="wb-sideitem-ico">' + wbIcon('gear', 'sm') + '</span>设置</a>';
  if (me) {
    html += wbAccountHtml(me);
  }
  html += '</div>';
  html += '</aside>';

  // ── 收起态：左侧竖排入口栏（0.21.8）──────────────────────────────
  // 用户要的是"收起之后左侧仍立着一列入口"，而不是"一颗孤零零的展开钮"。
  // 0.21.7 只补了那颗展开钮 —— 它修好了"展不开"，但收起来之后
  // 「管理后台 / 设置 / 我的账号」三个入口**跟着整栏一起消失**了（它们住在
  // `.wb-side` 底部的 `.wb-side-foot` 里，被 `.wb.side-closed .wb-side{display:none}` 一起藏掉）。
  // 于是"收起左栏"事实上等于"丢掉整个治理面导航"：想进后台或看账号，只能先把栏展开。
  // 做法上有一个刻意的选择：这一列是**网格里真实的一列**（`.wb.side-closed` 多留 56px），
  // 不是绝对定位悬浮在主区上。悬浮版看着更省事，但窄视口下必然压住正文列左缘，
  // 而且"到底有没有东西被盖住"要靠算才知道 —— 有自己一列，边界就是明摆着的。
  // 布局（用户 2026-10-08 裁定）：**展开在顶、三个导航在底**。
  //   展开左栏留在原来收起钮的位置（一进一出同一处，视线不用移动）；
  //   管理后台 / 设置 / 我的账号贴栏底 —— 与展开态 `.wb-side-foot` 的位置一一对应。
  // ⚠️ 这里**没有**「登出」：用户清单里没提它，而登出是 `.wb-side-foot` 里另一颗独立的钮 ——
  //    要不要一并搬进来由用户定，不在这一条改动里自作主张。
  if (w.sideOpen === false) {
    html += '<nav class="wb-siderail" aria-label="左栏已收起：展开与治理面入口">'
      + '<button class="wb-iconbtn wb-side-expand" ' + act('wbToggleSide') + ' title="展开左栏">'
      + wbIcon('sidebar') + '</button>'
      // 这三项**贴栏底**（`.wb-siderail-foot` 是 `margin-top:auto`），位置与展开态里
      // 那三个入口（`.wb-side-foot`，同样在左栏最下面）**一一对应** ——
      // 同一个东西在两种状态下落在同一处，视线不用重新找。
      + '<div class="wb-siderail-foot">'
      + '<a class="wb-iconbtn" ' + navAttr('#/overview') + ' title="管理后台">'
      + wbIcon('grid') + '</a>'
      + '<a class="wb-iconbtn" ' + navAttr('#/settings') + ' title="设置">'
      + wbIcon('gear') + '</a>'
      + '<a class="wb-iconbtn" ' + navAttr('#/me')
      + ' title="我的账号">'
      + wbIcon('user') + '</a>'
      + '</div>'
      + '</nav>';
  }

  // ── 中：对话 ─────────────────────────────────────────────────
  // ⚠️ 0.21.9：**没有"空态"这一套了**（用户 2026-10-08 裁定）。
  //
  // 从前这里有 `isEmpty`（没有会话且没有消息）一个分支，它渲染的是另一副样子：
  // 品牌页 `.wb-hero` + **垂直居中**的输入卡（`.wb-main.is-empty{justify-content:center}`），
  // 页签条也不画。用户的原话是「为什么是两套」「搞成一套，统一新建会话后的样式，
  // 不再搞什么会话前的样式，增加复杂性」。
  //
  // 他说得对。那个分支买到的东西只有"第一屏好看一点"，代价是：
  //   ① 同一块区域有**两种布局**，用户每次"新建会话"都要看它跳一次（居中 → 靠下、
  //      页签从无到有）。跳变本身比"朴素但恒定"更让人怀疑是不是坏了；
  //   ② 它的判据是 `!sessionId && !msgs.length` —— 而 `sessionId` 在**新建的那一刻**
  //      就非空了（`wbNewSession` 一返回就设上），所以那个"好看的第一屏"其实只在
  //      "还没点过任何会话"时出现过一次，之后就再也不出现了。为一次出现维护第二套布局。
  //
  // 现在只有一套：**页签条 + 消息流 + 输入卡，恒渲染**。没有会话时消息流里是
  // 一句"这个会话还没有消息"（见 wbStreamHtml），位置与有会话时逐字相同。
  html += '<section class="wb-main">';
  // ⚠️ 展开钮**不再**渲染在这里。0.21.7 它是主区左上角一颗绝对定位的孤钮，
  //    0.21.8 起搬进了上面那个 `.wb-siderail`（`wb-side-expand` 这个类名保留，
  //    便于回归继续指认"哪一颗是展开钮"）。它仍然满足 0.21.7 那条硬约束：
  //    必须在 `.wb-side` **之外** —— 栏内那颗收起钮会跟着 `display:none` 一起消失。
  // 右上幽灵图标钮（0.21.7 只剩一件事：上下文面板开合）。
  // ⚠️ 0.21.7 从这里删掉了两颗钮，都是用户裁定的：
  //   · 「会话内检索」→ **整块删除**（连服务端 `/api/kernel/sessions/:id/search` 路由、
  //     消息卡上的命中高亮一起删）。只删按钮会留下一份没有入口的实现 —— 那正是本项目
  //     一直在清的东西（"藏起来的那份会一直在"）。
  //   · 「清屏」→ 删掉。它只清当前视图、不动库里事件，而**换会话本来就会换一份视图** ——
  //     一个"看起来会删东西、其实什么都不删"的按钮，留着只会让人误判。
  //   ⚠️ **「停止」保留**（流式中才出现）：那是功能不是噪音 —— 不摆它就没法中止一轮
  //     正在烧 token 的对话，而且它只在流式期间存在，不占常态视觉。
  html += '<div class="wb-top">'
    + (canSend ? '' : '<span class="badge dim" title="当前角色没有 session:execute">只读</span>')
    + (w.streaming ? '<span class="spinner"></span>' : '')
    + (w.streaming
      ? '<button class="wb-iconbtn" ' + act('wbStop') + ' title="① 通知上游取消本轮；② 本地立刻停止接收。两件事一起做才算真停 —— 只断开读取的话上游还在烧 token。">'
        + wbIcon('stop') + '</button>'
      : '')
    // 0.21.9：它开的仍然只是一块「上下文面板」（轨迹已经搬回主区，不在这里）——
    // 标题沿用**用户自己的叫法**（"只保留上下文面板"），再把装的东西写清楚，
    // 用户按下去不会以为多出了一个会话内容区。
    // ⚠️ "上下文面板"这四个字别去掉：它是这颗纯图标钮**唯一**的可读标签
    //    （test-browser S19 有一条断言钉着 title 里要能读到它）。
    + '<button class="wb-iconbtn" ' + act('wbToggleRail') + ' title="上下文面板（当前会话的用量与产物）">'
    + wbIcon('sidebarRight') + '</button>'
    + '</div>';
  // ⚠️ 这一行是补一个**真实缺陷**：工作台往 `State.wb.notice` 写了 4 处提示
  //（新建会话 / 模型登记 / 附件上传部分失败 / 停止的上游结果），却**从来没渲染过**。
  // 后果最重的是"模型登记"那条 —— 用户在成本页看到用量进了「未归因」桶，
  // 而界面当时明明想说"已为本会话登记模型：…"，只是没显示出来。
  if (w.notice) html += '<div class="wb-notice note">' + esc(w.notice) + '</div>';
  // ⚠️ 0.21.9：这里曾有「空态品牌页」`.wb-hero`（大 logo + 一句引导语）。随空态分支
  //    一起删除 —— 它唯一的职责是让"还没有任何会话"的那一屏好看些，而那一屏现在
  //    与有会话时**逐字同构**：树上有默认工作区，主区有页签 + 一句空消息 + 输入卡。
  //    那句引导语本身也已经过期（"选好工作区与模式" —— 模式已经不在界面上了）。
  // 会话框自己的选项卡（0.21.9 定版：「对话 | 轨迹」）—— 恒渲染。
  // ⚠️ 空态也要画它：页签是**这个会话框的骨架**，不画会得到一个"没有页签的会话框"，
  //    那正是用户说的"两套样式"。它现在是有会话/没会话都一样的那个样子。
  html += wbViewTabsHtml();
  // 消息流：role=log + aria-live —— 消息是**流式**到达的，读屏用户必须能"听"到新消息
  //（role=log 是会话型日志区的标准语义，隐含 polite；显式写上便于一眼确认）。
  // 0.21.7：内容套一层与输入卡同宽的 `.wb-stream-inner` —— 对话内容因此与输入卡左右对齐、
  //   整块居中，两侧留白不再只有 24px 而消息还贴左边。
  // 0.21.9：这一层现在装的是**当前选项卡**的内容（对话 或 轨迹），见 wbViewBodyHtml。
  //   ⚠️ 内容**不在这里拼**，走 `wbStreamShellHtml()` —— 因为 `App.wbPaint()` 也要写
  //      同一个 innerHTML，两边各拼一遍就会出现"一处套了那一层、一处没套"，
  //      而那一层决定宽度 → 用户看到提交瞬间的 48px 宽度闪动。见 wbStreamShellHtml 的说明。
  // ⚠️ `aria-label` 要跟着换：同一个容器在「轨迹」页签下装的是过程记录，
  //    读屏用户听到"对话消息流"会以为里面是对话 —— 那是个会让人找错东西的标签。
  const onTrace = State.wb.viewTab === 'trace';
  html += '<div class="wb-stream" id="wb-stream" role="log" aria-live="polite"'
    + ' aria-label="' + (onTrace ? '轨迹：这个会话每一轮的过程记录' : '对话消息流') + '">'
    + wbStreamShellHtml()
    + '</div>';
  html += wbKbStripHtml();
  html += wbAttachStripHtml();
  html += wbComposeHtml(canSend);
  html += '</section>';

  // ── 右：上下文 ───────────────────────────────────────────────
  if (w.railOpen) html += '<aside class="wb-rail" id="wb-rail">' + wbRailHtml() + '</aside>';

  html += '</div>';
  return html;
}

/**
 * 输入卡（0.21.2 重做，对齐原生 Harness）：
 *   徽片行（工作区 · 模式）在卡片**上方**，卡片内部右下是模型 / 推理等级 / 圆形发送钮。
 * 会话内的选择器**立即登记到本会话**（模型与等级一项接口落库），没会话则作为新对话的默认。
 * 归因徽标（服务端记下了什么）放在左下、与档位徽片同排 —— 它是"事实核对"，不是选择器。
 */
function wbComposeHtml(canSend) {
  const w = State.wb;
  const busy = w.streaming;

  let html = '<div class="wb-compose-wrap">';

  // 徽片行：**整块删除（0.21.9）**。
  //
  // 用户 2026-10-08：「工作区那一行信息也可以删掉（对话输入框上面一行）」。
  //
  // 它上面一共挂过三样东西，前两样早一步就没了，这里把最后一样也拿掉：
  //   · 没会话时的**工作区下拉** —— 0.21.6 删（它与左侧树是两个改同一件事的入口，
  //     用户可以在下拉里选 A、再从树上点 B，而界面不告诉你哪个算数）；
  //   · **模式徽片**（有会话时这个会话登记的模式，没登记时说「未指定」）—— 0.21.9 删
  //     （模式整个概念不在界面上了）；
  //   · **工作区徽片**（"这个会话在哪个工作区"，只有内边距的一行、恒不换行）—— 就是现在删的。
  //
  // 为什么最后这一样也该走：它是一条**纯复述**（displays 一个用户刚刚在上面点过的位置），
  // 却常驻占掉输入卡上方一整行的高度，把"输入框"和"对话正文"推得更远。
  // 会话属于哪个工作区**在左侧树上就有**：那一行是高亮的、名字就在那里。
  // 删掉它之后，输入卡上方不再有第二次陈述 —— 也因此 `wb-chips` / `wb-chip.ghost`
  // 这两条 CSS 规则一起删（见 style.css 里那段说明），不留"藏起来的那份"。
  //
  // ⚠️ 同时注意：`curWs` 这个局部变量也一并删掉。它就是为这一枚徽片查的，
  //    留着会变成"一个算了却没人读的值"——下一个人会以为别处还在用它。

  // 卡片
  html += '<div class="wb-card">';
  // 隐藏的文件选择框：附件走"原始字节 + ?filename="，不用 multipart（见服务端 readRawBody 注释）
  html += '<input type="file" id="wb-file" multiple style="display:none" ' + actCh('wbFilesChosen') + '>';
  html += '<textarea id="wb-input" placeholder="' + (canSend ? '输入问题，回车发送（Shift+回车换行）' : '当前角色只能查看，不能发起对话') + '"'
    + (canSend && !busy ? '' : ' disabled') + '></textarea>';
  html += '<div class="wb-card-foot">';

  // 左：＋附件。
  // ── 「模型未归因 / 已归因模型」徽标：删除（0.21.7）────────────────────────
  // 这里曾有两个徽标（`wbFootModelNote()`）：会话登记过模型时显示「已归因模型 provider/model」，
  // 没登记时显示「模型未归因（用量会进未归因桶）」。用户的反应是"模型未归因又是个什么…
  // 右边不是有模型选择和推理等级吗（右侧选择哪个模型会话就绑定哪个模型不行吗）"。
  //
  // 他说得对，那个徽标在解释一个**不该存在的问题**：
  //   · 徽标想表达的是"选择器 ≠ 服务端记下的那个"。可归因的真实链路是
  //     `agent_sessions.model_id`（kernel.mjs 的 runTurn 用它算用量）—— 发回合的请求体里
  //     **根本不带模型**。也就是说：只要"选择器显示的"和"会话绑定的"不是同一件事，
  //     用户看到的模型就不是真正在用的那个。
  //   · 正确的修法不是再补一个"归因状态"的第三概念，而是**把两者变成一件事**：
  //     选择器就是会话的绑定项。所以：
  //       ① 新建会话时选择器的值随请求体提交（`wbNewSession` 里的 `body.model`）；
  //       ② 打开已有会话时若服务端记着模型而本地没绑，就地补绑一次
  //          （`wbRefreshContext` 里的 `POST …/model`），失败静默 —— 无权限/会话已删
  //          不该弹一个用户无从处理的错误；
  //       ③ 选择模型时立即登记（`wbSelectModel`），并如实播报后果。
  //     这样"选中的"恒等于"绑定的"，徽标无事可报，删除它。
  // ⚠️ 删的是**徽标**，不是归因能力：`modelRecorded` / `modelRecordedProvider` 这两个状态
  //    仍在用（下拉回显要按它选中），成本报告里的"未归因"桶也照常存在 —— 那是账本的事实。
  html += '<div class="wb-foot-left">';
  html += '<button class="wb-iconbtn wb-add" ' + act('wbPickFiles') + (canSend && !busy && !w.attachBusy ? '' : ' disabled')
    + ' title="上传附件。图片（按内容识别）会作为图片内容块送给模型；文本类会把正文注入本轮上下文；其余文件只登记与展示，不会交给模型。">'
    + wbIcon('clip') + '</button>';
  html += '</div>';

  // 右：模型 · 推理等级 · 圆形发送
  //
  // ── 0.21.9：两枚下拉的**底色与字色**（用户 2026-10-08，第二次裁定）──────────
  //
  // 用户第一句是「对话框大模型及推理等级下拉框样式颜色有问题重新修改」。我把它读成
  // "箭头有问题"，改了箭头。他的回应是：
  //   「改的锤子啊，好好看看下拉框颜色 看什么颜色 背景色 字体颜色」
  // —— 他指的是**这两枚下拉实际落在什么底色、什么字色上**，箭头是次要的。
  //
  // 查证（改前）：`.wb-chip.ghost` 给 `background: transparent; color: var(--text-dim)`，
  // `.wb-chip select` 又写 `background: transparent; color: inherit` —— 于是整块**透明**，
  // 底就是卡片自己的 `--bg-panel`。也就是说：两枚下拉与卡片背景**逐像素同色**，
  // 用户看到的是"两段穿插在卡片里的小灰字"，不是一个能点的控件。
  // 详细复盘见 style.css 的 `.wb-chip select` 与 `.wb-chip.ghost.chip-ctl` 两段注释。
  //
  // 修法（只在 CSS 里改，这里的标记**不动**）：给 `.wb-chip.ghost.chip-ctl` 一个可见的底
  // （--bg-subtle，朝"凹进去"一档）与边（--border），字色提到 --text。
  // select 保持 `color: inherit; background: transparent` —— 由容器一处定义、两处继承。
  //
  // ⚠️ 唯一稳定钩子仍是 `#wb-model` / `#wb-effort` 两个 id，以及 `.wb-chip.ghost.chip-ctl`
  //    这个容器类 —— 别再加只有名字没有样式的类（`wb-model-chip` 就是这么变成死类的）。
  // ⚠️ 箭头那一轮的改动**保留**（它修的是另两个真缺陷：位图取不到 currentColor、
  //    所以暗色主题下看不清；以及 :disabled 时箭头不跟着淡）。见下面 `.wb-sel-caret`。
  html += '<div class="wb-foot-right">';
  // ⚠️ 这里从前还挂着一个 `wb-model-chip` —— 0.21.9 查证：**样式表里没有它、
  //    测试与文档里也没人引用**，是纯死类（与 `.chip-ctl` 那次是同一种病：
  //    HTML 写着一个没人认领的类名）。已删掉。要区分这两枚徽片请用 `#wb-model`
  //    / `#wb-effort` 的 id —— 那是真正稳定的钩子。
  html += '<span class="wb-chip ghost chip-ctl">'
    + '<select id="wb-model" ' + actCh('wbSelectModel') + (w.models.length ? '' : ' disabled')
    // ⚠️ 提示必须**两种情形都成立**（0.21.9，用户问"是否准确"——查了，从前那句不完全准确）：
    //    这条下拉在有会话 / 没会话时行为不同 ——
    //      有会话：change 立刻 POST …/model，服务端落库（下次打开按落库值回显，71-app 的 wbSelectModel）；
    //      没会话：**什么都不登记**，只存本地，等建会话时随请求体提交。
    //    从前写的"选中即登记到本会话"只对前一种成立 —— 而**新建会话时恰恰没有会话**，
    //    那句话在用户最常停留的时刻是假的。改成按情形说清，只留一句猜不到的后果（用量归因）。
    + ' title="这个会话用哪个模型：选中立即登记到会话（下次打开仍记着）。'
    + '还没有会话时，它就是新会话的默认。后续用量按模型名归因。" aria-label="模型">'
    + (w.models.length
      ? w.models.map((m) => '<option value="' + esc(m.value) + '"' + (m.value === w.modelValue ? ' selected' : '') + '>'
          + esc(m.label) + '</option>').join('')
      : '<option value="">（模型目录不可用）</option>')
    + '</select>'
    // 箭头：`aria-hidden` —— 它是纯装饰，可读语义由 `<select>` 自己的 aria-label 提供，
    // 读屏器再念一遍"下箭头"是噪音。
    // ⚠️ 这里**不传** `'sm'`：箭头尺寸由 CSS 的 `.wb-chip .wb-sel-caret .wb-ico`（12px）定。
    //    传了 `'sm'` 也不会错（CSS 特异度更高、照样被压成 12px），但那会让人以为
    //    "尺寸是这里给的" —— 一处样式两个来源，下次改的时候必然只改到一处。
    + '<span class="wb-sel-caret" aria-hidden="true">' + wbIcon('chevronDown') + '</span>'
    + '</span>';
  const efforts = wbEffortOptions();
  if (efforts.length) {
    html += '<span class="wb-chip ghost chip-ctl">'
      + '<select id="wb-effort" ' + actCh('wbEffortPick')
      // 与模型下拉同一套口径、同一套验证（0.21.9）：有会话 → 立即登记（随模型一次落库，
      // 重启后按会话行回显）；没会话 → 只存本地，等建会话时提交（不落库、刷新即还原 ——
      // 这半句从前没说，容易读成"和会话一样记着"）。
      + ' title="推理等级：有会话时切换会立即登记到会话（下次打开仍记着）。'
      + '还没有会话时，它就是新会话的默认。" aria-label="推理等级">'
      + efforts.map((e) => '<option value="' + esc(e.id) + '"' + (w.effort === e.id ? ' selected' : '')
        + ' title="' + esc(e.description || '') + '">' + esc(e.name || e.id) + '</option>').join('')
      + '</select>'
      // 同模型的箭头：尺寸由 CSS 定，这里不传 'sm'（理由见上面）。`aria-hidden` 同理。
      + '<span class="wb-sel-caret" aria-hidden="true">' + wbIcon('chevronDown') + '</span>'
      + '</span>';
  }
  html += '<button class="wb-send" ' + act('wbSend') + (canSend && !busy ? '' : ' disabled')
    + ' title="发送（回车发送，Shift+回车换行）" aria-label="发送">' + wbIcon('arrowUp') + '</button>';
  html += '</div>';

  html += '</div></div></div>';
  return html;
}

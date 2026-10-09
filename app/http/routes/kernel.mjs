/**
 * 内核路由：会话、回合、事件、模型。
 *
 * 这一层**只认契约**（kernel.provider.*），不认识任何上游概念。
 * 会话在本地库有一份映射（`agent_sessions.kernel_session_id`），
 * 事件落本地库（`events` 表），因此"轨迹/交付物/统计"永远有数据源，
 * 不依赖上游是否还能回放。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { readJsonBody, readRawBody } from '../context.mjs';
import { openNdjsonStream } from '../stream.mjs';
import { errors } from '../../util/errors.mjs';
import { safeBaseName } from '../../util/fname.mjs';
import { nowIso } from '../../util/ids.mjs';
import { versionGate, readRawConfigFile, ENV_NAMES } from '../../config.mjs';
import { describeKernelRestart } from '../../kernel/connection-config.mjs';
import { sanitizeKernelEvent } from '../../kernel/index.mjs';
import { tx } from '../../data/db.mjs';
import * as sessions from '../../data/repositories/sessions.mjs';
import * as events from '../../data/repositories/events.mjs';
import * as attachments from '../../data/repositories/attachments.mjs';
import * as artifacts from '../../platform/governance/artifacts.mjs';
import * as audit from '../../platform/governance/audit.mjs';
import * as caps from '../../platform/capability/service.mjs';
import * as metrics from '../../platform/observe/metrics.mjs';
// 通知的产生方入口（节流规则在那里，不在这里）—— 本路由是平台的强制点之一：
// 并发闸在这儿拦下请求，所以"拦下了要有人知道"也从这儿出去。
// ⚠️ 这里通过 `deps.notify` 拿到服务，而不是 import 具体实例 —— 与全项目一致（见 createServer）。
import { emitQuotaBlocked } from '../../platform/notify/producers.mjs';
// 会话列表要回显"这条会话我能不能管"（改名/删除/移动）—— 判据必须与动作守卫同源。
// 这里只用它读一次"当前角色有没有全局 session:write"，档位那一半在工作区服务里。
import { can } from '../../platform/identity/permissions.mjs';
import { STORAGE_DIR, UPLOAD_DIR } from '../../paths.mjs';
import {
  sniffImageMediaType, toImagePart, describeImages, isImageMediaType, humanBytes,
  IMAGE_MEDIA_TYPES,
} from '../../platform/attachment/content.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** M0 尚无身份体系：所有数据落在一个默认租户下。M1 起由 tenant 中间件注入。 */
const DEFAULT_TENANT = 'default';
const tenantOf = (ctx) => ctx.tenantId || DEFAULT_TENANT;

/* ── 会话附件（3.6）：上限与消毒 ───────────────────────────────
 *
 * 三个上限都必须**写死在一处并如实回给前端**，否则用户只会看到一句
 * "上传失败"，不知道是自己文件太大还是平台坏了。
 */
/** 单个附件字节上限（8MB）。再大就不该走对话附件，该走知识库导入。 */
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
/** 一轮对话里**注入上下文**的文本总上限。超了不注入，但如实报出是哪几个没进去。 */
const INJECT_MAX_BYTES = 96 * 1024;
/** 判为"文本附件"的字节上限：超过这个大小，即便能解码也不注入（避免把 8MB 日志塞进请求体）。 */
const INJECT_PER_FILE_MAX = 64 * 1024;

/* ── 图片附件的上限（A 档：真的把图送给模型）─────────────────────
 *
 * 先说清楚**哪个约束是真在起作用的**，免得写下一个永远不会触发的分支：
 *
 *   单张上限 = `ATTACH_MAX_BYTES`（8MB，就是上传上限）。
 *     刻意**不再另设一个更小的数** —— 设了也永远不会触发（存进来的东西
 *     本来就不超过上传上限），那就是"写了但从不生效"的死代码，
 *     比没有更糟：它让人以为那里有一道防线。
 *     所以单张图片的约束**已经由上传接口承担**，这里不重复实现。
 *
 *   本轮合计上限 = `IMAGE_TOTAL_MAX`（10MB）。**这一条才是真正会拦人的**：
 *     8MB 的单张上限 × 想发几张就发几张，很容易把请求体撑爆。
 *
 * 为什么合计是 10MB 而不是更大 —— 唯一的瓶颈是**我们自己的请求体**：
 *   图片要以 base64 进 JSON，字节膨胀 4/3。
 *     IMAGE_TOTAL_MAX(10MB) × 4/3 ≈ 13.3MB
 *     + INJECT_MAX_BYTES(96KB) ≈ 13.4MB  <  TURN_BODY_MAX(16MB) ✓
 * 上游自己的限额（单张 20MiB、单条消息 200MiB）比这宽得多，不是瓶颈。
 * 改任何一个数都要重算这条不等式。
 */
/** 本轮所有图片**合计**的原始字节上限（base64 后会变成约 13.3MB）。 */
const IMAGE_TOTAL_MAX = 10 * 1024 * 1024;
/** 回合提交接口的请求体上限。只为"带图片的一轮"放宽，其余接口仍用 256KB 默认值。 */
const TURN_BODY_MAX = 16 * 1024 * 1024;
/**
 * 注入正文与用户原始输入之间的**分界标记**。
 *
 * 为什么需要一个标记：注入之后，`turn-start` 事件的 text 就是"用户输入 + 附件正文"，
 * 而工作台要把它回放成**用户气泡**。不回放全量是**说谎**（那确实是发给内核的内容），
 * 把 60KB 文件糊进气泡里又没法用。标记让前端能精确地切成两段：
 *   气泡显示用户真正打的字 + 一句"＋N 个附件已注入"，「轨迹」里仍是完整原文。
 *
 * ⚠️ 这个字面量在 `public/app/84-workbench.js` 里有一份**必须一字不差**的副本（`WB_ATTACH_MARKER`），
 * 由 `test-frontend` 的契约对账用例钉住 —— 改了这里不改那里，回归会红。
 * 刻意不做成模块共享：为了一个常量把服务端模块引入前端打包，代价大于收益。
 */
const ATTACH_INJECT_BEGIN = '\n\n<<<STI-ATTACHMENTS>>>\n';

/* ── 会话挂载知识库（0.14.0）：RAG 闭环的平台侧实现 ──────────────
 *
 * 目标：让"企业知识库"真的进入对话。做法是**上下文注入**，不是工具调用 ——
 * 平台侧工具执行在真实内核上并不存在（assessment-0.11.0 §B7），走那条路会立刻卡死；
 * 而"平台能往本轮 content 里写字"这件事已由附件正文注入（0.10.0）证明成立。
 *
 * 三条边界（页面与事件帧里都如实标注，不只藏在这里）：
 *   · **注入 = 平台把片段拼进 content**，所以"模型看到了这段文字"是成立的 ——
 *     它不依赖上游任何扩展点，因此对**任何**满足契约的内核都同样有效。
 *   · **挂库 ≠ 可见**：检索走 knowledge.search，那里的库级 ACL 会丢弃不可见库
 *     并记 note。库后来被收紧而用户无权 → 那一份静默忽略，**不泄漏、不打断对话**。
 *   · **检索失败不打断对话**：把失败如实写进事件帧（`notes`），绝不假装"检索过但没命中"。
 *
 * 上限：单条片段截断到 `KB_CHUNK_MAX_BYTES`，本轮合计 `KB_INJECT_MAX_BYTES`。
 * 与附件共用 `TURN_BODY_MAX` 的预算，16KB ≪ 96KB（附件额度），不改变上面那条不等式。
 */
/**
 * 命中片段条数上限。5 是一个刻意的**保守值**：每个片段都会真实占用上下文与费用，
 * 而当前检索默认是纯文本（bigram + bm25）—— 相关性排序不如向量可靠时，
 * 多塞几条的边际收益会迅速变成噪声。要更多请从模型侧（长上下文）解决，不是从这里加。
 */
const KB_INJECT_TOP_K = 5;
/** 单条知识片段注入的字节上限（约 1500 字）。超了截断并标 `truncated`，不静默丢。 */
const KB_CHUNK_MAX_BYTES = 6 * 1024;
/** 本轮注入知识片段**合计**的字节上限。 */
const KB_INJECT_MAX_BYTES = 16 * 1024;

/**
 * 知识段与前面内容之间的分界标记（与 `ATTACH_INJECT_BEGIN` 同一条纪律）。
 *
 * ⚠️ 同样的字面量在 `public/app/84-workbench.js` 里有一份必须一字不差的副本
 * （`WB_KB_MARKER`），由 `test-frontend` 的契约对账用例钉住 —— 改一边不改另一边，
 * 回归会红（这正是那个用例存在的理由）。
 */
const KB_INJECT_BEGIN = '\n\n<<<STI-KNOWLEDGE>>>\n';

/**
 * 文件名净化（`safeBaseName`）已收归 `app/util/fname.mjs` 单点 —— 它是**防路径穿越**的
 * 那一层，与 `knowledge/service.mjs` 共用同一条规则。历史体检（assessment-0.11.0 §A1-#4）
 * 指出"两份拷贝意味着加固了一处、漏了另一处是可能的"，故此处不再保留同款实现。
 * 本文件调用 `safeBaseName(filename, 'attachment')`（兜底名各调用方自取）。
 */

/**
 * 判定附件是不是"文本"。
 *
 * 判据是**内容**而不是扩展名：一个叫 .txt 的文件可能是二进制（改过扩展名），
 * 一个叫 .log 的也可能是。只要出现 NUL 字节就按二进制处理；
 * 再用 `toString('utf8')` 往返比对一次，确认它是合法 UTF-8
 * （非法序列会被替换成 U+FFFD，往返对不上就说明不是文本）。
 */
function classifyBuffer(buf, isUtf8) {
  if (buf.includes(0)) return 'binary';
  const text = buf.toString('utf8');
  if (isUtf8 && !Buffer.from(text, 'utf8').equals(buf)) return 'binary';
  return 'text';
}

/**
 * 把选中的附件拼成本轮要交给内核的东西。
 *
 * ⚠️ 诚实边界（页面上也写了同样的话，不是只藏在这里）：
 *   · 本平台**不转发**请求 —— `content` 就是原样交给内核的东西，附件的正文是
 *     **平台拼进 content** 的，所以"模型看到了这段文字"对文本类是成立的。
 *   · **图片**：按魔数认出白名单格式（PNG/JPEG/WebP/GIF）后，装成上游的
 *     `{type:'image', mediaType, data(base64), name}` 内容块，**字节真的送到模型**。
 *     依据见 `app/platform/attachment/content.mjs` 顶部。
 *   · **通用文件**（PDF / 压缩包 / 改名过的二进制）：字节**不会**送给模型 ——
 *     这是**上游的设计**而非平台缺陷：「通用文件的字节永远不会到达提供方」，
 *     上游的本意是"存到只读路径 + 给模型一行句柄文本，由模型按需读取"。
 *     本平台尚未接通"给路径"那一段（B 档），所以这轮**既没送字节也没给路径**，
 *     如实标为未提交。宁可少做，也不谎报"文件已交给模型"。
 *   · 超限的附件同样不提交，但会在返回里**逐条点名** —— 不静默丢弃。
 *
 * 返回三个互不重叠的数组，前端据此分别说话（"送去了什么"与"没送什么"是两件事）：
 *   `images`   —— 已装成图片块、这轮真的要送出去的（`sent` 是它的展示版）
 *   `injected` —— 正文已拼进 content 的文本附件
 *   `skipped`  —— 未提交的，每条带 `reason` 与 `note`
 *
 * @param {object} [opts]
 * @param {boolean} [opts.canSendImages] 上游是否支持图片附件（见 runTurn 的说明）。
 *   为 false 时图片**整条不进 images**，转而进 `skipped` 并说明原因 ——
 *   绝不能在正文里写下"已作为图片块提交"却把图丢在 provider 那一层。
 * @returns {{content:string, images:Array, injected:Array, sent:Array, skipped:Array}}
 */
function composeWithAttachments(content, rows, { canSendImages = true } = {}) {
  const empty = { content, images: [], injected: [], sent: [], skipped: [] };
  if (!Array.isArray(rows) || !rows.length) return empty;

  const injected = [];
  const sent = [];
  const skipped = [];
  const images = [];
  const blocks = [];
  let budget = INJECT_MAX_BYTES;
  let imageBudget = IMAGE_TOTAL_MAX;

  for (const row of rows) {
    // 字节只读一次：嗅探与文本注入都要用，读两次纯属浪费（8MB 的文件不是小数）。
    let buf;
    try {
      buf = fs.readFileSync(path.join(STORAGE_DIR, row.stored_path));
    } catch (e) {
      skipped.push({ id: row.id, name: row.name, reason: 'unreadable', note: '读取落盘文件失败：' + (e && e.message) });
      continue;
    }

    // ① 先按**内容**判是不是白名单图片 —— 不信扩展名，也不信上传时浏览器报的 mime。
    //    认出来才走图片通路；认不出的一律退回文件通路（猜错格式会让上游整条消息失败）。
    const mediaType = sniffImageMediaType(buf);
    if (mediaType) {
      // 上游不支持图片通路时**在这一步就拦下**，而不是拼好正文、交给 provider 再丢。
      // 顺序很重要：正文里那句"已作为图片块提交给模型"是给用户看的，
      // 先写后丢就是假陈述；先问能力，写下的每一句才是真的。
      if (!canSendImages) {
        skipped.push({
          id: row.id, name: row.name, reason: 'upstream_unsupported',
          note: '当前上游内核版本未声明支持图片附件，这张图没有提交给模型。'
            + '（平台不会在正文里谎称已提交 —— 请升级上游内核后重试。）',
        });
        continue;
      }
      if (buf.length > imageBudget) {
        skipped.push({
          id: row.id, name: row.name, reason: 'image_budget',
          note: '本轮图片合计已达上限 ' + humanBytes(IMAGE_TOTAL_MAX) + '，这张未提交给模型。',
        });
        continue;
      }
      // 这里**没有**单张上限的检查 —— 不是漏了。单张的约束由上传接口的
      // ATTACH_MAX_BYTES 承担（存进来的东西就不可能超过它），再写一遍是死代码。
      // 合计预算这一条才是真正会拦人的，见上方常量的说明。
      imageBudget -= buf.length;
      // toImagePart 内部会再比一次白名单 —— 它是硬约束，不允许调用方绕过。
      images.push(toImagePart({ data: buf, mediaType, name: row.name }));
      sent.push({ id: row.id, name: row.name, mediaType, bytes: buf.length });
      continue;
    }

    // ② 不是图片 → 走文本注入（判据是上传时按内容定下的 `kind`）
    if (row.kind !== 'text') {
      skipped.push({
        id: row.id, name: row.name, reason: 'binary',
        note: '通用文件不会送给模型，本轮未提交。它仍被登记，可随时查看与下载。',
      });
      continue;
    }
    if (row.bytes > INJECT_PER_FILE_MAX) {
      skipped.push({
        id: row.id, name: row.name, reason: 'too_large',
        note: '单个文本附件超过 ' + Math.round(INJECT_PER_FILE_MAX / 1024) + 'KB，未注入。',
      });
      continue;
    }
    const body = buf.toString('utf8');
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    if (bodyBytes > budget) {
      skipped.push({
        id: row.id, name: row.name, reason: 'budget',
        note: '本轮注入总量已达上限（' + Math.round(INJECT_MAX_BYTES / 1024) + 'KB），未注入。',
      });
      continue;
    }
    budget -= bodyBytes;
    blocks.push('<attachment name="' + row.name + '" id="' + row.id + '" bytes="' + row.bytes + '">\n'
      + body + '\n</attachment>');
    injected.push({ id: row.id, name: row.name, bytes: row.bytes });
  }

  const sections = [];
  if (blocks.length) {
    sections.push('【附件正文】以下几段是平台读到的附件全文，供你参考：\n\n' + blocks.join('\n\n'));
  }
  if (images.length) {
    sections.push('【随附图片】' + describeImages(sent));
  }
  // 一段都没成 → content 原样返回，**不加标记**（没有注入就不该有标记，否则气泡会被切错）。
  if (!sections.length) return { content, images: [], injected: [], sent: [], skipped };

  const composed = String(content)
    + ATTACH_INJECT_BEGIN
    + sections.join('\n\n');
  return { content: composed, images, injected, sent, skipped };
}

/**
 * 按 UTF-8 字节上限截断字符串，**不切断多字节字符**。
 *
 * 直接 `Buffer.subarray(0, n).toString('utf8')` 会在切到汉字中间时留下 U+FFFD
 * （"烫"字变成 "�"）—— 那段文字是要交给模型读的，末尾糊一个乱码会让人以为
 * 知识库里的原文就是坏的。用 `for...of` 迭代**码点**（不是码元），
 * 代理对（emoji 等）也不会被劈成两半。
 */
function clipUtf8(s, maxBytes) {
  const str = String(s);
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let bytes = 0;
  let out = '';
  for (const ch of str) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}

/**
 * 把会话挂载的知识库检索结果拼成本轮的参考资料段（RAG 闭环，0.14.0）。
 *
 * 调用位置：`runTurn` 里 **附件注入之前** —— 于是最终 content 的顺序是
 * `用户原文 + 知识段 + 附件段`。这个顺序是有意的：
 *   · 用户原文仍在最前面 → 前端"取第一个标记之前"的气泡切分逻辑不变；
 *   · 参考资料排在附件正文之前 → 人读起来也是"先看检索到的要点，再看附件全文"。
 *
 * 返回的 `notes` / `hits` 会原样进 `kind:'knowledge'` 事件帧，让"这一轮到底检索了
 * 什么、命中了什么、哪几个库被 ACL 挡了"三件事在轨迹里可查 —— 而不是只在界面上
 * 显示一句"已参考知识库"。
 *
 * @returns {Promise<{content:string, kbIds:string[], usedKbIds:string[], hits:Array,
 *                    notes:string[], elapsedMs:number, dropped:number, mode:string|null}>}
 */
async function composeWithKnowledge({ deps, ctx, row, query }) {
  const kbIds = sessions.decodeKbIds(row && row.kb_ids);
  // 不挂库 → 不检索、不注入、不加标记。**行为与 0.13.1 逐字一致**（这条有回归钉住）。
  if (!kbIds.length) {
    return { content: query, kbIds: [], usedKbIds: [], hits: [], notes: [], elapsedMs: 0, dropped: 0, mode: null };
  }

  const knowledge = deps.knowledge;
  if (!knowledge || typeof knowledge.search !== 'function') {
    return {
      content: query, kbIds, usedKbIds: [], hits: [], elapsedMs: 0, dropped: 0, mode: null,
      notes: ['知识服务未装配，本轮未检索（装配缺陷）'],
    };
  }

  // 纯附件的一轮（content 为空串是合法的）没有可检索的文本。此时**不是失败** ——
  // 不去检索、也不报错，只说清原因。把它混成"检索失败"会让人去查一个不存在的故障。
  const q = String(query == null ? '' : query).trim();
  if (!q) {
    return {
      content: query, kbIds, usedKbIds: [], hits: [], elapsedMs: 0, dropped: 0, mode: null,
      notes: ['本轮没有文本输入（只有附件），未做知识检索'],
    };
  }

  const t0 = Date.now();
  let r = null;
  let searchError = null;
  let searchErrorCode = '';
  let searchErrorStatus = 0;
  try {
    r = await knowledge.search({
      tenantId: tenantOf(ctx),
      userId: ctx.userId,
      roles: (ctx.user && ctx.user.roles) || [],
      kbIds,
      query: q,
      limit: KB_INJECT_TOP_K,
    });
  } catch (e) {
    searchError = e && e.message ? e.message : String(e);
    searchErrorCode = (e && e.code) || '';
    searchErrorStatus = (e && e.httpStatus) || 0;
  }
  const elapsedMs = Date.now() - t0;

  // ⚠️ 检索失败**不打断对话**：知识是增益不是契约。但必须如实带出去 ——
  //    "检索失败"与"检索成功但没命中"是两件事，混成一句就是造假。
  //
  //    而 **403 还要再分一层**：它不是故障，是**权限判定**（挂的库全被 ACL 挡了）。
  //    把"你没权限"说成"检索失败"，会让人去查一个根本不存在的故障 ——
  //    实测就是在这一步发现的：库从"全组织可见"改为"受限"之后，
  //    会话行里仍挂着它（历史事实），检索侧如实丢弃，但提示语写成了"检索失败"。
  if (searchError) {
    const denied = searchErrorCode === 'forbidden' || searchErrorStatus === 403;
    return {
      content: query, kbIds, usedKbIds: [], hits: [], elapsedMs, dropped: 0, mode: null,
      notes: [denied
        ? '挂载的知识库当前都不可访问（可能已被改为「受限」而你没有授权），本轮未注入任何知识。'
          + '这不是故障 —— 要么让管理员给你授权，要么改挂你有权访问的库。'
        : '知识检索失败，本轮未注入：' + searchError],
    };
  }

  const notes = Array.isArray(r.notes) ? r.notes.slice() : [];
  const usedKbIds = (r.scope && Array.isArray(r.scope.kbIds)) ? r.scope.kbIds.map(String) : [];
  const mode = r.retrieval ? r.retrieval.mode : null;
  const results = Array.isArray(r.results) ? r.results : [];

  if (!results.length) {
    return {
      content: query, kbIds, usedKbIds, hits: [], elapsedMs, dropped: 0, mode,
      notes: [...notes, '未命中任何知识片段'],
    };
  }

  const picked = [];
  const blocks = [];
  let budget = KB_INJECT_MAX_BYTES;
  let dropped = 0;

  for (const it of results) {
    const raw = String(it.text || '').trim();
    if (!raw) continue;
    const cut = Buffer.byteLength(raw, 'utf8') > KB_CHUNK_MAX_BYTES;
    const body = cut ? clipUtf8(raw, KB_CHUNK_MAX_BYTES) : raw;
    const use = Buffer.byteLength(body, 'utf8');
    // 预算用完的**逐条计数**，不静默丢弃 —— 前端会说"另有 N 条因预算未注入"。
    if (use > budget) { dropped++; continue; }
    budget -= use;

    const cit = (it.citation && typeof it.citation === 'object') ? it.citation : {};
    const hit = {
      n: picked.length + 1,
      label: cit.label || '(无定位信息)',
      docTitle: cit.documentTitle || '(无标题)',
      docId: cit.docId || '',
      kbId: cit.kbId || '',
      chunkId: it.chunkId || '',
      score: it.score != null ? it.score : null,
      locationKnown: !!cit.locationKnown,
      truncated: cut,
      bytes: use,
    };
    picked.push(hit);
    blocks.push('[' + hit.n + '] ' + hit.label + '\n' + body);
  }

  if (!picked.length) {
    return {
      content: query, kbIds, usedKbIds, hits: [], elapsedMs, dropped, mode,
      notes: [...notes, '命中的片段全部为空或超出注入预算'],
    };
  }

  const head = '【企业知识库参考资料】\n'
    + '以下几段是平台按用户的问题从企业知识库中检索到的原文片段。回答时请优先依据这些资料；\n'
    + '资料不足以回答时，请如实说明"知识库中没有找到相关内容"，不要凭常识编造。\n'
    + '引用某条资料时，请带上它的编号（如 [1]）。';
  const composed = String(query) + KB_INJECT_BEGIN + head + '\n\n' + blocks.join('\n\n');

  return { content: composed, kbIds, usedKbIds, hits: picked, elapsedMs, dropped, mode, notes };
}


/**
 * 并发闸包装（P1-2）—— 回合提交的**唯一入口检查点**。
 *
 * 为什么放在这里而不是 quota 中间件里：中间件只能"读一个数再判"，
 * 而并发闸要求**判定与自增原子**（两步之间开个窗口，两个请求会双双冲破上限）。
 * 中间件之后再进 handler，中间还隔着一次 await —— 窗口更大。
 * 把"判定+进入"收在一个同步调用里（`enterConcurrent`），窗口才真正消失。
 *
 * 配对纪律：`enterConcurrent` 返回 ok 之后，**必定**走 `finally` 里的
 * `leaveConcurrent`。收流、抛错、客户端断开三条路径都要走到 ——
 * 少走一次就是一次计数泄漏，表现为"没人用却报并发超限"。
 */
async function withTurnGate({ deps, ctx, fn }) {
  const gov = deps.governance;
  const tenantId = tenantOf(ctx);
  const userId = ctx.userId || null;
  if (!gov || !gov.quotas || typeof gov.quotas.enterConcurrent !== 'function') {
    // 装配缺陷：如实放行并在链状态里留痕。宁可少一道闸，也不能因为缺装配把所有人挡在门外。
    return fn();
  }
  const gate = gov.quotas.enterConcurrent({ tenantId, userId });
  if (!gate.ok) {
    try {
      audit.append({
        tenantId, userId,
        action: 'governance.quota.block', resourceType: 'quota', resourceId: 'concurrent',
        result: 'denied',
        detail: {
          metric: 'concurrent', active: gate.active, limit: gate.limit,
          subjectType: gate.subjectType, routeId: ctx.route ? ctx.route.id : '',
        },
      });
    } catch { /* 留痕失败不影响拦截本身 */ }
    metrics.inc('sti_quota_blocked_total', { metric: 'concurrent' });
    // 并发被撞满是"组织正在把平台压满"的最早信号，值得出站一次（同租户 10 分钟合并一次）。
    void emitQuotaBlocked(deps, {
      tenantId, metric: 'concurrent', subjectType: gate.subjectType,
      reason: '在途回合数 ' + gate.active + '/' + gate.limit + '（' + (gate.subjectType === 'user' ? '用户级' : '组织级') + '）',
      routeId: ctx.route ? ctx.route.id : '',
    });
    throw errors.quota('并发回合数已达上限（' + gate.active + '/' + gate.limit + '，'
      + (gate.subjectType === 'user' ? '用户级' : '组织级') + '）：请等当前回合结束后重试');
  }
  try {
    return await fn();
  } finally {
    gov.quotas.leaveConcurrent({ tenantId, userId });
  }
}

/**
 * 执行一轮对话的**唯一实现**：提交 → 流式读取事件 → 落库 → 用量 → 产物。
 *
 * 两个入口共用它：
 *   · `POST …/turns`        —— 收完整轮再一次性返回 JSON（老接口，回归在用）；
 *   · `POST …/turns/stream` —— 边收边以 NDJSON 帧推送（工作台在用）。
 * 共用同一实现，是为了让"配额口径、用量采集、产物提取"只有一份真相 ——
 * 否则流式与非流式会慢慢长歪，出现"网页看到的用量和接口返回的不一致"。
 *
 * `emit(frame)` 是可选的增量出口：非流式传入空函数（什么都不推）。
 *
 * ⚠️ `fromSeq` 传本地库已存的事件数（`before`），**但 provider 可以不认这个数**。
 * 原因：平台库的 seq 与上游事件流的 seq 是**两套编号**。上游内核自己在 submitTurn 时
 * 记下日志头（见 dsh-provider/index.mjs 的 turnBase），拿到正确的区间；测试替身
 * 则把它当作自己事件数组的下标。把"从哪开始"交给 provider 判断，
 * 契约层就不必知道两套编号的差异。
 *
 * @param {object} p
 * @param {(ac:AbortController)=>void} [p.linkAbort] 让调用方把"客户端断开"接到中止上
 */
async function runTurn({ deps, ctx, row, body, emit = () => {}, linkAbort = null }) {
  const { kernel, config, governance } = deps;
  const before = events.currentSeq(row.id);

  /**
   * 本轮的内核快照（0.21.3）——**在回合开头抓一次，之后全用它**。
   *
   * 为什么不能每步重读 `kernel.provider`：内核现在支持热切换（保存接入配置即刻生效），
   * 而一轮对话要跨 `submitTurn` 与 `streamTurns` 两个 await 点。若这里每步重读，
   * 恰好在中途换了内核就会"用旧内核提交、用新内核收流"—— 收到的是另一个会话空间
   * 的事件，表现为整轮空响应、或者串到别处的轨迹上，而且只在切换过的进程里偶发。
   *
   * 抓一次 = **在途回合用旧内核跑完，新回合用新内核**。这才是可判定的语义，
   * 也是"切内核不会打断正在进行的对话"这句话的真正实现（被换下的 provider 是
   * 纯内存对象，无需关闭，见 compose/kernel.mjs 的说明）。
   */
  const turnKernel = { ready: kernel.ready, provider: kernel.provider };

  emit({ kind: 'meta', sessionId: row.id, kernelSessionId: row.kernel_session_id, kernelReady: turnKernel.ready });

  // 附件（3.6 / 0.10.0）：先把选中的附件解析成"能送出去多少、跳过了哪些"。
  // 落库的 turn-start 事件里带的是**含附件正文与图片清单的完整 content**
  // （因为那才是真正交给内核的东西）—— 轨迹必须等于事实，而不是等于用户的输入框。
  //
  // 图片走**另一条通路**：它们不进 content 字符串，而是作为 `attachments` 参数
  // 传给 provider，由 provider 拼成上游的内容块数组。两条通路互不重叠：
  // 文本注入是"平台把字读出来拼进去"，图片是"平台把字节原样交上去"。
  const wanted = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
  const attRows = wanted.length
    ? attachments.getAttachmentsByIds(tenantOf(ctx), row.id, wanted)
    : [];
  const missing = wanted.filter((id) => !attRows.some((r) => r.id === id));
  // 图片通路的前提是**上游真的收得下**。这个判断必须在拼正文之前做完，
  // 理由见 composeWithAttachments 里 canSendImages 的说明。
  // `=== true` 是刻意的：provider 尚未解析出垫片能力时是 undefined，
  // 保守按"不支持"处理 —— 少送一轮图，好过在轨迹里写一句做不到的话。
  const canSendImages = turnKernel.provider.imageAttachments === true;

  // 知识库检索（0.14.0）：**在附件注入之前**做，于是最终 content 的顺序是
  // `用户原文 + 知识段 + 附件段`（顺序的理由见 composeWithKnowledge 的注释）。
  //
  // 检索的查询是**用户原始输入**（`body.content`），不是拼好的 content ——
  // 附件正文可能有 60KB，拿它当查询会把真正的问题淹掉，检索质量会莫名其妙地差，
  // 而且失败原因极难定位（"为什么挂了库却一条都没命中"）。
  const kb = await composeWithKnowledge({ deps, ctx, row, query: String(body.content) });
  if (kb.kbIds.length) {
    // 挂库时就一定要发这一帧 —— 哪怕命中了 0 条、哪怕检索失败。
    // 前端据此显示"已检索 N 个库 / 命中 0 条 / 失败原因"，
    // 而不是让用户对着一个静默的对话框猜"我的知识库到底生效了没有"。
    emit({
      kind: 'knowledge',
      kbIds: kb.kbIds,
      usedKbIds: kb.usedKbIds,
      hits: kb.hits,
      dropped: kb.dropped,
      elapsedMs: kb.elapsedMs,
      mode: kb.mode,
      notes: kb.notes,
    });
  }

  const composed = composeWithAttachments(kb.content, attRows, { canSendImages });
  if (attRows.length) {
    emit({
      kind: 'attachments',
      attached: composed.injected, sent: composed.sent,
      skipped: composed.skipped, missing,
    });
  }

  const submitted = await turnKernel.provider.submitTurn({
    sessionId: row.kernel_session_id,
    cwd: row.cwd,
    requestId: body.requestId || null,
    content: composed.content,
    // 图片内容块（可能为空数组）。provider 负责把它拼进上游要求的 content 数组；
    // 契约层只说"这一轮带了这些图"，不描述上游的块形状。
    attachments: composed.images,
    mode: body.mode || 'queue',
  });
  emit({ kind: 'turn', turnId: submitted.turnId, accepted: submitted.accepted !== false });


  const ac = new AbortController();
  if (typeof linkAbort === 'function') { try { linkAbort(ac); } catch { /* 接线失败不影响本轮 */ } }
  let timedOut = false;
  const timeoutMs = Number(config.values.turnTimeoutMs || 20000);
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  // 超时/中止不该把进程拖住：定时器不许让事件循环常驻
  timer.unref && timer.unref();

  const items = [];
  let truncated = false;
  let error = '';
  try {
    for await (const ev of turnKernel.provider.streamTurns({
      sessionId: row.kernel_session_id, cwd: row.cwd, fromSeq: before, signal: ac.signal,
    })) {
      items.push(ev);
      // emit 的那份**过抹名**（0.15.1）：上游会把系统提示词原文（带上游产品名）
      // 以 message 事件回放，实时帧直接进浏览器 —— 运行期抹名在这里做，
      // 落库的 items 仍是原文（显示层化简、数据层不许）。
      emit({ kind: 'event', event: sanitizeKernelEvent(ev) });
      if (ev.type === 'turn-end') break;
    }
  } catch (e) {
    truncated = true;
    error = e && e.message ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) { truncated = true; error = error || '收集超时'; }
  else if (ac.signal.aborted && !truncated) { truncated = true; error = error || '客户端断开，事件可能不完整'; }

  // 事件写入走批量单事务（events 仓储不提供逐条写入接口）。
  // 客户端中途断开也照样落已收到的部分 —— 轨迹宁缺毋滥，但不该整轮丢失。
  const written = events.appendEvents(row.id, items);
  sessions.touchSession(tenantOf(ctx), row.id);

  // 用量采集（M3）：从本轮事件里的 usage 事件照抄真实 token 数。
  // 采集失败不打挂回合 —— 但要如实带回失败信息，不能静默丢账。
  //
  // 归因（P1-3）：带上会话上登记的模型名（`agent_sessions.model_id`）。
  // 它的语义是「平台**要求上游**用的模型」，来自 `POST …/model` 或建会话时的显式选择；
  // 上游 usage 事件里不带模型名，所以这是**声明**而非观测 —— 没选过就是空串，
  // 成本报告会把这部分用量单独放进 unattributed，不拿默认模型的价去套。
  let usageCollected = { written: 0, skipped: 0, totals: null, error: null };
  if (governance && governance.usage) {
    try {
      const r = governance.usage.recordFromEvents({
        tenantId: tenantOf(ctx),
        userId: ctx.userId || null,
        sessionId: row.id,
        turnId: submitted.turnId,
        modelId: row.model_id || '',
        events: items,
      });
      usageCollected = { written: r.written, skipped: r.skipped, totals: r.totals, error: null };
    } catch (e) {
      usageCollected.error = e && e.message;
    }
    } else {
      usageCollected.error = '治理服务未装配（装配缺陷）';
    }

  // 指标（P1-2）：token 数照抄本轮真实事件（与 usage_records 同一口径：
  // 计费输入 = input + cacheRead + cacheWrite）。取不到就一个都不加 ——
  // 指标里也**不做估算**，否则 Grafana 上的曲线与账本对不上。
  if (usageCollected.totals) {
    const t = usageCollected.totals;
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    metrics.inc('sti_tokens_total', { direction: 'input' }, n(t.input) + n(t.cacheRead) + n(t.cacheWrite));
    metrics.inc('sti_tokens_total', { direction: 'output' }, n(t.output));
  }

  // 产物留存（M4）：回合内 tool 事件的文件路径提取（tool-call 的 args → input，tool-result 的 result → output）。
  // 与用量采集同一纪律：失败如实带回，不打挂回合。
  let artifactsRecorded = { written: 0, error: null };
  if (governance && governance.artifacts) {
    try {
      let n = 0;
      for (const ev of items) {
        if (ev.type === 'tool-call' && ev.tool && ev.tool.args != null) {
          n += governance.artifacts.recordFromToolCall({ tenantId: tenantOf(ctx), sessionId: row.id, turnId: ev.turnId || submitted.turnId, toolName: ev.tool.name, args: ev.tool.args, result: null }).written;
        }
        if (ev.type === 'tool-result' && ev.tool) {
          n += governance.artifacts.recordFromToolCall({ tenantId: tenantOf(ctx), sessionId: row.id, turnId: ev.turnId || submitted.turnId, toolName: ev.tool.name, args: null, result: ev.tool.result }).written;
        }
      }
      artifactsRecorded = { written: n, error: null };
    } catch (e) {
      artifactsRecorded = { written: 0, error: e && e.message };
    }
  }

  return {
    turnId: submitted.turnId,
    eventsWritten: written.inserted,
    lastSeq: written.lastSeq,
    truncated,
    error,
    usageCollected,
    artifactsRecorded,
    attachments: {
      requested: wanted.length,
      sent: composed.sent,              // 已作为图片块真的送出去的
      injected: composed.injected,      // 正文已拼进 content 的
      skipped: composed.skipped,
      missing,
    },
    events: items,
  };
}

/* ── 会话导出（0.17.0）：落库事件 → 人能读的**转录** ─────────────────────
 *
 * 与既有「会话日志 ZIP」（`/api/governance/sessions/:id/log.zip`，0.5.0）分工：
 *   · ZIP 是**原始转储** —— 全量事件 + 产物清单，给排障与留证；
 *   · 这里是**转录** —— 按轮重建"谁说了什么"（含工具调用与错误），给阅读与交付归档。
 * 两者不重复：转储有全部细节但没有人的视角，转录有人的视角但不给细节。
 *
 * 注入段剥离与前端工作台回放（84-workbench.js 的 wbSplitUserText）**同一口径**：
 * 落库的 turn-start 文本是真正发给内核的东西（用户原文 + 知识段 + 附件段），
 * 导出成人读转录时剥回"用户打过什么字"，剥掉的部分**写在注记行里** ——
 * 不静默丢（静默丢等于伪造了一份没注入过的对话）。
 *
 * 标记按**形态**识别（`<<<大写标识-XXX>>>`）而不是照抄常量：更名前落库的老会话里
 * 是旧前缀的标记（同款理由见 84-workbench.js 的 WB_ATTACH_MARKER_RE）；照抄常量剥不干净。
 */
const TRANSCRIPT_KB_MARKER_RE = /<<<[A-Z0-9]+-KNOWLEDGE>>>/;
const TRANSCRIPT_ATTACH_MARKER_RE = /<<<[A-Z0-9]+-ATTACHMENTS>>>/;
/** 取**第一个**注入标记：注入段顺序拼接（知识段在前、附件段在后），一次切干净。 */
const TRANSCRIPT_INJECT_MARKER_RE = /<<<[A-Z0-9]+-(?:KNOWLEDGE|ATTACHMENTS)>>>/;
const TRANSCRIPT_IMAGES_LINE_RE = /本轮随附 (\d+) 张图片/;
/** 上游回放的运行时上下文/技能提醒（不是用户打的字）——与前端 WB_INJECTED_MSG_RE 同口径。 */
const TRANSCRIPT_INJECTED_MSG_RE = /^Current runtime context\.|^<system-reminder>/;
/** 单次导出的事件上限。超了就截断并在结果里**如实标注**（不静默截成"完整导出"）。 */
const TRANSCRIPT_MAX_EVENTS = 20000;

/** 剥掉平台注入段（只切不 trim —— 与前端 wbStripInjected 一致，比较口径才相同）。 */
function transcriptStripInjected(text) {
  const t = String(text == null ? '' : text);
  const m = TRANSCRIPT_INJECT_MARKER_RE.exec(t);
  return m ? t.slice(0, m.index) : t;
}

/** 知识片段条数：数**知识段内部**的 `[n] ` 行号 —— 附件段（Markdown 附件正文）里的 `[1] ` 不能算进来。 */
function transcriptCountKbHits(text) {
  const s = String(text == null ? '' : text);
  const k = TRANSCRIPT_KB_MARKER_RE.exec(s);
  if (!k) return 0;
  const rest = s.slice(k.index + k[0].length);
  const a = TRANSCRIPT_ATTACH_MARKER_RE.exec(rest);
  const seg = a ? rest.slice(0, a.index) : rest;
  return (seg.match(/^\[\d+\] /gm) || []).length;
}

/** 从一条用户原文拆出「气泡正文 + 本轮注入计数」（前端 wbSplitUserText 的服务端同款）。 */
function transcriptUserParts(rawText) {
  const t = String(rawText == null ? '' : rawText);
  const stripped = transcriptStripInjected(t);
  const img = TRANSCRIPT_IMAGES_LINE_RE.exec(t);
  return {
    text: stripped.trim(),
    // 无标记就不计附件：计数是"平台注入过"的投影，不能把用户手打的 `<attachment ` 也算进去。
    attachCount: t === stripped ? 0 : (t.match(/<attachment /g) || []).length,
    attachImages: img ? Number(img[1]) : 0,
    kbCount: transcriptCountKbHits(t),
  };
}

/**
 * 落库事件 → 转录消息段（规则与前端工作台回放**同一套**，但不含任何显示态字段）。
 *
 * 有意的不对称（两边注释里都写了）：
 *   · turn-start 起一轮：用户段（剥注入、记注入数）+ 空的助手段；
 *   · `message` 按角色分拣：system 丢（是轨迹不是对话）、上游回放的运行时上下文丢、
 *     其余 user 并入本轮**最近一个**用户段（跨过助手段就是上一轮，不再并 —— 否则
 *     多轮提问会糊成一个气泡，此坑在 0.15.1 真机抓到过）；
 *   · 助手正文 = delta 累积 + 未被包含的完整文本块（finals）；
 *   · tool-call / tool-result 按 name 配对（result 尚为 null 的最近一个是它的调用）；
 *   · `error` 归到本轮助手段；`turn-end` 封口（其后事件没有新 turn-start 就另起裸助手段）。
 */
function buildTranscript(items) {
  const msgs = [];
  let cur = null;
  const newBlock = () => ({ role: 'assistant', text: '', reasoning: '', finals: [], tools: [], error: '', usage: null });

  for (const ev of (items || [])) {
    if (!ev) continue;
    const type = String(ev.type || '');

    if (type === 'turn-start') {
      const u = transcriptUserParts(ev.text);
      const injected = { attachCount: u.attachCount, attachImages: u.attachImages, kbCount: u.kbCount };
      // 空文本 + 零注入（上游形态的空 turn-start）不落用户段；纯附件轮（有注入、无文字）要落 ——
      // 否则转录里会凭空出现一轮"助手自说自话"。
      if (u.text || injected.attachCount || injected.attachImages || injected.kbCount) {
        msgs.push({ role: 'user', text: u.text, injected });
      }
      cur = newBlock();
      msgs.push(cur);
      continue;
    }

    if (!cur) { cur = newBlock(); msgs.push(cur); }
    const msg = cur;

    if (type === 'message') {
      const role = ev.role || 'assistant';
      if (role === 'system') {
        // 系统提示词等系统级注入：是轨迹不是对话（要原文去事件接口/日志 ZIP）。
      } else if (role === 'user') {
        const t = String(ev.text || '').trim();
        if (t && !TRANSCRIPT_INJECTED_MSG_RE.test(t)) {
          // 并入本轮最近的用户段（从当前助手段往前扫，跨过助手段即上一轮）。
          let merged = false;
          for (let i = msgs.indexOf(msg) - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') break;
            if (msgs[i].role === 'user') {
              if (!msgs[i].text.includes(t)) msgs[i].text = msgs[i].text ? msgs[i].text + '\n' + t : t;
              merged = true;
              break;
            }
          }
          if (!merged) msgs.splice(msgs.indexOf(msg), 0, madeUserMsgFromReplay(t));
        }
      } else {
        if (ev.reasoning) msg.reasoning += (msg.reasoning ? '\n' : '') + String(ev.reasoning);
        if (ev.delta) msg.text += String(ev.delta);
        else if (ev.text && String(ev.text).trim() && !msg.text.includes(String(ev.text))) msg.finals.push(String(ev.text));
      }
    } else if (type === 'reasoning') {
      if (ev.delta) msg.reasoning += String(ev.delta);
    } else if (type === 'tool-call') {
      msg.tools.push({
        name: (ev.tool && ev.tool.name) || '', args: ev.tool ? ev.tool.args : null,
        result: null, status: (ev.tool && ev.tool.status) || 'running',
      });
    } else if (type === 'tool-result' && ev.tool) {
      let t = null;
      for (let i = msg.tools.length - 1; i >= 0; i--) {
        if (msg.tools[i].name === ev.tool.name && msg.tools[i].result == null) { t = msg.tools[i]; break; }
      }
      if (!t) { t = { name: ev.tool.name || '', args: null, result: null, status: 'running' }; msg.tools.push(t); }
      t.result = ev.tool.result == null ? '' : ev.tool.result;
      t.status = ev.tool.status || 'ok';
    } else if (type === 'usage' && ev.usage) {
      msg.usage = ev.usage;
    } else if (type === 'error') {
      msg.error = ev.text || '本轮出错';
    } else if (type === 'turn-end') {
      cur = null;
    }
  }

  // 收口：空助手段（既无正文也无工具无错误）剔除；finals 并进正文。
  return msgs.filter((m) => {
    if (m.role === 'user') return true;
    return !!(String(m.text || '').trim() || (m.finals && m.finals.length) || m.tools.length || m.error);
  }).map((m) => {
    if (m.role !== 'assistant') return m;
    const out = {
      role: 'assistant',
      text: [m.text, ...(m.finals || [])].map((s) => String(s == null ? '' : s)).filter((s) => s.trim()).join('\n'),
    };
    if (m.reasoning) out.reasoning = m.reasoning;
    if (m.tools.length) out.tools = m.tools;
    if (m.error) out.error = m.error;
    if (m.usage) out.usage = m.usage;
    return out;
  });
}

/** 上游以 message(user) 回放时、前方没有本回合用户段时的兜底用户段。 */
function madeUserMsgFromReplay(text) {
  return { role: 'user', text, injected: { attachCount: 0, attachImages: 0, kbCount: 0 } };
}

/** 转录消息段 → Markdown（给人读的版本：不含推理与工具入参原文，那些在 JSON 与事件接口里）。 */
function transcriptToMarkdown(meta, msgs) {
  const lines = [];
  lines.push('# ' + (meta.title || '(未命名会话)'));
  lines.push('');
  lines.push('> 本文件是平台导出的会话**转录**：按轮重建「谁说了什么」，平台注入的检索/附件段'
    + '已从用户发言中剥出并注明；模型推理片段与工具入参/结果原文不在转录内 ——'
    + '完整事件流见 `GET /api/kernel/sessions/' + meta.sessionId + '/events`。');
  lines.push('');
  lines.push('- 会话 id：`' + meta.sessionId + '`');
  if (meta.provider || meta.model) lines.push('- 模型：' + [meta.provider, meta.model].filter(Boolean).join(' / '));
  lines.push('- 导出时间：' + meta.exportedAt);
  lines.push('- 事件数：' + meta.eventCount
    + (meta.truncated ? '（⚠️ 已达导出上限 ' + TRANSCRIPT_MAX_EVENTS + ' 条，本转录不完整）' : ''));

  for (const m of msgs) {
    lines.push('');
    lines.push('---');
    lines.push('');
    if (m.role === 'user') {
      lines.push('## 用户');
      lines.push('');
      lines.push(m.text ? m.text : '*（本轮只有附件，没有文字输入）*');
      const inj = m.injected || {};
      const bits = [];
      if (inj.attachCount) bits.push('附件正文 ' + inj.attachCount + ' 个');
      if (inj.attachImages) bits.push('图片 ' + inj.attachImages + ' 张');
      if (inj.kbCount) bits.push('知识片段 ' + inj.kbCount + ' 条');
      if (bits.length) { lines.push(''); lines.push('> 本轮注入已从发言中剥出：' + bits.join(' · ')); }
    } else {
      lines.push('## 助手');
      lines.push('');
      lines.push(m.text ? m.text : '*（本轮没有文字答复）*');
      if (m.tools && m.tools.length) {
        lines.push('');
        for (const t of m.tools) lines.push('> 工具调用：' + (t.name || '(未命名)') + '（' + (t.status || '未知') + '）');
      }
      if (m.error) { lines.push(''); lines.push('> 错误：' + m.error); }
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*转录由平台生成；上游注入的运行时上下文与系统级消息不属于对话，未计入。*');
  return lines.join('\n') + '\n';
}

export function kernelRoutes(deps) {
  const { kernel, governance, workspace } = deps;

  /** 主体描述（0.21.0 工作区守卫用）：userId + 租户级角色。工作区档位由服务层展开。 */
  const wsSubjectOf = (ctx) => ({ userId: ctx.userId, roles: (ctx.user && ctx.user.roles) || [] });

  /**
   * 工作区守卫：会话挂在工作区上之后，读/写/管按档位判。
   *
   * 0.21.6：档位不再来自工作区级授权，而是由**组织角色**推导（服务层内部判）。
   * 这里的调用点一个字没改 —— 守卫的**形状**没变，变的只是它背后那条判据。
   *
   * ⚠️ 0.21.9 删掉了 `|| !row.workspace_id` 这个短路。它从前是"未分组会话一律放行"的
   *    入口 —— 那句在 0021 引入工作区时是向后兼容（老数据本来没有归属），但同时是一条
   *    暗门：进了工作区的会话按档位判，没进工作区的反而人人可管。现在
   *    `assertSessionAccess` 自己会把空归属按**默认工作区**判（见服务层同名注释），
   *    所以这里不该再有一层"先放行再说"。workspace 服务未装配（理论上不会）仍放行：
   *    守卫是增益，不能反过来把会话功能整体卡死。
   */
  function guardWs(ctx, row, need = 'view') {
    if (!workspace || !row) return;
    workspace.assertSessionAccess(tenantOf(ctx), row, wsSubjectOf(ctx), need);
  }

  /**
   * "这不是我的会话"的写动作（改名/删除/移动他人会话）要 full 档；自己的 write 档就够。
   *
   * 判据来自 `workspace.sessionManageRight` —— **与列表页回显 `canManage` 是同一个函数**。
   * 两边各写一遍这条规则的话，迟早出现"按钮亮着、点了 403"（用户读作"系统坏了"）。
   */
  function guardWsOwnership(ctx, row) {
    if (!workspace || !row) return;   // 同上：空归属不再等于"跳过守卫"
    const right = workspace.sessionManageRight(tenantOf(ctx), row, wsSubjectOf(ctx));
    if (right.can) return;
    workspace.assertSessionAccess(tenantOf(ctx), row, wsSubjectOf(ctx), right.need);
  }

  /**
   * 解析平台会话 → 上游会话**行**；找不到就 404。
   *
   * 0.21.6 起多一步：**会话还没有上游会话就当场补建一个**。
   *
   * 什么时候会走到那一步：任何"本地会话行早于上游会话"的情形。
   * ⚠️ 0.21.9：此前举的例子是初始化时播下的那条**落脚会话**
   *    （`seedPlaceholderSession`）—— 它已按用户裁定删除，所以正常路径上这个分支
   *    不再被走到。**但补建逻辑留着**：删掉它就意味着"能打开却发不出消息"这种
   *    状态可能重新出现，而它当初正是为了修那个才加的。
   *
   * 为什么补建放在这里而不是放在保存内核配置时：**会话的本地行是平台侧的身份，
   * 上游会话是按需建立的**。用户第一次真的要在这条会话里说话时才需要上游，
   * 而那时内核必然已就绪（未就绪时整站被拦住，根本走不到这个函数）。
   * 从前这里直接 409「该会话没有关联的内核会话」—— 用户看到的是一条能打开、
   * 却发不出任何消息的会话，读起来就是"功能坏了"。
   */
  async function requireSession(ctx) {
    const row = sessions.getSession(tenantOf(ctx), ctx.params.id);
    if (!row) throw errors.notFound('会话不存在：' + ctx.params.id);
    guardWs(ctx, row, 'view');
    if (row.kernel_session_id) return row;
    const created = await kernel.provider.createSession({
      cwd: row.cwd || process.cwd(),
      presetId: row.preset_id || null,
      title: row.title || '',
    });
    return sessions.touchSession(tenantOf(ctx), row.id, { kernel_session_id: created.sessionId });
  }

  return [
    {
      id: 'kernel.status',
      method: 'GET',
      path: '/api/kernel/status',
      scope: 'session',
      capability: ['system:read'],
      summary: '内核状态（真实探测，失败如实上报）',
      milestone: 'M0',
      handler: async (ctx) => {
        const desc = await kernel.describe();
        /**
         * 「保存了但还没生效」在**这里**报，而不是在 public 的 `/api/system/status` 里：
         * 它带着配置文件的地址信息，只有登录用户（`system:read`）该看到。
         * 比较的两个值是客观的：**运行中内核实际连的地址**（`kernel.dshStatus.origin`，
         * 来自真实探测）与**配置文件里写的地址** —— 重启后它们自然相等，提示自己消失。
         */
        const fileCfg = readRawConfigFile();
        const restart = describeKernelRestart({
          runningOrigin: (kernel.dshStatus && kernel.dshStatus.origin) || '',
          fileOrigin: fileCfg.dshOrigin !== undefined ? String(fileCfg.dshOrigin) : undefined,
          originSource: deps.config && deps.config.sources ? deps.config.sources.dshOrigin : undefined,
          envName: ENV_NAMES.origin,
        });
        ctx.ok({
          ready: kernel.ready,
          reason: kernel.reason,
          describe: desc,
          upstreamStatus: kernel.dshStatus || null,
          versionGate: versionGate(desc.kernelVersion),
          restart,
        });
      },
    },

    {
      id: 'kernel.models',
      method: 'GET',
      path: '/api/kernel/models',
      scope: 'session',
      capability: ['capability:read'],
      summary: '模型目录',
      milestone: 'M0',
      handler: async (ctx) => {
        try {
          ctx.ok({ catalog: await kernel.provider.modelCatalog() });
        } catch (e) {
          // 上游不可用不是 500：如实返回"取不到"，让前端显示空态
          ctx.ok({ catalog: null, unavailable: true, reason: e.message });
        }
      },
    },

    {
      id: 'kernel.presets',
      method: 'GET',
      path: '/api/kernel/presets',
      scope: 'session',
      capability: ['capability:read'],
      summary: '模式（Agent 预设）清单 —— 内核如实上报；平台不发明内核没有的模式',
      milestone: '0.21.0',
      handler: async (ctx) => {
        try {
          ctx.ok(await kernel.provider.listAgentPresets());
        } catch (e) {
          // 与模型目录同一条纪律：上游不可用不是 500，如实返回"取不到"，前端显示空态
          ctx.ok({ presets: [], unavailable: true, reason: e.message });
        }
      },
    },

    {
      id: 'kernel.sessions.list',
      method: 'GET',
      path: '/api/kernel/sessions',
      scope: 'session',
      capability: ['session:read'],
      summary: '本地会话列表（带事件数）',
      milestone: 'M0',
      handler: (ctx) => {
        const limit = Number(ctx.query.limit || 50);
        const rows = sessions.listSessions(tenantOf(ctx), { limit });
        const subj = wsSubjectOf(ctx);
        // 0.21.6：这里从前还有一道"工作区可见性过滤"（挂在受限工作区且我看不见的会话
        // 不出现在列表里）。可见性随工作区权限模块一起删了，所以那一段也没了 ——
        // 现在所有工作区对所有成员可见，列表就是全部。
        //
        // 「这条会话我能不能改名/删除/移动」仍由**服务端**算出来随行下发（0.21.1）。
        //
        // 为什么不让前端自己拼：前端能拿到的只有"全局有没有 session:write"，而真实规则
        // 还叠着一层"这是不是我的会话"（自己的 write 档就够、别人的要 full）。
        // 让前端拼就等于把守卫的规则抄第二份，两边迟早漂移 —— 那时用户看到的是
        // "按钮亮着，点了 403"。这里复用守卫同一个函数，并把全局能力那一半也在这里判掉。
        const canWriteGlobal = can(subj.roles, 'session', 'write');
        const rights = workspace
          ? workspace.manageRightsFor(tenantOf(ctx), rows, subj)
          : null;
        ctx.ok({
          items: rows.map((r) => {
            const right = rights ? rights.get(r.id) : { need: null, can: true, reason: 'no-workspace-service' };
            return {
              id: r.id,
              title: r.title,
              cwd: r.cwd,
              kernelSessionId: r.kernel_session_id,
              // 模型归因（P1-3）：会话上登记的模型名。空串 = 没选过（成本报告会放进 unattributed）。
              modelProvider: r.model_provider || '',
              modelId: r.model_id || '',
              // 挂载的知识库（0.14.0）：列表页要能一眼看出哪些会话挂了库。
              kbIds: sessions.decodeKbIds(r.kb_ids),
              // 工作区 / 模式 / 推理等级（0.21.0）：树要按工作区分组、头部要显示当前模式与档位。
              workspaceId: r.workspace_id || null,
              presetId: r.preset_id || null,
              reasoningEffort: r.reasoning_effort || null,
              // 会话所有权与管理权（0.21.1）：树上的"改名/删除/移动"照这个亮灯。
              ownerUserId: r.owner_user_id || null,
              isMine: !!(ctx.userId && r.owner_user_id === ctx.userId),
              canManage: canWriteGlobal && right.can,
              manageNeed: right.need,
              eventCount: events.countEvents(r.id),
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            };
          }),
          total: sessions.countSessions(tenantOf(ctx)),
        });
      },
    },

    {
      id: 'kernel.sessions.create',
      method: 'POST',
      path: '/api/kernel/sessions',
      scope: 'session',
      capability: ['session:write'],
      summary: '新建会话（同时在内核与本地库各建一份）',
      milestone: 'M0',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        // 工作区（0.21.0）：给了 workspaceId 就要有 write 档；cwd 继承工作区的
        // （工作区 = 会话的组织容器，cwd 是它最重要的属性 —— 与原生 Harness 同一语义），
        // 显式传了 cwd 则以显式为准。
        let wsRow = null;
        if (body.workspaceId) {
          if (!workspace) throw errors.conflict('工作区服务未装配');
          const v = workspace.assertWorkspaceAccess(tenantOf(ctx), String(body.workspaceId), wsSubjectOf(ctx), 'write');
          wsRow = v.ws;
        } else if (workspace) {
          // ⚠️ 0.21.9：没给 workspaceId 时落进**兜底工作区**，不再写出一条"无归属"的会话。
          //    从前这里留空 → `workspace_id = NULL`，那就是「未分组」那一桶的来源，
          //    而它在权限上是一条暗门（服务层对它直接放行）。整桶删掉之后，
          //    "会话总要属于一个工作区"这条不变量必须**在入口处**兑现 —— 让调用方
          //    自己传对一个 id 是不够的（默认值本来就不该由客户端决定）。
          //    档位照旧要过：兜底工作区不是一个"谁都进得去"的地方。
          const def = workspace.defaultWorkspaceOf(tenantOf(ctx));
          if (def) {
            const v = workspace.assertWorkspaceAccess(tenantOf(ctx), def.id, wsSubjectOf(ctx), 'write');
            wsRow = v.ws;
          }
        }
        // ⚠️ 建会话时若要指定模型，**provider 与 model 必须成对给出**（0.21.9）。
        //    上游 `session/selectModel` 的硬要求，且它对违反的回应只有一句
        //    `wire field "request" failed boundary validation`（不点名是哪个字段）。
        //    更要紧的是**拦在建会话之前**：留到最后再抛，上游已经建好一个会话、
        //    本机也写了一条行，而响应是 500 —— 用户读到"新建失败"，库里却多了空壳
        //    （这正是 0.21.9 之前线上连发几十次 500 的真实形态）。
        if (body.model && !body.provider) {
          throw errors.badRequest('缺少 provider：指定模型时必须同时给出 provider 与 model'
            + '（上游 session/selectModel 的硬要求，只给 model 无法路由）');
        }
        const created = await kernel.provider.createSession({
          cwd: body.cwd || (wsRow && wsRow.cwd) || process.cwd(),
          presetId: body.presetId || null,
          title: body.title || '',
        });
        const row = sessions.createSessionRow({
          tenantId: tenantOf(ctx),
          ownerUserId: ctx.user ? ctx.user.id : null,
          kernelSessionId: created.sessionId,
          title: body.title || '未命名会话',
          cwd: body.cwd || (wsRow && wsRow.cwd) || process.cwd(),
          presetId: body.presetId || null,
          workspaceId: wsRow ? wsRow.id : null,
          reasoningEffort: body.reasoningEffort ? String(body.reasoningEffort) : null,
          // 建会话时可直接带上要挂的知识库（0.14.0）。此处**刻意不做可见性校验**：
          // 前端只会列出可见库，正常流程勾不出越权的值；而真有人直接打 API 塞了
          // 一个看不见的 id，检索时 knowledge.search 的 ACL 会把它丢掉 —— 安全边界
          // 在那一刻，不在这里。要"当场告诉他挂了但看不见"，走 POST …/kb（那里会校验）。
          kbIds: body.kbIds,
        });
        // 建会话时可以**显式**指定模型（P1-3）。不给就留空 —— 刻意不在这里偷偷填
        // "注册表里的默认对话模型"：那会把一个平台的猜测写成"这个会话真的用了它"，
        // 而本平台不转发请求，无从保证上游真用了它。空着 → 用量进 unattributed，如实。
        if (body.model) {
          await kernel.provider.selectModel({
            // 上面已保证 provider 非空 —— 这里不再写 `|| null`：给上游发显式的 null
            // 与"缺字段"是同一类失败（boundary validation），别让它在两处各留一个口子。
            sessionId: created.sessionId, provider: String(body.provider), model: String(body.model),
          });
          sessions.touchSession(tenantOf(ctx), row.id, {
            model_provider: body.provider == null ? '' : String(body.provider),
            model_id: String(body.model),
          });
        }
        ctx.json(201, {
          ok: true,
          session: {
            id: row.id, kernelSessionId: row.kernel_session_id, title: row.title,
            modelProvider: body.provider ? String(body.provider) : '',
            modelId: body.model ? String(body.model) : '',
            // 挂库清单回显（0.14.0）：建会话时勾的库要能立刻确认，而不是"我以为挂上了"。
            kbIds: sessions.decodeKbIds(row.kb_ids),
            // 工作区 / 模式 / 推理等级回显（0.21.0）：同一条"立刻确认"纪律。
            workspaceId: row.workspace_id || null,
            presetId: row.preset_id || null,
            reasoningEffort: row.reasoning_effort || null,
          },
        });
      },
    },

    {
      id: 'kernel.sessions.get',
      method: 'GET',
      path: '/api/kernel/sessions/:id',
      scope: 'session',
      capability: ['session:read'],
      summary: '会话详情 + 用量汇总',
      milestone: 'M0',
      handler: (ctx) => {
        const row = sessions.getSession(tenantOf(ctx), ctx.params.id);
        if (!row) throw errors.notFound('会话不存在：' + ctx.params.id);
        guardWs(ctx, row, 'view');
        ctx.ok({
          session: {
            id: row.id, title: row.title, cwd: row.cwd,
            kernelSessionId: row.kernel_session_id,
            // 模型归因（P1-3）：详情页要能回答"这个会话跑在哪个模型上"。
            modelProvider: row.model_provider || '', modelId: row.model_id || '',
            // 挂载的知识库（0.14.0）：会话详情要能回答"这个会话检索哪些库"。
            kbIds: sessions.decodeKbIds(row.kb_ids),
            // 工作区 / 模式 / 推理等级（0.21.0）：详情页回答"会话在哪个工作区、什么模式与档位"。
            workspaceId: row.workspace_id || null,
            presetId: row.preset_id || null,
            reasoningEffort: row.reasoning_effort || null,
            createdAt: row.created_at, updatedAt: row.updated_at,
          },
          usage: events.usageSummary(row.id),
          eventCount: events.countEvents(row.id),
        });
      },
    },

    {
      id: 'kernel.sessions.rename',
      method: 'PATCH',
      path: '/api/kernel/sessions/:id',
      scope: 'session',
      capability: ['session:write'],
      summary: '重命名会话（只改本地标题；不碰内核侧）',
      milestone: '0.16.0',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const title = String(body.title == null ? '' : body.title).trim();
        if (!title) throw errors.badRequest('title 不能为空（清空标题请直接想一个新名字，会话总要有个叫法）');
        if (title.length > 200) throw errors.badRequest('title 过长（≤200 字符）');
        const existing = sessions.getSession(tenantOf(ctx), ctx.params.id);
        if (!existing) throw errors.notFound('会话不存在：' + ctx.params.id);
        guardWsOwnership(ctx, existing);   // 改自己的会话 write 档就够；改别人的要 full
        let row = sessions.touchSession(tenantOf(ctx), ctx.params.id, { title });
        // 移动会话到别的工作区（0.21.0）：目标工作区要 write 档（服务层判）。
        // 别人的会话要 full（上面已把住）。
        // ⚠️ 0.21.9：`workspaceId` 给了就必须**非空** —— 从前给空串表示"移出到未分组"，
        //    而那个去处已经不存在了。空值在服务层直接 400（不在这里悄悄改成默认工作区：
        //    用户点的是"移动到…"，能走到这里的空值一定是调用方写错了）。
        if (body.workspaceId !== undefined && workspace) {
          row = workspace.moveSession({
            tenantId: tenantOf(ctx), sessionRow: row, subject: wsSubjectOf(ctx),
            toWorkspaceId: body.workspaceId,
          });
        }
        audit.append({
          tenantId: tenantOf(ctx), userId: ctx.userId || null,
          action: 'kernel.session.rename', resourceType: 'session', resourceId: row.id,
          result: 'ok', detail: { title, workspaceId: row.workspace_id || null },
        });
        ctx.ok({ session: { id: row.id, title: row.title, workspaceId: row.workspace_id || null, updatedAt: row.updated_at } });
      },
    },

    {
      id: 'kernel.sessions.delete',
      method: 'DELETE',
      path: '/api/kernel/sessions/:id',
      scope: 'session',
      capability: ['session:write'],
      summary: '删除会话（本地记录真删：事件/附件/产物记录级联清掉并清附件字节；用量留痕保留）',
      milestone: '0.16.0',
      handler: (ctx) => {
        const row = sessions.getSession(tenantOf(ctx), ctx.params.id);
        if (!row) throw errors.notFound('会话不存在：' + ctx.params.id);
        guardWsOwnership(ctx, row);   // 删自己的会话 write 档就够；删别人的要 full

        // 级联面在动手前先盘清（四类，各自处置都写在下面）：
        //   删：events（FK）、session_attachments（FK + 字节）、tool_artifacts（记录）、会话行本体；
        //   留：usage_records（配额/成本核算依据，删了等于"白嫖"已发生的用量）、
        //       审计（append-only，永不删）、上游内核侧的会话（平台只删自己的记录，
        //       装作能回收上游是撒谎 —— 引擎侧生命周期归引擎管）。
        const atts = attachments.listAttachments(tenantOf(ctx), row.id, { limit: 5000 });
        const counts = tx(() => ({
          events: events.deleteForSession(row.id),
          attachments: attachments.deleteForSession(tenantOf(ctx), row.id).length,
          artifacts: artifacts.deleteForSession(tenantOf(ctx), row.id),
          session: sessions.deleteSessionRow(tenantOf(ctx), row.id) ? 1 : 0,
        }));

        // 附件字节是平台落盘的，必须真删（与单附件 DELETE 同一套防穿越 + 容错口径）：
        // 删不掉不算整体失败（事务已提交，记录已清），但逐条如实回报。
        const bytesDeleted = [];
        const bytesErrors = [];
        for (const att of atts) {
          try {
            const abs = path.resolve(STORAGE_DIR, att.stored_path);
            if (abs.startsWith(path.resolve(STORAGE_DIR) + path.sep) && fs.existsSync(abs)) {
              fs.unlinkSync(abs);
              bytesDeleted.push(att.id);
            }
          } catch (e) { bytesErrors.push({ id: att.id, error: String(e && e.message || e) }); }
        }

        audit.append({
          tenantId: tenantOf(ctx), userId: ctx.userId || null,
          action: 'kernel.session.delete', resourceType: 'session', resourceId: row.id,
          result: 'ok',
          detail: {
            title: row.title, kernelSessionId: row.kernel_session_id || null,
            cascaded: counts, bytesDeleted: bytesDeleted.length, bytesErrors,
          },
        });
        ctx.ok({
          deleted: true, id: row.id, cascaded: counts,
          bytesDeleted: bytesDeleted.length,
          ...(bytesErrors.length ? { bytesErrors } : {}),
          kept: {
            usageRecords: '用量与成本核算依据（usage_records）不随会话删除 —— 删了等于把已发生的用量一笔勾销',
            upstream: '上游内核侧的会话不受影响（平台只删本地记录，不冒充能回收引擎侧数据）',
          },
        });
      },
    },

    {
      id: 'kernel.sessions.turns',
      method: 'POST',
      path: '/api/kernel/sessions/:id/turns',
      scope: 'session',
      capability: ['session:execute'],
      quotaMetric: 'turns',
      summary: '提交一轮对话并落库事件（附真实用量采集）',
      milestone: 'M0',
      handler: async (ctx) => {
        const row = await requireSession(ctx);
        guardWs(ctx, row, 'write');   // 发回合是工作区 write 档动作
        // 上限放宽到 16MB：图片要以 base64 塞进 JSON 请求体（膨胀 4/3），
        // 默认的 256KB 连一张小图都装不下。其余接口仍用默认值。
        const body = await readJsonBody(ctx.req, TURN_BODY_MAX);
        // 内容可以为空**当且仅当**带了附件 —— "只发一个文件"是很自然的一种提问方式。
        const hasAttach = Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;
        if ((!body.content || !String(body.content).trim()) && !hasAttach) {
          throw errors.badRequest('content 不能为空（除非本轮带了附件）');
        }

        const r = await withTurnGate({ deps, ctx, fn: () => runTurn({ deps, ctx, row, body }) });
        metrics.inc('sti_turns_total', { result: r.truncated ? 'error' : 'ok' });
        ctx.ok({
          turnId: r.turnId,
          eventsWritten: r.eventsWritten,
          lastSeq: r.lastSeq,
          truncated: r.truncated,
          usageCollected: r.usageCollected,
          artifactsRecorded: r.artifactsRecorded,
          attachments: r.attachments,
          ...(r.truncated ? { warning: '本轮事件未完整收集：' + (r.error || '超时') } : {}),
          events: r.events,
        });
      },
    },

    // ── P0-C：流式回合（NDJSON 增量推送）──────────────────────────
    //
    // 与 `…/turns` 的区别只有一个：**事件不再攒完再给**，而是收到一条推一帧，
    // 浏览器首字即可渲染。落库/用量/产物与老接口完全同源（共用 runTurn）。
    //
    // ⚠️ 一旦开始推流，HTTP 状态码就锁死为 200；此后的失败只能靠 `error` 帧
    // 告知。因此"会话存在""content 非空"这类要回 4xx 的校验放在开流之前。
    {
      id: 'kernel.sessions.turns.stream',
      method: 'POST',
      path: '/api/kernel/sessions/:id/turns/stream',
      scope: 'session',
      capability: ['session:execute'],
      quotaMetric: 'turns',
      summary: '提交一轮对话并以 NDJSON 增量推送事件（首字即达）',
      milestone: 'P0',
      handler: async (ctx) => {
        const row = await requireSession(ctx);
        guardWs(ctx, row, 'write');   // 流式发回合同上
        // 同上：带图片的一轮要放宽请求体上限，否则 base64 后的图会把 256KB 撑爆。
        const body = await readJsonBody(ctx.req, TURN_BODY_MAX);
        const hasAttach = Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;
        if ((!body.content || !String(body.content).trim()) && !hasAttach) {
          throw errors.badRequest('content 不能为空（除非本轮带了附件）');
        }

        // 显式协商：只认 NDJSON。给出别的 Accept 说明调用方用错了接口 —— 明确拒绝，
        // 不要"善意地"回一段 JSON 让它以为拿到的是流（那会让前端静默卡住）。
        const accept = String(ctx.req.headers.accept || '');
        if (accept && !accept.includes('*/*') && !accept.includes('ndjson') && !accept.includes('json')) {
          throw errors.badRequest('该接口以 application/x-ndjson 增量返回；如需一次性 JSON 请用 POST …/turns');
        }

        // ⚠️ 并发闸必须在**开流之前**判：一旦开始推流，HTTP 状态码就锁死为 200，
        //    超限就只能靠 error 帧告知（调用方拿不到 429，重试逻辑写不对）。
        await withTurnGate({
          deps, ctx,
          fn: async () => {
            const stream = openNdjsonStream(ctx);
            try {
              const r = await runTurn({
                deps, ctx, row, body,
                emit: (frame) => stream.write({ ts: Date.now(), ...frame }),
                // 客户端断开 → 中止上游读取（但 runTurn 仍会把已收到的事件落库）
                linkAbort: (ac) => { ctx.res.on('close', () => ac.abort()); },
              });
              metrics.inc('sti_turns_total', { result: r.truncated ? 'error' : 'ok' });
              if (r.truncated) stream.warning('本轮事件未完整收集：' + (r.error || '超时'), { truncated: true });
              stream.done({
                turnId: r.turnId,
                eventsWritten: r.eventsWritten,
                lastSeq: r.lastSeq,
                truncated: r.truncated,
                usageCollected: r.usageCollected,
                artifactsRecorded: r.artifactsRecorded,
                attachments: r.attachments,
              });
            } catch (e) {
              metrics.inc('sti_turns_total', { result: 'error' });
              // 响应头已写出，改不了状态码 —— 用 error 帧如实收场
              stream.error('turn_failed', e && e.message ? e.message : String(e));
            } finally {
              stream.close();
            }
          },
        });
      },
    },

    {
      id: 'kernel.sessions.model',
      method: 'POST',
      path: '/api/kernel/sessions/:id/model',
      scope: 'session',
      capability: ['session:write'],
      summary: '为会话选择模型（内核目录里可路由的 provider/model）',
      milestone: 'P0',
      handler: async (ctx) => {
        const row = await requireSession(ctx);
        guardWs(ctx, row, 'write');
        const body = await readJsonBody(ctx.req);
        if (!body.model) throw errors.badRequest('缺少 model');
        // 与建会话那条同一个硬要求：provider 与 model 必须成对（见 compat/0.2.0-rc.2.mjs
        // 里 selectModel 的实测记录）。只给 model 上游只会回一句不点名字段的
        // boundary validation，读起来像"上游坏了"，其实是参数不全。
        if (!body.provider) {
          throw errors.badRequest('缺少 provider：选模型必须同时给出 provider 与 model'
            + '（上游 session/selectModel 的硬要求，只给 model 无法路由）');
        }
        // 契约有 selectModel，但此前没有 HTTP 入口 —— 于是前端"选模型"只能是装饰。
        // 这里把它接上：由 provider 真正切换会话使用的模型与推理等级。
        await kernel.provider.selectModel({
          sessionId: row.kernel_session_id,
          provider: String(body.provider),   // 上面已保证非空（见那道 400）
          model: String(body.model),
          reasoningEffort: body.reasoningEffort || null,
        });
        // 把这次选择**落到本会话行上**（P1-3）。三个理由，缺哪个都不行：
        //   1. 成本/用量归因：后续回合的 usage_records.model_id 从这里取（见 runTurn）；
        //   2. 会话详情页要能显示"这个会话现在跑在哪个模型上"，而不是只能显示"切过了"；
        //   3. 内核重启后上游不记得，本地库得记得。
        // 语义边界：它记的是「平台**要求**上游用的模型」，不是从事件里观测到的实际模型。
        // 0.21.0：推理等级同理 —— 此前只透传上游不落库，重启后"这个会话用什么推理等级"就丢了。
        const updated = sessions.touchSession(tenantOf(ctx), row.id, {
          model_provider: body.provider == null ? '' : String(body.provider),
          model_id: String(body.model),
          reasoning_effort: body.reasoningEffort ? String(body.reasoningEffort) : null,
        });
        audit.append({
          tenantId: tenantOf(ctx), userId: ctx.userId || null,
          action: 'kernel.session.select-model', resourceType: 'session', resourceId: row.id,
          result: 'ok', detail: { provider: body.provider || null, model: String(body.model), reasoningEffort: body.reasoningEffort || null },
        });
        ctx.ok({
          sessionId: row.id,
          provider: body.provider || null,
          model: String(body.model),
          reasoningEffort: body.reasoningEffort ? String(body.reasoningEffort) : null,
          recorded: {
            modelProvider: updated.model_provider || '', modelId: updated.model_id || '',
            reasoningEffort: updated.reasoning_effort || null,
          },
          note: '本会话后续回合的用量会归因到这个模型名（匹配模型注册表里的「模型名」列）。',
        });
      },
    },

    {
      id: 'kernel.sessions.kb',
      method: 'POST',
      path: '/api/kernel/sessions/:id/kb',
      scope: 'session',
      capability: ['session:write'],
      summary: '设置会话挂载的知识库（决定后续回合的检索范围）',
      milestone: 'P0',
      handler: async (ctx) => {
        const row = await requireSession(ctx);
        guardWs(ctx, row, 'write');
        const body = await readJsonBody(ctx.req);
        const wanted = Array.isArray(body.kbIds)
          ? body.kbIds
          : (body.kbId ? [body.kbId] : []);

        // 挂载时**先校验可见性**，而不是"先存下、等检索时再静默忽略"。
        // 两种做法的差别在于用户能不能当场知道：静默接受的话，他勾了一个自己无权
        // 的库、界面上显示"已挂载"、之后每轮检索都少一份资料 —— 而没有任何一处
        // 会告诉他为什么。这里把被拒的**逐条点名**回显。
        //
        // ⚠️ 挂载校验**不替代**检索侧校验（knowledge.search 里的 ACL）：库可以在
        //    挂载之后被改成 restricted，所以真正的边界永远在检索那一刻。
        //    这里只是让"现在就能发现的问题现在就说"。
        const notes = [];
        let accepted = [];
        let klist = null;
        try {
          klist = deps.knowledge && typeof deps.knowledge.listBases === 'function'
            ? deps.knowledge.listBases(tenantOf(ctx), {
              userId: ctx.userId, roles: (ctx.user && ctx.user.roles) || [],
            })
            : null;
        } catch (e) {
          notes.push('可见知识库列表读取失败，本次跳过挂载校验：' + (e && e.message ? e.message : String(e)));
        }

        if (!Array.isArray(klist)) {
          // 服务未装配 / 查询失败：**放行**。挂库是增益，不是权限授予 ——
          // 挡在这里会变成"知识服务一抖，所有人的挂库操作全失败"，
          // 而真正的安全边界（检索时的 ACL）仍然完好。
          accepted = [...new Set(wanted.map(String).filter(Boolean))];
        } else {
          const byId = new Map(klist.map((b) => [String(b.id), b]));
          const missing = [];
          for (const raw of wanted) {
            const id = String(raw || '').trim();
            if (!id) continue;
            if (byId.has(id)) { if (!accepted.includes(id)) accepted.push(id); }
            else if (!missing.includes(id)) missing.push(id);
          }
          if (missing.length) {
            notes.push('已忽略不可见或不存在的知识库（' + missing.length + ' 个）：' + missing.join('、'));
          }
        }

        // 上限截断也要说清楚 —— 静默截断会让前端显示 5 个、实际只挂了 4 个。
        const capped = accepted.length > sessions.KB_PER_SESSION_MAX;
        const finalIds = accepted.slice(0, sessions.KB_PER_SESSION_MAX);
        if (capped) {
          notes.push('单个会话最多挂载 ' + sessions.KB_PER_SESSION_MAX + ' 个知识库，超出部分已忽略。');
        }

        const updated = sessions.touchSession(tenantOf(ctx), row.id, { kb_ids: sessions.encodeKbIds(finalIds) });
        const recorded = sessions.decodeKbIds(updated.kb_ids);

        audit.append({
          tenantId: tenantOf(ctx), userId: ctx.userId || null,
          action: 'kernel.session.set-kb', resourceType: 'session', resourceId: row.id,
          result: 'ok', detail: { kbIds: recorded, requested: wanted.length },
        });

        ctx.ok({
          sessionId: row.id,
          kbIds: recorded,
          // 「你要求的」与「实际挂上的」分开回。两者不等时 notes 一定非空。
          requested: wanted.length,
          notes,
          effect: recorded.length
            ? '本会话后续回合会在提交前检索这 ' + recorded.length + ' 个知识库，并把命中片段注入上下文。'
              + '挂载不清空历史：已发生的回合不受影响。'
            : '已清空挂载。本会话后续回合不再做知识检索，行为回到不挂库。',
        });
      },
    },

    {
      id: 'kernel.sessions.events',
      method: 'GET',
      path: '/api/kernel/sessions/:id/events',
      scope: 'session',
      capability: ['session:read'],
      summary: '事件列表（本地落库为主，尽力补上游快照）',
      milestone: 'M0',
      handler: async (ctx) => {
        const row = sessions.getSession(tenantOf(ctx), ctx.params.id);
        if (!row) throw errors.notFound('会话不存在：' + ctx.params.id);
        guardWs(ctx, row, 'view');
        const fromSeq = Number(ctx.query.fromSeq || 0);
        const limit = Number(ctx.query.limit || 500);

        const persisted = events.listEvents(row.id, { fromSeq, limit });
        let live = [];
        let liveError = '';
        try {
          const snap = await kernel.provider.snapshot({ kind: 'turns', sessionId: row.kernel_session_id, cwd: row.cwd, limit });
          live = (snap && snap.items) || [];
        } catch (e) {
          liveError = e.message;
        }
        // 服务点抹名（0.15.1）：两路来源的 text/delta 都可能是上游原文
        // （系统提示词、运行时上下文回放），过一遍契约层的抹名再出 API。
        // 落库原文不动 —— 这里是**读取口**，与实时帧的抹名同一条纪律。
        const bySeq = new Map();
        for (const ev of live) bySeq.set(Number(ev.seq), { ...sanitizeKernelEvent(ev), source: 'kernel' });
        for (const ev of persisted) bySeq.set(Number(ev.seq), { ...sanitizeKernelEvent(ev), source: 'db' });
        const items = [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(0, limit);

        ctx.ok({
          items,
          count: items.length,
          persistedCount: persisted.length,
          ...(liveError ? { liveUnavailable: true, liveReason: liveError } : {}),
        });
      },
    },

    {
      id: 'kernel.sessions.export',
      method: 'GET',
      path: '/api/kernel/sessions/:id/export',
      scope: 'session',
      capability: ['session:read'],
      summary: '导出会话转录（format=md 文本 / json 结构化；注入段已剥离并注明）',
      milestone: '0.17.0',
      handler: (ctx) => {
        const row = sessions.getSession(tenantOf(ctx), ctx.params.id);
        if (!row) throw errors.notFound('会话不存在：' + ctx.params.id);
        guardWs(ctx, row, 'view');

        const format = String((ctx.query && ctx.query.format) || 'md').toLowerCase();
        if (format !== 'md' && format !== 'json') {
          throw errors.badRequest('format 只支持 md 或 json，收到：' + format);
        }

        // 只读**已落库**事件：落库的部分就是事实，服务端不额外拒绝导出中的会话。
        // 「流式进行中先别导出」由前端按钮禁用表达 —— 那一轮还没落库，此刻导出的文件
        // 会少最后一轮；这是**按钮时刻**的语义，不该由服务端替用户猜。
        const rows = events.listEvents(row.id, { fromSeq: 0, limit: TRANSCRIPT_MAX_EVENTS + 1 });
        const truncated = rows.length > TRANSCRIPT_MAX_EVENTS;
        const items = rows.slice(0, TRANSCRIPT_MAX_EVENTS).map((ev) => sanitizeKernelEvent(ev));

        const title = row.title || '(未命名会话)';
        const exportedAt = nowIso();
        const msgs = buildTranscript(items);

        audit.append({
          tenantId: tenantOf(ctx), userId: ctx.userId || null,
          action: 'kernel.session.export', resourceType: 'session', resourceId: row.id,
          result: 'ok', detail: { format, eventCount: items.length, truncated },
        });

        ctx.ok({
          sessionId: row.id,
          title,
          format,
          filename: safeBaseName(title, 'session-' + row.id) + (format === 'json' ? '.json' : '.md'),
          eventCount: items.length,
          truncated,
          content: format === 'json'
            ? {
              sessionId: row.id,
              title,
              model: { provider: row.model_provider || null, id: row.model_id || null },
              exportedAt,
              eventCount: items.length,
              truncated,
              messages: msgs,
            }
            : transcriptToMarkdown(
              { sessionId: row.id, title, provider: row.model_provider, model: row.model_id, eventCount: items.length, truncated, exportedAt },
              msgs),
        });
      },
    },

    {
      id: 'kernel.sessions.cancel',
      method: 'POST',
      path: '/api/kernel/sessions/:id/cancel',
      scope: 'session',
      capability: ['session:execute'],
      summary: '取消会话当前回合（向上游发取消；已收到的事件不丢）',
      milestone: 'M0',
      handler: async (ctx) => {
        const row = await requireSession(ctx);
        guardWs(ctx, row, 'write');
        const body = await readJsonBody(ctx.req);
        const turnId = body.turnId ? String(body.turnId) : null;

        // ⚠️ 「停止」是两件事，必须先分清（否则用户以为停了、其实上游还在烧 token）：
        //   ① 断开读取 —— 前端 abort 掉 HTTP 响应，平台不再接收。这一条**不需要**本端点。
        //   ② 通知上游别跑了 —— 这一条才是本端点，它省的是上游的算力/token。
        // 两条一起做才是完整的"停止"。只做 ① 时，页面必须如实说"只是不再接收"。
        let upstream = { attempted: false };
        try {
          await kernel.provider.cancelTurn({ sessionId: row.kernel_session_id, turnId });
          upstream = { attempted: true, ok: true };
        } catch (e) {
          // 取消失败**不是**请求失败：本地已经停止接收了，如实回报"上游没取消成功"即可。
          upstream = { attempted: true, ok: false, error: e && e.message ? String(e.message) : String(e) };
        }

        audit.append({
          tenantId: tenantOf(ctx), userId: ctx.userId || null,
          action: 'kernel.session.cancel', resourceType: 'session', resourceId: row.id,
          result: upstream.ok ? 'ok' : 'error',
          detail: { turnId, upstream },
        });
        metrics.inc('sti_turn_cancels_total', { result: upstream.ok ? 'ok' : 'error' });

        ctx.ok({
          cancelled: true,
          turnId,
          upstream,
          eventsAlreadyPersisted: events.countEvents(row.id),
          note: upstream.ok
            ? '已向上游发出取消；此前收到的事件已落库，不会因取消而丢弃某一轮的全部轨迹。'
            : '本地已停止接收，但上游取消未成功：上游可能仍在消耗 token。请以用量页的实际数字为准。',
        });
      },
    },

    /* ── 会话附件（3.6）──────────────────────────────────────────────
     *
     * 传输契约：**元数据走 query，body 就是文件本身**（不用 multipart，理由见
     * context.mjs 的 readRawBody）。前端一行 `fetch(url,{method:'POST',body:file})` 即可。
     */
    {
      id: 'kernel.sessions.attachments.upload',
      method: 'POST',
      path: '/api/kernel/sessions/:id/attachments',
      scope: 'session',
      capability: ['session:write'],
      summary: '上传会话附件（原始字节 + ?filename= 元数据）',
      milestone: 'P1-3',
      handler: async (ctx) => {
        const row = await requireSession(ctx);
        guardWs(ctx, row, 'write');
        const filename = String(ctx.query.filename || '').trim();
        if (!filename) throw errors.badRequest('缺少 ?filename=（文件名走 query，body 就是文件字节）');

        const buf = await readRawBody(ctx.req, ATTACH_MAX_BYTES);
        if (!buf.length) throw errors.badRequest('文件为空');

        const safe = safeBaseName(filename, 'attachment');
        const mime = String(ctx.req.headers['content-type'] || '');
        // 文本判定：只在能确认是 UTF-8 时才注入（`Content-Type: text/*` 或 file.type 为空）。
        // 判据以**内容**为准，扩展名与 mime 只是"要不要做 UTF-8 往返校验"的提示。
        const kind = classifyBuffer(buf, mime.startsWith('text/') || mime === '' || mime.includes('json') || mime.includes('xml'));
        // 再按**魔数**认一次图片，认出来就用嗅探结果**覆盖**浏览器声明的 mime。
        // 为什么必须覆盖而不是"参考一下"：
        //   · `mime` 会落库并展示给用户，而浏览器声明经常不准（改名文件、octet-stream）；
        //   · 发送时它决定"能不能当图片送"，而上游会因为"字节与声明类型不符"
        //     让**整条消息失败** —— 我们只信自己嗅出来的那几个字节。
        // 认不出的格式**不猜**：退回文件通路，宁可少送，不拿用户整轮提问去赌。
        const detectedImage = sniffImageMediaType(buf);
        const storedMime = detectedImage || mime;

        const id = 'att_' + crypto.randomBytes(9).toString('hex');
        // 落盘路径带租户与会话两级目录：
        //   · 一级租户 —— 即便将来有人做运维级的目录列举，也一眼能看出边界；
        //   · 一级会话 —— 删除整段会话时可以整目录回收，不必逐文件找。
        const relDir = path.posix.join('uploads', 'sessions', tenantOf(ctx), row.id);
        const absDir = path.join(STORAGE_DIR, relDir);
        fs.mkdirSync(absDir, { recursive: true });
        const relPath = path.posix.join(relDir, id + '__' + safe);
        fs.writeFileSync(path.join(STORAGE_DIR, relPath), buf);

        const rec = attachments.createAttachment({
          tenantId: tenantOf(ctx), sessionId: row.id, userId: ctx.userId || null,
          name: safe, mime: storedMime, bytes: buf.length, kind, storedPath: relPath,
          sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        });
        audit.append({
          tenantId: tenantOf(ctx), userId: ctx.userId || null,
          action: 'kernel.session.attachment.upload', resourceType: 'attachment', resourceId: rec.id,
          result: 'ok', detail: { sessionId: row.id, name: safe, bytes: buf.length, kind, detectedImage: detectedImage || null },
        });

        // 「这个附件发送时会怎样」——三种互斥的结局，在上传时就**一次性说清**，
        // 而不是等用户发了才发现"怎么没送出去"。前端据此在列表上直接标注。
        const injectable = kind === 'text' && buf.length <= INJECT_PER_FILE_MAX;
        let delivery;
        if (detectedImage) {
          delivery = {
            mode: 'image',
            note: '已按内容识别为 ' + detectedImage + '；发送时作为图片内容块提交给模型，模型能直接看到这张图。',
          };
        } else if (injectable) {
          delivery = {
            mode: 'text',
            note: '文本附件：发送时正文会被拼进本轮上下文（单文件 ≤ '
              + Math.round(INJECT_PER_FILE_MAX / 1024) + 'KB）。气泡显示为简化形式，轨迹里保留原文。',
          };
        } else {
          delivery = {
            mode: 'none',
            note: '该附件不会送给模型：仅登记、展示与下载。',
          };
        }

        ctx.json(201, {
          ok: true,
          attachment: attachments.hydrate(rec),
          injectable,
          delivery,
          semantics: {
            mime: '响应里的 mime 是平台按文件内容（魔数）嗅探出的真实类型；'
              + '嗅探不出白名单图片时，退回浏览器声明的值 —— 因为猜错会让上游整条消息失败。',
            kind: 'kind 由内容判定（出现 NUL 字节或非法 UTF-8 序列即为 binary），不看扩展名。'
              + '它只决定"能不能以文本注入"，与"能不能当图片送"是两件事。',
            imageTypes: '可作为图片送给模型的白名单：' + IMAGE_MEDIA_TYPES.join(' / ')
              + '（单张 ≤ ' + humanBytes(ATTACH_MAX_BYTES) + '，即上传上限；本轮合计 ≤ '
              + humanBytes(IMAGE_TOTAL_MAX) + '）。',
            injectable: '只有 text 且不超过 ' + Math.round(INJECT_PER_FILE_MAX / 1024)
              + 'KB 的附件会被注入本轮上下文（内容拼进 content 的引用块）。',
          },
        });
      },
    },

    {
      id: 'kernel.sessions.attachments.list',
      method: 'GET',
      path: '/api/kernel/sessions/:id/attachments',
      scope: 'session',
      capability: ['session:read'],
      summary: '会话附件列表',
      milestone: 'P1-3',
      handler: (ctx) => {
        const row = sessions.getSession(tenantOf(ctx), ctx.params.id);
        if (!row) throw errors.notFound('会话不存在：' + ctx.params.id);
        guardWs(ctx, row, 'view');
        const rows = attachments.listAttachments(tenantOf(ctx), row.id, { limit: Number(ctx.query.limit || 200) });
        ctx.ok({
          items: rows.map((r) => {
            // 列表页要能直接说清"这个附件发送时会怎样"。这里按**落库的 mime** 判 ——
            // 上传时已用魔数嗅探并覆盖过，所以它是可信的，不必为列表再读一遍文件。
            const isImg = isImageMediaType(r.mime);
            const canInject = r.kind === 'text' && Number(r.bytes) <= INJECT_PER_FILE_MAX;
            return {
              ...attachments.hydrate(r),
              delivery: isImg ? 'image' : (canInject ? 'text' : 'none'),
            };
          }),
          count: rows.length,
          limits: {
            maxBytes: ATTACH_MAX_BYTES,
            injectMaxBytes: INJECT_MAX_BYTES,
            injectPerFileMax: INJECT_PER_FILE_MAX,
            imagePerFileMax: ATTACH_MAX_BYTES,   // = 上传上限（图片不另设更小的数，见内核路由的常量说明）
            imageTotalMax: IMAGE_TOTAL_MAX,
            imageTypes: IMAGE_MEDIA_TYPES.slice(),
          },
          semantics: {
            image: '图片（按内容识别为 ' + IMAGE_MEDIA_TYPES.join(' / ') + '）发送时作为图片内容块提交给模型。',
            text: '文本附件（≤ ' + Math.round(INJECT_PER_FILE_MAX / 1024) + 'KB）的正文会在发送时被拼进本轮上下文。',
            other: '其余通用文件仅登记、展示与下载，不会送给模型。',
          },
        });
      },
    },

    {
      id: 'kernel.sessions.attachments.get',
      method: 'GET',
      path: '/api/kernel/sessions/:id/attachments/:attId',
      scope: 'session',
      capability: ['session:read'],
      summary: '下载会话附件（按租户 + 会话双重过滤）',
      milestone: 'P1-3',
      handler: (ctx) => {
        const row = sessions.getSession(tenantOf(ctx), ctx.params.id);
        if (!row) throw errors.notFound('会话不存在：' + ctx.params.id);
        guardWs(ctx, row, 'view');
        const rec = attachments.getAttachment(tenantOf(ctx), row.id, String(ctx.params.attId));
        if (!rec) throw errors.notFound('附件不存在：' + ctx.params.attId);
        // 防目录穿越：stored_path 是我们自己写进去的，但仍做一次规范化确认 ——
        // 万一将来有人手工改库，这里不会变成任意文件读取。
        const abs = path.resolve(STORAGE_DIR, rec.stored_path);
        if (!abs.startsWith(path.resolve(STORAGE_DIR) + path.sep)) throw errors.internal('附件路径越界（数据被篡改？）');
        if (!fs.existsSync(abs)) throw errors.notFound('附件字节已丢失（元数据在、文件不在，请检查存储目录）');
        ctx.setHeader('content-type', rec.mime || 'application/octet-stream');
        // HTTP 头值只允许 ASCII（Node 会直接抛 "Invalid character in header content"，
        // 表现为**中文名附件一律下载失败 500**）。所以两个都给：
        //   · `filename=`  —— 纯 ASCII 兜底名（老客户端用这个，中文替换成下划线）；
        //   · `filename*=` —— RFC 5987 的 UTF-8 真名（现代浏览器优先用它，中文不乱码）。
        const asciiName = String(rec.name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
        ctx.setHeader('content-disposition',
          'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(rec.name));
        ctx.text(200, fs.readFileSync(abs), rec.mime || 'application/octet-stream');
      },
    },

    {
      id: 'kernel.sessions.attachments.delete',
      method: 'DELETE',
      path: '/api/kernel/sessions/:id/attachments/:attId',
      scope: 'session',
      capability: ['session:write'],
      summary: '删除会话附件（元数据 + 落盘字节都删）',
      milestone: 'P1-3',
      handler: (ctx) => {
        const row = sessions.getSession(tenantOf(ctx), ctx.params.id);
        if (!row) throw errors.notFound('会话不存在：' + ctx.params.id);
        guardWs(ctx, row, 'write');   // 删附件是内容写动作
        const rec = attachments.getAttachment(tenantOf(ctx), row.id, String(ctx.params.attId));
        if (!rec) throw errors.notFound('附件不存在：' + ctx.params.attId);
        attachments.deleteAttachment(tenantOf(ctx), row.id, rec.id);
        // 字节也要真删 —— 合规上的"删除请求"必须落到内容上，只删元数据是假删除。
        // 删不掉（文件本就不在/被占用）不算失败，但要如实回报。
        let bytesDeleted = false;
        let bytesError = '';
        try {
          const abs = path.resolve(STORAGE_DIR, rec.stored_path);
          if (abs.startsWith(path.resolve(STORAGE_DIR) + path.sep) && fs.existsSync(abs)) {
            fs.unlinkSync(abs);
            bytesDeleted = true;
          }
        } catch (e) { bytesError = e && e.message ? String(e.message) : String(e); }
        audit.append({
          tenantId: tenantOf(ctx), userId: ctx.userId || null,
          action: 'kernel.session.attachment.delete', resourceType: 'attachment', resourceId: rec.id,
          result: bytesDeleted ? 'ok' : 'partial', detail: { sessionId: row.id, name: rec.name, bytesDeleted, bytesError },
        });
        ctx.ok({ deleted: true, id: rec.id, bytesDeleted, ...(bytesError ? { bytesError } : {}) });
      },
    },

    // ── 这里曾经有一条 `kernel.sessions.search`（/api/kernel/sessions/:id/search）──────────
    // 会话内检索是一套**完整而正确**的设计：服务端在落库事件里找（不依赖前端已加载的那 2000 条），
    // 再按"可见文本（正文 / 推理增量）"复核一次，把工具入参 / 事件类型名那类假阳性挡掉。
    // 本轮被**整块删除**（用户：右上角"会话内搜索删除" → 裁定"整块删除"），不是只摘掉那颗按钮 ——
    // 按钮摘了实现留着，下一个人还会把它接回来，这就是本项目一直在清的那种"藏起来的那份"。
    // 一并删掉的：路由（这里）、`events.searchEvents`（仓储层）、前端四个动作（71-app-workbench.js）、
    // 命中面板（84-workbench.js）、消息高亮、State 四个字段、CSS。
    // 要加回来时**沿用当时的口径**：服务端匹配 + 可见文本复核 + 归属校验走 `sessions.getSession`。
  ];
}

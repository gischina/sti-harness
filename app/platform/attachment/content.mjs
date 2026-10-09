/**
 * 附件 → 上游提示词内容块（平台级横切能力）。
 *
 * ── 为什么这个模块存在（以及上一版错在哪）────────────────────────────────
 *
 * 上一版（0.9.0 / 3.6）在这里下过一个**错误的结论**并写进了四份文档：
 *
 *   「平台没有接通上游的"上传一个新附件"通道（契约里的 `readAttachment`
 *     是"读上游已有的附件"，不是"送一个上去"）。」
 *
 * 错在**只看了契约的一半就推断了整体**。`readAttachment` 确实是"读"，
 * 但**写入通道不在它身上**，而在 `submitTurn` 的 `content` 内容块数组里。
 * 上游（`@deepseek-ai/dsh@0.2.0-rc.2`）的 `dsh-attachment` 官方契约：
 *
 *   // @deepseek-ai/dsh-attachment/lib/types/types.d.ts
 *   export type PromptContentPart =
 *     | { type: 'text';  text: string }
 *     | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
 *         data: string;          // 规范 base64
 *         name?: string };
 *
 * 并且注释明写：「a wire caller can **never cite an attachment it did not
 * upload**」—— 即**必须在提交那一刻把 base64 一起带上**，不能只引用一个 id。
 * 我们的 `toBlocks()` 对数组是**原样透传**，所以这条路本来就是通的。
 *
 * ── 上游对两类附件的待遇**根本不同**（这是它的设计，不是平台的缺失）──
 *
 *   图片：校验 → 规范化（EXIF 摆正、去元数据、缩放、转 WebP/JPEG）→ **字节真的送给模型**。
 *   通用文件：**按字节原样保存**，而「通用文件的字节**永远不会到达提供方**：
 *            每条路由都收到一行确定性的句柄文本……以及供文件工具读取的只读保存路径。」
 *            （`@deepseek-ai/dsh-attachment/README.zh.md`）
 *
 * 所以"二进制附件不会送给模型"这句话对**文件**成立、对**图片**不成立 ——
 * 上一版把两者混为一谈，才给出了"一律不送"的结论。
 * 本模块只负责**图片这一条**通路；文件那条（给模型一行可读路径）是 B 档，
 * 见 docs/roadmap.md 的探针结论。
 *
 * ── 为什么必须按**内容**嗅探，而不是信扩展名/声明的 mime ────────────────
 *
 * 上游在准入时会「校验字节与声明类型是否相符」，不符则**整条消息失败**
 * （连文本一起不发布）。所以把一张改名成 .png 的 JPEG 声明成 image/png，
 * 后果不是"这张图丢了"，而是**用户这一轮提问整个发不出去**。
 * 我们宁可自己先认出来：认不出白名单格式的，就**不按图片送**，退回文件路径。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */

/**
 * 上游接受的白名单图片类型（**逐字**取自 `PromptContentPart` 的 `ImageMediaType`）。
 * 不在此列的一律不按图片送 —— 上游会因为"声明与实际不符"整条失败，
 * 我们不能拿用户的整轮提问去赌一个自己没认出来的格式。
 */
export const IMAGE_MEDIA_TYPES = Object.freeze([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]);

/** 声明的 mime → 上游媒体类型的白名单查找表 */
const IMAGE_MEDIA_TYPE_SET = new Set(IMAGE_MEDIA_TYPES);

/** 判断一个 mime 是不是上游接受的白名单图片类型 */
export function isImageMediaType(mt) {
  return IMAGE_MEDIA_TYPE_SET.has(String(mt || '').toLowerCase().split(';')[0].trim());
}

/** 读第 n 个字节（越界返回 -1），避免到处写 `buf.length > n ? buf[n] : -1` */
function at(buf, n) {
  return n < buf.length ? buf[n] : -1;
}

/**
 * 按**文件魔数**嗅探真实图片类型；不是白名单图片则返回 `''`。
 *
 * 只认这四种（与上游白名单一一对应），刻意**不做**"看起来像图片就猜一个"的兜底：
 * 猜错的代价是整轮消息失败，比"不按图片送"严重得多。
 *
 * @param {Buffer|Uint8Array} buf 文件**开头**若干字节即可（≥ 12 字节足够，多传无害）
 * @returns {'image/png'|'image/jpeg'|'image/webp'|'image/gif'|''}
 */
export function sniffImageMediaType(buf) {
  if (!buf || buf.length < 4) return '';

  // PNG：89 50 4E 47 0D 0A 1A 0A（8 字节签名，是全部格式里最长的，先判）
  if (
    at(buf, 0) === 0x89 && at(buf, 1) === 0x50 && at(buf, 2) === 0x4e && at(buf, 3) === 0x47 &&
    at(buf, 4) === 0x0d && at(buf, 5) === 0x0a && at(buf, 6) === 0x1a && at(buf, 7) === 0x0a
  ) return 'image/png';

  // JPEG：FF D8 FF（JPEG 家族全部以 SOI 开头，第三字节是某个标记前缀）
  if (at(buf, 0) === 0xff && at(buf, 1) === 0xd8 && at(buf, 2) === 0xff) return 'image/jpeg';

  // GIF：47 49 46 38 ("GIF8")，后接 '7a' 或 '9a' 表示 GIF87a / GIF89a
  if (at(buf, 0) === 0x47 && at(buf, 1) === 0x49 && at(buf, 2) === 0x46 && at(buf, 3) === 0x38) {
    const v = at(buf, 4);
    if (v === 0x37 || v === 0x39) return 'image/gif';
  }

  // WebP：RIFF 容器 —— 0..4 为 "RIFF"，8..12 为 "WEBP"。
  // 两个都要判：只看 RIFF 会把 .wav / .avi 认成图片。
  if (
    at(buf, 0) === 0x52 && at(buf, 1) === 0x49 && at(buf, 2) === 0x46 && at(buf, 3) === 0x46 &&
    at(buf, 8) === 0x57 && at(buf, 9) === 0x45 && at(buf, 10) === 0x42 && at(buf, 11) === 0x50
  ) return 'image/webp';

  return '';
}

/**
 * 把图片字节装成上游要求的内容块。
 *
 * @param {{ data: Buffer|Uint8Array, mediaType: string, name?: string }} p
 *   `mediaType` **必须是 `sniffImageMediaType()` 的结果**，不接受调用方自报的值 ——
 *   这是本模块唯一的硬约束，因为它决定了上游会不会整条拒绝。
 * @returns {{type:'image', mediaType:string, data:string, name?:string}}
 */
export function toImagePart({ data, mediaType, name = '' }) {
  if (!isImageMediaType(mediaType)) {
    throw new Error('toImagePart：mediaType 不在上游白名单内（' + mediaType + '）—— 请先调用 sniffImageMediaType()');
  }
  const part = {
    type: 'image',
    mediaType,
    // 上游要求**规范 base64**（`EncodedImageAttachment.data`）。Node 的 toString('base64')
    // 输出标准 base64（含 `=` 补位、不含换行），符合"规范"要求。
    data: Buffer.from(data).toString('base64'),
  };
  const n = String(name || '');
  if (n) part.name = n;      // 上游 name 是可选字段，空串就不带
  return part;
}

/**
 * 图片清单的**人类可读**描述，用于落进 `turn-start` 的正文里。
 *
 * 为什么要写进正文（而不是只在事件里提一句）：`turn-start` 的 text 是
 * "真正交给内核的东西"，轨迹必须自解释 —— 只读 API 的调用方看到这句话，
 * 才知道这一轮除了文字还带了图，且**图是真的以图片块提交的**。
 *
 * @param {Array<{name:string, mediaType:string, bytes:number}>} images
 * @returns {string} 没有图片时返回空串
 */
export function describeImages(images) {
  if (!Array.isArray(images) || !images.length) return '';
  const lines = images.map((im) => {
    const kind = String(im.mediaType || '').replace(/^image\//, '');
    return '  · ' + im.name + '（' + kind + '，' + humanBytes(im.bytes) + '）';
  });
  return '本轮随附 ' + images.length + ' 张图片，已作为图片内容块提交给模型：\n' + lines.join('\n');
}

/** 字节数的人类可读形式（只用于展示与正文描述，不参与任何判断） */
export function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + 'B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + 'KB';
  return (v / 1024 / 1024).toFixed(1) + 'MB';
}

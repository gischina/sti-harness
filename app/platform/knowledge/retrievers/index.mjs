/**
 * 检索器装配点 —— **`VectorIndex` 抽象的唯一落点**。
 *
 * 为什么需要这一层（而不是让 service.mjs 直接 import `searchVector`）：
 *   文档里反复出现一句承诺：「到规模了再换 ANN 索引，**不改调用方**」。
 *   在引入本文件之前，这句话是**假的** —— `service.mjs` 直接 import 具体函数，
 *   想换索引就必须去改 service 的调用点（这正是一次全量体检抓出来的问题：
 *   文档写了 6 遍的"已预留 `VectorIndex` 抽象"，代码里一次都没出现）。
 *   现在把"选哪个实现"收口到这里：`service.mjs` 只认 `index.search(payload)`，
 *   换 ANN 只需在 `createVectorIndex()` 里加一个分支 + 一份新实现，调用方一行不动。
 *
 * 诚实边界：
 *   · 当前**只实装一种**向量索引：`brute-force`（精确余弦，见 vector.mjs）。
 *     本文件**不假装**已有 ANN —— 未知 `kind` 会**抛错**，而不是静默回退到暴力扫描
 *     （静默回退会让"我配了 ann 但其实在暴力扫描"变成看不见的事实）。
 *   · 文本侧同理：`fts5-bigram` 是唯一实现；它没有"换索引"的现实诉求，
 *     所以这一层对文本侧更多是**接口对称**，而不是待替换点。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { searchFts, searchFtsIds } from './fts.mjs';
import { searchVector, SAFE_IN_LIMIT } from './vector.mjs';

/**
 * 预过滤候选的**安全上限**（转发 vector.mjs 的值，不另抄一个数字）。
 * service 用它把配置项 `prefilterCandidates` 夹紧，这样"配了个过大的值"
 * 不会变成一次 SQL 变量爆炸 —— 而是在配置生效处就被夹住并如实说明。
 */
export const MAX_PREFILTER_CANDIDATES = SAFE_IN_LIMIT;

/** 唯一实装的向量索引实现名。页面 / benchmark 都读它，避免"实际用的是什么"有两处说法。 */
export const VECTOR_INDEX_IMPL = 'brute-force';
/** 唯一实装的文本检索实现名。 */
export const TEXT_INDEX_IMPL = 'fts5-bigram';

/**
 * 创建向量索引。返回的对象**只暴露 `search(payload)`** —— 这是与 service.mjs 的契约。
 *
 * @param {{kind?:string}} [cfg]  `kind` 缺省为 `brute-force`；给别的值会抛错（见文件头诚实边界）。
 * @returns {{kind:string, search:(payload:object)=>object}}
 */
export function createVectorIndex(cfg = {}) {
  const kind = String((cfg && cfg.kind) || VECTOR_INDEX_IMPL);
  if (kind !== 'brute-force') {
    throw new Error(
      '未知的向量索引实现：' + kind + '（当前只实装 ' + VECTOR_INDEX_IMPL
      + '；ANN 需要新增一份实现并在这里注册，不要静默回退）');
  }
  // 目前是一种实现：直接暴露函数。将来加 ANN 时，这里按 kind 分支即可。
  return { kind, search: searchVector };
}

/**
 * 创建文本检索器。返回 `{kind, search(payload), ids(payload)}`，与向量侧接口对称。
 *
 * `ids(payload)` 是 B2 预过滤的专门入口：只取命中的 chunk id（不读正文），
 * 与 `search` **共用同一套 kbClause / SQL / 查询阶梯**（见 fts.mjs 的 runLadder），
 * 因此"候选来自哪些匹配规则"不可能与"文本结果来自哪些匹配规则"分裂成两套。
 *
 * @param {{kind?:string}} [cfg]
 * @returns {{kind:string, search:(payload:object)=>object, ids:(payload:object)=>object}}
 */
export function createTextIndex(cfg = {}) {
  const kind = String((cfg && cfg.kind) || TEXT_INDEX_IMPL);
  if (kind !== TEXT_INDEX_IMPL) {
    throw new Error('未知的文本检索实现：' + kind + '（当前只实装 ' + TEXT_INDEX_IMPL + '）');
  }
  return { kind, search: searchFts, ids: searchFtsIds };
}

/** 供状态页 / 自检汇报"当前检索用的是什么实现"（与代码同源，不另抄一份） */
export function retrieverInfo() {
  return {
    vectorIndex: VECTOR_INDEX_IMPL,
    textIndex: TEXT_INDEX_IMPL,
    note: '向量索引当前为精确暴力扫描（召回无损、成本随分块数线性增长）；'
      + '换 ANN 只在 retrievers/index.mjs 增实现，service 调用方不变。',
  };
}

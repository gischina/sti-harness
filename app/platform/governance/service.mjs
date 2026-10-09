/**
 * 治理与审计服务（M3）—— 把治理模块收口成一个依赖注入点。
 *
 * 为什么包一层：middleware / routes 只认 `deps.governance.xxx`，
 * 不直接 import 各模块 —— 与 identity / knowledge 的装配方式一致，
 * 测试时可以整体替换（test-governance 就是这么做到零第三方依赖自包含的）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import * as audit from './audit.mjs';
import * as usage from './usage.mjs';
import * as quotas from './quotas.mjs';
import * as artifacts from './artifacts.mjs';
import * as concurrency from './concurrency.mjs';
import * as cost from './cost.mjs';

export function createGovernanceService(deps = {}) {
  // 并发计数的观察者：把在途回合数报给 /metrics 的 `sti_active_turns` gauge。
  // 走注入而不是让 governance 直接 import observe —— 两个模块互不认识，
  // 装配层负责连线（与 identity/knowledge 的 resolveCredential 同一手法）。
  if (typeof deps.onConcurrentChange === 'function') concurrency.setObserver(deps.onConcurrentChange);

  // 成本核算（P1-3）需要一个"按租户取模型条目"的能力，而 governance **不认识** model 模块。
  // 同样走注入：装配层把 `model.listProviders` 接进来（与 resolveEmbedding 同款）。
  // 没注入时 `summarizeCost` 会拿到空 providers —— 结果里每条都是"未定价"（金额 null），
  // 这是**如实**的降级，不是"0 元"。宁可显示"不知道"，也不显示一个假的 0。
  const resolveProviders = typeof deps.resolveProviders === 'function' ? deps.resolveProviders : () => [];

  return {
    audit,
    usage,
    quotas,
    artifacts,
    concurrency,
    /** 成本核算绑定好依赖的实例（路由只认 `governance.cost.summary(...)`） */
    cost: {
      summarize: (p = {}) => cost.summarizeCost({ ...p, resolveProviders }),
      computeCost: cost.computeCost,
      buildCostReport: cost.buildCostReport,
      formatAmount: cost.formatAmount,
      TOKEN_CLASSES: cost.TOKEN_CLASSES,
    },
    /** 治理模块全部直接用同步 SQLite，没有后台资源需要释放；统一入口便于将来扩展 */
    close() { /* no-op */ },
  };
}

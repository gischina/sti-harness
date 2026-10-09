/**
 * 路由装配 —— 单一入口。
 *
 * 这里除了注册**已交付**的路由，还会把**已规划但未交付**的路由也登记进表，
 * 并让它们返回 501 + 明确的里程碑信息。理由：
 *   · 路由表是唯一真源，表里没有的东西就等于"这个产品不存在"；
 *   · 让 `/api/system/routes` 一眼看出"哪些接口还没做、什么时候做"，
 *     比一个 404 页面对使用者友好得多，也杜绝了"以为做了其实没做"。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { systemRoutes } from './system.mjs';
import { kernelRoutes } from './kernel.mjs';
import { identityRoutes } from './identity.mjs';
import { knowledgeRoutes } from './knowledge.mjs';
import { workspaceRoutes } from './workspace.mjs';
import { governanceRoutes } from './governance.mjs';
import { capabilityRoutes } from './capability.mjs';
import { modelRoutes } from './model.mjs';
import { operationRoutes } from './operation.mjs';
import { scheduleRoutes } from './schedule.mjs';
import { notifyRoutes } from './notify.mjs';
import { AppError } from '../../util/errors.mjs';

/**
 * 已规划、尚未交付的端点。M0~M5 全部交付后此表为空 —— 机制保留：
 * 未来任何新接口仍应先进这张表（501 + 里程碑），再转正。
 */
export const PLANNED_ROUTES = [
  // M1（身份与权限）已交付 —— 见 app/http/routes/identity.mjs。
  // M2（企业知识与检索）已交付 —— 见 app/http/routes/knowledge.mjs。
  // M3（治理与审计）已交付 —— 见 app/http/routes/governance.mjs。
  // M4（能力分发）已交付 —— 见 app/http/routes/capability.mjs。
  // M5（企业化收口）已交付 —— 见 app/http/routes/operation.mjs。备份的"恢复"
  //   刻意不做在线接口（诚实边界见 operation.mjs 顶部注释）。
];

export function registerRoutes(router, deps) {
  router.addAll(systemRoutes(deps));
  router.addAll(kernelRoutes(deps));
  router.addAll(identityRoutes(deps));
  router.addAll(knowledgeRoutes(deps));
  router.addAll(workspaceRoutes(deps));
  router.addAll(governanceRoutes(deps));
  router.addAll(capabilityRoutes(deps));
  router.addAll(modelRoutes(deps));
  router.addAll(operationRoutes(deps));
  router.addAll(scheduleRoutes(deps));
  router.addAll(notifyRoutes(deps));

  for (const p of PLANNED_ROUTES) {
    router.add({
      id: p.id,
      method: p.method,
      path: p.path,
      scope: p.scope,
      capability: p.capability || [],
      summary: p.summary,
      milestone: p.milestone,
      handler: () => {
        throw new AppError('not_implemented',
          `该接口尚未交付（计划在 ${p.milestone}）：${p.summary}。当前返回 501 是预期行为，不是故障。`, 501);
      },
    });
  }

  return router;
}

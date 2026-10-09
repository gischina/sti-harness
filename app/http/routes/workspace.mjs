/**
 * 工作区路由（0.21.0）—— 对话工作台树状组织层的 HTTP 面。
 *
 * 权限模型（0.21.6 起简化了一大块）：
 *   · 路由层只把**租户级**的门（`session:read` / `session:write`）；
 *   · "能不能动这个工作区"由 `workspace.assertWorkspaceAccess` 在服务层判 ——
 *     它现在只按**组织角色**推导档位（见 platform/workspace/visibility.mjs）；
 *   · **从前还有一条"不可见一律 404"**（受限工作区不确认存在性）。那条随可见性
 *     一起删了：工作区现在对全组织可见，404 在这里只剩"真的没有这个 id"一种含义。
 *
 * 0.21.6 删掉的三个端点（`GET/POST /api/workspaces/:id/grants`、
 * `DELETE /api/workspaces/:id/grants/:bindingId`）与 `visibility` 入参：
 *   **上游 dsh 自己有一份工作区权限三档**，平台这份是第二份真相，而平台没有接口
 *   去改上游那一份 —— 两边永远对不上。整块删除，理由详见迁移 0023 的头注释。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { readJsonBody } from '../context.mjs';
import { requireBody } from './_shared.mjs';
import { browseDirectories } from '../../platform/workspace/browse.mjs';

export function workspaceRoutes(deps) {
  const { workspace } = deps;
  if (!workspace) {
    throw new Error('工作区路由装配失败：deps.workspace 未提供');
  }

  const subjectOf = (ctx) => ({ userId: ctx.userId, roles: (ctx.user && ctx.user.roles) || [] });

  return [
    {
      id: 'workspace.tree',
      method: 'GET',
      path: '/api/workspaces',
      scope: 'session',
      capability: ['session:read'],
      summary: '工作区树数据（工作区 + 各自会话数 + 哪一个是兜底工作区）',
      milestone: '0.21.0',
      handler: (ctx) => {
        ctx.ok(workspace.listTree(ctx.tenantId));
      },
    },

    {
      id: 'workspace.browse',
      method: 'GET',
      path: '/api/workspaces/browse',
      scope: 'session',
      capability: ['session:write'],
      summary: '列出一个目录下的子目录（「新建工作区」弹框里的文件夹选择器；只读、只列目录）',
      milestone: '0.21.7',
      handler: (ctx) => {
        // ⚠️ 门槛与 `workspace.create` 一致（都是 `session:write`）：能建工作区的人本来就能把
        //    cwd 填成服务器上任意一处 —— 本接口只把"盲填路径"变成"看得见地选"，
        //    不增加任何能力。理由与安全边界见 platform/workspace/browse.mjs 头注释。
        ctx.ok(browseDirectories(ctx.query.path));
      },
    },

    {
      id: 'workspace.create',
      method: 'POST',
      path: '/api/workspaces',
      scope: 'session',
      capability: ['session:write'],
      summary: '新建工作区（纯组织容器：把会话分堆放）',
      milestone: '0.21.0',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        requireBody({
          name: { required: true, maxLen: 120, label: '工作区名称' },
          cwd: { maxLen: 512, label: '工作目录' },
          description: { maxLen: 500, label: '说明' },
        }, body);
        const row = workspace.createWorkspace({
          tenantId: ctx.tenantId,
          subject: subjectOf(ctx),
          name: body.name,
          cwd: body.cwd,
          description: body.description,
        });
        ctx.json(201, {
          ok: true,
          workspace: {
            id: row.id, name: row.name, cwd: row.cwd, description: row.description,
            ownerUserId: row.owner_user_id,
            createdAt: row.created_at, updatedAt: row.updated_at,
          },
        });
      },
    },

    {
      id: 'workspace.update',
      method: 'PATCH',
      path: '/api/workspaces/:id',
      scope: 'session',
      capability: ['session:read'],
      summary: '改工作区（名称 / 工作目录 / 说明；需完全权限 —— 档位在服务层按组织角色判。兜底工作区禁改名）',
      milestone: '0.21.0',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const row = workspace.updateWorkspace({
          tenantId: ctx.tenantId, workspaceId: ctx.params.id,
          subject: subjectOf(ctx), patch: body,
        });
        ctx.ok({
          ok: true,
          workspace: {
            id: row.id, name: row.name, cwd: row.cwd, description: row.description,
            updatedAt: row.updated_at,
          },
        });
      },
    },

    {
      id: 'workspace.delete',
      method: 'DELETE',
      path: '/api/workspaces/:id',
      scope: 'session',
      capability: ['session:read'],
      summary: '删除工作区（需完全权限；会话不级联 —— 改挂到默认工作区。兜底工作区本身不能删）',
      milestone: '0.21.0',
      handler: (ctx) => {
        const r = workspace.deleteWorkspace({
          tenantId: ctx.tenantId, workspaceId: ctx.params.id, subject: subjectOf(ctx),
        });
        ctx.ok({
          ok: true, ...r,
          note: '会话已全部移入「' + r.toWorkspaceName + '」，本体未删除。',
        });
      },
    },
  ];
}

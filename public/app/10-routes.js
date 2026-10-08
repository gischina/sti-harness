/* STI HARNESS 前端
 * Copyright 2026 liwei（易智瑞西安）.
 *
 * 纪律（继承前身项目的经验）：
 *  1. ROUTES 单点定义 —— 顶栏/导航/标题/权限要求全部由它推导，改名不会四处漂移；
 *  2. 诚实数据源 —— 每个数字都来自真实接口；取不到就显示空态并说明原因；
 *  3. 服务端返回什么就显示什么，前端不做"乐观补全"；
 *  4. **鉴权只在服务端做**。这里按 /api/identity/me 返回的权限矩阵决定"显不显示入口"，
 *     只是为了少让人点进去撞 403 —— 真正的拦截在 rbac 中间件，前端藏起来不等于安全。
 */

/* STI HARNESS 前端 · 路由表（唯一真源）
 * Copyright 2026 liwei（易智瑞西安）.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';

/* ── 路由表：唯一真源 ──────────────────────────────────── */
//
// ⚠️ 第一项就是**登录后的落地页**（见 defaultRoute()）。因此工作台排在首位：
//    最终用户（提问的人）打开就该看到一个对话框，而不是一张路由清单。
//    管理后台的页面全部保留在后面，"工作台"与"后台"并存。
//
// ⚠️ 分组纪律（0.15.2 重整，0.15.6 定序）：组名按**使用者视角**命名，顺序即侧栏顺序 ——
//    0.15.6 起定为「工作台 → 概览 → 知识 → 能力 → 治理 → 平台 → 身份 → 开发者」：
//    日常使用在上（对话 / 概览 / 知识），平台自身管理居中（能力 / 治理 / 平台运维），
//    身份与深度自省在下；开发者组收拢全部自省工具。
//    同类自省页（契约 / 接口清单 / 中间件）必须同组，否则它们会散落在其它组里，
//    找"平台自己长什么样"要跨组翻。
const ROUTES = [
  { id: 'workbench', group: '工作台', title: '对话工作台', sub: '像用聊天工具一样提问；事件流式到达，工具调用与用量实时可见', hash: '#/workbench', need: ['session', 'read'] },
  { id: 'overview', group: '概览', title: '平台概览', sub: '这台机器上到底装了什么、什么没装；系统明细在页底折叠区', hash: '#/overview' },
  { id: 'knowledge', group: '知识', title: '知识库与检索', sub: '导入文档、分块预览、混合检索与引用溯源', hash: '#/knowledge', need: ['knowledge', 'read'] },
  // ⚠️ 能力清单与可见性治理的 sub 里**不再出现"工具"**（0.21.10）：工具不是可登记的能力，
  //    它由内核自己调用、只在会话事件流里以「工具卡」的形式出现，没有清单、也没有独立开关。
  //    页面确实还列 MCP / 插件，但它们各有自己的来源，不挂在"工具"这个名目下。
  { id: 'capabilities', group: '能力', title: '能力清单', sub: 'Skill / MCP：登记与内核双来源；启停立即生效', hash: '#/capabilities', need: ['skill', 'read'] },
  { id: 'capSources', group: '能力', title: '来源与导入导出', sub: '按来源分组；脱敏导出可导入另一套部署', hash: '#/capSources', need: ['capability', 'read'] },
  { id: 'capPolicies', group: '能力', title: '可见性治理', sub: '二级 allow/deny（连接/服务）；deny 永远赢', hash: '#/capPolicies', need: ['capability', 'read'] },
  { id: 'audit', group: '治理', title: '审计日志', sub: '哈希链防篡改；可校验并定位首个断裂点', hash: '#/audit', need: ['audit', 'read'] },
  { id: 'quotas', group: '治理', title: '配额与用量', sub: '先检后放行；用量数字全部来自真实 usage 事件', hash: '#/quotas', need: ['quota', 'read'] },
  { id: 'sessionlogs', group: '治理', title: '会话日志', sub: '按会话下载全量轨迹 ZIP（事件流 + 产物清单）；是快照不是备份，下载会记审计', hash: '#/sessionlogs', need: ['artifact', 'read'] },
  { id: 'models', group: '平台', title: '模型中心', sub: '登记模型服务、设默认与降级链；探活会真发一次最小请求', hash: '#/models', need: ['model', 'read'] },
  { id: 'schedules', group: '平台', title: '调度中心', sub: '按时间自动跑的任务：审计归档/锚定、定期备份、探活巡检', hash: '#/schedules', need: ['schedule', 'read'] },
  { id: 'notify', group: '平台', title: '通知渠道', sub: '异常主动出站告知：配额拦截、备份失败、探活失败', hash: '#/notify', need: ['notify', 'read'] },
  { id: 'backup', group: '平台', title: '备份与恢复', sub: '在线创建一致性备份、校验备份文件；恢复是离线动作', hash: '#/backup', need: ['operation', 'read'] },
  { id: 'settings', group: '平台', title: '平台设置', sub: '监听 / 会话 / 知识检索等运行参数：页面写 config.json，重启生效', hash: '#/settings', need: ['system', 'read'] },
  { id: 'users', group: '身份', title: '账号管理', sub: '组织内的账号、角色绑定与启停', hash: '#/users', need: ['user', 'read'] },
  { id: 'groups', group: '身份', title: '用户组', sub: '组是角色绑定的第二种主体；组上的角色对全部成员生效', hash: '#/groups', need: ['group', 'read'] },
  { id: 'roles', group: '身份', title: '角色与权限', sub: '内置角色 × 资源 × 动作的完整矩阵', hash: '#/roles', need: ['role', 'read'] },
  { id: 'creds', group: '身份', title: '凭据托管', sub: '加密落库；接口永不回显明文，也不回显密文', hash: '#/creds', need: ['credential', 'read'] },
  { id: 'me', group: '身份', title: '我的账号', sub: '我的角色、我的权限、我的 API Key', hash: '#/me' },
  { id: 'contract', group: '开发者', title: '契约与映射', sub: '契约方法、事件映射覆盖率（含未核实项）', hash: '#/contract' },
  { id: 'routes', group: '开发者', title: '接口清单', sub: '路由表直接读自代码，逐行可查', hash: '#/routes' },
  { id: 'middleware', group: '开发者', title: '中间件', sub: '哪些已实装、哪些还没实装（还没实装的不做拦截）', hash: '#/middleware' },
];

/**
 * 尚未交付的能力。
 *
 * ⚠️ 这里是**空表**：M0~M5 五个里程碑已全部交付，路由表里没有任何 501 占位。
 * 保留这个常量（而不是删掉）是为了让"未交付清单"始终有一个显式出口 ——
 * 下一轮真要加待办时，加在这里即可重新出现在侧栏与概览页，而不是散落在各处。
 */
const PLANNED = [];

const RESOURCE_LABEL = {
  org: '组织', department: '部门', group: '用户组', user: '账号', role: '角色', credential: '凭据',
  apikey: 'API Key', session: '会话', artifact: '产物与会话日志', knowledge: '知识库', audit: '审计', quota: '配额',
  // ⚠️ 这里曾有一条 `tool: '工具'`（0.21.10 删除）：能力可见性只剩连接 / 服务两级，
  //    再留一个永远不会有实体映射过来的标签，只会在权限矩阵里凭空多出一行。
  capability: '能力可见性', skill: 'Skill', mcp: 'MCP 服务', system: '平台设置',
  operation: '运维', model: '模型中心', schedule: '调度中心', notify: '通知渠道',
};
const ACTION_LABEL = { read: '查看', write: '修改', delete: '删除', execute: '执行' };

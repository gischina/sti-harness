/**
 * 声明式权限表 —— 纯函数，无副作用、不碰数据库。
 *
 * 为什么单独抽出来（而不是散在各 handler 里 if/else）：
 *   · 权限判定必须能被**穷举测试**（M1 验收标准 1：正例 + 反例全覆盖）；
 *   · 权限矩阵要能直接给前端渲染成表格，文档与代码不会漂移；
 *   · 判定结果要能被审计记下来（`explain()` 给出"凭哪个角色放行的"）。
 *
 * 判定语义（**这套规则本身很重要，改动等于改安全边界**）：
 *   1. **具体资源优先**：`grants[resource]` 存在就用它，否则回落到 `grants['*']`（默认档）。
 *      —— 所以 `admin` 的 `'*'` 给 `read/write/execute`，再用 `org: ['read']` **收窄**组织权限，
 *         而不会因为通配符把 `org` 也放大。
 *   2. 动作列表里出现 `'*'` 表示该资源全权。
 *   3. **未知角色一律拒绝**（`can()` 返回 false）—— 宁可拒绝也不默认放行。
 *      这一点必须保持：数据库里若出现一个拼错的角色 key，不能因此变成"人人有份"。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

/** 资源清单。与路由的 `capability` 对应，改这里要同步检查路由表。 */
export const RESOURCES = [
  'org',          // 组织本身（改名、删除、转移所有权）—— **预留**：当前没有任何路由用到它
  'department',   // 部门（**组织归属，不是权限载体**：挂在哪个部门不改变任何判定，判定只看 role_bindings）
  'group',        // 用户组（角色绑定的主体之一）
  'user',         // 账号
  'role',         // 角色与绑定
  'credential',   // 模型/服务凭据
  'model',        // 模型中心（注册表 / 默认模型 / 降级链）—— P1-1
  'apikey',       // 集成用的长期令牌
  'session',      // Agent 会话
  // 会话产物与会话日志导出包（工作台产物面板按会话列产物；治理 → 会话日志按会话导出 log.zip）。
  // 这两个接口的 capability 写的是 `artifact:read` —— 声明在这里，矩阵里才有这一行可判；
  // 漏了它 `allowed('artifact','read')` 恒 false，产物面板与日志页会静默变成死代码。
  'artifact',
  'knowledge',    // 知识库与文档
  'audit',        // 审计日志
  'quota',        // 配额
  'capability',   // 能力可见性治理
  'skill',        // Skill
  'tool',         // 工具
  'mcp',          // MCP 服务
  'operation',    // 运维动作（备份/校验 —— M5）
  'schedule',     // 定时任务（P1-2）
  'notify',       // 出站通知渠道（P1-2）
  'system',       // 平台设置/自检/路由表/指标
];

export const ACTIONS = ['read', 'write', 'delete', 'execute'];

/**
 * 角色定义。`grants` 是「资源 → 允许的动作」。
 * `'*'` 键是**默认档**（该资源没有单独声明时用它）；动作里的 `'*'` 表示全权。
 *
 * 为什么 owner 拿 `'*': ['*']` 而 admin 不是：组织所有者需要能删组织、转移所有权，
 * 这类"把平台交给别人/毁掉"的动作不该给到普通管理员。
 */
export const ROLE_MATRIX = {
  owner: {
    name: '所有者',
    description: '组织全权，含删除组织与转移所有权。每个组织至少一个。',
    builtin: true,
    grants: { '*': ['*'] },
  },
  admin: {
    name: '管理员',
    description: '管人、管凭据、管能力、看审计；不能删除或转让组织本身。',
    builtin: true,
    grants: {
      '*': ['read', 'write', 'execute'],
      // 会话：显式给 delete（0021 起）。此前管理员经 '*' 回落只有 read/write/execute；
      // session:delete 目前**没有任何路由**把它当 capability（删会话仍是 session:write），
      // 它的第一语义是**工作区档位里的"完全权限"标记** —— 档位从会话能力推导
      // （见 platform/workspace/visibility.mjs 的 levelFromRoles），而"完全权限"
      // 正是"能管别人的会话"那一档（自己的会话 write 档就够）。少了它，
      // 管理员会在自己的组织里管不动别人建的会话。
      //
      // 0.21.6：它仍是档位的**唯一**来源 —— 工作区级授权（role_bindings 的
      // scope_type='workspace' 绑定）已随工作区权限模块一起删除，见迁移 0023。
      session: ['read', 'write', 'execute', 'delete'],
      org: ['read'],
      role: ['read', 'write'],
      // 账号：与"组"同一条理由 —— 删除账号是不可逆动作（会真删人与他的会话/凭据/绑定），
      // 默认档 '*' 只给 read/write/execute，所以删除权必须在这里**显式**声明。
      user: ['read', 'write', 'delete'],
      // 组是**权限载体**：删组会连带撤掉它承载的全部角色绑定。
      // 默认档 '*' 不含 delete，所以这里必须显式声明 —— 不能靠通配符"顺带"给出删除权。
      group: ['read', 'write', 'delete'],
      // 部门：**组织归属，不是权限载体**（把谁挪进哪个部门不会给他任何权限）。
      // 但 delete 单独给它：删除部门会同时改变"组织视图"本身，是管理员动作而非所有者专属
      // —— 与删账号（user:delete）同理，属不可逆动作，必须在默认档之外**显式**声明。
      // 实现侧有引用护栏：有成员 / 有子部门的部门会被拒绝删除并给出人话理由
      // （见 identity/service.mjs 的 deleteDepartment）。
      department: ['read', 'write', 'delete'],
      credential: ['read', 'write', 'delete'],
      // 模型中心：登记模型服务、设默认、跑探活（探活会出网并产生少量用量，属"写"动作）。
      model: ['read', 'write', 'delete'],
      audit: ['read'],
      quota: ['read', 'write'],
      capability: ['read', 'write', 'delete'],
      // 运维动作：delete 是 0.18.0 备份面板「删除备份文件」带来的 —— 删备份是**不可逆**动作，
      // 与 user/group/department 同一条纪律：默认档 '*' 不含 delete，必须在这里**显式**声明，
      // 不能靠通配符"顺带"给出（盘面上的动作会记审计 `operation.backup.remove`，含文件名与释放字节数）。
      // 谁不该有：member/viewer 本就没授 operation（回落空数组 → 一律拒绝），不受本改动影响。
      operation: ['read', 'write', 'delete'],
      // 定时任务能触发备份/归档等有副作用的动作，因此 delete（删任务）与 write 都只给管理员。
      schedule: ['read', 'write', 'delete'],
      // 通知渠道的 URL 里常内嵌 token —— 改它等于改密钥的可达范围，因此收紧到管理员。
      notify: ['read', 'write', 'delete'],
      /**
       * 平台设置：`write` 是 P0「内核接入向导」带来的 —— 它允许在页面上
       * **检测**任意地址（服务端会主动去连，SSRF 形状）并**改写**平台连到哪台内核。
       *
       * 为什么给管理员而不是只给所有者：接入内核是**运维动作**，而管理员在这个
       * 平台里就是运维角色（他已经能读写 `credential`，那里面存着权限级别相当的密钥）。
       * 只给所有者会让"运维接手部署"这件事卡住 —— 而卡住的结果通常是把权限
       * 到处乱发，比一开始就明确给管理员更糟。
       *
       * 两个动作都记审计（`kernel.probe` / `kernel.config`，含目标地址），
       * 因此"谁试过连哪儿"是事后可查的 —— 这是把它给到管理员的前提。
       */
      system: ['read', 'write'],
    },
  },
  member: {
    name: '成员',
    description: '日常使用：跑 Agent、查知识库、用已授权的 Skill / 工具；可管理自己的 API Key。',
    builtin: true,
    grants: {
      session: ['read', 'write', 'execute'],
      knowledge: ['read'],
      capability: ['read'],
      skill: ['read', 'execute'],
      tool: ['read'],
      mcp: ['read'],
      model: ['read'],
      apikey: ['read', 'write', 'delete'],
      user: ['read'],
      department: ['read'],
      group: ['read'],
      org: ['read'],
      system: ['read'],
    },
  },
  viewer: {
    name: '只读访客',
    description: '只能看，不能改也不能执行（适合审计、观摩账号）。',
    builtin: true,
    grants: {
      session: ['read'],
      knowledge: ['read'],
      capability: ['read'],
      skill: ['read'],
      tool: ['read'],
      mcp: ['read'],
      model: ['read'],
      user: ['read'],
      department: ['read'],
      group: ['read'],
      org: ['read'],
      system: ['read'],
    },
  },
};

export const ROLE_KEYS = Object.keys(ROLE_MATRIX);

/** 角色 key 是否已知 */
export function knownRole(key) {
  return Object.prototype.hasOwnProperty.call(ROLE_MATRIX, String(key));
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 取某角色对某资源实际生效的动作列表（具体资源优先，否则用默认档 `'*'`） */
function effectiveActions(roleKey, resource) {
  const role = ROLE_MATRIX[roleKey];
  if (!role) return null;
  const g = role.grants || {};
  const has = Object.prototype.hasOwnProperty.call(g, resource);
  return has ? g[resource] : (g['*'] || []);
}

/**
 * 权限判定的**唯一入口**。
 * @param {string|string[]} roles 角色 key（可多个，取并集）
 * @param {string} resource 资源名
 * @param {string} action 动作名
 * @returns {boolean}
 */
export function can(roles, resource, action) {
  const res = String(resource || '').toLowerCase();
  const act = String(action || '').toLowerCase();
  if (!res || !act) return false;
  for (const rk of asArray(roles)) {
    const acts = effectiveActions(String(rk), res);
    if (!acts) continue;                                  // 未知角色：跳过（不默认允许）
    if (acts.includes('*') || acts.includes(act)) return true;
  }
  return false;
}

/**
 * 与 `can()` 同源，但给出**为什么**。审计要记"凭哪个角色放行的"，
 * 出问题时这条信息比一个 true/false 有用得多。
 * @returns {{allowed:boolean, by:string|null, actions:string[]}}
 */
export function explain(roles, resource, action) {
  const res = String(resource || '').toLowerCase();
  const act = String(action || '').toLowerCase();
  const checked = [];
  for (const rk of asArray(roles)) {
    const key = String(rk);
    const acts = effectiveActions(key, res);
    if (!acts) { checked.push({ role: key, actions: null, note: '未知角色，已忽略' }); continue; }
    checked.push({ role: key, actions: acts.slice(), note: null });
    if (acts.includes('*') || acts.includes(act)) {
      return { allowed: true, by: key, actions: acts.slice(), checked };
    }
  }
  return { allowed: false, by: null, actions: [], checked };
}

/** 单个角色的完整权限矩阵（前端"角色管理"页直接用） */
export function matrixFor(roles) {
  const keys = asArray(roles).map(String);
  const out = {};
  for (const res of RESOURCES) {
    out[res] = {};
    for (const act of ACTIONS) out[res][act] = can(keys, res, act);
  }
  return out;
}

/** 全部角色的权限矩阵（文档与前端角色页共用，避免文档与代码漂移） */
export function fullMatrix() {
  const out = {};
  for (const key of ROLE_KEYS) out[key] = { name: ROLE_MATRIX[key].name, description: ROLE_MATRIX[key].description, matrix: matrixFor([key]) };
  return out;
}

/** 机器可读描述（状态页/自检用） */
export function describePermissions() {
  return {
    resources: RESOURCES.slice(),
    actions: ACTIONS.slice(),
    roles: ROLE_KEYS.map((k) => ({ key: k, name: ROLE_MATRIX[k].name, builtin: !!ROLE_MATRIX[k].builtin })),
    rules: '具体资源优先于默认档 "*"；动作 "*" 表示全权；未知角色一律拒绝。',
  };
}

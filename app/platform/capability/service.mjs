/**
 * 能力仓储与服务 —— skills / mcp_servers / capability_bindings 的平台侧真相源。
 *
 * ⚠️ 0.21.10：**`tools` 不再在这个列表里**（登记表整表删除）。理由见下面
 *    "Tools：整块删除" 那一段与 `0025_drop_tools.sql`。一句话：
 *    工具由内核自己调用、上游没有工具清单 RPC，所以它没有可登记的对象。
 *
 * 职责与边界（与内核层的关系）：
 *   · 内核 provider 也会报清单（`listSkills/listMcpServers`）—— 那是
 *     "本机现在实际有什么"；本模块是"企业登记了什么、允不允许用"。
 *     两侧都在响应里如实标注来源，不混为一谈。
 *   · 启停/可见性必须**不重启进程**立即生效 —— 因此所有判定函数都是「每次现查库」，
 *     不做进程内缓存。查库开销对清单接口可以忽略（工具数是几十的量级）。
 *   · 健康探测是**真实探测**：http/sse 做 TCP 连接尝试，stdio 检查命令可执行性；
 *     探不了就如实说探不了 —— health 停在 unknown 并写明原因，绝不假装 ok。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { run, get, all } from '../../data/db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';
import { BINDING_LEVELS, bindingsForSubject, decideMcpVisibility, decideSkillVisibility } from './visibility.mjs';

const VALID_TRANSPORTS = ['stdio', 'sse', 'http'];
const PROBE_TIMEOUT_MS = 2000;

/* ── Skills ─────────────────────────────────────────────── */

export function listSkills(tenantId) {
  return all('SELECT * FROM skills WHERE tenant_id = ? ORDER BY installed_at DESC', [tenantId]);
}

export function getSkill(tenantId, name) {
  return get('SELECT * FROM skills WHERE tenant_id = ? AND name = ?', [tenantId, name]);
}

/** 登记一个 Skill（安装流程的最后一步 —— 文件落位成功才调这里，失败即回滚见 installSkill）。 */
export function registerSkill(tenantId, { name, source = 'local', version = '', path = '', enabled = 1, modelInvocable = 1, meta = {} }) {
  if (!name || typeof name !== 'string') throw new Error('skill.name 必填');
  const row = {
    id: newId('skill'), tenant_id: tenantId, name, source, version, path,
    enabled: enabled ? 1 : 0, model_invocable: modelInvocable ? 1 : 0,
    installed_at: nowIso(), meta_json: JSON.stringify(meta || {}),
  };
  run(
    `INSERT INTO skills (id, tenant_id, name, source, version, path, enabled, model_invocable, installed_at, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       source = excluded.source, version = excluded.version, path = excluded.path,
       enabled = excluded.enabled, meta_json = excluded.meta_json`,
    [row.id, row.tenant_id, row.name, row.source, row.version, row.path, row.enabled, row.model_invocable, row.installed_at, row.meta_json],
  );
  return getSkill(tenantId, name);
}

/** 安装失败时抹掉登记行（不落半成品的回滚半边）。 */
export function unregisterSkill(tenantId, name) {
  run('DELETE FROM skills WHERE tenant_id = ? AND name = ?', [tenantId, name]);
}

export function setSkillEnabled(tenantId, name, enabled) {
  const r = run('UPDATE skills SET enabled = ? WHERE tenant_id = ? AND name = ?', [enabled ? 1 : 0, tenantId, name]);
  return r.changes > 0;
}

/* ── Tools：整块删除（0.21.10）──────────────────────────────
 *
 * 这里从前有 `listTools` / `getTool` / `upsertTool` / `setToolEnabled` 四个仓储函数，
 * 读写 `tools` 登记表（字段 name / origin / enabled / policy_json / meta_json）。
 *
 * 删掉的理由（用户裁定 2026-10-08）：「工具是在内核自己调用，不用单独写这个能力，
 * 而且不会单独列出来有哪些工具」。三条事实见 `0025_drop_tools.sql` 头注释：
 * 平台侧没有工具执行路径、上游没有工具清单 RPC（候选探测全部 404）、
 * 因此"有哪些工具"这个问题本身不存在。
 *
 * ⚠️ 与 Skill 的分界（这是本次删除的判据，不是"工具不重要"）：
 *   **Skill 是平台可治理的能力** —— 有安装流程、有文件落位、有登记表、能逐个启停；
 *   **工具不是** —— 它由内核自己调用，没有独立的存在形式可登记。
 *   把"事件流里出现过的东西"当成"可以登记的东西"是这里原本的错。
 * ⚠️ 保留的是**事件流事实**：某轮真的调过什么活在 `events` 表的
 *   `tool-call` / `tool-result` 事件里，与登记表无关 —— 所以工具卡照常显示，
 *   删掉的只是"拿它去和登记表对账"。
 */

/* ── MCP servers ────────────────────────────────────────── */

export function listMcpServers(tenantId) {
  return all('SELECT * FROM mcp_servers WHERE tenant_id = ? ORDER BY name', [tenantId]);
}

/**
 * **跨全部租户**读 MCP 登记表 —— 给契约层 `listMcpServers` 的**保守并集**那一档用。
 *
 * 为什么需要跨租户：契约层不带 `tenantId` 时语义就是保守并集（任一租户 deny 即剔除），
 * 它要看到的是**全部候选**，再逐个问"有没有哪个租户把它 deny 了"。
 * 拿单个租户的清单去过滤会**掩盖**别的租户的 deny —— 表现为"改了半天不生效"。
 *
 * ⚠️ 这不是越权出口：它只被 `compose/kernel.mjs` 的 provider 装配调用，用来构造
 *    契约层清单；HTTP 侧一律走上面带 `tenantId` 的那一个。真实用户的清单请求
 *    永远拿不到别的租户的行 —— 这一条由 `audit-tenant-isolation.mjs` 兜底扫描。
 */
export function listMcpServersAcrossTenants() {
  return all('SELECT * FROM mcp_servers ORDER BY name');
}

export function getMcpServer(tenantId, name) {
  return get('SELECT * FROM mcp_servers WHERE tenant_id = ? AND name = ?', [tenantId, name]);
}

export function registerMcpServer(tenantId, { name, transport = 'stdio', configCipher = '', enabled = 1 }) {
  if (!name || typeof name !== 'string') throw new Error('mcp.name 必填');
  if (!VALID_TRANSPORTS.includes(transport)) throw new Error(`transport 只支持 ${VALID_TRANSPORTS.join('/')}，收到：${transport}`);
  run(
    `INSERT INTO mcp_servers (id, tenant_id, name, transport, config_cipher, enabled, health, health_detail, health_at)
     VALUES (?, ?, ?, ?, ?, ?, 'unknown', '', '')
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       transport = excluded.transport, config_cipher = excluded.config_cipher, enabled = excluded.enabled`,
    [newId('mcp'), tenantId, name, transport, configCipher, enabled ? 1 : 0],
  );
  return getMcpServer(tenantId, name);
}

export function setMcpEnabled(tenantId, name, enabled) {
  const r = run('UPDATE mcp_servers SET enabled = ? WHERE tenant_id = ? AND name = ?', [enabled ? 1 : 0, tenantId, name]);
  return r.changes > 0;
}

export function removeMcpServer(tenantId, name) {
  const r = run('DELETE FROM mcp_servers WHERE tenant_id = ? AND name = ?', [tenantId, name]);
  return r.changes > 0;
}

/** 探测结果落库（health + 详情 + 时间）。 */
function saveHealth(tenantId, name, health, detail) {
  run('UPDATE mcp_servers SET health = ?, health_detail = ?, health_at = ? WHERE tenant_id = ? AND name = ?',
    [health, String(detail || '').slice(0, 500), nowIso(), tenantId, name]);
}

/**
 * TCP 连接探测（http / sse）。真连接，不是 ping 假装 —— 端口通不通 2 秒内见分晓。
 */
function probeTcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok, detail) => { try { socket.destroy(); } catch { /* 已断开 */ } resolve({ ok, detail }); };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on('connect', () => done(true, `TCP ${host}:${port} 可达`));
    socket.on('timeout', () => done(false, `TCP ${host}:${port} 连接超时（${PROBE_TIMEOUT_MS}ms）`));
    socket.on('error', (e) => done(false, `TCP ${host}:${port} 连接失败：${e.message}`));
  });
}

/**
 * 健康探测 —— 真实探测，失败如实标注。
 *
 * @param {object} row  mcp_servers 表行
 * @param {(cipher: string) => string|null} decrypt  解密回调（密钥不进本模块，
 *   由装配层注入 —— 与 main.mjs 给内核注入凭据解密是同一模式）
 * @returns {{name, transport, health, detail, probedAt}}
 */
export async function probeMcpServer(row, decrypt) {
  const finish = (health, detail) => {
    saveHealth(row.tenant_id, row.name, health, detail);
    return { name: row.name, transport: row.transport, health, detail, probedAt: nowIso() };
  };

  if (!row.enabled) {
    return finish('unknown', '服务已停用，未探测（停用状态探测会产生误导性的失败记录）');
  }

  let config = {};
  if (row.config_cipher) {
    try {
      const plain = decrypt ? decrypt(row.config_cipher) : null;
      if (plain == null) return finish('unknown', '配置已加密存储但装配层未提供解密能力，无法取连接参数 —— 如实不探');
      config = JSON.parse(plain);
    } catch (e) {
      return finish('error', '配置解密/解析失败（密钥不匹配或配置损坏）：' + e.message);
    }
  }

  if (row.transport === 'http' || row.transport === 'sse') {
    const url = config.url || '';
    let host = config.host, port = config.port;
    if (!host && url) {
      try { const u = new URL(url); host = u.hostname; port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); }
      catch { return finish('error', 'config.url 无法解析：' + url); }
    }
    if (!host || !port) return finish('unknown', '配置里没有 host/port 或 url，无从探测 —— 请补全连接配置');
    const r = await probeTcp(host, port);
    return finish(r.ok ? 'ok' : 'error', r.detail);
  }

  // stdio：命令在本机是否可执行。只验证「文件在不在、能不能执行」，
  // 不真的拉起子进程 —— 探测不应产生副作用（MCP 会话是内核的职责）。
  const command = config.command || '';
  if (!command) return finish('unknown', 'stdio 服务未配置 command，无从验证');
  const candidates = process.platform === 'win32' && !/\.(exe|cmd|bat|ps1)$/i.test(command)
    ? [command, command + '.exe', command + '.cmd', command + '.bat']
    : [command];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { fs.accessSync(c, fs.constants.X_OK); return finish('ok', `命令存在且可执行：${c}`); }
      catch { return finish('error', `命令存在但不可执行：${c}`); }
    }
    // PATH 查找（相对命令名）
    for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
      if (!dir) continue;
      const p = dir + (dir.endsWith('/') || dir.endsWith('\\') ? '' : process.platform === 'win32' ? '\\' : '/') + c;
      if (fs.existsSync(p)) {
        try { fs.accessSync(p, fs.constants.X_OK); return finish('ok', `PATH 中找到且可执行：${p}`); }
        catch { return finish('error', `PATH 中找到但不可执行：${p}`); }
      }
    }
  }
  return finish('error', `命令未找到：${command}（本机 PATH 中不存在）—— 服务注册了但环境不具备`);
}

/* ── Capability bindings（三级 allow/deny） ─────────────── */

export function listBindings(tenantId) {
  return all('SELECT * FROM capability_bindings WHERE tenant_id = ? ORDER BY subject_type, capability_type, capability_id', [tenantId]);
}

/**
 * upsert 一条绑定：同（subject, capability）只留一条，重复设置即覆盖 allow 值。
 *
 * 为什么先查后写而不是 INSERT OR REPLACE：表上只有 id 主键，业务键
 * （tenant + subject + capability）没有唯一约束（0001 迁移的历史决定，迁移只增不改，
 * 不回头补索引），INSERT 系的 upsert 语法都帮不上忙。读改写竞争在单写者模型下
 * 串行化（docs/architecture.md §7.4），安全。
 *
 * @returns {object} 最终生效的绑定行
 */
export function setBinding(tenantId, { subjectType = 'tenant', subjectId, capabilityType, capabilityId, allow }) {
  if (!['tenant', 'user', 'role'].includes(subjectType)) throw new Error(`subject_type 只支持 tenant/user/role，收到：${subjectType}`);
  if (!BINDING_LEVELS.includes(capabilityType)) throw new Error(`capability_type 只支持 ${BINDING_LEVELS.join('/')}，收到：${capabilityType}`);
  if (!capabilityId || typeof capabilityId !== 'string') throw new Error('capability_id 必填');
  if (allow !== 0 && allow !== 1) throw new Error('allow 必须是 0（deny）或 1（allow）');
  if (subjectType !== 'tenant' && !subjectId) throw new Error('user/role 级绑定必须给 subject_id');
  // tenant 级绑定的主体就是租户本身 —— subjectId 不传时落租户 id，不能存空串
  //（空串会让 bindingsForSubject 的 subject_id === tenantId 匹配不上，per-tenant 判定
  // 就看不到这条绑定 —— 保守并集看不见这个问题，带租户的精确判定会立刻暴露）。
  if (subjectType === 'tenant' && !subjectId) subjectId = tenantId;

  const existing = get(
    'SELECT id FROM capability_bindings WHERE tenant_id = ? AND subject_type = ? AND subject_id = ? AND capability_type = ? AND capability_id = ?',
    [tenantId, subjectType, subjectId ?? '', capabilityType, capabilityId],
  );
  if (existing) {
    run('UPDATE capability_bindings SET allow = ? WHERE tenant_id = ? AND id = ?', [allow, tenantId, existing.id]);
    return get('SELECT * FROM capability_bindings WHERE tenant_id = ? AND id = ?', [tenantId, existing.id]);
  }
  const id = newId('bind');
  run(
    'INSERT INTO capability_bindings (id, tenant_id, subject_type, subject_id, capability_type, capability_id, allow) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, tenantId, subjectType, subjectId ?? '', capabilityType, capabilityId, allow],
  );
  return get('SELECT * FROM capability_bindings WHERE tenant_id = ? AND id = ?', [tenantId, id]);
}

export function removeBinding(tenantId, id) {
  const r = run('DELETE FROM capability_bindings WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  return r.changes > 0;
}

/**
 * 按行 id 翻转 allow/deny（0.16.0）。
 *
 * 为什么有 upsert 的 setBinding 还要这一条：列表页的行只有 id，要"把这条
 * deny 改成 allow"得靠人肉重新拼四个业务键 —— 界面上多一步就多一次出错；
 * 且 allow 只认 0/1 两个值，与 mcp 的 enabled 一样**只收布尔**，
 * "看起来像假值"的 0 / 'false' 一律拒绝（静默按真值处理是查不出来的坑）。
 * @returns {object|null} 更新后的行；id 不存在（或跨租户）时为 null
 */
export function setBindingAllow(tenantId, id, allow) {
  if (allow !== 0 && allow !== 1) throw new Error('allow 必须是 0（deny）或 1（allow）');
  run('UPDATE capability_bindings SET allow = ? WHERE tenant_id = ? AND id = ?', [allow, tenantId, id]);
  return get('SELECT * FROM capability_bindings WHERE tenant_id = ? AND id = ?', [tenantId, id]);
}

/**
 * 把安装目录打回 ZIP（导入导出用：导出端重打包，导入端解压安装）。
 * 返回 zipSync 可用的 entries 形状（name + data），由调用方压缩。
 */
export function packSkillDir(dir) {
  const entries = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const relPath = rel ? rel + '/' + name : name;
      const full = path.join(dir, relPath);
      if (fs.statSync(full).isDirectory()) walk(relPath);
      else entries.push({ name: relPath, data: fs.readFileSync(full) });
    }
  };
  walk('');
  return entries;
}

/* ── 更新检测（M4：记录来源与版本，支持更新检测）──────────── */

/**
 * 对一个目录算内容快照（文件相对路径 + 大小 + 内容 hash，排序后整体 SHA256）。
 * 安装时存进 meta.installedSnapshot，更新检测时现算比对 —— 目录被手动改动能被发现。
 */
export function snapshotSkillDir(dir) {
  const files = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const relPath = rel ? rel + '/' + name : name;
      const full = path.join(dir, relPath);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(relPath);
      else files.push({ p: relPath, s: st.size, h: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16) });
    }
  };
  walk('');
  files.sort((a, b) => (a.p < b.p ? -1 : 1));
  return { files: files.length, hash: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16) };
}

/**
 * 更新检测：现算目录快照与安装时的 meta.installedSnapshot 比对。
 *
 * 诚实边界：检测的对象是**平台磁盘上的安装目录**（zip 安装解压后的那份 / 本地目录引用）。
 * 平台没有"上游市场"可查 —— source=zip 的包是从 API 上传的，平台不保留上传副本之外的
 * 上游，因此**发现不了"上游出了新版本"**，只能发现"装进来的这份被改过"。
 * 前者需要 M4-3 的市场/导入导出配合，做不到就不装作做得到。
 *
 * @returns {{status: 'unchanged'|'changed'|'missing'|'not_checkable', detail: string,
 *            installedSnapshot?: object, currentSnapshot?: object}}
 */
export function checkSkillUpdate(tenantId, name) {
  const row = getSkill(tenantId, name);
  if (!row) return { status: 'not_checkable', detail: 'Skill 未登记：' + name };
  if (!row.path) return { status: 'not_checkable', detail: '登记时没有安装路径（meta-only 记录），无从比对' };
  if (!fs.existsSync(row.path)) {
    return { status: 'missing', detail: '安装目录已不存在（可能被手动删除）：' + row.path };
  }
  let meta = {};
  try { meta = JSON.parse(row.meta_json || '{}'); } catch { /* 空快照按 changed 处理 */ }
  if (!meta.installedSnapshot) {
    return { status: 'changed', detail: '登记时没有内容快照（旧版安装），无法确认是否被动过 —— 保守按已变更处理', currentSnapshot: snapshotSkillDir(row.path) };
  }
  const now = snapshotSkillDir(row.path);
  const status = now.hash === meta.installedSnapshot.hash && now.files === meta.installedSnapshot.files ? 'unchanged' : 'changed';
  return {
    status,
    detail: status === 'unchanged'
      ? '安装目录与安装时快照一致（' + now.files + ' 个文件）'
      : '安装目录与安装时快照不一致 —— 内容被改动过（安装时 ' + meta.installedSnapshot.files + ' 个文件，现 ' + now.files + ' 个）',
    installedSnapshot: meta.installedSnapshot,
    currentSnapshot: now,
  };
}

/* ── 可见性判定（现查库版 —— gate 与清单接口共用） ──────── */

/**
 * 判定一个 MCP 服务当前对模型是否可见（现查库，立即生效）。
 *
 * ⚠️ **0.21.10：这个函数是"从工具判定里拆出来"的，不是新写的。**
 *   在此之前 MCP 的可见性**借用工具判定**：`capability-gate.mjs` 里
 *   `gated.listMcpServers` 调的是 `toolVisibleNow('mcp:' + name)` —— 靠给名字加前缀
 *   把 MCP 服务塞进"工具"那一套判定。工具那套一删，这条路就断了。
 *   所以必须给 MCP 一个**自己的**判定入口，否则"删工具"会顺手把 MCP 的可见性闸
 *   一起弄坏 —— 而那是另一个功能，不该被这次删除波及。
 *
 * 语义与从前保持一致（拆出来时**行为逐字不变**，只是不再经过工具那层）：
 *   · 绑定仍按「任一主体维度命中即生效」展开（tenant / user / role）；
 *   · MCP 服务**不在**任何登记表里（`mcp_servers` 那份登记是连接配置，不是可见性开关），
 *     所以判定只看绑定，不看 enabled —— 这一条从前是靠 `registeredSomewhere` 恒为
 *     false（`tools` 表里查不到 `mcp:xxx` 这个"工具名"）隐式成立的，现在写明白。
 *   · 多租户：**保守并集** —— 任一租户 deny 即不可见（防跨租户泄漏）。
 */
export function mcpVisibleNow(serverName) {
  const rows = all('SELECT tenant_id, subject_type, subject_id, capability_type, capability_id, allow FROM capability_bindings');
  const verdict = decideMcpVisibility({ serverName, bindings: rows });
  return verdict;
}

/**
 * per-tenant 版（契约层 `listMcpServers({ tenantId })` 用）。
 *
 * ⚠️ 从前 gate 的 `listMcpServers` **没有** per-tenant 版本 —— 它只调
 *   `toolVisibleNow`（保守并集）。这里保留那个语义：带租户时只看该租户的绑定，
 *   不带租户时退回保守并集。**不是在扩大能力，是把原先隐含在工具那套里的两档
 *   如实补出来** —— 若只留一档，M5 的多租户隔离会在 MCP 这一侧留一个缺口。
 */
export function mcpVisibleForTenant(tenantId, serverName, { userId = null, roles = [] } = {}) {
  if (!tenantId) return mcpVisibleNow(serverName);
  const rows = all('SELECT subject_type, subject_id, capability_type, capability_id, allow FROM capability_bindings WHERE tenant_id = ?', [tenantId]);
  const bindings = bindingsForSubject(rows, { tenantId, userId, roles });
  return decideMcpVisibility({ serverName, bindings });
}

/** per-tenant 的 Skill 版，语义同上。 */
export function skillVisibleForTenant(tenantId, skillName, { userId = null, roles = [] } = {}) {
  if (!tenantId) return skillVisibleNow(skillName);
  const rows = all('SELECT subject_type, subject_id, capability_type, capability_id, allow FROM capability_bindings WHERE tenant_id = ?', [tenantId]);
  const bindings = bindingsForSubject(rows, { tenantId, userId, roles });
  const reg = get('SELECT enabled FROM skills WHERE tenant_id = ? AND name = ?', [tenantId, skillName]);
  const registryEnabled = !reg || reg.enabled === 1;
  const verdict = decideSkillVisibility({ skill: { name: skillName }, bindings, registryEnabled });
  return { ...verdict, registered: !!reg };
}

/** 同上，Skill 版。 */
export function skillVisibleNow(skillName) {
  const rows = all('SELECT tenant_id, subject_type, subject_id, capability_type, capability_id, allow FROM capability_bindings');
  const registryRows = all('SELECT tenant_id, enabled FROM skills WHERE name = ?', [skillName]);
  const registeredSomewhere = registryRows.length > 0;
  const registryEnabled = !registeredSomewhere || registryRows.some((r) => r.enabled === 1);
  const verdict = decideSkillVisibility({ skill: { name: skillName }, bindings: rows, registryEnabled });
  return { ...verdict, registered: registeredSomewhere };
}

/** 汇总计数（自检与前端卡片用）。 */
export function stats(tenantId) {
  const one = (sql, ...args) => get(sql, args);
  return {
    skills: one('SELECT COUNT(*) AS n FROM skills WHERE tenant_id = ?', tenantId).n,
    skillsEnabled: one('SELECT COUNT(*) AS n FROM skills WHERE tenant_id = ? AND enabled = 1', tenantId).n,
    // ⚠️ 0.21.10：`tools` / `toolsEnabled` 两个计数随登记表一起删除。
    //    不要为了"字段稳定"留一个恒为 0 的占位 —— 一个恒 0 的计数会被读成
    //    "一个工具都没有"，而事实是"工具不再是一个可登记的概念"（两回事）。
    mcpServers: one('SELECT COUNT(*) AS n FROM mcp_servers WHERE tenant_id = ?', tenantId).n,
    mcpHealthy: one("SELECT COUNT(*) AS n FROM mcp_servers WHERE tenant_id = ? AND health = 'ok'", tenantId).n,
    bindings: one('SELECT COUNT(*) AS n FROM capability_bindings WHERE tenant_id = ?', tenantId).n,
    bindingsDeny: one('SELECT COUNT(*) AS n FROM capability_bindings WHERE tenant_id = ? AND allow = 0', tenantId).n,
  };
}

/**
 * 能力探测：插件树、Skills 根目录、MCP 服务清单。
 *
 * 原则（沿用同权利人早期作品提出的「诚实数据源」）：
 *   · 探测失败/不可用 → 返回 `ok:false` + 原因 + `source`，页面显示空态；
 *   · **绝不**用上一次的快照冒充本次结果；
 *   · 解析是「尽力而为」，因此所有结果都带 `tolerant:true`，不声称完全准确。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 把绝对路径压成末级文件名，避免把本机路径泄漏给前端/落盘快照 */
export function shortPath(p) {
  const s = String(p || '');
  if (!s) return '';
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

/**
 * 宽容解析 `dsh --profile <p> --dump-config` 的输出。
 * 上游的 YAML 结构未在文档中冻结，因此这里**不假设严格 schema**：
 * 只按行扫描「层标题」与「插件条目」，拿不到的字段就留空。
 */
export function parseDumpConfig(text) {
  const lines = String(text || '').split(/\r?\n/);
  const layers = [];
  const plugins = [];
  let currentLayer = null;

  const isLayerHeader = (line) => /^\s{0,2}[a-zA-Z0-9_@.\-/\\]+\s*:\s*$/.test(line) || /^\s*#\s*layer/i.test(line);
  const layerOf = (line) => line.replace(/:\s*$/, '').trim();

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || /^\s*#/.test(line)) continue;

    if (isLayerHeader(line) && !/^\s*-\s/.test(line)) {
      const name = layerOf(line);
      // 顶层且不像插件字段的，视为层标题
      if (name && !/^(id|name|package|plugin|enabled|disabled|version)$/i.test(name)) {
        currentLayer = name;
        if (!layers.includes(name)) layers.push(name);
        continue;
      }
    }

    const m = /^\s*-\s*(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[1].trim();

    // 形如 `- id: foo` / `- name: foo` / `- package: foo@1.2.3`
    const kv = /^([A-Za-z_]+)\s*:\s*(.+)$/.exec(rest);
    if (kv && /^(id|name|package|plugin|source)$/i.test(kv[1])) {
      plugins.push({
        id: kv[2].trim().replace(/^["']|["']$/g, ''),
        package: kv[1].toLowerCase() === 'package' ? kv[2].trim() : '',
        layer: currentLayer,
        disabled: false,
      });
      continue;
    }
    // 形如 `- some-plugin-name`
    if (/^[\w@.\-/]+$/.test(rest)) {
      plugins.push({ id: rest, package: rest, layer: currentLayer, disabled: false });
    }
  }

  return { layers, plugins };
}

/** 探测插件树（优先问 DSH 自己：--dump-config，失败则如实上报） */
export function dumpPlugins(client, profile) {
  const r = client.dumpConfig(profile);
  if (!r.ok) {
    return { ok: false, source: 'dump-config', profile, error: r.error, layers: [], plugins: [] };
  }
  const parsed = parseDumpConfig(r.text);
  return {
    ok: true,
    source: 'dump-config',
    tolerant: true,          // 解析是尽力而为，不声称完全准确
    profile,
    via: shortPath(r.via || ''),
    layers: parsed.layers,
    plugins: parsed.plugins,
    pluginCount: parsed.plugins.length,
    textLength: r.text.length,
    at: new Date().toISOString(),
  };
}

/** 候选 Skills 根目录（只报告**真实存在**的，不猜） */
export function skillsRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh');
  const profile = process.env.DSH_PROFILE || 'web';
  const candidates = [
    path.join(dshHome, 'skills'),
    path.join(dshHome, 'profiles', profile, 'skills'),
    path.join(process.cwd(), '.dsh', 'skills'),
    path.join(process.cwd(), 'skills'),
  ];
  const roots = [];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
        const entries = fs.readdirSync(c, { withFileTypes: true }).filter((e) => e.isDirectory());
        roots.push({ path: c, short: c.replace(home, '~'), count: entries.length, names: entries.slice(0, 50).map((e) => e.name) });
      }
    } catch { /* 单个候选读不了不影响其他 */ }
  }
  return { roots, searched: candidates.map((c) => c.replace(home, '~')) };
}

/**
 * MCP 服务清单 —— **平台登记表**是这份清单的来源，不是上游。
 *
 * ⚠️ 这里曾经返回 `{servers: [], source: 'not-implemented'}`，理由是
 *    "MCP 握手与健康探测在 M4 交付"。M4 早已交付，但这个方法没跟着改，
 *    于是成了一句**过期的空话**：契约层 `listMcpServers` 恒返回空，
 *    能力闸（`applyCapabilityGate`）也就**永远没有东西可过滤** ——
 *    "deny 掉一个 MCP 服务，它在契约层立即消失"这条验收标准
 *    在回归里根本走不到（测试替身与真上游都返回空，测出来的是"没测"）。
 *
 * 为什么来源是平台登记表而不是上游 RPC：
 *   · MCP 服务是**平台侧配置**（`mcp_servers` 表：transport + 加密连接配置 + 健康），
 *     接入方是使用平台的人，不是上游内核；
 *   · 上游没有"MCP 清单"RPC（与工具清单同一情形，`compat/*.mjs` 的候选探测全 404）；
 *   · 因此"有哪些 MCP 服务"这个问题**只有平台答得出**，而且它答的就是真话。
 *
 * 与 `listSkills` 的处理**刻意不同**：Skill 清单是"内核报一份 + 平台报一份"的
 * 双来源（内核有 `skills/list` RPC），所以那里做合并；MCP 没有上游那一半，
 * 合并的对象是空的 —— 硬凑一个"双来源"只会造出一份永远为空的假来源。
 *
 * 读库是**调用时现查**（`listMcpServers` 每次调 gate 都要重新判定），
 * 与能力闸"现查库、无缓存、不重启生效"的口径一致。
 *
 * @param {(tenantId?:string)=>Array} listRegistered 平台登记表的读取函数
 *   （注入而不是直接 import：内核适配层不许反向依赖平台层，见 `architecture.md` §3）
 */
export function mcpServers(listRegistered) {
  if (typeof listRegistered !== 'function') {
    return {
      servers: [],
      source: 'platform-registry',
      note: '未注入登记表读取器 —— 如实返回空，不编造。',
    };
  }
  let rows = [];
  try { rows = listRegistered() || []; } catch (e) {
    return {
      servers: [],
      source: 'platform-registry',
      error: e.message,
      note: '登记表读取失败，如实上报而不是假装没有服务。',
    };
  }
  return {
    servers: rows.map((r) => ({
      name: r.name,
      transport: r.transport,
      enabled: r.enabled !== 0 && r.enabled !== false,
      health: r.health || 'unknown',
    })),
    source: 'platform-registry',
  };
}

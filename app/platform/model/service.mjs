/**
 * 模型中心服务（P1-1）—— 平台侧模型注册表、默认模型与降级链。
 *
 * 为什么需要这一层（P1-1 要解决的具体问题）：
 *   在它之前，"平台配了哪些模型"这件事**没有数据落点** —— 向量模型散在
 *   `data/config.json`（进程级、改完要重启），对话模型根本不可配（只能透传上游）。
 *   运维想问"配了哪几个、哪个是默认、挂了哪条链、通不通"，没有任何接口能回答。
 *
 * 本模块交付四件事（与 roadmap P1-1 一一对应）：
 *   1. **多 provider 配置**：注册表 CRUD，按组织隔离，密钥只存凭据**名称**；
 *   2. **连通性测试**：真发一次最小请求（`probe.mjs`），失败按原因分类；
 *   3. **默认模型**：库层用部分唯一索引保证「每组织每 kind 至多一个默认」；
 *   4. **降级链**：同 kind 内按 `priority` 升序的启用项序列 ——
 *      不另建链表，因为多一张链表就要维护"链与项一致"，而顺序在 priority 一列里已完整。
 *
 * 三条诚实边界（**写在最前面，因为最容易被含糊过去**）：
 *   · **本模块不是 model gateway**。它是"配置 + 探活 + 排序"，**不做请求转发**。
 *     把配额从事后统计升级为事前拦截需要网关本体（必须在模型调用路径上），
 *     那是 roadmap 里 v1.0 的工作。这里如实不承诺 —— 一个不转发请求的"网关"
 *     只是名字好听。
 *   · **探活会真的出网**（对话探活发 `max_tokens:1` 的最小请求）。结论里带
 *     `billedRequest` 让运维知道。不做"只探端口"的假探活。
 *   · **密钥永不回显**。表里存的是凭据**名称**，探活时按名去取、解密、
 *     只用在这一次 fetch 上；响应与日志里不出现值。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, all, tx } from '../../data/db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';
import { parseJsonSafe } from '../../util/json.mjs';
// 租户过滤的落点单点在 data/repositories/rows.mjs（曾与 notify/schedule 各留一份拷贝，体检 §A1-#3）
import { rowBy } from '../../data/repositories/rows.mjs';
import { KINDS, PROTOCOLS_BY_KIND, endpointFor, probeModel } from './probe.mjs';

const DEFAULT_PRIORITY = 100;

export function createModelService(deps = {}) {
  const resolveCredential = typeof deps.resolveCredential === 'function' ? deps.resolveCredential : null;
  const defaultTimeoutMs = Number(deps.probeTimeoutMs) > 0 ? Number(deps.probeTimeoutMs) : 15000;

  /* ── 读 ─────────────────────────────────────────────────────── */

  function rowsOf(tenantId) {
    return all(
      'SELECT * FROM model_providers WHERE tenant_id = ? ORDER BY kind, priority, created_at',
      [String(tenantId)]
    );
  }

  const TABLE = 'model_providers';
  const rowById = (tenantId, id) => rowBy(tenantId, TABLE, 'id', id);
  const rowByName = (tenantId, name) => rowBy(tenantId, TABLE, 'name', name);

  function readMeta(row) {
    return parseJsonSafe(row.meta_json);
  }

  /** 公开形状 —— **唯一**允许出到接口/前端的地方（因此密钥没有出口）。 */
  function shape(row) {
    if (!row) return null;
    const meta = readMeta(row);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      protocol: row.protocol,
      baseUrl: row.base_url,
      model: row.model,
      // 只给"名字"与"有没有值"：名字是给运维认的，值是密钥，没有出口。
      credentialName: row.credential_name || null,
      hasCredential: !!row.credential_name,
      priority: Number(row.priority),
      enabled: !!row.enabled,
      isDefault: !!row.is_default,
      label: row.label || '',
      endpoint: endpointFor(row.kind, row.protocol, row.base_url),
      source: 'registry',
      // 单价（P1-3 / 成本核算）。**原样输出 null**，不把 null 变成 0 ——
      // 0 是"免费"，null 是"不知道"，页面据 null 显示"未定价"，不是"¥0.00"。
      currency: row.currency || '',
      priceInMinor: row.price_in_minor === null || row.price_in_minor === undefined ? null : Number(row.price_in_minor),
      priceCacheReadMinor: row.price_cache_read_minor === null || row.price_cache_read_minor === undefined ? null : Number(row.price_cache_read_minor),
      priceCacheWriteMinor: row.price_cache_write_minor === null || row.price_cache_write_minor === undefined ? null : Number(row.price_cache_write_minor),
      priceOutMinor: row.price_out_minor === null || row.price_out_minor === undefined ? null : Number(row.price_out_minor),
      priced: [row.price_in_minor, row.price_cache_read_minor, row.price_cache_write_minor, row.price_out_minor]
        .some((v) => v !== null && v !== undefined),
      lastProbe: meta.lastProbe || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listProviders(tenantId) {
    return rowsOf(tenantId).map(shape);
  }

  function getProvider(tenantId, id) {
    return shape(rowById(tenantId, id));
  }

  /* ── 校验 ───────────────────────────────────────────────────── */

  function validate(input) {
    const name = String(input.name || '').trim();
    if (!name) return 'name 不能为空';
    if (name.length > 60) return 'name 过长（上限 60 字符）';
    const kind = String(input.kind || '');
    if (!KINDS.includes(kind)) return 'kind 必须是 ' + KINDS.join(' / ');
    const protocol = String(input.protocol || '');
    const allowed = PROTOCOLS_BY_KIND[kind] || [];
    if (!allowed.includes(protocol)) return kind + ' 的 protocol 必须是 ' + allowed.join(' / ');
    // 除"显式不配向量"外，baseUrl 与 model 都是必需品 —— 缺了它们探活必然失败，
    // 与其存进去再让人去猜，不如在写入时就拒绝。
    if (protocol !== 'none') {
      if (!String(input.baseUrl || '').trim()) return '缺少 baseUrl（模型服务的根地址）';
      if (!String(input.model || '').trim()) return '缺少模型名';
    }
    if (input.priority !== undefined && !Number.isFinite(Number(input.priority))) return 'priority 必须是数字';
    return priceError(input);
  }

  /**
   * 单价校验（P1-3 / 成本核算）。
   *
   * 规则（每一条都对应一种"会让金额算错"的输入）：
   *   · 单价必须是**非负整数**（单位：最小货币单位 / 每 100 万 token）。
   *     小数与负数一律拒 —— 金额用整数存就是为了不留浮点漂移的缝。
   *   · **配了任一单价就必须有币种**（3 位字母）。没有币种的单价无法表达成金额；
   *     默认按人民币算等于替客户做决定，而且他可能以为是美元。
   *   · 不给单价 = 合法的（"没配"），此时币种可空。
   */
  function priceError(input) {
    const fields = ['priceInMinor', 'priceCacheReadMinor', 'priceCacheWriteMinor', 'priceOutMinor'];
    let any = false;
    for (const f of fields) {
      if (input[f] === undefined || input[f] === null || input[f] === '') continue;
      const n = Number(input[f]);
      if (!Number.isInteger(n) || n < 0) {
        return f + ' 必须是非负整数（最小货币单位 / 每 100 万 token），实际：' + input[f];
      }
      any = true;
    }
    const currency = String(input.currency || '').trim();
    if (any && !/^[A-Za-z]{3}$/.test(currency)) {
      return '配了单价就必须给出 3 位币种（如 CNY / USD）—— 缺币种的单价无法表示成金额';
    }
    if (currency && !/^[A-Za-z]{3}$/.test(currency)) return 'currency 必须是 3 位字母（ISO 4217）';
    return null;
  }

  /** 单价的落库取值：空 → null（**不是 0**） */
  function priceValue(v) {
    if (v === undefined || v === null || v === '') return null;
    return Number(v);
  }

  /** 清掉同租户同 kind 的既有默认（受库层部分唯一索引约束，必须在设置新默认前调用） */
  function clearDefault(tenantId, kind) {
    run('UPDATE model_providers SET is_default = 0 WHERE tenant_id = ? AND kind = ? AND is_default = 1',
      [String(tenantId), String(kind)]);
  }

  /* ── 写 ─────────────────────────────────────────────────────── */

  function createProvider(tenantId, input = {}) {
    const bad = validate(input);
    if (bad) return { ok: false, error: bad };
    const name = String(input.name).trim();
    if (rowByName(tenantId, name)) return { ok: false, error: '同名模型条目已存在：' + name };

    const id = newId('mdl');
    const now = nowIso();
    const wantDefault = !!input.isDefault;
    try {
      // 清理默认 + 插入必须在同一事务里：中途失败时不能留下"默认没了但新的没建成"。
      tx(() => {
        if (wantDefault) clearDefault(tenantId, String(input.kind));
        run(
          `INSERT INTO model_providers
             (id, tenant_id, name, kind, protocol, base_url, model, credential_name,
              priority, enabled, is_default, label, meta_json, currency,
              price_in_minor, price_cache_read_minor, price_cache_write_minor, price_out_minor,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, String(tenantId), name, String(input.kind), String(input.protocol),
            String(input.baseUrl || ''), String(input.model || ''), String(input.credentialName || ''),
            input.priority === undefined ? DEFAULT_PRIORITY : Number(input.priority),
            input.enabled === false ? 0 : 1,
            wantDefault ? 1 : 0,
            String(input.label || ''), JSON.stringify(input.meta || {}),
            String(input.currency || '').trim().toUpperCase() || null,
            priceValue(input.priceInMinor), priceValue(input.priceCacheReadMinor),
            priceValue(input.priceCacheWriteMinor), priceValue(input.priceOutMinor),
            now, now]
        );
      });
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
    return { ok: true, provider: getProvider(tenantId, id) };
  }

  function updateProvider(tenantId, id, patch = {}) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '模型条目不存在：' + id };

    // 用"现值 + 补丁"拼出完整输入再走同一套校验 —— 否则改一个字段能绕过校验。
    const merged = {
      name: patch.name !== undefined ? patch.name : row.name,
      kind: patch.kind !== undefined ? patch.kind : row.kind,
      protocol: patch.protocol !== undefined ? patch.protocol : row.protocol,
      baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : row.base_url,
      model: patch.model !== undefined ? patch.model : row.model,
      priority: patch.priority !== undefined ? patch.priority : row.priority,
      // 单价也要进 merged：否则"只改个 enabled"会把校验跳过去，
      // 而校验恰恰是拦住"负数单价 / 缺币种"的唯一一道闸。
      currency: patch.currency !== undefined ? patch.currency : row.currency,
      priceInMinor: patch.priceInMinor !== undefined ? patch.priceInMinor : row.price_in_minor,
      priceCacheReadMinor: patch.priceCacheReadMinor !== undefined ? patch.priceCacheReadMinor : row.price_cache_read_minor,
      priceCacheWriteMinor: patch.priceCacheWriteMinor !== undefined ? patch.priceCacheWriteMinor : row.price_cache_write_minor,
      priceOutMinor: patch.priceOutMinor !== undefined ? patch.priceOutMinor : row.price_out_minor,
    };
    const bad = validate(merged);
    if (bad) return { ok: false, error: bad };

    const mergedName = String(merged.name).trim();
    const clash = rowByName(tenantId, mergedName);
    if (clash && clash.id !== row.id) return { ok: false, error: '同名模型条目已存在：' + mergedName };

    // kind 改了会让"默认"落在一个新的 kind 上，语义含糊 —— 直接拒绝比猜要好。
    if (String(merged.kind) !== row.kind && row.is_default) {
      return { ok: false, error: '该条目是默认项，改 kind 会让默认落到另一个用途上；请先取消默认或另建条目' };
    }

    const wantDefault = patch.isDefault === undefined ? !!row.is_default : !!patch.isDefault;
    const wantEnabled = patch.enabled === undefined ? !!row.enabled : !!patch.enabled;
    if (wantDefault && !wantEnabled) {
      return { ok: false, error: '不能把已停用的条目设为默认' };
    }

    const credentialName = patch.credentialName !== undefined ? String(patch.credentialName || '') : (row.credential_name || '');
    const label = patch.label !== undefined ? String(patch.label || '') : (row.label || '');
    const now = nowIso();
    try {
      tx(() => {
        if (wantDefault && !row.is_default) clearDefault(tenantId, String(merged.kind));
        run(
          `UPDATE model_providers SET
             name = ?, kind = ?, protocol = ?, base_url = ?, model = ?, credential_name = ?,
             priority = ?, enabled = ?, is_default = ?, label = ?,
             currency = ?, price_in_minor = ?, price_cache_read_minor = ?,
             price_cache_write_minor = ?, price_out_minor = ?,
             updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
          [mergedName, String(merged.kind), String(merged.protocol), String(merged.baseUrl || ''),
            String(merged.model || ''), credentialName,
            merged.priority === undefined ? DEFAULT_PRIORITY : Number(merged.priority),
            wantEnabled ? 1 : 0, wantDefault ? 1 : 0, label,
            String(merged.currency || '').trim().toUpperCase() || null,
            priceValue(merged.priceInMinor), priceValue(merged.priceCacheReadMinor),
            priceValue(merged.priceCacheWriteMinor), priceValue(merged.priceOutMinor),
            now, String(tenantId), String(id)]
        );
      });
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
    return { ok: true, provider: getProvider(tenantId, id) };
  }

  function deleteProvider(tenantId, id) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '模型条目不存在：' + id };
    run('DELETE FROM model_providers WHERE tenant_id = ? AND id = ?', [String(tenantId), String(id)]);
    return {
      ok: true, deleted: row.name,
      // 刻意**不自动提升**下一个为默认：那会悄悄改变行为。默认没了就报"没有默认"，
      // resolveDefault 会如实说明它落到了链首（defaultSource='chain-head'）。
      note: row.is_default ? '被删的是默认项；已不再有显式默认，取链首作为默认。' : undefined,
    };
  }

  function setEnabled(tenantId, id, enabled) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '模型条目不存在：' + id };
    const on = !!enabled;
    // 停用当前默认项时把默认标记一并撤掉 —— 一个停用的条目不该继续"声称"是默认。
    // ⚠️ 撤销是**单向**的：重新启用**不会**自动恢复默认。这一点必须显式回报给调用方，
    //    否则运维会以为"关一下再开一下"什么都没变，而实际上默认换人（或落到链首）了。
    const clearedDefault = !on && !!row.is_default;
    try {
      tx(() => {
        if (clearedDefault) clearDefault(tenantId, row.kind);
        run('UPDATE model_providers SET enabled = ?, is_default = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
          [on ? 1 : 0, clearedDefault ? 0 : row.is_default, nowIso(), String(tenantId), String(id)]);
      });
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
    return {
      ok: true,
      provider: getProvider(tenantId, id),
      clearedDefault,
      ...(clearedDefault
        ? { note: '该条目原是默认项，停用已同时撤掉默认标记；重新启用不会自动恢复，请重新设为默认或接受链首。' }
        : {}),
    };
  }

  function setDefault(tenantId, id) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '模型条目不存在：' + id };
    if (!row.enabled) return { ok: false, error: '不能把已停用的条目设为默认（请先启用）' };
    try {
      tx(() => {
        clearDefault(tenantId, row.kind);
        run('UPDATE model_providers SET is_default = 1, updated_at = ? WHERE tenant_id = ? AND id = ?',
          [nowIso(), String(tenantId), String(id)]);
      });
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
    return { ok: true, provider: getProvider(tenantId, id) };
  }

  /* ── 默认模型 / 降级链 ──────────────────────────────────────── */

  /** 某 kind 的降级链：**只含启用项**，按 priority 升序（同 priority 按创建时间，保证顺序确定） */
  function resolveChain(tenantId, kind) {
    if (!KINDS.includes(String(kind))) return [];
    const rows = all(
      'SELECT * FROM model_providers WHERE tenant_id = ? AND kind = ? AND enabled = 1 ORDER BY priority ASC, created_at ASC',
      [String(tenantId), String(kind)]
    );
    return rows.map((r, i) => ({ ...shape(r), position: i }));
  }

  /**
   * 解析默认项，并**如实说明它是怎么成为默认的**：
   *   `defaultSource: 'explicit'`  —— 有人显式设了它；
   *   `defaultSource: 'chain-head'` —— 没人设默认，取了降级链的第一项；
   *   `defaultSource: null`         —— 该用途一条启用项都没有。
   * 不区分这三种情况的话，界面就只能显示一个名字，让人以为"这就是被配置的默认"。
   */
  function resolveDefault(tenantId, kind) {
    const chain = resolveChain(tenantId, kind);
    const explicit = chain.find((p) => p.isDefault) || null;
    if (explicit) return { provider: explicit, defaultSource: 'explicit', chain };
    if (chain.length) return { provider: chain[0], defaultSource: 'chain-head', chain };
    return { provider: null, defaultSource: null, chain: [] };
  }

  /* ── 探活 ───────────────────────────────────────────────────── */

  /**
   * 真探一条模型条目。
   *
   * 返回形状**分两层**（与 operation.verifyByName 同一纪律）：
   *   `ok` 说"这次调用有没有跑成"（条目存在吗、密钥取得出来吗）；
   *   `verdict` 说"连通性结论"。
   * 合并成一个 ok 就分不出"条目不存在（404）"与"条目存在但连不上（200 + 结论）"。
   *
   * @returns {Promise<{ok:true,name:string,verdict:object}|{ok:false,reason:'not_found',error:string}>}
   */
  async function probeProvider(tenantId, id) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '模型条目不存在：' + id };

    let apiKey = '';
    let credentialNote = null;
    if (row.credential_name && resolveCredential) {
      try { apiKey = resolveCredential(String(tenantId), row.credential_name) || ''; }
      catch (e) { credentialNote = '凭据「' + row.credential_name + '」读取失败：' + (e && e.message); }
      if (!apiKey && !credentialNote) credentialNote = '凭据「' + row.credential_name + '」没有值（或已不存在）';
    }
    if (row.credential_name && !resolveCredential) {
      credentialNote = '平台未装配凭据解析器（装配缺陷），本次探活未带密钥';
    }

    const verdict = await probeModel({
      kind: row.kind, protocol: row.protocol, baseUrl: row.base_url, model: row.model,
      apiKey, timeoutMs: defaultTimeoutMs,
    });
    if (credentialNote) verdict.credentialNote = credentialNote;

    // 记下最近一次探活（供界面显示），但**不把它当成长期结论** —— 连通性随时会变，
    // 因此字段名就叫 lastProbe，并带上时间戳。
    try {
      const meta = readMeta(row);
      meta.lastProbe = {
        at: nowIso(), ok: verdict.ok, level: verdict.level, code: verdict.code,
        message: verdict.message, latencyMs: verdict.latencyMs,
      };
      run('UPDATE model_providers SET meta_json = ? WHERE tenant_id = ? AND id = ?',
        [JSON.stringify(meta), String(tenantId), String(id)]);
    } catch { /* 记不上最近结果不影响探活结论本身 */ }

    return { ok: true, name: row.name, endpoint: endpointFor(row.kind, row.protocol, row.base_url), verdict };
  }

  /* ── 与知识层对接：让注册表成为向量配置的**一个真源** ─────────── */

  /**
   * 给知识层用的向量配置。
   *
   * 为什么必须有这个接缝：没有它，模型中心就只是一个"能存能看的表"，
   * 而真正决定检索质量的那份配置仍在 `config.json` 里 —— 页面与行为脱节，
   * 属于"治理表演"。接上之后，注册表里的默认向量项**真的**被检索使用。
   *
   * 诚实约束：
   *   · **没有组织上下文时返回 null**（不去猜"全局默认"）。调用方（诊断自检）
   *     会因此回落到 `config.json` 并在结果里标明来源，不会含糊地声称某个默认。
   *   · 返回值里的 `source` 让上层能如实标注这份配置来自哪里。
   *
   * @returns {{provider:string, baseUrl:string, model:string, credentialName:string,
   *            dim:number, source:'model-registry', registryName:string, registryId:string}|null}
   */
  function resolveEmbeddingForIdentity(tenantId) {
    if (!tenantId) return null;
    const d = resolveDefault(String(tenantId), 'embedding');
    const p = d.provider;
    if (!p) return null;
    return {
      provider: p.protocol,                 // 协议名即 embedding 层的 provider 名（openai-compat / ollama / none）
      baseUrl: p.baseUrl || '',
      model: p.model || '',
      credentialName: p.credentialName || '',
      dim: 0,                               // 维度在首次真实调用时从响应观察，不在配置里写死
      source: 'model-registry',
      registryName: p.name,
      registryId: p.id,
    };
  }

  /* ── 状态 ───────────────────────────────────────────────────── */

  function status(tenantId) {
    const rows = rowsOf(tenantId);
    const byKind = {};
    for (const k of KINDS) byKind[k] = rows.filter((r) => r.kind === k).length;
    const dChat = resolveDefault(tenantId, 'chat');
    const dEmbed = resolveDefault(tenantId, 'embedding');
    return {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      byKind,
      withCredential: rows.filter((r) => r.credential_name).length,
      defaultChat: dChat.provider ? dChat.provider.name : null,
      defaultChatSource: dChat.defaultSource,
      defaultEmbedding: dEmbed.provider ? dEmbed.provider.name : null,
      defaultEmbeddingSource: dEmbed.defaultSource,
      kinds: KINDS.slice(),
      protocols: JSON.parse(JSON.stringify(PROTOCOLS_BY_KIND)),
      // 这条边界必须随数据一起出现在界面上，否则会被当成"已经能拦配额了"
      boundaries: '本模块是「配置 + 探活 + 排序」，不做请求转发；把配额从事后统计升级为事前拦截需要 model gateway（v1.0）。',
    };
  }

  return {
    listProviders, getProvider, createProvider, updateProvider, deleteProvider,
    setEnabled, setDefault, resolveChain, resolveDefault, probeProvider,
    resolveEmbeddingForIdentity, status,
    /** 无后台资源；与其它模块同构 */
    close() { /* no-op */ },
  };
}

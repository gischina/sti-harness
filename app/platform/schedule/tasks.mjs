/**
 * 定时任务的**执行体白名单**。
 *
 * 为什么要有这一层（而不是让 `scheduled_jobs.kind` 直接 `import('./' + kind)`）：
 *   1. 动态 import 一个来自数据库的字符串 = 把库写入权升级成**任意代码执行**；
 *   2. 白名单让"库里出现了一个没有实现的 kind"变成一条**如实的 fail 记录**
 *      （`unknown-kind`），而不是静默跳过 —— 静默跳过会让运维以为任务在跑；
 *   3. 每个执行体的入参默认值、依赖项、失败语义都能在这里写清楚，
 *      而调度器本身只需要"按时间叫醒它、把结果记下来"。
 *
 * 每个执行体签名：
 *   `async ({ tenantId, params, deps }) => { status:'ok'|'fail'|'skipped', detail:object }`
 *   · 返回 `skipped` 表示"这次确实没什么可做的"（例如当日没有可归档的审计），
 *     **这不是失败** —— 把它记成 fail 会让失败计数失去意义（狼来了）。
 *   · 抛异常会被调度器捕获并记成 `fail`，同时保留 `error` 明细；执行体自己
 *     尽量别抛，能预期的缺失（依赖未装配）就返回 fail + 说明。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

/** 参数默认值（集中一处，让"任务配了但参数空着"有确定行为，而不是靠执行体各自兜底） */
export const TASK_DEFAULTS = {
  'audit.archive': { retentionDays: 90 },
  'audit.anchor': {},
  'session.purge': { keepDays: 7 },
  'notify.retry': { keepDays: 30, limit: 100 },
  'backup.create': { label: 'auto', keep: 30 },
  'model.probe': { kind: '' },
};

export const TASK_KINDS = Object.keys(TASK_DEFAULTS);

/** 人类可读说明 —— 直接给调度页渲染，避免前端再维护一份文案 */
export const TASK_INFO = {
  'audit.archive': {
    title: '审计归档',
    desc: '把超过保留期的审计记录写成 data/archive/audit-YYYYMM.jsonl 只读副本后从主表删除；删除动作本身入链。',
  },
  'audit.anchor': {
    title: '审计链尾锚定',
    desc: '把当日最后一条审计的 hash 与记录数固定到 data/anchor/ 与 audit_anchors 表，用于发现"整表重写"。',
  },
  'session.purge': {
    title: '会话清理',
    desc: '删除已过期或已吊销、且超过保留期的登录会话记录（保留最近 keepDays 天便于审计追溯）。'
      + '不做这件事的话 auth_sessions 只增不减，是长期运行的慢速磁盘/查询泄漏。',
  },
  'backup.create': {
    title: '自动备份',
    desc: '调用在线快照（VACUUM INTO）生成一份一致性备份到 data/backups/，并只保留最近 keep 份'
      + '（默认 30，参数 keep）—— 更旧的自动删除，删除动作单独入审计。'
      + '轮转在建成功之后才做；没有它，自动备份就是磁盘无界增长的来源。',
  },
  'notify.retry': {
    title: '通知失败重投',
    desc: '把 `notify_deliveries` 里已到期的失败投递重新发一次（指数退避，最多 6 次，'
      + '超过转 dead 并保留可见、可手动重投），顺带清理超过保留期的终态记录。'
      + '没有它，上游抖动就等于告警永久丢失 —— 而丢的往往是"审计链尾锚点""备份失败"这类必须被看见的事件。',
  },
  'model.probe': {
    title: '模型探活巡检',
    desc: '对注册表里启用的模型条目逐条探活，失败项按事件白名单出站告警。',
  },
};

function mergeParams(kind, params) {
  const base = { ...(TASK_DEFAULTS[kind] || {}) };
  if (params && typeof params === 'object') {
    for (const k of Object.keys(params)) if (params[k] !== undefined) base[k] = params[k];
  }
  return base;
}

function need(deps, path, label) {
  const v = path.split('.').reduce((a, k) => (a == null ? a : a[k]), deps);
  if (!v) throw new Error('执行体依赖未装配：' + label + '（装配缺陷，不是数据问题）');
  return v;
}

/**
 * 执行体表。`TASK_KINDS`（= `TASK_DEFAULTS` 的键）必须与本表的键**完全对齐** ——
 * test-core 有一条用例钉住这件事（防止"登记了却没有实现"或"实现了却没有登记"）。
 *
 * ⚠️ 迁移纪律：0009 注释里那份 kind 列表是"截至 0009 时点"的记录，**不可回改**
 * （改历史迁移会断校验和、卡死启动）。新增 kind 的正确做法是：
 *   ① 在这里 + `TASK_DEFAULTS` + `TASK_INFO` 三处补齐；
 *   ② 如需 schema 变更（例如给清理查询补索引），写一个**新的**迁移文件；
 *   ③ 在**新迁移**的注释里记录这次新增，而不是回头去动 0009。
 */
const TASKS = {
  async 'audit.archive'({ tenantId, params, deps }) {
    const audit = need(deps, 'governance.audit', 'governance.audit');
    const retentionDays = Number(params.retentionDays) > 0 ? Number(params.retentionDays) : TASK_DEFAULTS['audit.archive'].retentionDays;
    const r = audit.archive({ tenantId, retentionDays, dir: deps.archiveDir });
    if (r.archived === 0) return { status: 'skipped', detail: { retentionDays, archived: 0, cutoff: r.cutoff, note: '没有超过保留期的记录' } };
    return { status: 'ok', detail: { retentionDays, archived: r.archived, cutoff: r.cutoff, file: r.file } };
  },

  async 'audit.anchor'({ tenantId, params, deps }) {
    const audit = need(deps, 'governance.audit', 'governance.audit');
    const r = audit.anchor({ tenantId, dir: deps.anchorDir });
    if (!r.ok) return { status: 'fail', detail: r };
    // 出站：锚点只有离开这台机器才有意义（见 0009 迁移的诚实边界）。
    // 没有配渠道时如实标 false —— 不假装已经外发。
    let delivered = 0;
    if (deps.notify && typeof deps.notify.emit === 'function') {
      try {
        const d = await deps.notify.emit({
          tenantId, event: 'audit.anchor',
          payload: { day: r.day, tailHash: r.tailHash, recordCount: r.recordCount, file: r.file },
        });
        delivered = d && d.delivered ? d.delivered : 0;
      } catch { /* 出站失败不影响锚点本身落盘 */ }
    }
    return {
      status: 'ok',
      detail: { day: r.day, tailHash: r.tailHash, recordCount: r.recordCount, file: r.file, delivered, outOfBand: delivered > 0 },
    };
  },

  async 'session.purge'({ tenantId, params, deps }) {
    const identity = need(deps, 'identity', 'identity');
    const keepDays = Number(params.keepDays) > 0 ? Number(params.keepDays) : TASK_DEFAULTS['session.purge'].keepDays;
    // purgeSessions 一并清"已失效且超保留期"的两步登录票据（同表纪律、同保留期，
    // 见 identity/service.mjs 的 TOTP 小节）。两者都是 0 才算"没什么可做的"。
    const r = identity.purgeSessions({ keepDays, orgId: tenantId });
    if (!r.removed && !r.challengesRemoved) {
      return { status: 'skipped', detail: { keepDays, removed: 0, challengesRemoved: 0, note: '没有"已失效且超过保留期"的会话或两步登录票据' } };
    }
    return { status: 'ok', detail: { keepDays, removed: r.removed, challengesRemoved: r.challengesRemoved } };
  },

  async 'notify.retry'({ tenantId, params, deps }) {
    const notify = need(deps, 'notify', 'notify');
    const limit = Number(params.limit) > 0 ? Number(params.limit) : TASK_DEFAULTS['notify.retry'].limit;
    const r = await notify.retryPending({ limit, tenantId });
    // 清理与重投同频：两者共用同一张表。只重投不清理，表会被"早就成功的历史"撑大；
    // 只清理不重投，这张表就白建了。清理**只删终态**（见 notify.purgeDeliveries 的注释）。
    const purge = notify.purgeDeliveries({ keepDays: params.keepDays, tenantId });

    // 任务状态怎么记（这条判断得写下来，否则失败计数会失去意义）：
    //   · 到期为 0 → skipped（"这次确实没什么可做的"，本来就不是失败）；
    //   · 有投递成功 / 仍在重试中 → ok。**"上游还是不通"不是任务失败** ——
    //     把它记 fail 会让调度页的失败数变成"上游健康度"，那时真正的任务故障就淹没了；
    //   · **只有本次出现新的死信（达到重投上限）才记 fail** —— 那意味着
    //     "平台放弃了一条告警"，是运维必须抬头看的事，值得一个红点。
    if (!r.picked) {
      return { status: 'skipped', detail: { due: 0, purged: purge.removed, note: '没有到期的待重投投递' } };
    }
    return {
      status: r.dead > 0 ? 'fail' : 'ok',
      detail: {
        picked: r.picked, delivered: r.delivered, stillPending: r.failed, dead: r.dead,
        purged: purge.removed, maxAttempts: r.maxAttempts,
        ...(r.dead > 0 ? { note: '有 ' + r.dead + ' 条达到重投上限转 dead —— 接收端需要人工排查' } : {}),
      },
    };
  },

  async 'backup.create'({ tenantId, params, deps }) {
    const operation = need(deps, 'operation', 'operation');
    const label = String(params.label || 'auto');
    let r;
    try {
      r = operation.backupNow({ label });
    } catch (e) {
      // ⚠️ **备份失败必须出站**，否则"备份"会安静地不再发生 —— 而它恰恰是最不该静默失败的一件事
      //    （静默失败 = 以为有备份，实际没有；等到需要恢复那天才发现，是最贵的一种失败）。
      //    `backup.failed` 自 0.8.0 起就躺在通知白名单与部署文档里，却**一直没有 emit 点**，
      //    0.12.1 才接上（对账表见 `notify/service.mjs` 的 `NOTIFY_EVENT_PRODUCERS`）。
      //
      //    为什么**不**在手工接口（`POST /api/operation/backup`）上报同一个事件：那是"人在旁边
      //    看着"的动作，错误会立刻显示给操作者；把它也出站只会让告警通道被操作者的试错刷屏
      //    —— 同一条判断见 `notify/service.mjs` 里"试发不入队"的注释。
      if (deps.notify && typeof deps.notify.emit === 'function') {
        try {
          const msg = (e && e.message) || String(e);
          await deps.notify.emit({
            tenantId, event: 'backup.failed',
            // `note` 是给钉钉/企微这类接收端直接渲染的一行摘要（见 notify 的 buildBody）。
            // ⚠️ 摘要里含原始错误信息，可能带本机路径 —— 这是刻意的：接收端是**运维自己的**告警地址，
            //    藏掉原因反而让人无从排查。密文/凭据永远不在这里（备份错误不涉及它们）。
            payload: { note: '自动备份失败：' + msg, label, error: msg },
          });
        } catch { /* 出站失败**绝不**掩盖原始错误：备份失败的真相必须原样抛出去 */ }
      }
      throw e;   // 如实让任务记成 fail —— 吞掉它就等于"备份连续失败"在调度页上也看不见
    }

    // ⚠️ 轮转**必须**在建成功之后 —— 顺序反了（先删后建）时，一旦新建失败就是**净损失**：
    // 旧备份已经删了、新备份又没成。这是这里唯一不能颠倒的一件事。
    //
    // `keep` 只**透传**，不在这一层再算一遍：规范化语义只有一个实现
    // （"没给"用默认值、"给了 0"抬到 1，见 backup.mjs 的 normalizeKeep）——
    // 同一条规则写两遍，就是等它们某天对不上。
    let prune;
    try {
      prune = operation.pruneBackups({ keep: params.keep });
    } catch (e) {
      // 轮转失败不影响"备份已经成功"这个事实。**不记成 fail** 的理由与文件顶部那条一致：
      // 把它记成 fail 会让失败计数失去意义（备份确实做成了）。如实回报，不吞。
      prune = { ok: false, error: (e && e.message) || String(e), keep: null };
    }

    // 报告的保留份数一律取**实际生效值**（pruneBackups 规范化后的）；轮转没跑成就如实为 null。
    const keptPolicy = prune.keep == null ? null : prune.keep;
    const removed = Array.isArray(prune.removed) ? prune.removed : [];
    if (removed.length && deps.governance && deps.governance.audit) {
      // 删除是**不可逆**动作，单独记一条 —— 若只塞进 `schedule.job.run` 的 detail 里，
      // 事后要回答"哪几份备份被删了、什么时候"就得去翻调度日志。
      try {
        deps.governance.audit.append({
          tenantId,
          userId: null,
          action: 'operation.backup.prune',
          resourceType: 'backup',
          resourceId: removed[0].file + (removed.length > 1 ? ' 等 ' + removed.length + ' 份' : ''),
          result: 'ok',
          detail: { keep: keptPolicy, removed: removed.map((x) => x.file).slice(0, 20), freedBytes: prune.freedBytes },
        });
      } catch { /* 留痕失败不影响备份与轮转的结果 */ }
    }

    return {
      status: 'ok',
      detail: {
        name: r.name,
        bytes: r.bytes,
        tenantId,
        keep: keptPolicy,
        rotated: prune.ok === false
          ? null
          : { total: prune.total, kept: prune.kept, removed: removed.map((x) => x.file), freedBytes: prune.freedBytes },
        rotateError: prune.ok === false ? prune.error : null,
      },
    };
  },

  async 'model.probe'({ tenantId, params, deps }) {
    const model = need(deps, 'model', 'model');
    const kind = params.kind ? String(params.kind) : null;
    const list = model.listProviders(tenantId).filter((p) => p.enabled && (!kind || p.kind === kind));
    if (!list.length) return { status: 'skipped', detail: { checked: 0, note: '没有启用的模型条目' } };
    const results = [];
    let failed = 0;
    for (const p of list) {
      try {
        const r = await model.probeProvider(tenantId, p.id);
        const level = r.ok ? r.verdict.level : 'fail';
        // `skipped`（向量协议 none）不算失败：那是"没配，属预期状态"。
        if (!r.ok || (level !== 'ok' && level !== 'skipped')) {
          failed++;
          if (deps.notify && typeof deps.notify.emit === 'function') {
            try {
              await deps.notify.emit({
                tenantId, event: 'model.probe.failed',
                payload: { name: p.name, kind: p.kind, level, code: r.ok ? r.verdict.code : 'not_found', endpoint: r.ok ? r.endpoint : null },
              });
            } catch { /* 出站失败不影响巡检结果 */ }
          }
        }
        results.push({ name: p.name, level, code: r.ok ? r.verdict.code : 'not_found' });
      } catch (e) {
        failed++;
        results.push({ name: p.name, level: 'fail', code: 'probe_error', error: e && e.message });
      }
    }
    return { status: failed ? 'fail' : 'ok', detail: { checked: list.length, failed, results } };
  },
};

/** 该 kind 是否已实现 */
export function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(TASKS, String(kind));
}

/**
 * 执行一个任务体。
 * @returns {Promise<{status:'ok'|'fail'|'skipped', detail:object}>}
 */
export async function runTask(kind, { tenantId, params, deps }) {
  const fn = TASKS[String(kind)];
  if (!fn) {
    return { status: 'fail', detail: { error: 'unknown-kind', kind: String(kind), known: TASK_KINDS } };
  }
  const merged = mergeParams(kind, params);
  try {
    const r = await fn({ tenantId, params: merged, deps });
    return { status: r && r.status ? r.status : 'ok', detail: (r && r.detail) || {} };
  } catch (e) {
    return { status: 'fail', detail: { error: e && e.message ? e.message : String(e) } };
  }
}

/**
 * 定时任务底座（P1-2）—— 单进程、零依赖的"按时间跑"能力。
 *
 * 为什么它是 P1 的第一件（而不是某一项功能）：
 *   审批超时、审计归档、审计锚定、会话清理、定期备份、模型探活巡检 —— 这几件事**全都**
 *   只想说一句话："到点了，跑一下"。在它之前，平台唯一会自己动的是限流清扫
 *   与流心跳（都是基础设施自清理），**没有任何业务调度**。于是每加一项
 *   "该定时做的事"，都要在那个模块里再写一套 setInterval —— 底座是一次性的，
 *   省下的是后面每一次。
 *
 * ⚠️ 三条诚实边界（写在最前面，因为它们决定了这个模块**不能**被宣传成什么）：
 *
 *   1. **不是 cron。** 只认两种规则：`interval:<毫秒>` 与 `dailyAt:HH:MM`（UTC）。
 *      不实现 cron 解析器 —— 一套 cron 表达式解析 + 时区 + DST 处理是一个独立的
 *      复杂度来源，而 90% 的运维诉求（"每小时"、"每天凌晨"）这两种就够。
 *      规则在写入时**严格校验**，非法表达式进不了库。
 *
 *   2. **进程不跑，任务就不跑。** 单进程部署形态的必然结果：进程停了就没有调度，
 *      也没有"错过了就补跑"（不写 catch-up，因为"补跑一次归档"和"补跑一次备份"
 *      的风险完全不同，让调度器统一猜是错的）。错过就是错过，页面会显示
 *      `next_run_at` 已过期，运维能看见。
 *
 *   3. **没有分布式锁。** 单进程即单调度者。将来真上多实例，这一层必须重做
 *      （需要一个租约表），而不是"加个开关"就能用。这条写在这里，防止有人
 *      以为它可以横向扩。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, all } from '../../data/db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';
import { parseJsonSafe } from '../../util/json.mjs';
// 租户过滤的落点单点在 data/repositories/rows.mjs（曾与 model/notify 各留一份拷贝，体检 §A1-#3）
import { rowBy } from '../../data/repositories/rows.mjs';
import { TASK_KINDS, TASK_INFO, isKnownKind, runTask } from './tasks.mjs';

const DAY_MS = 86_400_000;

/** 默认任务集 —— 组织建立时播种，让平台"开箱就有人在干活"，而不是等运维来配。 */
export const DEFAULT_JOBS = [
  { name: '审计归档', kind: 'audit.archive', schedule: 'dailyAt:03:30', params: { retentionDays: 90 } },
  { name: '审计链尾锚定', kind: 'audit.anchor', schedule: 'dailyAt:00:10', params: {} },
  // 会话清理：不加它，auth_sessions 只增不减（一次全量体检抓出的长期泄漏）
  { name: '会话清理', kind: 'session.purge', schedule: 'dailyAt:04:10', params: { keepDays: 7 } },
  // 通知失败重投（体检 §B5）：告警不能因为"上游抖了一下"就永久丢失。
  // 间隔 10 分钟：重投本身的退避是 10 分钟起、指数上升，调度比它密只是让到期即发。
  { name: '通知失败重投', kind: 'notify.retry', schedule: 'interval:600000', params: { keepDays: 30, limit: 100 } },
];

/* ── 规则解析（纯函数，可单测）──────────────────────────────────────── */

/**
 * 解析触发规则。
 * @returns {{ok:true,type:'interval',ms:number}|{ok:true,type:'dailyAt',hh:number,mm:number}|{ok:false,error:string}}
 */
export function parseSchedule(spec) {
  const s = String(spec == null ? '' : spec).trim();
  let m = /^interval:(\d+)$/.exec(s);
  if (m) {
    const ms = Number(m[1]);
    if (!(ms >= 1_000)) return { ok: false, error: 'interval 至少 1000 毫秒（更密的调度没有意义）' };
    if (ms > 30 * DAY_MS) return { ok: false, error: 'interval 上限 30 天（更长的周期请用 dailyAt）' };
    return { ok: true, type: 'interval', ms };
  }
  m = /^dailyAt:(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return { ok: false, error: 'dailyAt 的时/分非法（00:00 – 23:59）' };
    return { ok: true, type: 'dailyAt', hh, mm };
  }
  return { ok: false, error: 'schedule 必须是 interval:<毫秒> 或 dailyAt:HH:MM（UTC 时区）' };
}

/**
 * 算出下次执行时刻（毫秒）。
 *
 * ⚠️ `dailyAt` 按 **UTC** 解释 —— 与 `usage.periodStart()` 同一口径（库里时间戳
 * 全是 `toISOString()` 的 UTC）。用本地时区算会让同一份配置在不同机器上
 * 于不同时刻触发，而界面上显示的时间又对不上，这是最容易被忽略的一类坑。
 */
export function computeNextRun(spec, fromMs = Date.now()) {
  const p = parseSchedule(spec);
  if (!p.ok) return null;
  if (p.type === 'interval') return fromMs + p.ms;
  const d = new Date(fromMs);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), p.hh, p.mm, 0, 0);
  return today > fromMs ? today : today + DAY_MS;
}

/** 规则的人类可读说明（给页面用，避免前端再解析一遍） */
export function describeSchedule(spec) {
  const p = parseSchedule(spec);
  if (!p.ok) return spec;
  if (p.type === 'interval') {
    const min = p.ms / 60_000;
    if (p.ms % DAY_MS === 0) return '每 ' + (p.ms / DAY_MS) + ' 天';
    if (p.ms % 3_600_000 === 0) return '每 ' + (p.ms / 3_600_000) + ' 小时';
    if (Number.isInteger(min)) return '每 ' + min + ' 分钟';
    return '每 ' + (p.ms / 1000) + ' 秒';
  }
  return '每日 ' + String(p.hh).padStart(2, '0') + ':' + String(p.mm).padStart(2, '0') + '（UTC）';
}

/* ── 服务 ──────────────────────────────────────────────────────────── */

export function createScheduleService(deps = {}) {
  const tickMs = Number(deps.tickMs) > 0 ? Number(deps.tickMs) : 30_000;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  /** 交给执行体的依赖集合（集中一处，执行体只认这几个名字） */
  const taskDeps = {
    governance: deps.governance || null,
    operation: deps.operation || null,
    model: deps.model || null,
    notify: deps.notify || null,
    // 会话清理执行体（session.purge）要它 —— 删会话是身份的领域，调度器只负责"到点叫醒"。
    identity: deps.identity || null,
    archiveDir: deps.archiveDir || null,
    anchorDir: deps.anchorDir || null,
  };

  let timer = null;
  let ticking = false;
  let lastTickAt = null;
  let lastTickSummary = null;

  /* ── 读 ── */

  const TABLE = 'scheduled_jobs';
  const rowById = (tenantId, id) => rowBy(tenantId, TABLE, 'id', id);
  const rowByName = (tenantId, name) => rowBy(tenantId, TABLE, 'name', name);

  function parseJson(s) {
    return parseJsonSafe(s);
  }

  function shape(row) {
    if (!row) return null;
    const params = parseJson(row.params_json);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      known: isKnownKind(row.kind),
      title: (TASK_INFO[row.kind] || {}).title || row.kind,
      schedule: row.schedule,
      scheduleText: describeSchedule(row.schedule),
      params,
      enabled: !!row.enabled,
      lastRunAt: row.last_run_at || null,
      lastStatus: row.last_status || null,
      lastDetail: parseJson(row.last_detail_json),
      nextRunAt: row.next_run_at || null,
      overdue: !!(row.enabled && row.next_run_at && String(row.next_run_at) <= nowIso()),
      runCount: Number(row.run_count || 0),
      failCount: Number(row.fail_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listJobs(tenantId) {
    return all(
      'SELECT * FROM scheduled_jobs WHERE tenant_id = ? ORDER BY enabled DESC, kind, name',
      [String(tenantId)]
    ).map(shape);
  }

  function getJob(tenantId, id) {
    return shape(rowById(tenantId, id));
  }

  /* ── 写 ── */

  function validate(input, { partial = false } = {}) {
    if (!partial || input.name !== undefined) {
      const name = String(input.name || '').trim();
      if (!name) return 'name 不能为空';
      if (name.length > 60) return 'name 过长（上限 60 字符）';
    }
    if (!partial || input.kind !== undefined) {
      const kind = String(input.kind || '');
      if (!isKnownKind(kind)) return 'kind 必须是已实现的执行体：' + TASK_KINDS.join(' / ');
    }
    if (!partial || input.schedule !== undefined) {
      const p = parseSchedule(input.schedule);
      if (!p.ok) return p.error;
    }
    if (input.params !== undefined && input.params !== null && typeof input.params !== 'object') {
      return 'params 必须是一个对象';
    }
    return null;
  }

  function createJob(tenantId, input = {}) {
    const bad = validate(input);
    if (bad) return { ok: false, error: bad };
    const name = String(input.name).trim();
    if (rowByName(tenantId, name)) return { ok: false, error: '同名任务已存在：' + name };
    const id = newId('job');
    const now = nowIso();
    const next = computeNextRun(input.schedule, Date.now());
    run(
      `INSERT INTO scheduled_jobs
         (id, tenant_id, name, kind, schedule, params_json, enabled,
          last_run_at, last_status, last_detail_json, next_run_at, run_count, fail_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, '{}', ?, 0, 0, ?, ?)`,
      [id, String(tenantId), name, String(input.kind), String(input.schedule).trim(),
        JSON.stringify(input.params || {}), input.enabled === false ? 0 : 1,
        next ? new Date(next).toISOString() : null, now, now]
    );
    return { ok: true, job: getJob(tenantId, id) };
  }

  function updateJob(tenantId, id, patch = {}) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '任务不存在：' + id };
    const bad = validate(patch, { partial: true });
    if (bad) return { ok: false, error: bad };

    const name = patch.name !== undefined ? String(patch.name).trim() : row.name;
    const clash = rowByName(tenantId, name);
    if (clash && clash.id !== row.id) return { ok: false, error: '同名任务已存在：' + name };

    const kind = patch.kind !== undefined ? String(patch.kind) : row.kind;
    const schedule = patch.schedule !== undefined ? String(patch.schedule).trim() : row.schedule;
    const params = patch.params !== undefined ? patch.params : parseJson(row.params_json);
    const enabled = patch.enabled !== undefined ? !!patch.enabled : !!row.enabled;
    // 规则变了就重算下次执行 —— 否则页面会显示一个按旧规则算出来的时间。
    const next = patch.schedule !== undefined
      ? computeNextRun(schedule, Date.now())
      : (row.next_run_at || (enabled ? computeNextRun(schedule, Date.now()) : null));

    run(
      `UPDATE scheduled_jobs SET name = ?, kind = ?, schedule = ?, params_json = ?, enabled = ?,
         next_run_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
      [name, kind, schedule, JSON.stringify(params || {}), enabled ? 1 : 0,
        next ? new Date(next).toISOString() : null, nowIso(), String(tenantId), String(id)]
    );
    return { ok: true, job: getJob(tenantId, id) };
  }

  function deleteJob(tenantId, id) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '任务不存在：' + id };
    run('DELETE FROM scheduled_jobs WHERE tenant_id = ? AND id = ?', [String(tenantId), String(id)]);
    return { ok: true, deleted: row.name };
  }

  /* ── 执行 ── */

  /**
   * 跑一个任务并把结果写回（含审计留痕）。
   *
   * `manual` 区分"定时触发"与"运维点了一下" —— 两者在审计里必须能分开，
   * 否则事后没人分得清"这次归档是自动的还是有人手动跑的"。
   */
  async function execute(tenantId, row, { manual = false } = {}) {
    const startedAt = Date.now();
    const r = await runTask(row.kind, { tenantId, params: parseJson(row.params_json), deps: taskDeps });
    const tookMs = Date.now() - startedAt;
    const now = nowIso();
    const next = computeNextRun(row.schedule, Date.now());
    const okRun = r.status !== 'fail';

    run(
      `UPDATE scheduled_jobs SET last_run_at = ?, last_status = ?, last_detail_json = ?,
         next_run_at = ?, run_count = run_count + 1, fail_count = fail_count + ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
      [now, r.status, JSON.stringify({ ...r.detail, tookMs, manual }), next ? new Date(next).toISOString() : null,
        okRun ? 0 : 1, now, String(tenantId), String(row.id)]
    );

    const gov = deps.governance;
    if (gov && gov.audit) {
      try {
        gov.audit.append({
          tenantId, userId: null,
          action: 'schedule.job.run',
          resourceType: 'schedule', resourceId: row.id,
          result: okRun ? 'ok' : 'error',
          detail: { kind: row.kind, status: r.status, tookMs, manual, ...r.detail },
        });
      } catch { /* 留痕失败不影响任务结果 */ }
    }
    return { ok: true, job: getJob(tenantId, row.id), status: r.status, detail: { ...r.detail, tookMs } };
  }

  /** 运维手动触发（不校验是否到点） */
  async function runNow(tenantId, id) {
    const row = rowById(tenantId, id);
    if (!row) return { ok: false, reason: 'not_found', error: '任务不存在：' + id };
    return execute(tenantId, row, { manual: true });
  }

  /**
   * 一次调度扫描。
   *
   * 到期判定：`enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= now`。
   * `next_run_at IS NULL` 的启用任务**不跑**，只在下一次 tick 时补算 ——
   * 这是刻意的：NULL 意味着"我们不知道它该什么时候跑"（例如库是手改的），
   * 直接跑一个规则不明的任务比不跑更危险。
   *
   * 重入保护：`ticking` 标志。上一轮还没跑完时直接跳过本轮，
   * 不让"备份还在做"与"下一轮备份开始了"叠在一起。
   */
  async function tick(nowMs = Date.now()) {
    if (ticking) return { skipped: true, reason: '上一轮尚未结束' };
    ticking = true;
    const summary = { at: new Date(nowMs).toISOString(), due: 0, ran: 0, failed: 0, errors: [] };
    try {
      const nowStr = new Date(nowMs).toISOString();
      const rows = all(
        // tenant-ok: 调度器是**平台级后台循环**，它的职责就是跨租户找出所有到期任务；
        // 这里不带租户过滤是语义正确的（它**不是**租户请求路径）。
        // 执行时逐条按 `row.tenant_id` 归属 —— 结果只会写回行自己所属的租户。
        `SELECT * FROM scheduled_jobs
          WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC LIMIT 50`,
        [nowStr]
      );
      summary.due = rows.length;
      for (const row of rows) {
        try {
          const r = await execute(String(row.tenant_id), row, { manual: false });
          summary.ran++;
          if (r.status === 'fail') { summary.failed++; summary.errors.push({ id: row.id, kind: row.kind, detail: r.detail }); }
        } catch (e) {
          summary.failed++;
          summary.errors.push({ id: row.id, kind: row.kind, error: e && e.message });
          log('定时任务执行异常：' + row.kind + ' · ' + (e && e.message));
        }
      }
      // 启用了但 next_run_at 为空的任务（例如规则是手改进库的）在这里补算一次。
      // 不补算的话它们永远为 NULL、永远不到期 —— 表现为"任务启用了但从不执行"，
      // 这是最难查的一类静默故障。
      // tenant-ok: 与上面同一条理由 —— 平台级后台循环，跨租户补算。id 是主键，
      // 更新只落在那一行上，不存在"改到别家"的可能。
      for (const row of all(
        'SELECT id, schedule FROM scheduled_jobs WHERE enabled = 1 AND next_run_at IS NULL LIMIT 50', [])) {
        const fixed = computeNextRun(String(row.schedule), nowMs);
        if (fixed) {
          run('UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?', [new Date(fixed).toISOString(), row.id]);
          summary.repaired = (summary.repaired || 0) + 1;
        }
      }
      lastTickSummary = summary;
    } finally {
      lastTickAt = new Date(nowMs).toISOString();
      ticking = false;
    }
    return summary;
  }

  /* ── 生命周期 ── */

  function start() {
    if (timer) return { ok: true, already: true, tickMs };
    // `unref()`：调度器**不该**让进程无法退出。--check 模式与优雅退出都依赖这一点。
    timer = setInterval(() => { tick().catch((e) => log('调度 tick 失败：' + (e && e.message))); }, tickMs);
    timer.unref && timer.unref();
    return { ok: true, tickMs };
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    return { ok: true };
  }

  /* ── 播种 ── */

  /**
   * 为某个组织补齐默认任务（幂等：同名已存在就跳过）。
   *
   * 为什么播种而不是让运维自己配：审批超时与审计锚定是**平台自己承诺过**的能力，
   * "装了但没配所以没生效"会让承诺形同虚设。播种让它们默认就在跑，
   * 运维可以关、可以改参数，但不需要先知道"有这么个东西"。
   */
  function ensureDefaults(tenantId) {
    const created = [];
    for (const d of DEFAULT_JOBS) {
      if (rowByName(tenantId, d.name)) continue;
      const r = createJob(tenantId, d);
      if (r.ok) created.push(r.job.name);
    }
    return created;
  }

  /** 启动时对所有已存在的组织播种（老库升级上来也能拿到默认任务） */
  function ensureDefaultsForAllTenants() {
    let tenants = [];
    try { tenants = all('SELECT id FROM orgs', []).map((r) => r.id); } catch { tenants = []; }
    const out = {};
    for (const t of tenants) out[t] = ensureDefaults(t);
    return out;
  }

  /* ── 状态 ── */

  function status(tenantId) {
    const jobs = listJobs(tenantId);
    return {
      running: !!timer,
      tickMs,
      lastTickAt,
      lastTick: lastTickSummary,
      total: jobs.length,
      enabled: jobs.filter((j) => j.enabled).length,
      overdue: jobs.filter((j) => j.overdue).length,
      failing: jobs.filter((j) => j.lastStatus === 'fail').length,
      kinds: TASK_KINDS.slice(),
      info: JSON.parse(JSON.stringify(TASK_INFO)),
      // 边界必须随数据一起出现在界面上，否则"有调度器"会被读成"高可用调度"
      boundaries: '单进程调度：进程不跑任务就不跑，且不补跑错过的。'
        + 'dailyAt 按 UTC 解释。本模块不是 cron（只认 interval / dailyAt），也没有分布式锁。',
    };
  }

  return {
    listJobs, getJob, createJob, updateJob, deleteJob,
    runNow, tick, start, stop, ensureDefaults, ensureDefaultsForAllTenants, status,
    parseSchedule, computeNextRun, describeSchedule,
    // 进程级探针（不碰库）—— public 状态接口用它，避免为了报"调度器在不在跑"
    // 而去查一个跟组织无关的库查询。
    runningNow: () => !!timer,
    tickMs: () => tickMs,
    /** 供优雅退出使用 */
    close() { stop(); },
  };
}

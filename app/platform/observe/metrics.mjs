/**
 * 指标端点（P1-2）—— 让平台在客户的监控栈里**不再是黑盒**。
 *
 * 为什么需要：企业一定有自己的监控（Prometheus / Grafana / Zabbix / 夜莺）。
 * 在它之前，平台对外只有一条日志流与一个 `/api/system/health`。
 * 运维想答"这台机器现在每秒多少请求、慢在哪、配额拦了多少次"，
 * 只能自己去翻日志 —— 那不是可观测性，那是考古。
 *
 * 设计选择（都是刻意的，不是偷懒）：
 *   · **进程内计数器字典 + 文本渲染**，零依赖。Prometheus 的文本格式
 *     （`text/plain; version=0.0.4`）就是几行字符串，不需要任何库。
 *   · **计数器是进程级的，重启即归零。** 这是 Prometheus 生态的标准语义
 *     （它靠 `_total` 的单调递增 + 重启检测来做 rate 计算），不是缺陷。
 *   · **不引入 `/metrics` 的独立端口。** 走现有 HTTP 端口 + `system:read` 权限；
 *     额外端口的代价是多一份监听/配置/TLS 面，而现有鉴权链已经足够。
 *     真实部署里给采集器发一个只读账号的 API Key 即可。
 *   · **审计链长只报调用方所属组织。** 一个组织不该通过指标看到另一个组织的
 *     审计规模 —— 这跟审计页的隔离是同一条纪律，指标不能开后门。
 *
 * ⚠️ 覆盖边界（如实写在端点返回值附近）：只统计**匹配到路由**的 `/api/*` 请求。
 *    `/upstream/*` 透传与静态资源不经中间件链，因此不在指标里 ——
 *    这是有意的（它们不是"平台接口"，混进来会污染 route 维度）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { get } from '../../data/db.mjs';
import { dbInfo } from '../../data/db.mjs';

/** 直方图桶（毫秒）。覆盖"本地接口 < 5ms"到"慢查询 > 5s"的常见区间。 */
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const state = {
  startedAt: Date.now(),
  /** `${method}|${route}|${status}` → 次数 */
  httpRequests: new Map(),
  /** `${route}` → { count, sum, buckets:number[] } */
  httpDuration: new Map(),
  /** name → 次数（turns_total / tokens_total / quota_blocked_total / …） */
  counters: new Map(),
  /** name → 数值（active_turns / …） */
  gauges: new Map(),
  /** 仍在处理中的请求数（不落在 route 维度上，避免基数爆炸） */
  inflight: 0,
};

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

/** 计数器 +1。`labels` 会拼成稳定的标签串（键按字典序，保证时序连续）。 */
export function inc(name, labels = null, by = 1) {
  const key = labelKey(name, labels);
  bump(state.counters, key, by);
}

/** 设置一个瞬时值（gauge）。 */
export function setGauge(name, value, labels = null) {
  state.gauges.set(labelKey(name, labels), Number(value) || 0);
}

export function observeHttpDuration(routeId, ms) {
  const k = String(routeId || 'unknown');
  let e = state.httpDuration.get(k);
  if (!e) { e = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) }; state.httpDuration.set(k, e); }
  e.count++;
  e.sum += ms;
  for (let i = 0; i < BUCKETS.length; i++) { if (ms <= BUCKETS[i]) { e.buckets[i]++; } }
}

export function recordHttpRequest({ method, routeId, status, durationMs }) {
  bump(state.httpRequests, labelKey('sti_http_requests_total', { method: String(method || '').toUpperCase(), route: String(routeId || 'unknown'), status: String(status || 0) }));
  observeHttpDuration(routeId, Number(durationMs) || 0);
}

export function beginInflight() { state.inflight++; }
export function endInflight() { state.inflight = Math.max(0, state.inflight - 1); }

/** 测试与"清零"用。生产不调用 —— 归零会让 rate 计算出负值。 */
export function reset() {
  state.httpRequests.clear();
  state.httpDuration.clear();
  state.counters.clear();
  state.gauges.clear();
  state.inflight = 0;
  state.startedAt = Date.now();
}

function labelKey(name, labels) {
  if (!labels) return name;
  const keys = Object.keys(labels).sort();
  if (!keys.length) return name;
  return name + '{' + keys.map((k) => k + '="' + escapeLabel(labels[k]) + '"').join(',') + '}';
}

function escapeLabel(v) {
  return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function parseKey(key) {
  const i = key.indexOf('{');
  if (i < 0) return { name: key, labels: '' };
  return { name: key.slice(0, i), labels: key.slice(i) };
}

/**
 * 渲染 Prometheus 文本格式。
 * @param {{tenantId?:string|null}} [opts] 提供 tenantId 时附带该组织的审计链长
 * @returns {string}
 */
export function render(opts = {}) {
  const lines = [];
  const help = (n, t, type) => {
    lines.push('# HELP ' + n + ' ' + t);
    lines.push('# TYPE ' + n + ' ' + type);
  };

  const uptimeSec = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
  help('sti_uptime_seconds', '本进程已运行的秒数', 'gauge');
  lines.push('sti_uptime_seconds ' + uptimeSec);

  help('sti_process_inflight_requests', '当前仍在处理中的平台接口请求数', 'gauge');
  lines.push('sti_process_inflight_requests ' + state.inflight);

  help('sti_http_requests_total', '匹配到路由的 /api/* 请求总数（不含 /upstream 透传与静态资源）', 'counter');
  for (const [k, v] of [...state.httpRequests].sort()) {
    const { name, labels } = parseKey(k);
    lines.push(name + labels + ' ' + v);
  }
  // 若一条都没有，也要给出 TYPE 行，避免采集端读不到指标元数据
  if (!state.httpRequests.size) lines.push('sti_http_requests_total 0');

  help('sti_http_request_duration_ms', '平台接口处理耗时分布（毫秒）', 'histogram');
  if (!state.httpDuration.size) {
    for (const b of BUCKETS) lines.push('sti_http_request_duration_ms_bucket{route="",le="' + b + '"} 0');
    lines.push('sti_http_request_duration_ms_bucket{route="",le="+Inf"} 0');
    lines.push('sti_http_request_duration_ms_sum 0');
    lines.push('sti_http_request_duration_ms_count 0');
  } else {
    for (const [route, e] of [...state.httpDuration].sort()) {
      let cumulative = 0;
      for (let i = 0; i < BUCKETS.length; i++) {
        cumulative = e.buckets[i];
        lines.push('sti_http_request_duration_ms_bucket{route="' + escapeLabel(route) + '",le="' + BUCKETS[i] + '"} ' + cumulative);
      }
      lines.push('sti_http_request_duration_ms_bucket{route="' + escapeLabel(route) + '",le="+Inf"} ' + e.count);
      lines.push('sti_http_request_duration_ms_sum{route="' + escapeLabel(route) + '"} ' + e.sum);
      lines.push('sti_http_request_duration_ms_count{route="' + escapeLabel(route) + '"} ' + e.count);
    }
  }

  // 业务计数器：类型表集中声明，未出现的也给 0 —— 采集端配置的告警规则
  // 不能在"事件还没发生过"时因为缺指标而失效（这是运维侧很实际的一条）。
  const counterTypes = {
    sti_turns_total: '提交的回合数（result 维度：ok|error）',
    sti_tokens_total: 'usage 事件里的真实 token 数（direction 维度：input|output）',
    sti_quota_blocked_total: '配额拦截次数（metric 维度）',
    sti_notify_deliveries_total: '出站通知投递次数（result 维度：ok|fail）',
    sti_schedule_job_runs_total: '定时任务执行次数（result 维度：ok|fail|skipped）',
  };
  const seen = new Set();
  for (const [k, v] of [...state.counters].sort()) {
    const { name, labels } = parseKey(k);
    if (!seen.has(name)) {
      if (counterTypes[name]) help(name, counterTypes[name], 'counter');
      else help(name, '（未登记说明的计数器）', 'counter');
      seen.add(name);
    }
    lines.push(name + labels + ' ' + v);
  }
  for (const [name, desc] of Object.entries(counterTypes)) {
    if (!seen.has(name)) { help(name, desc, 'counter'); lines.push(name + ' 0'); }
  }

  help('sti_active_turns', '当前在途的回合数（并发闸的实测值）', 'gauge');
  lines.push('sti_active_turns ' + (state.gauges.get('sti_active_turns') || 0));

  // ── 需要读库的指标（只报调用方所属组织，见文件头说明）──
  const info = dbInfo();
  help('sti_db_size_bytes', 'SQLite 库文件字节数（WAL 未计入；-1 表示尚未落盘）', 'gauge');
  lines.push('sti_db_size_bytes ' + (info.bytes == null ? -1 : info.bytes));
  help('sti_db_tables', '库中表与视图的数量', 'gauge');
  lines.push('sti_db_tables ' + (info.tables == null ? 0 : info.tables));

  const tenantId = opts.tenantId ? String(opts.tenantId) : null;
  help('sti_audit_chain_length', '调用方所属组织的审计链长度', 'gauge');
  if (tenantId) {
    let n = 0;
    try {
      const r = get('SELECT COUNT(*) AS n FROM audit_logs WHERE tenant_id = ?', [tenantId]);
      n = r ? Number(r.n) : 0;
    } catch { n = 0; }
    lines.push('sti_audit_chain_length{tenant="' + escapeLabel(tenantId) + '"} ' + n);
  } else {
    lines.push('sti_audit_chain_length 0');
  }

  return lines.join('\n') + '\n';
}

/** 供测试与状态页使用的快照（不解析文本） */
export function snapshot() {
  return {
    startedAt: state.startedAt,
    httpRequests: Object.fromEntries(state.httpRequests),
    counters: Object.fromEntries(state.counters),
    gauges: Object.fromEntries(state.gauges),
    durationRoutes: state.httpDuration.size,
    inflight: state.inflight,
  };
}

/**
 * 环境自检（`node app/main.mjs --check`）。
 *
 * 部署到别人机器上时最需要的东西：一条命令把「环境缺什么」逐项列清楚，
 * 输出是纯文本，可以直接粘贴给管理员。**只检查、不启动服务。**
 *
 * 原则：每一项都必须给出**实测**结果，而不是"应该没问题"。
 * 探测不到的一律标 `warn`/`fail` 并说明可能的影响，绝不粉饰。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { checkNodeVersion, versionGate, readRawConfigFile } from './config.mjs';
import { dbInfo } from './data/db.mjs';
import { migrationStatus } from './data/migrate.mjs';
import { secretInfo } from './data/secret.mjs';
import { staticAssets } from './http/static.mjs';
import * as orgRepo from './platform/identity/repos/orgs.mjs';
import { middlewareStatus, rateLimitPolicy } from './http/middleware/registry.mjs';
import { inspectProvider, describeContract } from './kernel/contract.mjs';
import { readVersion, DATA_DIR, DB_FILE, SECRET_FILE, BACKUP_KEY_FILE } from './paths.mjs';
import { plain } from './log.mjs';
import { backupKeyInfo } from './platform/operation/backup.mjs';

/** 探测端口是否可用：可用=true，被占=false（被本程序占用也算占用） */
export function portFree(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const finish = (free) => { if (!done) { done = true; try { srv.close(); } catch { /* ignore */ } resolve(free); } };
    srv.once('error', () => finish(false));
    srv.once('listening', () => finish(true));
    try { srv.listen(port, host); } catch { finish(false); }
    setTimeout(() => finish(false), timeoutMs).unref?.();
  });
}

/**
 * @param {{config:object, kernel:object, router:object, pipeline:object, startedAt:number,
 *          identity?:object, knowledge?:object, governance?:object,
 *          operation?:object, schedule?:object, notify?:object, rawConfig?:object}} deps
 *   `identity` / `knowledge` / `governance` / `operation` / `schedule` / `notify` 是可选的：
 *   缺哪个就**跳过**对应项（例如只想单测某一项时），而不是伪造一个空状态 ——
 *   自检的每一项都必须是实测值，"没有依赖所以没查"与"查了结果是空"不能长得一样。
 *   `rawConfig` 是**第 [15] 项的注入点**：缺省读本机 `data/config.json` 的原始内容；
 *   给了就用给的（回归要能造出"明文令牌"与"密文令牌"两种形状，否则这一项只能测到本机现状）。
 * @returns {Promise<{ok:boolean, items:Array, fails:number, warns:number}>}
 */
export async function runCheck(deps) {
  const { config, kernel, router } = deps;
  const items = [];
  const add = (n, title, level, lines = []) => items.push({ n, title, level, lines });

  // [1] 运行环境
  const node = checkNodeVersion();
  add(1, '运行环境', node.ok ? 'ok' : 'fail', [
    'Node.js ' + node.current + '（要求 ≥ ' + node.required + '）',
    '平台版本 ' + readVersion() + '｜PID ' + process.pid + '｜平台 ' + process.platform + '/' + process.arch,
    node.ok ? '✓ 满足下限（node:sqlite 可用）' : '× 版本过低：node:sqlite 自 ' + node.required + ' 起可用，请升级 Node',
  ]);

  // [2] 数据目录与主密钥
  const si = secretInfo(SECRET_FILE);
  const dirLines = [
    '数据目录 ' + DATA_DIR,
    fs.existsSync(DB_FILE) ? '数据库文件已存在（' + Math.round((fs.statSync(DB_FILE).size || 0) / 1024) + ' KB）' : '数据库文件尚未创建（首次启动会创建）',
    si.exists
      ? '✓ 主密钥 data/.secret 已存在（' + si.bytes + ' 字节，权限 ' + si.mode + '，指纹 ' + si.fingerprint + '）'
      : '· 主密钥 data/.secret 尚未生成（首次启动会生成）',
    si.exists ? '  注意：该文件丢失将导致已存凭据不可解密，备份时必须包含它' : '',
  ].filter(Boolean);
  add(2, '数据目录', 'ok', dirLines);

  // [3] 数据库
  const db = dbInfo();
  if (db.open) {
    add(3, '数据库', 'ok', [
      '✓ SQLite ' + db.sqliteVersion + '｜日志模式 ' + db.journalMode + '｜表/视图 ' + db.tables + ' 个',
      '页 ' + db.pageCount + ' × ' + db.pageSize + ' 字节',
    ]);
  } else {
    add(3, '数据库', 'warn', ['· 未打开（--check 下若已打开会显示实测值）', '真实探测请在数据库打开后查看：GET /api/system/status']);
  }

  // [4] 迁移
  const mig = migrationStatus();
  const migLevel = mig.problems.length ? 'fail' : (mig.pending.length ? 'warn' : 'ok');
  add(4, '数据库迁移', migLevel, [
    '已应用 ' + mig.appliedCount + ' / 共 ' + mig.totalFiles + ' 个迁移文件' + (mig.currentVersion ? '｜当前版本 ' + mig.currentVersion : ''),
    mig.problems.length
      ? '× 发现 ' + mig.problems.length + ' 个迁移问题：\n' + mig.problems.map((p) => '    · ' + p.message).join('\n')
      : (mig.pending.length ? '· 待应用：' + mig.pending.join(', ') : '✓ 全部已应用，无需迁移'),
  ]);

  // [5] 前端产物（清单由 staticAssets() 从 index.html 现读：分片化之后逐个罗列没有意义，
  //     全部就位时只报总数，缺了才逐个点名 —— 缺的那一个才会真的导致白屏）
  const assets = staticAssets();
  const missing = assets.filter((a) => !a.exists);
  const appCount = assets.filter((a) => a.file.startsWith('app/')).length;
  add(5, '前端产物', missing.length ? 'fail' : 'ok',
    (missing.length
      ? missing.map((a) => '× 缺失：' + a.file)
      : ['✓ index.html 引用的 ' + assets.length + ' 个资源全部就位（其中 public/app/ 分片 ' + appCount + ' 个）'])
      .concat(missing.length ? ['  请把 public/ 整个目录（含 public/app/ 子目录）与 app/ 放在同一层'] : []));

  // [6] 端口
  const free = await portFree(config.values.host, config.values.port);
  add(6, '监听端口', free ? 'ok' : 'warn', [
    (free ? '✓ ' : '· ') + config.values.host + ':' + config.values.port
      + (free ? ' 可用' : ' 已被占用（若本程序未在运行，请改 STI_PORT）'),
    '（--check 不启动服务，因此"被占用"也可能是上一次没退干净）',
  ]);

  // [7] 内核 —— 只有两种处境：接入了 / 没接入（见 app/kernel/index.mjs 的 facade 说明）
  const desc = await kernel.describe();
  const gate = versionGate(desc.kernelVersion);
  /** 有没有配地址。`dshStatus` 只由真实内核适配层产出，未接入时整块是 null。 */
  const kernelConfigured = !!kernel.dshStatus;
  const upstream = kernel.dshStatus || {};
  const kernelLines = [
    kernel.ready
      ? '✓ 已接入内核'
      : (kernelConfigured ? '· 内核已配置，但当前不可用' : '· 尚未接入内核'),
    '  ' + kernel.reason,
    // ⚠️ 没有上游版本时**不要**把契约版本顶上去：那会出现「契约 1.0.0」被读成
    //    "上游就是 1.0.0"。没有版本就什么都不写。
    'provider：' + desc.kernel
      + '｜契约 ' + desc.contractVersion
      + (desc.kernelVersion ? '｜上游版本 ' + desc.kernelVersion : ''),
  ];
  if (kernelConfigured) {
    kernelLines.push('上游状态：' + (upstream.state || 'unknown') + (upstream.detail ? '（' + upstream.detail + '）' : ''));
    if (upstream.origin) kernelLines.push('上游地址：' + upstream.origin + (upstream.rev ? '｜运行实例 rev ' + upstream.rev : ''));
    kernelLines.push((gate.level === 'ok' ? '✓ ' : '· ') + '版本门禁：' + gate.detail);
  } else {
    kernelLines.push('  未接入时对话功能不可用；接入入口在概览页「接入内核」。');
  }
  add(7, 'Agent 内核', kernel.ready ? 'ok' : 'warn', kernelLines);

  // [8] 契约与映射覆盖率
  const insp = inspectProvider(kernel.provider);
  const cdesc = describeContract();
  const mapLines = [
    insp.ok ? '✓ 契约方法齐全（' + cdesc.methods.length + ' 个）' : '× 契约缺失方法：' + insp.missing.join(', '),
    insp.extra.length ? '· 契约外的扩展方法：' + insp.extra.join(', ') : '',
    '契约版本 ' + cdesc.version + '｜已知事件类型 ' + cdesc.eventTypes.length + ' 个',
  ].filter(Boolean);
  const map = kernel.mapping;
  if (map) {
    mapLines.push('事件映射规则 ' + map.ruleCount + ' 条：已核实 ' + map.verified.length + ' 条，**未核实 ' + map.unverified.length + ' 条**');
    if (map.unverified.length) {
      mapLines.push('  未核实：' + map.unverified.map((u) => u.id).join(', ')
        + '（需对着运行中的上游核实并录制 fixtures，见 docs/feasibility.md §6.4）');
    }
  }
  add(8, '契约与映射', insp.ok ? (map && map.unverified.length ? 'warn' : 'ok') : 'fail', mapLines);

  // [9] 中间件与路由
  const mws = middlewareStatus();
  const active = mws.filter((m) => m.state === 'active').map((m) => m.name);
  const pending = mws.filter((m) => m.state !== 'active').map((m) => m.name + '(' + m.milestone + ')');
  const stats = router ? router.stats() : { total: 0, byScope: {}, byMilestone: {} };
  const rl = rateLimitPolicy();
  add(9, '中间件与路由', 'warn', [
    '中间件已实装：' + (active.join(', ') || '无'),
    '**未实装（当前不做任何拦截）**：' + (pending.join(', ') || '无'),
    '路由 ' + stats.total + ' 条（' + Object.entries(stats.byScope).map(([k, v]) => k + ' ' + v).join('，') + '）',
    '按里程碑：' + Object.entries(stats.byMilestone).map(([k, v]) => k + ' ' + v).join('，'),
    '限流：默认 ' + rl.defaultPerMinute + ' 次/分钟/IP'
      + (Object.keys(rl.routeLimits).length
        ? '｜专属阈值：' + Object.entries(rl.routeLimits).map(([k, v]) => k + ' ' + v + '/分钟').join('，')
        : ''),
  ]);

  // [10] 打开方式
  const scheme = config.values.host === '0.0.0.0' ? '127.0.0.1' : config.values.host;
  add(10, '打开方式', 'info', [
    '启动：node app/main.mjs（或双击 start.cmd / 执行 ./start.sh）',
    '然后浏览器访问 http://' + scheme + ':' + config.values.port,
    '**不要**直接双击 public/index.html —— 那样所有接口都会失效',
    config.values.host === '0.0.0.0' || config.values.host === '::'
      ? '⚠ 当前监听全部网卡：多用户部署必须置于 HTTPS 反向代理之后，并确认已启用会话与 CSRF 防护'
      : '当前仅监听本机（127.0.0.1）。要让别人访问，改 STI_HOST 为内网地址，并**先配好 TLS 反向代理**',
  ]);

  // [11] 企业知识与检索（M2）
  // 这一项刻意把「哪些格式现在真的能解析」逐条列出来 ——
  // 因为外部命令（pdftotext / LibreOffice）是否装好，直接决定 PDF/Office 能不能进库。
  if (deps.knowledge) {
    try {
      const ks = deps.knowledge.status(null);
      const ext = ks.parsers.external;
      const lines = [
        '纯 Node 解析：' + ks.parsers.native.join(' / ') + '（txt md csv tsv json html，无需外部命令）',
        (ext.pdftotext.available ? '✓ ' : '× ') + 'PDF 解析（pdftotext）'
          + (ext.pdftotext.available ? '：' + (ext.pdftotext.version || '可用') : '：未检测到 —— ' + ext.pdftotext.hint),
        (ext.office.available ? '✓ ' : '× ') + 'Office 解析（LibreOffice）'
          + (ext.office.available ? '：' + (ext.office.version || '可用') : '：未检测到 —— ' + ext.office.hint),
        '向量模型：' + ks.embedding.mode + (ks.embedding.mode === 'none'
          ? '（检索为纯文本 bigram + FTS5 bm25；配置 STI_EMBED_PROVIDER / STI_EMBED_MODEL 可启用语义检索）'
          : '：' + (ks.embedding.model || '(未设模型名)')),
        '分块参数：上限 ' + ks.chunking.maxChars + ' 字符 / 重叠 ' + ks.chunking.overlapChars
          + ' / 标题层级 ' + ks.chunking.maxHeadingDepth,
        '解析并发：' + ks.workerPool.mode + '（' + ks.workerPool.note + '）',
      ];
      // 实际用的是哪种检索实现、预过滤开没开 —— 这两件事必须能被运维看见，
      // 否则「换 ANN 只改装配点」与「预过滤默认关」都只活在文档里。
      if (ks.retrievers) {
        lines.push('检索实现：文本 ' + ks.retrievers.textIndex + ' ｜ 向量 ' + ks.retrievers.vectorIndex
          + '（向量预过滤：' + (ks.retrievers.prefilter.enabled
            ? '**开**，候选上限 ' + ks.retrievers.prefilter.maxCandidates
            : '关（全量精确扫描）') + '）');
      }
      if (ks.workerPool.fallbackReason) lines.push('· ' + ks.workerPool.fallbackReason);
      add(11, '企业知识与检索', (!ext.pdftotext.available || !ext.office.available) ? 'warn' : 'ok', lines);
    } catch (e) {
      add(11, '企业知识与检索', 'warn', ['· 知识层状态读取失败：' + e.message]);
    }
  }

  // [12] 治理与审计（M3）
  // 审计链是"事后可信"的根基：这里**真的重算一遍链**并给出结论，
  // 让部署者在自检里就能确认审计没被动过（或及早发现被动过）。
  if (deps.governance) {
    try {
      const g = deps.governance;
      const orgs = orgRepo.listOrgs();
      const lines = [];
      let level = 'ok';
      let chainOk = true;
      for (const o of orgs) {
        const v = g.audit.verifyChain(o.id);
        chainOk = chainOk && v.ok;
        lines.push((v.ok ? '✓ ' : '× ') + '审计链[' + (o.name || o.id) + ']：' + v.checked + ' 条全部重算'
          + (v.ok ? '通过' : '，**在第 ' + (v.brokenAt.index + 1) + ' 条断裂** —— 自该条起不可信，请立即排查'));
        if (!v.ok) level = 'fail';
      }
      if (!orgs.length) lines.push('· 尚无组织（初始化向导完成后这里会逐个校验审计链）');
      const quotaCount = (() => { try { return orgs.reduce((n, o) => n + g.quotas.list(o.id).length, 0); } catch { return -1; } })();
      lines.push('配额规则：' + (quotaCount < 0 ? '读取失败' : quotaCount + ' 条'));
      lines.push('用量口径：usage 事件逐字段照抄（计费输入 = input + cacheRead + cacheWrite），无估算');
      add(12, '治理与审计', level, lines);
    } catch (e) {
      add(12, '治理与审计', 'warn', ['· 治理层状态读取失败：' + e.message]);
    }
  }

  // [13] 凭据表安全自检（P1-A2a）
  // `credentials` 的密文列是 `cipher`，明文永远不该有列。这条断言自 M1 写下起
  // **从没有被调用过** —— "写了却没接通的护栏"比没有更危险（会让人以为它在守着）。
  // 这里把它真正跑起来：列名层面若出现 plain/secret/token/key/password/value 一律报红。
  if (db.open && deps.identity && typeof deps.identity.assertNoPlaintextColumns === 'function') {
    try {
      const a = deps.identity.assertNoPlaintextColumns();
      add(13, '凭据表安全', a.suspicious.length ? 'fail' : 'ok', [
        (a.suspicious.length ? '× ' : '✓ ') + 'credentials 表列名检查：' + a.columns.length + ' 列'
          + (a.suspicious.length
            ? '，发现可疑明文字段：' + a.suspicious.join(', ') + '（凭据只能以 cipher 密文列存放）'
            : '，无任何明文字段列（只有 cipher 密文列）'),
      ]);
    } catch (e) {
      add(13, '凭据表安全', 'warn', ['· 凭据表检查失败：' + e.message]);
    }
  }

  // [14] 备份与恢复（体检 §B10）
  // 为什么单列一项：备份是**唯一**"不做也不会报错"的运维必需项 —— 没配就是没配，服务照跑、
  // 界面也看不出异常，直到真的需要恢复那天才发现。自检是唯一能在"上线前"把它问出来的地方。
  // ⚠️ 本项只**读**（列举备份目录 / 查定时任务 / 查渠道订阅），不建任务、不建备份 —— 自检不改数据。
  if (deps.operation) {
    try {
      const orgs = orgRepo.listOrgs();
      const jobs = [];
      for (const o of orgs) {
        const list = deps.schedule ? deps.schedule.listJobs(o.id) : [];
        for (const j of list) if (j.kind === 'backup.create') jobs.push({ org: o.name || o.id, ...j });
      }
      const enabled = jobs.filter((j) => j.enabled);
      const lb = deps.operation.listBackups();
      const lines = [];
      let level = 'ok';

      // ① 自动备份任务配没配
      if (!orgs.length) {
        lines.push('· 尚无组织 —— 初始化向导完成后，这里会显示自动备份任务的状态');
        level = 'warn';
      } else if (!jobs.length) {
        lines.push('× 自动备份任务：**未配置** —— 平台不会自动产生任何备份'
          + '（这是刻意的默认：备份是**消耗型**动作，"要不要占盘"由运维定；代价是开箱即用 ≠ 开箱有备份）');
        lines.push('  → **上线前必做**：在「调度中心」新建一条任务 —— 类型选「自动备份」，规则 `dailyAt:03:00`，参数 `{"keep":30}`');
        level = 'warn';
      } else if (!enabled.length) {
        lines.push('! 自动备份任务：已建 ' + jobs.length + ' 条，但**全部处于停用状态** —— 等同于没配');
        level = 'warn';
      } else {
        lines.push('✓ 自动备份任务：' + enabled.length + ' 条启用（'
          + enabled.map((j) => j.name + '@' + j.scheduleText).join('；') + '）');
      }

      // ② 有没有真备份
      if (!lb.items.length) {
        lines.push('× 备份产物：' + (lb.note ? lb.note.replace(/。\s*$/, '') : '还没有任何备份')
          + ' —— **当前没有任何可恢复的还原点**');
        level = 'warn';
      } else {
        const last = lb.items[0];
        lines.push('✓ 备份产物：' + lb.items.length + ' 份，最近 ' + last.file
          + '（' + (last.bytes / 1048576).toFixed(1) + ' MB，' + last.mtime + '）');
        lines.push('  目录 ' + lb.dir + ' —— 轮转**只**发生在自动任务的 `backup.create` 里；'
          + '`POST /api/operation/backup` 手工建的备份**不会被自动清理**（平台刻意不提供删除接口）');
      }

      // ③ 备份失败到底会不会有人收到（白名单 ≠ 有渠道订阅）
      if (deps.notify && typeof deps.notify.listChannels === 'function' && orgs.length) {
        const subs = [];
        for (const o of orgs) {
          for (const c of deps.notify.listChannels(o.id)) {
            if (c.enabled && Array.isArray(c.events) && c.events.includes('backup.failed')) {
              subs.push((o.name || o.id) + '/' + c.name);
            }
          }
        }
        if (subs.length) {
          lines.push('✓ 备份失败告警：' + subs.length + ' 个启用渠道订阅了 `backup.failed`（自动备份失败时会出站）');
        } else {
          lines.push('! 备份失败告警：**没有任何启用渠道订阅 `backup.failed`** —— '
            + '自动备份连续失败也不会有通知（订阅在「通知渠道」页里勾；事件通路本身已接通）');
          level = 'warn';
        }
      }

      // ④ 备份加密密钥（2026-10 安全评审 P1-7）
      try {
        const envKey = process.env.STI_BACKUP_KEY;
        let source = null;
        let keyInput = null;
        if (envKey && envKey.trim()) {
          source = 'STI_BACKUP_KEY 环境变量'; keyInput = envKey.trim();
        } else if (fs.existsSync(BACKUP_KEY_FILE)) {
          const body = fs.readFileSync(BACKUP_KEY_FILE, 'utf8').trim();
          if (body) { source = 'data/backup.key 文件'; keyInput = body; }
        }
        if (source && keyInput) {
          const info = backupKeyInfo(keyInput);
          lines.push('✓ 备份加密密钥：已配置（来源 ' + source + '，指纹 ' + info.kid
            + '）—— 新备份以 AES-256-GCM 加密、manifest HMAC 签名');
        } else {
          lines.push('! 备份加密密钥：**未配置统一密钥** —— 备份仍会加密，但每份各用一次性密钥'
            + '（包旁同名 .key）。建议设 STI_BACKUP_KEY 或妥善保管 data/backup.key');
          level = 'warn';
        }
      } catch (e) {
        lines.push('! 备份加密密钥状态读取失败：' + e.message);
        level = 'warn';
      }

      // ⑤ 恢复与主密钥（这两条是刻意的边界，必须在自检里说清，而不是只写在文档里）
      lines.push('恢复：**离线维护动作** —— `node tools/restore-backup.mjs <备份ZIP> <目标数据目录>`'
        + '（停机 → 恢复 → 校验 → 再启动）；平台**不做在线恢复接口**（运行中换掉自己脚下的库）');
      lines.push('主密钥 `data/.secret` **不在备份包内**（进了包就等于凭据明文搬家）——'
        + ' 必须**单独另行保管**；丢失即已存凭据永久不可解密，无后门（见第 [2] 项的指纹）');

      add(14, '备份与恢复', level, lines);
    } catch (e) {
      add(14, '备份与恢复', 'warn', ['· 备份状态读取失败：' + e.message]);
    }
  }

  // [15] 内核令牌的落盘卫生（0.15.0）
  // 为什么单列一项：明文令牌躺在 `data/config.json` 里**不会报任何错** ——
  // 服务照起、对话照跑、页面照显示"已接入"。0.15.0 **之前**写下的配置就是这个形状
  // （令牌内嵌在地址的 `?token=` 后），而 0.15.0 之后写的都是密文 ——
  // 于是"老配置里那份明文副本"既不会自己消失，**也没有任何地方会提醒它还在**。
  // 它与备份是同一类：**"不做也不会报错"的运维项必须在自检里有位置**（§10 第 14 条）。
  // 代价不是理论上的：任何能读到这个文件的进程、以及**每一份备份包与快照**，
  // 都连带拿到了调用上游内核的凭据。
  // ⚠️ 本项只**读**配置：不加密、不写盘。改写配置是 `tools/seal-kernel-token.mjs` 的职责 ——
  // **自检必须保持只读**，否则"跑一次自检"就动了运维的配置。
  try {
    const raw = deps.rawConfig || readRawConfigFile();
    const plainInOrigin = typeof raw.dshOrigin === 'string' && /[?&]token=/.test(raw.dshOrigin);
    const plainKey = typeof raw.dshToken === 'string' && raw.dshToken !== '';
    const cipher = typeof raw.dshTokenCipher === 'string' && raw.dshTokenCipher !== '';
    const src = config.sources || {};
    const lines = [];
    let level = 'ok';

    lines.push('地址来源 ' + (src.dshOrigin || '—')
      + '｜令牌来源 ' + (src.dshToken || 'none'));

    if (plainInOrigin || plainKey) {
      level = 'warn';
      lines.push('! **内核令牌在 `data/config.json` 里是明文**'
        + (plainInOrigin ? '（内嵌在地址的 `?token=` 后）' : '（独立的 `dshToken` 键）')
        + ' —— 这是 0.15.0 **之前**写下的形状，不会自己变成密文');
      lines.push('  影响：任何能读到该文件的进程，以及**每一份备份包与快照**，'
        + '都连带拿到了调用上游内核的凭据');
      lines.push('  → 一条命令就地封存（读出来 → 加密 → 写回；令牌不经过剪贴板、也不打屏）：'
        + ' `node tools/seal-kernel-token.mjs`（默认只报告，加 `--apply --force` 才写）');
    } else if (cipher) {
      lines.push('✓ 令牌以**密文**落盘（`dshTokenCipher`，AES-256-GCM），明文键已删除');
    } else {
      lines.push('· 配置里没有内核令牌（尚未接入内核，或令牌来自环境变量）');
    }
    // 这一条容易被忽略，且很容易被误读成"保存没生效" —— 所以放在自检里而不是只写文档。
    // 0.21.3 起语义变了：内核连接**保存即生效**（门面热切换），不再是"只读一次"。
    lines.push('  注：令牌与地址**保存即生效**（0.21.3 起门面支持热切换，无需重启进程；'
      + '在途回合会用切换前的内核跑完）。唯一的例外是被**环境变量**覆盖的键 —— '
      + '那种情况下页面上保存永远不会生效，概览页会据此提示');

    add(15, '内核令牌落盘卫生', level, lines);
  } catch (e) {
    add(15, '内核令牌落盘卫生', 'warn', ['· 配置读取失败：' + e.message]);
  }

  const fails = items.filter((i) => i.level === 'fail').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  return { items, fails, warns, ok: fails === 0 };
}

/** 纯文本打印（可直接整段发给管理员） */
export function printCheck(result, meta = {}) {
  plain('');
  plain('STI HARNESS 部署自检' + (meta.version ? '（版本 ' + meta.version + '）' : ''));
  plain('时间 ' + new Date().toISOString());
  plain('='.repeat(64));
  for (const it of result.items) {
    const mark = { ok: '✓', warn: '!', fail: '×', info: '·' }[it.level] || '·';
    plain('');
    plain('[' + it.n + '] ' + mark + ' ' + it.title);
    for (const l of it.lines) plain('    ' + l);
  }
  plain('');
  plain('='.repeat(64));
  if (result.fails) plain('结果：发现 ' + result.fails + ' 个阻塞问题，' + result.warns + ' 个提示。');
  else if (result.warns) plain('结果：无阻塞问题，' + result.warns + ' 个提示（上面标 ! 的项建议看一眼）。');
  else plain('结果：未发现阻塞问题。');
  plain('');
}

export const _internals = { path };

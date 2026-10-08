/**
 * STI HARNESS 进程入口。
 *
 * 职责：配置装配 → 数据目录/迁移/密钥就位 → 内核选择 → 起 HTTP 服务 → 优雅退出。
 * `--check` 走同一套装配，但只做自检、不监听端口。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
// ⚠️ 必须第一个 import：收敛 node:sqlite 的实验性警告（详见该文件说明）
import './util/quiet-warnings.mjs';

import process from 'node:process';
import { loadConfig, checkNodeVersion, readRawConfigFile, writeConfigFile } from './config.mjs';
import { log, plain, setLevel } from './log.mjs';
import {
  ensureRuntimeDirs, readVersion, DATA_DIR, DB_FILE, SECRET_FILE,
  DB_BASENAME, findNonCanonicalDb, WORKSPACE_DIR,
} from './paths.mjs';
import { openDb, closeDb } from './data/db.mjs';
import { migrate, migrationStatus } from './data/migrate.mjs';
import { ensureSecret, secretInfo } from './data/secret.mjs';
import { decryptSecret, encryptSecret, cipherKid } from './platform/identity/credentials.mjs';
import { reencryptSecrets } from './platform/operation/keyrotate.mjs';
import { createServer } from './http/server.mjs';
import { formatChain } from './http/middleware/registry.mjs';
import { runCheck, printCheck } from './diagnostics.mjs';
// 装配图（平台服务 + 内核）单点在 app/compose/ —— main 只保留"步骤"（P2-13）
import { buildServices } from './compose/services.mjs';
import { composeKernel, reloadKernel } from './compose/kernel.mjs';

const VERSION = readVersion();

function parseArgs(argv) {
  const out = { check: false, help: false, version: false, port: null };
  for (const a of argv) {
    if (a === '--check' || a === '-c') out.check = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
  }
  return out;
}

function usage() {
  plain('');
  plain('STI HARNESS ' + VERSION + ' · 企业级时空智能体生产平台');
  plain('');
  plain('用法：');
  plain('  node app/main.mjs             启动服务（默认 http://127.0.0.1:3090）');
  plain('  node app/main.mjs --check     只做环境自检，不启动服务');
  plain('  node app/main.mjs --version   显示版本');
  plain('  node app/main.mjs --help      显示本帮助');
  plain('');
  plain('环境变量：');
  plain('  STI_HOST      监听地址（默认 127.0.0.1；多用户部署需配 TLS 反代）');
  plain('  STI_PORT      监听端口（默认 3090）');
  plain('  STI_DATA_DIR  数据目录（默认 ./data）');
  plain('  STI_WORKSPACE_DIR  初始化时默认工作区的工作目录（默认 <数据目录>/workspace）');
  plain('  STI_LOG_LEVEL debug | info | warn | error（默认 info）');
  plain('  DSH_ORIGIN    上游内核地址，可整段带 ?token=…');
  plain('  DSH_TOKEN     上游内核令牌（与上面二选一）');
  plain('');
  plain('数据目录结构：data/（SQLite 库、storage/ 文件、.secret 主密钥）');
  plain('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { usage(); return 0; }
  if (args.version) { plain(VERSION); return 0; }

  if (process.env.STI_LOG_LEVEL) setLevel(process.env.STI_LOG_LEVEL);

  // ── 启动前的硬门禁：Node 版本 ─────────────────────────────────
  const node = checkNodeVersion();
  if (!node.ok) {
    console.error('');
    console.error('[x] Node.js 版本过低：当前 ' + node.current + '，需要 ≥ ' + node.required);
    console.error('    node:sqlite 自 ' + node.required + ' 起无需实验性开关即可使用。');
    console.error('    请从 https://nodejs.org 安装 LTS 版本后重试。');
    console.error('');
    process.exitCode = 1;
    return 1;
  }

  // ── 配置 ─────────────────────────────────────────────────────
  const config = loadConfig();
  if (args.port) { config.values.port = args.port; config.sources.port = 'cli'; }

  // ── 数据目录 + 主密钥 + 数据库 + 迁移 ─────────────────────────
  let migration = { applied: [], problems: [] };
  try {
    const created = ensureRuntimeDirs();
    if (created.length) log.info('已创建运行时目录：' + created.length + ' 个');
    const sec = ensureSecret(SECRET_FILE);
    if (!sec.ok) throw new Error(sec.error);
    if (sec.created) log.info('已生成主密钥 data/.secret（权限 0600）—— 备份时必须包含它');
    openDb(DB_FILE);
    migration = migrate({ onApply: (f) => log.info('已应用迁移 ' + f.file) });
    if (migration.applied.length) log.info('迁移完成，共应用 ' + migration.applied.length + ' 个');
    // 更名后：数据目录里可能有**改名前建立的库文件**。只报告、不自动采纳（见 paths.mjs 说明）。
    const stray = findNonCanonicalDb();
    if (stray.length) {
      log.warn('数据目录里有非规范命名的库文件：' + stray.join('、')
        + '（规范名 ' + DB_BASENAME + '）。本版本不会自动使用它们；'
        + '若那是你的旧数据，先停服务，再跑 node tools/adopt-data-dir.mjs --dry-run 看迁移计划。');
    }
  } catch (e) {
    if (e && e.code === 'MIGRATION_REJECTED') {
      log.error('数据库迁移被拒绝执行：');
      for (const p of (e.problems || [])) log.error('  · ' + p.message);
      log.error('请按提示处理（通常是有人改动了已应用过的迁移文件）。');
    } else {
      log.error('初始化失败：' + e.message);
    }
    process.exitCode = 1;
    return 1;
  }

  // ── 平台服务装配（装配图单点在 app/compose/services.mjs）──────
  let services;
  try {
    services = buildServices({ config });
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return 1;
  }
  const { masterSecret, keyring, identity, model, knowledge, workspace, governance, operation, notify, schedule } = services;

  // ── 内核（令牌解密 → 选型 → 契约层能力闸，见 app/compose/kernel.mjs）──
  let kernel;
  try {
    kernel = await composeKernel({ config, keyring });
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return 1;
  }

  // ── 自检模式 ─────────────────────────────────────────────────
  if (args.check) {
    const server = createServer({
      config, kernel, identity, knowledge, workspace, governance, operation, model, schedule, notify,
      paths: { DATA_DIR }, startedAt: Date.now(),
      // 换内核是**能力**而不是实现：路由层只说"现在切一下"，怎么重新装配属于
      // compose 层（与 decryptMcpConfig / encryptSecret 同一条纪律 —— 注入能力，
      // 不注入内部结构）。热切换的语义见 compose/kernel.mjs 的 reloadKernel。
      switchKernel: () => reloadKernel({ config, keyring, kernel }),
      masterSecret,
      decryptMcpConfig: (cipher) => { try { return decryptSecret(cipher, keyring); } catch { return null; } },
      // 路由层要"加密一个值"，但不该拿到主密钥本身 —— 注入的是能力，不是秘密。
      // （知识库接入向导用它把内核令牌以密文写进 config.json。）
      encryptSecret: (plain) => encryptSecret(plain, masterSecret),
    });
    const result = await runCheck({
      config, kernel, identity, knowledge, governance, operation, schedule, notify,
      router: server.router, pipeline: server.pipeline, startedAt: Date.now(),
    });
    printCheck(result, { version: VERSION });
    // 关键状态再做一次简短汇总，便于一眼确认
    const si = secretInfo(SECRET_FILE);
    plain('提示：主密钥指纹 ' + (si.exists ? si.fingerprint : '(未生成)')
      + '｜迁移 ' + migrationStatus().currentVersion
      + '｜内核 ' + (kernel.ready ? '已接入' : '未接入')
      + '｜数据目录 ' + DATA_DIR);
    plain('');
    // ⚠️ 必须关掉 worker 池：线程默认会让进程保持存活，--check 会因此**挂住不退出**。
    await knowledge.close();
    closeDb();
    process.exitCode = result.ok ? 0 : 1;
    return process.exitCode;
  }

  // ── 启动服务 ─────────────────────────────────────────────────
  const startedAt = Date.now();
  const { server, router, pipeline } = createServer({
    config, kernel, identity, knowledge, workspace, governance, operation, model, schedule, notify,
    paths: { DATA_DIR }, startedAt,
    // 换内核的能力（实现见 compose/kernel.mjs 的 reloadKernel）
    switchKernel: () => reloadKernel({ config, keyring, kernel }),
    masterSecret,
    decryptMcpConfig: (cipher) => { try { return decryptSecret(cipher, keyring); } catch { return null; } },
    encryptSecret: (plain) => encryptSecret(plain, masterSecret),
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.values.port, config.values.host, resolve);
  }).catch((e) => {
    if (e.code === 'EADDRINUSE') {
      log.error('端口 ' + config.values.port + ' 已被占用。换个端口：STI_PORT=3091 node app/main.mjs');
    } else {
      log.error('监听失败：' + e.message);
    }
    throw e;
  });

  const stats = router.stats();
  const shown = config.values.host === '0.0.0.0' || config.values.host === '::' ? '127.0.0.1' : config.values.host;
  plain('');
  plain('STI HARNESS ' + VERSION + ' 已启动');
  plain('  地址        http://' + shown + ':' + config.values.port);
  plain('  内核        ' + (kernel.ready ? '已接入' : '未接入')
    + (kernel.reason ? '（' + kernel.reason.slice(0, 60) + (kernel.reason.length > 60 ? '…' : '') + '）' : ''));
  plain('  数据目录    ' + DATA_DIR);
  plain('  路由        ' + stats.total + ' 条（' + Object.entries(stats.byMilestone).map(([k, v]) => k + ' ' + v).join('，') + '）');
  plain('  中间件      ' + formatChain(pipeline.chains.session));
  plain('  自检        node app/main.mjs --check');
  plain('  停止        Ctrl+C');
  plain('');

  // ── 默认工作区（0.21.1）──────────────────────────────────────
  // 与下面的定时任务播种同一个位置、同一条理由：**只在实际服务模式做** ——
  // `--check` 必须保持只读，否则跑一次自检就改了数据目录。
  //
  // 幂等：该组织已经有工作区就一步不动（判定是一次 SELECT）。
  // 新装平台的"第一次"由初始化向导负责（那时才有组织与管理员可记），
  // 这里补的是**已经初始化过、但还没有工作区**的库（升级上来的库）。
  //
  // ⚠️ 0.21.9：它**不再**顺带播一条落脚会话（用户裁定：初始化后只有默认工作区，
  // 不再有默认会话）。此前那一步的判据是"整个平台零会话"，连带平台侧也没了 ——
  // 现在这里只做一件事：**没有工作区就补一个**。
  try {
    const seeded = Object.entries(workspace.ensureDefaultsForAllTenants({ cwd: WORKSPACE_DIR }))
      .filter(([, row]) => row);
    if (seeded.length) {
      log.info('已为 ' + seeded.length + ' 个组织建立默认工作区（工作目录 ' + WORKSPACE_DIR + '）');
    }
  } catch (e) {
    // 补默认工作区失败不该拦住平台本身，但必须吵出来 —— 静默的话
    // 用户看到的就是"左栏永远空着"，且没有任何线索。
    log.error('建立默认工作区失败（平台其他功能不受影响）：' + (e && e.message));
  }

  // ── 定时任务（P1-2）──────────────────────────────────────────
  // 先播种默认任务（幂等），再启动调度器。
  // ⚠️ 只在实际服务模式做，`--check` 模式不写库也不起定时器 ——
  //    自检必须保持"只读"，否则跑一次自检就改了数据目录。
  try {
    const seeded = schedule.ensureDefaultsForAllTenants();
    const names = Object.values(seeded).flat();
    if (names.length) log.info('已为组织播种默认定时任务：' + names.length + ' 个');
    schedule.start();
    log.info('定时任务调度器已启动（每 ' + schedule.tickMs() + ' ms 扫描一次；单进程，进程停止即不执行）');
  } catch (e) {
    // 调度器起不来不该拦住平台本身 —— 但它必须吵出来，不能静默
    log.error('定时任务调度器启动失败（平台其他功能不受影响）：' + (e && e.message));
  }

  // ── 后台重加密（P1-8）────────────────────────────────────────
  // 放到事件循环里、启动流程之后：不阻塞监听，也不拖慢启动。
  // 幂等且无后台状态，每次启动扫一遍；全部是当前 kid 时零写入。
  setImmediate(() => {
    let r;
    try {
      r = reencryptSecrets({
        keyring, decryptSecret, encryptSecret, cipherKid,
        config: { raw: readRawConfigFile, write: writeConfigFile },
      });
    } catch (e) {
      log.warn('主密钥轮换：本轮后台重加密未完成：' + e.message);
      return;
    }
    if (r.rewrapped > 0) {
      log.info('主密钥轮换：已将 ' + r.rewrapped + ' 项密文重加密为当前密钥'
        + '（历史无 kid 格式 ' + r.legacyRewrapped + ' 项、旧密钥格式 ' + r.foreignRewrapped
        + ' 项' + (r.configRewrapped ? '、含配置文件令牌 1 项' : '') + '）。');
    }
    if (r.failures.length > 0) {
      log.warn('主密钥轮换：' + r.failures.length + ' 项密文当前解不开，已保持原样（不丢数据）：'
        + r.failures.slice(0, 5).map((f) => f.table + '/' + f.name).join('、')
        + (r.failures.length > 5 ? ' 等' : '')
        + '。请把对应的旧密钥补进 STI_OLDER_SECRETS 后重启。');
    } else if (keyring.older.length && r.rewrapped > 0) {
      log.info('主密钥轮换：全部存量密文已归位为当前密钥，确认无误后可移除 STI_OLDER_SECRETS 里的旧密钥。');
    }
  });

  // ── 优雅退出 ─────────────────────────────────────────────────
  //
  // 两个刻意的做法（2026-10 安全评审 P0-3 / P1-5）：
  //   1. **退出码必须说实话**：正常信号（SIGINT/SIGTERM）干净退出 = 0；
  //      未捕获异常或退出超时强退 = 1。以前所有路径都 exit(0)，
  //      守护进程的"失败自动重启 / 告警"会把崩溃误读成正常退出。
  //   2. **主动排空，不干等 5 秒**：server.close() 会等所有 keep-alive 与 SSE
  //      自行关闭，以前几乎必然拖到超时。现在立即 closeIdleConnections()
  //      结束空闲连接，只给**在途**回合留出排空时间；到点 closeAllConnections() 强结。
  let closing = false;
  const shutdown = (signal, wantedCode = 0) => {
    if (closing) return;
    closing = true;
    log.info('收到 ' + signal + '，正在优雅退出…');

    let settled = false;
    const t = setTimeout(() => {
      // 超时强退本身是**异常事件**（有在途工作没来得及完成），退出码必须是 1 ——
      // 即使最初来自正常信号：干净退出不会走到这里。
      log.warn('退出超时，强制结束在途连接');
      finalize(wantedCode || 1, true);
    }, 5000);
    t.unref?.();

    // 先停调度器（避免关库之后还有任务在跑），再停 worker 线程池，最后关数据库 ——
    // 反过来的话，正在写入的摄取任务会撞上已关闭的连接。
    function finalize(code, fromTimeout = false) {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      Promise.resolve()
        .then(() => schedule.close())
        .catch(() => { /* 关调度器失败不阻塞退出 */ })
        .then(() => knowledge.close())
        .catch(() => { /* 关池失败不阻塞退出 */ })
        .then(() => {
          try { closeDb(); } catch { /* ignore */ }
          log.info('已停止。');
          process.exit(code);
        });
      if (fromTimeout) {
        try { server.closeAllConnections(); } catch { /* 旧版本兜底：直接退出 */ }
      }
    }

    server.close(() => finalize(wantedCode));
    // 主动排空第一步：立即关掉空闲的 keep-alive 连接（它们没有在途工作，
    // 但会让 server.close 的回调迟迟不触发）。只保留在途 SSE / 回合连接。
    try { server.closeIdleConnections(); } catch { /* Node < 18.20 无此方法，干等兜底 */ }
    // 不再接受新连接；在途连接由上方超时与 closeAllConnections 收口
  };
  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));

  process.on('unhandledRejection', (r) => {
    log.error('未处理的 Promise 拒绝：' + (r && r.message ? r.message : String(r)));
  });
  process.on('uncaughtException', (e) => {
    log.error('未捕获异常：' + (e && e.stack ? e.stack : String(e)));
    // 崩溃路径退出码必须非 0（P0-3），守护进程据此重启与告警
    shutdown('uncaughtException', 1);
  });

  return 0;
}

main().then((code) => {
  if (typeof code === 'number' && code !== 0) process.exitCode = code;
}).catch((e) => {
  console.error('');
  console.error('[x] 启动失败：' + (e && e.stack ? e.stack : String(e)));
  console.error('');
  process.exitCode = 1;
});

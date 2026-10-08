/**
 * 数据目录采纳工具 —— 把**非规范命名**的库文件认成规范名（更名后的升级通道）。
 *
 * 用法：
 *   node tools/adopt-data-dir.mjs [--data-dir <目录>] [--dry-run]
 *
 * 背景：本产品做过一次**更名**，库文件名随之改变。更名前建立的库文件不会被自动使用
 * （见 `app/paths.mjs` 的 `findNonCanonicalDb` 说明：替使用者挑库文件是最容易造成
 * 「我的数据怎么不对」的那类魔法）。本工具是那条路的手动出口。
 *
 * ── 为什么用 `VACUUM INTO` 而不是复制文件 ────────────────────────────
 * 本工具最初写的是 `fs.copyFileSync`，并且会在"存在非空 -wal"时拒绝执行。
 * 那次拒绝**当场救了一例真实数据**：使用者的主库 360KB，而 `-wal` 有 684KB ——
 * 意味着绝大部分近期提交都还在 WAL 里没并回主库；按"复制 .db"做会**静默丢掉那 684KB**。
 * 正确做法不是把这种情况推给使用者去"停服务再试"，而是换一个对的原语：
 * `VACUUM INTO` 产出的是**事务一致**的单文件快照，WAL 里的内容包含在内，
 * 且在服务运行中同样安全（备份功能用的就是它，见 `platform/operation/backup.mjs`）。
 *
 * ── 三条硬约束（设计上刻意如此）────────────────────────────────────
 *  1. **绝不删除原件**。产出快照后原件原地留着 —— 删不删由使用者自己决定，不由工具代劳。
 *  2. **绝不覆盖**。规范名文件已存在 → 直接拒绝（与 `backup.mjs` 的防误覆盖同款）。
 *  3. **不猜**。目录里若同时存在多个候选，报"无法判定"并列出它们，不挑一个。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_BASENAME } from '../app/paths.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const di = argv.indexOf('--data-dir');
const dataDir = di >= 0 && argv[di + 1] ? path.resolve(argv[di + 1]) : DATA_DIR;

console.log('数据目录 :', dataDir);
console.log('规范库名 :', DB_BASENAME);
console.log('模式     :', dryRun ? '--dry-run（只看计划，不写任何文件）' : 'VACUUM INTO 快照 + 校验（不删原件）');
console.log('');

if (!fs.existsSync(dataDir)) {
  console.error('✗ 数据目录不存在：' + dataDir);
  process.exit(1);
}

const candidates = fs.readdirSync(dataDir).filter((n) => /\.db$/.test(n) && n !== DB_BASENAME).sort();
const canonicalAbs = path.join(dataDir, DB_BASENAME);

if (!candidates.length) {
  console.log(fs.existsSync(canonicalAbs)
    ? '✓ 数据目录里没有需要采纳的库文件（已经是规范名）。'
    : '✓ 数据目录里没有任何库文件 —— 首次启动会自动创建一个空的规范名库。');
  process.exit(0);
}
if (candidates.length > 1) {
  console.error('✗ 目录里有多个非规范库文件，本工具不替你挑：');
  for (const c of candidates) console.error('    · ' + c);
  console.error('  请先自行确认该用哪个（把其余的移走），再重跑。');
  process.exit(1);
}

const srcName = candidates[0];
const srcAbs = path.join(dataDir, srcName);

// 约束 2：绝不覆盖既有规范名库
if (fs.existsSync(canonicalAbs)) {
  console.error('✗ 规范名文件已存在：' + DB_BASENAME + '（防误覆盖，本工具不覆盖既有库）');
  console.error('  要采纳 ' + srcName + '，请先把现有的 ' + DB_BASENAME + ' 移走。');
  process.exit(1);
}

// 把"是否还在写"如实报告出来（VACUUM INTO 不需要它停下，但使用者该知道当前是什么状态）
const walAbs = srcAbs + '-wal';
const walBytes = fs.existsSync(walAbs) ? fs.statSync(walAbs).size : 0;
console.log('计划：');
console.log('  源    ' + srcName + '（主文件 ' + fs.statSync(srcAbs).size + ' 字节'
  + (walBytes ? '，另有未检查点的 -wal ' + walBytes + ' 字节' : '，无未检查点的 -wal') + '）');
console.log('  产出  ' + DB_BASENAME + ' —— 由 `VACUUM INTO` 生成的事务一致单文件快照');
if (walBytes) {
  console.log('        （-wal 里的提交**会一并包含**在快照里；这正是不能用"复制 .db"的原因）');
}
console.log('  ⚠ 原件 ' + srcName + ' 保留不动；确认无误后由你自己删除。');
console.log('  ⚠ .secret（主密钥）在**原位**，本工具不碰它 —— 别把库和主密钥分开。');
console.log('');

if (dryRun) {
  console.log('（--dry-run：到此为止，没有写任何文件。）');
  process.exit(0);
}

// 用 `VACUUM INTO` 产出快照。只读打开源库：本操作只读源、只写目标。
let snap = null;
try {
  const db = new DatabaseSync(srcAbs, { readOnly: true });
  try {
    db.exec("VACUUM INTO '" + canonicalAbs.replace(/'/g, "''") + "'");
    snap = fs.statSync(canonicalAbs).size;
  } finally {
    db.close();
  }
} catch (e) {
  console.error('✗ 生成快照失败：' + e.message);
  if (fs.existsSync(canonicalAbs)) console.error('  已产生的 ' + DB_BASENAME + ' 可能不完整，请自行删除；原件未动。');
  process.exit(1);
}

// 快照后立即自证：只读打开 + integrity_check + 迁移表与计数必须在
let verdict = null;
try {
  const db = new DatabaseSync(canonicalAbs, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const mig = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    const migRows = mig && mig.n ? db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() : { n: 0 };
    verdict = {
      integrity: (integrity && integrity.integrity_check) || '(无返回)',
      hasMigrations: !!(mig && mig.n),
      migrations: (migRows && migRows.n) || 0,
    };
  } finally {
    db.close();
  }
} catch (e) {
  console.error('✗ 快照打不开：' + e.message);
  console.error('  已写入的 ' + DB_BASENAME + ' 请自行删除或保留排查；原件未动。');
  process.exit(1);
}

if (verdict.integrity !== 'ok' || !verdict.hasMigrations) {
  console.error('✗ 自证未通过：integrity_check=' + verdict.integrity
    + '，迁移表=' + (verdict.hasMigrations ? '有' : '**没有**'));
  console.error('  这不是一个本产品的库。已写入的 ' + DB_BASENAME + ' 请自行删除；原件未动。');
  process.exit(1);
}

console.log('✓ 已生成快照并通过自证');
console.log('  快照大小        : ' + snap + ' 字节');
console.log('  integrity_check : ' + verdict.integrity);
console.log('  已应用迁移      : ' + verdict.migrations + ' 条');
console.log('');
console.log('下一步：');
console.log('  1) node app/main.mjs --check        # 确认自检无阻塞问题');
console.log('  2) 启动服务，确认数据齐全');
console.log('  3) 确认无误后再自行删除原件 ' + srcName
  + (walBytes ? ' 及其 -wal / -shm' : ''));
console.log('');
console.log('⚠ 更名同时改了**令牌前缀**：更名前签发的会话令牌与 API Key 不再被接受。');
console.log('  账号与密码不受影响（在 users 表里），重新登录即可；API Key 需要重新签发。');

/**
 * 路径推导 —— 全项目唯一允许出现「目录从哪来」的地方。
 *
 * 纪律（沿用同权利人早期作品的部署经验）：**源码里不得出现任何写死的绝对路径 / 用户名**。
 * 所有位置都按运行时信息推导，换盘符、换目录名、换机器都不影响。
 * 唯一的例外是 `STI_DATA_DIR` 环境变量（部署者显式指定数据目录时用）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** .../sti-harness/app */
export const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
/** .../sti-harness */
export const ROOT = path.dirname(APP_DIR);
/** 前端产物目录 */
export const PUBLIC_DIR = path.join(ROOT, 'public');
/** 迁移脚本目录 */
export const MIGRATIONS_DIR = path.join(APP_DIR, 'data', 'migrations');
/** 版本号单点维护文件 */
export const VERSION_FILE = path.join(ROOT, 'VERSION');

/** 运行时数据根目录。默认在项目根的 `data/`；可用 STI_DATA_DIR 指到别处。 */
export const DATA_DIR = process.env.STI_DATA_DIR
  ? path.resolve(process.env.STI_DATA_DIR)
  : path.join(ROOT, 'data');

/** SQLite 库文件**规范名**（改名后唯一认可的库文件名；备份包内条目名同此）。 */
export const DB_BASENAME = 'sti-harness.db';
/** SQLite 库文件（业务数据全部在这里） */
export const DB_FILE = path.join(DATA_DIR, DB_BASENAME);

/**
 * 列出数据目录里**不是规范名**的库文件（只返回文件名，不返回路径）。
 *
 * 为什么只报告、不自动采纳 —— 产品更名后，更名前建立的库文件名与规范名不同。
 * 替使用者"自动挑一个库文件来用"是最容易造成「我的数据怎么不对」的那类魔法，
 * 尤其当目录里同时存在多个 `.db` 时。所以这里只回答"发现了什么"，
 * 采纳与否交给 `tools/adopt-data-dir.mjs`（而它也**只复制 + 校验，不删原件**）。
 */
export function findNonCanonicalDb(dataDir = DATA_DIR) {
  try {
    return fs.readdirSync(dataDir).filter((n) => /\.db$/.test(n) && n !== DB_BASENAME).sort();
  } catch {
    return [];
  }
}
/** AES-256-GCM 主密钥。首次启动生成，权限 0600。**丢失 = 凭据不可解**。 */
export const SECRET_FILE = path.join(DATA_DIR, '.secret');
/**
 * 备份独立密钥（2026-10 安全评审 P1-7）：**刻意与 .secret 分开**的另一把密钥，
 * 首次用于备份时生成。它只加密备份包，不加密平台在线凭据。
 */
export const BACKUP_KEY_FILE = path.join(DATA_DIR, 'backup.key');
/** 文件存储根（上传 / 产物 / 索引） */
export const STORAGE_DIR = path.join(DATA_DIR, 'storage');
export const UPLOAD_DIR = path.join(STORAGE_DIR, 'uploads');
export const ARTIFACT_DIR = path.join(STORAGE_DIR, 'artifacts');

/**
 * 默认工作区的工作目录（初始化时自动建立的那个工作区的落点，0021 / 0.21.1）。
 *
 * 为什么给它一个**固定**目录，而不是 `process.cwd()`：
 * 工作区 cwd 决定上游项目级能力能读写哪一片文件系统。用"启动时的当前目录"当默认值，
 * 等于把一个取决于"从哪儿敲的命令"的东西写成了一条**持久配置** ——
 * 换个目录启动，同一个工作区就悄悄指向了别处。随数据目录走的固定落点才是可预期的，
 * 也不会让新装的平台默认拿到用户的整个主目录。
 *
 * 要指到别处有两个办法（都不需要改源码）：`STI_WORKSPACE_DIR` 环境变量，
 * 或者在工作台里对着那个工作区点「⋯」→「工作目录…」改它的 cwd。
 */
export const WORKSPACE_DIR = process.env.STI_WORKSPACE_DIR
  ? path.resolve(process.env.STI_WORKSPACE_DIR)
  : path.join(DATA_DIR, 'workspace');

/** 日志目录（M0 暂只写控制台；落盘留给 M3 的审计之外的可观测性） */
export const LOG_DIR = path.join(DATA_DIR, 'logs');
/**
 * 审计归档目录（P1-2）。超期审计写成 JSONL 只读副本后从主表删除。
 * ⚠️ 它与数据库在同一台机器上 —— 因此它**不是**防篡改的最终手段
 * （见 audit.mjs 的诚实边界）。要真正防"整表重写"，这个目录应挂到
 * 只读介质或异地，或把锚点出站到外部。
 */
export const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
/**
 * 审计链尾锚点目录（P1-2）。每日一份 JSON，记录当日链尾 hash 与记录数。
 * 同样受上面那条边界约束：锚点没离开这台机器就等于没锚。
 */
export const ANCHOR_DIR = path.join(DATA_DIR, 'anchor');

/** 运行时必须存在的目录（启动时统一创建） */
export const RUNTIME_DIRS = [DATA_DIR, STORAGE_DIR, UPLOAD_DIR, ARTIFACT_DIR, LOG_DIR, ARCHIVE_DIR, ANCHOR_DIR, WORKSPACE_DIR];

/**
 * 确保运行时目录存在。目录不可写时**抛出**而不是静默继续 ——
 * 宁可启动失败并说清原因，也不要在第一次写库时才报一个看不懂的错。
 */
export function ensureRuntimeDirs() {
  const created = [];
  for (const d of RUNTIME_DIRS) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      created.push(d);
    }
  }
  // 可写性实测：真写一个探针文件，而不是只看 stat
  const probe = path.join(DATA_DIR, '.write-probe');
  try {
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
  } catch (e) {
    const err = new Error('数据目录不可写：' + DATA_DIR + '（' + e.message + '）');
    err.code = 'DATA_DIR_NOT_WRITABLE';
    throw err;
  }
  return created;
}

/** 读版本号。文件缺失或为空时返回 '0.0.0-dev'，不抛异常。 */
export function readVersion() {
  try {
    const v = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    return v || '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

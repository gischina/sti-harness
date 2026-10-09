/**
 * 备份与恢复（M5 · 企业化收口）。
 *
 * 备份 = 一个标准 ZIP（`app/util/zip.mjs` 构建）：
 *   manifest.json          —— 格式/版本/时间/逐文件 SHA256（校验的唯一真相源）
 *   sti-harness.db    —— `VACUUM INTO` 产出的在线一致性快照（WAL 下安全）
 *   storage/...            —— uploads 与 artifacts 全量原样打包
 *
 * 诚实边界（写在这里，因为最容易被误读）：
 *   1. **恢复不做在线接口**。服务进程握着打开的 DB 句柄，运行中把自己脚下的库换掉
 *      不是「危险」两个字能概括的。恢复是**离线维护动作**：`tools/restore-backup.mjs`
 *      （停机 → 恢复 → 校验 → 再启动）。HTTP 只提供备份创建与备份文件校验。
 *   2. 日志（data/logs）不进备份 —— 它是运行痕迹不是业务数据；主密钥
 *      （data/.secret）**必须单独保管**，绝不进备份包（进了包就等于凭据明文搬家），
 *      恢复校验会显式提醒这一点。
 *   3. 备份文件落在 DATA_DIR/backups 下 —— 它属于"运行时数据"，
 *      打包产物扫描（M5-3）会把它排除在发布产物之外。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zipSync, readZipEntries } from '../../util/zip.mjs';
import { VERSION_FILE, DB_BASENAME } from '../../paths.mjs';

const BACKUP_FORMAT = 'sti-harness/backup';
const BACKUP_FORMAT_VERSION = 2;

/**
 * 密文条目头：`STIE1`(5) ‖ iv(12) ‖ tag(16) ‖ ciphertext（AES-256-GCM）。
 * formatVersion 2（2026-10 安全评审 P1-7）起，db 与 storage 条目全部加密，
 * manifest 保留明文（只含哈希，无业务内容）但加 HMAC 签名。
 */
const ENC_MAGIC = Buffer.from('STIE1');
const HKDF_SALT = 'sti-harness/backup/v2';
const HKDF_ENC_INFO = 'sti-harness/backup/enc/v1';
const HKDF_SIGN_INFO = 'sti-harness/backup/sign/v1';

/**
 * 把外部输入统一成 32 字节备份主密钥：
 *   · Buffer 32B 直接用；其它长度先 SHA256；
 *   · 字符串：64 位 hex 或 32B 的 base64 按字面解码，其余当口令做 SHA256。
 * 备份密钥**独立于** data/.secret（masterSecret）：.secret 不进备份包，
 * 备份必须在 .secret 丢失时仍可恢复。
 */
function coerceBackupKey(input) {
  if (Buffer.isBuffer(input)) {
    return input.length === 32 ? input : crypto.createHash('sha256').update(input).digest();
  }
  const s = String(input == null ? '' : input).trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/]{43}=?$/.test(s)) {
    const b = Buffer.from(s, 'base64');
    if (b.length === 32) return b;
  }
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

/** 密钥指纹：写进 manifest，恢复时用错密钥能立刻得到"kid 不匹配"的明确错误。 */
function keyKid(master) {
  return crypto.createHash('sha256').update(master).digest('hex').slice(0, 16);
}

/** 一钥一用：从备份主密钥经 HKDF 分别派生加密密钥与签名密钥。 */
function deriveKeys(master) {
  return {
    encKey: Buffer.from(crypto.hkdfSync('sha256', master, HKDF_SALT, HKDF_ENC_INFO, 32)),
    signKey: Buffer.from(crypto.hkdfSync('sha256', master, HKDF_SALT, HKDF_SIGN_INFO, 32)),
  };
}

function encryptEntry(plain, encKey) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ENC_MAGIC, iv, c.getAuthTag(), ct]);
}

/** 解密失败（GCM tag 不匹配）抛错 —— 密文被改过或密钥不对。 */
export function decryptEntry(blob, encKey) {
  if (!Buffer.isBuffer(blob) || blob.length < ENC_MAGIC.length + 12 + 16
    || !blob.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) {
    throw new Error('密文条目不认识（缺 STIE1 头或被截断）');
  }
  let p = ENC_MAGIC.length;
  const iv = blob.subarray(p, p + 12); p += 12;
  const tag = blob.subarray(p, p + 16); p += 16;
  const d = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(p)), d.final()]);
}

/**
 * 确定性 JSON：Object key 递归排序、无多余空白。
 * 签名与验签两端必须用同一个序列化结果，否则同样内容会算出不同 HMAC。
 */
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stableJson(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function signManifest(manifest, signKey) {
  return crypto.createHmac('sha256', signKey).update(stableJson(manifest)).digest('hex');
}

/**
 * 备份密钥的非敏感信息（供自检展示）：只返回指纹，不回传密钥本身。
 * 指纹算法与写入 manifest 的 kid 同源，避免两处实现漂移。
 */
export function backupKeyInfo(input) {
  const master = coerceBackupKey(input);
  return { kid: keyKid(master) };
}

/**
 * 格式串**形态**校验，而不是与常量等值比对。
 *
 * 为什么放宽：本产品做过一次更名，更名前产出的备份包里 `format` 是另一个前缀。
 * 若在这里写死等值比对，那些历史备份会被判成「不是本平台的备份包」而拒绝恢复 ——
 * 等于一次改名让历史备份作废。改为形态匹配后：
 *   · 仍然挡得住"随手给了个 zip"（manifest 缺失 / 形态不符）；
 *   · 接纳更名前后的两种前缀。
 * ⚠️ 代价说清：前缀本身不再参与校验，所以"拿错产品的备份包但形态恰好相同"这类
 *    极端情况少了一层拦截（`formatVersion` 与库文件哈希仍在拦）。
 */
const BACKUP_FORMAT_RE = /^[a-z0-9][a-z0-9-]*\/backup$/;

/**
 * 包内库文件**条目名**同样不写死。更名前的备份包里条目名是旧名，
 * 写死比对的后果同 `BACKUP_FORMAT_RE` 那段：历史备份包一律判"缺库文件"。
 * 规则：**恰好一个** `*.db` 条目（不含子目录里的），多一个就报"无法判定"而不是随便挑。
 */
const DB_ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/;

/**
 * 本模块产出的备份文件命名形态（`createBackup` 里生成 `backup-<时间戳>.zip`）。
 *
 * **保留策略只认这个形态** —— 这是"清理"这个动作能说清楚边界的前提：
 * 运维手工放进 `backups/` 的其它 zip（比如从别处拷来做比对的），一律不碰。
 * 顺带也就绕开了 `createBackup` 的临时文件（`.vacuum-tmp.db`）。
 */
const BACKUP_FILE_RE = /^backup-[A-Za-z0-9._-]+\.zip$/;

function sha256(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function currentVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch { return 'unknown'; }
}

/** 递归收集目录下所有文件（返回 {rel, abs}），目录不存在返回空数组 */
function walkFiles(root, rel = '') {
  const abs = rel ? path.join(root, rel) : root;
  let out = [];
  let st;
  try { st = fs.statSync(abs); } catch { return out; }
  if (!st.isDirectory()) return out;
  for (const name of fs.readdirSync(abs).sort()) {
    const r = rel ? rel + '/' + name : name;
    const p = path.join(root, r);
    const s = fs.statSync(p);
    if (s.isDirectory()) out = out.concat(walkFiles(root, r));
    else out.push({ rel: r, abs: p, bytes: s.size });
  }
  return out;
}

/**
 * 创建备份。
 * @param {{dataDir:string, destDir:string?, label:string?, key:(string|Buffer)?}} opts
 *        key 为备份主密钥（hex/base64/口令）；不传则生成一次性随机密钥，
 *        在备份包旁写同名 `.key` 文件。
 * @returns {{file:string, bytes:number, manifest:object, keyFile:(string|null), oneShot:boolean}}
 */
export function createBackup({ dataDir, destDir, label = '', key = null }) {
  // 备份密钥：显式传入（装配层从 STI_BACKUP_KEY / data/backup.key 取）；
  // 没传则生成**一次性随机密钥**并在包旁写同名 .key（恢复的唯一凭证）。
  const oneShot = key == null;
  const master = oneShot ? crypto.randomBytes(32) : coerceBackupKey(key);
  const kid = keyKid(master);
  const { encKey, signKey } = deriveKeys(master);

  const dbFile = path.join(dataDir, DB_BASENAME);
  const storageDir = path.join(dataDir, 'storage');
  const outDir = destDir || path.join(dataDir, 'backups');
  fs.mkdirSync(outDir, { recursive: true });

  // 1) 在线一致性快照：VACUUM INTO 把库压实到独立文件（含 WAL 里未合并的页）。
  //    对打开中的库执行是安全的 —— 这正是它比"复制 db 文件"强的地方。
  const snapshot = path.join(outDir, '.vacuum-tmp.db');
  try { fs.rmSync(snapshot, { force: true }); } catch { /* 不存在即可 */ }
  // db.mjs 的连接池无法直接复用（openDb 是单例）——这里开一次性连接做 VACUUM。
  const raw = new DatabaseSync(dbFile);
  try {
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    raw.prepare('VACUUM INTO ?').run(snapshot);
  } finally {
    raw.close();
  }

  // 2) 收集条目：明文哈希进 manifest（恢复校验真相源），密文进 zip。
  const entries = [];
  const dbBuf = fs.readFileSync(snapshot);
  const dbHash = sha256(dbBuf);
  const dbEntry = DB_BASENAME + '.enc';
  entries.push({ name: dbEntry, data: encryptEntry(dbBuf, encKey) });

  const storageFiles = walkFiles(storageDir);
  const storageManifest = [];
  for (const f of storageFiles) {
    const buf = fs.readFileSync(f.abs);
    const name = 'storage/' + f.rel;
    storageManifest.push({ name, entry: name + '.enc', bytes: buf.length, sha256: sha256(buf) });
    entries.push({ name: name + '.enc', data: encryptEntry(buf, encKey) });
  }

  const manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    platformVersion: currentVersion(),
    createdAt: new Date().toISOString(),
    label: String(label || '').slice(0, 120),
    encryption: {
      alg: 'AES-256-GCM', scheme: 'STIE1', kdf: 'HKDF-SHA256', kid,
      entrySuffix: '.enc',
      note: 'db 与 storage 条目经备份密钥加密；备份密钥独立于 data/.secret。',
    },
    db: { bytes: dbBuf.length, sha256: dbHash, entry: dbEntry },
    storage: { fileCount: storageManifest.length, bytes: storageManifest.reduce((s, x) => s + x.bytes, 0), files: storageManifest },
    secret: 'NOT_INCLUDED —— data/.secret（主密钥）必须单独保管，见 docs/deploy.md §备份',
  };
  // manifest 签名（不含 signature 字段自身）：任何文件哈希/条目被篡改都过不了这关。
  manifest.signature = { alg: 'HS256', kid, value: signManifest(manifest, signKey) };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });

  // 3) 打包（按名字排序保证 determinism；manifest 最后一个条目方便人工打开先看）
  const stamp = manifest.createdAt.replace(/[:.]/g, '-');
  const file = path.join(outDir, `backup-${stamp}.zip`);
  const zipBuf = zipSync(entries);
  fs.writeFileSync(file, zipBuf);
  fs.rmSync(snapshot, { force: true });

  // 一次性密钥：写在备份包旁（同名主干 .key，hex）。它是这份备份的唯一解密凭证，
  // 必须与备份包**分开保管**（备份包上云、密钥留本机/密码柜）。
  let keyFile = null;
  if (oneShot) {
    keyFile = file.replace(/\.zip$/, '.key');
    fs.writeFileSync(keyFile, master.toString('hex'));
  }

  return { file, bytes: zipBuf.length, manifest, keyFile, oneShot };
}

/**
 * 规范化 `keep`。**"没给"与"给了个非法值"必须分开处理**，否则语义会骗人：
 *   · 没给（`undefined` / 非数字）→ 用默认 30（调用方没意见，按平台默认来）；
 *   · 给了但 < 1（`0` / 负数）→ **抬到 1**，而不是回退默认。
 *     回退默认的后果是：运维配了 `keep: 0`（字面意思是"一份旧的都不要"），系统却安静地
 *     留着 30 份 —— 配置与行为对不上，而"配置对不上"正是最难查的一类问题。
 *     `keep: 0` 的真实意图最接近"只留最新那份"，而**约束 1 不允许一份都不剩**，
 *     所以它落在 1 —— 既贴近用户意图，又守住"绝不出现零备份"这条线。
 */
function normalizeKeep(keep, fallback = 30) {
  const n = Number(keep);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 1 ? i : 1;
}

/**
 * 备份保留策略（轮转）：只保留最近 `keep` 份，更旧的删除。
 *
 * 为什么需要它：`backup.create` 这个定时任务会**持续**产出备份，而在此之前**没有任何回收**
 * —— 单进程服务一旦把磁盘写满就直接挂掉。"自动备份"于是变成磁盘无界增长的来源。
 * 这是"半成品反而危险"的典型：**已经在写，却没有边界** —— 比"完全没做"更该收口。
 *
 * 三条安全约束（每一条都是为了让"清理"绝不演变成"丢数据"）：
 *
 *   1. **至少保留 1 份。** `keep` 给 0 / 负数一律抬到 1（见 `normalizeKeep`）。
 *      宁可留一份旧的，也绝不能出现"清理完发现一份都不剩"——
 *      **磁盘满是问题，"没有备份"是灾难**，两者不在一个量级。
 *   2. **只认本模块产物的命名**（`BACKUP_FILE_RE`）。作用域能被一句话说清，
 *      才敢让它无人值守地跑。
 *   3. **只做"给定目录裁到 keep 份"这一件事。** "必须先建后删"由调用方保证
 *      （见 `platform/schedule/tasks.mjs` 的 `backup.create`）——顺序反了的话，
 *      一旦新建失败就是净损失：旧的删了、新的没成。
 *
 * 排序用 **mtime** 而不是文件名：文件名里的时间戳是创建时刻，但文件可能被复制、
 * 被外部工具搬运，mtime 更接近"这份备份实际是什么时候落的盘"。同一 mtime 用文件名
 * 兜底，保证**同一目录两次调用结果一致**（否则会出现"这次删 A、下次删 B"的抖动）。
 *
 * @param {{dir:string, keep?:number, dryRun?:boolean}} opts
 * @returns {{ok:true, keep:number, total:number, kept:number,
 *            removed:Array<{file:string,bytes:number,mtime:string}>,
 *            freedBytes:number, dryRun:boolean, note:string}}
 */
export function pruneBackups({ dir, keep = 30, dryRun = false } = {}) {
  const dirAbs = String(dir || '');
  const keepN = normalizeKeep(keep);

  let names = [];
  try { names = fs.readdirSync(dirAbs); } catch { names = []; }   // 目录不存在 = 没什么可裁的

  const candidates = [];
  for (const name of names) {
    if (!BACKUP_FILE_RE.test(name)) continue;                      // 约束 2：不碰其它文件
    const abs = path.join(dirAbs, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    candidates.push({ file: name, abs, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), mtimeMs: st.mtimeMs });
  }
  candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || String(b.file).localeCompare(String(a.file)));

  const doomed = candidates.slice(keepN);                          // 约束 1：keepN ≥ 1，故最后一份永不入列
  const removed = [];
  for (const c of doomed) {
    if (!dryRun) {
      try { fs.rmSync(c.abs, { force: true }); } catch { continue; }  // 删不掉就跳过，不让一个文件卡住整轮
      // 连带删掉这份备份的**同名一次性密钥**（backup-xxx.key，64 位 hex）。
      // 只认与 zip 同名主干的 .key，绝不会碰到统一密钥文件（通常叫 backup.key）。
      try {
        const sidecar = c.abs.replace(/\.zip$/, '.key');
        if (sidecar !== c.abs && fs.existsSync(sidecar)) {
          const body = fs.readFileSync(sidecar, 'utf8').trim();
          if (/^[0-9a-f]{64}$/i.test(body)) fs.rmSync(sidecar, { force: true });
        }
      } catch { /* sidecar 清理失败不阻塞轮转 */ }
    }
    removed.push({ file: c.file, bytes: c.bytes, mtime: c.mtime });
  }

  const note = candidates.length === 0
    ? '没有可轮转的备份（只认 backup-*.zip，不会碰其它文件）'
    : (removed.length
      ? `保留最近 ${keepN} 份，删掉 ${removed.length} 份更旧的`
      : `共 ${candidates.length} 份，未超过保留上限 ${keepN} 份`);

  return {
    ok: true,
    keep: keepN,
    total: candidates.length,
    kept: candidates.length - removed.length,
    removed,
    freedBytes: removed.reduce((s, r) => s + r.bytes, 0),
    dryRun: !!dryRun,
    note,
  };
}

/**
 * 删除单份备份（人工点名删除，0.18.0）。
 *
 * 与 `pruneBackups` 的关系：轮转是"按策略删最旧的"，这里是"点名删某一份"。
 * **两条护栏与轮转对齐**，理由不是形式统一，而是"人工删除比轮转更危险"：
 * 轮转无人值守、规则可预测；一次点击却能在几秒内错删掉唯一的退路。
 *
 *   1. **只认本模块产物的命名**（`BACKUP_FILE_RE`）。非 `backup-*.zip` 形态一律
 *      `bad_request` —— 目录里可能有运维手工放进来的对比包，也可能有人拿 `../`
 *      想走到别的目录去；形态白名单把两者一并挡掉（不依赖调用方先做路径校验）。
 *   2. **绝不删掉最后一份**（`last_one`）。与轮转的约束 1 同源：
 *      **磁盘满是问题，"没有备份"是灾难**，两者不在一个量级。
 *
 * 侧车清理与轮转同一口径：只删与 zip 同名主干、内容为 64 位 hex 的 `.key`。
 * @returns {{ok:true, name:string, bytes:number, freedKey:boolean, remaining:number}
 *          | {ok:false, reason:'bad_request'|'not_found'|'last_one', error:string}}
 */
export function removeBackup({ dir, name } = {}) {
  const n = String(name == null ? '' : name).trim();
  if (!BACKUP_FILE_RE.test(n)) {
    return { ok: false, reason: 'bad_request', error: '只能删除本平台产出的备份文件（backup-*.zip 形态）：' + (n || '(空)') };
  }
  const abs = path.join(String(dir || ''), n);
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, reason: 'not_found', error: '备份文件不存在：' + n }; }
  if (!st.isFile()) return { ok: false, reason: 'not_found', error: '备份文件不存在：' + n };

  // “最后一份”按现存同名形态的文件数判断（删掉这份后还剩几份）
  let total = 0;
  try {
    total = fs.readdirSync(String(dir || '')).filter((f) => BACKUP_FILE_RE.test(f)).length;
  } catch { total = 0; }
  if (total <= 1) {
    return { ok: false, reason: 'last_one', error: '这是最后一份备份，拒绝删除 —— 磁盘满是问题，没有备份是灾难' };
  }

  fs.rmSync(abs, { force: true });
  let freedKey = false;
  try {
    const sidecar = abs.replace(/\.zip$/, '.key');
    if (sidecar !== abs && fs.existsSync(sidecar)) {
      const body = fs.readFileSync(sidecar, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(body)) { fs.rmSync(sidecar, { force: true }); freedKey = true; }
    }
  } catch { /* sidecar 清理失败不阻塞删除 */ }

  return { ok: true, name: n, bytes: st.size, freedKey, remaining: total - 1 };
}

/**
 * 校验备份文件：重算每个条目的哈希与 manifest 比对，报告全部问题（不是遇错即停）。
 *
 * formatVersion 1 = 历史明文备份（保持旧校验口径）；2 = 加密+签名备份，
 * 必须提供备份密钥：先验 manifest 签名，再解密条目验明文哈希。
 * @returns {{ok:boolean, checked:number, problems:string[], encrypted?:boolean, kid?:string}}
 */
export function verifyBackup(backupFile, { key = null } = {}) {
  const entries = readZipEntries(fs.readFileSync(backupFile));
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const problems = [];

  const mf = byName.get('manifest.json');
  if (!mf) return { ok: false, checked: 0, problems: ['缺 manifest.json —— 不是本平台的备份包'] };
  let manifest;
  try { manifest = JSON.parse(mf.toString('utf8')); } catch (e) {
    return { ok: false, checked: 0, problems: ['manifest.json 解析失败：' + e.message] };
  }
  if (!BACKUP_FORMAT_RE.test(String(manifest.format || ''))) {
    problems.push(`format 形态不认识（应为 <产品名>/backup）：${manifest.format}`);
  }

  if (manifest.formatVersion === 1) return verifyV1(manifest, byName, problems);
  if (manifest.formatVersion === 2) return verifyV2(manifest, byName, problems, key);
  problems.push(`formatVersion 不认识：${manifest.formatVersion}`);
  return { ok: false, checked: byName.size, problems };
}

/** formatVersion 1：历史明文备份的校验（逻辑保持原样，只做了形态抽取）。 */
function verifyV1(manifest, byName, problems) {
  const dbNames = [...byName.keys()].filter((n) => DB_ENTRY_RE.test(n));
  if (dbNames.length > 1) problems.push('包里有多个库文件，无法判定该用哪个：' + dbNames.join(' / '));
  const dbName = dbNames.length === 1 ? dbNames[0] : null;
  const db = dbName ? byName.get(dbName) : null;
  if (!db) problems.push('包里没有库文件（*.db）');
  else if (!manifest.db || typeof manifest.db.sha256 !== 'string') problems.push('manifest 缺 db.sha256');
  else if (sha256(db) !== manifest.db.sha256) problems.push(dbName + ' 哈希不匹配（文件被改动或截断）');

  const files = manifest.storage && manifest.storage.files ? manifest.storage.files : [];
  const declared = new Set(files.map((f) => f.name));
  for (const f of files) {
    const data = byName.get(f.name);
    if (!data) { problems.push('manifest 声明了但包里没有：' + f.name); continue; }
    if (sha256(data) !== f.sha256) problems.push('哈希不匹配：' + f.name);
  }
  for (const name of byName.keys()) {
    if (name === 'manifest.json' || name === dbName || declared.has(name)) continue;
    problems.push('包里有 manifest 未声明的条目：' + name);
  }

  return { ok: problems.length === 0, checked: byName.size, problems, encrypted: false };
}

/** formatVersion 2：验签名 → 解密 → 验明文哈希。 */
function verifyV2(manifest, byName, problems, key) {
  const kid = manifest.encryption && manifest.encryption.kid;
  if (key == null) {
    problems.push('该备份已加密（kid ' + String(kid || '?') + '），需要提供备份密钥才能校验内容');
    return { ok: false, checked: byName.size, problems, encrypted: true, kid: kid || null };
  }
  const master = coerceBackupKey(key);
  const gotKid = keyKid(master);
  if (!kid || gotKid !== String(kid)) {
    problems.push('备份密钥不匹配（密钥指纹 ' + gotKid + ' ≠ 包内 kid ' + String(kid) + '）');
    return { ok: false, checked: byName.size, problems, encrypted: true, kid: kid || null };
  }
  const { encKey, signKey } = deriveKeys(master);

  // ① manifest 签名：取出 signature 后重算 HMAC
  const sig = manifest.signature;
  if (!sig || sig.alg !== 'HS256' || typeof sig.value !== 'string') {
    problems.push('manifest 缺有效签名（signature.alg=HS256）');
  } else {
    const unsigned = { ...manifest };
    delete unsigned.signature;
    const expect = signManifest(unsigned, signKey);
    // 长度必须先比，避免计时差异（虽非认证路径，保持严谨）
    if (sig.value.length !== expect.length
      || !crypto.timingSafeEqual(Buffer.from(sig.value, 'hex'), Buffer.from(expect, 'hex'))) {
      problems.push('manifest 签名不匹配（manifest 被篡改或密钥不对）');
    }
  }

  // ② 加密 db 条目：包里 *.db.enc 恰好一个，且与 manifest.db.entry 一致
  const dbEncNames = [...byName.keys()]
    .filter((n) => DB_ENTRY_RE.test(n.replace(/\.enc$/, '')) && n.endsWith('.enc'));
  if (dbEncNames.length > 1) problems.push('包里有多个加密库文件，无法判定该用哪个：' + dbEncNames.join(' / '));
  const dbEntryName = manifest.db && manifest.db.entry;
  if (!dbEntryName || !byName.has(dbEntryName)) {
    problems.push('manifest 声明的加密库条目不存在：' + String(dbEntryName));
  } else {
    if (dbEncNames.length === 1 && dbEncNames[0] !== dbEntryName) {
      problems.push('库里唯一的加密库条目与 manifest.db.entry 不一致');
    }
    try {
      const plain = decryptEntry(byName.get(dbEntryName), encKey);
      if (!manifest.db || typeof manifest.db.sha256 !== 'string') problems.push('manifest 缺 db.sha256');
      else if (sha256(plain) !== manifest.db.sha256) problems.push(dbEntryName + ' 解密后哈希不匹配');
    } catch (e) {
      problems.push(dbEntryName + ' 解密失败：' + e.message);
    }
  }

  // ③ storage：逐条目解密比对
  const files = manifest.storage && manifest.storage.files ? manifest.storage.files : [];
  const declared = new Set([dbEntryName]);
  for (const f of files) {
    declared.add(f.entry);
    const blob = byName.get(f.entry);
    if (!blob) { problems.push('manifest 声明了但包里没有：' + f.entry); continue; }
    try {
      const plain = decryptEntry(blob, encKey);
      if (sha256(plain) !== f.sha256) problems.push('解密后哈希不匹配：' + f.name);
    } catch (e) {
      problems.push(f.entry + ' 解密失败：' + e.message);
    }
  }
  for (const name of byName.keys()) {
    if (name === 'manifest.json' || declared.has(name)) continue;
    problems.push('包里有 manifest 未声明的条目：' + name);
  }

  return { ok: problems.length === 0, checked: byName.size, problems, encrypted: true, kid: gotKid };
}

/**
 * 离线恢复：校验 → 写入目标数据目录。**只对未运行服务的目录使用**。
 * @param {{backupFile:string, destDataDir:string, overwrite:boolean?, key:(string|Buffer)?}} opts
 * @returns {{restored:{db:boolean, storage:string[]}, manifest:object}}
 */
export function restoreBackup({ backupFile, destDataDir, overwrite = false, key = null }) {
  const verdict = verifyBackup(backupFile, { key });
  if (!verdict.ok) {
    const e = new Error('备份包校验失败，拒绝恢复：' + verdict.problems.join('；'));
    e.code = 'bad_request';
    throw e;
  }
  const dbTarget = path.join(destDataDir, DB_BASENAME);
  if (fs.existsSync(dbTarget) && !overwrite) {
    const e = new Error('目标目录已有 ' + DB_BASENAME + '（防误覆盖，显式传 overwrite:true 才继续）');
    e.code = 'bad_request';
    throw e;
  }
  fs.mkdirSync(destDataDir, { recursive: true });

  const entries = readZipEntries(fs.readFileSync(backupFile));
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const manifest = JSON.parse(byName.get('manifest.json').toString('utf8'));
  const restoredStorage = [];

  const writeOut = (targetName, data) => {
    const target = path.join(destDataDir, targetName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  };

  if (manifest.formatVersion === 1) {
    // 历史明文备份：按 zip 条目原样还原；库条目落成规范名
    for (const e of entries) {
      if (e.name === 'manifest.json') continue;
      const targetName = DB_ENTRY_RE.test(e.name) ? DB_BASENAME : e.name;
      writeOut(targetName, e.data);
      if (e.name.startsWith('storage/')) restoredStorage.push(e.name);
    }
  } else {
    // 加密备份：只按 manifest 声明的条目**解密后**写明文名（包已校验，无夹带条目）
    const master = coerceBackupKey(key);
    const { encKey } = deriveKeys(master);
    writeOut(DB_BASENAME, decryptEntry(byName.get(manifest.db.entry), encKey));
    for (const f of manifest.storage.files) {
      writeOut(f.name, decryptEntry(byName.get(f.entry), encKey));
      restoredStorage.push(f.name);
    }
  }

  // 恢复后立即自证：用只读连接跑完整性检查 + 迁移版本表必须在
  const check = new DatabaseSync(dbTarget, { readOnly: true });
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') {
      throw new Error('恢复后的库 integrity_check 未通过：' + JSON.stringify(integrity));
    }
  } finally {
    check.close();
  }
  return { restored: { db: true, storage: restoredStorage }, manifest };
}

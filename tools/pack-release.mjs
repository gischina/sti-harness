/**
 * 发布打包（M5 · 企业化收口）。
 *
 * 用法：node tools/pack-release.mjs
 * 产物：dist/sti-harness-<版本>.zip
 *
 * 打包范围（白名单制 —— 想进包的东西必须列在这里，不是"排除黑名单剩下的都进"）：
 *   app/  public/  docs/  tools/  VERSION  README.md  LICENSE  NOTICE  start.*  check.*
 *
 * LICENSE / NOTICE 必须进包：Apache-2.0 第 4(d) 条要求随分发提供 NOTICE，
 * 对已发布的二进制/归档同样适用。漏了它们不是"少个文件"，是许可不合规。
 *
 * 排除什么不是口味问题，是安全边界（roadmap M5 验收标准 3）：
 *   · data/ 整个目录：SQLite 库（全部业务数据）、storage/（用户上传）、
 *     backups/（备份包）、logs/、以及 .secret（主密钥 —— 进包等于凭据明文搬家）；
 *   · 测试运行残留（sti-* 临时目录在系统临时区，本就不在仓库里）。
 *
 * 打完包**立即扫描**（同脚本内，不是另一个可忘记跑的步骤）：
 *   · 条目名扫描：任何 data/、*.db、.secret、.env、backups、logs 命中即失败；
 *   · 内容扫描：app/ 与 public/ 的源码里不得出现"像真实凭据的字符串"
 *     （cipher 块格式 / 长度可疑的硬编码 token）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from '../app/util/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();

/* ── 白名单收集 ─────────────────────────────────────────────── */
const WHITELIST_DIRS = ['app', 'public', 'docs', 'tools'];
const WHITELIST_FILES = ['VERSION', 'README.md', 'LICENSE', 'NOTICE', 'start.cmd', 'start.sh', 'check.cmd', 'check.sh'];

function collect(dir, rel = '') {
  const out = [];
  const abs = path.join(ROOT, dir, rel);
  for (const name of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? rel + '/' + name.name : name.name;
    if (name.isDirectory()) out.push(...collect(dir, r));
    else out.push({ rel: dir + '/' + r, abs: path.join(ROOT, dir, r) });
  }
  return out;
}

let files = [];
for (const d of WHITELIST_DIRS) files.push(...collect(d));
for (const f of WHITELIST_FILES) {
  const abs = path.join(ROOT, f);
  if (fs.existsSync(abs)) files.push({ rel: f, abs });
}

/* ── 内容扫描：分两组，作用域不同 ───────────────────────────────
 *
 * 这个区分不是洁癖，是一次真泄漏换来的：
 *
 *   · SECRET_PATTERNS —— **产品代码**里不许出现任何像凭据的东西（app / public）。
 *     `password: '…'` 这种形状出现在运行期代码里，唯一的解释就是硬编码凭据。
 *   · TOKEN_PATTERNS  —— **任何被分发的文件**里都不许出现像**令牌**的东西
 *     （app / public / tools / docs）。因为 tools/ 与 docs/ 同样随包出去，
 *     而 `?token=<长串>` / `Bearer <长串>` / 私钥块只有一种解释。
 *
 * ⚠️ TOKEN_PATTERNS 这一组是 0.15.0 补的。补之前 `tools/test-core.mjs` 里躺着一枚
 * 从本机 `data/config.json` **整行抄来的真实内核令牌**，而扫描只覆盖 `app/` ——
 * 整个打包流程报"泄漏命中 0"，全程全绿。最后是"**独立解包 → 换一套规则复扫**"抓出来的。
 * 教训：**扫描范围比扫描规则更容易漏**；规则写得再细，扫不到那个目录就等于没有。
 */
const SECRET_PATTERNS = [
  { name: 'AES-GCM cipher 块', re: /\b[A-Za-z0-9+/]{40,}={0,2}\b.*iv.*authTag/i },
  { name: '硬编码 Bearer 令牌', re: /['"]Bearer\s+[A-Za-z0-9._-]{20,}['"]/ },
  { name: '硬编码 password= 形态的赋值', re: /password\s*[:=]\s*['"][^'"]{8,}['"]/i },
];

const TOKEN_PATTERNS = [
  { name: 'URL 内嵌长令牌（?token=）', re: /[?&]token=[A-Za-z0-9._-]{20,}/ },
  { name: '硬编码 Bearer 令牌', re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'JWT 三段式', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
];

/** TOKEN_PATTERNS 的作用域：**凡是会被分发的目录都要扫**。 */
const TOKEN_SCOPE = ['app/', 'public/', 'tools/', 'docs/'];

/* ── 打包 ───────────────────────────────────────────────────── */
const distDir = path.join(ROOT, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const outFile = path.join(distDir, `sti-harness-${VERSION}.zip`);

const entries = [];
const leaks = [];
let secretScanned = 0;
let tokenScanned = 0;
for (const f of files) {
  const buf = fs.readFileSync(f.abs);
  // 条目名扫描：顶层 data/ 是运行时目录（库/上传/备份/日志/主密钥），绝不能进包；
  // app/data/ 是**源码**（migrations、仓储），必须进包 —— 别用"路径里有 data"这种宽匹配。
  if (/^data\//.test(f.rel) || /\.db$|\.db-wal$|\.db-shm$|\.secret$|\.env$/i.test(f.rel)) {
    leaks.push('条目名命中排除清单：' + f.rel);
    continue;
  }
  // 内容扫描（文本类文件，按作用域分两组跑）
  if (/\.(mjs|js|cjs|json|md|sql|cmd|sh|txt|html|css)$|VERSION$/i.test(f.rel)) {
    const text = buf.toString('utf8');
    if (/^(app|public)\//.test(f.rel)) {
      secretScanned++;
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(text)) leaks.push(`内容疑似凭据（${p.name}）：${f.rel}`);
      }
    }
    if (TOKEN_SCOPE.some((s) => f.rel.startsWith(s))) {
      tokenScanned++;
      for (const p of TOKEN_PATTERNS) {
        if (p.re.test(text)) leaks.push(`内容疑似令牌（${p.name}）：${f.rel}`);
      }
    }
  }
  entries.push({ name: f.rel, data: buf });
}
entries.push({
  name: 'MANIFEST.txt',
  data: Buffer.from([
    `sti-harness ${VERSION} 发布包`,
    `打包时间 : ${new Date().toISOString()}`,
    `文件数   : ${entries.length}`,
    '',
    '本包不含：数据库（业务数据）、storage/（用户上传）、backups/、logs/、.secret（主密钥）。',
    '许可证：Apache-2.0（见 LICENSE）；第三方与参考来源说明见 NOTICE。',
    '部署：解压后按 docs/deploy.md §2 起服务；数据目录首次启动自动创建。',
    '恢复既有环境：用 data/backups 里的备份包 + tools/restore-backup.mjs（见 deploy.md §备份）。',
  ].join('\n'), 'utf8'),
});

fs.writeFileSync(outFile, zipSync(entries));

/* ── 报告 ───────────────────────────────────────────────────── */
console.log('');
console.log('发布打包（白名单制 + 打包即扫描）');
console.log('  版本     : ' + VERSION);
console.log('  产物     : dist/sti-harness-' + VERSION + '.zip（' + entries.length + ' 个条目，' + fs.statSync(outFile).size + ' 字节）');
console.log('  凭据形态扫描 : ' + secretScanned + ' 个文件 × ' + SECRET_PATTERNS.length + ' 条特征（app/ + public/）');
console.log('  令牌形态扫描 : ' + tokenScanned + ' 个文件 × ' + TOKEN_PATTERNS.length + ' 条特征（含 tools/ 与 docs/ —— 它们同样随包出去）');
if (leaks.length) {
  console.log('');
  console.log('✗ 泄漏 ' + leaks.length + ' 处：');
  for (const l of leaks) console.log('  · ' + l);
  console.log('DONE leaks=' + leaks.length);
  process.exit(1);
}
console.log('  泄漏命中 : 0（条目名 ＋ 凭据形态 ＋ 令牌形态，三重扫描通过）');
console.log('DONE leaks=0');

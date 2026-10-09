/**
 * 把 `data/config.json` 里的**明文内核令牌**封成密文（离线一次性迁移动作）。
 *
 * 为什么需要这个工具：
 *   0.15.0 起，内核接入向导写出去的令牌一律是密文（`dshTokenCipher`，AES-256-GCM），
 *   明文键在同一个合并动作里被删掉。但**在那之前写下的配置不会自己变**——
 *   老部署的 `data/config.json` 里至今留着一份明文副本：
 *
 *     { "dshOrigin": "http://127.0.0.1:3080/?token=<明文令牌>" }
 *
 *   这个形状**不会报任何错**：服务照起、对话照跑、页面照显示"已接入"。
 *   它的代价是任何能读到该文件的进程、以及**每一份备份包与快照**，
 *   都连带拿到了调用上游内核的凭据。所以它与"备份"属于同一类问题 ——
 *   **"不做也不会报错"的运维项**（自检第 [15] 项会把它问出来）。
 *
 * 为什么是"就地重新加密"而不是"让人去页面上重填一遍"：
 *   令牌**本来就在那个文件里**，让用户再去别处把它找出来重敲一遍是多余的动作，
 *   而且找个准不准全凭运气。这里直接读出来、加密、写回，令牌**不经过剪贴板也不经过屏幕**。
 *
 * 设计约束（每一条都对应一类会出错的做法）：
 *   · **默认只报告、不写盘**（要加 `--apply`）—— 迁移动的是"下一次启动用什么凭据"，
 *     不该因为"顺手跑了一下命令"就发生。
 *   · **写前备份**（`config.json.bak-<时间戳>`）：写坏了要能退回去。
 *   · **原子写**（复用 `writeConfigFile`）：半个 JSON 会让下次启动静默回落到内置内核。
 *   · **写后往返校验**：另起一次读取，用产品自己的 `loadConfig()` 比对
 *     "地址"与"解密后的令牌"两个**客观值**与原值逐字一致；不一致就明说去用备份还原。
 *   · **不打印令牌**：输出里只出现密文前缀与长度，令牌原文一个字符都不落终端
 *     （终端会被录屏、会被贴进工单）。
 *
 * ⚠️ 刻意**复用产品代码**（`normalizeKernelInput` / `mergeKernelConfigPatch` /
 *   `writeConfigFile` / `encryptSecret`），不另写一套解析与合并 ——
 *   否则"迁移出来的形状"与"向导保存出来的形状"会分叉，而两者本该逐字一致。
 *
 * 用法：
 *   node tools/seal-kernel-token.mjs                 # 只报告（默认）
 *   node tools/seal-kernel-token.mjs --apply         # 执行并校验
 *   node tools/seal-kernel-token.mjs --apply --force # 跳过确认（脚本化场景）
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readRawConfigFile, writeConfigFile, loadConfig } from '../app/config.mjs';
import { normalizeKernelInput, mergeKernelConfigPatch } from '../app/kernel/connection-config.mjs';
import { encryptSecret, decryptSecret } from '../app/platform/identity/credentials.mjs';
import { loadSecret } from '../app/data/secret.mjs';
import { SECRET_FILE } from '../app/paths.mjs';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const force = argv.includes('--force');

/** 令牌只以"长度 + 指纹前缀"出现，原文一律不进终端。 */
const mask = (t) => (t ? '<' + String(t).length + ' 字符，' + String(t).slice(0, 4) + '…>' : '（无）');
/**
 * 地址里**也可能内嵌着令牌**（`?token=…`，这正是本工具要处理的形状），
 * 所以打印地址前必须先摘掉它 —— 否则"不打印令牌"的承诺在第一个输出行就自己破了。
 * 终端会被录屏、会被整段贴进工单，这条路和写进文件一样漏。
 */
const maskOrigin = (o) => String(o == null ? '' : o).replace(/([?&]token=)[^&#\s]*/gi, '$1' + '<已隐去>');

function die(msg) { console.log(msg); process.exit(1); }

const raw = readRawConfigFile();
const { configFile: file } = loadConfig();

console.log('');
console.log('内核令牌封存（config.json 明文 → 密文）');
console.log('  配置文件 : ' + file);
console.log('  当前内容 : dshOrigin=' + JSON.stringify(maskOrigin(raw.dshOrigin))
  + '｜dshToken=' + mask(raw.dshToken)
  + '｜dshTokenCipher=' + (raw.dshTokenCipher ? '（已有密文）' : '（无）'));

const norm = normalizeKernelInput(raw.dshOrigin, raw.dshToken);
if (norm.invalid) die('\n× 地址不合法，不敢动它：' + norm.error);

const plain = norm.token;
const alreadyCipher = typeof raw.dshTokenCipher === 'string' && raw.dshTokenCipher !== '';

console.log('  归一化   : ' + JSON.stringify({ origin: norm.origin, tokenFrom: norm.tokenFrom || '—', token: mask(plain) }));

if (!plain) {
  console.log('');
  if (alreadyCipher) console.log('✓ 已经是密文落盘（`dshTokenCipher`），无需封存。');
  else console.log('· 配置里没有令牌 —— 无需封存。');
  console.log('DONE sealed=0');
  process.exit(0);
}

const masterSecret = loadSecret(SECRET_FILE);
if (!masterSecret) die('\n× 读不到主密钥（' + SECRET_FILE + '）—— 无法加密，请先确认数据目录正确。');

// 迁移后的形状 == 向导「保存并启用」写出来的形状
const after = mergeKernelConfigPatch(raw, {
  origin: norm.origin,
  tokenCipher: encryptSecret(plain, masterSecret),
});

console.log('  封存后   : ' + JSON.stringify({
  dshOrigin: after.dshOrigin,
  dshTokenCipher: String(after.dshTokenCipher).slice(0, 16) + '…（' + after.dshTokenCipher.length + ' 字符）',
  dshToken: after.dshToken === undefined ? '（明文键已删除）' : '!! 仍在 !!',
}));

if (!apply) {
  console.log('');
  console.log('（只是报告：加 --apply 才会写盘。写前会备份，写后会做往返校验。）');
  console.log('DONE sealed=0');
  process.exit(0);
}
if (!force) {
  console.log('');
  console.log('写盘会让**下一次启动**改用密文令牌。请确认当前实例可以重启，然后加 --force 再跑一次。');
  console.log('DONE sealed=0');
  process.exit(0);
}

/* ── 写盘 ─────────────────────────────────────────────────── */
const bak = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(file, bak);

let written;
try { written = writeConfigFile(after); }
catch (e) { die('\n× 写盘失败：' + e.message + '\n  原文件未改动；如需手工处理，备份在 ' + bak); }

console.log('');
console.log('  已写入   : ' + written.file + '（' + written.bytes + ' 字节，原子写）');
console.log('  已备份   : ' + bak);

/* ── 往返校验：换一次读取路径，比对两个客观值 ───────────────── */
const back = loadConfig().values;
let tokenBack = '';
try { tokenBack = back.dshTokenCipher ? decryptSecret(back.dshTokenCipher, masterSecret) : ''; }
catch (e) { die('\n× 刚写下的密文解不开：' + e.message + '\n  请用备份还原：' + bak); }

const okOrigin = back.dshOrigin === norm.origin;
const okToken = tokenBack === plain;
const disk = fs.readFileSync(file, 'utf8');
const okNoPlain = !/"dshToken"\s*:/.test(disk) && !/[?&]token=/.test(disk);

console.log('');
console.log('  往返校验 : 地址 ' + (okOrigin ? '✓' : '✗') + '｜令牌解密 ' + (okToken ? '✓ 与原值逐字一致' : '✗'));
console.log('  明文残留 : ' + (okNoPlain ? '✓ 无（`dshToken` 键已删，地址里也没有 `token=`）' : '✗ 仍有明文'));

if (!(okOrigin && okToken && okNoPlain)) {
  die('\n× 校验未通过 —— 请用备份还原：' + bak + '\n  然后把这份输出发出来，别自己改文件。');
}
console.log('');
console.log('✓ 完成。重启本服务后生效（不重启则当前进程仍用启动时读到的那份配置）。');
console.log('DONE sealed=1');

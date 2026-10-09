/**
 * 离线恢复工具（M5 · 企业化收口）。
 *
 * 用法：
 *   node tools/restore-backup.mjs <备份ZIP> <目标数据目录> [--overwrite]
 *
 * 流程：校验备份包（v2 备份先验签名再解密，逐文件哈希）→ 写入 db + storage
 *      → integrity_check 自证。
 * 目标目录必须是**未运行服务**的目录 —— 运行中换库不是本工具的职责范围。
 *
 * 备份密钥（P1-7，仅加密备份需要）按顺序找：
 *   1. 环境变量 STI_BACKUP_KEY；
 *   2. 备份包同目录、同名主干的 .key（一次性密钥场景）；
 *   3. 目标数据目录里的 backup.key。
 * 都没有时，加密备份会在校验阶段明确报"需要密钥"；v1 明文备份不受影响。
 *
 * 恢复完成后，目标目录里**没有** .secret（主密钥不在备份包里）——
 * 如果是全新机器，需要先重新初始化或从安全渠道找回主密钥，否则凭据解不开。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { restoreBackup } from '../app/platform/operation/backup.mjs';

const [,, backupFile, destArg, ...flags] = process.argv;
if (!backupFile || !destArg) {
  console.error('用法：node tools/restore-backup.mjs <备份ZIP> <目标数据目录> [--overwrite]');
  process.exit(2);
}
const backupAbs = path.resolve(backupFile);
const destDataDir = path.resolve(destArg);
const overwrite = flags.includes('--overwrite');

/** 按文件头注释的顺序找备份密钥，找不到返回 null。 */
function findBackupKey() {
  const fromEnv = process.env.STI_BACKUP_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const candidates = [
    backupAbs.replace(/\.zip$/, '.key'),
    path.join(destDataDir, 'backup.key'),
  ];
  for (const f of candidates) {
    try {
      if (f !== backupAbs && fs.existsSync(f)) {
        const v = fs.readFileSync(f, 'utf8').trim();
        if (v) return v;
      }
    } catch { /* 试下一个 */ }
  }
  return null;
}
const backupKey = findBackupKey();

console.log('备份包 :', backupAbs);
console.log('目标   :', destDataDir, overwrite ? '（--overwrite：覆盖已有库）' : '');
console.log('备份密钥:', backupKey
  ? '已提供（' + (process.env.STI_BACKUP_KEY ? 'STI_BACKUP_KEY' : '密钥文件') + '）'
  : '未提供（仅 v1 明文备份可恢复）');

try {
  const r = restoreBackup({ backupFile: backupAbs, destDataDir, overwrite, key: backupKey });
  console.log('');
  console.log('✓ 校验通过并已恢复');
  console.log('  平台版本（备份时）:', r.manifest.platformVersion);
  console.log('  备份创建时间      :', r.manifest.createdAt);
  console.log('  storage 文件      :', r.restored.storage.length, '个');
  console.log('');
  console.log('⚠ 提醒：目标目录没有 .secret（主密钥不在备份包里）。');
  console.log('  全新机器请先恢复/重配主密钥并重启服务，否则已加密的凭据无法解密。');
  console.log('  下一步：node app/main.mjs --check 验证 → 启动 → 复跑回归。');
} catch (e) {
  console.error('✗ 恢复失败：' + e.message);
  process.exit(1);
}

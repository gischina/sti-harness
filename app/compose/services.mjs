/**
 * 平台服务装配 —— 把「主密钥 → 各业务服务」的装配细节从 main.mjs 单点抽出（P2-13）。
 *
 * 为什么抽：main.mjs 此前一人分饰三角 —— 参数解析、引导检查（目录/迁移/密钥）、
 * 服务装配图。装配图是其中最长也最讲究顺序的一段（模型先于知识、治理依赖模型、
 * 调度器最后），混在启动流程里让人分不清「哪些是步骤、哪些是依赖注入」。
 * 抽出后 main.mjs 只剩"步骤"，依赖关系集中在本文件可一眼看全。
 *
 * 纪律（与抽取前**逐行等价**，只是搬了家）：
 *   · 装配顺序即依赖顺序：identity → keyring → model → knowledge → governance
 *     → operation → notify → schedule（最后：它的执行体要用前四者）；
 *   · 主密钥只在这里读一次并注入 —— 加密模块与服务层都不碰文件系统；
 *   · 装配失败抛**带前缀的 Error**（"××服务装配失败：原因"），由 main 统一记日志、
 *     置退出码 1 —— 退出码语义（P0-3）不因搬家而变。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import process from 'node:process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { log } from '../log.mjs';
import { sessionTtlMs } from '../config.mjs';
import { DATA_DIR, SECRET_FILE, BACKUP_KEY_FILE, ARCHIVE_DIR, ANCHOR_DIR } from '../paths.mjs';
import { loadSecret } from '../data/secret.mjs';
import { createIdentityService } from '../platform/identity/service.mjs';
import { createKnowledgeService } from '../platform/knowledge/service.mjs';
import { createModelService } from '../platform/model/service.mjs';
import { createWorkspaceService } from '../platform/workspace/service.mjs';
import { createGovernanceService } from '../platform/governance/service.mjs';
import { createOperationService } from '../platform/operation/service.mjs';
import { createNotifyService } from '../platform/notify/service.mjs';
import { createScheduleService } from '../platform/schedule/service.mjs';
import { getCredentialForUse } from '../platform/identity/repos/credentials.mjs';
import { decryptSecret, createSecretKeyring, encryptSecret } from '../platform/identity/credentials.mjs';
import * as metrics from '../platform/observe/metrics.mjs';
import * as auditLog from '../platform/governance/audit.mjs';

/**
 * 解析备份独立密钥（P1-7）。
 *   1. `STI_BACKUP_KEY` 环境变量（hex / base64 / 口令均可，识别规则见 backup.mjs）；
 *   2. data/backup.key 已存在 → 读；
 *   3. 否则生成 32B 随机 hex 写入（0600）。
 * 读/写失败返回 null，由 backup.mjs 退化为"每份备份一个一次性密钥"。
 */
export function resolveBackupKey() {
  const fromEnv = process.env.STI_BACKUP_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    if (fs.existsSync(BACKUP_KEY_FILE)) {
      const v = fs.readFileSync(BACKUP_KEY_FILE, 'utf8').trim();
      if (v) return v;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(BACKUP_KEY_FILE, generated, { mode: 0o600 });
    log.info('已生成备份独立密钥 backup.key —— 请与备份包分开妥善保管（丢了它，已加密备份无法恢复）。');
    return generated;
  } catch (e) {
    log.warn('backup.key 不可用（' + e.message + '），本次备份将各用一次性密钥。');
    return null;
  }
}

/**
 * 解析轮换保留的旧主密钥（P1-8）：环境变量 `STI_OLDER_SECRETS`，
 * 多条用逗号或分号分隔，每条为一把 32 字节密钥的 base64。
 * 格式非法的条目跳过并告警（绝不让一条坏配置把启动拖死）。
 */
export function parseOlderSecrets() {
  const raw = process.env.STI_OLDER_SECRETS;
  if (!raw || !raw.trim()) return [];
  const out = [];
  for (const part of raw.split(/[,;]/)) {
    const s = part.trim();
    if (!s) continue;
    let b;
    try { b = Buffer.from(s, 'base64'); } catch { b = null; }
    if (!b || b.length !== 32) {
      log.warn('STI_OLDER_SECRETS 中有一条密钥无法识别（应为 32 字节 base64），已跳过。');
      continue;
    }
    out.push(b);
  }
  return out;
}

/**
 * 装配全部平台业务服务。
 * @param {{config:object}} args `config` = loadConfig() 的结果（含 values / sources）
 * @returns {{masterSecret:Buffer, keyring:object, identity:object, resolveCredential:Function,
 *            model:object, knowledge:object, governance:object, operation:object,
 *            notify:object, schedule:object, backupKey:string|null}}
 */
export function buildServices({ config }) {
  // ── 身份与权限（M1）───────────────────────────────────────────
  let masterSecret;
  let identity;
  try {
    masterSecret = loadSecret(SECRET_FILE);
    // `sessionTtlHours` 以前只存在于配置里、从没被读 —— 会话实际写死 8 小时。
    // 死配置比没有配置更危险：运维改了 `config.json` 以为生效，其实什么都没变。
    // 换算收口到 `sessionTtlMs()`（纯函数、有回归钉住），这里只负责"传进去"。
    const ttlMs = sessionTtlMs(config.values);
    identity = createIdentityService({
      masterSecret,
      ...(ttlMs ? { sessionTtlMs: ttlMs } : {}),
    });
  } catch (e) {
    throw new Error('身份服务装配失败：' + e.message);
  }

  // 密钥环（P1-8）：当前密钥加密；STI_OLDER_SECRETS 提供的旧密钥仅供解密，
  // 后台重加密把存量老密文逐步搬到当前密钥。所有 decryptSecret 调用一律传环。
  const keyring = createSecretKeyring({ active: masterSecret, older: parseOlderSecrets() });
  if (keyring.older.length) {
    log.info('主密钥轮换：已加载 ' + keyring.older.length
      + ' 把旧密钥（仅供解密），启动后自动把存量密文重加密为当前密钥。');
  }

  // ── 模型中心（P1-1）───────────────────────────────────────────
  // 先于知识服务装配：知识层的向量配置会**优先**读注册表里的默认向量项
  // （见 resolveEmbedding），这样"页面上配的模型"与"检索真正用的模型"是同一份，
  // 而不是页面一套、config.json 一套。
  //
  // 凭据解析器抽成一个具名函数，供模型中心与知识层共用 —— 两处各写一遍解密逻辑，
  // 早晚会出现"一处做了失败降级、另一处直接把异常抛出去"的分歧。
  const resolveCredential = (tenantId, name) => {
    const row = getCredentialForUse(tenantId, name);
    if (!row || !row.cipher) return null;
    try { return decryptSecret(row.cipher, keyring); }
    catch (e) { log.warn('凭据「' + name + '」解密失败：' + e.message); return null; }
  };
  const model = createModelService({ resolveCredential });

  // ── 企业知识与检索（M2）───────────────────────────────────────
  // 向量服务密钥从凭据库取（AES-256-GCM 解密）—— 解密只在这一次调用里发生，
  // 明文不落配置、不落日志、不进响应体。
  let knowledge;
  try {
    knowledge = createKnowledgeService({
      config,
      audit: auditLog,
      resolveCredential,
      // 注册表里的默认向量项覆盖 config.json（返回 null 时照旧用 config.json 并在结果里标明来源）
      resolveEmbedding: (tenantId) => model.resolveEmbeddingForIdentity(tenantId),
      // 4.6 库级 ACL：把"某人在某库上被授了什么角色"的查询接进来。
      // 知识层**不直接读 `role_bindings`** —— 授权是身份的领域，知识层只消费结论。
      // 两个入口来源同一个服务，避免"服务层一套、这里一套"的口径分裂。
      identity,
      resolveScopedRoles: (userId, scopeType) => identity.scopedRolesForUser(userId, scopeType),
    });
  } catch (e) {
    throw new Error('知识服务装配失败：' + e.message);
  }

  // ── 工作区（0.21.0）──────────────────────────────────────────
  // 对话工作台的树状组织层：工作区 CRUD（**纯组织容器** —— 0.21.6 起不再有
  // 工作区级授权与可见性，理由见迁移 0023 头注释）。档位推导纯函数在
  // platform/workspace/visibility.mjs（只按组织角色）；这里只负责把审计接进去。
  //
  // ⚠️ 不再传 identity：从前它是给"工作区级授权名单"（role_bindings 的 scoped 查询）
  //    用的，那条路已经删掉。少一个依赖 = 少一处可以偷偷长出权限概念的地方。
  const workspace = createWorkspaceService({ audit: auditLog });

  // ── 治理与审计（M3）───────────────────────────────────────────
  // 审计 / 用量 / 配额等模块全用同步 SQLite，无后台资源；
  // 收口成 service 是为了让 middleware 与路由只认 deps.governance（与 identity 同构）。
  //
  // 并发计数的观察者在这里接线（P1-2）：governance 不认识 metrics，metrics 也不认识
  // governance —— 装配层负责把"在途回合数"这个 gauge 报给 /metrics。
  //
  // 成本核算（P1-3）同理：governance 不认识 model，装配层把"按租户取模型条目"接进去。
  // 接的是 `listProviders`（公开形状，已含单价与币种），不是更细的仓库查询 ——
  // 价格口径只有一处定义（model/service.mjs 的 shape），成本层不另抄一份。
  const governance = createGovernanceService({
    onConcurrentChange: (s) => metrics.setGauge('sti_active_turns', s.total),
    resolveProviders: (tenantId) => model.listProviders(tenantId),
  });

  // ── 运维（M5）────────────────────────────────────────────────
  // 五个模块到这里全部有了 service 门面 —— operation 最晚补齐（P0-D #9）：
  // 在此之前备份的路由直接 import backup.mjs，目录列举与路径校验长在 handler 里。
  //
  // 备份独立密钥（P1-7）：STI_BACKUP_KEY 环境变量优先；否则 data/backup.key
  // （与 .secret 分开的另一把密钥，首次需要时自动生成，权限 0600）。
  // 读/生成都失败则传 null —— backup.mjs 会退化为一次性密钥并在包旁写 .key。
  const backupKey = resolveBackupKey();
  const operation = createOperationService({ dataDir: DATA_DIR, backupKey });

  // ── 出站通知（P1-2）───────────────────────────────────────────
  // 渠道 URL 用与凭据同一把主密钥加密（URL 里常内嵌 token，它等价于一个密钥）。
  // 加解密函数由装配层注入，notify 模块自己不碰 .secret 文件（与知识层取密钥同款）。
  const notify = createNotifyService({
    masterSecret,
    encryptSecret,
    decryptSecret,
    resolveCredential,
    audit: auditLog,
    allowLoopback: process.env.STI_NOTIFY_ALLOW_LOOPBACK === '1',
  });

  // ── 定时任务底座（P1-2）───────────────────────────────────────
  // 最后装配：它的执行体要用到 governance / operation / model / notify 四者。
  const schedule = createScheduleService({
    governance, operation, model, notify, identity,
    archiveDir: ARCHIVE_DIR, anchorDir: ANCHOR_DIR,
    tickMs: Number(process.env.STI_SCHED_TICK_MS) > 0 ? Number(process.env.STI_SCHED_TICK_MS) : undefined,
    log: (m) => log.warn(m),
  });

  return { masterSecret, keyring, identity, resolveCredential, model, knowledge, workspace, governance, operation, notify, schedule, backupKey };
}

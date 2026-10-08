/**
 * 主密钥轮换 · 后台重加密（2026-10 安全评审 P1-8）。
 *
 * 背景：凭据信封自 v2 起在密文头部带 kid（见 identity/credentials.mjs）。
 * 密钥轮换（换一把新的主密钥）如果要求"停机、解密、重加密、再起"，
 * 轮换窗口内数据处于半新半旧状态，且停机本身常常不可接受。
 *
 * 做法：装配层持有"密钥环"——当前密钥 + 若干旧密钥。
 *   · 读取：新密文按 kid 找当前密钥，老密文按 kid 找旧密钥，全程可读；
 *   · 本模块在启动后被后台调用，把"kid 不是当前密钥"的密文逐个
 *     解密、用当前密钥重加密、写回，直到全部归位；
 *   · 之后旧密钥即可从 STI_OLDER_SECRETS 移除。
 *
 * 覆盖全部密文承载位置（枚举，不凭印象）：
 *   · credentials.cipher（上游/模型凭据）
 *   · notify_channels.url_cipher（出站 webhook，URL 可能内嵌 token）
 *   · mcp_servers.config_cipher（MCP 连接配置）
 *   · config.json 的 dshTokenCipher（内核接入令牌）——通过可选 config 钩子处理，
 *     本模块不直接 import 配置模块，保持可单测。
 *
 * 纪律：
 *   · 已经是当前 kid 的密文一律跳过（不做无谓解密/写入）；
 *   · 解不开的单元（旧密钥没给全）保持原样、计入 failures，**不丢数据**；
 *   · 写回全部按主键 UPDATE，不做 DELETE/INSERT。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { all, run } from '../../data/db.mjs';

/**
 * 数据库内的密文单元。SQL 全部现写、列名与迁移文件一致：
 * credentials(id,cipher) ｜ notify_channels(id,url_cipher) ｜ mcp_servers(id,config_cipher)
 */
const DB_CELLS = [
  {
    table: 'credentials',
    list: () => all('SELECT id, name, cipher FROM credentials WHERE cipher <> \'\''),
    update: (id, cipher) => run('UPDATE credentials SET cipher=? WHERE id=?', [cipher, id]),
  },
  {
    table: 'notify_channels',
    // tenant-ok: 密钥轮换是平台级维护，有意遍历**全部租户**逐单元重加密，不按 tenant_id 过滤；
    // 写回按主键、只改密文列。该豁免同时覆盖下面的 SELECT 与 UPDATE。
    list: () => all('SELECT id, name, url_cipher AS cipher FROM notify_channels WHERE url_cipher <> \'\''),
    update: (id, cipher) => run('UPDATE notify_channels SET url_cipher=? WHERE id=?', [cipher, id]),
  },
  {
    table: 'mcp_servers',
    // tenant-ok: 同上，密钥轮换必须覆盖所有租户的 MCP 连接配置；写回按主键、只改密文列。
    list: () => all('SELECT id, name, config_cipher AS cipher FROM mcp_servers WHERE config_cipher <> \'\''),
    update: (id, cipher) => run('UPDATE mcp_servers SET config_cipher=? WHERE id=?', [cipher, id]),
  },
];

/**
 * 执行一轮重加密。无后台状态：调用一次扫一遍，幂等，可安全反复执行。
 *
 * @param {object} opts
 * @param {object} opts.keyring createSecretKeyring() 的密钥环
 * @param {(cipher:string, keyOrRing:*) => string} opts.decryptSecret
 * @param {(plain:string, key:Buffer) => string} opts.encryptSecret
 * @param {(cipher:string) => Buffer|null} opts.cipherKid v2→kid；v1→null
 * @param {{raw:() => object, write:(next:object) => void}|null} [opts.config]
 *        可选：重写配置文件里的密文内核令牌
 * @returns {{scanned:number, current:number, rewrapped:number,
 *            legacyRewrapped:number, foreignRewrapped:number,
 *            configRewrapped:boolean, failures:Array<{table:string,name:string,message:string}>}}
 */
export function reencryptSecrets({
  keyring, decryptSecret, encryptSecret, cipherKid, config = null,
} = {}) {
  const result = {
    scanned: 0, current: 0, rewrapped: 0,
    legacyRewrapped: 0, foreignRewrapped: 0,
    configRewrapped: false, failures: [],
  };
  if (!keyring || typeof keyring.findKey !== 'function' || !Buffer.isBuffer(keyring.activeKid)) {
    throw new Error('reencryptSecrets 需要 keyring（createSecretKeyring 的返回值）');
  }

  /** 处理单个密文：需要重加密→返回新密文；已是当前→null；失败→抛异常 */
  function rewrap(cipher) {
    const kid = cipherKid(cipher);
    if (kid && kid.equals(keyring.activeKid)) return null;
    const plain = decryptSecret(cipher, keyring);
    return { next: encryptSecret(plain, keyring.active), legacy: !kid };
  }

  for (const cell of DB_CELLS) {
    let rows = [];
    try { rows = cell.list(); } catch (e) {
      result.failures.push({ table: cell.table, name: '(列表查询失败)', message: e.message });
      continue;
    }
    for (const row of rows) {
      result.scanned++;
      const cipher = String(row.cipher || '');
      if (!cipher) { result.current++; continue; }
      try {
        const r = rewrap(cipher);
        if (!r) { result.current++; continue; }
        cell.update(row.id, r.next);
        result.rewrapped++;
        if (r.legacy) result.legacyRewrapped++; else result.foreignRewrapped++;
      } catch (e) {
        result.failures.push({ table: cell.table, name: row.name || row.id, message: e.message });
      }
    }
  }

  // 配置文件里的密文内核令牌。
  // 分层审计禁的是"缩写词作为完整标识符（\bdsh\b）"，这里是驼峰属性名的前缀
  //（dshTokenCipher，h 与 T 之间没有词边界），不构成命中；语义清晰比拼接字符串重要。
  if (config) {
    try {
      const raw = config.raw() || {};
      if (raw.dshTokenCipher) {
        const r = rewrap(String(raw.dshTokenCipher));
        if (r) {
          config.write({ ...raw, dshTokenCipher: r.next });
          result.configRewrapped = true;
          result.rewrapped++;
          if (r.legacy) result.legacyRewrapped++; else result.foreignRewrapped++;
        }
      }
    } catch (e) {
      result.failures.push({ table: 'config.json', name: 'tokenCipher', message: e.message });
    }
  }

  return result;
}

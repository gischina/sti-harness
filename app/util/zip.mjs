/**
 * 零依赖 ZIP 构建器 —— 会话日志导出（产物留存）用。
 *
 * 只依赖 node:zlib（内置）。实现的是标准 PKZIP 格式：
 *   [local file header + data] × N → central directory → EOCD
 * 单文件用 deflateRaw 压缩；压缩后反而更大（如已压缩内容）就退回 STORE。
 *
 * 为什么不引第三方库：项目红线是零第三方依赖；ZIP 是 1989 年的格式，
 * 核心（local header + central directory + EOCD + CRC32）一页纸就能写对。
 *
 * ⚠️ 明确不做的：分卷、加密、ZIP64（单包 > 4GB 或 > 65535 个文件才需要，
 * 会话日志导出远达不到）；读侧（解压）不在本文件 —— 回归里用 zlib.inflateRaw
 * 逐条解开验证，那本身就是对格式的最强断言。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(d = new Date()) {
  // DOS 时间：年从 1980 起算，秒精度 2s。溢出（1980 前）就钳到 0。
  const year = Math.max(0, d.getFullYear() - 1980);
  const date = (year << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

/**
 * 构建一个 ZIP 文件（Buffer）。
 * @param {Array<{name:string, data:Buffer|string, at?:Date}>} entries
 */
export function zipSync(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    const e = new Error('ZIP 至少要有一个条目（空包没有存在的意义，宁可报错）');
    e.code = 'bad_request';
    throw e;
  }
  if (entries.length > 65535) {
    const e = new Error('条目数超过 ZIP 上限（65535）');
    e.code = 'bad_request';
    throw e;
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name), 'utf8');
    if (nameBuf.length === 0 || nameBuf.length > 0xffff) {
      const e = new Error('ZIP 条目名长度非法：' + String(entry.name).slice(0, 50));
      e.code = 'bad_request';
      throw e;
    }
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    if (data.length > 0xffffffff) {
      const e = new Error('ZIP 条目超过 4GB（需要 ZIP64，本实现明确不支持）');
      e.code = 'bad_request';
      throw e;
    }
    const { date, time } = dosDateTime(entry.at || new Date());
    const crc = crc32(data);

    // 压缩：收益为负就 STORE（method 0），否则 DEFLATE（method 8）
    let method = 0;
    let payload = data;
    if (data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) { method = 8; payload = deflated; }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);        // local file header signature
    local.writeUInt16LE(20, 4);                // version needed (2.0：支持 deflate)
    local.writeUInt16LE(0x0800, 6);            // flags: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);   // compressed size
    local.writeUInt32LE(data.length, 22);      // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);                // extra field length
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);      // central directory signature
    central.writeUInt16LE(20, 4);              // version made by
    central.writeUInt16LE(20, 6);              // version needed
    central.writeUInt16LE(0x0800, 8);          // flags: UTF-8
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);              // extra
    central.writeUInt16LE(0, 32);              // comment
    central.writeUInt16LE(0, 34);              // disk number
    central.writeUInt16LE(0, 36);              // internal attrs
    central.writeUInt32LE(0, 38);              // external attrs
    central.writeUInt32LE(offset, 42);         // local header offset
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
  }

  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);           // end of central directory
  eocd.writeUInt16LE(0, 4);                    // disk number
  eocd.writeUInt16LE(0, 6);                    // central dir disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);              // central dir offset（= 全部 local 部分的长度）
  eocd.writeUInt16LE(0, 20);                   // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/**
 * 读取一个 ZIP（Buffer）的全部条目。
 *
 * 与 zipSync 同一血统：只支持「单盘、无加密、非 ZIP64」的经典结构 ——
 * 签名不对就抛错，绝不猜着解析。给 M4 的「从 ZIP 包安装 Skill」与回归共用。
 *
 * @returns {Array<{name:string, data:Buffer, method:number}>}
 */
export function readZipEntries(buf) {
  if (!buf || buf.length < 22) {
    const e = new Error('不是合法的 ZIP（长度不足）');
    e.code = 'bad_request';
    throw e;
  }
  // 从尾部找 EOCD 签名（容忍注释，最多扫 65557 字节）
  let eocdAt = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdAt = i; break; }
  }
  if (eocdAt < 0) {
    const e = new Error('不是合法的 ZIP（找不到 central directory 结尾）');
    e.code = 'bad_request';
    throw e;
  }
  const count = buf.readUInt16LE(eocdAt + 10);
  const cdSize = buf.readUInt32LE(eocdAt + 12);
  let p = buf.readUInt32LE(eocdAt + 16);
  if (p + cdSize > buf.length) {
    const e = new Error('ZIP central directory 越界（文件可能被截断）');
    e.code = 'bad_request';
    throw e;
  }

  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      const e = new Error('ZIP central directory 条目签名不对（偏移 ' + p + '）');
      e.code = 'bad_request';
      throw e;
    }
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // local header：签名 + 30 字节定长 + 名字 + extra
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      const e = new Error('ZIP local header 签名不对（条目 ' + name + '）');
      e.code = 'bad_request';
      throw e;
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataAt = localOffset + 30 + lNameLen + lExtraLen;
    const payload = buf.slice(dataAt, dataAt + compSize);

    let data;
    if (method === 0) data = payload;
    else if (method === 8) data = zlib.inflateRawSync(payload);
    else {
      const e = new Error('ZIP 条目用了不支持的压缩方法 ' + method + '（' + name + '）');
      e.code = 'bad_request';
      throw e;
    }
    if (data.length !== uncompSize) {
      const e = new Error('ZIP 条目解出长度不符（' + name + '）：期望 ' + uncompSize + ' 实际 ' + data.length);
      e.code = 'bad_request';
      throw e;
    }
    if (crc32(data) !== crc) {
      const e = new Error('ZIP 条目 CRC 校验失败（' + name + '）—— 内容已损坏');
      e.code = 'bad_request';
      throw e;
    }
    out.push({ name, data, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * 解压 ZIP 到目标目录。
 *
 * 安全边界（M4 Skill 安装的依赖项）：
 *   · 条目名含绝对路径 / `..` 段 / Windows 盘符 → 拒绝（路径穿越）；
 *     extract 前调用方也可以用 readZipEntries 自己预检（安装流程是先预检再解压）。
 *   · 目录条目（以 / 结尾）建目录；文件条目自动补父目录。
 *
 * @param {Buffer} buf ZIP 原始字节
 * @param {string} destDir 目标目录（须已存在或可创建）
 * @returns {{name: string, size: number}[]} 解出的文件清单（不含目录条目）
 */
export function extractZip(buf, destDir) {
  const entries = readZipEntries(buf);
  const written = [];
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of entries) {
    if (e.name.includes('..') || e.name.startsWith('/') || /^[A-Za-z]:/.test(e.name)) {
      const err = new Error('ZIP 条目路径越界：' + e.name);
      err.code = 'bad_request';
      throw err;
    }
    const target = path.join(destDir, e.name);
    if (e.name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
    written.push({ name: e.name, size: e.data.length });
  }
  return written;
}

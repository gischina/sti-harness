/**
 * 分层审计 —— 拦截「上游专有概念泄漏到产品层」。
 *
 * 规则（来自 docs/architecture.md §4.2，是 DSH 升级影响面可控的前提）：
 *   审计范围内的代码**不得出现上游专有名词**。上游概念只允许存在于
 *   `app/kernel/dsh-provider/` 一个目录里。
 *
 * 实现要点：
 *   · **先剥掉注释再扫描** —— 注释里出现"前身项目叫什么"是正常的文档需要，
 *     不该判违规；判违规的是**代码**里的上游概念。
 *   · 白名单按行内联标注 `layering-allow`，用于确有必要的说明性字符串。
 *
 * 用法：node tools/audit-layering.mjs [--json]
 * 末行输出 `DONE fails=0`（沿用项目约定）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import '../app/util/quiet-warnings.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 审计范围：产品层 + HTTP 层 + 前端。这三处一旦出现上游概念，升级影响面就会失控。 */
const TARGETS = [
  { dir: 'app/platform', note: '业务层（身份/知识/治理/能力）' },
  { dir: 'app/http', note: 'HTTP 层（路由/中间件/静态）' },
  { dir: 'public', note: '前端产物' },
];

/** 明确不在范围内，以及原因 —— 写下来是为了不被当成遗漏 */
const OUT_OF_SCOPE = [
  { path: 'app/kernel/dsh-provider/**', reason: '上游适配层：唯一允许出现上游专有名词的地方' },
  { path: 'app/kernel/*.mjs', reason: '契约层根：需要 import dsh-provider 来装配 provider' },
  { path: 'app/config.mjs', reason: '配置项名（如 DSH_ORIGIN）是给运维看的接口契约' },
  { path: 'app/main.mjs', reason: '启动帮助文本里列出的环境变量名属运维接口' },
  { path: 'tools/**', reason: '诊断与打包脚本需要直呼其名才能工作' },
  { path: 'docs/**', reason: '文档必须能说明白它与上游的关系' },
];

/**
 * 违规模式。分两类：
 *  A. 上游代码概念（方法名、协议名、包名、CLI 子命令）—— 硬违规；
 *  B. 上游产品名作为**标识符**出现 —— 硬违规。
 */
const PATTERNS = [
  { id: 'api-namespace', re: /agentPresets|dynamicCordisRunner|deliverables\/presented|sessionFeedback/, hint: '上游 RPC 命名空间' },
  { id: 'api-method', re: /\bsession\/(follow|history|attachment|search|submit|create|list)\b/, hint: '上游 RPC 方法名' },
  { id: 'protocol', re: /\btypert\b|__DSH_BOOT__|dsh-auth-|askai\.|ASKAI_/i, hint: '上游协议/信封/鉴权标识' },
  { id: 'cli', re: /--dump-config|dump-config|cordis\.patch|dsh\s+web\b|dsh\.cmd/i, hint: '上游 CLI / profile 概念' },
  { id: 'package', re: /@deepseek-ai\/|deepseek-ai/i, hint: '上游包名' },
  { id: 'brand-ident', re: /\bDSH_[A-Z_]+\b|\bDSH\b|dsh-provider|\bdsh\b|\bDeepSeek\b/i, hint: '上游产品名作为代码标识符（缩写与全名都要拦 —— 0.15.1：上游会把全名写进系统提示词回放，源码里也不能留）' },
];

/** 剥掉注释（保留行号结构，便于报位置） */
function stripComments(src) {
  const out = [];
  let i = 0;
  let state = 'code';      // code | line | block | sq | dq | tpl
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out.push(' ', ' '); i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out.push(' ', ' '); i += 2; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out.push(c); i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out.push('\n'); } else out.push(' '); i++; continue; }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out.push(' ', ' '); i += 2; continue; }
      out.push(c === '\n' ? '\n' : ' '); i++; continue;
    }
    // 字符串状态：整体保留（字符串里的上游概念也是违规，因为会进运行时）
    if (state === 'sq' && c === "'" && src[i - 1] !== '\\') state = 'code';
    else if (state === 'dq' && c === '"' && src[i - 1] !== '\\') state = 'code';
    else if (state === 'tpl' && c === '`' && src[i - 1] !== '\\') state = 'code';
    out.push(c); i++;
  }
  return out.join('');
}

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(mjs|js|cjs|html|css|json)$/i.test(e.name)) acc.push(full);
  }
  return acc;
}

export function auditLayering() {
  const findings = [];
  let scanned = 0;
  let skippedAllow = 0;

  for (const t of TARGETS) {
    const base = path.join(ROOT, t.dir);
    for (const file of walk(base)) {
      scanned++;
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split(/\r?\n/);
      const code = stripComments(raw).split(/\r?\n/);
      for (let i = 0; i < code.length; i++) {
        const line = code[i];
        if (!line.trim()) continue;
        if (line.includes('layering-allow')) { skippedAllow++; continue; }
        for (const p of PATTERNS) {
          const m = p.re.exec(line);
          if (!m) continue;
          findings.push({
            file: rel,
            line: i + 1,
            pattern: p.id,
            hint: p.hint,
            match: m[0],
            source: (lines[i] || '').trim().slice(0, 140),
          });
          break;
        }
      }
    }
  }

  return { scanned, findings, skippedAllow, targets: TARGETS, outOfScope: OUT_OF_SCOPE };
}

function main() {
  const json = process.argv.includes('--json');
  const r = auditLayering();

  if (json) {
    console.log(JSON.stringify(r, null, 2));
    console.log('DONE fails=' + (r.findings.length ? 1 : 0));
    process.exitCode = r.findings.length ? 1 : 0;
    return;
  }

  console.log('');
  console.log('分层审计：上游专有概念是否泄漏到产品层');
  console.log('='.repeat(64));
  console.log('扫描范围（' + r.scanned + ' 个文件）：');
  for (const t of r.targets) console.log('  · ' + t.dir + '/　' + t.note);
  if (r.skippedAllow) console.log('  （其中 ' + r.skippedAllow + ' 行标注了 layering-allow，已豁免）');

  console.log('');
  console.log('不在范围内（有明确原因，非遗漏）：');
  for (const o of r.outOfScope) console.log('  · ' + o.path + '　' + o.reason);

  console.log('');
  if (!r.findings.length) {
    console.log('结果：未发现泄漏。上游概念只存在于 app/kernel/dsh-provider/ —— 升级影响面可枚举。');
  } else {
    console.log('结果：发现 ' + r.findings.length + ' 处泄漏：');
    for (const f of r.findings) {
      console.log('');
      console.log('  ' + f.file + ':' + f.line + '  [' + f.pattern + '] ' + f.hint);
      console.log('    命中：' + f.match);
      console.log('    原文：' + f.source);
    }
    console.log('');
    console.log('修法：把这段上游概念搬进 app/kernel/dsh-provider/ 内，');
    console.log('      产品层改调用契约（contract.mjs）里的语义接口。');
  }
  console.log('');
  console.log('DONE fails=' + (r.findings.length ? 1 : 0));
  process.exitCode = r.findings.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

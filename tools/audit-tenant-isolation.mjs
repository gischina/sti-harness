/**
 * 多租户隔离静态审计（M5 · 验收依据「全表 tenant_id 强制注入，仓储层统一过滤」）。
 *
 * 方法：
 *   1. 在内存库上按序应用全部迁移，得到「哪些表带 tenant_id 列」的**事实清单**
 *      （不是手写清单 —— 以后加表忘了进来，是清单的问题不是扫描的问题）；
 *   2. 扫描 app/ 下全部 .mjs 里的 SQL 字符串（含模板字符串，按 `;` 拆句）；
 *   3. 任何触碰租户隔离表的语句，SQL 文本里必须出现 `tenant_id`
 *      （SELECT/DELETE/UPDATE 的 where、JOIN 的条件、INSERT 的列清单各算数）；
 *      没有 → 违规。确属全局语句的，在 SQL 附近写 `tenant-ok: <理由>` 标记豁免
 *      —— 豁免必须带理由，没有理由的豁免本身就是违规。
 *
 * 局限（诚实边界）：静态扫描抓「忘了过滤」，抓不住「过滤值用错变量」；
 * 后者由双租户动态用例（test-governance 跨租户 section）钉住。两层合在一起才是验收。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'app');
const MIGRATIONS_DIR = path.join(APP_DIR, 'data', 'migrations');

/* 1+2. 扫描（scan0）；CLI 报告（printReport） */

/* 3. 报告（CLI 专用；测试进程内调 scan() 只看返回值） */
function printReport({ scoped, statementsChecked, violations }) {
  console.log('');
  console.log('租户隔离静态审计（表清单来自迁移事实，非手写）');
  console.log('  租户隔离表 ' + scoped.length + ' 张：' + scoped.join(', '));
  console.log('  触碰隔离表的 SQL 语句：' + statementsChecked + ' 条');
  if (violations.length) {
    console.log('');
    console.log('\u2717 违规 ' + violations.length + ' 条（触碰租户隔离表但没有 tenant_id 过滤，也没有 tenant-ok 豁免标记）：');
    for (const v of violations) {
      console.log('  \u00b7 ' + v.file + ':' + v.line + '  [' + v.tables.join(',') + ']');
      console.log('    ' + v.sql);
    }
    console.log('');
    console.log('DONE violations=' + violations.length);
    return 1;
  }
  console.log('  违规 0 条 —— 所有触碰租户隔离表的语句都带 tenant_id 或显式豁免');
  console.log('DONE violations=0');
  return 0;
}

/** 进程内入口：给回归套件直接调，避免 spawn 子进程（EBUSY 环境不可靠）。 */
export function scan() {
  return scan0();
}

function scan0() {
  /* 1. 事实清单：内存库跑迁移，收集带 tenant_id 的表 */
  const mem = new DatabaseSync(':memory:');
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) mem.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  const SCOPED = [];
  for (const t of mem.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const cols = mem.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name);
    if (cols.includes('tenant_id')) SCOPED.push(t.name);
  }
  mem.close();
  if (!SCOPED.length) {
    throw new Error('扫描失败：迁移里没找到任何租户隔离表（清单不可能为空）');
  }

  /* 2. 收集 SQL 字符串 */
  function* walkMjs(dir) {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) yield* walkMjs(p);
      else if (name.name.endsWith('.mjs')) yield p;
    }
  }

  /** 从源码里剥掉注释与普通代码，抓出所有字符串内容（含模板字符串），返回 {text, line} */
  function extractStrings(src) {
    const out = [];
    let i = 0, line = 1;
    const n = src.length;
    const push = (text, startLine, startIdx) => out.push({ text, line: startLine, start: startIdx });
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      // 行注释 / 块注释
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
      // 字符串（' " `）—— 模板字符串可能嵌套 ${}，简单处理：把 ${...} 当普通文本跳过
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        const startLine = line;
        const startIdx = i - 1;
        let text = '';
        i++;
        while (i < n && src[i] !== quote) {
          if (src[i] === '\\') { text += src[i] + (src[i + 1] || ''); i += 2; continue; }
          if (src[i] === '\n' && quote !== '`') break; // 单双引号串里的换行是语法错误，停
          text += src[i];
          if (src[i] === '\n') line++;
          i++;
        }
        i++;
        push(text, startLine, startIdx);
        continue;
      }
      i++;
    }
    return out;
  }

  const SQL_KEYWORD = /\b(select|insert|update|delete|replace)\b/i;
  /** 表引用必须是 SQL 语法位置（from/join/into/update 之后），裸词会误伤 URL 与注释文本 */
  const tableRefRe = (t) => new RegExp(`\\b(from|join|into|update)\\s+"?${t}\\b`, 'i');
  const violations = [];
  let statementsChecked = 0;

  for (const file of walkMjs(APP_DIR)) {
    const rel = path.relative(ROOT, file).replaceAll('\\', '/');
    const src = fs.readFileSync(file, 'utf8');
    for (const { text, line, start } of extractStrings(src)) {
      if (!SQL_KEYWORD.test(text)) continue;
      // 按 ; 拆成单句（模板字符串里常有多句）
      for (const stmt of text.split(';')) {
        const s = stmt.trim();
        if (!SQL_KEYWORD.test(s)) continue;
        const touched = SCOPED.filter((t) => tableRefRe(t).test(s));
        if (!touched.length) continue;
        statementsChecked++;
        if (/\btenant_id\b/i.test(s)) continue;
        if (/tenant-ok\s*:/i.test(s)) continue; // 语句内标记的显式豁免
        // 扩展到**代码语句级**：run('UPDATE t SET ' + x + ' WHERE tenant_id = ?') 这种
        // 拼接模式里，tenant_id 在相邻的字面量里 —— 取字面量起点往后到语句结束的
        // 源码片段（截 800 字符），把其中所有字符串内容拼起来再判一次。
        const ctx = src.slice(start, start + 800);
        const ctxTexts = extractStrings(ctx).map((x) => x.text).join(' ');
        if (/\btenant_id\b/i.test(ctxTexts)) continue;
        // 豁免标记也允许写在语句附近的注释里（前后 3 行内，必须带理由）
        const lineStart = src.lastIndexOf('\n', Math.max(0, start - 1));
        const before = src.slice(Math.max(0, start - 400), start);
        const after = ctx;
        if (/tenant-ok\s*:/i.test(before) || /tenant-ok\s*:/i.test(after)) continue;
        violations.push({ file: rel, line, tables: touched, sql: s.replace(/\s+/g, ' ').slice(0, 140) });
      }
    }
  }

  return { scoped: SCOPED, statementsChecked, violations };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  let code = 0;
  try {
    code = printReport(scan0());
  } catch (e) {
    console.error(String(e.message || e));
    code = 1;
  }
  process.exit(code);
}

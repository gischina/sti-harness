/**
 * 静态托管 public/。
 *
 * 两个从同权利人早期作品的部署经验继承而来：
 *  1. **`file://` 误开兜底**：用户常常双击 index.html 打开，页面会因为相对路径
 *     与 API 全部失效而白屏，看不出原因。这里不解决它（静态页做不到），
 *     但在**服务端**给出能照着做的提示。
 *  2. **前端文件缺失**：只拷了 app/ 忘了 public/ 是最常见的部署事故，
 *     首页给一段可操作的说明，而不是一句 not found。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR } from '../paths.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const NO_CACHE = { 'cache-control': 'no-cache' };

function missingIndexPage() {
  return '<!doctype html><meta charset="utf-8">'
    + '<body style="font:14px/1.8 system-ui,\'Microsoft YaHei\',sans-serif;max-width:660px;margin:12vh auto;padding:0 20px">'
    + '<h2>前端文件缺失</h2>'
    + '<p>后端已启动，但找不到 <code>' + escapeHtml(path.join(PUBLIC_DIR, 'index.html')) + '</code>。</p>'
    + '<p>请把 <code>public/</code> 整个目录与 <code>app/</code> 放在同一层（即项目根目录下）。</p>'
    + '<p>在本目录执行 <code>node app/main.mjs --check</code> 可做一次完整环境自检。</p></body>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * @returns {boolean} 是否已经处理（true = 响应已结束）
 */
export function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(path.join(PUBLIC_DIR, rel));
  // 目录穿越防护
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
    return true;
  }

  fs.readFile(target, (err, buf) => {
    if (err) {
      if (rel === '/index.html') {
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8', ...NO_CACHE }).end(missingIndexPage());
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...NO_CACHE }).end('not found: ' + rel);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // HTML 与 JS 不缓存：单机部署下"改了文件刷新还是老样子"是最烦人的坑
      ...(ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css' ? NO_CACHE : {}),
    });
    res.end(buf);
  });
  return true;
}

/**
 * 前端产物是否就位（自检用）。
 *
 * ⚠️ 清单**从 index.html 现读**，不写死 —— 前端自 0.11.2 起按域拆成 `public/app/*.js` 多片，
 * 写死一份清单就等于"自检只盯着它记得的那几个文件"，新增/改名的分片漏拷了也照报绿。
 * 这里改成解析 index.html 里的 `src=` / `href=`（相对 `./`），**页面真的会去取的每个文件都必须存在**。
 */
export function staticAssets() {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  let refs = [];
  try {
    const html = fs.readFileSync(indexPath, 'utf8');
    refs = [...html.matchAll(/(?:src|href)=["']\.\/([^"']+)["']/g)].map((m) => m[1]);
  } catch { /* index.html 缺失：下面的清单只有它自己，会如实报缺 */ }
  const need = ['index.html', ...new Set(refs)];
  return need.map((f) => {
    const p = path.join(PUBLIC_DIR, f);
    let size = null;
    try { size = fs.statSync(p).size; } catch { /* 缺失 */ }
    return { file: f, exists: size != null, size, path: p };
  });
}

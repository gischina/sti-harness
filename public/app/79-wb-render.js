'use strict';
/* 79-wb-render.js —— 0.19.0：工作台渲染器增强
 * 助手正文的安全 markdown 子集渲染 + 工具参数/结果的 JSON 富格式。
 *
 * 设计底线：**先转义、后变换**（escape-first）。
 *   1. 先把 ``` 围栏代码块整体切出（body 内不可能出现 ```），块体永不走行内变换；
 *   2. 其余文本整段 esc()，再做行内标记变换 —— 任何未闭合/非法语法自然以字面形式输出，
 *      原始 HTML 永远按字面显示（想注入 <script> 只会看到 "&lt;script&gt;"）；
 *   3. 链接只放行 http/https/mailto/相对路径（无 scheme），其余 scheme 退化为纯文本。
 * 流式中途收到半个语法也安全：不成对的 ` / * / [ 按字面透传。
 */
(function () {
  const TOKEN_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g;

  function splitInline(escLine) {
    return escLine.split(TOKEN_RE).map((tok, i) => {
      if (i % 2 === 0) return tok;                       // 纯文本段（已转义）
      if (tok[0] === '`') return '<code>' + tok.slice(1, -1) + '</code>';
      if (tok.startsWith('**')) return '<strong>' + tok.slice(2, -2) + '</strong>';
      if (tok[0] === '*') return '<em>' + tok.slice(1, -1) + '</em>';
      const m = tok.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/);
      const href = (m && m[2]) || '';
      if (!urlIsSafe(href)) return tok;                  // 不安全的 scheme → 纯文本
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + (m[1] || href) + '</a>';
    }).join('');
  }

  function urlIsSafe(href) {
    if (!href || /[\s"'<>]/.test(href)) return false;
    if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) return true;
    return /^(https?:|mailto:)/i.test(href);
  }

  function renderInlineChunk(escText) {
    return escText.split('\n').map(splitInline).join('\n');
  }

  // 非围栏行按块分组渲染（esc 后的行首标记：'### '、'&gt; '、'- '/'* '、'1. '）
  function renderLooseLines(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lv = h[1].length;
        out.push('<div class="wb-md-h' + lv + '">' + renderInlineChunk(h[2]) + '</div>');
        i++; continue;
      }
      if (line.startsWith('&gt; ')) {
        const buf = [];
        while (i < lines.length && lines[i].startsWith('&gt; ')) buf.push(lines[i++].slice(5));
        out.push('<blockquote class="wb-md-quote">' + renderInlineChunk(buf.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^[-*]\s+/, ''));
        out.push('<ul class="wb-md-ul">' + buf.map((x) => '<li>' + renderInlineChunk(x) + '</li>').join('') + '</ul>');
        continue;
      }
      if (/^\d+[.)]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\d+[.)]\s+/, ''));
        out.push('<ol class="wb-md-ol">' + buf.map((x) => '<li>' + renderInlineChunk(x) + '</li>').join('') + '</ol>');
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim()) buf.push(lines[i++]);
      out.push('<p class="wb-md-p">' + renderInlineChunk(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
    }
    return out.join('');
  }

  function renderMarkdown(src) {
    const text = String(src == null ? '' : src);
    if (!text) return '';
    const parts = [];
    const re = /```([A-Za-z0-9_+-]*)\n([\s\S]*?)(?:```|$)/g;
    let last = 0; let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push({ t: 'loose', v: text.slice(last, m.index) });
      parts.push({ t: 'code', lang: m[1], v: m[2] });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ t: 'loose', v: text.slice(last) });
    return parts.map((p) => {
      if (p.t === 'code') {
        const lang = esc(p.lang || '');
        const body = esc(p.v.replace(/\n$/, ''));
        return '<pre class="wb-md-pre"' + (lang ? ' data-lang="' + lang + '"' : '') + '><code>' + body + '</code></pre>';
      }
      return renderLooseLines(esc(p.v).split('\n'));
    }).join('');
  }

  function toolJsonHtml(v) {
    let s = (typeof v === 'string') ? v : JSON.stringify(v, null, 2);
    if (s === undefined) s = String(v);
    if (s.length > 280) {
      return '<details class="wb-tool-json"><summary>展开 JSON（' + s.length + ' 字符）</summary>'
        + '<pre class="mono-block">' + esc(s) + '</pre></details>';
    }
    return '<code class="wb-tool-inline">' + esc(s) + '</code>';
  }

  const api = { renderMarkdown, toolJsonHtml, urlIsSafe };
  window.STIRender = api;
  // vm 沙箱里 window 是独立对象、≠全局对象；两条路都铺，渲染层才能稳定取到。
  globalThis.STIRender = api;
})();

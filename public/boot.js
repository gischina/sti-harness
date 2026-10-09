/* STI HARNESS 首屏引导脚本
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 为什么单独一个文件（而不是写在 index.html 里）：
 *   CSP 一旦去掉 `script-src 'unsafe-inline'`，HTML 里的**内联 `<script>` 会被整段拒绝执行**。
 *   首屏上色与 file:// 兜底又必须在内联脚本位置尽早跑，所以把这两段挪成外链文件
 *   —— 同源脚本在 `script-src 'self'` 下照常执行，且 CSP 的 XSS 防护得以恢复。
 *
 * ⚠️ 首屏上色必须**在 CSS 应用前**执行，否则暗色下会先白闪一下。
 *    它是阻塞式 `<script src>` 放在 <head> 里，因此仍在首次绘制之前运行。
 */
'use strict';

/* 首屏上色：按系统主题给 <html> 打标记 */
(function () {
  try {
    var t = localStorage.getItem('sti.theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }
})();

/* file:// 误开兜底：静态页无法自愈，但要说清原因，而不是留一片空白 */
if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', function () {
    document.body.innerHTML = '<div class="boot-error">'
      + '<h1>打开方式不对</h1>'
      + '<p>你直接双击了这个文件（<code>file://</code>）。这个页面需要由后端提供，'
      + '否则所有接口都会失效。</p>'
      + '<p>请先启动服务，再访问对应地址：</p>'
      + '<pre>node app/main.mjs</pre>'
      + '<p>然后浏览器打开 <code>http://127.0.0.1:3090</code></p>'
      + '</div>';
  });
}

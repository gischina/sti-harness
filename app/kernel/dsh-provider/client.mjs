/**
 * DSH 客户端 —— 地址/令牌解析、令牌换 cookie、反代调用、版本探测。
 *
 * ⚠️ 本文件位于 `dsh-provider/` 内，**是 DSH 专有名词的合法归属地**。
 * 产品层与前端不得出现这里的任何 DSH 概念（由 tools/audit-layering.mjs 拦截）。
 *
 * 从基线实现迁移过来的既有实现（已验证有效）：
 *   · `dsh web` 打印 http://127.0.0.1:3080/?token=<launchToken>
 *   · GET /?token=… 校验通过后回 303 + Set-Cookie: dsh-auth-<authority>=v1.…
 *   · 此后 /api/* 与实时流 WebSocket 的 upgrade 都必须带这个 cookie，否则 401
 *   · 反代/桥接必须替浏览器完成 token→cookie 的换取并持续携带
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseDshOrigin } from '../../config.mjs';
import { log } from '../../log.mjs';
import { neutralizeUpstreamText } from './brand.mjs';

const DEFAULT_TIMEOUT = 5000;

export function createDshClient({ origin, token = '', profile = 'web' } = {}) {
  const parsed = parseDshOrigin(origin);
  const state = {
    origin: parsed.origin,
    token: token || parsed.token || '',
    source: 'explicit',
    profile,
    cookie: '',
    cookieExpiresAt: 0,
    authError: '',
    version: null,
    rev: '',
  };

  const authHeaders = () => (state.cookie ? { cookie: state.cookie } : {});

  /** 用令牌换会话 cookie */
  async function exchangeToken(timeoutMs = 6000) {
    if (!state.token) return { ok: false, mode: 'no-token', error: '未配置令牌' };
    try {
      const r = await fetch(state.origin + '/?token=' + encodeURIComponent(state.token), {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
      const setCookie = r.headers.get('set-cookie') || '';
      const m = /(dsh-auth-[^=;]+)=([^;]+)/.exec(setCookie);
      if (!m) {
        return {
          ok: false,
          status: String(r.status),
          error: (r.status === 401 || r.status === 403)
            ? '令牌被内核拒绝（HTTP ' + r.status + '）—— 多半已过期，重新从内核取启动地址'
            : '该地址没有下发内核会话 cookie（HTTP ' + r.status + '）—— 它可能不是内核服务，或该版本不需要令牌',
        };
      }
      const maxAge = Number((/Max-Age=(\d+)/i.exec(setCookie) || [])[1] || 0);
      state.cookie = m[1] + '=' + m[2];
      state.cookieExpiresAt = maxAge ? Date.now() + maxAge * 1000 : 0;
      state.authError = '';
      return { ok: true, mode: 'exchanged', status: String(r.status) };
    } catch (e) {
      return { ok: false, error: '连接内核失败：' + e.message };
    }
  }

  /** 需要时（首次 / 快过期 / 被 401 拒）刷新 cookie */
  async function ensureAuth(force = false) {
    if (!state.token) { state.cookie = ''; state.cookieExpiresAt = 0; return { ok: true, mode: 'no-token' }; }
    if (!force && state.cookie && (!state.cookieExpiresAt || state.cookieExpiresAt - Date.now() > 60000)) {
      return { ok: true, mode: 'cached' };
    }
    const r = await exchangeToken();
    if (!r.ok) state.authError = r.error || '换取会话 cookie 失败';
    return r;
  }

  /** 本平台自己调一个上游一元 RPC（页面请求走 transport 原样转发，不走这里） */
  async function remoteCall(method, args = {}) {
    const send = () => fetch(state.origin + '/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ type: 'client-request', rpcId: 'sti-' + Date.now(), method, payload: { args } }),
    });
    let r = await send();
    if (r.status === 401 && state.token) {
      const again = await ensureAuth(true);
      if (again.ok) r = await send();
    }
    const j = await r.json().catch(() => null);
    const result = j && j.result;
    if (!result) {
      const e = new Error('上游响应异常（HTTP ' + r.status + '）');
      e.code = 'upstream';
      e.httpStatus = 502;
      throw e;
    }
    // 值级失败：{ok:false,error} 也是成功响应（基线实现踩过这个坑）
    if (result.ok === false) {
      const d = result.error || {};
      const e = new Error(d.message || d.code || '上游调用失败');
      e.code = d.code || 'upstream_error';
      throw e;
    }
    return result.value;
  }

  /**
   * 判断该地址上是不是 DSH、要不要令牌、当前是否已认证。
   * 只看 `GET /` 与响应特征，**不依赖任何 RPC 方法名** —— 方法名随版本变，
   * 而根路径语义稳定（未认证恒为 401 + "dsh web authentication required"）。
   */
  async function probe(timeoutMs = DEFAULT_TIMEOUT) {
    try {
      const r = await fetch(state.origin + '/', {
        method: 'GET', redirect: 'manual',
        headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs),
      });
      const ct = r.headers.get('content-type') || '';
      const raw = await r.text().catch(() => '');
      const isDshPage = /__DSH_BOOT__|DeepSeek Harness/i.test(raw);
      const needsToken = r.status === 401 && /dsh web authentication required/i.test(raw);
      const forbidden = r.status === 403 && /forbidden/i.test(raw);
      const isDsh = needsToken || (r.status === 200 && isDshPage);
      const rev = (/"rev"\s*:\s*"([0-9a-f]{6,})"/i.exec(raw) || [])[1] || '';
      if (rev) state.rev = rev;
      return {
        ok: isDsh, authed: r.status === 200 && isDsh, needsToken, forbidden,
        reachable: true, rev, status: String(r.status),
        server: r.headers.get('server') || '—', ct,
        body: raw.replace(/\s+/g, ' ').trim().slice(0, 200),
      };
    } catch (e) {
      return {
        ok: false, authed: false, needsToken: false, forbidden: false,
        reachable: false, rev: '', status: '—', server: '—', ct: '', body: e.message,
      };
    }
  }

  /** 汇总状态（state 取值：ok / need-token / token-rejected / forbidden / unreachable / not-kernel） */
  async function status(timeoutMs = DEFAULT_TIMEOUT) {
    await ensureAuth(false);
    let p = await probe(timeoutMs);
    if (p.needsToken && state.token && state.authError) {
      await ensureAuth(true);
      p = await probe(timeoutMs);
    }
    const out = {
      origin: state.origin, hasToken: !!state.token, profile: state.profile,
      reachable: p.reachable, authed: p.authed, httpStatus: p.status,
      rev: p.rev || '', version: version(), state: 'unknown', detail: '', error: '',
      /**
       * **事实**（不是散文）：产品层要拿它自己拼"给人看的话"。
       *
       * 为什么要把观测值单列出来：`detail` 里的散文一旦带上游产品名，就会随
       * **运行期字符串**穿到用户屏幕上（`tools/audit-layering.mjs` 是源码静态扫描，
       * 看不见运行期 —— 真机验收才抓到了「不像是 DSH」直接显示在接入向导里）。
       * 事实是安全的、可复用的、不会随上游改名而失真。
       */
      facts: {
        httpStatus: String(p.status || '—'),
        server: p.server || '—',
        contentType: p.ct || '',
      },
    };
    if (p.authed) { out.state = 'ok'; out.detail = '已认证，内核可用'; return out; }
    if (p.needsToken) {
      out.state = state.token ? 'token-rejected' : 'need-token';
      // authError 来自**上游响应体**（我们控制不了的内容）→ 交给运行期抹名防线处理。
      out.error = state.token ? neutralizeUpstreamText(state.authError || '令牌无效或已过期') : '';
      out.detail = state.token ? '当前令牌被拒绝（多半已过期或来自上一次启动）' : '该地址要求浏览器会话鉴权';
      return out;
    }
    if (p.forbidden) { out.state = 'forbidden'; out.detail = '该地址拒绝了本机来源的请求'; return out; }
    if (!p.reachable) { out.state = 'unreachable'; out.error = neutralizeUpstreamText(p.body); out.detail = '连不上该地址'; return out; }
    out.state = 'not-kernel';
    // 这里**不写"不像是某某"**：结论由产品层的词表说（见 connection-config 的 KERNEL_STATE_TEXT），
    // provider 只负责报"对面回了什么"这几项客观值。
    out.detail = 'HTTP ' + p.status + '，Server: ' + p.server + '，Content-Type: ' + (p.ct || '—');
    return out;
  }

  // ── dsh 命令行发现与版本读取 ───────────────────────────────

  function candidates() {
    const list = [];
    const push = (p) => { if (p && !list.includes(p)) list.push(p); };
    if (process.env.DSH_BIN) push(process.env.DSH_BIN);
    const isWin = process.platform === 'win32';
    const names = isWin ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
    // PATH 上的 dsh
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      for (const n of names) push(path.join(dir, n));
    }
    // node.exe 同目录
    push(path.join(path.dirname(process.execPath), isWin ? 'dsh.cmd' : 'dsh'));
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (isWin && process.env.APPDATA) push(path.join(process.env.APPDATA, 'npm', 'dsh.cmd'));
    push(path.join(home, '.npm-global', 'bin', 'dsh'));
    push('/usr/local/bin/dsh');
    push('/opt/homebrew/bin/dsh');
    return list.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
  }

  /** 由 dsh 垫片反推它旁边的 @deepseek-ai/dsh/package.json */
  function packageDir(cmdPath) {
    const dirsToTry = [];
    let cur = path.dirname(cmdPath);
    for (let i = 0; i < 5 && cur && cur !== path.dirname(cur); i++) {
      dirsToTry.push(path.join(cur, 'node_modules', '@deepseek-ai', 'dsh'));
      dirsToTry.push(path.join(cur, '..', '@deepseek-ai', 'dsh'));
      cur = path.dirname(cur);
    }
    for (const d of dirsToTry) {
      try {
        if (fs.existsSync(path.join(d, 'package.json'))) return path.resolve(d);
      } catch { /* 换下一个 */ }
    }
    return null;
  }

  function runDsh(args) {
    for (const cmd of candidates()) {
      try {
        const out = execFileSync(cmd, args, {
          encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        });
        return { ok: true, out: String(out || ''), via: cmd };
      } catch (e) {
        const out = (e && (e.stdout || '')) ? String(e.stdout) : '';
        if (out) return { ok: true, out, via: cmd };
      }
    }
    return { ok: false, out: '', via: null };
  }

  /** DSH 版本。只从本机读：先反推包目录的 package.json，再退回 `dsh --version`。 */
  function version() {
    if (state.version !== null) return state.version;
    state.version = '—';
    try {
      for (const c of candidates()) {
        const d = packageDir(c);
        if (!d) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
          if (j.version) { state.version = j.version; break; }
        } catch { /* 换下一个 */ }
      }
      if (state.version === '—') {
        const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(runDsh(['--version']).out || '');
        if (m) state.version = m[1];
      }
    } catch { /* 保持 '—'，界面显示"未获取" */ }
    return state.version;
  }

  /** 列出本机所有能找到的 dsh（自检里逐条打印，来源透明） */
  function discover() {
    const found = [];
    for (const c of candidates()) {
      const d = packageDir(c);
      let v = '';
      if (d) { try { v = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).version || ''; } catch { /* ignore */ } }
      found.push({ bin: c, packageDir: d, version: v });
    }
    if (!found.length) {
      const r = runDsh(['--version']);
      if (r.ok) found.push({ bin: r.via, packageDir: null, version: (/(\d+\.\d+\.\d+[^\s]*)/.exec(r.out) || [])[1] || '' });
    }
    return found;
  }

  /** 运行 `dsh --profile <p> --dump-config`，拿到合成后的插件树 YAML 文本 */
  function dumpConfig(profileName = state.profile) {
    const r = runDsh(['--profile', profileName, '--dump-config']);
    if (!r.ok) return { ok: false, error: '未能执行 dsh --dump-config（本机可能没装 dsh 命令行）', via: null, text: '' };
    return { ok: true, text: r.out, via: r.via };
  }

  return {
    state, authHeaders, exchangeToken, ensureAuth, remoteCall, probe, status,
    candidates, packageDir, runDsh, version, discover, dumpConfig,
    get origin() { return state.origin; },
    get cookie() { return state.cookie; },
    _log: log,
  };
}

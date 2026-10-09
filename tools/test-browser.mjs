/**
 * 真机浏览器自动化验收 —— 核心旅程级 + 全局异常对账。
 *
 * 为什么必须有它（连续四版抓到门禁漏网缺陷）：
 *   · test-http 保接口状态码 / test-frontend 保 vm 渲染钉，都不跑真实 DOM 与事件委托；
 *   · 0.15.1「取消语义」bug、0.15.0「知识库挂完不刷新」bug、0.14.2「侧栏键盘不可达」bug
 *     全部是 vm 层全绿、浏览器层必红的真实案例。
 *
 * 设计原则：
 *   · 零第三方依赖 —— Node 24 内置全局 WebSocket + Chrome DevTools Protocol；
 *   · 本机 Edge/Chrome 无头实例 —— 从 stderr 正则截 ws:// 地址；
 *   · 找不到浏览器 → SKIP（明确说明原因，绝不计入通过），同 test-external.mjs 纪律；
 *   · **找到了但起不来**（装是装了，无头模式被策略拦掉 / 不产出 DevTools 端口）→ 同样 SKIP，
 *     理由同上：这是**环境限制**，不是被测代码缺陷。把它记成 fails 的后果是门禁"机器决定成败"，
 *     用久了必被人习惯性忽略 —— 那它守着的 23 个场景就全白写了。
 *   · 同进程装配全部服务（照 test-http.mjs 夹具），server.listen(0) 随机端口；
 *   · 23 个场景：19 个覆盖四条业务流（组织身份 / RAG 闭环 / 治理 / 运维）
 *     + 4 个 UI 不变式（窄视口右栏可达与开合 / 对话框 Tab 焦点陷阱 / 侧栏滚动位置跨重绘保持 /
 *       工作台收口：左栏收起后可展开 · 节头划过显形 · 正文与输入卡同轴）；
 *     对账场景永远排最后：它收口此前全部场景在页面上累积的未捕获 JS 异常。
 *   · 末行输出 `DONE fails=N skipped=N`。
 *
 * 用法：
 *   node tools/test-browser.mjs
 *   STI_BROWSER="C:\Program Files\Google\Chrome\Application\chrome.exe" node tools/test-browser.mjs
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let total = 0, fails = 0, skips = 0;
const failures = [], skipped = [];
// 逐场景身份轨迹：`STI_BROWSER_TRACE=1` 时每个场景结束后打一行「当前 hash / 视图 / 登录是谁」。
// 排查"某条用例莫名找不到元素"时，最先要排除的就是**登录态被别人换掉了** ——
// 一条用例把身份换错，后面十几条会集体假红，而错误信息只会说"选择器没找到"。
const TRACE = process.env.STI_BROWSER_TRACE === '1';

async function traceLine() {
  if (!TRACE || !br) return;
  try {
    const d = await br.eval(`(function(){
      return { hash: location.hash, view: (typeof State !== 'undefined' ? State.view : '?'),
        me: (typeof State !== 'undefined' && State.me && State.me.user) ? (State.me.user.username || null) : null };
    })()`, { awaitPromise: false });
    console.log('      · ' + JSON.stringify(d));
  } catch (e) { /* 诊断本身失败就算了 */ }
}

async function t(name, fn) {
  total++;
  try {
    const r = await fn();
    if (r && r.skip) { total--; skips++; skipped.push({ name, reason: r.skip }); console.log('  ~ ' + name); console.log('      跳过：' + r.skip); return; }
    console.log('  ✓ ' + name);
    await traceLine();
  } catch (e) {
    fails++; failures.push({ name, error: e });
    console.log('  ✗ ' + name);
    const msg = (e && e.message) ? String(e.message) : String(e);
    for (const line of msg.split('\n').slice(0, 8)) console.log('      ' + line);
    // 失败时的现场快照：光看"某个选择器没找到"推不出根因（是没渲染？渲染成别的分支？
    // 还是登录态掉了？），把 hash / 视图 / 身份 / 外壳三类元素的存在性一次性打出来。
    if (br) {
      try {
        const d = await br.eval(`(function(){
          var app = document.querySelector('#app');
          var txt = app ? (app.innerText || '') : '';
          return {
            hash: location.hash, view: (typeof State !== 'undefined' ? State.view : '?'),
            me: (typeof State !== 'undefined' && State.me ? (State.me.user && State.me.user.username) : null),
            roles: (typeof State !== 'undefined' && State.me && State.me.user) ? (State.me.user.roles || State.me.user.role || null) : null,
            topbar: !!document.querySelector('.topbar'), sidebar: !!document.querySelector('.sidebar'),
            head: txt.slice(0, 160).replace(/\s+/g, ' '),
          };
        })()`, { awaitPromise: false });
        console.log('      [现场] ' + JSON.stringify(d));
      } catch (e2) { /* 诊断本身失败就算了 */ }
    }
  }
}
function section(s) { console.log(''); console.log('── ' + s + ' ' + '─'.repeat(Math.max(0, 56 - s.length))); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── CDP 客户端（零依赖）────────────────────────────────────────────── */

class CdpBrowser {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.sessionId = null;
    this._onMessageBound = (data) => this._onMessage(JSON.parse(data));
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error('WebSocket 连接失败：' + e.message));
      this.ws.onmessage = (msg) => this._onMessage(JSON.parse(msg.data));
    });
  }

  _onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    } else {
      this.events.push(msg);
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const envelope = { id, method, params };
    if (this.sessionId) envelope.sessionId = this.sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify(envelope));
    });
  }

  async createPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Network.enable');
    // 注入全局错误收集器（S22 用）
    await this.send('Runtime.addBinding', { name: '__stiBrowserError' });
    await this.eval(`
      window.__stiErrors = [];
      window.addEventListener('error', e => {
        window.__stiErrors.push({type:'error', msg:e.message, file:e.filename, line:e.lineno});
        if (window.__stiBrowserError) window.__stiBrowserError({type:'error', msg:e.message});
      });
      window.addEventListener('unhandledrejection', e => {
        window.__stiErrors.push({type:'unhandledrejection', msg:String(e.reason)});
        if (window.__stiBrowserError) window.__stiBrowserError({type:'unhandledrejection', msg:String(e.reason)});
      });
    `, { awaitPromise: false });
    return targetId;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const ready = await this.eval('document.readyState', { awaitPromise: false });
      if (ready === 'complete') {
        await sleep(400); // 给前端 boot() 留时间
        return;
      }
      await sleep(200);
    }
    throw new Error('导航超时：' + url);
  }

  async reload() {
    await this.send('Page.reload');
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const ready = await this.eval('document.readyState', { awaitPromise: false });
      if (ready === 'complete') { await sleep(400); return; }
      await sleep(200);
    }
    throw new Error('刷新超时');
  }

  async eval(expression, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...opts,
    });
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error('JS 异常: ' + desc);
    }
    return r.result?.value;
  }

  async exists(selector) {
    return !!(await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`, { awaitPromise: false }));
  }

  async textOf(selector) {
    return await this.eval(`(function(){ var el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : ''; })()`);
  }

  async click(selector) {
    await this.eval(`
      (function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('click miss: ${selector}');
        el.scrollIntoView({block:'center'});
        el.click();
      })()
    `);
  }

  async type(selector, text) {
    await this.eval(`
      (function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('type miss: ${selector}');
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
  }

  async selectOption(selector, value) {
    await this.eval(`
      (function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('select miss: ${selector}');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
  }

  async waitFor(selector, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await this.exists(selector)) return;
      await sleep(250);
    }
    throw new Error('waitFor 超时: ' + selector);
  }

  async waitForText(selector, text, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const txt = await this.textOf(selector);
      if (txt.includes(text)) return txt;
      await sleep(250);
    }
    throw new Error(`waitForText 超时: ${selector} 不含 "${text}"`);
  }

  async waitForNoSpinner(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const count = await this.eval(`document.querySelectorAll('.spinner').length`, { awaitPromise: false });
      if (count === 0) return;
      await sleep(300);
    }
    throw new Error('等待 spinner 消失超时');
  }

  async assertNoRenderError() {
    const body = await this.eval(`document.body.innerText`, { awaitPromise: false });
    if (body.includes('本页渲染失败')) throw new Error('页面出现「本页渲染失败」');
  }

  async currentHash() {
    return await this.eval('location.hash', { awaitPromise: false });
  }

  async hashTo(hash) {
    await this.eval(`location.hash = ${JSON.stringify(hash)}`);
    await sleep(600);
    await this.waitForNoSpinner(8000);
    await this.assertNoRenderError();
  }

  close() {
    if (this.ws) { this.ws.close(); this.ws = null; }
  }
}

/* ── 浏览器探测 ─────────────────────────────────────────────────────── */

function probeBrowser() {
  const env = process.env.STI_BROWSER;
  if (env) {
    if (fs.existsSync(env)) return env;
    // 显式指定但文件不存在 → SKIP（不是 fallback 到自动探测，否则用户配错路径会拿到假绿）
    console.log('  ! STI_BROWSER 指向的文件不存在：' + env);
    return null;
  }
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return null;
}

async function launchBrowser(executable) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-br-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--user-data-dir=' + userDataDir,
  ];
  const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let wsUrl = null;
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('浏览器启动超时（15s）')), 15000);
    let buf = '';
    proc.stderr.on('data', (chunk) => {
      buf += chunk;
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m && !wsUrl) { wsUrl = m[1]; clearTimeout(timer); res(); }
    });
    proc.on('error', (e) => { clearTimeout(timer); rej(e); });
    proc.on('exit', (code) => { if (!wsUrl) { clearTimeout(timer); rej(new Error('浏览器进程退出码 ' + code)); } });
  });
  return { proc, wsUrl, userDataDir };
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

console.log('');
console.log('STI HARNESS 真机浏览器自动化验收');
console.log('='.repeat(64));

const browserPath = probeBrowser();
if (!browserPath) {
  console.log('');
  console.log('  未找到本机 Chrome/Edge —— SKIP（不是通过）。');
  console.log('  可通过 STI_BROWSER 环境变量指定浏览器可执行文件路径。');
  console.log('');
  console.log('DONE fails=0 skipped=1');
  process.exitCode = 0;
  process.exit();
}

console.log('');
console.log('  浏览器: ' + browserPath);

// 临时数据目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-browser-'));
process.env.STI_DATA_DIR = tmp;
process.env.STI_LOG_LEVEL = 'error';
// 内核改由下面**显式注入测试替身**（0.21.4 起没有"内核模式"这个开关了）。
process.env.STI_RATE_LIMIT = '100000';
process.env.STI_RATE_LIMIT_LOGIN = '100000';

await import('../app/util/quiet-warnings.mjs');

const { ensureRuntimeDirs, DB_FILE, DATA_DIR } = await import('../app/paths.mjs');
const db = await import('../app/data/db.mjs');
const migrate = await import('../app/data/migrate.mjs');
const { loadConfig } = await import('../app/config.mjs');
const { createIdentityService } = await import('../app/platform/identity/service.mjs');
const { createKnowledgeService } = await import('../app/platform/knowledge/service.mjs');
// 0.21.0 起还必须给出工作区服务：工作区路由在装配期就要 deps.workspace（与 main.mjs 同构）。
const { createWorkspaceService } = await import('../app/platform/workspace/service.mjs');
const { createGovernanceService } = await import('../app/platform/governance/service.mjs');
const { createOperationService } = await import('../app/platform/operation/service.mjs');
const { createModelService } = await import('../app/platform/model/service.mjs');
const { createScheduleService } = await import('../app/platform/schedule/service.mjs');
const { createNotifyService } = await import('../app/platform/notify/service.mjs');
const { createKernel } = await import('../app/kernel/index.mjs');
const { createKernelStub } = await import('./kernel-stub.mjs');
const { createServer } = await import('../app/http/server.mjs');
const audit = await import('../app/platform/governance/audit.mjs');
const { encryptSecret, decryptSecret } = await import('../app/platform/identity/credentials.mjs');

ensureRuntimeDirs();
db.openDb(DB_FILE);
migrate.migrate();

const MASTER = crypto.randomBytes(32);
const identity = createIdentityService({ masterSecret: MASTER, sessionTtlMs: 3600 * 1000 });
const config = loadConfig();
// 显式注入测试替身：产品路径上没有"没配地址也能用"的内核（那层降级已删）。
const kernel = createKernel({ provider: createKernelStub(), reason: '回归用测试替身（不依赖真实内核）' });
const knowledge = createKnowledgeService({
  config, audit, resolveCredential: () => null,
  identity,
  resolveScopedRoles: (userId, scopeType) => identity.scopedRolesForUser(userId, scopeType),
});
const operation = createOperationService({ dataDir: DATA_DIR });
const model = createModelService({});
const governance = createGovernanceService({ resolveProviders: (tid) => model.listProviders(tid) });
const notify = createNotifyService({ masterSecret: MASTER, encryptSecret, decryptSecret, allowLoopback: true });
const schedule = createScheduleService({ governance, operation, model, notify });
// 0.21.0 起还必须给出工作区服务：工作区路由在**装配期**就要 deps.workspace（与 main.mjs 同构）。
// ⚠️ 真机验收是唯一"能看见页面长什么样"的一层 —— 它装配不出来的话，
//    工作台改成工作区树之后**没有任何一层**会真正渲染过它。
const workspace = createWorkspaceService({ identity, audit });
const { server } = createServer({
  config, kernel, identity, knowledge, workspace, governance, operation, model, notify, schedule,
  paths: { DATA_DIR }, startedAt: Date.now(),
  encryptSecret: (plain) => encryptSecret(plain, MASTER),
});

await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;

// 浏览器进程与 CDP 客户端
let browserProc = null;
let userDataDir = null;
let br = null;

// Webhook sink 服务器（S18 用）
let sinkServer = null;
let sinkReceived = [];

async function setupSink() {
  sinkReceived = [];
  sinkServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { sinkReceived.push({ method: req.method, url: req.url, body }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise(r => sinkServer.listen(0, '127.0.0.1', r));
}

function sinkUrl() {
  const addr = sinkServer.address();
  return 'http://127.0.0.1:' + addr.port + '/hook';
}

/* ── 场景定义 ───────────────────────────────────────────────────────── */

async function s1_setup() {
  await br.navigate(BASE + '/');
  await br.waitFor('#orgName');
  await br.type('#orgName', '浏览器验收组织');
  await br.type('#adminDisplayName', '验收管理员');
  await br.type('#adminUsername', 'admin');
  await br.type('#adminPassword', 'Adm1n-Pass!23');
  await br.click('[data-act="runSetup"]');
  await br.waitFor('#loginUser');
  // setup 成功后 view='login'，hash 可能为空 —— 断言页面元素而非 hash
  const hasLogin = await br.exists('#loginUser');
  if (!hasLogin) throw new Error('setup 后未出现登录表单');
}

async function s2_login() {
  await br.type('#loginUser', 'admin');
  await br.type('#loginPass', 'Adm1n-Pass!23');
  await br.click('[data-act="login"]');
  await br.waitFor('#wb-input');
  // 落地页=工作台即通过；hash 可能是空（首次登录时 boot 直接渲染，未走 hashchange）
  const hash = await br.currentHash();
  const hasWb = await br.exists('#wb-input');
  if (!hasWb) throw new Error('登录后未进入工作台，hash=' + hash);
}

async function s3_pageSweep() {
  // 从 10-routes.js 运行时读取路由表（同 test-frontend 纪律）
  const routes = await br.eval(`ROUTES`);
  if (!Array.isArray(routes) || routes.length < 21) throw new Error('ROUTES 读取异常：' + (routes && routes.length));
  let renderFails = [];
  let spinnerStuck = [];
  for (const r of routes) {
    await br.hashTo(r.hash);
    await sleep(400);
    try { await br.assertNoRenderError(); }
    catch (e) { renderFails.push(r.id); }
    const spinners = await br.eval(`document.querySelectorAll('.spinner').length`, { awaitPromise: false });
    if (spinners > 0) spinnerStuck.push(r.id);
  }
  if (renderFails.length) throw new Error('渲染失败页面：' + renderFails.join(', '));
  if (spinnerStuck.length) throw new Error('spinner 残留页面：' + spinnerStuck.join(', '));
}

async function s4_createUser() {
  await br.hashTo('#/users');
  await br.waitFor('#nu-user');
  await br.type('#nu-user', 'member1');
  await br.type('#nu-name', '成员一号');
  await br.type('#nu-pass', 'Member1-Pass!');
  // 角色下拉按 key ASC 排序（admin 排第一），必须显式选 member —— 不选建出来的是管理员
  await br.selectOption('#nu-role', 'member');
  await br.click('[data-act="createUser"]');
  await sleep(600);
  await br.waitForNoSpinner(5000);
  const body = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (!body.includes('成员一号')) throw new Error('新建用户后页面未出现成员一号');
}

async function s5_setCred() {
  await br.hashTo('#/creds');
  await br.waitFor('#cd-name');
  await br.type('#cd-name', '浏览器验收凭据');
  await br.type('#cd-provider', 'browser-test');
  await br.type('#cd-value', 'secret-browser-123');
  await br.click('[data-act="setCred"]');
  await sleep(600);
  await br.waitForNoSpinner(5000);
  const body = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (!body.includes('浏览器验收凭据')) throw new Error('新建凭据后未出现在列表');
}

async function s6_roleSidebar() {
  // 登出
  await br.click('[data-act="logout"]');
  await br.waitFor('#loginUser');
  await sleep(300);
  // 成员登录（成员无 session 权限时落地页是概览而非工作台，等登录表单消失即可）
  await br.type('#loginUser', 'member1');
  await br.type('#loginPass', 'Member1-Pass!');
  await br.click('[data-act="login"]');
  let loggedIn = false;
  for (let i = 0; i < 30; i++) {
    const hasLogin = await br.exists('#loginUser');
    if (!hasLogin) { loggedIn = true; break; }
    await sleep(300);
  }
  if (!loggedIn) throw new Error('成员登录后登录表单未消失');
  await sleep(500);
  // 成员有 user:read（看得到账号管理），但没有 credential 权限 —— 用凭据页做侧栏收缩断言
  const hasCredsNav = await br.exists('[data-nav="#/creds"]');
  if (hasCredsNav) throw new Error('成员账号不应看到「凭据托管」导航');
  // 登出 → 管理员回登
  await br.click('[data-act="logout"]');
  await br.waitFor('#loginUser');
  await sleep(300);
  await br.type('#loginUser', 'admin');
  await br.type('#loginPass', 'Adm1n-Pass!23');
  await br.click('[data-act="login"]');
  let adminIn = false;
  for (let i = 0; i < 50; i++) {
    if (!(await br.exists('#loginUser'))) { adminIn = true; break; }
    await sleep(300);
  }
  if (!adminIn) throw new Error('管理员回登后登录表单未消失');
  await sleep(500);
  // 侧栏在任何 app 页面都渲染，直接断言导航存在（此时 hash 可能还停在 #/creds）
  const adminHasCreds = await br.exists('[data-nav="#/creds"]');
  if (!adminHasCreds) throw new Error('管理员应看到「凭据托管」导航');
}

async function s7_createBase() {
  await br.hashTo('#/knowledge');
  await br.waitFor('#kb-name');
  await br.type('#kb-name', '浏览器验收库');
  await br.click('[data-act="createBase"]');
  await sleep(600);
  await br.waitForNoSpinner(5000);
  const body = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (!body.includes('浏览器验收库')) throw new Error('建库后未出现在列表');
}

async function s8_importText() {
  await br.hashTo('#/knowledge');
  await br.waitFor('#kb-doc-title');
  await br.type('#kb-doc-title', '浏览器测试文档');
  await br.type('#kb-text', 'STI HARNESS 浏览器自动化验收专用文本。知识库检索测试。');
  await br.click('[data-act="importText"]');
  await sleep(600);
  await br.waitForNoSpinner(10000);
  // 等待解析完成（轮询状态徽章）
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const body = await br.eval(`document.body.innerHTML`, { awaitPromise: false });
    if (body.includes('可检索')) { ready = true; break; }
    await sleep(500);
  }
  if (!ready) throw new Error('文本导入后未出现「可检索」状态');
}

async function s9_search() {
  await br.hashTo('#/knowledge');
  await br.waitFor('#kb-q');
  await br.type('#kb-q', '浏览器自动化');
  await br.type('#kb-limit', '5');
  await br.click('[data-act="runSearch"]');
  await sleep(600);
  await br.waitForNoSpinner(8000);
  const body = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (body.includes('没有命中')) throw new Error('检索应命中，但显示「没有命中」');
  if (!body.includes('浏览器测试文档')) throw new Error('检索结果未包含预期文档标题');
}

async function s10_mountKb() {
  // 先确保回到工作台
  await br.hashTo('#/workbench');
  await br.waitFor('#wb-input');
  // 获取第一个知识库 id
  const kbId = await br.eval(`
    (State.wb.kbList && State.wb.kbList[0] && State.wb.kbList[0].id) || ''
  `);
  if (!kbId) throw new Error('工作台没有可见知识库');
  // 新建会话
  await br.eval(`App.wbNewSession()`);
  await sleep(600);
  await br.waitForNoSpinner(5000);
  // 打开面板并挂载（覆盖：POST /api/kernel/sessions/:id/kb）
  await br.eval(`App.wbToggleKbPanel()`);
  await sleep(300);
  await br.eval(`App.wbToggleKb(${JSON.stringify(kbId)})`);
  await sleep(600);
  await br.waitForNoSpinner(5000);
  const body = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (!body.includes('已挂 1 个')) throw new Error('挂载知识库后应显示「已挂 1 个」');
}

async function s11_askWithKb() {
  await br.hashTo('#/workbench');
  await br.waitFor('#wb-input');
  // 确保有会话且挂了库
  const hasSession = await br.eval(`!!State.wb.sessionId`);
  if (!hasSession) {
    await br.eval(`App.wbNewSession()`);
    await sleep(600);
    await br.waitForNoSpinner(5000);
  }
  const mounted = await br.eval(`(State.wb.kbMounted && State.wb.kbMounted.length) || 0`);
  if (mounted === 0) {
    const kbId = await br.eval(`(State.wb.kbList && State.wb.kbList[0] && State.wb.kbList[0].id) || ''`);
    if (kbId) {
      await br.eval(`App.wbToggleKbPanel()`); await sleep(200);
      await br.eval(`App.wbToggleKb(${JSON.stringify(kbId)})`); await sleep(600);
      await br.waitForNoSpinner(5000);
    }
  }
  await br.type('#wb-input', '什么是 STI HARNESS？');
  await br.click('[data-act="wbSend"]');
  // 等待流式结束：「停止」按钮消失（变回「清屏」）且 spinner 消失
  let streaming = true;
  for (let i = 0; i < 40; i++) {
    const hasStop = await br.exists('[data-act="wbStop"]');
    const spinners = await br.eval(`document.querySelectorAll('.spinner').length`, { awaitPromise: false });
    if (!hasStop && spinners === 0) { streaming = false; break; }
    await sleep(500);
  }
  if (streaming) throw new Error('流式响应未在 20s 内结束');

  // ⚠️ 0.21.9（用户裁定「消息流里只留正文，工具卡也一起挪去轨迹 tab」，随后又裁定
  //    「轨迹不要放到右侧栏，放到会话框中（会话框中选项卡对话、轨迹）」）：知识库检索回执
  //    已经**不在消息流里**了 —— 它住在会话框的「轨迹」页签里，而默认停在「对话」。
  //    所以要先切到「轨迹」，再找 `.wb-kb`；否则这条用例红出来的原因是
  //    "页签默认停在对话"，指向的根本不是回执那个东西。
  //    这里显式置状态再重绘，不用 `App.wbViewTab()` —— 那个会自己 render 一次，
  //    紧接着我们再 render 一次是多余的；而这种地方多一次重绘就会多一次焦点丢失的机会。
  await br.eval(`(function(){ State.wb.viewTab = 'trace'; render(); return true; })()`);
  await sleep(250);

  const hasKbReceipt = await br.exists('.wb-kb');
  if (!hasKbReceipt) throw new Error('「轨迹」页签里应出现知识库检索回执 .wb-kb');
  const kbText = await br.textOf('.wb-kb');
  if (!kbText.includes('命中')) throw new Error('知识库回应收应含「命中」');
  const assistantText = await br.eval(`document.querySelector('.wb-text') && document.querySelector('.wb-text').innerText`, { awaitPromise: false });
  if (!assistantText || assistantText.length < 2) throw new Error('助手回复为空');
}

async function s12_reloadReplay() {
  await br.hashTo('#/workbench');
  await br.waitFor('#wb-input');
  const before = await br.eval(`document.querySelectorAll('.wb-msg').length`, { awaitPromise: false });
  if (before === 0) throw new Error('刷新前应有历史消息');
  await br.reload();
  await br.waitFor('#wb-input');
  const after = await br.eval(`document.querySelectorAll('.wb-msg').length`, { awaitPromise: false });
  if (after < before) throw new Error('刷新后消息数减少：' + after + ' < ' + before);
}

async function s14_auditVerify() {
  await br.hashTo('#/audit');
  await br.waitFor('[data-act="verifyAudit"]');
  await br.click('[data-act="verifyAudit"]');
  await sleep(600);
  await br.waitForNoSpinner(10000);
  // 以 State.error / State.notice 为准，避免「断裂」出现在说明文字里误报
  const err = await br.eval(`State.error || ''`);
  const notice = await br.eval(`State.notice || ''`);
  if (err) throw new Error('审计校验出错：' + err);
  if (!notice.includes('通过') && !notice.includes('完整') && !notice.includes('一致')) {
    const body = await br.eval(`document.body.innerText`, { awaitPromise: false });
    if (body.includes('断裂') && !body.includes('通过')) throw new Error('审计链校验发现断裂');
  }
}

async function s15_upsertQuota() {
  await br.hashTo('#/quotas');
  await br.waitFor('#q-subjecttype');
  // q-metric / q-period 是下拉框，必须选服务端返回的可用值
  const metrics = await br.eval(`(State.quotasData && State.quotasData.metrics) || []`);
  const periods = await br.eval(`(State.quotasData && State.quotasData.periods) || []`);
  const metric = metrics[0] || 'turn';
  const period = periods[0] || 'day';
  await br.selectOption('#q-subjecttype', 'user');
  await br.type('#q-subjectid', 'admin');
  await br.selectOption('#q-metric', metric);
  await br.selectOption('#q-period', period);
  await br.type('#q-limit', '1000');
  await br.selectOption('#q-mode', 'block');
  await br.click('[data-act="upsertQuota"]');
  await sleep(600);
  await br.waitForNoSpinner(5000);
  await sleep(500);
  const body = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (!body.includes(metric)) throw new Error('配额创建后未出现在列表（metric=' + metric + '）');
}

async function s16_createModel() {
  await br.hashTo('#/models');
  await br.waitFor('#md-name');
  await br.type('#md-name', '浏览器验收模型');
  await br.selectOption('#md-protocol', 'openai-compat');
  await br.type('#md-base', 'http://127.0.0.1:9999');
  await br.type('#md-model', 'gpt-test');
  await br.type('#md-priority', '1');
  await br.click('[data-act="createModel"]');
  await sleep(600);
  await br.waitForNoSpinner(5000);
  await sleep(500);
  const err = await br.eval(`State.error || ''`);
  if (err) throw new Error('创建模型报错：' + err);
  const body = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (!body.includes('浏览器验收模型')) throw new Error('模型创建后未出现在列表');
}

async function s17_jobAndTick() {
  await br.hashTo('#/schedules');
  await br.waitFor('#job-name');
  await br.type('#job-name', '浏览器验收任务');
  await br.selectOption('#job-kind', 'backup.create');
  // 调度规则只支持 interval:<ms> 或 dailyAt:HH:MM（UTC）
  await br.type('#job-schedule', 'dailyAt:00:00');
  await br.click('[data-act="createJob"]');
  await sleep(600);
  await br.waitForNoSpinner(5000);
  await sleep(500);
  const err = await br.eval(`State.error || ''`);
  if (err) throw new Error('创建任务报错：' + err);
  const body = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (!body.includes('浏览器验收任务')) throw new Error('任务创建后未出现在列表');
  // tickNow
  await br.click('[data-act="tickNow"]');
  await sleep(600);
  await br.waitForNoSpinner(8000);
}

async function s18_webhook() {
  await setupSink();
  await br.hashTo('#/notify');
  await br.waitFor('#nc-name');
  await br.type('#nc-name', '浏览器验收渠道');
  await br.type('#nc-url', sinkUrl());
  // 勾选 backup.failed 事件（事件名含点，id 是 nc-e-backup.failed）
  await br.eval(`(function(){
    var el = document.getElementById('nc-e-backup.failed');
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', {bubbles:true})); }
  })()`);
  await br.click('[data-act="createChannel"]');
  await sleep(600);
  await br.waitForNoSpinner(5000);
  await sleep(500);
  const err = await br.eval(`State.error || ''`);
  if (err) throw new Error('创建渠道报错：' + err);
  const body = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (!body.includes('浏览器验收渠道')) throw new Error('渠道创建后未出现在列表');
  // 试发
  const rows = await br.eval(`document.querySelectorAll('[data-act="testChannel"]').length`, { awaitPromise: false });
  if (rows === 0) throw new Error('没有可试发的渠道按钮');
  await br.click('[data-act="testChannel"]');
  await sleep(600);
  await br.waitForNoSpinner(5000);
  // 等待 sink 收到请求（最多 5s）
  let received = false;
  for (let i = 0; i < 20; i++) {
    if (sinkReceived.length > 0) { received = true; break; }
    await sleep(250);
  }
  if (!received) throw new Error('Webhook sink 未收到试发请求');
}

async function s19_backup() {
  await br.hashTo('#/backup');
  await br.waitFor('[data-act="createBackup"]');
  await br.click('[data-act="createBackup"]');
  await sleep(600);
  await br.waitForNoSpinner(10000);
  const body1 = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (!body1.includes('备份')) throw new Error('备份列表应出现新备份');
  // 校验第一个备份
  const hasVerify = await br.exists('[data-act="verifyBackup"]');
  if (!hasVerify) throw new Error('应有「校验」按钮');
  await br.click('[data-act="verifyBackup"]');
  await sleep(600);
  await br.waitForNoSpinner(10000);
  const body2 = await br.eval(`document.body.innerText`, { awaitPromise: false });
  if (body2.includes('校验失败')) throw new Error('备份校验失败');
}

async function s20_jsErrors() {
  const errs = await br.eval(`window.__stiErrors || []`);
  // 允许已知无害的噪音（如某些浏览器扩展、DevTools 自身）
  const allowed = [
    'chrome-extension',
    'devtools',
    'Failed to load resource', // 网络探测类的 404 不算 JS 异常
  ];
  const real = (errs || []).filter(e => !allowed.some(a => (e.msg || '').includes(a) || (e.file || '').includes(a)));
  if (real.length > 0) {
    throw new Error('页面出现未捕获 JS 异常（' + real.length + ' 条）：' + real.map(e => e.msg).join('；'));
  }
}

async function s21_sidebarScrollKept() {
  // 布局不变式：侧栏滚到下面后点导航（触发全量 render），滚动位置必须保持，
  // 不能跳回顶部。回归对应的真实问题：render 重建 .sidebar DOM 导致 scrollTop 归零。
  await br.hashTo('#/overview');
  // 无头默认视口可能放得下整个侧栏（不可滚）→ 强制矮视口，稳定复现"侧栏可滚"
  await br.send('Emulation.setDeviceMetricsOverride',
    { width: 1000, height: 420, deviceScaleFactor: 1, mobile: false });
  try {
    await sleep(200);
    const before = await br.eval(`
      (function(){
        var s = document.querySelector('.sidebar');
        s.scrollTop = s.scrollHeight;
        return s.scrollTop;
      })()
    `);
    if (!before || before <= 0) throw new Error('侧栏在当前视口下不可滚动，无法验收该不变式');
    // 点一个**滚到底时仍可见**的菜单项（备份在末尾组），直接派发 click：
    // 不能用 br.click() —— 它的 scrollIntoView 会先把侧栏滚到被点元素位置，污染测量
    await br.eval(`(function(){ document.querySelector('[data-nav="#/backup"]').click(); })()`);
    await sleep(500);
    await br.waitForNoSpinner(8000);
    const after = await br.eval(`(function(){ return document.querySelector('.sidebar').scrollTop; })()`);
    if (Math.abs(after - before) > 4) {
      throw new Error('点导航后侧栏滚动位置跳变：' + before + ' → ' + after + '（应保持）');
    }
  } finally {
    await br.send('Emulation.clearDeviceMetricsOverride');
  }
}

/* ── UI 不变式：窄视口右栏 + 对话框键盘（2026-10 交付评审补）────────── */

/**
 * 键击派发（CDP Input 域）。Tab/Escape 这类**非文本键**不能用 eval 里
 * `dispatchEvent(new KeyboardEvent(...))` 代替 —— 合成事件 isTrusted=false，
 * 浏览器不执行默认焦点行为，"焦点陷阱"的真实路径就测不出来。
 * rawKeyDown + keyUp 是 Puppeteer 派发非文本键的同一手法；
 * VK 码：Tab=9 / Escape=27；modifiers 位掩码 Shift=8。
 */
async function pressKey(key, vk, modifiers = 0) {
  const k = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await br.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, k));
  await br.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
}

/** 弹层内当前焦点状态（供焦点陷阱断言）。 */
async function dialogFocusState() {
  return await br.eval(`
    (function(){
      var a = document.activeElement;
      var els = document.querySelectorAll('.modal.dlg button, .modal.dlg input, .modal.dlg textarea, .modal.dlg select');
      return {
        id: (a && a.id) || '', tag: (a && a.tagName) || '',
        inDlg: !!(a && a.closest && a.closest('.modal.dlg')),
        first: !!(els.length && a === els[0]),
        last: !!(els.length && a === els[els.length - 1]),
      };
    })()
  `);
}

async function s22_railNarrow() {
  // 回归对应的两个真实缺陷（2026-10 交付评审）：
  //   ① ≤1100px 时 `.wb-rail` 曾被 `display:none` 藏掉 —— 点开也什么都看不见；
  //   ② 媒体查询里单独的 `.wb` 压不过 `.wb.rail-closed`（两个类）—— 窄屏**收起右栏**反而回退桌面宽度。
  // 不变式：窄视口下右栏可见、折到对话区**下方**占满整行，且开合双向真实生效。
  //
  // 0.21.2 全屏布局后判据换了三处（别再按旧文案写）：
  //   · 开合钮变成**图标钮**（没有任何文字，状态由 `#wb-rail` 的在/不在表达），
  //     可读标签只剩 `title` —— 拿按钮文字断言开合会永远失败；
  //     0.21.7 起图标本身从散装字形（原来是 `▤`）换成**内联 SVG**，所以"有没有图标"
  //     改判 `querySelector('svg.wb-ico')`：按符号断言会把用例绑在某个特定字符上，
  //     下次换图标又得改一次，而它想验的其实是"这个钮是纯图标、可读标签只能靠 title"。
  //   · 列宽基线：桌面 264px、≤1100px **200px**（不是旧的 220/180）；
  //   · 收起右栏在 ≤1100px 是**两轨**（左栏 + 主区），不是一轨 —— 一轨只在 ≤820px。
  await br.send('Emulation.setDeviceMetricsOverride',
    { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  const readRail = () => br.eval(`
    (function(){
      var wb = document.querySelector('.wb');
      var main = document.querySelector('.wb-main');
      var rail = document.querySelector('#wb-rail');
      var btn = document.querySelector('[data-act="wbToggleRail"]');
      var cols = getComputedStyle(wb).gridTemplateColumns;
      return {
        open: !!rail,
        cols: cols,
        tracks: cols.trim().split(/\\s+/).length,
        wbW: wb.getBoundingClientRect().width,
        railW: rail ? rail.getBoundingClientRect().width : -1,
        railTop: rail ? rail.getBoundingClientRect().top : -1,
        mainBottom: main ? main.getBoundingClientRect().bottom : -1,
        display: rail ? getComputedStyle(rail).display : '',
        btnTitle: btn ? (btn.getAttribute('title') || '') : '',
        btnText: btn ? btn.textContent.trim() : '',
        // 0.21.7：图标是一颗内联 SVG（类名 wb-ico）—— 判"有图标"看它，不看某个字符。
        // ⚠️ 这段代码是**整段模板字符串**，注释里**不许出现反引号** ——
        //    反引号会把模板提前闭合，后面的文本会被当成 JS 解析（曾经这样写出过
        //    "ico is not defined" 这种与现场毫无关系的报错）。
        btnIcon: !!(btn && btn.querySelector('svg.wb-ico')),
        btnHtml: btn ? btn.innerHTML.slice(0, 160) : '',
      };
    })()
  `);
  const toggleRail = async () => { await br.click('[data-act="wbToggleRail"]'); await sleep(400); };
  try {
    await br.hashTo('#/workbench');
    await br.waitFor('[data-act="wbToggleRail"]');
    // 基准：右栏的开合状态挂在跨路由不重置的 `State.wb.railOpen` 上，
    // 所以先显式归位到"开"，不依赖默认值是开还是关 ——
    // ⚠️ 这个默认值改过：0.21.2 起是**收起**，0.21.9 起用户裁定改成**展开**
    //    （「右侧栏 上下文面板 默认显示」）。这行"缺则点开"两种默认值下都对，
    //    所以不必跟着改；但**别**把它换成"断言默认就是展开" —— 那会与本用例
    //    要测的东西（窄视口下列轨/折行/特异性）无关地耦合到一个会变的默认值上。
    if (!(await br.exists('#wb-rail'))) await toggleRail();
    await br.waitFor('#wb-rail');

    const geo = await readRail();
    if (!geo.open) throw new Error('窄视口下点开右栏后 #wb-rail 仍不在 DOM 里');
    if (geo.display === 'none') throw new Error('窄视口下右栏被 display:none 藏掉（点开成了摆设）');
    if (!(geo.railW > 0)) throw new Error('窄视口下右栏宽度为 0：' + JSON.stringify(geo));
    if (geo.railW < geo.wbW - 4) {
      throw new Error('窄视口下右栏未占满整行（应折到对话区下方）：rail=' + geo.railW + ' wb=' + geo.wbW);
    }
    if (!(geo.railTop >= geo.mainBottom - 2)) {
      throw new Error('窄视口下右栏未折到对话区下方（与主区并排或被压掉）：' + JSON.stringify(geo));
    }
    // 图标钮的可读性底线：图标本身无语义，`title` 是它唯一的标签
    if (!/上下文面板/.test(geo.btnTitle)) {
      throw new Error('右栏开合钮丢了可读标签（图标钮只能靠 title 表意）：' + JSON.stringify(geo.btnTitle));
    }
    if (geo.btnText !== '') {
      throw new Error('右栏开合钮应保持纯图标（0.21.2 起不再有「隐藏上下文」这类文字）：' + JSON.stringify(geo.btnText));
    }
    if (!geo.btnIcon) {
      throw new Error('右栏开合钮里应有一颗内联 SVG 图标（0.21.7 起图标一律走 wbIcon，'
        + '不再是 ▤ 这类散装字形）：' + JSON.stringify(geo.btnHtml));
    }

    // 收起 → 元素消失、且列宽必须落回**窄屏**两轨（200px 起）。
    // 漏写媒体查询里的 `.wb.rail-closed` 这条，双类会压过单类，悄悄回退桌面 264px / 三轨。
    await toggleRail();
    const closed = await readRail();
    if (closed.open) throw new Error('收起右栏后 #wb-rail 仍在 DOM 里');
    if (closed.tracks !== 2) {
      throw new Error('≤1100px 收起右栏应为两轨（左栏 + 主区），实际：' + closed.cols);
    }
    if (!/^200px/.test(closed.cols)) {
      throw new Error('≤1100px 收起右栏后回退桌面列宽（特异性回归）：' + closed.cols);
    }

    // 再展开 → 双向真实生效
    await toggleRail();
    const back = await readRail();
    if (!back.open) throw new Error('再次点开右栏后 #wb-rail 没回来（单向开关）');

    // ≤820px：折为单列（右栏仍在且占满整行）；收起态也不得回退多列
    await br.send('Emulation.setDeviceMetricsOverride',
      { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const narrow = await readRail();
    if (!narrow.open) throw new Error('≤820px 断点切换后右栏丢了（应仍为展开态）');
    if (narrow.tracks !== 1) throw new Error('≤820px 应折为单列，实际列轨数：' + narrow.tracks);
    if (narrow.railW < narrow.wbW - 4) {
      throw new Error('≤820px 右栏未占满整行：rail=' + narrow.railW + ' wb=' + narrow.wbW);
    }
    await toggleRail();
    const narrowClosed = await readRail();
    if (narrowClosed.open) throw new Error('≤820px 收起右栏后 #wb-rail 仍在 DOM 里');
    if (narrowClosed.tracks !== 1) {
      throw new Error('≤820px 收起右栏后回退多列（特异性回归）：' + narrowClosed.cols);
    }
    // 还原：本用例把右栏来回点了三次，收尾要停回**默认态**，否则会把后续用例
    // 拖进"右栏常开/常关"的隐含前提里。
    // ⚠️ 默认态 0.21.9 起是**展开**（用户 2026-10-08：「右侧栏 上下文面板 默认显示」），
    //    0.21.2–0.21.8 是收起。这里因此**断言展开**而不是收起 ——
    //    写死一边必然在默认值下一次翻转时变红，所以顺手把"当前默认是哪一边"
    //    钉在 State 上（见下面那行读出来的值），而不是靠人记得改这里。
    if (!(await br.exists('#wb-rail'))) await toggleRail();
    await br.waitFor('#wb-rail');
  } finally {
    await br.send('Emulation.clearDeviceMetricsOverride');
  }
}

/**
 * 打开第一条"菜单里有「重命名」"的会话行 ⋯ 菜单（0.21.1）。
 *
 * 改名 / 删除 / 移动从 0.21.1 起收进了会话名右侧的「⋯」——默认不渲染，
 * 所以「等 [data-act=wbRenameSession] 出现」这种写法会直接超时。这不是等久一点的问题，
 * 而是**入口在菜单里**：必须先点 ⋯ 把菜单展开（菜单是状态 State.wb.rowMenu，一次只开一个）。
 *
 * 为什么要逐个试而不是无脑取第一个：会话是否可管取决于它在哪个工作区、以及我是不是建档人。
 * 遍历时行数与 ⋯ 按钮数都不变（展开菜单不新增 ⋯），所以下标在整个循环里是稳定的。
 */
async function openSessionRowMenuWithRename() {
  const n = await br.eval(
    `document.querySelectorAll('[data-act="wbToggleRowMenu"][data-a1="session"]').length`,
    { awaitPromise: false });
  for (let i = 0; i < n; i++) {
    await br.eval(`(function(){
      var els = document.querySelectorAll('[data-act="wbToggleRowMenu"][data-a1="session"]');
      if (els[${i}]) els[${i}].click();
    })()`, { awaitPromise: false });
    if (await br.exists('[data-act="wbRenameSession"]')) return true;
  }
  return false;
}

async function s23_dialogTrap() {
  // 回归对应的真实缺陷：弹层写着 role="dialog"，但浏览器不会因此拦住 Tab ——
  // 弹层开着时背后整页仍在 DOM 里，焦点一溜出去，键盘用户就在"看不见的界面"里迷路。
  // 不变式：弹层开着时 Tab / Shift+Tab 只在弹层内循环（首尾互绕），Esc 取消并关闭。
  await br.send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  try {
    await br.hashTo('#/workbench');
    await br.waitFor('[data-act="wbToggleRowMenu"][data-a1="session"]');
    if (!(await openSessionRowMenuWithRename())) {
      throw new Error('没有任何会话行的「⋯」菜单里能找到「重命名」—— 弹层陷阱无从触发');
    }
    await br.click('[data-act="wbRenameSession"]');
    await br.waitFor('.modal.dlg #dlg-input');
    await sleep(200); // 等 Dlg._open 的自动聚焦落定

    const st0 = await dialogFocusState();
    if (st0.id !== 'dlg-input') throw new Error('弹层打开后焦点应在输入框（dlg-input），实际：' + JSON.stringify(st0));

    const count = await br.eval(`
      (function(){
        return document.querySelectorAll('.modal.dlg button, .modal.dlg input, .modal.dlg textarea, .modal.dlg select').length;
      })()
    `);
    if (count < 2) throw new Error('弹层内可聚焦元素不足两个，陷阱无从循环：' + count);

    const focusEdge = (edge) => br.eval(`
      (function(){
        var els = document.querySelectorAll('.modal.dlg button, .modal.dlg input, .modal.dlg textarea, .modal.dlg select');
        els[${edge === 'last' ? 'els.length - 1' : '0'}].focus();
      })()
    `);

    // ① 尾 → Tab → 必须绕回首（不拦的话焦点会跑到弹层外）
    await focusEdge('last');
    await pressKey('Tab', 9, 0);
    let s = await dialogFocusState();
    if (!s.inDlg) throw new Error('Tab 从弹层尾部逃逸：' + JSON.stringify(s));
    if (!s.first) throw new Error('Tab 应绕回弹层第一个元素，实际：' + JSON.stringify(s));

    // ② 首 → Shift+Tab → 必须绕到尾
    await pressKey('Tab', 9, 8);
    s = await dialogFocusState();
    if (!s.inDlg) throw new Error('Shift+Tab 从弹层首部逃逸：' + JSON.stringify(s));
    if (!s.last) throw new Error('Shift+Tab 应绕到弹层最后一个元素，实际：' + JSON.stringify(s));

    // ③ 连按六次 Tab，焦点全程不得离开弹层
    for (let i = 0; i < 6; i++) {
      await pressKey('Tab', 9, 0);
      s = await dialogFocusState();
      if (!s.inDlg) throw new Error('第 ' + (i + 1) + ' 次 Tab 后焦点逃出弹层：' + JSON.stringify(s));
    }

    // ④ Esc 关闭（走 40-delegate.js 的 keydown 委托；Dlg.close(null) 即取消改名）
    await pressKey('Escape', 27, 0);
    await sleep(300);
    if (await br.exists('.modal.dlg')) throw new Error('按 Esc 后弹层未关闭');
  } finally {
    await br.send('Emulation.clearDeviceMetricsOverride');
  }
}

/**
 * S22 工作台收口（0.21.7 起，0.21.8 扩到收起态入口栏）：
 *   左栏收起后仍能展开、且左侧立着**一列**入口 / 节头动作划过才显形 / 正文与输入卡同轴。
 *
 * 为什么这三件事**非真机不可**（vm 层是结构性盲区，三条各自不同）：
 *   · 「收起之后还能展开」的缺陷机理就是**布局**——展开钮曾经住在 `.wb-side` 里，
 *     而 `.wb.side-closed .wb-side{display:none}` 把整栏连钮一起藏掉。判它修没修好，
 *     要看**真实几何**：它在不在 `.wb-side` 子树里、有没有尺寸、落不落在视口内、
 *     用**真鼠标**点得动点不动 —— HTML 里有个类名什么都不证明。
 *   · 「鼠标划过才出现」是 CSS `:hover`。而 `br.click()` 发的是 **JS 合成 click**
 *     （`isTrusted=false`），浏览器不会因此触发 hover 伪类 —— 必须用 CDP
 *     `Input.dispatchMouseEvent` 发真实指针移动，再读 `getComputedStyle().opacity`。
 *   · 「正文与输入卡同轴」是**几何**：两个元素的左右边缘差几像素。vm 层没有排版引擎，
 *     连这两个盒子的宽度都算不出来，更别说它们对没对齐。
 */
async function s24_workbenchCollar() {
  // 视口必须够宽：`--wb-compose-w` 是 1200px（0.21.9 从 900px 放宽），
  // 而各容器有 `max-width: calc(100% - 48px)`。视口太窄时列宽会被 max-width 压下来，
  // "两侧留白到底还剩多少"就**测不出**（量到的是被压过的值，不是设计值）。
  // （这是**测量前提**，不是把断言放松。）
  await br.send('Emulation.setDeviceMetricsOverride',
    { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  try {
    await br.hashTo('#/workbench');
    await br.waitFor('#wb-input');
    await br.waitFor('[data-act="wbPickSession"]', 10000);

    // ── 前置 ①：状态归位（右栏收起 + 页签停在「对话」）──────────────────
    // 两条都是**跨路由不重置**的，而两条都会让下面的测量失效：
    //   · `railOpen` 展开着会把主区挤窄 —— "两侧留白"的分母变了，量到的是被压过的值；
    //   · `viewTab` 停在「轨迹」时 `.wb-stream-inner` **根本不存在**（那是「对话」那一侧的
    //     容器，轨迹渲染的是 `.wb-trace`），后面会一路报"准备不出有正文的前提"。
    // 所以必须先归位，再去做后面那些"准备前提"的动作。
    await br.eval(`(function(){ State.wb.railOpen = false; State.wb.viewTab = 'chat'; render(); return true; })()`);
    await sleep(300);

    // ── 前置 ②：正文列只在**有消息**时才渲染 ─────────────────────────────
    // （空态"不占地方"靠的正是 `.wb-stream:empty`，见 84-workbench.js。）
    // S12 刷新过页面，会话不会自动恢复 —— 这里显式开一个，不依赖"上一条用例留下的会话"。
    if (!(await br.exists('.wb-stream-inner'))) {
      const n = await br.eval(
        `document.querySelectorAll('[data-act="wbPickSession"]').length`, { awaitPromise: false });
      if (!n) throw new Error('工作区树上没有任何会话行，准备不出"有正文"的前提');
      for (let i = 0; i < n && !(await br.exists('.wb-stream-inner')); i++) {
        await br.eval(`(function(){
          var e = document.querySelectorAll('[data-act="wbPickSession"]');
          if (e[${i}]) e[${i}].click();
        })()`, { awaitPromise: false });
        await sleep(700);
      }
      if (!(await br.exists('.wb-stream-inner'))) {
        throw new Error('逐个打开 ' + n + ' 个会话后正文列都没渲染出来（这些会话里都没有消息？）');
      }
    }

    // ── 前置 ③：归位到「左栏展开」 ──────────────────────────────────────
    // `State.wb.sideOpen` 跨路由不重置，别依赖上一场景把它留成了什么。
    if (await br.exists('.wb.side-closed')) {
      await br.click('.wb-side-expand');
      await sleep(400);
    }
    if (!(await br.exists('.wb-side'))) throw new Error('前置失败：左栏没渲染');

    // 把指针挪到右下角，保证下面读到的是"没人碰过"的原始状态。
    await br.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1580, y: 880 });
    await sleep(150);

    // ── ① 收起左栏 → 必须**仍有**一个真实可达的展开入口 ──────────────────
    await br.click('[data-act="wbToggleSide"]');   // 品牌头那颗（展开态下 DOM 里的第一个）
    await sleep(400);
    const c = await br.eval(`
      (function(){
        var aside = document.querySelector('.wb-side');
        var btn = document.querySelector('.wb-side-expand');
        var r = btn ? btn.getBoundingClientRect() : null;
        var cs = btn ? getComputedStyle(btn) : null;
        return {
          asideHidden: !!aside && getComputedStyle(aside).display === 'none',
          hasBtn: !!btn,
          // ★ 结构判据的真机版：展开钮不能住在 .wb-side 子树里 —— 住进去就会被一起藏掉
          inAside: !!(aside && btn && aside.contains(btn)),
          visible: !!(r && r.width > 0 && r.height > 0 && cs.display !== 'none'
            && cs.visibility !== 'hidden' && cs.opacity !== '0'),
          // 还得落在视口里 —— 落在视口外，"有按钮"等于"点不到"
          inViewport: !!(r && r.left >= 0 && r.top >= 0
            && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1),
          box: r ? { x: Math.round(r.left), y: Math.round(r.top),
            w: Math.round(r.width), h: Math.round(r.height) } : null,
        };
      })()
    `);
    if (!c.asideHidden) throw new Error('左栏没真的收起（.wb-side 仍可见）：' + JSON.stringify(c));
    if (!c.hasBtn) throw new Error('左栏收起后**没有任何展开入口** —— 这正是用户报的那个缺陷：' + JSON.stringify(c));
    if (c.inAside) throw new Error('展开钮住在 .wb-side 里 —— 它会跟着整栏被一起藏掉（缺陷机理本身）：' + JSON.stringify(c));
    if (!c.visible) throw new Error('展开钮没有可见尺寸：' + JSON.stringify(c));
    if (!c.inViewport) throw new Error('展开钮不在视口内，等于点不到：' + JSON.stringify(c));

    // ── ①b 收起态左侧是**一列入口**（0.21.8），而且它是真的一列、不是浮层 ──────
    // 用户要的不只是"能展开"，而是收起之后「管理后台 / 设置 / 我的账号」仍在手边 ——
    // 这三项原来住在左栏底部，收起时跟着整栏一起消失（整个治理面导航一起没了）。
    // 这里钉两条 vm 层算不出来的东西：
    //   · 几何：栏的右边缘不得越过主区的左边缘。换成绝对定位悬浮的写法，这一条立刻红 ——
    //     而那正是窄视口下正文列左缘被压住的原因（"看着只是有点挤"，其实是盖住了）。
    //   · 尺寸：每一项都要有真实宽高且落在视口内。把某一项藏起来/挤出视口，这里就红。
    // ⚠️ 注释里不许出现反引号：这一段整个是模板字符串，反引号会把它提前闭合，
    //    报出来的错会和现场毫无关系（0.21.7 在这上面花过最久的时间，见本文件别处的记录）。
    const railGeo = await br.eval(`
      (function(){
        var nav = document.querySelector('.wb-siderail');
        var main = document.querySelector('.wb-main');
        var items = nav ? [].slice.call(nav.querySelectorAll('.wb-iconbtn')) : [];
        return {
          hasNav: !!nav,
          vh: innerHeight, vw: innerWidth,
          count: items.length,
          items: items.map(function(b){
            var r = b.getBoundingClientRect();
            return {
              title: b.getAttribute('title') || '',
              hasIcon: !!b.querySelector('svg.wb-ico'),
              w: Math.round(r.width), h: Math.round(r.height),
              left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom),
            };
          }),
          railRight: nav ? Math.round(nav.getBoundingClientRect().right) : -1,
          railBottom: nav ? Math.round(nav.getBoundingClientRect().bottom) : -1,
          footBottom: (function(){
            var f = nav && nav.querySelector('.wb-siderail-foot');
            return f ? Math.round(f.getBoundingClientRect().bottom) : -1;
          })(),
          mainLeft: main ? Math.round(main.getBoundingClientRect().left) : -1,
        };
      })()
    `);
    if (!railGeo.hasNav) throw new Error('收起态没渲染竖排入口栏（.wb-siderail）—— 那就是回到了一颗孤钮的老样子');
    if (railGeo.count !== 4) {
      throw new Error('入口栏应有四项（展开左栏 / 管理后台 / 设置 / 我的账号），实际 '
        + railGeo.count + '：' + JSON.stringify(railGeo.items));
    }
    if (railGeo.items[0].title !== '展开左栏') {
      throw new Error('入口栏第一项应是「展开左栏」，实际是「' + railGeo.items[0].title
        + '」—— 顺序反了（展开在顶、三个导航在底）');
    }
    for (const it of railGeo.items) {
      if (it.w <= 0 || it.h <= 0) {
        throw new Error('入口栏里有一项没有尺寸（等于点不到）：' + JSON.stringify(it));
      }
      if (!it.hasIcon) throw new Error('入口栏里有一项没有内联 SVG 图标：' + JSON.stringify(it));
      if (it.left < 0 || it.top < 0 || it.bottom > railGeo.vh + 1) {
        throw new Error('入口栏里有一项落在视口外：' + JSON.stringify(it));
      }
    }
    if (railGeo.railRight > railGeo.mainLeft + 1) {
      throw new Error('入口栏压在主区上了（栏右缘 ' + railGeo.railRight
        + ' > 主区左缘 ' + railGeo.mainLeft + '）—— 说明它退化成了浮层，'
        + '窄视口下会盖住正文列（必须让它占网格真实的一列）');
    }

    // ── ①c 展开入口在**顶**、三个导航项在**底**（用户 2026-10-08 的裁定） ──────
    // 同样是几何：`margin-top: auto` 有没有生效、栏是不是真被拉伸到全高，
    // 只靠读标记看不出来（写了 auto 但容器没高度，三项照样贴在顶上）。
    if (railGeo.footBottom < 0) throw new Error('入口栏里没有 .wb-siderail-foot（三个导航项没包在底部那一段里）');
    if (railGeo.railBottom - railGeo.footBottom > 16) {
      throw new Error('三个导航项没贴到栏底（栏底 ' + railGeo.railBottom + '，底部组下沿 '
        + railGeo.footBottom + '）—— 它们又挤回展开钮下面去了');
    }
    const navTop = Math.min(...railGeo.items.slice(1).map(it => it.top));
    if (navTop - railGeo.items[0].bottom < 100) {
      throw new Error('三个导航项离展开钮太近（间隙只有 ' + (navTop - railGeo.items[0].bottom)
        + 'px）—— 它们应该在栏底，而不是跟在展开钮后面排一排');
    }

    // 用**真鼠标**点它 —— 这一下才是"收起之后还能回来"的证据
    const mx = c.box.x + Math.round(c.box.w / 2);
    const my = c.box.y + Math.round(c.box.h / 2);
    await br.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await br.send('Input.dispatchMouseEvent', { type, x: mx, y: my, button: 'left', clickCount: 1 });
    }
    await sleep(500);
    if (await br.exists('.wb.side-closed')) throw new Error('真实点击展开钮后左栏仍未展开（收起成了单向开关）');
    const backVisible = await br.eval(`(function(){
      var a = document.querySelector('.wb-side');
      return a ? getComputedStyle(a).display !== 'none' : false;
    })()`);
    if (!backVisible) throw new Error('点开之后 .wb-side 仍不可见');

    // ── ② 节头两个动作：默认隐形，鼠标真划过就要现身 ────────────────────
    await br.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1580, y: 880 });
    await sleep(200);
    const head = await br.eval(`
      (function(){
        var h = document.querySelector('.wb-sec-head');
        var t = document.querySelector('.wb-sec-tools');
        if (!h || !t) return null;
        var r = h.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
          opacityIdle: getComputedStyle(t).opacity,
          displayIdle: getComputedStyle(t).display,
          hasFilter: !!document.querySelector('[data-act="wbToggleTreeFilter"]'),
          hasNew: !!document.querySelector('[data-act="wbNewWorkspace"]'),
          hasReload: !!document.querySelector('[data-act="wbEnsureLoaded"]'),
        };
      })()
    `);
    if (!head) throw new Error('工作区节头没渲染');
    if (!head.hasFilter || !head.hasNew) {
      throw new Error('节头两个动作必须**恒在 DOM 里**（显隐是 CSS 的事，不该做成条件渲染，'
        + '否则键盘用户永远摸不到它们）：' + JSON.stringify(head));
    }
    if (head.hasReload) throw new Error('「重新拉取工作区与会话列表」入口已整个删除，不该还在 DOM 里');
    if (head.displayIdle === 'none') {
      throw new Error('节头工具用了 display:none —— 那会让按钮从 Tab 序列里消失（必须用 opacity）');
    }
    if (head.opacityIdle !== '0') throw new Error('节头工具默认应是隐形的（opacity:0），实际 ' + head.opacityIdle);

    await br.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: head.x, y: head.y });
    await sleep(250);
    const hovered = await br.eval(
      `getComputedStyle(document.querySelector('.wb-sec-tools')).opacity`, { awaitPromise: false });
    if (hovered !== '1') throw new Error('鼠标真的划过节头了，工具仍未现身（opacity=' + hovered + '）');

    await br.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1580, y: 880 });
    await sleep(300);
    const unhovered = await br.eval(
      `getComputedStyle(document.querySelector('.wb-sec-tools')).opacity`, { awaitPromise: false });
    if (unhovered !== '0') throw new Error('鼠标移开后节头工具没有收回（opacity=' + unhovered + '）');

    // 键盘可达性：只用 opacity 收着还不够，`:focus-within` 必须真的把它显出来 ——
    // 否则 Tab 进去的用户是在**摸黑操作**（焦点停在看不见的按钮上）。
    // ⚠️ 聚焦与读值必须**分两次**：`.wb-sec-tools` 带 `transition: opacity .12s`，
    //    同一 tick 里 `getComputedStyle().opacity` 拿到的是**过渡的起始值**（还是 0），
    //    会报出一个"看着像规则没生效、其实是没等它过渡完"的假红。
    const focusOk = await br.eval(`
      (function(){
        var b = document.querySelector('[data-act="wbNewWorkspace"]');
        if (!b) return null;
        b.focus();
        return document.activeElement === b;
      })()
    `);
    if (!focusOk) throw new Error('「新建工作区」按钮聚焦不上（它必须在 Tab 序列里，不能被 display:none 藏掉）');
    await sleep(300);
    const focusOpacity = await br.eval(
      `getComputedStyle(document.querySelector('.wb-sec-tools')).opacity`, { awaitPromise: false });
    if (focusOpacity !== '1') {
      throw new Error('键盘聚焦到节头动作上时它没有显形（`:focus-within` 没生效，'
        + '用户看不到自己正在按什么）：opacity=' + focusOpacity);
    }
    await br.eval(`document.activeElement.blur()`, { awaitPromise: false });
    await sleep(300);

    // ── ③ 正文列与输入卡：同宽、同轴、都在主区里居中 ────────────────────
    const axis = await br.eval(`
      (function(){
        var main = document.querySelector('.wb-main');
        var inner = document.querySelector('.wb-stream-inner');
        var wrap = document.querySelector('.wb-compose-wrap');
        if (!main || !inner || !wrap) return null;
        var m = main.getBoundingClientRect();
        var a = inner.getBoundingClientRect();
        var b = wrap.getBoundingClientRect();
        var rd = function(v){ return Math.round(v * 10) / 10; };
        return {
          dLeft: rd(a.left - b.left), dRight: rd(a.right - b.right), dW: rd(a.width - b.width),
          innerW: rd(a.width), wrapW: rd(b.width),
          // 居中判据独立于"与输入卡对齐"：距主区左右边缘的距离应当相等
          innerGapL: rd(a.left - m.left), innerGapR: rd(m.right - a.right),
          scrollable: (function(){ var s = document.querySelector('.wb-stream');
            return s ? s.scrollHeight > s.clientHeight : false; })(),
        };
      })()
    `);
    if (!axis) throw new Error('正文列 / 输入卡 / 主区 有一项没渲染出来，同轴无从测量');
    console.log('      · 现读：正文列宽 ' + axis.innerW + 'px / 输入卡宽 ' + axis.wrapW
      + 'px ｜ 左 Δ' + axis.dLeft + ' 右 Δ' + axis.dRight
      + ' ｜ 主区两侧留白 ' + axis.innerGapL + ' / ' + axis.innerGapR
      + 'px ｜ 消息流可滚=' + axis.scrollable);
    if (!(axis.innerW > 780)) {
      throw new Error('正文列没比 780px 宽 —— 这一版把输入卡放宽到 900px 的效果没体现（视口 '
        + '1600 下不该被 max-width 压住）：' + JSON.stringify(axis));
    }
    if (Math.abs(axis.dW) > 1) {
      throw new Error('正文列与输入卡不同宽（Δ' + axis.dW + 'px）：' + JSON.stringify(axis));
    }
    if (Math.abs(axis.dLeft) > 1 || Math.abs(axis.dRight) > 1) {
      throw new Error('正文列与输入卡不在同一条轴上（左 Δ' + axis.dLeft + ' / 右 Δ' + axis.dRight
        + 'px）—— 上下两截看起来是错位的：' + JSON.stringify(axis));
    }
    if (Math.abs(axis.innerGapL - axis.innerGapR) > 1) {
      throw new Error('正文列在主区里没居中（两侧留白 ' + axis.innerGapL + ' / ' + axis.innerGapR + 'px）');
    }
    if (!(axis.innerGapL >= 24)) {
      throw new Error('正文列两侧留白小于 24px（用户说的"容距太小"）：' + axis.innerGapL + 'px');
    }
  } finally {
    await br.send('Emulation.clearDeviceMetricsOverride');
  }
}

/* ── 执行 ───────────────────────────────────────────────────────────── */

/**
 * 「浏览器存在但起不来」不能算失败 —— 这是**环境限制**，不是被测代码的问题（0.21.12 补）。
 *
 * 为什么必须单独一档：换一台机器、换一个 CI 镜像，Edge 可能装在不同路径、
 * 或者被策略拦掉无头模式（本机实测：`msedge.exe --headless=new …` 与
 * `--headless --dump-dom about:blank` 都是**退出码 0 且零输出**，stderr 从不出
 * `DevTools listening on …`）。这时候如果照旧记 `fails++`，门禁就变成"机器决定成败"，
 * 用久了的唯一后果是**这条门禁被人习惯性忽略** —— 那它守着的 23 个场景就全白写了。
 *
 * 纪律同 `probeBrowser()` 返回 null 的那一档，也同 test-external.mjs：
 *   · 找不到 / 起不来 → SKIP（**明确写清原因**，绝不计入通过）；
 *   · 只有"起来了但场景跑挂"才是 fails。
 * ⚠️ 所以 SKIP 在这里**不是放水**：它把"没测到"如实说出来，而不是伪装成绿。
 */
let launchFailure = null;

try {
  let launch;
  try {
    launch = await launchBrowser(browserPath);
  } catch (e) {
    launchFailure = e;
    throw e;
  }
  browserProc = launch.proc;
  userDataDir = launch.userDataDir;

  br = new CdpBrowser(launch.wsUrl);
  await br.connect();
  await br.createPage();

  section('组织身份（M1）');
  await t('S1 初始化向导 → 登录页', s1_setup);
  await t('S2 登录 → 工作台', s2_login);
  await t('S3 全部 22 页渲染扫荡', s3_pageSweep);
  await t('S4 新建用户', s4_createUser);
  await t('S5 新建凭据', s5_setCred);
  await t('S6 登出/成员登录/侧栏收缩/管理员回登', s6_roleSidebar);

  section('RAG 闭环（M2）');
  await t('S7 新建知识库', s7_createBase);
  await t('S8 粘贴文本导入 → 可检索', s8_importText);
  await t('S9 检索命中', s9_search);
  await t('S10 工作台新建会话并挂载知识库', s10_mountKb);
  await t('S11 提问并命中知识库片段', s11_askWithKb);
  await t('S12 刷新后历史消息回放', s12_reloadReplay);

  section('治理（M3）');
  await t('S13 审计校验', s14_auditVerify);
  await t('S14 新建配额', s15_upsertQuota);

  section('运维与平台（M4/M5）');
  await t('S15 新建模型条目', s16_createModel);
  await t('S16 新建调度任务并立即执行', s17_jobAndTick);
  await t('S17 Webhook 渠道创建与试发', s18_webhook);
  await t('S18 备份创建与校验', s19_backup);

  section('UI 不变式');
  await t('S19 窄视口右栏可达与开合（≤1100px）', s22_railNarrow);
  await t('S20 对话框键盘：Tab 焦点陷阱 + Esc 取消', s23_dialogTrap);
  await t('S21 侧栏滚动位置跨重绘保持', s21_sidebarScrollKept);
  await t('S22 工作台收口：左栏收起后可展开 / 节头划过显形 / 正文与输入卡同轴', s24_workbenchCollar);

  section('全局对账');
  // ⚠️ 对账必须放**最后**：它把此前全部场景在页面上累积的未捕获 JS 异常一次摊开。
  // 排在它之后的场景若抛异常就会漏网 —— 所以 UI 不变式跑在它前面。
  await t('S23 全局未捕获 JS 异常对账', s20_jsErrors);

} catch (e) {
  console.log('');
  if (launchFailure) {
    // 起不来 → 记 SKIP 而不是 fails（口径见 launchFailure 上方的注释）。
    skips++;
    skipped.push({
      name: '全部 23 场景',
      reason: '浏览器存在但无法驱动无头实例（' + e.message + '）—— 环境限制，非被测代码缺陷',
    });
    console.log('  浏览器存在但无法驱动无头实例 —— SKIP（不是通过）。');
    console.log('    ' + browserPath);
    console.log('    原因：' + e.message);
    console.log('    这台机器上 Edge 的无头模式不产出 DevTools 端口（实测 --headless=new 与');
    console.log('    --headless --dump-dom 均"退出码 0 且零输出"）。换一台有可用 Chrome/Edge 的');
    console.log('    机器、或用 STI_BROWSER 指向可驱动的浏览器，这 23 个场景就会真的跑起来。');
  } else {
    console.log('  致命错误：' + e.message);
    fails++;
  }
} finally {
  section('清理');
  if (br) { try { br.close(); } catch (e) { /* ignore */ } }
  if (browserProc && !browserProc.killed) {
    try { browserProc.kill(); } catch (e) { /* ignore */ }
    await sleep(500);
    try { if (browserProc.pid) { spawn('taskkill', ['/pid', String(browserProc.pid), '/T', '/F'], {stdio:'ignore'}); } } catch (e) { /* ignore */ }
  }
  if (sinkServer) { try { sinkServer.close(); } catch (e) { /* ignore */ } }
  if (server) { try { server.close(); } catch (e) { /* ignore */ } }
  if (knowledge && knowledge.close) { try { await knowledge.close(); } catch (e) { /* ignore */ } }
  if (db && db.closeDb) { try { db.closeDb(); } catch (e) { /* ignore */ } }
  if (userDataDir) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
}

console.log('');
console.log('────────────────────────────────────────────────────────────────');
console.log('  总计: ' + total + '  通过: ' + (total - fails) + '  失败: ' + fails + '  跳过: ' + skips);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f.name + ' —— ' + (f.error && f.error.message));
}
if (skipped.length) {
  console.log('');
  for (const s of skipped) console.log('  ~ ' + s.name + ' —— ' + s.reason);
}
console.log('');
console.log('DONE fails=' + fails + ' skipped=' + skips);
process.exitCode = fails ? 1 : 0;

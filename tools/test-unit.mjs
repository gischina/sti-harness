/**
 * 快速单测层 —— 纯函数的**毫秒级**回归。
 *
 * 为什么单独一层：`test-core` / `test-http` 是端到端回归（装配服务、建库、甚至起端口），
 * 跑一遍要几十秒；改一行纯函数也要付这个代价，人会开始跳过验证 ——
 * "反正改的只是个解析函数"。这一层只收**无 IO 的纯函数**（切词、解析、归一化、算钱），
 * 全程不建库不起服务，跑完不到一秒，让它有资格在每次改动后随手就跑。
 *
 * 边界（如实）：它**不替代**端到端 —— 纯函数对了不等于装配对了；
 * 两层各管各的：这一层钉"函数的语义"，端到端钉"装配与协作"。
 *
 * 覆盖（入选标准：有真实分支逻辑、曾出过或容易出错的纯函数）：
 *   · util/validate   入参校验器（P1-10b 新增，这里钉全部语义）
 *   · util/bigram     中文切词 / FTS5 查询串 / 降级链（检索召回的根基）
 *   · util/net        clientIpOf / isSecureRequest（trustProxy 语义，P1-9）
 *   · config          sessionTtlMs（配置 → 毫秒换算）
 *   · schedule        parseSchedule / computeNextRun / describeSchedule（UTC 口径）
 *   · kernel/contract normalizeEvent（事件归一化，绝不猜测缺失语义）
 *   · governance/cost computeCost / formatAmount（"不知道 ≠ 0 元"口径）
 *
 * 用法：node tools/test-unit.mjs
 * 末行输出 `DONE fails=N`（gate 检查项 `unit`）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import assert from 'node:assert/strict';
import { validateBody } from '../app/util/validate.mjs';
import { tokenize, toIndexText, toMatchQuery, buildQueryLadder } from '../app/util/bigram.mjs';
import { clientIpOf, isSecureRequest } from '../app/util/net.mjs';
import { sessionTtlMs } from '../app/config.mjs';
import { parseSchedule, computeNextRun, describeSchedule } from '../app/platform/schedule/service.mjs';
import { normalizeEvent } from '../app/kernel/contract.mjs';
import { computeCost, formatAmount } from '../app/platform/governance/cost.mjs';
import { inferGroupProvider, fillGroupProviders } from '../app/kernel/dsh-provider/catalog.mjs';

let total = 0;
let fails = 0;

async function t(name, fn) {
  total++;
  try {
    await fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    fails++;
    console.log('  ✗ ' + name);
    console.log('      ' + String(e && e.message ? e.message : e).split('\n').join('\n      '));
  }
}

function section(s) {
  console.log('\n[' + s + ']');
}

/* ── 入参校验器 ───────────────────────────────────────────────────── */

section('P1-10b · validateBody（声明式入参校验）');

await t('必填字段：缺失 / 空串 / null 都算"未填"', () => {
  const s = { username: { required: true, label: '用户名' } };
  assert.equal(validateBody(s, { username: 'a' }).ok, true);
  for (const v of [undefined, null, '']) {
    const r = validateBody(s, { username: v });
    assert.equal(r.ok, false, '值 ' + JSON.stringify(v) + ' 必须被拒');
    assert.equal(r.errors[0].field, 'username');
    assert.match(r.errors[0].message, /缺少必填字段/);
  }
});

await t('可选字段"未填"直接跳过其余检查（空串 ≈ 不传）', () => {
  const r = validateBody({ a: { required: true }, b: { maxLen: 3, enum: ['x'] } }, { b: '' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.field), ['a'], '只报必填的那个，b 未填不报枚举错');
});

await t('类型：字符串 / 数字 / 布尔 / 字符串数组 / 对象', () => {
  assert.equal(validateBody({ v: { type: 'number' } }, { v: '5' }).ok, false, '不偷偷转换类型（"5" ≠ 5）');
  assert.equal(validateBody({ v: { type: 'number' } }, { v: 5 }).ok, true);
  assert.equal(validateBody({ v: { type: 'boolean' } }, { v: 'true' }).ok, false);
  assert.equal(validateBody({ v: { type: 'stringArray' } }, { v: ['a', 1] }).ok, false, '数组里混进非字符串要拒');
  assert.equal(validateBody({ v: { type: 'stringArray' } }, { v: ['a', 'b'] }).ok, true);
  assert.equal(validateBody({ v: { type: 'object' } }, { v: [] }).ok, false, '数组不是对象');
  assert.equal(validateBody({ v: {} }, { v: ['x'] }).ok, false, '缺省 type = string');
});

await t('maxLen：字符串看字符数、数组看元素数', () => {
  const r1 = validateBody({ a: { maxLen: 4 } }, { a: '12345' });
  assert.equal(r1.ok, false);
  assert.match(r1.errors[0].message, /4/);
  const r2 = validateBody({ roles: { type: 'stringArray', maxLen: 2 } }, { roles: ['a', 'b', 'c'] });
  assert.equal(r2.ok, false);
  assert.equal(validateBody({ a: { maxLen: 4 } }, { a: '1234' }).ok, true);
});

await t('enum：字符串与字符串数组都查；错误要列出允许值', () => {
  const r = validateBody({ visibility: { enum: ['tenant', 'restricted'] } }, { visibility: 'public' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /tenant \/ restricted/);
  assert.equal(validateBody({ d: { enum: ['approved', 'rejected'] } }, { d: 'rejected' }).ok, true);
  const r2 = validateBody({ roles: { type: 'stringArray', enum: ['admin', 'member'] } }, { roles: ['admin', 'boss'] });
  assert.equal(r2.ok, false, '数组里任一元素越界都要拒');
});

await t('一次报全：两个坏字段出两条，互不吞', () => {
  const r = validateBody(
    { a: { required: true }, b: { type: 'number' } },
    { b: 'nope' }
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.field).sort(), ['a', 'b']);
});

await t('body 整个不是对象：按"required 全缺"报，无 required 时报 body 本身', () => {
  const r1 = validateBody({ a: { required: true } }, 'not-an-object');
  assert.equal(r1.ok, false);
  assert.equal(r1.errors[0].field, 'a');
  const r2 = validateBody({ b: { maxLen: 2 } }, [1, 2]);
  assert.equal(r2.ok, false);
  assert.equal(r2.errors[0].field, '(body)');
});

await t('未知字段不拦（形状校验不做白名单，多余字段由 service 决定用不用）', () => {
  assert.equal(validateBody({}, { anything: 1 }).ok, true);
});

/* ── bigram 切词 ──────────────────────────────────────────────────── */

section('检索根基 · bigram（切词 / 查询串 / 降级链）');

await t('CJK 重叠双字串：企业级权限管理 → 6 个 gram', () => {
  assert.deepEqual(tokenize('企业级权限管理'), ['企业', '业级', '级权', '权限', '限管', '管理']);
});

await t('单字 CJK 保留；中英混排各走各的路径；英文转小写', () => {
  assert.deepEqual(tokenize('权'), ['权']);
  assert.deepEqual(tokenize('权限 Admin!'), ['权限', 'admin'], '标点是分隔符，英文按词切');
  assert.equal(toIndexText('备份'), '备份');
});

await t('toMatchQuery：phrase 档 CJK 保序短语、拉丁 AND', () => {
  assert.equal(toMatchQuery('权限管理'), '"权限 限管 管理"', '默认 phrase：gram 串成短语');
  assert.equal(toMatchQuery('admin 后台'), '"admin" AND "后台"', '段间 AND，先后顺序保持');
});

await t('toMatchQuery：or 档段内 OR（容忍换序），any 档全局 OR（容忍多从句）', () => {
  assert.equal(toMatchQuery('权限管理', { mode: 'or' }), '("权限" OR "限管" OR "管理")');
  const any = toMatchQuery('备份？怎么做', { mode: 'any' });
  assert.ok(!/AND/.test(any), 'any 档不得残留段间 AND（整句提问的最后一道网）');
  assert.ok(/OR/.test(any));
});

await t('buildQueryLadder：phrase → or → any，相同串去重（单段查询 or 与 any 同串）', () => {
  assert.deepEqual(
    buildQueryLadder('权限管理').map((x) => x.mode),
    ['phrase', 'or'],
    '单段查询的 or 与 any 同串，any 被去重'
  );
  assert.equal(buildQueryLadder('备份？怎么做').length, 3, '多从句三档全不同');
  assert.deepEqual(buildQueryLadder(''), [], '空查询没有降级链');
});

/* ── net（trustProxy 语义）────────────────────────────────────────── */

section('P1-9 · net（clientIpOf / isSecureRequest）');

await t('直连：只认 socket 地址，且把 IPv4-mapped 还原成 IPv4', () => {
  assert.equal(clientIpOf({ socket: { remoteAddress: '::ffff:10.1.2.3' } }), '10.1.2.3');
  assert.equal(
    clientIpOf({ headers: { 'x-forwarded-for': '203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } }),
    '127.0.0.1',
    '默认不采信 XFF —— 客户端可随意伪造'
  );
  assert.equal(clientIpOf({ socket: { remoteAddress: 'fe80::1%eth0' } }), 'fe80::1', 'zone id 要剥掉');
  assert.equal(clientIpOf({}), 'unknown');
});

await t('trustProxy：取 XFF 最左值并归一化；无头回落 socket', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIpOf(req, { trustProxy: true }), '203.0.113.7');
  assert.equal(clientIpOf({ headers: {}, socket: { remoteAddress: '::ffff:1.2.3.4' } }, { trustProxy: true }), '1.2.3.4');
});

await t('isSecureRequest：socket.encrypted 直判；X-Forwarded-Proto 只在 trustProxy 时采信首个值', () => {
  assert.equal(isSecureRequest({ socket: { encrypted: true } }), true);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }), false, '不开 trustProxy 就不认');
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }, { trustProxy: true }), true);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'http,https' } }, { trustProxy: true }), false, '只看首个值');
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'HTTPS' } }, { trustProxy: true }), true, '大小写不敏感');
});

/* ── 配置换算 ─────────────────────────────────────────────────────── */

section('config · sessionTtlMs（配置 → 毫秒）');

await t('合法正数小时 → 毫秒；字符串数字也认；其余一律 null（交给默认值）', () => {
  assert.equal(sessionTtlMs({ sessionTtlHours: 2 }), 7_200_000);
  assert.equal(sessionTtlMs({ sessionTtlHours: '3' }), 10_800_000);
  assert.equal(sessionTtlMs({}), null, '没配 = null（不是 0，更不是默认值的复制品）');
  for (const bad of [0, -1, 'abc', null]) assert.equal(sessionTtlMs({ sessionTtlHours: bad }), null);
});

/* ── 调度解析 ─────────────────────────────────────────────────────── */

section('schedule · parseSchedule / computeNextRun / describeSchedule');

await t('interval：下限 1000ms、上限 30 天，边界都要钉住', () => {
  assert.equal(parseSchedule('interval:999').ok, false);
  assert.deepEqual(parseSchedule('interval:1000'), { ok: true, type: 'interval', ms: 1000 });
  assert.equal(parseSchedule('interval:' + 30 * 86_400_000).ok, true);
  assert.equal(parseSchedule('interval:' + (30 * 86_400_000 + 1)).ok, false);
});

await t('dailyAt：HH:MM 合法范围 00:00–23:59；其它写法一律报错且文案说清两种形式', () => {
  assert.deepEqual(parseSchedule('dailyAt:23:59'), { ok: true, type: 'dailyAt', hh: 23, mm: 59 });
  assert.equal(parseSchedule('dailyAt:9:05').ok, true, '小时允许 1–2 位');
  for (const bad of ['dailyAt:24:00', 'dailyAt:12:60', 'every day', 'cron:* * * * *']) {
    assert.equal(parseSchedule(bad).ok, false, bad + ' 必须被拒');
  }
  assert.match(parseSchedule('xxx').error, /interval|dailyAt/);
});

await t('computeNextRun：dailyAt 按 **UTC** 算"今天已过就明天"，interval 是加法', () => {
  const from = Date.UTC(2026, 0, 1, 10, 0);
  assert.equal(computeNextRun('dailyAt:12:00', from), Date.UTC(2026, 0, 1, 12, 0), '今天还没到 → 今天');
  assert.equal(computeNextRun('dailyAt:08:00', from), Date.UTC(2026, 0, 2, 8, 0), '今天已过 → 明天同一时刻');
  assert.equal(computeNextRun('interval:1500', from), from + 1500);
  assert.equal(computeNextRun('nonsense', from), null, '非法规则没有下次执行时刻');
});

await t('describeSchedule：人类可读，非法规则原样返回（不假装能解释）', () => {
  assert.equal(describeSchedule('interval:86_400_000'.replace(/_/g, '')), '每 1 天');
  assert.equal(describeSchedule('interval:3600000'), '每 1 小时');
  assert.equal(describeSchedule('interval:60000'), '每 1 分钟');
  assert.equal(describeSchedule('interval:90000'), '每 90 秒');
  assert.equal(describeSchedule('dailyAt:09:05'), '每日 09:05（UTC）');
  assert.equal(describeSchedule('nonsense'), 'nonsense');
});

/* ── 内核契约归一化 ───────────────────────────────────────────────── */

section('kernel/contract · normalizeEvent（绝不猜测缺失语义）');

await t('已知事件：字段补全、known:true、seq/turnId 可从 ctx 取', () => {
  const ev = normalizeEvent({ type: 'message', role: 'assistant', text: '你好' }, { seq: 3, turnId: 't1' });
  assert.equal(ev.known, true);
  assert.equal(ev.seq, 3);
  assert.equal(ev.turnId, 't1');
  assert.equal(ev.text, '你好');
  assert.equal(ev.type, 'message');
  assert.deepEqual(ev.warnings, []);
  assert.ok(ev.at, '缺 at 要补当前时刻');
});

await t('未知类型：不丢弃，标 known:false + warning（丢弃 = 轨迹里凭空少一块）', () => {
  const ev = normalizeEvent({ type: 'zzz-not-real' });
  assert.equal(ev.known, false);
  assert.ok(ev.warnings.includes('unknown_event_type'));
  assert.equal(ev.type, 'zzz-not-real', '原样保留类型名 —— 它是排障线索');
  const twice = normalizeEvent({ type: 'zzz', warnings: ['unknown_event_type'] });
  assert.equal(twice.warnings.filter((w) => w === 'unknown_event_type').length, 1, '不重复追加');
});

await t('垃圾输入（null / 非对象）不炸：归一成 unknown 事件', () => {
  const ev = normalizeEvent(null);
  assert.equal(ev.type, 'unknown');
  assert.equal(ev.known, false);
  assert.equal(ev.usage, null);
});

await t('usage：分项缺失补 0、字符串数字转数字；全空则 usage=null', () => {
  assert.deepEqual(
    normalizeEvent({ type: 'usage', usage: { input: '10', output: 5 } }).usage,
    { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 }
  );
  assert.equal(normalizeEvent({ type: 'usage', usage: {} }).usage, null);
  assert.equal(normalizeEvent({ type: 'usage' }).usage, null);
});

await t('tool：形状归一（缺 status → null，不编造）', () => {
  const ev = normalizeEvent({ type: 'tool-call', tool: { name: 'shell.exec', args: { cmd: 'ls' } } });
  assert.equal(ev.tool.name, 'shell.exec');
  assert.deepEqual(ev.tool.args, { cmd: 'ls' });
  assert.equal(ev.tool.status, null);
  assert.equal(normalizeEvent({ type: 'tool-call', tool: 'not-an-object' }).tool, null);
});

/* ── 成本核算 ─────────────────────────────────────────────────────── */

section('governance/cost · computeCost / formatAmount（"不知道 ≠ 0 元"）');

await t('没配单价 → amountMinor 为 **null**（不是 0），note 说人话', () => {
  const r = computeCost({ tokens: { input: 1000 } });
  assert.equal(r.amountMinor, null);
  assert.equal(r.amount, null);
  assert.equal(r.partial, true);
  assert.match(r.note, /未登记单价/);
});

await t('全价：整数运算（token × 单价，最后除 1e6），币种统一大写', () => {
  const r = computeCost({
    tokens: { input: 1_000_000, output: 1_000_000 },
    price: { currency: 'usd', priceInMinor: 3, priceOutMinor: 12 },
  });
  assert.equal(r.currency, 'USD');
  assert.equal(r.amountMinor, 15, '1M×3 + 1M×12 = 15 美分');
  assert.equal(r.amount, 'USD 0.15');
  assert.equal(r.partial, false);
});

await t('部分定价：cache 价不许拿 input 价顶替 → 记入未定价桶 + missingPrices', () => {
  const r = computeCost({
    tokens: { input: 1_000_000, cacheRead: 500 },
    price: { currency: 'USD', priceInMinor: 3 },
  });
  assert.equal(r.amountMinor, 3, '只有已定价部分进金额');
  assert.ok(r.partial);
  assert.deepEqual(r.missingPrices, ['cacheRead']);
  assert.match(r.note, /未定价/);
});

await t('单价配了但没币种 → 金额无法表达（不默认按人民币算）', () => {
  const r = computeCost({ tokens: { input: 1000 }, price: { priceInMinor: 3 } });
  assert.equal(r.amountMinor, null);
  assert.match(r.note, /币种/);
});

await t('非法单价（负数 / 小数）一律当"没配"：宁可不算，不可算错', () => {
  const r = computeCost({ tokens: { input: 1000 }, price: { currency: 'USD', priceInMinor: -5, priceOutMinor: 1.5 } });
  assert.equal(r.amountMinor, null);
  assert.match(r.note, /未登记单价/);
});

await t('formatAmount：最小货币单位 → 两位小数，负数带符号', () => {
  assert.equal(formatAmount(15, 'USD'), 'USD 0.15');
  assert.equal(formatAmount(1_234_567, 'CNY'), 'CNY 12345.67');
  assert.equal(formatAmount(-5, 'USD'), '-USD 0.05');
  assert.equal(formatAmount(null, 'USD'), null, 'null 进 null 出 —— 不把"不知道"格式化成 0.00');
});

/* ── 模型目录 provider 推导 ─────────────────────────────────────── */

section('0.19.0 · catalog（模型目录组 provider 推导）');

await t('缺 provider 的组：组内模型同属一个命名空间时按 id 前缀补齐', () => {
  const out = fillGroupProviders([
    { models: [{ id: 'deepseek-official/deepseek-flash' }, { id: 'deepseek-official/deepseek-chat' }] },
  ]);
  assert.equal(out[0].provider, 'deepseek-official');
  assert.equal(inferGroupProvider([{ id: 'a/b/c' }]), 'a', '只取第一个 / 前的前缀');
});

await t('多命名空间歧义：宁可留空也不猜', () => {
  assert.equal(inferGroupProvider([{ id: 'a/x' }, { id: 'b/y' }]), '');
  const g = { models: [{ id: 'a/x' }, { id: 'b/y' }] };
  const out = fillGroupProviders([g]);
  assert.equal(out[0].provider, undefined, '歧义组不得被补上 provider');
  assert.equal(out[0], g, '补不上的组原样返回（不换对象）');
});

await t('已有 provider 的组不动（含与 id 前缀不一致的）', () => {
  const g = { provider: 'stub', models: [{ id: 'other/x' }] };
  const out = fillGroupProviders([g]);
  assert.equal(out[0].provider, 'stub');
  assert.equal(out[0], g, '已有 provider 不换对象');
});

await t('无前缀模型不构成证据：留空；混一个无前缀不碍事', () => {
  assert.equal(inferGroupProvider([{ id: 'gpt-4' }]), '');
  assert.equal(inferGroupProvider([{ id: '' }]), '');
  assert.equal(inferGroupProvider([]), '');
  assert.equal(inferGroupProvider(null), '');
  // '/x' 的空前缀也不算
  assert.equal(inferGroupProvider([{ id: '/x' }]), '');
  // 一个带前缀 + 一个无前缀 → 仍唯一，可推
  assert.equal(inferGroupProvider([{ id: 'a/x' }, { id: 'plain' }]), 'a');
});

/* ── 汇总 ─────────────────────────────────────────────────────────── */

console.log('\n================================================================');
console.log('用例 ' + total + ' 个｜失败 ' + fails + ' 个');
console.log('DONE fails=' + fails);
if (fails > 0) process.exitCode = 1;

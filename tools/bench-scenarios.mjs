/**
 * 压测的**场景定义**（"一个请求长什么样"）—— 由两个执行者共用：
 *   · `tools/bench-concurrency.mjs` 主进程：闭环阶梯 / 长稳 / **同进程**开环；
 *   · 同一脚本的 `--sender` **独立发包端**：真正的开环（发包端与服务端**不在同一个事件循环**里）。
 *
 * 为什么必须共用一份：如果两边各写一遍"请求长什么样"，两边压的就不是同一个东西了 ——
 * 那时"独立发包端测出来的拐点"和"闭环阶梯测出来的饱和点"**没有任何可比性**，
 * 而这两个数字要放在同一张表里读。
 *
 * 本模块是**纯的**：只依赖注入进来的 `fetchJson(method, path, body)`，
 * 不 import 任何 app 模块、不碰数据库、不起服务 —— 因此独立发包端可以零负担地复用它
 * （发包端绝不该打开数据库或起服务：那样它就不再是"另一台机器上的人"了）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import crypto from 'node:crypto';

/**
 * @param {object} p
 * @param {(method:string, path:string, body:any)=>Promise<{status:number, body:any, text:string}>} p.fetchJson
 * @param {string} p.kbId     检索场景用的知识库 id
 * @param {string} p.cwd      写场景建会话时用的工作目录（**必须由调用方给**：发包端在另一个进程里，
 *                            拿不到主进程的临时目录）
 * @param {number} [p.mixRead] mixed 场景里读的百分比
 */
export function makeScenarios({ fetchJson, kbId, cwd, mixRead = 70 }) {
  /** 每个场景是一个 `one()`：**发一个请求**并返回 `{ ok, note }`。
   *  `ok=false` 会被计成错误（也是 `DONE fails` 的来源之一）—— 所以这里判的是
   *  "响应符不符合预期"，不是"快不快"。 */
  const scenarios = {
    /** 只读：混合检索（FTS5 bm25 + bigram；未启用向量，所以不掺 embedding 往返） */
    async search() {
      const r = await fetchJson('POST', '/api/knowledge/search', { kbId, query: '数据治理 权限管理', limit: 10 });
      if (r.status !== 200) return { ok: false, note: 'HTTP ' + r.status + ' ' + r.text.slice(0, 120) };
      const n = (r.body && r.body.results && r.body.results.length) || 0;
      // 空库也能"快" —— 所以这里把"查到了东西"也算进预期，防止空转出来的漂亮数字
      return { ok: n > 0, note: n > 0 ? '' : '检索 0 命中（语料或检索链路有问题，这个数字没有意义）' };
    },

    /** 只读：纯平台状态（最轻的读，用来量"框架底噪"） */
    async readmin() {
      const r = await fetchJson('GET', '/api/system/status');
      return r.status === 200 ? { ok: true } : { ok: false, note: 'HTTP ' + r.status };
    },

    /** 写：建会话 + 提交一轮（测试替身，事件真的落库） */
    async turn() {
      const c = await fetchJson('POST', '/api/kernel/sessions', { cwd, title: '并发基准会话' });
      if (c.status !== 201 && c.status !== 200) return { ok: false, note: '建会话 HTTP ' + c.status };
      const sid = c.body && c.body.session ? c.body.session.id : null;
      if (!sid) return { ok: false, note: '建会话未返回会话 id' };
      const t = await fetchJson('POST', '/api/kernel/sessions/' + encodeURIComponent(sid) + '/turns', {
        content: '基准：只回复两个字', mode: 'chat', requestId: 'benchc-' + crypto.randomUUID().slice(0, 8),
      });
      if (t.status !== 200) return { ok: false, note: '提交回合 HTTP ' + t.status + ' ' + t.text.slice(0, 120) };
      const written = (t.body && t.body.eventsWritten) || 0;
      return { ok: written > 0, note: written > 0 ? '' : '回合 0 事件落库（写链路有问题）', wrote: written };
    },

    /** 混合：按比例混读与写（最接近真实形态） */
    async mixed(i) {
      return (i % 100) < mixRead ? scenarios.search() : scenarios.turn();
    },
  };
  return scenarios;
}

/** 场景的人话说明（表里、命令行里都用它 —— 同一句话只写一遍） */
export function scenarioNote(scen, mixRead = 70) {
  return {
    search: '并发只读检索（FTS5 bm25 + bigram，无向量）',
    readmin: '并发只读平台状态（最轻的读：量框架底噪）',
    turn: '并发写：建会话 + 提交一轮（测试替身，事件真落库）',
    mixed: '混合：读 ' + mixRead + '% / 写 ' + (100 - mixRead) + '%',
  }[scen] || scen;
}

/**
 * 产物留存 —— 变更类工具产出的**文件路径提取** + 会话产物清单。
 *
 * 定位要诚实：这不是沙箱级的文件追踪（那需要 OS 层监控，本项目明确不做）。
 * 做的是「字符串层提取」：工具执行（平台网关 + 回合事件）的 args / result 里
 * 出现的文件系统路径，被提取、去重、落库 —— 让「这个会话动过哪些文件」
 * 可查询（/api/governance/artifacts）、可随会话日志 ZIP 一起导出。
 * 路径是工具自己报出来的：工具不说谎它就在，工具不报它就记不到 —— 这个边界写在这，
 * 不在文档里藏。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { run, all, get } from '../../data/db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';
import { errors } from '../../util/errors.mjs';
import { statSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * 从任意文本里提取文件系统路径。
 *
 * 规则（宁可少报，不可误报）：
 *  - Windows 绝对路径：盘符 + 冒号 + 反斜杠/正斜杠（C:\x\y.z、D:/data/a.txt）
 *  - POSIX 绝对路径：以 / 开头且至少两段（/var/log/app.log）；单个 /tmp 也算
 *  - 明确排除 URL（scheme://）、盘符单独出现、纯标点尾巴
 * 返回去重后的数组（保持首次出现顺序）。
 */
export function extractPaths(text) {
  if (text == null) return [];
  const s = String(text);
  const out = [];
  const seen = new Set();

  // Windows：盘符 + 冒号 + 斜杠起头（C:\x\y.z、D:/data/a.txt）。
  // 负向后行断言排除"词中冒号"（URL 的 https:// 会被咬成 s://…）
  const winRe = /(?<![A-Za-z])[A-Za-z]:[/\\][^\s"'`<>|*\x00-\x1f]*/g;
  // POSIX：/ 开头，至少一个内部字符；尾部句读标点在 push 里剥掉
  //（不能在字符类里排除 '.' —— 那会让 /var/log/app.log 被截成 /var/log/app.lo）。
  // 全角标点（，。；：（）等）同样视作路径边界 —— 中文正文里最常见。
  const posixRe = /(?:^|[\s"'`=(\[\u3001\uff0c\uff1b\uff1a])(\/[^\s"'`<>)\]},;\u3000-\u303f\uff00-\uffef]+)/g;

  const push = (p) => {
    const path = p.replace(/[.,;:]+$/, '');   // 句尾标点不算路径的一部分
    if (!path || seen.has(path)) return;
    if (path.length < 2 || !/[\\/]/.test(path.slice(1))) return;
    seen.add(path);
    out.push(path);
  };

  let m;
  while ((m = winRe.exec(s)) !== null) push(m[0]);
  while ((m = posixRe.exec(s)) !== null) push(m[1]);
  return out;
}

/**
 * 一次工具调用的路径提取与落库。
 * @param {{tenantId:string, sessionId:string, turnId?:string|null, toolName:string,
 *          args?:object|null, result?:any}} p
 * @returns {{written:number, inputPaths:string[], outputPaths:string[]}}
 */
export function recordFromToolCall({ tenantId, sessionId, turnId = null, toolName, args = null, result = null }) {
  const inputPaths = args == null ? [] : extractPaths(typeof args === 'string' ? args : JSON.stringify(args));
  let outputPaths = [];
  if (result != null) {
    const rs = typeof result === 'string' ? result : JSON.stringify(result);
    outputPaths = extractPaths(rs);
  }
  const at = nowIso();
  let written = 0;
  for (const [direction, paths] of [['input', inputPaths], ['output', outputPaths]]) {
    for (const path of paths) {
      run(
        'INSERT INTO tool_artifacts (id, tenant_id, session_id, turn_id, tool_name, path, direction, recorded_at) VALUES (?,?,?,?,?,?,?,?)',
        [newId('art'), tenantId, sessionId, turnId, toolName, path, direction, at]
      );
      written++;
    }
  }
  return { written, inputPaths, outputPaths };
}

/**
 * 会话产物清单（租户隔离：session 必须属于该租户，否则按不存在处理）。
 */
export function listForSession(tenantId, sessionId, { limit = 200, offset = 0 } = {}) {
  const owned = get('SELECT id FROM agent_sessions WHERE id = ? AND tenant_id = ?', [sessionId, tenantId]);
  if (!owned) return { items: [], total: 0, notFound: true };
  const total = get('SELECT COUNT(*) AS n FROM tool_artifacts WHERE tenant_id = ? AND session_id = ?', [tenantId, sessionId]);
  const rows = all(
    'SELECT id, session_id, turn_id, tool_name, path, direction, recorded_at FROM tool_artifacts WHERE tenant_id = ? AND session_id = ? ORDER BY recorded_at, id LIMIT ? OFFSET ?',
    [tenantId, sessionId, limit, offset]
  );
  return { items: rows, total: total ? Number(total.n) : 0, notFound: false };
}

/**
 * 删除某会话的全部产物记录（0.16.0 会话删除的级联面）。
 *
 * 这里删的只是「路径记录」，**不动任何文件**：tool_artifacts 记录的是工具
 * 提取到的路径（很多在平台之外），平台无权也无从替用户删那些文件。
 * 这与附件删除不同 —— 附件字节是平台自己落盘的，删元数据必须连带删字节。
 * @returns {number} 实际删除的行数
 */
export function deleteForSession(tenantId, sessionId) {
  const r = run('DELETE FROM tool_artifacts WHERE tenant_id = ? AND session_id = ?', [tenantId, sessionId]);
  return r.changes || 0;
}

/**
 * 用**系统默认程序**打开一个文件（0.21.9）。
 *
 * 为什么这件事只能由服务端做：产物清单里的路径是**跑平台那台机器上**的路径。
 * 浏览器既读不到它，也没有任何 API 能"用系统程序打开一个磁盘文件" ——
 * `file://` 被 CSP/同源挡死，且即便放行，打开的也是**客户端**的路径。
 * 所以这一步是平台替用户在服务端机器上把文件交给 shell。
 *
 * 安全口径（写清楚，免得被当成疏漏）：
 *   · 它是**有副作用**的动作（会在那台机器上起一个程序），不是只读 —— 因此单独一条路由、
 *     单独落审计，而不是塞进 GET 清单里。开了什么、谁开的，事后查得到。
 *   · **不校验"这个路径在清单里"**：清单是"字符串层提取"（工具报什么记什么），
 *     既不全也不权威 —— 拿它当白名单，会让"工具没报但确实写出来的文件"打不开，
 *     而挡不住任何一个能直接调 API 的人。能调这个接口的人本来就有 `artifact:read`，
 *     与"让 agent 去写那些文件"是同一个人、同一份权限（路由层挂的就是这个 capability）。
 *   · **`spawn` 而不是 `exec`**，且数组传参、`shell:false` —— 路径里的空格、`&`、引号
 *     都不会被当成命令分隔符。这是这条接口里唯一真正的注入面，必须堵死。
 *   · 只接受**已存在的文件**（目录也给过 —— 交给文件管理器打开是合理行为），
 *     不存在就如实报，不静默成功。
 *
 * @returns {{ok:boolean, opener?:string, platform:string, isDir?:boolean}}
 * @throws 路径为空 / 不存在 / 起不了进程 —— 都由路由层翻译成 4xx
 */
export function openWithDefaultApp(rawPath) {
  const target = String(rawPath == null ? '' : rawPath).trim();
  if (!target) throw errors.badRequest('缺少 path：要打开哪个文件？');
  if (!existsSync(target)) {
    throw errors.notFound('文件不存在（它可能已被移动或删除）：' + target);
  }
  let st = null;
  try { st = statSync(target); } catch (err) {
    throw errors.badRequest('读不到这个路径：' + target + '（' + ((err && err.code) || 'unknown') + '）');
  }

  // 每个平台把"交给默认程序"这件事交给谁。命令与参数都写死在这里 ——
  // 路径永远走**数组里的独立一格**，不拼进字符串。
  let cmd;
  let args;
  if (process.platform === 'win32') {
    // `start` 是 cmd 内建命令，必须经 cmd；第一个参数是窗口标题占位（否则带引号的路径会被当成标题）。
    // 空标题写作 `""` —— 这是 cmd 的既有约定，不是笔误。
    cmd = 'cmd';
    args = ['/c', 'start', '', target];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [target];
  } else {
    cmd = 'xdg-open';
    args = [target];
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
    child.unref();          // 平台不等它 —— 用户关掉那个程序跟平台没关系
  } catch (err) {
    throw errors.badRequest('起不了系统程序（' + cmd + '）：' + ((err && err.message) || 'unknown'));
  }
  return { ok: true, opener: cmd, platform: process.platform, isDir: st.isDirectory() };
}

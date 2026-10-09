/**
 * 工作目录浏览（0.21.7）—— 「新建工作区」弹框里的**文件夹选择器**。
 *
 * 为什么需要服务端来列目录：`cwd` 是**服务器上的路径**，决定上游项目级能力能读写哪一片
 * 文件系统。浏览器给不了服务器的目录树（`<input webkitdirectory>` 拿到的是**客户端**的
 * 目录，而且在浏览器里只能得到 `C:\fakepath\…` 这种假路径）—— 拿它当 cwd 存下去，
 * 会存进一个在服务器上根本不存在的路径。所以只能由服务端列目录。
 *
 * ⚠️ **它不增加任何能力，只把"盲填"变成"看得见地选"。** 判断依据：`workspace.create`
 * （`session:write`）本来就接受**任意** cwd 字符串 —— 能建工作区的人早就能把 cwd 指到
 * 服务器上任何一处。本接口与他已有的能力完全对齐，因此挂同一个门（`session:write`）。
 * 它只做三件事，都是**只读**：
 *   1. 列出一个目录下的**子目录名**（不列文件、不读文件内容）；
 *   2. 给出上级目录与几个常用起点（默认工作区目录 / 主目录 / 盘符）；
 *      ⚠️ 0.21.9：起点里**不再有"平台数据目录"与"平台安装目录"**（用户裁定去掉）。
 *      这不是"少列两个目录"，是**别把人往那儿引** —— 选择器的用途是挑一个**工作目录**，
 *      而这两个是平台自己的家（数据库、日志、密钥、源码），恰好是所有目录里最不该当工作区的两个：
 *      摆成"常用"等于给一个诱导，选中之后上游项目级能力就能在平台自己身上读写。
 *      它们并没有被"禁掉"（`workspace.create` 仍接受任意 cwd，见下），只是不再**推荐**。
 *   3. 目录不存在、不是目录、读不了 —— 如实报 4xx，不返回"看起来正常的空列表"。
 *
 * 安全边界（照实写下来，免得被当成疏漏）：
 *   · **只列目录，不列文件** —— 选择器的用途是挑一个工作目录，文件列表在这里没有用；
 *   · **路径先 realpath 归一** —— `..`、符号链接都先解析到真实路径再列，避免"用链接绕过"；
 *   · **不递归** —— 一次只走一层，因此不存在符号链接成环导致遍历失控的问题；
 *   · **有上限** —— 超大目录只列前 N 条并如实标 `truncated`，不把整个目录塞进内存；
 *   · 越权与不存在**分开报**：读不了是 400（带 errno），不存在是 404 ——
 *     与库级 ACL 的 403/404 分离同一条纪律。
 *     ⚠️ `ENOTDIR`（给的是个文件）归 404，且**两处抛它的地方归一**：realpath 抛与
 *        readdir 抛都是"这个位置没有你要的目录"。同一个原因给出两个状态码是最难查的
 *        一类不一致（`xxx/VERSION/..` 与 `xxx/VERSION` 会分别走这两条路）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WORKSPACE_DIR } from '../../paths.mjs';
import { errors } from '../../util/errors.mjs';

/** 一次最多列多少条 —— 选目录不需要看完一整个 /usr/lib，超过就如实说"还有更多"。 */
const MAX_ENTRIES = 500;

/** 常用起点。全部来自 paths.mjs 的推导，不在这里另写一份路径真相。 */
function browseRoots() {
  const out = [
    { label: '默认工作区目录', path: WORKSPACE_DIR },
    { label: '用户主目录', path: os.homedir() },
  ];
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const p = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(p)) out.push({ label: '盘符 ' + p.slice(0, 2), path: p }); } catch { /* 读不到就不列 */ }
    }
  } else {
    out.push({ label: '根目录 /', path: '/' });
  }
  const seen = new Set();
  return out.filter((r) => {
    if (!r.path) return false;
    let key;
    try { key = fs.realpathSync(r.path); } catch { key = path.resolve(r.path); }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 列出一个目录下的子目录。
 * @param {string} target 目标目录；空 / 未给 → 默认工作区目录
 * @returns {{path:string,parent:string|null,sep:string,entries:{name:string,path:string}[],truncated:boolean,roots:{label:string,path:string}[]}}
 */
export function browseDirectories(target) {
  const asked = String(target == null ? '' : target).trim();
  const start = asked || WORKSPACE_DIR;

  let resolved;
  try {
    // realpath 一步到位：既归一 `..` / 相对路径，也把符号链接解析到真实位置。
    resolved = fs.realpathSync(path.resolve(start));
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) throw errors.notFound('目录不存在：' + start);
    throw errors.badRequest('目录不可访问：' + start + '（' + ((e && e.code) || 'unknown') + '）');
  }

  let entries;
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (e) {
    const code = (e && e.code) || 'unknown';
    // ⚠️ `ENOTDIR` 在这里必须与上面那条 realpath 的 catch **归同一个码**。
    //    同一个 errno 从两处抛出来、却给出两个不同的状态码，是最难查的一类不一致：
    //    `path.resolve('…/VERSION/..')` 会先让 realpath 抛 ENOTDIR（→ 404），
    //    而真实的文件路径会走到这里抛 ENOTDIR（若给 400 就成了"同一个原因两个结论"）。
    //    语义上它属于"这个位置没有你要的那个目录"，与 ENOENT 同类 → 404。
    if (code === 'ENOTDIR' || code === 'ENOENT') throw errors.notFound('目录不存在：' + resolved);
    // 存在但读不了（EACCES / EPERM）—— 与"不存在"必须分开说，否则用户会去建一个已经存在的目录
    throw errors.badRequest('目录不可读：' + resolved + '（' + code + '）');
  }

  const dirs = [];
  for (const d of entries) {
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      // 链接指向目录时**收进来**（用户看到的目录树里它是可进入的），断了/指文件的跳过
      try { isDir = fs.statSync(path.join(resolved, d.name)).isDirectory(); } catch { isDir = false; }
    }
    if (isDir) dirs.push({ name: d.name, path: path.join(resolved, d.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  const truncated = dirs.length > MAX_ENTRIES;
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    // 到了根就如实给 null，别让前端摆一个点了没反应的「上级目录」
    parent: parent === resolved ? null : parent,
    sep: path.sep,
    entries: truncated ? dirs.slice(0, MAX_ENTRIES) : dirs,
    truncated,
    roots: browseRoots(),
  };
}

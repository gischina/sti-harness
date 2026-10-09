/**
 * 上游契约快照工具 —— 上游升级后**第一步**跑的就是它。
 *
 * 用法：
 *   node tools/snapshot-upstream-contract.mjs            # 与快照对比（CI / 升级后）
 *   node tools/snapshot-upstream-contract.mjs --update   # 确认差异可接受后，更新快照
 *   node tools/snapshot-upstream-contract.mjs --show      # 打印当前快照内容
 *
 * 末行输出 `DONE fails=N`（沿用本项目回归脚本约定）。
 * 本机未装上游 → 输出 SKIP 并 `DONE fails=0 skipped=1`，**不伪装成通过**
 * （因为"没装上游"不等于"契约没变"）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import '../app/util/quiet-warnings.mjs';
import {
  extractUpstreamContract, diffContract, readSnapshot, writeSnapshot, SNAPSHOT_FILE,
} from '../app/kernel/dsh-provider/upstream-contract.mjs';
import { createDshClient } from '../app/kernel/dsh-provider/client.mjs';

const args = process.argv.slice(2);
const wantUpdate = args.includes('--update');
const wantShow = args.includes('--show');

function line(s = '') { console.log(s); }

line('');
line('STI HARNESS 上游契约快照');
line('='.repeat(64));

/** 找本机上游包目录：优先 DSH_BIN 反推，其次 PATH 上的 dsh */
function locateUpstream() {
  const client = createDshClient({ origin: 'http://127.0.0.1:1/' });
  const found = client.discover();
  const hit = found.find((f) => f.packageDir);
  return hit ? { dir: hit.packageDir, version: hit.version, bin: hit.bin } : null;
}

const up = locateUpstream();

if (!up) {
  line('');
  line('  SKIP：本机未发现 @deepseek-ai/dsh 包，无法提取上游契约。');
  line('        这不是"通过"——「本机没装上游」不等于「上游契约没变」。');
  line('        装上上游（或设 DSH_BIN）后重跑本脚本。');
  line('');
  line('='.repeat(64));
  line('用例 0 个｜失败 0 个｜跳过 1 个');
  line('DONE fails=0 skipped=1');
  process.exitCode = 0;
} else {
  const extracted = extractUpstreamContract(up.dir);

  line('');
  line('上游：@deepseek-ai/dsh@' + (up.version || '未知'));
  line('位置：' + up.dir);
  line('');

  if (!extracted.available) {
    line('  SKIP：已定位上游包，但未能提取契约 —— ' + extracted.reason);
    if (extracted.missing && extracted.missing.length) {
      for (const m of extracted.missing) line('    · 缺：' + m);
    }
    line('');
    line('='.repeat(64));
    line('用例 0 个｜失败 0 个｜跳过 1 个');
    line('DONE fails=0 skipped=1');
    process.exitCode = 0;
  } else {
    const typeCount = Object.keys(extracted.sessionEventTypes).length;
    line('提取结果（来源均为**类型定义源码**，非运行事件流）：');
    for (const [k, v] of Object.entries(extracted.sources)) line('  · ' + v);
    line('  · 事件类型 ' + typeCount + ' 个：' + Object.keys(extracted.sessionEventTypes).join(' '));
    line('  · TokenUsage 字段：' + extracted.tokenUsageFields.join(', '));
    line('  · TurnTokenUsage 字段：' + extracted.turnTokenUsageFields.join(', '));
    if (extracted.missing && extracted.missing.length) {
      for (const m of extracted.missing) line('  ⚠ 未能读取：' + m);
    }

    const prev = readSnapshot();
    line('');

    if (wantUpdate) {
      const f = writeSnapshot(extracted);
      line('已写入快照基线：' + f);
      line('  基线：上游 ' + (extracted.version || '未知') + '，事件类型 ' + typeCount + ' 个。');
      if (prev) line('  覆盖了旧基线：上游 ' + (prev.version || '未知') + '，生成于 ' + (prev.extractedAt || '未知'));
      line('');
      line('  ⚠ 请确认这次更新是有意的：把差异"一键抹平"会让这个机制失去意义。');
      line('    正确的顺序是：先看差异 → 改 events.mjs 的映射 → 跑 test-core.mjs → 再更新基线。');
      line('');
      line('='.repeat(64));
      line('用例 1 个｜失败 0 个');
      line('DONE fails=0');
      process.exitCode = 0;
    } else if (wantShow) {
      line('当前快照文件：' + SNAPSHOT_FILE);
      if (prev) line(JSON.stringify(prev, null, 2));
      line('');
      line('DONE fails=0');
      process.exitCode = 0;
    } else if (!prev) {
      line('快照文件尚不存在：' + SNAPSHOT_FILE);
      line('  首次使用请运行 `node tools/snapshot-upstream-contract.mjs --update` 生成基线。');
      line('  在基线生成之前，本脚本无法判断"上游是否变了"。');
      line('');
      line('='.repeat(64));
      line('用例 1 个｜失败 0 个｜跳过 1 个');
      line('DONE fails=0 skipped=1');
      process.exitCode = 0;
    } else {
      const diff = diffContract(prev, extracted);
      line('快照基线：上游 ' + (prev.version || '未知') + '，生成于 ' + (prev.extractedAt || '未知'));

      if (diff.ok) {
        line('');
        line('  ✓ 契约与快照一致 —— 事件类型 ' + typeCount + ' 个、TokenUsage '
          + extracted.tokenUsageFields.length + ' 字段、TurnTokenUsage '
          + extracted.turnTokenUsageFields.length + ' 字段均未变。');
        line('');
        line('  说明：这只证明**类型契约**没变，不证明运行事件流的形状没变。');
        line('        运行侧的破坏仍只能由 fixtures 回归发现（见 docs/roadmap.md「M0 缺口」）。');
        line('');
        line('='.repeat(64));
        line('用例 1 个｜失败 0 个');
        line('DONE fails=0');
        process.exitCode = 0;
      } else {
        line('');
        line('  ✗ 发现 ' + diff.changes.length + ' 处差异 —— 上游契约变了，必须逐条确认影响面：');
        line('');
        for (const c of diff.changes) {
          line('    [' + c.kind + '] ' + c.item);
          line('        快照：' + c.before);
          line('        现在：' + c.after);
        }
        line('');
        line('  处理顺序：① 逐条判断是否影响 app/kernel/dsh-provider/events.mjs 的映射；');
        line('            ② 改完跑 `node tools/test-core.mjs`；');
        line('            ③ 确认无误后 `node tools/snapshot-upstream-contract.mjs --update` 更新基线。');
        line('');
        line('='.repeat(64));
        line('用例 1 个｜失败 1 个');
        line('DONE fails=1');
        process.exitCode = 1;
      }
    }
  }
}

/**
 * 系统路由：健康检查、平台状态、路由表、契约描述、限流状态、指标、OpenAPI 规格。
 *
 * 前几项是 **public** scope —— 它们的作用就是"让别人能一眼看出这台机器上
 * 到底装了什么、什么没装"。它们不含任何敏感数据，因此无需登录；
 * 但也不暴露任何凭据（凭据只在 admin scope 的接口里，且永不回显明文）。
 *
 * ⚠️ **不是全都 public**（0.8.0 起）：`system.metrics` 与 `system.openapi.json`
 * 是 `session` scope + `system:read`。理由：它们虽然也不含凭据，但**含权限模型本身** ——
 * 指标里有本组织的审计链长，规格里有每条接口的 `capability` 要求。
 * 把"哪些接口需要管理员"送给未认证调用方，等于把攻击面地图送出去。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { describeContract } from '../../kernel/contract.mjs';
import { probeKernelConnection } from '../../kernel/index.mjs';
import { normalizeKernelInput, mergeKernelConfigPatch } from '../../kernel/connection-config.mjs';
import { middlewareStatus, MIDDLEWARE_STATUS } from '../middleware/registry.mjs';
import { staticAssets } from '../static.mjs';
import { dbInfo } from '../../data/db.mjs';
import { migrationStatus } from '../../data/migrate.mjs';
import { checkNodeVersion, versionGate, ENV_NAMES, readRawConfigFile, writeConfigFile, loadConfig } from '../../config.mjs';
import { readVersion } from '../../paths.mjs';
import { readJsonBody } from '../context.mjs';
import { errors } from '../../util/errors.mjs';
import { auditOf } from './_shared.mjs';
import * as metrics from '../../platform/observe/metrics.mjs';
import { buildOpenApi } from '../openapi.mjs';

/** 平台设置白名单（0.16.0）：键 → 类型 / 范围 / 页面文案。GET 与 PUT 共用这一张表。 */
const SETTING_DEFS = [
  { key: 'host', type: 'string', label: '监听地址' },
  { key: 'port', type: 'number', integer: true, min: 1, max: 65535, label: '监听端口' },
  { key: 'sessionTtlHours', type: 'number', min: 0.5, label: '会话令牌有效期（小时）' },
  { key: 'trustProxy', type: 'boolean', label: '信任反向代理头', note: '经反向代理部署时才打开；直连形态下打开会被伪造头骗过' },
  { key: 'embeddingProvider', type: 'string', label: '向量模型 Provider', note: 'openai-compat | ollama；留空 = 纯文本检索' },
  { key: 'embeddingBaseUrl', type: 'string', label: '向量服务 Base URL' },
  { key: 'embeddingModel', type: 'string', label: '向量模型名' },
  { key: 'embeddingDim', type: 'number', integer: true, min: 0, label: '向量维度', note: '0 = 未配向量' },
  { key: 'embeddingCredentialName', type: 'string', label: '向量服务凭据名', note: '凭据值本身存凭据表（加密），这里只引用名称' },
  { key: 'embeddingTimeoutMs', type: 'number', min: 1000, label: '向量化超时（毫秒）' },
  { key: 'chunkMaxChars', type: 'number', min: 100, label: '分块上限（字符）', note: '改动只影响新文档；已有文档需重建索引才一致' },
  { key: 'chunkOverlapChars', type: 'number', min: 0, label: '分块重叠（字符）' },
  { key: 'chunkMinChars', type: 'number', min: 0, label: '最小块（字符）' },
  { key: 'chunkMaxHeadingDepth', type: 'number', integer: true, min: 0, label: '标题层级并入深度' },
  { key: 'workerPoolSize', type: 'number', integer: true, min: 0, label: '知识解析 worker 数', note: '0 = 主线程内联执行' },
  { key: 'prefilterVector', type: 'boolean', label: '向量预过滤', note: '会改变检索答案（非纯优化），默认关' },
  { key: 'prefilterCandidates', type: 'number', integer: true, min: 32, label: '预过滤候选上限' },
];
const SETTING_MAP = new Map(SETTING_DEFS.map((d) => [d.key, d]));

/** 按白名单定义做类型强转与范围校验，违反即 400（错误信息带键名与中文标签）。 */
function coerceSetting(key, raw) {
  const def = SETTING_MAP.get(key);
  if (def.type === 'boolean') {
    if (typeof raw !== 'boolean') throw errors.badRequest('「' + def.label + '」（' + key + '）必须是 true / false');
    return raw;
  }
  if (def.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw errors.badRequest('「' + def.label + '」（' + key + '）必须是数字');
    if (def.integer && !Number.isInteger(n)) throw errors.badRequest('「' + def.label + '」（' + key + '）必须是整数');
    if (def.min != null && n < def.min) throw errors.badRequest('「' + def.label + '」（' + key + '）不能小于 ' + def.min);
    if (def.max != null && n > def.max) throw errors.badRequest('「' + def.label + '」（' + key + '）不能大于 ' + def.max);
    return n;
  }
  return String(raw == null ? '' : raw);
}

/**
 * @param {{config:object, kernel:object, router:object, paths:object, startedAt:number}} deps
 */
export function systemRoutes(deps) {
  const { config, kernel, router, startedAt } = deps;
  const audit = auditOf('system', deps.governance);

  return [
    {
      id: 'system.health',
      method: 'GET',
      path: '/api/health',
      scope: 'public',
      summary: '存活探针',
      milestone: 'M0',
      handler: (ctx) => ctx.ok({
        version: readVersion(),
        uptimeMs: Date.now() - startedAt,
        kernelReady: kernel.ready,
      }),
    },

    {
      id: 'system.status',
      method: 'GET',
      path: '/api/system/status',
      scope: 'public',
      summary: '平台状态（全部为实测值）',
      milestone: 'M0',
      handler: async (ctx) => {
        const node = checkNodeVersion();
        const db = dbInfo();
        const mig = migrationStatus();
        const assets = staticAssets();
        const kdesc = await kernel.describe();
        const gate = versionGate(kdesc.kernelVersion);

        ctx.ok({
          platform: {
            version: readVersion(),
            node: { current: node.current, required: node.required, ok: node.ok },
            pid: process.pid,
            uptimeMs: Date.now() - startedAt,
            startedAt: new Date(startedAt).toISOString(),
            dataDir: deps.paths.DATA_DIR,
          },
          config: {
            file: config.configFile,
            exists: config.exists,
            sources: config.sources,
            values: {
              host: config.values.host,
              port: config.values.port,
              // 令牌只报"有没有"，不回报内容
              hasToken: !!config.values.dshToken,
            },
            /** 前端照着这段文案提示运维即可，无需在自己的代码里写上游变量名 */
            connectHints: {
              originEnv: ENV_NAMES.origin,
              tokenEnv: ENV_NAMES.token,
              profileEnv: ENV_NAMES.profile,
              configFile: config.configFile,
              note: '把带令牌的完整地址整段填进 ' + ENV_NAMES.origin + '（或写进配置文件），然后重启本服务。',
            },
          },
          database: db,
          migrations: mig,
          staticAssets: assets,
          kernel: {
            /**
             * 唯一的判据：接入了没有。前端据此决定放行还是拦住并要求接入。
             * 刻意不给"模式"这类三值字段 —— 见 app/kernel/index.mjs 的 facade 说明。
             */
            ready: kernel.ready,
            reason: kernel.reason,
            describe: kdesc,
            contract: kernel.contract,
            versionGate: gate,
          },
          middleware: middlewareStatus(),
          routes: router.stats(),
          // 调度器的**进程级**状态（不含任何组织数据，因此可以放在 public 接口里）。
          // 组织级任务明细在 /api/schedule/jobs（session scope，按组织隔离）。
          scheduler: deps.schedule
            ? {
              running: !!deps.schedule.runningNow(),
              tickMs: deps.schedule.tickMs(),
              boundary: '单进程调度：进程不跑任务就不跑，且不补跑错过的。本模块不是 cron，也没有分布式锁。',
            }
            : null,
          /**
           * 知识层**机器级**能力（解析器可用性、向量模式、worker 池状态）。
           * 刻意传 null 作为租户：这是 public 接口，不得统计任何组织的数据 ——
           * 因此这里的 bases/documents/chunks 都是 null（"没统计"），而不是 0。
           */
          knowledge: deps.knowledge ? deps.knowledge.status(null) : null,
        });
      },
    },

    // ── 内核接入向导（P0：把"手改 config.json"变成页面上的三步）───────
    //
    // 为什么这两条是 `session` + `system:write` 而不是 public：
    //   · 探测会让**服务端**主动去连一个调用方指定的地址（可以指向内网任何主机）——
    //     这是一个 SSRF 形状的动作，必须是有权限的人才能发起，且必须留痕；
    //   · 保存会写配置文件、改平台连到哪台引擎 —— 这是本平台权限级别最高的配置之一。
    // 因此两者都收紧到管理员，并且都记审计（谁、什么时候、试了哪个地址）。
    //
    // **保存即生效**（0.21.3）。这里曾经写的是"刻意不提供改完立即生效"，理由是
    // "内核门面在装配期就被路由持有，热切换会让正在跑的回合用的是哪个 provider 变得不可判定"。
    // 前半句是事实（门面确实被路由持有），但它是个**可以修的形状**：门面内部持有可变
    // state、对外全用 getter 之后，换内核 = 原子写一次 state，路由引用完全不用动。
    // 后半句才是真问题，而它也有确定答案 —— **回合开头抓一次 provider 局部变量**：
    // 在途回合用旧内核跑完，新回合用新内核。这恰恰让语义变得可判定，而不是不可判定。
    //
    // 剩下两种"文件改了、进程不变"的情形（env 覆盖 / 重新装配失败）仍然如实报需要重启。
    {
      id: 'system.kernel.probe',
      method: 'POST',
      path: '/api/system/kernel/probe',
      scope: 'session',
      capability: ['system:write'],
      summary: '检测一个内核地址是否可用（只探测，不改动任何配置）',
      milestone: 'P0',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const probe = await probeKernelConnection({
          origin: body.origin,
          token: body.token,
          profile: body.profile,
        });
        audit(ctx, 'kernel.probe', probe.origin || '(空地址)', probe.ok ? 'ok' : 'fail', {
          state: probe.state, stage: probe.stage, httpStatus: probe.httpStatus,
          version: probe.version, hasToken: probe.hasToken,
        });
        ctx.ok({ probe });
      },
    },

    {
      id: 'system.kernel.config',
      method: 'POST',
      path: '/api/system/kernel/config',
      scope: 'session',
      capability: ['system:write'],
      summary: '保存内核接入配置（写 data/config.json，令牌以密文落盘；保存即生效，无需重启）',
      milestone: 'P0',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);

        const norm = normalizeKernelInput(body.origin, body.token);
        if (norm.invalid) throw errors.badRequest('内核地址不可用：' + norm.error);

        // 先检测、再保存 —— 顺序本身就拒绝了一类垃圾配置。
        //
        // 0.21.5 起判据收紧成一条：**检测没通过就不保存**（从前留了 `force` 这条旁路，
        // 只拒 `unreachable` / `not-kernel`）。为什么收紧：那条旁路唯一的作用是让用户
        // 把一条当场已被证伪的配置存进去，代价是"保存成功、平台却没接入上" ——
        // 那是最难自查的一种失败（界面会显示"已保存"）。而它换来的好处只是少点一次检测。
        //
        // 为什么连 `need-token` / `token-rejected` / `forbidden` 也拒：它们确实"连上了"，
        // 但对平台而言与连不上等价 —— 不具备令牌 / 令牌过期 / 来源不被信任的内核，
        // 存进去也跑不动一个回合。词表里每一种都给了**下一步该干嘛**（见 DIAG），
        // 所以这里的拒绝是"告诉你卡在哪一步"，不是"不告诉你为什么"。
        const probe = await probeKernelConnection({ origin: norm.origin, token: norm.token, profile: body.profile });
        if (!probe.ok) {
          // 用 `ctx.fail` 而不是 `throw`：本项目的统一错误出口**刻意只回 code + message**
          // （不把内部结构泄给调用方），而这里必须把**完整诊断**带回去 ——
          // 前端要拿它显示"卡在哪一步、下一步干嘛"，不该为了显示结果再探一次。
          // `ctx.fail` 就是这条规矩的显式出口：要带 detail 就自己写明白。
          ctx.fail(409, 'kernel_not_ready',
            '没有保存：这次检测的结果是「' + probe.verdict + '」。'
            + (probe.detail ? '（' + probe.detail + '）' : '')
            + (probe.hint ? ' ' + probe.hint : ''),
            { probe });
          return;
        }

        // 令牌动作的优先级：显式"清空" > 给了令牌就写 > 没给就保持原样。
        // 顺序不能反 —— "地址里带了一个旧令牌、用户其实想清空"这种情况，
        // 若让令牌优先，用户会以为清了，实际写进去的还是旧的。
        const tokenAction = String(body.tokenAction || '') === 'clear'
          ? 'clear'
          : (norm.token ? 'set' : 'keep');

        if (tokenAction === 'set' && typeof deps.encryptSecret !== 'function') {
          // 宁可拒绝保存，也不退化成写明文：配置文件里的明文令牌一旦落盘，
          // 之后无论怎么修都有一份副本留在备份/快照里了。
          throw errors.internal('缺少加密能力（装配层未注入 encryptSecret）—— 拒绝以明文写入配置文件');
        }

        const raw = readRawConfigFile();
        const patch = { origin: norm.origin };
        if (tokenAction === 'set') patch.tokenCipher = deps.encryptSecret(norm.token);
        else if (tokenAction === 'clear') patch.tokenCipher = null;
        const next = mergeKernelConfigPatch(raw, patch);
        const written = writeConfigFile(next);

        // ── 当场生效（0.21.3）────────────────────────────────────────
        // 写盘成功后立刻重新装配、原子换入**正在跑的**门面，不再等重启。
        //
        // 为什么还留着"重启"这条路：有且只有两种情形下文件改了而进程不变 ——
        //   ① 被环境变量覆盖（env 优先级高于配置文件，这是既定语义）；
        //   ② 重新装配抛错（比如地址当场不可用）。
        // 这两种必须如实说"仍需重启"。因为"我们支持热切换了"就对它们也报成功，
        // 就是拿一个新的谎言替换旧的缺陷。
        let switchResult = null;
        let switchError = '';
        if (typeof deps.switchKernel === 'function') {
          try {
            switchResult = await deps.switchKernel();
          } catch (e) {
            switchError = e && e.message ? e.message : String(e);
          }
        } else {
          switchError = '装配层未注入切换能力（switchKernel）';
        }

        const envOverride = !!(deps.config && deps.config.sources
          && deps.config.sources.dshOrigin === 'env');
        const applied = !!(switchResult && switchResult.applied);
        const restartRequired = envOverride || !applied;
        const runningReady = !!(deps.kernel && deps.kernel.ready);

        audit(ctx, 'kernel.config', norm.origin, 'ok', {
          tokenAction,
          tokenSource: norm.tokenFrom,
          probeState: probe.state,
          file: written.file,
          readyAfterSwitch: applied ? !!switchResult.ready : null,
          switchError: switchError || undefined,
          envOverride,
        });

        ctx.ok({
          saved: true,
          file: written.file,
          bytes: written.bytes,
          applied: {
            origin: norm.origin,
            hasToken: !!(next.dshTokenCipher || next.dshToken),
          },
          // 只有 env 覆盖 / 切换失败这两种情形才为 true；正常保存是**当场生效**的
          restartRequired,
          restartNote: envOverride
            ? '这个进程用的是环境变量里的值（' + ENV_NAMES.origin + '）—— '
              + '环境变量优先级高于配置文件，所以这次保存不会改变当前进程。'
              + '要改就从那个环境变量改，或者去掉它再重启。'
            : (!switchResult
              ? '已写入配置文件，但当场切换失败：' + switchError
                + '。当前内核状态未改变（' + (runningReady ? '仍可用' : '仍不可用')
                + '）—— 可以重启本服务再试。'
              : ''),
          switched: applied
            ? {
              ready: !!switchResult.ready,
              reason: switchResult.reason || '',
              note: switchResult.ready
                ? '已当场生效，无需重启。两点要知道：'
                  + '① 正在进行的回合会用**切换前**的内核跑完（不会中途换线）；'
                  + '② 会话在两边各自存一份 —— 旧内核上建立的会话在新内核上取不到轨迹。'
                : '已按你填的地址当场切换，但这个内核**当前不可用** —— '
                  + '保存那一刻的检测是通过的，之后又探不到了（内核掉线，或这次保存没改变当前进程）。'
                  + '平台会显示为"内核不可用"并给出重连入口 —— 内核起来后重新检测/保存即可。',
            }
            : null,
          effective: { ready: runningReady },
          probe,
        });
      },
    },

    /* ── 平台设置（0.16.0）：把「只能看 config.json」的运行参数搬进界面 ──
     *
     * 范围是刻意收窄的，只收**运行参数**（监听、会话、知识检索行为），三类东西不收：
     *   · 密钥与内核接入（dshOrigin / dshToken / dshTokenCipher）：
     *     它们有专用向导（探活 + 密文落盘，见上），设置页不出现第二个能碰它的入口；
     *   · 被环境变量覆盖的键：env 优先级高于 config.json，允许改只会制造
     *     "保存成功却不生效"的假动作 —— 本页对这类键直接锁定并明说原因；
     *   · 未知键：不在白名单里的键一律 400，写盘时**合并**进原文件（不整文件覆盖），
     *     因此令牌密文等未收录键永远原样保留。
     */
    {
      id: 'system.settings.get',
      method: 'GET',
      path: '/api/system/settings',
      scope: 'session',
      capability: ['system:read'],
      summary: '平台设置：可管理键的生效值、来源（default / config.json / env）与锁定状态',
      milestone: '0.16.0',
      handler: (ctx) => {
        // 实时读文件而不是装配期快照：保存写盘后页面要立即反映新值 ——
        // 否则管理员保存完看到数值"跳回去"，会以为没保存成功。
        // 「尚未重启、进程还在跑旧值」的边界由 note 与 PUT 的 restartRequired 明说。
        const live = loadConfig();
        return ctx.ok({
        file: config.configFile,
        exists: config.exists,
        settings: SETTING_DEFS.map((d) => ({
          key: d.key,
          type: d.type,
          label: d.label,
          note: d.note || undefined,
          value: live.values[d.key],
          source: live.sources[d.key] || 'default',
          envLocked: live.sources[d.key] === 'env',
        })),
        note: '保存写入 data/config.json，重启服务后生效。环境变量优先级高于配置文件，'
          + '被覆盖的键在本页锁定；密钥与内核接入不在此页管理。',
      });
      },
    },

    {
      id: 'system.settings.update',
      method: 'PUT',
      path: '/api/system/settings',
      scope: 'session',
      capability: ['system:write'],
      summary: '保存平台设置（白名单键 + 类型校验；合并写 config.json，未收录键原样保留；需重启生效）',
      milestone: '0.16.0',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const patch = body && typeof body.settings === 'object' && !Array.isArray(body.settings)
          ? body.settings
          : body;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw errors.badRequest('请求体必须是对象（{ settings: {…} } 或直接的键值对象）');
        }
        const keys = Object.keys(patch);
        if (!keys.length) throw errors.badRequest('没有提供任何要保存的设置项');

        const unknown = keys.filter((k) => !SETTING_MAP.has(k));
        if (unknown.length) {
          throw errors.badRequest('未知或不可通过本页管理的键：' + unknown.join(', ')
            + '（密钥与内核接入请走专用入口，其余键一律不接受页面改动）');
        }

        const raw = readRawConfigFile();
        const applied = {};
        for (const k of keys) {
          const def = SETTING_MAP.get(k);
          if (config.sources[k] === 'env') {
            throw errors.badRequest('「' + def.label + '」（' + k + '）当前由环境变量覆盖，'
              + '写进配置文件不会生效 —— 请改部署环境的环境变量，或移除该变量后再用本页管理');
          }
          applied[k] = coerceSetting(k, patch[k]);
        }
        // 合并写盘：只覆盖白名单键。令牌密文、内核模式等未收录键在 raw 里原样保留 ——
        // 这里若做"整文件替换"，一次保存就能把内核接入配置整个抹掉。
        for (const [k, v] of Object.entries(applied)) raw[k] = v;
        const written = writeConfigFile(raw);

        audit(ctx, 'system.settings.update', written.file, 'ok', {
          keys: Object.keys(applied),
          // 布尔与数字原样记录；字符串值可能含主机名等半敏感信息，只记长度
          values: Object.fromEntries(Object.entries(applied).map(([k, v]) =>
            [k, typeof v === 'string' ? { type: 'string', length: v.length } : v])),
        });

        ctx.ok({
          saved: true,
          file: written.file,
          bytes: written.bytes,
          updated: Object.keys(applied),
          restartRequired: true,
          restartNote: '运行参数在装配期读入进程，保存后需要重启本服务才会生效。'
            + '重启会中断正在进行的回合；已完成的会话与数据不受影响。',
        });
      },
    },

    {
      id: 'system.routes',
      method: 'GET',
      path: '/api/system/routes',
      scope: 'public',
      summary: '路由表（唯一真源，直接读代码里的表）',
      milestone: 'M0',
      handler: (ctx) => ctx.ok({ routes: router.list(), stats: router.stats() }),
    },
    {
      id: 'system.contract',
      method: 'GET',
      path: '/api/system/contract',
      scope: 'public',
      summary: '契约描述与上游映射覆盖率（诚实标注未核实项）',
      milestone: 'M0',
      handler: (ctx) => ctx.ok({
        contract: describeContract(),
        mapping: kernel.mapping,
        compat: kernel.compat,
      }),
    },

    {
      id: 'system.middleware',
      method: 'GET',
      path: '/api/system/middleware',
      scope: 'public',
      summary: '中间件交付状态（明示哪些还没实装）',
      milestone: 'M0',
      handler: (ctx) => ctx.ok({
        middlewares: MIDDLEWARE_STATUS,
        chains: deps.pipeline ? deps.pipeline.chains : null,
        note: 'state=not-implemented 的中间件在当前版本不做任何拦截，'
          + '响应头 x-sti-passthrough 会如实列出本次请求经过的占位中间件。',
      }),
    },

    // ── P1-2：指标端点 ────────────────────────────────────────────────
    // 为什么是 session scope 而不是 public：指标里包含**本组织的**审计链长度。
    // 采集器用一个只读账号的 API Key 即可（system:read）。做成 public 会让
    // "平台规模"这类信息对所有能碰到端口的人可见 —— 没必要。
    {
      id: 'system.metrics',
      method: 'GET',
      path: '/api/system/metrics',
      scope: 'session',
      capability: ['system:read'],
      summary: 'Prometheus 文本格式指标（计数器为进程级，重启归零；链长为调用方组织）',
      milestone: 'P1',
      handler: (ctx) => {
        // 只统计匹配到路由的 /api/* 请求：/upstream 透传与静态资源不经中间件链，
        // 把它们混进 route 维度会污染指标（这条边界也写在 metrics.mjs 顶部）。
        const body = metrics.render({ tenantId: ctx.tenantId });
        ctx.setHeader('cache-control', 'no-store');
        ctx.text(200, body, 'text/plain; version=0.0.4; charset=utf-8');
      },
    },

    {
      id: 'system.openapi',
      method: 'GET',
      path: '/api/system/openapi.json',
      // session + system:read（不是 public）：规格里含每条接口的 capability 要求 ——
      // 那是"哪些接口需要管理员"的地图。见本文件顶部注释。
      scope: 'session',
      capability: ['system:read'],
      summary: 'OpenAPI 3.0 规格（从路由表生成，因此不会与实现漂移；响应体是标准文档，不是平台信封）',
      milestone: 'P1',
      handler: (ctx) => {
        // 直接给标准 OpenAPI 文档，**不套 `{ok:true, ...}` 信封** ——
        // 套了就不再是合法 OpenAPI，Postman/Insomnia/Swagger UI 全都吃不了。
        // 这是本项目里少数几个刻意偏离"统一信封"的地方，理由必须写出来。
        ctx.setHeader('cache-control', 'no-store');
        ctx.json(200, buildOpenApi({ routes: router.list(), version: readVersion() }));
      },
    },
  ];
}

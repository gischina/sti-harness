-- ---------------------------------------------------------------------------
-- 0024 · 删掉「未分组」：每个组织一个**兜底工作区**（is_default）
--
-- 删什么：「未分组」这个概念本身。它不是一条工作区记录，只是 `workspace_id IS NULL`
--   的会话构成的**虚拟桶** —— 建表时（0021 头注释第 2 条）它是"删工作区不级联"的
--   落点。用了两版之后，用户把它读穿了：
--
--     用户 2026-10-08：「默认工作区和未分组，这个未分组是个什么概念，删除工作区，
--                       其下面的会话移动到未分组，未分组有意义吗」
--
--   查证后发现它不止"没意义"，还是一处**看不见的暗门**：
--     · 它不是 workspaces 里的一行 —— 没有 id、没有 cwd、不能改名、不能删除，
--       所以它在各处的呈现必然不一致（用户接着就发现"当前工作区小节也没显示未分组"）；
--     · 更要紧的是权限：`sessionManageRight` 对未分组的会话**直接返回 can:true**
--       （见 platform/workspace/service.mjs 的旧注释）—— 进了工作区的会话按档位判，
--       没进工作区的反而人人可管。没有档位 = 没有门，而它连解释都没有。
--
-- 换成什么（用户 2026-10-08 裁定）：
--   ① **未分组整个删掉**；
--   ② 删除工作区时，里面的会话**移入默认工作区**（不再有"无处可放"这回事）；
--   ③ 因此默认工作区**不能重命名、不能删除** —— 它是全租户会话的兜底去处，
--      能被改名或删掉的话，② 的落点就没有保证了。
--      代价说清：`默认工作区` 这个名字从此是**固定的**；不想要它，另建一个工作区用即可。
--
-- 本迁移做两件事：
--   1. 加 `workspaces.is_default`（0/1），并把每个租户**最早建的那个工作区**标成默认 ——
--      它就是 `ensureDefaultWorkspace` 当初播种的那一个（播种发生在该租户第一次启动时，
--      时间上必然是最早的）。租户下一个工作区都没有时不会出错：那里没有可标的行。
--   2. 把存量 `workspace_id IS NULL` 的会话一次性归进该租户的默认工作区。
--      ⚠️ `EXISTS` 那道判断不能省：租户还没有工作区时（新装、迁移先于播种跑）
--         `workspace_id = (SELECT ...)` 会算出 NULL —— 那就成了一次什么都不做的 UPDATE，
--         看似无害，但配上 `updated_at` 的自增就成了"每次启动都把所有空归属会话的
--         时间戳改一遍"。加了 EXISTS，这种租户一行都不动。
--         （那种租户的空归属会话由服务层在播种之后对账，见 service.mjs 的
--          `attachOrphansToDefault`——迁移在这里够不着"尚未播种"的租户。）
--
-- 只增不改（迁移纪律）：0021 一个字都不动（migrate.mjs 对已应用迁移做 sha256 比对）。
-- 不变量：`is_default = 1` 的行**每租户至多一条**由服务层维持（播种时设、删除时拦），
--   本迁移不建唯一索引 —— SQLite 的部分唯一索引表达不了"按 tenant_id 各一条"，
--   而用触发器去维护"至多一条"会把一条业务规则藏进 schema（本项目的一贯做法是
--   把这类判据留在服务层，让它可读、可测、可给人看）。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

ALTER TABLE workspaces ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- 每个租户最早建的那个工作区 = 当初播种的"默认工作区"
UPDATE workspaces
   SET is_default = 1
 WHERE archived_at IS NULL
   AND id IN (
     SELECT id FROM (
       SELECT id,
              ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at ASC, id ASC) AS rn
         FROM workspaces
        WHERE archived_at IS NULL
     )
      WHERE rn = 1
   );

-- 存量空归属会话归入本租户的默认工作区
UPDATE agent_sessions
   SET workspace_id = (
         SELECT w.id FROM workspaces w
          WHERE w.tenant_id = agent_sessions.tenant_id
            AND w.is_default = 1
            AND w.archived_at IS NULL
          LIMIT 1
       ),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE workspace_id IS NULL
   AND archived_at IS NULL
   AND EXISTS (
         SELECT 1 FROM workspaces w2
          WHERE w2.tenant_id = agent_sessions.tenant_id
            AND w2.is_default = 1
            AND w2.archived_at IS NULL
       );

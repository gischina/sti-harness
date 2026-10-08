-- ---------------------------------------------------------------------------
-- 0011 · 模型单价（成本核算：token → 金额）
--
-- 为什么需要：
--   平台已经在逐字段照抄上游的 usage 事件（input/cacheRead/cacheWrite/output/reasoning），
--   但"花了多少钱"这个问题在 1.0.2 之前**没有任何出口** —— 企业内控口径上，
--   "本月用了 3200 万 token" 不如 "本月花了 480 元" 能对上财务。
--
-- 为什么单价落在 `model_providers` 上（而不是另建价格表）：
--   ① 单价是**条目属性**，与降级链同源 —— 链按 `priority` 选中的那条，就是实际计费的那条；
--      另建一张价格表就必须维护"价格与条目一致"，而那种一致性迟早会漂。
--   ② 每个租户的价格可能不同（合同价），条目本身就带 `tenant_id`，天然隔离。
--
-- 单位与语义（**这三条必须写死在注释里，否则一年后没人说得清**）：
--   · `*_minor` 是**最小货币单位**（人民币的"分"、美元的"美分"），整数。
--     用整数存钱、只在最后一步四舍五入 —— 用浮点存金额迟早会出现 0.01 的漂移。
--   · 单价是**每 100 万 token** 的价格（行业惯例，各家价目表都这么写）。
--     计费 = round(该类 token 数 × 单价 / 1_000_000)。
--   · 单价列**可为 NULL**，含义是"没配这个价"，**不是 0 元**。
--     0 元是"免费"，NULL 是"不知道" —— 把不知道当免费会算出一个偏低的、看起来正常的总额，
--     这是本项目最不能接受的一类错误（见 README §3 诚实数据源）。
--
--   四类 token 各自定价，互不顶替：
--     `input`       → price_in_minor
--     `cache_read`  → price_cache_read_minor
--     `cache_write` → price_cache_write_minor
--     `output`      → price_out_minor        （reasoning 是 output 的**子集**，不另计）
--   `cache_read` / `cache_write` 没配价时，那部分 token 记为"未定价"，
--   **绝不按 input 价顶替** —— 缓存价通常比输入价便宜得多，顶替会系统性高估。
--
-- 为什么不给"历史用量"补算：
--   单价是**当下的**配置，把它套到三个月前的用量上是编造历史。金额口径从配置单价当天起算，
--   页面上必须把这一点写出来（"按当前单价估算"）。
--
-- 只增不改（迁移纪律）：ALTER TABLE ADD COLUMN 追加，不动 0008 的历史定义。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

ALTER TABLE model_providers ADD COLUMN currency                TEXT;     -- ISO 4217（CNY / USD …）；配了任一单价就必须有值
ALTER TABLE model_providers ADD COLUMN price_in_minor          INTEGER;  -- 未缓存输入，每 100 万 token 的最小单位数
ALTER TABLE model_providers ADD COLUMN price_cache_read_minor  INTEGER;  -- 缓存读取
ALTER TABLE model_providers ADD COLUMN price_cache_write_minor INTEGER;  -- 缓存写入
ALTER TABLE model_providers ADD COLUMN price_out_minor         INTEGER;  -- 输出（含 reasoning）

-- 说明：不加 CHECK 约束（`node:sqlite` 的 ALTER TABLE 支持有限，且负价/坏币种在
-- 服务层已经拦住 —— 校验只放在库里，错误信息会变成一句 SQL 报错，运维读不懂）。
-- 服务层规则：单价必须是非负整数或 NULL；配了任一单价则 currency 必填且为 3 位大写字母。

-- 0005 — M4 · MCP 健康探测的留痕字段（只增不改）。
--
-- mcp_servers.health 列（0001 就有）只存结果（unknown | ok | error），
-- 但「什么时候探的、为什么失败」没有地方放。没有这两列，
-- 探测失败就只能给一句干巴巴的 error，运维没法判断是刚坏的还是三个月没探过。
-- 详情放本表而不进审计 —— 健康状态是易变观测数据，不是需要防篡改的治理事实。
--
-- Copyright 2026 liwei（易智瑞西安）.
ALTER TABLE mcp_servers ADD COLUMN health_detail TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_servers ADD COLUMN health_at   TEXT NOT NULL DEFAULT '';

# 2026-10-13 前端站点迁到 agentchat.stream

## 一句话

Cloudflare Worker `iroh-chatroom` 的自定义域名从 `im.pinkstar.cc` 换成新购的
**`agentchat.stream`**；旧域名先短暂并存（半天，等 0.1.1 铺开），随后**按要求收回**——
现在只保留 `agentchat.stream`。

## 改了什么

| # | 位置 | 改动 |
|---|---|---|
| 1 | `wrangler.toml` | `routes` 新增 `agentchat.stream`（custom_domain）；`im.pinkstar.cc` 保留为兼容别名；补变更史 |
| 2 | `agent-pi/src/cli.ts` | `DEFAULT_SERVER` → `https://agentchat.stream`（USAGE 同步）——适配器"配置自举"的默认来源 |
| 3 | `mobile/src/config/relay-config.ts` | 移动端拉的 `RELAY_CONFIG_URL` → 新域名 |
| 4 | 文案 | README 组件表、`docs/bring-your-own-agent.md`、`agent-pi/README.md`、`docs/deploy.md`（含换算校验命令与变更史）、npm 包 README（`scripts/build-room-bridge-npm.sh`）、e2e/单测脚本 |
| 5 | 产物 | 单文件 bridge → **`bridge-v0.1.1`**（新域名为默认）；npm 包 → **`iroh-room-bridge@0.1.1`** |

不动的东西：中继/常驻节点（`*.editor.vip`）、`get.editor.vip` 安装脚本分发、
roomd 与协议。历史发版记录/日期快照文档里的旧域名**保持原样**（它们记录当时事实）。

## 验证

| 项 | 结果 |
|---|---|
| CF 部署 | 并存阶段 version `ddebec7a…`（双域名）；**收旧后 version `df3e4162-e6e4-473f-82cf-9f4715fc5da1`（只留 `agentchat.stream`）** |
| 双域名可达 | `https://agentchat.stream/` 与 `https://im.pinkstar.cc/` 均 **200**；`/js/util.js` 哈希与本地一致（`4e76d2dd…`）；`/relay-config.json` 正常返回 |
| 适配器引导（新默认） | 本机重建的单文件版跑 `byoa-join.py`：日志 `已从 https://agentchat.stream 引导配置`，**6/6**（真实链路） |
| `bridge-v0.1.1` | CI run `38371531377` **success**；Release 13 个资产齐全（6 平台 + 逐产物 sha256 + SHA256SUMS） |
| npm `0.1.1` | 已发布，`latest`=0.1.1；registry 安装后 bundle 内 `agentchat.stream` ×2、**`im.pinkstar.cc` ×0**；`--help` 正常 |
| 单测/类型 | `test-room-bootstrap` 13/13、agent-pi tsc、biome 全过 |

## 回滚与后续

- 旧域名收回实测：`https://im.pinkstar.cc/` → **530 / error 1016**、`dig` 无记录
  （自定义域名绑定删除时记录一并清掉，没有悬挂）。
- 回滚：`wrangler.toml` 的 `routes` 加回旧域名重新部署即可（旧域名必须在 CF 账号里）。
- ⚠️ 发布 npm 用的 granular token 应在用完后 Revoke（本次发布后提醒所有者）。

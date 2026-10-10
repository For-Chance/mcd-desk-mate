# MCP 集成说明

本文档说明「麦娘桌面 McDesk」实际调用了哪些麦当劳 MCP 能力、以什么流程调用、响应数据长什么样，以及这些调用为使用者创造了什么价值。

> 本文所有结论均来自**真实 Token 的真实调用**（2026-10-09 于麦当劳中国 MCP Server 实测），非文档推测。文中不含任何真实 Token、订单号或账号标识。

## 1. 接入信息

| 项目 | 值 |
| --- | --- |
| MCP Server | 麦当劳中国官方 MCP Server（`https://mcp.mcd.cn`） |
| 传输协议 | Streamable HTTP（单端点 POST JSON-RPC 2.0） |
| 认证方式 | 请求头 `Authorization: Bearer <MCP_TOKEN>` |
| 协议版本 | `2024-11-05` |
| 限流 | 每 Token 每分钟 600 次请求 |
| 客户端标识 | `mcd-desk-mate / 0.1.0` |
| 实测 Tool 总数 | **35 个**（`tools/list` 实测返回） |
| 本项目调用 | 12 个 |
| 配置示例 | 见 [`mcp-config.example.json`](./mcp-config.example.json) |

本项目**没有使用任何第三方 MCP SDK**，而是在 `src/mcp/client.js` 中实现了一个约 180 行的轻量客户端，原因是：

1. 桌面宠物对启动速度和包体积敏感，引入完整 SDK 会显著增加安装负担；
2. 需要精确处理 `text/event-stream` 与 `application/json` 两种响应形态；
3. 需要在断网、限流、Token 失效等场景下给出人设化的中文提示，而不是抛原始堆栈。

客户端的握手流程严格遵循 MCP 规范：

```
POST /  initialize                  →  取得 mcp-session-id
POST /  notifications/initialized   （通知，无响应体）
POST /  tools/call                  →  业务调用
```

会话 ID 会缓存在客户端实例上，后续调用自动携带。

## 2. 实际调用的 MCP Tool

所有调用都经过 `src/mcp/brain.js` 统一封装，工具失败不会中断整体流程。

| MCP Tool | 调用场景 | 关键入参 | 麦娘的表现 |
| --- | --- | --- | --- |
| `query-my-coupons` | 启动快照、右键「我的优惠券」 | `page` / `pageSize`（选填） | 播报持券总数；**若有券今日到期则优先警示** |
| `available-coupons` | 启动快照、领券前探测 | 无 | 播报「麦麦省有 N 张券可以领」 |
| `auto-bind-coupons` | 右键 / 托盘「一键领取麦麦省券」 | 无 | 播报「好耶，一口气领了 N 张券，比如「××」！」 |
| `query-my-account` | 启动快照、右键「我的积分」 | 无 | 播报可用积分与累计积分，并单独提示本月/下月过期积分 |
| `campaign-calendar` | 启动快照、右键「今日活动」 | `specifiedDate`（选填） | 播报今日上线活动，或接下来最近的一场 |
| `order-list` | 启动快照、右键「最近订单」 | 无 | 播报上一单时间、门店、金额、商品与「多少天前」 |
| `query-nearby-stores` | 右键「附近门店」 | `beType`+`searchType`+`city`（+`keyword`） | 播报最近门店名称、营业时间与是否在营业 |
| `list-nutrition-foods` | 营养速查、投喂玩法、猜热量出题 | 无 | 在 160 条官方营养数据中检索；投喂时播报热量与三大营养素并累计当日账本 |
| `now-time-info` | 启动快照、作息判断、节气倒计时 | 无 | 决定她「现在是早餐时段」说得对不对；并推算下一个节气还有几天 |
| `query-lottery-info` | 扭蛋机（只读） | 无 | 展示活动名、可用积分、单次消耗与**服务端给出的消耗原文** |
| `draw-lottery` | 扭蛋机（真实抽奖） | 无 | 在用户明确确认后抽一次，展示中奖奖品或原样展示失败原因 |
| `query-my-prizes` | 节气收藏册 | `pageNum` / `pageSize` | 从奖品墙中识别二十四节气门票，计算 6/24 这样的收集进度 |

### 2.1 入参踩坑记录（实测）

`query-nearby-stores` 是本项目唯一一个**必须传城市**的工具。仅传 `beType`/`searchType` 而不传 `city` 时，服务端会返回：

```json
{"success":false,"code":600050,"message":"收藏餐厅列表为空，请您提供城市+关键词进行搜索"}
```

因此应用在设置面板中提供了「常用城市」与「地标关键词」两个字段，并在未填城市时**不发起请求**，直接由麦娘提示用户补全——避免拿一次必然失败的调用来浪费配额。

## 3. 实测响应格式（本项目最重要的技术发现）

官方 Tool 描述只说明「返回 Markdown 便于展示」，实测发现响应存在**三种形态**，若按常规 JSON 解析会全部拿到空数据：

| 形态 | 涉及 Tool | 说明 |
| --- | --- | --- |
| **A. 纯 Markdown 报告** | `available-coupons`、`query-my-coupons`、`campaign-calendar`、`auto-bind-coupons` | 业务数据散落在文本行中，**没有任何 JSON** |
| **B. Markdown 说明 + 内嵌原始 JSON** | `query-my-account`、`order-list`、`query-nearby-stores`、`now-time-info`、`query-lottery-info`、`draw-lottery`、`query-my-prizes` | 正文是人类可读说明，末尾附一段完整的业务 JSON |
| **C. 自定义表格串** | `list-nutrition-foods` | 内嵌 JSON 的 `data` 字段本身又是 `[N]{字段列表}:` + 换行分隔的自定义表格 |

举例说明三者的真实长相：

**形态 A**（`query-my-coupons`，节选）

```
# 您的优惠券列表

共 8 张可用优惠券 | 第 1/1 页 | 每页 20 条

## 9.9元中杯冰美式
- **优惠**: ¥9.9 (用券价格)
- **有效期**: 2026-10-09 00:00-2026-10-15 23:59
- **标签**: 到店专用、外送专用
```

**形态 B**（`query-my-account`，末尾内嵌）

```json
{"availablePoint":"241.3","accountId":"...","accumulativePoint":"313.3",
 "currency":"麦享会积分","currentMouthExpirePoint":"0","expiredPoint":"0",
 "frozenPoint":"0","nextMouthExpirePoint":"0","usedPoint":"72"}
```

> 注意 `currentMouthExpirePoint` 官方字段名拼写为 `Mouth`（非 `Month`），本项目按原字段名兼容。

**形态 C**（`list-nutrition-foods`，`data` 字段原文节选）

```
[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  猪柳麦满分,null,1288,308,16,16,24,781,213
  猪柳蛋麦满分,null,1618,387,23,21,25,846,243
```

为此本项目专门抽出 `src/mcp/parse.js` 作为**独立解析层**：用括号配平 + 字符串状态机挖出内嵌 JSON，用正则解析 Markdown 报告，再把营养表串还原成 160 条结构化记录。解析全部容错，任一段失配只降级为空集合，不抛异常。

自行验证可执行：

```bash
export MCD_MCP_TOKEN="你的 Token"

# 列出全部 35 个 Tool 与入参 schema
node scripts/verify-mcp.js list

# 真实跑一遍本项目用到的全部工具，原始响应存入 .tmp/
node scripts/verify-mcp.js calls scripts/verify-calls.json

# 端到端校验：真实数据 → 解析 → 麦娘播报文案
node scripts/check-brain.js 上海市 陆家嘴

# 玩法能力联调：抽奖活动、节气收藏、菜单、投喂、出题
node scripts/check-fun.js
```

> `check-fun.js` **刻意不调用真实的 `draw-lottery`**——抽奖会实实在在扣积分。
> 它只做两件事：把只读链路跑通，以及验证「不做确认时必定被拒绝」这道闸门是否有效。

## 4. 调用流程

### 4.1 启动快照（并发聚合）

应用启动后约 2.6 秒（等渲染层就绪）触发一次，此后按用户配置的间隔（默认 30 分钟）重复。

```
麦娘启动
   │
   ├─ Promise.all 并发发起 6 个 tools/call
   │     ├─ query-my-coupons     ┐
   │     ├─ available-coupons     │
   │     ├─ query-my-account      │
   │     ├─ campaign-calendar     ├─ 任一失败都不影响其余
   │     ├─ order-list            │
   │     └─ now-time-info         ┘
   │
   ├─ parse.js 解析三种异构响应 → brain.js 组装成统一快照
   │     { wallet, claimable, points, campaigns, orders,
   │       serverTime, nextTerm, updatedAt }
   │
   └─ buildBriefing() 按优先级挑选最值得说的一件事
         → IPC 推送到渲染层 → 气泡显示 + 表情切换 + 情绪动作
```

选择并发而非串行，是因为 6 个工具之间没有数据依赖，并发能把首屏等待从「6 次往返之和」压缩到「最慢的一次」。

### 4.2 播报优先级

`buildBriefing()` 不是简单罗列数字，而是按「用户不看到就会吃亏」的程度排序，取最靠前的一条：

| 优先级 | 条件 | 播报示例 |
| --- | --- | --- |
| 1 | 有券**今日到期** | 「×××」今天就要到期了，趁着还没过期去用掉呀！ |
| 2 | 麦麦省有可领新券 | 麦麦省有 7 张券可以领，要我帮你一键全领了吗？ |
| 3 | 本月有积分将过期 | 有 N 麦享会积分这个月就要过期了，去麦麦商城换点东西吧～ |
| 4 | 今日有新活动 | 今天有活动上线：×××，记得看一眼～ |
| 5 | 有即将开始的活动 | 接下来有 N 个活动要开始啦，最近的是「×××」 |
| 6 | 持有券总数 | 你手上有 N 张券，别放过期啦 |
| 7 | 超过 14 天未消费 | 已经 N 天没吃过麦当劳了，有点想你哦～ |

这一层是「麦娘」相对于纯工具调用的核心增量：把 MCP 的原始数据翻译成**有时序紧迫感的人话**。

### 4.3 主动领取优惠券

```
用户点「一键领取麦麦省券」
   │
   ├─ 前置校验：Token 是否已配置（未配置则引导打开设置窗）
   ├─ tools/call → auto-bind-coupons
   ├─ 解析 Markdown 结果中的「总计 / 成功 / 失败」与券名列表
   └─ 领取成功后立刻 refresh() 重拉快照，保证气泡里的数字是最新的
```

### 4.4 容错设计

| 异常 | 处理方式 |
| --- | --- |
| 未配置 Token | 不发起请求，麦娘提示「先去 open.mcd.cn 申请」，并自动打开设置窗 |
| HTTP 401 | 提示「MCP Token 无效、已过期或未提供」 |
| HTTP 429 | 提示「触发限流，每分钟最多 600 次请求」 |
| 请求超时（20s） | 中止请求并提示稍后再试 |
| 业务返回 `success:false` | 读取其中的 `message`（如门店查询缺城市）并转成口语提示，不抛错 |
| 单个工具报错 | 记入 `tool-error` 事件日志，快照中该字段降级为空，其余功能不受影响 |
| 响应格式变化 | 解析层容错：Markdown 与 JSON 两种形态都尝试，失配则降级为空集合 |
| 抽奖请求过于频繁 | 服务端可能返回「操作太频繁」（**不扣积分**）；本地 8 秒冷却先挡一道，避免走到这一步 |
| 抽奖返回非 SUCCESS | 原样展示服务端 `message`，不做改写（官方协议要求） |
| 完全离线 | 麦娘仍可正常显示、拖拽、眨眼，只是不说话 |

## 5. 抽奖的合规设计（本项目最需要克制的部分）

`draw-lottery` 是全部 35 个 Tool 里**唯一会不可逆地消耗用户资产**的接口——每按一次，真实积分就少一次。官方在 Tool 描述里写了一段异常严格的约束，本项目逐条落实到代码与界面，而不是当作建议写在注释里。

### 5.1 官方约束与对应实现

| 官方原文要求 | 本项目的落实 |
| --- | --- |
| 「调用 draw-lottery 前必须展示 drawDecision.nextConsumption 并得到用户明确确认」 | 界面上有一条醒目的黄色警示条，**原样呈现** `nextConsumption.text`（如「本次将消耗 24 积分」）；确认按钮是独立动作，文案直接写明代价：**「确认消耗 24 积分抽一次」** |
| 「严禁根据 availableTimes 为 0/null 或 drawTypeText 自行推断能否抽奖」 | 能否抽完全取决于 `drawDecision.resourceEligible`，不使用本地余额或次数做任何推算 |
| 「resourceEligible 为 false 时不得调用」 | 抽奖前**重新调用一次** `query-lottery-info` 复核；界面停留过久导致积分被别处扣掉时会被拦下 |
| 「严禁试抽、自动抽或连续抽」 | 代码中不存在任何自动触发路径：没有定时抽、没有失败重试抽、没有连抽按钮。抽后进入 8 秒冷却 |
| 「status.code 非 SUCCESS 时 message 为具体失败原因，直接展示给用户，不要自行改写」 | 失败时 `brain.drawLottery()` 把服务端 `message` 原样透传，界面直接渲染，不加前缀、不做措辞包装 |

### 5.2 三重闸门

```
用户点击「确认消耗 24 积分抽一次」
   │
   ├─ 闸门 1：confirm 必须是严格布尔 true
   │     没有确认 → 「要你明确点头我才敢按下去」
   │
   ├─ 闸门 2：8 秒冷却
   │     冷却中 → 告知还需等待几秒。
   │     注意：**失败也计入冷却** —— 否则失败重试会变成对服务端的连打，
   │     而服务端限流虽不扣积分，反复失败对用户是纯粹的时间损失。
   │
   ├─ 闸门 3：抽前复核 resourceEligible
   │     不可抽 → 拒绝，并用服务端文案说明原因
   │
   └─ tools/call → draw-lottery
         ├─ 非 SUCCESS → 原样展示服务端 message
         ├─ win=false  → 如实告知「这次没中奖，积分已经按规则花掉了」
         └─ win=true   → 播放开蛋动画并展示真实奖品
```

### 5.3 一个设计取舍

**我们主动放弃了「连抽」这个提升爽感的设计。**

连抽能让扭蛋机的体验更接近游戏，但它同时意味着用户在极短时间内连续消耗积分，而官方协议明确禁止。在这个权衡里，用户资产安全优先于爽感——按钮上写的就是实际代价，每一次扣分都必须出自用户的独立决定。

这一节的实现位于 `src/mcp/brain.js` 的 `lotteryInfo()` / `drawLottery()`，以及 `src/renderer/panel.js` 的 `renderGacha()` / `doDraw()`。

## 6. 业务价值

麦当劳 MCP 提供的能力本身已覆盖「券、活动、积分、订单、门店、营养」六大域，但这些能力目前主要面向对话式客户端——用户需要**主动提问**才能获得信息。

「麦娘桌面」把这些能力**常驻在桌面上并主动推送**，解决三个具体问题：

1. **券会过期，但没人提醒**。`auto-bind-coupons` 把「打开小程序 → 翻页 → 逐张点击」压缩成一次点击；`query-my-coupons` 的「今日到期」标签被提升为最高优先级播报，直接把「沉睡的券」变成「今天的行动」。
2. **活动信息分散**。`campaign-calendar` 的结果被翻译成一句人话，用户不需要专门去查。
3. **积分躺在账户里贬值**。`query-my-account` 返回的过期积分被单独拎出来提示，指向麦麦商城的兑换动作。

换句话说，这个项目把 MCP 从「问答接口」变成了「常驻提醒服务」，而常驻提醒正需要一个有人格、会被看见的载体——这就是麦娘存在的理由。

## 7. 隐私与合规

- MCP Token 仅保存在本机用户目录（`app.getPath('userData')/config.json`）或环境变量中，不上传任何第三方服务器；
- 仓库中不包含任何真实 Token，`mcp-config.example.json` 只使用 `${MCD_MCP_TOKEN}` 环境变量占位符；
- 所有查询均基于用户自己的麦当劳会员账号，不涉及他人数据；
- 麦当劳 MCP 的调用结果仅用于本机展示，不做沉淀、不做二次分发；
- 文档与截图中出现的券名、活动名均为公开营销信息，不含订单号、账号或其他个人标识；
- 项目中的角色形象为原创生成素材，未使用麦当劳官方商标、logo 或任何官方视觉资产。

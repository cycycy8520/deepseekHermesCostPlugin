# dsh-hermes-cost-meter

**DeepSeek Harness 的花费统计插件。** 告诉你每个对话、每个项目、每个模型花了多少钱——按**每一笔请求自己发生的时刻**计价，因此高峰/低谷时段、缓存命中/未命中、模型切换都被如实区分，而不是拿一个平均价去乘总数。

> 装完之后：输入框下方多一颗 💰 药丸（本对话花费），左边栏多一个**花费统计**入口（进去是**账号花费**与**项目花费**两个页签，默认账号花费），设置里多一页「花费计价」（价表与历史回溯）。

---

## 安装

在 DeepSeek Harness 的 **设置 → 内置插件 → 添加插件** 里粘贴下面这一行，然后点安装：

```
https://github.com/cycycy8520/deepseekHermesCostPlugin
```

或者用命令行：

```sh
dsh plugin add https://github.com/cycycy8520/deepseekHermesCostPlugin
```

**其他安装方式**（GUI 同样支持）：

| 方式 | 粘贴什么 |
|---|---|
| GitHub 仓库 | `https://github.com/cycycy8520/deepseekHermesCostPlugin` |
| 本地目录 | 本机上插件目录的绝对路径（开发时用） |
| tarball | `pnpm pack` 产出的 `.tgz` 路径 |

> **本包尚未发布到 npm**，所以 `dsh plugin add dsh-hermes-cost-meter` 会失败——请用上面的 GitHub 地址。

**安装后重启一次 DeepSeek Harness。** 只有 host 半边需要重启（它注册 `/api/cost/*` 路由）；之后只改客户端半边，刷新页面即可。

**不需要配置价格。** 价目表出厂内置（DeepSeek 全系 + 小米 MiMo + token-plan，含 2026-09-10 调价前后两个时期），装上即开始计价。

---

## 预算与对账

**预算**可以设在**账号**上，也可以设在**单个项目**上（设置 → 花费计价 → 预算）。金额用显示货币，周期为 今日 / 本月 / 累计。设好之后，面板顶部会出现一条进度条：`预算 · 范围 · 已用/上限 · 百分比`，用到 80% 变黄、超支变红 —— 项目预算算的就是那个项目自己的对话，所以"**这个模块花了多少钱**"是这一行。

**对账**（设置 → 花费计价 → 对账口径）把本插件与官方账单可能对不上的地方写在页面上，先看它再怀疑数字：

- **计费口径**：未缓存输入 × 未缓存单价 + 输出 × 输出单价 +（缓存读取 + 缓存写入）× 缓存命中单价，逐笔按**该笔请求发生时刻**的价目计算；
- **推理/思维 token**：供应商单独上报，官方账单不计费，本插件也不计入金额；
- **币种基准**：¥ 直接用官方人民币价目；其他货币经汇率换算，与官方人民币账单有结构性差异 —— 对账前切成 ¥；
- **分钟级延迟**：账本写入有去抖（默认 4 秒），正在流式返回的请求尚未结算；
- **无价目 token**：显示有多少 token 没匹配到价目（补一条价目即可计入）；
- **当前覆盖**：对话数、账本行数、插件版本、状态文件路径。
## 你会得到什么

### 1. 输入框下方的 💰 药丸

显示**当前对话**的花费。点开看分桶明细：缓存读取／未缓存输入／缓存写入／输出 各花了多少，以及本项目所有对话的排行。

### 2. 左边栏 → 花费统计 → 页签「账号花费」

回答「**我一共花了多少**」。

| 区块 | 内容 |
|---|---|
| 六格数字卡 | 总花费、总 token、模型用时、工具用时、缓存读取 token、对话数 |
| 日历热力图 | 53 周 × 7 天，**Token／花费**双指标 × **每天／每周／累计**三档；悬停显示「日期 · token · 金额」 |
| 花费构成 | 按四个计费桶拆分金额与占比 |
| 项目排行 | 每个项目花了多少、占比多少，**点击可下钻** |
| 对话明细 | 全部对话按花费降序，可分页 |

顶部两个**全局过滤器**：范围（全部项目 / 某项目）、时间（全部 / 近 30 天 / 近 7 天）——作用于页面上所有内容。

### 3. 左边栏 → 花费统计 → 页签「项目花费」

回答「**钱花在哪了**」。按项目和对话拆开看：饼图看占比，明细表逐个对话列出 token、用时与金额，可分页、可切范围。

### 4. 设置 → 花费计价：价表（**已内置，通常不用动**）

**价表按「生效日期」键控**，因为模型名不等于价格。例如 `deepseek-v4-flash` 在 2026-09-10 之前是独立定价的 V4-Flash-0731，之后才变成 V4.1-Flash 的路由别名——没有日期就必然算错其中一个时期。

**出厂即带完整价目，装上就能算钱，你不需要填任何东西。** 已内置：

| 模型 | 缓存命中 | 未命中 | 缓存写入 | 输出 | 生效区间 |
|---|---|---|---|---|---|
| `deepseek-v4-pro` | 0.30 | 9.00 | 0 | 27.00 | 2026-08-16 起 |
| `deepseek-v4-flash` | 0.10 | 3.00 | 0 | 9.00 | 2026-08-16 → 2026-09-10 |
| `deepseek-v4-flash` | 0.04 | 2.00 | 0 | 8.00 | 2026-09-10 起 |
| `deepseek-flash` | 0.04 | 2.00 | 0 | 8.00 | 2026-09-10 起 |
| `xiaomi/mimo-v2.5-pro` | 0.025 | 3.00 | 0 | 6.00 | 不限 |
| `xiaomi/mimo-v2.5` | 0.02 | 1.00 | 0 | 2.00 | 不限 |
| `xiaomi-token-plan-cn/*` | 2.5 | 300 | 0 | 600 | 不限（单位 Credits） |

单位为 **元 / 百万 token**（上表为高峰价）。

这一页仍然可编辑，但**只有在官方调价时才需要来**：可增删行、改单价、改币种、设定低谷折扣。2026 年节假日日历也已内置（33 天）。

> 没有配价表的模型不会被静默算成 0：它会记进该会话的**未定价**计数，日志里也会打印模型名。

### 5. 设置 → 花费计价 →「计算未评估信息」

读取会话日志，把**历史**里每一笔请求按它自己发生的时间重新计价，并写入账本。

**这是补齐历史的唯一方式**：实时累加只知道"现在"，只有日志知道"当时"。

---

## 计价规则

| 项目 | 取值 |
|---|---|
| 高峰时段 | 周一至周五 北京时间 09:00–12:00、14:00–18:00（**排除中国法定节假日**） |
| 低谷时段 | 其余全部时间（含完整周末、完整节假日），**五折** |
| 缓存写入 | DeepSeek 不收费 → 计 0 |
| 订阅套餐 | 如小米 Token Plan，按 **Credits** 统计，**不计金额** |

节假日表默认内置 2026 年国务院安排。

---

## 数据从哪来

插件**不重新计算 token**，而是直接使用框架已经上报的权威值：

| 数字 | 来源 |
|---|---|
| 四个计费桶 | `tokenUsage` 投影（提供方上报，精确累计） |
| 模型 | `modelSelection` 投影 |
| 用时／TTFT／TPS | `sessionStats` 投影 |
| 项目归属 | 工作区注册表的 `sessionIds` |
| 按天分布 | 回溯时按每笔请求自己的时间戳落桶 |

**账本与价表存在插件自己的文件里**：`$DSH_HOME/dsh-hermes-cost-meter/state.json`（默认 `~/.dsh/dsh-hermes-cost-meter/state.json`），不随插件分发。换一台机器安装，花费从零开始记；把这个文件拷过去即可带走历史。

---

## 兼容性

```json
"engines": { "dsh": ">=0.1.0-0", "node": ">=22" }
```

**`-0` 不是笔误。** semver 的 `>=0.1.0` **不匹配预发布版本**（如 `0.1.6-alpha.2`），除非区间自身带预发布标识。`>=0.1.0-0` 才是"0.1.0 及以后、含预发布"的正确写法。当前版本没有校验 `engines`，但将来若开始校验，写错的区间会**直接挡住安装**。

**验证过的版本：`0.2.0-rc.2`。**

**为什么必须 0.2 以上**：0.2 把 `ctx.settings` 换成了 `SettingsForms`（只剩 `describe/update/configure/documentPath/writable`），**`ctx.settings.register(ns, schema)` 不再存在**。本插件原先把账本与价表存在那个命名空间里，在 0.2 上会抛错并被自身的 `try/catch` 吞掉 —— 表现就是「客户端半边照常加载、侧栏有条目，但页面取不到数据」。现已改为**插件自有的存储**：`$DSH_HOME/dsh-hermes-cost-meter/state.json`，并通过 `ctx.inject(['connection'])` 注册 `/api/cost/state`、`/api/cost/config`、`/api/cost/backfill` 路由供客户端读取。

**0.1.x 未验证**：早期版本里有 `settings.register`，但本插件现在依赖的连接路由载体（`connection.fetch.register` / `sessionQuery.readSession`）是否可用没有测过。要在 0.1.x 上用，先确认这两点。

---

## 已知限制

- **热力图的历史长度＝日志的长度。** 网格固定画满 53 周（日历形状必须在），但只有日志覆盖到的日期可能有颜色。
- **已花费的历史需要跑一次回溯。** 刚装完账本只有"从安装起"的累计；点一次「计算未评估信息」才把日志里的历史补进来。
- **`sessionStats` 缺失的旧会话，用时显示 `—`**，不会用 0 冒充。
- **价目表是写死的出厂值。** 它覆盖到 2026-09-10 的官方调价，但官方再调价时插件本身不会知道——改价请到设置 → 花费计价（不用改代码）。
- **仅支持 Web 形态。** 界面全是 DOM；headless / ACP / SDK profile 下装了也没有意义。
- **一个对话中途换过模型时**，该对话的整段花费按最后使用的模型归入「按模型」统计。

---

# 故障排查

> **如果插件不工作：把这一整节复制给你的 AI，连同你看到的现象。** 下面的症状表、契约清单和诊断命令足够它定位问题。

## 第一步：确认它装上了

```sh
# 1. profile 里有没有这个包
cat ~/.dsh/profiles/web/package.json
#    期望：dependencies 里有 "dsh-hermes-cost-meter"，dsh.profile.bundles 数组里有 "dsh-hermes-cost-meter"

# 2. 目录在不在
ls ~/.dsh/profiles/web/node_modules/dsh-hermes-cost-meter
#    期望：能看到 index.js / client.js / cordis.patch.yml
```

两个都在 → 装是装上了，问题在加载或运行。

## 症状 → 原因 → 处置

| 症状 | 最可能的原因 | 处置 |
|---|---|---|
| 左边栏没有 💰 图标 | 客户端 bundle 没被浏览器加载（模块 id 与包名不符，或页面用了缓存的旧 bundle） | **硬刷新**（Ctrl+Shift+R）。仍无 → 检查 `client.js` 里 `__ModuleLoader__.load({ id })` 是否**等于包名** |
| 设置里没有「花费计价」/「花费分布」 | 同上 | 同上 |
| 输入框下面没有 💰 药丸 | 该对话尚未产生 token（正常）；**或 host 半边没加载**——此时药丸会变成一个橙色的「未就绪」按钮，鼠标悬停写着原因 | 前者先发一条消息；后者**重启 DeepSeek Harness** |
| 左边栏有「花费统计」，但点进去只有一段橙色说明 | host 半边没加载——客户端读不到 `/api/cost/state` 路由 | 面板上的橙色说明会直接写出来（含 HTTP 状态）。**重启 DeepSeek Harness**，只刷新页面不够 |
| 点「开始计算」报 **HTTP 404** | host 路由 `/api/cost/backfill` 未注册——**host 半边需要重启** | 重启 DeepSeek Harness |
| 顶部显示 **「回溯服务未就绪」** | 同上（那是启动时的路由探测结果） | 重启 DeepSeek Harness |
| 热力图只有一个格子 / 「有数据 1 天」 | 账本还没有按天数据（新装的正常现象） | 跑一次「计算未评估信息」 |
| 用时显示 `—` | 该会话没有 `sessionStats` 投影（多为旧会话） | 正常行为，不是 bug |
| 金额全是 ¥0.00 | 该模型不在价表里 | 一般**不用管**：内置价目已覆盖 DeepSeek 全系与小米 MiMo。确实用了别的模型 → 设置 → 花费计价，加一行即可；日志里也会打印未归因的模型名 |
| 设置里价表是空的 | 已被手工删空 | 删成空数组时**内置默认会自动补回**（`models: []` 也走同一个兜底），刷新页面即可 |
| **整个界面空白 / 打不开** | **模块加载期抛错**。最常见：`client.js` 顶层 `const` 引用了**在它后面才声明**的 `const`（TDZ） | 见下方「界面整个空白」 |
| 安装时被拒：`declares no bundle` | `package.json` 缺 `dsh.bundle.patch`，或它指向的文件不存在 | 补上，或用 `node tools/check-package.mjs` 检查 |
| 卸载后界面还显示插件 | 浏览器缓存了旧 bundle | 硬刷新 |

### 界面整个空白 —— 怎么查

这是最严重的一种，但它**能精确定位**：错误发生在模块求值阶段，不是某个组件。

```sh
cd <插件目录>
node --check client.js                      # 只查语法，抓不到这类错误
node tools/check-identifiers.mjs client.js index.js   # 查"用了但没绑定"的名字
node tools/smoke-load.mjs client.js         # ← 这一个能抓到
```

`smoke-load.mjs` 会用桩 loader **真实执行整个模块**并调用一次 `apply(ctx)`。它只证明两件事：模块能初始化、插槽能注册。不渲染、不证明外观——但这正是能把界面搞瘫的那一类。

看到 `ReferenceError: Cannot access 'X' before initialization` → **把那个 `const X = ...` 移到引用它的那行之前**。JavaScript 的 `const`/`let` 有暂时性死区，`node --check` 和"是否绑定过"类检查都看不见它。

## 这个插件依赖的框架契约

如果某个功能在你的 DSH 版本上不可用，多半是下面某一项变了。这些都可以用 `cordis_inspect_query` 自查。

**客户端投影**（读 `projectionValues`）：

| 键 | 用到的字段 |
|---|---|
| `tokenUsage` | `uncachedInputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens` |
| `modelSelection` | `lastUsed.provider`、`lastUsed.model` |
| `sessionStats` | `llmMs`、`toolMs`、`ttftMs`、`ttftSteps`、`decodeMs`、`decodeTokens` |

**插槽**：

| 插槽 | 注册选项 | 用途 |
|---|---|---|
| `conversation.composer.dock` | `{ id }` | 💰 药丸 |
| `settings.section` | `{ id, order, label }` | 价表页、分布页 |
| `sidebar.panellist` | `{ id, order, label }` | 侧边栏图标 |
| `main` | `{ key }` | 整页仪表盘 |

**host 服务**：`settings`（价表命名空间与账本）、`connection.fetch.register`（回溯路由）、`sessionQuery.readSession`（读日志）。

**浏览器模块表基线**：`react`、`react-dom`（由宿主提供，插件不打包它们）。

**客户端模块协议**：`window.__ModuleLoader__.load({ id, factory })`，且 **`id` 必须等于包名**。

## 改代码

插件是**纯 JavaScript，零依赖，无构建步骤**。`index.js` 与 `client.js` 就是运行时产物，直接编辑即可。

```sh
# 改完必跑这四道，全绿再重载
node tools/check-package.mjs                          # 分发就绪
node --check index.js && node --check client.js        # 语法
node tools/check-identifiers.mjs client.js index.js    # 引用完整性
node tools/smoke-load.mjs client.js                    # 能加载 ← 保命的
```

**重载方式**：客户端改动 → 硬刷新页面即可；**host 改动（`index.js`）必须重启 DeepSeek Harness**。


---

## 卸载

设置 → 内置插件 → 找到 `dsh-hermes-cost-meter` → 卸载。账本与价表配置会留在 `$DSH_HOME/dsh-hermes-cost-meter/state.json`（默认 `~/.dsh/dsh-hermes-cost-meter/state.json`），需要清理时删掉该文件（或整个目录）即可。

---

## 开发

仓库内的 `tools/` 是开发工具（不是运行时依赖）：

| 文件 | 用途 |
|---|---|
| `tools/check-package.mjs` | **发布体检**：manifest 字段、patch 是否解析且指向本包、client 模块 id 是否等于包名、`private` 是否已移除 |
| `tools/smoke-load.mjs` | **加载级冒烟测试**：用桩 loader 真实执行模块并调用 `apply`，专抓"模块级 const 引用后又声明的 const"这类 TDZ 错误 |
| `tools/render-states.mjs` | **真渲染测试**：用真 React 把 6 个插槽组件在「host 未加载」和「正常」两种状态下服务端渲染，断言坏状态必须**说出原因**而不是静默 |
| `tools/check-identifiers.mjs` | 作用域审计：列出"使用了但从未绑定"的名字 |
| `tools/check-locales.mjs` | 中英键位对齐：少一个键用户就会看到原始 key 名 |
| `tools/check-defaults.mjs` | **内置价表自足性**：断言空配置能解析出完整价表、空/脏配置会回落到内置值、低谷折扣与节假日日历都在 |
| `tools/dump-models.mjs` | 打印生效价表（`--defaults` = 出厂内置，不带参数 = 本机存储），两边形状一致，可直接 diff |
| `tools/scan-sessions.mjs` | 离线扫描会话日志，统计模型用量（回溯引擎的原型） |
| `tools/pricing.mjs` | 带生效日期的价表与逐笔计价 |

**发布前必跑**（八项，全绿才发）：

```sh
node tools/check-package.mjs
node --check index.js
node --check client.js
node tools/check-identifiers.mjs client.js index.js
node tools/check-locales.mjs client.js
node tools/smoke-load.mjs client.js
node tools/render-states.mjs client.js      # 需要能解析到 react，见下
node tools/check-defaults.mjs index.js
```

`render-states.mjs` 用**真 React** 渲染，所以需要能解析到 `react` / `react-dom`：会从工作目录向上找 `node_modules/react`，也可以用环境变量指定：

```powershell
$env:DSH_REACT_DIR = "<DSH 检出目录>\node_modules"
node tools/render-states.mjs client.js
```

找不到 React 时它会打印 `SKIPPED` 并以 0 退出——这样别人克隆下来不会因为缺依赖而卡住，但**发版前应当确保它是真跑了**，不是被跳过。

想确认「本机存的价表 == 出厂默认」，直接 diff：

```powershell
node tools/dump-models.mjs --defaults > $env:TEMP\a; node tools/dump-models.mjs > $env:TEMP\b; Compare-Object (cat $env:TEMP\a) (cat $env:TEMP\b)
```

`package.json` 的 `files` 字段确保只有运行必需的四个文件进入发布包：`index.js`、`client.js`、`cordis.patch.yml`、`README.md`。运行时**零依赖**——`index.js` 没有任何 import，`client.js` 只用浏览器基线里的 `react` / `react-dom`。

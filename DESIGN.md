# DSH 花费计量插件 — 设计底稿

> 状态：**M1–M7 已实现并验证**；统计仪表盘设计已定稿、待开发
> 目标 profile：`~/.dsh/profiles/web`
> 插件目录：本仓库根目录
>
> **相关文档**：[DASHBOARD.md](./DASHBOARD.md) —— 整页统计仪表盘的开发文档（版面、展示规则、数据缺口、分期）

---

## 1. 目标

在 DSH Web 界面上显示**准确的**人民币花费：

1. **每个对话的花费** —— 精确到分
2. **每个项目（工作区）下所有对话的花费合计** —— 包括没打开过的对话
3. **价表与时段可配置** —— 因为模型价格会变

### 明确不做

- ❌ 不追溯装插件之前的历史花费（用户明确要求：从装插件之后才开始算）
- ❌ 不估算、不给区间、不给"约等于"标记
- ❌ 不读会话日志
- ❌ 不遮蔽任何出厂 UI

---

## 2. 核心设计决策

这一节记录**为什么是现在这个方案**，以及被否决的备选方案。开发时不要重新走一遍这些弯路。

### 2.1 ✅ 采用：差值累加计费

**规则**（每个对话独立维护）：

```
第一次见到该对话：
    baseline = 当前 token 总数
    cost     = 0                        # 历史不计费

之后每次 token 数更新：
    delta     = 当前 token 总数 − baseline
    cost     += delta × 当前时段单价
    baseline  = 当前 token 总数
```

**为什么这是准确的**：那个 token 计数器是**累计值**，每次刷新时我们能读到增量；而增量**发生的那一刻**是高峰还是低谷，我们看表就知道——不需要在数据里存时间戳。

**副作用（好的）**：同一个对话中途换模型会自动正确，因为每笔增量按**那一刻的模型**计价。子 agent 用别的模型同样覆盖。

### 2.2 ❌ 否决：把花费加进出厂的「Token 用量」弹窗

那个弹窗（`StatsPills.tsx` 里的 `UsagePill`）内容是一段写死的 `<dl>`，通过 `createPortal` 挂到 `document.body`，**内部没有任何插槽**。技术上只能靠遮蔽整个 `main.conversation`（`replaceRisk: shadows-shipped-ui`），框架一升级就碎。**不做。**

→ 改为在同插槽里加一颗**并列的药丸**。

### 2.3 ❌ 否决：读完整会话日志做精确回溯

`ctx.sessionQuery.readSession(id)` 确实能读出完整可重放日志（每条事件带 `time` 毫秒时间戳），理论上能对每一笔请求按它自己发生的时间计价。**但用户否决**：太重，没必要——从装插件之后开始算就够了。

### 2.4 ❌ 否决：显示区间（高峰价 / 低谷价两个数）

用户明确要求"就要准确的扣除"。差值累加已经能给出单一准确值，不需要区间。

### 2.5 ❌ 否决：未知模型回落到 flash 价

**这是在编数字**，与"准确"直接冲突。改为：留空 + 提示 + 引导配置。

### 2.6 ✅ 采用：客户端算钱，host 只做存储

客户端已经能读到全部所需数据；host 半边**只**负责持久化（配置 + 账本），不加一行计费逻辑。

**为什么必须要有 host 半边**：客户端写不了文件（`workspaceFiles` 只有 `read`/`stat`/`list`/`changes`，没有 write），而 `localStorage` 清浏览器缓存就没了。配置页也需要 host 托管设置命名空间。

---

## 3. 数据来源（已实测确认）

### 3.1 三个数据源

| 数据 | 来源 | 性质 |
|---|---|---|
| 四个计费桶 | `tokenUsage` 投影 | 提供方上报的**精确累计值** |
| 用的哪个模型 | `model/selection` 投影 | `{ lastUsed, next }` |
| 项目 → 对话 | `WorkspaceView.sessionIds` | 权威归属关系 |

### 3.2 关键发现：冷对话也有数据

会话列表**每一行**都带 `projectionValues`，来自持久化投影缓存，**零 I/O、不读日志**：

```ts
// packages/api/session-controller/src/sessions/service.ts
export interface SessionSummary {
  id: SessionId
  displayTitle: string
  running: boolean
  blank: boolean
  updatedAt: number
  /** Current host-computed projection values retained by the object layer. */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}
```

宿主侧由 `projectionsFor()` 填充，返回**每一个当前已缓存的 wire 值**：

```ts
// packages/api/session-controller/src/list.ts:268
values: block.values as SessionProjectionValues
```

**这就是"没打开过的对话也能算钱"的全部依据。**

### 3.3 四个计费桶互不重叠

```ts
// packages/llm/token-meter/src/projection.ts:13
export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
```

缓存命中与未命中的单价差 50 倍，框架已经帮我们分好了——这是最容易被算错的地方。

---

## 4. 架构

```
┌─ 客户端半边（client.js）────────────────────────────┐
│  算钱 + 显示                                        │
│  ├─ 观察会话列表里所有对话的 tokenUsage              │
│  ├─ 算增量 × 当前时段单价 → 累加                     │
│  ├─ 💰 药丸挂在 conversation.composer.dock           │
│  └─ 点开：本对话明细 + 本项目每个对话 + 合计          │
└─────────────────────────────────────────────────────┘
                    ↕ 读写
┌─ host 半边（index.js）──────────────────────────────┐
│  只做存储，不算钱                                    │
│  ├─ 配置：价表 / 折扣 / 时段 / 节假日                 │
│  │        → ctx.settings.register('dsh-cost', ...)   │
│  └─ 账本：每会话 { baselineTokens, cost }            │
│           → ctx.storageDomain.open(spec)             │
└─────────────────────────────────────────────────────┘
```

### 4.1 为什么这就是正确的层级

| 层级 | 管什么 | 本插件 |
|---|---|---|
| HOST 组合 | 跨会话共享的注册表与服务 | ❌ 不发布供他人读取的服务，**不该**进 |
| AGENT PRESET | 单个会话贡献什么 | ❌ 不是会话级 |
| **profile bundle** | 叠加在 profile 上的一层 | ✅ **就是这个** |

装一次 → `web` profile 下所有对话都有；卸载 → 干净消失。

---

## 5. 存储设计

### 5.1 配置文件（价表等）

- 位置：由宿主 `settings` 服务托管，落在 `~/.dsh/settings.yaml`
- 命名空间：`dsh-cost`
- 好处：跨浏览器、跨重启、可手工编辑、顺带得到设置页

### 5.2 账本文件

- 位置：`~/.dsh/storages/` 下（与 `session_projcache` 同级）
- 用框架的 storage 服务（JSON 后端），不自己造轮子
- 一条会话一行：

```json
{
  "version": 1,
  "sessions": {
    "<sessionId>": {
      "baseline": { "cacheMiss": 100349, "cacheRead": 2394624, "cacheWrite": 0, "output": 38942 },
      "cost": 0.4213,
      "model": "deepseek-flash",
      "updatedAt": 1770000000000
    }
  }
}
```

**体积**：一个会话约 200 字节，几百个会话也就几十 KB。

---

## 6. 多模型与价表

### 6.1 各家计费的桶不一样

| | 缓存命中 | 未缓存输入 | 缓存写入 | 输出 | 分时折扣 |
|---|---|---|---|---|---|
| DeepSeek | 有 | 有 | **不收费** | 有 | 有（峰谷五折） |
| Anthropic | 有 | 有 | **要收费** | 有 | 无 |
| OpenAI | 有 | 有 | 不单独收 | 有 | 无 |

所以价表**不是三个数**，而是每个模型自带计费方式。

### 6.2 配置结构

```yaml
models:
  - match: deepseek-flash          # 也接受 "provider/model" 精确写法
    currency: CNY
    rates: { cacheHit: 0.04, cacheMiss: 2.0, cacheWrite: 0, output: 8.0 }
    discount:                      # 可选；不写 = 全天一口价
      offPeakRatio: 0.5
      peakHours: [[9, 12], [14, 18]]   # 北京时间
      weekdaysOnly: true
      holidays: [...]                  # 默认内置 2026 国务院安排

  - match: anthropic/claude-x
    currency: USD
    rates: { cacheHit: 0.3, cacheMiss: 3.0, cacheWrite: 3.75, output: 15.0 }
    # 无 discount 段 → 全天同价
```

`discount` 段**每个模型独立且可选**，所以只有 DeepSeek 有峰谷。

### 6.3 未知模型：不猜

- token 数照常显示（那是精确的）
- 金额**留空**，显示「未配置价格」
- 💰 药丸上出现提示点
- 项目合计里单列：`3 个对话已计价 ¥12.40 · 1 个未配置`

> **原则：一个偷偷算错的数字，比一个明显的空缺危险得多。**

### 6.4 ✅ 修订：出厂即带完整价表（推翻早期决定）

**早期决定**：只内置本部署用到的 DeepSeek 两项，其余留给用户填。

**为什么推翻**：它把配置成本推给了每一个用户，而正确性收益是零——因为**生效日期已经解决了"过期价"这个唯一真实的担忧**。价表按 `from`/`to` 键控，一份包含多个时期的表不会"过期"，它只是同一模型在不同时间段的正确价格。真正会静默产生错数的是**缺行**（回落成 0），而不是行多。

**现行决定**：内置本部署实际在用的全部价目，新装用户**不需要填任何东西**即可开始计价：

| 模型 | 缓存命中 | 未命中 | 缓存写入 | 输出 | 生效区间 |
|---|---|---|---|---|---|
| `deepseek-v4-pro` | 0.30 | 9.00 | 0 | 27.00 | 2026-08-16 起 |
| `deepseek-v4-flash` | 0.10 | 3.00 | 0 | 9.00 | 2026-08-16 → 2026-09-10 |
| `deepseek-v4-flash` | 0.04 | 2.00 | 0 | 8.00 | 2026-09-10 起 |
| `deepseek-flash` | 0.04 | 2.00 | 0 | 8.00 | 2026-09-10 起 |
| `xiaomi/mimo-v2.5-pro` | 0.025 | 3.00 | 0 | 6.00 | 不限 |
| `xiaomi/mimo-v2.5` | 0.02 | 1.00 | 0 | 2.00 | 不限 |
| `xiaomi-token-plan-cn/*` | 2.5 | 300 | 0 | 600 | 不限（Credits） |

单位 元 / 百万 token，上表为高峰价；DeepSeek 三行走低谷 ×0.5。2026 节假日日历（33 天）一并内置。

**这条决定靠什么保证不腐化**：`tools/check-defaults.mjs` 断言"空配置必须解析出上表 7 行 + 完整折扣 + 节假日"。价目漂移会让预检变红，而不是悄悄上线。

#### 6.4.1 兜底必须走和用户行同一道规范化

`schema()` 的兜底曾经直接返回 `DEFAULTS.models` **原样**，而用户自己填的行会经 `normalizeModel` 规范化。两条路径形状不同：内置行少写一个 `cacheWrite` 就会是 `undefined` → `NaN`，而存储行会被补成 0。

现在兜底改为 `defaultModels()`——对 `DEFAULT_MODELS` 跑同一个 `normalizeModel`，只算一次并缓存。

**明确不加 `Object.freeze`**：`settings.update` 走 `mergeLayers` 深合并，冻结数组一旦被就地写入就会在**账本落盘**路径上抛错。防一个假想的误改，换掉一条关键写入路径，不划算。

---

## 7. UI 设计

### 7.1 展示位置

`conversation.composer.dock` —— Composer 卡片下方那一行。**已确认该插槽：**

- kind: `list`，scope: `session`
- `replaceRisk: none` ← 可以安全挂载，不遮蔽出厂 UI
- 当前占用者只有 `{ registrant: "lc", id: "stats", order: 0 }`

**约束**：那一整行（`4 轮 41 步 · 238 tok/s` + `4M tok · 缓存命中 97%` + `18%` 圈）是**一个**注册条目 `stats`，内部没有插槽。所以本插件插不到中间，只能作为**该行的第二个条目**排在末尾：

```
  ⟳ 4 轮 41 步 · 238 tok/s   🗄 4M tok · 缓存命中 97%   ◐ 18%   ¥2.41
                                                                    ↑ 本插件
```

### 7.2 弹窗

**只显示花了多少**，不显示"省了多少"、不做任何装饰性着色（用户明确要求）。

```
┌──────────────────────────────────────────────┐
│ 💰 花费估算                          ¥43.86    │
├──────────────────────────────────────────────┤
│ 本对话 · deepseek-flash                       │
│   缓存读取     875,438,848 tok       ¥35.02   │
│   未缓存输入     1,850,141 tok        ¥3.70   │
│   输出             643,245 tok        ¥5.15   │
├──────────────────────────────────────────────┤
│ 本项目 GW · 3 个对话            合计 ¥58.26   │
│   ▸ DeepSeek 用量界面插件费…         ¥43.86   │
│     DeepSeek 余额查询 API 方法       ¥12.30   │
│     个人网站制作能力咨询              ¥2.10   │
├──────────────────────────────────────────────┤
│ 当前低谷时段（半价）· 按实测 token 计算         │
└──────────────────────────────────────────────┘
```

### 7.3 设置页

用 `settings.section` 插槽，在「设置」里多一页 **花费计价**：

```
设置 → 花费计价

  ⚠ 检测到 2 个模型未配置价格
  ┌────────────────┬──────────┬────────┬────────┬────────┬──────┐
  │ 模型            │ 缓存命中 │ 未缓存 │ 缓存写入│ 输出   │ 币种 │
  ├────────────────┼──────────┼────────┼────────┼────────┼──────┤
  │ deepseek-flash  │  0.04    │  2.0   │   0    │   8.0  │ CNY  │  ✓
  │ deepseek-v4-pro │  0.30    │  9.0   │   0    │  27.0  │ CNY  │  ✓
  │ openai/gpt-5    │  [    ]  │ [    ] │ [    ] │ [    ] │ [  ] │  ⚠
  └────────────────┴──────────┴────────┴────────┴────────┴──────┘
  [ + 手动添加模型 ]

  低谷折扣  [ 0.5 ]      高峰时段（北京时间） [ 09:00-12:00, 14:00-18:00 ]
  仅工作日  [x]          节假日 [ 内置 2026 国务院安排 ] [ 编辑 ]
```

**那两行是插件自己发现的**——扫所有会话的 `model/selection`，把用户**实际用过**的模型全列出来。用户只要填空，不用猜模型 id 怎么写。

---

## 8. 插件规范符合性

| 规则 | 落地 |
|---|---|
| 包声明 `dsh.bundle.patch` | `package.json` |
| patch 用唯一 id/name 插入行 | `id: cost-meter` |
| host 用命名 `apply`（不混用 default class 形式） | `export function apply()` |
| 客户端 `window.__ModuleLoader__.load`，id = 包名 | `client.js` |
| factory 无副作用 | factory 内只定义，不执行 |
| 只用声明过的插槽，不读别人 DOM/CSS | 只用 `conversation.composer.dock`、`settings.section` |
| 自己的唯一 id，不复用出厂的 `stats` | `id: 'cost'` |
| 资源在 `apply` 里用 `ctx.effect` 注册并给清理函数 | locale 字典 |
| 可见文案走客户端 locale 服务 | 注册 `zh` / `en` 两套 |
| 不替换 app 根、不追加第二个应用 | 只挂 portal 弹窗 |
| 不遮蔽出厂 UI | 选 `replaceRisk: none` 的插槽 |
| 用 `plugin_manager` 安装，不用 shell | 安装步骤 |

### 待开发时验证的两点

1. **`react-dom` 是否在浏览器模块表里**（弹窗要用 `createPortal`）。出厂代码 `import { createPortal } from 'react-dom'`，基本可以肯定有；万一没有，改用 `dsh.client.external` 声明，或不做 portal。
2. **设置页那部分**（`settings.section` 插槽 + host 设置命名空间）是所有环节里最新的一块，装的时候确认一次。

### 抗升级性

万一 DSH 改了投影 key 或插槽名，插件只会「药丸不显示」，**不会把界面搞崩**。

---

## 9. 已知限制（不精确之处）

诚实记录，开发时不要假装不存在：

1. **浏览器关闭期间的增量** —— 后台跑的对话，那段时间的增量会在下次打开时被**一次性按"打开那一刻"的价**计价。总数正确，只有时段归属可能偏。设置页脚注说明。
2. **峰谷边界上的单笔请求** —— 若某个请求正好跨过边界，会按观察到的那一刻计价。一天只有 4 次边界，影响极小。
3. **会话中途换模型的那一次增量** —— 可能归属到新模型。
4. **节假日表的年份** —— 内置 2026 年。跨年后需更新，否则节假日会被当作高峰。
5. **价表需要人工维护** —— DeepSeek 改价后必须同步，否则数字会错。这是本设计的最大外部依赖。

### 未来可选的校准手段

DeepSeek 有余额接口 `GET /user/balance`（返回 `total_balance` / `granted_balance` / `topped_up_balance`，币种 CNY/USD）。可以用它做**对账**：比对"插件算出来的累计"与"账户实际下降"，从而自动发现价表过期。**本次不实现**，列为后续增强。

---

## 10. 开发计划

| 阶段 | 内容 | 产出 |
|---|---|---|
| **M1** | host 半边：settings 命名空间 + 账本存储 | `index.js` |
| **M2** | 客户端：差值累加引擎 + 观察会话列表 | `client.js` 逻辑层 |
| **M3** | 客户端：💰 药丸 + 弹窗 | `client.js` UI 层 |
| **M4** | 安装并验证药丸出现在页面上 | 可运行 |
| **M5** | 设置页：价表 / 时段 / 节假日配置 | 完整 |
| **M6** | 未配置模型的检测与引导 | 完整 |

**M1–M4 是可用的最小闭环**，先跑通再加 M5/M6。

---

## 11. 发布路径

代码是**纯 JS、零依赖、无构建步骤**，所以：

| 层级 | 做法 | 成本 |
|---|---|---|
| ① 拷贝文件夹 | 整个 `dsh-cost-meter/` 拷到另一台机器，`install_bundle <路径>` | 零 |
| ② 发 npm 包 | 改 scope/version/license/repository，`npm publish` | 只改元数据 |
| ③ 并入 DSH 官方仓库 | 移植成 TypeScript + 补测试与 README | 大 |

**可移植性**：读的 `tokenUsage`、`model/selection` 投影和两个插槽**全是框架通用 API，不含 DeepSeek 特有逻辑**。DeepSeek 特有的只有**默认价表**和**峰谷时段**，换个部署改配置即可。

---

## 12. 实现状态

### 已验证可用

| 环节 | 证据 |
|---|---|
| 安装 | `plugin_manager` 返回 `application: applied` |
| 客户端挂载 | `conversation.composer.dock` 占用者出现 `{ id: "cost", order: 1 }`，与出厂 `stats` 并列 |
| host 持久化 | `~/.dsh/settings.yaml` 出现 `dsh-cost` 段，63 个会话基线；其中一场的数字与原「Token 用量」面板分毫不差 |
| 模型归因 | 弹窗显示 `本对话 · deepseek-flash` |
| 分桶计价 | 493,184 × ¥0.04/2 ＋ 3,913 × ¥2.0/2 ＋ 2,003 × ¥8.0/2 ＝ **¥0.0218** ✓ |
| 峰谷判定 | 显示"当前低谷时段（半价）"，金额确为半价 |
| 项目合计 | 显示工作区名、对话清单与合计 |

### 实现中修正的两处

1. **`modelSelection` 键名**（见 A.5）——曾误用事件类型名 `'model/selection'`，导致模型归因为空、全部 token 落进"未计入"。同时加了自愈规则：`model` 为空的行在加载时丢弃重建。
2. **去掉"缓存为你省下"及装饰性着色**——只看花了多少。

### 尚未实现

- **M6** 未配置模型的检测与引导

### M7 已完成（回溯引擎）

**架构**：host 只做客户端做不到的事——读日志、抽出**逐笔请求样本** `{时间, provider, model, 四个桶}`；**定价留在客户端**。这样回溯和实时累加共用同一个计价器，两边永远不会算出不同的数。

**免费自检**：host 折叠出的 token 总数会与框架自己的 `tokenUsage` 投影逐会话比对，不符就计数报警——等于拿框架的权威值检验这个引擎。

**重试语义**：`foldSamples` 镜像框架的折叠——同一 (turn, step) 重复上报取后者（不重复计），`llm/retry-started` 之后算第二次计费请求。

**通道**：`ctx.connection.fetch.register()` 挂 `/api/cost/backfill`，NDJSON 流式推进度。用作用域注入 `ctx.inject(['connection','sessionQuery'], ...)` 包住，缺少任一依赖时计费本体照常工作。

### ⚠️ 三个踩过的坑（务必记住）

**1. Fetch 路由路径必须带 `/api` 前缀。**

服务文档写的是 "absolute path below `/api`"，但注册表用 `url.pathname` 直接做 key，`assertFetchRoute` 要求以 `/api/` 开头。注册 `/cost/backfill` 会**抛异常**；若被 promise 的 reject 分支吞掉，只会在请求时表现为一个无信息的 404。

```ts
// packages/client/connection/src/rpc-host.ts:266
if (!pathname.startsWith(`${channel}/`)) return undefined
```

**教训**：注册失败绝不能用 `warn` 吞掉，必须 `error` 级别——否则故障会推迟到用户点击时才以 404 形式出现。

**2. 重命名 `const` 时漏改引用，会让整个渲染分支崩成空白。**

`projectId` 改成 `projectCwd` 时，`scope === 'project'` 分支里的 `<select>` 仍在用旧名。默认 scope 是 `all`，所以打开页面一切正常；**一点「按项目」就 ReferenceError，整个设置面板内容区变空白**。

**防御**：`tools/check-identifiers.mjs` —— 作用域审计，列出"使用了但从未绑定"的名字。两半都跑，必须为 0。

**3. ⛔ 模块级 `const` 引用后面才声明的 `const` —— 整个界面瘫痪。**

```js
const SELECT = { ...INPUT, colorScheme: DARK_UI ? 'dark' : 'light' }   // 读 DARK_UI
const DARK_UI = window.matchMedia(...)                                  // 但声明在后面
```

`const`/`let` 有**暂时性死区**。这个错误在**模块求值阶段**抛出，所以不是某个组件坏掉，而是**整个客户端插件加载失败、界面瘫痪**。

**关键**：`node --check` 抓不到（语法合法），`check-identifiers.mjs` 也抓不到（`DARK_UI` **确实绑定了**，只是绑定在后面）。两个工具都瞎在这里。

**防御**：`tools/smoke-load.mjs` —— 用桩 loader 和最小 `react` 在 Node 里**真实执行模块**，再调一次 `apply(ctx)`。

它只证明两件事：**模块能初始化**、**apply 能注册插槽**。它不渲染，也不证明任何外观。但这正是能把界面搞瘫的那一类错误。

```
client.js: loads clean
  spec id   : @local/dsh-cost-meter
  registers : conversation.composer.dock [id=cost, order=1]
  registers : settings.section [id=cost-report, order=13]
  registers : settings.section [id=cost, order=12]
```

**操作规程（强制）**：任何改动客户端之后、`set_bundle` 重载之前，必须依次跑：

```
node --check client.js
node tools/check-identifiers.mjs client.js index.js
node tools/smoke-load.mjs client.js        ← 最后这道是保命的
```

- 两个插槽都用**错误边界**包住，渲染异常显示成一行可读信息，而不是空白。

### 热重载的边界（重要）

| 改动位置 | 生效方式 |
|---|---|
| 客户端 `client.js` | `plugin_manager` 的 `set_bundle` 禁用→启用即可，**无需重启** |
| host `index.js` | **必须重启 harness**——host 是 Node 进程里被缓存的 ESM 模块，重载只是用旧模块重跑 `apply` |

**判断 host 是否已重启**（不靠猜）：比对进程启动时间与文件修改时间。

```powershell
$f = Get-Item '<pkg>\index.js'
$p = Get-Process -Id (Get-NetTCPConnection -LocalPort 3080 -State Listen).OwningProcess
$p.StartTime -gt $f.LastWriteTime   # True => 已加载新代码
```

**注意**：客户端重载 ≠ host 重载。早期我曾用 `settings.yaml` 里出现 `credits` 字段来"证明"host 已更新——那是错的，该文件存的是客户端写入的原始用户层，只能证明客户端换了。

### M5 已完成（价表 + 设置页）

价表改为**生效日期键控**，因为模型名不等于价格：`deepseek-v4-flash` 在 2026-09-10 之前是独立定价的 V4-Flash-0731，之后才变成 V4.1-Flash 的路由别名。没有日期就无法区分这两个时期。

默认价目（CNY／百万 token，高峰价，低谷半价）：

| 模型 | 生效区间 | 缓存命中 | 未缓存 | 输出 |
|---|---|---|---|---|
| `deepseek-v4-pro` | 2026-08-16 → | 0.30 | 9.00 | 27.00 |
| `deepseek-v4-flash` | 2026-08-16 → 09-10 | 0.10 | 3.00 | 9.00 |
| `deepseek-v4-flash` | 2026-09-10 → | 0.04 | 2.00 | 8.00 |
| `deepseek-flash` | 2026-09-10 → | 0.04 | 2.00 | 8.00 |
| `xiaomi/mimo-v2.5-pro` | 全程 | 0.025 | 3.00 | 6.00 |
| `xiaomi-token-plan-cn/*` | 全程 | 2.5 | 300 | 600（**Credits**） |

`tokenPlan: true` 的行是预购订阅：额度以 Credits 扣减，用尽即停服而不溢出到余额，因此**不产生金额**，只统计 Credits。

设置页挂在 `settings.section`（`id: cost`，`order: 12`），可直接编辑价表、增删行、切换套餐标记、改币种与写入间隔。

### 关于热重载（重要）

**不需要重启 harness。** `plugin_manager` 的 `set_bundle` 断开再启用即可让两半都加载新代码。

判定方法：新版 `normalizeLedgerRow` 多产出 `credits` 字段，写入一次后检查 `settings.yaml`——出现 `credits` 即证明新 host schema 已生效。

### 已知实现细节

- 只有一处硬编码颜色：`#d29343`，仅用于"该模型无价目、token 未计入"的警告——这是花钱数字的准确性提示，不是装饰。
- 客户端与 host 通过框架自带的 `remote.settings` 通道通信（`describe()` 读、`update(ns, patch, revision)` 写），未自定义任何 Remote，也未使用装饰器。

---

## 15. 分发与合规（实测规则）

### 15.1 清单的真源

`packages/util/package-manifest/src/types.ts` 是插件作者所用 `package.json` 字段的权威声明：

```ts
interface DshPackageManifest {
  name: string; version: string; description?: string
  private?: boolean                    // "Prevent npm publication"
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  engines?: { dsh?: string; node?: string; npm?: string }
  dsh?: { manifestVersion?: 1; bundle?: { patch: string }; profile?: {...}; client?: DshClientManifest }
}

interface DshClientManifest {
  platform: string
  inject?: string[]    // "Informational package-name dependencies, NOT Cordis service injection"
  immediately?: boolean
  external?: string[]  // "...beyond the implicit client baseline; absent means baseline externals only"
}
```

**`engines` 是声明式的**（"DSH compatibility is declarative until a reader enforces it"）——写了不会被校验，但不写就没有兼容性声明。

### 15.2 客户端基线模块表

`packages/client/web/src/platform.ts:9`：

```ts
'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis'
```

这些由宿主提供，**不需要写进 `dsh.client.external`**。本插件只用 `react` / `react-dom`，因此 `external` 留空即正确。

### 15.3 安装器怎么工作

`packages/boot/plugin-manager/src/operations.ts`：

1. **`install_bundle` 就是在 profile 目录里跑 pnpm**，装完后 `reconcile` 读新依赖的清单
2. `anchorPathSpec` **只改写 `./` `../` 这类相对路径**，其余 spec 原样传给 pnpm
   → 所以 `github:user/repo`、npm 包名、压缩包**都能装**
3. 有 `dsh.bundle` → `loadOverlayPatches` **校验 patch 能被解析** → 加入 `dsh.profile.bundles`
4. 没有 `dsh.bundle` → 警告 `"installed as a plain dependency, not a profile layer"`

### 15.4 三种可分发形态（GUI 安装框自己写明的）

`packages/client/ui-plugin-manager/src/client/locales.ts`：

> `installDescription: '输入插件的包名、GitHub 仓库地址或本地目录路径。'`
> `installGuideIntro: '从插件的 README 或发布页面复制以下任意一项。'`

| 形态 | 示例 |
|---|---|
| 包名 | `dsh-cost-meter`（文档约定：`dsh-xxx` 或 `@作者/插件名`） |
| GitHub 仓库 | `https://github.com/<作者>/dsh-cost-meter` |
| 本地目录 | 绝对路径 |
| 压缩包 | 也被识别（`installSubjectTarball`） |

**"让 AI 一下子装上"的关键就是 README**——GUI 的引导语明确说"从插件的 README 复制"。所以 README 里必须有一个可直接粘贴的字符串。

### 15.5 本包已落实的合规项

| 项 | 之前 | 现在 |
|---|---|---|
| 包名 | `@local/dsh-cost-meter`（本地约定） | **`dsh-cost-meter`**（文档约定的 `dsh-xxx`） |
| `private` | `true` → **挡住 npm 发布** | 已移除 |
| `dsh.manifestVersion` | 无 | `1` |
| `engines` | 无 | `dsh: >=0.1.6-alpha.2`, `node: >=22` |
| `license` / `keywords` / `files` | 无 | 已补 |
| `cordis.patch.yml` 的 `name` | `@local/dsh-cost-meter` | **`dsh-cost-meter`**（必须等于包名，Loader 按它 import） |
| `client.js` 的模块 id | `@local/dsh-cost-meter` | **`dsh-cost-meter`**（必须等于包名，浏览器模块表按它查表） |
| README | 无 | 有，含可直接粘贴的安装串 |

### 15.6 ⚠️ 打包陷阱：自引用 junction

一次事故修复过程中，工作目录里曾残留一个测试 HOME，其中有**两个 junction**：

```
test-home/profiles/web/node_modules/<包名>  →  <插件目录>              （指回包自己 → 无限递归）
test-home/profiles/web/node_modules         →  ~/.dsh/profiles/web/node_modules
```

**任何递归复制/打包都会因第一个而死循环**（`Copy-Item -Recurse` 会直接报"系统无法辨识文件名"）。`package.json` 的 `files` 白名单能挡住它进 npm 发布包，但**挡不住目录拷贝**——打包前必须确认包内无 junction：

```powershell
Get-ChildItem <包目录> -Recurse -Force | Where-Object { $_.LinkType }
```

`package.json` 的 `files` 白名单能挡住它进 npm 发布包，但**挡不住目录拷贝**——所以打包前必须确认包内无 junction。

### 15.7 发布前必跑

```sh
node tools/check-package.mjs          # 分发就绪：清单字段、patch 可解析且名实相符、client id 匹配、private 已移除
node --check index.js
node --check client.js
node tools/check-identifiers.mjs client.js index.js
node tools/smoke-load.mjs client.js   # 加载级冒烟：抓 TDZ 这类"语法合法但一加载就炸"的错误
node tools/check-defaults.mjs index.js # 内置价表自足：空配置必须解析出完整价表与折扣日历
```

六项全绿才算可发。前五项管"能不能装上、会不会白屏"，第六项管"装上之后用户要不要自己配"。

想确认"本机存的价表 == 出厂默认"：

```powershell
node tools/dump-models.mjs --defaults > $env:TEMP\a; node tools/dump-models.mjs > $env:TEMP\b; Compare-Object (cat $env:TEMP\a) (cat $env:TEMP\b)
```

两边输出形状刻意做成一致，`Compare-Object` 无输出即为逐行相同。

---

## 附录 A：已实测确认的 API 契约

### A.1 插槽 `conversation.composer.dock`

```ts
name: 'conversation.composer.dock'
kind: 'list'
scope: 'session'
replaceRisk: 'none'
registration: { id: string (required), order?: number, label?: string | (() => string) }

standardProps: [
  'useResource', 'useWorkspaces', 'usePanelInfo', 'useSessions', 'useSessionStatus',
  'useSessionRetainInfo', 'useChat', 'useConversation', 'useInput', 'inputActions',
  'useSession', 'sessionId', 'useProjection', 'useTrajectory'
]

// 当前占用者
occupants: [{ registrant: 'lc', id: 'stats', order: 0 }]
```

### A.2 客户端要用的 hook 类型

```ts
type UseSessions   = SnapshotSelectorHook<SessionListState>   // packages/client/ui-session/src/client/index.ts:32
type UseWorkspaces = SnapshotSelectorHook<WorkspaceSnapshot>
```

### A.3 `SessionListState`

```ts
export interface SessionListState {
  ids: SessionId[]
  byId: Record<SessionId, SessionSummary>
  phase: SessionListPhase
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>
}
```

### A.4 `WorkspaceView`

```ts
export interface WorkspaceView {
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly SessionId[]
  readonly createdAt: string
  readonly updatedAt: string
}
```

### A.5 `modelSelection` 投影

⚠️ **投影键名是驼峰 `modelSelection`**。`'model/selection'` 是 **SessionEventMap 的事件类型**，不是投影键——实现时把两者搞混过一次，导致模型归因全部为空。

```ts
// packages/api/session-controller/src/types.ts:30
interface SessionProjectionMap {
  sessionListMetadata: SessionListMetadata
  imageLimits: ImageAttachmentLimits
  modelSelection: ModelSelectionProjection      // ← 键名
}

export interface ModelSelectionProjection {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Selection the next request should use, falling back to lastUsed. */
  readonly next: ModelSelection | null
}

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}
```

### A.6 host `settings` 服务

```ts
register<const Namespace extends string, T>(
  ns: Namespace & SettingsNamespaceInput<Namespace>,
  schema: z<T>,
  options?: SettingsRegisterOptions<T>,
): SettingsScope<T>

installSection<const Namespace extends string, T>(
  owner: Context, ns, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>,
): void
```

客户端通过 `ctx.remote.settings.get/update/mutate(ns, ...)` 读写，需在 `inject` 声明 `'remote'`, `'remote.settings'`。

### A.7 Storage

```ts
// 根：dshHomePath('storages')
ctx.storageDomain.open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
```

参考 `session_projcache` 落在 `<root>/session_projcache/sessions/<id>.json`。

---

## 附录 B：DeepSeek 价表（CNY / 1M tokens，高峰价）

| 模型 | 缓存命中 | 未缓存输入 | 缓存写入 | 输出 |
|---|---|---|---|---|
| `deepseek-flash` | ¥0.04 | ¥2.0 | ¥0（不收费） | ¥8.0 |
| `deepseek-v4-pro` | ¥0.30 | ¥9.0 | ¥0（不收费） | ¥27.0 |

**低谷时段全部五折。**

- 高峰 = 周一至周五 北京时间 **09:00–12:00** 与 **14:00–18:00**（等价 UTC 01:00–04:00、06:00–10:00），**排除中国法定节假日**
- 其余时间（含完整周末、完整节假日）为低谷
- 已下线的 `deepseek-chat` / `deepseek-reasoner` 不要再写进价表
- 旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍路由到 V4.1-Flash，按 Flash 价计费

### 2026 年放假日（国办发明电〔2025〕7号）

```
元旦    01-01 ~ 01-03
春节    02-15 ~ 02-23
清明    04-04 ~ 04-06
劳动节  05-01 ~ 05-05
端午    06-19 ~ 06-21
中秋    09-25 ~ 09-27
国庆    10-01 ~ 10-07
```

调休上班日（02-14、02-28、05-09、09-20、10-10、01-04）均为周末，按规则本就属于低谷，无需特殊处理。

> ⚠️ 价格与时段需以 [官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 与实际账单为准。

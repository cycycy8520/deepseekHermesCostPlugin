# 花费统计仪表盘 — 开发文档

> 状态：**设计已定稿，待开发**
> 前置文档：[DESIGN.md](./DESIGN.md)（计费插件的整体设计、踩过的坑、预检规程）
> 本文只讲这一件事：**整页统计仪表盘**。实现时以本文为准，不要临场压缩。

---

## 1. 目标与定位

把已有的花费数据做成一个 **Codex 个人主页形态**的整页仪表盘：

**一屏之内回答三个问题**——我花了多少？花在哪？什么时候花的？

### 比 Codex 强在哪

Codex 只统计 token 和时间。我们有它没有的：

| | Codex | 本仪表盘 |
|---|---|---|
| Token | ✅ | ✅ |
| 时间（模型/工具用时） | ✅ | ✅ |
| **钱** | ❌ | ✅ 按项目／模型／计费桶 |
| **缓存的价值** | ❌ | ✅ 缓存读取占比、缓存省下多少 |
| **峰谷时段** | ❌ | ✅ 低谷半价省了多少 |
| **子 agent 花费** | ❌ | ✅ 独立会话，独立计价 |

---

## 2. 数据来源（逐项映射）

每一个数字都必须能指出它是从哪来的。**没有来源的数字不许上界面。**

| 界面元素 | 数据来源 | 现状 |
|---|---|---|
| 总花费 | 账本 `cost` 求和 | ✅ 现成 |
| 总 token | 账本 `charged` 求和 | ✅ 现成 |
| 缓存读取花费 | 账本 `byBucket.cacheRead` | ✅ 现成 |
| 缓存命中 token | 账本 `charged.cacheRead` | ✅ 现成 |
| 对话数 | 账本有花费的行数 | ✅ 现成 |
| 项目数 | 按工作区归属分组计数 | ✅ 现成 |
| 项目维度 | 工作区注册表 `sessionIds` | ✅ 现成 |
| 模型维度 | 账本 `model`（逗号分隔） | ✅ 现成 |
| 计费桶构成 | 账本 `byBucket` | ✅ 现成 |
| **模型用时** | `sessionStats.llmMs` | ✅ 现成（见 §2.1） |
| **工具用时** | `sessionStats.toolMs` | ✅ 现成 |
| **TTFT 平均** | `sessionStats.ttftMs / ttftSteps` | ✅ 现成 |
| **输出速度** | `sessionStats.decodeTokens / (decodeMs/1000)` | ✅ 现成 |
| **每日活动（热力图）** | 账本新增 `byDay` | ⚠️ **要补**（见 §3） |
| **连续天数／单日峰值** | 同上 | ⚠️ 要补 |
| 项目维度的按天数据 | 同上（按会话的 `byDay` 再按项目聚合） | ⚠️ 要补 |

### 2.1 「图3 那四项」是白捡的

`session-stats` 投影**已经在客户端可见**，字段如下（实测）：

```ts
// packages/session/session-stats/src/types.ts:42
//   声明进 SessionProjectionMap → 客户端可见
// packages/session/session-stats/src/projection.ts:199
wire: {
  view: state => ({
    turns, steps,
    llmMs, toolMs,
    ttftMs, ttftSteps,
    decodeMs, decodeTokens,
  }),
}
```

它和 `tokenUsage` 走**同一个机制**：跟着会话列表每一行 (`SessionSummary.projectionValues`) 发到客户端。

**结论**：跨全部会话求和即可得到「模型用时 42时14分 / 工具用时 6时02分 / TTFT 3.2秒 / 269 tok/s」——**零额外成本，不需要读日志，不需要改 host**。

---

## 3. 唯一的数据缺口：按天直方图

### 3.1 为什么缺

账本现在每个会话**只存一个累计总额**。而回溯引擎**明明拿到了每一笔请求的时间戳**（样本形如 `{t, p, m, b}`），求和之后就把 `t` 丢掉了。

实时累加那边同理——它知道"现在"，但只累加进总数。

### 3.2 怎么补

**在回溯时顺手按天落桶。** 引擎本来就在逐笔遍历，`t` 就在手上，成本几乎为零。实时累加那边按 `Date.now()` 落一个桶。

### 3.3 账本结构变更

每个账本行新增一个字段：

```js
byDay: {
  '2026-09-30': { tokens: 420000000, cost: 12.30, credits: 0 },
  '2026-10-01': { tokens: 180000000, cost:  5.10, credits: 0 },
}
```

- 键是**北京时间日历日**（与峰谷判定同一套时区，避免跨时区错位）
- `credits` 给 Token Plan 路线用（它不计金额）

### 3.4 体积

一个会话只在实际活跃的那些天有条目。绝大多数会话活跃 1–2 天。

| 场景 | 条目数 | 体积 |
|---|---|---|
| 100 个会话 | ≈150 | ≈9 KB |
| 2000 个会话 | ≈3000 | ≈180 KB |

**远小于之前担心的量级。** 加上写入已经是"只写变化的行"，不会每次全量推送。

### 3.5 ✅ 已解决：不需要重启（读原始用户层）

**原先的判断**：新增持久字段要改 host 的 `normalizeLedgerRow`，而它构造的是固定形状、未知字段会被丢掉，所以必须重启。

**这个判断只对了一半。** 设置服务里有两条路径：

| 路径 | 是否经过 schema |
|---|---|
| **写入** → 存储文档 | ❌ 不经过。存的是**原始用户层**，`byDay` 原样落盘 |
| **读取** → `value`（解析值） | ✅ 经过。旧 schema 会把 `byDay` **剥掉** |

所以数据**写得进去、读不回来**。

**解法**：`describe()` 同时返回 `user`——原始用户层。实测确认两端都保留：

```ts
// packages/settings/settings/src/index.ts:499
//   "Describe every registered namespace ... including the composition
//    `base` and raw user layers"
// packages/settings/settings/src/index.ts:524
//   ...detachedUser === undefined ? {} : { user: detachedUser }
// packages/api/settings-controller/src/index.ts:66-67
//   ...descriptor.user === undefined ? {} : { user: descriptor.user as JsonValue }
```

客户端读账本时走 `found.user?.ledger ?? found.value?.ledger`。

**为什么这样是安全的**：账本是**机器写的数据**，不是用户配置；schema 在这里的作用是给配置做默认值与校验。而且 `adoptLedger` 本来就会对每个字段做防御性归并（`...(row.baseline ?? {})`），不依赖 schema 兜底。

**代价**：账本绕过了 schema 校验。这与 §13 里"账本应该搬出 `settings.yaml`、迁到 storage 域"是同一个方向的问题——那次迁移会把这件事彻底理顺。

> host 侧的 `byDay` normalizer **仍然要写**：它负责保留上限、丢弃非法日期键。只是**不阻塞功能**了——老进程下也能正常工作，重启后自动开始生效。


---

## 4. 版面设计

### 4.1 主视图

```
┌──────────────────────────────────────────────────────────────────┐
│ 💰 花费统计                        [全部项目 ▾]   [全部时间 ▾]     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ¥229.20        3.35B          42时14分         70              │
│   总花费          总 token       模型用时         对话数           │
│                                                                  │
│   ¥147.60        1.10B          6时02分          6               │
│   缓存读取        缓存命中 tok    工具用时         项目数           │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ Token 活动                                  每天 / 每周 / 累计     │
│ ░░░░░▓▓▓████▓▓░░░   ← 热力图，按数据范围自适应                     │
│ 8月14日起 · 共 49 天                                              │
├──────────────────────────────────────────────────────────────────┤
│ ┌─ 花费构成 ──────────┐  ┌─ 项目排行 ─────────────────────┐      │
│ │ 缓存读取 ████ ¥147.6│  │ GW         ████████ ¥120.30 64% │      │
│ │         · 64.4%     │  │ 脑力填填填 ██       ¥ 39.22 17% │      │
│ │ 输出     ███  ¥ 76.2│  │ …                              │      │
│ │ 未缓存   █    ¥  5.4│  │                                │      │
│ └─────────────────────┘  └────────────────────────────────┘      │
├──────────────────────────────────────────────────────────────────┤
│ 明细 · 按花费降序 · 共 70 条                        第 1/3 页      │
│ 对话              项目      模型     token    用时     花费        │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 下钻后（点了某个项目）

```
│ 💰 花费统计   ← 返回全部项目      [脑力填填填 ▾]   [全部时间 ▾]     │
```

- 顶部出现**「← 返回全部项目」**
- 范围框显示当前项目
- **整页重算**：数字卡、热力图、两张图表、明细表全部只算这个项目
- **饼图从「项目分布」切成「对话分布」**（单项目下项目饼图是一个 100% 实心圆，零信息）

### 4.3 空数据状态

```
┌──────────────────────────────────────────────────────────────────┐
│ 💰 花费统计                                                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│              还没有可统计的数据                                    │
│                                                                  │
│   先去「花费计价」跑一次计算，把历史日志里的花费回溯进账本。         │
│                                                                  │
│              [ 前往花费计价 ]                                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**不允许**：显示一堆 ¥0.00 假装正常。

---

## 5. 展示规则（十二条，实现时逐条对照）

| # | 规则 | 理由 |
|---|---|---|
| **1** | **一屏三问**：首屏不滚动就能回答「花了多少／花在哪／什么时候花的」 | 数字卡最上、图表在中、明细最下 |
| **2** | **每个数字必须带占比** | 「¥147.60」没有意义，「64.4%」才知道它重不重要 |
| **3** | **所有列表按花费降序** | 这是花费统计，不是通讯录 |
| **4** | **每个聚合都能下钻，且能原路返回** | 点项目行 → 范围切到它 + 出现「← 返回」；点对话行 → 弹窗看桶明细 |
| **5** | **两个全局过滤器**：范围（全部/某项目）、时间（全部/近30天/近7天） | 作用于**页面上一切**，包括热力图和明细 |
| **6** | **热力图永远画满 53 周（12 个月）**，没有数据的日子也渲染成**空格子** | 贡献图的**形状本身就是日历**。按"有数据的范围"自适应会把它收缩成一个孤零零的点，**连日历都不像了**，读者看不懂 —— 这是第一版实现犯过的错 |
| **7** | **没数据要直说，不能装作正常** | 见 §4.3 |
| **8** | **大数字大，标签小** | ¥229.20 用 28px；标签 11px 灰字。眼睛先抓数字，再读标签 |
| **9** | **颜色只用来区分，不用来装饰** | 七色调色板只给图表。**不加渐变、不加阴影、数字不上色** |
| **10** | **明细永远分页，不做无限滚动** | 每页 25，与已有规则一致 |
| **11** | **格式统一** | 见 §7 |
| **12** | **一页只有一个主行动：看** | 唯一控件是两个过滤器，不满屏按钮 |

---

## 6. 明确不做的（反面清单，同样重要）

- ❌ **无限滚动** —— 一律分页
- ❌ **入场动画／过渡** —— 只有 heatmap tooltip 有
- ❌ **引图表库** —— 条形用 div 宽度、饼图与热力图用 SVG 自绘，**保持零依赖**
- ❌ **超过两层的下钻** —— 项目 → 对话，到此为止
- ❌ **同页两套过滤器** —— 只有顶部那一组
- ❌ **头像／用户名** —— DSH 没有账号体系，不做
- ❌ **数字上色** —— 只有警告（未计价）用橙色

---

## 7. 格式规格

### 7.1 时长

| 范围 | 格式 | 例 |
|---|---|---|
| < 60 秒 | `{n}秒` | `42秒` |
| < 60 分 | `{m}分{s}秒` | `42分14秒` |
| ≥ 60 分 | `{h}时{m}分` | `3小时12分` |

### 7.2 Token

一律 K / M / B，两位小数：`4.2亿` → 内部用 `420M`；超过 1000B 用 `1.10T`。

### 7.3 金额

- 一般：`¥X.XX`
- `< ¥0.01`：`¥0.XXXX`（保留四位）
- `0`：`¥0.00`
- Token Plan：另用 `{n} cr`

### 7.4 日期

- 热力图 tooltip：`9月30日 · 4.2亿 tok · ¥12.30`
- 页脚范围：`2026-08-14 起 · 共 49 天`

---

## 8. 交互规格

| 元素 | 行为 |
|---|---|
| 热力图格子 | 悬停 → tooltip（日期 + token + 花费） |
| 项目行 | 点击 → 范围切到该项目 |
| 对话行 | 点击 → 复用已有的花费弹窗 |
| 顶部过滤器变化 | 整页重算；**明细表回到第 1 页** |
| 顶部过滤器 | 滚动时**吸顶** |
| 「← 返回全部项目」 | 范围复位；时间过滤器**保持不变** |
| 每天/每周/累计 | 只切热力图的聚合方式，不影响其他区块 |

---

## 9. 位置与注册（实测契约）

### 9.1 为什么是整页

Codex 那种主页**必须整页**。挤在设置弹窗（内容列约 690px）里，数字卡放不下、热力图放不下、明细表只能看到 5 列。

### 9.2 两个插槽

框架正好配套（实测自 `cordis_inspect_query`）：

**`sidebar.panellist`** —— kind `list`，scope `root`，`replaceRisk: none`

```
purpose: "Global panel icons."
description: "Each list id addresses the matching main panel; the sidebar owns
              the button and resolves its label from list metadata."
registration: { id: string(必填), order?: number, label?: string | (() => string) }
ownerProps:   { size: number, active: boolean }   ← 我提供图标组件
standardProps: useResource, useWorkspaces, usePanelInfo, useSessions,
               useSessionStatus, useSessionRetainInfo
现有占用者:   { id: "plugins", order: 0 }
```

**`main`** —— kind `keyed`，scope `root`

```
purpose: "Central panel selected by sidebar entry id."
keyDomain: "open ... already taken: conversation"
registration: { key: string(必填) }              ← 注意是 key 不是 id
standardProps: 同 panellist（无 useProjection）
说明: "The reserved `conversation` key hosts the Conversation;
       other keys receive no Session binding."
现有占用者:   key="plugins", key="conversation"
```

### 9.3 接线

```js
// 图标：收到 { size, active }，自绘
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: 'cost', order: 1, label: () => t('dashTitle'),
}, boundary('cost icon', CostIcon)))

// 整页：key 与上面的 id 相同，框架自动对应
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: 'cost',
}, boundary('cost dashboard', CostDashboard)))
```

**注意**：`main` 是 `shadows-shipped-ui` 风险等级——但只在**抢占已占用的 key** 时才有风险。`cost` 是空闲的，安全。

---

## 10. 组件拆分

| 组件 | 职责 |
|---|---|
| `CostIcon` | 侧边栏图标，`{ size, active }` |
| `CostDashboard` | 整页外壳：过滤器 + 各区块编排 |
| `StatCards` | 六格数字卡 |
| `ActivityHeatmap` | SVG 热力图 + tooltip |
| `BucketBars` | 花费构成条形 |
| `ProjectRanking` | 项目排行（可下钻） |
| `DetailTable` | 明细分页表 |

所有组件都在 `client.js` 内（客户端 bundle 是单文件，没有相对导入）。

---

## 11. 分期计划与验收标准

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P1** | host：账本行加 `byDay`；回溯时按天落桶；实时累加按 `now` 落桶 | `settings.yaml` 里账本行出现 `byDay`；跑一次回溯后，各天 token 之和**等于**该会话 `charged` 总和 |
| **P2** | `sidebar.panellist` 图标 + `main` 整页 + 六格数字卡 + 两个过滤器 | 左边栏出现 💰；点开是整页；六格数字与「花费分布」页对得上 |
| **P3** | 热力图（SVG 自绘 + tooltip + 每天/每周/累计切换） | 格子总数 = 数据覆盖天数；悬停显示日期/token/花费 |
| **P4** | 花费构成、项目排行、明细分页表、下钻与返回 | 点项目行整页重算且出现「← 返回」；饼图切成对话分布 |
| **P5** | 衍生指标：连续天数、单日峰值、缓存省下多少 | — |

**P1 是硬前置**——没有按天数据，P3 和 P5 都做不了。

---

## 12. 已定取舍与待定项

### 12.1 已定：用时跨项目相加 = 累计用时

多个会话可能**并行跑**（A 项目在等时切到 B 项目），用时相加会**超过墙钟时间**。

**决定：照相加，标签写「模型用时」「工具用时」。** 与 Codex 一致，标签本身已经诚实。

> 备选（已否决）：全部项目时显示墙钟跨度。两个口径会让人困惑。

### 12.2 已定：热力图固定 53 周，历史长度只影响上色

网格**固定画满 53 周**（与 Codex 一致），日期轴就是日历本身。日志最早到 **2026-08-14**，所以只有那之后的日子可能有颜色，之前是空格子。

页脚如实标注**有数据的天数**（`共 N 天有数据`），而不是让空白去暗示"坏了"。

### 12.3 待定

- 热力图的"每天/每周/累计"三档，**累计**具体指什么？（累计总量曲线 vs 累计色阶）——实现前需确认
- 单日峰值按**全部项目**还是**单项目**？建议：随范围过滤器走

---

## 13. 风险

| 风险 | 说明 | 对策 |
|---|---|---|
| host schema 变更 | 加 `byDay` 曾被认为必须重启 | **已解决**：客户端读原始用户层 `user`，老进程下照常工作（§3.5） |
| `items`（工作区列表）**在设置页里不总是可取** | 早期实测：设置页里 `useWorkspaces` 返回空（时序问题，随后自行恢复） | 仪表盘在 `main` 插槽，与设置页不同；**实现时先验证** |
| 用时字段来源不明 | `sessionStats` 在 `main` 插槽的 `standardProps` 里**没有** `useProjection` | 改为从 `useSessions` 的 `projectionValues.sessionStats` 读（与账本同一份数据） |
| 热力图空白 | 只有 7 周数据 | 按数据范围自适应 + 页脚标注 |

---

## 14. 开发前置规程（沿用 DESIGN.md）

**任何改动、在 `set_bundle` 重载之前，四道预检必须全绿：**

```
[1/4] node --check index.js
[2/4] node --check client.js
[3/4] node tools/check-identifiers.mjs client.js index.js
[4/4] node tools/smoke-load.mjs client.js        ← 保命那道
```

改 host 则必须重启 harness，并用「进程启动时间 > 文件修改时间」确认已加载。

---

## 附录：本文引用的实测证据

| 结论 | 出处 |
|---|---|
| `sessionStats` 客户端可见 | `packages/session/session-stats/src/types.ts:42`（`SessionProjectionMap`） |
| 其 wire 字段 | `packages/session/session-stats/src/projection.ts:199–210` |
| `sidebar.panellist` 契约 | `cordis_inspect_query` → `Slots.listSubTree(root="sidebar.panellist")` |
| `main` 契约 | `cordis_inspect_query` → `Slots.listSubTree(root="main")` |
| 项目归属用 `sessionIds` | 工作区注册表；弹窗、回溯选择器、花费分布三处已统一 |
| 账本行现状字段 | `baseline, byBucket, charged, cost, credits, unpriced, model, updatedAt` |
| 回溯样本形状 | `{t, p, m, b}`（时间、provider、model、四个桶） |

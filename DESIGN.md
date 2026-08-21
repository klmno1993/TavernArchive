# Tavern Archive 设计文档

SillyTavern 第三方扩展：全局对话内容搜索、收藏与标签管理。
纯前端扩展，无服务端组件，通过 GitHub URL 直接安装。

## 目标

ST 自带的聊天搜索以单个角色为单位，无法跨角色全局搜索，也没有收藏/标签等管理手段。
本扩展建立**消息级本地索引**，提供：

- 全局搜索对话**内容**（跨全部角色卡与群聊）
- 多维筛选：角色卡多选、群聊、发送者、时间范围（消息级）、标签/收藏状态
- 聊天级 + 消息级收藏，聊天级标签（多标签、颜色、备注）
- 搜索结果一键跳转：打开对应聊天并滚动定位到该条消息

## 技术路线

- 纯前端扩展（`public/scripts/extensions/third-party/TavernArchive/`）
- 数据源：ST 服务器现成 REST API
  - `POST /api/chats/search`（空 query）→ 某角色/群聊下全部聊天文件的元数据
  - `POST /api/chats/get` / `POST /api/chats/group/get` → 聊天完整内容
  - 角色/群聊列表直接用 `getContext().characters` / `getContext().groups`，不发请求
- 索引：内存全量索引 + IndexedDB 持久化（库名按用户 handle 区分：`tavern-archive-<handle>`）
- 收藏/标签：`extension_settings.tavernArchive`，随 ST 设置持久化到服务器端
- 增量更新：比对 `message_count + last_mes + file_size`，只重拉变化的聊天；已删除的聊天剔除

### 关键设计决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 面板形态 | 覆盖主内容区（与 ST 自带用户设置/世界书同区域同形态）：`position: fixed; top: var(--topBarBlockSize); left: calc((100dvw - var(--sheldWidth))/2); width: var(--sheldWidth)`，窄屏拉满 100dvw；点顶栏图标开关，无遮罩无弹窗，桌面手机一致 | 弹窗/抽屉在移动端兼容性问题多；复用 ST 现成的布局变量与交互惯例最稳 |
| 收藏/标签粒度 | 聊天级 + 消息级 | 金句/名场面收藏是刚需；数据结构一次到位 |
| swipe 策略 | 仅索引当前 swipe | 索引是缓存不是数据源，以后想改策略重建即可；索引全部 swipe 噪音大、体积翻倍 |
| 搜索语法 | 空格 AND + `"短语"` + `-排除` + 可选正则开关 + 大小写开关 | 简单够用，上限高 |
| 匹配粒度 | 消息级（全部条件命中同一条消息） | 比 ST 自带的跨消息匹配更符合直觉 |
| 消息锚点 | `chatKey + 消息数组下标`（对应 ST 的 `mesid`） | 重 roll 后收藏仍指向"第 N 楼"，符合直觉 |

### chatKey 格式

- 角色聊天：`c::<avatar文件名>::<fileId>`，如 `c::Alice.png::Alice - 2024-01-01@12h00m00s`
- 群聊：`g::<groupId>::<chatId>`

风险：用户在 ST 内重命名聊天文件会断链。对策：启动时校验所有收藏/标签 key，失效项集中列出，用户确认后清理。不做自动迁移。

## 数据结构

### IndexedDB（`tavern-archive-<handle>`，v1）

```
store meta:     { chatKey, type:'char'|'group', avatar?, charName?, groupId?, groupName?,
                  fileId, fileName, messageCount, lastMes(ISO), fileSize, indexedAt }
store messages: { chatKey, messages: [{ i, name, isUser, ts(Number|null), text }] }
```

### extension_settings.tavernArchive

```js
{
  favorites:   { [chatKey]: { note, addedAt } },
  chatTags:    { [chatKey]: [tagName, ...] },
  tags:        { [tagName]: { color } },
  msgFavorites:{ [chatKey]: { [msgIdx]: { note, addedAt } } },
  lastIndexAt: 0,
}
```

## 与 ST 的接口（已核实 release 分支源码）

- 导入：`../../../../script.js`（`getRequestHeaders`、`saveSettingsDebounced`、`eventSource`、`event_types`、`showMoreMessages`、`openCharacterChat`、`selectCharacterById`）；`../../../extensions.js`（`getContext`、`extension_settings`）；`../../../group-chats.js`（`openGroupChat`）；`../../../user.js`（`getCurrentUserHandle`）
- 入口：`#top-settings-holder` 注入 `.drawer-icon` 放大镜图标；`#extensions_settings2` 注入 `.inline-drawer` 设置块；斜杠命令 `/archive`（`SlashCommandParser.addCommandObject`）
- 消息 DOM：`#chat .mes[mesid="N"]`
- **长聊天分页渲染**：默认只渲染最后 100 条（`power_user.chat_truncation`），定位早期消息需循环 `await showMoreMessages()` 直到目标 mesid 出现在 DOM，再 `scrollIntoView` + 闪烁高亮
- 跳转角色聊天顺序：先 `selectCharacterById(characters 数组下标)`，再 `openCharacterChat(file_id)`；群聊：`openGroupChat(groupId, chatId)`（不满足条件静默返回，需自行校验）
- 主题适配：只用 ST CSS 变量（`--SmartThemeBodyColor`、`--SmartThemeBorderColor`、`--SmartThemeBlurTintColor`、`--SmartThemeEmColor` 等）与原生 class（`menu_button`、`text_pole`、`inline-drawer`、`checkbox_label`）。`background_only` class 不存在，勿用
- 注意：`getContext()` 每次调用重新取值（快照语义），用到时现取

## 索引流程

1. 启动：打开 IndexedDB → 全量读入内存 → 后台静默增量刷新
2. 增量刷新：对每个角色/群聊调 `/api/chats/search`（空 query，并发 6），比对元数据，变化的聊天重拉内容解析入库；消失的删除
3. 首次全量：进度条（按聊天推进），可后台继续，面板打开时显示进度
4. 面板打开时若距上次刷新 >60s，再跑一次增量
5. 消息解析：跳过首行 `chat_metadata` 头；跳过 `is_system`；`text` 取当前 swipe（`swipes[swipe_id]`，无则 `mes`）；`send_date` 解析为时间戳（`Date.parse` → `moment` 兜底），失败存 `null`（启用时间筛选时不参与）

## 搜索

- 分词：`/"([^"]+)"|(\S+)/g`，引号内为短语，`-` 前缀为排除
- 正则模式：整个输入编译为一个正则（非法正则在 UI 提示，不崩溃）
- 流程：聊天级过滤（角色/群聊、标签、收藏）→ 消息级过滤（发送者、时间）→ 文本匹配 → 命中收集
- 排序：聊天视图按 `lastMes` 倒序或命中数；消息视图按时间倒序
- 高亮：命中词/正则命中段包 `<mark>`

## UI 结构

```
┌ #ta-panel（覆盖 #sheld 主内容区）──────────────┐
│ 头部: [搜索输入(有内容时显示✕清除)] [.*正则] [Aa大小写] [✕] │
│ ┌ 筛选栏 ────┬ 主区 ────────────────────────┐ │
│ │ ▸ 发送者   │ 工具栏: [消息|聊天] [当前对话] │ │
│ │ ▸ 时间     │   排序 计数                    │ │
│ │ ▸ 角色/群聊│ ┌ 结果卡片(增量渲染,30/批) ──┐ │ │
│ │   含命中数 │ │ 头像 角色名·聊天名·时间 ★  │ │ │
│ │   与仅看   │ │ …命中**关键词**片段…       │ │ │
│ │ ▸ 收藏/标签│ │ [跳转] [收藏本条] 🏷标签    │ │ │
│ │           │ └───────────────────────────┘ │ │
│ └───────────┴───────────────────────────────┘ │
│ 状态栏: 索引统计 · 上次更新(相对时间) · [刷新索引] [重建索引] │
└────────────────────────────────────────────────┘
```

- 窄屏（<768px）：同一面板形态不变，仅布局收窄；筛选栏与主区纵向排列
- 键盘：`/` 聚焦搜索，`Esc` 关闭/收起筛选
- 状态机：未建索引（引导页）→ 索引中（进度 + 可搜已索引部分）→ 就绪
- 空态区分"还没有任何聊天"与"无命中，建议放宽筛选"

## 性能

- 搜索全在内存，毫秒级；输入防抖 300ms
- 结果增量渲染（IntersectionObserver 哨兵，每批 30 条），避免大结果集卡死
- 索引拉取并发 6；聊天内容解析在主线程（量大时按角色分片让出事件循环）

## 后续补充（已实现）

- 搜索框内容非空时显示清除按钮
- 「★ 仅收藏」开关，含义跟随粒度轴：聊天视图=收藏的聊天，消息视图=收藏的消息；收藏消息可无关键词浏览；与「仅无标签」独立可组合
- 角色筛选列表实时显示本次搜索各角色命中数（命中排前、0 命中灰显），行内「仅看」一键只搜该角色
- 聊天视图按角色/群聊分组，组头可折叠
- 跳转消息/打开聊天后自动关闭面板
- 状态栏上次更新改为相对时间；索引进度提示可关闭面板后台继续
- 工具栏「当前对话」开关：仅搜索当前打开的聊天

## 已知边界

- 首次索引耗时与聊天总量成正比，有进度展示，中断后续传（已索引的在 IndexedDB）
- 时间筛选对无 `send_date` 的消息不生效
- ST 渲染分页导致跳转极早消息时需多次 `showMoreMessages`，循环上限保护（如 200 次）
- 多用户（多 handle）：设置由 ST 按用户隔离；IndexedDB 按 handle 分库

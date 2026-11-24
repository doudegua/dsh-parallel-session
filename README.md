# dsh-parallel-session · 平行会话

给 DSH 加一个「平行会话」原语：当前会话调用工具 `spawn_parallel_session`，开启一个**与本会话平级**的顶层会话；用户可以在侧栏或结果卡片里直接点进去和它对话。当前会话把上文写进 `context` 一并交接，用户不用再对着空白输入框手打一遍。

## 它和现有两种「开新会话」的区别

| | `subagent` | `spawn_teammate`（Agent Teams） | **`spawn_parallel_session`** |
| --- | --- | --- | --- |
| 归属 | 当前会话的子代理 | Team Lead 的成员 | 无归属，真正的顶层会话 |
| 用户能直接开聊吗 | 不能（没有会话入口） | 能（成员会话） | 能（侧栏 + 结果卡片一键打开） |
| 模型/思考等级 | 可独立配置 | 可独立配置 | **默认继承当前会话**，可覆盖 |
| 工作区/权限 | 子代理沿用父级 | 团队共享 cwd | **默认继承当前会话**，可覆盖 |
| 权限能否是「完全权限」 | 视配置 | 视配置 | **永远不能**（强制收敛） |
| 用途 | 分解子任务 | 多角色协作 | 把一段上文交接给另一个会话，用户接着聊 |

## 当前机器状态

已经以 bundle 形式安装在 `~/.dsh/profiles/desktop`：

- 依赖：`"@dsh-external/dsh-parallel-session": "link:/Users/huakaifugui/Workspace/dsh-parallel-session"`
- bundles 列表已包含 `@dsh-external/dsh-parallel-session`
- host 插件（工具）与 client 插件（聊天结果卡片）都已热加载，无需重启

## 安装到别的 profile

GUI：侧栏 **Plugins → Add plugin**，输入本地目录的绝对路径

```
/Users/huakaifugui/Workspace/dsh-parallel-session
```

点 **Install**，完成后点 **Enable now**。桌面版支持 HMR，启用即生效，不用重启。

命令行等价做法：

```bash
dsh plugin --profile desktop add /Users/huakaifugui/Workspace/dsh-parallel-session
# 然后把 @dsh-external/dsh-parallel-session 加进 profile 的 dsh.profile.bundles 并重载
```

## 安装（GitHub / 公共分发）

仓库准备发布后（私有仓库同样适用），可以直接按 Git 源安装：

```bash
dsh plugin --profile desktop add github:<你的账号>/dsh-parallel-session
```

或在 GUI 的 **Plugins → Add plugin** 里填 `github:<你的账号>/dsh-parallel-session`，装完 **Enable now**。

`lib/` 已随仓库提交，安装后不需要再构建；想自己构建就 `bash scripts/build.sh`。

## 兼容性与风险

- 基于 **DSH 0.2.2-rc.1** 的宿主服务实现（`sessionController` / `permissionPresets` / `sessionTitle` / `workspaceRegistry` / `sandboxPolicy` 等），**不是公开 SDK**，大版本升级后可能失效；升级 DSH 后请先跑 `bash scripts/build.sh` 的自检，再在真实会话里冒烟一次。
- 权限收敛依赖宿主挂载 `permissionPresets`；缺失时插件会 **fail-closed** 拒绝创建，而不是退回不安全默认值。
- 插件不读取、不写入任何外部凭据；调试日志只记会话 id/模型/权限等元数据，不记用户内容。

## 相关项目

- [dsh-session-bridge](https://www.npmjs.com/package/dsh-session-bridge) / [dsh-bridge](https://www.npmjs.com/package/dsh-bridge)：给已有会话发消息、等回复的“会话桥”。
- 本插件的定位不同：它开的是**新的平级会话**，重点在「继承父会话配置 + 上文交接 + 权限不越权 + 一键打开」，不是跨会话消息总线。

## 许可

BSD-3-Clause，见 [LICENSE](LICENSE)。

## 模型看到的工具

工具名：`spawn_parallel_session`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `context` | ✅ | 交给新会话的上文交接说明。新会话看不到当前会话的聊天历史，必须写全：目标、已定决策、文件/路径、约束、下一步 |
| `title` | | 新会话标题（会用 `sessionTitle.rename` 写入，方便在侧栏认出来） |
| `provider` + `model` | | 覆盖新会话模型；两个必须同时给。默认继承当前会话 |
| `reasoning_effort` | | 覆盖思考等级（`low` / `medium` / `high`…）。默认继承；换模型后不支持时退回模型默认 |
| `workspace` | | 新会话工作目录（绝对路径）。默认用当前会话所属工作区；可传该工作区内的子目录，越界会被拒绝 |
| `permission` | | 新会话权限预设。只接受非完全权限（通常是 `read-only` / `workspace-write`） |
| `start` | | 默认 `true`：上文作为第一条用户消息立即送达并开始一轮简短确认；`false`（字符串 `"false"` 也认）：只暂存为待发送输入，用户发第一条消息时一起送达 |

工具只能由**顶层会话**调用：子代理 / Agent Teams 成员调用会被拒绝（防止后台代理凭空造用户可见会话、递归刷会话）。

成功结果（同时是卡片数据源）：

```json
{
  "ok": true,
  "sessionId": "session-…",
  "title": "会话标题",
  "cwd": "/Users/huakaifugui/Workspace",
  "workspace": "Workspace",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "reasoningEffort": "high",
  "permission": "workspace-write",
  "permissionNote": "父会话权限是「auto」（完全权限）。按规则平行会话不能继承完全权限，已降级为「workspace-write」。",
  "start": true,
  "delivery": "started",
  "hint": "平行会话已开好，用户点卡片里的「打开会话」即可直接继续对话。"
}
```

## 权限规则（重要）

- 平行会话的权限默认继承当前会话，但**任何情况下都不会是「完全权限」**：
  - `danger-full-access` 预设被排除；
  - `auto`（Auto review）预设的沙箱也是完全权限，同样被排除。
- **平行会话的权限不会比父会话更宽**：按 `read-only < workspace-write < danger-full-access` 比较。父会话只读时，子会话最多只读；父会话是完全权限时，子会话自动降级为 `workspace-write`，并在 `permissionNote` 里说明。
- 显式传 `permission=danger-full-access` / `auto` / 比父会话更宽的预设会直接报错，**且在创建会话之前就被拒绝**（不会留下孤儿会话）。
- 宿主缺少 `permissionPresets` 服务时 **fail-closed**：无法证明不是完全权限就不创建。
- 落盘后会再读一次实际权限（优先用权威的 `sandboxPolicy.resolve()`），确认没有停在完全权限上；失败会归档半成品会话并返回 `ok:false + sessionId`。
- `workspace` 只能指向父会话工作区内部（按 realpath 后的路径段比较，符号链接也算数），越界拒绝。

## 上下文交接 & start 语义

- `start=true`（默认）：上文以「用户消息」写入新会话并立即开一轮；消息末尾带一句「本回合只需确认已了解上文、等待用户指示」，避免新会话自作主张开工。
- `start=false`：上文写入新会话的 `next-step` 待发送输入（持久化），不会开跑；用户在新会话发第一条消息时，上文会作为同一轮的前置输入一起送达。
- 没传 `title` 时，插件从 `context` 首行派生标题并写入（避免宿主自动标题把交接头当标题）；显式 `title` 优先。
- 上文正文由插件加一段固定头：`【并行会话上文】以下内容由另一个 DSH 会话「<父会话标题>」转交…`，让新会话知道这是转交的上下文而不是用户原话。

## 聊天里的结果卡片

client 插件注册了 `tool.call.toolview / spawn_parallel_session`，每次调用在聊天里显示一张卡片：

- 标题行：`平行会话 · <标题>`
- 元信息行：模型 · 推理等级 · 权限 · 工作区
- 右侧主按钮 **「打开会话」** → 调 `uiWorkspace.openSession(sessionId)` 把该会话切到主区域
- 悬浮提示里放 `permissionNote` / `modelNote` / `titleNote`，不占卡片正文
- 失败时显示红色紧凑失败行；结果未到时显示「正在创建平行会话…」
- 新会话刚创建、客户端会话列表还没收到时点「打开会话」会在 600ms 后重试，避免“点了没反应”。

## 开发与自检

```bash
cd /Users/huakaifugui/Workspace/dsh-parallel-session
bash scripts/build.sh          # src → lib + 五段自检
```

自检内容：

1. host 入口导出与工具定义契约；
2. `scripts/check-host.cjs`：用 fake ctx 跑 execute，覆盖继承、权限收敛（含“不比父会话更宽”）、非法覆盖、缺权限服务 fail-closed、workspace 越界、暂存模式、创建后失败归档、子代理拒绝、标题派生、输出契约；
3. host 不 import 任何 `@deepseek-ai/*` 包（避免 profile 里旧版本副本混入）；
4. `scripts/check-client.cjs`：ModuleLoader 注册、slot 注册、卡片各状态渲染与按钮行为；
5. `src → lib` 同步。

改完代码让宿主重载插件（不必重启应用）：

- GUI：Plugins 页把这张 bundle 关掉再打开；或
- 直接调 `plugin_manager` 的 `set_bundle`（enabled=false → true）；或
- 触发一次 profile 重装配（HMR 会替换掉链接目录里变化过的文件）。

调试日志：`$DSH_HOME/storages/parallel-session/events.jsonl`（缺省 `~/.dsh/...`；每次成功创建会话一行 JSON，含父会话 id、新会话 id、模型、权限、是否 start、上文长度；创建后失败也会记一行 `spawn-failed`）。

## 目录

```
dsh-parallel-session/
├── package.json          # bundle(patch) + client(dsh.client) 声明
├── cordis.patch.yml      # bundle 层：插入 host 插件行
├── src/index.js          # host：spawn_parallel_session 工具
├── src/client/index.js   # client：结果卡片 + 「打开会话」按钮
├── scripts/build.sh      # 自检 + src → lib
├── scripts/check-host.cjs
├── scripts/check-client.cjs
└── lib/                  # 构建产物（DSH 实际加载这里）
```

## 已知边界

- 新会话只继承**工作区/模型/权限/agent preset**，不继承聊天历史；历史只能由当前会话写进 `context`（这是设计目标，不是缺陷）。
- 只能从顶层会话调用；子代理和 Agent Teams 成员被拒绝。
- `context` 上限 100,000 字符，超出直接报错。
- 权限只允许非完全权限；若部署把全部预设都配成完全权限，工具会拒绝创建。
- 创建会话复用官方 `sessionController.create()`：会走预设、持久化、侧栏分组（标题由插件 `sessionTitle.rename` 写，create 本身不碰标题）；父会话不属于任何工作区时，新会话落在父会话当前目录，可能显示在「未分组」。
- 没有删除会话的 API；测试产生的会话用 `workspace/archiveSession` 归档。创建后失败时插件会自动归档半成品会话。
- 会话标题上限受部署配置约束（当前 80 字节），插件按 72 字节截断后写入。
- 卡片依赖 client 插件热加载；如果 GUI 里暂时看不到卡片，刷新一次页面即可。

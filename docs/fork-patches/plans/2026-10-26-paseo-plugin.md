# Paseo 插件计划（plugin/paseo）

| | |
|---|---|
| 状态 | 第二版：已按顾问审核意见修订（第 11 节）；第 12 节两项已定，P0–P3 在隔离环境开工，P4 等旧客户端事故修完 |
| 日期 | 2026-10-26 |
| 范围 | 用户已定：先做加入/停止同步、同步状态、记忆面板；入口按第 12 节改为工作区右上角按钮，不做自动加入 |
| 分支基线 | `fork-rebuild` = `7f357c9`（release `fork-2026.10.26.3`，30 个补丁） |
| 目标宿主 | Paseo 0.13.0（开发机上的 daemon（`pluginsEnabled: true`）；笔记本的桌面版 daemon）；另一台机器装了 0.13.1，daemon 未运行 |
| engram 服务 | 每台机器一个 `engram serve`，`127.0.0.1:7437` |

这份文档放在 `docs/fork-patches/` 下，不进补丁序列。

## 1. 目标

Paseo 里的 Claude、Codex、Pi、DSH agent 已经各自接好了 engram，缺的是只有 Paseo 这一层才看得到的三件事：

1. **加入/停止同步**：工作区右上角提供按钮，加入前扫描疑似含密码的 prompt，加入后可明确确认停止本机上传；不再向时间线写卡片。
2. **同步状态**：侧边栏底部一行，显示当前宿主上 engram 的同步状态，出问题时一眼能看到。
3. **记忆面板**：工作区里的一个面板，按当前项目搜索、浏览记忆和最近的 prompt，可以删除单条。

## 2. 已核实的事实

以下内容是在 engram `7f357c9` 和 Paseo `v0.13.0`（`d34d17a9`）上读代码或实测得到的。凡是顾问纠正过的地方，都单独注明。

**engram**

- **加入同步只在本机生效**：`engram cloud enroll` 调用 `Store.EnrollProject`（`cmd/engram/cloud.go:891`）。`EnrollProject` 不只是往 `sync_enrolled_projects` 插一行，它会在同一个事务里，把这个项目历史上的 session、observation、prompt、删除标记和 relation 全部回填成待推送的变更（`internal/store/store.go:9173`、`:10754`）。项目在库里还没有任何数据时，也可以先加入（`store.go:6543`）。目前没有对应的 HTTP 接口，也没有自动加入。
- 插件要用到的现有接口：`GET /project/current?cwd=`、`GET /search`、`GET /observations/recent`、`GET /observations/{id}`、`GET /prompts/recent`、`GET /prompts/search`、`DELETE /observations/{id}`、`DELETE /prompts/{id}`、`GET /sync/status`、`GET /health`。
- `GET /project/current` 的响应**始终**带 `available_projects` 字段，项目明确时它是 null。所以判断项目有没有歧义，要看这个字段是不是非空，不能看字段在不在（`internal/server/server.go:1690`）。
- `DELETE /observations/{id}` 必须带 `expected_project`：不带返回 400，项目对不上返回 409（`server.go:1094`）。`DELETE /prompts/{id}` 目前只认 ID，不检查记录属于哪个项目。
- **删除 prompt 不一定立刻同步**（顾问纠正）：如果项目已经加入同步，删除时会入队一条 `delete` 变更；如果还没加入，只写删除标记，等以后加入同步时再由回填带上去（`store.go:5278` 起，`:5316`、`:11660`）。
- `GET /prompts/recent` 返回 prompt 的完整原文（`store.go:5034`、`server.go:1299`）。
- `redactSecrets` 只认固定格式的密钥（GitHub token、`sk-`、AWS key、Slack token、PEM 私钥），「密码是 xxx」这种写法会原样入库。开发机和笔记本上各有约 160 条 prompt 提到「密码」或「password」，其中有真实密码（记忆 #24005）。
- **本地鉴权**（顾问纠正，列表比我原来写的长）：
  - `requireAuth`：配置了 `ENGRAM_HTTP_TOKEN` 时要求 Bearer，没配置时不检查。受它保护的有删除 prompt、删除 session、导入导出、`/compatibility`，以及运行时路由里标了需要鉴权的那几个：删除 observation、consolidate、judge-many、session finalize（`internal/server/runtime_contract.go:58`）。
  - `requireConfiguredAuth`：没配置 `ENGRAM_HTTP_TOKEN` 时直接返回 503（`server.go:240`），目前只用在 `/projects/migrate` 和 `/projects/rescue-ownership` 上。
  - 本机 serve 没有配置 `ENGRAM_HTTP_TOKEN`。
- **运行时契约**（顾问纠正）：契约投影只包含记忆操作绑定的那些路由，以及 4 个写死的辅助路由（`runtime-session-resolve`、`runtime-session-end`、`prompt-capture-decision`、`compaction-context`），见 `runtime_contract.go:110`、`:146`。新增的路由只要不绑定到任何操作、也不加进这 4 个之一，投影就不会变。比对方式：DSH 用 `isDeepStrictEqual`（`plugin/dsh/lib/contract.ts:20`），Pi 用递归的 `sameProjection`（`plugin/pi/runtime-contract.js:6`），两者都是严格比对。
- **`/sync/status` 的语义**（顾问纠正）：`enabled=false` 不只表示「serve 没开云同步」，项目没加入、项目范围缺失、配置错误都可能让它变成 false；manager 不存在时，走持久化状态的那条路径甚至可能返回 true（`cmd/engram/main.go:385`、`:478`，`cmd/engram/autosync_status.go:25`）。`last_sync_at` 有时取自 manager 内存，有时取自持久化状态。另外还有 `upgrade` 暂停、`phase=degraded` 两种状态。字段里没有待推送条数。

**Paseo 0.13**

- 文档：`https://paseo.sh/docs/plugins/reference.md`。
- `server.on("agent.created" | "agent.turn_started" | ...)`：事件只在发生时投递一次，不会重放；`agent.created` 不包括导入和恢复出来的 agent。事件里能拿到 `agent.cwd`、`agent.parentAgentId`、`workspace.cwd`。
- `paseo.agents.ref(id).timeline.append(...)`：相同 `id` 会替换原来那一行；`data` 不超过 64 KiB；这些行只存在 daemon 内存里，daemon 重启后就没了。
- **时间线卡片的渲染组件里可以调用 `useRpc`**（顾问核对了 v0.13.0 源码：renderer 外层包着 `PluginInstallationProvider`，它提供了 `PluginRpcProvider`，见 `packages/app/src/plugins/timeline/view.tsx:83`、`installation-provider.tsx:19`）。组件拿到的参数有 `agentId`、`item`、`timestamp`、`theme`、`host`、`layout`。
- 客户端 `useWorkspace` 拿到的工作区对象里，目录字段叫 `directory`，不叫 `cwd`（顾问纠正）。`addWorkspacePanel` 的 `context: "workspace"` 已经弃用，目前仍然兼容。
- **主机设置（`scope: "host"`）只能从客户端写**：服务端拿到的设置句柄只有 `read()` 和 `subscribe()`（顾问核对，`packages/plugin/src/server/contracts.ts:25`）。客户端用 `useSettings().save(values, revision)` 保存。
- **插件不能 import 自己目录以外的代码**：v0.13.0 的插件编译器会拒绝越出插件根目录的 import（`packages/server/src/server/plugins/compiler.ts:77`）。所以不能直接复用 `plugin/dsh/lib`。
- 没有「发送 prompt 之前」的钩子。插件按 daemon 安装，是不受沙箱限制的代码。`~/.paseo`、`~/.paseo-aivideo`、`~/.paseo-nautilus` 没有打开插件开关，要打开须经用户同意。

## 3. 不做的事

- 不注入 engram MCP，不按白名单自动加入，不拦截 prompt，不做 `/private` 命令。
- 插件不经手云端 token，不改 `cloud.json`，不读任何 `.env`。
- 不发布到公共插件目录。
- 不自动拉起 engram serve，只报告「服务不可用」。理由：插件拉起的 serve 环境变量可能不对，会重现笔记本上「serve 没带 token、同步停摆」的问题。
- 不在加入同步时立即触发推送，交给自动同步去推（见 4.5）。
- 第一版不提供「查看 prompt 原文」（见 4.3）。
- 不负责修复同步协议本身的问题，比如离线多日的旧客户端回来后用旧数据覆盖新数据（记忆 #24011）。这个由另一项工作处理，见第 9 节。

## 4. 设计

### 4.1 目录与安装

```
plugin/paseo/
  paseo-plugin.json      { "id": "engram", "requirements": { "paseo": ">=0.13.0" } }
  OVERVIEW.md  package.json  tsconfig.json
  index.client.tsx  index.server.ts
  client/  server/  shared/
  test/
```

- 每台跑 Paseo daemon 的机器各装一份：`paseo plugin install <仓库>/plugin/paseo --home <daemon home>`。
- **部署顺序**：先升级 engram serve，再装插件。插件比 serve 先装、或者 serve 回滚了，都要能正常工作，规则见 4.2。
- 运行时依赖只用 Paseo 自带的 `@getpaseo/plugin`、`zod`、`react-native`。

### 4.2 engram 客户端（server/engram.ts）

单独写一个，不复用 DSH 的客户端。DSH 那个带自动重试、运行前检查和不可用回调，和这里的请求策略不一样；只借鉴它处理取消、脱敏和「写入结果未知」的做法。

- **基址**：从主机设置 `engram.baseUrl` 读，默认 `http://127.0.0.1:7437`。只接受 loopback 地址的 HTTP，拒绝重定向。
- **鉴权**：daemon 进程环境里有 `ENGRAM_HTTP_TOKEN` 时，带上 `Authorization: Bearer`。token 不存进 Paseo 设置，不写日志，不传给客户端。
- **超时**：每个请求 5 秒，不自动重试。
- **能力探测**：读 `GET /health` 里的 `capabilities`，看有没有 4.3 新增的管理能力标志（`sync-admin-v2`，同时兼容保留 v1 的只读能力），不靠 404 来判断。探测结果只缓存 60 秒，失败后可以重新探测，不会把「不支持」永久记下来。缺少某项能力时，就禁用对应的按钮或面板，并提示「engram 版本太旧」。
- **错误分类**：
  - `unavailable`：连接被拒绝或连接超时；
  - `unsupported`：缺少能力标志；
  - `outcome_unknown`：写请求已经发出，但没收到响应；
  - `http_error`：其他错误，带上服务端返回的结构化错误码（`code`）。

  业务上的 404（比如项目不存在）属于 `http_error`，不当成「版本太旧」。
- **实例绑定**：记下 `/health` 返回的 `instance_id`。所有删除和加入请求都带上这个 `instance_id`，服务端发现对不上就拒绝。这样可以防止面板切换主机或数据库之后，误删了另一个库里的记录（4.3 有对应的接口改动）。

### 4.3 Go 端改动（fork 补丁）

按 `plugin-thin` 规则，判断逻辑都放在 Go，插件只负责调用和展示。新增的路由**不绑定任何记忆操作，也不加进那 4 个辅助路由**，所以 Pi 和 DSH 的契约投影不变。理由是职责不同：这些接口给管理界面用，不属于记忆协议。

| 路由 | 鉴权 | 作用 |
|---|---|---|
| `GET /health`（加字段） | 无 | `capabilities` 同时提供 `sync-admin-v1` 和 `sync-admin-v2` |
| `GET /sync/enrollment?project=P` | 无 | 返回 `{project, enrolled, cloud_configured, autosync_enabled, instance_id}`。`cloud_configured` 表示云端地址和 token 都齐了 |
| `GET /prompts/secret-scan?project=P&cursor=C` | 见第 12 节 | 分页扫描这个项目的 prompt，返回 `{items, next_cursor, complete, scan_token}`。`items` 里每条是 `{id, created_at, session_id, reason, masked_context}`，不含原文。`scan_token` 由项目、prompt 总数、最大 id 和最后修改时间算出来 |
| `POST /sync/enrollment` `{project, instance_id, scan_token \| force}` | 见第 12 节 | 加入同步，走 `EnrollProject`，幂等。项目名先过 `NormalizeProject`；项目在库里还没有数据也允许加入。带 `scan_token` 时，服务端在同一个事务里重算一次，结果对不上就返回 409 `scan_stale`，要求客户端重新扫描；`force: true` 表示用户明确选了「仍然加入」 |
| `DELETE /sync/enrollment?project=P&instance_id=I` | requireLocalAdmin | 幂等调用 UnenrollProject，匹配实例，返回 GET enrollment 状态；DELETE 无请求体不检查 Content-Type |
| `GET /prompts/recent`、`GET /prompts/search`（加参数） | 无 | 新增 `masked=1`。带上这个参数时，每条 prompt 的内容都用和扫描一样的规则打码。插件请求 prompt 一律带 `masked=1` |
| `DELETE /prompts/{id}`（加参数） | 不变 | 新增可选的 `expected_project` 和 `instance_id`，在事务里检查记录确实属于这个项目，对不上就返回 409。不带这两个参数时，行为和原来一样 |
| `GET /sync/status`（加字段） | 无 | 增加 `target: "cloud"`；`pending_count`，指 `cloud` 这个目标下未确认的变更条数；`last_success_at`，取自 `sync_state` 里 `cloud` 那一行；`status_at`，即生成这份状态的时间；`paused`，在升级暂停时为 true。每个字段的取值范围都写清楚，不复用只统计 `cloud:<项目>` 的 `CloudSyncSummary` |

- **疑似密码的判定规则**：关键词（密码、口令、password、passwd、pwd、token、secret、api key、apikey）后的显式赋值保持 4 字符规则并支持 is。中文「密码/口令」后仅隔空白或「是/为/:/=/：」的第一个 ASCII 可见串 `[!-~]{4,}` 一律遮蔽，包括纯字母值；英文仍需显式连接词或密码形态，保留 password policy、token budget、secret key。关键词后 60 个 Unicode 字符窗口内的疑似值也检查，值至少 6 字符且字母+数字或含特殊符号；规则 B 检查关键词后 600 个 Unicode 字符内开始的单行 ASCII 词（6–64 字符且同时含字母与数字，可带 [User]、[用户]、User: 等前缀）。明显 URL/路径除外；窗口只限制值的起点，命中后整段替换为 `[已遮蔽]`，不保留首尾字符。与固定格式密钥规则共用于展示列表、扫描和错误文本，不改存储 redactSecrets。无关键词的单行 abc1234def、open-u60-pro、x86_64 和「密码输入处」等中文正文不遮蔽；接受多遮，只承诺遮住检测到的值。
- **测试**：
  - 每个接口写 handler 测试，覆盖鉴权、项目不存在、重复加入、`scan_token` 过期、`instance_id` 不符、删除 prompt 时项目不符；
  - 规则表写正例和反例，并用虚构的秘密值确认它不会出现在任何响应里；
  - store 层测试确认加入同步会回填变更；
  - 契约测试确认投影不变，即 Pi 和 DSH 内置的 `runtime-contract.json` 和服务端一字不差。

### 4.4 功能 1：工作区右上角同步按钮

- 每个当前工作区用 `client.addHeaderButton({id, workspaceId, button})` 注册一个按钮，使用 `update()` 更新；手机由宿主收进工作区「···」菜单。通过 `client.paseo.workspaces.list({subscribe:{}})` 的 owned subscription 登记、更新、移除工作区，卸载时取消订阅、清理轮询和所有按钮。原始 SDK 字段为 `workspaceDirectory`，`useWorkspace` 的 selector 字段仍为 `directory`。
- 订阅和分页均不传 `includeBackground`，同步按钮只面向普通工作区，不要求宿主声明 `features.backgroundWorkspaces`。SDK 会在网络请求前拒绝未声明的后台能力。`page.limit` 统一为协议上限 200，超过一页时继续按非空游标获取全部工作区；测试假 SDK 同时使用真实协议 schema 校验参数。订阅、快照及错误回调保留分类码和经清理的错误信息，整条日志截断至 200 字符；真实宿主声明、连接订阅、桌面/手机呈现仍需 P4 验证。
- 用目录调用 `GET /project/current`。有歧义或解析失败时显示「engram：选择项目」，点击打开记忆面板；选择会同步到按钮。服务不可用、版本太旧时显示对应错误，不隐藏按钮。未配置云同步时显示「engram：未配置云同步」，点击打开状态页。
- 未加入且已配置云同步时显示「加入同步」。按钮是 popover 描述符，首次点击后在 popover 中显示扫描进度；完整扫描后，没有疑似项就带 scan_token 加入并关闭，有疑似项则保留处理界面，可逐条确认删除、「重新扫描后加入」「仍然加入」「先不加入」。复用原 shared/enrollment 状态机，保留 scan_stale 重扫与结果未知时只读确认，不自动重放。
- 已加入显示「已同步」，菜单含「停止同步」「打开 engram 记忆」「查看同步状态」；该标签只代表加入开关，不是云端传输完成证明。只有 v1 的服务仍显示加入状态，但禁用停止项、提示版本太旧；加入和停止操作要求 v2。
- 停止通过 `DELETE /sync/enrollment?project=P&instance_id=I`，继承本地 Host/Origin/auth 检查，不要求 Content-Type。确认框写清项目名、主机名，提供「停止同步」「取消」。v2 同时保留 v1 能力标志。
- 实测确认文案：新记录不再排队上传；已有积压保留但失去上传资格，重新加入后继续上传；入站变更仍会应用；已上传内容不删除。停止期间新建记录会补推，但对已 ack 同项目记录的修改不会自动补推；已发出的请求可能继续完成。保留积压可能让状态显示阻塞。详见 HTTP 工作流和隔离测试报告。
- 注册时、点击后、操作完成后与每 60 秒刷新，仅检查仍存在的工作区。同项目并发状态、加入和停止请求合并，面板与按钮共用实例绑定和操作状态。轮询更新相同行为时不替换 behavior，避免宿主关闭正在处理的 popover。
- 删除时间线 renderer、agent.created/turn_started 检查器、卡片组件和 ignoredProjects/忽略功能。面板顶部显示加入状态并复用同一操作组件。

已加入且出现在 blocked_projects 中的项目，按钮显示错误样式的「云端未放行」，菜单包含停止同步和查看状态；面板及侧边栏列出项目名并提示云端白名单配置。字段是最近拒绝证据，按原退避下一次成功后或停止同步后清除，不改云端与退避。

### 4.5 功能 2：同步状态

- 用 `addSidebarFooterItem` 加一个 `SidebarRow`，显示「engram @ <宿主名>」加一个状态点。宿主名要明确写出来，因为 Paseo 只显示一份侧边栏项，它跟随的是当前选中的宿主，不一定是当前工作区所在的宿主。
- 客户端每 30 秒调一次 RPC `status.get`，服务端去调 `GET /sync/status`。

| 级别 | 条件 |
|---|---|
| 红 | `blocked_projects` 中有 project_not_allowed；`unavailable`；鉴权或策略被拒；`consecutive_failures >= 3`；`phase = degraded`；`cloud_configured = false` 但有已加入同步的项目 |
| 黄 | `dead_count > 0`（保留的证据，需人工查看，不一定表示当前故障）；`paused`（升级暂停）；`deferred_count > 0`；`backoff_until` 是未来的时间；`pending_count > 0` 且 `last_success_at` 早于 10 分钟前；`status_at` 早于 2 分钟前（状态过期） |
| 灰 | `unsupported`；本机没有任何项目加入同步 |
| 绿 | 以上都不满足 |

- 点击这一行弹出 popover，列出原始字段和取值范围。`last_error` 由服务端用打码规则处理之后再返回。
- popover 底部固定写一句：「绿色只说明传输正常，不能说明内容没有被旧客户端覆盖」。

### 4.6 功能 3：记忆面板

- 用 `addWorkspacePanel({ id: "memory" })` 加面板，用 `useWorkspace(id, w => w.directory)` 拿工作目录，再加一个 Command Center 项「打开 engram 记忆」。
- 打开时经 RPC 调 `GET /project/current` 解析项目，标题写成「项目名 @ 宿主名」。项目有歧义时，列出候选项目让用户选。
- 三个标签页：
  - **搜索**：`GET /search`；
  - **最近记忆**：`GET /observations/recent`；
  - **最近 prompt**：`GET /prompts/recent?masked=1`，另有一个「只看疑似含密码」开关，打开后改走 `secret-scan`。
- 删除前二次确认，确认框里写清楚：已加入同步的项目，删除会同步到其他机器；未加入的，要等以后加入同步时才会带上去。
  - 记忆走 `DELETE /observations/{id}?expected_project=&instance_id=`；
  - prompt 走 `DELETE /prompts/{id}?expected_project=&instance_id=`。
- 面板顶部还有：同步加入状态、「加入同步」入口（和右上角按钮共用状态机）。
- 只用 React Native 原生组件，颜色一律从 `theme.colors` 取，`layout.compact` 时改单列布局。

### 4.7 RPC 清单（shared/rpc.ts）

`health.probe`、`status.get`、`project.resolve`、`enroll.status`、`enroll.scan`、`enroll.join`、`memory.search`、`memory.recent`、`memory.get`、`memory.delete`、`prompts.recent`、`prompts.delete`。

输入输出都用 zod 定义。客户端拿到的内容里不会有 token，也不会有 prompt 原文（都是 `masked=1` 的结果）。停止同步新增 `enroll.stop` RPC，必须有 v2 能力。

## 5. 阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | Go 端补丁：4.3 的全部改动和测试 | `go test ./internal/server/ ./internal/store/ ./cmd/engram/` 通过；Pi、DSH 的契约投影测试不变 |
| P1 | 插件骨架、engram 客户端、功能 2 | typecheck 通过；装在测试安装 ID 上能跑起来；临时 serve 分别处于停掉、暂停、鉴权失败、有积压、状态过期时，不会显示绿色 |
| P2 | 功能 3 | 在临时 serve 上走通搜索、查看、删除；prompt 返回给插件的都已打码；切换实例后拒绝删除；手机布局检查 |
| P3 | 功能 1 | 工作区按钮能出现，三种按钮路径、扫描过期、超时待确认都要走通；登记/注销、60 秒轮询和同项目合并请求正确；加入→停止→再加入往返通过 |
| P4 | 实装与登记 | 在开发机的 daemon 上实测；笔记本的桌面版 daemon 要用户同意后再装；登记 fork 补丁，更新 README |

## 6. 测试与隔离

- **临时 serve**：临时 `ENGRAM_DATA_DIR`、非 7437 端口，并用 bash 包装脚本清掉所有继承来的 `ENGRAM_*` 变量（zsh 不会对 `$VAR` 分词，这个坑已经踩过）。
- **测试安装**：用独立的安装 ID（`paseo plugin install ... --id engram-test`）指向临时 serve，不去改正式安装的 `baseUrl`。正式安装只有到 P4 才装。
- **假云端**：所有假云端地址都必须是 loopback；测试里要断言没有任何出站连接到非 loopback 地址，光确认「没连云端服务器」不够。
- **秘密值**：用虚构的秘密值覆盖普通列表、扫描结果、错误信息、RPC 返回值和时间线 `data`，确认原值一处都没漏出来。
- **插件单测**：server 侧的 handler 和 engram 客户端，用 Node 内置的 test runner 起一个假 HTTP 服务来测。包括这些场景：服务端已经提交但响应丢了、实例切换、项目改名、跨项目的 ID。
- **真实宿主**：在测试安装 ID 上做 `install`、`reload`，看 `logs`；桌面窗口和窄窗口各看一遍，深色和浅色主题各看一遍。

## 7. 安装与回滚

- 安装：先升级 engram serve，再 `paseo plugin install /abs/plugin/paseo --home <daemon home>`，然后 `paseo plugin ls` 确认状态为 running。
- 回滚：`paseo plugin remove engram --home <daemon home>`。Go 端的新接口不影响其他客户端，不需要回滚。
- 已经加入同步的项目可以用 `engram cloud unenroll` 撤销，但已经推上去的数据不会撤回。

## 8. fork 补丁登记

- 0031 `feat(server): sync admin endpoints and masked prompt projection`
- 0032 `feat(plugin): Paseo adapter`

CI 加一步 `plugin/paseo` 的 typecheck 和单测。`docs/fork-patches/README.md` 更新补丁数和说明。

## 9. 风险

- **高：扫描完到真正加入之间，可能又进来了新 prompt**：靠 `scan_token` 加服务端重算来解决（见 4.3）。但扫描只覆盖 prompt，记忆正文里也可能有密码，界面上要写明这一点。
- **高：本地 HTTP 接口没有鉴权**：没配置 `ENGRAM_HTTP_TOKEN` 时，`requireAuth` 等于没有保护。加入同步会扩大推上云端的数据范围，以前只能用 CLI 做，开放到 HTTP 上以后，本机任何进程都能调用；如果没有 Origin 检查，浏览器页面也可能借用户的身份发起这类请求。处理方式待第 12 节决定。
- **高：状态灯可能误报绿色**：已经按 4.5 补上暂停、degraded、鉴权失败、状态过期这几种情况，并且给字段写明了取值范围。
- **高：旧客户端事故**（记忆 #24011）：一台离线多日的旧客户端，回来后用旧数据把改名和内容回退了。加入同步会扩大同步范围，这类事故的影响也会跟着变大。在正式扩大同步范围之前，要先确认这台旧客户端已经被拦住（另一项工作正在处理：轮换共享 token），并且受影响的数据已经恢复。插件的绿灯不能用来证明这件事已经解决。
- **中：删错库**：面板切换宿主或数据库后，可能拿着旧 ID 去删另一个库里的记录。靠 `instance_id` 和 `expected_project` 防住（见 4.2、4.3）。
- **中：远程客户端的权限**：通过 Paseo 配对的客户端（包括手机）都能删除记忆、加入同步。这和 Paseo 本身已经能操控 agent 的权限是同一级别，要在 `OVERVIEW.md` 里写明。

## 10. 参考

- Paseo 插件参考：`https://paseo.sh/docs/plugins/reference.md`（2026-10-26 抓取）；Paseo 源码 `v0.13.0`（`d34d17a9`）
- DSH 适配器计划：`docs/fork-patches/plans/2026-10-25-dsh-adapter.md`
- 仓库规则：`skills/plugin-thin/SKILL.md`、`skills/architecture-guardrails/SKILL.md`、`skills/server-api/SKILL.md`、`skills/business-rules/SKILL.md`
- 相关记忆：#24005（prompt 里的明文密码）、#24008（Paseo 没有 engram 插件）、#24011（旧 token 客户端重推）、#24027（范围决定）

## 11. 顾问审核与采纳情况（2026-10-26，advisor `7d5f8402`）

顾问的结论是：改完再开工，方向不用重想。顾问只做了静态核对，没有编译或运行任何东西。下表中的事实纠正，主 agent 抽查了投影白名单、`requireConfiguredAuth`、删除 observation 必须带 `expected_project`、未加入同步时删除 prompt 不入队这几条，都成立。

| 第一版的问题 | 顾问意见 | 采纳 |
|---|---|---|
| 1. 新接口放在契约之外，靠 404 判断版本 | 放在契约外可以，但要用能力标志来判断，不能靠 404；先升级 serve 再装插件；「不支持」的判断不能永久缓存 | 采纳（4.2、4.3） |
| 2. 是否复用 DSH 的客户端 | 编译器禁止跨目录 import，单独写一个，借鉴它的取消和「结果未知」处理 | 采纳（4.2） |
| 3. 原文要不要传到客户端 | 第一版不提供；普通 prompt 列表也必须打码；命中的值整段替换；不要诱导用户删除 | 采纳（4.3、4.4） |
| 4. 卡片的触发时机 | 以 `agent.created` 为主，用 `agent.turn_started` 补查；不要永久地「每个项目只提示一次」 | 采纳（4.4） |
| 5. 加入后要不要立即同步 | 不要，交给自动同步；成功只说明本机已加入；超时要按「结果待确认」处理 | 采纳（4.4） |
| 6. 「忽略」存在哪 | 存主机设置，但要从客户端写，并按 engram 实例区分 | 采纳（4.4） |
| 7. 旧客户端事故 | 插件解决不了，绿灯也证明不了它已经解决；正式扩大同步范围前，先确认旧客户端已被拦住、数据已恢复 | 采纳（第 9 节） |

另外采纳的事实纠正：契约投影的范围、Pi 的比对方式、删除 prompt 有条件同步、鉴权路由列表、客户端工作区字段叫 `directory`、删除 observation 必须带 `expected_project`、`available_projects` 始终存在、`enabled=false` 的含义、时间线卡片里可以用 `useRpc`。

实现阶段修订：`dead_count > 0` 改为黄灯；上游保留无害的放弃记录作为证据直至到期清理，不能仅据此把当前传输判为故障。

## 12. 用户决定（2026-10-26 已定）

- **2026-10-27 用户决定**：入口改为工作区右上角按钮，去掉卡片和忽略；新增停止同步。

- 鉴权采用 **A**：`requireAuth`，再加 JSON、loopback `Host`、拒绝带 `Origin` 头三项检查。
- 先在隔离环境里做 P0 到 P3；P4 正式安装等旧客户端事故修复（轮换共享 token、恢复数据）完成之后再做。

以下是当时提给用户的选项，留作记录。

1. **新接口要不要强制鉴权**：加入同步、扫描接口用哪种鉴权？
   - **A（推荐）**：用 `requireAuth`，同时要求请求是 `Content-Type: application/json`、`Host` 是 loopback、并且不带浏览器的 `Origin` 头。好处是不用给每台机器配 `ENGRAM_HTTP_TOKEN`，也能挡住网页借用户身份发起的请求。剩下的风险是本机任何进程都能调用，但这和本机进程本来就能直接跑 `engram cloud enroll` 是同一级别。
   - **B**：用 `requireConfiguredAuth`。每台机器的 serve 都要配 `ENGRAM_HTTP_TOKEN`，Paseo daemon 的环境里也要有同一个值，这需要重启 Paseo daemon（每次都先请你同意），Pi 和 DSH 插件也要能拿到这个 token。
2. **开工时间**：开工前是否要等旧客户端事故修复完成（轮换共享 token、恢复数据）？建议 P0 到 P3 在隔离环境里先做，P4 正式安装要等事故修复完成之后。

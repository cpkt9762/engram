# DSH 适配器计划（plugin/dsh）

| | |
|---|---|
| 状态 | Q1–Q5 已定（第 11 节），从 P0 开工 |
| 日期 | 2026-10-25（同日按决定修订） |
| 目标 profile | `acp`（Paseo 实际启动的 profile，见 8.1） |
| 分支基线 | `fork-rebuild` = `3975618`（上游基线 `fc43849`）；`upstream/main` = `f82c184`（v3.6.0+5，比基线多 125 个提交） |
| 参考实现 | `@ian_p/dsh-gentle-engram` v0.7.3（MIT，GitHub `ForeverYoungPp/dsh-gentle-engram` `18b4c9e`）；上游 `plugin/pi`（gentle-engram 0.5.1） |
| 目标宿主 | DeepSeek Harness（DSH）0.2.0-rc.2，运行在 Node 22.23.3 上 |

这份文档放在 `docs/fork-patches/` 下，不会进补丁序列（`regenerate.sh:26` 会跳过只改这个目录的提交），
也不影响「本分支去掉 `docs/fork-patches/` 后与补丁重放结果逐字节一致」这条校验。

文中行号：标了 `upstream/main:` 的按 `f82c184`；没标的按本分支 `3975618`。P0 完成后，本分支的行号会整体变成上游的。

---

## 1. 目标

在 fork 里新增 `plugin/dsh`，让 DSH 直接使用本机的 engram：同一个 SQLite、同一条云同步、
和 Claude Code / Codex / Pi 共享记忆。行为对齐上游 `plugin/pi`，并修掉 dsh-gentle-engram 的已知缺陷。
代码留在本仓库，可以自己改，也跟着 fork 一起重放。

## 2. 为什么不用现成方案

| 方案 | 问题 |
|---|---|
| DSH 官方示例 `apps/cli/config/examples/mcp-memory/engram.cordis.yml`（`dsh-mcp-client` 启动 `engram mcp`） | `engram mcp` 用自己子进程的 cwd 判断项目；DSH 一个进程里跑多个会话，会把记忆记到错的项目上。没有 prompt 捕获，也没有压缩归档 |
| `dsh-hooks-claude-code` 复用 Claude 插件的 hooks.json | SessionStart / UserPromptSubmit 只认 JSON 里的 `additionalContext`，engram 的 `session-start.sh` 输出的是纯 stdout；不支持 SessionEnd、PreCompact；`engram hook claude-pre-tool-use` 的匹配规则会命中 DSH 的 `mcp__engram__*`，有误拦写操作的风险 |
| `@ian_p/dsh-gentle-engram` | 设计方向对，但只有一个维护者，每周下载 21 次；装在 `node_modules` 里不方便改；有第 4 节列出的缺陷；不做 runtime contract 校验 |

## 3. 参考实现对照

| 维度 | dsh-gentle-engram 0.7.3 | 上游 plugin/pi 0.5.1 | 本计划 |
|---|---|---|---|
| 传输 | HTTP，不插 MCP 行 | HTTP | HTTP，不插 MCP 行 |
| 项目解析 | 会话 cwd 调 `GET /project/current`，404 时读 `.engram/config.json` | 同左 | 同左，fail-closed；`explicit_project_required` 的 409 单独处理 |
| 会话 key | `agent.id`；遇到 409 用 `randomUUID()` 轮换 | runtime id + `resume:true` | `agent.id` + `resume:true`，直接用服务端返回的 effective id |
| 结束会话 | 只有 `mem_session_end` | `mem_session_end`，以及非 reload 的 shutdown | 只有 `mem_session_end` |
| 跨项目写入 | 不支持 | satellite 会话 `<id>@<project>` | P4，照 Pi（4.11） |
| mem_save 应答丢失 | 超时报 unknown | `operation_id` + `GET /observations/save-result`（plugin-thin 里的 Pi 专属例外） | P4，照 Pi，先把例外扩到 DSH（4.12） |
| prompt 捕获 | 本地判断 | 本地判断后 `POST /prompts`（不用 `/prompts/capture-decision`） | 同 Pi |
| 协议注入 | 每次请求走 `systemPrompt.context` | `before_agent_start` 追加 system prompt | 静态协议走 `systemPrompt.section`；`context` 只放一次性恢复提示 |
| 压缩 | 归档摘要，不回读 `/context/compaction` | 归档后回读 | 跟 dsh-gentle-engram |
| 工具 | 21 个（缺 `mem_list_projects`） | 23 个 operation | 同 Pi 的 23 个 |
| 服务端契约校验 | 无 | 启动时精确比对 `GET /runtime-contract` | 复用 Pi 的契约文件做同样的比对（4.3） |
| 语言与构建 | TypeScript + tsdown，产物 `dist/` | 直接发布 `.ts`，由宿主加载；测试靠 Node 原生剥类型 | TypeScript（只用可擦除语法），无构建，靠 Node 原生剥类型，只以 `link:` 安装 |
| 安装 | npm | `engram setup pi` → `pi install npm:gentle-engram@0.5.1` | `engram setup dsh`：解出内嵌文件，再 `dsh plugin add`（4.13） |
| 测试 | `node:test`，伪造 ctx + 本地 http 桩 | `node:test` + sandbox + 真实 Go server 桩 | 单测 + 真实 Go server 契约 + 真实 cordis 挂载 + 隔离端到端冒烟 |

## 4. 设计

### 4.1 目录与打包

```text
plugin/dsh/
  package.json           dsh.bundle.patch、exports（./index.ts）、engines.node、peerDependencies
  cordis.patch.yml       insert 一行，id: engram-dsh
  index.ts               apply()：事件接线
  lib/*.ts               config / client / server / contract / project / session / tools / capture / protocol / redaction
  runtime-contract.json  Pi 契约文件的逐字节副本（4.3）
  test/*.test.mjs
  README.md
```

- **语言（Q2 已定）：TypeScript，不构建，和 Pi 的 `index.ts` 同一做法。** 依据：
  - engram 现有适配器的规律是「宿主能直接加载 TS 就写 TS、不构建」：Pi 是 `index.ts`（另有 5 个纯 `.js` 辅助模块），
    OpenCode 是 `engram.ts`；Claude Code、Codex 是 shell 脚本加 Go 端 hook。
    只有 Obsidian 因为宿主只认 JS，才用 TS + esbuild，产物 `main.js` 不入库（`plugin/obsidian/.gitignore`）。
  - 上游 Pi 的测试就是靠 Node 原生剥类型直接 import `index.ts`（`upstream/main:plugin/pi/test/plugin-sandbox.mjs:97`，CI 用 Node 24）。
  - DSH 用 Node 的 `import()` 加载插件。本机 Node 22.23.3 实测：经符号链接进到 `node_modules` 的 `.ts`
    能加载，因为 Node 按真实路径判断；真实拷贝在 `node_modules` 里的 `.ts` 报
    `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。实测没有 ExperimentalWarning 输出。
- **由此带来的三条约束**：
  1. 只用可擦除语法：不用 `enum`、`namespace`、构造函数参数属性；类型导入一律 `import type`；相对导入写 `.ts` 后缀。
  2. 只以 `link:` 安装：开发时指向仓库检出，`engram setup dsh` 时指向它解出的目录（4.13）。不打 tarball，不发 npm。
     装进 `node_modules` 的真实拷贝会直接加载失败，README 写明。
  3. `package.json` 写 `engines.node: ">=22.18"`（Node 22 从 22.18 起默认剥类型）。
- **运行时零 `@deepseek-ai/*` import**：`link:` 指向的目录在 profile 之外，Node 从真实路径往上找不到 profile 里的 peer。
  所以只用 `import type`（剥类型时整行删掉）；工具直接构造 `ToolDefinition` 对象交给 `ctx.tools.register`，
  不调用 `defineTool`（dsh-solana-re 的 `src/adapters/dsh/tool.ts` 就是这么做的）；插件配置自己校验，不用 schemastery。
  dsh-gentle-engram 在运行时 import 了 `@deepseek-ai/dsh-tools` 的 `defineTool` 和 `@deepseek-ai/schemastery`，
  是靠 tsdown 打包加 pnpm 解析 peer 才跑起来的，这条路在这里不能照搬。
- **依赖**：没有运行时依赖（`skills/plugin-thin/SKILL.md` 边界规则第 3 条）。
  peer 精确钉 `0.2.0-rc.2`：`@deepseek-ai/dsh-agent`、`dsh-tools`、`dsh-session`、`dsh-system-prompt`，
  `peerDependenciesMeta` 全部设为 optional，做法同 dsh-solana-re。这些 peer 在运行时不加载，作用是让
  `dsh plugin add` 在安装前做版本兼容检查，DSH 升级后会拒装，逼着先跑 P3 冒烟。
  npm 上这些包的 dist-tag 都不指向 `0.2.0-rc.2`（`latest` 是更旧的 rc，`next` 是 `0.2.1-rc.3`），必须写精确版本。
  编辑器和类型检查需要的类型声明，作为 devDependencies 装在 `plugin/dsh/node_modules`，不进运行时。
- **命名**：包名 `@cpkt9762/engram-dsh`，`private: true`，不发 npm。cordis 行 id 用 `engram-dsh`，
  和 dsh-gentle-engram 的 `engram-memory` 区分开。
- **互斥**：同一个 profile 里不能同时装 dsh-gentle-engram，也不能有 `serverName: engram` 的 MCP 行，
  否则 `mem_*` 工具会重名。P3 实测 DSH 遇到重名工具时的表现，要确保冲突时报错，不能静默覆盖。
- **许可**：按设计重写，不整文件照搬。确实照搬的片段（例如恢复提示的措辞），
  在文件头保留 dsh-gentle-engram 的 MIT 版权声明（Copyright (c) 2026 Enoc Hernández）。

### 4.2 事件接线

| DSH 事件 | 用途 |
|---|---|
| `agent/created` | 后台预热：确保 serve 可用、通过契约校验、解析项目。这个事件是串行并被 await 的，所以只发起不等待，免得拖慢建会话 |
| `agent/inbox/inserted` | prompt 捕获 |
| `tools/result` | 被动捕获 |
| `session/event`，过滤 `compaction/summary` | 压缩归档。DSH 的压缩没有单独的 Cordis 事件，只有会话日志事件 |
| `agent/turn-stopping` | 排空本会话写队列（最多 5 s）；清掉已送达的恢复提示。监听器返回 void，不截断 bail 链 |
| `agent/disposed` | 只释放本地状态，不写 engram |

插件热重载后 `agent/created` 不会重发，所以每个监听器和工具都要能按需重建会话状态
（dsh-gentle-engram 的 `sessions.ensure()` 思路）。

事件语义（2026-10-25 从 DSH 0.2.0-rc.2 源码核实，详见第 12 节 DSH 部分）：

- `agent/created` 和 `agent/turn-stopping` 是 serial、会被 await 的：监听器抛错会让建 agent 失败或让这一轮以 error 结束，
  返回非 undefined 会跳过后面的监听器。所以这两个监听器必须吞掉自己的所有错误（只写日志），并且返回 undefined。
- `agent/inbox/inserted`、`agent/disposed`、`tools/result`、`session/event` 是 emit，错误被宿主吞掉；
  `session/event` 在会话 append 里同步调用，监听器只能入队、立刻返回。
- 没有单独的 turn 开始、结束事件；需要时从 `session/event` 的 `turn/start`、`turn/end` 看。
- 在插件 ctx 上注册的监听器能收到所有 agent 的事件；用 payload 里的 `agent` 区分会话。

**注册一律挂在插件 ctx 上，不挂 `agent.ctx`**：`agent.ctx` 上的注册只在 agent dispose 时撤销，插件卸载、重载时不会撤销，
还会一直引用旧代码的闭包。工具、协议 section、恢复提示 context 都注册成全局的一份，按调用时的 agent 分派
（工具用 `exec.agent`，context 的 text provider 用 `AssembleContext.agent`）。

### 4.3 服务发现、归属与契约校验

- 设了 `ENGRAM_URL`：直接用这个地址，跳过归属检查，也不拉起进程（同上游 Pi，`upstream/main:plugin/pi/index.ts:1392`）。
- 没设：先异步执行 `engram instance-id`，结果必须是 32 位十六进制（用 `execFile`，不用 `spawnSync`。dsh-gentle-engram
  `src/engram/server.ts:104-109` 用同步调用，最长会阻塞事件循环 10 s），再用 `GET /health` 的 `instance_id` 比对。
  一致就直接用；不一致或缺字段就拒绝，不接管也不终止对方进程；只有确定的连接被拒（ECONNREFUSED）才拉起 `engram serve`。
- 拉起时通过子进程环境变量 `ENGRAM_PORT` 传端口（`cmd/engram/main.go:1001-1010` 读取它）。
  dsh-gentle-engram 在 `src/engram/server.ts:166` 拉起时没传端口，配置里改了 `port` 就会一直等到启动超时。
- `engram serve` 是本机共享的守护进程，Claude、Codex、Pi 都连它，所以拉起后故意不随 DSH 退出。README 写明这一点。
- 拉起的子进程继承 DSH 进程的环境。Pi 会额外设 `ENGRAM_CLOUD_AUTOSYNC=1`。
  本机实际情况：serve 由 launchd 服务 `dev.engram.serve` 常驻（`~/.local/bin/engram serve`，7437 端口），
  插件正常走「复用」分支；Paseo 起的 DSH 进程环境里也带着 `ENGRAM_CLOUD_*`（8.1）。拉起只是 launchd 服务挂掉时的兜底。
- 设了 `ENGRAM_HTTP_TOKEN` 时，除 `/health` 以外的请求都带 `Authorization: Bearer`。没设时服务端放行
  （`upstream/main:internal/server/server.go:175-186` 的 `requireAuth`）。
- 不支持 Pi 的 `ENGRAM_SERVER_MODE=session-owned`（`engram serve --session-owned`，连 `/health` 都要 Bearer）。DSH 只走共享模式。

**runtime contract（方案 A：复用 Pi 的契约）**

上游的契约只有一份，是给 Pi 设计的：

- `GET /runtime-contract` 不看任何参数，永远返回同一份 projection，`contract_id` 写死为 `engram.pi-http-runtime/v1`、
  `revision: 1`（`upstream/main:internal/server/runtime_contract.go:96-156`，`:131`）。
- 生成工具 `go run ./tools/runtime-contract` 的 `-check` 只认 `plugin/pi/runtime-contract.json`（`upstream/main:tools/runtime-contract/main.go:18,41`）。
- Pi 的比对方式：去掉 `instance_id` 后与包内 json 递归深比较，`instance_id` 必须是非空且不超过 128 字符的字符串，
  不重算 digest（`upstream/main:plugin/pi/runtime-contract.js:6-24`）。校验时机：初始化、每次 dispatch 及其重试、
  mem_save 恢复的每一步、显式结束会话（`upstream/main:plugin/pi/index.ts:766-845`）。

三种做法：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（采用）** | `plugin/dsh/runtime-contract.json` 是 Pi 那份的逐字节副本，比对逻辑照 Pi | 上游每改一次 Pi 的绑定，副本就要跟着更新，否则插件拒绝工作。插件和二进制在同一个仓库、同一次 P0 里更新，这个代价可以接受 |
| B | 在 Go 里给 DSH 单独一份 projection 和 contract id，路由或参数按适配器区分 | 要改 `runtime_contract.go`、生成工具和测试，按上游 CONTRIBUTING 属于 shared contracts 的高风险改动；每次重放都可能冲突 |
| C | 像 OpenCode 一样不校验 | 服务端接口变了也不会发现 |

方案 A 的配套：

- 加一个 Node 测试，断言 `plugin/dsh/runtime-contract.json` 与 `plugin/pi/runtime-contract.json` 逐字节相同。
  上游一改 Pi 的契约，fork 的测试先失败，不会等到运行时才暴露。
- `.gitattributes` 给这个文件加 `eol=lf`（`upstream/main:.gitattributes:6` 对 Pi 那份就是这么做的）。
- 比对失败时：工具返回错误，hook 静默放弃，日志写明「升级 engram、重启 serve 和 DSH」，措辞照 Pi（`upstream/main:plugin/pi/index.ts:763`）。
- 如果以后 DSH 的工具集和 Pi 分叉，再改用方案 B。

### 4.4 项目解析

- cwd 只取本会话的 `agent.session.header.cwd`，永远不用 `process.cwd()`。
- 调 `GET /project/current?cwd=`，最多 5 次，间隔 200 ms；路由返回 404（老服务端）时，
  从 cwd 向上找 `.engram/config.json` 里的 `project_name`。
- 结果是 `unknown`、带 `error_hint` 或包含路径分隔符时判为失败。失败时禁止写入，读工具返回错误；
  只写日志，不把错误文本塞进模型上下文。失败结果 30 s 后过期，补上配置文件不用重启。
- 上游返回 `409 explicit_project_required` 时（`upstream/main:DOCS.md:268-274`），同样禁止隐式写入，
  日志提示「在项目目录里启动，或显式传 `project`」。P3b 实测更正：这个 409 **只在 HOME 本身是 Git 仓库**
  （比如 dotfiles 仓库）、并且在其中未跟踪的子目录里捕获时才出现。普通 HOME 目录按目录名判项目
  （`dir_basename`），HOME 本身是 Git 根目录时按 `git_root` 判，都返回 200。本插件不另加规则，以服务端判定为准。
- 多仓库工作区按 engram 的规则拒绝猜测，日志里提示在工作区根目录加 `.engram/config.json`。
- 写请求（`POST /sessions`、`/observations`、`/observations/passive`、`/prompts`）带上可选的
  `project_provenance: {source, directory, raw_project}`。`source` 用 `/project/current` 返回的检测来源，
  回退到 `.engram/config.json` 时用 `config`。这些字段只作为本地证据，不影响项目归属（`upstream/main:docs/CAPTURE-PROJECT-PROVENANCE.md`）。

### 4.5 会话身份与生命周期

- DSH 里 `Agent.id` 就是 `SessionId`，resume 前后不变（`dsh-agent/lib/types/types.d.ts:13`）。
  engram 的会话 key 就用 `agent.id`。
- **懒注册**：第一次真正产生记忆时（`mem_*` 写入、prompt 捕获、工具结果捕获、压缩归档）才 `POST /sessions`。
- **注册体**：`{id, project, directory: cwd, ownership_mode: "project_owned", resume: true, project_provenance}`。
  前提是 `/health` 的 `capabilities.root_session_resume` 为 true，否则拒绝写入并报错，不退回到不带 resume 的注册。
- **用服务端返回的 id**：之后所有写入的 `session_id` 都用注册时服务端返回的 id。
  续接选择是确定的（`internal/store/store.go:3411` 的 `ResumeSessionWithOwnershipModeTimed`，
  以及同文件的 `continuationSessionTx`）：
  - root 未结束，返回 root；
  - root 已结束，返回编号最小的未结束续接 `<id>:resume:N`；
  - 都结束了，分配下一个编号。

  所以重复注册是幂等的，插件重载后也能找回同一行。这样就不需要 dsh-gentle-engram 的随机轮换
  （`src/registration.ts:149-176`），也就没有它 DESIGN.md 里记的遗留问题「轮换后的 key 在 reload 后丢失，同一会话被拆成两行」。
- **续租**：写入前如果距上次注册超过 60 s，就重新 POST 一次（服务端租约 30 分钟）。
- **服务端不拒绝写入已结束的会话**（P1a 实测，2026-10-25）：`POST /sessions/{id}/end` 返回 200 之后，
  `POST /observations` 带同一个 session_id 仍返回 201，记录落在已结束的 root 上。`validateSessionProject`
  （`internal/server/server.go:2369`）只查项目归属，不查 `ended_at`；409 `session_already_ended` 只出现在注册和 finalize。
  上游 Pi 也是首次登记后缓存 effective id，不靠写入被拒来发现会话结束。所以：
  - 不实现「写入被拒→重新注册」分支，服务端没有这个协议；
  - 会话被别处结束后，最迟在下一次续租（60 s）时续接到 `<id>:resume:N`，在这之前的写入落在已结束的 root 上，这是服务端语义，接受；
  - 本插件自己的 `mem_session_end` 结束会话后立刻让缓存的 effective id 失效，下一次写入马上注册续接。
- **结束**：`agent/disposed` 不调 `/end`。DSH 的 dispose 不等于用户结束工作，结束后下次又会续接出一行新的，徒增噪音。
  只有 `mem_session_end` 调 `POST /sessions/{id}/end`，并且不接受模型传入的会话 id。
- **项目冲突**：同一 id 先后解析成不同项目时服务端返回 409 `session_project_conflict`。
  隐式写入直接报错；显式指定了别的项目的写入走 satellite（4.11）。
- **子 agent**：用它自己的 `agent.id` 和 cwd。已核实父 agent 下发给子 agent 的第一条消息 `source.kind` 也是 `'user'`
  （`dsh-subagent-in-process-driver/lib/index.js:207-210`、`dsh-subagent/lib/index.js:1738-1739`），和人类输入分不开；
  所以 `session.header.origin === 'subagent'`（或 `delegationDepth > 0`）的会话一律不做 prompt 捕获
  （Pi 对子进程输入也是跳过的）。工具和被动捕获照常。

### 4.6 协议注入

DSH 0.2.0-rc.2 的相关语义已从 `dsh-system-prompt` 的类型声明和 README 核实：

- `section` 和 `context` 的 `text` 都可以是函数，每次组装请求时求值；`context` 返回空串就不贡献内容（`lib/types/index.d.ts:58-78`）。
- 通过 `agent.ctx` 注册的条目只作用于这个 agent，并遮蔽同名的全局条目（README:28、:111）。
- `section` 默认会插值 `{{变量}}`，引用了未定义的变量会直接抛错（`lib/types/index.d.ts:191-197`）。
- `context` 会落成一条持久的 user 角色快照（`lib/types/index.d.ts:72`）。部署方可以用 `includeRuntimeContext: false`
  或 `suppressRuntimeContext()` 关掉所有动态 context（README:47、:82）。

设计：

- **静态协议**：Memory Protocol 用全局的 `ctx.systemPrompt.section` 注册，文本固定，对 prompt cache 友好。
  设 `interpolate: false`，免得协议文本里出现 `{{` 时整次组装失败。order 放在第一方说明之后、
  环境后缀（10000）之前。文本写在 `lib/protocol.ts` 的 ``const MEMORY_INSTRUCTIONS = ` ``，
  常量必须以换行再接反引号结尾（上游清单测试的结束标记是 `` "\n`" ``）。把这个文件加进两个契约测试的清单（P2）：
  - `upstream/main:internal/setup/memory_protocol_test.go:152-168`：加 `{path, start, end, claude:false}` 一项，
    截出的文本要通过 `assertSelectiveMemoryContract` 的 25 条正则，并且不能含禁用短语（如 “Use ToolSearch”）。
    P4 有了内嵌副本后，副本也要加一项（OpenCode 就是源文件和内嵌副本各一项）。
  - `upstream/main:plugin/delivery_guarantee_test.go:11-22`：加一项，文件里要逐字包含 `:41-46` 的 4 句话。
- **恢复提示**：在插件 ctx 上注册**一个全局** `systemPrompt.context`，text provider 按 `AssembleContext.agent?.id`
  查本插件的「待送达提示」表，有就返回提示，没有就返回空串。这样不会串到同一进程的其他会话，也不需要 `agent.ctx` 注册（4.2）。
  dsh-gentle-engram 在第一次组装请求时就清掉提示（`src/index.ts:389-392`），那次请求失败提示就没了。
  这里改成：该轮 `agent/turn-stopping` 正常结束后才从表里删除。
  部署方关掉了动态 context 时提示送不到；协议正文本身已经要求压缩后先调 `mem_context`，这是兜底。
- **context 的两条硬约束**（已核实）：
  - 快照只在所有 context 拼起来的文本变化时才写一次（`dsh-agent-loop/lib/index.js:334-349`），
    所以提示在表里多留几步不会重复写进会话；但提示文本里不能放时间戳之类每步都变的内容。
  - context 一律做严格 `{{变量}}` 插值，没有 `interpolate: false`，未知引用会让这一轮失败（`dsh-system-prompt/lib/index.js:146-180`）。
    提示文本里的 `{{` 必须先转义，或保证不出现；有单测锁住。
  - text provider 必须同步返回，不能 await。
- **不自动注入历史记忆**：新会话开局不注入历史记忆，避免项目判错时把别的项目的记忆带进来。由协议要求模型先调 `mem_context`。

### 4.7 工具

- **工具集**：和上游 Pi 的 23 个 operation 一致（`upstream/main:internal/server/runtime_contract.go:110-129`）：
  `mem_search`、`mem_context`、`mem_search_prompts`、`mem_get_observation`、`mem_save`、`mem_session_summary`、
  `mem_update`、`mem_suggest_topic_key`、`mem_consolidate`、`mem_judge_many`、`mem_session_finalize`、
  `mem_save_prompt`、`mem_session_start`、`mem_session_end`、`mem_current_project`、`mem_doctor`、
  `mem_capture_passive`、`mem_review`、`mem_judge`、`mem_compare`、`mem_list_projects`、`mem_pin`、`mem_unpin`。
  `mem_delete`、`mem_stats`、`mem_timeline` 不在其中（`upstream/main:internal/server/runtime_contract_current_test.go:50-56`）。
- 相对 fork 基线，上游新增了三个组合操作：`mem_consolidate`、`mem_judge_many`、`mem_session_finalize`，
  对应的路由走 `requireAuth`（`upstream/main:internal/server/agent_workflows.go:43,95,157`）。
- **参数**：照上游 Pi 的 schema，包括 `GET /search` 的 `response_format=compact`、`GET /observations/{id}` 的
  `include_history` / `history_cursor`。
- **注册**：直接构造 `ToolDefinition` 对象交给插件 ctx 的 `ctx.tools.register`（4.1、4.2）。已核实的要求：
  - `output: { schema, render }` 必填；`output.schema` 只能用 `type`、`oneOf`、`properties`、`required`、
    布尔型 `additionalProperties`、`items`、`enum`、`const` 和说明类字段，注册时会校验（`dsh-tools/lib/index.js:34-49,2878-2888`）。
  - `parameters` 写标准 JSON Schema（`required: [...]` 数组），不是 `defineTool` 的属性级 `required: true` 写法。
  - **宿主不校验参数**，只有 `defineTool` 的包装会校验；模型给的 JSON 解析失败时 `args` 甚至是原始字符串。
    所以每个工具自己校验参数，失败时抛普通 `Error`，消息格式照 `ToolArgsError`：`invalid arguments: a; b`。
  - 普通 `Error` 会变成给模型的 `Error: <message>` 和 `isError: true`，这一轮不会中断。
  - 会话 id 用 `exec.agent?.id`，cwd 用 `exec.agent?.session.header.cwd`；`exec` 里没有 cwd 字段。
- **重名**：同一层里重名注册会**同步抛错**（`dsh-tools/lib/index.js:2634`）。不 try/catch 降级：让插件启动失败，
  日志写明「这个 profile 里已有别的 `mem_*` 工具（dsh-gentle-engram 或 engram MCP 行），先移除」。
- **作用域**：读工具默认限定在本会话的项目；只有显式传 `all_projects: true` 才跨项目。
- **按 id 操作的工具**（get / update / pin / unpin / judge / compare 等）调用前同样要确保 serve 就绪、契约已校验。
  dsh-gentle-engram 的这几个工具不走 `server.ensure()`，在预热完成前调用不会触发恢复。

### 4.8 捕获与写队列

- **prompt**：服务端的 `POST /prompts/capture-decision` 只接受 `source: "claude-code"`
  （`upstream/main:internal/server/prompt_capture_decision.go:29`），DSH 不能用。
  照 Pi 和 OpenCode 在本地判断（`upstream/main:plugin/pi/index.ts:3129-3206`）：
  - `agent/inbox/inserted` 里只收 `source.kind === 'user'` 的消息（`user-rpc` 变体的 kind 也是 `'user'`），跳过合成输入；
    子 agent 会话（`session.header.origin === 'subagent'`）整个跳过，见 4.5；
  - trim 后不超过 10 字符的跳过；项目解析失败的跳过；
  - 先做 `<private>` 脱敏再截到 2000 字符，然后 `POST /prompts`，body 带 `session_id`、`project`、`project_provenance`。
- **mem_save 附带当前 prompt**：Pi 会在同一轮、同一项目、同一会话里给 `mem_save` 附上 `current_prompt`
  （`upstream/main:plugin/pi/index.ts:2481-2485`），P2 照做。Pi 的 `promptProof` 只用于它和其他 Pi 扩展之间的本地桥，DSH 不需要。
- **工具结果**：`tools/result` 跳过自家工具、出错的结果和不超过 50 字符的结果，其余原文交给 `POST /observations/passive`，
  由 Go 端解析 Key Learnings 段，解析逻辑留在 Go（plugin-thin 第 2 条）。
  这和 Pi 一致；dsh-gentle-engram 是在本地用复制来的正则先筛一遍。代价是工具调用多时 HTTP 请求也多。
- **脱敏**：凭据形态的文本由 fork 补丁 0003 在 Go 写入前处理，插件只负责 `<private>` 块。
- **写队列**：每个会话一个串行写队列，`agent/turn-stopping` 时排空。

### 4.9 压缩归档

- 监听 `session/event` 里的 `compaction/summary`（`dsh-compaction/README.md:95,116`），按 `compactionId` 去重。
  `data.summary` 是 `ContentBlock[]`，取其中的 text 块拼成摘要（字段见 `dsh-compaction/lib/types/types.d.ts:35-68`）。
  监听器是同步调用的，只把归档任务放进写队列就返回。
  去重集合设上限；dsh-gentle-engram 的 `archivedCompactions` 会无限增长。
- 摘要归档为 `type: session_summary`、`topic_key: session/compaction-recovery`。
- 四种结局对应不同的恢复提示，措辞沿用 `plugin/pi/compaction-recovery.js`：
  - Confirmed：已保存；
  - Unknown：超时，可能已写入，先核实，不要盲目重试；
  - Failed：确定失败，引导模型手动调 `mem_session_summary`；
  - Unavailable：没有可信的会话或项目，什么都没归档。

### 4.10 超时与重试

规则和 Pi 一致：
- GET 最多试 3 次；
- `POST /sessions` 最多 2 次；
- 其他写请求只发一次。超时就报 unknown，提示先用 `mem_search` 或 `mem_doctor` 核实，不盲目重发。
- 唯一的例外是 `mem_save` 的应答丢失恢复（4.12）。

### 4.11 跨项目写入（satellite，P4）

照上游 Pi（`upstream/main:plugin/pi/index.ts:1758-1845,1939-1963,2417-2423`）：

- **触发**：只有 `mem_save`、`mem_save_prompt`、`mem_session_summary`、`mem_session_finalize` 这四个写工具，
  并且模型显式传了 `project` 或 `cwd`。`cwd` 先经 `GET /project/current?cwd=` 解析；`project` 和 `cwd` 解析结果不一致时报错。
  目标项目和本会话的 root 项目不同时才走 satellite；隐式写入永远不走。
- **id**：`<agent.id>@<目标项目>`。
- **注册**：每次注册请求（含重试）前都查 `GET /health`，要求 `capabilities.isolated_session_registration === true`，否则失败。
  然后 `POST /sessions {id, project, ownership_mode: "project_owned", resume: true, isolated: true}`，不带 `directory`
  （服务端规定 isolated 注册必须不带 directory，否则 400；冲突返回 409 `session_isolation_conflict`，
  `upstream/main:internal/server/server.go:589-601`）。
  应答必须是 `status: "created"`，`id` 等于请求的 id 或 `<id>:resume:N`，之后写入用应答里的 id。
- **结束**：Pi 在 runtime 退出时逐个结束 satellite。DSH 不在 dispose 时结束 root（4.5），satellite 也一样：
  只在 `mem_session_end` 时连同本会话的所有 satellite 一起结束。插件重载后 satellite 列表丢失不要紧，
  续接是确定的，下次写入会找回同一行。
- **测试**：照 `upstream/main:plugin/pi/test/cross-project-saves.test.mjs` 和 `internal/server/isolated_session_test.go`。

### 4.12 mem_save 应答丢失恢复（P4）

服务端早就支持（fork 基线里已有），上游语义没变：

- `POST /observations` 可以带 `operation_id`。指纹不同返回 409，对应记录已删除返回 410
  （`upstream/main:internal/server/server.go:745-769`）。
- `GET /observations/save-result?operation_id=`：成功返回 `200 {id, status: "committed"}`；
  从未记录返回 `404`，`code: "observation_save_result_not_found"`；已删除返回 410（`upstream/main:internal/server/server.go:689-711`）。
- 本地账本 `observation_save_operations` 永久保留（`upstream/main:DOCS.md:401-415`）。

插件照 Pi 的 `postObservationWithReplayRecovery` 实现（`upstream/main:plugin/pi/index.ts:553-655`）：

1. 每次保存生成一个 UUID，冻结脱敏后的 body 和两个目标地址；整体截止 7.5 s，POST 单次 3 s，GET 单次 1 s。
2. POST 应答不明确时查 save-result。
3. 只有拿到带类型的 404，才在 250 ms 退避后原样重放一次 POST。
4. 重放得到 409 / 410 或仍不明确时，最后再查一次 save-result。
5. 仍无结论就返回 `unknown`，不报「已保存」。
6. 只有 `mem_save` 走这条路；每一步都重新校验 runtime contract。

**前提：先改仓库规则。** `skills/plugin-thin/SKILL.md:30-54` 的「Narrow Pi Exception: Observation-Save Acknowledgement Recovery」
只授权 `plugin/pi`，上游的 OpenCode 也没用它。要在同一个补丁里把例外的适用范围扩到 `plugin/dsh`，
条款原样保留（只认 save-result 的权威结果、只重放一次、不扩展到其他路由和工具、遥测不记 operation UUID）。
这是 fork 专有的规则改动，补丁说明里写清楚。

### 4.13 `engram setup dsh`（P4）

做法：OpenCode 的「内嵌文件写到固定目录」，加上 Codex / Claude Code 的「调外部 CLI」。
上游的 Pi 是 `runCommand("pi", "install", "npm:gentle-engram@0.5.1")`，走 npm，这里不适用。

1. **内嵌**：`internal/setup/generate.go` 的 `go:generate` 把 `plugin/dsh` 的运行时文件（不含 `test/`）复制到
   `internal/setup/plugins/dsh/`，用 `//go:embed plugins/dsh` 打进二进制。同时改掉 `generate.go` 里
   “Only OpenCode needs embedding” 的注释，并加一个测试，断言内嵌副本和源文件逐字节相同
   （仿照 `upstream/main:internal/setup/setup_test.go:26`）。
2. **写文件**：解到 `~/.engram/integrations/dsh/`（固定路径，不含空格；放在 `node_modules` 之外，Node 才会剥类型）。
   照 OpenCode 的 `patchEngramBINLine`（`upstream/main:internal/setup/setup.go:505-518`），把当前 engram 的绝对路径
   写进插件里的一个常量，插件就用安装它的那个二进制，不依赖 Paseo 守护进程的 PATH。
3. **检查 profile**：默认 profile `acp`，可以用环境变量 `ENGRAM_DSH_PROFILE` 改。这样不加新的 CLI 参数，
   少动 `cmd/engram/main.go`。profile 目录是 `${DSH_HOME:-~/.dsh}/profiles/<p>/`。
   - profile 不存在：报错退出。
   - 已经装了 `@ian_p/dsh-gentle-engram`，或 `cordis.patch.yml` 里有 `serverName: engram` 的 MCP 行：报错退出，提示先移除；不自动删。
   - 已经以 `link:` 指向同一目录：只刷新文件，不再调 `dsh plugin add`。
4. **安装**：`lookPathFn("dsh")` 找不到就报错，并打印手动命令（照 Codex，`upstream/main:internal/setup/setup.go:1647-1651`）。
   找到就 `runCommand("dsh", "plugin", "--profile", p, "add", <绝对路径>)`。输出含 “already” 时按幂等处理（照 Claude Code，`:1000-1030`）。
5. **安装后提示**：Paseo 里要新建 DSH agent 才生效；升级 engram 二进制后重跑一次 `engram setup dsh` 刷新文件。
6. **改动清单**（都是上游常改的文件，冲突风险中）：
   - `internal/setup/agents.go`：新增 `dsh` 条目；
   - 新文件 `internal/setup/dsh.go`：`installDSH`；
   - `internal/setup/generate.go`、`internal/setup/plugins/dsh/**`；
   - 测试：`internal/setup/registry_test.go:257-268` 的列表从 14 个改成 15 个，`cmd/engram/main_test.go:488`，
     新的 install 测试（用 `resetSetupSeams` 换掉 `lookPathFn` 和 `runCommand`，照 `upstream/main:internal/setup/setup_test.go:672-681,808-822`）；
   - `cmd/engram/main.go:3984-3986` 的 usage；
   - 文档：`DOCS.md:67-68` 的权威表、`docs/AGENT-SETUP.md`、`docs/PLUGINS.md`、`README.md` 的 setup 目标数。
     `docs/INSTALLATION.md` 和 `docs/codebase/integrations.md` 只在测试要求时改，尽量少碰上游热文件。
- 卸载：上游 setup 没有卸载入口，这里也不加；README 写明用 `dsh plugin --profile acp remove @cpkt9762/engram-dsh`。

### 4.14 Go 端与仓库规则改动汇总

| 阶段 | Go 代码 | 测试与 CI | 仓库规则 |
|---|---|---|---|
| P1–P3 | 不改 | 两个协议清单测试各加一项；`.gitattributes` 加一行；CI 的 Plugin Tests job 加一个 step | 无 |
| P4 setup | `internal/setup` 新增 dsh；`cmd/engram/main.go` usage | 4.13 第 6 条 | 无 |
| P4 恢复 | 不改 | 插件测试 | `skills/plugin-thin/SKILL.md` 例外扩到 DSH |
| P4 satellite | 不改 | 插件测试 | 无 |

CI 只在现有的 Plugin Tests job（`upstream/main:.github/workflows/ci.yml:470-511`，Node 24）里加一个 step，
不新开 job，因为必需检查的名单是固定的（`upstream/main:CONTRIBUTING.md:241`）。

## 5. 不做的事

- 不向上游提 PR（稳定后再议）。
- 不发 npm 包，也不以 tarball 或 github 方式安装（这两种装法会把 `.ts` 放进 `node_modules`，加载失败）。
- 不支持 DSH 0.1.x，不支持 Pi 的 session-owned 模式。
- 不插 MCP 行，不走 hooks 桥。
- 新会话不自动注入历史记忆。
- 不改 dashboard、云同步和 store 的语义；不改 runtime contract 的 Go 实现（方案 A）。

## 6. 阶段

### P0 跟上游（Q1 已定）

**试重放结论**（2026-10-25，在临时 worktree 里把 12 个补丁 `git am -3` 到 `f82c184`，冲突不解、直接跳过，用完已删）：

- 12 个补丁全部仍需保留，没有一个被上游取代。0003、0004、0009、0010 的回归测试放到纯上游上跑，都按预期失败。
- 要停下手工处理的只有 4 处：0003、0004、0006、0007。0009、0010 在 `store_test.go` 末尾的冲突是跳过 0003 后上下文对不上引起的连带冲突，按顺序解决就不会出现。
- 用 `git merge-tree` 模拟 `3975618` 合入 `upstream/main`：5 个文件、7 个冲突块。

| # | 结果 | 冲突原因与解法 | 工作量 |
|---|---|---|---|
| 0001、0002、0005、0008、0011、0012 | 干净 | — | 低 |
| 0003 脱敏 | `store.go` 1 块 | 上游 `fc0dd31`（#1840）把 `endSessionOperation` 拆出了 `endSessionSummaryOperation`。脱敏放在 `endSessionOperation(id, summary string)` 里，再交给 `endSessionSummaryOperation`；**不要**放进后者，因为新的 `FinalizeSession` 会把旧 summary 原样传进去。复核 summary 被脱敏成空串时 `nullableString` 存成 NULL 是否可接受 | 低到中 |
| 0004 数据目录权限 | `instance.go`、`store.go` 2 块 | 上游 `7f2f523`（#2048）新增 `EnsureInstanceIDContext`，`48e1d08`（#1953）加了 `ValidateDataDirectory`，`7e9908d`（#1854）加了 `ctx.Err()` 检查。`EnsureInstanceIDContext` 里的 `0o755` 换成 `dataDirPerm`；顺序是先上游的 `ValidateDataDirectory`，再 `secureDataDir`；两边新增的检查都留 | 中 |
| 0006 同步加密 | `sync.go` 1 块 | 上游 `2f4e0bd`（#1845）给 `sessionIDsAvailableInChunks` 加了 `decoded` 缓存，**应用循环会直接复用这个缓存**。这和上次部署时修的 `chunkForEntry` 密文进缓存是同一类坑（engram 记忆 #20091）。`!ok` 分支里必须先 `openChunkFromCloud`、再 `json.Unmarshal`、最后写缓存。`ReadChunk` 调用点从 6 个变成 7 个，新增的 `sync.go:633`（`2712017`）只做存在性检查、不需要解封，但要写进审计表 | **高**（语义） |
| 0007 TLS | `cmd/engram/cloud.go`、`cloudserver.go` 各 1 块 | 上游 `a059fe9`（#1658）加了 `WithVersion` 和 `version` 字段，两边各加一行，都保留。解完按 README 再核对一次路由清单 | 低 |

**步骤**：

1. `git branch fork-rebuild-backup-<日期>` 留备份。
2. 按 `docs/fork-patches/README.md`「路线 B」从 `upstream/main` 新建 `fork-rebuild-next`，`git am -3` 12 个补丁，预计停 4 次。
   每个补丁应用前先核实它要修的问题在上游还在（这次已核实全部还在）。
3. 0006 解完后做变异测试：缓存写入前不解封，`TestCloudRoundTripThroughSealedChunk` 一类的用例必须失败。
   上游新加的 sync 测试（`import_chunk_reuse_test.go`、`missing_payload_recovery_test.go`）会直接读 chunk 正文，要确认它们在加密开着时仍然通过。
4. 按 README「合并后必须验证」：清掉 `ENGRAM_CLOUD_*` 后在干净上游和新分支上各跑一次 `go test -count=1 ./...`，
   比到用例级；`go vet ./...` 只允许出现上游自带的 `caller_binding_test.go` 那 7 条。
5. `regenerate.sh` 重新导出补丁，更新 README 的头表和「本轮」一节；本分支去掉 `docs/fork-patches/` 后要和重放结果逐字节一致。
6. 确认后把 `fork-rebuild` 指向新分支，这一步要改写远程历史，**强推前先征得用户同意**。

**部署**（上次 `3975618` 部署到了 po0 / Mac / macstudio / nuc 四台，见 engram 记忆 #20091）：

- 工具链：`go.mod` 的 go 从 1.25.10 升到 **1.26.10**，`modernc.org/sqlite` 从 1.46.2 升到 **1.58.0**。本机是 go1.27.1，没问题；
  其他机器如果本地构建要先确认 Go 版本，也可以在 Mac 上交叉编译（modernc 是纯 Go，不需要 CGO）。
- 本地数据库：`schemaVersion` 不变，上游只新增了 3 张表，都是 `CREATE TABLE IF NOT EXISTS`：
  `project_aliases`、`capture_project_provenance`、`session_finalizations`。生产代码里没有 ALTER TABLE。
  按代码判断回退到 `3975618` 仍能打开新库，只是丢掉这几项新功能——**这一点还没实测**。
  部署前每台都备份 `engram.db`（连同 `-wal`、`-shm`）和 `cloud.key`，先拿库副本用新、旧二进制各打开一次。
- 云端：`chunkcodec` 有一处行为变化（`45a8b2a`：session ID 不再去首尾空白）。po0 上的 cloud server 和各客户端一起升级。
- 部署涉及远程机器和真实数据，每台动手前都要征得用户同意；Claude、Codex、Pi 的冒烟按上次的清单再走一遍。

**验收**：补丁重放一致性；用例级零回归；`engram version` 显示新的伪版本；本机 `GET /runtime-contract` 可用，
返回的 `contract_id` 是 `engram.pi-http-runtime/v1`；四台机器 Claude、Codex、Pi 冒烟通过。

### P1 骨架与读写

- 内容：config、client、server、contract、project、session、tools，以及 `cordis.patch.yml`，配齐单测。
- 验收：
  - 单测全部通过；
  - 契约副本与 Pi 那份逐字节相同的测试通过；
  - 用真实 Go server 跑通 `mem_save` → `mem_search` → `mem_context` 往返（复用 `plugin/pi/test/support/real-server`，不再复制第三份）；
  - 覆盖 409、resume 续接、项目解析失败、`explicit_project_required`、契约不匹配五类用例。

### P2 捕获、压缩、协议

- 内容：capture、compaction、protocol section、`current_prompt`；两个 Go 协议清单测试加上 `plugin/dsh`；CI 的 Plugin Tests job 加一个 step。
- 验收：
  - 单测通过；
  - `TestMemoryProtocolSourceInventory`、`TestMemoryProtocolDeliveryGuarantee` 通过。

### P3 真实宿主

- 真实 cordis 挂载测试：从本机 DSH 安装目录 import 真实的 cordis 和 dsh-tools，按 `link:` 方式挂载插件，目录不存在就跳过。
  参照 dsh-solana-re 的 `tests/host-registration-real.integration.test.ts`。
- 隔离环境端到端冒烟（第 7 节），通过后装进 acp（第 8 节）。

**P3 完成情况（2026-10-25）**：

- P3a：`test/host-real.test.mjs` 用本机 DSH 安装中真实的 cordis、dsh-tools、dsh-system-prompt、dsh-scope 挂载插件，验证以下几点：
  - 注册与 output schema；
  - 重名时挂载失败并回滚；
  - 真实 assemble 下协议段和按 agent 区分的恢复提示；
  - 走 ToolRuntime 真实执行路径时通过输出校验；
  - serial 事件不抛错；
  - dispose 后全部撤销。

  `DSH_RUNTIME_ROOT` 不存在时整组跳过。
- P3b：编排者亲自执行，报告在 `engram-reports/p3b/report.md`。做法是 `dsh --profile headless --patch <overlay>`，
  overlay 里插件行的 `name` 写 `plugin/dsh/index.ts` 的绝对路径，宿主会转成 file URL 直接加载，**不改任何 profile**。
  续接已有会话用 headless 的 `--session-id <id>`（没有 `--resume`）。
  冒烟项 1–5、7 通过，第 6 项按上面 4.4 的更正不适用。
- 冒烟中发现并修复的问题：
  - F6：可选参数为空串时当作未传；`mem_update` 在 `find` 非空时保留空的 `replace`。
  - F7：持续性配置错误按原因去重，用 error 级别报一次。cordis 默认日志等级会过滤 warn。
  - F8：fork 补丁 0013 的钥匙串镜像改为有界调用、密钥走 stdin。之前 `engram serve` 在自动同步加新数据目录时会卡住启动。
- 执行纪律：在 zsh 里 `env $VAR` 不会按空格拆分。清掉 `ENGRAM_*` 必须用 bash 包装脚本，并在子进程里核对。

### P4 setup、satellite、应答丢失恢复（Q4 已定）

按依赖顺序，每项一个补丁：

1. `mem_save` 应答丢失恢复（4.12），连同 plugin-thin 的规则改动。
2. satellite 跨项目写入（4.11）。
3. `engram setup dsh`（4.13）。放最后，因为它要内嵌前两项完成后的文件。

验收：各自的单测和真实 server 测试；`engram setup dsh` 在临时 `DSH_HOME` 里跑通安装、重复安装和冲突拒装三种情况。

## 7. 验证

```sh
# 单测：不装依赖，做法同 Pi 的 test/plugin-sandbox.mjs。仓库路径不在 node_modules 里，Node 22.18+ 能直接剥类型
cd plugin/dsh && timeout 120s node --test --test-concurrency=1 test/*.test.mjs
# 协议契约测试：上游测试会读环境里的 ENGRAM_CLOUD_*，先清掉
env -u ENGRAM_CLOUD_SERVER -u ENGRAM_CLOUD_TOKEN -u ENGRAM_CLOUD_CA_FILE -u ENGRAM_CLOUD_AUTOSYNC \
  timeout 600s go test ./plugin/ ./internal/setup/ -run 'MemoryProtocol'
```

### 端到端冒烟的隔离要求

- 用临时的 `ENGRAM_DATA_DIR` 和一个非 7437 的 `ENGRAM_PORT`，unset 全部 `ENGRAM_CLOUD_*`，单独起一个 `engram serve`。
- 在临时 `DSH_HOME` 下建 profile，用 `link:` 装 `plugin/dsh`，`ENGRAM_URL` 指向上面这个临时 serve。
- 全程不连真实的 7437 端口，也不连云端。

### 冒烟清单

1. `mem_current_project` 返回正确的项目。
2. `mem_save` 之后，用指向临时数据目录的 `engram search` 能查到，`session_id` 等于 DSH 的 agent id。
3. resume 同一个 DSH 会话后再写，仍然落在同一个 session 行。
4. `mem_session_end` 之后再写，落到 `<id>:resume:N`（编号由服务端分配）。
5. 触发一次压缩，能看到 compaction-recovery 观察，恢复提示只出现一次。
6. 服务端返回 `explicit_project_required`（HOME 是 Git 仓库、在其未跟踪子目录中）或项目歧义时，写入被拒绝，并有日志提示。
7. 不设 `ENGRAM_URL` 时停掉 serve，下一次写入会自动拉起；改 `ENGRAM_PORT` 后拉起的端口正确。
8. 同一 profile 里再装 dsh-gentle-engram，能看到明确的冲突报错。
9. 把插件里的契约副本改坏一个字段，所有记忆操作被拒绝，并提示升级。
10. （P4）显式 `project` 写到另一个项目，落在 `<id>@<project>` 行；`mem_save` 的 POST 应答被人为丢弃后，结果靠 save-result 确认，没有重复写入。
11. （P4）在临时 `DSH_HOME` 里跑 `engram setup dsh` 两次，第二次不重复安装；预置 dsh-gentle-engram 后拒装。

### 补丁登记后的校验

运行 `./docs/fork-patches/regenerate.sh`，再把全部补丁 `git am` 到纯净的上游基线上，
产出的 tree 应该和本分支去掉 `docs/fork-patches/` 后一致。

## 8. 安装、切换与回滚

### 8.1 目标 profile：acp（Q3 已定）

Paseo 里两个 DSH provider 用的都是 `acp`：

- 内置的「DeepSeek Harness」provider 是一个 Paseo 插件，启动命令是
  `dsh --profile ${DSH_PASEO_PROFILE:-acp}`（`~/.paseo-solarb/plugins/deepseek-harness/<id>/checkout/plugins/deepseek-harness/server/dsh-compatibility.ts:153-159`）。
  配置和守护进程环境里都没有设 `DSH_PASEO_PROFILE`。
- 自定义 provider `dsh-solana-worker` 的命令是 `dsh --profile acp`（`~/.paseo-solarb/config.json` 的 `agents.providers`）。
- 运行时佐证：当前唯一的 DSH 进程是 `node ~/.local/bin/dsh --profile acp`，父进程是 Paseo Daemon。

acp 现状（`dsh plugin --profile acp list`）：`dsh-subagent-claude-code`、`dsh-subagent-codex`、`@norman-else/dsh-claude`，
以及以 `link:` 安装的 `dsh-solana-re`。没有 engram 的 MCP 行，也没有 dsh-gentle-engram，不需要先清理。

装进 acp 的影响：

- Paseo 里所有 DSH agent（包括做 Solana 逆向的 `dsh-solana-worker`）都会读写 engram，项目按各自会话的 cwd 解析。
- acp 只在启动时组装插件，没有 HMR。Paseo 的 ACP provider 看起来是每个 agent 起一个 `dsh --profile acp` 子进程
  （它的 README 记录过一次 teardown「关闭了全部 6 个 ACP profile 子进程」），所以装好以后新建的 agent 才带插件，
  已有的 agent 要重建。P3 实测确认。重启 Paseo 守护进程会打断所有 agent，要先征得同意。
- DSH 子进程继承 Paseo 守护进程的环境，实测其中有 `ENGRAM_CLOUD_*` 系列变量（只核对了变量名）。
  本机的 `engram serve` 由 launchd 服务 `dev.engram.serve` 常驻在 7437 端口，插件正常情况下直接复用它，不需要自己拉起。

acp 的 `cordis.patch.yml` 把 `agent-preset-registry` 的默认值设成了 `claude`（`@norman-else/dsh-claude` 提供，
让本机 Claude Code CLI 接管循环和工具）。如果 Paseo 的 DSH 会话走的是这个 preset，插件注册的工具就到不了模型。
已用运行时证据排除：2026-10-25 Paseo 建的一个 acp 会话（cwd 为 solana-arbitrage）走的是 DSH 自己的循环，
provider `codex-relay`、模型 `gpt-5.6-sol`，调用了 DSH 的 `bash` / `read` 和 dsh-solana-re 的 `sol_decompile` 等工具，
会话头里没有 `agentPreset`。P3 冒烟时再确认一次。

web 和 headless 暂不安装，需要时同样用 `link:` 加装。

### 8.2 步骤

- 安装前备份 acp 的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`。
- P3 阶段手动安装：`dsh plugin --profile acp add <仓库绝对路径>/plugin/dsh`（本地路径必须是绝对路径，会以 `link:` 方式安装）。
  P4 之后改用 `engram setup dsh`，它会把链接改指到 `~/.engram/integrations/dsh/`。
  `dsh plugin` 实际是通过 corepack 转发给 pnpm（本机第一次调用时下载了 pnpm 12.15.0）。
- 装好后在 Paseo 里新建一个 DSH agent 做冒烟；已有的 agent 按上面说的重建。改了插件源码也要重建 agent 才生效。
- 如果以后在别的 profile 安装，而那里已经有 dsh-gentle-engram 或官方的 engram MCP 行，先移除。

### 8.3 回滚

- 用 `dsh plugin --profile acp remove @cpkt9762/engram-dsh` 卸载，再核对 `package.json` 的 `dsh.profile.bundles`
  里已经去掉这个包；对不上就直接恢复备份，然后重建 Paseo 里的 DSH agent。
- 记忆都存在 engram 里，卸载插件不会丢数据。

## 9. fork 补丁登记

- 补丁按改动面拆分，接在 P0 重放后的 12 个补丁后面：
  - P1–P3：`plugin/dsh` 新目录一个；两个 Go 清单测试、`.gitattributes` 和 `ci.yml` 一个；
  - P4：应答丢失恢复（含 plugin-thin）、satellite、`engram setup dsh` 各一个。
- 每加一个补丁都跑 `regenerate.sh`，并更新 `docs/fork-patches/README.md`：头表的补丁数、补丁清单表、逐补丁说明。
  冲突风险：`plugin/dsh` 是新目录，低；Go 测试清单、`ci.yml`、`internal/setup`、`cmd/engram/main.go`、文档，上游经常改，中。
- 提交信息用 Conventional Commits，**末尾带 `Co-Authored-By` 署名（Q5 已定，跟 fork 现有习惯）**。
  `fc43849..3975618` 的 13 个提交全部带这一行：10 个是 `Claude Opus 5 <noreply@anthropic.com>`，
  3 个是 `Claude Opus 5.5 <noreply@anthropic.com>`；作者和提交者都是 `cpkt9762`。
  上游禁止这个 trailer（`upstream/main:CONTRIBUTING.md:636`，本分支在 `:445`；`skills/commit-hygiene/SKILL.md:28` 也写了），
  但 fork 的提交不往上游送；哪天要把某个补丁提给上游，再在那个 PR 里去掉。

## 10. 风险

| 风险 | 对策 |
|---|---|
| DSH 0.2.0 还是 rc，事件名和 API 会变。dsh-gentle-engram 0.7.0 就因为 `agent/session-start` 改名成 `agent/created` 坏过一次 | peer 精确钉版本；真实 cordis 挂载测试把事件名锁住；升级 DSH 前先跑 P3 冒烟 |
| 契约副本和上游 Pi 强耦合（方案 A） | 副本与 Pi 那份逐字节相同由测试保证；每次 P0 式重放后一起更新；分叉时改方案 B |
| P0 的 0006 解法错误会让密文进本地库（上次部署时出过同类事故） | 按 P0 第 3 步做变异测试；部署前备份数据库，先在库副本上试 |
| 新二进制写过的库回退到 `3975618` 的兼容性只做了代码判断 | P0 部署前用库副本实测新、旧二进制各打开一次 |
| Node 剥类型的前提变了（DSH 改用 Node 22.18 以下，或改成把插件拷进 `node_modules`） | `engines.node` 声明下限；P3 的真实宿主测试按 `link:` 方式挂载，加载失败会直接暴露 |
| `context` 和 `section` 的细节、子 agent 消息的来源、重名工具的处理 | 已从 DSH 源码核实（4.2、4.5、4.6、4.7）；P3 真实宿主测试和冒烟再确认一次 |
| acp 的默认 preset 是 `claude`，如果 Paseo 会话走它，插件工具到不了模型 | 已用运行时证据排除（8.1）；P3 冒烟再确认 |
| 由 DSH 拉起的 serve 可能不带云同步环境变量 | 风险已降低：本机 serve 由 launchd 的 `dev.engram.serve` 常驻，插件直接复用；Paseo 起的 DSH 进程环境里也有 `ENGRAM_CLOUD_*`。README 仍写明 |
| 每个工具结果都发一次 passive 请求 | 和 Pi 相同；需要时再加开关 |
| P4 setup 改的都是上游热文件，每次重放都可能冲突 | setup 单独成一个补丁、放在最后；文档只改必须改的几处 |

## 11. 已定事项（2026-10-25）

| # | 问题 | 决定 | 依据 |
|---|---|---|---|
| Q1 | 基线 | 先把 fork 跟到上游最新（P0），再开发 | 用户决定；试重放显示 4 处冲突，可行 |
| Q2 | 语言 | TypeScript，不构建，只用可擦除语法，只以 `link:` 安装 | 跟 engram 适配器的惯例（Pi、OpenCode），见 4.1 |
| Q3 | profile | `acp` | Paseo 的两个 DSH provider 都启动 `dsh --profile acp`，见 8.1 |
| Q4 | P4 范围 | 做 `engram setup dsh`、跨项目 satellite 写入、`mem_save` 应答丢失恢复；不发 npm | 用户决定 |
| Q5 | 提交署名 | 带 `Co-Authored-By` | fork 现有 13 个提交全部带，见第 9 节 |

dsh-gentle-engram 的只读源码副本（`/tmp/dge-src-ro`）已删除。文中引用的它的文件和行号，以 GitHub 上
`ForeverYoungPp/dsh-gentle-engram` 的 `18b4c9e` 为准。

## 12. 参考

上游（`upstream/main` = `f82c184`）：
- runtime contract：`internal/server/runtime_contract.go:46-168`、`tools/runtime-contract/main.go`、`tools/runtime-contract/main_test.go:25-45`、
  `plugin/pi/runtime-contract.json`、`plugin/pi/runtime-contract.js:6-24`、`docs/RUNTIME-CONTRACT.md`
  （文档里写的 31 条绑定、22 个操作已过时，代码是 32 和 23）
- `plugin/pi/index.ts`：
  - 契约校验 :763、:766-845
  - 服务发现与归属 :911-987、:1386-1428
  - mem_save 恢复 :553-655
  - satellite :1758-1845、:1939-1963、:2417-2423
  - prompt 捕获 :3129-3206；`current_prompt` :2481-2485
- `plugin/pi/test/`：`plugin-sandbox.mjs`、`cross-project-saves.test.mjs`、`native-tool-contract.test.mjs:441-480`、`support/real-server/main.go`
- `internal/server/server.go`：`requireAuth` :175-186、路由 :494-543、capabilities :558、`POST /sessions` :589-627、
  save-result :689-711、`operation_id` :745-769
- `internal/server/prompt_capture_decision.go:13-47`、`internal/server/agent_workflows.go`
- `internal/setup/`：`agents.go:16-196`、`registry.go:66-76,358-416`、`setup.go:35-45,73-74,291-322,505-573,985-1050,1618-1672`、
  `generate.go:6`、`memory_protocol_test.go:152-168,291-334`、`registry_test.go:249-270`、`setup_test.go:26,42,672-681,808-822`
- `plugin/delivery_guarantee_test.go:11-22,41-46`
- `skills/plugin-thin/SKILL.md:23-54`、`skills/commit-hygiene/SKILL.md:28`
- `docs/CAPTURE-PROJECT-PROVENANCE.md`、`DOCS.md:274,401-415`
- `.github/workflows/ci.yml:470-511`（Plugin Tests）、`CONTRIBUTING.md:241,636`

本仓库（`3975618`）：
- `internal/store/store.go:3411`：`ResumeSessionWithOwnershipModeTimed`，以及同文件的 `continuationSessionTx`
- `cmd/engram/main.go:1001-1010`：`resolveServeOptions` 读 `ENGRAM_PORT`
- `docs/fork-patches/README.md`：「下次合并官方代码怎么做」「补丁清单」「每个补丁」

dsh-gentle-engram v0.7.3（`18b4c9e`）：
- `docs/DESIGN.md`：为什么放弃 MCP 桥、各项不变式、已知遗留
- `src/index.ts`、`src/registration.ts`、`src/engram/server.ts`、`src/engram/project.ts`、`src/capture.ts`、`src/tools.ts`

DSH 0.2.0-rc.2（`~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下）：
- `dsh-package-manifest/README.md:33-46`：`dsh.bundle.patch`
- `dsh-plugin-manager/README.md`：安装、版本兼容、豁免
- `dsh-app-boot/README.md`：patch 层序、peer 解析
- `dsh-agent/lib/types/runtime-types.d.ts`：生命周期事件
- `dsh-agent/lib/types/types.d.ts:13`：`Agent.id` 即 `SessionId`
- `dsh-system-prompt/lib/types/index.d.ts:47-79,191-197,225-262`、`dsh-system-prompt/README.md:28,47,82,111`
- `dsh-compaction/README.md:95,116`
- `dsh-tools/lib/index.js:838`（`defineTool`）、`dsh-tools/README.md`
- 加载与打包：`dsh-app-boot/lib/index.js:286-311`（peer 检查）、`:495-509`（`dsh.bundle.patch`）、`:3559-3572`（patch 列表）；
  `cordis-plugin-loader/lib/index.js:214-226,664-669`；`cordis/lib/index.js:956-962`（无 `Config` 时原样传入配置）
- 事件：`dsh-agent/lib/types/runtime-types.d.ts:148,227-242,263-266,387-391`；`dsh-agent/lib/index.js:579-583`；
  `dsh-agent-loop/lib/index.js:999-1030`；`dsh-tools/lib/types/index.d.ts:92`；`dsh-session/lib/types/index.d.ts:64`
- 工具：`dsh-tools/lib/types/index.d.ts:115-191,216-242`；`dsh-tools/lib/index.js:34-49,2634,2878-2888,3294-3318,3616-3631`
- context 快照与插值：`dsh-agent-loop/lib/index.js:334-349`；`dsh-system-prompt/lib/index.js:146-180`
- 子 agent 来源：`dsh-subagent-in-process-driver/lib/index.js:207-210`、`dsh-subagent/lib/index.js:470-481,1738-1739`

本机其他：
- dsh-solana-re `src/adapters/dsh/tool.ts`：不用 `defineTool` 直接构造 `ToolDefinition`
- Paseo DeepSeek Harness 插件 `server/dsh-compatibility.ts:153-159`

# Fork 补丁记录

这个目录记录 `cpkt9762/engram` 相对上游 `Gentleman-Programming/engram` 的**全部**改动，
目的只有一个：**下次合并官方最新代码时，知道每一处改了什么、为什么改、冲突了该怎么办。**

| | |
|---|---|
| 上游基线 | `upstream/main` = `47f281c`（2026-08-17） |
| 补丁数 | 11 |
| 分支 | `fix/cjk-trigram-per-term-fallback` |
| 改动面 | 15 个文件，+2659 / -111 行（其中约一半是测试） |

**已验证**：这 11 个补丁 `git am` 到纯净的 `47f281c` 上，产出的 tree 是
`db0170bcf5c0` —— 与本分支**去掉 `docs/fork-patches/` 之后逐字节一致**
（这个目录本身不在补丁序列里，见文末「重新生成」）。
也就是说这份记录不是事后描述，而是可重放的等价物。

---

## 下次合并官方代码怎么做

上游动了之后走这套流程。**先做路线 A，冲突多到难受再退到路线 B。**

### 路线 A：rebase（默认）

```bash
git fetch upstream
git switch fix/cjk-trigram-per-term-fallback
git rebase upstream/main
# 有冲突就按下面「每个补丁」一节里的锚点逐个解
./docs/fork-patches/regenerate.sh    # 重新生成补丁文件，让记录跟上
```

### 路线 B：重放补丁（rebase 打成一团时）

```bash
git fetch upstream
git switch -c fork-rebuild upstream/main
git am docs/fork-patches/*.patch
# 某个补丁挂了:
#   git am --show-current-patch=diff   看它想改什么
#   手工改完 -> git add -A && git am --continue
#   这个补丁已被上游实现 -> git am --skip
./docs/fork-patches/regenerate.sh
```

路线 B 的好处是**一次只面对一个补丁**，而且能干净地放弃已被上游实现的那些。

### 合并后必须验证

```bash
# 上游测试不是 hermetic 的,会读环境里的 ENGRAM_CLOUD_*,必须清掉再跑
env -u ENGRAM_CLOUD_TOKEN -u ENGRAM_CLOUD_CA_FILE -u ENGRAM_CLOUD_AUTOSYNC \
    go test ./...
```

基线是 **23 个包全过、0 失败**。不清环境变量的话 `cmd/engram` 会有 4 个
`TestCmdServeSyncStatus*` 假失败（autosync 被 env 唤醒，phase 从 `idle` 变 `running`），
**那不是补丁的问题**，别去改代码。

中文检索的功能验证另有一套（不在本仓库）：
`~/Developer/work/AIGC/engram-migration/verify_recall.py`，23 项召回断言。

---

## 补丁清单

风险栏是**上游改动撞上来的概率**，不是补丁本身的质量。

> 下文的行号是**基于 `47f281c` 的快照**，rebase 之后会漂移。
> 真正稳定的锚点是**函数名**，行号只是帮你第一次定位。
> 本文档写入时全部行号和测试名都逐条核对过。

| # | 补丁 | 主要文件 | 冲突风险 | 可提上游 |
|---|---|---|---|---|
| 0001 | CJK 检索：trigram FTS + per-term 回退 | `internal/store/store.go` | **高** | 是（见 #537） |
| 0002 | 上一条的回归测试 | `internal/store/store_test.go` | 低 | 是 |
| 0003 | `MaxSearchResults` 20 → 100 | `internal/store/store.go` | 低 | 是 |
| 0004 | prompt import 幂等 | `internal/store/store.go` | 中 | **是（上游 bug）** |
| 0005 | 写入前脱敏凭据 | `internal/store/store.go` | 中 | 是 |
| 0006 | 数据库仅属主可读 | `internal/store/store.go` | 低 | 是 |
| 0007 | 字段级加密包（新包） | `internal/cloud/cloudcrypto/` | **无** | 否（私有需求） |
| 0008 | 两条同步 rail 接入加密 | `internal/sync/sync.go`, `remote/transport.go` | **高** | 否 |
| 0009 | TLS 服务 + 可关 dashboard | `internal/cloud/cloudserver/` | 中 | TLS 部分可以 |
| 0010 | push 失败不再阻断 pull | `internal/cloud/autosync/manager.go` | 中 | **是（上游 bug）** |
| 0011 | 改名时迁移同步队列归属 | `internal/store/store.go` | 中 | **是（上游 bug）** |

### 依赖关系

- **0001 → 0002**：测试依赖实现，一起走。
- **0007 → 0008**：**0007 单独应用不是终态。** 0007 用随机 nonce，0008 改成
  HMAC 派生的确定性 nonce（合成 IV），并把 `TestSealStringIsNonDeterministic`
  改名为 `TestSealStringIsDeterministic`。只应用 0007 会得到一个
  chunk_id 每次都变、服务端去重永不命中的版本。
- **0008 → 0009**：无强依赖，但 0009 的 TLS 是 0008 加密数据实际能安全传输的前提。

---

## 每个补丁

### 0001 — CJK 检索：trigram FTS + per-term 回退

**问题**：上游建 FTS5 表时没指定 tokenizer，默认 `unicode61` 把整段连续汉字当**一个
token**。实测在 18,022 条真实中文语料上，召回率只有 10~30%（`代理` 13/47、`内存` 17/56）。

**做法**：FTS 表改用 `tokenize='trigram'`，检索按 term 分流——
≥3 字符走 FTS MATCH，<3 字符走 `LIKE`/`GLOB`，取交集。

**为什么不是上游 PR #537 那样**：#537 的回退条件是「**所有** term 都短于 3 字符才走
LIKE」。中文里 4 字词配 2 字词是最常见的查法，`反向代理 内存` 这类查询在它那里返回 0
（真值 10）。本补丁是 per-term 判断，不是 all-or-nothing。

**锚点**：
- `tokenize='trigram'` 共 **4 处**，全在迁移路径里：`migrate()`（2 处：
  `observations_fts` 和 `prompts_fts`）、`migrateFTSTopicKey()`、
  `migrateLegacyObservationsTable()`。上游这 4 处都是 0。
- `Store.Search()` — 检索分流
- 新增 `splitSearchTerms()`、`hasCJK()`、`likeEscape()`

**冲突风险高的原因**：上游 PR #526（weighted BM25）和 #537（CJK trigram）都在改
`Store.Search`，而且**互相冲突**。任一合入，本补丁必然冲突。

- 若 #537 合入 → 用上游的 trigram 建表，只保留本补丁的 per-term 分流逻辑，
  并确认 `反向代理 内存` 这类混合查询不返回 0。
- 若 #526 合入 → 把评分改动叠加到分流之后，别丢掉短词那条 LIKE 分支。

**验证**：`TestObservationsFTSUsesTrigramTokenizer`、`TestSearchCJK_MixedLengthQuery`、
`TestSplitSearchTerms_CountsRunesNotBytes`（这条最关键——2 字中文词是 6 字节，
用 `len()` 会误判成长词，整条链路崩掉）

**代价**：trigram 索引膨胀约 5.3×（14.4MB 原文 → 76MB 索引）。2 字查询走全表 LIKE
约 48ms 且与命中数无关；≥3 字走 trigram 约 0.0ms。

---

### 0002 — CJK 回归测试

11 个用例。设计原则是**让目标词只出现在更长的连续串内部**（`代理` 只出现在
`反向代理` 里）——这正是 trigram 和 unicode61 的分水岭，普通用例测不出区别。

覆盖：schema 断言两张 FTS 表都是 trigram、rune 而非 byte 计数、短/长中文词命中长串
内部、长短混合查询、全短词查询、any 模式并集、拉丁短词守词边界（`go` 不命中
`golang`）但紧邻标点仍命中（`(v2)`）、LIKE 元字符保持字面量、负对照。

---

### 0003 — MaxSearchResults 20 → 100

上游硬编码 20，`--limit 1000` 会被**静默截断**。默认值出现在
`DefaultConfig()` 和 `FallbackConfig()` **两处**，只改一处的话 fallback 路径仍是 20。

rebase 时注意：如果上游把这个值改成可配置，直接用上游的，丢掉本补丁。

---

### 0004 — prompt import 幂等

**这是上游 bug。** `Store.Import()` 对 sessions 用 `INSERT OR IGNORE`、对
observations 用 `WHERE NOT EXISTS(sync_id)`，**唯独 prompts 完全不去重**。

后果：迁移不可重试。任何中断后重跑都会让 prompt 语料翻倍，`prompts_fts` 跟着翻倍，
检索结果被污染。实测重复导入一次，49 条变 98 条。

**锚点**：`Store.Import()` 里的 `INSERT INTO user_prompts`，加上和 observations
同构的 `WHERE NOT EXISTS` 守卫。

**验证**：`TestImportSkipsPromptWithExistingSyncID`、
`TestImportGeneratesSyncIDForPromptWithoutOne`

**这条最值得提上游**——改动小、是明确的行为不一致、有测试。

---

### 0005 — 写入前脱敏凭据

**问题**：上游写入路径上唯一的过滤是 `stripPrivateTags()`，而它只是一个正则
`(?is)<private>.*?</private>` —— 要靠 agent **主动**用标签把密钥包起来才会被剥掉。
没有任何密钥模式识别。

实测后果：迁移进来的 18,160 条记忆里有 **11 个唯一凭据、43 处**，包括 2 个
GitHub PAT 和 7 个 `sk-` API key。其中好几条恰恰是在记录「发现了凭据泄露」这件事，
一边写「PAT 明文硬编码在 settings.json」一边把那个 PAT 原样存了进来。

**做法**：新增 `sanitizeForStorage()`，7 类模式（github-pat / `gh[pousr]_` / `sk-` /
`ctx7sk-` / `AKIA` / `xox` / 私钥块整块），挂在 **9 个写入点**上。

**锚点**（`internal/store/store.go`）：
- `AddObservation()` — title + content
- `UpdateObservation()` — title + content
- `preparePromptContent()`
- `EndSession()` — summary（**上游这里连 `<private>` 过滤都没有**）
- `SuggestTopicKey()`

**误报防护**：专门测了「看着像密钥但不是」的文本必须原样保留——
`we use sk-learn for the model`、`the sk- prefix identifies OpenAI keys`、
`AKIA is the prefix for AWS access key ids`。一个会在这些上误伤的过滤器会持续损坏正常记忆。

**注意**：`sanitizeForStorage()` 内部两步（剥标签、脱敏）的**顺序不影响结果**。
变异测试证明颠倒顺序测试仍全过——因为 `<private>` 整块最后都会被删掉。别在注释里
声称有顺序依赖。

**验证**：`TestAddObservationRedactsCredentials`、`TestPromptAndSessionSummaryAreRedacted`、
`TestRedactionLeavesOrdinaryProseAlone`、`TestSuggestTopicKeyDoesNotLeakCredentials`

---

### 0006 — 数据库仅属主可读

上游用系统 umask 建库，实测是目录 `0755` / 文件 `0644` —— 一个 150MB 的记忆库
**同机其他用户可读**。

**做法**：`dataDirPerm = 0o700`、`dbFilePerm = 0o600`，新增 `secureDBFiles()`
在 pragma 之后收紧权限。WAL 模式还会生成 `-wal` 和 `-shm` 两个同样含数据的边车文件，
所以目录权限是主要闸门，三个文件都要覆盖。

**锚点**：`New()`、`newWithoutRepair()`（两处 `MkdirAll`）、`secureDBFiles()`

**验证**：`TestStoreTightensDataDirAndDatabasePermissions`

---

### 0007 — 字段级加密包（新包）

`internal/cloud/cloudcrypto/`，AES-256-GCM。**全新目录，上游没有同名文件，冲突风险为零。**

**为什么是字段级而不是整体加密 payload**：服务端不是哑存储。
`InsertMutationBatch()` 会 `json.Unmarshal` 每条 entry 做 materialize，
`WriteChunk()` 要索引 session 和计数，两者都校验
`entries[i].project` / `sessions[i].id` / `observations[i].sync_id` 非空。
整体加密会在 push 时被直接 413/400 拒绝。

所以只封**服务端从不读的字段**：observation 的 title/content、prompt 的 content、
session 的 summary。JSON 结构和所有结构字段原样保留，**服务端一行都不用改**。

**明确不隐藏的**（服务端要靠这些路由、排序、去重）：项目名、sync_id、session_id、
observation type、scope、topic_key、时间戳、每项目条数。运营者仍能看到
「你在哪些项目上、什么时候、做了多少」，但看不到内容。

**密钥**：`<dataDir>/cloud.key`，32 字节，`0600`。丢了云端数据永久不可读
（本地 SQLite 仍是明文）。

---

### 0008 — 两条同步 rail 接入加密

**这是整套改动里最容易出静默错误的一个补丁**，也是冲突风险最高的之一。

engram 有**两条**云同步通道，漏一条就是静默明文泄露：
- **chunks rail**：`internal/sync/sync.go` 的 `Export`/import 路径
- **mutations rail**：`internal/cloud/remote/transport.go` 的
  `MutationTransport.PushMutations`/`PullMutations`

**锚点**：
- `sync.go:138` `cloudSealer()` — 懒加载密钥
- `sync.go:157` `sealChunkForCloud()` / `sync.go:170` `openChunkFromCloud()`
- 封装点 `sync.go:487`（导出）
- **开封点 3 处**：`sync.go:643`、`sync.go:730`、`sync.go:1242` —— 漏一处就是数据读不回来
- `transport.go:364` `MutationTransport.EnableSealing()`
- `main.go:839` autosync 接入点。**加密初始化失败必须停用同步，不能退化成明文推送。**

**两个必须知道的坑**（都是实测踩出来的）：

1. **`ChunkData` 有第四个字段 `Mutations []store.SyncMutation`。**
   只封 `sessions`/`observations`/`prompts` 三个数组**等于没封**——
   `buildImportMutations()` 优先读这个 journal，每条 title 和正文都有一份完整明文副本
   躺在里面。实测输出：`mutations[1] payload="{...,\"title\":\"project observation\",...}"`。
   而且因为导入走的是 journal，**关掉解密往返测试照样通过**，表面上一切正常。
   `TestCloudExportSealsTheMutationJournalToo` 就是钉这条的。

2. **nonce 必须是确定性的。** chunk_id 由内容哈希推导，服务端会校验
   `chunk id does not match payload hash`。随机 nonce → 同样内容每次密文不同 →
   chunk_id 每次都变 → 服务端内容寻址去重永不命中 → 每次重试堆一个重复 chunk。
   所以用 HMAC 派生的合成 IV。代价是运营者能看出两个字段值相同，但看不出是什么。
   加密必须发生在**算 chunk_id 之前**。

**rebase 要点**：上游一旦改 `Syncer.Export` 或增加 chunk section，就要重新确认
「所有含正文的字段都被封了」。**不要只看测试是否通过**——按上面第 1 条的教训，
必须做变异测试：故意关掉导入解密，往返测试**应该失败**；如果还通过，说明有一条
未封装的路径在供数据。

**验证**：`TestCloudExportSealsContentButKeepsStructure`、
`TestCloudExportSealsTheMutationJournalToo`、`TestCloudRoundTripThroughSealedChunk`、
`TestCloudImportWithWrongKeyFailsLoudly`（错误密钥必须报错，不能静默返回垃圾）、
`TestCloudSealingCanBeDisabled`

---

### 0009 — TLS 服务 + 可关 dashboard

**问题一**：`cloud serve` 只有 `http.ListenAndServe`，**只会明文监听**。
公网部署时 bearer token 和全部元数据明文过网。

**问题二**：dashboard 的 10 个路由无条件注册，其中 `/dashboard/bootstrap` 是
**预认证**的。不用 dashboard 的部署白白暴露这块攻击面。

**做法**：
- `WithTLS(certFile, keyFile)` — 走 `http.ListenAndServeTLS`。半配置（只给 cert
  不给 key）被忽略而不是崩掉，见 `TestWithTLSIgnoresHalfConfiguredPair`。
- `WithoutDashboard()` — 整块 dashboard 路由包在开关里
- 客户端 `newHTTPClient()` + `ENGRAM_CLOUD_CA_FILE` — 把指定 CA 装进
  `tls.Config.RootCAs`，**只信任这一张证书，不碰系统信任库**。
  这一点很重要：自签方案的常规做法是往 System keychain 装信任根（要 sudo、全机生效、
  CA 私钥泄露等于对所有 HTTPS 流量的中间人许可证），这里完全避开了。

**锚点**：
- `cloudserver.go:152` `WithTLS()`、`:165` `WithoutDashboard()`、
  `:176` `WithDashboardFromEnv()`（读 `ENGRAM_CLOUD_DASHBOARD`）、
  `:203` `listenAndServeTLS` 字段
- `CloudServer.Start()`、`CloudServer.routes()`
- `cloud.go:114` 环境变量接入
- `transport.go` 的 `NewRemoteTransport()` / `NewMutationTransport()`

**routes() 里包 dashboard 的边界要小心**：`dashboard.Mount(s.mux, ...)` 才是注册
`/dashboard/` 主入口的地方，它后面那批 `HandleFunc` 只是子路由。只包住后者的话
dashboard 关不掉。`/sync` 路由必须留在开关**外面**。

**验证**：`TestStartUsesTLSWhenCertConfigured`、`TestWithoutDashboardDropsPreAuthRoutes`、
`TestClientTrustsConfiguredCAFile`、`TestClientRejectsUntrustedCertByDefault`、
`TestClientFailsLoudlyOnBadCAFile`

---

### 0010 — push 失败不再阻断 pull

**问题**：`cycle()` 里 push 一失败就 `return`，pull 根本不执行。一个项目没 enroll，
push 返回 `nonEnrolledPendingError`，**整台机器所有项目的拉取一起停摆**。
更糟的是 `recordBlocked` 把 `BackoffUntil` 设成 `nil`，于是每个 poll 周期重试一次、
每次以同样理由失败，**永远卡住不自愈**——节点静默地不再接收远端记忆，直到有人发现。

实测现场：WSL 因 8 条 `solana-arb-bot` 待推积压而 degraded，`last_pulled_seq` 停在
27562 不动，直到 `engram cloud enroll` 解除阻塞才恢复。

**做法**：push 和 pull 是两条独立的 rail，推不上去的节点仍然需要收东西。
无条件执行 pull，push 的错误留到之后再报。

`recordFailureWithReason` 改成显式接收失败阶段，不再从 `m.status.Phase` 推断——
pull 先跑之后，记录 push 错误时 phase 已经是 `PhasePulling`，推断会把每个 push
失败都误标成 pull 失败。

**锚点**：`autosync/manager.go` 的 `Manager.cycle()`、`Manager.recordFailureWithReason()`

**验证**：`TestManagerPullsEvenWhenPushFails`（新增，覆盖传输失败路径和 phase 标注）；
`TestManagerBlocksWhenOnlyNonEnrolledPendingMutationsRemain` 原本断言旧的短路行为，
改为断言「push 被阻塞时 pull 照常执行一次」。

**上游状态**：`Gentleman-Programming/engram` 的 `main` 同样有这个缺陷，rebase 拿不到修复。

---

### 0011 — 改名时迁移同步队列归属

**问题**：`MigrateProject` / `MergeProjects` 只 UPDATE `observations`、`sessions`、
`user_prompts` 三张表的 `project` 列，**不动 `sync_mutations` 的归属**。而
`backfillProjectSyncMutationsTx` 的去重条件只看 `(entity_key, source)`、从不看
project，于是那些行被判定为「已入队」而跳过——**改名永远同步不出去，对端一直沿用旧名**。

实测现场：827 条 observation 的实体表早已改名为 `solana-arb-bot`，同步队列里却仍
记在 `solana-arbitrage` 名下；手动 `engram sync --cloud --project solana-arb-bot`
只推得上去 54 条。

**做法**：把排队中的 mutation 迁到新项目名并清空 `acked_at`，让它们重新推送。
payload 自带 `project` 字段（对端 pull 后 apply 用的就是它），所以一并改写；
`json_valid` 保护 payload 不是 JSON 的行，避免被 `json_set` 置空。

**顺序很重要**：迁移必须在 backfill 之前跑，否则 backfill 会因为同样的去重逻辑
跳过这些实体。

**锚点**：`store.go` 的 `Store.rehomeProjectSyncMutationsTx()`（新增）、
`Store.MigrateProject()`、`Store.MergeProjects()`

**验证**：`TestMigrateProjectRequeuesAlreadySyncedMutations`（新增，模拟「已完成同步」
后改名，断言 mutation 的 project 列、payload 里的 project、以及重新入队三者都对）

**上游状态**：同 0010，上游 `main` 也有这个缺陷。

---

## 本 fork 新增的环境变量

上游都没有，全部是本 fork 引入的。

| 变量 | 作用 | 默认 |
|---|---|---|
| `ENGRAM_CLOUD_TLS_CERT` | 服务端证书路径 | 空 = 明文 HTTP |
| `ENGRAM_CLOUD_TLS_KEY` | 服务端私钥路径 | 空 = 明文 HTTP |
| `ENGRAM_CLOUD_DASHBOARD` | 关掉 dashboard 路由 | 开启 |
| `ENGRAM_CLOUD_CA_FILE` | 客户端信任的 CA（自签证书用） | 空 = 系统信任库 |
| `ENGRAM_CLOUD_ENCRYPT` | 关掉字段级加密 | 开启 |

后两个的判断是**严格等于字符串 `"0"`**（`cloudserver.go:176`、`cloudcrypto.go:111`），
`false` / `no` / `off` 都**不生效**。要关就写 `=0`。

---

## 两个跟补丁无关但会毁掉它的坑

### 1. 千万别 `brew upgrade engram`

补丁版二进制启动时会打印：

```
Update available: 0.0.0-...+dirty -> 1.20.0
To update: brew update && brew upgrade engram
```

**照做会把补丁版换成上游未打补丁的版本**，中文检索静默退回 unicode61，召回率掉回
10~30%，而且不会有任何报错。升级只能走这个 fork 重新编译：

```bash
git fetch upstream && git rebase upstream/main
go build -o ~/.local/bin/engram-patched ./cmd/engram
GOOS=linux GOARCH=amd64 go build -o /tmp/engram-linux-amd64 ./cmd/engram   # 给服务端
```

Claude Code 插件调的是 **PATH 上的裸 `engram`**（不认 `ENGRAM_BIN`，那是
`plugin/pi/` 适配器的机制），所以 `~/.local/bin/engram` 是指向补丁版的符号链接，
且 `~/.local/bin` 必须在 PATH **最前面**——哪天 brew 装了官方版，PATH 顺序决定谁赢。

### 2. 上游测试不 hermetic

见上面「合并后必须验证」。跑 `go test ./...` 前清掉 `ENGRAM_CLOUD_*`。

---

## 重新生成这份记录

```bash
./docs/fork-patches/regenerate.sh                 # 对 upstream/main
./docs/fork-patches/regenerate.sh v1.21.0         # 对某个 tag
```

脚本会跳过只改 `docs/fork-patches/` 的 commit，所以这个目录不会自我记录、
编号也不会每次漂移。**每次 rebase 之后都跑一遍**，否则 GitHub 上的 `.patch`
文件和实际 commit 就对不上了。

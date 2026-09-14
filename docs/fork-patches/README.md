# Fork 补丁记录

这个目录记录 `cpkt9762/engram` 相对上游 `Gentleman-Programming/engram` 的**全部**改动，
目的只有一个：**下次合并官方最新代码时，知道每一处改了什么、为什么改、冲突了该怎么办。**

| | |
|---|---|
| 上游基线 | `upstream/main` = `a2199d9`（2026-09-14，v2.0.0-rc.11） |
| 补丁数 | 10（上一轮 12 个，2 个被上游实现） |
| 分支 | `fork-rebuild` |
| 改动面 | 17 个文件，+2729 / -91 行（其中约一半是测试） |

**已验证**：这 10 个补丁 `git am` 到纯净的 `a2199d9` 上，产出的 tree 是
`be11421dfb9b` —— 与本分支**去掉 `docs/fork-patches/` 之后逐字节一致**
（用 `git diff --quiet` 确认）。这份记录不是事后描述，而是可重放的等价物。

---

## 上一轮基线是什么

上一轮基线是 `47f281c`（2026-08-17），12 个补丁。上游在四周内推进了 **429 个提交**
（220 fix / 37 test / 16 feat），并且**把 module path 改成了 `/v2`** ——
旧补丁里所有 `github.com/Gentleman-Programming/engram/internal/...` 都要改。

`git rebase` 完全不可行：上游把本 fork 改动的文件搅得最狠
（`store.go` +4357/-681、`main.go` +1031/-297、`sync.go` +782/-97）。
本轮走的是路线 B（逐补丁重放 + 手工移植）。

---

## 下次合并官方代码怎么做

### 路线 B：重放补丁（默认，别再试 rebase）

```bash
git fetch upstream
git switch -c fork-rebuild-next upstream/main
git am docs/fork-patches/*.patch
# 某个补丁挂了:
#   git am --show-current-patch=diff   看它想改什么
#   先去上游代码里确认这个 bug 还在不在 —— 本轮 12 个里有 2 个已被上游修掉
#   手工改完 -> git add -A && git am --continue
#   已被上游实现 -> git am --skip
./docs/fork-patches/regenerate.sh
```

**关键纪律**：每个补丁应用前，先去上游代码里核实它要修的问题**还存在**。
本轮如果不做这一步，会平白往上游身上叠两份重复实现（0004 的 prompt 幂等、
0012 的失败上限），其中一份还会和上游语义打架。

### 合并后必须验证

```bash
# 上游测试不是 hermetic 的,会读环境里的 ENGRAM_CLOUD_*,必须清掉再跑
env -u ENGRAM_CLOUD_TOKEN -u ENGRAM_CLOUD_CA_FILE -u ENGRAM_CLOUD_AUTOSYNC \
    go test -count=1 ./...
```

**基线不是「全绿」。** 在纯净的 `a2199d9` 上，这台机器就有 **5 个包失败**：

| 包 | 原因 |
|---|---|
| `cmd/engram` | unix socket 路径超 `sun_path` 限制（macOS TMPDIR 太长） |
| `internal/server` | 同上 |
| `internal/setup` | locale 把 `mañana` 处理成乱码 |
| `internal/version` | `TestUpdateInstructions` 期望 GitHub Releases URL，实得 brew 串 |
| `plugin` | nudge + unix socket |

正确做法是**先在干净 worktree 上跑一遍基线存下来**，再拿改动后的结果比对
失败包集合，而不是追求全绿：

```bash
git worktree add /tmp/engram-pristine upstream/main
(cd /tmp/engram-pristine && env -u ENGRAM_CLOUD_TOKEN -u ENGRAM_CLOUD_CA_FILE \
    -u ENGRAM_CLOUD_AUTOSYNC go test ./... 2>&1 | grep -E '^(FAIL|ok)\s' \
    | awk '{print $1,$2}' | sort > /tmp/baseline.txt)
```

本轮结果：失败包集合与基线**完全一致**，唯一多出的是新增的 `cloudcrypto`（通过）。

---

## 补丁清单

风险栏是**上游改动撞上来的概率**，不是补丁本身的质量。

| # | 补丁 | 主要文件 | 冲突风险 | 可提上游 |
|---|---|---|---|---|
| 0001 | `MaxSearchResults` 20 → 100 | `internal/store/store.go` | 低 | 是 |
| 0002 | prompt import 幂等的回归测试 | `internal/store/store_test.go` | 低 | 是 |
| 0003 | 写入前脱敏凭据 | `internal/store/store.go` | 中 | 是 |
| 0004 | 数据目录仅属主可读 | `internal/store/store.go` | 低 | 是 |
| 0005 | 字段级加密包（新包） | `internal/cloud/cloudcrypto/` | **无** | 否（私有需求） |
| 0006 | 两条同步 rail 接入加密 | `internal/sync/sync.go`, `remote/transport.go` | **高** | 否 |
| 0007 | TLS 服务 + 可关 dashboard | `internal/cloud/cloudserver/` | **高** | TLS 部分可以 |
| 0008 | push 失败不阻断 pull | `internal/cloud/autosync/manager.go` | 中 | **是（上游 bug）** |
| 0009 | 改名时重新入队已 ack 的 mutation | `internal/store/store.go` | 中 | **是（上游 bug）** |
| 0010 | CJK 检索 per-term 分流 | `internal/store/store.go` | **高** | 是 |

### 依赖关系

- **0005 → 0006**：**0005 单独应用不是终态。** 0005 用随机 nonce，0006 改成
  HMAC 派生的确定性 nonce。只应用 0005 会得到一个 chunk_id 每次都变、
  服务端去重永不命中的版本。
- **0006 → 0007**：无强依赖，但 0007 的 TLS 是 0006 加密数据实际能安全传输的前提。

---

## 本轮被上游取代的两个补丁

### 旧 0004 — prompt import 幂等（实现已取代，测试保留）

上游 `Store.Import()` 的 prompt 分支现在用的是
`INSERT ... SELECT ... WHERE NOT EXISTS (sync_id)` + `RowsAffected`，
**和旧补丁一字不差**。实现丢弃，两个回归测试保留为新 0002 ——
它们在上游实现上直接通过，钉的是行为而非补丁。

### 旧 0012 — 失败上限改为限流

上游 `9428a21 fix(autosync): retry after failure ceiling (#882)` 做了同一件事，
思路和实现基本一致。整条丢弃。

---

## 每个补丁

### 0001 — `MaxSearchResults` 20 → 100

上游硬编码 20，`--limit 1000` 会被**静默截断**。默认值出现在
`DefaultConfig()` 和 `FallbackConfig()` **两处**，只改一处的话 fallback 路径仍是 20。

rebase 时注意：如果上游把这个值改成可配置，直接用上游的，丢掉本补丁。

---

### 0002 — prompt import 幂等的回归测试

见上文「被上游取代」。保留 `TestImportSkipsPromptWithExistingSyncID` 和
`TestImportGeneratesSyncIDForPromptWithoutOne`，防止将来重构把守卫弄丢——
那会让每次重试导入都把 prompt 语料翻倍。

---

### 0003 — 写入前脱敏凭据

**问题**：上游写入路径上唯一的过滤是 `stripPrivateTags()`，只是一个正则
`(?is)<private>.*?</private>` —— 要靠 agent **主动**用标签把密钥包起来才会被剥掉。
实测迁移进来的 18,160 条记忆里有 **11 个唯一凭据、43 处**，包括 2 个
GitHub PAT 和 7 个 `sk-` API key。

**上游结构变化（重要）**：`preparePromptContent` 没了，现在叫
`prepareStoredContent`，返回值多了 `TruncationMetadata`。而且
**AddObservation、两条 prompt 路径、UpdateObservation 四个内容写入点全都走它**，
所以正文只需要改这**一处**，不像旧补丁那样挂 9 个点。

剩下需要单独挂的是绕过它的路径：
- `AddObservation()` 的 title
- `UpdateObservation()` 的 title、空内容守卫、title 赋值
- `SuggestTopicKey()` 两处（topic key 会和 observation 一起持久化）
- `EndSession()` 的 summary —— **上游这里连 `<private>` 过滤都没有**

**误报防护**：专门测了「看着像密钥但不是」的文本必须原样保留——
`we use sk-learn for the model`、`AKIA is the prefix for AWS access key ids`。
一个会在这些上误伤的过滤器会持续损坏正常记忆。

**验证**：`TestAddObservationRedactsCredentials`、`TestPromptAndSessionSummaryAreRedacted`、
`TestRedactionLeavesOrdinaryProseAlone`、`TestSuggestTopicKeyDoesNotLeakCredentials`。
上游的 `TestContentTruncationMeasuresRedactedBytes` 也仍然通过——把脱敏放进
`prepareStoredContent` 让字节统计量的是真正落库的内容。

---

### 0004 — 数据目录仅属主可读

**本轮缩小了范围。** 旧补丁声称三个缺口（目录 0755、`engram.db` 0644、
WAL 边车 0644），实测在 `a2199d9` 上**只剩第一个**：

```
PROBE dir           = 0755   <- 唯一缺口
PROBE engram.db     = 0600
PROBE engram.db-wal = 0600
PROBE engram.db-shm = 0600
```

上游的 `ensureDatabaseFile` 已经用 0600 建主库，而 SQLite 让 WAL 边车
**继承主库权限**。目录才是那个还敞着的门。

`secureDBFiles()` 保留，但定位从「修复缺口」改成「升级路径」：
在 `ensureDatabaseFile` 改用 0600 之前建的库仍是旧权限，打开它不会重新改权限。

`EnsureInstanceID` 自带一个 `os.MkdirAll(dataDir, 0o755)`，它在 `newStore` 之后跑、
`MkdirAll` 不改已存在目录的权限，所以原本无害；但它是导出的，
`cmd/engram/main.go:690` 直接调用，所以也改成同一个常量。

**变异测试结论**：去掉 `secureDataDir` → 测试失败（目录断言）；
去掉 `secureDBFiles` → 测试**不失败**。正是这一点让本轮把说法收窄，
而不是照抄旧 commit message。

---

### 0005 — 字段级加密包（新包）

`internal/cloud/cloudcrypto/`，AES-256-GCM。**全新目录，上游没有同名文件，冲突风险为零。**

**为什么是字段级而不是整体加密 payload**：服务端不是哑存储。
`InsertMutationBatch()` 会 `json.Unmarshal` 每条 entry 做 materialize，
`WriteChunk()` 要索引 session 和计数，两者都校验
`entries[i].project` / `sessions[i].id` / `observations[i].sync_id` 非空。
整体加密会在 push 时被直接 413/400 拒绝。

所以只封**服务端从不读的字段**：observation 的 title/content、prompt 的 content、
session 的 summary。JSON 结构和所有结构字段原样保留，**服务端一行都不用改**。

**明确不隐藏的**：项目名、sync_id、session_id、observation type、scope、topic_key、
时间戳、每项目条数。运营者仍能看到「你在哪些项目上、什么时候、做了多少」，但看不到内容。

**密钥**：`<dataDir>/cloud.key`，32 字节，`0600`。丢了云端数据永久不可读
（本地 SQLite 仍是明文）。默认开启，只有 `ENGRAM_CLOUD_ENCRYPT=0` 能关。

---

### 0006 — 两条同步 rail 接入加密

**这是整套改动里最容易出静默错误的一个补丁**，也是冲突风险最高的之一。

engram 有**两条**云同步通道，漏一条就是静默明文泄露：
- **chunks rail**：`internal/sync/sync.go` 的 `Export`/import 路径
- **mutations rail**：`internal/cloud/remote/transport.go` 的
  `MutationTransport.PushMutations`/`PullMutations`

**上游结构变化（本轮踩到的）**：

1. **云导出路径变了。** 现在是 `exportCloudMutationChunks`，会把一次导出
   切成大小受限的多片（#833）。封装要放在**分片循环内部**，且必须在
   `CanonicalizeForProject` 和 `chunkcodec.ChunkID` **之前**——
   服务端会校验 `chunk id does not match payload hash`。

2. **读 chunk 的地方从 3 处变成 4 处。**
   `preflightLegacyChunkOwnership` 是上游新增的，也会读 chunk body。
   漏掉它会让 legacy 导入在密文上报 JSON parse 错误。
   另外 `exportedRelationKeys` 改名成了 `exportedChunkKeys`。

3. `internal/sync` 自己就是 `package sync`，导入标准库要用 `stdsync "sync"`。

**两个必须知道的坑**（都是实测踩出来的）：

1. **`ChunkData` 有第四个字段 `Mutations`。**
   只封 `sessions`/`observations`/`prompts` **等于没封**——
   `buildImportMutations()` 优先读这个 journal，每条 title 和正文都有一份完整明文副本。
   而且因为导入走 journal，**关掉解密往返测试照样通过**，表面上一切正常。

2. **nonce 必须是确定性的。** chunk_id 由内容哈希推导，随机 nonce 会让
   chunk_id 每次都变、服务端去重永不命中。所以用 HMAC 派生的合成 IV。

**rebase 要点**：上游一旦改 `Syncer.Export` 或增加 chunk section，就要重新确认
「所有含正文的字段都被封了」。**不要只看测试是否通过**——必须做变异测试：

```bash
# 关掉全部解封 -> 往返测试必须失败
# 跳过 chunkMutations -> TestCloudExportSealsTheMutationJournalToo 必须失败
```

本轮两条都实测过，分别报
`imported title "enc:v1:..." not present in source` 和
`mutations[1].payload.title went out in the clear: "project observation"`。

**两个上游测试需要改，不是修**（它们断言的正是封装刻意打破的东西）：
- `TestCloudSyncPreservesPiPromptIdentityUnderProjectScope` 跨 store 导入，
  需要 `shareCloudKey`
- cloudstore 的 prompt 删除传播测试按**明文**匹配 dashboard 行。
  dashboard 在本 fork 里永远看不到明文，按明文匹配会让正向断言**空过**。
  helper 改成封装后再比对（确定性 nonce 让它可复现），
  并在明文真的泄漏到 dashboard 时显式失败。#837 的删除传播契约本身没动。

---

### 0007 — TLS 服务 + 可关 dashboard

**上游把 dashboard 做大了**，这是本轮改动最多的一条。

**服务端**：
- `WithTLS(certFile, keyFile)` — 走 `http.ListenAndServeTLS`。
  半配置（只给 cert 不给 key）被忽略而不是崩掉。
- `WithoutDashboard()` / `WithDashboardFromEnv()`（`ENGRAM_CLOUD_DASHBOARD=0`）

**`routes()` 的边界是这条补丁最容易写错的地方。** dashboard 现在有 ~75 行，
横跨 `dashboard.Mount`、`/dashboard/bootstrap`（GET+POST，**预认证**）、
以及 8 条 `/dashboard/admin/*`。本轮把整块抽成 `mountDashboard()` 方法，
守卫包住**调用**。

**如果只把守卫包在 `dashboard.Mount` 之后那批 `HandleFunc` 上**——也就是旧补丁
较小的 diff 暗示的形状——`dashboard.Mount` 仍会注册 `/dashboard`、
`/dashboard/login` 和整个浏览器界面，而 `/dashboard/bootstrap` 返回 404，
**从外面看像是关掉了**。

旧版 `TestWithoutDashboardDropsPreAuthRoutes` 只探 `/dashboard/bootstrap`，
**抓不到这个错误形状**。本轮扩展成探 `/dashboard`、`/dashboard/`、
`/dashboard/login`、`/dashboard/health`、`/dashboard/browser/prompts`、
`/dashboard/admin/users/{id}`，并断言 `/sync/pull` 和 `/health` 必须存活。
变异测试：让守卫失效 → 测试在 `/dashboard` 上失败。

**客户端**：上游新增了 `newRemoteHTTPClient`，带一个「不把 bearer token 带到
非 HTTPS 跳转」的重定向保护。本轮**把 CA 支持合并进它**而不是替换，两重保护都在。
构造函数改为向上传播它的 error —— 坏的 `ENGRAM_CLOUD_CA_FILE` 必须响亮失败，
不能静默退回系统信任库。

`ENGRAM_CLOUD_CA_FILE` **只信任这一张证书，不碰系统信任库**。
自签方案的常规做法是往 System keychain 装信任根：要 sudo、全机生效、
CA 私钥泄露等于对所有 HTTPS 流量的中间人许可证。

---

### 0008 — push 失败不再阻断 pull

**上游至今仍有这个缺陷。** `cycle()` 里 push 一失败就 `return`，pull 根本不执行。
一个项目没 enroll，push 返回 `nonEnrolledPendingError`，
**整台机器所有项目的拉取一起停摆**。更糟的是 `recordBlocked` 把 `BackoffUntil`
设成 `nil`，于是每个 poll 周期重试一次、每次以同样理由失败，
**永远卡住不自愈**。

实测现场：WSL 因 8 条 `solana-arb-bot` 待推积压而 degraded，
`last_pulled_seq` 停在 27562 不动，直到 `engram cloud enroll` 解除阻塞才恢复。

`recordFailureWithReason` 改成显式接收失败阶段，不再从 `m.status.Phase` 推断——
pull 先跑之后，记录 push 错误时 phase 已经是 `PhasePulling`，
推断会把每个 push 失败都误标成 pull 失败。

**一个上游测试断言的正是本补丁移除的行为。**
`TestManagerCyclePartialPushFailureSkipsPullAndHealthyState` 捆了三条断言：
①失败被记录+backoff ②跳过 pull ③不标记 healthy。
①③照旧，只翻转 ②，并把测试改名为
`...StillPullsAndAvoidsHealthyState`，免得名字继续描述 fork 已经没有的行为。
**这是对上游的刻意分歧，不是合并事故。**

变异测试：恢复短路 → 5 个用例失败。

---

### 0009 — 改名时重新入队已 ack 的 mutation

**本轮缩小了范围，上游修掉了一半。**

上游新增的 `migrateProjectSyncIdentityTx` 在 `MigrateProject` 和 `MergeProjects`
里都会跑，会重写 `project` 列和 payload 里的 project 字段（`json_valid` 守卫也一样），
**还额外迁移了 enrollment**——这一点旧补丁没做。这半边现在是上游的，不要重复实现。

但它的 WHERE 是 `acked_at IS NULL`，**只处理待推送的行**。
已经同步完成的行仍指向旧名，而且没人会重新入队它们：
`backfillProjectSyncMutationsTx` 的去重只看 `(entity_key, source)`、从不看 project，
于是判定为「已入队」而跳过。改名永远同步不出去，对端一直沿用旧名。

实测现场：827 条 observation 的实体表早已改名为 `solana-arb-bot`，
同步队列里却仍记在 `solana-arbitrage` 名下；手动同步只推得上去 54 条
（恰好还 pending 的那些）。

`requeueAckedProjectSyncMutationsTx` 只覆盖补集 `acked_at IS NOT NULL`，
并清空 ack 让行重新可推。两者都必须在 backfill 之前跑。

**缺口是实测出来的不是推断的**：只加测试不加实现，在上游实现上报
`expected 3 mutations re-queued under "new-name", got 0`。

---

### 0010 — CJK 检索 per-term 分流

**上游已经自己修了一大半。** `9fc7663 fix(store): support CJK FTS5 search (#924)`
把 FTS 表换成了 `tokenize='trigram'`（4 处全是上游的了），
而且 `hasShortFTSTerm` 用的是 `utf8.RuneCountInString` 而**不是** `len` ——
旧 README 里担心的 PR #537 那个「所有 term 都短才回退」的逻辑也不存在了，
现在是「任一 term 短就回退」，`反向代理 内存` 这类混合查询**不再返回 0**。

**剩下的问题是排序，不是召回。** 上游一旦发现短词就把**整条查询**
送进 `buildSearchLIKEQuery`：`rank` 硬编码 `0.0`，`ORDER BY updated_at`，
BM25、title/content 权重、以及新的 pinned/recency/stability 复合排序**全部丢弃**。
中文里长词配两字词是最常见的查法，所以实际上大多数真实查询都掉进这条路径。

per-term 分流让长词继续走 trigram MATCH，短词在基表上取交集，
结果保留真实相关性分数。`TestSearchCJK_MixedLengthQuery` 现在显式断言
`rank != 0`，改回整条降级就会失败。

**两处 fork 原始形状没能存活**：

1. **`"any"` 模式用不了这套。** OR 语义下短词必须能**增加** FTS 没命中的行，
   而挂在 FTS 联接上的谓词只能**减少**行。这个组合保留上游的 LIKE 扫描，
   正是 `TestShortTermFallbackEscapesAndPreservesFiltersAndMatchModes` 钉住的。
2. **全短词查询**也留在上游 LIKE 路径，不再另开私有路径；
   但 `termPredicate` 让那条路径按脚本区分：短拉丁词走 GLOB 词边界
   （`go` 不再命中 `golang`/`algorithm`），CJK 和 ≥3 rune 的词保持子串匹配。
   上游的列覆盖（含 `type`、`project`）和转义测试原样不动。

**最危险的细节仍然是 rune 而非 byte 计数**：2 字中文词是 6 字节，
用 `len()` 会误判成长词 → 送进 MATCH → trigram 索引不到 → **静默返回 0**。
变异测试：换成 `len()` → 4 个 CJK 用例失败，其中
`expected 2 rows containing 代理 inside a longer run, got 0`。

**代价**：trigram 索引膨胀约 5.3×（14.4MB 原文 → 76MB 索引）。

---

## 重新生成

```bash
./docs/fork-patches/regenerate.sh              # 对 upstream/main
./docs/fork-patches/regenerate.sh v2.0.0-rc.11 # 或对某个 tag
```

脚本会跳过只动 `docs/fork-patches/` 的提交，否则这个目录会自己记录自己、
编号每次都漂。

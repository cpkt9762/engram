# Fork 补丁记录

这个目录记录 `cpkt9762/engram` 相对上游 `Gentleman-Programming/engram` 的**全部**改动，
目的只有一个：**下次合并官方最新代码时，知道每一处改了什么、为什么改、冲突了该怎么办。**

| | |
|---|---|
| 上游基线 | `72e40df`（2026-10-25，v3.6.0 之后） |
| 补丁数 | 14（原12条，0009按上游历史不可变契约重写，新增0013/0014） |
| 分支 | `fork-rebuild-next` |
| 改动面 | 22 个文件，+3418 / -151 行（不含本记录目录） |

**已验证**：本轮补丁 `git am` 到纯净的 `72e40df` 上，产出的 tree 是
`b4cb63b088031373b78c04cb2b6f3845f2a1db60` —— 与本分支**去掉 `docs/fork-patches/` 之后逐字节一致**
（用 `git diff --quiet` 确认）。这份记录不是事后描述，而是可重放的等价物。

---

## 本轮：`fc43849` → `72e40df`

2026-10-25 按路线 B 重放，原有12个补丁的目标和顺序全部保留。
0009经编排者裁决改为生成新upsert、保留ack历史，并折回第9提交；其余原提交信息不变。
`git am -3` 实际停 4 次，0009/0010 的测试文件没有连带冲突：

| 补丁 | 冲突解法 |
|---|---|
| 0003 | 上游拆出 `endSessionSummaryOperation`；只在 `endSessionOperation` 脱敏，再调用 nullable 入口；FinalizeSession 历史值原样保留，新正文走 prepareStoredContent |
| 0004 | EnsureInstanceIDContext 使用 dataDirPerm；ValidateDataDirectory 在 secureDataDir 前；ctx.Err 和 secureDBFiles 都保留 |
| 0006 | decoded 缓存 !ok 分支按 ReadChunk → openChunkFromCloud → Unmarshal → decoded 入缓存，保留上游复用机制 |
| 0007 | 同时保留 WithVersion/version 和 TLS/dashboard 开关；routes()+mountDashboard() 共31条显式路由，与上游逐条一致，Version: s.version 保留 |

本轮额外发现 macOS 测试隔离缺陷：cloudcrypto 创建测试密钥时通过 `security -U`
覆盖真实用户的钥匙串镜像。临时 HOME 无法隔离系统用户的登录钥匙串。
0013 修复镜像覆盖和测试调用；真实 cloud.key 没有改变，真实镜像恢复由编排者另行处理。
后续测试一律使用拒绝系统调用的 security shim，仅记录参数个数与子命令名，不记录密钥。

0009初次保真重放时，新增的 `TestExplicitMergeCanonicalization` 确定性失败：
上游5/5过，fork5/5失败。接受上游“已ack历史不可变”契约，
去掉原地重排，改为修复backfill的project去重条件；普通改名和MergeProjects都有回归测试。
0014补上0006分类缓存的加密覆盖：现有sync全包在删除该处解封后仍绿，
新测试则明确因密文落库而失败，恢复后通过。

**本轮实测用例级零回归**：上游与fork都是4包/5个父用例失败，新增/减少失败集合均为空。
两树在同机go1.27.1下重新完整运行，使用临时HOME/数据目录、物理TMPDIR=/private/tmp、
清除继承的全部ENGRAM_*、禁止自动更新检查，以及拒绝系统调用的security shim。
全量均exit1（基线失败），未超时；store和sync全包均通过，shim日志0行。
采用物理TMPDIR后，此前默认macOS临时路径下的23个基线失败不再适用。

| 包 | 本轮基线失败 | 关键输出/环境 |
|---|---|---|
| internal/cloud/chunkcodec | TestCompressedEnvelopeRoundTripDoesNotExposePayloadText | compressed envelope exposed observation text |
| internal/tui | TestDataLoadingCommands | 禁用更新检查后checkForUpdate的status为空 |
| internal/version | TestCheckLatest、TestUpdateInstructions | 禁用更新检查后status为空；更新指令为brew而非GitHub URL |
| plugin | TestCodexUnixSessionEndAdapter | slow分支出现unexpected POST /runtime-sessions/end请求 |

go build ./...通过；go vet ./...仅caller_binding_test.go的7条上游unkeyed fields。
0009修复后的显式合并测试和两个新增测试连续5次通过；未改上游断言。
0006两份上游新增测试文件import_chunk_reuse_test.go、missing_payload_recovery_test.go包含在sync全包内并通过。

| 本轮变异 | 实测 |
|---|---|
| 0006分类缓存前不解封，原有sync全包 | 仍绿，确认覆盖缺口，新增0014 |
| 0006分类缓存前不解封，新增0014 | 密文落库断言失败，恢复后通过 |
| openChunkFromCloud直通 | TestCloudRoundTripThroughSealedChunk失败 |
| 跳过chunkMutations | TestCloudExportSealsTheMutationJournalToo失败 |
| 0009去掉project去重条件 | 两个新测试均报新upsert为0（预期5） |
| 0009恢复原地改写已ack行 | 上游显式合并及两个新测试均报历史被改变 |
| 0009的project比较加上永不匹配的#后缀 | ack后幂等测试两条路径均失败，journal从12行增至18行；恢复后各5次通过 |
| 0013去掉testing.Testing判断 | 测试触及keychain的断言失败 |
| 0013加回-U | 精确参数断言失败 |

各组变异均已恢复并通过git diff --quiet。完整命令、uptime、退出码与合成库往返证据
交付在本轮P0报告中；真实钥匙串恢复由编排者另行授权处理，不属于本地重放验收。

## 再往前一轮：`5c41718` → `fc43849`

上一轮基线 `5c41718` 后来被上游打成了 **v3.4.0**（标签在 2026-10-12 发布，
指向的正是这个提交）。所以 fork 当时构建出来的 `3.3.3-...` 伪版本，内容就是 v3.4.0 ——
客户端提示 "Update available → 3.4.0" 是假警报，不要跟着跑 brew upgrade。

本轮跟进的是 v3.4.0 之后的 **26 个提交**（尚未发版），主要为了 **#1765**：
Claude Code `--resume` 一个已结束的会话后，写入闸门会拒掉此后所有记忆写入
（`host session already ended`），#1765 让 resume 绑定到 `<id>:resume:N` 续接会话。
闸门逻辑在二进制的 `hook_claude.go` 里，只更新插件修不了。

`git rebase` 只停了 **1 次**：

| 停在 | 形态 | 处理 |
|---|---|---|
| `store.go` 搜索列清单 | 双方各自改动 | 上游给 FTS 查询加了 `o.superseded_by_sync_id` 列，fork 加了 `shortTerms` 参数，两个都要；顺带确认 fork 改过的 LIKE 路径也带上了新列 |

**但"干净应用"不等于不变式还成立。** 上游新增了 `ConsolidateObservations`
（#1782 / #1825，MCP 合并工具），它在**独立文件** `consolidate.go` 里有自己的
`INSERT INTO observations`，调用方传入的 title/content override 直接落库，
既没经过 fork 的凭据脱敏，也没经过上游自己的 `<private>` 剥离。只搜 `store.go`
找不到它 —— **审计写入路径要搜整个 `internal/store/` 包**。已在 0003 里补上，见那一节。

`sync.go` 这轮的 chunk 读写点没有增加（读 6 处、写 2 处），`Export` 被拆成
`Export` → `ExportWithOptions`，但云分支提前 return 仍在同一个函数里、仍排在
`exportedReviewState` 和主干 `WriteChunk` 之前。

**但部署时发现，上一轮放过的 `chunkForEntry` 其实是个真漏洞，而且已经在线上造成了损坏。**
部署后各机本地库里出现 `enc:v1:` 密文的 observation / prompt / session summary
（Mac 上：10-12 升级前 0 条，到 10-13 是 43 条 observation、61 条 prompt），而且每做一次
`sync --import --cloud` 就多一批。追下去：

1. 密文是**单层**的，用本机 `cloud.key` 解一次即得明文 —— 不是重复加密，是导入时没解开。
2. 它们所在的 chunk `created_by` 是 `LEGACY_SYNC`：服务端在**每次收到变更推送时**都会物化一个 chunk。
3. 导入这些 chunk 时，只要前面某个 chunk 里有 relation，就会触发 `importDependencyOracle`
   预分类后续所有 pending chunk。`chunkForEntry` 读的是未解封的字节、把结果放进缓存，
   而应用循环优先复用这份缓存（`dependencyOracle.cachedChunk`），于是密文直接被写入本地库。
4. v1 manifest 会走 legacy 预检，预检会解封并预填缓存，正好把问题盖住 —— 现有上游测试用的都是 v1。
   fork 自己写的 manifest 是 v2。

修复：`chunkForEntry` 先 `openChunkFromCloud` 再解析、入缓存（已并入 0006）。
回归测试 `TestCloudImportOpensChunksCachedByTheDependencyOracle`（fork 独有文件
`sealed_import_test.go`）用 v2 manifest + 加密 chunk 复现，修复前 `obs-oracle-b` 以密文落库。

**只有 chunk 导入会触发**（`engram sync --import --cloud` 等），每 30 秒的 autosync 变更拉取
走 `PullMutations` → `openPulled`，是会解封的。已经写坏的本地行需要单独修复，见部署记录。

## 再往前一轮：`9997a85` → `5c41718`

上一轮基线是 `9997a85`（2026-09-23），同样 12 个补丁。上游在 **18 天内推进了 188 个提交**
（119 fix / 17 feat / 18 test），版本从 v2.x 一路打到 **v3.3.2**，带两个 breaking change：

- `b08308a chore(module)!` 把 module path 改到 **`/v3`** —— 补丁里所有 import 都要改写，
  本轮有 2 个补丁共 20 处引用旧 `/v2` 路径。
- `e8c0ce3 fix(server)!` 要求 HTTP PATCH/DELETE 和 MCP `mem_update`/`mem_delete` 必须带
  `expected_project`。这不影响 fork 补丁，但会影响调用方。

**12 个补丁一个都没被上游实现**，逐条 grep 核实过（`splitSearchTerms` 0 处、
`MaxSearchResults` 仍是 20、`redactCredential` 0 处、`cloudcrypto` 包不存在、
`ENGRAM_CLOUD_TLS_CERT`/`WithoutDashboard` 0 处、`migrateProjectSyncIdentityTx` 仍全是
`acked_at IS NULL`）。只有 0008 被追上一半，见那一节。

**`git rebase` 仍然可行**，即使跨了 188 个提交和一次 module path 变更。全程停了 **6 次**：

| 停在 | 形态 | 处理 |
|---|---|---|
| `store.go` `EndSession` | 真冲突 | 上游重构出 `endSessionOperation`，而且**有两个调用方**（`EndSession` + runtime-session 路径）。把 `sanitizeForStorage` 放进 `endSessionOperation` 内部，比原补丁只盖 `EndSession` 更严 |
| `store.go` `newStore` | 真冲突 | 上游新增 `checkDataDirectoryFilesystem` 必须在建目录**之前**跑（它向上找已存在的祖先，目录一旦存在就短路）。顺序是 check → `secureDataDir` |
| `remote/transport.go` | 双方各自新增 | 上游加了 provenance 方法（session authority / prompt pair claim / source attestation），fork 加了封装方法。两边都留；注意分界线切在 `postProvenance` 中间，要手工补回它的收尾 |
| `cloudserver.go` `routes()` | **边界冲突** | 上游在被补丁搬走的那段里**新增了 4 条 `/sync` 路由**，必须一起挪到 dashboard 开关之外。详见 0007 |
| `autosync/manager.go` | **语义冲突** | 见 0008 的「上游追上了一半」 |
| 四个测试文件的 import 块 | 纯碰撞 | 取 fork 侧（= 上游那组 + `cloudcrypto`）并改写到 `/v3`，然后断言结果是上游那组的超集 |

**module path 变更的处理方式**：不要逐个手改。解冲突时取回 `/v3` 那侧，
最后全局 `grep -rl 'engram/v2' --include='*.go'` 验证为 0。重生成补丁后
再对 `.patch` 文件做一次同样的检查。

**审计 chunk 读写路径不能只按补丁里的处数。** 本轮 `ReadChunk` 有 6 个调用点
（上一轮 5 个），要逐个判断"能不能看到云端 chunk"：

| 调用点 | 是否需要解封 |
|---|---|
| `importEntriesDependencySafeWithProgress` | 要，已有 |
| `preflightLegacyChunkOwnership` | 要，已有 |
| `sessionIDsAvailableInChunks` | 要，已有 |
| `exportedChunkKeys` | 已有（实际是 no-op，见下） |
| `exportedReviewState`（上游新增） | **不需要** |
| `importDependencyOracle.chunkForEntry` | **要** —— 这一行当时判错了，`fc43849` 轮已补，见下 |
| `ExportWithOptions` 本地模式的 payload 存在性检查（72e40df 新增） | **不需要**，只检查 ReadChunk 错误，不解析正文；当前总计7个调用点 |

后两个都查证过，别重复踩：

- **`exportedReviewState` 不可达。** `Export` 在 `if sy.cloudMode` 分支里就 `return` 到
  `exportCloudMutationChunks` 了，而 `exportedChunkKeys`/`exportedReviewState` 在那之后。
  这两个函数**只在本地模式下运行**，永远见不到密文。`exportedChunkKeys` 里那处
  `openChunkFromCloud` 因此是 no-op（`!sy.cloudMode` 时直通）。本轮一度给
  `exportedReviewState` 也补了一处，变异测试证明去掉它整个包照样绿，才发现是不可达代码，已撤回。
- ~~**`chunkForEntry` 无害。**~~ **这条结论是错的，造成了线上数据问题，`fc43849` 轮已修。**
  当时的理由是"封装只盖 title/content/summary，oracle 只读 sync_id，两者不相交"。
  漏看的是：oracle 把读到的 chunk 放进缓存，**应用循环会直接复用这份缓存**，
  不再重新读取和解封。于是凡是被 oracle 预分类过的 chunk，都以密文应用进本地库。
  教训：判断"某处读密文无害"，要追到这份数据**最终流向哪里**，不能只看读的那个函数自己用了哪些字段。

**写入侧同理**：`Export` 主干那个 `WriteChunk` 在 cloudMode 下到不了，不该封装；
云分支的 seal 必须在 `CanonicalizeForProject`/`ChunkID` **之前**，
否则 chunk_id 覆盖的不是服务端实际收到的内容（服务端会校验这两者一致）。

**一处文本合并成功但语义错了**（上一轮的教训，仍然适用）：`sync.go` 的
`exportedChunkKeys` 上游从 4 个返回值改成 5 个，fork 插入的 `openChunkFromCloud`
错误分支仍写着 4 个 `nil`。git 没报冲突，`go vet` 才抓到。
**rebase 后必须跑 `go vet ./...`，不能只看有没有冲突标记。**

**死代码陷阱**：`hasShortFTSTerm` 在 fork 里已经没有调用方了（三个调用点都被
`splitSearchTerms` 换掉），但函数还留着，而且里面也有一个 `< 3` 的长度判断。
本轮做 rune/byte 变异测试时第一次就打在了它身上，测试毫无反应。
要改的是 `splitSearchTerms` 里的 `utf8.RuneCountInString(term) >= 3`。
（上游的 `scripts/deadcode-ratchet.sh` 不报它，`scripts` 包实测通过。）

## 下次合并官方代码怎么做

### 先看上游推进了多少

```bash
git fetch upstream
git rev-list --count HEAD..upstream/main
```

**几十个提交量级 → 可以直接 `git rebase upstream/main`**，但仍要逐条检查语义变化。
**几百个提交、或 module path 变了 → 走下面的路线 B。**
不管走哪条，`git branch fork-rebuild-backup-<日期>` 先留个备份分支。

### 路线 B：重放补丁（上游推进过大时）

```bash
git fetch upstream
git switch -c fork-rebuild-next upstream/main
git am docs/fork-patches/*.patch
# 某个补丁挂了:
#   git am --show-current-patch=diff   看它想改什么
#   先去上游代码里确认问题是否仍在；72e40df轮原12个补丁全部仍需保留
#   手工改完 -> git add -A && git am --continue
#   已被上游实现 -> git am --skip
./docs/fork-patches/regenerate.sh
```

**关键纪律**：每个补丁应用前，先去上游代码里核实它要修的问题**还存在**。
早期一轮若不做这一步，会叠两份重复实现（旧0004的prompt幂等、旧0012的失败上限）。
72e40df轮还证明，补丁干净应用也可能撞上新契约：0009必须重写实现，不能直接跳过上游失败测试。

### 合并后必须验证

```bash
# 使用bash；shim目录需预先创建，只记录security参数个数和子命令后exit1
for name in $(env | cut -d= -f1); do
    case "$name" in ENGRAM_*) unset "$name" ;; esac
done
task_root=$(mktemp -d /tmp/engram-check.XXXXXX)
mkdir -p "$task_root/home" "$task_root/data"
HOME="$task_root/home" ENGRAM_DATA_DIR="$task_root/data" ENGRAM_NO_UPDATE_CHECK=1 \
    TMPDIR=/private/tmp PATH="$shim:$PATH" timeout 1800s go test -count=1 ./...
```

**基线不是「全绿」，而且这一栏每轮都在变，必须每次重新测，不能抄上一轮的。**
macOS必须隔离系统security调用：临时HOME不能隔离钥匙串。测试结束核对shim调用数为0，
保留uptime/退出码，并清理task_root。使用物理TMPDIR可避免/var与/private/var的别名差异。
ENGRAM_NO_UPDATE_CHECK=1会使TestCheckLatest的部分预期不同，两树必须保持同样环境。
本轮最新实测结果见开头“fc43849 → 72e40df”，下表保留为历史记录。
在纯净的 `fc43849` 上，这台机器是 **7 个包 / 23 个用例失败**
（`5c41718` 时是 22 个，多出的 `TestCodexRegisteredSessionHandoff` 见下面"不稳定用例"）：

| 包 | 原因 |
|---|---|
| `cmd/engram` | unix socket 路径超 `sun_path` 限制（macOS TMPDIR 太长） |
| `internal/server` | 同上 |
| `internal/mcp` | ambiguous-project 恢复流程依赖 git 身份 |
| `internal/store` | project history / git 检测依赖本机 git 配置 |
| `internal/setup` | locale 把 `mañana` 处理成乱码 |
| `internal/version` | `TestUpdateInstructions` 期望 GitHub Releases URL，实得 brew 串 |
| `plugin` | nudge + unix socket |

**正确做法是先在干净 worktree 上跑基线存下来，再比对 —— 而且要比到用例级，不是包级。**
`internal/store` 这轮在上游就挂，光看包状态分不清是不是 CJK 补丁弄坏的：

```bash
git worktree add /tmp/engram-pristine upstream/main
(cd /tmp/engram-pristine && env -u ENGRAM_CLOUD_TOKEN -u ENGRAM_CLOUD_CA_FILE \
    -u ENGRAM_CLOUD_AUTOSYNC go test -count=1 ./... 2>&1) > /tmp/baseline.txt
grep -E '^--- FAIL' /tmp/baseline.txt | sed 's/ (.*//' | sort -u > /tmp/base-tests.txt
# 改动后同样抽一份 /tmp/mine-tests.txt, 然后:
comm -23 /tmp/mine-tests.txt /tmp/base-tests.txt   # 我引入的回归
comm -13 /tmp/mine-tests.txt /tmp/base-tests.txt   # 我反而修好的
```

**`fc43849` 这轮结果：零回归。** 失败**包**集合逐包一致，唯一多出的是新增的
`cloudcrypto`（通过）。用例级只有一处差异：`TestCodexRegisteredSessionHandoff`
在基线上挂、在 fork 上过。fork 没碰 codex 相关代码，于是在两棵树上**各单独跑 5 次**，
都是 5/5 通过 —— 它是全量负载下的不稳定用例，那次基线失败是偶发，**不能记成"修好了"**。
单次全量跑出来的差异，先重复跑再下结论。

`go vet ./...` 会报 `internal/server/caller_binding_test.go` 的 7 条 "struct literal
uses unkeyed fields"。干净上游上一模一样，该文件 fork 没改，是上游自带的。

**关键改动都要做变异测试**，否则无从判断测试是否真的在保护它。两轮共 7 组（前 5 组在 `5c41718` 轮；`fc43849` 轮唯一起冲突的是 CJK 那条，已重跑第 1 组）：

| 变异 | 预期 | 实测 |
|---|---|---|
| `splitSearchTerms` 的 rune 计数换成 byte | CJK 短词召回归零 | 6 个用例 FAIL |
| `openChunkFromCloud` 改成直通 | 云往返读到密文 | `TestCloudRoundTripThroughSealedChunk` FAIL |
| dashboard 开关包住一条 `/sync` 路由 | 该路由随 dashboard 消失 | `TestWithoutDashboardDropsPreAuthRoutes` FAIL |
| `cycle()` 恢复 push 失败就 return | pull 被阻断 | 7 个用例 FAIL |
| 去掉 `exportedReviewState` 的解封 | （本轮用来**判定该不该加**） | 全包仍绿 → 证明不可达，改动已撤回 |
| 合并 override 不过 `sanitizeForStorage`（`fc43849` 轮） | 凭据落库 | 测试先于修复写，修复前在 plan 一步就 FAIL |
| `chunkForEntry` 不解封（`fc43849` 轮，部署时发现） | oracle 缓存的密文被应用进本地库 | 测试先于修复写，修复前 `obs-oracle-b` 以密文落库 |

最后一行是这套方法最有用的一次：它否掉了一个**看起来显然该加**的改动。

---

## 补丁清单

风险栏是**上游改动撞上来的概率**，不是补丁本身的质量。
括号里是实际撞上的轮次 —— `5c41718` 这轮 0003/0004/0006/0007/0008 都停了。

| # | 补丁 | 主要文件 | 冲突风险 | 可提上游 |
|---|---|---|---|---|
| 0001 | `MaxSearchResults` 20 → 100 | `internal/store/store.go` | 低 | 是 |
| 0002 | prompt import 幂等的回归测试 | `internal/store/store_test.go` | 低 | 是 |
| 0003 | 写入前脱敏凭据 | `internal/store/store.go` | 中 | 是 |
| 0004 | 数据目录仅属主可读 | `internal/store/store.go` | 低 | 是 |
| 0005 | 字段级加密包（新包） | `internal/cloud/cloudcrypto/` | **无** | 否（私有需求） |
| 0006 | 两条同步 rail 接入加密 | `internal/sync/sync.go`, `remote/transport.go` | **高** | 否 |
| 0007 | TLS 服务 + 可关 dashboard | `internal/cloud/cloudserver/` | **高** | TLS 部分可以 |
| 0008 | push 失败不阻断 pull | `internal/cloud/autosync/manager.go` | **高**（连续两轮语义冲突） | **是（上游 bug）** |
| 0009 | 改名后生成新upsert，保留ack历史 | `internal/store/store.go` | 中 | **是（上游 bug）** |
| 0010 | CJK 检索 per-term 分流 | `internal/store/store.go` | **高** | 是 |
| 0011 | 测试信任测试 CA，不再换 `DefaultTransport` | `cmd/engram/autosync_e2e_test.go` | 中 | 否（依赖 0007） |
| 0012 | 断言明文前先解封 chunk | `internal/sync/sync_test.go` | 中 | 否（依赖 0006） |
| 0013 | 钥匙串镜像不覆盖、测试不访问系统钥匙串 | `internal/cloud/cloudcrypto/` | 低 | 否（依赖 0005） |
| 0014 | 分类缓存解封后的明文落库回归测试 | `internal/sync/sealed_import_test.go` | 低 | 否（依赖 0006） |

### 依赖关系

- **0005 → 0006**：**0005 单独应用不是终态。** 0005 用随机 nonce，0006 改成
  HMAC 派生的确定性 nonce。只应用 0005 会得到一个 chunk_id 每次都变、
  服务端去重永不命中的版本。
- **0006 → 0007**：无强依赖，但 0007 的 TLS 是 0006 加密数据实际能安全传输的前提。
- **0006 → 0012**：加密 chunk 的明文断言必须先解封。
- **0007 → 0011**：独立 TLS transport 需要通过显式 CA 入口信任测试服务器。
- **0005 → 0013**：修复 cloudcrypto 创建密钥时的系统钥匙串副作用。
- **0006 → 0014**：保护session分类的decoded缓存，不让后续调用将密文应用进本地库。

---

## 曾被上游取代的两个补丁（`a2199d9` → `9997a85` 那轮）

### 旧 0004 — prompt import 幂等（实现已取代，测试保留）

上游 `Store.Import()` 的 prompt 分支现在用的是
`INSERT ... SELECT ... WHERE NOT EXISTS (sync_id)` + `RowsAffected`，
**和旧补丁一字不差**。实现丢弃，两个回归测试保留为新 0002 ——
它们在上游实现上直接通过，钉的是行为而非补丁。

### 旧 0012 — 失败上限改为限流

上游 `9428a21 fix(autosync): retry after failure ceiling (#882)` 做了同一件事，
思路和实现基本一致。整条丢弃。

`5c41718` 这轮**没有新增被取代的补丁** —— 12 条全部仍需保留。

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

**`5c41718` 这轮 `EndSession` 又变了**：上游把它重构成 `endSessionOperation(id, summary)`，
返回一个 `func(*sql.Tx) error`，而且**有两个调用方** —— `EndSession` 和上面那个
runtime-session 创建路径。脱敏放进 `endSessionOperation` **内部**而不是 `EndSession`，
两个调用方一起覆盖，比原补丁更严。

**`72e40df` 轮**：上游又拆出 `endSessionSummaryOperation(id, summary any)`。
脱敏仍在 `endSessionOperation(id, summary string)`，再经 `nullableString` 传给新 helper；
不能放进新 helper，否则 FinalizeSession 保留的历史 summary 会被再次改写。
脱敏/裁剪后若为空，保存为 NULL；相对旧 fork 的空字符串，JSON 的 `summary:""`
会变成省略字段，这是可见行为变化。私密标签和凭据通常替换为 `[REDACTED]`，并不会变空；
纯空白会变空。FinalizeSession 对历史 NULL/空串的精确保留不变。

**`fc43849` 这轮多了一条绕开 `prepareStoredContent` 的写入路径**：
`ConsolidateObservations`（`internal/store/consolidate.go`）用自己的 INSERT 写合并后的
survivor，调用方给的 title/content override 原样落库。现在在构建 plan 时就对 override
套 `sanitizeForStorage`，所以返回给调用方的 plan 里也看不到原文。override 过滤后为空时
回落到源记录拼接，源记录在写入时已经过滤过。测试放在 fork 独有的
`consolidate_redact_test.go`，因为上游还在频繁改 `consolidate_test.go`。
测试先于修复写，修复前它在 plan 那一步就失败（原始凭据已出现在返回的 plan 里）。
这同时补上了上游自己在这条路径上缺的 `<private>` 剥离，值得提给上游。

还有一处仍然直接用 `stripPrivateTags` 而没换成 `sanitizeForStorage`：
`replaceObservationContent`（`mem_update` 的 find/replace 路径）。
这在 `9997a85` 上就是这样，**是原补丁本身漏的一处，不是 rebase 弄丢的**。
find/replace 写进去的替换文本因此只过 `<private>` 过滤、不过凭据脱敏。
修它要改行为、要配回归测试，本轮按保真重放处理，没动。

**误报防护**：专门测了「看着像密钥但不是」的文本必须原样保留——
`we use sk-learn for the model`、`AKIA is the prefix for AWS access key ids`。
一个会在这些上误伤的过滤器会持续损坏正常记忆。

**验证**：`TestAddObservationRedactsCredentials`、`TestPromptAndSessionSummaryAreRedacted`、
`TestRedactionLeavesOrdinaryProseAlone`、`TestSuggestTopicKeyDoesNotLeakCredentials`。
上游的 `TestContentTruncationMeasuresRedactedBytes` 也仍然通过——把脱敏放进
`prepareStoredContent` 让字节统计量的是真正落库的内容。

---

### 0004 — 数据目录仅属主可读

**范围在 `a2199d9` 那轮就缩小了。** 旧补丁声称三个缺口（目录 0755、`engram.db` 0644、
WAL 边车 0644），实测**只剩第一个**：

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

**`5c41718` 这轮多了一个顺序约束**：上游在 `newStore` 里新增了
`checkDataDirectoryFilesystem(cfg.DataDir)`，它会**向上找第一个已存在的祖先目录**
来判断是不是网络文件系统（注释写明"without creating the data directory"）。
所以它必须跑在建目录**之前** —— 顺序是 `checkDataDirectoryFilesystem` → `secureDataDir`。
反过来写，探测永远落在刚建好的空目录上，网络文件系统的拒绝逻辑就失效了。

**`72e40df` 轮**：上游将上述探测纳入 `ValidateDataDirectory`，顺序更新为
`ValidateDataDirectory` → `secureDataDir`。新的 `EnsureInstanceIDContext` 同样使用
dataDirPerm，并保留所有启动取消检查；连接预热后的 secureDBFiles 也保留。

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

2. **读 chunk 的地方会随上游增长：3 处 → 4 处（`a2199d9`）→ 6 处（`5c41718`）→ 7 处（`72e40df`）。**
   `preflightLegacyChunkOwnership` 是 `a2199d9` 那轮新增的，也会读 chunk body，
   漏掉它会让 legacy 导入在密文上报 JSON parse 错误。
   另外 `exportedRelationKeys` 改名成了 `exportedChunkKeys`。
   **每轮都要重新列调用点逐个判断，不能按处数对**；
   读点逐个判断时，**要追到数据最终流向**：`chunkForEntry` 只读 sync_id，但它的缓存会被
   应用循环复用，所以它必须解封（`fc43849` 轮修复，详见「本轮」一节）。

3. `internal/sync` 自己就是 `package sync`，导入标准库要用 `stdsync "sync"`。

**`72e40df` 的 decoded 缓存**：sessionIDsAvailableInChunks 新增缓存参数，
必须在 !ok 分支读取后先解封，再 Unmarshal 和写缓存。当前生产调用仅来自
importModeLocal 分类；正常本地 sync 的 cloudMode=false，解封是直通。
因此还要用开启 cloudMode 的测试直接覆盖该内部路径，不能假定普通云往返测试已经守护它。
新增的第7处 ReadChunk 是本地 ExportWithOptions 的存在性检查，不解析正文，无需解封。

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

**`72e40df` 轮**：上游新增 WithVersion/version，与 TLS/dashboard 字段、选项全部保留。
routes()+mountDashboard() 的31条显式 HandleFunc 与上游排序比较一致，
dashboard.Mount 仍在开关内，配置中的 Version: s.version 仍在。

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

**`5c41718` 这轮又踩到同一个边界，方向相反。** 上游在被这条补丁**搬走**的那段路由里
新增了 4 条 `/sync` 路由：`session-authorities`、`prompt-pair-claims`、
`prompt-source-attestations`、`prompt-source-attestations/verify`。
`git rebase` 把那整段标成冲突（fork 侧是"已删除"），**直接取 fork 侧就会把这 4 条一起丢掉**，
服务端静默少 4 个端点。正确做法是把它们一起挪到开关之外，并且解完之后断言
上游那 19 条路由在 `routes()` 顶部**全部就位**（逐行 `in` 检查，不靠眼看）。

这 4 条也加进了存活探测（按各自的 method 探，POST 路由用 GET 探会得到 405 而不是 404，
断言会假过）。变异测试：把其中一条塞进 dashboard 开关里 →
`POST /sync/session-authorities disappeared along with the dashboard`。

**客户端**：上游新增了 `newRemoteHTTPClient`，带一个「不把 bearer token 带到
非 HTTPS 跳转」的重定向保护。本轮**把 CA 支持合并进它**而不是替换，两重保护都在。
构造函数改为向上传播它的 error —— 坏的 `ENGRAM_CLOUD_CA_FILE` 必须响亮失败，
不能静默退回系统信任库。

`ENGRAM_CLOUD_CA_FILE` **只信任这一张证书，不碰系统信任库**。
自签方案的常规做法是往 System keychain 装信任根：要 sudo、全机生效、
CA 私钥泄露等于对所有 HTTPS 流量的中间人许可证。

---

### 0008 — push 失败不再阻断 pull

> **2026-09-23 更新：上游追上了一半，本补丁的实现已经改成融合而非替换。**
> 上游现在会在 push 返回 `nonEnrolledPendingError` 时继续 pull，而且做得比 fork 细：
> 用 `pullPreservingSyncState` 避免 pull 顺手清掉 blocked 状态，
> 再用 `recordBlockedAfterSuccess` 把状态补回去（`recordBlocked` 会清空 `BackoffUntil`，
> 单用它就是 fork 当初描述的那个「永远重试不自愈」）。
> **但上游只覆盖 `nonEnrolledPendingError` 这一种 push 错误**，
> 其余 push 失败仍然 `return`、仍然带着 pull 一起停。
> 所以 fork 保留「任何 push 失败都继续 pull」的语义，但内部改用上游这两个新方法：
> blocked 走 `pullPreservingSyncState` + `recordBlockedAfterSuccess`，
> 其余走普通 `pull`。下次 rebase 时先确认上游是否已经把覆盖面扩到全部 push 错误，
> 如果扩了，这条补丁就只剩 `failedPhase` 参数那部分。
>
> 踩坑记录：合并时把「持久化 blocked 状态失败」的 phase 传成了 `PhasePushFailed`，
> 上游测试 `TestManagerCycleRecordsBlockedStatePersistenceFailureAfterSuccessfulPull`
> 期望 `PhasePullFailed`——那个失败发生在 pull **之后**，按 pull 阶段归类。

**上游原本的缺陷**：`cycle()` 里 push 一失败就 `return`，pull 根本不执行。
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

**`5c41718` 这轮上游又往前走了一点，而且多了两个同类测试。**
上游新增 `safeOutboundBlock(err)`，把"可以放行 pull"的判定从单一错误类型
扩成一棵错误树，涵盖 `nonEnrolledPendingError` 和 `promptPreflightError`
（后者报 `prompt_provenance_blocked` 这个新 reason code），
`errors.Join` 出来的多错误只有**全部**是这两类才放行。
**transport 失败仍然 `return`，仍然带着 pull 一起停。**

合并方式：保留上游的分类（包括那个新 reason code），只去掉它的提前 `return` ——
`isBlocked := pushErr != nil && safeOutboundBlock(pushErr)`，blocked 走
`pullPreservingSyncState` + `recordBlockedAfterSuccess`，其余走普通 `pull`，
最后才按 `PhasePushFailed` 记录 push 错误。

`recordFailureWithReason` 的函数体也变了：上游新增 `setCycleStatusLocked(phase, reasonCode, msg)`
（比 fork 原来的裸 `m.status.Phase = failedPhase` 多设 reason 字段、还尊重 `m.disabled`）。
取上游的 helper，相位仍用 fork 显式传入的那个。

两个新的上游测试断言跳过 pull，照同样手法处理：

| 上游测试 | 处理 |
|---|---|
| `...PromptBlockMixedWithTransportFailureSkipsPull` | 4 条断言里只翻转 pull 那条，改名 `...StillPulls` |
| `...KeyedPromptBlockAllowsInboundProgress` | uncertain-preflight 分支翻转。实测 fork 下 `pulls=1`、远端 Seq 7 的 mutation 成功到达，同时 `push_failed` + backoff + `ConsecutiveFailures=1` + 持久化失败消息全部保留 |

变异测试：恢复短路 → **7 个用例**失败（上一轮 5 个）。

---

### 0009 — 改名后以当前内容重新推送已同步记录

动机不变：827条observation的实体表已改名，journal仍在旧项目名下，手动同步只能推54条pending。
根因是backfill只按entity_key/source判定已入队，不看已ack行当初代表哪个project。
ack只设置acked_at，disposition仍是pending，旧历史因而一直压住新项目的backfill。

**`72e40df`轮接受上游契约**：`project_canonicalization_test.go` 要求已ack的journal整行不变。
旧实现 `requeueAckedProjectSyncMutationsTx` 改payload/project并清ack，确定性违反该契约，现已删除。
上游的 `migrateProjectSyncIdentityTx` 和其后的backfill保持原有顺序与职责。

新去重条件是 `sm.acked_at IS NULL OR sm.project = ?`：未ack的pending/quarantined继续覆盖实体，
因为上游会迁移它们；已ack行只有project等于当前所属项目才算覆盖。
否则从当前实体行构造一条新upsert，旧journal不动，也避免重放旧payload覆盖对端的新内容。
检测器projectSyncBackfillRequired、projectNeedsBackfill、enrolledProjectsNeedingBackfill与写入谓词同步。
所有外部project值都用绑定参数；批量发现查询按源行的有效project作静态SQL关联比较。
syncDeleteTombstoneNeedsBackfill未改。

project来源已核对：session用自身；空project的observation/prompt在journal边界从session推导；
relation使用源observation的有效project。session归属的observation正文payload可仍省略project，
journal.project记录有效归属，不需要改动上游payload语义。

`TestMigrateProjectRepushesAlreadySyncedRecords` 和 `TestMergeProjectsRepushesAlreadySyncedRecords`
覆盖五种实体样本、历史整行不变、当前内容、pending/quarantined去重与再次backfill幂等。
去掉新谓词：新upsert为0而失败；恢复原地UPDATE：新测试和上游显式合并测试都因历史改变而失败。

审查补充 `TestProjectRenameAckedBackfillStaysIdle`：MigrateProject与非explicit MergeProjects
都覆盖session、显式/空project observation、软删除observation的delete、prompt及relation。
用sync成功推送后的生产入口AckSyncMutationSeqs完成ack，再跑backfill，整个journal不变；
projectNeedsBackfill、projectSyncBackfillRequired和enrolledProjectsNeedingBackfill都报告无需处理。
project比较临时加#后缀后，两条路径都从12行涨到18行而失败，恢复后各5次通过；
store和cloudcrypto全包通过，security shim日志0行。生产代码未改。

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

### 0011 — 测试信任测试 CA，不再换 `DefaultTransport`

0007 给云客户端装了自己的 `http.Transport` 和显式 root pool。
在那之前，测试靠 `http.DefaultTransport = srv.Client().Transport` 让自签证书被接受；
之后这个赋值**够不着**客户端了，于是 4 个测试常年报
`x509: certificate signed by unknown authority`。

这 4 个失败在 rebase 前的 fork 上就存在，不是本轮 rebase 造成的，
但既然 0007 是 fork 自己的补丁，这笔测试债也该 fork 还。

改法是让测试走 0007 自己提供的入口：把 `httptest` 服务器的证书写成 PEM，
`t.Setenv("ENGRAM_CLOUD_CA_FILE", path)`。这样测的是**真实的信任路径**，
而不是一个已经不存在的钩子。`cmd/engram` 里 5 个调用点共用 `trustTLSServer`
这一个 helper，改它一处即可；`internal/sync` 的契约测试单独加了个等价 helper。

涉及：`TestAutosyncPushPullRoundTrip`、`TestCmdMCPAutosyncPollTickerPullsDuringServe`、
`TestCmdMCPAutosyncPushesWriteDuringServe`、`TestRemoteTransportImplementsTransportContract`。

---

### 0012 — 断言明文前先解封 chunk

上游本轮新增的 `TestCloudExportPropagatesFindReplace` 把 chunk 从 transport 上取下来，
直接 `json.Unmarshal` 后断言 `Content == "new new"`。
0006 的字段级封装让那里是 `enc:v1:...`，断言必然失败。

这是**上游新测试撞上 fork 特性**的第三例（前两例见 0006 结尾），
处理方式一致：不改断言的意图，只在读之前 `sy.openChunkFromCloud(payload)`，
和真实的对端 pull 路径一样。

**下次 rebase 的预期**：上游每新增一个「直接读 chunk 正文」的测试，
就会多一例。判据很简单——失败信息里出现 `enc:v1:` 前缀，就是这一类，
加解封即可，不要去动 0006。

---

### 0013 — 钥匙串镜像不覆盖、测试不访问系统钥匙串

全量测试在临时 HOME 中生成密钥，却调用真实 `security add-generic-password -U`，
覆盖系统用户的 `engram-cloud-key` 镜像。登录钥匙串按系统用户划分，不受 HOME 隔离。

2026-10-25测试后的真实条目被随机测试key覆盖已由编排者核实；真实cloud.key文件未动。
本提交正文记录了该事故、生产恢复风险及修复方式，真实钥匙串恢复另行授权，worker不执行。

2026-10-25 后续冒烟又发现同步镜像无超时：开启 autosync 且数据目录全新时，
`serve` 在 `EnableSealing → LoadOrCreateKey → mirrorToKeychain` 中阻塞，尚未监听端口。
编排者实测 `security` 挂起超过一分钟，goroutine dump 指向 `runSecurity`。

镜像先校验 USER（空时用 engram），仅接受 `[A-Za-z0-9._-]+`；
base64 密钥仅接受 `[A-Za-z0-9+/=]+`。不合法时不执行任何命令。
先用 3 秒 context 查询 `find-generic-password -s <service> -a <account>`，不带 `-w`，
只查属性、不读取密钥。返回 0 就跳过；仅返回 44 才添加；其他错误或超时均跳过。
添加改用 `security -i`，通过 stdin 输入一行 add 命令，密钥不进入进程 argv，
不传 `-U`，使用 5 秒 context 超时杀进程。已有条目及查询后并发插入的条目都不覆盖。
整体最坏约 8 秒返回。文件仍是权威数据，镜像仍是 best effort。
LoadOrCreateKey 仅在 `!testing.Testing()` 时镜像，测试二进制完全不碰系统钥匙串。
KeyFromKeychain 的恢复行为不变。

runSecurity 测试缝传 context、stdin 并返回退出码；测试假实现覆盖已有/缺失条目、
查询异常、两个超时、非法输入、空账户默认值及测试二进制守卫，不运行真实 security。
三组变异（强制判为不存在、去掉添加超时、密钥放回 argv）均使对应回归失败，
逐组恢复后 `git diff --quiet` 通过。构建、cloudcrypto vet、三包定向测试及 cloudcrypto 全包通过。
`make lint` 因本机缺少 golangci-lint v2.13.2 未能执行检查，任务禁止联网安装。

合成场景的假 security 对 find 返回 44，对 `-i` 挂起 60 秒；修复后二进制
在 5.657 秒内 `/health` 返回 200，随后已停止。原定 `http://127.0.0.1:9` 被现有
HTTPS bearer 门禁拒绝，不能触发镜像；有效场景改用同一不可达地址的
`https://127.0.0.1:9`，没有改动门禁。全部运行使用临时 HOME、物理 TMPDIR、
清空继承的 ENGRAM_* 和拒绝真实 security 的 shim。普通 shim 日志 0 行，
有效合成 shim 日志 2 行，只记参数个数和子命令名，不记录密钥。
命令、uptime、退出码、变异和启动证据见本次 f8 报告。

---

### 0014 — 分类缓存解封后的明文落库回归测试

当前生产session分类仅用于本地模式，普通本地sync的cloudMode=false，解封是直通。
因此去掉该解封，原有sync全包仍通过。测试明确开启cloudMode后调用内部local分类流程，
用v2 chunk经过sessionIDsAvailableInChunks → decoded缓存 → apply，断言明文落库。
变异状态失败，修复状态通过。它守护内部缓存契约，不声称普通云Import当前会走这条分支。

---

## 重新生成

```bash
./docs/fork-patches/regenerate.sh              # 对 upstream/main
./docs/fork-patches/regenerate.sh v2.0.0-rc.11 # 或对某个 tag
```

脚本会跳过只动 `docs/fork-patches/` 的提交，否则这个目录会自己记录自己、
编号每次都漂。

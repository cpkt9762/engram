# engram — 打过补丁的 fork

这是 [`Gentleman-Programming/engram`](https://github.com/Gentleman-Programming/engram) 的
个人 fork，带 9 个补丁。**上游的产品文档看 [README.md](../README.md)，这一页只讲这个 fork 和上游有什么不一样。**

> **补丁不在 `main` 上。** `main` 是上游的干净镜像（只多这一个文件），
> 为的是 rebase 时有个不含改动的基线。
> 所有改动在 **[`fix/cjk-trigram-per-term-fallback`](https://github.com/cpkt9762/engram/tree/fix/cjk-trigram-per-term-fallback)** 分支。
>
> **完整补丁记录：[`docs/fork-patches/README.md`](https://github.com/cpkt9762/engram/blob/fix/cjk-trigram-per-term-fallback/docs/fork-patches/README.md)**
> —— 每个补丁的问题、锚点函数、上游冲突风险、验证测试，以及一份 `git am` 可重放的补丁序列。

## 为什么要 fork

两件上游没解决的事。

**中文检索基本是坏的。** 上游建 FTS5 表时没指定 tokenizer，默认 `unicode61` 会把
整段连续汉字当成**一个 token**。在 18,022 条真实中文语料上实测，召回率只有 **10~30%**
（搜 `代理` 命中 622 条，真值 4043）。上游 PR #537 想用 trigram 修，但它的回退条件是
「**所有** term 都短于 3 字符才走 LIKE」，于是 `反向代理 内存` 这类长短混合查询返回 0
（真值 10）—— 而这是中文最常见的查法。本 fork 改成 per-term 分流。

**云同步是明文的。** 上游 `cloud serve` 只有 `http.ListenAndServe`，服务端 Postgres 里
记忆正文明文落盘。对「自建但不信任服务器运营者」（比如跑在公有云 VPS 上）这个场景不够用。

## 9 个补丁

基线 `47f281c`（2026-08-17）· 13 个文件 · +2473 / -90 行，约一半是测试。

| # | 改了什么 |
|---|---|
| 0001-0002 | CJK 检索：trigram FTS + **per-term** 回退，配 11 个回归测试 |
| 0003 | `MaxSearchResults` 20 → 100（上游硬编码 20，`--limit 1000` 被静默截断） |
| 0004 | prompt import 幂等 —— **上游 bug**，导致迁移不可重试，重跑一次语料就翻倍 |
| 0005 | 写入前脱敏凭据，7 类模式挂 9 个写入点（上游只剥 `<private>` 标签，要靠 agent 自觉） |
| 0006 | 数据库仅属主可读（上游是 `0755`/`0644`，同机其他用户可读整个记忆库） |
| 0007-0008 | 云同步 payload 字段级 AES-256-GCM 加密，两条 rail 全覆盖 |
| 0009 | `cloud serve` 支持 TLS；dashboard 可关（它有预认证路由） |

0004 和 0006 是修上游的问题，值得提回上游。0007-0008 是私有需求，不适合上游。

## 已验证

- 9 个补丁 `git am` 到纯净 `47f281c` 上，产出 tree 与分支（去掉 `docs/fork-patches/`）**逐字节一致**
- `go test ./...` **23 个包全过、0 失败**
- 中文召回 **23/23** 精确等于 SQL 真值（2 字词 / ≥3 字词 / 长短混合 / 拉丁词边界 / 负对照）
- 每个补丁都做过**变异测试**：故意把代码改坏，确认测试抓得到。0008 就是这么发现
  「只封三个数组等于没封」的 —— `ChunkData` 还有第四个字段 `Mutations` journal，
  关掉解密后往返测试**照样通过**，明文 title 却躺在 payload 里

## 构建

```bash
git clone -b fix/cjk-trigram-per-term-fallback https://github.com/cpkt9762/engram.git
cd engram
go build -o engram ./cmd/engram
GOOS=linux GOARCH=amd64 go build -o engram-linux-amd64 ./cmd/engram   # 服务端
```

纯 Go（`modernc.org/sqlite`，无 cgo），交叉编译无障碍。

跑测试前要清掉环境变量 —— **上游测试不是 hermetic 的**，会读 ambient `ENGRAM_CLOUD_*`，
配置过的机器上会看到 4 个 `TestCmdServeSyncStatus*` 假失败：

```bash
env -u ENGRAM_CLOUD_TOKEN -u ENGRAM_CLOUD_CA_FILE -u ENGRAM_CLOUD_AUTOSYNC go test ./...
```

## 千万别 `brew upgrade engram`

补丁版二进制启动时会打印：

```
Update available: 0.0.0-...+dirty -> 1.20.0
To update: brew update && brew upgrade engram
```

**照做会把补丁版换成上游未打补丁的版本**，中文检索静默退回 `unicode61`，召回率掉回
10~30%，而且**不会有任何报错**。升级只能走这个 fork 重新编译：

```bash
git fetch upstream && git rebase upstream/main
go build -o ~/.local/bin/engram-patched ./cmd/engram
./docs/fork-patches/regenerate.sh    # 让补丁记录跟上
```

Claude Code 插件调的是 **PATH 上的裸 `engram`**（不认 `ENGRAM_BIN`，那是 `plugin/pi/`
适配器的机制），所以 `~/.local/bin/engram` 是指向补丁版的符号链接，且 `~/.local/bin`
必须在 PATH **最前面** —— 哪天 brew 装了官方版，PATH 顺序决定谁赢。

## 本 fork 新增的环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `ENGRAM_CLOUD_TLS_CERT` / `ENGRAM_CLOUD_TLS_KEY` | 服务端证书与私钥 | 空 = 明文 HTTP |
| `ENGRAM_CLOUD_CA_FILE` | 客户端信任的 CA（自签证书用，不碰系统信任库） | 空 = 系统信任库 |
| `ENGRAM_CLOUD_DASHBOARD` | 设 `0` 关掉 dashboard 路由 | 开启 |
| `ENGRAM_CLOUD_ENCRYPT` | 设 `0` 关掉字段级加密 | 开启 |

后两个是**严格等于字符串 `"0"`**，`false` / `off` 不生效。

---

上游是 MIT，本 fork 同样。补丁的 commit message 里都带着实测数据和取舍理由，
方便日后回看或提给上游。

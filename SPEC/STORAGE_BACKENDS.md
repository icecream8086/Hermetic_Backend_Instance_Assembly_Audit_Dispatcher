# 存储后端替换方向

## 三层存储接口

```
IAtomicStore  — 热状态 KV + OCC（乐观并发控制）
IQueryStore   — 冷查询 / 关系查询
IBlobStore    — 大对象 / 二进制
```

## 当前实现 vs 替换方案

### IAtomicStore — DO / FileKV

| 环境 | 当前实现 | 后端 |
|---|---|---|
| dev | `FileKVAtomicStore` | `.data/kv/*.json` |
| cloudflare | `DurableObjectAtomicStore` (+ KV cache) | `ctx.storage` (SQLite) |

替换方向：

| 方案 | 说明 | 代价 |
|---|---|---|
| **TiKV** | 分布式 KV，原生 OCC + MVCC，`transact` 天然对应 TiKV 事务 | 要 PD + TiKV 两个进程，dev 太重 |
| **FoundationDB** | 单进程嵌入式，get/set/clear + 事务语义逐字翻译接口 | 编译期依赖，SQL 套件需额外配 |
| **better-sqlite3** | 单文件，行级锁，`transact` 走 `BEGIN IMMEDIATE` | 无分布式能力，不能跨进程 |
| **Redis + Lua** | `set` OCC 用 Lua script 原子化，`transact` 用 WATCH/MULTI/EXEC | 无 MVCC，OCC 需要应用层配合 |
| **etcd** | v3 API 带 revision（= version），支持 txn | gRPC 依赖，读延迟偏高 |

### IQueryStore — D1 / FileQuery

| 环境 | 当前实现 | 后端 |
|---|---|---|
| dev | `FileQueryStore` | `.data/query/*.json`（简陋模拟） |
| cloudflare | `D1QueryStore` | Cloudflare D1 (SQLite) |

替换方向：任何 SQLite 或 PostgreSQL 客户端。
- 已有的 `D1QueryStore` 改接 better-sqlite3 即可
- 或直接换 `node-postgres` 接 PG

### IBlobStore — R2 / FileBlob

| 环境 | 当前实现 | 后端 |
|---|---|---|
| dev | `FileBlobStore` | `.data/blob/*` |
| cloudflare | `R2BlobStore` | Cloudflare R2 (S3 协议) |

替换方向：S3 协议实现，项目已内置 MinIO 配置。
- 已有 `s3-factory.ts` 和 SigV4 签名
- 切到 MinIO 只需要改 endpoint/credential 配置

### 其他 Cloudflare 特化组件

| 组件 | 用途 | 替换 |
|---|---|---|
| `platforms/cloudflare.ts` | DNS provider | `CloudflareDnsProvider` → 替换为其他 DNS API |
| `config/env.ts` | 环境变量加载 (workerd 兼容) | 已有 `env.ts`，透出 process.env |
| `index.ts` | wrangler entry point | dev 入口走 `dev.ts`，无依赖 |

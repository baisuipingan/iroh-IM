# 文件面落地笔记：Matrix / tusd / RustFS / 部署形态

> 日期：2026-10-19
> 这是 [`file-transfer-architecture-review-2026-10-19.md`](file-transfer-architecture-review-2026-10-19.md) 的展开：
> 详细解释 Matrix 怎么存文件、tusd 到底做什么、RustFS 能不能替代 MinIO、以及"多 iroh-relay 轻量集群"还够不够。

---

## 1. Matrix 是怎么做的

### 1.1 一句话

**房间事件（消息）和文件字节是两条完全独立的路。**
消息里只放一个 `mxc://` 引用 + 元信息；文件本身放在 homeserver 的 **Content Repository（媒体仓库）**，用普通 HTTP 上传/下载。

### 1.2 组件

```text
客户端 A ──HTTP──> homeserver A（Synapse/Conduit…）
                      ├─ 房间事件（JSON，签名，联邦复制）
                      └─ Content Repository（媒体文件，HTTP）
                              │
                              │ 联邦 S2S（按需拉取 + 缓存）
                              ▼
                         homeserver B ──HTTP──> 客户端 B
```

- **homeserver**：负责账号、房间、事件、联邦、媒体仓库。
- **房间事件**：`m.room.message` 等 JSON 事件，签名后写入房间 DAG，通过联邦复制到其他 homeserver。
- **Content Repository**：独立模块，存二进制；对外用 `mxc://{serverName}/{mediaId}` 标识。
- **`mxc://` 不是 HTTP URL**：客户端不能直接 `GET`，必须先向自己的 homeserver 解析。这是"媒体与服务器地址解耦"的关键。

### 1.3 上传流程

1. 客户端 `POST /_matrix/media/v3/upload?filename=photo.jpg`，body 是原始字节，`Content-Type` 是真实 MIME。
2. homeserver 存字节 + 元信息，返回 `{"content_uri": "mxc://example.org/abcd1234"}`。
3. 客户端发房间事件：

```json
{
  "msgtype": "m.file",
  "body": "photo.jpg",
  "url": "mxc://example.org/abcd1234",
  "info": { "mimetype": "image/jpeg", "size": 128000 }
}
```

4. 其他成员收到事件，用自己的 homeserver 下载：

```text
GET /_matrix/client/v1/media/download/example.org/abcd1234
Authorization: Bearer <access_token>
```

5. 如果 `example.org` 不是本机，本机 homeserver 会通过 **Server-Server API** 去源服务器拉取，**本地缓存**后再回给客户端。客户端始终只面对自己的 homeserver。

### 1.4 三个容易忽略的设计

**① 媒体不可变**
上传后 `mediaId` 对应内容不可修改；重新上传就是新 ID。这样缓存、去重、CDN 都简单，也不会出现"同一个链接内容变了"。

**② 异步上传（create + PUT）**
Matrix 有 `POST /_matrix/media/v1/create` 先申请一个 `mxc://`，之后再用 `PUT /_matrix/media/v3/upload/{serverName}/{mediaId}` 补字节。用途：

- 先把事件发出去（引用已确定的 `mxc://`），字节稍后补；
- 上传动作可以交给另一个进程/设备，甚至对象存储的预签名 URL；
- 未使用的 media ID 有 `unused_expires_at`，会被清理。

**但这不是断点续传**：PUT 仍是一次性整包，没有 `PATCH`/`Content-Range`/offset。

**③ 加密附件**
E2EE 房间里，客户端先在本地用 AES-CTR + SHA-256 加密，上传**密文**；事件里的 `file` 字段带 key/iv/hashes：

```json
"file": {
  "url": "mxc://example.org/ciphertext",
  "key": { "kty": "oct", "alg": "A256CTR", "k": "..." },
  "iv": "...",
  "hashes": { "sha256": "..." },
  "v": "v2"
}
```

homeserver 只看到密文；缩略图也只能客户端自己生成。这是"服务端不可见文件"的标准做法，可以直接借。

### 1.5 存储与运维（Synapse 为例）

| 配置 | 作用 | 默认 |
|---|---|---|
| `media_store_path` | 本地媒体目录 | `media_store` |
| `max_upload_size` | 单次上传上限 | `50M` |
| `media_storage_providers` | 外部存储后端（S3 兼容等） | `[]` |
| `enable_local_media_storage` | 是否保留本地磁盘存储 | `true` |
| `max_pending_media_uploads` | 单用户挂起的未完成 media ID 数 | `5` |
| `unused_expiration_time` | 未上传的 media ID 过期 | `24h` |
| `media_upload_limits` | 按用户/时间窗的累计配额 | `[]` |
| `enable_authenticated_media` | 新媒体是否必须认证下载 | `true`（1.120+） |

S3 兼容存储通过 `media_storage_providers` 的模块接入（例如 `s3_storage_provider.S3StorageProviderBackend`），常见配置是"本地缓存 + 异步 offload 到 S3"：

```yaml
media_store_path: /var/lib/synapse/media_store
max_upload_size: "210M"
media_storage_providers:
  - module: s3_storage_provider.S3StorageProviderBackend
    store_local: true
    store_remote: true
    store_synchronous: false
    config:
      bucket: synapse-media
      endpoint_url: https://s3.example.com
      access_key_id: ...
      secret_access_key: ...
```

注意：

- **Matrix 规范本身不做断点续传**；大文件靠对象存储/客户端分片，或外部 tus。
- **没有内置的媒体保留/自动清理**（`media_retention` 是消息事件保留，不是媒体文件）；要靠对象存储 lifecycle 或定时脚本。
- **联邦媒体是按需缓存**，不是全量复制：源服务器挂了且本地没缓存，就 404。房间事件有联邦复制，媒体没有。
- 下载认证是趋势：v1.11 起推荐 `/_matrix/client/v1/media/download`，旧的匿名 `/_matrix/media/v3/download` 逐步退场。

### 1.6 该借什么、不该借什么

| 借 | 不借 |
|---|---|
| 消息只带 `mxc://`/文件引用 + 元信息 | 整套 homeserver + 联邦 + Postgres |
| 媒体仓库独立于聊天事件 | Matrix 的事件 DAG/房间状态模型 |
| 媒体不可变、按 ID 寻址 | 规范里"没有断点续传"的缺口 |
| 下载必须认证、按房间成员校验 | 联邦媒体的缓存一致性复杂度 |
| E2EE 附件信封（AES-CTR + SHA-256） | 为了聊天室文件去部署 Synapse |

**结论**：Matrix 值得学的是**分层**（事件/媒体分离、引用/字节分离、认证/存储分离），不是把 Synapse 搬过来。

---

## 2. tusd 是做什么的

### 2.1 一句话

**tusd 是 tus 可续传上传协议的官方参考服务端**：一个 Go 单二进制，负责"记住每个上传已经收了多少字节"，让客户端断线后用 `HEAD` 查偏移、用 `PATCH` 从断点继续。

它不是网盘、不是 CDN、不是对象存储；它只解决"上传过程可恢复"。

### 2.2 协议核心（三句话）

1. `POST /files/` 创建上传，返回 `Location`（上传 URL）和 `Upload-Offset: 0`；
2. `PATCH <Location>` 带 `Upload-Offset: N` + `Content-Type: application/offset+octet-stream` 写入下一段；
3. 断线后 `HEAD <Location>` 拿 `Upload-Offset`，从该偏移继续 `PATCH`。

服务端按上传 URL 记录偏移；客户端只需记住这个 URL。偏移不匹配返回 `409`，不会破坏已有数据。

可选扩展：`creation`（创建时带首片）、`creation-defer-length`（总长未知）、`checksum`（分片校验）、`termination`（删除）、`concatenation`（分片合并/并行上传）、`expiration`（过期清理）。

### 2.3 tusd 的能力

| 能力 | 说明 |
|---|---|
| 存储后端 | 本地磁盘、S3、GCS、Azure Blob |
| S3 兼容 | `--s3-bucket` + `--s3-endpoint` 指向 MinIO/RustFS/其他 S3 |
| 锁 | 本地 `FileLocker` / 内存 `MemoryLocker`；多实例要用共享锁或粘性会话 |
| Hooks | `pre-create`（阻塞，做鉴权/配额）、`post-create`、`post-receive`、`pre-finish`、`post-finish`、`post-terminate` |
| 运维 | 单二进制、Prometheus metrics、CORS、`--behind-proxy`、最大尺寸/总容量限制 |
| 客户端 | `tus-js-client`、Uppy Tus 插件、Go/Python/Java/Rust 客户端 |

### 2.4 和当前项目的对接方式

```text
浏览器                         roomd                      tusd                对象存储
  │  1. 申请上传（房间+文件元信息） │                         │                     │
  ├─────────────────────────────>│                         │                     │
  │  2. 返回 upload token/URL     │                         │                     │
  │<─────────────────────────────┤                         │                     │
  │  3. POST /files/ (带 token)   │                         │                     │
  ├──────────────────────────────┼────────────────────────>│                     │
  │                              │  4. pre-create hook 校验 │                     │
  │                              │<────────────────────────┤                     │
  │  5. PATCH 分片（可断可续）     │                         │  6. 写对象/分片      │
  ├──────────────────────────────┼────────────────────────>├────────────────────>│
  │                              │  7. post-finish hook     │                     │
  │                              │<────────────────────────┤                     │
  │  8. roomd 广播 FileRef（file_id/url/size/sha256）        │                     │
  │<─────────────────────────────┤                         │                     │
```

关键点：

- **鉴权在 `pre-create`**：roomd 校验"这个用户在当前房间、文件大小/类型合规"，然后签发 upload token（可以放在 `Upload-Metadata` 里）。
- **完成后 `post-finish`**：roomd 写文件记录、广播消息；不要只依赖客户端"我传完了"。
- **下载**：可以直接给对象存储的预签名 GET（支持 Range），也可以让 roomd 代理（可控但吃带宽）。
- **多接收方**：每个接收方各自从对象存储下载，发送方只上传一次；这是相对 P2P 最大的体验差异。

### 2.5 部署坑（很实际）

1. **反向代理默认缓冲请求体**：Nginx 要 `proxy_request_buffering off;` + `client_max_body_size`；Caddy 要确认不缓冲大 body。否则大文件会先落代理磁盘/内存，甚至被 kill。
2. **CORS 必须放行 tus 头**：`Tus-Resumable`、`Upload-Length`、`Upload-Offset`、`Upload-Metadata`、`Content-Type`；方法 `POST/HEAD/PATCH/OPTIONS/DELETE`。
3. **多实例 + 本地盘 = 续传会坏**：上传状态在单机磁盘；负载均衡要粘性，或改用 S3 后端 + 共享锁。单实例最省心。
4. **`max-size`/配额**：tusd 只做单文件上限；按用户/房间的累计配额要在 `pre-create` hook 里做。
5. **清理**：未完成上传要有 expiration/定时清理，否则磁盘会被半截文件吃满。
6. **校验**：tus 的 `checksum` 是分片级；整文件哈希仍要在 `post-finish` 或客户端做（BLAKE3/SHA-256）。

### 2.6 什么时候不需要 tusd

如果直接用 **S3 multipart + 预签名 URL**：

- 浏览器 `CreateMultipartUpload` → 逐片 `UploadPart`（预签名）→ `CompleteMultipartUpload`；
- 断点续传 = 客户端持久化 `uploadId` + 每片 ETag，下次 `ListParts` 对比缺口；
- 少一个 tusd 服务，但客户端代码更多，CORS/预签名/分片重试都要自己处理。

**小团队 MVP 建议 tusd**：协议成熟、客户端现成、服务端单二进制；等规模上来再考虑直连 S3 multipart。

---

## 3. MinIO 换成 RustFS 怎么样

### 3.1 RustFS 是什么

- Rust 写的 S3 兼容对象存储，**Apache 2.0**；
- 2026-09-16 发布 **1.0.0 GA**（首个 commit 2024-02，2025-07 开源）；
- 能力：分布式、纠删码、多副本/站点复制、multipart、bucket/object lifecycle、IAM/OIDC/KMS/SSE、WebDAV/Swift/FTP、控制台、Prometheus/OTel；
- 官方提供 MinIO 迁移路径（同 S3 API、可共存/换镜像）。

### 3.2 和 MinIO 的取舍

| 维度 | MinIO | RustFS |
|---|---|---|
| 成熟度 | 多年生产验证，生态最广 | 1.0 GA 仅约 1 个月；首个 commit 2024-02 |
| 许可 | AGPLv3（商业嵌入要注意） | **Apache 2.0**（对商业更友好） |
| S3 兼容 | 事实标准 | 声称 drop-in；要用你的实际工具验证 |
| 运维 | 成熟文档/社区 | 新，文档/社区还在长 |
| 分布式 | 成熟 | 有，但生产案例比 MinIO 少 |
| 控制台/功能 | 社区版功能有调整 | 功能表很全，但需实测 |

**判断**：

- **单节点、小规模、自建**：RustFS 可以用，Apache 2.0 是实打实的优势；但请把它当"新数据库"对待——先跑通 multipart、预签名 URL、CORS、备份恢复，再上生产。
- **多节点 HA、关键数据**：目前更稳的是 MinIO（接受 AGPL）或 Ceph/SeaweedFS；RustFS 建议先做非关键/可重建数据，或等更多生产案例。
- **不想运维存储**：直接 Cloudflare R2 / Backblaze B2 / S3。对这个小项目，**R2 往往比自建 RustFS 更"轻"**：没有磁盘、没有副本、没有备份脚本，出网费也低。

> 一句话：RustFS 值得试，但"1.0 是信任的起点，不是终点"。别把唯一一份用户文件放在一个刚 GA 一个月的存储上，除非你有独立备份。

### 3.3 其他可选

| 方案 | 适合 | 注意 |
|---|---|---|
| **Cloudflare R2** | 想零运维、全球边缘、出网便宜 | 依赖 Cloudflare；国内访问延迟/合规要评估 |
| **Backblaze B2** | 便宜、S3 兼容 | 国内延迟一般；配 CDN |
| **MinIO** | 自建、成熟、S3 标准 | AGPL；社区版功能变化 |
| **RustFS** | 自建、Apache 2.0、想换 MinIO | 新；先小规模验证 |
| **Garage** | 轻量、geo-distributed、小集群 | 生态比 MinIO 小；S3 兼容子集 |
| **SeaweedFS** | 海量小文件、对象存储 | 组件多，运维门槛高 |
| **Ceph RGW** | 大规模、统一存储 | 太重，不适合这个项目 |

---

## 4. 多 iroh-relay 轻量集群还够不够？

### 4.1 先分清两个平面

| 平面 | 现在 | 换文件面之后 |
|---|---|---|
| **聊天控制面** | 3 台 iroh-relay（HK/EU/FR）+ 1 台 roomd | **不变**；relay 只跑 gossip/消息/presence，流量很小 |
| **文件数据面** | 也走 relay（和心跳共用 WebSocket） | **独立**：tusd + 对象存储，走 HTTPS |

所以"3 台 relay 够不够"要分开看：

- **聊天**：够，甚至过剩；relay 是 1 vCPU/1GB 级别的轻服务。
- **文件**：不够，因为 relay 本来就不是存储/CDN；需要新增对象存储（或托管 R2/S3）。

### 4.2 三种部署形态

#### 形态 A：托管对象存储 + tusd（最轻，推荐 MVP）

```text
3 × iroh-relay（不变）
1 × roomd（不变）
1 × tusd（可以跑在 roomd 同一台，256–512MB 内存）
1 × 托管 bucket（R2 / B2 / S3）
```

- 不需要自己维护磁盘/副本/备份（托管方负责 durability）；
- tusd 只是"上传协议网关"，无状态（S3 后端）或单机盘（小规模）；
- 成本：存储 + 出网流量；R2 出网费低，适合聊天室文件。

**这是"轻量"唯一能保住的做法**：把状态交给托管存储，自己只跑一个无状态 tusd。

#### 形态 B：单节点自建 RustFS/MinIO + tusd（可控，但要运维）

```text
3 × iroh-relay（不变）
1 × roomd（不变）
1 × 存储 VPS：RustFS/MinIO + tusd + Caddy
  - 2–4 vCPU / 4–8GB / 500GB–1TB SSD
  - 备份：bucket replication 或 restic + 异机
```

- 数据在自己手里，Apache 2.0（RustFS）省许可顾虑；
- 但这是一台**有状态**服务器：磁盘、备份、监控、扩容都要管；
- 单点：重启/磁盘满会中断上传；tus 能续传，但下载会 5xx。

**适合**：有合规/数据主权要求，或文件量不大、能接受单点。

#### 形态 C：分布式 RustFS/MinIO 集群（重，当前不建议）

```text
3 × relay + 3 × 存储节点（每台磁盘/纠删码/复制）
```

- 真正的 HA 需要至少 3–4 个存储节点、独立网络、监控、扩容规划；
- 跨 HK/EU/FR 做 geo-distributed 存储，延迟和一致性都很麻烦；
- relay VPS 现在就跑着别的业务（HK 那台 8GB 内存、117GB 盘、已用 49%、只剩 61GB，还有 dpxwebsite/sub2api 等容器），**不适合再塞存储**。

**结论**：当前规模不需要分布式对象存储；不要把 relay 节点改成存储节点。

### 4.3 资源与成本粗算（小规模）

| 组件 | 规格（量级建议） | 说明 |
|---|---|---|
| iroh-relay ×3 | 1 vCPU / 1GB / 20GB | 不变；只跑聊天 |
| roomd ×1 | 1 vCPU / 1GB / 20GB | 不变；SQLite 历史 |
| tusd ×1 | 0.5 vCPU / 256–512MB | 可和 roomd 同机 |
| RustFS 单节点 | 2–4 vCPU / 4–8GB / 500GB+ SSD | 独立 VPS，别和 relay 混部 |
| Caddy/Nginx | 0.5 vCPU / 128MB | TLS + 反代；关请求缓冲 |
| 备份 | 异机/对象存储 | 3-2-1；至少每日 |

托管 R2 则去掉 RustFS + 备份，只保留 tusd（甚至 tusd 也可以省，走 S3 multipart 预签名）。

### 4.4 什么时候必须升级

- 文件总量 > 单盘可承受（比如 > 1TB）→ 加盘/换存储节点；
- 需要 99.9% 可用 → 托管多区 bucket，或 3 节点集群；
- 上传并发 > 几十路 → tusd 多实例 + S3 后端 + 共享锁/粘性；
- 需要 CDN 加速下载 → 对象存储 + CDN（R2 自带边缘）；
- 需要审计/配额/病毒扫描 → `pre-create`/`post-finish` hook 接 roomd 或独立服务。

---

## 5. 推荐落地组合（按优先级）

### 方案 1：R2 + tusd（最省心）

- 浏览器 → tusd（Caddy 反代，关缓冲）→ R2；
- roomd 在 `pre-create` 校验房间/用户/大小，在 `post-finish` 广播 `FileRef`；
- 下载：R2 预签名 GET（Range 支持）；
- 3 台 relay 不动。

**适合**：现在就要稳定、没有合规硬要求、想最少运维。

### 方案 2：单节点 RustFS + tusd（数据自己拿）

- 新增一台存储 VPS（2–4 vCPU / 4–8GB / 500GB+）；
- RustFS 单节点 + tusd（S3 后端，`--s3-endpoint` 指向 RustFS）；
  先用 tusd 跑通 multipart/预签名/CORS（S3 兼容性别只看官网声明），再上生产；
- Caddy 反代；每日 restic/桶复制到异机；
- relay 不动。

**适合**：要 Apache 2.0、数据主权、能接受单点。

### 方案 3：MinIO + tusd（最稳的自建）

- 和方案 2 一样，只是存储换 MinIO；
- 接受 AGPL；成熟度和文档最好。

**适合**：团队已有 MinIO 运维经验/合规允许 AGPL。

---

## 6. 一页结论

1. **Matrix 的核心不是"P2P"，是"事件与媒体分离"**：消息只带 `mxc://`，文件走独立 HTTP 仓库；下载认证、媒体不可变、E2EE 信封都值得借。
2. **tusd 是 tus 协议的服务端**：解决"断点续传"这一件事；存储后端可本地/S3；鉴权/配额/完成回调靠 hooks；部署要关反代缓冲、配 CORS、避免多实例本地盘。
3. **RustFS 可以替代 MinIO，但要按"新存储"评估**：Apache 2.0 是优势，1.0 GA 很新；单节点小规模可用，关键数据先做备份/灰度，HA 仍优先 MinIO/托管。
4. **"3 台 relay + roomd" 对聊天够，对文件不够**：文件面必须新增对象存储；最轻是 R2 + tusd，最可控是单节点 RustFS/MinIO + tusd；分布式存储是下一个阶段的事，不要把 relay 节点改成存储节点。

---

## 7. 参考

- Matrix Content Repository：<https://spec.matrix.org/latest/client-server-api/#content-repository>
- Synapse 媒体配置：<https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html>
- tus 协议：<https://tus.io/protocols/resumable-upload>
- tusd：<https://github.com/tus/tusd>
- RustFS 1.0 GA：<https://rustfs.com/blog/announcing-rustfs-1-0-0-ga/>
- RustFS 官网：<https://rustfs.com/>
- MinIO：<https://min.io/>

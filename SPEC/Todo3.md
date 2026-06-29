
### 5.3 计算实例模块 ✅

- [x] 抄 GitHub Runner: online/offline/busy 三态 — `RunnerInstance.status` + `busy` 独立标志，不变量 `busy⇒online`
- [x] 抄 GitHub Runner: Registration Token — `POST /instances/registration-token` 1h TTL，一次性消费
- [x] 抄 GitHub Runner: Runner Groups — `RunnerGroup` + `visibility: 'all' | 'selected'` + `selectedScopeIds` + DAG `dependsOn`
- [x] 实例心跳 — `POST /instances/:id/heartbeat` 更新 lastHeartbeatAt，`POST /instances/mark-stale` 超时 5min → offline
- [x] `src/features/instances/` — RunnerService + createInstancesRouter (14 端点)

### 5.4 容器镜像管理模块 ✅

- [x] 抄 ECI ImageCache: `ImageCacheTracker` — LRU 淘汰 (总大小上限) + 7 天过期 + `recordAccess`/`touch`/`recordRemoval`
- [x] `computeEvictions()` — oldest-first 驱逐算法，返回 evicted IDs + reclaimed bytes
- [x] 镜像仓库凭证管理 — **复用 5.2 ContainerSecret**（visibility 作用域控制哪些 sandbox 可用哪个 registry 凭据）
- [ ] 镜像加速 (nydus/dadi/p2p/imc) ⏳ — provider 层实现

### 5.5 存储桶管理 ⏳

- [ ] S3 auto-key-provision (已有 spec)
- [ ] S3 policy manager (已有 spec)
- [ ] 存储配额 + 用量统计
- [ ] 数据卷扩容 (cloud_essd / cloud_ssd 性能等级)

### 5.6 网络模块 ⏳

- [ ] 安全组规则 DAG (iptables 模型)
- [ ] 入/出带宽限制 (bps)
- [ ] 多可用区调度 (VSwitchOrdered / VSwitchRandom)

---

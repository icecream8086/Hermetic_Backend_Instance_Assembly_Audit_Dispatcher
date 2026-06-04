# HBI-AAD v4.0 需求分析文档

> 云无关容器编排平台 — 后端需求规格

---

## 核心概念

| 概念 | 说明 |
|------|------|
| **层级** | 说明 |
|---------|------|
| **Platform（云厂商）** | 物理基础设施提供商：alibaba（阿里云）、aws（亚马逊云）、podman（自有服务器）、stub（模拟） |
| **Region（地域）** | 云厂商的数据中心地域，如 AlibabaRegion.CnBeijing（华北2）。不同 region 之间网络隔离。 |
| **ComputeInstance（计算实例）** | **核心底层概念**。云厂商 xx 区 xx 数据中心的一台真实计算节点。包含 platform、region、zone、endpoint、capabilities、capacity、status。凭证通过 `credentialRef` 引用 CredentialService。 |
| **Credential（凭证）** | 云厂商 AK/SK + 私有镜像仓库凭证。独立 CRUD，读接口自动 masking。通过 `credentialRef` 被实例引用。 |
| **Template（模板）** | 容器的声明式定义（镜像、资源、端口、环境变量、健康检查）。支持 DAG 继承链。可绑定 `instanceId` 指定计算实例。 |
| **Sandbox（沙箱）** | **ComputeInstance + Template = 运行中的容器实例**。有独立的状态机、网络、存储卷。通过 `instanceId` 绑定到计算实例。 |
| **Container Group（容器组）** | 多容器共享 namesapce 的编排单元。Podman 上对应 pod，ECI 上对应 ContainerGroup。⚠️ **接口已定义但上层管理待实现**。 |
| **SecurityGroup（安全组）** | 平台无关的防火墙规则边界。绑定到 ComputeInstance，provider/region 自动继承。 |
| **Subnet（子网）** | IP 段管理（CIDR + 子网前缀）。绑定到 ComputeInstance，provider/region 自动继承。 |
| **RegionBucket（存储桶）** | Region 级 S3 存储桶抽象。绑定到 ComputeInstance，platform/region/endpoint/credentialRef 自动继承。 |

---

## 1. 角色定义

### 1.1 角色层级（Linux sudo 模型）

| 角色 | 系统组 | 权限组 | 说明 |
|------|--------|--------|------|
| **wheel** | wheel | perm.sysadmin | 全系统访问，需 sudo 临时提权获得 root role |
| **root** | root | perm.operator | 系统管理员，CRUD 操作（不含 admin） |
| **operator** | 可配置 | perm.operator | 运维操作员，CRUD |
| **user** | users | perm.viewer | 普通用户，只读 + 管理自有资源 |
| **daemon** | daemon（默认） | 按绑定组决定 | 子账号，只允许 Ed25519 密钥登录，可被分配到任意用户组获得对应权限 |
| **viewer** | 可配置 | perm.viewer | 只读用户 |

### 1.2 双重验证模型

- **组成员资格** + **用户角色** 共同决定权限
- `wheel` 组成员 + `role=root` → 完整 admin 权限
- `sudo` 端点：给 `wheel` 组成员临时授予 30 分钟 root role

### 1.3 MAC（强制访问控制）

不可变规则，启动时加载，不允许 API 修改：
- 禁止删除 root 用户 / 修改 root 角色
- 禁止删除 / 修改 wheel、daemon、root、users 用户组
- 禁止创建 / 修改 / 删除系统组 (perm.*)
- 禁止修改 seed 数据 (`_init:*`)
- 禁止删除 route ACL 索引
- 禁止修改 MAC 策略自身

---

## 2. 用户故事

### 2.1 作为 wheel 管理员

```
我能管理系统中的所有资源，不受限制。
```

- 登录 → 获得 session token
- `sudo` → 获得 30 分钟 root role
- 管理所有用户（创建、删除、改角色、设登录策略）
- 管理所有权限策略、用户组、权限组、路由 ACL
- 管理 topology（cluster、region bucket）
- 管理所有 sandbox、template、network、image
- 查看审计日志
- 管理事件循环

### 2.2 作为 root 管理员

```
我能管理系统资源，但不能修改权限系统本身。
```

- 登录 → 获得 session token
- CRUD sandbox、template、network、image、topology
- GET 用户列表、审计日志、platform 列表
- **不能** 创建/修改/删除权限策略、用户组、路由 ACL
- **不能** 修改 MAC 策略

### 2.3 作为普通用户 (user)

```
我能管理自己的 sandbox 和 template，查看公共资源。
```

- 注册 → 登录 → 获得 session token
- 创建自己的 sandbox（指定资源规格、镜像、网络）
- 创建自己的 template
- 查看公共 template / network
- GET platform 列表
- GET 用户列表
- 管理 topology（CRUD cluster、bucket）
- **不能** 管理别人的 sandbox/template
- **不能** 看审计日志

### 2.4 作为 daemon（服务账户 / 子账号）

```
我是 CI/CD 或自动化服务，只能用密钥认证。
管理员可以将我绑定到不同的用户组获得不同权限。
```

- **只用** Ed25519 无密码登录（`passwordLoginDisabled = true`），无法密码登录
- 权限完全由绑定的用户组决定（类似阿里云 RAM 子账号）
- 默认种子权限：与 `users` 组相同的 Route ACL（可被管理员修改）
- 可以独立绑定到 perm.operator 等系统组实现自动化运维
- 典型用途：CI/CD 部署账号、监控采集账号、备份服务账号

---

## 3. 功能需求

### 3.1 用户认证

| ID | 需求 | 优先级 |
|----|------|--------|
| AUTH-01 | 用户注册：邮箱唯一性 + PBKDF2 密码哈希 + 自动加入 users 组 | P0 |
| AUTH-02 | 密码登录：5 次/分钟锁定 + session token（2h TTL） | P0 |
| AUTH-03 | Ed25519 无密码登录：一次性 nonce + ±30s 窗口 + 90s nonce 缓存 | P1 |
| AUTH-04 | 登录策略：按用户设置 CIDR 白名单、时间范围、启用/禁用、禁用密码登录 | P2 |
| AUTH-05 | daemon 子账号：自动 `passwordLoginDisabled=true`，仅 Ed25519 密钥认证 | P1 |
| AUTH-06 | Session 管理：创建、验证、列表、吊销 | P0 |
| AUTH-06 | Login info 端点：暴露用户存在的认证方式和策略 | P1 |
| AUTH-07 | 公钥管理：设置/清除 Ed25519 公钥 | P1 |
| AUTH-08 | __become-wheel（dev only）：localhost 将用户加入 wheel 组 | P0-dev |

### 3.2 权限系统

| ID | 需求 | 优先级 |
|----|------|--------|
| PERM-01 | 策略 CRUD：action+resource 匹配、allow/deny、优先级排序 | P0 |
| PERM-02 | 用户组 CRUD：组成员管理、DAG 依赖 | P0 |
| PERM-03 | 权限组 CRUD：规则集合 + 绑定用户组/用户 + DAG 依赖 | P0 |
| PERM-04 | 路由 ACL CRUD：HTTP method + pathPrefix 匹配、按组/用户授权 | P0 |
| PERM-05 | MAC 策略：启动时加载、不可变、最高优先级 | P0 |
| PERM-06 | sudo 提权：30 分钟 root role、wheel 组验证 | P1 |
| PERM-07 | 权限评估：MAC → Route ACL → 策略 → DAG 解析 → allow/deny | P0 |
| PERM-08 | 系统组 CRUD：不可变策略模板、sharded index（4 shards） | P0 |
| PERM-09 | Log policy：动态日志级别控制 | P2 |
| PERM-10 | 权限模板：预定义 admin/operator/viewer/login-only/daemon/service-api | P1 |
| PERM-11 | 比较功能：用户组/权限组对比（差异分析） | P2 |

### 3.3 Sandbox 管理（单容器实例）

> Sandbox = 1 个主容器 + 可选 initContainers。多容器编排走容器组 Provider（`IContainerGroupProvider`），见 PodSpec 路径。

| ID | 需求 | 优先级 |
|----|------|--------|
| SBX-01 | 创建单容器 sandbox：指定 region、cluster、资源、镜像、initContainers、网络、存储、重启策略、健康检查探针 | P0 |
| SBX-02 | 状态机：Pending → Scheduling → Running → Stopped → Terminated → Deleted | P0 |
| SBX-03 | 同步状态：从 provider 查询实时状态、更新本地 entity | P0 |
| SBX-04 | 健康检查：可配置重试次数（默认 11）、-1=永不删除、自动终止 | P0 |
| SBX-05 | 停止 sandbox | P0 |
| SBX-06 | 终止 sandbox：best-effort provider 清理 + 本地状态删除 | P0 |
| SBX-07 | 获取 sandbox 详情（含容器状态、网络、事件） | P0 |
| SBX-08 | 列表：cursor 分页 + status 过滤 | P0 |
| SBX-09 | 等待公网 IP：轮询直到 IP 出现或超时 | P1 |
| SBX-10 | 获取容器日志（limitBytes, sinceSeconds, timestamps） | P0 |
| SBX-11 | 容器健康状态查询 | P0 |
| SBX-12 | 指标收集：CPU、内存、网络、磁盘每容器 | P1 |
| SBX-13 | 幂等创建：idempotencyKey 防止重复 | P1 |
| SBX-14 | Instance 联动：instanceId → 自动解析 ComputeInstance 获取 endpoint/capabilities | P1 |
| SBX-15 | VNet 联动：networkId → 自动合并 securityGroupId/subnetIds | P1 |

### 3.4 Template 系统

| ID | 需求 | 优先级 |
|----|------|--------|
| TPL-01 | 模板 CRUD | P0 |
| TPL-02 | DAG 继承：模板通过 dependsOn 组成继承链，合并规则（Override/Append/Merge） | P0 |
| TPL-03 | Apply：模板 → CreateSandboxInput 映射，自动求和 CPU/内存 | P0 |
| TPL-04 | 健康检查映射：healthChecks → per-container liveness/readiness/startup probes | P0 |
| TPL-05 | 存储映射：OSS、NFS、hostPath、emptyDir → Volume + VolumeMount | P0 |
| TPL-06 | 网络映射：NetworkSpec → SandboxNetworkConfig，含 instanceId 透传 | P0 |
| TPL-07 | 实例限制：fixed / perUser / perSystem 三种上限策略 | P1 |
| TPL-08 | 单例模式：singleton=true 限制只有 1 个运行中实例 | P1 |
| TPL-09 | 资源绑定：domain + port 独占声明 | P2 |
| TPL-10 | Seed 模板保护：MAC 规则防止删除无 creatorId 的种子模板 | P0 |

### 3.5 安全组

| ID | 需求 | 优先级 |
|----|------|--------|
| SG-01 | 安全组 CRUD：securityGroupId、rules、绑定 ComputeInstance | P0 |
| SG-02 | provider/region 从绑定的 ComputeInstance 自动继承 | P0 |
| SG-03 | Provider 联动：ensureNetwork / removeNetwork（Podman bridge） | P1 |
| SG-04 | 网络规则：ingress/egress 规则 + applyRules 到 provider | P2 |
| SG-05 | OCC 冲突检测 | P0 |

### 3.5b 子网

| ID | 需求 | 优先级 |
|----|------|--------|
| SUB-01 | 子网 CRUD：cidr、subnetPrefix、绑定 ComputeInstance | P0 |
| SUB-02 | provider/region 从绑定的 ComputeInstance 自动继承 | P0 |

### 3.6 Topology（拓扑管理）

| ID | 需求 | 优先级 |
|----|------|--------|
| TOP-01 | Region 列表：按平台枚举（alibaba / aws / podman） | P0 |
| TOP-02 | ComputeInstance CRUD：platform、region、zone、endpoint、credentialRef、capabilities、capacity、status | P0 |
| TOP-03 | Instance 过滤：按 region / platform / status 过滤 | P0 |
| TOP-04 | Instance heartbeat：上报容量 + 状态，last-writer-wins | P1 |
| TOP-05 | ZoneId 校验：按平台规则（alibaba: cn-hangzhou-a / podman: local-<name>） | P0 |
| TOP-06 | RegionBucket CRUD：name + bucketType + instanceId，其余从实例继承 | P0 |

### 3.6b 凭证管理

| ID | 需求 | 优先级 |
|----|------|--------|
| CRED-01 | 凭证 CRUD：name、platform、accessKeyId、accessKeySecret、registryCredentials | P0 |
| CRED-02 | 读接口自动 masking：secret 只返回前12位 + *** | P0 |
| CRED-03 | 通过 credentialRef 被 ComputeInstance 引用 | P0 |
| CRED-04 | 支持私有镜像仓库凭证（registryCredentials） | P1 |

### 3.7 DNS

| ID | 需求 | 优先级 |
|----|------|--------|
| DNS-01 | 同步 DNS 记录：在 provider（Cloudflare/Stub）和本地同时创建/更新 | P0 |
| DNS-02 | 删除 DNS 记录：provider 删除 + 本地标记 Stale | P0 |
| DNS-03 | 记录查询：按 refId 关联查询 | P2 |

### 3.8 镜像管理

| ID | 需求 | 优先级 |
|----|------|--------|
| IMG-01 | 拉取镜像：支持 instanceId 路由到不同 Podman 端点 | P0 |
| IMG-02 | 列表：分页 + architecture 过滤 | P0 |
| IMG-03 | 查看详情 | P0 |
| IMG-04 | 删除镜像 | P0 |
| IMG-05 | 私有仓库凭证：通过配置传入 registryCredentials | P1 |

### 3.9 审计

| ID | 需求 | 优先级 |
|----|------|--------|
| AUD-01 | 所有资源变更写审计日志（创建/更新/删除） | P0 |
| AUD-02 | 审计级别：INFO / NOTICE / WARNING | P0 |
| AUD-03 | 审计查询：支持后端可插拔（local / kv / workers / none） | P0 |
| AUD-04 | 登录审计：登录成功/失败 | P0 |

### 3.10 Provider 抽象

| ID | 需求 | 优先级 |
|----|------|--------|
| PRV-01 | 容器 Provider：创建/描述/更新/删除/日志 | P0 |
| PRV-02 | 容器组 Provider：Podman pod / ECI ContainerGroup 生命周期。⚠️ 接口已定义，但上层管理（独立 CRUD、状态跟踪、Web UI）待实现 | P1 |
| PRV-03 | S3 Provider：AWS S3 / Alibaba OSS / Cloudflare R2 / MinIO | P0 |
| PRV-04 | 镜像 Provider：拉取/列表/查看/删除 | P0 |
| PRV-05 | DNS Provider：Cloudflare / Stub | P0 |
| PRV-06 | Metrics Provider：ECI / Stub | P1 |
| PRV-07 | 网络策略 Provider：Podman bridge / ECI SecurityGroup | P1 |
| PRV-08 | 多账户支持：按名称查找容器/S3 账户 | P0 |
| PRV-09 | Provider 注册表：统一接口 + 能力声明 | P0 |

### 3.11 认证（后端 → 云平台）

| ID | 需求 | 优先级 |
|----|------|--------|
| AUTH-01 | Alibaba ECI：AccessKeyId + AccessKeySecret HMAC-SHA1 RPC 签名 | P0 |
| AUTH-02 | Alibaba OSS：AccessKeyId + AccessKeySecret OSS Authorization header | P0 |
| AUTH-03 | AWS S3 / MinIO：SigV4（AWS4-HMAC-SHA256） | P0 |
| AUTH-04 | Cloudflare R2：SigV4（region=auto）+ AccountId | P0 |
| AUTH-05 | Cloudflare DNS：Bearer token + OAuth2 刷新 | P0 |
| AUTH-06 | 私有镜像仓库认证：registryCredentials 配置支持 | P1 |
| AUTH-07 | 统一 IAuthProvider 抽象（NoAuth / Bearer / AkSk） | P2 |

### 3.12 Seed 数据

| ID | 需求 | 优先级 |
|----|------|--------|
| SEED-01 | 首次启动初始化策略库：4 系统组 + 4 用户组 + route ACL | P0 |
| SEED-02 | 首次启动初始化种子模板：6 模板（含 DAG 继承演示） | P0 |
| SEED-03 | 首次启动初始化默认 Podman ComputeInstance（含 region, zone, endpoint） | P0 |
| SEED-04 | 幂等初始化：标记位控制，不重复写入 | P0 |

### 3.13 Provider 抽象层

提供者层将云平台差异封装在统一接口后，业务层不分支 provider 身份。

| 接口 | 能力 | 实现 |
|------|------|------|
| `IContainerProvider` | 单容器创建/描述/更新/删除/日志 | PodmanContainerProvider / AlibabaEciContainerProvider / StubContainerProvider |
| `IContainerGroupProvider` | 多容器组创建/删除/状态（Podman pod / ECI ContainerGroup） | PodmanContainerGroupProvider / AlibabaEciContainerGroupProvider |
| `IImageProvider` | 镜像拉取/列表/查看/删除 | PodmanImageProvider / AlibabaEciImageProvider / StubImageProvider |
| `IDnsProvider` | DNS 记录创建/删除 | CloudflareDnsProvider / StubDnsProvider |
| `IMetricsProvider` | 容器指标采集 | AlibabaEciMetricsProvider / StubMetricsProvider |
| `INetworkPolicyProvider` | 多租户网络隔离（bridge / security group） | PodmanNetworkPolicyProvider |
| `IS3Provider` | S3 兼容对象存储（put/get/delete/list/presigned URL） | AwsS3Provider / AlibabaOssProvider / CloudflareR2S3Provider |
| `IVirtualNode` | Kubernetes 虚拟节点注册/心跳 | — |

**Provider 注册表（IProviderRegistry）**聚合所有提供者接口，提供：
- 默认提供者（`container`, `image`, `dns`, `metrics`）
- 多账户查找（`account(name)`）
- ComputeInstance 动态解析（`resolveContainer(instanceId)` / `resolveImage(instanceId)` / `resolveGroup(instanceId)`）

### 3.14 Template 系统

| ID | 需求 | 优先级 |
|----|------|--------|
| TPL-01 | 模板 CRUD | P0 |
| TPL-02 | DAG 继承：模板通过 dependsOn 组成继承链，合并规则（Override/Append/Merge） | P0 |
| TPL-03 | Apply：模板 → CreateSandboxInput 映射，自动求和 CPU/内存 | P0 |
| TPL-04 | 健康检查映射：healthChecks → per-container liveness/readiness/startup probes | P0 |
| TPL-05 | 存储映射：OSS、NFS、hostPath、emptyDir → Volume + VolumeMount | P0 |
| TPL-06 | 网络映射：NetworkSpec → SandboxNetworkConfig，含 instanceId 透传 | P0 |
| TPL-07 | 实例限制：fixed / perUser / perSystem 三种上限策略 | P1 |
| TPL-08 | 单例模式：singleton=true 限制只有 1 个运行中实例 | P1 |
| TPL-09 | 资源绑定：domain + port 独占声明 | P2 |
| TPL-10 | Seed 模板保护：MAC 规则防止删除无 creatorId 的种子模板 | P0 |

**模板 DAG 合并策略：**

| 策略 | 规则 |
|------|------|
| **Override** | 上层模板的字段覆盖下层同名 field |
| **Append** | 容器按 name 去重合并，新 name 追加 |
| **Merge** | 同名 container 的 env/ports/cmd 做深度合并 |

**6 个种子模板：**
- `base-alpine` — Alpine Linux，sleep 3600，256MB
- `nginx` — Nginx，端口 80，TCP readiness 检查，singleton
- `fedora` — Fedora Linux，sleep 3600，256MB
- `minio-server` — MinIO S3 存储，端口 9000/9001，默认凭据
- `custom-alpine` — DAG 继承 base-alpine，加 curl + env
- `full-stack` — DAG 合并 custom-alpine + nginx

### 3.15 拓扑模型（Topology）

```
Platform（云厂商）                  ← 谁提供计算资源
 └── Region（地域, 枚举值）           ← 哪个数据中心
      └── ComputeInstance（计算实例）  ← 核心底层概念
            ├── endpoint, credentialRef
            ├── capabilities, capacity, status
            ├── labels, createdAt, updatedAt
            ├── SecurityGroup（绑定到此实例的安全组）
            ├── Subnet（绑定到此实例的子网）
            ├── RegionBucket（绑定到此实例的存储桶）
            └── Credential（通过 credentialRef 引用）

ComputeInstance + Template → Sandbox（运行中的容器）
```

**核心公式：`Sandbox = ComputeInstance + Template`**

- Template 定义「跑什么」（镜像、命令、资源规格、网络、探针）
- ComputeInstance 定义「在哪跑」（端点、凭证、能力、容量）
- Sandbox 是两者结合的运行实例，有独立生命周期（状态机）

| ID | 需求 | 优先级 |
|----|------|--------|
| TOP-01 | Platform 枚举：alibaba / aws / podman / stub | P0 |
| TOP-02 | Region 枚举：AlibabaRegion 19 个、AwsRegion 13 个、PodmanRegion 1 个 | P0 |
| TOP-03 | ZoneId：branded string，按平台校验格式（alibaba: cn-hangzhou-a / podman: local-<name>） | P0 |
| TOP-04 | ComputeInstance CRUD：platform、region、zone、endpoint、credentialRef、capabilities、capacity、labels、status | P0 |
| TOP-05 | RegionBucket CRUD：name + bucketType + instanceId，其余从实例继承 | P0 |
| TOP-06 | Instance heartbeat：上报容量 + 状态，last-writer-wins | P1 |
| TOP-07 | Instance 按能力解析：resolveByCapability(container/image/group/network/s3) | P0 |
| TOP-08 | Credential CRUD：读接口 secret 自动 masking | P0 |

### 3.16 存储抽象（3-Tier）

| 层级 | 接口 | 实现 | 用途 |
|------|------|------|------|
| **Atomic Store** | `IAtomicStore` | DO / file / KV | 热数据，OCC 写入，强一致 |
| **Query Store** | `IQueryStore` | D1 / none | 关系查询，复杂报表 |
| **Blob Store** | `IBlobStore` | R2 / none | 大对象存储（日志、备份） |

**IAtomicStore 核心操作：**
- `get<T>(key)` → `{ value, version } | null`
- `set<T>(key, value, expectedVersion, ttl?)` — OCC 写入
- `transact<T>(action)` — 串行化事务

### 3.17 事件系统

| ID | 需求 | 优先级 |
|----|------|--------|
| EVT-01 | EventBus：进程内 pub/sub | P0 |
| EVT-02 | EventLoop：定时 tick 处理队列事件 | P0 |
| EVT-03 | 健康检查 tick：扫描 sandbox 状态、自动终止不健康实例 | P0 |
| EVT-04 | DO alarm 回调：`POST /__tick` 触发 tick | P1 |
| EVT-05 | WebSocket 桥接：将事件推送到 Notification DO | P2 |

### 3.18 审计系统

| ID | 需求 | 优先级 |
|----|------|--------|
| AUD-01 | 所有资源变更写审计日志（创建/更新/删除），含 actorId | P0 |
| AUD-02 | 审计级别：INFO / NOTICE / WARNING / ERR | P0 |
| AUD-03 | 审计后端可插拔：local / kv / workers / none | P0 |
| AUD-04 | 审计日志查询：分页、级别过滤、facility 过滤、文本搜索 | P0 |
| AUD-05 | 每一条日志包含操作者 ID（actorId） | P0 |

---

## 4. 数据流

### 4.1 创建单容器 Sandbox（模板 Apply）

> 一条 sandbox = 一个主容器。`CreateContainerGroupInput` 虽然是"组"命名，但 Podman 实现只取 `containers[0]`，ECI 实现创建单容器 ContainerGroup。

```
POST /api/templates/:id/apply
  → authz middleware（route ACL + 权限检查）
  → template/handler.ts
    → 加载 template + DAG 解析
    → applicator.applyTemplate() → CreateSandboxInput
  → SandboxService.provision(input)
    1. 解析 VNet 引用（networkId → merge securityGroupId）
    2. 解析 ComputeInstance 引用（instanceId → 获取 endpoint/capabilities）
    3. 生成 SandboxId, 持久化 Scheduling
    4. 解析容器 Provider：resolveContainer(instanceId) → IContainerProvider
    5. toContainerGroupInput() → CreateContainerGroupInput
    6. IContainerProvider.create()
    7. 持久化 Running
    8. dispatch event (sandbox.provisioned)
```

### 4.2 健康检查循环

```
EventLoop tick (30s)
  → health:check event
  → 遍历所有 sandbox:ids
    → provider.getStatus(providerId)
    → null → 标记 Deleted
    → 容器不健康 → 累加 health:fails:{id}
    → fails >= maxRetries → provider.delete() → 标记 Deleted
```

### 4.3 权限评估

```
请求到达
  → authz middleware
    1. 检查 publicPaths → 跳过
    2. MAC 规则评估（deny-override）
    3. Route ACL 匹配（method + pathPrefix）
    4. 用户登录策略（时间 + IP）
  → handler
    5. requirePerm() → action + resource 级别检查
       → 加载用户组 + DAG 依赖
       → 权限组 + DAG 依赖
       → 按优先级排序
       → 首条匹配 deny = 拒绝, 首条匹配 allow = 允许
       → 默认拒绝
```

---

## 5. 非功能性需求

| ID | 需求 | 指标 |
|----|------|------|
| NFR-01 | 平台无关性 | 所有 provider 接口平台无关，新增云厂商不改业务层 |
| NFR-02 | OCC 数据一致性 | 所有写操作使用 optimistic concurrency control |
| NFR-03 | Provider 容错 | provider 不可用时不阻塞本地状态变更 |
| NFR-04 | 幂等性 | idempotencyKey 防止 sandbox 重复创建 |
| NFR-05 | 审计完整性 | 所有资源变更可追溯 |
| NFR-06 | 前端适配 | 所有列表接口支持分页 |
| NFR-07 | 请求限制 | 100 req/60s rate limit, 5MB body limit, JSON 深度 10 |
| NFR-08 | 认证方式 | 密码 / Ed25519 无密码 / Bearer token / AK/SK HMAC 四种 |
| NFR-09 | 多数据中心 | Region + ComputeInstance + Zone 三级拓扑，调度器感知 |
| NFR-10 | 存储可插拔 | file / KV / D1 / R2 / DO 按环境切换 |

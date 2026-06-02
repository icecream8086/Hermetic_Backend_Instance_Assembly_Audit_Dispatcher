# Virtual Network API v1

## Overview

虚拟网段（Virtual Network）是对容器网络基础设施的抽象层，负责管理 CIDR 网段定义、可见性控制、Provider 映射。**不负责 EIP/公网 IP 管理。**

支持三种 Provider：
- `podman` — Podman Network (bridge driver)
- `alibaba` — 阿里云 VPC + VSwitch + SecurityGroup
- `stub` — 本地开发模拟

---

## Entity

```typescript
interface VirtualNetwork {
  id: string;                      // "net_<uuid>"
  name: string;
  description?: string;

  // 网络配置
  cidr: string;                    // "10.2.0.0/16"
  subnetPrefix: number;            // 24
  securityGroupId?: string;

  // Provider 映射
  provider: string;                // "podman" | "alibaba" | "stub"
  region: string;
  providerNetworkId?: string;      // 创建后回填

  // 访问控制
  visibility: 'public' | 'private';
  creatorId?: string;
  userIds?: string[];
  userGroupIds?: string[];

  status: 'Active' | 'Inactive' | 'Error';
  createdAt: number;
  updatedAt: number;
}
```

---

## Access Control

| 规则 | 说明 |
|---|---|
| >= root 组 + role='root' | **无视所有可见性规则**，可 CRUD 全部 |
| `visibility: public` | 所有认证用户可见 |
| `visibility: private` + `creatorId` 匹配 | 仅创建者自己可见 |
| `visibility: private` + `userIds` 白名单 | 指定用户可见 |
| `visibility: private` + `userGroupIds` 白名单 | 指定用户组成员可见 |

---

## Endpoints

### POST /api/networks

创建虚拟网段。Root only。

```json
// Request
{
  "name": "dev-network",
  "cidr": "10.2.0.0/16",
  "subnetPrefix": 24,
  "provider": "podman",
  "region": "local",
  "visibility": "private",
  "userGroupIds": ["usergrp_developers"]
}

// Response: 201
{
  "ok": true,
  "data": { "id": "net_xxx", "name": "dev-network", ... }
}
```

### GET /api/networks

列出虚拟网段，按当前用户可见性过滤。支持分页和过滤。

| Query | Type | Default | Description |
|---|---|---|---|
| `page` | int | 1 | 页码 |
| `limit` | int | 20 | 每页条数 (max 100) |
| `visibility` | string | — | 过滤: `public` / `private` |
| `provider` | string | — | 过滤: `podman` / `alibaba` / `stub` |
| `region` | string | — | 过滤: `local` / `cn-hangzhou` / ... |

```json
// Response
{
  "ok": true,
  "data": {
    "items": [ { "id": "net_xxx", ... } ],
    "total": 1,
    "page": 1,
    "limit": 20
  }
}
```

### GET /api/networks/:id

获取单个虚拟网段详情。

### PUT /api/networks/:id

更新虚拟网段。Root only。

```json
// Request
{
  "name": "renamed-network",
  "visibility": "public",
  "userIds": ["user_uuid_1", "user_uuid_2"]
}
```

### DELETE /api/networks/:id

删除虚拟网段。Root only。

```json
// Response: 200
{ "ok": true, "data": null }
```

---

## Route ACL

| Group | Access |
|---|---|
| root | `* /api/networks` (全部操作) |
| users | `GET /api/networks` (只读) |
| wheel | `* /` (全路径放行，含 networks) |

---

## Integration with Templates

模板 `network.vpc.id` 将来可引用 `VirtualNetwork.id`。apply 时系统自动从虚拟网段的 CIDR 池分配子网并传入 provider。

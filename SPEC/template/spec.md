# Sandbox Template Specification v2

## Overview

Sandbox templates define **stateless container specs** with **DAG inheritance**. The type system is organized into three clear layers:

| Layer | Content | Tag |
|---|---|---|
| **模板信息** | Template metadata (name, visibility, DAG, quotas) | — |
| **容器信息** | Stateless container definitions | `container` |
| **扩展功能** | Health checks, network, storage, vendor overrides | `extensions` |

`container` (stateless core) and future `containerGroup` are **mutually exclusive** — a template is either a single container group or a pod of containers, never both.

---

## Template Object

```typescript
interface SandboxTemplate {
  id: string;
  name: string;                        // 锁原子性基础 — 改名 = 新锁
  description?: string;

  // DAG inheritance
  dependsOn?: string[];

  // Timestamps
  createdAt: number;
  updatedAt: number;

  // Ownership & access control
  creatorId?: string;
  visibility?: 'public' | 'private';
  userGroupIds?: string[];

  // Instance limit (NOT inherited via DAG — child must re-declare)
  instanceLimit?: {
    type: 'fixed' | 'perUser' | 'perSystem';
    max: number;
  };

  // Domain:port exclusive binding
  resourceBinding?: { domain?: string; port?: number };

  // ── Container (stateless core, tag: container) ──
  container?: ContainerSpec;

  // ── Health checks (independent from container) ──
  healthChecks?: HealthCheckDef[];

  // ── Network (common infrastructure layer) ──
  network?: NetworkSpec;

  // ── Extensions (storage, scheduling, vendor, lifecycle) ──
  extensions?: TemplateExtensions;
}
```

---

## ContainerSpec (Stateless Core)

```typescript
interface ContainerSpec {
  region: string;
  zone?: string;
  account?: string;
  restartPolicy?: 'Always' | 'OnFailure' | 'Never';
  containers: ContainerDef[];
  initContainers?: ContainerDef[];
}

interface ContainerDef {
  name: string;
  image: string;
  command?: string[];              // ENTRYPOINT override
  args?: string[];                 // CMD override
  env?: { name: string; value?: string; valueFrom?: string }[];
  ports?: { containerPort: number; protocol?: string }[];
  resources?: {
    requests?: { cpu?: number; memory?: number };
    limits?:   { cpu?: number; memory?: number; gpu?: number };
  };
}
```

No probes, no storage, no provider overrides — these are **extensions**.

### Resource Units

| Field | Unit | Example |
|---|---|---|
| `cpu` | cores (fractional OK) | `0.25`, `1.0`, `4` |
| `memory` | MB | `256`, `1024` |
| `gpu` | cards | `1` |

---

## HealthChecks (Independent)

```typescript
interface HealthCheckDef {
  name: string;
  target: string;                  // "container:name" | "init:name"
  type: 'liveness' | 'readiness' | 'startup';
  probe: ProbeSpec;                // exec | httpGet | tcpSocket
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}
```

### Probe Types

```json
// HTTP GET
{ "httpGet": { "path": "/health", "port": 8080, "scheme": "HTTP" } }

// TCP Socket
{ "tcpSocket": { "port": 80 } }

// Exec command
{ "exec": { "command": ["/bin/bash", "-c", "exec 3<>/dev/tcp/localhost/80 || exit 1"] } }
```

Health checks are **composable** — multiple checks can target the same container.

---

## Network (Common Infrastructure Layer)

```typescript
interface NetworkSpec {
  mode?: 'public' | 'private' | 'vpc';
  publicIp?: {
    allocate?: boolean;
    bandwidth?: number;            // Mbps
  };
  vpc?: {
    id?: string;
    subnetIds?: string[];
    securityGroupId?: string;
  };
  // future: dns, loadBalancer, privateLink
}
```

---

## Extensions (Storage, Scheduling, Vendor, Lifecycle)

```typescript
interface TemplateExtensions {
  storage?: TemplateStorage[];
  spotStrategy?: string;           // "None" | "SpotAsPriceGo" | "SpotWithPriceLimit"
  providerOverrides?: Record<string, unknown>;
  healthMaxRetries?: number;
  autoStart?: boolean;
  webTerminal?: boolean;
  lifecycleHooks?: Record<string, unknown>;
}

interface TemplateStorage {
  name: string;
  type: 'oss' | 'nfs' | 'hostPath' | 'emptyDir';
  mountPath: string;
  oss?:      { bucket: string; path: string; readOnly?: boolean };
  nfs?:      { server: string; path: string; readOnly?: boolean };
  hostPath?: { path: string };
  size?: number;                  // GB (emptyDir capacity)
  providerOverrides?: Record<string, unknown>;
}
```

---

## Instance Limit System

### Declaration

```json
{
  "name": "singleton-app",
  "instanceLimit": { "type": "fixed", "max": 1 },
  "container": { "region": "local", "containers": [...] }
}
```

### Limit Types

| Type | Scope | Behavior |
|---|---|---|
| `fixed` | Global | 模板全局限量，所有用户共享 N 个实例 |
| `perSystem` | Global | 同 `fixed`，系统级总量控制 |
| `perUser` | Per user | 每个用户仅能创建 N 个该模板的实例 |

### Enforcement

apply 时 `claimInstanceSlot()` 执行：
1. 扫描 `sandbox:ids` 索引，查找 `name === 模板名` 的沙箱
2. 检查沙箱状态是否为 `live`（Pending / Scheduling / Running / Stopped / Terminated）
3. 如果实时计数 ≥ `max` → 返回 429
4. OCC 计数器辅助并发保护

### Lock Key

- 基于 `tpl.name` 的 hash → `tpl:lock:<hash>`
- **改名 = 新锁** — 模板重命名后，原有运行中实例不计入新锁
- 容器停止（Failed / Deleted）后不计入，允许重新创建

### Inheritance

`instanceLimit` **不被 DAG 合并**。子模板必须显式声明自己的 limit：

```json
// Parent: singleton-parent (instanceLimit: { type: "fixed", max: 1 })
// Child:  inherited without instanceLimit → 无限制
// Child:  inherited WITH instanceLimit → 使用子模板的 limit（独立的锁）
```

---

## DAG Inheritance

Templates form a DAG via `dependsOn`. During resolution:

1. All ancestors collected via DFS
2. Reversed (root first → child last), then deep-merged
3. Child values override parents

### Merge Rules

| Field | Strategy | Inherited? |
|---|---|---|
| `container.containers` | Merge by `name` | 是 |
| `container.initContainers` | Merge by `name` | 是 |
| `healthChecks` | Merge by `target:name` | 是 |
| `network` | Deep merge | 是 |
| `extensions` | Deep merge | 是 |
| `instanceLimit` | **Not merged** | 否 — 子模板必须重声明 |
| `resourceBinding` | **Not merged** | 否 — 每个模板独立的域名绑定 |
| `visibility` | **Not merged** | 否 — 子模板自己的可见性 |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST`   | `/api/templates` | Create template |
| `GET`    | `/api/templates` | List templates |
| `GET`    | `/api/templates/:id` | Get raw template |
| `GET`    | `/api/templates/:id/resolved` | Get DAG-resolved template |
| `POST`   | `/api/templates/:id/apply` | Apply → create sandbox |
| `PUT`    | `/api/templates/:id` | Update template |
| `DELETE` | `/api/templates/:id` | Delete template |

### Apply Request Body

```json
POST /api/templates/:id/apply
{
  "name": "my-sandbox",
  "region": "local",
  "provider": "podman"
}
```

---

## Seed Templates

| Name | Containers | Probes | DependsOn |
|---|---|---|---|
| `base-alpine` | alpine (sleep 3600) | none | — |
| `nginx` | nginx (port 80) | readiness TCP:80 | — |
| `custom-alpine` | alpine (DAG demo) | none | `base-alpine` |
| `full-stack` | alpine (merged) | none (from base-alpine) | `custom-alpine`, `nginx` |

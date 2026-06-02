# Preview: ContainerGroup Template Spec (v1-proposal)

> **Status**: Design Preview — not yet implemented
> **Kind**: `ContainerGroup`
> **ApiVersion**: `hbi-aad/v1`

## Overview

`ContainerGroup` is a future template kind that extends the stateless container model to **multi-service orchestration**. It is mutually exclusive with `Container` — a template is one or the other.

Conceptually equivalent to `docker-compose.yml` or a Kubernetes `Pod`, but expressed in the same HBI-AAD template format.

---

## Identity Tags

```typescript
interface SandboxTemplate {
  apiVersion: string;                // "hbi-aad/v1"
  kind: 'Container' | 'ContainerGroup';
  metadata?: {
    author?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
}
```

The `kind` field is the formal discriminator. Future code can switch on `kind` to determine which spec to validate and apply.

---

## ContainerGroup Spec

```typescript
interface ContainerGroupSpec {
  region: string;
  zone?: string;
  account?: string;

  // Shared namespaces — containers can communicate via localhost
  sharedNamespaces?: ('net' | 'uts' | 'ipc' | 'pid')[];

  // Multi-service definitions
  services: Record<string, ServiceDef>;
}

interface ServiceDef {
  image: string;
  command?: string[];
  args?: string[];
  env?: { name: string; value?: string; valueFrom?: string }[];
  ports?: { containerPort: number; hostPort?: number; protocol?: string }[];
  resources?: {
    requests?: { cpu?: number; memory?: number };
    limits?:   { cpu?: number; memory?: number; gpu?: number };
  };

  // Service topology: start order
  dependsOn?: string[];

  // Horizontal scaling
  replicas?: number;                 // default 1

  // Per-service health checks
  healthChecks?: {
    type: 'liveness' | 'readiness' | 'startup';
    probe: ProbeSpec;
    initialDelaySeconds?: number;
    periodSeconds?: number;
    timeoutSeconds?: number;
    successThreshold?: number;
    failureThreshold?: number;
  }[];

  // Per-service storage
  storage?: TemplateStorage[];
}
```

---

## Comparison: Container vs ContainerGroup

| Aspect | Container | ContainerGroup |
|---|---|---|
| **kind** | `"Container"` | `"ContainerGroup"` |
| **Container spec** | `container.containers[]` | `containerGroup.services{}` |
| **Health checks** | Global `healthChecks[]` by target | Per-service `.healthChecks[]` |
| **Service topology** | None (flat) | `dependsOn[]` per service |
| **Replicas** | None (1 implicit) | `.replicas` per service |
| **Shared namespace** | N/A | `sharedNamespaces[]` |
| **Storage** | Global `storage[]` | Per-service `.storage[]` |
| **Use case** | Single container / sidecar | Microservices / full-stack |

---

## Example: Full-Stack App

```json
{
  "name": "fullstack-app",
  "apiVersion": "hbi-aad/v1",
  "kind": "ContainerGroup",
  "singleton": true,
  "metadata": {
    "author": "dev@example.com",
    "labels": { "env": "staging", "stack": "fullstack" }
  },

  "containerGroup": {
    "region": "local",
    "sharedNamespaces": ["net"],

    "services": {
      "db": {
        "image": "postgres:15-alpine",
        "env": [{ "name": "POSTGRES_DB", "value": "myapp" }],
        "resources": { "limits": { "cpu": 1, "memory": 512 } },
        "storage": [{
          "name": "pgdata",
          "type": "nfs",
          "mountPath": "/var/lib/postgresql/data",
          "nfs": { "server": "192.168.1.100", "path": "/data/pg" }
        }]
      },

      "api": {
        "image": "node:20-alpine",
        "command": ["node", "server.js"],
        "env": [{ "name": "PORT", "value": "3000" }],
        "ports": [{ "containerPort": 3000 }],
        "resources": { "limits": { "cpu": 0.5, "memory": 256 } },
        "dependsOn": ["db"],
        "healthChecks": [
          { "type": "liveness", "probe": { "httpGet": { "path": "/health", "port": 3000 } }, "periodSeconds": 15 }
        ]
      },

      "web": {
        "image": "nginx:latest",
        "ports": [{ "containerPort": 80 }],
        "resources": { "limits": { "cpu": 0.5, "memory": 128 } },
        "dependsOn": ["api"],
        "replicas": 2,
        "healthChecks": [
          { "type": "readiness", "probe": { "tcpSocket": { "port": 80 } }, "periodSeconds": 5, "initialDelaySeconds": 2 }
        ]
      }
    }
  },

  "network": {
    "mode": "public",
    "publicIp": { "allocate": true, "bandwidth": 10 }
  },

  "extensions": {
    "providerOverrides": {
      "podman": { "networkName": "hbi-net" }
    }
  }
}
```

---

## Shared Namespace Behavior

| Namespace | Effect |
|---|---|
| `net` | All services share the same network stack — localhost communication |
| `uts` | Shared hostname and domain name |
| `ipc` | Shared IPC namespace — inter-process communication |
| `pid` | Shared PID namespace — one service can see another's processes |

With `sharedNamespaces: ["net"]`, services communicate via `localhost:<port>`.
Without it, each service has its own network namespace and communicates via service name.

---

## Implementation Path

1. Add `containerGroup?: ContainerGroupSpec` to `SandboxTemplate` (types.ts)
2. Add `ContainerGroup` to the `kind` union
3. Create `applicator-gp.ts` — maps `ContainerGroupSpec` to provider input
4. Update DAG merge to handle `containerGroup` (merge services by name)
5. Update seed templates — add a demo containerGroup template
6. The rest (network, extensions, instance limit, visibility) stays the same

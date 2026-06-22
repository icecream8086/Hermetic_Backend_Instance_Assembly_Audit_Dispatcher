# Action 系统前端开发指南

> 基于 `specs/Action_Module.md` 和当前后端实现，2026-06-23

---

## 1. 基础信息

| 项目 | 值 |
|------|-----|
| API Base | `http://localhost:3000/api/actions` |
| 认证 | `Authorization: Bearer {token}`（复用 `/api/users/login`） |
| 内容类型 | `application/json` |
| 分页格式 | `{ items: T[], total: number, page: number, limit: number }` |
| 实时推送 | WebSocket `workflow:completed` / `workflow:job:status` |
| OpenAPI | `GET /api/openapi.json`（自动生成） |

---

## 2. 核心页面与 API 映射

### 2.1 工作流列表页

```
GET /api/actions/workflows?page=1&limit=50
→ { items: WorkflowDef[], total, page, limit }
```

**WorkflowDef 关键字段：**
```typescript
{
  id: string;          // "wf_xxx"
  name: string;
  on: { manual?: boolean; cron?: string; push?: { branches?: string[] }; http?: { signatureSecret?: string } };
  jobs: Record<string, JobDef>;
  orgId?: string;
  projectId?: string;
  ownerId?: string;
  createdAt: number;
  updatedAt: number;
}
```

**操作：** 新建 / 编辑 / 删除 / 触发

---

### 2.2 工作流编辑器（YAML / 表单）

**新建：**
```
POST /api/actions/workflows
Body: {
  name: "my-workflow",
  on: { manual: true },
  jobs: { build: { container: { image: "node:20" }, steps: [{ run: "npm test" }] } }
}
→ 201 WorkflowDef
```

**更新：**
```
PATCH /api/actions/workflows/:id
Body: { name: "new-name" }  // 部分更新
→ WorkflowDef
```

**YAML 格式参考：**
```yaml
name: "Deploy Game Server"
on:
  manual: true
  cron: "0 */6 * * *"
  http:
    signatureSecret: "my-secret"
jobs:
  build:
    runsOn: "linux"
    needs: []
    container:
      image: "docker.io/library/node:20"
      resources: { cpu: 2, memory: 4096 }
      ports: [{ containerPort: 3000 }]
    steps:
      - name: "Install"
        run: "npm install"
      - name: "Test"
        run: "npm test"
        continueOnError: true
      - name: "Deploy DNS"
        dns:
          action: upsert
          type: A
          name: "game.example.com"
          value: "${{ steps.get-ip.outputs.ip }}"
          zoneId: "abc123"
          proxied: true
    timeout: 600

  deploy:
    needs: ["build"]
    instanceId: "inst_eci_hangzhou"
    region: "cn-hangzhou"
    containers:
      - name: main
        image: "my-registry/game-server:v1.2.3"
        ports: [{ containerPort: 25565 }]
      - name: db
        image: "docker.io/library/redis:7"
    approval:
      approvers: ["admin-user-id"]
      message: "Please approve production deploy"
    steps:
      - run: "./start.sh"
  ```

**校验：** 后端用 Zod 校验，返回 `400 INVALID_WORKFLOW` 时 `error.message` 包含具体字段错误。

**矩阵策略：**
```yaml
test:
  strategy:
    matrix:
      os: [ubuntu, alpine]
      node: [18, 20]
    exclude:
      - { os: alpine, node: 20 }
  container:
    image: "node:${{ matrix.node }}"
  steps:
    - run: "uname -a && node -v"
```
运行时自动展开为 `test (os=ubuntu, node=18)`, `test (os=ubuntu, node=20)`, `test (os=alpine, node=18)` 三个 Job。

---

### 2.3 触发工作流

| 触发方式 | API | 说明 |
|----------|-----|------|
| 手动 | `POST /api/actions/workflows/:id/trigger` | body: `{ inputs: { key: "value" } }` → `201 WorkflowRun` |
| HTTP | `POST /api/actions/workflows/:id/http` | header: `X-Workflow-Signature: <HMAC-SHA256>` |
| Webhook | `POST /api/actions/webhook` | body: `{ ref: "refs/heads/main", ... }` |
| 共享链接 | `POST /api/actions/shared-links/:id/launch` | body: `{ password?: "xxx" }`，无需登录 |

---

### 2.4 运行监控页（DAG 可视化核心）

**Run 列表：**
```
GET /api/actions/runs?page=1&limit=50
→ { items: WorkflowRun[], total, page, limit }
```

**WorkflowRun：**
```typescript
{
  id: string;           // "wfr_xxx"
  workflowId: string;
  status: "Pending" | "Running" | "Success" | "Failure" | "Cancelled" | "TimedOut";
  trigger: "manual" | "cron" | "http" | "webhook" | "shared_link";
  jobRunRefs: { jobName: string; jobRunId: string }[];  // ← DAG 节点列表
  startedAt: number;
  completedAt?: number;
}
```

**DAG 渲染：**
```
jobRunRefs 即节点列表。JobDef.needs 即边。
前端从 WorkflowDef.jobs[name].needs 获取边关系，结合 jobRunRefs 绘制 DAG。
节点颜色: Queued=灰, Running=蓝, Success=绿, Failure=红, Skipped=黄
```

**Job 详情：**
```
GET /api/actions/jobs/:jobRunId
→ JobRun {
  jobName: string,
  status: "Queued" | "Running" | "Success" | "Failure" | "Skipped" | "Cancelled",
  sandboxId?: string,
  stepRuns: { name: string, status: string, startedAt?, completedAt?, exitCode?, error? }[],
  startedAt?, completedAt?, error?
}
```

**Step 日志：**
```
GET /api/actions/jobs/:jobRunId/logs?step=build&offset=0&limit=500
→ { text: string, totalBytes: number, offset: number, limit: number }
```
日志格式为 dmesg: `[    123.456789] Step started: build`

**审批操作：**
```
POST /api/actions/runs/:runId/approvals
Body: { jobName: "deploy", approvers: ["user-id-1", "user-id-2"] }

POST /api/actions/approvals/:approvalId/decide
Body: { approved: true, reason: "LGTM" }
```

---

### 2.5 实时状态推送（WebSocket）

**事件类型：**

| 事件 | payload | 触发时机 |
|------|---------|----------|
| `workflow:job:status` | `{ jobRunId, jobName, workflowRunId, status, error? }` | Job 状态变更（Running/Success/Failure） |
| `workflow:completed` | `{ workflowRunId, status }` | WorkflowRun 终态 |

**连接：** Workers 部署后通过 DO WebSocket；本地开发需检查 DO binding 配置。
前端在 Run 详情页建立连接，收到事件后局部更新节点颜色/状态，不需要轮询。

---

### 2.6 共享链接管理（OneDrive 式分享）

**Owner 创建：**
```
POST /api/actions/shared-links
Body: {
  workflowId: "wf_xxx",
  name: "My Game Server",
  password: "optional-password",
  expiresAt: 1719600000000,
  maxUses: 10,         // 0 = 无限
  concurrentMax: 3,    // 0 = 无限
  defaultTtlSeconds: 3600
}
→ 201 SharedLink (不含 passwordHash)
```

**Owner 列表 / 详情 / 撤销：**
```
GET    /api/actions/shared-links
GET    /api/actions/shared-links/:id
POST   /api/actions/shared-links/:id/disable
```

**Guest 访问流程（前端页面）：**
```
1. 打开 https://yourapp.com/launch/sl_xxx
2. 调 GET /api/actions/shared-links/:id → 显示服务名称、简介
3. 如果需要密码，弹出输入框
4. POST /api/actions/shared-links/:id/launch  { password: "xxx" }
   → 201 { runId: "wfr_xxx", status: "Pending" }
5. 轮询或 WebSocket 等 run 完成
6. GET /api/actions/runs/:runId/jobs → 拿 sandboxId / IP:port
```

---

### 2.7 Runner 管理

```
GET    /api/actions/runners              # 在线列表 → RunnerRegistration[]
GET    /api/actions/runners?labels={"os":"linux"}  # 标签过滤
POST   /api/actions/runners/heartbeat    # Runner 注册/心跳
POST   /api/actions/runners/:id/drain    # 排水
```

---

### 2.8 组织与权限

```
POST   /api/actions/orgs                 # 创建组织
GET    /api/actions/orgs?member=userId   # 我的组织
POST   /api/actions/orgs/:id/members     # 添加成员
POST   /api/actions/projects             # 创建项目 (需 orgId)
GET    /api/actions/projects?orgId=xxx   # 项目列表
```

**密钥管理：**
```
POST   /api/actions/workflows/:id/secrets   { key: "DOCKER_PASSWORD", value: "xxx" }
GET    /api/actions/workflows/:id/secrets   → [{ key, id }]  // 不返回 value
DELETE /api/actions/secrets/:id
```
在 YAML 中用 `${{ secrets.DOCKER_PASSWORD }}` 引用，后端自动解密注入。

---

### 2.9 仪表盘

```
GET /api/actions/dashboard
→ {
  totalRuns, activeRuns, successRate, avgDurationMs,
  runnersOnline,
  byTrigger: { manual: N, cron: N, webhook: N, http: N, shared_link: N },
  byStatus: { Success: N, Failure: N, Pending: N, Running: N }
}
```

---

### 2.10 Action 注册表

```
POST /api/actions/actions    { name, version, runs: { using: "container", image: "node:20" } }
GET  /api/actions/actions?page=1&limit=50
```

---

## 3. 权限模型

后端已挂 RBAC guard。前端按角色控制 UI：

| 资源 | Action | 说明 |
|------|--------|------|
| `action:workflow` | `create` / `read` / `update` / `delete` / `execute` | 工作流 CRUD + 触发 |
| `action:secret` | `create` / `read` / `delete` | 密钥管理 |
| `action:shared-link` | `create` / `read` / `delete` | 共享链接 |
| `action:runner` | `read` / `manage` | Runner 管理 |
| `action:org` | `create` / `read` / `manage` | 组织管理 |

后端返回 `403 FORBIDDEN` 时，前端隐藏对应按钮/菜单项。

---

## 4. 错误处理

所有错误返回 `{ error: string }`。关键错误码：

| HTTP | code | 说明 |
|------|------|------|
| 400 | `INVALID_WORKFLOW` | YAML/JSON 校验失败，message 含具体字段 |
| 401 | `MISSING_SIGNATURE` / `INVALID_SIGNATURE` | HTTP 触发签名错误 |
| 403 | `FORBIDDEN` | 权限不足 |
| 403 | `LINK_EXPIRED` / `LINK_EXHAUSTED` / `LINK_DISABLED` | 共享链接失效 |
| 404 | `WORKFLOW_NOT_FOUND` / `RUN_NOT_FOUND` / `JOB_NOT_FOUND` | 资源不存在 |
| 409 | `CONFLICT` | OCC 版本冲突，重试即可 |

---

## 5. 推荐前端技术栈

| 需求 | 推荐 |
|------|------|
| 框架 | React 18+ / Vue 3+ |
| YAML 编辑器 | monaco-yaml（VS Code 同款） |
| DAG 可视化 | dagre + react-flow / vue-flow |
| 实时状态 | WebSocket + zustand/pinia |
| HTTP 测试 | `http/action.http`（VS Code REST Client） |
| OpenAPI 生成 | `openapi.json` → openapi-generator / orval |

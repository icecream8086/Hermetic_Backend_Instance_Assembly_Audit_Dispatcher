# Alibaba ECI 扩展字段 — AST 规则表

> 面向前端动态表单引擎。每个字段视为一个 AST 节点，`deps` 定义其可见性/可选性的前置条件。

---

## 1. 节点定义 (Field AST Nodes)

```
FieldNode {
  key: string              // providerOverrides.alibaba 下的 key
  group: string            // 编辑器分组
  type: "string" | "number" | "boolean" | "string[]" | "object"
  label: string            // 中文标签
  help: string             // tooltip 文案
  eciParam: string         // 映射到的 ECI API 参数名
  default?: string|number|boolean
  validation?: {
    kind: "enum" | "range" | "pattern"
    values?: string[]       // enum 取值列表
    min?: number
    max?: number
    pattern?: string        // regex
  }
  visibility: Rule[]        // 可见性条件（AND）
  required: Rule[]          // 必填条件（AND，仅在可见时生效）
  locked: Rule[]            // 锁定值条件（字段存在但不可改）
  scope: "sandbox" | "network" | "container" | "volume"
}
```

---

## 2. 规则表达式 (Rule AST)

```
Rule {
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "nin" | "exists"
  field: string             // 目标字段路径，支持点号嵌套
  value?: string | number | boolean | string[]
}
```

**路径语法**：

| 路径 | 解析目标 |
|---|---|
| `resourceSpec.gpu` | `container.resources.limits.gpu` 的聚合值 |
| `spotStrategy` | `providerOverrides.alibaba.spotStrategy` |
| `autoCreateEip` | `providerOverrides.alibaba.autoCreateEip` |
| `containers[0].image` | 第一个容器的镜像 |
| `subnetIds` | 网络配置的子网列表 |

---

## 3. 字段节点全表

### 3.1 GPU & 实例规格 (group: gpu)

| # | key | type | default | validation | visibility | locked |
|---|---|---|---|---|---|---|
| 1 | `instanceType` | string | — | — | always | `{op:"eq", field:"resourceSpec.gpu", value:0}` → lock `ecs.gn*` when gpu>0 |
| 2 | `cpuArchitecture` | enum | `AMD64` | `AMD64`, `Arm64` | always | 当 `gpu > 0` → 锁定 `AMD64` |
| 3 | `osType` | enum | `Linux` | `Linux`, `Windows` | always | — |

**GPU 联动逻辑（前端伪代码）**：
```
if resourceSpec.gpu > 0:
    instanceType.options = filter(ecs.gn*)
    cpuArchitecture.value = "AMD64"; cpuArchitecture.disabled = true
    show gpuModelHint = gpuModelFromInstanceType(instanceType.value)
else:
    instanceType.options = all ECS types
    cpuArchitecture.disabled = false
```

---

### 3.2 竞价实例 (group: spot)

| # | key | type | default | validation | visibility | required |
|---|---|---|---|---|---|---|
| 4 | `spotStrategy` | enum | `NoSpot` | `NoSpot`, `SpotAsPriceGo`, `SpotWithPriceLimit` | always | — |
| 5 | `spotPriceLimit` | number | — | min: 0 | `{op:"eq", field:"spotStrategy", value:"SpotWithPriceLimit"}` | 同上（可见时必填） |
| 6 | `spotDuration` | number | — | — | `{op:"in", field:"spotStrategy", value:["SpotAsPriceGo","SpotWithPriceLimit"]}` | — |
| 7 | `strictSpot` | boolean | `false` | — | `{op:"neq", field:"spotStrategy", value:"NoSpot"}` | — |

---

### 3.3 网络 — EIP (group: network)

| # | key | type | default | validation | visibility | 互斥 |
|---|---|---|---|---|---|---|
| 8 | `autoCreateEip` | boolean | `false` | — | always | 与 `eipInstanceId` 互斥 |
| 9 | `eipBandwidth` | number | 5 | 1–100 | `{op:"eq", field:"autoCreateEip", value:true}` | — |
| 10 | `eipISP` | enum | `BGP` | `BGP`, `BGP_PRO` | `{op:"eq", field:"autoCreateEip", value:true}` | — |
| 11 | `eipInstanceId` | string | — | — | always | 与 `autoCreateEip` 互斥 |
| 12 | `eipCommonBandwidthPackage` | string | — | — | always | — |

**互斥规则**：`autoCreateEip=true` 隐藏 `eipInstanceId`；`eipInstanceId` 有值时隐藏 `autoCreateEip` + `eipBandwidth` + `eipISP`。

---

### 3.4 网络 — 带宽 & 固定 IP (group: network)

| # | key | type | default | validation | visibility |
|---|---|---|---|---|---|
| 13 | `ingressBandwidth` | number | — | — | always |
| 14 | `egressBandwidth` | number | — | — | always |
| 15 | `fixedIp` | string | — | — | always |
| 16 | `fixedIpRetainHour` | number | 48 | — | `{op:"eq", field:"fixedIp", value:"true"}` |
| 17 | `ipv6AddressCount` | number | — | — | always |

---

### 3.5 存储 & 镜像 (group: storage)

| # | key | type | default | validation | visibility |
|---|---|---|---|---|---|
| 18 | `autoMatchImageCache` | boolean | `false` | — | always |
| 19 | `imageSnapshotId` | string | — | — | always（与 `autoMatchImageCache` 无关，可单独指定缓存快照） |
| 20 | `ephemeralStorage` | number | — | — | always |
| 21 | `imageRegistryCredentials` | object | — | — | always（仅私有仓库时需要） |

---

### 3.6 调度 (group: schedule)

| # | key | type | default | validation | visibility |
|---|---|---|---|---|---|
| 22 | `scheduleStrategy` | enum | `VSwitchOrdered` | `VSwitchOrdered`, `VSwitchRandom` | `{op:"gt", field:"subnetIds.length", value:1}` |
| 23 | `cpuOptionsCore` | number | — | — | always（仅特定规格支持） |
| 24 | `cpuOptionsThreadsPerCore` | number | 2 | 1–2 | always |

---

### 3.7 系统 (group: system)

| # | key | type | default | validation | visibility |
|---|---|---|---|---|---|
| 25 | `hostName` | string | — | — | always |
| 26 | `dnsPolicy` | enum | `Default` | `Default`, `ClusterFirst`, `None` | always |
| 27 | `activeDeadlineSeconds` | number | — | — | always |
| 28 | `ramRoleName` | string | — | — | always |
| 29 | `resourceGroupId` | string | — | — | always |
| 30 | `corePattern` | string | — | — | always |

---

## 4. 依赖图 (Dependency Graph)

```
                    resourceSpec.gpu
                         │
              ┌──────────┼──────────┐
              v          v          v
        instanceType  cpuArch   osType
        (filter gn*)  (lock)    (lock Linux)
              │
              v
        gpuModelHint (后端只读，前端展示)

        spotStrategy ──────┬──────────────┐
              │            │              │
              v            v              v
        spotPriceLimit  spotDuration  strictSpot
        (only SPL)     (spot > NoSpot)

        autoCreateEip ──── eipBandwidth ─── eipISP
              │
              X (互斥)
              │
        eipInstanceId

        subnetIds.length > 1 ─── scheduleStrategy

        fixedIp == "true" ─── fixedIpRetainHour
```

---

## 5. 编辑器渲染伪代码

```
for each group in [gpu, spot, network, storage, schedule, system]:
    render section header with group.label
    for each field in group.fields:
        if not field.visibility.eval(currentState):
            continue  // skip hidden
        disabled = field.locked.eval(currentState)
        required = field.required.eval(currentState)
        switch field.type:
            case "boolean": render toggle(field, disabled)
            case "enum":    render select(field, values=field.validation.values, disabled)
            case "number":  render numberInput(field, min, max, disabled, required)
            case "string":  render textInput(field, disabled, required)
            case "object":  render jsonEditor(field, disabled)

    // GPU group: show derived model hint
    if group == "gpu" and currentState.resourceSpec.gpu > 0:
        render readonly hint: "GPU 型号: {gpuModelFromInstanceType(...)}"
```

---

## 6. 跨字段校验 (Cross-field Validation)

后端 `validateExtensionOverrides` 已实现单字段校验。以下为前端需额外实现的跨字段规则：

| 规则 | 触发条件 | 错误信息 |
|---|---|---|
| GPU 架构冲突 | `gpu > 0 && cpuArchitecture != "AMD64"` | "GPU 实例仅支持 AMD64 架构" |
| Spot 价格缺失 | `spotStrategy == "SpotWithPriceLimit" && !spotPriceLimit` | "竞价上限模式下必须设置 spotPriceLimit" |
| EIP 冲突 | `autoCreateEip && eipInstanceId` | "自动创建 EIP 与绑定已有 EIP 不能同时设置" |
| 实例类型架构冲突 | `instanceType.startsWith("ecs.g") && cpuArchitecture == "Arm64"` | "所选实例类型不支持 ARM 架构" |

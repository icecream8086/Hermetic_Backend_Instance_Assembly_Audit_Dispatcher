# 形式化验证参考目录

> 页码 = 章节编号。每个条目：页码 + 一句话摘要。

---

## 形式化模型 (14)

**001** — `ECI_LIFECYCLE_FORMAL_MODEL.md`
ECI 容器组 11 态生命周期。TLA⁺ 规约：δ(s,op) 18 条转移 + 5 Safety + 5 Liveness + Mermaid 状态机图。RestartPolicy/Force 删除参数形式化。

**002** — `ECI_LIFECYCLE_TRUTH_TABLE.md`
ECI 完整 Status × Operation 真值矩阵 (11×17)。API 前置/后置条件、系统驱动转移、RestartPolicy×ExitCode 真值表、可达性闭包、幂等性保证。

**003** — `GITHUB_ACTIONS_LIFECYCLE_FORMAL_MODEL.md`
GitHub Actions WorkflowRun 6+1 态生命周期。TLA⁺ 规约：status + conclusion 双层模型，Run→Job→Step 三层资源蕴含。对比 ECI：软终态(completed)可 rerun，硬终态(deleted)不可逆。

**004** — `GITHUB_ACTIONS_LIFECYCLE_TRUTH_TABLE.md`
GHA 完整 Status × Operation 真值矩阵 (8×12)。CancelRun 合法性、Rerun×RerunFailed 条件、Conclusion 聚合规则 (Run←Jobs←Steps)、GitHub×ECI 对比。

**005** — `GITHUB_RUNNER_MODEL.md`
GitHub Runner 3 态 (online/offline/deleted) + busy 标志。不变量 busy⇒online。Registration Token 1h TTL。Runner Groups 可见性模型。映射：实例心跳/health-check。

**006** — `GITHUB_SECRET_MODEL.md`
GitHub Secret 2 态 (exists/deleted)。NaCl SealedBox 公钥密封加密。Org/Repo 二级可见性作用域 (all/private/selected)。不变量：加密不可逆、Name 唯一性、公钥独立于 secret 生命周期。

**007** — `GITHUB_ARTIFACT_MODEL.md`
GitHub Artifact 3 态 (exists/expired/deleted)。TTL 驱动过期 (默认 90 天)。不变量：expired⇒Download=410、deleted⇒Get=404。映射：Blob 按 SandboxId 索引。

**008** — `GITHUB_CACHE_MODEL.md`
GitHub Cache 3 态 (exists/evicted/deleted)。LRU 驱逐 (10GB 上限) + 7 天未访问自动删。version 递增 (同 key 多版本共存)。key+ref 复合索引。

**009** — `RHEL_PERMISSION_FORMAL_MODEL.md`
RHEL 9.8 六层安全检查栈：Namespace→Seccomp→Capability→SELinux→DAC→审计。DAC: UID/GID+rwx 12bits+ACL。Capability: P/E/I/B/A 5 集合。sudo: who/where/as_whom/what 4 元组。User Namespace: UID 映射。TLA⁺ 规约。

**010** — `SELINUX_FORMAL_MODEL.md`
SELinux MAC 形式化。Type Enforcement (TE) 核心公式：`allow s t:c {p}`。MLS/MCS (Bell-LaPadula: No Read Up, No Write Down)。AVC 缓存。三种模式 (Enforcing/Permissive/Disabled)。Boolean 运行时开关。TLA⁺ 规约含 BLP 不变量。

**011** — `DMESG_JOURNALD_FORMAL_MODEL.md`
Linux 日志系统全链路：printk→ring buffer→/dev/kmsg→journald。Priority=F×8+L 单字段编码。字段信任模型 (`_`=可信，大写=不可信)。6 维游标 (s,i,b,m,t,x)。速率限制 burst+interval。日志轮换三参数。

**012** — `DAC_LOGGING_VERIFICATION.md`
DAC×日志协作形式化验证。三层门控 (DAC→Capability→SELinux) 在拒绝点产生 audit 记录，type 区分拒绝层 (SYSCALL/CAPABILITIES/AVC)。不变量：拒绝必有记录、journal 文件仅 root+systemd-journal 组可读。TLA⁺ 规约。

**013** — `K8S_POD_LIFECYCLE_MODEL.md`
K8s Pod 三层嵌套状态：Phase (5)×Conditions (4+)×Container (3)。三种容器类型 (Init/Sidecar/App) 启动/终止顺序。三种探针 (liveness/readiness/startup)。指数退避重启。per-container restartPolicyRules。

**014** — `SYSTEMD_UNIT_MODEL.md`
systemd Unit 双层状态：ActiveState (5) + SubState (数十)。6 种 Service Type。6 种依赖关系 (Wants/Requires/Requisite/BindsTo/PartOf/Conflicts) + 顺序 (After/Before)。Restart= 7 策略×5 退出条件转移矩阵。INVOCATION_ID 审计链。

**015** — `IPTABLES_CHAIN_MODEL.md`
iptables 4 表×5 链架构。First-Match Wins 语义。自定义链子程序调用。conntrack 5 态。nftables 改进 (原子事务、verdict map)。形式化：Match→Eval→Traverse 三层函数，DROP 不可达后续表不变量。

**016** — `AIRFLOW_ARCHITECTURE_MODEL.md`
Airflow 调度器完整模型。Kahn 拓扑排序。13 态 TaskInstance 状态机。调度器主循环 4 阶段。临界区 5 步过滤管线 (Pool→DAG→Task→DagRun→Executor)。ConcurrencyMap O(1) 并发索引。Pool 信号量。9 种 TriggerRule。TLA⁺ 规约。

**017** — `CONTAINER_GROUP_LIFECYCLE_TRUTH_TABLE.md`
本项目 ContainerGroup 全生命周期验证真值表。11 态+6 条 GC 路径决策树。Producer-Consumer 数据完整性矩阵 (28 场景)。API 合法前置状态全矩阵。共享资源生命周期。8 Safety + 4 Liveness。

---

## 对比分析 (1)

**018** — `ECI_VS_K8S_POD_COMPARISON.md`
ECI×K8s Pod 完整对比。概念映射 (1:1+ECI独有+K8s独有)、状态粒度 (11 vs 5)、状态投影函数 π: S₁₁→P₅。API/网络/安全/存储/计费五维对比。结论：ECI 是 K8s 的精化 (refinement)。

---

## 静态分析设计 (1)

**019** — `CEA_STATIC_ANALYSIS_DESIGN.md`
三层分析路线图：ESLint TypeChecker (no-unknown-leak/no-handwritten-guard/enforce-decode-layer, ~300 行) → Semgrep taint (过程间) → CodeQL CFG/DFG (全项目类型污染)。ESLint/Semgrep/CodeQL 能力边界对比图。

---

## 扩展字段形式化 (1)

**020** — `ECI_EXTENSION_AST.md`
ECI 扩展字段 AST 规则表。30 个字段节点的 visibility/required/locked 条件表达式。依赖图 (GPU→InstanceType→cpuArch, Spot→PriceLimit/Duration, EIP 互斥)。跨字段校验规则。面向前端动态表单引擎。

---

## 工程规格 (3)

**021** — `container_dep_spec.txt`
Template 容器依赖规格。SandboxTemplate 结构总览、singleton/instanceLimit 互斥锁、DAG 继承规则 (合并字段 vs 不合并字段)、虚拟网段系统、Seed 模板、apply 数据流向。

**022** — `preview_container_gp_dep_spec.md`
ContainerGroup 未来设计预览 (v1-proposal)。与 Container 的对比矩阵 (kind 判别)。多服务编排 (services{})、sharedNamespaces、per-service healthChecks/storage/dependsOn/replicas。

**023** — `key-loading-podspec.md`
容器内密钥处理规范。Podman secret (/run/secrets) / ECI FlexVolume (/etc/secret) / Stub 三种挂载路径。读取即清除、环境变量约束、多容器隔离、安全边界四阶段缓解。

---

## 存储/密钥/策略 (2)

**024** — `s3-auto-key-provision.md`
S3 存储桶自动密钥对生成/注入/回收/轮转设计。BucketKeyBinding 记录。签发流程 (provision)、回收流程 (delete)、轮转 (24h)。applicator 修复：TemplateStorage.bucketId 死代码激活。

**025** — `s3-policy-manager.md`
S3 策略管理器。S3Policy 实体 (effect/actions/pathPrefix/priority)。S3PolicyManager (CRUD+resolve)。Policy→MinIO IAM/OSS RAM 翻译。与 autoGenerateKeys 流程集成。低耦合设计：handler 层做权限检查。

---

## 重构计划 (2)

**026** — `REFACTOR_PLAN.md`
权限×日志×审计 6 阶段重构计划。Phase 0/0a/0b: 基础设施 (合并 audit+logger、删 LogLevel、Capability 位域)。Phase 1-6: Facility 数字化→可信字段分离→游标实现→三层门控→中间件注册表→MESSAGE_ID+速率限制。最终架构图 (中间件链+三层门控+审计日志全链路)。

**027** — `ECI_CODEC_REFACTOR_PLAN.md`
ECI 字段映射重构。5 层手工映射→单一声明式双向 Codec 表。编译期强制 encode+decode 配对。实际效果：删 ~300 行 (eci-container.ts 528→227)，新增 833 行 codec，TypeScript 编译器强制新字段补全。

---

## 元数据 (3)

**028** — `TODO.md`
重构计划进度跟踪。Phase 0-6 基础设施+6 大模块 (容器/调度器/权限/日志/组件/参考模型) 的已完成/待办事项清单。

**029** — `README.md`
SPEC 索引。API (12)、Data Model (3)、Core System (9)、Providers (5)、Existing (4) 分类。

**030** — `STORAGE_BACKENDS.md`
三层存储替换方案：IAtomicStore (TiKV/FoundationDB/better-sqlite3/Redis/etcd)、IQueryStore (SQLite/PostgreSQL)、IBlobStore (S3/MinIO)。

---

## 页码速查

```
001-017  形式化模型 (含真值表)
018      对比分析
019      静态分析设计
020      扩展字段 AST
021-023  工程规格
024-025  存储/密钥/策略
026-027  重构计划
028-030  元数据
```

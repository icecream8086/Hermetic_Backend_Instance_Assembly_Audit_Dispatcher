# SPEC Index

| Category | Doc | Description |
|----------|-----|-------------|
| **API** | | |
| | [Users](api/users.md) | Register, login, CRUD, sessions, avatar, public keys |
| | [Sandbox](api/sandbox.md) | Sandbox CRUD, state machine, health |
| | [Permission](api/permission.md) | Policies, groups, route ACLs, check |
| | [Topology](api/topology.md) | Compute instances, buckets, credentials, image repositories |
| | [Platforms](api/platforms.md) | Available provider platforms |
| | [Info](api/info.md) | Server info and runtime status |
| | [DNS](api/dns.md) | DNS record management |
| | [Audit](api/audit.md) | Audit log query and stats |
| | [Events & Dev](api/events.md) | Event loop, dev endpoints |
| | [WebSocket](api/websocket.md) | Real-time notification channel |
| | [OCI Runtime](api/oci-runtime.md) | Low-level container lifecycle |
| **Data Model** | | |
| | [User](data-model/user.md) | User, Session, LoginPolicy, LoginInfo |
| | [Sandbox](data-model/sandbox.md) | Sandbox entity, state machine, containers |
| | [Permission](data-model/permission.md) | Policy, PermGroup, UserGroup, RouteACL |
| **Core System** | | |
| | [Storage](core/storage.md) | 3-tier: IAtomicStore, IQueryStore, IBlobStore |
| | [Event Bus](core/event-bus.md) | Process pub/sub + event loop |
| | [Auth](core/auth.md) | IAuthProvider, credential types |
| | [Provider](core/provider.md) | Provider interface layer (container/image/dns/metrics/s3) |
| | [Middleware](core/middleware.md) | AuthZ, AuthN, rate limit, error handler |
| | [DAG](core/dag.md) | Generic DAG with Kahn topological sort |
| | [Scheduler](core/scheduler.md) | Pluggable timer backend |
| | [Region](core/region.md) | Region type system and registry |
| | [Health Check](core/health-check.md) | Event-driven auto-recovery |
| **Providers** | | |
| | [Podman](providers/podman.md) | Local container runtime |
| | [Alibaba](providers/alibaba.md) | Alibaba Cloud ECI/OSS |
| | [Cloudflare](providers/cloudflare.md) | DNS + R2 storage |
| | [S3](providers/s3.md) | AWS S3 SigV4 |
| | [Stub](providers/stub.md) | Local dev simulation |
| **Existing** | | |
| | [Template Spec](template/spec.md) | Template data model + DAG inheritance |
| | [Container Dep](container_dep_spec.txt) | Container dependency and limit system |
| | [Network API](network/api.md) | Virtual network API |
| | [ContainerGroup Preview](preview_container_gp_dep_spec.md) | Future ContainerGroup design |
| **Security** | | |
| | [S3 Presigned Control Plane](s3-presigned-control-plane.md) | Worker control-plane JWT + on-demand presigned URL (v3, current) |
| | [Storage Sync API](storage-sync-api.md) | Client-facing upload-sync REST API over S3 (v1) |
| | [Platform Secret Provisioner](platform-secret-provisioner.md) | Cross-platform native secret injection via ContainerSecret (v1) |
| | [Security Resource Presigned](security-resource-presigned-spec.md) | v2 presigned URL injection (deprecated) |
| | [S3 Auto Key Provision](s3-auto-key-provision.md) | v1 AK/SK key pair (deprecated) |
| | [S3 Policy Manager](s3-policy-manager.md) | v1 MinIO IAM policy (deprecated) |

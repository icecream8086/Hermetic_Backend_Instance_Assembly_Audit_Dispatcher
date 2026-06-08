# PodSpec: 容器内密钥处理规范

## 1. 密钥形态

容器启动后，密钥以**文件**形式存在，**不是环境变量**。挂载点由 provider 决定：

| 类型 | 挂载路径 | 文件系统 | 持久化 |
|------|---------|----------|--------|
| Podman secret | `/run/secrets/{name}` | tmpfs（内存） | 容器删除即消失 |
| ECI FlexVolume | `/etc/secret/{name}` | 内存盘 | 实例释放即消失 |
| Stub | `/tmp/stub-secrets/{name}` | 临时文件 | 进程退出即消失 |

## 2. 应用读取规范

### 2.1 路径约定

应用**不应硬编码**密钥路径，通过环境变量 `SECRET_DIR` 或命令行参数获取：

```
SECRET_DIR=/run/secrets  # podman 默认
# 或
SECRET_DIR=/etc/secret   # alibaba eci 默认
```

应用从 `$SECRET_DIR/{secret_name}` 读取文件内容。

### 2.2 读取即清除

应用读取密钥后**应立即从文件系统中删除**，缩小暴露窗口：

```bash
#!/bin/sh
set -e

# 1. 读取密钥到变量
DB_PASS=$(cat "$SECRET_DIR/db-password")

# 2. 立即删除文件（tmpfs，不可恢复）
rm -f "$SECRET_DIR/db-password"

# 3. 启动应用，从环境变量或内存取用
export DB_PASSWORD="$DB_PASS"
exec node app.js
```

避免写入应用日志、stdout、监控采集路径。

### 2.3 启动后清除所有密钥

如果容器被注入了多个密钥，入口脚本应在首次初始化后**遍历清除**：

```bash
for f in "$SECRET_DIR"/*; do
  [ -f "$f" ] && rm -f "$f"
done
```

## 3. 环境变量的约束

- ConfigMap（非敏感配置）走 `env`，直接暴露在容器环境中
- Secret **不允许**映射为环境变量
- 入口脚本可将密钥从文件读入环境变量供子进程使用（如上例），但必须确保 `exec` 替代 shell，防止 `ps` 泄漏

## 4. 多容器共享

同一 Pod 内的多个容器不共享密钥。每个容器独立挂载自己的 secret mount。应用不应假设同一 Pod 的其他容器可读取自己的密钥目录。

## 5. 安全边界总结

| 阶段 | 风险 | 缓解措施 |
|------|------|---------|
| 运行时文件存在 | 被同容器其他进程读取 | `chmod 600`，`rm -f` 读取后删除 |
| 进程内存 | 被 coredump 捕获 | 关闭核心转储 `ulimit -c 0` |
| 子进程继承 | 通过环境变量泄漏 | 仅用 `exec` 启动主进程，不 export 到 shell 全局 |
| 日志采集 | 意外打印 | 应用层禁止日志输出密钥内容 |

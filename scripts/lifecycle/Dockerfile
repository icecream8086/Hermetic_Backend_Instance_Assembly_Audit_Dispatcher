# ocibox — 容器生命周期验证镜像
# 基于 busybox，自带 nc，加 producer/consumer 脚本
# 构建: docker build -f scripts/lifecycle/Dockerfile -t ocibox:v1 .
# 推送: docker tag ocibox:v1 registry-vpc.cn-hangzhou.aliyuncs.com/minecraft-graalvm/ocibox:v1
#        docker push registry-vpc.cn-hangzhou.aliyuncs.com/minecraft-graalvm/ocibox:v1

FROM busybox:latest

LABEL maintainer="hbi-aad"
LABEL description="Container lifecycle validation image — producer/consumer scripts with nc"

# 安装脚本
COPY scripts/lifecycle/producer.sh /usr/local/bin/producer
COPY scripts/lifecycle/consumer.sh /usr/local/bin/consumer
RUN chmod +x /usr/local/bin/producer /usr/local/bin/consumer

# 验证
RUN which nc && which sh && /usr/local/bin/producer --help 2>/dev/null; exit 0

CMD ["sh"]

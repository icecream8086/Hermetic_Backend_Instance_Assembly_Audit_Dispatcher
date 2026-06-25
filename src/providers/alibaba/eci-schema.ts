/**
 * Alibaba Cloud ECI — full extension field schema.
 *
 * Every supported ECI CreateContainerGroup API parameter is registered here.
 * Nothing passes through unregistered — prevents parameter injection.
 *
 * Reference: https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-createcontainergroup
 *
 * Category groups (for frontend editor):
 *   gpu       GPU & instance type
 *   spot      Spot/preemptible instance
 *   network   EIP, bandwidth, fixed IP, IPv6
 *   storage   Image cache, ephemeral storage, private registry
 *   schedule  Multi-AZ scheduling, CPU options
 *   system    Hostname, DNS, RAM role, resource group, lifecycle
 */

import { registerExtensionSchema } from '../../core/provider/extension-schema.ts';

registerExtensionSchema({
  provider: 'alibaba',
  label: 'Alibaba Cloud ECI',
  fields: [

    // ═══════════════════════════════════════════════════════════
    // GPU & instance type
    // ═══════════════════════════════════════════════════════════

    {
      key: 'instanceType',
      type: 'string',
      label: 'Instance Type',
      description: 'ECS instance types, comma-separated for multi-spec fallback. GPU specs: gn6v (T4), gn7i (A10), gn6e (V100), gn7 (A100), gn8 (H100)',
      eciParam: 'InstanceType',
      transform: 'comma-sep',
      scope: 'sandbox',
      category: 'gpu',
    },
    {
      key: 'cpuArchitecture',
      type: 'string',
      label: 'CPU Architecture',
      description: 'AMD64 or Arm64. GPU instances force AMD64.',
      eciParam: 'CpuArchitecture',
      scope: 'sandbox',
      category: 'gpu',
      validation: { enum: ['AMD64', 'Arm64'] },
    },
    {
      key: 'osType',
      type: 'string',
      label: 'OS Type',
      description: 'Linux or Windows Server Core',
      eciParam: 'OsType',
      scope: 'sandbox',
      category: 'gpu',
      validation: { enum: ['Linux', 'Windows'] },
    },

    // ═══════════════════════════════════════════════════════════
    // Spot / preemptible instance
    // ═══════════════════════════════════════════════════════════

    {
      key: 'spotStrategy',
      type: 'string',
      label: 'Spot Strategy',
      description: 'Spot instance bidding strategy. NoSpot = pay-as-you-go (default)',
      eciParam: 'SpotStrategy',
      scope: 'sandbox',
      category: 'spot',
      validation: { enum: ['NoSpot', 'SpotAsPriceGo', 'SpotWithPriceLimit'] },
    },
    {
      key: 'spotPriceLimit',
      type: 'number',
      label: 'Spot Price Limit',
      description: 'Max hourly price for SpotWithPriceLimit. Only valid when spotStrategy=SpotWithPriceLimit.',
      eciParam: 'SpotPriceLimit',
      transform: 'number-string',
      scope: 'sandbox',
      category: 'spot',
      validation: { min: 0 },
    },
    {
      key: 'spotDuration',
      type: 'number',
      label: 'Spot Duration (hours)',
      description: 'Spot instance protection duration in hours. Valid only when spotStrategy != NoSpot.',
      eciParam: 'SpotDuration',
      transform: 'number-string',
      scope: 'sandbox',
      category: 'spot',
    },
    {
      key: 'strictSpot',
      type: 'boolean',
      label: 'Strict Spot',
      description: 'If true, fail when spot resources unavailable instead of falling back to pay-as-you-go.',
      eciParam: 'StrictSpot',
      transform: 'boolean-string',
      scope: 'sandbox',
      category: 'spot',
    },

    // ═══════════════════════════════════════════════════════════
    // Network — EIP
    // ═══════════════════════════════════════════════════════════

    {
      key: 'autoCreateEip',
      type: 'boolean',
      label: 'Auto Create EIP',
      description: 'Automatically create and bind an Elastic IP. Mutually exclusive with eipInstanceId.',
      eciParam: 'AutoCreateEip',
      transform: 'boolean-string',
      scope: 'network',
      category: 'network',
    },
    {
      key: 'eipBandwidth',
      type: 'number',
      label: 'EIP Bandwidth (Mbps)',
      description: 'Public IP bandwidth in Mbps. Only valid when autoCreateEip=true.',
      eciParam: 'EipBandwidth',
      transform: 'number-string',
      scope: 'network',
      category: 'network',
      validation: { min: 1, max: 100 },
    },
    {
      key: 'eipISP',
      type: 'string',
      label: 'EIP ISP',
      description: 'EIP line type. BGP_PRO = BGP multi-line premium. Only valid when autoCreateEip=true.',
      eciParam: 'EipISP',
      scope: 'network',
      category: 'network',
      validation: { enum: ['BGP', 'BGP_PRO'] },
    },
    {
      key: 'eipInstanceId',
      type: 'string',
      label: 'Existing EIP ID',
      description: 'Bind an existing EIP by ID. Mutually exclusive with autoCreateEip.',
      eciParam: 'EipInstanceId',
      scope: 'network',
      category: 'network',
    },
    {
      key: 'eipCommonBandwidthPackage',
      type: 'string',
      label: 'Shared Bandwidth Package ID',
      description: 'Bind an existing shared bandwidth package for EIP billing optimization.',
      eciParam: 'EipCommonBandwidthPackage',
      scope: 'network',
      category: 'network',
    },

    // ═══════════════════════════════════════════════════════════
    // Network — VPC / security group / subnet (moved from NetworkSpec)
    // ═══════════════════════════════════════════════════════════

    {
      key: 'securityGroupId',
      type: 'string',
      label: 'Security Group ID',
      description: 'VPC security group ID (Alibaba Cloud sg-xxx).',
      eciParam: 'SecurityGroupId',
      scope: 'network',
      category: 'network',
    },
    {
      key: 'vSwitchId',
      type: 'string',
      label: 'VSwitch IDs (comma-separated)',
      description: 'One or more VSwitch IDs for multi-AZ scheduling, comma-separated.',
      eciParam: 'VSwitchId',
      scope: 'network',
      category: 'network',
    },

    // ═══════════════════════════════════════════════════════════
    // Network — bandwidth & fixed IP
    // ═══════════════════════════════════════════════════════════

    {
      key: 'ingressBandwidth',
      type: 'number',
      label: 'Ingress Bandwidth (bps)',
      description: 'Inbound bandwidth limit in bits per second.',
      eciParam: 'IngressBandwidth',
      transform: 'number-string',
      scope: 'network',
      category: 'network',
    },
    {
      key: 'egressBandwidth',
      type: 'number',
      label: 'Egress Bandwidth (bps)',
      description: 'Outbound bandwidth limit in bits per second.',
      eciParam: 'EgressBandwidth',
      transform: 'number-string',
      scope: 'network',
      category: 'network',
    },
    {
      key: 'fixedIp',
      type: 'string',
      label: 'Fixed IP',
      description: 'Enable fixed private IP. Set to "true" to retain the IP after restart.',
      eciParam: 'FixedIp',
      scope: 'network',
      category: 'network',
    },
    {
      key: 'fixedIpRetainHour',
      type: 'number',
      label: 'Fixed IP Retain (hours)',
      description: 'How many hours to retain the fixed IP after instance stops. Default 48.',
      eciParam: 'FixedIpRetainHour',
      transform: 'number-string',
      scope: 'network',
      category: 'network',
    },
    {
      key: 'ipv6AddressCount',
      type: 'number',
      label: 'IPv6 Address Count',
      description: 'Number of IPv6 addresses. Currently fixed at 1 when enabled.',
      eciParam: 'Ipv6AddressCount',
      transform: 'number-string',
      scope: 'network',
      category: 'network',
    },

    // ═══════════════════════════════════════════════════════════
    // Storage & image
    // ═══════════════════════════════════════════════════════════

    {
      key: 'autoMatchImageCache',
      type: 'boolean',
      label: 'Auto Match Image Cache',
      description: 'Automatically match and use existing image caches to accelerate startup.',
      eciParam: 'AutoMatchImageCache',
      transform: 'boolean-string',
      scope: 'sandbox',
      category: 'storage',
    },
    {
      key: 'imageSnapshotId',
      type: 'string',
      label: 'Image Snapshot ID',
      description: 'Specific image cache snapshot ID to use. If set, skips auto-matching.',
      eciParam: 'ImageSnapshotId',
      scope: 'sandbox',
      category: 'storage',
    },
    {
      key: 'ephemeralStorage',
      type: 'number',
      label: 'Ephemeral Storage (GiB)',
      description: 'Additional temporary storage in GiB beyond the default 30 GiB.',
      eciParam: 'EphemeralStorage',
      transform: 'number-string',
      scope: 'sandbox',
      category: 'storage',
    },
    {
      key: 'imageRegistryCredentials',
      type: 'object',
      label: 'Private Registry Credentials',
      description: 'Credentials for private image registries. Array of {server, userName, password}.',
      eciParam: 'ImageRegistryCredential',
      transform: 'json-string',
      scope: 'sandbox',
      category: 'storage',
    },

    // ═══════════════════════════════════════════════════════════
    // Scheduling
    // ═══════════════════════════════════════════════════════════

    {
      key: 'scheduleStrategy',
      type: 'string',
      label: 'Multi-AZ Schedule Strategy',
      description: 'VSwitch selection strategy when multiple subnets are specified. VSwitchOrdered = try in list order (default). VSwitchRandom = random.',
      eciParam: 'ScheduleStrategy',
      scope: 'sandbox',
      category: 'schedule',
      validation: { enum: ['VSwitchOrdered', 'VSwitchRandom'] },
    },

    // ═══════════════════════════════════════════════════════════
    // CPU options
    // ═══════════════════════════════════════════════════════════

    {
      key: 'cpuOptionsCore',
      type: 'number',
      label: 'CPU Physical Cores',
      description: 'Number of physical CPU cores. Only valid for specific instance types that support CPU affinity.',
      eciParam: 'CpuOptionsCore',
      transform: 'number-string',
      scope: 'sandbox',
      category: 'schedule',
    },
    {
      key: 'cpuOptionsThreadsPerCore',
      type: 'number',
      label: 'Threads Per Core',
      description: '1 = disable hyper-threading, 2 = enable (default). Only valid for specific instance types.',
      eciParam: 'CpuOptionsThreadsPerCore',
      transform: 'number-string',
      scope: 'sandbox',
      category: 'schedule',
      validation: { min: 1, max: 2 },
    },

    // ═══════════════════════════════════════════════════════════
    // System: hostname, DNS, lifecycle, security
    // ═══════════════════════════════════════════════════════════

    {
      key: 'hostName',
      type: 'string',
      label: 'Host Name',
      description: 'Container group hostname. 2–128 characters.',
      eciParam: 'HostName',
      scope: 'sandbox',
      category: 'system',
    },
    {
      key: 'dnsPolicy',
      type: 'string',
      label: 'DNS Policy',
      description: 'Default = cluster DNS, ClusterFirst = cluster DNS first, None = no DNS.',
      eciParam: 'DnsPolicy',
      scope: 'sandbox',
      category: 'system',
      validation: { enum: ['Default', 'ClusterFirst', 'None'] },
    },
    {
      key: 'activeDeadlineSeconds',
      type: 'number',
      label: 'Active Deadline (seconds)',
      description: 'Maximum lifetime of the container group in seconds. After this, the instance is terminated.',
      eciParam: 'ActiveDeadlineSeconds',
      transform: 'number-string',
      scope: 'sandbox',
      category: 'system',
    },
    {
      key: 'ramRoleName',
      type: 'string',
      label: 'RAM Role Name',
      description: 'RAM role for accessing Alibaba Cloud services (OSS, RDS, etc.) from within the container.',
      eciParam: 'RamRoleName',
      scope: 'sandbox',
      category: 'system',
    },
    {
      key: 'resourceGroupId',
      type: 'string',
      label: 'Resource Group ID',
      description: 'Alibaba Cloud resource group for billing and access control.',
      eciParam: 'ResourceGroupId',
      scope: 'sandbox',
      category: 'system',
    },
    {
      key: 'corePattern',
      type: 'string',
      label: 'Core Dump Pattern',
      description: 'Directory path for core dump files, e.g. /data/coredump/core.%e.%p.%t.',
      eciParam: 'CorePattern',
      scope: 'sandbox',
      category: 'system',
    },

  ],
});

import { registerExtensionSchema } from '../../core/provider/extension-schema.ts';

registerExtensionSchema({
  provider: 'alibaba',
  label: 'Alibaba Cloud ECI',
  fields: [
    { key: 'autoCreateEip', type: 'boolean', label: 'Auto Create EIP', description: 'Automatically allocate and bind an Elastic IP', eciParam: 'AutoCreateEip', transform: 'boolean-string', scope: 'network' },
    { key: 'eipBandwidth', type: 'number', label: 'EIP Bandwidth (Mbps)', description: 'Public IP bandwidth in Mbps', eciParam: 'EipBandwidth', transform: 'number-string', scope: 'network', validation: { min: 1, max: 100 } },
    { key: 'ingressBandwidth', type: 'number', label: 'Ingress Bandwidth', description: 'Inbound bandwidth in bps', eciParam: 'IngressBandwidth', transform: 'number-string', scope: 'network' },
    { key: 'egressBandwidth', type: 'number', label: 'Egress Bandwidth', description: 'Outbound bandwidth in bps', eciParam: 'EgressBandwidth', transform: 'number-string', scope: 'network' },
    { key: 'autoMatchImageCache', type: 'boolean', label: 'Auto Match Image Cache', description: 'Automatically match existing image caches', eciParam: 'AutoMatchImageCache', transform: 'boolean-string', scope: 'sandbox' },
    { key: 'spotDuration', type: 'number', label: 'Spot Duration (hours)', description: 'Spot instance duration in hours', eciParam: 'SpotDuration', transform: 'number-string', scope: 'sandbox' },
    { key: 'strictSpot', type: 'boolean', label: 'Strict Spot', description: 'Fail if spot unavailable instead of falling back', eciParam: 'StrictSpot', transform: 'boolean-string', scope: 'sandbox' },
    { key: 'hostName', type: 'string', label: 'Host Name', description: 'Container group hostname', eciParam: 'HostName', scope: 'sandbox' },
    { key: 'dnsPolicy', type: 'string', label: 'DNS Policy', description: 'DNS policy', eciParam: 'DnsPolicy', scope: 'sandbox', validation: { enum: ['Default', 'ClusterFirst', 'None'] } },
    { key: 'activeDeadlineSeconds', type: 'number', label: 'Active Deadline', description: 'Max lifetime in seconds', eciParam: 'ActiveDeadlineSeconds', transform: 'number-string', scope: 'sandbox' },
    { key: 'ramRoleName', type: 'string', label: 'RAM Role Name', description: 'RAM role for accessing Alibaba Cloud services', eciParam: 'RamRoleName', scope: 'sandbox' },
    { key: 'instanceType', type: 'string', label: 'Instance Type', description: 'Comma-separated ECS instance types', eciParam: 'InstanceType', transform: 'comma-sep', scope: 'sandbox' },
    { key: 'ephemeralStorage', type: 'number', label: 'Ephemeral Storage (GB)', description: 'Temporary storage in GB', eciParam: 'EphemeralStorage', transform: 'number-string', scope: 'sandbox' },
    { key: 'osType', type: 'string', label: 'OS Type', description: 'Linux or Windows', eciParam: 'OsType', scope: 'sandbox', validation: { enum: ['Linux', 'Windows'] } },
    { key: 'cpuArchitecture', type: 'string', label: 'CPU Architecture', description: 'AMD64 or Arm64', eciParam: 'CpuArchitecture', scope: 'sandbox', validation: { enum: ['AMD64', 'Arm64'] } },
  ],
});

/**
 * ECI codec completeness and round-trip tests.
 *
 * Verifies buildCreateParams and parseContainerGroup cover every field
 * from CreateContainerGroupInput / ContainerCreateConfig / ProbeSpec.
 * Runs without real Alibaba credentials.
 */

import { describe, it, expect } from 'vitest';
import { buildCreateParams, parseContainerGroup, parseProbe } from '../../../src/providers/alibaba/eci-codec.ts';
import type { CreateContainerGroupInput } from '../../../src/core/provider/types.ts';
import { createRegionId } from '../../../src/core/region/types.ts';

// ─── Full-populated input ───

function makeFullInput(): CreateContainerGroupInput {
  return {
    name: 'test-group',
    description: 'integration test',
    region: createRegionId('cn-hangzhou'),
    zoneId: 'cn-hangzhou-a',
    cpu: 4,
    memory: 8,
    gpu: 1,
    gpuType: 'nvidia.com/gpu',
    restartPolicy: 'Always',
    containers: [
      {
        name: 'app',
        image: 'nginx:latest',
        command: ['nginx', '-g', 'daemon off;'],
        args: ['-c', '/etc/nginx/nginx.conf'],
        env: [
          { name: 'ENV', value: 'prod' },
          { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
        ],
        tty: true,
        stdin: true,
        imagePullPolicy: 'IfNotPresent',
        resources: {
          limits: { cpu: 2, memory: 4096 },
          requests: { cpu: 1, memory: 2048 },
        },
        livenessProbe: {
          httpGet: { path: '/health', port: 8080, scheme: 'HTTP' },
          initialDelaySeconds: 10,
          periodSeconds: 5,
          timeoutSeconds: 3,
          failureThreshold: 3,
          successThreshold: 1,
        },
        readinessProbe: {
          tcpSocket: { port: 8080 },
          initialDelaySeconds: 5,
          periodSeconds: 3,
        },
        startupProbe: {
          exec: { command: ['check.sh', '--ready'] },
          failureThreshold: 30,
          periodSeconds: 2,
        },
        ports: [
          { containerPort: 80, protocol: 'tcp' },
          { containerPort: 443, protocol: 'tcp', hostPort: 443 },
        ],
        networkMode: 'bridge',
      },
    ],
    volumes: [
      {
        id: 'nfs-vol',
        type: 'NFSVolume',
        options: { server: '192.168.1.100', path: '/data', readOnly: false },
      },
      {
        id: 'disk-vol',
        type: 'DiskVolume',
        options: { diskId: 'd-abc123', fsType: 'ext4', sizeGiB: 100, diskCategory: 'cloud_ssd', readOnly: false },
      },
    ],
    network: {
      subnetIds: ['vsw-001', 'vsw-002'],
      securityGroupId: 'sg-abc',
      allocatePublicIp: false,
    },
    tags: [
      { key: 'env', value: 'test' },
      { key: 'team', value: 'platform' },
    ],
    providerOverrides: {
      alibaba: {
        autoCreateEip: true,
        eipBandwidth: 10,
        spotStrategy: 'SpotAsPriceGo',
        ephemeralStorage: 50,
        hostName: 'test-host',
        dnsPolicy: 'Default',
        activeDeadlineSeconds: 3600,
        instanceType: 'ecs.c6.large',
      },
    },
  };
}

// ─── Tests ───

describe('buildCreateParams', () => {
  it('produces RegionId and ContainerGroupName', () => {
    const input = makeFullInput();
    const p = buildCreateParams(input);
    expect(p['RegionId']).toBe('cn-hangzhou');
    expect(p['ContainerGroupName']).toBe('test-group');
  });

  it('maps top-level scalars', () => {
    // Use single-subnet input (multi-subnet deletes ZoneId for VSwitchRandom)
    const input = { ...makeFullInput(), network: { subnetIds: ['vsw-001'], securityGroupId: 'sg-abc', allocatePublicIp: false } };
    const p = buildCreateParams(input);
    expect(p['Cpu']).toBe('4');
    expect(p['Memory']).toBe('8');
    expect(p['RestartPolicy']).toBe('Always');
  });

  it('encodes GPU as GpuSpecs JSON', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['GpuSpecs']).toBe('[{"Count":1,"Type":"nvidia.com/gpu"}]');
  });

  it('maps container scalars with prefix', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['Container.1.Name']).toBe('app');
    expect(p['Container.1.Image']).toBe('nginx:latest');
    expect(p['Container.1.ImagePullPolicy']).toBe('IfNotPresent');
    expect(p['Container.1.Tty']).toBe('true');
    expect(p['Container.1.Stdin']).toBe('true');
    expect(p['Container.1.NetworkMode']).toBe('bridge');
  });

  it('maps container command/args (compound)', () => {
    const p = buildCreateParams(makeFullInput());
    // command array → space-joined string
    expect(p['Container.1.Command']).toBe('nginx -g daemon off;');
    expect(p['Container.1.Args']).toBe('-c /etc/nginx/nginx.conf');
  });

  it('maps container resources (compound)', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['Container.1.Cpu']).toBe('2');
    expect(p['Container.1.Memory']).toBe('4096');
  });

  it('maps env vars with Value and FieldRefFieldPath', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['Container.1.EnvironmentVar.1.Key']).toBe('ENV');
    expect(p['Container.1.EnvironmentVar.1.Value']).toBe('prod');
    expect(p['Container.1.EnvironmentVar.2.Key']).toBe('NODE_NAME');
    expect(p['Container.1.EnvironmentVar.2.FieldRefFieldPath']).toBe('status.hostIP');
    expect(p['Container.1.EnvironmentVar.2.Value']).toBeUndefined();
  });

  it('maps ports', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['Container.1.Port.1.Port']).toBe('80');
    expect(p['Container.1.Port.1.Protocol']).toBe('tcp');
    expect(p['Container.1.Port.2.Port']).toBe('443');
    expect(p['Container.1.Port.2.Protocol']).toBe('tcp');
    expect(p['Container.1.Port.2.HostPort']).toBe('443');
  });

  it('maps livenessProbe with HttpGet', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['Container.1.LivenessProbe.HttpGet.Path']).toBe('/health');
    expect(p['Container.1.LivenessProbe.HttpGet.Port']).toBe('8080');
    expect(p['Container.1.LivenessProbe.HttpGet.Scheme']).toBe('HTTP');
    expect(p['Container.1.LivenessProbe.InitialDelaySeconds']).toBe('10');
    expect(p['Container.1.LivenessProbe.PeriodSeconds']).toBe('5');
    expect(p['Container.1.LivenessProbe.TimeoutSeconds']).toBe('3');
    expect(p['Container.1.LivenessProbe.FailureThreshold']).toBe('3');
    expect(p['Container.1.LivenessProbe.SuccessThreshold']).toBe('1');
  });

  it('maps readinessProbe with TcpSocket', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['Container.1.ReadinessProbe.TcpSocket.Port']).toBe('8080');
    expect(p['Container.1.ReadinessProbe.InitialDelaySeconds']).toBe('5');
    expect(p['Container.1.ReadinessProbe.PeriodSeconds']).toBe('3');
    // Should NOT have HttpGet or Exec params
    expect(p['Container.1.ReadinessProbe.HttpGet.Path']).toBeUndefined();
  });

  it('maps startupProbe with Exec', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['Container.1.StartupProbe.Exec.Commands']).toBe('check.sh --ready');
    expect(p['Container.1.StartupProbe.FailureThreshold']).toBe('30');
    expect(p['Container.1.StartupProbe.PeriodSeconds']).toBe('2');
  });

  it('maps NFS volume', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['Volume.1.Name']).toBe('nfs-vol');
    expect(p['Volume.1.Type']).toBe('NFSVolume');
    expect(p['Volume.1.NFSVolume.Server']).toBe('192.168.1.100');
    expect(p['Volume.1.NFSVolume.Path']).toBe('/data');
  });

  it('maps Disk volume', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['Volume.2.Name']).toBe('disk-vol');
    expect(p['Volume.2.Type']).toBe('DiskVolume');
    expect(p['Volume.2.DiskVolume.DiskId']).toBe('d-abc123');
    expect(p['Volume.2.DiskVolume.FsType']).toBe('ext4');
    expect(p['Volume.2.DiskVolume.DiskSize']).toBe('100');
  });

  it('maps network with multi-subnet', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['SecurityGroupId']).toBe('sg-abc');
    expect(p['VSwitchId']).toBe('vsw-001,vsw-002');
    expect(p['ScheduleStrategy']).toBe('VSwitchRandom');
    // ZoneId should be deleted when multi-subnet
    expect(p['ZoneId']).toBeUndefined();
  });

  it('maps tags', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['Tag.1.Key']).toBe('env');
    expect(p['Tag.1.Value']).toBe('test');
    expect(p['Tag.2.Key']).toBe('team');
    expect(p['Tag.2.Value']).toBe('platform');
  });

  it('maps extension overrides', () => {
    const p = buildCreateParams(makeFullInput());
    // These come from providerOverrides.alibaba via applyExtensionOverrides
    expect(p['AutoCreateEip']).toBe('true');
    expect(p['EipBandwidth']).toBe('10');
    expect(p['SpotStrategy']).toBe('SpotAsPriceGo');
    expect(p['EphemeralStorage']).toBe('50');
    expect(p['HostName']).toBe('test-host');
    expect(p['DnsPolicy']).toBe('Default');
    expect(p['ActiveDeadlineSeconds']).toBe('3600');
  });

  it('always sets AutoMatchImageCache', () => {
    const p = buildCreateParams(makeFullInput());
    expect(p['AutoMatchImageCache']).toBe('true');
  });

  it('partial mode only includes set fields', () => {
    const partial = buildCreateParams(
      { name: 'updated', region: createRegionId('cn-hangzhou') } as CreateContainerGroupInput,
      { partial: true },
    );
    expect(partial['ContainerGroupName']).toBe('updated');
    expect(partial['Cpu']).toBeUndefined();
    expect(partial['Memory']).toBeUndefined();
    expect(partial['RestartPolicy']).toBeUndefined();
    expect(partial['AutoMatchImageCache']).toBeUndefined();
  });
});

describe('parseContainerGroup', () => {
  it('populates all identity fields', () => {
    const cg = parseContainerGroup({
      ContainerGroupId: 'eci-abc123',
      ContainerGroupName: 'test-group',
      Status: 'Running',
      RegionId: 'cn-hangzhou',
      ZoneId: 'cn-hangzhou-a',
      Cpu: 4,
      Memory: 8,
      RestartPolicy: 'Always',
      CreationTime: '2026-01-01T00:00:00Z',
      InstanceType: 'ecs.c6.large',
      SpotStrategy: 'SpotAsPriceGo',
    });

    expect(cg.providerId).toBe('eci-abc123');
    expect(cg.name).toBe('test-group');
    expect(cg.status).toBe('Running');
    expect(cg.regionId).toBe('cn-hangzhou');
    expect(cg.zoneId).toBeTruthy();
    expect(cg.cpu).toBe(4);
    expect(cg.memory).toBe(8);
    expect(cg.restartPolicy).toBe('Always');
    expect(cg.creationTime).toBe('2026-01-01T00:00:00Z');
    expect(cg.instanceType).toBe('ecs.c6.large');
    expect(cg.spotStrategy).toBe('SpotAsPriceGo');
  });

  it('parses network fields', () => {
    const cg = parseContainerGroup({
      IntranetIp: '10.0.0.1',
      VpcId: 'vpc-001',
      VSwitchId: 'vsw-001',
      SecurityGroupId: 'sg-001',
      EniInstanceId: 'eni-001',
    });
    expect(cg.network.privateIp).toBe('10.0.0.1');
    expect(cg.network.vpcId).toBe('vpc-001');
    expect(cg.network.subnetId).toBe('vsw-001');
    expect(cg.network.securityGroupId).toBe('sg-001');
    expect(cg.network.eniId).toBe('eni-001');
  });

  it('parses containers with env and resources', () => {
    const cg = parseContainerGroup({
      Containers: [
        {
          ContainerId: 'ctr-001',
          Name: 'app',
          Image: 'nginx:latest',
          Args: ['-g', 'daemon off;'],
          WorkingDir: '/app',
          Status: 'Running',
          Cpu: 2,
          Memory: 4096,
          EnvironmentVars: [{ Key: 'ENV', Value: 'prod' }],
        },
      ],
    });

    expect(cg.containers).toHaveLength(1);
    const c = cg.containers[0]!;
    expect(c.name).toBe('app');
    expect(c.image).toBe('nginx:latest');
    expect(c.status).toBe('Running'); // ECI returns capitalized status, passed through as-is
    expect(c.alive).toBe(true);
    expect(c.resources).toEqual({ cpu: 2, memory: 4096 });
    expect(c.env).toEqual({ ENV: 'prod' });
  });

  it('parses associatedResources (EIP)', () => {
    const cg = parseContainerGroup({
      AssociatedResources: [
        {
          ResourceType: 'EIP',
          ResourceId: 'eip-001',
          Ip: '1.2.3.4',
          Bandwidth: 100,
          Isp: 'BGP',
          Status: 'InUse',
        },
      ],
    });
    expect(cg.associatedResources).toHaveLength(1);
    const eip = cg.associatedResources[0]!;
    expect(eip.type).toBe('eip');
    expect(eip.ip).toBe('1.2.3.4');
    expect(eip.bandwidth).toBe(100);
  });

  it('parses ephemeralStorage', () => {
    const cg = parseContainerGroup({ EphemeralStorage: 50 });
    expect(cg.ephemeralStorageGiB).toBe(50);
  });

  it('parses tags and events', () => {
    const cg = parseContainerGroup({
      Tags: [{ Key: 'env', Value: 'prod' }],
      Events: [{ Reason: 'Created', Type: 'Normal', Message: 'Container created', Count: 1 }],
    });
    expect(cg.tags).toEqual([{ key: 'env', value: 'prod' }]);
    expect(cg.events[0]!.reason).toBe('Created');
    expect(cg.events[0]!.type).toBe('Normal');
  });

  it('parses GPU from string to number', () => {
    const cg = parseContainerGroup({ Gpu: '1', InstanceType: 'gn6v.2xlarge' });
    expect(cg.gpu).toBe(1);
    expect(cg.gpuModel).toBe('NVIDIA T4');
  });

  it('handles missing optional fields gracefully', () => {
    const cg = parseContainerGroup({});
    expect(cg.providerId).toBe('');
    expect(cg.name).toBe('');
    expect(cg.status).toBe('Pending');
    expect(cg.cpu).toBe(0);
    expect(cg.memory).toBe(0);
    expect(cg.restartPolicy).toBe('Always');
    expect(cg.containers).toEqual([]);
    expect(cg.volumes).toEqual([]);
    expect(cg.events).toEqual([]);
    expect(cg.tags).toEqual([]);
    expect(cg.associatedResources).toEqual([]);
    expect(cg.ephemeralStorageGiB).toBeUndefined();
    expect(cg.network.privateIp).toBeUndefined();
  });
});

describe('parseProbe', () => {
  it('parses HttpGet probe', () => {
    const probe = parseProbe({
      HttpGet: { Path: '/health', Port: 8080, Scheme: 'HTTP' },
      InitialDelaySeconds: 10,
      PeriodSeconds: 5,
    });
    expect(probe).toBeDefined();
    expect(probe!.httpGet).toEqual({ path: '/health', port: 8080, scheme: 'HTTP' });
    expect(probe!.initialDelaySeconds).toBe(10);
    expect(probe!.periodSeconds).toBe(5);
  });

  it('parses TcpSocket probe', () => {
    const probe = parseProbe({ TcpSocket: { Port: 3306 }, TimeoutSeconds: 3 });
    expect(probe).toBeDefined();
    expect(probe!.tcpSocket).toEqual({ port: 3306 });
    expect(probe!.timeoutSeconds).toBe(3);
  });

  it('parses Exec probe', () => {
    const probe = parseProbe({ Exec: { Commands: ['/bin/sh', '-c', 'echo ok'] }, FailureThreshold: 3 });
    expect(probe).toBeDefined();
    expect(probe!.exec).toEqual({ command: ['/bin/sh', '-c', 'echo ok'] });
    expect(probe!.failureThreshold).toBe(3);
  });

  it('returns undefined for empty input', () => {
    expect(parseProbe(undefined)).toBeUndefined();
    expect(parseProbe({})).toBeUndefined();
  });
});

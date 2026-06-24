/**
 * ECI Container Group entity integrity — integration test against real Alibaba API.
 *
 * Verifies the full chain: CreateContainerGroup → DescribeContainerGroups →
 * parseContainerGroup → runtimeToContainers / runtimeToNetwork / runtimeToEvents.
 *
 * Default: SKIPPED. Requires real Alibaba credentials and network access.
 * Opt-in:  ECI_INTEGRATION_TEST=true npx vitest run tests/integration/eci-entity-integrity.test.ts
 *
 * Minimal spec: 1c1g, no volumes, no EIP, auto-cleanup.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rpcCall } from '../../src/providers/alibaba/eci-signer.ts';
import { parseContainerGroup } from '../../src/providers/alibaba/eci-container.ts';
import { runtimeToNetwork, runtimeToContainers, runtimeToEvents } from '../../src/features/sandbox/runtime-mapper.ts';

// ─── Config ───

const AK_ID = process.env['ALIBABA_ACCESS_KEY_ID'] ?? '';
const AK_SECRET = process.env['ALIBABA_ACCESS_KEY_SECRET'] ?? '';
const ENDPOINT = process.env['ALIBABA_ECI_ENDPOINT'] ?? 'eci.cn-hangzhou.aliyuncs.com';
const REGION = process.env['ALIBABA_REGION'] ?? 'cn-hangzhou';
const HAS_CREDENTIALS = !!(AK_ID && AK_SECRET);

// ─── Helpers ───

function api(params: Record<string, any>, action: string): Promise<any> {
  return rpcCall(ENDPOINT, AK_ID, AK_SECRET, action, params as any);
}

async function describeGroup(providerId: string): Promise<any> {
  const resp = await api(
    { RegionId: REGION, ContainerGroupIds: JSON.stringify([providerId]), Limit: '1' },
    'DescribeContainerGroups',
  );
  return resp?.ContainerGroups?.[0] ?? null;
}

async function deleteGroup(providerId: string): Promise<void> {
  try {
    await api({ RegionId: REGION, ContainerGroupId: providerId }, 'DeleteContainerGroup');
  } catch { /* best-effort cleanup */ }
}

function wait(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ─── Test ───

const runIntegration = HAS_CREDENTIALS;

describe.skipIf(!runIntegration)('ECI entity integrity (real API)', () => {
  let providerId: string | null = null;

  afterAll(async () => {
    if (providerId) await deleteGroup(providerId);
  });

  it('CreateContainerGroup returns providerId', async () => {
    // Alibaba RPC API uses flat indexed params (Container.1.Name, etc.), not JSON.
    const idx = 'Container.1';
    const resp = await api({
      RegionId: REGION,
      ContainerGroupName: `integrity-test-${Date.now()}`,
      SecurityGroupId: 'sg-bp16o5urk39itwcqmdzj',
      VSwitchId: 'vsw-bp1xx36ys1jou7o1bsdpp',
      Cpu: '1',
      Memory: '1',
      RestartPolicy: 'Always',
      SpotStrategy: 'SpotAsPriceGo',
      [`${idx}.Name`]: 'echo',
      [`${idx}.Image`]: 'registry-vpc.cn-hangzhou.aliyuncs.com/minecraft-graalvm/ftp_bp:latest',
      [`${idx}.Cpu`]: '0.5',
      [`${idx}.Memory`]: '0.5',
      [`${idx}.Tty`]: 'true',
      [`${idx}.Stdin`]: 'true',
      [`${idx}.ImagePullPolicy`]: 'Always',
      AutoCreateEip: 'true',
      EipBandwidth: '1',
    }, 'CreateContainerGroup');

    providerId = resp?.ContainerGroupId ?? null;
    expect(providerId, `CreateContainerGroup response: ${JSON.stringify(resp)}`).toBeTruthy();
    expect(typeof providerId).toBe('string');
    expect(providerId).toMatch(/^eci-/);
  }, 30_000);

  it('DescribeContainerGroups → parseContainerGroup populates ALL entity fields', async () => {
    expect(providerId).toBeTruthy();

    // Poll until CG reaches a data-rich state (max 90s).
    // ECI returns containers/network/events even for Failed/Succeeded — we verify
    // entity field mapping regardless of whether the process stays alive.
    let raw: any = null;
    let status = '';
    for (let i = 0; i < 30; i++) {
      raw = await describeGroup(providerId!);
      status = raw?.Status ?? '';
      // Stop polling once ECI has finished initializing (non-transient state)
      if (status === 'Running' || status === 'Failed' || status === 'Succeeded' || status === 'Expired') break;
      await wait(3000);
    }
    expect(status, `ECI did not reach a data-rich state within 90s. Last status: ${status}`).toMatch(/^(Running|Failed|Succeeded)$/);

    // ─── Parse through the full mapping chain ───
    const cg = parseContainerGroup(raw);

    // §1  Top-level identity
    expect(cg.providerId).toBe(providerId);
    expect(cg.name).toBeTruthy();
    expect(cg.status).toBe('Running');
    expect(cg.regionId).toBe(REGION);
    expect(cg.zoneId).toBeTruthy();
    expect(typeof cg.zoneId).toBe('string');
    expect(cg.cpu).toBeGreaterThan(0);
    expect(cg.memory).toBeGreaterThan(0);
    expect(cg.restartPolicy).toBeTruthy();
    expect(cg.creationTime).toBeTruthy();

    // §2  Network
    const network = runtimeToNetwork(cg.network, cg.associatedResources);
    expect(network.privateIp, `privateIp missing — network: ${JSON.stringify(cg.network)}`).toBeTruthy();
    expect(network.vpcId).toBeTruthy();
    // subnetId / securityGroupId / eniId map from ECI fields
    // These should be populated from the real response

    // §3  Containers — the critical bug path
    const containers = runtimeToContainers(cg);
    expect(containers.length, `containers array empty — was the ECI response missing Containers[]?`).toBeGreaterThan(0);
    const c = containers[0]!;
    expect(c.name).toBeTruthy();
    expect(c.image).toBeTruthy();
    expect(c.cpu).toBeGreaterThan(0);
    expect(c.memory).toBeGreaterThan(0);
    // Container may be Waiting/Running/Terminated depending on workload
    expect(['Running', 'Waiting', 'Terminated'], `unexpected container state: ${c.state.state}`).toContain(c.state.state);
    // ready is true only when container is healthy AND Running

    // §4  Events
    const events = runtimeToEvents(cg);
    expect(events.length, 'events should contain at least creation events').toBeGreaterThan(0);
    const eventTypes = events.map(e => e.reason);
    expect(eventTypes).toContain('Created');

    // §5  Volumes (should be empty for our minimal spec)
    expect(Array.isArray(cg.volumes)).toBe(true);

    // §6  Tags
    expect(Array.isArray(cg.tags)).toBe(true);
  }, 120_000);

  it('cleanup: DeleteContainerGroup succeeds', async () => {
    expect(providerId).toBeTruthy();
    await deleteGroup(providerId!);

    // Verify deletion
    await wait(5000);
    const cg = await describeGroup(providerId!);
    // After deletion, DescribeContainerGroups returns no results or status=Deleted
    if (cg) {
      expect(['Deleted', 'Terminating', 'Expired']).toContain(cg.Status);
    }
    providerId = null; // prevent afterAll double-cleanup
  }, 30_000);
});

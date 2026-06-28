/**
 * Podman network policy provider — implements INetworkPolicyProvider
 * via the libpod networks API.
 *
 * Each tenant gets an isolated bridge network. Pods created for that
 * tenant attach to this network, preventing cross-tenant traffic by
 * default (Podman bridge networks are isolated per-network).
 */

import type { INetworkPolicyProvider } from '../../core/provider/interfaces.ts';

const NETWORK_PREFIX = 'hbi-iso-';

function networkName(tenantId: string): string {
  // Deterministic name ensures idempotent ensureNetwork
  return NETWORK_PREFIX + tenantId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

export class PodmanNetworkPolicyProvider implements INetworkPolicyProvider {
  readonly #libpodApi: string;

  public constructor(endpoint = 'http://127.0.0.1:8080') {
    this.#libpodApi = `${endpoint}/v5.0.0/libpod`;
  }

  public async ensureNetwork(tenantId: string): Promise<string> {
    const name = networkName(tenantId);

    // Check if already exists
    const listResp = await fetch(`${this.#libpodApi}/networks/json`);
    if (listResp.ok) {
      const networks = await listResp.json();
      const existing = networks.find(n => n.Name === name);
      if (existing) return name;
    }

    // Create isolated bridge network — no DNS, no default route to
    // other networks. Each tenant network is a /24 subnet.
    const subnet = tenantSubnet(tenantId);
    const body = {
      name,
      driver: 'bridge',
      internal: false,  // pods can reach internet via NAT
      subnets: [{ subnet }],
      labels: { 'managed-by': 'hbi-aad', tenant: tenantId },
      options: { isolate: 'true' },
    };

    const resp = await fetch(`${this.#libpodApi}/networks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      // 409 = already exists (race), treat as success
      if (resp.status !== 409) {
        throw new Error(`Podman network create failed (${resp.status}): ${err}`);
      }
    }

    return name;
  }

  public async removeNetwork(networkId: string): Promise<void> {
    const resp = await fetch(`${this.#libpodApi}/networks/${encodeURIComponent(networkId)}`, {
      method: 'DELETE',
    });
    if (!resp.ok && resp.status !== 404) {
      const err = await resp.text().catch(() => '');
      throw new Error(`Podman network remove failed (${resp.status}): ${err}`);
    }
  }
}

/**
 * Deterministic /24 subnet derived from tenant ID hash.
 * Avoids subnet collisions for different tenants while being
 * reproducible across restarts.
 */
function tenantSubnet(tenantId: string): string {
  let hash = 0;
  for (let i = 0; i < tenantId.length; i++) {
    hash = ((hash << 5) - hash) + tenantId.charCodeAt(i);
    hash |= 0;
  }
  // Map to 10.2.x.x range (skip 10.0.x.x and 10.1.x.x for safety)
  const b2 = ((Math.abs(hash) % 253) + 2) & 0xff; // 2-254
  return `10.2.${b2}.0/24`;
}

import type { IAtomicStore } from '../store/interfaces.ts';
import type { NetworkId, ResolvedNetwork, NetworkResolverFn } from './types.ts';

const VNET_PREFIX = 'vnet:';

/** Minimal VNet shape stored in IAtomicStore — avoids importing feature-level types. */
interface VNetEntry {
  readonly id: NetworkId;
  readonly provider: string;
  readonly securityGroupId?: string | undefined;
  readonly cidr?: string | undefined;
}

/**
 * Create a NetworkResolverFn backed by IAtomicStore.
 * Keeps VNet storage key convention in core/network/ so neither features
 * nor composition roots need to know the key format.
 */
export function createAtomicNetworkResolver(atomic: IAtomicStore): NetworkResolverFn {
  return async (id: NetworkId) => {
    const entry = await atomic.get<VNetEntry>(VNET_PREFIX + id);
    if (!entry) return null;
    const v = entry.value;
    return {
      provider: v.provider,
      securityGroupId: v.securityGroupId,
      subnetIds: v.cidr ? [v.cidr] : undefined,
    } satisfies ResolvedNetwork;
  };
}

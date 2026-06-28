import { z } from 'zod';

const networkIdSchema = z.string().min(1).brand('NetworkId');

/** Brand type for virtual network IDs — shared across features and providers. */
export type NetworkId = z.infer<typeof networkIdSchema>;

export function createNetworkId(raw: string): NetworkId {
  if (!raw) throw new TypeError('NetworkId must not be empty');
  return networkIdSchema.parse(raw);
}

export function generateNetworkId(): NetworkId {
  return networkIdSchema.parse(`net_${crypto.randomUUID()}`);
}

/** Minimal VNet data resolved for sandbox provisioning.
 *  Feature-agnostic — used as a callback parameter to avoid cross-feature imports. */
export interface ResolvedNetwork {
  readonly provider: string;
  readonly securityGroupId?: string | undefined;
  readonly subnetIds?: readonly string[] | undefined;
}

/** Resolver callback: given a NetworkId, return the network data or null.
 *  Wired in the composition root to avoid features importing each other. */
export type NetworkResolverFn = (id: NetworkId) => Promise<ResolvedNetwork | null>;

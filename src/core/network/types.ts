declare const NETWORK_ID_BRAND: unique symbol;

/** Brand type for virtual network IDs — shared across features and providers. */
export type NetworkId = string & { readonly [NETWORK_ID_BRAND]: true };

export function createNetworkId(raw: string): NetworkId {
  if (!raw) throw new TypeError('NetworkId must not be empty');
  return raw as NetworkId;
}

export function generateNetworkId(): NetworkId {
  return `net_${crypto.randomUUID()}` as NetworkId;
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

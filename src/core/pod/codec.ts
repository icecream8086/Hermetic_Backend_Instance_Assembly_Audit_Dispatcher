/**
 * PodCodec — CEA core contract.
 *
 * Each provider implements PodCodec<TNative> where TNative is the provider's
 * wire format (RPC params, REST body, JSON). The TypeScript compiler enforces
 * that encode / decode / decodeStatus all exist and are updated together
 * when PodSpec or PodRuntime changes.
 *
 * Usage (Airflow KubernetesExecutor pattern):
 *   const codec = providerRegistry.resolvePodCodec(instanceId);
 *   const native = codec.encode(podSpec);   // PodSpec → provider params
 *   const runtime = codec.decode(raw);     // provider response → PodRuntime
 *   const phase = codec.decodeStatus(raw); // provider response → PodPhase
 */

import type { PodSpec, PodRuntime, PodPhase } from './types.ts';

// ═══════════════════════════════════════════════════════════════
// PodCodec interface
// ═══════════════════════════════════════════════════════════════

/**
 * Bidirectional codec for a specific container provider.
 *
 * @typeParam TNative - The provider's native wire format.
 *   - Alibaba ECI: `Record<string, string>` (flat RPC params)
 *   - Podman: PodmanCreateRequest (REST JSON body)
 *   - K8s: V1Pod (Kubernetes JSON)
 *   - AWS ECS: TaskDefinition (JSON)
 */
export interface PodCodec<TNative> {
  /** Provider identifier for routing. */
  readonly providerId: string;

  /** Encode a PodSpec into the provider's native creation format.
   *  CEA: every PodSpec field must have an encode entry in the codec table. */
  encode(input: PodSpec): TNative;

  /** Decode a provider's raw response into a PodRuntime.
   *  CEA: every PodRuntime field must have a decode entry. */
  decode(raw: unknown): PodRuntime;

  /** Extract PodPhase from a provider's raw describe response.
   *  Maps provider-specific status → K8s PodPhase (5). */
  decodeStatus(raw: unknown): PodPhase;

  /** Encode a partial PodSpec for update operations.
   *  Optional — providers that don't support update throw NOT_IMPLEMENTED. */
  encodePartial?(input: { [K in keyof PodSpec]?: PodSpec[K] | undefined }): TNative;
}

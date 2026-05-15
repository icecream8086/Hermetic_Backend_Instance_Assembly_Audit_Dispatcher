import type {
  IMetricsProvider,
  FetchMetricsInput,
  FetchMetricsResult,
  MetricSnapshot,
} from '../../core/provider/index.ts';

export class StubMetricsProvider implements IMetricsProvider {
  async fetchMetrics(input: FetchMetricsInput): Promise<FetchMetricsResult> {
    const now = Date.now();
    const snapshots: MetricSnapshot[] = [];

    for (let i = 0; i < 10; i++) {
      const t = i + 1; // 1..10, deterministic
      snapshots.push({
        id: `stub-metric-${i}`,
        sandboxId: input.providerId,
        timestamp: now - (9 - i) * 60_000,
        cpu: { usageNanoCores: t * 100_000_000, usageCores: t * 0.2 },
        memory: { usageBytes: t * 50 * 1024 * 1024, rss: t * 25 * 1024 * 1024, cache: t * 12 * 1024 * 1024 },
        network: { txBytes: t * 1000, rxBytes: t * 5000, txPackets: t * 10, rxPackets: t * 20 },
        disk: { readBytes: t * 100 * 1024, writeBytes: t * 50 * 1024, readIo: t, writeIo: t * 0.5 },
        containers: [],
      });
    }

    return { snapshots };
  }
}

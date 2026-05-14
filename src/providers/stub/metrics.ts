import type {
  IMetricsProvider,
  FetchMetricsInput,
  FetchMetricsResult,
} from '../../core/provider/interfaces.ts';
import { createMetricSnapshotId, createSandboxId } from '../../features/sandbox/types.ts';
import type { MetricSnapshot } from '../../features/sandbox/types.ts';

export class StubMetricsProvider implements IMetricsProvider {
  async fetchMetrics(input: FetchMetricsInput): Promise<FetchMetricsResult> {
    const now = Date.now();
    const snapshots: MetricSnapshot[] = [];

    for (let i = 0; i < 10; i++) {
      snapshots.push({
        id: createMetricSnapshotId(`stub-metric-${i}`),
        sandboxId: createSandboxId(input.providerId),
        timestamp: now - (9 - i) * 60_000,
        cpu: { usageNanoCores: Math.random() * 1e9, usageCores: Math.random() * 2 },
        memory: { usageBytes: Math.random() * 512 * 1024 * 1024, rss: Math.random() * 256 * 1024 * 1024, cache: Math.random() * 128 * 1024 * 1024 },
        network: { txBytes: Math.random() * 10000, rxBytes: Math.random() * 50000, txPackets: Math.random() * 100, rxPackets: Math.random() * 200 },
        disk: { readBytes: Math.random() * 1024 * 1024, writeBytes: Math.random() * 512 * 1024, readIo: Math.random() * 10, writeIo: Math.random() * 5 },
        containers: [],
      });
    }

    return { snapshots };
  }
}

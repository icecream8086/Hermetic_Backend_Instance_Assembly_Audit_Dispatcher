import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { EventBus } from '../../core/event-bus/bus.ts';
import type { EventLoop } from '../../core/event-bus/loop.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { WorkflowDef, WorkflowRun } from './types.ts';
import { PFX_WORKFLOW_DEF, IDX_WORKFLOW_IDS } from './types.ts';

// ─── Cron trigger ───

export interface CronTriggerDeps {
  atomic: IAtomicStore;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
  onTrigger: (wf: WorkflowDef, trigger: WorkflowRun['trigger'], payload?: unknown) => Promise<unknown>;
}

/**
 * Register a self-rearming cron tick on the EventBus, seeded via EventLoop.
 * Follows the same pattern as registerHealthCheck() in core/events/health-check.ts.
 */
export function registerCronTrigger(deps: CronTriggerDeps): void {
  deps.eventBus.on('workflow:cron:tick', async () => {
    try {
      const idx = await deps.atomic.get<string[]>(IDX_WORKFLOW_IDS);
      if (!idx) return;

      const now = Date.now();
      for (const id of idx.value) {
        const entry = await deps.atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + id);
        if (!entry) continue;
        const cron = entry.value.on.cron;
        if (!cron) continue;

        if (cronMatches(cron, now)) {
          await deps.onTrigger(entry.value, 'cron');
        }
      }
    } finally {
      deps.eventLoop.enqueuePriority({ type: 'workflow:cron:tick', payload: {} });
    }
  });

  // Seed first tick
  deps.eventLoop.enqueuePriority({ type: 'workflow:cron:tick', payload: {} });
}

/**
 * Minimal cron expression matcher for standard 5-field syntax.
 * Supports: *, N, *\/N, comma-separated values.
 */
function cronMatches(expr: string, nowMs: number): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const d = new Date(nowMs);
  const values = [
    d.getUTCMinutes(),
    d.getUTCHours(),
    d.getUTCDate(),
    d.getUTCMonth() + 1,
    d.getUTCDay(),
  ];

  for (let i = 0; i < 5; i++) {
    if (!cronFieldMatches(fields[i]!, values[i]!)) return false;
  }
  return true;
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return step > 0 && value % step === 0;
  }
  if (field.includes(',')) {
    return field.split(',').some(f => cronFieldMatches(f.trim(), value));
  }
  return parseInt(field, 10) === value;
}

// ─── HTTP trigger signature verification ───

/**
 * Verify HMAC-SHA256 signature on an HTTP trigger request.
 * The signature is expected in the X-Workflow-Signature header.
 * Body is raw string; compared against sha256(secret + body).
 */
export async function verifyHttpSignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const sigBytes = hexToBytes(signature);
  return crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(body));
}

export async function signHttpPayload(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return bytesToHex(new Uint8Array(sig));
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

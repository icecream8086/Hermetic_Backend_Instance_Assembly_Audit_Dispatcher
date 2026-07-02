import { z } from 'zod';
import type { IDnsProvider } from '../../core/provider/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { DnsStepDef } from './types.ts';

/**
 * Execute a DNS step — uses the IDnsProvider directly.
 *
 * DNS is an Action-internal capability, not routed through the
 * /api/dns feature.  This means:
 *  - No pre-existing DnsRecord entity required
 *  - DNS lifecycle is tied to the Workflow Run (cleanup on teardown)
 *  - zoneId is explicit in the step config (no external lookup)
 */
export async function executeDnsStep(
  step: DnsStepDef,
  provider: IDnsProvider,
  audit?: IAuditWriter,
): Promise<void> {
  const dns = step.dns;
  const ttl = dns.ttl ?? 300;
  const proxied = dns.proxied ?? false;

  if (dns.action === 'upsert') {
    // providerRecordId is optional for upsert — the provider will create or
    // update the record. We use the fqdn as a stable identifier.
    const recordId = `${dns.type}:${dns.name}:${dns.zoneId}`;
    await provider.updateRecord({
      domain: dns.name,
      type: z.enum(['A', 'CNAME']).parse(dns.type),
      value: dns.value,
      ttl,
      proxied,
      providerRecordId: recordId,
      zoneId: dns.zoneId,
    });
  } else {
    const recordId = `${dns.type}:${dns.name}:${dns.zoneId}`;
    await provider.deleteRecord({
      zoneId: dns.zoneId,
      providerRecordId: recordId,
    });
  }

  audit?.write({
    level: 6,
    facility: 'action-dns',
    message: `DNS ${dns.action} ${dns.type} ${dns.name} → ${dns.value}`,
    metadata: { stepType: 'dns', ...dns },
  });
}

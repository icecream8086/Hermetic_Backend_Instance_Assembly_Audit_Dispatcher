import { z } from 'zod';

const logIdSchema = z.string().regex(/^\d{16}-[a-f0-9]{12}$/).brand('LogId');
export const versionIdSchema = z.string().min(1).brand('VersionId');
const serializedBodySchema = z.string().brand('SerializedBody');
const facilitySchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).brand('Facility');
const orderIdSchema = z.string().regex(/^ord_[a-f0-9-]{36}$/).brand('OrderId');

export type LogId = z.infer<typeof logIdSchema>;
export type VersionId = z.infer<typeof versionIdSchema>;
export type SerializedBody = z.infer<typeof serializedBodySchema>;
export type Facility = z.infer<typeof facilitySchema>;
export type OrderId = z.infer<typeof orderIdSchema>;

export function createLogId(raw: string): LogId {
  return logIdSchema.parse(raw);
}

export function generateLogId(): LogId {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return createLogId(`${Date.now().toString(10).padStart(16, '0')}-${rand}`);
}

export function createVersionId(raw: string): VersionId {
  return versionIdSchema.parse(raw);
}

export function generateVersionId(): VersionId {
  return versionIdSchema.parse(crypto.randomUUID());
}

export function createFacility(raw: string): Facility {
  return facilitySchema.parse(raw);
}

export function createOrderId(raw: string): OrderId {
  return orderIdSchema.parse(raw);
}

export function generateOrderId(): OrderId {
  return orderIdSchema.parse(`ord_${crypto.randomUUID()}`);
}

export function createSerializedBody(raw: string): SerializedBody {
  return serializedBodySchema.parse(raw);
}

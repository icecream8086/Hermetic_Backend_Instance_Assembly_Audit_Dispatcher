declare const LOG_ID_BRAND: unique symbol;
declare const VERSION_ID_BRAND: unique symbol;
declare const SERIAL_BODY_BRAND: unique symbol;
declare const FACILITY_BRAND: unique symbol;
declare const ORDER_ID_BRAND: unique symbol;

export type LogId = string & { readonly [LOG_ID_BRAND]: true };
export type VersionId = string & { readonly [VERSION_ID_BRAND]: true };
export type SerializedBody = string & { readonly [SERIAL_BODY_BRAND]: true };
export type Facility = string & { readonly [FACILITY_BRAND]: true };
export type OrderId = string & { readonly [ORDER_ID_BRAND]: true };

const LOG_ID_PATTERN = /^\d{16}-[a-f0-9]{12}$/;
const FACILITY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

export function createLogId(raw: string): LogId {
  if (!LOG_ID_PATTERN.test(raw)) throw new TypeError(`Invalid LogId format: ${raw}`);
  return raw as LogId;
}

export function generateLogId(): LogId {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return createLogId(`${Date.now().toString(10).padStart(16, '0')}-${rand}`);
}

export function generateVersionId(): VersionId {
  return crypto.randomUUID() as VersionId;
}

export function createFacility(raw: string): Facility {
  if (!FACILITY_PATTERN.test(raw)) throw new TypeError(`Invalid facility name: ${raw}`);
  return raw as Facility;
}

const ORDER_ID_PATTERN = /^ord_[a-f0-9-]{36}$/;

export function createOrderId(raw: string): OrderId {
  if (!ORDER_ID_PATTERN.test(raw)) throw new TypeError(`Invalid OrderId format: ${raw}`);
  return raw as OrderId;
}

export function generateOrderId(): OrderId {
  return `ord_${crypto.randomUUID()}` as OrderId;
}

export function createSerializedBody(raw: string): SerializedBody {
  return raw as SerializedBody;
}

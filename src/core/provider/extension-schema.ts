/**
 * Provider extension field schema system.
 *
 * Each provider declares which extension parameters it supports.
 * Extension fields are provider-specific knobs that go beyond the
 * common CreateContainerGroupInput (e.g. Alibaba EIP, BGP Pro, spot).
 *
 * Two endpoints consume these schemas:
 *   GET  /api/extension-fields?instanceId=xxx  — schema for a specific instance
 *   POST /api/sandboxes                       — validated via providerOverrides
 */

// ─── Field type ───

export type ExtensionFieldType = 'string' | 'number' | 'boolean' | 'object' | 'string[]' | 'number[]';

export interface ExtensionFieldValidation {
  readonly enum?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: string;
}

/** Description of a single extension parameter. */
export interface ExtensionFieldDef {
  readonly key: string;
  readonly type: ExtensionFieldType;
  readonly label: string;
  readonly description: string;
  readonly required?: boolean;
  readonly default?: unknown;
  /** Alibaba ECI API parameter name (for auto-mapping). */
  readonly eciParam?: string;
  /** Value transformation hint. */
  readonly transform?: 'boolean-string' | 'number-string' | 'json-string' | 'comma-sep';
  readonly validation?: ExtensionFieldValidation;
  /** Which level the parameter applies to. */
  readonly scope: 'sandbox' | 'container' | 'volume' | 'network';
  /** Optional category grouping for UI. */
  readonly category?: string;
}

/** Named schema for a single provider. */
export interface ProviderExtensionSchema {
  readonly provider: string;
  readonly label: string;
  readonly fields: readonly ExtensionFieldDef[];
}

// ─── Schema Registry ───

const schemas = new Map<string, ProviderExtensionSchema>();

export function registerExtensionSchema(schema: ProviderExtensionSchema): void {
  schemas.set(schema.provider, schema);
}

export function getExtensionSchema(provider: string): ProviderExtensionSchema | undefined {
  return schemas.get(provider);
}

export function getAllExtensionSchemas(): readonly ProviderExtensionSchema[] {
  return [...schemas.values()];
}

/** Map providerOverrides → ECI API params using schema eciParam hints. */
export function applyExtensionOverrides(
  provider: string,
  overrides: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!overrides) return out;

  const schema = schemas.get(provider);
  if (!schema) return out;

  for (const field of schema.fields) {
    const val = overrides[field.key];
    if (val === undefined || val === null) continue;
    // 'None' is the canonical sentinel for "not set" in our domain model.
    if (val === 'None') continue;
    if (!field.eciParam) continue;

    switch (field.transform) {
      case undefined:
        out[field.eciParam] = z.record(z.unknown()).safeParse(val).success ? JSON.stringify(val) : String(val);
        break;
      case 'boolean-string':
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- extension boundary: overrides values from external input may be falsy
        out[field.eciParam] = val ? 'true' : 'false';
        break;
      case 'number-string':
        out[field.eciParam] = z.number().safeParse(val).success ? String(val) : '';
        break;
      case 'json-string':
        out[field.eciParam] = JSON.stringify(val);
        break;
      case 'comma-sep':
        out[field.eciParam] = Array.isArray(val) ? val.join(',') : (z.string().safeParse(val).success ? val : '');
        break;
    }
  }

  return out;
}

/** Validate providerOverrides against the declared schema. */
export function validateExtensionOverrides(
  provider: string,
  overrides: Record<string, unknown> | undefined,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!overrides) return { valid: true, errors };

  const schema = schemas.get(provider);
  if (!schema) return { valid: true, errors };

  function checkType(v: unknown, type: string): boolean {
    try {
      switch (type) {
        case 'number': z.number().parse(v); break;
        case 'boolean': z.boolean().parse(v); break;
        case 'string': z.string().parse(v); break;
        case 'object': z.record(z.unknown()).parse(v); break;
        case 'string[]': z.array(z.string()).parse(v); break;
        case 'number[]': z.array(z.number()).parse(v); break;
      }
      return true;
    } catch (e) { const _r = false; return _r; }
  }

  for (const field of schema.fields) {
    const val = overrides[field.key];
    if (val === undefined || val === null) {
      if (field.required) errors.push(`${field.key} is required`);
      continue;
    }

    // Type check using Zod (CEA: no handwritten typeof guards)
    if (!checkType(val, field.type)) {
      errors.push(`${field.key} must be a ${field.type}`);
    }

    // Enum check
    if (field.validation?.enum && z.string().safeParse(val).success) {
      if (!field.validation.enum.includes(val)) {
        errors.push(`${field.key} must be one of: ${field.validation.enum.join(', ')}`);
      }
    }

    // Range check
    if (field.validation) {
      if (field.validation.min !== undefined && typeof val === 'number' && val < field.validation.min) {
        errors.push(`${field.key} must be >= ${String(field.validation.min)}`);
      }
      if (field.validation.max !== undefined && typeof val === 'number' && val > field.validation.max) {
        errors.push(`${field.key} must be <= ${String(field.validation.max)}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

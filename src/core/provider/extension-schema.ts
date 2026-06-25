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
    if (!field.eciParam) continue;

    switch (field.transform) {
      case 'boolean-string':
        out[field.eciParam] = val ? 'true' : 'false';
        break;
      case 'number-string':
        out[field.eciParam] = String(val);
        break;
      case 'json-string':
        out[field.eciParam] = JSON.stringify(val);
        break;
      case 'comma-sep':
        out[field.eciParam] = Array.isArray(val) ? val.join(',') : String(val);
        break;
      default:
        out[field.eciParam] = String(val);
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

  for (const field of schema.fields) {
    const val = overrides[field.key];
    if (val === undefined || val === null) {
      if (field.required) errors.push(`${field.key} is required`);
      continue;
    }

    // Type check
    switch (field.type) {
      case 'number':
        if (typeof val !== 'number') errors.push(`${field.key} must be a number`);
        break;
      case 'boolean':
        if (typeof val !== 'boolean') errors.push(`${field.key} must be a boolean`);
        break;
      case 'string':
        if (typeof val !== 'string') errors.push(`${field.key} must be a string`);
        break;
      case 'string[]':
        if (!Array.isArray(val) || val.some(v => typeof v !== 'string')) errors.push(`${field.key} must be a string array`);
        break;
      case 'number[]':
        if (!Array.isArray(val) || val.some(v => typeof v !== 'number')) errors.push(`${field.key} must be a number array`);
        break;
    }

    // Enum check
    if (field.validation?.enum && typeof val === 'string') {
      if (!field.validation.enum.includes(val)) {
        errors.push(`${field.key} must be one of: ${field.validation.enum.join(', ')}`);
      }
    }

    // Range check
    if (field.validation) {
      if (field.validation.min !== undefined && typeof val === 'number' && val < field.validation.min) {
        errors.push(`${field.key} must be >= ${field.validation.min}`);
      }
      if (field.validation.max !== undefined && typeof val === 'number' && val > field.validation.max) {
        errors.push(`${field.key} must be <= ${field.validation.max}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

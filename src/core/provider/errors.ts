import { AppError } from '../types.ts';

/** Provider resolution failed — no fallback. The caller must handle or escalate. */
export class ProviderResolutionError extends AppError {
  constructor(
    message: string,
    public readonly instanceId?: string,
    public readonly platform?: string,
  ) {
    super(503, 'PROVIDER_RESOLUTION_FAILED', message);
  }
}

/** A provider operation (create/delete/describe/getLogs) failed at the cloud API level. */
export class ProviderOperationError extends AppError {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly providerId?: string,
    public readonly providerPlatform?: string,
  ) {
    super(502, 'PROVIDER_OPERATION_FAILED', message);
  }
}

/** Credential resolution failed — the requested credential reference cannot be resolved. */
export class CredentialResolutionError extends AppError {
  constructor(
    message: string,
    public readonly credentialRef?: string,
    public readonly instanceId?: string,
  ) {
    super(401, 'CREDENTIAL_RESOLUTION_FAILED', message);
  }
}

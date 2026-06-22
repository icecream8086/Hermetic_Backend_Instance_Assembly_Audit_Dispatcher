import { describe, it, expect } from 'vitest';
import {
  ProviderResolutionError,
  ProviderOperationError,
  CredentialResolutionError,
} from '../../../src/core/provider/errors.ts';

describe('ProviderResolutionError', () => {
  it('has statusCode 503 and code PROVIDER_RESOLUTION_FAILED', () => {
    const err = new ProviderResolutionError('resolver down', 'i-abc');
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('PROVIDER_RESOLUTION_FAILED');
    expect(err.message).toContain('resolver down');
  });

  it('preserves instanceId and platform in public fields', () => {
    const err = new ProviderResolutionError('no provider', 'i-xyz', 'alibaba');
    expect(err.instanceId).toBe('i-xyz');
    expect(err.platform).toBe('alibaba');
  });

  it('platform is optional (undefined when omitted)', () => {
    const err = new ProviderResolutionError('generic resolution failure');
    expect(err.instanceId).toBeUndefined();
    expect(err.platform).toBeUndefined();
  });

  it('is an instance of Error and AppError', () => {
    const err = new ProviderResolutionError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AppError');
  });
});

describe('ProviderOperationError', () => {
  it('has statusCode 502 and code PROVIDER_OPERATION_FAILED', () => {
    const err = new ProviderOperationError('ECI describe failed', 'describe', 'p-123', 'alibaba');
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe('PROVIDER_OPERATION_FAILED');
  });

  it('preserves operation name, providerId, and platform', () => {
    const err = new ProviderOperationError('timeout', 'delete', 'prov_abc', 'alibaba');
    expect(err.operation).toBe('delete');
    expect(err.providerId).toBe('prov_abc');
    expect(err.providerPlatform).toBe('alibaba');
  });

  it('all fields are optional beyond message and operation', () => {
    const err = new ProviderOperationError('generic fail', 'create');
    expect(err.operation).toBe('create');
    expect(err.providerId).toBeUndefined();
    expect(err.providerPlatform).toBeUndefined();
  });
});

describe('CredentialResolutionError', () => {
  it('has statusCode 401 and code CREDENTIAL_RESOLUTION_FAILED', () => {
    const err = new CredentialResolutionError('missing keys', 'cred_xxx', 'i-abc');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('CREDENTIAL_RESOLUTION_FAILED');
  });

  it('preserves credentialRef and instanceId', () => {
    const err = new CredentialResolutionError('cred not found', 'eci_profile@account1', 'i-inst1');
    expect(err.credentialRef).toBe('eci_profile@account1');
    expect(err.instanceId).toBe('i-inst1');
  });

  it('fields are optional', () => {
    const err = new CredentialResolutionError('no env vars set');
    expect(err.credentialRef).toBeUndefined();
    expect(err.instanceId).toBeUndefined();
  });

  it('message describes what was missing', () => {
    const err = new CredentialResolutionError(
      'Credential "cred_abc" not found or missing access keys for instance i-1',
      'cred_abc',
      'i-1',
    );
    expect(err.message).toContain('cred_abc');
    expect(err.message).toContain('i-1');
  });
});

describe('Error propagation compatibility', () => {
  it('all three error types expose statusCode for handler errorStatus() extraction', () => {
    const errors = [
      new ProviderResolutionError('a'),
      new ProviderOperationError('b', 'op'),
      new CredentialResolutionError('c'),
    ];
    for (const e of errors) {
      expect(typeof e.statusCode).toBe('number');
      expect(e.statusCode).toBeGreaterThanOrEqual(400);
      expect(typeof e.code).toBe('string');
    }
  });

  it('status codes are distinct for different failure modes', () => {
    // 401 = credential, 502 = provider operation, 503 = provider resolution
    expect(new CredentialResolutionError('x').statusCode).toBe(401);
    expect(new ProviderOperationError('x', 'op').statusCode).toBe(502);
    expect(new ProviderResolutionError('x').statusCode).toBe(503);
  });
});

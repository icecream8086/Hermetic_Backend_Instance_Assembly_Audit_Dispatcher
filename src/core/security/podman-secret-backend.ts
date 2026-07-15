/**
 * PodmanSecretBackend — implements PlatformSecretBackend via the Podman libpod REST API.
 *
 * Uses the same direct fetch() pattern as PodmanContainerProvider.
 * The libpod secrets endpoints live at the root (not under /v1.24).
 */

import type { PlatformSecretBackend, PlatformSecretParams, PlatformUpsertResult } from './secret-provisioner.ts';
import { z } from 'zod';

export class PodmanSecretBackend implements PlatformSecretBackend {
  public readonly platform = 'podman' as const;
  readonly #apiBase: string;

  /**
   * @param apiBase - Podman API root URL, e.g. "http://127.0.0.1:8080".
   *                  Should NOT include the Docker v1.24 path suffix.
   */
  public constructor(apiBase: string) {
    this.#apiBase = apiBase;
  }

  public async upsert(params: PlatformSecretParams): Promise<PlatformUpsertResult> {
    const secretData = Object.values(params.data).join('\n');

    const body: Record<string, unknown> = {
      name: params.name,
      data: btoa(secretData),
    };
    if (params.labels && Object.keys(params.labels).length > 0) {
      body.labels = params.labels;
    }

    let result: PlatformUpsertResult;
    try {
      const resp = await fetch(`${this.#apiBase}/libpod/secrets/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.text();
        result = {
          platformRef: '',
          ok: false,
          error: `Podman secret create failed (${String(resp.status)}): ${err}`,
        };
      } else {
        const parsed = z.object({ ID: z.string() }).parse(await resp.json());
        result = { platformRef: parsed.ID, ok: true };
      }
    } catch (err: unknown) {
      result = {
        platformRef: '',
        ok: false,
        error: `Podman secret create error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return result;
  }

  public async remove(platformRef: string): Promise<void> {
    const resp = await fetch(`${this.#apiBase}/libpod/secrets/${encodeURIComponent(platformRef)}`, {
      method: 'DELETE',
    });
    if (!resp.ok && resp.status !== 404) {
      const err = await resp.text();
      throw new Error(`Podman secret remove failed (${String(resp.status)}): ${err}`);
    }
  }

  public async exists(platformRef: string): Promise<boolean> {
    let ok = false;
    try {
      const resp = await fetch(`${this.#apiBase}/libpod/secrets/${encodeURIComponent(platformRef)}/json`);
      ok = resp.ok;
    } catch (_err: unknown) {
      console.error('exists check failed:', _err);
    }
    return ok;
  }
}

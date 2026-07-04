/**
 * PodmanSecretBackend — implements PlatformSecretBackend via the Podman libpod REST API.
 *
 * Uses the same direct fetch() pattern as PodmanContainerProvider.
 * The libpod secrets endpoints live at the root (not under /v1.24).
 */

import type { PlatformSecretBackend, PlatformSecretParams, PlatformUpsertResult } from './secret-provisioner.ts';

export class PodmanSecretBackend implements PlatformSecretBackend {
  readonly platform = 'podman' as const;
  readonly #apiBase: string;

  /**
   * @param apiBase - Podman API root URL, e.g. "http://127.0.0.1:8080".
   *                  Should NOT include the Docker v1.24 path suffix.
   */
  constructor(apiBase: string) {
    this.#apiBase = apiBase;
  }

  async upsert(params: PlatformSecretParams): Promise<PlatformUpsertResult> {
    const secretData = Object.values(params.data).join('\n');

    const body: Record<string, unknown> = {
      name: params.name,
      data: btoa(secretData),
    };
    if (params.labels && Object.keys(params.labels).length > 0) {
      body.labels = params.labels;
    }

    try {
      const resp = await fetch(`${this.#apiBase}/libpod/secrets/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.text();
        return {
          platformRef: '',
          ok: false,
          error: `Podman secret create failed (${String(resp.status)}): ${err}`,
        };
      }

      const result = await resp.json() as { ID: string };
      return { platformRef: result.ID, ok: true };
    } catch (err: unknown) {
      return {
        platformRef: '',
        ok: false,
        error: `Podman secret create error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async remove(platformRef: string): Promise<void> {
    const resp = await fetch(`${this.#apiBase}/libpod/secrets/${encodeURIComponent(platformRef)}`, {
      method: 'DELETE',
    });
    if (!resp.ok && resp.status !== 404) {
      const err = await resp.text();
      throw new Error(`Podman secret remove failed (${String(resp.status)}): ${err}`);
    }
  }

  async exists(platformRef: string): Promise<boolean> {
    try {
      const resp = await fetch(`${this.#apiBase}/libpod/secrets/${encodeURIComponent(platformRef)}/json`);
      return resp.ok;
    } catch {
      return false;
    }
  }
}

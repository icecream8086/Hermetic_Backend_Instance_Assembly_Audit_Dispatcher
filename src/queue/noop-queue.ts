import type { IMessageQueue } from './interfaces.ts';

/**
 * No-op message queue — always returns false, available = false.
 *
 * Used when no Queue binding is present (e.g. `npm run dev` without wrangler).
 * Callers detect `available === false` or `send() === false` and fall back
 * to inline execution.
 */
export class NoopMessageQueue implements IMessageQueue {
  public readonly available: boolean = false;

  public async sendImagePull(): Promise<boolean> { return false; }
  public async sendSandboxGc(): Promise<boolean> { return false; }
  public async sendSandboxProvision(): Promise<boolean> { return false; }
  public async sendBucketKeyRotate(): Promise<boolean> { return false; }
  public async send(): Promise<boolean> { return false; }
  public async sendBatch(_messages: any[]): Promise<number> { return 0; }
}

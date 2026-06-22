import type { IMessageQueue } from './interfaces.ts';

/**
 * No-op message queue — always returns false, available = false.
 *
 * Used when no Queue binding is present (e.g. `npm run dev` without wrangler).
 * Callers detect `available === false` or `send() === false` and fall back
 * to inline execution.
 */
export class NoopMessageQueue implements IMessageQueue {
  get available(): boolean { return false; }

  async sendImagePull(): Promise<boolean> { return false; }
  async sendSandboxGc(): Promise<boolean> { return false; }
  async sendSandboxProvision(): Promise<boolean> { return false; }
  async sendBucketKeyRotate(): Promise<boolean> { return false; }
  async send(): Promise<boolean> { return false; }
  async sendBatch(_messages: Array<any>): Promise<number> { return 0; }
}

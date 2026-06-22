/// <reference types="@cloudflare/workers-types" />

import type { IMessageQueue } from './interfaces.ts';
import type { TaskMessage, TaskType, ImagePullPayload, SandboxGcPayload, SandboxProvisionPayload, BucketKeyRotatePayload } from './types.ts';

/**
 * Cloudflare Queues producer — wraps the platform Queue binding.
 *
 * When the binding is unavailable, degrades to returning false from every
 * send method (equivalent to NoopMessageQueue).  Callers must check the
 * return value and fall back to inline execution.
 */
export class CfQueueProducer implements IMessageQueue {
  readonly #queue: Queue<TaskMessage> | null;

  constructor(queueBinding?: Queue<TaskMessage>) {
    this.#queue = queueBinding ?? null;
  }

  get available(): boolean {
    return this.#queue !== null;
  }

  async sendImagePull(payload: ImagePullPayload): Promise<boolean> {
    return this.#send(this.#message('image:pull', payload));
  }

  async sendSandboxGc(payload: SandboxGcPayload): Promise<boolean> {
    return this.#send(this.#message('sandbox:gc', payload));
  }

  async sendSandboxProvision(payload: SandboxProvisionPayload): Promise<boolean> {
    return this.#send(this.#message('sandbox:provision', payload));
  }

  async sendBucketKeyRotate(payload: BucketKeyRotatePayload): Promise<boolean> {
    return this.#send(this.#message('bucket-key:rotate', payload));
  }

  async send(message: TaskMessage): Promise<boolean> {
    return this.#send(message);
  }

  async sendBatch(messages: TaskMessage[]): Promise<number> {
    if (!this.#queue || messages.length === 0) return 0;
    try {
      const batch = messages.map(m => ({ body: m }));
      await this.#queue.sendBatch(batch);
      return messages.length;
    } catch (err) {
      console.error('[cf-queue] sendBatch failed:', err instanceof Error ? err.message : err);
      return 0;
    }
  }

  // ─── Internal ───

  async #send(message: TaskMessage): Promise<boolean> {
    if (!this.#queue) return false;
    try {
      await this.#queue.send(message);
      return true;
    } catch (err) {
      console.error('[cf-queue] send failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  #message<T>(type: TaskType, payload: T): TaskMessage {
    return {
      type,
      payload: payload as TaskMessage['payload'],
      timestamp: Date.now(),
      id: crypto.randomUUID(),
    };
  }
}

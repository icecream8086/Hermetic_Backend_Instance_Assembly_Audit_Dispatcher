import type {
  TaskMessage,
  ImagePullPayload,
} from './types.ts';

/**
 * Abstract message queue — producer side.
 *
 * Decouples callers from the concrete transport (Cloudflare Queues,
 * in-process EventLoop, no-op stub).  Implementations:
 *   - CfQueueProducer — wraps Cloudflare Queue binding
 *   - NoopMessageQueue  — always returns false (dev without wrangler)
 */
export interface IMessageQueue {
  /** Whether the queue backend is live and can accept messages. */
  readonly available: boolean;

  /** Enqueue a typed image:pull task. Returns false if unavailable or failed. */
  sendImagePull(payload: ImagePullPayload): Promise<boolean>;

  /** Enqueue an arbitrary message. Used by generic dispatch paths. */
  send(message: TaskMessage): Promise<boolean>;

  /** Enqueue multiple messages in one batch. Returns count successfully sent. */
  sendBatch(messages: TaskMessage[]): Promise<number>;
}

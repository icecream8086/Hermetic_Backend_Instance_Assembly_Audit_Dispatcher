import type { EventBus } from '../event-bus/bus.ts';
import type { IAtomicStore } from '../store/interfaces.ts';
import type { IProviderRegistry } from '../provider/interfaces.ts';
import type { IMessageQueue } from '../../queue/interfaces.ts';
import type { SecretEncryption } from '../auth/secret-encryption.ts';
import { CredentialService } from '../auth/credential.ts';

export interface ImagePullDeps {
  atomic: IAtomicStore;
  providers: IProviderRegistry;
  eventBus: EventBus;
  queueProducer: IMessageQueue;
  secretEncryption?: SecretEncryption;
}

/**
 * Register the image.pull handler on the event bus.
 *
 * Pulls are dispatched to Queue first; falls back to inline execution
 * when the Queue binding is unavailable.
 */
export function registerImagePullHandler(deps: ImagePullDeps): void {
  const { atomic, providers, eventBus, queueProducer, secretEncryption } = deps;

  eventBus.on('image.pull', async (event: { type: string; payload?: unknown }) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload) return;
    const { taskId, image, instanceId, clusterId, credentialRef, registryCredential } = payload as {
      taskId?: string; image?: string; instanceId?: string; clusterId?: string;
      credentialRef?: string; registryCredential?: { server: string; userName: string; password: string };
    };
    if (!taskId || !image) return;

    const entry = await atomic.get<any>('pull-task:' + taskId);
    if (!entry) return;
    const taskBase = { id: taskId, repositoryId: entry.value.repositoryId, image, createdAt: entry.value.createdAt };

    // Try queue dispatch first
    const qSent = await queueProducer.sendImagePull({
      taskId, image,
      ...(instanceId ? { instanceId } : {}),
      ...(clusterId ? { clusterId } : {}),
      ...(credentialRef ? { credentialRef } : {}),
      ...(registryCredential ? { registryCredential } : {}),
    });
    if (qSent) {
      await atomic.set('pull-task:' + taskId, {
        ...taskBase, status: 'queued', queuedAt: Date.now(),
      }, entry.version);
      return;
    }

    // Queue unavailable — inline pull
    try {
      const imgProvider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
      let credArg: string | { server: string; userName: string; password: string } | undefined = clusterId;
      if (credentialRef) {
        const credSvc = new CredentialService(atomic, secretEncryption);
        const managed = await credSvc.findByName(credentialRef);
        if (managed?.registryCredentials?.length) {
          credArg = { server: managed.registryCredentials[0]!.server, userName: managed.registryCredentials[0]!.userName, password: managed.registryCredentials[0]!.password };
        }
      } else if (registryCredential) {
        credArg = registryCredential;
      }
      const info = await imgProvider.pull(image, credArg as any);
      await atomic.set('pull-task:' + taskId, {
        ...taskBase, status: 'completed', result: { id: info.id, tags: [...info.tags] }, completedAt: Date.now(),
      }, entry.version);
    } catch (e: any) {
      console.error(`[pull-task] ${taskId} failed:`, e.message);
      await atomic.set('pull-task:' + taskId, {
        ...taskBase, status: 'failed', error: e.message, failedAt: Date.now(),
      }, entry.version);
    }
  });
}

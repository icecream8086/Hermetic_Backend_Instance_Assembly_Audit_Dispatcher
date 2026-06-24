import type { ITaskExecutor, Task, TaskInstance, TaskExecutionResult } from '../../core/dag/types.ts';
import type { IBlobStore } from '../../core/store/interfaces.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { EventBus } from '../../core/event-bus/bus.ts';
import type { RunStepDef, UsesStepDef, StepDef, ActionContainerConfig } from './types.ts';
import { executeDnsStep } from './step-dns.ts';
import { appendStepLog } from './logs.ts';
import { ActionRegistry } from './registry.ts';
import { createEvent } from '../../core/event-bus/types.ts';

/**
 * JobOperator — executes a GitHub Actions–style Job as a single Task.
 *
 * This is the bridge between the Airflow scheduler and the existing
 * step-execution infrastructure. It provisions a sandbox and runs
 * the job's steps inside it.
 */
export class JobOperator implements ITaskExecutor {
  readonly key = 'sandbox';

  constructor(
    private readonly deps: {
      stores: { blob: IBlobStore };
      providers: Pick<IProviderRegistry, 'resolveContainer' | 'dns'>;
      audit: IAuditWriter;
      eventBus?: EventBus;
      actionRegistry?: ActionRegistry;
    },
  ) {}

  async execute(_task: Task, ti: TaskInstance): Promise<TaskExecutionResult> {
    const config = _task.config as {
      jobName: string;
      needs: string[];
      steps: StepDef[];
      env: Record<string, string>;
      timeout?: number;
      container?: ActionContainerConfig;
      containers?: readonly (ActionContainerConfig & { name: string })[];
      instanceId?: string;
      region?: string;
      approval?: { approvers: readonly string[]; message?: string };
    };

    const jobName = config.jobName;
    const steps = config.steps;

    try {
      // Provision sandbox
      const sandboxId = await this.provisionSandbox(config);

      // Execute steps sequentially
      for (const step of steps) {
        const name = step.name ?? this.stepLabel(step);
        await appendStepLog(this.deps.stores.blob, ti.id, name, `Step started: ${name}`);
        this.deps.audit.write({
          level: 6, facility: 'job-operator',
          message: `Step ${name} started for ${jobName}`,
          metadata: { taskInstanceId: ti.id, stepName: name },
        } as any);

        try {
          if ('run' in step) {
            await this.executeRunStep(step, config.env, sandboxId);
          } else if ('dns' in step) {
            await executeDnsStep(step, this.deps.providers.dns, this.deps.audit);
          } else if ('uses' in step) {
            await this.executeUsesStep(step, config.env, sandboxId);
          }
          await appendStepLog(this.deps.stores.blob, ti.id, name, `Step completed: ${name}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await appendStepLog(this.deps.stores.blob, ti.id, name, `Step FAILED: ${msg}`);
          this.deps.audit.write({
            level: 3, facility: 'job-operator',
            message: `Step ${name} failed: ${msg}`,
            metadata: { taskInstanceId: ti.id, stepName: name, error: msg },
          } as any);

          if (step.continueOnError) continue;
          return { success: false, error: msg, exitCode: 1 };
        }
      }

      // Emit completion event
      if (this.deps.eventBus) {
        const evt = createEvent('workflow:job:status', {
          jobRunId: ti.id, jobName,
          workflowRunId: ti.dagRunId,
          status: 'Success',
        });
        await this.deps.eventBus.dispatch(evt);
      }

      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, exitCode: 1 };
    }
  }

  private stepLabel(step: StepDef): string {
    if ('run' in step) return step.run.slice(0, 60);
    if ('dns' in step) return `dns:${step.dns.name}`;
    return step.uses ?? 'unknown';
  }

  private async provisionSandbox(config: any): Promise<string> {
    const instanceId = config.instanceId;
    if (!instanceId || !this.deps.providers.resolveContainer) {
      throw new Error('Job requires an instanceId to resolve a container provider');
    }

    const provider: any = await this.deps.providers.resolveContainer(instanceId);
    const region = config.region ?? 'local';
    const mainContainer = config.containers?.[0] ?? config.container;
    if (!mainContainer) throw new Error('Job has no container defined');

    const env = config.env ?? {};
    const envList = Object.entries(env).map(([name, value]) => ({ name, value })) as any;

    const result = await provider.create({
      name: `action-${config.jobName}-${Date.now()}`,
      region,
      ...(instanceId ? { instanceId } : {}),
      cpu: mainContainer.resources?.cpu ?? 1,
      memory: mainContainer.resources?.memory ?? 1024,
      spotStrategy: 'Never',
      restartPolicy: 'Never',
      containers: [{
        name: config.jobName,
        image: mainContainer.image,
        command: mainContainer.command ? [...mainContainer.command] : undefined,
        args: mainContainer.args ? [...mainContainer.args] : undefined,
        env: envList,
        ports: mainContainer.ports ? [...mainContainer.ports] : undefined,
        workingDir: mainContainer.workingDir,
        resources: mainContainer.resources ? { cpu: mainContainer.resources.cpu ?? 1, memory: mainContainer.resources.memory ?? 1024 } : { cpu: 1, memory: 2048 },
      }],
      network: { allocatePublicIp: false },
    });

    return result.providerId;
  }

  private async executeRunStep(
    step: RunStepDef,
    env: Record<string, string>,
    sandboxId: string,
  ): Promise<void> {
    const provider = await this.deps.providers.resolveContainer?.(undefined) as any;
    if (typeof provider?.exec !== 'function') return;

    const shell = step.shell ?? '/bin/sh';
    const mergedEnv = Object.entries({ ...env, ...step.env }).map(([k, v]) => `${k}=${v}`);

    const result = await provider.exec({
      providerId: sandboxId,
      command: [shell, '-c', step.run],
      env: mergedEnv,
      timeout: step.timeout ? step.timeout * 1000 : undefined,
    });

    if (result?.exitCode !== 0) {
      throw new Error(`Command exited with ${result?.exitCode ?? -1}: ${step.run.slice(0, 200)}`);
    }
  }

  private async executeUsesStep(
    step: UsesStepDef,
    env: Record<string, string>,
    sandboxId: string,
  ): Promise<void> {
    const registry = this.deps.actionRegistry;
    const provider = await this.deps.providers.resolveContainer?.(undefined) as any;

    if (!registry && typeof provider?.exec !== 'function') {
      throw new Error(`Cannot execute uses: step — no action registry or provider exec`);
    }

    const resolved = registry ? await registry.resolve(step.uses) : null;
    if (resolved && typeof provider?.exec === 'function') {
      const mergedEnv = { ...env, ...step.env, ...step.with };
      const envList = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);
      const cmd = resolved.entrypoint ?? ['/bin/sh', '-c', `echo 'Action: ${step.uses}'`];
      const result = await provider.exec({
        providerId: sandboxId,
        command: cmd,
        env: envList,
        timeout: step.timeout ? step.timeout * 1000 : undefined,
      });
      if (result?.exitCode !== 0) {
        throw new Error(`Action ${step.uses} failed with exit ${result?.exitCode}`);
      }
    } else if (typeof provider?.exec === 'function') {
      const mergedEnv = { ...env, ...step.env, ...step.with };
      const envList = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);
      const result = await provider.exec({
        providerId: sandboxId,
        command: ['/bin/sh', '-c', `echo 'Running action: ${step.uses}'`],
        env: envList,
        timeout: step.timeout ? step.timeout * 1000 : undefined,
      });
      if (result?.exitCode !== 0) {
        throw new Error(`Action ${step.uses} failed with exit ${result?.exitCode}`);
      }
    } else {
      throw new Error(`Action not found: ${step.uses}`);
    }
  }
}

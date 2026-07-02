import { z } from 'zod';
import type { ITaskExecutor, Task, TaskInstance, TaskExecutionResult } from '../../core/dag/types.ts';
import type { IBlobStore } from '../../core/store/interfaces.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { EventBus } from '../../core/event-bus/bus.ts';
import type { RunStepDef, UsesStepDef, StepDef, ActionContainerConfig } from './types.ts';
import { executeDnsStep } from './step-dns.ts';
import { appendStepLog } from './logs.ts';
import type { ActionRegistry } from './registry.ts';
import { createEvent } from '../../core/event-bus/types.ts';
import type { PodService } from '../../core/pod/service.ts';
import type { PodSpec } from '../../core/pod/types.ts';

/** Provider with exec support for step-level container execution. */
interface ExecProvider {
  exec?(opts: {
    providerId: string;
    command: readonly string[];
    env: readonly string[];
    timeout: number | undefined;
  }): Promise<{ exitCode: number }>;
}

/**
 * JobOperator — executes a GitHub Actions–style Job as a single Task.
 *
 * This is the bridge between the Airflow scheduler and the existing
 * step-execution infrastructure. It provisions a sandbox and runs
 * the job's steps inside it.
 */
export class JobOperator implements ITaskExecutor {
  public readonly key = 'sandbox';

  public constructor(
    private readonly deps: {
      stores: { blob: IBlobStore };
      // eslint-disable-next-line @typescript-eslint/no-restricted-types -- slim dependency interface: only two methods needed from IProviderRegistry
      providers: Pick<IProviderRegistry, 'resolveContainer' | 'dns'>;
      audit: IAuditWriter;
      eventBus?: EventBus;
      actionRegistry?: ActionRegistry;
      podService?: PodService;
    },
  ) {}

  public async execute(_task: Task, ti: TaskInstance): Promise<TaskExecutionResult> {
    const config = z.custom<{
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
    }>().parse(_task.config);

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
        });

        try {
          if (step.run != null) {
            await this.executeRunStep(step, config.env, sandboxId);
          } else if (step.dns != null) {
            await executeDnsStep(step, this.deps.providers.dns, this.deps.audit);
          } else if (step.uses != null) {
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
          });

          if (step.continueOnError) continue;
          const stepResult = { success: false, error: msg, exitCode: 1 };
          return stepResult;
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
      const _r = { success: false, error: msg, exitCode: 1 };
      return _r;
    }
  }

  private stepLabel(step: StepDef): string {
    if ('run' in step && step.run != null) return step.run.slice(0, 60);
    if ('dns' in step && step.dns != null) return `dns:${step.dns.name}`;
    if ('uses' in step) return step.uses;
    return '';
  }

  private async provisionSandbox(config: {
    jobName: string;
    env: Record<string, string>;
    container?: ActionContainerConfig;
    containers?: readonly (ActionContainerConfig & { name: string })[];
    instanceId?: string;
    region?: string;
  }): Promise<string> {
    const mainContainer: ActionContainerConfig | undefined = config.containers?.[0] ?? config.container;
    if (!mainContainer) throw new Error('Job has no container defined');

    const env = config.env ?? {};
    const envList = Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));

    // v3 path: PodService.provision() → PodEntity with lifecycle tracking
    if (this.deps.podService) {
      const podSpec: PodSpec = {
        metadata: {
          name: `action-${String(config.jobName)}-${String(Date.now())}`,
          labels: { job: config.jobName, owner: 'actions' },
        },
        spec: {
          containers: [{
            name: config.jobName,
            image: mainContainer.image,
            command: mainContainer.command ? [...mainContainer.command] : undefined,
            args: mainContainer.args ? [...mainContainer.args] : undefined,
            env: envList.length > 0 ? envList : undefined,
            ports: mainContainer.ports ? [...mainContainer.ports] : undefined,
            resources: mainContainer.resources ? {
              limits: {
                cpu: mainContainer.resources.cpu ?? 1,
                memory: mainContainer.resources.memory ?? 1024,
              },
            } : undefined,
          }],
          restartPolicy: 'Never',
        },
      };
      const pod = await this.deps.podService.provision(podSpec);
      return pod.providerId ?? pod.podId;
    }

    // v2 fallback: direct provider.create()
    const instanceId = config.instanceId;
    if (!instanceId) {
      throw new Error('Job requires an instanceId to resolve a container provider');
    }

    const provider = await this.deps.providers.resolveContainer(instanceId);
    const region = config.region ?? 'local';

    const result = await provider.create({
      name: `action-${String(config.jobName)}-${String(Date.now())}`,
      region,
      ...(instanceId ? { instanceId } : {}),
      cpu: mainContainer.resources?.cpu ?? 1,
      memory: mainContainer.resources?.memory ?? 1024,
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
    const provider = z.custom<ExecProvider>().parse(await this.deps.providers.resolveContainer(undefined));
    if (provider?.exec == null) return;

    const shell = step.shell ?? '/bin/sh';
    const mergedEnv = Object.entries({ ...env, ...step.env }).map(([k, v]) => `${k}=${v}`);

    const result = await provider.exec({
      providerId: sandboxId,
      command: [shell, '-c', step.run],
      env: mergedEnv,
      timeout: step.timeout ? step.timeout * 1000 : undefined,
    });

    if (result?.exitCode !== 0) {
      throw new Error(`Command exited with ${String(result?.exitCode ?? -1)}: ${step.run.slice(0, 200)}`);
    }
  }

  private async executeUsesStep(
    step: UsesStepDef,
    env: Record<string, string>,
    sandboxId: string,
  ): Promise<void> {
    const registry = this.deps.actionRegistry;
    const provider = z.custom<ExecProvider>().parse(await this.deps.providers.resolveContainer(undefined));

    if (!registry && provider?.exec == null) {
      throw new Error(`Cannot execute uses: step — no action registry or provider exec`);
    }

    const resolved = registry ? await registry.resolve(step.uses) : null;
    if (resolved && provider?.exec != null) {
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
        throw new Error(`Action ${String(step.uses)} failed with exit ${String(result?.exitCode)}`);
      }
    } else if (provider?.exec != null) {
      const mergedEnv = { ...env, ...step.env, ...step.with };
      const envList = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);
      const result = await provider.exec({
        providerId: sandboxId,
        command: ['/bin/sh', '-c', `echo 'Running action: ${step.uses}'`],
        env: envList,
        timeout: step.timeout ? step.timeout * 1000 : undefined,
      });
      if (result?.exitCode !== 0) {
        throw new Error(`Action ${String(step.uses)} failed with exit ${String(result?.exitCode)}`);
      }
    } else {
      throw new Error(`Action not found: ${step.uses}`);
    }
  }
}

import type { IAtomicStore } from '../../core/store/interfaces.ts';
import { AppError } from '../../core/types.ts';
import { generateVersionId } from '../../core/brand.ts';
import type { VersionId } from '../../core/brand.ts';

// ═══════════════════════════════════════════════════════════════
// Extension types — pluggable metadata for all Action entities
// ═══════════════════════════════════════════════════════════════

/**
 * Extensible metadata contract shared by all Action entities.
 * Every entity exposes `metadata` (arbitrary JSON) and `annotations`
 * (string key-value pairs, e.g. for label selectors).
 */
export interface ExtensibleEntity {
  readonly id: string;
  readonly metadata?: Record<string, unknown>;
  readonly annotations?: Readonly<Record<string, string>>;
}

export interface CreateOrgInput {
  readonly name: string;
  readonly displayName?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly displayName?: string;
  readonly ownerId: string;
  readonly memberIds: readonly string[];
  readonly adminIds: readonly string[];
  readonly projectIds: readonly string[];
  /** Resource quotas for this org. */
  readonly quotas: OrgQuota;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: VersionId;
}

export interface OrgQuota {
  readonly maxWorkflows: number;    // 0 = unlimited
  readonly maxRunners: number;
  readonly maxConcurrentRuns: number;
  readonly maxSharedLinks: number;
  readonly maxSecretsPerWorkflow: number;
}

export const DEFAULT_ORG_QUOTA: OrgQuota = {
  maxWorkflows: 0,
  maxRunners: 5,
  maxConcurrentRuns: 10,
  maxSharedLinks: 20,
  maxSecretsPerWorkflow: 50,
};

export interface CreateProjectInput {
  readonly orgId: string;
  readonly name: string;
  readonly displayName?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface Project {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly displayName?: string;
  readonly ownerId: string;
  readonly memberIds: readonly string[];
  readonly quotas: OrgQuota; // inherits from org, can be overridden
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: VersionId;
}

// ─── Approval node ───

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalNode {
  readonly id: string;
  readonly workflowRunId: string;
  readonly jobName: string;
  readonly approvers: readonly string[]; // userIds who can approve
  readonly status: ApprovalStatus;
  readonly reason?: string;
  readonly requestedAt: number;
  readonly decidedAt?: number;
  readonly decidedBy?: string;
  readonly version: VersionId;
}

const PFX_ORG = 'action-org:';
const PFX_PROJ = 'action-project:';
const PFX_APPROVAL = 'action-approval:';
const IDX_ORG = 'action-org:ids';
const IDX_PROJ = 'action-project:ids';
const IDX_APPROVAL = 'action-approval:ids';

// ═══════════════════════════════════════════════════════════════
// Organization service
// ═══════════════════════════════════════════════════════════════

export class OrgService {
  public constructor(private readonly atomic: IAtomicStore) {}

  public async create(ownerId: string, input: CreateOrgInput): Promise<Organization> {
    const id = `org_${crypto.randomUUID()}`;
    const now = Date.now();
    const org: Organization = {
      id, name: input.name,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ownerId, memberIds: [ownerId], adminIds: [ownerId], projectIds: [],
      quotas: DEFAULT_ORG_QUOTA,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: now, updatedAt: now, version: generateVersionId(),
    };
    await this.atomic.set(PFX_ORG + id, org, null);
    await this.#addToIdx(IDX_ORG, id);
    return org;
  }

  public async get(id: string): Promise<Organization | null> {
    const e = await this.atomic.get<Organization>(PFX_ORG + id);
    return e?.value ?? null;
  }

  public async list(memberId?: string): Promise<Organization[]> {
    const idx = await this.atomic.get<string[]>(IDX_ORG);
    if (!idx) return [];
    const entries = (await Promise.all(idx.value.map(i => this.atomic.get<Organization>(PFX_ORG + i))))
      .filter(e => e).map(e => e!.value);
    return memberId ? entries.filter(o => o.memberIds.includes(memberId)) : entries;
  }

  public async addMember(orgId: string, userId: string): Promise<void> {
    const e = await this.atomic.get<Organization>(PFX_ORG + orgId);
    if (!e) throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    if (e.value.memberIds.includes(userId)) return;
    const updated: Organization = { ...e.value, memberIds: [...e.value.memberIds, userId], updatedAt: Date.now(), version: generateVersionId() };
    await this.atomic.set(PFX_ORG + orgId, updated, e.version);
  }

  public async addProject(orgId: string, projectId: string): Promise<void> {
    const e = await this.atomic.get<Organization>(PFX_ORG + orgId);
    if (!e) throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    const updated: Organization = { ...e.value, projectIds: [...e.value.projectIds, projectId], updatedAt: Date.now(), version: generateVersionId() };
    await this.atomic.set(PFX_ORG + orgId, updated, e.version);
  }

  public async #addToIdx(key: string, id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(key);
    await this.atomic.set(key, [...(idx?.value ?? []), id], idx?.version ?? null);
  }
}

// ═══════════════════════════════════════════════════════════════
// Project service
// ═══════════════════════════════════════════════════════════════

export class ProjectService {
  public constructor(private readonly atomic: IAtomicStore, private readonly orgService: OrgService) {}

  public async create(ownerId: string, input: CreateProjectInput): Promise<Project> {
    const org = await this.orgService.get(input.orgId);
    if (!org) throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');

    const id = `proj_${crypto.randomUUID()}`;
    const now = Date.now();
    const proj: Project = {
      id, orgId: input.orgId, name: input.name,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ownerId, memberIds: [ownerId], quotas: org.quotas,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: now, updatedAt: now, version: generateVersionId(),
    };
    await this.atomic.set(PFX_PROJ + id, proj, null);
    await this.orgService.addProject(input.orgId, id);
    await this.#addToIdx(IDX_PROJ, id);
    return proj;
  }

  public async get(id: string): Promise<Project | null> {
    const e = await this.atomic.get<Project>(PFX_PROJ + id);
    return e?.value ?? null;
  }

  public async list(orgId: string): Promise<Project[]> {
    const idx = await this.atomic.get<string[]>(IDX_PROJ);
    if (!idx) return [];
    const entries = (await Promise.all(idx.value.map(i => this.atomic.get<Project>(PFX_PROJ + i))))
      .filter(e => e).map(e => e!.value);
    return entries.filter(p => p.orgId === orgId);
  }

  public async #addToIdx(key: string, id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(key);
    await this.atomic.set(key, [...(idx?.value ?? []), id], idx?.version ?? null);
  }
}

// ═══════════════════════════════════════════════════════════════
// Approval service
// ═══════════════════════════════════════════════════════════════

export class ApprovalService {
  public constructor(private readonly atomic: IAtomicStore) {}

  public async request(runId: string, jobName: string, approvers: string[]): Promise<ApprovalNode> {
    const id = `aprv_${crypto.randomUUID()}`;
    const now = Date.now();
    const node: ApprovalNode = {
      id, workflowRunId: runId, jobName, approvers,
      status: 'pending', requestedAt: now, version: generateVersionId(),
    };
    await this.atomic.set(PFX_APPROVAL + id, node, null);
    await this.#addToIdx(IDX_APPROVAL, id);
    return node;
  }

  public async decide(id: string, userId: string, approved: boolean, reason?: string): Promise<ApprovalNode> {
    const e = await this.atomic.get<ApprovalNode>(PFX_APPROVAL + id);
    if (!e) throw new AppError(404, 'APPROVAL_NOT_FOUND', 'Approval not found');
    if (!e.value.approvers.includes(userId)) throw new AppError(403, 'NOT_APPROVER', 'You are not an approver');
    if (e.value.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', 'Approval already decided');

    const now = Date.now();
    const updated: ApprovalNode = {
      ...e.value, status: approved ? 'approved' : 'rejected',
      ...(reason ? { reason } : {}),
      decidedAt: now, decidedBy: userId, version: generateVersionId(),
    };
    await this.atomic.set(PFX_APPROVAL + id, updated, e.version);
    return updated;
  }

  public async getForRun(runId: string): Promise<ApprovalNode[]> {
    const idx = await this.atomic.get<string[]>(IDX_APPROVAL);
    if (!idx) return [];
    const entries = (await Promise.all(idx.value.map(i => this.atomic.get<ApprovalNode>(PFX_APPROVAL + i))))
      .filter(e => e?.value.workflowRunId === runId).map(e => e!.value);
    return entries;
  }

  public async #addToIdx(key: string, id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(key);
    await this.atomic.set(key, [...(idx?.value ?? []), id], idx?.version ?? null);
  }
}

/**
 * Alibaba Cloud CR (Container Registry) OpenAPI client — full coverage.
 *
 * API version: 2018-12-01
 * Reference: https://api.aliyun.com/meta/v1/products/cr/versions/2018-12-01/api-docs.json
 *
 * All 115 CR OpenAPI operations. All methods require InstanceId (CR EE instance).
 * This is a raw API client — no business logic, no state mapping.
 */

import { z } from 'zod';
import { rpcCall, type RpcParams } from './rpc.ts';

const API = '2018-12-01';

// ═══════════════════════════════════════════════════════════════
//  实例管理 (Instance Management) — 5
// ═══════════════════════════════════════════════════════════════

export class AlibabaCrApiClient {
  public constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly endpoint = 'cr.cn-hangzhou.aliyuncs.com',
  ) {}

  public getInstance(instanceId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetInstance', API, { InstanceId: instanceId });
  }

  public getInstanceUsage(instanceId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetInstanceUsage', API, { InstanceId: instanceId });
  }

  public getInstanceCount(): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetInstanceCount', API, {});
  }

  public listInstance(params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListInstance', API, params ?? {});
  }

  public listInstanceRegion(params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListInstanceRegion', API, params ?? {});
  }

  // ══════════════════════════════════════════════════════════
  //  实例访问控制 (Instance Access Control) — 10
  // ══════════════════════════════════════════════════════════

  public getInstanceEndpoint(instanceId: string, endpointType: string, moduleName?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, EndpointType: endpointType };
    if (moduleName) p.ModuleName = moduleName;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetInstanceEndpoint', API, p);
  }

  public listInstanceEndpoint(instanceId: string, moduleName?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (moduleName) p.ModuleName = moduleName;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListInstanceEndpoint', API, p);
  }

  public getInstanceVpcEndpoint(instanceId: string, moduleName?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (moduleName) p.ModuleName = moduleName;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetInstanceVpcEndpoint', API, p);
  }

  public createInstanceEndpointAclPolicy(instanceId: string, endpointType: string, entry: string, comment?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, EndpointType: endpointType, Entry: entry };
    if (comment) p.Comment = comment;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateInstanceEndpointAclPolicy', API, p);
  }

  public deleteInstanceEndpointAclPolicy(instanceId: string, endpointType: string, entry: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteInstanceEndpointAclPolicy', API, {
      InstanceId: instanceId, EndpointType: endpointType, Entry: entry,
    });
  }

  public createInstanceVpcEndpointLinkedVpc(instanceId: string, vpcId: string, vswitchId: string, moduleName?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, VpcId: vpcId, VswitchId: vswitchId };
    if (moduleName) p.ModuleName = moduleName;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateInstanceVpcEndpointLinkedVpc', API, p);
  }

  public deleteInstanceVpcEndpointLinkedVpc(instanceId: string, vpcId: string, vswitchId: string, moduleName?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, VpcId: vpcId, VswitchId: vswitchId };
    if (moduleName) p.ModuleName = moduleName;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteInstanceVpcEndpointLinkedVpc', API, p);
  }

  public updateInstanceEndpointStatus(instanceId: string, endpointType: string, enable: boolean, moduleName?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, EndpointType: endpointType, Enable: String(enable) };
    if (moduleName) p.ModuleName = moduleName;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateInstanceEndpointStatus', API, p);
  }

  public getInstanceVpcEndpointLinkedVpc(instanceId: string, moduleName?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (moduleName) p.ModuleName = moduleName;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetInstanceVpcEndpointLinkedVpc', API, p);
  }

  public listInstanceEndpointAclPolicy(instanceId: string, endpointType: string, moduleName?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, EndpointType: endpointType };
    if (moduleName) p.ModuleName = moduleName;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListInstanceEndpointAclPolicy', API, p);
  }

  // ══════════════════════════════════════════════════════════
  //  实例存储管理 (Instance Storage) — 4
  // ══════════════════════════════════════════════════════════

  public createStorageDomainRoutingRule(instanceId: string, routes: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateStorageDomainRoutingRule', API, {
      InstanceId: instanceId, Routes: routes,
    });
  }

  public deleteStorageDomainRoutingRule(instanceId: string, ruleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteStorageDomainRoutingRule', API, {
      InstanceId: instanceId, RuleId: ruleId,
    });
  }

  public getStorageDomainRoutingRule(instanceId: string, ruleId?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (ruleId) p.RuleId = ruleId;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetStorageDomainRoutingRule', API, p);
  }

  public updateStorageDomainRoutingRule(instanceId: string, routes: string, ruleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateStorageDomainRoutingRule', API, {
      InstanceId: instanceId, Routes: routes, RuleId: ruleId,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  实例同步管理 (Instance Sync) — 8
  // ══════════════════════════════════════════════════════════

  public createRepoSyncRule(instanceId: string, namespaceName: string, targetRegionId: string, targetInstanceId: string,
    targetNamespaceName: string, tagFilter: string, syncScope: string, syncRuleName: string,
    opts?: { repoName?: string; targetRepoName?: string; repoNameFilter?: string; syncTrigger?: string; targetUserId?: string; linkId?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, NamespaceName: namespaceName, TargetRegionId: targetRegionId, TargetInstanceId: targetInstanceId, TargetNamespaceName: targetNamespaceName, TagFilter: tagFilter, SyncScope: syncScope, SyncRuleName: syncRuleName };
    if (opts?.repoName) p.RepoName = opts.repoName;
    if (opts?.targetRepoName) p.TargetRepoName = opts.targetRepoName;
    if (opts?.repoNameFilter) p.RepoNameFilter = opts.repoNameFilter;
    if (opts?.syncTrigger) p.SyncTrigger = opts.syncTrigger;
    if (opts?.targetUserId) p.TargetUserId = opts.targetUserId;
    if (opts?.linkId) p.LinkId = opts.linkId;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateRepoSyncRule', API, p);
  }

  public createRepoSyncTask(instanceId: string, repoId: string, tag: string, targetRegionId: string, targetInstanceId: string,
    targetNamespace: string, targetRepoName: string, targetTag: string,
    opts?: { targetUserId?: string; override?: boolean }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId, Tag: tag, TargetRegionId: targetRegionId, TargetInstanceId: targetInstanceId, TargetNamespace: targetNamespace, TargetRepoName: targetRepoName, TargetTag: targetTag };
    if (opts?.targetUserId) p.TargetUserId = opts.targetUserId;
    if (opts?.override) p.Override = 'true';
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateRepoSyncTask', API, p);
  }

  public createRepoSyncTaskByRule(instanceId: string, repoId: string, tag: string, syncRuleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateRepoSyncTaskByRule', API, {
      InstanceId: instanceId, RepoId: repoId, Tag: tag, SyncRuleId: syncRuleId,
    });
  }

  public deleteRepoSyncRule(instanceId: string, syncRuleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteRepoSyncRule', API, {
      InstanceId: instanceId, SyncRuleId: syncRuleId,
    });
  }

  public getRepoSyncTask(instanceId: string, syncTaskId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetRepoSyncTask', API, {
      InstanceId: instanceId, SyncTaskId: syncTaskId,
    });
  }

  public listRepoSyncRule(instanceId: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListRepoSyncRule', API, { InstanceId: instanceId, ...params });
  }

  public listRepoSyncTask(instanceId: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListRepoSyncTask', API, { InstanceId: instanceId, ...params });
  }

  public cancelRepoSyncTask(instanceId: string, syncTaskId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CancelRepoSyncTask', API, {
      InstanceId: instanceId, SyncTaskId: syncTaskId,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  镜像命名空间管理 (Namespace) — 5
  // ══════════════════════════════════════════════════════════

  public createNamespace(instanceId: string, namespaceName: string, opts?: { autoCreateRepo?: boolean; defaultRepoType?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, NamespaceName: namespaceName };
    if (opts?.autoCreateRepo) p.AutoCreate = 'true';
    if (opts?.defaultRepoType) p.DefaultVisibility = opts.defaultRepoType;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateNamespace', API, p);
  }

  public getNamespace(instanceId: string, namespaceName?: string, namespaceId?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (namespaceName) p.NamespaceName = namespaceName;
    if (namespaceId) p.NamespaceId = namespaceId;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetNamespace', API, p);
  }

  public listNamespace(instanceId: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListNamespace', API, { InstanceId: instanceId, ...params });
  }

  public updateNamespace(instanceId: string, namespaceName: string, opts?: { autoCreateRepo?: boolean; defaultRepoType?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, NamespaceName: namespaceName };
    if (opts?.autoCreateRepo !== undefined) p.AutoCreate = String(opts.autoCreateRepo);
    if (opts?.defaultRepoType) p.DefaultRepoType = opts.defaultRepoType;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateNamespace', API, p);
  }

  public deleteNamespace(instanceId: string, namespaceName: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteNamespace', API, {
      InstanceId: instanceId, NamespaceName: namespaceName,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  镜像仓库管理 (Repository) — 5
  // ══════════════════════════════════════════════════════════

  public createRepository(instanceId: string, repoName: string, repoNamespaceName: string, repoType: string, summary: string, detail?: string, tagImmutability?: boolean): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoName: repoName, RepoNamespaceName: repoNamespaceName, RepoType: repoType, Summary: summary };
    if (detail) p.Detail = detail;
    if (tagImmutability !== undefined) p.TagImmutability = String(tagImmutability);
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateRepository', API, p);
  }

  public getRepository(instanceId: string, repoId?: string, repoNamespaceName?: string, repoName?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (repoId) p.RepoId = repoId;
    if (repoNamespaceName) p.RepoNamespaceName = repoNamespaceName;
    if (repoName) p.RepoName = repoName;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetRepository', API, p);
  }

  public listRepository(instanceId: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListRepository', API, { InstanceId: instanceId, ...params });
  }

  public updateRepository(instanceId: string, repoType: string, summary: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateRepository', API, { InstanceId: instanceId, RepoType: repoType, Summary: summary, ...params });
  }

  public deleteRepository(instanceId: string, repoId?: string, repoName?: string, repoNamespaceName?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (repoId) p.RepoId = repoId;
    if (repoName) p.RepoName = repoName;
    if (repoNamespaceName) p.RepoNamespaceName = repoNamespaceName;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteRepository', API, p);
  }

  // ══════════════════════════════════════════════════════════
  //  镜像管理 (Image Tag) — 7
  // ══════════════════════════════════════════════════════════

  public createRepoTag(instanceId: string, namespaceName: string, repoName: string, fromTag: string, toTag: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateRepoTag', API, {
      InstanceId: instanceId, NamespaceName: namespaceName, RepoName: repoName, FromTag: fromTag, ToTag: toTag,
    });
  }

  public deleteRepoTag(instanceId: string, repoId: string, tag: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteRepoTag', API, {
      InstanceId: instanceId, RepoId: repoId, Tag: tag,
    });
  }

  public listRepoTag(instanceId: string, repoId: string, pageNo?: number, pageSize?: number): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId };
    if (pageNo !== undefined) p.PageNo = String(pageNo);
    if (pageSize !== undefined) p.PageSize = String(pageSize);
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListRepoTag', API, p);
  }

  public getRepoTag(instanceId: string, repoId: string, tag: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetRepoTag', API, {
      InstanceId: instanceId, RepoId: repoId, Tag: tag,
    });
  }

  /** Create image tag scan task. */
  public createRepoTagScanTask(instanceId: string, repoId: string, tag: string, opts?: { digest?: string; scanService?: string; scanType?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId, Tag: tag };
    if (opts?.digest) p.Digest = opts.digest;
    if (opts?.scanService) p.ScanService = opts.scanService;
    if (opts?.scanType) p.ScanType = opts.scanType;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateRepoTagScanTask', API, p);
  }

  /** Get image tag scan status. */
  public getRepoTagScanStatus(instanceId: string, opts?: { repoId?: string; tag?: string; scanTaskId?: string; digest?: string; scanType?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (opts?.repoId) p.RepoId = opts.repoId;
    if (opts?.tag) p.Tag = opts.tag;
    if (opts?.scanTaskId) p.ScanTaskId = opts.scanTaskId;
    if (opts?.digest) p.Digest = opts.digest;
    if (opts?.scanType) p.ScanType = opts.scanType;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetRepoTagScanStatus', API, p);
  }

  /** Get image tag scan summary. */
  public getRepoTagScanSummary(instanceId: string, opts?: { repoId?: string; tag?: string; scanTaskId?: string; digest?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (opts?.repoId) p.RepoId = opts.repoId;
    if (opts?.tag) p.Tag = opts.tag;
    if (opts?.scanTaskId) p.ScanTaskId = opts.scanTaskId;
    if (opts?.digest) p.Digest = opts.digest;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetRepoTagScanSummary', API, p);
  }

  /** List image tag scan results (vulnerabilities). */
  public listRepoTagScanResult(instanceId: string, opts?: { repoId?: string; tag?: string; scanTaskId?: string; pageNo?: number; pageSize?: number; severity?: string; digest?: string; scanType?: string; vulQueryKey?: string; filterValue?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (opts?.repoId) p.RepoId = opts.repoId;
    if (opts?.tag) p.Tag = opts.tag;
    if (opts?.scanTaskId) p.ScanTaskId = opts.scanTaskId;
    if (opts?.pageNo !== undefined) p.PageNo = String(opts.pageNo);
    if (opts?.pageSize !== undefined) p.PageSize = String(opts.pageSize);
    if (opts?.severity) p.Severity = opts.severity;
    if (opts?.digest) p.Digest = opts.digest;
    if (opts?.scanType) p.ScanType = opts.scanType;
    if (opts?.vulQueryKey) p.VulQueryKey = opts.vulQueryKey;
    if (opts?.filterValue) p.FilterValue = opts.filterValue;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListRepoTagScanResult', API, p);
  }

  // ══════════════════════════════════════════════════════════
  //  镜像构建管理 (Build) — 14
  // ══════════════════════════════════════════════════════════

  public createBuildRecordByRule(instanceId: string, repoId: string, buildRuleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateBuildRecordByRule', API, {
      InstanceId: instanceId, RepoId: repoId, BuildRuleId: buildRuleId,
    });
  }

  public createBuildRecordByRecord(instanceId: string, repoId: string, buildRecordId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateBuildRecordByRecord', API, {
      InstanceId: instanceId, RepoId: repoId, BuildRecordId: buildRecordId,
    });
  }

  public cancelRepoBuildRecord(instanceId: string, repoId: string, buildRecordId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CancelRepoBuildRecord', API, {
      InstanceId: instanceId, RepoId: repoId, BuildRecordId: buildRecordId,
    });
  }

  public getRepoBuildRecord(instanceId: string, buildRecordId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetRepoBuildRecord', API, {
      InstanceId: instanceId, BuildRecordId: buildRecordId,
    });
  }

  public getRepoBuildRecordStatus(instanceId: string, repoId: string, buildRecordId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetRepoBuildRecordStatus', API, {
      InstanceId: instanceId, RepoId: repoId, BuildRecordId: buildRecordId,
    });
  }

  public listRepoBuildRecord(instanceId: string, repoId: string, pageNo?: number, pageSize?: number): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId };
    if (pageNo !== undefined) p.PageNo = String(pageNo);
    if (pageSize !== undefined) p.PageSize = String(pageSize);
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListRepoBuildRecord', API, p);
  }

  public listRepoBuildRecordLog(instanceId: string, buildRecordId: string, repoId?: string, offset?: number): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, BuildRecordId: buildRecordId };
    if (repoId) p.RepoId = repoId;
    if (offset !== undefined) p.Offset = String(offset);
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListRepoBuildRecordLog', API, p);
  }

  public createRepoBuildRule(instanceId: string, repoId: string, pushType: string, pushName: string, imageTag: string,
    opts?: { dockerfileLocation?: string; dockerfileName?: string; buildArgs?: string; platforms?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId, PushType: pushType, PushName: pushName, ImageTag: imageTag };
    if (opts?.dockerfileLocation) p.DockerfileLocation = opts.dockerfileLocation;
    if (opts?.dockerfileName) p.DockerfileName = opts.dockerfileName;
    if (opts?.buildArgs) p.BuildArgs = opts.buildArgs;
    if (opts?.platforms) p.Platforms = opts.platforms;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateRepoBuildRule', API, p);
  }

  public deleteRepoBuildRule(instanceId: string, repoId: string, buildRuleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteRepoBuildRule', API, {
      InstanceId: instanceId, RepoId: repoId, BuildRuleId: buildRuleId,
    });
  }

  public listRepoBuildRule(instanceId: string, repoId: string, pageNo?: number, pageSize?: number): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId };
    if (pageNo !== undefined) p.PageNo = String(pageNo);
    if (pageSize !== undefined) p.PageSize = String(pageSize);
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListRepoBuildRule', API, p);
  }

  public updateRepoBuildRule(instanceId: string, repoId: string, buildRuleId: string,
    opts?: { dockerfileLocation?: string; dockerfileName?: string; pushType?: string; pushName?: string; imageTag?: string; buildArgs?: string; platforms?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId, BuildRuleId: buildRuleId };
    if (opts?.dockerfileLocation) p.DockerfileLocation = opts.dockerfileLocation;
    if (opts?.dockerfileName) p.DockerfileName = opts.dockerfileName;
    if (opts?.pushType) p.PushType = opts.pushType;
    if (opts?.pushName) p.PushName = opts.pushName;
    if (opts?.imageTag) p.ImageTag = opts.imageTag;
    if (opts?.buildArgs) p.BuildArgs = opts.buildArgs;
    if (opts?.platforms) p.Platforms = opts.platforms;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateRepoBuildRule', API, p);
  }

  public createRepoSourceCodeRepo(instanceId: string, repoId: string, codeRepoType: string, codeRepoNamespaceName: string,
    codeRepoName: string, opts?: { autoBuild?: boolean; overseaBuild?: boolean; disableCacheBuild?: boolean }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId, CodeRepoType: codeRepoType, CodeRepoNamespaceName: codeRepoNamespaceName, CodeRepoName: codeRepoName };
    if (opts?.autoBuild) p.AutoBuild = 'true';
    if (opts?.overseaBuild) p.OverseaBuild = 'true';
    if (opts?.disableCacheBuild) p.DisableCacheBuild = 'true';
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateRepoSourceCodeRepo', API, p);
  }

  public getRepoSourceCodeRepo(instanceId: string, repoId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetRepoSourceCodeRepo', API, {
      InstanceId: instanceId, RepoId: repoId,
    });
  }

  public updateRepoSourceCodeRepo(instanceId: string, repoId: string, codeRepoType: string, codeRepoNamespaceName: string,
    codeRepoName: string, opts?: { autoBuild?: string; overseaBuild?: string; disableCacheBuild?: string; codeRepoId?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId, CodeRepoType: codeRepoType, CodeRepoNamespaceName: codeRepoNamespaceName, CodeRepoName: codeRepoName };
    if (opts?.autoBuild) p.AutoBuild = opts.autoBuild;
    if (opts?.overseaBuild) p.OverseaBuild = opts.overseaBuild;
    if (opts?.disableCacheBuild) p.DisableCacheBuild = opts.disableCacheBuild;
    if (opts?.codeRepoId) p.CodeRepoId = opts.codeRepoId;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateRepoSourceCodeRepo', API, p);
  }

  // ══════════════════════════════════════════════════════════
  //  镜像触发器管理 (Trigger) — 5
  // ══════════════════════════════════════════════════════════

  public createRepoTrigger(instanceId: string, repoId: string, triggerName: string, triggerUrl: string, triggerType: string, triggerTag?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId, TriggerName: triggerName, TriggerUrl: triggerUrl, TriggerType: triggerType };
    if (triggerTag) p.TriggerTag = triggerTag;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateRepoTrigger', API, p);
  }

  public deleteRepoTrigger(instanceId: string, repoId: string, triggerId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteRepoTrigger', API, {
      InstanceId: instanceId, RepoId: repoId, TriggerId: triggerId,
    });
  }

  public listRepoTrigger(instanceId: string, repoId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListRepoTrigger', API, {
      InstanceId: instanceId, RepoId: repoId,
    });
  }

  public updateRepoTrigger(instanceId: string, repoId: string, triggerId: string,
    opts?: { triggerName?: string; triggerUrl?: string; triggerType?: string; triggerTag?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoId: repoId, TriggerId: triggerId };
    if (opts?.triggerName) p.TriggerName = opts.triggerName;
    if (opts?.triggerUrl) p.TriggerUrl = opts.triggerUrl;
    if (opts?.triggerType) p.TriggerType = opts.triggerType;
    if (opts?.triggerTag) p.TriggerTag = opts.triggerTag;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateRepoTrigger', API, p);
  }

  // ══════════════════════════════════════════════════════════
  //  镜像安全管理 (Security Scan) — 2 helpers above, plus details
  // ══════════════════════════════════════════════════════════

  public listScanBaselineByTask(params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListScanBaselineByTask', API, params ?? {});
  }

  public listScanMaliciousFileByTask(params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListScanMaliciousFileByTask', API, params ?? {});
  }

  // ══════════════════════════════════════════════════════════
  //  访问凭证管理 (Authorization) — 2
  // ══════════════════════════════════════════════════════════

  public getAuthorizationToken(instanceId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetAuthorizationToken', API, { InstanceId: instanceId });
  }

  public resetLoginPassword(instanceId: string, password: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ResetLoginPassword', API, {
      InstanceId: instanceId, Password: password,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  Helm Chart 命名空间管理 (Chart Namespace) — 5
  // ══════════════════════════════════════════════════════════

  public createChartNamespace(instanceId: string, namespaceName: string, opts?: { autoCreateRepo?: boolean; defaultRepoType?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, NamespaceName: namespaceName };
    if (opts?.autoCreateRepo) p.AutoCreateRepo = 'true';
    if (opts?.defaultRepoType) p.DefaultRepoType = opts.defaultRepoType;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateChartNamespace', API, p);
  }

  public getChartNamespace(instanceId: string, namespaceName: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetChartNamespace', API, {
      InstanceId: instanceId, NamespaceName: namespaceName,
    });
  }

  public listChartNamespace(instanceId: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListChartNamespace', API, { InstanceId: instanceId, ...params });
  }

  public updateChartNamespace(instanceId: string, namespaceName: string, opts?: { autoCreateRepo?: boolean; defaultRepoType?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, NamespaceName: namespaceName };
    if (opts?.autoCreateRepo !== undefined) p.AutoCreateRepo = String(opts.autoCreateRepo);
    if (opts?.defaultRepoType) p.DefaultRepoType = opts.defaultRepoType;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateChartNamespace', API, p);
  }

  public deleteChartNamespace(instanceId: string, namespaceName: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteChartNamespace', API, {
      InstanceId: instanceId, NamespaceName: namespaceName,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  Chart 仓库管理 (Chart Repository) — 5
  // ══════════════════════════════════════════════════════════

  public createChartRepository(instanceId: string, repoName: string, repoNamespaceName: string, opts?: { repoType?: string; summary?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoName: repoName, RepoNamespaceName: repoNamespaceName };
    if (opts?.repoType) p.RepoType = opts.repoType;
    if (opts?.summary) p.Summary = opts.summary;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateChartRepository', API, p);
  }

  public getChartRepository(instanceId: string, repoNamespaceName: string, repoName: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetChartRepository', API, {
      InstanceId: instanceId, RepoNamespaceName: repoNamespaceName, RepoName: repoName,
    });
  }

  public listChartRepository(instanceId: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListChartRepository', API, { InstanceId: instanceId, ...params });
  }

  public updateChartRepository(instanceId: string, repoNamespaceName: string, repoName: string, opts?: { repoType?: string; summary?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RepoNamespaceName: repoNamespaceName, RepoName: repoName };
    if (opts?.repoType) p.RepoType = opts.repoType;
    if (opts?.summary) p.Summary = opts.summary;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateChartRepository', API, p);
  }

  public deleteChartRepository(instanceId: string, repoNamespaceName: string, repoName: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteChartRepository', API, {
      InstanceId: instanceId, RepoNamespaceName: repoNamespaceName, RepoName: repoName,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  Chart 版本管理 (Chart Release) — 2
  // ══════════════════════════════════════════════════════════

  public listChartRelease(instanceId: string, repoName: string, repoNamespaceName: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListChartRelease', API, {
      InstanceId: instanceId, RepoName: repoName, RepoNamespaceName: repoNamespaceName, ...params,
    });
  }

  public deleteChartRelease(instanceId: string, chart: string, release: string, repoName: string, repoNamespaceName: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteChartRelease', API, {
      InstanceId: instanceId, Chart: chart, Release: release, RepoName: repoName, RepoNamespaceName: repoNamespaceName,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  云原生交付链管理 (Delivery Chain) — 6
  // ══════════════════════════════════════════════════════════

  public createChain(instanceId: string, name: string, opts?: { repoName?: string; repoNamespaceName?: string; description?: string; chainConfig?: string; scopeExclude?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, Name: name };
    if (opts?.repoName) p.RepoName = opts.repoName;
    if (opts?.repoNamespaceName) p.RepoNamespaceName = opts.repoNamespaceName;
    if (opts?.description) p.Description = opts.description;
    if (opts?.chainConfig) p.ChainConfig = opts.chainConfig;
    if (opts?.scopeExclude) p.ScopeExclude = opts.scopeExclude;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateChain', API, p);
  }

  public deleteChain(instanceId: string, chainId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteChain', API, {
      InstanceId: instanceId, ChainId: chainId,
    });
  }

  public updateChain(instanceId: string, chainId: string, name: string, chainConfig: string, opts?: { description?: string; scopeExclude?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, ChainId: chainId, Name: name, ChainConfig: chainConfig };
    if (opts?.description) p.Description = opts.description;
    if (opts?.scopeExclude) p.ScopeExclude = opts.scopeExclude;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateChain', API, p);
  }

  public getChain(instanceId: string, chainId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetChain', API, {
      InstanceId: instanceId, ChainId: chainId,
    });
  }

  public listChain(instanceId: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListChain', API, { InstanceId: instanceId, ...params });
  }

  public listChainInstance(instanceId: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListChainInstance', API, { InstanceId: instanceId, ...params });
  }

  // ══════════════════════════════════════════════════════════
  //  事件通知 (Event Notification) — 4
  // ══════════════════════════════════════════════════════════

  public listEventCenterRecord(instanceId: string, params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListEventCenterRecord', API, { InstanceId: instanceId, ...params });
  }

  public listEventCenterRuleName(instanceId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListEventCenterRuleName', API, { InstanceId: instanceId });
  }

  public createEventCenterRule(instanceId: string, ruleName: string, eventChannel: string, eventType: string, eventScope: string, eventConfig: string,
    opts?: { namespaces?: string; repoNames?: string; repoTagFilterPattern?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RuleName: ruleName, EventChannel: eventChannel, EventType: eventType, EventScope: eventScope, EventConfig: eventConfig };
    if (opts?.namespaces) p.Namespaces = opts.namespaces;
    if (opts?.repoNames) p.RepoNames = opts.repoNames;
    if (opts?.repoTagFilterPattern) p.RepoTagFilterPattern = opts.repoTagFilterPattern;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateEventCenterRule', API, p);
  }

  public updateEventCenterRule(instanceId: string, ruleId: string, opts?: { ruleName?: string; eventChannel?: string; eventType?: string; eventScope?: string; namespaces?: string; repoNames?: string; repoTagFilterPattern?: string; eventConfig?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RuleId: ruleId };
    if (opts?.ruleName) p.RuleName = opts.ruleName;
    if (opts?.eventChannel) p.EventChannel = opts.eventChannel;
    if (opts?.eventType) p.EventType = opts.eventType;
    if (opts?.eventScope) p.EventScope = opts.eventScope;
    if (opts?.namespaces) p.Namespaces = opts.namespaces;
    if (opts?.repoNames) p.RepoNames = opts.repoNames;
    if (opts?.repoTagFilterPattern) p.RepoTagFilterPattern = opts.repoTagFilterPattern;
    if (opts?.eventConfig) p.EventConfig = opts.eventConfig;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateEventCenterRule', API, p);
  }

  public deleteEventCenterRule(instanceId: string, ruleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteEventCenterRule', API, {
      InstanceId: instanceId, RuleId: ruleId,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  制品订阅管理 (Artifact Subscription) — 10
  // ══════════════════════════════════════════════════════════

  public createArtifactSubscriptionRule(instanceId: string, sourceProvider: string, sourceRepoName: string, namespaceName: string,
    repoName: string, tagRegexp: string, tagCount: number, platform: string,
    opts?: { sourceNamespaceName?: string; override?: boolean; accelerate?: boolean }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, SourceProvider: sourceProvider, SourceRepoName: sourceRepoName, NamespaceName: namespaceName, RepoName: repoName, TagRegexp: tagRegexp, TagCount: String(tagCount), Platform: platform };
    if (opts?.sourceNamespaceName) p.SourceNamespaceName = opts.sourceNamespaceName;
    if (opts?.override) p.Override = 'true';
    if (opts?.accelerate) p.Accelerate = 'true';
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateArtifactSubscriptionRule', API, p);
  }

  public updateArtifactSubscriptionRule(instanceId: string, ruleId: string,
    opts?: { sourceProvider?: string; sourceNamespaceName?: string; sourceRepoName?: string; namespaceName?: string; repoName?: string; tagRegexp?: string; tagCount?: number; override?: string; accelerate?: string; platform?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RuleId: ruleId };
    if (opts?.sourceProvider) p.SourceProvider = opts.sourceProvider;
    if (opts?.sourceNamespaceName) p.SourceNamespaceName = opts.sourceNamespaceName;
    if (opts?.sourceRepoName) p.SourceRepoName = opts.sourceRepoName;
    if (opts?.namespaceName) p.NamespaceName = opts.namespaceName;
    if (opts?.repoName) p.RepoName = opts.repoName;
    if (opts?.tagRegexp) p.TagRegexp = opts.tagRegexp;
    if (opts?.tagCount) p.TagCount = String(opts.tagCount);
    if (opts?.override) p.Override = opts.override;
    if (opts?.accelerate) p.Accelerate = opts.accelerate;
    if (opts?.platform) p.Platform = opts.platform;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateArtifactSubscriptionRule', API, p);
  }

  public deleteArtifactSubscriptionRule(instanceId: string, ruleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteArtifactSubscriptionRule', API, {
      InstanceId: instanceId, RuleId: ruleId,
    });
  }

  public getArtifactSubscriptionRule(instanceId: string, ruleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetArtifactSubscriptionRule', API, {
      InstanceId: instanceId, RuleId: ruleId,
    });
  }

  public listArtifactSubscriptionRule(instanceId: string, pageNo?: number, pageSize?: number): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (pageNo !== undefined) p.PageNo = String(pageNo);
    if (pageSize !== undefined) p.PageSize = String(pageSize);
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListArtifactSubscriptionRule', API, p);
  }

  public createArtifactSubscriptionTask(instanceId: string, ruleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateArtifactSubscriptionTask', API, {
      InstanceId: instanceId, RuleId: ruleId,
    });
  }

  public getArtifactSubscriptionTask(instanceId: string, taskId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetArtifactSubscriptionTask', API, {
      InstanceId: instanceId, TaskId: taskId,
    });
  }

  public listArtifactSubscriptionTask(instanceId: string, pageNo?: number, pageSize?: number): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (pageNo !== undefined) p.PageNo = String(pageNo);
    if (pageSize !== undefined) p.PageSize = String(pageSize);
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListArtifactSubscriptionTask', API, p);
  }

  public getArtifactSubscriptionTaskResult(instanceId: string, taskId: string, pageNo?: number, pageSize?: number): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, TaskId: taskId };
    if (pageNo !== undefined) p.PageNo = String(pageNo);
    if (pageSize !== undefined) p.PageSize = String(pageSize);
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetArtifactSubscriptionTaskResult', API, p);
  }

  // ══════════════════════════════════════════════════════════
  //  制品生命周期管理 (Artifact Lifecycle) — 5
  // ══════════════════════════════════════════════════════════

  public createArtifactLifecycleRule(instanceId: string, opts?: { auto?: boolean; scheduleTime?: string; namespaceName?: string; repoName?: string; tagRegexp?: string; retentionTagCount?: number; enableDeleteTag?: boolean; scope?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (opts?.auto !== undefined) p.Auto = String(opts.auto);
    if (opts?.scheduleTime) p.ScheduleTime = opts.scheduleTime;
    if (opts?.namespaceName) p.NamespaceName = opts.namespaceName;
    if (opts?.repoName) p.RepoName = opts.repoName;
    if (opts?.tagRegexp) p.TagRegexp = opts.tagRegexp;
    if (opts?.retentionTagCount !== undefined) p.RetentionTagCount = String(opts.retentionTagCount);
    if (opts?.enableDeleteTag !== undefined) p.EnableDeleteTag = String(opts.enableDeleteTag);
    if (opts?.scope) p.Scope = opts.scope;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateArtifactLifecycleRule', API, p);
  }

  public getArtifactLifecycleRule(instanceId: string, ruleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetArtifactLifecycleRule', API, {
      InstanceId: instanceId, RuleId: ruleId,
    });
  }

  public listArtifactLifecycleRule(instanceId: string, pageNo?: number, pageSize?: number): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (pageNo !== undefined) p.PageNo = String(pageNo);
    if (pageSize !== undefined) p.PageSize = String(pageSize);
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListArtifactLifecycleRule', API, p);
  }

  public updateArtifactLifecycleRule(instanceId: string, ruleId: string, opts?: { auto?: boolean; scheduleTime?: string; namespaceName?: string; repoName?: string; tagRegexp?: string; retentionTagCount?: number; enableDeleteTag?: boolean; scope?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RuleId: ruleId };
    if (opts?.auto !== undefined) p.Auto = String(opts.auto);
    if (opts?.scheduleTime) p.ScheduleTime = opts.scheduleTime;
    if (opts?.namespaceName) p.NamespaceName = opts.namespaceName;
    if (opts?.repoName) p.RepoName = opts.repoName;
    if (opts?.tagRegexp) p.TagRegexp = opts.tagRegexp;
    if (opts?.retentionTagCount !== undefined) p.RetentionTagCount = String(opts.retentionTagCount);
    if (opts?.enableDeleteTag !== undefined) p.EnableDeleteTag = String(opts.enableDeleteTag);
    if (opts?.scope) p.Scope = opts.scope;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateArtifactLifecycleRule', API, p);
  }

  public deleteArtifactLifecycleRule(instanceId: string, ruleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteArtifactLifecycleRule', API, {
      InstanceId: instanceId, RuleId: ruleId,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  制品构建管理 (Artifact Build) — 5
  // ══════════════════════════════════════════════════════════

  public createArtifactBuildRule(instanceId: string, scopeType: string, scopeId: string, artifactType: string, parameters?: string): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, ScopeType: scopeType, ScopeId: scopeId, ArtifactType: artifactType };
    if (parameters) p.Parameters = parameters;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateArtifactBuildRule', API, p);
  }

  public getArtifactBuildRule(instanceId: string, opts?: { scopeType?: string; scopeId?: string; artifactType?: string; buildRuleId?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId };
    if (opts?.scopeType) p.ScopeType = opts.scopeType;
    if (opts?.scopeId) p.ScopeId = opts.scopeId;
    if (opts?.artifactType) p.ArtifactType = opts.artifactType;
    if (opts?.buildRuleId) p.BuildRuleId = opts.buildRuleId;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetArtifactBuildRule', API, p);
  }

  public getArtifactBuildTask(instanceId: string, buildTaskId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetArtifactBuildTask', API, {
      InstanceId: instanceId, BuildTaskId: buildTaskId,
    });
  }

  public cancelArtifactBuildTask(instanceId: string, buildTaskId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CancelArtifactBuildTask', API, {
      InstanceId: instanceId, BuildTaskId: buildTaskId,
    });
  }

  public listArtifactBuildTaskLog(instanceId: string, buildTaskId: string, page: number, pageSize: number): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListArtifactBuildTaskLog', API, {
      InstanceId: instanceId, BuildTaskId: buildTaskId, Page: String(page), PageSize: String(pageSize),
    });
  }

  // ══════════════════════════════════════════════════════════
  //  扫描规则管理 (Scan Rule) — 5
  // ══════════════════════════════════════════════════════════

  public createScanRule(instanceId: string, ruleName: string, scanScope: string, triggerType: string, repoTagFilterPattern: string,
    opts?: { namespaces?: string; repoNames?: string; scanType?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, RuleName: ruleName, ScanScope: scanScope, TriggerType: triggerType, RepoTagFilterPattern: repoTagFilterPattern };
    if (opts?.namespaces) p.Namespaces = opts.namespaces;
    if (opts?.repoNames) p.RepoNames = opts.repoNames;
    if (opts?.scanType) p.ScanType = opts.scanType;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateScanRule', API, p);
  }

  public getScanRule(instanceId: string, scanRuleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetScanRule', API, {
      InstanceId: instanceId, ScanRuleId: scanRuleId,
    });
  }

  public listScanRule(params?: RpcParams): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListScanRule', API, params ?? {});
  }

  public updateScanRule(instanceId: string, scanRuleId: string, ruleName: string, scanScope: string, triggerType: string, repoTagFilterPattern: string,
    opts?: { namespaces?: string; repoNames?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { InstanceId: instanceId, ScanRuleId: scanRuleId, RuleName: ruleName, ScanScope: scanScope, TriggerType: triggerType, RepoTagFilterPattern: repoTagFilterPattern };
    if (opts?.namespaces) p.Namespaces = opts.namespaces;
    if (opts?.repoNames) p.RepoNames = opts.repoNames;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UpdateScanRule', API, p);
  }

  public deleteScanRule(instanceId: string, scanRuleId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteScanRule', API, {
      InstanceId: instanceId, ScanRuleId: scanRuleId,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  标签管理 (Tags) — 3
  // ══════════════════════════════════════════════════════════

  public tagResources(resourceType: string, resourceId: string | string[], regionId: string, tag: string | string[]): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'TagResources', API, {
      ResourceType: resourceType,
      ResourceId: normalizeStringOrArray(resourceId),
      RegionId: regionId,
      Tag: normalizeStringOrArray(tag),
    });
  }

  public untagResources(resourceType: string, regionId: string, opts?: { resourceId?: string[]; tagKey?: string[]; all?: boolean }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { ResourceType: resourceType, RegionId: regionId };
    if (opts?.resourceId) p.ResourceId = opts.resourceId.join(',');
    if (opts?.tagKey) p.TagKey = opts.tagKey.join(',');
    if (opts?.all !== undefined) p.All = String(opts.all);
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'UntagResources', API, p);
  }

  public listTagResources(resourceType: string, regionId: string, opts?: { resourceId?: string[]; tag?: string[]; nextToken?: string }): Promise<Record<string, unknown>> {
    const p: Record<string, string> = { ResourceType: resourceType, RegionId: regionId };
    if (opts?.resourceId) p.ResourceId = opts.resourceId.join(',');
    if (opts?.tag) p.Tag = opts.tag.join(',');
    if (opts?.nextToken) p.NextToken = opts.nextToken;
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListTagResources', API, p);
  }

  // ══════════════════════════════════════════════════════════
  //  其他 (Other) — 1
  // ══════════════════════════════════════════════════════════

  public changeResourceGroup(resourceId: string, resourceRegionId: string, resourceGroupId: string): Promise<Record<string, unknown>> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ChangeResourceGroup', API, {
      ResourceId: resourceId, ResourceRegionId: resourceRegionId, ResourceGroupId: resourceGroupId,
    });
  }
}

// ─── Helpers ───

const stringOrArraySchema = z.union([
  z.string(),
  z.array(z.string()).transform(a => a.join(',')),
]);

function normalizeStringOrArray(v: string | string[]): string {
  return stringOrArraySchema.parse(v);
}

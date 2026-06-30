import { z } from 'zod';

// ─── Platform enumeration ───

export type Platform = 'alibaba' | 'aws' | 'podman' | 'stub';

// ─── Region types ───

/** Alibaba Cloud regions as a true enum — string values for API compatibility. */
export enum AlibabaRegion {
  CnHangzhou = 'cn-hangzhou',
  CnBeijing = 'cn-beijing',
  CnShanghai = 'cn-shanghai',
  CnZhangjiakou = 'cn-zhangjiakou',
  CnHuhehaote = 'cn-huhehaote',
  CnShenzhen = 'cn-shenzhen',
  CnChengdu = 'cn-chengdu',
  CnHongkong = 'cn-hongkong',
  CnQingdao = 'cn-qingdao',
  CnHeyuan = 'cn-heyuan',
  CnWulanchabu = 'cn-wulanchabu',
  CnGuangzhou = 'cn-guangzhou',
  ApNortheast1 = 'ap-northeast-1',
  ApSoutheast1 = 'ap-southeast-1',
  ApSoutheast3 = 'ap-southeast-3',
  ApSoutheast5 = 'ap-southeast-5',
  ApSouth1 = 'ap-south-1',
  UsEast1 = 'us-east-1',
  UsWest1 = 'us-west-1',
  EuWest1 = 'eu-west-1',
  EuCentral1 = 'eu-central-1',
}

export const ALIBABA_REGIONS: readonly string[] = Object.values(AlibabaRegion);

/** AWS regions as a true enum. */
export enum AwsRegion {
  UsEast1 = 'us-east-1',
  UsEast2 = 'us-east-2',
  UsWest1 = 'us-west-1',
  UsWest2 = 'us-west-2',
  EuWest1 = 'eu-west-1',
  EuWest2 = 'eu-west-2',
  EuCentral1 = 'eu-central-1',
  EuNorth1 = 'eu-north-1',
  ApSoutheast1 = 'ap-southeast-1',
  ApSoutheast2 = 'ap-southeast-2',
  ApNortheast1 = 'ap-northeast-1',
  ApSouth1 = 'ap-south-1',
  SaEast1 = 'sa-east-1',
  CaCentral1 = 'ca-central-1',
}

export const AWS_REGIONS: readonly string[] = Object.values(AwsRegion);

/** Podman regions — local-only, but supports multiple named instances. */
export enum PodmanRegion {
  Local = 'local',
}

// ─── RegionId brand type ───

const regionIdSchema = z.string().min(1).brand('RegionId');
export type RegionId = z.infer<typeof regionIdSchema>;

export function createRegionId(raw: string): RegionId {
  if (!raw.trim()) throw new TypeError('RegionId must not be empty');
  return regionIdSchema.parse(raw);
}

export function createAlibabaRegion(raw: string): AlibabaRegion {
  const r = Object.values(AlibabaRegion).find(r => String(r) === raw);
  if (!r) throw new TypeError(`Invalid Alibaba region: "${raw}". Valid: ${ALIBABA_REGIONS.join(', ')}`);
  return r;
}

export function createAwsRegion(raw: string): AwsRegion {
  const r = Object.values(AwsRegion).find(r => String(r) === raw);
  if (!r) throw new TypeError(`Invalid AWS region: "${raw}". Valid: ${AWS_REGIONS.join(', ')}`);
  return r;
}

/** Local / dev region constant. */
export const LOCAL_REGION = createRegionId('local');

// ─── ZoneId brand type (validated per platform, not a closed enum) ───

const zoneIdSchema = z.string().min(1).brand('ZoneId');
export type ZoneId = z.infer<typeof zoneIdSchema>;

/** Alibaba zone pattern: cn-hangzhou-g, cn-beijing-g, us-east-1-a, etc. */
const ALIBABA_ZONE_RE = /^[a-z]+(?:-[a-z0-9]+)+-[a-z]$/;

/** Podman zone: 'local' or 'local-<name>'. */
const PODMAN_ZONE_RE = /^local(?:-[a-zA-Z0-9_-]+)?$/;

export function createZoneId(raw: string, platform: Platform): ZoneId {
  if (!raw.trim()) throw new TypeError('ZoneId must not be empty');
  switch (platform) {
    case 'alibaba':
      if (!ALIBABA_ZONE_RE.test(raw)) {
        throw new TypeError(`Invalid Alibaba zone: "${raw}". Expected format like "cn-hangzhou-a"`);
      }
      break;
    case 'podman':
      if (!PODMAN_ZONE_RE.test(raw)) {
        throw new TypeError(`Invalid Podman zone: "${raw}". Expected "local" or "local-<name>"`);
      }
      break;
    case 'stub':
      // Stub accepts any non-empty string
      break;
    case 'aws':
      // AWS zone format: us-east-1a, us-east-1b, etc.
      if (!/^[a-z]+-[a-z]+-\d+[a-z]$/.test(raw)) {
        throw new TypeError(`Invalid AWS zone: "${raw}". Expected format like "us-east-1a"`);
      }
      break;
  }
  return zoneIdSchema.parse(raw);
}

// ─── ClusterId brand type ───

const clusterIdSchema = z.string().min(1).brand('ClusterId');
export type ClusterId = z.infer<typeof clusterIdSchema>;

export function generateClusterId(): ClusterId {
  return clusterIdSchema.parse(`cluster_${crypto.randomUUID()}`);
}

declare const REGION_ID_BRAND: unique symbol;

export type RegionId = string & { readonly [REGION_ID_BRAND]: true };

export function createRegionId(raw: string): RegionId {
  if (!raw || !raw.trim()) throw new TypeError('RegionId must not be empty');
  return raw as RegionId;
}

// ─── Alibaba Cloud regions ───

export const ALIBABA_REGIONS = [
  'cn-hangzhou', 'cn-beijing', 'cn-shanghai', 'cn-zhangjiakou',
  'cn-huhehaote', 'cn-shenzhen', 'cn-chengdu', 'cn-hongkong',
  'cn-qingdao', 'cn-heyuan', 'cn-wulanchabu', 'cn-guangzhou',
  'ap-northeast-1', 'ap-southeast-1', 'ap-southeast-3', 'ap-southeast-5',
  'ap-south-1', 'us-east-1', 'us-west-1', 'eu-west-1', 'eu-central-1',
] as const;

export type AlibabaRegion = typeof ALIBABA_REGIONS[number];

// ─── AWS regions ───

export const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-central-1', 'eu-north-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
  'ap-south-1', 'sa-east-1', 'ca-central-1',
] as const;

export type AwsRegion = typeof AWS_REGIONS[number];

// ─── Local / dev regions ───

export const LOCAL_REGION = 'local' as RegionId;

// ─── Validated region creation ───

export function createAlibabaRegion(raw: string): AlibabaRegion {
  const r = ALIBABA_REGIONS.find(r => r === raw);
  if (!r) throw new TypeError(`Invalid Alibaba region: "${raw}". Valid: ${ALIBABA_REGIONS.join(', ')}`);
  return r;
}

export function createAwsRegion(raw: string): AwsRegion {
  const r = AWS_REGIONS.find(r => r === raw);
  if (!r) throw new TypeError(`Invalid AWS region: "${raw}". Valid: ${AWS_REGIONS.join(', ')}`);
  return r;
}

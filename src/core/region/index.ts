export type { RegionId, AlibabaRegion, AwsRegion } from './types.ts';
export { ALIBABA_REGIONS, AWS_REGIONS, LOCAL_REGION, createRegionId, createAlibabaRegion, createAwsRegion } from './types.ts';
export type { ProviderName, RegionConfig, RegionEndpoint } from './registry.ts';
export { RegionRegistry, getDefaultRegistry, setDefaultRegistry } from './registry.ts';

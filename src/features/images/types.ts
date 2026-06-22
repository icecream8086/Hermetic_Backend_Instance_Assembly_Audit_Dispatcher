import type { ImageInfo, ListImagesOptions } from '../../core/provider/interfaces.ts';

export interface PullImageRequest {
  image: string;
  instanceId?: string;
  clusterId?: string;
  credentialRef?: string;
}

export interface TagImageRequest {
  tag: string;
}

export interface SearchImagesRequest {
  term: string;
  limit?: number;
}

export interface BuildImageRequest {
  dockerfile?: string;
  context?: unknown;
  tag?: string;
}

export interface PruneImagesRequest {
  dangling?: boolean;
}

export type { ImageInfo, ListImagesOptions };

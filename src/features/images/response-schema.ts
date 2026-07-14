import { z } from 'zod';

/** Image info — matches core/provider interfaces.ts ImageInfo. */
export const ImageInfoResponseSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()).readonly(),
  created: z.number().optional(),
  size: z.number().optional(),
  architecture: z.string().optional(),
  os: z.string().optional(),
  layers: z.number().optional(),
}).openapi({ ref: 'ImageInfo' });

/** Search result item. */
export const ImageSearchResultItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  isOfficial: z.boolean().optional(),
});

/** History entry. */
export const ImageHistoryEntrySchema = z.object({
  id: z.string(),
  created: z.number().optional(),
  createdBy: z.string().optional(),
  size: z.number().optional(),
});

/** Prune result. */
export const PruneResultSchema = z.object({
  reclaimed: z.number(),
});

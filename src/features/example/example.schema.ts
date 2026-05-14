import { z } from 'zod';

export const CreateOrderSchema = z.object({
  facilityId: z.string().min(1).max(64),
  amount: z.number().positive(),
  currency: z.string().length(3).default('USD'),
  description: z.string().max(500).optional(),
});

export const OrderSchema = z.object({
  id: z.string(),
  facilityId: z.string(),
  amount: z.number(),
  currency: z.string(),
  description: z.string().optional(),
  createdAt: z.number(),
});

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
export type Order = z.infer<typeof OrderSchema>;

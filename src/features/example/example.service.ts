import type { CreateOrderInput, Order } from './example.schema.ts';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import { LogLevel } from '../../core/types.ts';
import { createFacility, generateOrderId } from '../../core/brand.ts';
import { AppError } from '../../core/types.ts';

const FACILITY = createFacility('order-service');

export class ExampleService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
  ) {}

  async createOrder(input: CreateOrderInput): Promise<Order> {
    this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'Creating order',
      metadata: { input },
    });

    const order: Order = {
      id: generateOrderId(),
      facilityId: input.facilityId,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      createdAt: Date.now(),
    };

    const version = await this.atomic.set(`order:${order.id}`, order, null);
    if (!version) {
      throw new AppError(409, 'ORDER_EXISTS', `Order ${order.id} already exists`);
    }

    return order;
  }

  async getOrder(id: string): Promise<Order | null> {
    const entry = await this.atomic.get<Order>(`order:${id}`);
    return entry?.value ?? null;
  }
}

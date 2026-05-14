import type { CreateOrderInput, Order } from './example.schema.ts';
import { ExampleService } from './example.service.ts';

export class ExampleHandler {
  constructor(private readonly service: ExampleService) {}

  async create(input: CreateOrderInput): Promise<Order> {
    return this.service.createOrder(input);
  }

  async getById(id: string): Promise<Order | null> {
    return this.service.getOrder(id);
  }
}

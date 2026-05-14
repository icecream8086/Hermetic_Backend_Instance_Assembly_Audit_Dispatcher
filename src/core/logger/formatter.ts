import type { LogEntry } from './types.ts';
import type { SerializedBody } from '../brand.ts';
import { createSerializedBody } from '../brand.ts';

export interface ILogFormatter {
  serialize(entry: LogEntry): SerializedBody;
  deserialize(body: SerializedBody): LogEntry;
}

export class JsonLogFormatter implements ILogFormatter {
  serialize(entry: LogEntry): SerializedBody {
    return createSerializedBody(JSON.stringify(entry));
  }

  deserialize(body: SerializedBody): LogEntry {
    return JSON.parse(body) as LogEntry;
  }
}

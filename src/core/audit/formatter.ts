import { z } from 'zod';
import type { StoredAuditEntry } from './types.ts';
import type { SerializedBody } from '../brand.ts';
import { createSerializedBody } from '../brand.ts';

const { parse: parseJson } = JSON;

export interface ILogFormatter {
  serialize(entry: StoredAuditEntry): SerializedBody;
  deserialize(body: SerializedBody): StoredAuditEntry;
}

export class JsonLogFormatter implements ILogFormatter {
  public serialize(entry: StoredAuditEntry): SerializedBody {
    return createSerializedBody(JSON.stringify(entry));
  }

  public deserialize(body: SerializedBody): StoredAuditEntry {
    return z.custom<StoredAuditEntry>((v) => typeof v === 'object' && v !== null).parse(parseJson(body));
  }
}

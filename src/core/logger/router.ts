import type { ILogRouter } from './interfaces.ts';
import type { ILogWriter, ILogReader, ILogger } from './interfaces.ts';
import type { Facility } from '../brand.ts';

export class LogRouter implements ILogRouter {
  readonly #loggers = new Map<string, ILogger>();

  resolve(facility: Facility): ILogWriter & ILogReader {
    const logger = this.#loggers.get(facility);
    if (!logger) throw new Error(`No logger registered for facility: ${facility}`);
    return logger;
  }

  register(facility: Facility, logger: ILogger): void {
    this.#loggers.set(facility, logger);
  }

  dispose(): void {
    for (const logger of this.#loggers.values()) {
      logger.dispose();
    }
    this.#loggers.clear();
  }
}

export interface CircularQueueOptions {
  /**
   * Maximum number of elements.
   * Omit or set to 0 for auto-growing (starts at 16, doubles when full).
   */
  readonly capacity?: number;
}

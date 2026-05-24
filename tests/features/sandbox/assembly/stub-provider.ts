import type {
  IContainerGroupProvider,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
  CreateContainerGroupInput,
  ContainerGroupRuntime,
} from '../../../src/core/provider/index.ts';

/**
 * Stub IContainerGroupProvider for testing PodResolver.
 * Records created groups and returns deterministic responses.
 */
export class StubContainerGroupProvider implements IContainerGroupProvider {
  #groups: CreateContainerGroupInput[] = [];
  #nextId = 1;

  createdGroups(): readonly CreateContainerGroupInput[] {
    return this.#groups;
  }

  async createGroup(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
    this.#groups.push(input);
    return { providerId: `stub-group-${this.#nextId++}` };
  }

  async deleteGroup(_providerId: string): Promise<void> {
    // no-op
  }

  async getGroupStatus(_providerId: string): Promise<ContainerGroupRuntime | null> {
    return null;
  }

  async describeGroups(_input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
    return { sandboxes: [] };
  }
}

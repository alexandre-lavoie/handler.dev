import { describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';
import { DockerService } from '../docker.js';

describe('DockerService', () => {
  it('uses the injected Dockerode client', async () => {
    const client = {
      listContainers: vi.fn().mockResolvedValue([]),
    } as unknown as Docker;
    const service = new DockerService(client);

    await expect(service.listContainers()).resolves.toEqual([]);
    expect(client.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['handler'] },
    });
  });

  it('keeps availability caching scoped to the service instance', async () => {
    const firstClient = {
      ping: vi.fn().mockResolvedValue(undefined),
    } as unknown as Docker;
    const secondClient = {
      ping: vi.fn().mockRejectedValue(new Error('unavailable')),
    } as unknown as Docker;

    const firstService = new DockerService(firstClient);
    const secondService = new DockerService(secondClient);

    await expect(firstService.isDockerAvailable()).resolves.toBe(true);
    await expect(firstService.isDockerAvailable()).resolves.toBe(true);
    await expect(secondService.isDockerAvailable()).resolves.toBe(false);
    expect(firstClient.ping).toHaveBeenCalledTimes(1);
    expect(secondClient.ping).toHaveBeenCalledTimes(1);
  });
});

/**
 * Docker Sandbox Adapter
 *
 * Converts Docker containers to the unified Sandbox abstraction.
 */

import type { SandboxAdapter, SandboxDirectoryUpload, SandboxFileContent, SandboxFileInfo, SandboxFileUpload, SandboxLogOptions } from './types.js';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, posix } from 'path';
import { tmpdir } from 'os';
import type {
  Sandbox,
  SandboxStatus,
  DockerMeta,
  CreateSandboxRequest,
} from '../../types/sandbox.js';
import type { ContainerInfo, ImageInfo } from '../../types/index.js';
import { DockerService, dockerService } from '../docker.js';
import { listBuilds, getBuild, type BuildStatus } from '../build-tracker.js';
import { getPrivateKey } from '../container-builder.js';
import { findAvailableSshPort } from '../../utils/port.js';
import { parseLsOutput } from './files.js';
import { getDockerMetrics, type GuestMetrics } from '../guest-metrics.js';
import { detectAgentsInDocker, type AgentInfo } from '../agent-detect.js';
import { expandSandboxPath } from './upload.js';

/**
 * Maps Docker container state to unified SandboxStatus
 */
function mapContainerState(state: ContainerInfo['state']): SandboxStatus {
  switch (state) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'building':
      return 'building';
    case 'failed':
      return 'error';
    case 'created':
    case 'exited':
    case 'stopped':
    default:
      return 'stopped';
  }
}

/**
 * Extracts vCPU count from container (Docker doesn't expose this easily)
 * Returns a default value since Docker containers share host CPUs
 */
function getContainerVcpus(): number {
  return 1; // Default, Docker shares host CPUs
}

/**
 * Extracts memory from container (Docker doesn't expose this easily in list)
 * Returns a default value
 */
function getContainerMemoryMb(): number {
  return 1024; // Default 1GB
}

/**
 * Extracts disk size from container
 */
function getContainerDiskGb(): number {
  return 10; // Default 10GB
}

/**
 * Converts a Docker ContainerInfo to Sandbox
 */
function containerToSandbox(container: ContainerInfo): Sandbox {
  const meta: DockerMeta = {
    type: 'docker',
    containerId: container.id,
    volumes: container.volumes,
    dockerState: container.state,
  };

  // Generate docker exec command for direct container access
  // Use container name for more user-friendly command
  const shortId = container.id.substring(0, 12);
  const dockerExecCommand = `docker exec -it -u dev -w /home/dev/workspace ${container.name} /bin/bash`;

  return {
    id: `docker-${shortId}`,
    name: container.name,
    backend: 'docker',
    status: mapContainerState(container.state),

    // Resources
    vcpus: getContainerVcpus(),
    memoryMb: getContainerMemoryMb(),
    diskGb: getContainerDiskGb(),

    // Network
    ports: container.ports.map((p) => ({
      container: p.container,
      host: p.host,
      protocol: 'tcp',
    })),

    // Access
    terminalType: 'docker-exec',
    sshHost: container.sshPort ? 'localhost' : undefined,
    sshPort: container.sshPort ?? undefined,
    sshUser: container.sshPort ? 'root' : undefined,
    sshCommand: container.sshCommand ?? undefined,
    dockerExecCommand,
    sshKeyId: container.sshPort ? 'docker' : undefined,

    // Metadata
    image: container.image,
    createdAt: container.createdAt,

    backendMeta: meta,
  };
}

/**
 * Converts a build status to a pseudo-Sandbox
 */
function buildStatusToSandbox(buildId: string, status: BuildStatus): Sandbox {
  const meta: DockerMeta = {
    type: 'docker',
    containerId: '',
    volumes: [],
    buildId,
  };

  return {
    id: `docker-build-${buildId}`,
    name: status.name || buildId,
    backend: 'docker',
    status: status.status === 'failed' ? 'error' : 'building',
    error: status.error,

    // Resources (pending)
    vcpus: 1,
    memoryMb: 1024,
    diskGb: 10,

    // Network (pending)
    ports: [],

    // Access (not available during build)
    terminalType: 'docker-exec',

    // Metadata
    image: status.name || 'building...',
    createdAt: status.startedAt,

    backendMeta: meta,
  };
}

export class DockerAdapter implements SandboxAdapter {
  readonly backend = 'docker' as const;

  constructor(public service: DockerService = dockerService) {}

  async isAvailable(): Promise<boolean> {
    try {
      // Try to list containers to verify Docker is accessible
      await this.service.listContainers();
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<Sandbox[]> {
    const containers = await this.service.listContainers();
    const sandboxes = containers.map(containerToSandbox);

    // Include in-progress builds as pseudo-sandboxes
    const builds = listBuilds();
    for (const buildStatus of builds) {
      if (buildStatus.status === 'building' || buildStatus.status === 'failed') {
        // Don't include if we already have the container
        const containerExists = containers.some(
          (c) => c.name === buildStatus.name
        );
        if (!containerExists) {
          sandboxes.push(buildStatusToSandbox(buildStatus.id, buildStatus));
        }
      }
    }

    return sandboxes;
  }

  async get(id: string): Promise<Sandbox | null> {
    // Handle build IDs
    if (id.startsWith('docker-build-')) {
      const buildId = id.replace('docker-build-', '');
      const status = getBuild(buildId);
      return status ? buildStatusToSandbox(buildId, status) : null;
    }

    // Strip the 'docker-' prefix to get the container ID
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;

    const container = await this.service.getContainer(containerId);
    return container ? containerToSandbox(container) : null;
  }

  async create(request: CreateSandboxRequest): Promise<Sandbox> {
    // For Docker, we need either an image or a dockerfile
    if (!request.image && !request.dockerOptions?.dockerfile) {
      throw new Error('Docker sandbox requires either an image or dockerfile');
    }

    // If dockerfile is provided, we need to build first
    // For now, require an existing image - build support to be added
    if (!request.image) {
      throw new Error('Building from dockerfile not yet supported via sandbox API');
    }

    // Auto-pull the image if it doesn't exist locally
    if (!(await this.service.imageExists(request.image))) {
      console.log(`[DockerAdapter] Image '${request.image}' not found locally, pulling...`);
      await this.service.pullImage(request.image);
    }

    // Find an available SSH port
    const sshPort = await findAvailableSshPort();

    const container = await this.service.createContainer({
      name: request.name,
      image: request.image,
      sshPort,
      volumes: request.dockerOptions?.volumes,
      ports: request.ports?.map((p) => ({
        container: p.container,
        host: p.host,
      })),
      env: request.dockerOptions?.env,
    });

    // Start the container
    await container.start();

    // Get the updated container info
    const info = await this.service.getContainer(container.id);
    if (!info) {
      throw new Error('Failed to get container info after creation');
    }

    return containerToSandbox(info);
  }

  async start(id: string): Promise<Sandbox> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    await this.service.startContainer(containerId);

    const container = await this.service.getContainer(containerId);
    if (!container) {
      throw new Error(`Container ${containerId} not found after start`);
    }

    return containerToSandbox(container);
  }

  async stop(id: string): Promise<Sandbox> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    await this.service.stopContainer(containerId);

    const container = await this.service.getContainer(containerId);
    if (!container) {
      throw new Error(`Container ${containerId} not found after stop`);
    }

    return containerToSandbox(container);
  }

  async delete(id: string): Promise<void> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    await this.service.removeContainer(containerId);
  }

  async rename(id: string, name: string): Promise<void> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    await this.service.renameContainer(containerId, name);
  }

  async updateResources(
    id: string,
    resources: { vcpus?: number; memoryMb?: number; diskGb?: number },
  ): Promise<void> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    await this.service.updateContainerResources(containerId, resources);
  }

  async getLogs(id: string, options: SandboxLogOptions = {}): Promise<string> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    return this.service.getContainerLogs(containerId, {
      tail: options.tail,
      timestamps: options.timestamps ?? true,
    });
  }

  async getSSHKey(_id: string): Promise<string | null> {
    return getPrivateKey();
  }

  async getSSHCommand(id: string): Promise<string | null> {
    return (await this.get(id))?.sshCommand || null;
  }

  async uploadFile(id: string, file: SandboxFileUpload): Promise<string> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    const destinationPath = file.destinationPath || '/home/dev/workspace';
    const remotePath = `${destinationPath}/${file.filename}`;

    try {
      execFileSync('docker', ['exec', containerId, 'mkdir', '-p', posix.dirname(remotePath)], { stdio: 'pipe' });
    } catch {
      // docker cp reports a useful error if the destination is unavailable.
    }
    execFileSync('docker', ['cp', file.sourcePath, `${containerId}:${remotePath}`], { stdio: 'pipe' });
    try {
      execFileSync('docker', ['exec', containerId, 'chown', '-R', 'dev:dev', remotePath], { stdio: 'pipe' });
    } catch {
      // Ownership changes are best-effort.
    }

    return remotePath;
  }

  async uploadFiles(id: string, files: SandboxFileContent[]): Promise<number> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    const tempDir = mkdtempSync(join(tmpdir(), 'sandbox-upload-files-'));
    try {
      for (const [index, file] of files.entries()) {
        const destination = expandSandboxPath(file.destPath, '/home/dev');
        const remotePath = posix.join(destination, file.filename);
        const sourcePath = join(tempDir, `${index}-${file.filename}`);
        writeFileSync(sourcePath, file.content);

        execFileSync('docker', ['exec', containerId, 'mkdir', '-p', destination], { stdio: 'pipe' });
        execFileSync('docker', ['cp', sourcePath, `${containerId}:${remotePath}`], { stdio: 'pipe' });
        try {
          execFileSync('docker', ['exec', containerId, 'chown', 'dev:dev', remotePath], { stdio: 'pipe' });
        } catch {
          // Ownership changes are best-effort.
        }
      }
      return files.length;
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  }

  async uploadDirectory(id: string, directory: SandboxDirectoryUpload): Promise<string> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    const destinationPath = directory.destinationPath || '/home/dev/workspace';
    const remoteArchive = `/tmp/handler-upload-${process.pid}-${Date.now()}.tar.gz`;

    try {
      execFileSync('docker', ['exec', containerId, 'mkdir', '-p', destinationPath], { stdio: 'pipe' });
    } catch {
      // Extraction reports a useful error if the destination is unavailable.
    }
    execFileSync('docker', ['cp', directory.archivePath, `${containerId}:${remoteArchive}`], { stdio: 'pipe' });
    try {
      execFileSync('docker', ['exec', containerId, 'tar', '-xzf', remoteArchive, '-C', destinationPath], { stdio: 'pipe' });
    } finally {
      try {
        execFileSync('docker', ['exec', containerId, 'rm', remoteArchive], { stdio: 'pipe' });
      } catch {
        // Remote cleanup is best-effort.
      }
    }
    try {
      execFileSync('docker', ['exec', containerId, 'chown', '-R', 'dev:dev', destinationPath], { stdio: 'pipe' });
    } catch {
      // Ownership changes are best-effort.
    }

    return destinationPath;
  }

  async listFiles(id: string, path: string): Promise<SandboxFileInfo[]> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    let output: string;
    try {
      output = execFileSync('docker', ['exec', containerId, 'ls', '-la', '--time-style=long-iso', path], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch {
      output = execFileSync('docker', ['exec', containerId, 'ls', '-la', path], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
    }
    return parseLsOutput(output);
  }

  async downloadFile(id: string, path: string): Promise<Buffer> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    const tempDir = mkdtempSync(join(tmpdir(), 'sandbox-download-'));
    const destination = join(tempDir, 'downloaded-file');
    try {
      execFileSync('docker', ['cp', `${containerId}:${path}`, destination], {
        stdio: 'pipe',
        timeout: 60_000,
      });
      return readFileSync(destination);
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  }

  async getMetrics(id: string): Promise<GuestMetrics> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    return getDockerMetrics(containerId, id);
  }

  async getAgents(id: string): Promise<AgentInfo[]> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    return detectAgentsInDocker(containerId, id);
  }

  async exec(id: string, command: string, timeoutMs = 10_000): Promise<string> {
    const containerId = id.startsWith('docker-') ? id.slice(7) : id;
    return execFileSync('docker', ['exec', containerId, 'sh', '-c', command], {
      encoding: 'utf-8',
      timeout: timeoutMs,
    });
  }

  async listImages(): Promise<ImageInfo[]> {
    return this.service.listImages();
  }
}

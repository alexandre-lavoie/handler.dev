/**
 * DigitalOcean Sandbox Adapter
 *
 * Converts DigitalOcean Droplets to the unified Sandbox abstraction.
 */

import type { SandboxAdapter, SandboxDirectoryUpload, SandboxFileContent, SandboxFileInfo, SandboxFileUpload, SandboxLogOptions } from './types.js';
import type {
  Sandbox,
  SandboxStatus,
  DigitalOceanMeta,
  CreateSandboxRequest,
} from '../../types/sandbox.js';
import {
  DigitalOceanService,
  type DigitalOceanDroplet,
  type DigitalOceanSizeClass,
  DO_SIZE_PRESETS,
} from '../digitalocean.js';
import { uploadDirectoryViaScp, uploadFilesViaTar, uploadFileViaScp } from './upload.js';
import { downloadFileViaScp, listFilesViaSsh } from './files.js';
import { getCloudMetricsViaSsh, type GuestMetrics } from '../guest-metrics.js';
import type { AgentInfo } from '../agent-detect.js';
import { execViaSsh } from './exec.js';

/**
 * Maps DigitalOcean droplet status to unified SandboxStatus
 */
function mapDoStatus(status: string): SandboxStatus {
  switch (status) {
    case 'new':
      return 'creating';
    case 'active':
      return 'running';
    case 'off':
      return 'stopped';
    case 'archive':
      return 'stopped';
    default:
      return 'stopped';
  }
}

/**
 * Infer size class from size slug
 */
function inferSizeClass(sizeSlug: string): DigitalOceanSizeClass {
  for (const [key, preset] of Object.entries(DO_SIZE_PRESETS)) {
    if (preset.sizeSlug === sizeSlug) {
      return key as DigitalOceanSizeClass;
    }
  }
  return 'small';
}

/**
 * Converts a DigitalOcean droplet to Sandbox
 */
function dropletToSandbox(droplet: DigitalOceanDroplet, sshKeyPath: string): Sandbox {
  const sizeClass = inferSizeClass(droplet.sizeSlug);
  const preset = DO_SIZE_PRESETS[sizeClass] || DO_SIZE_PRESETS.small;

  const meta: DigitalOceanMeta = {
    type: 'digitalocean',
    dropletId: droplet.dropletId,
    sizeSlug: droplet.sizeSlug,
    region: droplet.region,
    publicIp: droplet.publicIp,
    privateIp: droplet.privateIp,
    doStatus: droplet.status,
  };

  return {
    id: `do-${droplet.dropletId}`,
    name: droplet.name,
    backend: 'digitalocean',
    status: mapDoStatus(droplet.status),
    error: undefined,

    // Resources
    vcpus: preset.vcpus,
    memoryMb: preset.memoryMb,
    diskGb: preset.diskGb,

    // Network
    ports: [],
    guestIp: droplet.publicIp || droplet.privateIp,

    // Access - DigitalOcean uses SSH as root
    terminalType: 'ssh',
    sshHost: droplet.publicIp,
    sshPort: 22,
    sshUser: 'root',
    sshCommand: droplet.publicIp
      ? `ssh -i ${sshKeyPath} root@${droplet.publicIp}`
      : undefined,

    // Metadata
    image: `digitalocean-${sizeClass} (${droplet.sizeSlug})`,
    createdAt: droplet.createdAt || new Date().toISOString(),
    startedAt: droplet.status === 'active' ? droplet.createdAt : undefined,

    backendMeta: meta,
  };
}

export class DigitalOceanAdapter implements SandboxAdapter {
  readonly backend = 'digitalocean' as const;

  constructor(private doService: DigitalOceanService) {}

  async isAvailable(): Promise<boolean> {
    return this.doService.isAvailable();
  }

  async list(): Promise<Sandbox[]> {
    try {
      const droplets = await this.doService.listDroplets();
      const sshKeyPath = this.doService.getSshKeyPath();
      return droplets.map((droplet) => dropletToSandbox(droplet, sshKeyPath));
    } catch (error) {
      console.error('[DigitalOceanAdapter] Failed to list droplets:', error);
      return [];
    }
  }

  async get(id: string): Promise<Sandbox | null> {
    // Strip the 'do-' prefix to get the droplet ID
    const dropletIdStr = id.startsWith('do-') ? id.slice(3) : id;
    const dropletId = parseInt(dropletIdStr, 10);

    if (isNaN(dropletId)) return null;

    try {
      const droplet = await this.doService.getDroplet(dropletId);
      if (!droplet) return null;
      const sshKeyPath = this.doService.getSshKeyPath();
      return dropletToSandbox(droplet, sshKeyPath);
    } catch {
      return null;
    }
  }

  async create(request: CreateSandboxRequest): Promise<Sandbox> {
    // Determine size class from resources or options
    let sizeClass: DigitalOceanSizeClass = 'small';

    if (request.digitaloceanOptions?.sizeClass) {
      sizeClass = request.digitaloceanOptions.sizeClass;
    } else if (request.vcpus && request.memoryMb) {
      if (request.vcpus >= 4 || request.memoryMb >= 8192) {
        sizeClass = 'large';
      } else if (request.vcpus >= 2 || request.memoryMb >= 4096) {
        sizeClass = 'medium';
      }
    }

    const droplet = await this.doService.createDroplet({
      name: request.name,
      sizeClass,
      sizeSlug: request.digitaloceanOptions?.sizeSlug,
      region: request.digitaloceanOptions?.region,
    });

    const sshKeyPath = this.doService.getSshKeyPath();
    return dropletToSandbox(droplet, sshKeyPath);
  }

  async start(id: string): Promise<Sandbox> {
    const dropletIdStr = id.startsWith('do-') ? id.slice(3) : id;
    const dropletId = parseInt(dropletIdStr, 10);
    await this.doService.startDroplet(dropletId);
    const droplet = await this.doService.getDroplet(dropletId);
    if (!droplet) {
      throw new Error(`Droplet ${dropletId} not found after start`);
    }
    const sshKeyPath = this.doService.getSshKeyPath();
    return dropletToSandbox(droplet, sshKeyPath);
  }

  async stop(id: string): Promise<Sandbox> {
    const dropletIdStr = id.startsWith('do-') ? id.slice(3) : id;
    const dropletId = parseInt(dropletIdStr, 10);
    await this.doService.stopDroplet(dropletId);
    const droplet = await this.doService.getDroplet(dropletId);
    if (!droplet) {
      throw new Error(`Droplet ${dropletId} not found after stop`);
    }
    const sshKeyPath = this.doService.getSshKeyPath();
    return dropletToSandbox(droplet, sshKeyPath);
  }

  async delete(id: string): Promise<void> {
    const dropletIdStr = id.startsWith('do-') ? id.slice(3) : id;
    const dropletId = parseInt(dropletIdStr, 10);
    await this.doService.deleteDroplet(dropletId);
  }

  async rename(_id: string, _name: string): Promise<void> {
    throw new Error('Renaming is not supported for digitalocean sandboxes');
  }

  async updateResources(
    _id: string,
    _resources: { vcpus?: number; memoryMb?: number; diskGb?: number },
  ): Promise<void> {
    throw new Error('Resource reconfiguration is not supported for digitalocean sandboxes');
  }

  async getLogs(_id: string, _options?: SandboxLogOptions): Promise<string> {
    return '[DigitalOcean droplets: Use SSH to view logs directly on the droplet]';
  }

  async getSSHKey(_id: string): Promise<string | null> {
    return this.doService.getSshPrivateKey();
  }

  async getSSHCommand(id: string): Promise<string | null> {
    return (await this.get(id))?.sshCommand || null;
  }

  async uploadFile(id: string, file: SandboxFileUpload): Promise<string> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('Instance does not have a public IP address');
    const key = await this.doService.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available');

    return uploadFileViaScp({
      sourcePath: file.sourcePath,
      destinationPath: file.destinationPath || '/root',
      filename: file.filename,
      host: sandbox.guestIp,
      user: sandbox.sshUser || 'root',
      keyContent: key,
    });
  }

  async uploadFiles(id: string, files: SandboxFileContent[]): Promise<number> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('Instance does not have a public IP address');
    const key = await this.doService.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available');

    return uploadFilesViaTar({
      files,
      host: sandbox.guestIp,
      user: sandbox.sshUser || 'root',
      home: '/root',
      keyContent: key,
    });
  }

  async uploadDirectory(id: string, directory: SandboxDirectoryUpload): Promise<string> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('Instance does not have a public IP address');
    const key = await this.doService.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available');

    return uploadDirectoryViaScp({
      archivePath: directory.archivePath,
      destinationPath: directory.destinationPath || '/root',
      host: sandbox.guestIp,
      user: sandbox.sshUser || 'root',
      keyContent: key,
    });
  }

  async listFiles(id: string, path: string): Promise<SandboxFileInfo[]> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('Instance does not have an IP address');
    const key = await this.doService.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available');

    return listFilesViaSsh({ path, host: sandbox.guestIp, user: sandbox.sshUser || 'root', keyContent: key });
  }

  async downloadFile(id: string, path: string): Promise<Buffer> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('Instance does not have a public IP address');
    const key = await this.doService.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available');

    return downloadFileViaScp({ path, host: sandbox.guestIp, user: sandbox.sshUser || 'root', keyContent: key });
  }

  async getMetrics(id: string): Promise<GuestMetrics | null> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) return null;
    const key = await this.doService.getSshPrivateKey();
    if (!key) return null;

    return getCloudMetricsViaSsh(sandbox.guestIp, 22, sandbox.sshUser || 'root', key, id);
  }

  async getAgents(_id: string): Promise<AgentInfo[]> {
    return [];
  }

  async exec(id: string, command: string, timeoutMs = 10_000): Promise<string> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('Instance does not have a public IP address');
    const key = await this.doService.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available');

    return execViaSsh({
      command,
      host: sandbox.guestIp,
      user: sandbox.sshUser || 'root',
      keyContent: key,
      timeoutMs,
    });
  }
}

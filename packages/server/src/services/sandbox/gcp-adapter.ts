/**
 * GCP Sandbox Adapter
 *
 * Converts GCP Compute Engine instances to the unified Sandbox abstraction.
 */

import type { SandboxAdapter, SandboxDirectoryUpload, SandboxFileInfo, SandboxFileUpload, SandboxLogOptions } from './types.js';
import type {
  Sandbox,
  SandboxStatus,
  GcpMeta,
  CreateSandboxRequest,
} from '../../types/sandbox.js';
import {
  GcpService,
  type GcpInstance,
  GCP_SIZE_PRESETS,
  GCP_SSH_KEY_PATH,
  type GcpSizeClass,
} from '../gcp.js';
import { uploadDirectoryViaScp, uploadFileViaScp } from './upload.js';
import { downloadFileViaScp, listFilesViaSsh } from './files.js';
import { getCloudMetricsViaSsh, type GuestMetrics } from '../guest-metrics.js';
import type { AgentInfo } from '../agent-detect.js';

/**
 * Maps GCP instance status to unified SandboxStatus
 */
function mapGcpStatus(status: string): SandboxStatus {
  switch (status) {
    case 'PROVISIONING':
    case 'STAGING':
      return 'creating';
    case 'RUNNING':
      return 'running';
    case 'STOPPING':
      return 'stopping';
    case 'TERMINATED':
    case 'STOPPED':
    case 'SUSPENDED':
      return 'stopped';
    default:
      return 'stopped';
  }
}

/**
 * Converts a GCP instance to Sandbox
 */
function instanceToSandbox(instance: GcpInstance, projectId: string): Sandbox {
  const sizeClass = (instance.labels['handler-size-class'] || 'small') as GcpSizeClass;
  const preset = GCP_SIZE_PRESETS[sizeClass] || GCP_SIZE_PRESETS.small;

  const meta: GcpMeta = {
    type: 'gcp',
    instanceName: instance.instanceName,
    machineType: instance.machineType,
    zone: instance.zone,
    projectId,
    publicIp: instance.publicIp,
    privateIp: instance.privateIp,
    gcpStatus: instance.status,
    creationTimestamp: instance.creationTimestamp,
  };

  return {
    id: `gcp-${instance.instanceName}`,
    name: instance.name,
    backend: 'gcp',
    status: mapGcpStatus(instance.status),
    error: undefined,

    // Resources
    vcpus: preset.vcpus,
    memoryMb: preset.memoryMb,
    diskGb: preset.diskGb,

    // Network
    ports: [],
    guestIp: instance.publicIp || instance.privateIp,

    // Access
    terminalType: 'ssh',
    sshHost: instance.publicIp,
    sshPort: 22,
    sshUser: 'handler',
    sshCommand: instance.publicIp
      ? `ssh -i ${GCP_SSH_KEY_PATH} handler@${instance.publicIp}`
      : undefined,

    // Metadata
    image: `gcp-${sizeClass} (${instance.machineType})`,
    createdAt: instance.creationTimestamp || new Date().toISOString(),
    startedAt: instance.status === 'RUNNING' ? instance.creationTimestamp : undefined,

    backendMeta: meta,
  };
}

export class GcpAdapter implements SandboxAdapter {
  readonly backend = 'gcp' as const;

  constructor(private gcp: GcpService) {}

  async isAvailable(): Promise<boolean> {
    return this.gcp.isAvailable();
  }

  async list(): Promise<Sandbox[]> {
    try {
      const instances = await this.gcp.listInstances();
      const projectId = this.gcp.getProjectId();
      return instances.map((instance) => instanceToSandbox(instance, projectId));
    } catch (error) {
      console.error('[GcpAdapter] Failed to list instances:', error);
      return [];
    }
  }

  async get(id: string): Promise<Sandbox | null> {
    const instanceName = id.startsWith('gcp-') ? id.slice(4) : id;

    try {
      const instance = await this.gcp.getInstance(instanceName);
      if (!instance) return null;
      const projectId = this.gcp.getProjectId();
      return instanceToSandbox(instance, projectId);
    } catch {
      return null;
    }
  }

  async create(request: CreateSandboxRequest): Promise<Sandbox> {
    let sizeClass: GcpSizeClass = 'small';

    if (request.gcpOptions?.sizeClass) {
      sizeClass = request.gcpOptions.sizeClass;
    } else if (request.vcpus && request.memoryMb) {
      if (request.vcpus >= 4 || request.memoryMb >= 8192) {
        sizeClass = 'large';
      } else if (request.vcpus >= 2 || request.memoryMb >= 4096) {
        sizeClass = 'medium';
      }
    }

    const instance = await this.gcp.createInstance({
      name: request.name,
      sizeClass,
      machineType: request.gcpOptions?.machineType,
      diskSizeGb: request.diskGb,
      zone: request.gcpOptions?.zone,
    });

    const projectId = this.gcp.getProjectId();
    return instanceToSandbox(instance, projectId);
  }

  async start(id: string): Promise<Sandbox> {
    const instanceName = id.startsWith('gcp-') ? id.slice(4) : id;
    const instance = await this.gcp.startInstance(instanceName);
    const projectId = this.gcp.getProjectId();
    return instanceToSandbox(instance, projectId);
  }

  async stop(id: string): Promise<Sandbox> {
    const instanceName = id.startsWith('gcp-') ? id.slice(4) : id;
    const instance = await this.gcp.stopInstance(instanceName);
    const projectId = this.gcp.getProjectId();
    return instanceToSandbox(instance, projectId);
  }

  async delete(id: string): Promise<void> {
    const instanceName = id.startsWith('gcp-') ? id.slice(4) : id;
    await this.gcp.deleteInstance(instanceName);
  }

  async rename(_id: string, _name: string): Promise<void> {
    throw new Error('Renaming is not supported for gcp sandboxes');
  }

  async updateResources(
    _id: string,
    _resources: { vcpus?: number; memoryMb?: number; diskGb?: number },
  ): Promise<void> {
    throw new Error('Resource reconfiguration is not supported for gcp sandboxes');
  }

  async getLogs(_id: string, _options?: SandboxLogOptions): Promise<string> {
    return '[GCP instances: Use SSH to view logs directly on the instance]';
  }

  async getSSHKey(_id: string): Promise<string | null> {
    return this.gcp.getSshPrivateKey();
  }

  async getSSHCommand(id: string): Promise<string | null> {
    return (await this.get(id))?.sshCommand || null;
  }

  async uploadFile(id: string, file: SandboxFileUpload): Promise<string> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('Instance does not have a public IP address');
    const key = await this.gcp.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available');

    return uploadFileViaScp({
      sourcePath: file.sourcePath,
      destinationPath: file.destinationPath || '/home/handler',
      filename: file.filename,
      host: sandbox.guestIp,
      user: sandbox.sshUser || 'handler',
      keyContent: key,
    });
  }

  async uploadDirectory(id: string, directory: SandboxDirectoryUpload): Promise<string> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('Instance does not have a public IP address');
    const key = await this.gcp.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available');

    return uploadDirectoryViaScp({
      archivePath: directory.archivePath,
      destinationPath: directory.destinationPath || '/home/handler',
      host: sandbox.guestIp,
      user: sandbox.sshUser || 'handler',
      keyContent: key,
    });
  }

  async listFiles(id: string, path: string): Promise<SandboxFileInfo[]> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('Instance does not have an IP address');
    const key = await this.gcp.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available');

    return listFilesViaSsh({ path, host: sandbox.guestIp, user: sandbox.sshUser || 'handler', keyContent: key });
  }

  async downloadFile(id: string, path: string): Promise<Buffer> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('Instance does not have a public IP address');
    const key = await this.gcp.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available');

    return downloadFileViaScp({ path, host: sandbox.guestIp, user: sandbox.sshUser || 'handler', keyContent: key });
  }

  async getMetrics(id: string): Promise<GuestMetrics | null> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) return null;
    const key = await this.gcp.getSshPrivateKey();
    if (!key) return null;

    return getCloudMetricsViaSsh(sandbox.guestIp, 22, sandbox.sshUser || 'root', key, id);
  }

  async getAgents(_id: string): Promise<AgentInfo[]> {
    return [];
  }
}

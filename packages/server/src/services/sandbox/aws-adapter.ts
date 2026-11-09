/**
 * AWS Sandbox Adapter
 *
 * Converts AWS EC2 instances to the unified Sandbox abstraction.
 */

import type { SandboxAdapter, SandboxDirectoryUpload, SandboxFileContent, SandboxFileInfo, SandboxFileUpload, SandboxLogOptions } from './types.js';
import type {
  Sandbox,
  SandboxStatus,
  AwsMeta,
  CreateSandboxRequest,
} from '../../types/sandbox.js';
import {
  AwsService,
  type AwsInstance,
  type Ec2InstanceState,
  AWS_SIZE_PRESETS,
  AWS_SSH_KEY_PATH,
  type AwsSizeClass,
} from '../aws.js';
import { uploadDirectoryViaScp, uploadFilesViaTar, uploadFileViaScp } from './upload.js';
import { downloadFileViaScp, listFilesViaSsh } from './files.js';
import { getCloudMetricsViaSsh, type GuestMetrics } from '../guest-metrics.js';
import type { AgentInfo } from '../agent-detect.js';
import { execViaSsh } from './exec.js';

/**
 * Maps EC2 instance state to unified SandboxStatus
 */
function mapEc2State(state: Ec2InstanceState): SandboxStatus {
  switch (state) {
    case 'pending':
      return 'creating';
    case 'running':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'stopped':
      return 'stopped';
    case 'shutting-down':
    case 'terminated':
      return 'stopped';
    default:
      return 'stopped';
  }
}

/**
 * Converts an AWS instance to Sandbox
 */
function instanceToSandbox(instance: AwsInstance, region: string): Sandbox {
  const sizeClass = (instance.tags['handler:sizeClass'] || 'small') as AwsSizeClass;
  const preset = AWS_SIZE_PRESETS[sizeClass] || AWS_SIZE_PRESETS.small;

  const meta: AwsMeta = {
    type: 'aws',
    instanceId: instance.instanceId,
    instanceType: instance.instanceType,
    spotRequestId: instance.spotRequestId,
    volumeId: instance.volumeId,
    availabilityZone: instance.availabilityZone,
    publicIp: instance.publicIp,
    privateIp: instance.privateIp,
    region,
    ec2State: instance.state,
    launchTime: instance.launchTime?.toISOString(),
    securityGroupId: instance.securityGroupId,
    subnetId: instance.subnetId,
    vpcId: instance.vpcId,
  };

  return {
    id: `aws-${instance.instanceId}`,
    name: instance.name,
    backend: 'aws',
    status: mapEc2State(instance.state),
    error: undefined,

    // Resources (from size preset or defaults)
    vcpus: preset.vcpus,
    memoryMb: preset.memoryMb,
    diskGb: preset.diskGb,

    // Network - AWS instances don't expose internal port mappings
    ports: [],
    guestIp: instance.publicIp || instance.privateIp,

    // Access - AWS uses SSH
    terminalType: 'ssh',
    sshHost: instance.publicIp,
    sshPort: 22,
    sshUser: 'ubuntu',
    sshCommand: instance.publicIp
      ? `ssh -i ${AWS_SSH_KEY_PATH} ubuntu@${instance.publicIp}`
      : undefined,

    // Metadata
    image: `aws-${sizeClass} (${instance.instanceType})`,
    createdAt: instance.launchTime?.toISOString() || new Date().toISOString(),
    startedAt: instance.state === 'running' ? instance.launchTime?.toISOString() : undefined,

    backendMeta: meta,
  };
}

export class AwsAdapter implements SandboxAdapter {
  readonly backend = 'aws' as const;

  constructor(private aws: AwsService) {}

  async isAvailable(): Promise<boolean> {
    return this.aws.isAvailable();
  }

  async list(): Promise<Sandbox[]> {
    try {
      const instances = await this.aws.listInstances();
      const region = this.aws.getRegion();
      return instances.map((instance) => instanceToSandbox(instance, region));
    } catch (error) {
      console.error('[AwsAdapter] Failed to list instances:', error);
      return [];
    }
  }

  async get(id: string): Promise<Sandbox | null> {
    // Strip the 'aws-' prefix to get the instance ID
    const instanceId = id.startsWith('aws-') ? id.slice(4) : id;

    try {
      const instance = await this.aws.getInstance(instanceId);
      if (!instance) return null;
      const region = this.aws.getRegion();
      return instanceToSandbox(instance, region);
    } catch {
      return null;
    }
  }

  async create(request: CreateSandboxRequest): Promise<Sandbox> {
    // Determine size class from resources or options
    let sizeClass: AwsSizeClass = 'small';

    if (request.awsOptions?.sizeClass) {
      sizeClass = request.awsOptions.sizeClass;
    } else if (request.vcpus && request.memoryMb) {
      // Infer size class from resources
      if (request.vcpus >= 4 || request.memoryMb >= 8192) {
        sizeClass = 'large';
      } else if (request.vcpus >= 2 || request.memoryMb >= 4096) {
        sizeClass = 'medium';
      }
    }

    const instance = await this.aws.createInstance({
      name: request.name,
      sizeClass,
      purchaseType: request.awsOptions?.purchaseType || 'spot',
      instanceType: request.awsOptions?.instanceType,
      amiId: request.awsOptions?.amiId,
      volumeId: request.awsOptions?.volumeId,
      volumeSizeGb: request.awsOptions?.volumeSizeGb || request.diskGb,
      availabilityZone: request.awsOptions?.availabilityZone,
      subnetId: request.awsOptions?.subnetId,
      securityGroupIds: request.awsOptions?.securityGroupIds,
    });

    const region = this.aws.getRegion();
    return instanceToSandbox(instance, region);
  }

  async start(id: string): Promise<Sandbox> {
    const instanceId = id.startsWith('aws-') ? id.slice(4) : id;
    const instance = await this.aws.startInstance(instanceId);
    const region = this.aws.getRegion();
    return instanceToSandbox(instance, region);
  }

  async stop(id: string): Promise<Sandbox> {
    const instanceId = id.startsWith('aws-') ? id.slice(4) : id;
    const instance = await this.aws.stopInstance(instanceId);
    const region = this.aws.getRegion();
    return instanceToSandbox(instance, region);
  }

  async delete(id: string): Promise<void> {
    const instanceId = id.startsWith('aws-') ? id.slice(4) : id;
    await this.aws.terminateInstance(instanceId);
  }

  async rename(_id: string, _name: string): Promise<void> {
    throw new Error('Renaming is not supported for aws sandboxes');
  }

  async updateResources(
    _id: string,
    _resources: { vcpus?: number; memoryMb?: number; diskGb?: number },
  ): Promise<void> {
    throw new Error('Resource reconfiguration is not supported for aws sandboxes');
  }

  async getLogs(_id: string, _options?: SandboxLogOptions): Promise<string> {
    return '[AWS instances: Use SSH to view logs directly on the instance]';
  }

  async getSSHKey(_id: string): Promise<string | null> {
    return this.aws.getSshPrivateKey();
  }

  async getSSHCommand(id: string): Promise<string | null> {
    const instanceId = id.startsWith('aws-') ? id.slice(4) : id;
    return this.aws.getSshCommand(instanceId);
  }

  async uploadFile(id: string, file: SandboxFileUpload): Promise<string> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('AWS instance does not have a public IP address');
    const key = await this.aws.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available for AWS instances');

    return uploadFileViaScp({
      sourcePath: file.sourcePath,
      destinationPath: file.destinationPath || '/home/ubuntu',
      filename: file.filename,
      host: sandbox.guestIp,
      user: 'ubuntu',
      keyContent: key,
    });
  }

  async uploadFiles(id: string, files: SandboxFileContent[]): Promise<number> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('AWS instance does not have a public IP address');
    const key = await this.aws.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available for AWS instances');

    return uploadFilesViaTar({
      files,
      host: sandbox.guestIp,
      user: 'ubuntu',
      home: '/home/ubuntu',
      keyContent: key,
    });
  }

  async uploadDirectory(id: string, directory: SandboxDirectoryUpload): Promise<string> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('AWS instance does not have a public IP address');
    const key = await this.aws.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available for AWS instances');

    return uploadDirectoryViaScp({
      archivePath: directory.archivePath,
      destinationPath: directory.destinationPath || '/home/ubuntu',
      host: sandbox.guestIp,
      user: 'ubuntu',
      keyContent: key,
    });
  }

  async listFiles(id: string, path: string): Promise<SandboxFileInfo[]> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('AWS instance does not have a public IP address');
    const key = await this.aws.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available for AWS instances');

    return listFilesViaSsh({ path, host: sandbox.guestIp, user: 'ubuntu', keyContent: key });
  }

  async downloadFile(id: string, path: string): Promise<Buffer> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('AWS instance does not have a public IP address');
    const key = await this.aws.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available for AWS instances');

    return downloadFileViaScp({ path, host: sandbox.guestIp, user: 'ubuntu', keyContent: key });
  }

  async getMetrics(id: string): Promise<GuestMetrics | null> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) return null;
    const key = await this.aws.getSshPrivateKey();
    if (!key) return null;

    return getCloudMetricsViaSsh(sandbox.guestIp, 22, sandbox.sshUser || 'root', key, id);
  }

  async getAgents(_id: string): Promise<AgentInfo[]> {
    return [];
  }

  async exec(id: string, command: string, timeoutMs = 10_000): Promise<string> {
    const sandbox = await this.get(id);
    if (!sandbox?.guestIp) throw new Error('AWS instance does not have a public IP address');
    const key = await this.aws.getSshPrivateKey();
    if (!key) throw new Error('SSH key not available for AWS instances');

    return execViaSsh({ command, host: sandbox.guestIp, user: 'ubuntu', keyContent: key, timeoutMs });
  }
}

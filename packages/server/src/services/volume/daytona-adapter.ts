/**
 * Daytona Volume Adapter
 *
 * Wraps Daytona volume operations for the unified Volume abstraction.
 */

import type {
  Volume,
  VolumeFileInfo,
  CreateVolumeRequest,
  DaytonaVolumeMeta,
  VolumeStatus,
} from '../../types/volume.js';
import { DaytonaService } from '../daytona.js';

/**
 * Maps Daytona volume state to unified VolumeStatus
 */
function mapDaytonaState(state: string): VolumeStatus {
  switch (state) {
    case 'creating':
      return 'creating';
    case 'ready':
      return 'ready';
    case 'deleting':
      return 'deleting';
    case 'error':
      return 'error';
    default:
      return 'ready';
  }
}

/**
 * Converts a Daytona volume to the unified Volume type
 */
function daytonaVolumeToVolume(vol: {
  id: string;
  name: string;
  organizationId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
}): Volume {
  const meta: DaytonaVolumeMeta = {
    type: 'daytona',
    organizationId: vol.organizationId,
    daytonaState: vol.state,
  };

  return {
    id: `vol-daytona-${vol.id}`,
    name: vol.name,
    backend: 'daytona',
    status: mapDaytonaState(vol.state),
    attachedTo: [], // Daytona tracks this differently
    createdAt: vol.createdAt,
    backendMeta: meta,
  };
}

export class DaytonaVolumeAdapter {
  readonly backend = 'daytona' as const;

  constructor(private service: DaytonaService) {}

  async isAvailable(): Promise<boolean> {
    try {
      return await this.service.isAvailable();
    } catch {
      return false;
    }
  }

  async list(): Promise<Volume[]> {
    try {
      const volumes = await this.service.listVolumes();
      return volumes.map(daytonaVolumeToVolume);
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<Volume | null> {
    // Extract the Daytona volume ID from the unified ID
    const daytonaVolId = id.replace(/^vol-daytona-/, '');

    try {
      const vol = await this.service.getVolume(daytonaVolId);
      return vol ? daytonaVolumeToVolume(vol) : null;
    } catch {
      return null;
    }
  }

  async create(request: CreateVolumeRequest): Promise<Volume> {
    const vol = await this.service.createVolume(request.name);
    return daytonaVolumeToVolume(vol);
  }

  async delete(id: string): Promise<void> {
    const daytonaVolId = id.replace(/^vol-daytona-/, '');
    await this.service.deleteVolume(daytonaVolId);
  }

  async listFiles(id: string, path: string = '/'): Promise<VolumeFileInfo[]> {
    // Daytona volumes are S3-backed and don't support direct file listing
    throw new Error('File listing not supported for Daytona volumes. Access files through a workspace.');
  }

  async uploadFile(id: string, filename: string, content: Buffer, destPath: string = '/'): Promise<void> {
    throw new Error('File upload not supported for Daytona volumes. Access files through a workspace.');
  }

  async downloadFile(id: string, filePath: string): Promise<Buffer> {
    throw new Error('File download not supported for Daytona volumes. Access files through a workspace.');
  }

  async deleteFile(id: string, filePath: string): Promise<void> {
    throw new Error('File deletion not supported for Daytona volumes. Access files through a workspace.');
  }
}

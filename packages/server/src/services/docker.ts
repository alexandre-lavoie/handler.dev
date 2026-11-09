import Docker from 'dockerode';
import { PassThrough } from 'stream';
import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { posix } from 'path';
import * as tar from 'tar-stream';
import type { ContainerInfo, VolumeInfo, ImageInfo } from '../types/index.js';
import type { SandboxDirectoryUpload, SandboxFileContent, SandboxFileInfo, SandboxFileUpload } from './sandbox/types.js';
import { parseLsOutput } from './sandbox/files.js';
import { expandSandboxPath } from './sandbox/upload.js';
import { getConfig } from './config.js';

const CONTAINER_LABEL = 'handler';
const IMAGE_LABEL = 'handler';
const DOCKER_CHECK_INTERVAL = 30_000;

export class DockerService {
  private dockerAvailable: boolean | null = null;
  private dockerCheckTime = 0;

  constructor(private readonly docker: Docker = new Docker()) {}

  isAvailable(): boolean {
    return true;
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [CONTAINER_LABEL] },
    });

    return containers.map((container) => {
      const sshPort = this.extractSshPort(container.Ports);
      return {
        id: container.Id,
        name: container.Names[0]?.replace(/^\//, '') || '',
        image: container.Image,
        status: container.Status,
        state: this.mapState(container.State),
        sshPort,
        sshCommand: sshPort ? `ssh -p ${sshPort} dev@localhost` : null,
        volumes: this.extractVolumes(container.Mounts),
        ports: this.extractPorts(container.Ports),
        createdAt: new Date(container.Created * 1000).toISOString(),
      };
    });
  }

  async getContainer(id: string): Promise<ContainerInfo | null> {
    try {
      const container = this.docker.getContainer(id);
      const info = await container.inspect();

      const sshPort = this.extractSshPortFromInspect(info.NetworkSettings.Ports);
      return {
        id: info.Id,
        name: info.Name.replace(/^\//, ''),
        image: info.Config.Image,
        status: info.State.Status,
        state: this.mapState(info.State.Status),
        sshPort,
        sshCommand: sshPort ? `ssh -p ${sshPort} root@localhost` : null,
        volumes: this.extractVolumesFromInspect(info.Mounts),
        ports: this.extractPortsFromInspect(info.NetworkSettings.Ports),
        createdAt: info.Created,
      };
    } catch {
      return null;
    }
  }

  async createContainer(options: {
    name: string;
    image: string;
    sshPort: number;
    volumes?: Array<{ name: string; mountPath: string }>;
    ports?: Array<{ container: number; host: number }>;
    env?: Record<string, string>;
  }): Promise<Docker.Container> {
    const { name, image, sshPort, volumes = [], ports = [], env = {} } = options;

    // Convert volume names to local directory paths for bind mounts
    const binds: string[] = [];
    for (const v of volumes) {
      const volumePath = await this.getVolumePath(v.name);
      binds.push(`${volumePath}:${v.mountPath}`);
    }
    const envArray = Object.entries(env).map(([k, v]) => `${k}=${v}`);

    // Build exposed ports and port bindings
    const exposedPorts: Record<string, object> = { '22/tcp': {} };
    const portBindings: Record<string, Array<{ HostPort: string }>> = {
      '22/tcp': [{ HostPort: sshPort.toString() }],
    };

    for (const port of ports) {
      const key = `${port.container}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: port.host.toString() }];
    }

    const container = await this.docker.createContainer({
      name,
      Hostname: name,
      Image: image,
      Labels: { [CONTAINER_LABEL]: 'true' },
      Env: envArray,
      Tty: true,
      OpenStdin: true,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        Binds: binds.length > 0 ? binds : undefined,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });

    return container;
  }

  async startContainer(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    const info = await container.inspect();

    // Don't try to start if already running
    if (info.State.Running) {
      return;
    }

    await container.start();
  }

  async stopContainer(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    const info = await container.inspect();

    // Don't try to stop if not running
    if (!info.State.Running) {
      return;
    }

    await container.stop();
  }

  async removeContainer(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.remove({ force: true });
  }

  async renameContainer(id: string, newName: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.rename({ name: newName });
  }

  async updateContainerResources(id: string, resources: { vcpus?: number; memoryMb?: number; diskGb?: number }): Promise<void> {
    const container = this.docker.getContainer(id);
    const updateConfig: Record<string, unknown> = {};

    if (resources.memoryMb !== undefined) {
      updateConfig.Memory = resources.memoryMb * 1024 * 1024; // Convert MB to bytes
      updateConfig.MemorySwap = resources.memoryMb * 1024 * 1024 * 2; // 2x for swap
    }
    if (resources.vcpus !== undefined) {
      // NanoCPUs: number of CPUs * 1e9
      updateConfig.NanoCpus = resources.vcpus * 1e9;
    }

    if (Object.keys(updateConfig).length > 0) {
      await container.update(updateConfig);
    }
  }

  async listImages(): Promise<ImageInfo[]> {
    // Get handler-labeled images
    const handlerImages = await this.docker.listImages({
      filters: { label: [IMAGE_LABEL] },
    });

    // Also include ubuntu:24.04 if present
    const allImages = await this.docker.listImages({});
    const ubuntuImage = allImages.filter(img =>
      img.RepoTags?.some(tag => tag === 'ubuntu:24.04')
    );

    // Combine and dedupe by ID
    const seenIds = new Set<string>();
    const images = [...handlerImages, ...ubuntuImage].filter(img => {
      if (seenIds.has(img.Id)) return false;
      seenIds.add(img.Id);
      return true;
    });

    // Fetch detailed info for each image to get labels
    const imageInfos: ImageInfo[] = [];
    for (const img of images) {
      try {
        const image = this.docker.getImage(img.Id);
        const inspect = await image.inspect();
        const labels = inspect.Config?.Labels || {};

        // Decode Dockerfile content if present
        let dockerfile: string | undefined;
        if (labels['handler.dockerfile']) {
          try {
            dockerfile = Buffer.from(labels['handler.dockerfile'], 'base64').toString('utf-8');
          } catch {
            // If decoding fails, use raw value
            dockerfile = labels['handler.dockerfile'];
          }
        }

        imageInfos.push({
          id: img.Id,
          repoTags: img.RepoTags || [],
          size: img.Size,
          created: new Date(img.Created * 1000).toISOString(),
          dockerfile,
          dockerfileName: labels['handler.dockerfile-name'],
        });
      } catch {
        // If inspection fails, return basic info
        imageInfos.push({
          id: img.Id,
          repoTags: img.RepoTags || [],
          size: img.Size,
          created: new Date(img.Created * 1000).toISOString(),
        });
      }
    }

    return imageInfos;
  }

  async pullImage(imageName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }
        this.docker.modem.followProgress(stream, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  async removeImage(id: string): Promise<void> {
    const image = this.docker.getImage(id);
    await image.remove({ force: true });
  }

  async renameImage(currentTag: string, newTag: string): Promise<void> {
    const image = this.docker.getImage(currentTag);
    // Tag with new name
    await image.tag({ repo: newTag.split(':')[0], tag: newTag.split(':')[1] || 'latest' });
    // Remove old tag (but not the image itself if it has other tags)
    try {
      await this.docker.getImage(currentTag).remove({ force: false, noprune: true });
    } catch {
      // Old tag might already be removed or shared with other references
    }
  }

  async imageExists(imageName: string): Promise<boolean> {
    try {
      const image = this.docker.getImage(imageName);
      await image.inspect();
      return true;
    } catch {
      return false;
    }
  }

  async imageHasLabel(imageName: string, label: string): Promise<boolean> {
    try {
      const image = this.docker.getImage(imageName);
      const info = await image.inspect();
      return info.Config?.Labels?.[label] === 'true';
    } catch {
      // Image doesn't exist or can't be inspected
      return false;
    }
  }

  async buildImage(dockerfile: string, tag: string): Promise<void> {
    const tar = await this.createTarFromDockerfile(dockerfile);

    return new Promise((resolve, reject) => {
      this.docker.buildImage(tar, { t: tag, labels: { [IMAGE_LABEL]: 'true' }, rm: true }, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        if (!stream) {
          reject(new Error('No stream returned from buildImage'));
          return;
        }

        let buildError: string | null = null;

        stream.on('data', (chunk: Buffer) => {
          try {
            const lines = chunk.toString().split('\n').filter(Boolean);
            for (const line of lines) {
              const json = JSON.parse(line);
              if (json.error) {
                buildError = json.error;
              }
            }
          } catch {
            // Ignore parse errors
          }
        });

        this.docker.modem.followProgress(stream, (err) => {
          if (err) {
            reject(err);
          } else if (buildError) {
            reject(new Error(buildError));
          } else {
            resolve();
          }
        });
      });
    });
  }

  async buildImageWithLogs(
    dockerfile: string,
    tag: string,
    onLog: (message: string) => void,
    dockerfileName?: string
  ): Promise<void> {
    const tar = await this.createTarFromDockerfile(dockerfile);

    // Build labels including Dockerfile content (base64 encoded)
    const labels: Record<string, string> = {
      [IMAGE_LABEL]: 'true',
      'handler.dockerfile': Buffer.from(dockerfile).toString('base64'),
    };
    if (dockerfileName) {
      labels['handler.dockerfile-name'] = dockerfileName;
    }

    return new Promise((resolve, reject) => {
      this.docker.buildImage(tar, { t: tag, labels, rm: true }, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        if (!stream) {
          reject(new Error('No stream returned from buildImage'));
          return;
        }

        let buildError: string | null = null;

        stream.on('data', (chunk: Buffer) => {
          try {
            const lines = chunk.toString().split('\n').filter(Boolean);
            for (const line of lines) {
              const json = JSON.parse(line);
              if (json.stream) {
                onLog(json.stream);
              } else if (json.error) {
                buildError = json.error;
                onLog(`ERROR: ${json.error}`);
              } else if (json.status) {
                onLog(`${json.status}${json.progress ? ` ${json.progress}` : ''}`);
              }
            }
          } catch {
            onLog(chunk.toString());
          }
        });

        this.docker.modem.followProgress(stream, (err) => {
          if (err) {
            reject(err);
          } else if (buildError) {
            reject(new Error(buildError));
          } else {
            resolve();
          }
        });
      });
    });
  }

  private async createTarFromDockerfile(dockerfile: string): Promise<NodeJS.ReadableStream> {
    const { pack } = await import('tar-stream');
    const { PassThrough } = await import('stream');

    const tarStream = pack();
    tarStream.entry({ name: 'Dockerfile' }, dockerfile);
    tarStream.finalize();

    return tarStream;
  }

  // Volume functions now use local directories instead of Docker volumes
  // This keeps data in the project directory for easy access

  private async getVolumesDir(): Promise<string> {
    const { join } = await import('path');
    const config = await getConfig();
    return join(config.dataDirectory, 'volumes');
  }

  private async getDirectorySize(dirPath: string): Promise<number> {
    const { readdir, stat } = await import('fs/promises');
    const { join } = await import('path');

    let totalSize = 0;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          totalSize += await this.getDirectorySize(entryPath);
        } else if (entry.isFile()) {
          const stats = await stat(entryPath);
          totalSize += stats.size;
        }
      }
    } catch {
      // Ignore errors (permission issues, etc.)
    }

    return totalSize;
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    const { readdir, stat, mkdir } = await import('fs/promises');
    const { join } = await import('path');

    const volumesDir = await this.getVolumesDir();
    await mkdir(volumesDir, { recursive: true });

    try {
      const entries = await readdir(volumesDir, { withFileTypes: true });
      const volumes: VolumeInfo[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const volPath = join(volumesDir, entry.name);
          const stats = await stat(volPath);
          volumes.push({
            name: entry.name,
            driver: 'local',
            mountpoint: volPath,
            createdAt: stats.birthtime.toISOString(),
            size: 0, // Size is loaded lazily via separate endpoint
          });
        }
      }

      return volumes;
    } catch {
      return [];
    }
  }

  async getVolumeSize(name: string): Promise<number> {
    const { join } = await import('path');
    const volumesDir = await this.getVolumesDir();
    const volPath = join(volumesDir, name);
    return this.getDirectorySize(volPath);
  }

  async createVolume(name: string): Promise<void> {
    const { mkdir } = await import('fs/promises');
    const { join } = await import('path');

    const volumesDir = await this.getVolumesDir();
    const volumePath = join(volumesDir, name);
    await mkdir(volumePath, { recursive: true });
  }

  async removeVolume(name: string): Promise<void> {
    const { rm } = await import('fs/promises');
    const { join } = await import('path');

    const volumesDir = await this.getVolumesDir();
    const volumePath = join(volumesDir, name);
    await rm(volumePath, { recursive: true });
  }

  async getVolumeFiles(volumeName: string): Promise<string[]> {
    const { readdir } = await import('fs/promises');
    const { join } = await import('path');

    const volumesDir = await this.getVolumesDir();
    const volumePath = join(volumesDir, volumeName);

    async function listFilesRecursive(dir: string, base: string = ''): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        const relativePath = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          files.push(...await listFilesRecursive(join(dir, entry.name), relativePath));
        } else {
          files.push(relativePath);
        }
      }

      return files;
    }

    try {
      return await listFilesRecursive(volumePath);
    } catch {
      return [];
    }
  }

  async uploadFileToVolume(
    volumeName: string,
    fileName: string,
    fileContent: Buffer
  ): Promise<void> {
    const { writeFile, mkdir } = await import('fs/promises');
    const { join, dirname } = await import('path');

    const volumesDir = await this.getVolumesDir();
    const filePath = join(volumesDir, volumeName, fileName);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, fileContent);
  }

  async getVolumePath(volumeName: string): Promise<string> {
    const { join } = await import('path');
    const volumesDir = await this.getVolumesDir();
    return join(volumesDir, volumeName);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  // Cached Docker availability check — avoids repeated socket errors when Docker is not installed.
  // Re-checks every 30s so it picks up Docker being installed/started without a restart.
  async isDockerAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.dockerAvailable !== null && now - this.dockerCheckTime < DOCKER_CHECK_INTERVAL) {
      return this.dockerAvailable;
    }
    this.dockerAvailable = await this.testConnection();
    this.dockerCheckTime = now;
    return this.dockerAvailable;
  }

  private extractSshPort(ports: Docker.Port[]): number | null {
    const sshPort = ports.find((p) => p.PrivatePort === 22);
    return sshPort?.PublicPort || null;
  }

  private extractSshPortFromInspect(ports: Record<string, Array<{ HostPort: string }> | null>): number | null {
    const sshPorts = ports['22/tcp'];
    if (sshPorts && sshPorts.length > 0) {
      return parseInt(sshPorts[0].HostPort, 10);
    }
    return null;
  }

  private extractVolumes(mounts: Docker.ContainerInfo['Mounts']): Array<{ name: string; mountPath: string }> {
    return mounts
      .filter((m) => m.Type === 'volume' || m.Type === 'bind')
      .map((m) => {
        // For bind mounts, extract the volume name from the source path
        let name = m.Name || '';
        if (m.Type === 'bind' && m.Source) {
          // Extract volume name from path like /data/volumes/my-volume
          const parts = m.Source.split('/');
          const volIndex = parts.indexOf('volumes');
          if (volIndex !== -1 && parts.length > volIndex + 1) {
            name = parts[volIndex + 1];
          } else {
            name = parts[parts.length - 1] || m.Source;
          }
        }
        return {
          name,
          mountPath: m.Destination,
        };
      });
  }

  private extractVolumesFromInspect(mounts: Array<{ Type: string; Name?: string; Source?: string; Destination: string }>): Array<{ name: string; mountPath: string }> {
    return mounts
      .filter((m) => m.Type === 'volume' || m.Type === 'bind')
      .map((m) => {
        // For bind mounts, extract the volume name from the source path
        let name = m.Name || '';
        if (m.Type === 'bind' && m.Source) {
          // Extract volume name from path like /data/volumes/my-volume
          const parts = m.Source.split('/');
          const volIndex = parts.indexOf('volumes');
          if (volIndex !== -1 && parts.length > volIndex + 1) {
            name = parts[volIndex + 1];
          } else {
            name = parts[parts.length - 1] || m.Source;
          }
        }
        return {
          name,
          mountPath: m.Destination,
        };
      });
  }

  private extractPorts(ports: Docker.Port[]): Array<{ container: number; host: number }> {
    const portMap = new Map<string, { container: number; host: number }>();

    for (const p of ports) {
      if (!p.PublicPort || p.PrivatePort === 22) continue; // Exclude SSH port

      const key = `${p.PublicPort}-${p.PrivatePort}`;
      if (!portMap.has(key)) {
        portMap.set(key, { container: p.PrivatePort, host: p.PublicPort });
      }
    }

    return Array.from(portMap.values());
  }

  private extractPortsFromInspect(ports: Record<string, Array<{ HostPort: string }> | null>): Array<{ container: number; host: number }> {
    const portMap = new Map<string, { container: number; host: number }>();

    for (const [key, bindings] of Object.entries(ports)) {
      if (!bindings) continue;

      const containerPort = parseInt(key.split('/')[0], 10);
      if (containerPort === 22) continue; // Skip SSH port

      const hostPort = parseInt(bindings[0]?.HostPort, 10);

      if (containerPort && hostPort) {
        const mapKey = `${hostPort}-${containerPort}`;
        if (!portMap.has(mapKey)) {
          portMap.set(mapKey, { container: containerPort, host: hostPort });
        }
      }
    }

    return Array.from(portMap.values());
  }

  private mapState(state: string): ContainerInfo['state'] {
    const stateMap: Record<string, ContainerInfo['state']> = {
      running: 'running',
      exited: 'exited',
      created: 'created',
      paused: 'paused',
    };
    return stateMap[state.toLowerCase()] || 'stopped';
  }

  /**
   * Get container logs
   */
  async getContainerLogs(
    containerId: string,
    options: { tail?: number; since?: number; timestamps?: boolean } = {}
  ): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const { tail = 200, since = 0, timestamps = true } = options;

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      since,
      timestamps,
    });

    // Docker logs come with stream headers (8 bytes per line)
    // We need to strip them to get clean log output
    const buffer = Buffer.from(logs as unknown as Buffer);
    const lines: string[] = [];
    let offset = 0;

    while (offset < buffer.length) {
      // Each frame has 8-byte header: [type(1), 0, 0, 0, size(4)]
      if (offset + 8 > buffer.length) break;

      const size = buffer.readUInt32BE(offset + 4);
      offset += 8;

      if (offset + size > buffer.length) break;

      const line = buffer.subarray(offset, offset + size).toString('utf-8');
      lines.push(line.trimEnd());
      offset += size;
    }

    return lines.join('\n');
  }

  /**
   * Stream container logs (for real-time viewing)
   */
  async streamContainerLogs(
    containerId: string,
    onLog: (line: string) => void,
    options: { tail?: number; since?: number } = {}
  ): Promise<() => void> {
    const container = this.docker.getContainer(containerId);
    const { tail = 100, since = 0 } = options;

    const stream = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      since,
      timestamps: true,
      follow: true,
    });

    let buffer = Buffer.alloc(0);
    let aborted = false;

    const processBuffer = () => {
      while (buffer.length >= 8) {
        const size = buffer.readUInt32BE(4);
        const frameSize = 8 + size;

        if (buffer.length < frameSize) break;

        const line = buffer.subarray(8, frameSize).toString('utf-8').trimEnd();
        if (line) onLog(line);

        buffer = buffer.subarray(frameSize);
      }
    };

    (stream as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
      if (aborted) return;
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    });

    (stream as NodeJS.ReadableStream).on('end', () => {
      if (!aborted) {
        onLog('[Container log stream ended]');
      }
    });

    (stream as NodeJS.ReadableStream).on('error', (err: Error) => {
      if (!aborted) {
        onLog(`[Error: ${err.message}]`);
      }
    });

    // Return cleanup function
    return () => {
      aborted = true;
      // Stream is a Node.js Readable, cast and destroy safely
      const readable = stream as NodeJS.ReadableStream & { destroy?: () => void };
      if (typeof readable.destroy === 'function') {
        readable.destroy();
      }
    };
  }

  /**
   * Execute a command inside a running container and return stdout.
   * Uses Docker's demuxStream to properly strip multiplexed stream headers.
   */
  async execInContainer(containerId: string, cmd: string[], workDir?: string): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      ...(workDir ? { WorkingDir: workDir } : {}),
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise<string>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const stdout = new PassThrough();
      const stderr = new PassThrough();

      stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      this.docker.modem.demuxStream(stream, stdout, stderr);

      stream.on('end', async () => {
        const output = Buffer.concat(stdoutChunks).toString('utf-8');
        const errOutput = Buffer.concat(stderrChunks).toString('utf-8');
        const inspect = await exec.inspect();
        if (inspect.ExitCode !== 0) {
          reject(new Error(`Command failed (exit ${inspect.ExitCode}): ${errOutput || output}`));
        } else {
          resolve(output.trim());
        }
      });
      stream.on('error', reject);
    });
  }

  async uploadContainerFile(containerId: string, file: SandboxFileUpload): Promise<string> {
    const destinationPath = file.destinationPath || '/home/dev/workspace';
    const remotePath = posix.join(destinationPath, file.filename);
    const content = await readFile(file.sourcePath);

    await this.execContainer(containerId, `mkdir -p ${JSON.stringify(destinationPath)}`);
    const archive = tar.pack();
    archive.entry({ name: file.filename, mode: 0o644 }, content);
    archive.finalize();
    await this.docker.getContainer(containerId).putArchive(archive, { path: destinationPath });
    try {
      await this.execInContainer(containerId, ['chown', '-R', 'dev:dev', remotePath]);
    } catch {
      // Ownership changes are best-effort.
    }

    return remotePath;
  }

  async uploadContainerFiles(containerId: string, files: SandboxFileContent[]): Promise<number> {
    if (files.length === 0) return 0;

    const archive = tar.pack();
    const remotePaths: string[] = [];
    for (const file of files) {
      const destination = expandSandboxPath(file.destPath, '/home/dev');
      const remotePath = posix.join(destination, file.filename);
      remotePaths.push(remotePath);
      archive.entry(
        { name: remotePath.replace(/^\//, ''), mode: 0o644 },
        typeof file.content === 'string' ? Buffer.from(file.content) : file.content,
      );
    }
    archive.finalize();
    await this.docker.getContainer(containerId).putArchive(archive, { path: '/' });

    for (const remotePath of remotePaths) {
      try {
        await this.execInContainer(containerId, ['chown', 'dev:dev', remotePath]);
      } catch {
        // Ownership changes are best-effort.
      }
    }
    return files.length;
  }

  async uploadContainerDirectory(containerId: string, directory: SandboxDirectoryUpload): Promise<string> {
    const destinationPath = directory.destinationPath || '/home/dev/workspace';
    await this.execContainer(containerId, `mkdir -p ${JSON.stringify(destinationPath)}`);
    await this.docker.getContainer(containerId).putArchive(
      createReadStream(directory.archivePath),
      { path: destinationPath },
    );
    try {
      await this.execInContainer(containerId, ['chown', '-R', 'dev:dev', destinationPath]);
    } catch {
      // Ownership changes are best-effort.
    }

    return destinationPath;
  }

  async listContainerFiles(containerId: string, path: string): Promise<SandboxFileInfo[]> {
    let output: string;
    try {
      output = await this.execContainer(
        containerId,
        `ls -la --time-style=long-iso ${JSON.stringify(path)}`,
        30_000,
      );
    } catch {
      output = await this.execContainer(containerId, `ls -la ${JSON.stringify(path)}`, 30_000);
    }
    return parseLsOutput(output);
  }

  async downloadContainerFile(containerId: string, path: string): Promise<Buffer> {
    const archive = await this.docker.getContainer(containerId).getArchive({ path });
    const extract = tar.extract();

    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      extract.on('entry', (header, stream, next) => {
        if (settled || header.type !== 'file') {
          stream.resume();
          stream.on('end', next);
          return;
        }

        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          settled = true;
          resolve(Buffer.concat(chunks));
          next();
        });
        stream.on('error', reject);
      });
      extract.on('finish', () => {
        if (!settled) reject(new Error(`No file found at ${path}`));
      });
      extract.on('error', reject);
      archive.on('error', reject);
      archive.pipe(extract);
    });
  }

  async execContainer(containerId: string, command: string, timeoutMs = 10_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Container command timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.execInContainer(containerId, ['sh', '-c', command]).then(
        (output) => {
          clearTimeout(timeout);
          resolve(output);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }
}

// Singleton instance
export let dockerService = new DockerService();

export function getDockerService(): DockerService {
  if (!dockerService) {
    dockerService = new DockerService();
  }
  return dockerService;
}

export async function initializeDockerService(): Promise<DockerService> {
  const service = getDockerService();
  return service;
}

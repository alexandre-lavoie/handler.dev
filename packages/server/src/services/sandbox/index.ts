/**
 * Sandbox Service
 *
 * Unified service for managing all compute environments (Docker, VMs, Daytona)
 * through a single API. Routes requests to the appropriate backend adapter.
 */

import type { SandboxAdapter, SandboxDirectoryUpload, SandboxFileContent, SandboxFileInfo, SandboxFileUpload, SandboxGitLog, SandboxLogOptions, TmuxSessionInfo } from './types.js';
import type {
  Sandbox,
  SandboxBackend,
  SandboxListFilter,
  SandboxListResponse,
  CreateSandboxRequest,
} from '../../types/sandbox.js';
import { DockerAdapter } from './docker-adapter.js';
import { FirecrackerAdapter } from './vm-adapter.js';
import { DaytonaAdapter } from './daytona-adapter.js';
import { AwsAdapter } from './aws-adapter.js';
import { AzureAdapter } from './azure-adapter.js';
import { GcpAdapter } from './gcp-adapter.js';
import { DigitalOceanAdapter } from './digitalocean-adapter.js';
import { LinodeAdapter } from './linode-adapter.js';
import { DockerService, dockerService, initializeDockerService } from '../docker.js';
import { FirecrackerService, initializeFirecrackerService } from '../firecracker.js';
import { DaytonaService, initializeDaytonaService } from '../daytona.js';
import { AwsService, initializeAwsService } from '../aws.js';
import { AzureService, initializeAzureService } from '../azure.js';
import { GcpService, initializeGcpService } from '../gcp.js';
import { DigitalOceanService, initializeDigitalOceanService } from '../digitalocean.js';
import { LinodeService, initializeLinodeService } from '../linode.js';
import type { GuestMetrics } from '../guest-metrics.js';
import type { AgentInfo } from '../agent-detect.js';
import type { ImageInfo } from '../../types/index.js';
import { getTerminalSummary as generateTerminalSummary, type CachedSummary } from '../terminal-summary.js';

export class SandboxService {
  private adapters: Map<SandboxBackend, SandboxAdapter> = new Map();
  private initialized = false;

  isInitialized(): boolean {
    return this.initialized;
  }

  // Service instances (lazily initialized)
  private dockerService: DockerService | null = null;
  private firecrackerService: FirecrackerService | null = null;
  private daytonaService: DaytonaService | null = null;
  private awsService: AwsService | null = null;
  private azureService: AzureService | null = null;
  private gcpService: GcpService | null = null;
  private digitaloceanService: DigitalOceanService | null = null;
  private linodeService: LinodeService | null = null;

  /**
   * Initialize the sandbox service with all available adapters
   */
  async initialize(options?: {
    docker?: DockerService;
    firecracker?: FirecrackerService;
    daytona?: DaytonaService;
    aws?: AwsService;
    azure?: AzureService;
    gcp?: GcpService;
    digitalocean?: DigitalOceanService;
    linode?: LinodeService;
  }): Promise<void> {
    if (this.initialized) return;

    console.log('[SandboxService] Initializing...');

    // Register Docker adapter (always available)
    this.dockerService = options?.docker ?? dockerService;
    const dockerAdapter = new DockerAdapter(this.dockerService);
    if (await dockerAdapter.isAvailable()) {
      this.adapters.set('docker', dockerAdapter);
      console.log('[SandboxService] Docker adapter registered');
    }

    // Register Firecracker adapter
    if (options?.firecracker) {
      this.firecrackerService = options.firecracker;
      const fcAdapter = new FirecrackerAdapter(options.firecracker);
      if (await fcAdapter.isAvailable()) {
        this.adapters.set('firecracker', fcAdapter);
        console.log('[SandboxService] Firecracker adapter registered');
      }
    }

    // Register Daytona adapter
    if (options?.daytona) {
      this.daytonaService = options.daytona;
      const daytonaAdapter = new DaytonaAdapter(options.daytona);
      if (await daytonaAdapter.isAvailable()) {
        this.adapters.set('daytona', daytonaAdapter);
        console.log('[SandboxService] Daytona adapter registered');
      }
    }

    // Register AWS adapter
    if (options?.aws) {
      this.awsService = options.aws;
      const awsAdapter = new AwsAdapter(options.aws);
      if (await awsAdapter.isAvailable()) {
        this.adapters.set('aws', awsAdapter);
        console.log('[SandboxService] AWS adapter registered');
      }
    }

    // Register Azure adapter
    if (options?.azure) {
      this.azureService = options.azure;
      const azureAdapter = new AzureAdapter(options.azure);
      if (await azureAdapter.isAvailable()) {
        this.adapters.set('azure', azureAdapter);
        console.log('[SandboxService] Azure adapter registered');
      }
    }

    // Register GCP adapter
    if (options?.gcp) {
      this.gcpService = options.gcp;
      const gcpAdapter = new GcpAdapter(options.gcp);
      if (await gcpAdapter.isAvailable()) {
        this.adapters.set('gcp', gcpAdapter);
        console.log('[SandboxService] GCP adapter registered');
      }
    }

    // Register DigitalOcean adapter
    if (options?.digitalocean) {
      this.digitaloceanService = options.digitalocean;
      const doAdapter = new DigitalOceanAdapter(options.digitalocean);
      if (await doAdapter.isAvailable()) {
        this.adapters.set('digitalocean', doAdapter);
        console.log('[SandboxService] DigitalOcean adapter registered');
      }
    }

    // Register Linode adapter
    if (options?.linode) {
      this.linodeService = options.linode;
      const linodeAdapter = new LinodeAdapter(options.linode);
      if (await linodeAdapter.isAvailable()) {
        this.adapters.set('linode', linodeAdapter);
        console.log('[SandboxService] Linode adapter registered');
      }
    }

    this.initialized = true;
    console.log(`[SandboxService] Initialized with ${this.adapters.size} adapters`);
  }

  /**
   * Get availability status for all backends
   */
  async getBackendStatus(): Promise<Record<SandboxBackend, boolean>> {
    const results: Record<SandboxBackend, boolean> = {
      aws: false,
      azure: false,
      daytona: false,
      digitalocean: false,
      docker: false,
      gcp: false,
      firecracker: false,
      linode: false,
    };

    for (const [backend, adapter] of this.adapters) {
      try {
        results[backend] = await adapter.isAvailable();
      } catch {
        results[backend] = false;
      }
    }

    return results;
  }

  /**
   * List all sandboxes from all backends
   */
  async list(filter?: SandboxListFilter): Promise<SandboxListResponse> {
    const backends = filter?.backends || Array.from(this.adapters.keys());
    const results: Sandbox[] = [];
    const errors: string[] = [];

    // Fetch from all requested backends in parallel
    const promises = backends.map(async (backend) => {
      const adapter = this.getAdapter(backend);
      if (!adapter) {
        return { backend, sandboxes: [] };
      }

      try {
        const sandboxes = await adapter.list();
        return { backend, sandboxes };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`${backend}: ${message}`);
        return { backend, sandboxes: [] };
      }
    });

    const adapterResults = await Promise.all(promises);

    for (const result of adapterResults) {
      results.push(...result.sandboxes);
    }

    // Apply filters
    let filtered = results;

    // Filter by status
    if (filter?.status && filter.status.length > 0) {
      filtered = filtered.filter((s) => filter.status!.includes(s.status));
    }

    // Filter by search term
    if (filter?.search) {
      const search = filter.search.toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.name.toLowerCase().includes(search) ||
          s.image.toLowerCase().includes(search)
      );
    }

    // Sort by creation date (newest first)
    filtered.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // Get backend availability
    const backendStatus = await this.getBackendStatus();

    if (errors.length > 0) {
      console.warn('[SandboxService] List errors:', errors);
    }

    return {
      sandboxes: filtered,
      backends: backendStatus,
    };
  }

  /**
   * List images from backends that support image discovery.
   */
  async listImages(): Promise<ImageInfo[]> {
    const imageLists = await Promise.all(
      Array.from(this.adapters.values())
        .filter((adapter) => adapter.listImages)
        .map((adapter) => adapter.listImages!()),
    );

    return imageLists.flat();
  }

  /**
   * Get a specific sandbox by ID
   */
  async get(id: string): Promise<Sandbox | null> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter) return null;

    return adapter.get(id);
  }

  /**
   * Create a new sandbox
   */
  async create(request: CreateSandboxRequest): Promise<Sandbox> {
    return this.getAdapterThrow(this.getBackendFromId(request.backend)).create(request);
  }

  /**
   * Start a sandbox
   */
  async start(id: string): Promise<Sandbox> {
    return this.getAdapterThrow(this.getBackendFromId(id)).start(id);
  }

  /**
   * Stop a sandbox
   */
  async stop(id: string): Promise<Sandbox> {
    return this.getAdapterThrow(this.getBackendFromId(id)).stop(id);
  }

  /**
   * Delete a sandbox
   */
  async delete(id: string): Promise<void> {
    return this.getAdapterThrow(this.getBackendFromId(id)).delete(id);
  }

  /**
   * Rename a sandbox
   */
  async rename(id: string, newName: string): Promise<Sandbox> {
    await this.getAdapterThrow(this.getBackendFromId(id)).rename(id, newName);

    // Return updated sandbox
    const result = await this.get(id);
    if (!result) {
      throw new Error(`Sandbox ${id} not found after rename`);
    }

    return result;
  }

  /**
   * Update sandbox resources (vCPUs, memory, disk)
   * For VMs: updates state, applied on next boot. VM must be stopped.
   * For Docker: uses docker update for CPU/memory on running containers.
   */
  async updateResources(id: string, resources: { vcpus?: number; memoryMb?: number; diskGb?: number }): Promise<Sandbox> {
    await this.getAdapterThrow(this.getBackendFromId(id)).updateResources(id, resources);

    const result = await this.get(id);
    if (!result) {
      throw new Error(`Sandbox ${id} not found after resource update`);
    }

    return result;
  }

  /**
   * Get logs for a sandbox. Returns null when the sandbox does not exist.
   */
  async getLogs(id: string, options?: SandboxLogOptions): Promise<string | null> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter || !(await adapter.get(id))) return null;

    return adapter.getLogs(id, options);
  }

  /**
   * Get the SSH private key for a sandbox. Returns null when the sandbox or key does not exist.
   */
  async getSSHKey(id: string): Promise<string | null> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter || !(await adapter.get(id))) return null;

    return adapter.getSSHKey(id);
  }

  /**
   * Get the SSH command for a sandbox. Returns null when the sandbox or command does not exist.
   */
  async getSSHCommand(id: string): Promise<string | null> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter || !(await adapter.get(id))) return null;

    return adapter.getSSHCommand(id);
  }

  /**
   * Upload a local file to a sandbox. Returns null when the sandbox does not exist.
   */
  async uploadFile(id: string, file: SandboxFileUpload): Promise<string | null> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter || !(await adapter.get(id))) return null;

    return adapter.uploadFile(id, file);
  }

  /**
   * Upload multiple in-memory files to a running sandbox.
   */
  async uploadFiles(id: string, files: SandboxFileContent[]): Promise<number> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter) throw new Error('Sandbox not found');

    const sandbox = await adapter.get(id);
    if (!sandbox) throw new Error('Sandbox not found');
    if (sandbox.status !== 'running') throw new Error('Sandbox must be running to upload files');
    if (files.length === 0) return 0;

    return adapter.uploadFiles(id, files);
  }

  /**
   * Upload a local directory archive to a sandbox. Returns null when the sandbox does not exist.
   */
  async uploadDirectory(id: string, directory: SandboxDirectoryUpload): Promise<string | null> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter || !(await adapter.get(id))) return null;

    return adapter.uploadDirectory(id, directory);
  }

  /**
   * List files in a sandbox directory. Returns null when the sandbox does not exist.
   */
  async listFiles(id: string, path: string): Promise<SandboxFileInfo[] | null> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter || !(await adapter.get(id))) return null;

    return adapter.listFiles(id, path);
  }

  /**
   * Download a file from a sandbox. Returns null when the sandbox does not exist.
   */
  async downloadFile(id: string, path: string): Promise<Buffer | null> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter || !(await adapter.get(id))) return null;

    return adapter.downloadFile(id, path);
  }

  /**
   * Get runtime metrics for a sandbox. Returns null when unavailable.
   */
  async getMetrics(id: string): Promise<GuestMetrics | null> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter || !(await adapter.get(id))) return null;

    return adapter.getMetrics(id);
  }

  /**
   * Get detected coding agents for a sandbox. Returns an empty array when unavailable.
   */
  async getAgents(id: string): Promise<AgentInfo[]> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter || !(await adapter.get(id))) return [];

    return adapter.getAgents(id);
  }

  /**
   * Execute a command inside a running sandbox. Returns null on failure.
   */
  async exec(id: string, command: string, timeoutMs = 10_000): Promise<string | null> {
    const adapter = this.getAdapter(this.getBackendFromId(id));
    if (!adapter) return null;

    const sandbox = await adapter.get(id);
    if (!sandbox || sandbox.status !== 'running') return null;

    try {
      return await adapter.exec(id, command, timeoutMs);
    } catch {
      return null;
    }
  }

  /**
   * Get tmux sessions running in a sandbox.
   */
  async getTmuxSessions(id: string): Promise<TmuxSessionInfo[]> {
    const sandbox = await this.get(id);
    if (!sandbox || sandbox.status !== 'running') return [];

    try {
      const output = await this.exec(
        id,
        `tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{session_created}' 2>/dev/null || true`,
        5000,
      );
      if (!output) return [];

      return output
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const [name, windows, created] = line.split('\t');
          return {
            name: name || '',
            windows: parseInt(windows || '0', 10),
            created: parseInt(created || '0', 10),
          };
        })
        .filter((session) => session.name.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Get an AI-generated summary of a sandbox terminal session.
   */
  async getTerminalSummary(id: string, session?: string): Promise<CachedSummary | null> {
    const sandbox = await this.get(id);
    if (!sandbox || sandbox.status !== 'running') return null;

    const tmuxSession = session && /^[a-zA-Z0-9_.-]+$/.test(session)
      ? session
      : undefined;

    return generateTerminalSummary(
      sandbox,
      tmuxSession,
      (command, timeoutMs) => this.exec(id, command, timeoutMs),
    );
  }

  /**
   * Capture the current terminal pane with ANSI escape codes.
   */
  async captureTerminal(id: string): Promise<string | null> {
    const sandbox = await this.get(id);
    if (!sandbox || sandbox.status !== 'running') return null;

    try {
      const content = await this.exec(
        id,
        `tmux capture-pane -e -p -S -50 2>/dev/null || true`,
        5000,
      );
      return content || null;
    } catch {
      return null;
    }
  }

  /**
   * Get commit history and the current branch from a sandbox repository.
   */
  async getGitLog(id: string, limit = 50, workdir = '/home/agent'): Promise<SandboxGitLog> {
    const sandbox = await this.get(id);
    if (!sandbox || sandbox.status !== 'running') return { commits: [], branch: '' };

    const repoRoot = (await this.exec(
      id,
      `cd ${JSON.stringify(workdir)} && git rev-parse --show-toplevel 2>/dev/null || echo ""`,
    ))?.trim() || '';
    const gitDir = repoRoot || workdir;

    const [logOutput, branch] = await Promise.all([
      this.exec(id, `cd ${JSON.stringify(gitDir)} && git log --pretty=format:'%H|%h|%s|%an|%ae|%aI' -n ${limit} 2>/dev/null || echo ""`),
      this.exec(id, `cd ${JSON.stringify(gitDir)} && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`),
    ]);

    const commits = (logOutput || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, subject, author, email, date] = line.split('|');
        return { hash, shortHash, subject, author, email, date };
      });

    return { commits, branch: branch?.trim() || '' };
  }

  /**
   * Get the formatted details of a commit from a sandbox repository.
   */
  async getGitCommit(id: string, hash: string, workdir = '/home/agent'): Promise<string> {
    const sandbox = await this.get(id);
    if (!sandbox || sandbox.status !== 'running') return '';

    const repoRoot = (await this.exec(
      id,
      `cd ${JSON.stringify(workdir)} && git rev-parse --show-toplevel 2>/dev/null || echo ""`,
    ))?.trim() || '';
    const gitDir = repoRoot || workdir;

    return (await this.exec(
      id,
      `cd ${JSON.stringify(gitDir)} && git show ${hash} --stat 2>/dev/null || echo ""`,
    )) || '';
  }

  /**
   * Determine the backend type from a sandbox ID
   */
  private getBackendFromId(id: string): SandboxBackend {
    const prefix = id.split("-")[0];

    switch (prefix) {
      case 'do': return 'digitalocean';

      case 'fc':
      case 'vm': return 'firecracker';

      default: return prefix;
    }
  }

  /**
   * Get the registered adapter for a backend
   */
  getAdapter(backend: SandboxBackend): SandboxAdapter | undefined {
    return this.adapters.get(backend);
  }

  getAdapterThrow(backend: SandboxBackend): SandboxAdapter {
    const adapter = this.getAdapter(backend);
    if (!adapter) {
      throw new Error(`Backend '${backend}' is not available`);
    }

    return adapter;
  }

  /**
   * Check if a backend is available
   */
  hasBackend(backend: SandboxBackend): boolean {
    return this.adapters.has(backend);
  }

  /**
   * Get the underlying firecracker service (for VM-specific operations)
   */
  getFirecrackerService(): FirecrackerService | null {
    return this.firecrackerService;
  }

  /**
   * Get the underlying daytona service (for cloud-specific operations)
   */
  getDaytonaService(): DaytonaService | null {
    return this.daytonaService;
  }

  /**
   * Get the underlying AWS service (for cloud-specific operations)
   */
  getAwsService(): AwsService | null {
    return this.awsService;
  }

  getAzureService(): AzureService | null {
    return this.azureService;
  }

  getGcpService(): GcpService | null {
    return this.gcpService;
  }

  getDigitalOceanService(): DigitalOceanService | null {
    return this.digitaloceanService;
  }

  getLinodeService(): LinodeService | null {
    return this.linodeService;
  }

  /**
   * Reset the service so it can be reinitialized with new adapters
   */
  reset(): void {
    this.adapters.clear();
    this.firecrackerService = null;
    this.daytonaService = null;
    this.awsService = null;
    this.azureService = null;
    this.gcpService = null;
    this.digitaloceanService = null;
    this.linodeService = null;
    this.initialized = false;
    console.log('[SandboxService] Reset - will reinitialize on next use');
  }
}

// Singleton instance
let sandboxServiceInstance: SandboxService | null = null;
let sandboxServiceInitialization: Promise<SandboxService> | null = null;

/**
 * Get or create the sandbox service singleton
 */
export function getSandboxService(): SandboxService {
  if (!sandboxServiceInstance) {
    sandboxServiceInstance = new SandboxService();
  }
  return sandboxServiceInstance;
}

/**
 * Initialize the sandbox service with dependencies
 */
export async function initializeSandboxService(options?: {
  docker?: DockerService;
  firecracker?: FirecrackerService;
  daytona?: DaytonaService;
  aws?: AwsService;
  azure?: AzureService;
  gcp?: GcpService;
  digitalocean?: DigitalOceanService;
  linode?: LinodeService;
}): Promise<SandboxService> {
  const service = getSandboxService();
  await service.initialize(options);
  return service;
}

/**
 * Return the initialized sandbox service, initializing all available backends once.
 */
export async function ensureSandboxService(): Promise<SandboxService> {
  const service = getSandboxService();
  if (service.isInitialized()) return service;
  if (sandboxServiceInitialization) return sandboxServiceInitialization;

  sandboxServiceInitialization = (async () => {
    const backends = [
      { id: 'aws', init: initializeAwsService },
      { id: 'azure', init: initializeAzureService },
      { id: 'daytona', init: initializeDaytonaService },
      { id: 'docker', init: initializeDockerService },
      { id: 'digitalocean', init: initializeDigitalOceanService },
      { id: 'gcp', init: initializeGcpService },
      { id: 'firecracker', init: initializeFirecrackerService },
      { id: 'linode', init: initializeLinodeService },
    ] as const;

    const available = (await Promise.all(backends.map(async ({ id, init }) => {
      try {
        return { id, service: await init() };
      } catch (error) {
        console.log(`[SandboxService] ${id} not available:`, error instanceof Error ? error.message : 'unknown');
        return null;
      }
    }))).filter((result) => result !== null);

    const options = Object.fromEntries(
      available.map(({ id, service: backendService }) => [id, backendService]),
    );
    return initializeSandboxService(options);
  })().catch((error) => {
    sandboxServiceInitialization = null;
    throw error;
  });

  return sandboxServiceInitialization;
}

/**
 * Reset the sandbox service so it will be reinitialized on next use.
 * Call this after cloud backend configuration changes.
 */
export function resetSandboxService(): void {
  sandboxServiceInitialization = null;
  if (sandboxServiceInstance) {
    sandboxServiceInstance.reset();
  }
}

// Re-export types
export type { SandboxAdapter, SandboxServiceConfig, AdapterResult } from './types.js';
export { DockerAdapter } from './docker-adapter.js';
export { FirecrackerAdapter } from './vm-adapter.js';
export { DaytonaAdapter } from './daytona-adapter.js';
export { AwsAdapter } from './aws-adapter.js';
export { AzureAdapter } from './azure-adapter.js';
export { GcpAdapter } from './gcp-adapter.js';
export { DigitalOceanAdapter } from './digitalocean-adapter.js';
export { LinodeAdapter } from './linode-adapter.js';

/**
 * Sandbox Adapter Interface
 *
 * Defines the contract for backend adapters that convert various compute
 * environments (Docker, VMs, Daytona) to the unified Sandbox abstraction.
 */

import type {
  Sandbox,
  SandboxBackend,
  CreateSandboxRequest,
} from '../../types/sandbox.js';
import type { GuestMetrics } from '../guest-metrics.js';
import type { AgentInfo } from '../agent-detect.js';

export interface SandboxLogOptions {
  tail?: number;
  timestamps?: boolean;
}

export interface SandboxFileUpload {
  sourcePath: string;
  filename: string;
  destinationPath?: string;
}

export interface SandboxDirectoryUpload {
  archivePath: string;
  destinationPath?: string;
}

export interface SandboxFileInfo {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
}

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  created: number;
}

export interface SandboxGitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  email: string;
  date: string;
}

export interface SandboxGitLog {
  commits: SandboxGitCommit[];
  branch: string;
}

/**
 * Interface that all sandbox adapters must implement
 */
export interface SandboxAdapter {
  /** The backend type this adapter handles */
  readonly backend: SandboxBackend;

  /**
   * Check if this backend is available and configured
   */
  isAvailable(): Promise<boolean>;

  /**
   * List all sandboxes from this backend
   */
  list(): Promise<Sandbox[]>;

  /**
   * Get a specific sandbox by ID
   * @param id Full sandbox ID (with prefix)
   */
  get(id: string): Promise<Sandbox | null>;

  /**
   * Create a new sandbox
   */
  create(request: CreateSandboxRequest): Promise<Sandbox>;

  /**
   * Start a sandbox
   */
  start(id: string): Promise<Sandbox>;

  /**
   * Stop a sandbox
   */
  stop(id: string): Promise<Sandbox>;

  /**
   * Delete a sandbox
   */
  delete(id: string): Promise<void>;

  /**
   * Rename a sandbox
   */
  rename(id: string, name: string): Promise<void>;

  /**
   * Update sandbox resources
   */
  updateResources(id: string, resources: { vcpus?: number; memoryMb?: number; diskGb?: number }): Promise<void>;

  /**
   * Get logs for a sandbox
   */
  getLogs(id: string, options?: SandboxLogOptions): Promise<string>;

  /**
   * Get the SSH private key for a sandbox, if available
   */
  getSSHKey(id: string): Promise<string | null>;

  /**
   * Get the SSH command for a sandbox, if available
   */
  getSSHCommand(id: string): Promise<string | null>;

  /**
   * Upload a local file to a sandbox and return its remote path
   */
  uploadFile(id: string, file: SandboxFileUpload): Promise<string>;

  /**
   * Upload and extract a local directory archive in a sandbox
   */
  uploadDirectory(id: string, directory: SandboxDirectoryUpload): Promise<string>;

  /**
   * List files in a sandbox directory
   */
  listFiles(id: string, path: string): Promise<SandboxFileInfo[]>;

  /**
   * Download a file from a sandbox
   */
  downloadFile(id: string, path: string): Promise<Buffer>;

  /**
   * Get runtime metrics for a sandbox, if available
   */
  getMetrics(id: string): Promise<GuestMetrics | null>;

  /**
   * Get detected coding agents for a sandbox
   */
  getAgents(id: string): Promise<AgentInfo[]>;
}

/**
 * Configuration for the SandboxService
 */
export interface SandboxServiceConfig {
  /** Adapters to register */
  adapters?: SandboxAdapter[];
}

/**
 * Result type for operations that may partially fail
 */
export interface AdapterResult<T> {
  backend: SandboxBackend;
  success: boolean;
  data?: T;
  error?: string;
}

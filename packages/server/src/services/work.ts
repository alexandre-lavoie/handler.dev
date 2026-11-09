/**
 * Work service - orchestrates sandbox creation, repo cloning, and agent setup
 */

import { getGitHubService } from './github.js';
import { getSandboxService } from './sandbox/index.js';
import type { SandboxBackend } from '../types/sandbox.js';

export interface StartWorkOptions {
  repoFullName: string;       // e.g., "user/repo"
  branch?: string;            // Branch to checkout (default: repo's default branch)
  backend: SandboxBackend;    // Which backend to use
  agentConfigId?: string;     // Optional agent config to inject
}

export interface WorkResult {
  sandboxId: string;
  repoName: string;
  branch: string;
  clonePath: string;
}

/**
 * Wait for a sandbox to be in running state
 */
async function waitForSandboxRunning(sandboxId: string, timeoutMs = 120000): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 2000;
  const service = getSandboxService();

  while (Date.now() - startTime < timeoutMs) {
    const sandbox = await service.get(sandboxId);

    if (!sandbox) {
      throw new Error('Sandbox not found');
    }

    if (sandbox.status === 'running') {
      return;
    }

    if (sandbox.status === 'error' || sandbox.status === 'stopped') {
      throw new Error(`Sandbox entered ${sandbox.status} state`);
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error('Timeout waiting for sandbox to start');
}

/**
 * Inject git credentials into sandbox using .netrc
 */
async function injectGitCredentials(sandboxId: string, token: string): Promise<void> {
  const service = getSandboxService();

  // Create .netrc file for git authentication
  const netrcContent = `
machine github.com
login oauth
password ${token}
`.trim();

  const cmds = [
    `echo '${netrcContent}' > ~/.netrc && chmod 600 ~/.netrc`,
    `git config --global url."https://github.com/".insteadOf "git@github.com:"`,
    `git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"`,
  ];

  if (await service.exec(sandboxId, cmds.join(" && ")) === null) throw new Error(`Failed to execute command in sandbox ${sandboxId}`);
}

/**
 * Start work on a GitHub repository
 *
 * This function:
 * 1. Creates a new sandbox
 * 2. Waits for it to be running
 * 3. Injects git credentials
 * 4. Clones the repository
 * 5. Optionally injects agent config
 */
export async function startWork(options: StartWorkOptions): Promise<WorkResult> {
  const { repoFullName, branch, backend, agentConfigId } = options;

  // Get GitHub access token
  const githubService = getGitHubService();
  const accessToken = await githubService.getAccessToken();

  if (!accessToken) {
    throw new Error('Not connected to GitHub');
  }

  // Get repo info to determine default branch
  const [owner, repoName] = repoFullName.split('/');
  const repoInfo = await githubService.getRepo(owner, repoName);
  const targetBranch = branch || repoInfo.default_branch;

  // Create sandbox
  const service = getSandboxService();
  console.log(`[Work] Creating ${backend} sandbox for ${repoFullName}...`);

  // Determine default image based on backend
  const defaultImage = backend === 'docker' ? 'handler-default:latest' : 'ubuntu-base';

  const sandbox = await service.create({
    name: `work-${repoName}-${Date.now()}`,
    backend,
    image: defaultImage,
  });

  const sandboxId = sandbox.id;
  console.log(`[Work] Sandbox created: ${sandboxId}`);

  try {
    // Wait for sandbox to be running
    console.log(`[Work] Waiting for sandbox to start...`);
    await waitForSandboxRunning(sandboxId);
    console.log(`[Work] Sandbox is running`);

    // Inject git credentials
    console.log(`[Work] Injecting git credentials...`);
    await injectGitCredentials(sandboxId, accessToken);

    // Clone the repository
    const cloneUrl = `https://github.com/${repoFullName}.git`;
    const clonePath = `/root/${repoName}`;

    console.log(`[Work] Cloning ${cloneUrl}...`);

    const cmds = [
      `git clone --branch ${targetBranch} ${cloneUrl} ${clonePath}`,
      `cd ${clonePath} && pwd`,
    ];

    if (await service.exec(sandboxId, cmds.join(" && ")) === null) throw new Error(`Failed to execute command in sandbox ${sandboxId}`);

    // Inject agent config if specified
    if (agentConfigId) {
      console.log(`[Work] Injecting agent config: ${agentConfigId}`);
      // This would call the agent config service to inject config
      // For now, we'll leave this as a placeholder
      // await agentConfigService.inject(agentConfigId, sandboxId);
    }

    console.log(`[Work] Work started successfully for ${repoFullName}`);

    return {
      sandboxId,
      repoName,
      branch: targetBranch,
      clonePath,
    };
  } catch (error) {
    // If something fails, try to clean up the sandbox
    console.error(`[Work] Failed to set up work environment:`, error);
    try {
      const cleanupService = getSandboxService();
      await cleanupService.delete(sandboxId);
    } catch (cleanupError) {
      console.error(`[Work] Failed to cleanup sandbox:`, cleanupError);
    }
    throw error;
  }
}

/**
 * Get the status of a work session
 */
export async function getWorkStatus(sandboxId: string): Promise<{
  status: string;
  ready: boolean;
}> {
  const service = getSandboxService();
  const sandbox = await service.get(sandboxId);

  if (!sandbox) {
    throw new Error('Sandbox not found');
  }

  return {
    status: sandbox.status,
    ready: sandbox.status === 'running',
  };
}

/**
 * Shared utility for injecting files into running sandboxes.
 *
 * Used by agent-config inject and MCP deployment connect endpoints.
 */

import { ensureSandboxService } from './sandbox/index.js';
import type { SandboxFileContent } from './sandbox/types.js';

/**
 * Inject files into a running sandbox. Returns the number of files injected.
 */
export async function injectFilesIntoSandbox(
  sandboxId: string,
  files: SandboxFileContent[],
): Promise<number> {
  const service = await ensureSandboxService();
  return service.uploadFiles(sandboxId, files);
}

/**
 * Read a file from a running sandbox. Returns content or null if not found.
 */
export async function readFileFromSandbox(
  sandboxId: string,
  filePath: string,
): Promise<string | null> {
  const service = await ensureSandboxService();
  const buffer = await service.downloadFile(sandboxId, filePath);
  if (!buffer) {
    return null;
  }

  return buffer.toString();
}

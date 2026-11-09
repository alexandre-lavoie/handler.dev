import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export const SSH_OPTS = [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'ConnectTimeout=5',
  '-o', 'BatchMode=yes',
];

export function execViaSsh(options: {
  command: string;
  host: string;
  user: string;
  keyPath?: string;
  keyContent?: string;
  port?: number;
  timeoutMs?: number;
}): string {
  let keyPath = options.keyPath;
  let tempDir: string | undefined;

  try {
    if (options.keyContent) {
      tempDir = mkdtempSync(join(tmpdir(), 'sandbox-exec-key-'));
      keyPath = join(tempDir, 'ssh_key');
      writeFileSync(keyPath, options.keyContent, { mode: 0o600 });
    }
    if (!keyPath) throw new Error('SSH key not available');

    const portArgs = options.port && options.port !== 22 ? ['-p', String(options.port)] : [];
    return execFileSync(
      'ssh',
      ['-i', keyPath, ...portArgs, ...SSH_OPTS, `${options.user}@${options.host}`, options.command],
      { encoding: 'utf-8', timeout: options.timeoutMs ?? 10_000 },
    );
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true });
  }
}

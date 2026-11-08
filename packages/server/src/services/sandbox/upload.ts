import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SSH_OPTS } from '../../lib/exec-in-sandbox.js';

export function uploadFileViaScp(options: {
  sourcePath: string;
  destinationPath: string;
  filename: string;
  host: string;
  user: string;
  keyPath?: string;
  keyContent?: string;
  port?: number;
}): string {
  let keyPath = options.keyPath;
  let tempDir: string | undefined;

  try {
    if (options.keyContent) {
      tempDir = mkdtempSync(join(tmpdir(), 'sandbox-upload-key-'));
      keyPath = join(tempDir, 'ssh_key');
      writeFileSync(keyPath, options.keyContent, { mode: 0o600 });
    }
    if (!keyPath) throw new Error('SSH key not available');

    const sshPortArgs = options.port ? ['-p', String(options.port)] : [];
    const scpPortArgs = options.port ? ['-P', String(options.port)] : [];
    const target = `${options.user}@${options.host}`;

    try {
      execFileSync(
        'ssh',
        ['-i', keyPath, ...sshPortArgs, ...SSH_OPTS, target, 'mkdir', '-p', options.destinationPath],
        { stdio: 'pipe', timeout: 60_000 },
      );
    } catch {
      // The copy below reports a useful error if the destination is unavailable.
    }

    const remotePath = `${options.destinationPath}/${options.filename}`;
    execFileSync(
      'scp',
      ['-i', keyPath, ...scpPortArgs, ...SSH_OPTS, options.sourcePath, `${target}:${remotePath}`],
      { stdio: 'pipe', timeout: 600_000 },
    );
    return remotePath;
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true });
  }
}

export function uploadDirectoryViaScp(options: {
  archivePath: string;
  destinationPath: string;
  host: string;
  user: string;
  keyPath?: string;
  keyContent?: string;
  port?: number;
}): string {
  let keyPath = options.keyPath;
  let tempDir: string | undefined;
  const remoteArchive = `/tmp/handler-upload-${process.pid}-${Date.now()}.tar.gz`;

  try {
    if (options.keyContent) {
      tempDir = mkdtempSync(join(tmpdir(), 'sandbox-upload-key-'));
      keyPath = join(tempDir, 'ssh_key');
      writeFileSync(keyPath, options.keyContent, { mode: 0o600 });
    }
    if (!keyPath) throw new Error('SSH key not available');

    const sshPortArgs = options.port ? ['-p', String(options.port)] : [];
    const scpPortArgs = options.port ? ['-P', String(options.port)] : [];
    const target = `${options.user}@${options.host}`;
    const sshArgs = ['-i', keyPath, ...sshPortArgs, ...SSH_OPTS, target];

    try {
      execFileSync('ssh', [...sshArgs, 'mkdir', '-p', options.destinationPath], {
        stdio: 'pipe',
        timeout: 60_000,
      });
    } catch {
      // The extraction below reports a useful error if the destination is unavailable.
    }

    execFileSync(
      'scp',
      ['-i', keyPath, ...scpPortArgs, ...SSH_OPTS, options.archivePath, `${target}:${remoteArchive}`],
      { stdio: 'pipe', timeout: 300_000 },
    );
    try {
      execFileSync('ssh', [...sshArgs, 'tar', '-xzf', remoteArchive, '-C', options.destinationPath], {
        stdio: 'pipe',
        timeout: 120_000,
      });
    } finally {
      try {
        execFileSync('ssh', [...sshArgs, 'rm', remoteArchive], { stdio: 'pipe', timeout: 30_000 });
      } catch {
        // Remote cleanup is best-effort.
      }
    }

    return options.destinationPath;
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true });
  }
}

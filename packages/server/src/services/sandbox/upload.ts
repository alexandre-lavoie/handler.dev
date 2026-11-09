import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SSH_OPTS } from './exec.js';
import type { SandboxFileContent } from './types.js';

export function expandSandboxPath(filePath: string, home: string): string {
  return filePath.startsWith('~') ? filePath.replace(/^~(?=\/|$)/, home) : filePath;
}

export function uploadFilesViaTar(options: {
  files: SandboxFileContent[];
  host: string;
  user: string;
  home: string;
  keyPath?: string;
  keyContent?: string;
  port?: number;
}): number {
  if (options.files.length === 0) return 0;

  const tempDir = mkdtempSync(join(tmpdir(), 'sandbox-upload-files-'));
  try {
    let keyPath = options.keyPath;
    if (options.keyContent) {
      keyPath = join(tempDir, 'ssh_key');
      writeFileSync(keyPath, options.keyContent, { mode: 0o600 });
    }
    if (!keyPath) throw new Error('SSH key not available');

    const payloadDir = join(tempDir, 'payload');
    const relativePaths: string[] = [];
    for (const file of options.files) {
      const destination = expandSandboxPath(file.destPath, options.home);
      const directory = join(payloadDir, destination);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, file.filename), file.content);
      relativePaths.push(join(destination, file.filename).replace(/^\//, ''));
    }

    const tarData = execFileSync('tar', ['cf', '-', '-C', payloadDir, ...relativePaths], {
      maxBuffer: 50 * 1024 * 1024,
    });
    const portArgs = options.port && options.port !== 22 ? ['-p', String(options.port)] : [];
    execFileSync(
      'ssh',
      [
        '-T', '-i', keyPath, ...portArgs, ...SSH_OPTS,
        `${options.user}@${options.host}`,
        'trap "" TERM; kill 0 2>/dev/null; tar xf - -C / --no-same-owner',
      ],
      { input: tarData, timeout: 30_000 },
    );
    return options.files.length;
  } finally {
    rmSync(tempDir, { recursive: true });
  }
}

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

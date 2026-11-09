import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SSH_OPTS } from './exec.js';
import type { SandboxFileInfo } from './types.js';

export function parseLsOutput(output: string): SandboxFileInfo[] {
  const files: SandboxFileInfo[] = [];
  const longIsoRegex = /^([d\-lbcps])[rwxsStT\-]{9}\s+\d+\s+\S+\s+\S+\s+([\d,]+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/;
  const standardRegex = /^([d\-lbcps])[rwxsStT\-]{9}\s+\d+\s+\S+\s+\S+\s+([\d,]+)\s+([A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\s?\d{4}))\s+(.+)$/;

  for (const line of output.trim().split('\n')) {
    if (line.startsWith('total ') || !line.trim()) continue;
    const match = line.match(longIsoRegex) || line.match(standardRegex);
    if (!match) continue;

    const [, typeChar, size, modified, rawName] = match;
    if (rawName === '.' || rawName === '..') continue;
    const name = typeChar === 'l' ? rawName.split(' -> ')[0] : rawName;
    files.push({
      name,
      type: typeChar === 'd' ? 'directory' : 'file',
      size: parseInt(size.replace(/,/g, ''), 10),
      modified,
    });
  }

  return files;
}

export function listFilesViaSsh(options: {
  path: string;
  host: string;
  user: string;
  keyPath?: string;
  keyContent?: string;
  port?: number;
}): SandboxFileInfo[] {
  let keyPath = options.keyPath;
  let tempDir: string | undefined;

  try {
    if (options.keyContent) {
      tempDir = mkdtempSync(join(tmpdir(), 'sandbox-list-key-'));
      keyPath = join(tempDir, 'ssh_key');
      writeFileSync(keyPath, options.keyContent, { mode: 0o600 });
    }
    if (!keyPath) throw new Error('SSH key not available');

    const portArgs = options.port && options.port !== 22 ? ['-p', String(options.port)] : [];
    const baseArgs = ['-i', keyPath, ...portArgs, ...SSH_OPTS, `${options.user}@${options.host}`, 'ls', '-la'];
    let output: string;
    try {
      output = execFileSync('ssh', [...baseArgs, '--time-style=long-iso', options.path], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch {
      output = execFileSync('ssh', [...baseArgs, options.path], { encoding: 'utf-8', timeout: 30_000 });
    }
    return parseLsOutput(output);
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true });
  }
}

export function downloadFileViaScp(options: {
  path: string;
  host: string;
  user: string;
  keyPath?: string;
  keyContent?: string;
  port?: number;
}): Buffer {
  let keyPath = options.keyPath;
  const tempDir = mkdtempSync(join(tmpdir(), 'sandbox-download-'));

  try {
    if (options.keyContent) {
      keyPath = join(tempDir, 'ssh_key');
      writeFileSync(keyPath, options.keyContent, { mode: 0o600 });
    }
    if (!keyPath) throw new Error('SSH key not available');

    const destination = join(tempDir, 'downloaded-file');
    const portArgs = options.port ? ['-P', String(options.port)] : [];
    execFileSync(
      'scp',
      [
        '-i', keyPath,
        ...portArgs,
        ...SSH_OPTS,
        `${options.user}@${options.host}:${options.path}`,
        destination,
      ],
      { stdio: 'pipe', timeout: 300_000 },
    );
    return readFileSync(destination);
  } finally {
    rmSync(tempDir, { recursive: true });
  }
}

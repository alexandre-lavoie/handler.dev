/**
 * Unified Sandboxes API Routes
 *
 * Provides a single API for managing all compute environments:
 * - Docker containers
 * - Firecracker VMs
 * - Daytona cloud workspaces
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ensureSandboxService as ensureSandboxServiceInitialized, resetSandboxService } from '../services/sandbox/index.js';
import { dockerService } from '../services/docker.js';
import type { SandboxBackend, SandboxStatus } from '../types/sandbox.js';
import { execFileSync } from 'child_process';
import { validateSandboxId, validatePath, validateFilename } from '../lib/validation.js';

const sandboxes = new Hono();

/**
 * Reset the sandbox service so it will be reinitialized on next use.
 * Call this after cloud backend configuration changes.
 */
export function reinitializeSandboxService() {
  resetSandboxService();
}

const ListSandboxesQuerySchema = z.object({
  backend: z.string().optional(), // Comma-separated list of backends
  status: z.string().optional(),  // Comma-separated list of statuses
  search: z.string().optional(),
});

const CreateSandboxSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    'Name must start with alphanumeric and contain only alphanumeric, underscore, period, or hyphen'),
  backend: z.string().min(1),
  image: z.string().min(1),

  // Optional resources
  vcpus: z.number().min(1).max(32).optional(),
  memoryMb: z.number().min(256).max(65536).optional(),
  diskGb: z.number().min(1).max(1000).optional(),

  // Ports
  ports: z.array(z.object({
    container: z.number().min(1).max(65535),
    host: z.number().min(1).max(65535),
    protocol: z.string().optional(),
  })).optional(),

  // Docker-specific options
  dockerOptions: z.object({
    dockerfile: z.string().optional(),
    volumes: z.array(z.object({
      name: z.string(),
      mountPath: z.string(),
    })).optional(),
    env: z.record(z.string()).optional(),
    enableSsh: z.boolean().optional(),
  }).optional(),

  // VM-specific options
  vmOptions: z.object({
    hypervisor: z.enum(['firecracker']).optional(),
    networkMode: z.enum(['bridged', 'nat']).optional(),
    volumes: z.array(z.object({
      id: z.string(),
      mountPath: z.string(),
    })).optional(),
  }).optional(),

  // Daytona-specific options
  daytonaOptions: z.object({
    sizeClass: z.enum(['small', 'medium', 'large']).optional(),
    language: z.string().optional(),
    volumes: z.array(z.object({
      name: z.string(),
      mountPath: z.string(),
    })).optional(),
  }).optional(),

  // AWS-specific options
  awsOptions: z.object({
    sizeClass: z.enum(['small', 'medium', 'large']).optional(),
    purchaseType: z.enum(['spot', 'on-demand']).optional(),
    instanceType: z.string().optional(),
    amiId: z.string().optional(),
    volumeId: z.string().optional(),
    volumeSizeGb: z.number().optional(),
    availabilityZone: z.string().optional(),
    securityGroupIds: z.array(z.string()).optional(),
    subnetId: z.string().optional(),
  }).optional(),

  // Azure-specific options
  azureOptions: z.object({
    sizeClass: z.enum(['small', 'medium', 'large']).optional(),
    vmSize: z.string().optional(),
    resourceGroup: z.string().optional(),
  }).optional(),

  // GCP-specific options
  gcpOptions: z.object({
    sizeClass: z.enum(['small', 'medium', 'large']).optional(),
    machineType: z.string().optional(),
    zone: z.string().optional(),
  }).optional(),

  // DigitalOcean-specific options
  digitaloceanOptions: z.object({
    sizeClass: z.enum(['small', 'medium', 'large']).optional(),
    sizeSlug: z.string().optional(),
    region: z.string().optional(),
  }).optional(),

  // Linode-specific options
  linodeOptions: z.object({
    sizeClass: z.enum(['small', 'medium', 'large']).optional(),
    linodeType: z.string().optional(),
    region: z.string().optional(),
  }).optional(),

  // Agent config preset to inject after creation
  agentConfigId: z.string().optional(),
});

/**
 * GET /api/sandboxes
 * List all sandboxes with optional filtering
 *
 * Query params:
 * - backend: Comma-separated list of backends (docker,firecracker,daytona)
 * - status: Comma-separated list of statuses (running,stopped,error,etc.)
 * - search: Search term for name/image
 */
sandboxes.get('/', zValidator('query', ListSandboxesQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const service = await ensureSandboxServiceInitialized();

  // Parse backend filter
  let backends: SandboxBackend[] | undefined;
  if (query.backend) {
    backends = query.backend.split(',').filter((b): b is SandboxBackend => true);
  }

  // Parse status filter
  let status: SandboxStatus[] | undefined;
  if (query.status) {
    status = query.status.split(',').filter((s): s is SandboxStatus =>
      ['creating', 'starting', 'running', 'stopping', 'stopped', 'paused', 'error', 'archived', 'building'].includes(s)
    );
  }

  try {
    const result = await service.list({
      backends,
      status,
      search: query.search,
    });

    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list sandboxes';
    return c.json({ error: message }, 500);
  }
});

/**
 * GET /api/sandboxes/backends
 * Get backend availability status
 */
sandboxes.get('/backends', async (c) => {
  const service = await ensureSandboxServiceInitialized();

  try {
    const backends = await service.getBackendStatus();
    return c.json(backends);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get backend status';
    return c.json({ error: message }, 500);
  }
});

/**
 * GET /api/sandboxes/:id
 * Get a specific sandbox by ID
 */
sandboxes.get('/:id', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.get(id);

    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    return c.json(sandbox);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get sandbox';
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/sandboxes
 * Create a new sandbox
 */
sandboxes.post('/', zValidator('json', CreateSandboxSchema), async (c) => {
  const body = c.req.valid('json');
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.create(body);

    // If agentConfigId is provided, schedule injection after sandbox is running
    if (body.agentConfigId) {
      const configId = body.agentConfigId;
      // Fire-and-forget: poll for running state and inject
      (async () => {
        try {
          const { getAgentConfig } = await import('../services/agent-config.js');
          const config = await getAgentConfig(configId);
          if (!config) {
            console.warn(`[SandboxRoutes] Agent config ${configId} not found for injection`);
            return;
          }

          // Poll for sandbox to be running (max 120 seconds)
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const current = await service.get(sandbox.id);
            if (!current || current.status === 'error') break;
            if (current.status === 'running') {
              // Inject via internal API call
              const apiBase = `http://localhost:${process.env.SERVER_PORT || '4001'}/api`;
              const res = await fetch(`${apiBase}/agent-configs/${configId}/inject/${sandbox.id}`, {
                method: 'POST',
              });
              if (res.ok) {
                console.log(`[SandboxRoutes] Agent config ${configId} injected into sandbox ${sandbox.id}`);
              } else {
                console.warn(`[SandboxRoutes] Failed to inject agent config: ${await res.text()}`);
              }
              break;
            }
          }
        } catch (err) {
          console.error('[SandboxRoutes] Agent config injection error:', err);
        }
      })();
    }

    // Fire-and-forget: inject default quick files after sandbox is running
    (async () => {
      try {
        const { getDefaultQuickFiles } = await import('../services/quick-files.js');
        const defaults = await getDefaultQuickFiles();
        if (defaults.length === 0) return;

        const { dirname, basename } = await import('path');
        const { injectFilesIntoSandbox } = await import('../services/sandbox-inject.js');

        // Poll for sandbox to be running (max 120 seconds)
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const current = await service.get(sandbox.id);
          if (!current || current.status === 'error') break;
          if (current.status === 'running') {
            const filesToInject = defaults.map(qf => ({
              content: qf.content,
              destPath: dirname(qf.destPath),
              filename: basename(qf.destPath),
            }));
            const count = await injectFilesIntoSandbox(sandbox.id, filesToInject);
            console.log(`[SandboxRoutes] Injected ${count} default quick file(s) into sandbox ${sandbox.id}`);
            break;
          }
        }
      } catch (err) {
        console.error('[SandboxRoutes] Quick files injection error:', err);
      }
    })();

    return c.json(sandbox, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create sandbox';
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/sandboxes/:id/start
 * Start a stopped sandbox
 */
sandboxes.post('/:id/start', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.start(id);
    return c.json(sandbox);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start sandbox';
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/sandboxes/:id/stop
 * Stop a running sandbox
 */
sandboxes.post('/:id/stop', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.stop(id);
    return c.json(sandbox);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to stop sandbox';
    return c.json({ error: message }, 500);
  }
});

/**
 * PATCH /api/sandboxes/:id
 * Update a sandbox (rename)
 */
const UpdateSandboxSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    'Name must start with alphanumeric and contain only alphanumeric, underscore, period, or hyphen'),
});

sandboxes.patch('/:id', zValidator('json', UpdateSandboxSchema), async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const body = c.req.valid('json');
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.rename(id, body.name);
    return c.json(sandbox);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to rename sandbox';
    return c.json({ error: message }, 500);
  }
});

/**
 * PATCH /api/sandboxes/:id/resources
 * Update sandbox resources (vCPUs, memory, disk)
 */
const UpdateResourcesSchema = z.object({
  vcpus: z.number().min(1).max(32).optional(),
  memoryMb: z.number().min(128).max(65536).optional(),
  diskGb: z.number().min(1).max(1000).optional(),
});

sandboxes.patch('/:id/resources', zValidator('json', UpdateResourcesSchema), async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const body = c.req.valid('json');
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.updateResources(id, body);
    return c.json(sandbox);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update sandbox resources';
    const status = message.includes('must be stopped') ? 409 : 500;
    return c.json({ error: message }, status);
  }
});

/**
 * DELETE /api/sandboxes/:id
 * Delete a sandbox
 */
sandboxes.delete('/:id', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const service = await ensureSandboxServiceInitialized();

  try {
    await service.delete(id);
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete sandbox';
    return c.json({ error: message }, 500);
  }
});

/**
 * GET /api/sandboxes/:id/logs
 * Get sandbox logs
 */
sandboxes.get('/:id/logs', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const tail = parseInt(c.req.query('tail') || '200', 10);
  const service = await ensureSandboxServiceInitialized();

  try {
    const logs = await service.getLogs(id, { tail, timestamps: true });
    if (logs === null) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    return c.json({ logs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get sandbox logs';
    return c.json({ error: message }, 500);
  }
});

/**
 * GET /api/sandboxes/:id/logs/stream
 * Stream sandbox logs via SSE
 */
sandboxes.get('/:id/logs/stream', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const tail = parseInt(c.req.query('tail') || '100', 10);
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.get(id);
    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    // Only Docker supports streaming for now
    if (sandbox.backend !== 'docker') {
      return c.json({ error: 'Log streaming not supported for this backend' }, 400);
    }

    // Set up SSE headers
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    let cleanup: (() => void) | null = null;
    let closed = false;

    const sendEvent = async (event: string, data: string) => {
      if (closed) return;
      try {
        await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        // Stream closed
      }
    };

    const containerId = id.startsWith('docker-') ? id.slice(7) : id;

    // Start streaming logs
    dockerService.streamContainerLogs(
      containerId,
      (line) => sendEvent('log', line),
      { tail }
    ).then((cleanupFn) => {
      cleanup = cleanupFn;
    }).catch((error) => {
      sendEvent('error', error instanceof Error ? error.message : 'Unknown error');
    });

    // Clean up after 5 minutes or when client disconnects
    const timeout = setTimeout(async () => {
      closed = true;
      cleanup?.();
      await sendEvent('done', 'Timeout - stream closed after 5 minutes');
      await writer.close();
    }, 5 * 60 * 1000);

    c.req.raw.signal.addEventListener('abort', () => {
      closed = true;
      cleanup?.();
      clearTimeout(timeout);
      writer.close().catch(() => {});
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to stream sandbox logs';
    return c.json({ error: message }, 500);
  }
});

/**
 * GET /api/sandboxes/:id/ssh-key
 * Download SSH private key for the sandbox
 */
sandboxes.get('/:id/ssh-key', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.get(id);
    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    const privateKey = await service.getSSHKey(id);
    if (!privateKey) {
      return c.json({ error: 'SSH key not available for this sandbox' }, 404);
    }

    c.header('Content-Type', 'application/x-pem-file');
    c.header('Content-Disposition', `attachment; filename="${sandbox.name.replace(/[^a-z0-9]/gi, '_')}_key.pem"`);

    return c.body(privateKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get SSH key';
    return c.json({ error: message }, 500);
  }
});

/**
 * GET /api/sandboxes/:id/ssh-command
 * Get SSH command for connecting to the sandbox
 */
sandboxes.get('/:id/ssh-command', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.get(id);
    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    if (sandbox.status !== 'running') {
      return c.json({ error: 'Sandbox must be running to get SSH command' }, 400);
    }

    const sshCommand = await service.getSSHCommand(id);
    if (!sshCommand) {
      return c.json({ error: 'SSH command not available for this sandbox' }, 404);
    }

    return c.json({ sshCommand });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get SSH command';
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/sandboxes/:id/upload
 * Upload a file to the sandbox's working directory
 */
sandboxes.post('/:id/upload', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.get(id);
    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    if (sandbox.status !== 'running') {
      return c.json({ error: 'Sandbox must be running to upload files' }, 400);
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    const requestedDestPath = formData.get('destPath') as string | null;
    const destinationPath = requestedDestPath ? validatePath(requestedDestPath) : undefined;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const filename = validateFilename(file.name);
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    // Stream file to temp location instead of buffering in memory (supports large files)
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-upload-'));
    const tempPath = path.join(tempDir, filename);
    fs.mkdirSync(path.dirname(tempPath), { recursive: true });

    const fileStream = file.stream() as unknown as AsyncIterable<Uint8Array>;
    const writeStream = fs.createWriteStream(tempPath);
    for await (const chunk of fileStream) {
      if (!writeStream.write(chunk)) {
        await new Promise<void>((resolve) => writeStream.once('drain', resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.on('error', reject);
    });

    try {
      const uploadedPath = await service.uploadFile(id, {
        sourcePath: tempPath,
        filename,
        destinationPath,
      });
      if (!uploadedPath) return c.json({ error: 'Sandbox not found' }, 404);

      return c.json({ success: true, path: uploadedPath });
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  } catch (error) {
    console.error('[SandboxRoutes] Upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to upload file';
    const status = message.includes('does not have') || message.includes('SSH key not available') ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

/**
 * POST /api/sandboxes/:id/upload-directory
 * Upload a directory to the sandbox using tar (single transfer, avoids SSH connection limits)
 */
sandboxes.post('/:id/upload-directory', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.get(id);
    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    if (sandbox.status !== 'running') {
      return c.json({ error: 'Sandbox must be running to upload files' }, 400);
    }

    const formData = await c.req.formData();
    const files = formData.getAll('files');
    const paths = formData.getAll('paths');

    const requestedDestPath = formData.get('destPath') as string | null;
    const destinationPath = requestedDestPath ? validatePath(requestedDestPath) : undefined;

    if (!files || files.length === 0) {
      return c.json({ error: 'No files provided' }, 400);
    }

    if (files.length !== paths.length) {
      return c.json({ error: 'Mismatched files and paths count' }, 400);
    }

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    // Create temp directory and write all files preserving structure
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-upload-dir-'));
    const contentDir = path.join(tempDir, 'content');
    fs.mkdirSync(contentDir);

    console.log(`[SandboxRoutes] Uploading directory with ${files.length} files`);

    try {
      // Write all files to temp directory with their relative paths
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const relativePath = paths[i];

        if (!(file instanceof File) || typeof relativePath !== 'string') {
          continue;
        }

        const filePath = path.join(contentDir, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        const arrayBuffer = await file.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
      }

      // Create tar archive
      const tarPath = path.join(tempDir, 'upload.tar.gz');
      execFileSync('tar', ['-czf', tarPath, '-C', contentDir, '.'], { stdio: 'pipe' });

      const tarSize = fs.statSync(tarPath).size;
      console.log(`[SandboxRoutes] Created tar archive: ${(tarSize / 1024).toFixed(1)} KB`);

      const uploadedDestination = await service.uploadDirectory(id, {
        archivePath: tarPath,
        destinationPath,
      });
      if (!uploadedDestination) return c.json({ error: 'Sandbox not found' }, 404);

      return c.json({ success: true, filesUploaded: files.length, destination: uploadedDestination });
    } finally {
      // Cleanup temp directory
      fs.rmSync(tempDir, { recursive: true });
    }
  } catch (error) {
    console.error('[SandboxRoutes] Directory upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to upload directory';
    const status = message.includes('does not have') || message.includes('SSH key not available') ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

/**
 * GET /api/sandboxes/:id/files?path=...
 * List files in a sandbox directory
 */
sandboxes.get('/:id/files', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const requestedPath = validatePath(c.req.query('path') || '/');
  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.get(id);
    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    if (sandbox.status !== 'running') {
      return c.json({ error: 'Sandbox must be running to list files' }, 400);
    }

    const files = await service.listFiles(id, requestedPath);
    if (!files) return c.json({ error: 'Sandbox not found' }, 404);

    return c.json({ files, path: requestedPath });
  } catch (error) {
    console.error('[SandboxRoutes] File listing error:', error);
    const message = error instanceof Error ? error.message : 'Failed to list files';
    const status = message.includes('does not have') || message.includes('SSH key not available') ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

/**
 * GET /api/sandboxes/:id/files/download?path=...
 * Download a file from the sandbox
 */
sandboxes.get('/:id/files/download', async (c) => {
  const id = validateSandboxId(c.req.param('id'));
  const rawFilePath = c.req.query('path');

  if (!rawFilePath) {
    return c.json({ error: 'File path is required (use ?path=...)' }, 400);
  }

  const filePath = validatePath(rawFilePath);

  const service = await ensureSandboxServiceInitialized();

  try {
    const sandbox = await service.get(id);
    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    if (sandbox.status !== 'running') {
      return c.json({ error: 'Sandbox must be running to download files' }, 400);
    }

    const fileName = filePath.split('/').pop() || 'file';

    const content = await service.downloadFile(id, filePath);
    if (!content) return c.json({ error: 'Sandbox download failed' }, 404);

    return new Response(new Uint8Array(content), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
    });
  } catch (error) {
    console.error('[SandboxRoutes] Download error:', error);
    const message = error instanceof Error ? error.message : 'Failed to download file';
    const status = message.includes('does not have') || message.includes('SSH key not available') ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

// ============ Guest Metrics ============

sandboxes.get('/:id/metrics', async (c) => {
  try {
    const id = c.req.param('id');
    if (!validateSandboxId(id)) {
      return c.json({ error: 'Invalid sandbox ID' }, 400);
    }

    const service = await ensureSandboxServiceInitialized();
    const sandbox = await service.get(id);

    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    if (sandbox.status !== 'running') {
      return c.json({ metrics: null });
    }

    return c.json({ metrics: await service.getMetrics(id) });
  } catch (error) {
    console.error('[SandboxRoutes] Metrics error:', error);
    return c.json({ metrics: null });
  }
});

// ============ Agent Detection ============

sandboxes.get('/:id/agents', async (c) => {
  try {
    const id = c.req.param('id');
    if (!validateSandboxId(id)) {
      return c.json({ error: 'Invalid sandbox ID' }, 400);
    }

    const service = await ensureSandboxServiceInitialized();
    const sandbox = await service.get(id);

    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    if (sandbox.status !== 'running') {
      return c.json({ agents: [] });
    }

    return c.json({ agents: await service.getAgents(id) });
  } catch (error) {
    console.error('[SandboxRoutes] Agent detection error:', error);
    return c.json({ agents: [] });
  }
});

// ============ Tmux Session Listing ============

/**
 * GET /api/sandboxes/:id/tmux-sessions
 * List tmux sessions running inside a sandbox.
 * Returns { sessions: [{ name, windows, created }] }
 */
sandboxes.get('/:id/tmux-sessions', async (c) => {
  try {
    const id = c.req.param('id');
    if (!validateSandboxId(id)) {
      return c.json({ error: 'Invalid sandbox ID' }, 400);
    }

    const service = await ensureSandboxServiceInitialized();
    const sandbox = await service.get(id);

    if (!sandbox) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    if (sandbox.status !== 'running') {
      return c.json({ sessions: [] });
    }

    return c.json({ sessions: await service.getTmuxSessions(id) });
  } catch (error) {
    console.error('[SandboxRoutes] Tmux session listing error:', error);
    return c.json({ sessions: [] });
  }
});

// ============ Terminal Summary (AI-powered) ============

/**
 * GET /api/sandboxes/:id/terminal-summary
 * Get a short AI-generated summary of what's happening in the terminal.
 * Returns { summary: string, updatedAt: number } or { summary: null }.
 */
sandboxes.get('/:id/terminal-summary', async (c) => {
  try {
    const id = c.req.param('id');
    if (!validateSandboxId(id)) {
      return c.json({ summary: null }, 400);
    }

    const service = await ensureSandboxServiceInitialized();
    const result = await service.getTerminalSummary(id, c.req.query('session'));
    if (result) {
      return c.json({ status: result.status, summary: result.summary, updatedAt: result.updatedAt });
    }
    return c.json({ status: null, summary: null });
  } catch (error) {
    console.error('[SandboxRoutes] Terminal summary error:', error);
    return c.json({ summary: null });
  }
});

// ============ Terminal Capture (ANSI snapshot for previews) ============

/**
 * GET /api/sandboxes/:id/terminal-capture
 * Capture the current tmux pane content with ANSI escape codes.
 * Returns { content: string } or { content: null }.
 */
sandboxes.get('/:id/terminal-capture', async (c) => {
  try {
    const id = c.req.param('id');
    if (!validateSandboxId(id)) return c.json({ content: null }, 400);

    const service = await ensureSandboxServiceInitialized();
    return c.json({ content: await service.captureTerminal(id) });
  } catch {
    return c.json({ content: null });
  }
});

// ============ Git Operations (backend-agnostic) ============

/**
 * GET /api/sandboxes/:id/git-log
 * Get git commit history from inside a running sandbox
 */
sandboxes.get('/:id/git-log', async (c) => {
  const id = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const workdir = c.req.query('cwd') || '/home/agent';

  try {
    const service = await ensureSandboxServiceInitialized();
    return c.json(await service.getGitLog(id, limit, workdir));
  } catch (error) {
    console.error('[SandboxRoutes] Git log error:', error);
    return c.json({ commits: [], branch: '' });
  }
});

/**
 * GET /api/sandboxes/:id/git-show/:hash
 * Get details of a specific commit from inside a running sandbox
 */
sandboxes.get('/:id/git-show/:hash', async (c) => {
  const id = c.req.param('id');
  const hash = c.req.param('hash');
  const workdir = c.req.query('cwd') || '/home/agent';

  try {
    const service = await ensureSandboxServiceInitialized();
    return c.json({ output: await service.getGitCommit(id, hash, workdir) });
  } catch (error) {
    console.error('[SandboxRoutes] Git show error:', error);
    return c.json({ output: '' });
  }
});

export default sandboxes;

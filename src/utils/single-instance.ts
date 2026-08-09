import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';

const MAX_REQUEST_BYTES = 1_000_000;

export class SingleInstanceError extends Error {
  constructor(public readonly lockPath: string, public readonly ownerPid?: number) {
    super(ownerPid
      ? `bridge is already running (pid ${ownerPid}): ${lockPath}`
      : `bridge is already running: ${lockPath}`);
    this.name = 'SingleInstanceError';
  }
}

export interface InstanceResponse {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface SingleInstanceHandle {
  readonly lockPath: string;
  setRequestHandler(handler: (request: unknown) => Promise<unknown> | unknown): void;
  release(): Promise<void>;
}

interface LockMetadata {
  pid: number;
  instanceId: string;
  startedAt: string;
  endpoint: string;
}

function endpointFor(lockPath: string): string {
  const hash = createHash('sha256').update(resolve(lockPath).toLowerCase()).digest('hex').slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\cli-in-wechat-${hash}`
    : `${lockPath}.${hash}.sock`;
}

function readOwnerPid(lockPath: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockMetadata>;
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0 ? Number(value.pid) : undefined;
  } catch {
    return undefined;
  }
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function connectable(endpoint: string): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = createConnection(endpoint);
    const finish = (value: boolean) => {
      socket.destroy();
      resolveConnect(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function acquireSingleInstance(lockPath: string): Promise<SingleInstanceHandle> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const endpoint = endpointFor(lockPath);
  let requestHandler: ((request: unknown) => Promise<unknown> | unknown) | undefined;
  const server = createServer((socket) => handleSocket(socket, () => requestHandler));

  try {
    await listen(server, endpoint);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw error;
    if (process.platform !== 'win32' && !(await connectable(endpoint))) {
      try { unlinkSync(endpoint); } catch { /* another process may have repaired it */ }
      try {
        await listen(server, endpoint);
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw retryError;
        throw new SingleInstanceError(lockPath, readOwnerPid(lockPath));
      }
    } else {
      throw new SingleInstanceError(lockPath, readOwnerPid(lockPath));
    }
  }

  const metadata: LockMetadata = {
    pid: process.pid,
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    endpoint,
  };
  writeFileSync(lockPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  let released = false;

  return {
    lockPath,
    setRequestHandler(handler): void {
      requestHandler = handler;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockMetadata>;
        if (current.instanceId === metadata.instanceId) unlinkSync(lockPath);
      } catch { /* best effort during shutdown */ }
      if (process.platform !== 'win32' && existsSync(endpoint)) {
        try { unlinkSync(endpoint); } catch { /* best effort */ }
      }
    },
  };
}

function handleSocket(
  socket: Socket,
  getHandler: () => ((request: unknown) => Promise<unknown> | unknown) | undefined,
): void {
  let input = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
      socket.end(`${JSON.stringify({ ok: false, error: 'request too large' })}\n`);
      return;
    }
    const newline = input.indexOf('\n');
    if (newline < 0) return;
    const line = input.slice(0, newline);
    input = '';
    void (async () => {
      try {
        const handler = getHandler();
        if (!handler) throw new Error('bridge is not ready');
        const value = await handler(JSON.parse(line));
        socket.end(`${JSON.stringify({ ok: true, value } satisfies InstanceResponse)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        socket.end(`${JSON.stringify({ ok: false, error: message } satisfies InstanceResponse)}\n`);
      }
    })();
  });
}

export async function requestRunningInstance(lockPath: string, request: unknown): Promise<InstanceResponse | null> {
  const endpoint = endpointFor(lockPath);
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(endpoint);
    let response = '';
    let connected = false;
    socket.setEncoding('utf8');
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      socket.destroy();
      try {
        resolveRequest(JSON.parse(response.slice(0, newline)) as InstanceResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('bridge request timed out'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (!connected && ['ENOENT', 'ECONNREFUSED'].includes(error.code || '')) {
        resolveRequest(null);
      } else {
        reject(error);
      }
    });
  });
}

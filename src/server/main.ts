import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { NotFoundError, ProjectStorage, RevisionConflictError } from './storage';

const listeningPort = Number(process.env.PORT ?? 8740);
const dataDirectory = resolve(process.env.SPRITELOOM_DATA_DIR ?? 'data');
const staticDirectory = resolve(process.env.SPRITELOOM_STATIC_DIR ?? join(import.meta.dirname, 'web'));
const basicAuthCredentials = process.env.SPRITELOOM_BASIC_AUTH ?? '';
const maximumJsonBodyBytes = 8 * 1024 * 1024;
const maximumFrameBodyBytes = 64 * 1024 * 1024;

const contentTypesByExtension: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const storage = new ProjectStorage(dataDirectory);

class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readRequestBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const bodyChunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const chunkBuffer = chunk as Buffer;
    receivedBytes += chunkBuffer.length;
    if (receivedBytes > maximumBytes) throw new HttpError(413, 'Upload is too large.');
    bodyChunks.push(chunkBuffer);
  }
  return Buffer.concat(bodyChunks);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const bodyBytes = await readRequestBody(request, maximumJsonBodyBytes);
  try {
    const parsedBody: unknown = JSON.parse(bodyBytes.toString('utf8') || '{}');
    if (typeof parsedBody !== 'object' || parsedBody === null) throw new Error('not an object');
    return parsedBody as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
}

function isAuthorized(request: IncomingMessage): boolean {
  if (basicAuthCredentials === '') return true;
  const authorizationHeader = request.headers.authorization ?? '';
  if (!authorizationHeader.startsWith('Basic ')) return false;
  const suppliedCredentials = Buffer.from(Buffer.from(authorizationHeader.slice(6), 'base64').toString('utf8'));
  const expectedCredentials = Buffer.from(basicAuthCredentials);
  return (
    suppliedCredentials.length === expectedCredentials.length && timingSafeEqual(suppliedCredentials, expectedCredentials)
  );
}

async function handleApiRequest(request: IncomingMessage, response: ServerResponse, pathSegments: string[]): Promise<void> {
  const method = request.method ?? 'GET';
  const [, resource, projectIdentifier, subResource, frameFileName] = pathSegments;
  if (resource !== 'projects') throw new HttpError(404, 'Unknown API route.');

  if (projectIdentifier === undefined) {
    if (method === 'GET') return sendJson(response, 200, { projects: await storage.listProjects() });
    if (method === 'POST') {
      const body = await readJsonBody(request);
      const projectName = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : 'Untitled sprite';
      return sendJson(response, 201, { project: await storage.createProject(projectName.slice(0, 120)) });
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  if (subResource === undefined) {
    if (method === 'GET') return sendJson(response, 200, { project: await storage.readProject(projectIdentifier) });
    if (method === 'PUT') {
      const body = await readJsonBody(request);
      const baseRevision = typeof body.baseRevision === 'number' ? body.baseRevision : -1;
      try {
        const savedProject = await storage.saveProject(projectIdentifier, body.project, baseRevision);
        return sendJson(response, 200, { project: savedProject });
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          return sendJson(response, 409, { error: error.message, project: error.currentProject });
        }
        throw error;
      }
    }
    if (method === 'DELETE') {
      await storage.deleteProject(projectIdentifier);
      return sendJson(response, 200, { deleted: true });
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  if (subResource === 'frames' && frameFileName !== undefined && frameFileName.endsWith('.png')) {
    const frameIdentifier = frameFileName.slice(0, -4);
    if (method === 'GET') {
      const { bytes, modifiedAt } = await storage.readFramePixels(projectIdentifier, frameIdentifier);
      const entityTag = `"${bytes.length.toString(36)}-${modifiedAt.getTime().toString(36)}"`;
      if (request.headers['if-none-match'] === entityTag) {
        response.writeHead(304, { etag: entityTag });
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': bytes.length,
        'cache-control': 'no-cache',
        etag: entityTag,
      });
      response.end(bytes);
      return;
    }
    if (method === 'PUT') {
      const pngBytes = await readRequestBody(request, maximumFrameBodyBytes);
      try {
        await storage.writeFramePixels(projectIdentifier, frameIdentifier, pngBytes);
      } catch (error) {
        if (error instanceof NotFoundError) throw error;
        throw new HttpError(400, error instanceof Error ? error.message : 'Frame upload failed.');
      }
      return sendJson(response, 200, { saved: true });
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  throw new HttpError(404, 'Unknown API route.');
}

async function serveStaticFile(request: IncomingMessage, response: ServerResponse, requestPath: string): Promise<void> {
  const decodedPath = decodeURIComponent(requestPath);
  const relativePath = normalize(decodedPath).replace(/^([/\\])+/, '');
  let filePath = join(staticDirectory, relativePath);
  if (!filePath.startsWith(staticDirectory + sep) && filePath !== staticDirectory) throw new HttpError(404, 'Not found.');

  let fileStats = await stat(filePath).catch(() => null);
  if (fileStats === null || fileStats.isDirectory()) {
    // Single-page app: every unknown path gets the shell.
    filePath = join(staticDirectory, 'index.html');
    fileStats = await stat(filePath);
  }
  const entityTag = `"${fileStats.size.toString(36)}-${fileStats.mtimeMs.toString(36)}"`;
  if (request.headers['if-none-match'] === entityTag) {
    response.writeHead(304, { etag: entityTag });
    response.end();
    return;
  }
  const fileBytes = await readFile(filePath);
  response.writeHead(200, {
    'content-type': contentTypesByExtension[extname(filePath)] ?? 'application/octet-stream',
    'content-length': fileBytes.length,
    'cache-control': 'no-cache',
    etag: entityTag,
    'x-content-type-options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : fileBytes);
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    if (requestUrl.pathname === '/healthz') return sendJson(response, 200, { ok: true });
    if (!isAuthorized(request)) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="spriteloom", charset="UTF-8"' });
      response.end('Sign in to use spriteloom.');
      return;
    }
    const pathSegments = requestUrl.pathname.split('/').filter((segment) => segment !== '');
    if (pathSegments[0] === 'api') return await handleApiRequest(request, response, pathSegments);
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    return await serveStaticFile(request, response, requestUrl.pathname);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : error instanceof NotFoundError ? 404 : 500;
    if (statusCode === 500) console.error(error);
    if (!response.headersSent) {
      sendJson(response, statusCode, { error: error instanceof Error ? error.message : 'Something went wrong.' });
    } else {
      response.end();
    }
  }
});

await storage.initialize();
server.listen(listeningPort, () => {
  console.log(`spriteloom listening on port ${listeningPort} (data in ${dataDirectory})`);
});

for (const shutdownSignal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(shutdownSignal, () => server.close(() => process.exit(0)));
}

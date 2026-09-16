import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, ConfigStore } from './lib/config.js';
import {
  applyCors,
  readJson,
  requestOriginAllowed,
  safePathname,
  sendJson,
  sendText,
} from './lib/http.js';
import { createProxy } from './lib/proxy.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8790);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const configStore = new ConfigStore(DATA_DIR);
const proxy = createProxy({ configStore });

const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['public/index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
]);

function securityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function managementOriginAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}

function ensureManagementRequest(request) {
  if (!managementOriginAllowed(request)) {
    throw new AppError(403, 'management_origin_denied', 'Management API is local-only.');
  }
}

function ensureProxyOrigin(request, config) {
  if (!requestOriginAllowed(request, config.allowedOrigins)) {
    throw new AppError(
      403,
      'origin_denied',
      'Browser Origin is not allowed. Add the exact Origin in the management page.',
    );
  }
}

function serveStatic(response, pathname) {
  const entry = staticFiles.get(pathname);
  if (!entry) return false;
  const [relativePath, contentType] = entry;
  const body = readFileSync(join(ROOT, relativePath));
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
  return true;
}

async function handleManagement(request, response, pathname) {
  if (!pathname.startsWith('/api/')) return false;
  ensureManagementRequest(request);

  if (pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      version: '0.1.0',
      host: HOST,
      port: PORT,
      activeUpstream: configStore.snapshot().activeUpstreamId,
    });
    return true;
  }

  if (pathname === '/api/config' && request.method === 'GET') {
    sendJson(response, 200, configStore.snapshot());
    return true;
  }

  if (pathname === '/api/config' && request.method === 'PUT') {
    const body = await readJson(request, 256 * 1024);
    sendJson(response, 200, configStore.save(body));
    return true;
  }

  if (pathname === '/api/diagnostics' && request.method === 'GET') {
    const config = configStore.snapshot();
    sendJson(response, 200, {
      records: proxy.diagnostics.list(config.diagnosticLimit),
      persistence: 'memory-only',
    });
    return true;
  }

  if (pathname === '/api/diagnostics' && request.method === 'DELETE') {
    proxy.diagnostics.clear();
    sendJson(response, 200, { ok: true });
    return true;
  }

  throw new AppError(404, 'not_found', 'Management endpoint not found.');
}

async function handleProxy(request, response, pathname) {
  const supported =
    (request.method === 'GET' && pathname === '/v1/models') ||
    (request.method === 'POST' && ['/v1/responses', '/v1/chat/completions'].includes(pathname));

  if (!supported && request.method !== 'OPTIONS') return false;

  const config = configStore.snapshot();
  ensureProxyOrigin(request, config);
  applyCors(request, response, config.allowedOrigins);

  if (request.method === 'OPTIONS') {
    if (!['/v1/models', '/v1/responses', '/v1/chat/completions'].includes(pathname)) return false;
    response.writeHead(204, { 'content-length': '0' });
    response.end();
    return true;
  }

  let body = null;
  if (request.method === 'POST') {
    body = await readJson(request, 12 * 1024 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'invalid_body', 'Generation request must be a JSON object.');
    }
  }

  return proxy.handle(request, response, pathname, body);
}

const server = createServer(async (request, response) => {
  securityHeaders(response);

  try {
    const pathname = safePathname(request);

    if (request.method === 'GET' && serveStatic(response, pathname)) return;
    if (pathname === '/favicon.ico' && request.method === 'GET') {
      response.writeHead(204, { 'content-length': '0' });
      response.end();
      return;
    }

    if (await handleManagement(request, response, pathname)) return;
    if (await handleProxy(request, response, pathname)) return;

    sendText(response, 404, 'Not found.');
  } catch (error) {
    if (response.headersSent || response.destroyed) {
      if (!response.destroyed) response.destroy(error);
      return;
    }

    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : 'internal_error';
    const message = error instanceof AppError ? error.message : 'Internal proxy error.';
    if (!(error instanceof AppError)) console.error(error);
    sendJson(response, status, { error: code, message });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  console.log(`Codex Cache Proxy listening on http://${HOST}:${PORT}`);
  console.log(`Management UI: http://127.0.0.1:${PORT}/`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn('WARNING: proxy is listening beyond loopback. API keys pass through this process; protect the network path.');
  }
});

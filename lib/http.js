import { AppError } from './config.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export function lowerCaseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

export function forwardRequestHeaders(headers) {
  const input = lowerCaseHeaders(headers);
  const out = {};
  for (const [name, value] of Object.entries(input)) {
    if (HOP_BY_HOP.has(name)) continue;
    if (name === 'origin' || name === 'referer') continue;
    out[name] = value;
  }
  return out;
}

export function copyResponseHeaders(source, response) {
  for (const [name, value] of source.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'set-cookie') continue;
    response.setHeader(name, value);
  }
}

export async function readBody(request, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new AppError(413, 'body_too_large', `Request body exceeds ${limit} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(request, limit) {
  const raw = await readBody(request, limit);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

export function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export function requestOriginAllowed(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

export function applyCors(request, response, allowedOrigins) {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  response.setHeader(
    'access-control-allow-headers',
    request.headers['access-control-request-headers'] || 'authorization,content-type',
  );
  response.setHeader('access-control-max-age', '600');
}

export function safePathname(request) {
  let url;
  try {
    url = new URL(request.url || '/', 'http://127.0.0.1');
  } catch {
    throw new AppError(400, 'bad_url', 'Invalid request URL.');
  }
  return url.pathname;
}

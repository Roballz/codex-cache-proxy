import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireValue(ok, message, code = 'invalid_config') {
  if (!ok) throw new AppError(400, code, message);
}

export const validIdentity = value =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertKeys(value, allowed) {
  requireValue(isObject(value), 'Expected an object.');
  requireValue(
    Object.keys(value).every(key => allowed.includes(key)),
    'Unknown setting found. API keys and arbitrary headers are not stored here.',
  );
}

function normalizeName(value) {
  requireValue(
    typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !/[\x00-\x1f]/.test(value),
    'Name must contain 1-100 printable characters.',
  );
  return value.trim();
}

function normalizeChatMode(value) {
  const mode = value === 'global' ? 'upstream' : value;
  requireValue(['upstream', 'bridge'].includes(mode), 'Invalid Chat Completions mode.');
  return mode;
}

export function normalizeBaseUrl(value) {
  requireValue(typeof value === 'string' && value.length <= 2000, 'Invalid upstream URL.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, 'invalid_url', 'Use an absolute http(s) upstream URL.');
  }
  requireValue(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'URL must be http(s), without credentials, query, or fragment.',
  );

  let path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|models)$/, '');
  if (!path.endsWith('/v1')) path += '/v1';
  url.pathname = path;
  return url.href.replace(/\/+$/, '');
}

export function normalizeOrigin(value) {
  requireValue(typeof value === 'string' && value.length < 300, 'Invalid browser origin.');
  if (value === 'tauri://localhost') return value;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, 'invalid_origin', 'Origin must include a scheme and host.');
  }

  requireValue(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/',
    'Use an exact origin without path, credentials, wildcard, or null.',
  );
  return url.origin;
}

function defaultSession(id, name = 'Default RP') {
  return {
    id,
    name,
    value: randomUUID(),
    interfaceMode: 'chat_completions',
    identityMode: 'lock',
    chatMode: 'upstream',
  };
}

export function defaults() {
  const profileId = randomUUID();
  return {
    version: 1,
    revision: 0,
    activeUpstreamId: null,
    upstreams: [],
    activeSessionId: profileId,
    sessions: [defaultSession(profileId)],
    diagnosticLimit: 80,
    timeoutSeconds: 600,
    allowedOrigins: [
      'http://127.0.0.1:8000',
      'http://localhost:8000',
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
    ],
  };
}

export function validateConfig(input) {
  assertKeys(input, [
    'version',
    'revision',
    'activeUpstreamId',
    'upstreams',
    'activeSessionId',
    'sessions',
    // Legacy top-level mode fields are accepted only so existing settings migrate cleanly.
    'clientInterfaceMode',
    'identityMode',
    'chatCompletionsIdentityMode',
    'diagnosticLimit',
    'timeoutSeconds',
    'allowedOrigins',
  ]);

  requireValue(input.version === 1, 'Unsupported config version.');
  requireValue(Number.isSafeInteger(input.revision) && input.revision >= 0, 'Invalid config revision.');

  const legacyInterfaceMode = input.clientInterfaceMode ?? 'chat_completions';
  requireValue(
    ['responses', 'chat_completions'].includes(legacyInterfaceMode),
    'Invalid TT/ST interface mode.',
  );
  const legacyIdentityMode = input.identityMode ?? 'lock';
  requireValue(
    ['lock', 'fill', 'passthrough'].includes(legacyIdentityMode),
    'Invalid identity mode.',
  );
  const legacyChatMode = normalizeChatMode(input.chatCompletionsIdentityMode ?? 'upstream');

  requireValue(
    Number.isInteger(input.diagnosticLimit) && input.diagnosticLimit >= 10 && input.diagnosticLimit <= 200,
    'Diagnostic limit must be 10-200.',
  );
  requireValue(
    Number.isInteger(input.timeoutSeconds) && input.timeoutSeconds >= 10 && input.timeoutSeconds <= 3600,
    'Request timeout must be 10-3600 seconds.',
  );
  requireValue(Array.isArray(input.upstreams) && input.upstreams.length <= 30, 'At most 30 upstreams.');
  requireValue(
    Array.isArray(input.sessions) && input.sessions.length >= 1 && input.sessions.length <= 100,
    'Keep 1-100 session profiles.',
  );

  const upstreams = input.upstreams.map(upstream => {
    assertKeys(upstream, ['id', 'name', 'baseUrl', 'adapter']);
    requireValue(
      validIdentity(upstream.id) && ['sub2api', 'cpa', 'generic'].includes(upstream.adapter),
      'Invalid upstream id or adapter.',
    );
    return {
      id: upstream.id,
      name: normalizeName(upstream.name),
      baseUrl: normalizeBaseUrl(upstream.baseUrl),
      adapter: upstream.adapter,
    };
  });

  const sessions = input.sessions.map(session => {
    assertKeys(session, ['id', 'name', 'value', 'interfaceMode', 'identityMode', 'chatMode']);
    requireValue(
      validIdentity(session.id) && validIdentity(session.value),
      'Session ID must be 1-128 ASCII letters, digits, dots, colons, underscores, or hyphens.',
    );

    const interfaceMode = session.interfaceMode ?? legacyInterfaceMode;
    requireValue(
      ['responses', 'chat_completions'].includes(interfaceMode),
      'Invalid session TT/ST interface mode.',
    );
    const identityMode = session.identityMode ?? legacyIdentityMode;
    requireValue(
      ['lock', 'fill', 'passthrough'].includes(identityMode),
      'Invalid session identity mode.',
    );
    const chatMode = normalizeChatMode(session.chatMode ?? legacyChatMode);

    return {
      id: session.id,
      name: normalizeName(session.name),
      value: session.value,
      interfaceMode,
      identityMode,
      chatMode,
    };
  });

  requireValue(new Set(upstreams.map(item => item.id)).size === upstreams.length, 'Duplicate upstream id.');
  requireValue(new Set(sessions.map(item => item.id)).size === sessions.length, 'Duplicate session profile id.');
  requireValue(
    upstreams.length ? upstreams.some(item => item.id === input.activeUpstreamId) : input.activeUpstreamId === null,
    'Select an existing upstream.',
  );
  requireValue(
    sessions.some(item => item.id === input.activeSessionId),
    'Select an existing session profile.',
  );
  requireValue(
    Array.isArray(input.allowedOrigins) && input.allowedOrigins.length <= 30,
    'At most 30 browser origins.',
  );

  const normalized = {
    ...input,
    upstreams,
    sessions,
    allowedOrigins: [...new Set(input.allowedOrigins.map(normalizeOrigin))],
  };
  delete normalized.clientInterfaceMode;
  delete normalized.identityMode;
  delete normalized.chatCompletionsIdentityMode;
  return normalized;
}

function atomicWrite(path, text) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export class ConfigStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.path = join(directory, 'settings.json');
    this.backupPath = `${this.path}.bak`;

    if (!existsSync(this.path)) {
      if (existsSync(this.backupPath)) {
        throw new Error(
          'settings.json is missing but settings.json.bak exists. Restore it explicitly; refusing to generate a new session identity.',
        );
      }
      this.value = defaults();
      atomicWrite(this.path, `${JSON.stringify(this.value, null, 2)}\n`);
    } else {
      try {
        this.value = validateConfig(JSON.parse(readFileSync(this.path, 'utf8')));
      } catch {
        throw new Error(
          'Invalid settings.json. Restore settings.json.bak manually; the proxy did not regenerate your session identity.',
        );
      }
      chmodSync(this.path, 0o600);
    }
  }

  snapshot() {
    return structuredClone(this.value);
  }

  save(input) {
    const next = validateConfig(input);
    if (next.revision !== this.value.revision) {
      throw new AppError(409, 'stale_config', 'Settings changed in another tab. Reload before saving.');
    }

    next.revision += 1;
    atomicWrite(this.backupPath, `${JSON.stringify(this.value, null, 2)}\n`);
    atomicWrite(this.path, `${JSON.stringify(next, null, 2)}\n`);
    this.value = next;
    return this.snapshot();
  }
}

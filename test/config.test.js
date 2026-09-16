import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, normalizeBaseUrl, validateConfig } from '../lib/config.js';

test('base URL normalization keeps one /v1 suffix', () => {
  assert.equal(normalizeBaseUrl('https://example.com'), 'https://example.com/v1');
  assert.equal(normalizeBaseUrl('https://example.com/v1/'), 'https://example.com/v1');
  assert.equal(
    normalizeBaseUrl('https://example.com/v1/responses'),
    'https://example.com/v1',
  );
});

test('config store persists the generated session identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-cache-proxy-'));
  try {
    const first = new ConfigStore(directory);
    const firstValue = first.snapshot().sessions[0].value;
    const second = new ConfigStore(directory);
    assert.equal(second.snapshot().sessions[0].value, firstValue);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session stores interface, identity, and Chat mode independently', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-cache-proxy-'));
  try {
    const store = new ConfigStore(directory);
    const next = store.snapshot();
    next.sessions[0].interfaceMode = 'responses';
    next.sessions[0].identityMode = 'fill';
    next.sessions[0].chatMode = 'bridge';
    const saved = store.save(next);

    assert.equal(saved.sessions[0].interfaceMode, 'responses');
    assert.equal(saved.sessions[0].identityMode, 'fill');
    assert.equal(saved.sessions[0].chatMode, 'bridge');
    assert.equal(saved.clientInterfaceMode, undefined);
    assert.equal(saved.identityMode, undefined);
    assert.equal(saved.chatCompletionsIdentityMode, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy global mode fields migrate into every session', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-cache-proxy-'));
  try {
    const store = new ConfigStore(directory);
    const legacy = store.snapshot();
    legacy.clientInterfaceMode = 'responses';
    legacy.identityMode = 'fill';
    legacy.chatCompletionsIdentityMode = 'bridge';
    legacy.sessions = legacy.sessions.map(({ id, name, value }) => ({ id, name, value }));

    const normalized = validateConfig(legacy);
    assert.equal(normalized.sessions[0].interfaceMode, 'responses');
    assert.equal(normalized.sessions[0].identityMode, 'fill');
    assert.equal(normalized.sessions[0].chatMode, 'bridge');
    assert.equal(normalized.clientInterfaceMode, undefined);
    assert.equal(normalized.identityMode, undefined);
    assert.equal(normalized.chatCompletionsIdentityMode, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy native Chat global mode migrates to upstream mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-cache-proxy-'));
  try {
    const store = new ConfigStore(directory);
    const legacy = store.snapshot();
    legacy.chatCompletionsIdentityMode = 'global';
    legacy.sessions = legacy.sessions.map(({ id, name, value }) => ({ id, name, value }));
    const normalized = validateConfig(legacy);
    assert.equal(normalized.sessions[0].chatMode, 'upstream');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('config store writes a backup and never stores arbitrary secret fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-cache-proxy-'));
  try {
    const store = new ConfigStore(directory);
    const next = store.snapshot();
    next.sessions[0].name = 'Renamed';
    const saved = store.save(next);

    assert.equal(saved.sessions[0].name, 'Renamed');
    assert.match(readFileSync(join(directory, 'settings.json.bak'), 'utf8'), /Default RP/);

    assert.throws(
      () => validateConfig({ ...saved, apiKey: 'should-not-be-stored' }),
      error => error.code === 'invalid_config',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

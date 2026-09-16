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

test('config accepts the experimental Responses Bridge mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-cache-proxy-'));
  try {
    const store = new ConfigStore(directory);
    const next = store.snapshot();
    next.chatCompletionsIdentityMode = 'bridge';
    const saved = store.save(next);
    assert.equal(saved.chatCompletionsIdentityMode, 'bridge');
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyIdentity } from '../lib/identity.js';

function config(mode = 'lock') {
  return {
    identityMode: mode,
    activeSessionId: 'profile-1',
    sessions: [{ id: 'profile-1', name: 'Story A', value: 'fixed-session-123' }],
  };
}

const sub2api = { adapter: 'sub2api' };
const cpa = { adapter: 'cpa' };

test('lock mode overwrites client identity with the selected profile', () => {
  const result = applyIdentity(
    { model: 'gpt-5.6-sol', prompt_cache_key: 'client-key' },
    { 'session-id': 'client-session', authorization: 'Bearer test' },
    config('lock'),
    sub2api,
  );

  assert.equal(result.body.prompt_cache_key, 'fixed-session-123');
  assert.equal(result.headers.session_id, 'fixed-session-123');
  assert.equal(result.headers.conversation_id, 'fixed-session-123');
  assert.equal(result.headers['session-id'], undefined);
  assert.equal(result.headers.authorization, 'Bearer test');
  assert.equal(result.diagnostics.overwritten, true);
});

test('CPA adapter emits Session-Id style identity header', () => {
  const result = applyIdentity(
    { model: 'gpt-5.6-sol' },
    {},
    config('lock'),
    cpa,
  );

  assert.equal(result.body.prompt_cache_key, 'fixed-session-123');
  assert.equal(result.headers['session-id'], 'fixed-session-123');
  assert.equal(result.headers.session_id, undefined);
});

test('fill mode preserves one consistent client identity', () => {
  const result = applyIdentity(
    { model: 'gpt-5.6-sol', prompt_cache_key: 'client-stable' },
    { 'session-id': 'client-stable' },
    config('fill'),
    cpa,
  );

  assert.equal(result.body.prompt_cache_key, 'client-stable');
  assert.equal(result.headers['session-id'], 'client-stable');
  assert.equal(result.diagnostics.source, 'client');
});

test('fill mode rejects conflicting client identities', () => {
  assert.throws(
    () =>
      applyIdentity(
        { prompt_cache_key: 'one' },
        { 'session-id': 'two' },
        config('fill'),
        cpa,
      ),
    error => error.code === 'identity_conflict' && error.status === 409,
  );
});

test('passthrough mode does not mutate body or headers', () => {
  const body = { prompt_cache_key: 'original' };
  const headers = { 'session-id': 'original' };
  const result = applyIdentity(body, headers, config('passthrough'), cpa);

  assert.equal(result.body, body);
  assert.equal(result.headers, headers);
  assert.equal(result.changed, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyIdentity } from '../lib/identity.js';

function config(mode = 'lock', chatMode = 'upstream') {
  return {
    activeSessionId: 'profile-1',
    sessions: [
      {
        id: 'profile-1',
        name: 'Story A',
        value: 'fixed-session-123',
        interfaceMode: 'chat_completions',
        identityMode: mode,
        chatMode,
      },
    ],
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
    '/v1/responses',
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
    '/v1/responses',
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
    '/v1/responses',
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
        '/v1/responses',
      ),
    error => error.code === 'identity_conflict' && error.status === 409,
  );
});

test('passthrough mode does not mutate body or headers', () => {
  const body = { prompt_cache_key: 'original' };
  const headers = { 'session-id': 'original' };
  const result = applyIdentity(body, headers, config('passthrough'), cpa, '/v1/responses');

  assert.equal(result.body, body);
  assert.equal(result.headers, headers);
  assert.equal(result.changed, false);
});

test('locked Responses request fills missing reasoning summary', () => {
  const result = applyIdentity(
    {
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: 'hello' }],
      reasoning: { effort: 'high' },
    },
    {},
    config('lock'),
    sub2api,
    '/v1/responses',
  );

  assert.deepEqual(result.body.reasoning, { effort: 'high', summary: 'auto' });
});

test('fill mode preserves an explicit Responses reasoning summary', () => {
  const result = applyIdentity(
    {
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: 'hello' }],
      reasoning: { effort: 'medium', summary: 'concise' },
    },
    {},
    config('fill'),
    sub2api,
    '/v1/responses',
  );

  assert.deepEqual(result.body.reasoning, { effort: 'medium', summary: 'concise' });
});

test('passthrough mode does not add reasoning summary', () => {
  const body = {
    model: 'gpt-5.6-sol',
    input: [{ role: 'user', content: 'hello' }],
    reasoning: { effort: 'high' },
  };
  const result = applyIdentity(body, {}, config('passthrough'), sub2api, '/v1/responses');
  assert.equal(result.body, body);
  assert.deepEqual(result.body.reasoning, { effort: 'high' });
});

test('Chat upstream mode passes client identity through unchanged', () => {
  const body = {
    model: 'gpt-5.6-sol',
    prompt_cache_key: 'client-cache-key',
    messages: [{ role: 'user', content: 'hello' }],
  };
  const headers = {
    authorization: 'Bearer test',
    'session-id': 'client-session',
    'x-session-id': 'client-x-session',
  };

  const result = applyIdentity(
    body,
    headers,
    config('lock', 'upstream'),
    sub2api,
    '/v1/chat/completions',
  );

  assert.equal(result.body, body);
  assert.equal(result.headers, headers);
  assert.equal(result.changed, false);
  assert.equal(result.diagnostics.mode, 'upstream');
  assert.deepEqual(result.diagnostics.inbound, result.diagnostics.outbound);
  assert.equal(result.diagnostics.overwritten, false);
});

test('Chat bridge mode applies the selected session identity mode', () => {
  const result = applyIdentity(
    {
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: 'hello' }],
      reasoning: { effort: 'high' },
    },
    {},
    config('lock', 'bridge'),
    sub2api,
    '/v1/chat/completions',
  );

  assert.equal(result.body.prompt_cache_key, 'fixed-session-123');
  assert.equal(result.headers.session_id, 'fixed-session-123');
  assert.equal(result.diagnostics.mode, 'lock');
  assert.deepEqual(result.body.reasoning, { effort: 'high', summary: 'auto' });
});

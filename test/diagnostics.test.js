import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots, extractUsage, promptSnapshot } from '../lib/diagnostics.js';

test('prompt snapshots ignore session/cache identity fields', () => {
  const a = promptSnapshot({
    model: 'gpt-5.6-sol',
    input: [{ role: 'developer', content: 'fixed' }, { role: 'user', content: 'hello' }],
    prompt_cache_key: 'session-a',
  });
  const b = promptSnapshot({
    model: 'gpt-5.6-sol',
    input: [{ role: 'developer', content: 'fixed' }, { role: 'user', content: 'hello' }],
    prompt_cache_key: 'session-b',
  });

  assert.equal(a.hash, b.hash);
  assert.equal(a.metaHash, b.metaHash);
});

test('snapshot comparison finds the first changed message', () => {
  const before = promptSnapshot({
    model: 'gpt-5.6-sol',
    input: [
      { role: 'developer', content: 'fixed head' },
      { role: 'assistant', content: 'old turn' },
      { role: 'user', content: 'question 1' },
    ],
  });
  const current = promptSnapshot({
    model: 'gpt-5.6-sol',
    input: [
      { role: 'developer', content: 'fixed head' },
      { role: 'assistant', content: 'old turn' },
      { role: 'user', content: 'question 2' },
    ],
  });

  const comparison = compareSnapshots(current, before);
  assert.equal(comparison.available, true);
  assert.equal(comparison.equalMessages, 2);
  assert.equal(comparison.firstChangedMessage, 2);
  assert.ok(comparison.prefixBytesLowerBound > 0);
});

test('usage extraction distinguishes missing cached_tokens from zero', () => {
  const missing = extractUsage({ usage: { input_tokens: 100, output_tokens: 10 } });
  assert.equal(missing.inputTokens, 100);
  assert.equal(missing.cachedTokens, null);
  assert.equal(missing.reasoningTokens, null);
  assert.equal(missing.hitRate, null);

  const zero = extractUsage({
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
    },
  });
  assert.equal(zero.cachedTokens, 0);
  assert.equal(zero.hitRate, 0);
});

test('usage extraction calculates hit rate', () => {
  const usage = extractUsage({
    usage: {
      input_tokens: 80000,
      output_tokens: 1000,
      input_tokens_details: { cached_tokens: 64000 },
    },
  });

  assert.equal(usage.cachedTokens, 64000);
  assert.equal(usage.hitRate, 80);
});

test('usage extraction reads reasoning tokens from Responses and Chat shapes', () => {
  const responses = extractUsage({
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 24 },
    },
  });
  assert.equal(responses.reasoningTokens, 24);

  const chat = extractUsage({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 19 },
    },
  });
  assert.equal(chat.reasoningTokens, 19);
});

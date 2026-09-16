import test from 'node:test';
import assert from 'node:assert/strict';
import { canBridgeChatCompletions, chatCompletionsToResponsesShape } from '../lib/cc_bridge.js';

test('bridges plain-text Chat messages into Responses input shape', () => {
  const source = {
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'system', content: 'preset' },
      { role: 'assistant', content: 'history' },
      { role: 'user', content: 'latest' },
    ],
    stream: true,
    max_completion_tokens: 8000,
    reasoning_effort: 'high',
    temperature: 1,
    top_p: 1,
  };

  const result = chatCompletionsToResponsesShape(source);
  assert.equal(result.bridged, true);
  assert.equal(result.body.messages, undefined);
  assert.equal(result.body.store, false);
  assert.equal(result.body.max_output_tokens, 8000);
  assert.deepEqual(result.body.reasoning, { effort: 'high' });
  assert.deepEqual(result.body.input, [
    { role: 'developer', content: 'preset' },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'history' }],
    },
    { role: 'user', content: 'latest' },
  ]);
});

test('accepts text-only content arrays', () => {
  const result = chatCompletionsToResponsesShape({
    model: 'gpt-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'input_text', text: ' world' }] }],
  });
  assert.equal(result.bridged, true);
  assert.deepEqual(result.body.input, [{ role: 'user', content: 'hello world' }]);
});

test('rejects tools and multimodal messages instead of guessing', () => {
  assert.equal(canBridgeChatCompletions({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'x' } }],
  }).ok, false);

  assert.equal(canBridgeChatCompletions({
    model: 'gpt-test',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
  }).ok, false);
});

test('does not mutate the original Chat request', () => {
  const source = {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  };
  const before = structuredClone(source);
  chatCompletionsToResponsesShape(source);
  assert.deepEqual(source, before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReasoningSummary } from '../lib/reasoning.js';

test('enabled policy fills missing Responses reasoning summary', () => {
  const body = {
    model: 'gpt-5.6-sol',
    input: [{ role: 'user', content: 'hello' }],
    reasoning: { effort: 'high' },
  };

  const result = applyReasoningSummary(body, true);
  assert.notEqual(result, body);
  assert.deepEqual(result.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(body.reasoning, { effort: 'high' });
});

test('disabled policy leaves request unchanged', () => {
  const body = {
    model: 'gpt-5.6-sol',
    input: [{ role: 'user', content: 'hello' }],
    reasoning: { effort: 'high' },
  };

  assert.equal(applyReasoningSummary(body, false), body);
});

test('policy preserves explicit summary settings', () => {
  const body = {
    input: [],
    reasoning: { effort: 'medium', summary: 'concise' },
  };
  assert.equal(applyReasoningSummary(body, true), body);
});

test('policy does not invent reasoning or alter native Chat Completions', () => {
  const responsesWithoutReasoning = { model: 'gpt-test', input: [] };
  const chat = {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    reasoning_effort: 'high',
  };

  assert.equal(applyReasoningSummary(responsesWithoutReasoning, true), responsesWithoutReasoning);
  assert.equal(applyReasoningSummary(chat, true), chat);
});

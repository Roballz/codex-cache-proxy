function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function plainTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  let text = '';
  for (const part of content) {
    if (!isPlainObject(part)) return null;
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') {
      text += part.text;
      continue;
    }
    return null;
  }
  return text;
}

function unsupportedTopLevel(body) {
  const unsupported = [
    'tools',
    'tool_choice',
    'functions',
    'function_call',
    'response_format',
    'modalities',
    'audio',
    'web_search_options',
    'parallel_tool_calls',
  ];
  return unsupported.find(key => body[key] !== undefined && body[key] !== null);
}

export function canBridgeChatCompletions(body) {
  if (!isPlainObject(body) || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, reason: 'messages must be a non-empty array' };
  }

  const unsupported = unsupportedTopLevel(body);
  if (unsupported) return { ok: false, reason: `unsupported top-level field: ${unsupported}` };

  for (let index = 0; index < body.messages.length; index += 1) {
    const message = body.messages[index];
    if (!isPlainObject(message)) return { ok: false, reason: `messages[${index}] is not an object` };
    if (!['system', 'developer', 'assistant', 'user'].includes(message.role)) {
      return { ok: false, reason: `unsupported role: ${message.role}` };
    }
    if (message.name !== undefined || message.tool_calls !== undefined || message.tool_call_id !== undefined || message.function_call !== undefined) {
      return { ok: false, reason: `messages[${index}] uses tool/function metadata` };
    }
    if (plainTextContent(message.content) === null) {
      return { ok: false, reason: `messages[${index}] is not plain text` };
    }
  }

  return { ok: true, reason: null };
}

function convertMessage(message) {
  const text = plainTextContent(message.content);

  if (message.role === 'assistant') {
    return {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    };
  }

  if (message.role === 'system' || message.role === 'developer') {
    return { role: 'developer', content: text };
  }

  return { role: 'user', content: text };
}

export function chatCompletionsToResponsesShape(body) {
  const eligibility = canBridgeChatCompletions(body);
  if (!eligibility.ok) return { bridged: false, reason: eligibility.reason, body };

  const bridged = {
    model: body.model,
    input: body.messages.map(convertMessage),
    stream: body.stream !== false,
    store: false,
  };

  if (Number.isFinite(body.max_completion_tokens)) bridged.max_output_tokens = body.max_completion_tokens;
  else if (Number.isFinite(body.max_tokens)) bridged.max_output_tokens = body.max_tokens;

  if (Number.isFinite(body.temperature)) bridged.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) bridged.top_p = body.top_p;
  if (typeof body.service_tier === 'string') bridged.service_tier = body.service_tier;

  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim()) {
    bridged.reasoning = { effort: body.reasoning_effort.trim() };
  } else if (isPlainObject(body.reasoning)) {
    bridged.reasoning = structuredClone(body.reasoning);
  }

  return { bridged: true, reason: null, body: bridged };
}

import { AppError, validIdentity } from './config.js';

export const ID_HEADERS = [
  'session-id',
  'session_id',
  'x-session-id',
  'conversation-id',
  'conversation_id',
  'thread-id',
];

const ID_FIELDS = ['prompt_cache_key', 'session_id', 'conversation_id'];

function display(value) {
  return validIdentity(value) ? value : '[invalid or non-displayable]';
}

export function inspectIdentity(body, headers) {
  const entries = [];

  for (const key of ID_FIELDS) {
    if (Object.hasOwn(body, key)) {
      entries.push({ field: `body.${key}`, value: display(body[key]) });
    }
  }

  for (const key of ID_HEADERS) {
    if (headers[key] !== undefined) {
      entries.push({ field: `header.${key}`, value: display(headers[key]) });
    }
  }

  return entries;
}

export function activeSession(config) {
  return config.sessions.find(item => item.id === config.activeSessionId) ?? null;
}

export function applyIdentity(body, headers, config, upstream, path = '') {
  const inbound = inspectIdentity(body, headers);
  const session = activeSession(config);
  if (!session) {
    throw new AppError(400, 'missing_session', 'Selected session profile does not exist.');
  }

  if (path === '/v1/chat/completions' && session.chatMode === 'upstream') {
    return {
      body,
      headers,
      changed: false,
      diagnostics: {
        mode: 'upstream',
        source: 'client-or-upstream',
        profileName: session.name,
        inbound,
        outbound: inbound,
        overwritten: false,
        note: 'Chat Completions identity is passed through unchanged. The upstream may preserve client identity or derive its own compatibility cache key.',
      },
    };
  }

  const mode = session.identityMode;

  if (mode === 'passthrough') {
    return {
      body,
      headers,
      changed: false,
      diagnostics: {
        mode,
        source: 'client',
        profileName: session.name,
        inbound,
        outbound: inbound,
        overwritten: false,
      },
    };
  }

  const observedValues = [];
  for (const key of ID_FIELDS) {
    if (Object.hasOwn(body, key)) observedValues.push(body[key]);
  }
  for (const key of ID_HEADERS) {
    if (headers[key] !== undefined) observedValues.push(headers[key]);
  }

  const present = observedValues.filter(
    value => value !== '' && value !== null && value !== undefined,
  );

  let value = session.value;
  let source = 'profile';

  if (mode === 'fill' && present.length) {
    if (present.some(item => !validIdentity(item))) {
      throw new AppError(
        400,
        'invalid_identity',
        'Client identity is invalid. Use Lock mode or correct the client identity.',
      );
    }

    if (new Set(present).size !== 1) {
      throw new AppError(
        409,
        'identity_conflict',
        'Client session/cache identifiers disagree. Use Lock mode to choose one explicitly.',
      );
    }

    value = present[0];
    source = 'client';
  }

  if (!validIdentity(value)) {
    throw new AppError(
      400,
      'missing_identity',
      'Selected session profile has no valid ID. Request was not forwarded.',
    );
  }

  // Only touch continuity/cache identity fields. Never mutate prompt arrays,
  // previous_response_id, conversation, tool call IDs, or Responses item IDs.
  const nextBody = { ...body, prompt_cache_key: value };

  for (const key of ['session_id', 'conversation_id']) {
    if (Object.hasOwn(body, key)) nextBody[key] = value;
  }

  const nextHeaders = { ...headers };
  for (const key of ID_HEADERS) delete nextHeaders[key];

  const canonicalHeaders =
    upstream.adapter === 'sub2api'
      ? ['session_id', 'conversation_id']
      : ['session-id'];

  for (const key of canonicalHeaders) nextHeaders[key] = value;

  return {
    body: nextBody,
    headers: nextHeaders,
    changed: true,
    diagnostics: {
      mode,
      source,
      profileName: session.name,
      value,
      inbound,
      outbound: inspectIdentity(nextBody, nextHeaders),
      overwritten: present.some(item => item !== value),
    },
  };
}

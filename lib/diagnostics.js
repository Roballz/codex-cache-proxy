import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const digest = value => createHash('sha256').update(value).digest('hex');

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  const bytes = Buffer.from(canonical(value));
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    chunks.push({
      hash: digest(bytes.subarray(offset, offset + 1024)),
      bytes: Math.min(1024, bytes.length - offset),
    });
  }
  return { hash: digest(bytes), bytes: bytes.length, chunks };
}

export function promptSnapshot(body) {
  const field = Object.hasOwn(body, 'input') ? 'input' : 'messages';
  const input = body[field];
  const items = Array.isArray(input) ? input : [input ?? ''];
  const units = items.map((value, index) => ({
    path: `${field}[${index}]`,
    ...fingerprint(value),
  }));

  const meta = Object.fromEntries(
    Object.entries(body).filter(
      ([key]) => ![field, 'prompt_cache_key', 'session_id', 'conversation_id'].includes(key),
    ),
  );

  return {
    units,
    hash: digest(canonical(units.map(item => item.hash))),
    metaHash: digest(canonical(meta)),
  };
}

export function compareSnapshots(current, previous) {
  if (!previous) return { available: false };

  let equalMessages = 0;
  let prefixBytesLowerBound = 0;

  while (equalMessages < Math.min(current.units.length, previous.units.length)) {
    const now = current.units[equalMessages];
    const before = previous.units[equalMessages];
    if (now.hash !== before.hash) break;
    prefixBytesLowerBound += now.bytes;
    equalMessages += 1;
  }

  const now = current.units[equalMessages];
  const before = previous.units[equalMessages];
  let withinChangedMessage = 0;

  if (now && before) {
    for (let index = 0; index < Math.min(now.chunks.length, before.chunks.length); index += 1) {
      if (
        now.chunks[index].hash !== before.chunks[index].hash ||
        now.chunks[index].bytes !== before.chunks[index].bytes
      ) {
        break;
      }
      withinChangedMessage += now.chunks[index].bytes;
    }
  }

  return {
    available: true,
    sameInput: current.hash === previous.hash,
    parametersChanged: current.metaHash !== previous.metaHash,
    equalMessages,
    firstChangedMessage: current.hash === previous.hash ? null : equalMessages,
    prefixBytesLowerBound: prefixBytesLowerBound + withinChangedMessage,
    withinChangedMessage,
  };
}

export class DiagnosticsStore {
  constructor() {
    this.records = [];
    this.snapshots = new Map();
    this.credentialSalt = randomBytes(32);
  }

  begin(body, context, limit) {
    const credentialPartition = createHmac('sha256', this.credentialSalt)
      .update(context.authorization || '')
      .digest('hex');

    const scope = canonical([
      context.upstream.id,
      context.upstream.baseUrl,
      context.upstream.adapter,
      body.model,
      context.session,
      context.mode,
      context.path,
      credentialPartition,
    ]);

    const current = promptSnapshot(body);
    const previous = this.snapshots.get(scope);

    const record = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      state: 'running',
      upstream: context.upstream.name,
      adapter: context.upstream.adapter,
      model:
        typeof body.model === 'string' && /^[\w./:-]{1,160}$/.test(body.model)
          ? body.model
          : '[model]',
      path: context.path,
      identity: context.identity,
      inputHash: current.hash,
      parameterHash: current.metaHash,
      comparison: {
        ...compareSnapshots(current, previous?.snapshot),
        previousRequestId: previous?.id ?? null,
      },
      messages: current.units.slice(0, 80).map((unit, index) => ({
        path: unit.path,
        hash: unit.hash,
        bytes: unit.bytes,
        sameAsPrevious: previous ? previous.snapshot.units[index]?.hash === unit.hash : null,
      })),
      messageCount: current.units.length,
      omittedMessages: Math.max(0, current.units.length - 80),
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
        hitRate: null,
      },
      note: null,
    };

    this.snapshots.delete(scope);
    this.snapshots.set(scope, { id: record.id, snapshot: current });
    while (this.snapshots.size > 16) {
      this.snapshots.delete(this.snapshots.keys().next().value);
    }

    this.records.unshift(record);
    this.records.length = Math.min(this.records.length, limit);
    return record;
  }

  finish(record, patch = {}) {
    Object.assign(record, patch, {
      finishedAt: new Date().toISOString(),
    });
  }

  list(limit = 80) {
    return structuredClone(this.records.slice(0, limit));
  }

  clear() {
    this.records = [];
    this.snapshots.clear();
  }
}

function token(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function extractUsage(json) {
  const usage = json?.response?.usage ?? json?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = token(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = token(usage.output_tokens ?? usage.completion_tokens);
  const cachedTokens = token(
    usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
  );
  const reasoningTokens = token(
    usage.output_tokens_details?.reasoning_tokens ??
      usage.completion_tokens_details?.reasoning_tokens,
  );

  const valid = inputTokens !== null && cachedTokens !== null && cachedTokens <= inputTokens;

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    hitRate:
      valid && inputTokens > 0
        ? Math.round((cachedTokens / inputTokens) * 10000) / 100
        : null,
    inconsistent:
      cachedTokens !== null && inputTokens !== null && cachedTokens > inputTokens,
  };
}

function chatStreamFinished(json) {
  return (
    Array.isArray(json?.choices) &&
    json.choices.some(choice => choice && choice.finish_reason !== null && choice.finish_reason !== undefined)
  );
}

export class UsageObserver {
  constructor(isSse, limit = 4 * 1024 * 1024) {
    this.isSse = isSse;
    this.limit = limit;
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.parts = [];
    this.eventSize = 0;
    this.dropEvent = false;
    this.dropLine = false;
    this.skipped = 0;
    this.terminal = null;
    this.usage = null;
  }

  parse(text) {
    if (text.trim() === '[DONE]') {
      this.terminal ??= 'completed';
      return;
    }

    try {
      const json = JSON.parse(text);
      const usage = extractUsage(json);
      if (usage) {
        const next = { ...(this.usage || {}) };
        for (const [key, value] of Object.entries(usage)) {
          if (value !== null) next[key] = value;
        }
        if (
          Number.isSafeInteger(next.inputTokens) &&
          Number.isSafeInteger(next.cachedTokens)
        ) {
          next.inconsistent = next.cachedTokens > next.inputTokens;
          next.hitRate =
            next.inputTokens > 0 && !next.inconsistent
              ? Math.round((next.cachedTokens / next.inputTokens) * 10000) / 100
              : null;
        }
        this.usage = next;
      }

      if (json.error || json.type === 'error' || json.type === 'response.failed' || json.status === 'failed') {
        this.terminal = 'upstream_error';
      } else if (json.type === 'response.incomplete' || json.status === 'incomplete') {
        this.terminal = 'incomplete';
      } else if (
        json.type === 'response.completed' ||
        json.status === 'completed' ||
        chatStreamFinished(json) ||
        (!this.isSse && Array.isArray(json.choices))
      ) {
        this.terminal ??= 'completed';
      }
    } catch {
      this.skipped += 1;
    }
  }

  processLine(text) {
    if (text.endsWith('\r')) text = text.slice(0, -1);

    if (text === '') {
      if (!this.dropEvent && this.parts.length) this.parse(this.parts.join('\n'));
      this.parts = [];
      this.eventSize = 0;
      this.dropEvent = false;
      return;
    }

    if (!text.startsWith('data:') || this.dropEvent) return;

    const data = text.slice(5).replace(/^ /, '');
    this.eventSize += data.length;
    if (this.eventSize > this.limit) {
      this.parts = [];
      this.dropEvent = true;
      this.skipped += 1;
    } else {
      this.parts.push(data);
    }
  }

  writeText(text) {
    if (!this.isSse) {
      if (!this.dropEvent && this.pending.length + text.length <= this.limit) {
        this.pending += text;
      } else {
        this.pending = '';
        this.dropEvent = true;
      }
      return;
    }

    this.pending += text;
    let index;
    while ((index = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      if (this.dropLine || line.length > this.limit) {
        this.dropLine = false;
        this.dropEvent = true;
        this.skipped += 1;
      } else {
        this.processLine(line);
      }
    }

    if (this.pending.length > this.limit) {
      this.pending = '';
      this.dropLine = true;
      this.dropEvent = true;
    }
  }

  feed(chunk) {
    this.writeText(this.decoder.write(chunk));
  }

  end() {
    this.writeText(this.decoder.end());
    if (this.isSse) {
      if (!this.dropLine && this.pending) this.processLine(this.pending);
      this.processLine('');
    } else if (!this.dropEvent && this.pending) {
      this.parse(this.pending);
    } else if (this.dropEvent) {
      this.skipped += 1;
    }
    this.pending = '';
    this.parts = [];
  }
}

import { AppError } from './config.js';
import { applyIdentity } from './identity.js';
import { DiagnosticsStore, UsageObserver } from './diagnostics.js';
import { copyResponseHeaders, forwardRequestHeaders } from './http.js';

const SUPPORTED_POST_PATHS = new Set(['/v1/responses', '/v1/chat/completions']);
const SUPPORTED_GET_PATHS = new Set(['/v1/models']);

function selectedUpstream(config) {
  const upstream = config.upstreams.find(item => item.id === config.activeUpstreamId);
  if (!upstream) {
    throw new AppError(503, 'no_upstream', 'No active upstream is configured.');
  }
  return upstream;
}

function upstreamUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}${path.replace(/^\/v1/, '')}`;
}

function visibleIdentityScope(identity) {
  if (identity?.value) return identity.value;
  const promptKey = identity?.outbound?.find(item => item.field === 'body.prompt_cache_key');
  if (promptKey?.value) return promptKey.value;
  return identity?.mode === 'passthrough' ? 'passthrough' : 'unknown';
}

function finishRecord(diagnostics, record, observer, state, note = null) {
  diagnostics.finish(record, {
    state,
    note,
    usage: observer?.usage ?? record.usage,
    observerSkippedEvents: observer?.skipped ?? 0,
    terminalEvent: observer?.terminal ?? null,
  });
}

export function createProxy({ configStore, diagnostics = new DiagnosticsStore() }) {
  async function proxyModels(request, response, path) {
    const config = configStore.snapshot();
    const upstream = selectedUpstream(config);
    const headers = forwardRequestHeaders(request.headers);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('timeout')),
      config.timeoutSeconds * 1000,
    );

    const abort = () => controller.abort(new Error('client disconnected'));
    request.once('aborted', abort);
    response.once('close', () => {
      if (!response.writableEnded) abort();
    });

    try {
      const upstreamResponse = await fetch(upstreamUrl(upstream.baseUrl, path), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });

      response.statusCode = upstreamResponse.status;
      copyResponseHeaders(upstreamResponse.headers, response);
      response.setHeader('x-codex-cache-proxy-upstream', upstream.id);

      if (!upstreamResponse.body) {
        response.end();
        return;
      }

      const reader = upstreamResponse.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!response.write(Buffer.from(value))) {
          await new Promise(resolve => response.once('drain', resolve));
        }
      }
      response.end();
    } catch (error) {
      if (controller.signal.aborted) {
        if (!response.headersSent) {
          throw new AppError(
            504,
            'upstream_aborted',
            'Upstream request was aborted or timed out.',
          );
        }
        response.destroy();
        return;
      }
      throw new AppError(502, 'upstream_error', `Upstream request failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function proxyGeneration(request, response, path, body) {
    const config = configStore.snapshot();
    const upstream = selectedUpstream(config);
    const inboundHeaders = forwardRequestHeaders(request.headers);
    const identityResult = applyIdentity(body, inboundHeaders, config, upstream, path);
    const authorization = inboundHeaders.authorization || '';

    const record = diagnostics.begin(
      identityResult.body,
      {
        upstream,
        session: visibleIdentityScope(identityResult.diagnostics),
        mode: identityResult.diagnostics.mode,
        identity: identityResult.diagnostics,
        authorization,
        path,
      },
      config.diagnosticLimit,
    );

    const controller = new AbortController();
    let timedOut = false;
    let clientDisconnected = false;
    let observer = null;
    let downstreamClosedAfterTerminal = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, config.timeoutSeconds * 1000);

    const abortForClient = () => {
      clientDisconnected = true;
      if (observer?.terminal === 'completed') {
        downstreamClosedAfterTerminal = true;
        return;
      }
      controller.abort(new Error('client disconnected'));
    };
    request.once('aborted', abortForClient);
    response.once('close', () => {
      if (!response.writableEnded) abortForClient();
    });

    try {
      const headers = { ...identityResult.headers, 'content-type': 'application/json' };
      delete headers['content-length'];

      const upstreamResponse = await fetch(upstreamUrl(upstream.baseUrl, path), {
        method: 'POST',
        headers,
        body: JSON.stringify(identityResult.body),
        redirect: 'manual',
        signal: controller.signal,
      });

      const contentType = upstreamResponse.headers.get('content-type') || '';
      const isSse = contentType.toLowerCase().includes('text/event-stream');
      observer = new UsageObserver(isSse);

      response.statusCode = upstreamResponse.status;
      copyResponseHeaders(upstreamResponse.headers, response);
      response.setHeader('x-codex-cache-proxy-upstream', upstream.id);
      response.setHeader('x-codex-cache-proxy-identity-mode', identityResult.diagnostics.mode);

      if (!upstreamResponse.body) {
        observer.end();
        finishRecord(
          diagnostics,
          record,
          observer,
          upstreamResponse.ok ? 'completed' : 'upstream_error',
          'Upstream returned no response body.',
        );
        response.end();
        return;
      }

      const reader = upstreamResponse.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        observer.feed(chunk);

        if (downstreamClosedAfterTerminal || response.destroyed || response.writableEnded) {
          continue;
        }

        if (!response.write(chunk)) {
          await new Promise(resolve => {
            const onDrain = () => {
              cleanup();
              resolve();
            };
            const onClose = () => {
              cleanup();
              downstreamClosedAfterTerminal = observer?.terminal === 'completed';
              resolve();
            };
            const cleanup = () => {
              response.off('drain', onDrain);
              response.off('close', onClose);
            };
            response.once('drain', onDrain);
            response.once('close', onClose);
          });
        }
      }

      observer.end();
      const terminalState =
        observer.terminal === 'upstream_error' || !upstreamResponse.ok
          ? 'upstream_error'
          : observer.terminal === 'incomplete'
            ? 'incomplete'
            : 'completed';

      finishRecord(
        diagnostics,
        record,
        observer,
        terminalState,
        observer.usage
          ? downstreamClosedAfterTerminal
            ? 'Client closed after the normal terminal event; upstream tail was drained for diagnostics.'
            : null
          : 'Upstream did not expose cache usage statistics in an observable response event.',
      );

      if (!response.destroyed && !response.writableEnded) response.end();
    } catch (error) {
      if (controller.signal.aborted) {
        const state = timedOut
          ? 'timeout'
          : clientDisconnected
            ? 'client_aborted'
            : 'aborted';
        finishRecord(
          diagnostics,
          record,
          observer,
          state,
          timedOut ? 'Upstream timeout.' : 'Request aborted before a normal terminal event.',
        );
        if (!response.headersSent) {
          throw new AppError(
            timedOut ? 504 : 499,
            state,
            timedOut ? 'Upstream request timed out.' : 'Client disconnected.',
          );
        }
        response.destroy();
        return;
      }

      finishRecord(diagnostics, record, observer, 'proxy_error', error.message);
      throw new AppError(502, 'upstream_error', `Upstream request failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function handle(request, response, path, body = null) {
    if (request.method === 'GET' && SUPPORTED_GET_PATHS.has(path)) {
      await proxyModels(request, response, path);
      return true;
    }
    if (request.method === 'POST' && SUPPORTED_POST_PATHS.has(path)) {
      await proxyGeneration(request, response, path, body);
      return true;
    }
    return false;
  }

  return { handle, diagnostics };
}

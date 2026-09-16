const $ = selector => document.querySelector(selector);
const clone = id => document.getElementById(id).content.firstElementChild.cloneNode(true);

let config = null;

function uuid() {
  return crypto.randomUUID();
}

function setStatus(text, tone = '') {
  const node = $('#status');
  node.textContent = text;
  node.className = `status ${tone}`.trim();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    cache: 'no-store',
  });

  let body = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }

  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function upstreamNode(item) {
  const node = clone('upstream-template');
  node.dataset.id = item.id;
  node.querySelector('.name').value = item.name;
  node.querySelector('.adapter').value = item.adapter;
  node.querySelector('.base-url').value = item.baseUrl;
  const radio = node.querySelector('input[type="radio"]');
  radio.checked = item.id === config.activeUpstreamId;
  radio.addEventListener('change', () => {
    config.activeUpstreamId = item.id;
  });
  node.querySelector('.remove').addEventListener('click', () => {
    if (config.upstreams.length === 1) {
      config.activeUpstreamId = null;
    } else if (config.activeUpstreamId === item.id) {
      config.activeUpstreamId = config.upstreams.find(value => value.id !== item.id)?.id ?? null;
    }
    config.upstreams = config.upstreams.filter(value => value.id !== item.id);
    render();
  });
  return node;
}

function updateSessionModeVisibility(node) {
  const interfaceMode = node.querySelector('.interface-mode').value;
  node.querySelector('.chat-mode-wrap').hidden = interfaceMode !== 'chat_completions';
}

function sessionNode(item) {
  const node = clone('session-template');
  node.dataset.id = item.id;
  node.querySelector('.name').value = item.name;
  node.querySelector('.value').value = item.value;
  node.querySelector('.interface-mode').value = item.interfaceMode ?? 'chat_completions';
  node.querySelector('.identity-mode').value = item.identityMode ?? 'lock';
  node.querySelector('.chat-mode').value = ['upstream', 'bridge'].includes(item.chatMode)
    ? item.chatMode
    : 'upstream';
  updateSessionModeVisibility(node);

  const radio = node.querySelector('input[type="radio"]');
  radio.checked = item.id === config.activeSessionId;
  radio.addEventListener('change', () => {
    config.activeSessionId = item.id;
  });

  node.querySelector('.interface-mode').addEventListener('change', () => {
    updateSessionModeVisibility(node);
  });

  node.querySelector('.regen').addEventListener('click', () => {
    if (!confirm('重新生成后，当前会话将使用全新的固定 Session ID。继续吗？')) return;
    item.value = uuid();
    node.querySelector('.value').value = item.value;
  });

  node.querySelector('.remove').addEventListener('click', () => {
    if (config.sessions.length <= 1) {
      alert('至少保留一个会话档案。');
      return;
    }
    config.sessions = config.sessions.filter(value => value.id !== item.id);
    if (config.activeSessionId === item.id) config.activeSessionId = config.sessions[0].id;
    render();
  });
  return node;
}

function collectEditorValues() {
  const upstreamNodes = [...document.querySelectorAll('.upstream-item')];
  config.upstreams = upstreamNodes.map(node => ({
    id: node.dataset.id,
    name: node.querySelector('.name').value.trim(),
    adapter: node.querySelector('.adapter').value,
    baseUrl: node.querySelector('.base-url').value.trim(),
  }));

  const sessionNodes = [...document.querySelectorAll('.session-item')];
  config.sessions = sessionNodes.map(node => ({
    id: node.dataset.id,
    name: node.querySelector('.name').value.trim(),
    value: node.querySelector('.value').value.trim(),
    interfaceMode: node.querySelector('.interface-mode').value,
    identityMode: node.querySelector('.identity-mode').value,
    chatMode: node.querySelector('.chat-mode').value,
  }));

  config.diagnosticLimit = Number($('#diagnostic-limit').value);
  config.timeoutSeconds = Number($('#timeout-seconds').value);
  config.allowedOrigins = $('#allowed-origins').value
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean);
}

function render() {
  $('#diagnostic-limit').value = config.diagnosticLimit;
  $('#timeout-seconds').value = config.timeoutSeconds;
  $('#allowed-origins').value = config.allowedOrigins.join('\n');

  const upstreamList = $('#upstream-list');
  upstreamList.innerHTML = '';
  if (!config.upstreams.length) {
    upstreamList.innerHTML = '<p class="muted">还没有上游。添加一个 Sub2API、CLIProxyAPI 或 Generic 上游后才能转发请求。</p>';
  } else {
    for (const item of config.upstreams) upstreamList.append(upstreamNode(item));
  }

  const sessionList = $('#session-list');
  sessionList.innerHTML = '';
  for (const item of config.sessions) sessionList.append(sessionNode(item));
}

function formatTime(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function identitySummary(identity) {
  const inbound = Array.isArray(identity.inbound) ? identity.inbound : [];
  const clientHadIdentity = inbound.length > 0;

  let operation;
  if (identity.mode === 'upstream') operation = '原样交给上游';
  else if (identity.mode === 'passthrough') operation = '原样透传';
  else if (identity.mode === 'fill' && identity.source === 'client') operation = '沿用客户端身份';
  else if (identity.mode === 'fill') operation = '补充并锁定';
  else if (identity.mode === 'lock' && clientHadIdentity && identity.overwritten) operation = '覆盖并锁定';
  else if (identity.mode === 'lock' && clientHadIdentity) operation = '确认并锁定';
  else if (identity.mode === 'lock') operation = '新增并锁定';
  else operation = '未知';

  return {
    clientHadIdentity,
    operation,
    overwritten: Boolean(identity.overwritten),
  };
}

function diagNode(record) {
  const article = document.createElement('article');
  article.className = 'item diag';
  article.dataset.recordId = record.id;

  const cached = record.usage?.cachedTokens;
  const input = record.usage?.inputTokens;
  const reasoningTokens = record.usage?.reasoningTokens;
  const hitRate = record.usage?.hitRate;
  const comparison = record.comparison || {};
  const identity = record.identity || {};
  const bridge = identity.bridge || {};
  const identityInfo = identitySummary(identity);
  const identityLabel = identity.mode === 'upstream' ? '上游自动管理' : identity.mode || '';
  const identityValue = identity.mode === 'upstream'
    ? '由上游派生'
    : identity.value || identity.source || '透传/未知';
  const bridgeLabel = bridge.active
    ? 'Responses Bridge 已启用'
    : bridge.fallback
      ? `已回退原生 CC${bridge.reason ? ` · ${bridge.reason}` : ''}`
      : '未启用';

  article.innerHTML = `
    <div class="item-head">
      <strong>${escapeHtml(record.model || '[model]')}</strong>
      <span class="muted">${escapeHtml(record.state || 'unknown')}</span>
    </div>
    <div class="diag-grid">
      <div><span class="muted">时间</span><br>${escapeHtml(formatTime(record.startedAt))}</div>
      <div><span class="muted">上游</span><br>${escapeHtml(record.upstream || '')} (${escapeHtml(record.adapter || '')})</div>
      <div><span class="muted">路径</span><br><code>${escapeHtml(record.path || '')}</code></div>
      <div><span class="muted">CC Bridge</span><br>${escapeHtml(bridgeLabel)}</div>
      <div><span class="muted">身份模式</span><br>${escapeHtml(identityLabel)}${identity.profileName ? ` · ${escapeHtml(identity.profileName)}` : ''}</div>
      <div><span class="muted">身份值</span><br><code>${escapeHtml(identityValue)}</code></div>
      <div><span class="muted">客户端原有身份</span><br>${identityInfo.clientHadIdentity ? '有' : '无'}</div>
      <div><span class="muted">网关身份操作</span><br>${escapeHtml(identityInfo.operation)}</div>
      <div><span class="muted">是否覆盖客户端已有身份</span><br>${identityInfo.overwritten ? '是' : '否'}</div>
      <div><span class="muted">输入 tokens</span><br>${input ?? '未返回'}</div>
      <div><span class="muted">缓存 tokens</span><br>${cached ?? '未返回'}${hitRate !== null && hitRate !== undefined ? ` · ${hitRate}%` : ''}</div>
      <div><span class="muted">推理 tokens（模型内部推理）</span><br>${reasoningTokens ?? '未返回'}</div>
      <div><span class="muted">前序相同消息</span><br>${comparison.available ? comparison.equalMessages : '首次请求'}</div>
      <div><span class="muted">第一个变化消息</span><br>${comparison.available ? (comparison.firstChangedMessage ?? '无变化') : '—'}</div>
      <div><span class="muted">稳定前缀字节下限</span><br>${comparison.available ? comparison.prefixBytesLowerBound : '—'}</div>
      <div><span class="muted">其他参数是否变化</span><br>${comparison.available ? (comparison.parametersChanged ? '是' : '否') : '—'}</div>
    </div>
    ${record.note ? `<div class="muted">${escapeHtml(record.note)}</div>` : ''}
    <details>
      <summary>身份字段与消息哈希</summary>
      <pre>${escapeHtml(JSON.stringify({ identity, messages: record.messages, omittedMessages: record.omittedMessages }, null, 2))}</pre>
    </details>
  `;

  return article;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function captureDiagnosticUiState(container) {
  const state = new Map();
  for (const article of container.querySelectorAll('article.diag[data-record-id]')) {
    const details = article.querySelector('details');
    const pre = article.querySelector('pre');
    state.set(article.dataset.recordId, {
      open: Boolean(details?.open),
      preScrollTop: pre?.scrollTop ?? 0,
      preScrollLeft: pre?.scrollLeft ?? 0,
    });
  }
  return state;
}

function restoreDiagnosticUiState(node, state) {
  if (!state) return;
  const details = node.querySelector('details');
  const pre = node.querySelector('pre');
  if (details) details.open = state.open;
  if (pre) {
    pre.scrollTop = state.preScrollTop;
    pre.scrollLeft = state.preScrollLeft;
  }
}

async function loadDiagnostics() {
  try {
    const result = await api('/api/diagnostics');
    const container = $('#diagnostics');
    const uiState = captureDiagnosticUiState(container);
    container.innerHTML = '';
    if (!result.records.length) {
      container.innerHTML = '<p class="muted">还没有生成请求经过网关。</p>';
      return;
    }
    for (const record of result.records) {
      const node = diagNode(record);
      container.append(node);
      restoreDiagnosticUiState(node, uiState.get(record.id));
    }
  } catch (error) {
    console.error(error);
  }
}

async function load() {
  setStatus('载入中…');
  try {
    config = await api('/api/config');
    render();
    await loadDiagnostics();
    setStatus('已连接', 'good');
  } catch (error) {
    console.error(error);
    setStatus(`错误：${error.message}`, 'warn');
  }
}

$('#add-upstream').addEventListener('click', () => {
  const id = uuid();
  config.upstreams.push({
    id,
    name: 'Sub2API',
    baseUrl: 'http://127.0.0.1:3000/v1',
    adapter: 'sub2api',
  });
  if (!config.activeUpstreamId) config.activeUpstreamId = id;
  render();
});

$('#add-session').addEventListener('click', () => {
  const id = uuid();
  const current = config.sessions.find(item => item.id === config.activeSessionId);
  config.sessions.push({
    id,
    name: `RP ${config.sessions.length + 1}`,
    value: uuid(),
    interfaceMode: current?.interfaceMode ?? 'chat_completions',
    identityMode: current?.identityMode ?? 'lock',
    chatMode: current?.chatMode ?? 'upstream',
  });
  config.activeSessionId = id;
  render();
});

$('#save').addEventListener('click', async () => {
  try {
    collectEditorValues();
    setStatus('保存中…');
    config = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
    render();
    setStatus('已保存', 'good');
  } catch (error) {
    console.error(error);
    setStatus(`保存失败：${error.message}`, 'warn');
    alert(error.message);
  }
});

$('#reload').addEventListener('click', () => load());

$('#refresh-diagnostics').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await loadDiagnostics();
  } finally {
    button.disabled = false;
  }
});

$('#clear-diagnostics').addEventListener('click', async () => {
  if (!confirm('清空当前进程内的诊断记录？不会影响配置。')) return;
  try {
    await api('/api/diagnostics', { method: 'DELETE' });
    await loadDiagnostics();
  } catch (error) {
    alert(error.message);
  }
});

load();

/**
 * Web UI channel adapter.
 *
 * Serves a local chat interface at http://localhost:<WEB_UI_PORT> (default 3200).
 * Uses SSE for server→client delivery and POST for client→server messages.
 * No extra dependencies — built on Node's built-in http module.
 *
 * Activation: set WEB_UI_SECRET in .env. Without it the adapter is skipped.
 * Open http://localhost:3200 in a browser to chat.
 *
 * Wire format:
 *   GET  /          — chat UI HTML (secret embedded for auto-auth)
 *   GET  /stream    — SSE stream (auth: ?secret= query param)
 *   POST /message   — send message (auth: Authorization: Bearer <secret>)
 *   GET  /health    — liveness check (no auth)
 */
import crypto from 'crypto';
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const PLATFORM_ID = 'local';
const DEFAULT_PORT = 3200;

function createAdapter(): ChannelAdapter | null {
  const envConfig = readEnvFile(['WEB_UI_SECRET', 'WEB_UI_PORT']);
  const secret = process.env.WEB_UI_SECRET || envConfig.WEB_UI_SECRET;
  if (!secret) return null;

  const port = parseInt(process.env.WEB_UI_PORT || envConfig.WEB_UI_PORT || String(DEFAULT_PORT), 10);

  // Active SSE client connections
  const sseClients = new Map<string, http.ServerResponse>();

  let server: http.Server | null = null;
  let channelSetup: ChannelSetup | null = null;

  function checkBearerAuth(req: http.IncomingMessage): boolean {
    const auth = req.headers['authorization'];
    return typeof auth === 'string' && auth.startsWith('Bearer ') && auth.slice(7) === secret;
  }

  function checkQueryAuth(req: http.IncomingMessage): boolean {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    return url.searchParams.get('secret') === secret;
  }

  function broadcast(data: object): void {
    const line = `data: ${JSON.stringify(data)}\n\n`;
    for (const [clientId, res] of sseClients) {
      try {
        res.write(line);
      } catch {
        sseClients.delete(clientId);
      }
    }
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const { pathname } = url;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    // Liveness — no auth
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Chat UI — no auth (secret is embedded in the served HTML for local use)
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildChatHtml(secret, port));
      return;
    }

    // SSE stream — auth via ?secret= query param (browser EventSource can't set headers)
    if (pathname === '/stream' && req.method === 'GET') {
      if (!checkQueryAuth(req)) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
      const clientId = crypto.randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders(),
      });
      // Opening comment so the browser confirms the stream is live
      res.write(': connected\n\n');
      sseClients.set(clientId, res);
      log.info('Web UI client connected', { clientId, total: sseClients.size });

      req.on('close', () => {
        sseClients.delete(clientId);
        log.info('Web UI client disconnected', { clientId, total: sseClients.size });
      });
      return;
    }

    // Send message — auth via Authorization: Bearer header
    if (pathname === '/message' && req.method === 'POST') {
      if (!checkBearerAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        let text: string;
        try {
          const parsed = JSON.parse(body) as unknown;
          if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).text !== 'string') {
            throw new Error('missing text');
          }
          text = ((parsed as Record<string, unknown>).text as string).trim();
          if (!text) throw new Error('empty text');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
          res.end(JSON.stringify({ error: 'Bad Request: body must be {"text":"..."}' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ ok: true }));

        channelSetup
          ?.onInbound(PLATFORM_ID, null, {
            id: `web-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            content: { text, sender: 'user', senderId: `web-ui:${PLATFORM_ID}` },
          })
          ?.catch?.((err: unknown) => {
            log.error('Web UI: onInbound threw', { err });
          });
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  const adapter: ChannelAdapter = {
    name: 'web-ui',
    channelType: 'web-ui',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      channelSetup = config;
      server = http.createServer(handleRequest);

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        // Bind to loopback only — not accessible from the network
        server!.listen(port, '127.0.0.1', () => {
          log.info('Web UI listening', { url: `http://localhost:${port}` });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      for (const res of sseClients.values()) {
        try {
          res.end();
        } catch {
          // swallow — teardown is best-effort
        }
      }
      sseClients.clear();
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(_platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const text = extractText(message);
      if (text === null) return undefined;
      broadcast({ type: 'message', role: 'assistant', text });
      return undefined;
    },

    async setTyping(_platformId: string): Promise<void> {
      broadcast({ type: 'typing' });
    },
  };

  return adapter;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function buildChatHtml(secret: string, port: number): string {
  // Secret is embedded so the browser connects automatically without a login step.
  // The server only binds to 127.0.0.1 so this is only reachable from the local machine.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NanoClaw</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@14/marked.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0f1117;
      --surface: #1a1d27;
      --surface2: #22263a;
      --border: #2e3250;
      --text: #e2e6f0;
      --text-muted: #8890b0;
      --accent: #6c8ef5;
      --accent-dim: #3a4a8a;
      --user-bg: #1e3a5f;
      --assistant-bg: #1a1d27;
      --radius: 12px;
      --input-height: 52px;
    }

    html, body { height: 100%; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 15px;
      line-height: 1.6;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
    }

    /* ── Header ── */
    header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 20px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      flex-shrink: 0;
    }
    header .dot {
      width: 9px; height: 9px;
      border-radius: 50%;
      background: #3db87a;
      box-shadow: 0 0 6px #3db87a88;
    }
    header .dot.offline { background: #666; box-shadow: none; }
    header h1 { font-size: 16px; font-weight: 600; letter-spacing: .3px; }
    header .status { font-size: 12px; color: var(--text-muted); margin-left: auto; }

    /* ── Messages ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      scroll-behavior: smooth;
    }

    .msg {
      display: flex;
      flex-direction: column;
      max-width: 78%;
      gap: 4px;
    }
    .msg.user { align-self: flex-end; align-items: flex-end; }
    .msg.assistant { align-self: flex-start; align-items: flex-start; }

    .bubble {
      padding: 10px 14px;
      border-radius: var(--radius);
      line-height: 1.55;
      word-break: break-word;
    }
    .msg.user .bubble {
      background: var(--user-bg);
      border-bottom-right-radius: 4px;
      color: #cce0ff;
    }
    .msg.assistant .bubble {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-bottom-left-radius: 4px;
    }

    /* Markdown inside assistant bubbles */
    .bubble p { margin-bottom: .5em; }
    .bubble p:last-child { margin-bottom: 0; }
    .bubble code {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 13px;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 5px;
    }
    .bubble pre {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      overflow-x: auto;
      margin: .5em 0;
    }
    .bubble pre code { background: none; border: none; padding: 0; font-size: 13px; }
    .bubble ul, .bubble ol { padding-left: 1.4em; margin: .4em 0; }
    .bubble li { margin: .15em 0; }
    .bubble strong { color: #d0dcff; }
    .bubble a { color: var(--accent); }
    .bubble blockquote {
      border-left: 3px solid var(--accent-dim);
      padding-left: 10px;
      color: var(--text-muted);
      margin: .4em 0;
    }
    .bubble h1, .bubble h2, .bubble h3 {
      font-size: 1em;
      font-weight: 600;
      margin: .6em 0 .2em;
      color: #d0d8ff;
    }

    .ts {
      font-size: 11px;
      color: var(--text-muted);
      padding: 0 4px;
    }

    /* ── Typing indicator ── */
    #typing {
      display: none;
      align-self: flex-start;
      align-items: center;
      gap: 5px;
      padding: 10px 14px;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      border-bottom-left-radius: 4px;
    }
    #typing.visible { display: flex; }
    #typing span {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--text-muted);
      animation: bounce 1.2s infinite;
    }
    #typing span:nth-child(2) { animation-delay: .2s; }
    #typing span:nth-child(3) { animation-delay: .4s; }
    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: .5; }
      30% { transform: translateY(-5px); opacity: 1; }
    }

    /* ── Input bar ── */
    #input-bar {
      display: flex;
      align-items: flex-end;
      gap: 10px;
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      background: var(--surface);
      flex-shrink: 0;
    }

    #input {
      flex: 1;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 14px;
      color: var(--text);
      font-size: 15px;
      font-family: inherit;
      resize: none;
      min-height: 44px;
      max-height: 180px;
      outline: none;
      transition: border-color .15s;
      overflow-y: auto;
      line-height: 1.5;
    }
    #input:focus { border-color: var(--accent-dim); }
    #input::placeholder { color: var(--text-muted); }

    #send-btn {
      width: 44px; height: 44px;
      border-radius: 10px;
      border: none;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background .15s, opacity .15s;
      flex-shrink: 0;
    }
    #send-btn:hover { background: #7fa0ff; }
    #send-btn:disabled { opacity: .4; cursor: not-allowed; }
    #send-btn svg { width: 18px; height: 18px; }

    /* ── Empty state ── */
    #empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: var(--text-muted);
      pointer-events: none;
      font-size: 14px;
    }
    #empty svg { width: 36px; height: 36px; opacity: .4; }
    #empty.hidden { display: none; }

    /* scrollbar */
    #messages::-webkit-scrollbar { width: 5px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>
  <header>
    <div class="dot offline" id="status-dot"></div>
    <h1>NanoClaw</h1>
    <span class="status" id="status-text">Connecting…</span>
  </header>

  <div id="messages" style="position:relative;">
    <div id="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round"
          d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
      </svg>
      Send a message to get started
    </div>
    <div id="typing"><span></span><span></span><span></span></div>
  </div>

  <div id="input-bar">
    <textarea id="input" rows="1" placeholder="Message…" disabled></textarea>
    <button id="send-btn" disabled>
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M3.478 2.404a.75.75 0 00-.926.941l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.404z" />
      </svg>
    </button>
  </div>

  <script>
    const SECRET = ${JSON.stringify(secret)};
    const PORT   = ${port};

    const $messages  = document.getElementById('messages');
    const $typing    = document.getElementById('typing');
    const $empty     = document.getElementById('empty');
    const $input     = document.getElementById('input');
    const $sendBtn   = document.getElementById('send-btn');
    const $dot       = document.getElementById('status-dot');
    const $statusTxt = document.getElementById('status-text');

    let connected = false;

    // ── Markdown renderer ──
    function renderContent(text, isAssistant) {
      if (!isAssistant) return escHtml(text).replace(/\\n/g, '<br>');
      if (window.marked) {
        try {
          return marked.parse(text, { breaks: true, gfm: true });
        } catch (_) { /* fall through */ }
      }
      return escHtml(text).replace(/\\n/g, '<br>');
    }

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ── Message rendering ──
    function appendMessage(role, text) {
      $empty.classList.add('hidden');
      $typing.classList.remove('visible');

      const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const div = document.createElement('div');
      div.className = 'msg ' + role;

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = renderContent(text, role === 'assistant');

      const stamp = document.createElement('div');
      stamp.className = 'ts';
      stamp.textContent = ts;

      div.appendChild(bubble);
      div.appendChild(stamp);

      // Insert before typing indicator so typing stays at bottom
      $messages.insertBefore(div, $typing);
      scrollToBottom();
    }

    function scrollToBottom() {
      $messages.scrollTop = $messages.scrollHeight;
    }

    // ── Auto-resize textarea ──
    $input.addEventListener('input', () => {
      $input.style.height = 'auto';
      $input.style.height = Math.min($input.scrollHeight, 180) + 'px';
    });

    // ── Send ──
    function sendMessage() {
      const text = $input.value.trim();
      if (!text || !connected) return;

      appendMessage('user', text);
      $input.value = '';
      $input.style.height = 'auto';

      fetch('/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + SECRET,
        },
        body: JSON.stringify({ text }),
      }).catch((err) => {
        appendMessage('assistant', '_Failed to send: ' + err.message + '_');
      });
    }

    $sendBtn.addEventListener('click', sendMessage);
    $input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // ── SSE connection ──
    function setConnected(ok) {
      connected = ok;
      $dot.className = 'dot' + (ok ? '' : ' offline');
      $statusTxt.textContent = ok ? 'Connected' : 'Reconnecting…';
      $input.disabled = !ok;
      $sendBtn.disabled = !ok;
      if (ok) $input.focus();
    }

    function connect() {
      const es = new EventSource('/stream?secret=' + encodeURIComponent(SECRET));

      es.onopen = () => setConnected(true);

      es.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'typing') {
          $empty.classList.add('hidden');
          $typing.classList.add('visible');
          scrollToBottom();
        } else if (msg.type === 'message' && msg.role === 'assistant') {
          appendMessage('assistant', msg.text);
        }
      };

      es.onerror = () => {
        setConnected(false);
        // EventSource reconnects automatically after ~3s
      };
    }

    connect();
  </script>
</body>
</html>`;
}

registerChannelAdapter('web-ui', { factory: createAdapter });

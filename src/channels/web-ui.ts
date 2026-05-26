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
  <title>Privacy Aware Trading Assistant</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = { theme: { extend: { colors: { accent: '#10a37f' } } } }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/marked@14/marked.min.js"></script>
  <style>
    /* Markdown content */
    .bubble p { margin-bottom:.6em; }
    .bubble p:last-child { margin-bottom:0; }
    .bubble code { font-family:ui-monospace,'SFMono-Regular',monospace; font-size:13px; background:#f4f4f4; border-radius:4px; padding:2px 6px; }
    .bubble pre { background:#f4f4f4; border-radius:10px; padding:14px 16px; overflow-x:auto; margin:.6em 0; }
    .bubble pre code { background:none; padding:0; }
    .bubble ul,.bubble ol { padding-left:1.5em; margin:.4em 0; }
    .bubble li { margin:.2em 0; }
    .bubble strong { font-weight:600; }
    .bubble a { color:#10a37f; text-decoration:none; }
    .bubble a:hover { text-decoration:underline; }
    .bubble blockquote { border-left:3px solid #e5e5e5; padding-left:12px; color:#6b6b6b; margin:.4em 0; }
    .bubble h1,.bubble h2,.bubble h3 { font-weight:600; margin:.8em 0 .3em; }
    .bubble h1 { font-size:1.2em; } .bubble h2 { font-size:1.1em; } .bubble h3 { font-size:1em; }
    .bubble hr { border:none; border-top:1px solid #e5e5e5; margin:.8em 0; }
    .bubble table { border-collapse:collapse; width:100%; margin:.5em 0; font-size:14px; }
    .bubble th,.bubble td { border:1px solid #e5e5e5; padding:6px 12px; text-align:left; }
    .bubble th { background:#f4f4f4; font-weight:600; }
    /* Typing animation */
    @keyframes bounce { 0%,60%,100%{transform:translateY(0);opacity:.4;} 30%{transform:translateY(-5px);opacity:1;} }
    #typing-inner span { animation:bounce 1.3s infinite; }
    #typing-inner span:nth-child(2) { animation-delay:.15s; }
    #typing-inner span:nth-child(3) { animation-delay:.3s; }
    /* Scrollbar */
    #messages::-webkit-scrollbar { width:4px; }
    #messages::-webkit-scrollbar-track { background:transparent; }
    #messages::-webkit-scrollbar-thumb { background:#d0d0d0; border-radius:4px; }
    /* chat-empty state */
    #welcome { display:none; }
    #typing { display:none; }
    #typing.visible { display:flex; }
    body.chat-empty #messages { display:none; }
    body.chat-empty #welcome { display:flex; }
    body.chat-empty #main { justify-content:center; }
  </style>
</head>
<body class="bg-white h-screen flex flex-col overflow-hidden font-sans chat-empty">

  <!-- Topbar -->
  <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
    <div class="flex flex-col gap-0.5">
      <div class="flex items-center gap-2.5">
        <svg viewBox="0 0 28 28" fill="none" class="w-7 h-7 flex-shrink-0">
          <rect width="28" height="28" rx="7" fill="#e6f4f0"/>
          <polyline points="3,21 8,13 13,17 18,7 23,11" stroke="#10a37f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="23" cy="11" r="2" fill="#10a37f"/>
        </svg>
        <h1 class="text-xl font-semibold text-gray-900 tracking-tight">Privacy Aware Trading Assistant</h1>
      </div>
      <p class="text-xs text-gray-400 ml-9">AI-powered · Local · Private</p>
    </div>
    <div id="status-pill" class="flex items-center gap-1.5 text-xs text-gray-400">
      <div id="status-dot" class="w-2 h-2 rounded-full bg-gray-300"></div>
      <span id="status-text">Connecting…</span>
    </div>
  </div>

  <!-- Nav tabs -->
  <div class="flex items-center gap-1 px-6 py-2 border-b border-gray-100 flex-shrink-0">
    <button data-query="Show my current watchlist" class="px-3 py-1.5 text-sm text-gray-600 rounded-md hover:bg-gray-100 transition-colors cursor-pointer">Watchlist</button>
    <button data-query="Show my current price alerts" class="px-3 py-1.5 text-sm text-gray-600 rounded-md hover:bg-gray-100 transition-colors cursor-pointer">Alerts</button>
    <button data-query="What is the current market overview?" class="px-3 py-1.5 text-sm text-gray-600 rounded-md hover:bg-gray-100 transition-colors cursor-pointer">Market</button>
    <button data-query="Show current assistant configuration and capabilities" class="px-3 py-1.5 text-sm text-gray-600 rounded-md hover:bg-gray-100 transition-colors cursor-pointer">Settings</button>
  </div>

  <!-- Main -->
  <div id="main" class="flex-1 flex flex-col overflow-hidden">

    <!-- Welcome (shown when chat is empty) -->
    <div id="welcome" class="flex-col items-center gap-4 px-5 pb-6 text-center pointer-events-none">
      <div class="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="#10a37f" stroke-width="1.5" class="w-7 h-7">
          <polyline points="2,18 7,10 12,14 17,6 22,9" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="22" cy="9" r="1.5" fill="#10a37f" stroke="none"/>
        </svg>
      </div>
      <h2 class="text-2xl font-semibold text-gray-900">How can I help you today?</h2>
      <p class="text-sm text-gray-500 max-w-sm">Ask about your watchlist, RSI levels, price movements, or market trends.</p>
    </div>

    <!-- Messages -->
    <div id="messages" class="flex-1 overflow-y-auto py-2">
      <div id="typing" class="px-5 py-2 justify-center">
        <div id="typing-inner" class="w-full max-w-3xl flex items-center gap-1">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-gray-400"></span>
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-gray-400"></span>
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-gray-400"></span>
        </div>
      </div>
    </div>

    <!-- Input -->
    <div id="bottom" class="flex-shrink-0 px-5 py-3 pb-5 flex justify-center">
      <div class="w-full max-w-3xl">
        <div id="input-wrap" class="flex items-end gap-2 bg-gray-100 rounded-2xl border border-gray-200 px-4 py-3 focus-within:border-gray-400 transition-colors">
          <textarea id="input" rows="1" placeholder="Ask about your watchlist or market…" disabled
            class="flex-1 bg-transparent border-0 outline-none text-gray-900 text-base resize-none overflow-y-auto leading-relaxed placeholder-gray-400 disabled:opacity-50" style="min-height:26px;max-height:200px;font-family:inherit;"></textarea>
          <button id="send-btn" disabled
            class="w-9 h-9 rounded-xl bg-[#10a37f] hover:bg-[#0d8f6f] text-white flex items-center justify-center flex-shrink-0 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed border-0 cursor-pointer">
            <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4">
              <path d="M3.478 2.404a.75.75 0 00-.926.941l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.404z"/>
            </svg>
          </button>
        </div>
        <p class="text-center text-xs text-gray-400 mt-2">AI-powered · Local · Private</p>
      </div>
    </div>

  </div><!-- #main -->

  <script>
    const SECRET = ${JSON.stringify(secret)};
    const PORT   = ${port};

    const $messages  = document.getElementById('messages');
    const $typing    = document.getElementById('typing');
    const $input     = document.getElementById('input');
    const $sendBtn   = document.getElementById('send-btn');
    const $dot       = document.getElementById('status-dot');
    const $statusTxt = document.getElementById('status-text');

    let connected = false;

    function renderContent(text, isAssistant) {
      if (!isAssistant) return escHtml(text).replace(/\\n/g, '<br>');
      if (window.marked) {
        try { return marked.parse(text, { breaks: true, gfm: true }); } catch (_) {}
      }
      return escHtml(text).replace(/\\n/g, '<br>');
    }

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function appendMessage(role, text) {
      document.body.classList.remove('chat-empty');
      $typing.classList.remove('visible');

      const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const row = document.createElement('div');
      row.className = 'flex justify-center px-5 py-1';

      const inner = document.createElement('div');
      inner.className = 'w-full max-w-3xl flex flex-col' + (role === 'user' ? ' items-end' : '');

      const bubble = document.createElement('div');
      if (role === 'user') {
        bubble.className = 'bubble bg-gray-100 rounded-2xl px-4 py-2.5 max-w-[75%] text-sm text-gray-900 leading-relaxed break-words';
      } else {
        bubble.className = 'bubble w-full py-1 text-gray-900 leading-7';
        bubble.style.fontSize = '15px';
      }
      bubble.innerHTML = renderContent(text, role === 'assistant');

      const stamp = document.createElement('div');
      stamp.className = 'text-gray-400 mt-1' + (role === 'user' ? ' text-right' : '');
      stamp.style.fontSize = '11px';
      stamp.textContent = ts;

      inner.appendChild(bubble);
      inner.appendChild(stamp);
      row.appendChild(inner);

      $messages.insertBefore(row, $typing);
      scrollToBottom();
    }

    function scrollToBottom() {
      $messages.scrollTop = $messages.scrollHeight;
    }

    $input.addEventListener('input', () => {
      $input.style.height = 'auto';
      $input.style.height = Math.min($input.scrollHeight, 200) + 'px';
    });

    document.querySelectorAll('[data-query]').forEach(btn => {
      btn.addEventListener('click', () => {
        $input.value = btn.dataset.query;
        $input.focus();
        $input.dispatchEvent(new Event('input'));
      });
    });

    function sendMessage() {
      const text = $input.value.trim();
      if (!text || !connected) return;
      appendMessage('user', text);
      $typing.classList.add('visible');
      scrollToBottom();
      $input.value = '';
      $input.style.height = 'auto';
      fetch('/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SECRET },
        body: JSON.stringify({ text }),
      }).catch((err) => appendMessage('assistant', '_Failed to send: ' + err.message + '_'));
    }

    $sendBtn.addEventListener('click', sendMessage);
    $input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    function setConnected(ok) {
      connected = ok;
      $dot.className = ok
        ? 'w-2 h-2 rounded-full bg-[#10a37f]'
        : 'w-2 h-2 rounded-full bg-gray-300';
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
          document.body.classList.remove('chat-empty');
          $typing.classList.add('visible');
          scrollToBottom();
        } else if (msg.type === 'message' && msg.role === 'assistant') {
          appendMessage('assistant', msg.text);
        }
      };
      es.onerror = () => setConnected(false);
    }

    connect();
  </script>
</body>
</html>`;
}

registerChannelAdapter('web-ui', { factory: createAdapter });

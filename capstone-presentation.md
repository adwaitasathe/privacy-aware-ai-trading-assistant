---
marp: true
theme: default
paginate: true
html: true
style: |
  section {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    background: #0f1117;
    color: #e8eaf0;
  }
  h1 { color: #7ec8e3; border-bottom: 2px solid #2a3a4a; padding-bottom: 0.3em; }
  h2 { color: #a8d8ea; }
  h3 { color: #f9c74f; margin-top: 0.5em; }
  strong { color: #f9c74f; }
  code { background: #1e2738; color: #90e0ef; padding: 2px 6px; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; }
  th { background: #1e3a5f; color: #ffffff; padding: 10px 14px; font-size: 0.95em; }
  td { padding: 8px 14px; border-bottom: 1px solid #2a3a4a; color: #e8eaf0; background: #16202e; }
  tr:nth-child(even) td { background: #1a2535; }
  tr:last-child td { color: #6b7a8d; background: #111820; }
  del { color: #4a5568; }
  ul li { margin: 0.4em 0; }
  .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 2em; }
  section.title { text-align: center; justify-content: center; }
  section.title h1 { font-size: 2em; border: none; }
  section.title p { color: #a8d8ea; font-size: 1.1em; }
  section img { max-width: 100%; max-height: 80vh; display: block; margin: 0 auto; }
  section.fullimg { padding: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; }
  section.fullimg h2 { position: absolute; top: 16px; left: 40px; margin: 0; font-size: 1.1em; }
  section.fullimg img { max-width: 100%; max-height: 100vh; object-fit: contain; }
---

<!-- _class: title -->

# Privacy-Aware Trading Assistant

**Practical AI Privacy — Capstone Presentation**

---

## Agenda

1. **Use Case** — what it is and why privacy matters (~2 min)
2. **Top Risks** — identified and prioritized (~4 min)
3. **Mitigations** — how we addressed each risk (~4 min)
4. **Next Priority** — the executive pitch (~3 min)
5. **Q&A**

---

## 1. The Use Case

**Personal equity research assistant powered by Claude**

- Delivers **daily briefings** at 9 AM and 3 PM PT (Mon–Fri) via Telegram
  - Live prices + RSI for a watchlist (NVDA, AAPL, TSLA, MSFT, ...)
- Answers **on-demand queries** via a local Web UI
  - "What's the RSI on CIEN?" / "Add MRVL to my watchlist"
- **Runs entirely on your machine** — Docker container, Web UI at `127.0.0.1:3200`

---

<!-- _class: fullimg -->

## Architecture

![Architecture Diagram](architecture_diagram.png)

---

## Why Privacy Matters Here (AI-Specific)

**This is not generic "secure your laptop" security**

1. **Persistent memory** → agent builds a financial portfolio profile over time
   - Watchlist, preferences, commentary accumulate in agent workspace files

2. **Every Claude inference call leaves the device**
   - System prompt + context → Anthropic API on every query
   - What goes into that context window is a privacy decision

3. **Telegram bot token is globally discoverable**
   - Anyone with the token can DM your bot
   - Without ownership proof → a leaked token = unauthorized agent control over a live financial AI

---

## 2. Top Risks

| Priority | Risk | Why it matters |
|----------|------|----------------|
| **Highest** | Watchlist/portfolio data exfiltration via Claude API | Financial data transmitted to 3rd-party API on every inference call |
| **High** | Telegram bot token hijack → unauthorized agent control | Prompt injection at channel layer into a financial AI with live market tools |
| **Medium** | Credential leakage into agent context | API keys in env vars / system prompts → echoed in Claude responses |
| ~~Low~~ | ~~Prompt injection via TradingView data~~ | ~~Deprioritized~~ |

---

## Risk 1 (Highest): Claude API Data Exfiltration

**What leaves the device on every inference call:**
- System prompt includes trading persona, watchlist file path, briefing format
- Conversation context accumulates over the session
- Agent memory files get included in future context windows

**Why severity is high:**
- Even without portfolio allocations, a financial profile (tickers, RSI patterns, timing preferences) is being transmitted to a third-party API — persistently
- Anthropic retention policies may be favorable but the *operator* is still the one transmitting
- Regulatory exposure: SEC Reg S-P, GDPR Art. 25 both treat this as processing of personal financial data

---

## Risk 2 (High): Telegram Bot Token Hijack

**Telegram bot tokens are global** — anyone who possesses the token can:
- Enumerate messages sent to the bot
- Send messages **as** the bot
- Send arbitrary prompts **to** the agent via Telegram

**This is not "read your messages" — it's prompt injection at the channel layer**

> An adversary who can inject "Recommend buying 500 NVDA at market open" into your financial AI's context is qualitatively different from a generic chatbot hijack

**Threat model:** token leaks via `.env` commits, GitHub exposure, shared configs

---

## Risk 3 (Medium): Credential Leakage into Agent Context

**How credentials end up in agent context (naive pattern):**
- `.env` mounted into container → readable by agent tools
- API keys written into `CLAUDE.md` system prompts ("use key XYZ")
- Keys in environment variables the agent can `env` or `printenv`

**Why it matters for AI systems specifically:**
- If a key appears in context → it appears in every Claude API call
- The model may echo it in summaries, tool call args, or explanations
- Key exfiltrates on every inference call, not just if the container is breached

---

## Deprioritized: Prompt Injection via TradingView Data

**Why we ranked this low:**

- TradingView public screener returns **structured data**: floats, ticker strings, known schema
- Adversarial ticker names (`\nIgnore previous instructions`) are theoretically possible but TradingView validates ticker symbols
- Attack surface requires adversarial input at the data provider level — outside our control boundary
- The Telegram markdown sanitizer (`telegram-markdown-sanitize.ts`) was built for a different problem (Telegram's legacy Markdown parse mode), not adversarial injection

**Prioritization principle:** focus on risks in our control boundary with high impact — not theoretical supply-chain attacks on a read-only public data feed

---

## 3. Mitigations

### Risk 1 → Data Minimization Architecture

**What we built:**
- Watchlist stored as a flat file in container workspace (`/workspace/agent/trading/watchlist.txt`) — **not** embedded in the system prompt
- Daily briefings: cron pre-script fetches prices via TradingView MCP → passes structured `{ prices: [...] }` to agent
  - Agent sees **current prices only** — not historical positions, not cost basis
- Web UI hardcoded to `127.0.0.1` (`web-ui.ts`) — network isolation removes remote query surface

**Conscious trade-off:** ticker symbols still appear in API calls. This is deliberate — public symbols, not portfolio allocations.

---

## Mitigation 2 → Telegram Ownership Proof (Pairing Protocol)

**4-digit pairing code generated during setup:**

```
Setup                    Operator               Telegram
  │                         │                       │
  │── generate code ────────┤                       │
  │                         │── send "4729" ───────▶│
  │                         │                       │── interceptor ──▶ tryConsume()
  │                         │                       │   ✓ match → chat registered
  │                         │                       │   code NEVER forwarded to agent
```

**Key security properties:**
- Code must be sent **from** the chat being registered — knowing the code is not enough
- **One wrong guess = code invalidated + new code issued** → brute force window: 1 attempt
- `extractCode()` is strict: exactly 4 digits — "my pin is 4729" does not match
- Registered chats get `unknown_sender_policy: 'strict'` — unregistered senders silently dropped at host

---

## Mitigation 3 → OneCLI Agent Vault

**Credentials never inside the container:**

<div class="columns">
<div>

**Before (naive)**
```
container env:
  ANTHROPIC_API_KEY=sk-...
  TELEGRAM_BOT_TOKEN=...

.env mounted at /workspace/.env
Agent can read both
```

</div>
<div>

**After (OneCLI vault)**
```
container env: (nothing)
.env → shadow-mounted to /dev/null

HTTPS_PROXY → OneCLI gateway
gateway injects key per-request
by hostname pattern only
```

</div>
</div>

**Real gotcha from development:** `onecli.ensureAgent()` creates agents in `selective` mode — no secrets assigned by default. Symptom: `401 Unauthorized` that looks like an API key problem. Fix: `onecli agents set-secret-mode --id <id> --mode all`

---

## Bonus: Two-DB Split as Architectural Privacy Boundary

**The only host ↔ container interface:**

```
Host (Node.js)                    Container (Bun + Claude)
     │                                       │
     │── writes ──▶ inbound.db ◀── reads ───│
     │── reads  ◀── outbound.db ── writes ──│
     │                                       │
  central DB                          (no access)
  (users, roles,                       container is
   pairing state,                      isolated from
   channel configs)                    host DB entirely
```

**Privacy property:** even if the container is compromised (malicious MCP server, prompt injection into tool calls), it cannot reach the central database holding user roles, pairing state, or channel authentication sessions — those are never mounted.

---

## 4. Top Next Priority

### Payload Auditing for Claude API Calls

**The gap:** we know at the *architecture level* what *should* be in API calls. We have no runtime visibility into what *is* actually sent.

**The risk:** the agent is instructed to remember preferences across sessions. Over time, memory files accumulate financial commentary — and those files get included in future context windows sent to Anthropic.

**What "privacy by assertion" looks like today vs. what we want:**

| Today | With Payload Auditing |
|-------|----------------------|
| "We believe minimal data leaves" | "Here is a log of token counts + data categories per call" |
| Architecture-level claim | Per-call evidence |
| Cannot demonstrate to an auditor | Can demonstrate to an auditor |

---

## The Business Case for Payload Auditing

**What to build (low cost):**
1. Instrument agent runner poll loop: log token count + privacy-labeled summary per API call (no full content logged)
2. Max-retention policy for memory files (e.g., conversations >30 days archived/excluded from context)
3. Static analysis: classify "acceptable data" (ticker symbols, public prices) vs. "sensitive" (allocations, cost basis, broker IDs) — verify CLAUDE.md never prompts for the latter

**Compliance angle:**
- FINRA Rule 4370, SEC Regulation S-P, GDPR Article 25 all require *demonstrating* what personal/financial data you process and where it goes
- Moves from **privacy-by-assertion** → **privacy-by-evidence**

**ROI:** ~200 lines in the agent runner. Closes the last uninstrumented surface.

---

## Strategic Fit

**The pattern of this project:**

| Surface | Mitigation | Status |
|---------|-----------|--------|
| Credentials | OneCLI vault — per-request injection | ✅ Done |
| Channel access | Telegram pairing + localhost Web UI | ✅ Done |
| Host ↔ container | Two-DB split — no network ports | ✅ Done |
| **Claude API calls** | **Payload auditing** | **← Next** |

The Claude API call is the **one surface we cannot eliminate** — it is the product. Making it auditable closes the loop on our privacy-by-design posture.

---

<!-- _class: title -->

# Questions?

**Key files for reference:**
- `src/channels/telegram-pairing.ts` — ownership proof protocol
- `src/channels/web-ui.ts` — localhost-only binding
- `src/container-runner.ts` — OneCLI gateway injection
- `groups/main/CLAUDE.local.md` — trading persona + watchlist instructions

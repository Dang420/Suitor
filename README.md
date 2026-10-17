# Suitor — production build

Token-based chat: **ladies chat free, gentlemen bring tokens** (10 tokens per
message from a gentleman to a lady, enforced server-side).

Stack: Node.js + Express, PostgreSQL, vanilla JS frontend served from Express.
PayPal REST (Orders v2) for token packs, verified server-side. **No simulated
or bot profiles anywhere — Discover only shows real registered users.**

## Quick start (local)

Prereqs: Node 18+, PostgreSQL 13+.

```bash
cd suitor-deploy
npm install

# 1. Create the database
createdb suitor
# (or: psql -c "CREATE DATABASE suitor;")

# 2. Configure
cp .env.example .env
# edit .env: set DATABASE_URL and JWT_SECRET (openssl rand -hex 32)

# 3. Migrate + run
npm run migrate
npm start        # or: npm run dev
```

Open http://localhost:3000.

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `JWT_SECRET` | yes (prod) | dev-only fallback | `openssl rand -hex 32` |
| `PORT` | no | 3000 | Host sets this (Railway/Render) |
| `NODE_ENV` | no | development | Set `production` on deploy (secure cookies, pg TLS) |
| `TOKEN_COST_PER_MESSAGE` | no | 10 | Tokens a gentleman pays per message to a lady |
| `WELCOME_TOKENS` | no | 25 | Free tokens granted to gentlemen at signup |
| `PAYPAL_MODE` | no | sandbox | `sandbox` or `live` |
| `PAYPAL_CLIENT_ID` | for payments | — | From developer.paypal.com → Apps & Credentials |
| `PAYPAL_SECRET` | for payments | — | Same. **Never** put this in frontend code |
| `CONCIERGE_API_KEY` | no | — | Google Gemini key (free tier, AI Studio) for the AI Concierge. Server-side only. Unset = built-in draft bank |
| `QLOO_API_KEY` | no | — | Qloo API key for Taste Match date ideas. Server-side only. Unset = built-in taste bank |
| `QLOO_API_BASE` | no | `https://hackathon.api.qloo.com` | Qloo API base URL |
| `CONCIERGE_MODEL` | no | `gemini-2.5-flash` | Gemini model for concierge drafts |

Without `PAYPAL_CLIENT_ID`/`PAYPAL_SECRET` the wallet shows "Payments aren't
connected yet" and no real charges can happen. Tokens are **never** credited
without a `COMPLETED` capture verified against PayPal's API (amount +
currency checked, idempotent on the PayPal order id).

## API overview

- `POST /api/auth/signup` — `{email, password, name, gender, age, avatarColor, bio?, inviteCode?}`.
  18+ enforced, gentlemen get `WELCOME_TOKENS` server-side.
  **Ladies are invite-only**: `inviteCode` is required for `gender: "lady"`
  (400 `invite_required` / `invite_invalid` / `invite_revoked` / `invite_exhausted`
  otherwise). Gentlemen never need a code. Codes are consumed atomically
  (row-locked) and recorded on the user as `invite_code_id`.
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`
- `GET /api/discover` — real users (excludes self + blocked either way), with unread counts
- `GET /api/conversations`, `POST /api/conversations {peerId}`
- `GET /api/conversations/:id/messages?after=ISO`, `POST /api/conversations/:id/messages {body}`
  — token deduction inside a DB transaction; `402 insufficient_tokens` when broke
- `POST /api/conversations/:id/concierge {goal, hint?}` — AI Concierge drafts
  (`hello` / `keep_going` / `ask_out` / `revive`): returns 3 message drafts +
  a date idea. **Read-only by design** — it never sends a message and never
  moves tokens; the user taps a draft into the composer and sends it
  themselves. Powered by Gemini when `CONCIERGE_API_KEY` is set, otherwise a
  built-in draft bank (response carries `source: "ai" | "bank"`). When the
  user's balance can't cover the next message it flags `canAfford: false`
  and the UI points at the existing PayPal top-up flow — the concierge
  itself never touches payments
- **Taste Match (Qloo)** — on the `ask_out` / `keep_going` goals the date
  idea is grounded in real taste: interests are extracted from both bios,
  resolved to Qloo entities via `GET /search`, and Qloo's Insights API
  (`GET /v2/insights`) returns affinity-ranked places, movies, and artists
  that people with that taste actually love — the response adds a `taste`
  object (`source: "qloo"`) and the UI renders a Taste Match card with
  per-pick affinity scores. Live when `QLOO_API_KEY` is set on the server
  (hackathon API base `https://hackathon.api.qloo.com`, overridable via
  `QLOO_API_BASE`); without a key — or on any API error — it falls back to
  a built-in taste bank (`source: "bank"`), so the feature never dead-ends.
  `GET /api/config` reports `tasteMode: "api" | "bank"`. Same read-only
  rules as the concierge: no sends, no token movement, ever
- `GET /api/wallet`, `POST /api/wallet/create-order {packId}`,
  `POST /api/wallet/capture {orderId}`
- `POST /api/users/:id/report {reason}`, `POST /api/users/:id/block`,
  `DELETE /api/users/:id/block`

Auth: JWT in an httpOnly cookie (`secure` in production). Rate limits on
auth, messaging, and wallet endpoints. Helmet headers. All user content is
sanitized server-side and escaped on render.

## Lady invite codes

Ladies can only sign up with an invite code. Mint codes on the server machine
(never exposed over HTTP):

```bash
node scripts/gen-invite.js --label "Maya's friends" --uses 25
node scripts/gen-invite.js --uses 1   # single-use
```

Revoke a leaked code in psql:

```sql
UPDATE invite_codes SET revoked = TRUE WHERE code = 'LADYA3F9K2Q7';
```

Codes are case/dash tolerant (`lady-a3f9-k2q7` works). Track who invited whom
via `users.invite_code_id`. Existing lady accounts are unaffected.

## Deploy — Railway

1. Push this folder to a GitHub repo.
2. Railway → **New Project → Deploy from GitHub**, pick the repo.
3. **+ New → Database → PostgreSQL**. Railway injects `DATABASE_URL` automatically.
4. Service → **Variables**: set `JWT_SECRET` (`openssl rand -hex 32`),
   `NODE_ENV=production`, and the PayPal vars when ready.
5. Deploy. The start command (`npm start`) runs migrations automatically, then boots.

## Deploy — Render

1. Push this folder to a GitHub repo.
2. Render → **New → Web Service**, connect the repo.
   - Runtime: **Docker** (uses the included `Dockerfile`), or Node with
     Build `npm ci` / Start `npm start`.
3. **New → PostgreSQL**, then link it: set the web service's `DATABASE_URL`
   to the database's *Internal Database URL*.
4. **Environment**: `JWT_SECRET`, `NODE_ENV=production`, PayPal vars.
5. Deploy — migrations run on boot via `npm start`.

## Going live with PayPal

1. You need a **PayPal Business** account (personal accounts can't take payments).
2. Go to developer.paypal.com, log in with the business account,
   **Apps & Credentials → Create App**, copy the **Client ID** and **Secret**.
3. Set `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, and `PAYPAL_MODE=live` in the host's
   environment variables. Redeploy.
4. Test with a small real purchase before announcing anything.

## Smoke test

```bash
npm start &
node test/smoke.js   # signup → discover → message → token deduction → wallet
```

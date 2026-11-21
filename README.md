# Word Royale

A real-time, head-to-head five-letter word battle (Tanda Hackathon). Each player gets a secret word. Solve
yours to become **shielded**, or **steal** your opponent's word to knock them out. Both boards are visible
live, so every guess you make also hands your opponent clues.

Play a **2-player duel** or a **battle royale of up to 100 players**. The host sets the player limit in the lobby, and any
number from 2 up to that limit can start. In a battle royale, every player picks whom to attack from their own random
shortlist of 3 opponents. People who arrive mid-match spectate and join the next match. A spectator/projector view shows
the whole arena.

| Doc | What's in it |
|---|---|
| [docs/SRS.md](docs/SRS.md) | Original requirements, plus an **Implementation addendum** at the end listing every deviation |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Host-referee design, public/private state, realtime events, state machines, security limits |
| [docs/FUTURE_FEATURES.md](docs/FUTURE_FEATURES.md) | Battle-royale expansion and deferred mechanics |

## Stack

Next.js 16 (App Router) · React 19 · TypeScript 6 (strict) · Tailwind CSS 4 · Motion · Zustand ·
Supabase Realtime (Broadcast + Presence only, **no database**) · Vitest · Playwright. Deploys to Vercel as a
static and client app with no API routes.

The **host's browser is the referee**. It runs the pure game engine (`lib/engine`), keeps both secret words
private, and broadcasts a redacted public state. Guests only send intents (guess or steal) and render what
the host sends back.

## Quick start (no accounts needed)

Requires Node 22+ (tested on Node 24).

```bash
npm install
npm run dev:local        # local WebSocket relay (:8787) + Next dev server (:3000)
```

Open http://localhost:3000 in two browser windows, using a private window for the second player. Each tab
is its own player. Create a room in one window, then join with the code or link in the other.

Phones on the same Wi-Fi can join too. Open `http://<your-computer's-LAN-IP>:3000`; the relay is reached
on port 8787 of the same machine.

> `dev:local` uses a dev-only relay (`scripts/relay.mjs`) instead of Supabase. It has no auth and no rate
> limits, and it is never used by a deployed build that has Supabase configured.

## Running against Supabase locally

```bash
cp .env.example .env.local   # then fill in the two values below
npm run dev
```

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes (prod) | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes (prod) | The **anon / publishable** key. It is public by design, so never use the `service_role` / secret key. |
| `NEXT_PUBLIC_REALTIME_TRANSPORT` | no | `supabase` (default when the vars above are set) or `local` (dev relay) |
| `NEXT_PUBLIC_LOCAL_RELAY_URL` | no | Override the dev relay URL (default `ws://<page host>:8787`) |
| `NEXT_PUBLIC_DRAFT_MIRROR` | no | `false` turns off live mirroring of in-progress typing, which is the biggest source of Realtime messages |

`.env.local` is git-ignored. Do not commit credentials.

## Tests

```bash
npm test                      # Vitest: engine rules, redaction, host runner, protocol, client helpers
npx playwright install chromium   # first time only
npm run test:e2e              # Playwright: 2 players + spectator, through the local relay
E2E_PROD=1 npm run test:e2e   # same suite against a production build (next build && next start)
npm run typecheck && npm run lint
```

- **Unit tests (161):** every gameplay rule GR-1…GR-37 and edge case from the SRS test table, plus the amendments:
  - secret-leak checks
  - early-finish on and off
  - deadline-before-action ordering
  - duplicate sequence numbers
  - host refresh / abandon
  - malformed payloads
- **E2E (5, + an opt-in 100-player load test):**
  - battle royale: start 4 players in a 10-player room, host-only cap control, per-player 3-option shortlist picker,
    a late joiner spectates then plays the rematch, eliminations without the match ending, standings;
  - create, join and spectate; live guess mirroring; steal-row styling; a winning steal; rematch
  - a check that the guest's raw WebSocket frames never contain an active secret
  - guest refresh and host refresh mid-match
  - "Room not found"

  The E2E suite starts its own relay (port 8788) and dev server (port 3100). Stop any running `npm run dev`
  first, because Next allows one dev server per project folder.

### Test and demo URL flags

| Flag | Where | Effect |
|---|---|---|
| `?debug=1` | home / host room URL | 20 s match and 10 s overtime, plus a debug panel showing measured ack latency (p50/p95), clock offset, version and match duration |
| `?seed=42` | home / host room URL | Deterministic secret words |
| `?early=0` | home / host room URL | Starts with the GR-28 "unbeatable early finish" **off**. The host can also toggle it in the lobby. |
| `?watch=1` | room URL | Spectator / projector view |
| `?big=1` | room URL | 1.5× projector scaling |

### Display options

- **Light / dark pastel theme:** the sun/moon button in the header (or on the home page) switches the whole look: page background, boards, tiles, keys and text. Dark is the default because it reads better on projectors. The choice is remembered per browser.
- **Layout:** game and spectator screens fit exactly one screen and resize live on any device or orientation. Phones in landscape put the keyboard on the right.

## Battle royale scale (read before a 100-player event)

The host's browser referees the whole match. After the first full snapshot it sends only what changed,
batched every 100 ms, so a guess costs about 1 KB, not the whole 60–80 KB state.

**Through the relay** (`scripts/relay.mjs`), a 100-player match was load-tested at **76 ms median and
119 ms p95** guess confirmation, with no clients falling out of sync:
`LOADTEST=1 npx playwright test e2e/load-100.spec.ts`.

**On Supabase Realtime**, every message, including every player's guesses, fans out to everyone in the
room. A 100-player match is several hundred to a few thousand delivered messages per second, which is
**well above the free tier's Realtime quota**. This has not been measured. For big games, either:
- move to a paid Supabase plan and raise the Realtime limits; or
- self-host the relay, which delivers moves only to the host. Run it on any Node host (Render, Fly.io,
  Railway, a VM; it honours `PORT`). Then set `NEXT_PUBLIC_REALTIME_TRANSPORT=local` and
  `NEXT_PUBLIC_LOCAL_RELAY_URL=wss://your-relay-host` in Vercel. **The relay has no auth or rate
  limiting**, so it is fine for a one-off event, but don't leave it running publicly.

Two tips for big rooms: switch **unbeatable early finish off** (one lucky early solve would otherwise end it
for everyone), and keep the host laptop on power and a wired or strong connection.

## Deploy (Vercel + Supabase)

1. **Supabase:** create a project on the free tier. No tables, migrations or SQL are needed. The app uses
   public Realtime channels (`room:{CODE}`). If your project's Realtime settings restrict access to private
   channels only, re-enable public channels.
2. Copy the **Project URL** and the **anon / publishable** key.
3. **Vercel:** push this repo to GitHub, then *Add New → Project → Import* it. Vercel detects the Next.js
   framework preset.
4. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` under Project → Settings →
   Environment Variables, for both **Production** and **Preview**.
5. Deploy. Every push to `main` redeploys.

With the CLI instead: `npm i -g vercel && vercel link && vercel env add NEXT_PUBLIC_SUPABASE_URL &&
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY && vercel --prod`.

A production build without the Supabase variables shows a "Realtime not configured" screen instead of
silently failing.

### Demo-day checklist

- [ ] Production URL loads on iOS Safari and Android Chrome, on venue Wi-Fi **and** 4G.
- [ ] Check the current Supabase free-tier Realtime quotas (concurrent connections, messages per second)
      against the expected audience size. Set `NEXT_PUBLIC_DRAFT_MIRROR=false` if needed.
- [ ] Host laptop plugged in, sleep disabled, a single host tab. **The host tab is the referee.**
- [ ] Projector on `/room/{CODE}?watch=1&big=1`.
- [ ] One full dry run with `?debug=1`, including overtime (20 s match).
- [ ] QR code legible from the back of the room. Click the QR in the lobby to show it fullscreen.

## Known limitations (honest list)

- **Not cheat-proof.** The host's browser holds both secret words; anyone with DevTools on the *host*
  machine can read them. Guests never receive an active secret. Supabase anonymous channels do not
  authenticate senders, so a technically skilled participant could forge messages. Details and the
  hardening path are in [ARCHITECTURE.md](docs/ARCHITECTURE.md#security-limitations).
- **The host tab must stay open.** If it is gone for more than 10 s, the match is abandoned (GR-36). There
  is no host migration yet.
- **Supabase path not yet exercised.** No Supabase credentials were available while building this, so all
  automated multiplayer tests ran through the local relay, which mimics Broadcast and Presence. Run one
  real two-device match on the deployed URL before the demo.
- **Performance:** the room route's initial JS measured **205.5 KB gzipped**, against NFR-4's SHOULD of
  ≤ 200 KB. That figure excludes supabase-js, the word lists, the referee code and the QR encoder, which all
  load lazily. NFR-1/3/5 and Lighthouse were not measured on real devices.
  Use the `?debug=1` panel to read live ack latency.
- **Sound effects (UI-11, "could") are not implemented.**

## Project layout

```
app/                    Next.js routes: / (home) and /room/[code]
components/             React UI (no game rules in here)
lib/engine/             Pure rules engine: reducer, outcome, pairing, scoring, settings, projection + tests
lib/realtime/           Transport interface (Supabase / local relay), wire protocol, HostRunner + tests
lib/client/             RoomClient controller, zustand store, identity, copy, keyboard colouring,
                        player lookups, spectator-arena layout + tests
lib/words/              Generated word lists (answers 2,014 / valid guesses 17,501) + blocklist + licences
scripts/                relay.mjs (dev relay), dev-local.mjs, build-words.mjs (regenerate word lists)
e2e/                    Playwright specs + shared helpers (helpers.ts)
```

Word lists come from [SCOWL](http://wordlist.aspell.net/) (permissive licence in
`lib/words/LICENSE-SCOWL.txt`) and the public-domain ENABLE list (`lib/words/LICENSE-ENABLE.txt`).
Secret words are common words only (SCOWL size ≤ 35); **any** of the 17,501 five-letter words in SCOWL
(every size up to 95, all English spellings) or ENABLE is accepted as a guess. The Oxford English
Dictionary is proprietary and has no open edition, so it is not used. Regenerate the lists with
`node scripts/build-words.mjs /path/to/scowl-2020.12.07/final /path/to/enable1.txt`.

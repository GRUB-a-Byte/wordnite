# Word Royale — Architecture (release 1.0, 2-player duel)

This document describes how the shipped code works. Requirements are in [SRS.md](SRS.md); where the
implementation deviates from the SRS, the *Implementation addendum* at the end of the SRS explains why.

## 1. Overview

```mermaid
flowchart LR
    subgraph Vercel
        NEXT[Next.js app<br/>static + client bundles<br/>no API routes]
    end
    subgraph Supabase
        RT[(Realtime channel room:CODE<br/>Broadcast + Presence<br/>no tables)]
    end
    H[Host browser<br/>UI + HostRunner + engine<br/>holds PrivateGameState]
    G[Guest browser<br/>UI only]
    S[Spectator / projector<br/>UI read-only]
    NEXT -- HTTPS --> H & G & S
    H <-- "WebSocket: actions in, PublicGameState out" --> RT
    G <-- WebSocket --> RT
    S <-- WebSocket --> RT
```

- **No server-side game logic.** Vercel serves the app, and Supabase Realtime is only a relay.
- **The host browser is the referee** (SRS D-13). Its `HostRunner` owns the only copy of the authoritative
  state, including both secret words. It applies actions one at a time and broadcasts a *redacted* snapshot
  after every change.
- **Guests and spectators are thin clients.** They send intents (`GUESS`, `STEAL`, …) and render whatever
  the referee says. They never decide whether a word solved, stole or won.

For development and the Playwright suite, `scripts/relay.mjs` (a ~100-line WebSocket server) stands in for
Supabase with the same Broadcast (`self: true`) and Presence semantics. It is selected by
`NEXT_PUBLIC_REALTIME_TRANSPORT=local`, or automatically in dev when Supabase is not configured. It is
never deployed.

## 2. Module map and dependency rule

```
components/  ──►  lib/client/  ──►  lib/realtime/  ──►  lib/engine/
 (React UI)       (RoomClient,      (transport,         (pure rules:
                   zustand store,    protocol,           reducer, outcome,
                   copy, identity)   HostRunner)         pairing, scoring,
                                                         settings, projection)
```

Dependencies point **only to the right**. `lib/engine` has no React, Supabase or browser imports, and
calls neither `Date.now()` nor `Math.random()`: time and randomness are injected (NFR-8, NFR-13). ESLint
enforces this with `no-restricted-imports` and `no-explicit-any` on `lib/engine/**`. No gameplay rule
lives in a React component (FIX 2). Components call `RoomClient` methods and read the store.

| Module | Responsibility |
|---|---|
| `lib/engine/types.ts` | `PrivateGameState` / `PublicGameState`, players, rows, actions, events, rejections |
| `lib/engine/settings.ts` | `DEFAULT_SETTINGS`, `DEBUG_SETTINGS`, `validateSettings`, `resolveSettings` (FIX 3) |
| `lib/engine/score.ts` | GR-16 two-pass tile scoring |
| `lib/engine/secrets.ts` | GR-2 distinct secret selection (partial Fisher–Yates) |
| `lib/engine/pairing.ts` | Who targets whom. 1.0 = "duel" pairing (FIX 2 extension point) |
| `lib/engine/outcome.ts` | Win/draw evaluation GR-26…29 and timeout outcomes GR-30/33 |
| `lib/engine/reducer.ts` | `reduce(state, action, {now, rng, dictionary})` — the referee |
| `lib/engine/project.ts` | `toPublicState()` whitelist projection plus the `findLeakedSecrets()` tripwire (FIX 1) |
| `lib/realtime/transport.ts` | `RoomTransport` interface, outbound queue while offline, transport selection |
| `lib/realtime/supabaseTransport.ts` / `localTransport.ts` | Supabase Realtime and dev-relay implementations |
| `lib/realtime/protocol.ts` | Event names and payload types, plus runtime validation of untrusted payloads |
| `lib/realtime/hostRunner.ts` | Referee loop: FIFO dispatch, 250 ms TICK, presence diffing, persistence, broadcast |
| `lib/client/roomClient.ts` | Per-page controller: input, client-side validation, pending/ack, clock offset, host-absence detection, draft mirroring |
| `lib/client/store.ts` | Zustand store read by the UI |

## 3. Private vs public state (FIX 1)

```ts
PrivatePlayer extends PublicPlayer { secret: string }        // host memory + host sessionStorage only
PrivateGameState { players: PrivatePlayer[]; rowCounter; eventCounter; … }
PublicGameState  { players: PublicPlayer[]; hostNow; revealedSecrets?; … }   // the only thing ever sent
```

- `toPublicState(private, hostNow)` is a **whitelist** projection: every public field is copied
  explicitly, so adding a private field can never leak it by accident.
- `revealedSecrets` is filled **only when `phase === 'FINISHED'`** (FR-6.2). Abandoned matches reveal nothing.
- Every snapshot the host is about to broadcast in development (and in `?debug=1`) passes through
  `findLeakedSecrets()`. If an alive player's secret appears as any JSON string value other than a guessed
  word or a nickname, the broadcast is **blocked** and logged. A solved player's word legitimately appears
  on their own board, because they are invulnerable by then.
- Tests cover this at three levels:
  - **Unit:** projection of every phase, with and without solves.
  - **HostRunner:** every message broadcast through a full match.
  - **E2E:** every raw WebSocket frame the guest browser receives during play.

The host browser still holds both secrets, which is the accepted limitation of a browser referee (§9).

## 4. Realtime protocol

Channel `room:{CODE}`. Broadcast uses `self: true`, so **the host's own actions travel the same
relay path as guests' actions**. That keeps FIFO ordering fair between host and guest. Presence is keyed
by `playerId`, with payload `{ playerId, nickname, role: host|player|spectator, joinedAt }`.

| Event | Direction | Payload | Notes |
|---|---|---|---|
| `action` | client → host | `ClientAction` | `START`, `GUESS`, `STEAL`, `REMATCH`, `RETURN_TO_LOBBY`, `UPDATE_SETTINGS`. Each carries `playerId` and a per-player increasing `clientSeq`. Shape-validated by `parseClientAction()`; unknown fields are dropped. |
| `state` | host → all | `PublicGameState` | Sent after every change, re-sent every 3 s during a match (Broadcast is at-most-once), and on `sync_request`. |
| `reject` | host → all | `{ playerId, clientSeq, reason }` | Clients filter by their own id. |
| `draft` | player → all | `{ playerId, letters, mode, targetId, matchNumber }` | Live typing (GR-8). Throttled to ≤ 10/s, dropped while offline, never refereed. |
| `sync_request` | client → host | `{ playerId }` | Sent on every (re)connect. Bursts are coalesced. |

```mermaid
sequenceDiagram
    participant G as Guest RoomClient
    participant RT as room:CODE
    participant H as Host HostRunner
    G->>G: validate locally (length, dictionary, duplicate, target) — shake + toast on failure
    G->>G: show PENDING row immediately; block further submits
    G->>RT: action {STEAL, playerId, targetId, word, clientSeq: 7}
    RT->>H: action
    H->>H: parse → reduce(): apply due deadlines first, then the action
    alt rejected
        H->>RT: reject {playerId, clientSeq: 7, reason}
    end
    H->>RT: state {version++, hostNow, players[guest].lastSeq = 7, …}
    RT->>G: state → pending cleared (ack), latency recorded, tiles flip
```

**Acknowledgement (FIX 4).** Every processed action, accepted *or* rejected, sets
`players[i].lastSeq = clientSeq` in the next snapshot. A client clears its pending row when
`lastSeq ≥ pending.clientSeq` and records the submit→confirmation time. The `?debug=1` panel shows
p50/p95/max of the last 50. If no ack arrives:

| Time without ack | Client does |
|---|---|
| 3 s | sends `sync_request` |
| 6 s | resends the **same** action, same `clientSeq` (the host ignores it if it was already processed and just resends state) |
| 15 s | gives up, restores the draft, and shows a toast |

**Versioning and clock.** `version` increases on every change, and clients drop snapshots whose version is
not newer. Every snapshot carries `hostNow`. Clients estimate `offset = max(recent hostNow − Date.now())`
and render timers from the absolute `phaseEndsAt`.

**Animations never block the engine (FIX 4).** Rows appear in state immediately. The 250 ms per tile /
100 ms stagger flip is pure CSS on the client and plays once per row id. Overlays (steal shatter, overtime
"winged god", banners) are driven by the snapshot's `lastEvents`, which carry monotonically increasing ids,
so every screen plays the same animation for the same event. All overlays have `pointer-events: none`;
input is never paused.

## 5. Ordering and conflict resolution (FIX 6)

1. **Strict FIFO.** `HostRunner.dispatch()` is synchronous, so actions are applied fully, including all win
   checks, in the order the host receives them (SRS §5).
2. **Deadlines before actions.** `reduce()` first applies every due deadline in chronological order:
   countdown end, match timeout, overtime timeout and disconnect forfeits. Only then does it look at the
   action. A guess arriving 100 ms after the clock hit zero therefore lands *after* the timeout. It is
   either played in overtime or rejected as `not_playing`. It can never exploit the gap between 250 ms
   TICKs. This deliberately supersedes SRS E-9.
3. **Replay protection.** An action whose `clientSeq ≤ lastSeq` for that player is rejected as
   `duplicate_seq`, with no side effects. The host answers it with a fresh snapshot instead of a reject.
4. **Validate before mutate.** Phase, identity, target eligibility (via the pairing module), word format,
   dictionary, duplicates, then rows or ammo, all before any mutation. Invalid actions never consume rows.
5. **Idempotent terminal transitions.** `eliminate()` ignores an already-eliminated player, and `finish()`
   ignores a non-active match. No double elimination, no double victory.
6. **Outcome evaluation after every mutation** (`resolveOutcome`):
   1. decisive statuses: GR-26 last standing, GR-27 both solved, GR-29 nobody standing;
   2. GR-25 row exhaustion;
   3. re-evaluate, now including GR-28 *unbeatable*.

   Step 1 is why a successful steal on your final row wins (E-4). GR-28 runs after GR-25 so that an
   opponent who simply ran out of rows is reported as `opponent_out_of_rows`, not as `unbeatable` (FIX 5).
7. **Same-millisecond solves.** When two solves have equal rows and an equal `solvedAt`, the processing
   order (`solveOrder`) breaks the tie.

## 6. State machines

### Match phase

```mermaid
stateDiagram-v2
    [*] --> LOBBY
    LOBBY --> COUNTDOWN: START (host, 2 connected players)
    COUNTDOWN --> PLAYING: countdown deadline
    PLAYING --> FINISHED: GR-26/27/28/29 or timeout with a solver (GR-30)
    PLAYING --> OVERTIME: timeout, nobody solved (GR-31, once)
    OVERTIME --> FINISHED: win condition, or OT timeout (GR-33)
    COUNTDOWN --> ABANDONED: host gone > hostGraceMs
    PLAYING --> ABANDONED: host gone > hostGraceMs
    OVERTIME --> ABANDONED: host gone > hostGraceMs
    FINISHED --> COUNTDOWN: REMATCH (host, both connected)
    FINISHED --> LOBBY: RETURN_TO_LOBBY (host)
    ABANDONED --> LOBBY: RETURN_TO_LOBBY (host)
```

### Player status

```mermaid
stateDiagram-v2
    [*] --> alive
    alive --> invulnerable: own guess == own secret (GR-18)
    alive --> eliminated: stolen (GR-23) / rowsUsed == rowLimit (GR-25) / forfeit (GR-35)
    invulnerable --> invulnerable: post-solve steals use ammo (GR-21)
    invulnerable --> eliminated: forfeit only (disconnected > guestGraceMs)
```

## 7. Reliability (FIX 7)

| Concern | Implementation |
|---|---|
| Stable identity | `playerId` (random, lower-case base36) in `sessionStorage`, so it survives a refresh of the same tab. A new tab is a new player. The host claim `wr:host:{CODE}` is also in `sessionStorage`. |
| Room code collisions (E-18) | Before claiming a code, the home page joins the channel and checks Presence for an existing `host`. It tries up to 5 codes. |
| Lobby roster | `HostRunner` diffs every Presence snapshot against the engine roster: new members become `PRESENCE_JOIN`, missing ones `PRESENCE_LEAVE`. Players beyond `maxPlayers`, and anyone joining mid-match, become spectators. A would-be player waiting as a spectator is promoted when a lobby seat frees up. |
| Guest disconnect (GR-35) | Leaving during a match sets `connected=false`, `disconnectedAt`. Rejoining with the same id within 15 s restores the player. After that, they forfeit. This is checked by the clock, not by a timer, so it is deterministic. |
| Guest reconnect / refresh (E-14) | Transports auto-reconnect, re-track Presence and flush queued actions. The client sends `sync_request`. The persisted `clientSeq` plus the `lastSeq` from state keep sequence numbers monotonic. |
| Host refresh (E-15, NFR-7) | After every change the host writes the private state to `sessionStorage`, plus a 1 s heartbeat. On reload it restores the state (timers are absolute timestamps) and rebroadcasts. |
| Host gone (GR-36) | **Guests:** if host Presence is absent for > 10 s during a match, they show "Host left — game abandoned". A newer host snapshot clears this. **Host:** its own connection down > 10 s, or restoring with a heartbeat older than 10 s, means `ABANDON`, so both sides agree. |
| Connection indicator | A header dot shows connected, connecting/reconnecting or disconnected. Opponent boards show "offline". |
| Stale or forged snapshots | Clients ignore `state` with a different `roomCode`, a non-newer `version`, or (once locked on) a different `hostId`. |

## 8. Settings (FIX 3)

`GameSettings` holds plain numbers and booleans, with defaults in `DEFAULT_SETTINGS`:

| Setting | Default |
|---|---|
| match | 120 s |
| overtime | 45 s, +3 rows |
| base rows | 6 |
| post-solve steal rows | 3 |
| countdown | 3 s |
| guest grace | 15 s |
| host grace | 10 s |
| `maxPlayers` | 2 |
| `enableUnbeatableEarlyFinish` | `true` |

`validateSettings()` rejects out-of-range values. In 1.0, `maxPlayers` must be 2 and `wordLength` must
be 5, because only five-letter lists ship. The host can toggle `enableUnbeatableEarlyFinish` in the lobby
(an `UPDATE_SETTINGS` action, accepted only in `LOBBY`) or start with `?early=0`. `?debug=1` uses
`DEBUG_SETTINGS` (20 s / 10 s).

## 9. Security limitations

This is a hackathon prototype. **It is not cheat-proof, and the code does not claim to be.**

- **The host can read both secrets.** The referee runs in the host's browser, so the private state is in
  its memory and `sessionStorage`. Guests never receive an active secret over the wire.
- **No sender authentication.** Supabase anonymous channels accept any client holding the public anon key.
  A technically skilled participant could:
  - publish actions with someone else's `playerId`, or
  - publish a fake `state`.

  Mitigations are sanity checks only: payload shape validation, per-player sequence numbers, rule
  validation in the engine, and clients locking onto the first host id they follow.
- **No rate limiting** beyond Supabase's own quotas. The dev relay has none at all.
- **Nicknames** are rendered as text (React escaping), capped at 16 characters, and masked by a small
  profanity filter. The filter is conservative, for example "Scunthorpe" gets masked.

**Hardening path.** Move `reduce()` into a server authority, such as a Supabase Edge Function or a
long-lived worker; a Vercel Function alone cannot hold the match clock. Keep secrets server-side, and
authenticate players with per-player tokens. The `PrivateGameState` / `PublicGameState` split and the pure
reducer are already the shape such a move needs.

## 10. Extension points for the future battle-royale release (FIX 2)

The engine never refers to "player A/B" or to UI components. Players are records in an array, keyed by
stable ids. To grow beyond a duel:

| Extension | Where | What changes |
|---|---|---|
| N players | `settings.maxPlayers` + `validateSettings` | Lift the `max: 2` limit once the UI and outcome rules support N |
| Target assignment | `lib/engine/pairing.ts` | Replace duel pairing with random alive, non-shielded targets (SRS §13) or bracket pairings; reassign on elimination/solve |
| Win / ranking rules | `lib/engine/outcome.ts` | Generalised GR-28 and ranking (shielded by rows then time, then alive, then reverse elimination order); a steal no longer ends the match |
| Knockout rounds / tournament | New module above the reducer (e.g. `lib/engine/tournament.ts`) | Run one duel `PrivateGameState` per pairing and advance winners; the duel reducer stays unchanged |
| Server authority | `lib/realtime/hostRunner.ts` | Same `reduce()` + `toPublicState()`, hosted server-side; clients unchanged apart from the transport |
| UI | `components/GameView.tsx` | Already renders "my board + my current target", so it needs a target switcher and a "New target" animation |

## 11. Testing strategy

- **Vitest (`npm test`, 114 tests):**
  - `lib/engine`: every GR rule and SRS edge case, plus amendments (ordering, sequence numbers, leakage,
    the early-finish toggle, determinism);
  - `lib/realtime`: `HostRunner` against an in-memory transport (FIFO, presence diffing, persistence,
    abandon, resync, hostile payloads) and protocol validation;
  - `lib/client`: copy, keyboard colouring, ids, nicknames.
- **Playwright (`npm run test:e2e`):** real browsers through the local relay.
  - Two players and a spectator: mirroring (rows and live typing), invalid-word rejection, steal-row
    styling, a winning steal, both end screens, rematch.
  - A raw-WebSocket-frame secret-leak check.
  - Guest refresh, host refresh, and "Room not found".

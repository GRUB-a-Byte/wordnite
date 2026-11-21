# Word Royale — Future features

Release 1.0 is a **two-player duel** (see [SRS.md](SRS.md) and the implementation addendum). Nothing in
this file is implemented. Items here are **candidates for later playtesting, not approved scope**. Each
needs a decision before it is built.

The extension points referenced below are described in
[ARCHITECTURE.md §10](ARCHITECTURE.md#10-extension-points-for-the-future-battle-royale-release-fix-2).

---

## 1. Battle-royale / tournament mode (the original vision)

Goal: many players start in 1v1 duels, and the competition narrows until a final 1v1.

> **v1.1 shipped one form of this:** a king-of-the-hill session ([SRS_AMENDMENT_v1.1.md](SRS_AMENDMENT_v1.1.md)).
> Random symmetric duels, winners stay on, losers are out, last one standing is champion. The rows
> below are the remaining alternatives: brackets, a free-for-all variant, and matchmaking.

| Piece | Sketch | Builds on |
|---|---|---|
| Knockout rounds | Pair everyone into duels. Winners advance; draws need a tie-break rule (decide: replay, fewer rows, or coin flip). | A `tournament` module above the existing duel reducer. Each duel stays a normal `PrivateGameState`. |
| Automatic pairings | Random seeding for round 1, then by bracket position. Byes for odd counts. | `lib/engine/pairing.ts` |
| Final 1v1 | The last two players play a standard duel on the projector. | Existing duel and spectator view |
| Simultaneous duels | Several duels in one room. The projector shows a bracket and highlights the closest match. | Per-duel state inside one room, or one channel per duel |
| Free-for-all variant (SRS §13) | Each player sees exactly two boards (their own and a randomly assigned target). Targets are reassigned when theirs is eliminated or shielded. A steal eliminates but doesn't end the game. Ranking: shielded by rows then time, then alive, then reverse elimination order. | `pairing.ts` (random target), `outcome.ts` (generalised GR-28 and ranking), the `maxPlayers` limit |
| Matchmaking | A public quick-play queue | Needs a server |

Open questions to settle before building:
- Round timers.
- Whether overtime exists in every round.
- What spectators see during parallel duels.
- Whether eliminated players stay as spectators.
- Supabase Realtime quotas at that scale. A server authority is probably needed (below).

## 2. Deferred gameplay mechanics (from early brainstorming — NOT in SRS v1.0)

None of these are implemented, and they should only be added after a playtest decision.

| Idea | Description | Notes / risks |
|---|---|---|
| Logical / descriptive hints | A textual hint about your word (e.g. "a kind of food") | Needs a curated hint per answer word (licensing and effort); changes difficulty a lot |
| Additional clue reveals | Spend something (time or a row) to reveal one letter or position | Interacts with GR-27 row scoring; needs a cost model |
| Yellow-letter "critical hits" | Bonus effects when a steal attempt lands many present/correct letters | Could make steals too strong; needs tuning |
| Hint theft | Stealing a clue instead of a word | Depends on hints existing first |
| Adjustable multi-word progression | Solve N words in sequence instead of one (configurable N) | Superseded for 1.0 by the single-word duel (FIX 3). Revisit for tournament modes. Would change `GameSettings`, scoring and the board layout. |

**Explicitly removed — do not reintroduce:** saboteurs and hidden sabotage roles. Also out of scope:
RPG classes and boss battles.

## 3. Platform and quality items

| Item | Why | Notes |
|---|---|---|
| Server authority | Real anti-cheat. The host could otherwise read secrets, and senders are unauthenticated (ARCHITECTURE §9). | Same `reduce()` + `toPublicState()`, hosted in a Supabase Edge Function or a long-lived worker |
| Host migration | The match survives the host tab closing | Hard while the host holds secrets; easier after server authority |
| Spectator "dramatic irony" toggle (SRS FR-7.2) | Show the audience both secrets | Dropped in 1.0 because it requires secrets in the broadcast. Possible with a server-side spectator feed. |
| Sound effects (SRS UI-11, "could") | Key tick, flip, steal, eliminated; muted by default | Not implemented in 1.0 |
| Persistence | Match history, leaderboards, ELO (Supabase Postgres) | Needs auth and RLS |
| More modes | Hard mode (must reuse revealed hints), 6-letter words, team mode | `wordLength` is already a setting, but only 5-letter lists ship |
| Accounts | Persistent identity across devices | Currently a per-tab `playerId` |

# Word Royale — SRS Amendment v1.1: Spacebar toggle, waiting room, fresh duels

| | |
|---|---|
| **Amends** | [SRS.md](SRS.md) v1.0, including its implementation addenda Z.1–Z.11 |
| **Version** | 1.1 |
| **Date** | 2026-11-21 |
| **Status** | Draft, approved for implementation |
| **Requested by** | Product owner |
| **Related** | [ARCHITECTURE.md](ARCHITECTURE.md) · [FUTURE_FEATURES.md](FUTURE_FEATURES.md) |

> **Precedence.** This document amends SRS v1.0 and addenda Z.1–Z.11. Where they conflict, **this
> document wins**. Anything not mentioned here is unchanged. The requirement keywords (MUST / SHOULD /
> MAY) and ID conventions follow SRS §1.5. New requirements use the prefixes **`WR-`** (waiting room)
> and **`FD-`** (fresh duels).

---

## 1. Summary of changes

| ID | Affects | Change |
|---|---|---|
| FR-4.2a | FR-4.2, FR-4.3, UI-13 | **Space** toggles own guess ⇄ steal, under the same rules as Tab. |
| FD-1…FD-6 | GR-2, GR-3, GR-26–GR-28, Z.9 "Ending", Z.11 "Re-pairing" | In a battle royale, every pairing is a **fresh duel**: new secret words and a fully reset, blank board. A duel ends by the 1.0 duel rules; the loser is out of the battle and the winner waits for a new opponent. |
| FD-7 | GR-4, GR-5, GR-30–GR-34, FR-5.1, Z.9 "Ending" | **Every duel has its own timer**: its own 3 s countdown, 2:00 clock and 45 s overtime, starting when the duel starts. **There is no global match timer.** |
| WR-1 | GR-9, GR-14, `RejectReason` | The referee **rejects every GUESS and STEAL** from a player who is waiting (`waiting_for_opponent`). |
| WR-2 | FR-3.1–FR-3.4, FR-4.2a | The client turns all input off while waiting. |
| WR-3 | Z.11 "Odd numbers" | Replaces "they keep solving their own word" with "they wait and take no actions". |
| WR-4 | Z.11 | A player leaves the waiting room **only** by being paired, or when the match ends. |
| WR-5 | FR-5.1, FR-5.2, `ArenaBar`, the GameView waiting placeholder | A **waiting-room screen** with **no board and no timer**, only stats of who is still in play. |

**2-player matches are unchanged.** With two players the match *is* one duel: the players are paired
for the whole match and the duel's end is the match's end (GR-26 to GR-34). Nobody waits, and no
second duel ever starts. The FD and WR rules apply only to battle royales (3+ players,
`isBattleRoyale()`). The Space toggle applies to both.

---

## 2. Definitions (additions to SRS §1.3)

| Term | Definition |
|---|---|
| **Duel** | One pairing of two players inside a battle royale. It runs from the moment they are paired until one of them is knocked out of the battle (FD-3). |
| **Paired** | A player in play whose `targetId` names an opponent whose `targetId` names them back (Z.11). |
| **Waiting** (in the waiting room) | A player still in the battle (not eliminated), during `COUNTDOWN`, `PLAYING` or `OVERTIME`, who has **no `targetId`**. Derived from existing state; no stored field. |
| **Duel winner** | The player left standing when their duel ends. They go to the waiting room (or straight into a new duel if someone is free). |

A player is waiting when:

- they are the odd player out when the match starts with an odd number of players;
- they have just won their duel and no other player is free yet.

---

## 3. Spacebar toggle (amends FR-4.2)

- **FR-4.2a (new, M)** Pressing **Space** during `PLAYING` or `OVERTIME` toggles between **own guess**
  and **steal** mode. It is a power-user shortcut alongside Tab, Esc and clicking a board.
  1. **Same rules as Tab.** Space calls the existing `RoomClient.toggleMode()`, which goes through
     `setMode()` and `stealBlockReason()` in [lib/client/roomClient.ts](../lib/client/roomClient.ts).
     When steal mode isn't available (opponent shielded or eliminated, out of ammo), Space shows the
     same warning toast as Tab and the mode doesn't change.
  2. **Ignored** (no toggle, no toast) when:
     - the player is shielded. Their UI is steal-only (FR-4.7), so there is nothing to toggle;
     - the player is eliminated;
     - the player is waiting (WR-2);
     - the phase isn't `PLAYING` or `OVERTIME`;
     - the event is a key repeat (`KeyboardEvent.repeat`), so holding Space doesn't flicker the mode;
     - a text field has focus (input, textarea, select or content-editable), e.g. the nickname box.
  3. **No side effects.** The handler MUST call `preventDefault()` on Space **keydown and keyup**
     while the game view is mounted. Space then never scrolls the page and never activates a focused
     button (browsers activate buttons on Space keyup).
  4. **The draft is kept** when switching (FR-4.3).
  5. **Space can't clash with typing**, because guesses are A–Z only (GR-11).
  6. **Discoverability.** Every hint that mentions Tab also mentions Space:
     - the GameView status line: "tap X's board (or Space / Tab) to steal";
     - the steal button's tooltip in [components/Keyboard.tsx](../components/Keyboard.tsx): "Space or Tab to toggle".

     A small "Space ⇄" key hint appears next to the mode buttons on fine-pointer (mouse / trackpad)
     devices only.
  7. **Accessibility (UI-13).** Mode changes, from any source, are announced in a polite `aria-live`
     region: "Steal mode — target {name}" / "Own word".
- **Implementation location.** Add a Space branch next to the existing Tab branch in
  `usePhysicalKeyboard` ([components/GameView.tsx](../components/GameView.tsx)). The eligibility
  rules in point 2 SHOULD live in a small pure helper so they can be unit-tested.

---

## 4. Fresh duels (battle royale only)

- **FD-1 New duel on every pairing (M).** Whenever the referee pairs two players (`pairPlayers()` in
  [lib/engine/pairing.ts](../lib/engine/pairing.ts)), both start a **fresh duel**. This includes the
  first pairing at match start. Each of the two players gets:
  - a **new secret word**. It differs from the opponent's (GR-2), from every secret currently in play,
    and from that player's previous secrets this match, while enough answers remain;
  - a **full reset** to the GR-3 starting state:
    - status `alive`;
    - `rows` emptied, so the board is blank and the old rows are gone;
    - `rowsUsed = 0`;
    - `postSolveStealRows = 0`;
    - `solvedInRows`, `solvedAt` and `solveOrder` cleared.

  **Nothing from earlier duels carries over** (no shield, no steal shots, no rows), apart from still
  being in the battle.
- **FD-2 Row limit in a fresh duel (M).** `rowLimit = baseRows`. Extra rows only come from that
  duel's own overtime (FD-7).
- **FD-3 How a duel ends (M).** A duel is decided by the 1.0 duel rules, evaluated between its two
  players only:
  - **GR-26:** one of them is eliminated (word stolen, out of rows, or forfeit). The other wins.
  - **GR-27:** both solved. Fewer rows wins; equal rows → earlier solve.
  - **GR-28** (when `enableUnbeatableEarlyFinish` is on): one has solved and the other can no longer
    beat that row count. The solver wins.
  - **GR-30 (duel clock runs out):** if exactly one has solved, the solver wins. If nobody has solved,
    the duel goes into its own overtime (FD-7).
  - **GR-33 (duel overtime runs out):** if exactly one has solved, the solver wins. If nobody has
    solved, the duel is a **draw and both players are out of the battle** (1.0: "everybody loses").
- **FD-4 Losing a duel knocks you out of the battle (M).** The loser's status becomes `eliminated`.
  - Under GR-26 the existing reasons apply (`stolen`, `out_of_rows`, `forfeit`).
  - Under GR-27 and GR-28 the loser is eliminated with the new reason **`outscored`**. This is
    different from 1.0, where an unbeatable loss "is not an elimination" (Z.1 / FIX 5): in a battle
    royale, a lost duel must remove the player, or the battle never shrinks.
- **FD-5 The winner waits, then gets a new duel (M).** The duel winner loses their opponent and
  enters the waiting room (WR-1–WR-5). As soon as another player is free, the referee pairs them
  and FD-1 resets both.
- **FD-6 Supersedes Z.11 pair splitting (M).** The Z.11 rule "a pair in which neither player can steal
  from the other any more splits up" is **removed**. A duel now always runs to an FD-3 result. For
  example, a solved player with no steal shots left keeps their duel until the opponent solves, runs
  out of rows or becomes unbeatable.
- **FD-7 Every duel has its own timer; no global timer (M).** This amends GR-4, GR-5 and GR-30 to
  GR-34.
  - When a duel starts (FD-1), it gets its own **3 s countdown** (GR-4). No guesses or steals are
    accepted in that duel until the countdown ends.
  - It then gets its own **2:00 clock** (`matchMs`, GR-5), starting when its countdown ends.
  - It has its own **overtime**: at most once per duel (GR-34), it adds +3 rows to that duel's
    unsolved players and gives 45 s (`overtimeMs`, GR-31).
  - Each clock is independent. One duel's countdown, timeout or overtime never affects another duel
    or a waiting player.
  - **There is no global match timer.** The match has no deadline of its own; it lasts until it ends
    (below). The match-wide `PLAYING` → `OVERTIME` phase change no longer happens in a battle royale.
    The match stays `PLAYING` while duels run their own clocks.
  - The referee handles every duel's deadlines in time order before each action, exactly as it does
    for the single match clock today (addendum FIX 6).
  - **2 players:** the single duel's clock is the only clock, so a 2-player match plays exactly as
    before.
- **Match ending (amends Z.9 "Ending").**
  - **Last one standing:** the match ends as soon as only one player is left in the battle and no
    duel is running. They win.
  - **Nobody left:** if the last duel is a draw (FD-3) and nobody else is left, the match is a draw
    (GR-29, `all_eliminated`).
  - There is no match-level timeout or overtime. The match-level "everyone standing has solved" and
    generalised GR-28 checks from Z.9 are replaced by the per-duel FD-3 rules.
  - Standings: the match winner first, then eliminated players, most recently out first. Players
    knocked out together in a draw share a place (see A-12).

---

## 5. Waiting room

### 5.1 Rules

- **WR-1 No actions while waiting (M).** While a player is waiting, the referee MUST reject their
  `GUESS` and `STEAL` actions with the new reject reason **`waiting_for_opponent`**. No row or steal
  shot is used.
  - This amends GR-9 (own guesses are only allowed while in a duel, in a battle royale) and GR-14
    (rejection list).
  - It is enforced in the engine (`handleGuess` and `handleSteal` in
    [lib/engine/reducer.ts](../lib/engine/reducer.ts)), checked right after the phase and
    eliminated checks, before any word validation. The client rules below are a convenience only.
  - Steals *at* a waiting player were already rejected (`invalid_target`, `isOpponent()`). That stays.
- **WR-2 Input off on the client (M).**
  - `RoomClient.canType()` returns `false` while waiting.
  - When a player becomes waiting: their draft and any mirrored draft are cleared, and the mode
    returns to "own".
  - Physical keys (letters, Enter, Backspace, Tab, Space, Esc) do nothing.
  - A submission that was already in flight is answered `waiting_for_opponent`: the pending row is
    cleared and a toast says "Waiting for an opponent".
- **WR-3 Supersedes Z.11 "Odd numbers" (M).** "One player waits for an opponent. They keep solving
  their own word, and nobody can steal from them meanwhile" now reads: **"One player waits for an
  opponent. While waiting they cannot guess, type or steal, and nobody can steal from them."**
- **WR-4 Leaving the waiting room (M).** A waiting player leaves the waiting room only when:
  - the referee pairs them with an opponent: a fresh duel starts (FD-1) and input comes back; or
  - the match ends (last one standing, or abandon).

  There is **no time limit** and **no release to play solo**, even when no opponent can ever become
  free.
- **WR-6 Unchanged:**
  - which players are paired with whom (`pairPlayers()` priorities);
  - steal rules and scoring;
  - disconnect handling (GR-35);
  - late joiners and the 2–100 player cap.

### 5.2 Waiting-room screen (WR-5)

- **WR-5 (M)** While waiting, a player sees a waiting-room screen **instead of the game view**. It
  replaces:
  - the dashed "⏳ Waiting for an opponent" placeholder in GameView;
  - the "keep solving your word" status hint.

  It shows:
  1. **"Waiting for an opponent"**, with a line such as "You won your duel — you'll be paired as soon
     as someone is free" (or, for the odd player out at the start, "You'll be paired as soon as a duel
     ends").
  2. **No board.** Neither their own board nor any opponent's board is shown. Their next board starts
     blank in their next duel (FD-1).
  3. **No keyboard** and no mode buttons.
  4. **No timer.** A waiting player isn't in a duel, so there is no clock to show (FD-7). Other duels'
     clocks are not shown either.
  5. **Who is still in the battle:**
     - counts: alive · shielded · out, reusing `arenaCounts()` from
       [lib/client/players.ts](../lib/client/players.ts);
     - a list of players still in the battle, grouped by duel ("A vs B"), each with nickname, status
       (Alive / Shielded) and rows used. Other waiting players are marked "waiting".
- **When paired**, the normal game view returns with two blank boards. The existing toast
  "⚔ New opponent: {name}" (`reconcileMode()` in [lib/client/roomClient.ts](../lib/client/roomClient.ts))
  stays.
- **ArenaBar.** Its "⏳ waiting for a free opponent" text is not needed while the waiting-room screen
  is showing. The counts move into the waiting-room stats.

---

## 6. Consequences and edge cases (continues SRS §5)

| # | Situation | Outcome |
|---|---|---|
| E-21 | A battle royale starts with an odd number of players. | The odd player out is waiting from the countdown on. They see the waiting-room screen and can't act until a duel ends and frees an opponent. |
| E-22 | A player steals their opponent's word. | The opponent is out (`stolen`). The winner goes to the waiting room, or straight into a fresh duel if someone is free. Either way the next duel starts with a blank board and a new word. |
| E-23 | Both duelists solve. | Fewer rows wins (then earlier solve, GR-27). The loser is out (`outscored`). The winner moves on to a fresh duel. |
| E-24 | One duelist solves and the other can no longer beat their row count (GR-28 on). | The solver wins. The other is out (`outscored`). With GR-28 off, the duel continues until the unsolved player solves (GR-27 decides), runs out of rows, or that duel's clock runs out (FD-3). |
| E-25 | A solved duelist has used all their free steal shots. | The duel continues (FD-6: no more pair splitting) until FD-3 decides it. |
| E-26 | A waiting player's only possible opponent is a duel that's still running. | They keep waiting. Every duel ends at the latest when its own clock and overtime run out (about 2:48 including the countdown), so the wait is bounded. |
| E-27 | Duel A is in overtime when duel B starts. | Duel B starts its own countdown and 2:00 clock with `baseRows` rows. Duel A's overtime doesn't affect it (FD-7). |
| E-27a | A duel's overtime runs out with nobody solved, while a third player waits. | Both duelists are out (draw). The waiting player is the last one standing and wins the match. |
| E-27b | The last duel of the match ends in a draw and nobody else is left. | The match is a draw (GR-29). |
| E-28 | A GUESS is in flight when the sender's duel ends. | FIFO: the referee processes it after the transition and rejects it `waiting_for_opponent` (or `eliminated` for the loser), with no row used. |
| E-29 | A GUESS or STEAL aimed at the previous duel arrives after a new duel has started. | Scored in the new duel against the new secrets, as any action is. Clients drop drafts and pending rows when their opponent changes (WR-2), so this only happens with a manual double submit. |
| E-30 | A waiting player disconnects. | GR-35 applies unchanged (15 s grace, then forfeit). |
| E-31 | A waiting player presses Space, Tab, Enter or letters. | Nothing happens (WR-2, FR-4.2a.2). |
| E-32 | 2 players. | One duel for the whole match, as before. FD and WR never apply. |

---

## 7. Data model and protocol (amends SRS §9 and Z.2)

- **`RejectReason`** adds **`waiting_for_opponent`**. `REJECT_TEXT` in
  [lib/client/copy.ts](../lib/client/copy.ts) adds "Waiting for an opponent".
- **`EliminationReason`** adds **`outscored`** (FD-4). Copy: "Out-scored in your duel".
- **Per-duel clock fields (FD-7).** Each player record gets the state of their current duel's clock,
  identical on both players of a pair:
  - `duelPhase: 'COUNTDOWN' | 'PLAYING' | 'OVERTIME'` (unset while waiting or eliminated);
  - `duelEndsAt`: the host-clock deadline of that duel phase (replaces the match-wide `phaseEndsAt`
    in a battle royale);
  - `duelOvertimeUsed: boolean` (GR-34, per duel).

  `GameState.phaseEndsAt` and the match-level `OVERTIME` phase are only used in a 2-player match.
  The client timer (`Timer`, `usePhaseRemaining()` in [components/hooks.ts](../components/hooks.ts))
  reads the viewer's duel clock. Spectators see each duel's own clock.
- **Events.** `PLAY_STARTED` and `OVERTIME_START` gain the two player ids of the duel, so only that
  duel's players (and spectators watching it) see the "GO!" and "winged god" overlays.
- **Other stored fields: none.**
  - "Waiting" is derived from existing public state. Recommended: one shared helper,
    `isWaiting(p, phase)` = active phase, `status !== 'eliminated'`, no `targetId`, in
    [lib/engine/pairing.ts](../lib/engine/pairing.ts), used by both the reducer and the client.
  - The FD-1 reset reuses `resetPlayerForMatch()` in [lib/engine/state.ts](../lib/engine/state.ts)
    with a newly picked secret (`pickSecrets()` in [lib/engine/secrets.ts](../lib/engine/secrets.ts)),
    then applies FD-2's overtime row limit.
- **Events.** A fresh duel emits the existing `TARGET_CHANGED` for both players. A duel result emits
  the existing `ELIMINATED` for the loser. New row ids must not collide with the previous duel's (the
  `rowCounter` is match-wide, so they don't).
- **Secrets on the wire (FIX 1).** A replaced secret is never broadcast while it is still active. A
  finished duel's old words MAY be revealed to everyone once both are no longer in play (see A-13). The
  host's leak tripwire (`findLeakedSecrets()`) applies to the current secrets only.

---

## 8. Testing and acceptance (amends SRS §12)

### 8.1 Unit tests (Vitest)

In [`lib/engine/__tests__/battleRoyale.test.ts`](../lib/engine/__tests__/battleRoyale.test.ts) unless noted.

| Test | Covers |
|---|---|
| Pairing starts a fresh duel: both players get new, distinct secrets; rows, `rowsUsed`, shield, ammo and solve fields reset | FD-1 |
| Each duel gets its own countdown, 2:00 clock and overtime, starting at pairing; actions in a duel's countdown are rejected; one duel's timeout or overtime never changes another duel | FD-7 |
| Duel clock runs out: one solver → solver wins; nobody → overtime +3 rows; overtime runs out with nobody solved → both out | FD-3, FD-7 |
| There is no match-level timeout: a 3+ player match ends only when one (or no) player is left | FD-7 match ending |
| Duel results: steal / out of rows / forfeit → the other wins; both solved → fewer rows, then earlier; GR-28 → solver wins | FD-3 |
| The loser of GR-27 / GR-28 is eliminated `outscored` | FD-4 |
| The winner waits, then on pairing gets a blank board and a new word, different from their old one | FD-5, FD-1 |
| A solved player with 0 ammo keeps their duel (no pair splitting) | FD-6 |
| A waiting player's GUESS and STEAL → `waiting_for_opponent`; nothing changes | WR-1 |
| Odd count at START → one waiting player who can't guess | WR-1, E-21 |
| The match ends when one player is left in the battle | FD match ending |
| 2 players: no waiting, no fresh duel, all existing duel tests pass unchanged | §1, E-32 |
| Space eligibility helper: toggles only for an alive, paired player in PLAYING / OVERTIME; ignored for shielded, eliminated, waiting, repeat, other phases, text focus | FR-4.2a (lib/client tests) |

### 8.2 E2E (Playwright, local relay)

In [e2e/battle-royale.spec.ts](../e2e/battle-royale.spec.ts):

1. **Waiting room.** With 3 players, the odd player out sees the waiting-room screen: no board, no
   keyboard, no timer, the counts and the duel list. Typing, Enter and Space change nothing.
2. **Fresh duel.** A duelist steals their opponent's word. The winner sees the waiting-room screen,
   then is paired with the waiting player. Both see **two blank boards** (rows used 0/6), and a guess
   is scored against a new word.
3. **Spacebar.**
   - Space toggles own → steal → own.
   - The mode buttons' `aria-pressed` follows.
   - Typed letters survive the switch.
   - `window.scrollY` doesn't change.
   - Space while shielded does nothing.

### 8.3 Acceptance

- **AC-8** In a 5+ player match on real devices, no waiting player can submit a row by any means, and
  every new duel starts with blank boards.
- **AC-9** A player can play a full duel using only the physical keyboard (letters, Enter, Backspace, Space).

---

## 9. Decision log additions (continues SRS Appendix A)

| # | Question | Decision | Rationale |
|---|---|---|---|
| D-17 | Mode-toggle shortcut | **Space**, in addition to Tab, Esc and clicking | The fastest key for power users. It can never be part of a guess. |
| D-18 | What can a waiting player do? | **Nothing.** No guesses, typing or steals until paired. | A waiting player must not make progress while others are fighting. |
| D-19 | Who does this apply to? | **Everyone waiting**, including the odd player out at the start | One consistent rule. |
| D-20 | What if no opponent can ever come? | **They keep waiting** until the match ends. No solo release. | Product-owner decision: the waiting room always means "do nothing and wait". |
| D-21 | What does the waiting room show? | **No board and no timer.** Only who is still in the battle. | Product-owner decision. |
| D-22 | What happens on a new pairing? | **A fresh duel:** new secret word and a fully reset blank board for both. Nothing carries over. | Product-owner decision. Old rows would be clues to a word that no longer matters. |
| D-23 | How does a duel end, and what happens to its loser? | **1.0 duel rules** (GR-26 to GR-28, GR-30, GR-33) between the two; **the loser is out of the battle** (`outscored` when beaten on rows; a draw knocks both out). | Follows from D-22: a duel must have a decisive end, or the battle never shrinks. |
| D-24 | Timers | **Every duel has its own countdown, 2:00 clock and overtime. No global match timer.** | Product-owner decision: a duel that starts late must not be rushed by a clock that started earlier. |

## 10. Assumptions to confirm (continues SRS Appendix B)

| # | Assumption | Alternative |
|---|---|---|
| A-9 | Each new duel gets the full 3 s countdown before play. | Skip the countdown for re-pairings. |
| A-10 | In big matches the waiting-room duel list scrolls (up to 100 players), with counts always visible at the top. | Show only the counts above a size threshold. |
| A-11 | Spectators and eliminated players see each live duel with its own clock. | Show no clocks to spectators. |
| A-12 | Final standings: winner first, then eliminated players, most recently out first; a draw's two players share a place. | Rank by duels won. |
| A-13 | A finished duel's two words are shown to both of its players in the duel-result toast or flash, never to anyone while still active. | Reveal old words only on the end screen. |
| A-14 | New secrets avoid every word the player has had before this match, while enough answers remain (2,014 answers; at most 99 duels). | Only avoid the current opponent's word (GR-2). |

---

## Implementation notes (v1.1 build, 2026-11-21)

> Added during implementation. Where an item below conflicts with the text above, **this section
> takes precedence**.

### I.1 Decisions taken while building

| Item | Decision |
|---|---|
| Match start (FD-7) | A battle royale goes straight to `PLAYING` at START. There is no match-level countdown; each duel runs its own 3-2-1. 2-player matches keep `COUNTDOWN` → `PLAYING` as before. |
| Duel draw (FD-3) | Both players are eliminated with the new reason **`duel_draw`**, in addition to `outscored`. |
| Match result reasons | A battle royale whose last rival was out-scored ends with reason `outscored`; one whose last two rivals drew ends with `last_standing`. Both read "Last one standing" on the end screen. |
| Standings (A-12) | Competition ranking: players eliminated at the same moment (a drawn duel) share a place, e.g. 1, 2, 2. |
| A-13 | **Not implemented.** A finished duel's old words are not revealed mid-match; they appear only for players' final words on the end screen. |
| WR-5 list | Waiting players are listed without row counts, because their last duel's rows are history. |
| Spectators (A-11) | The projector grid shows each duel's own clock on its two mini boards ("3…", "1:42", "OT 0:31", "⏳" while waiting). The match-wide timer is gone. |
| Overlays | "GO!", the overtime banner and the winged god only fire for the two players of that duel (`playerIds` on the event). Spectators of a battle royale don't see per-duel overlays. |
| Client reset | When a player's opponent changes (new duel or waiting room), the client drops the draft, pending row and mirrored drafts and returns to own-guess mode. |

### I.2 Verification

- **Unit tests:** 175 pass. New: fresh duels, per-duel clocks / overtime / draws, waiting-room rejections, FD-6, E-4 in a battle royale, Space rules, matchups. The 1.0 two-player engine tests are unchanged.
- **E2E:** all 5 pass. `battle-royale.spec.ts` now covers:
  - the Space toggle (draft kept, no scroll, announced);
  - the waiting room (no board, no keyboard, no timer; typing is refused);
  - fresh duels (blank boards, new word);
  - per-duel spectator clocks.
- **Stress (opt-in):**
  - `LOADTEST=1 npx playwright test e2e/load-100.spec.ts`: 1 browser host + 99 bot agents over the local relay.
  - `STRESS=1 npx vitest run lib/engine/__tests__/stress.test.ts`: randomised 100-player matches through the referee.
  - Results: 3 / 3 browser runs and 500 / 500 engine matches finished with 0 crashes, 0 page errors and 0 invariant violations. No action was ever accepted from a waiting player. Ack p95 ≈ 108 ms on localhost.
- **Not verified:** Supabase Realtime at 100 players (quota estimate unchanged, see Z.9), and real devices.

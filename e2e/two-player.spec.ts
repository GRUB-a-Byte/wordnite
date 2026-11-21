import { expect, test, type Page } from '@playwright/test';
import { createRoom, hostRoster, joinRoom, newPlayer, typeWord, waitForPlay } from './helpers';

/**
 * SRS §12.2 — two browser contexts (host A, guest B) plus a spectator (C).
 * Rooms use the `?debug=1&seed=42` test hooks (see ./helpers).
 */

const CANDIDATES = ['CRANE', 'SLATE', 'TRAIN', 'GHOST', 'PLUMB', 'MOUND', 'STEAK', 'CHAIR', 'LEMON', 'OCEAN'];

interface Secrets {
  hostId: string;
  guestId: string;
  hostSecret: string;
  guestSecret: string;
}

async function readSecrets(host: Page): Promise<Secrets> {
  const { hostId, players } = await hostRoster(host);
  const hostP = players.find((p) => p.id === hostId)!;
  const guestP = players.find((p) => p.id !== hostId)!;
  return { hostId: hostP.id, guestId: guestP.id, hostSecret: hostP.secret, guestSecret: guestP.secret };
}

/** Text labels of the tiles of the n-th scored row on a board, e.g. ["C, correct", …]. */
async function rowLabels(page: Page, boardId: string, rowIndex: number): Promise<string[]> {
  const tiles = page.locator(`[data-testid="board-${boardId}"] [role="img"][aria-label*=", "]`);
  const all = await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  return all.slice(rowIndex * 5, rowIndex * 5 + 5);
}

async function joinAsGuest(guest: Page, code: string, nickname = 'bob') {
  await joinRoom(guest, code, nickname);
  await expect(guest.getByTestId('waiting-host')).toBeVisible();
}

test('two players + spectator: guess mirroring, steal rows, steal win, rematch, no secret leakage', async ({ browser }) => {
  const A = await newPlayer(browser);
  const B = await newPlayer(browser);
  const C = await newPlayer(browser);

  // Capture every WebSocket frame the GUEST receives (FIX 1 leak check).
  const guestFrames: string[] = [];
  B.page.on('websocket', (ws) => ws.on('framereceived', (f) => guestFrames.push(String(f.payload))));

  // 1. A creates a room, B joins by URL, C watches, A starts.
  const code = await createRoom(A.page);
  await joinAsGuest(B.page, code);
  await C.page.goto(`/room/${code}?watch=1`);
  await expect(A.page.getByTestId('player-list')).toContainText('bob');
  await expect(A.page.getByTestId('spectator-count')).toContainText('1');
  await expect(A.page.getByTestId('start-game')).toBeEnabled();
  await A.page.getByTestId('start-game').click();

  await waitForPlay(A.page, B.page, C.page);

  const s = await readSecrets(A.page);
  expect(s.hostSecret).toMatch(/^[A-Z]{5}$/);
  expect(s.guestSecret).toMatch(/^[A-Z]{5}$/);
  expect(s.hostSecret).not.toBe(s.guestSecret); // GR-2
  const safe = CANDIDATES.filter((w) => w !== s.hostSecret && w !== s.guestSecret);

  // 2. A submits a valid own guess; B (and the spectator) see the same letters + colours.
  await typeWord(A.page, safe[0]!);
  await expect(A.page.locator(`[data-testid="board-${s.hostId}"] [data-testid="rows-used"]`)).toHaveText('1/6');
  const onA = await rowLabels(A.page, s.hostId, 0);
  await expect
    .poll(() => rowLabels(B.page, s.hostId, 0), { timeout: 1_000 })
    .toEqual(onA);
  expect(onA.map((l) => l[0]).join('')).toBe(safe[0]);
  await expect.poll(() => rowLabels(C.page, s.hostId, 0)).toEqual(onA);

  // GR-8: in-progress typing is mirrored live to the opponent (not refereed, not scored).
  await A.page.keyboard.type('qj');
  const hostBoardOnB = B.page.locator(`[data-testid="board-${s.hostId}"]`);
  await expect(hostBoardOnB.locator('[role="img"][aria-label="Q"]')).toHaveCount(1);
  await expect(hostBoardOnB.locator('[role="img"][aria-label="J"]')).toHaveCount(1);
  for (let i = 0; i < 2; i++) await A.page.keyboard.press('Backspace');
  await expect(hostBoardOnB.locator('[role="img"][aria-label="Q"]')).toHaveCount(0);

  // Invalid word → rejected client-side, no row used (GR-12, E-11).
  await typeWord(A.page, 'zzzzz');
  await expect(A.page.getByTestId('toasts')).toContainText('Not in word list');
  await expect(A.page.locator(`[data-testid="board-${s.hostId}"] [data-testid="rows-used"]`)).toHaveText('1/6');
  // The rejected word stays in the draft (editable, like classic play) — clear it.
  for (let i = 0; i < 5; i++) await A.page.keyboard.press('Backspace');

  // 3. B enters steal mode by clicking A's board and submits a wrong steal → ⚔ row on both screens.
  await B.page.getByTestId(`board-${s.hostId}`).click();
  await expect(B.page.getByTestId('mode-steal')).toHaveAttribute('aria-pressed', 'true');
  await typeWord(B.page, safe[1]!);
  await expect(B.page.locator(`[data-testid="board-${s.guestId}"]`)).toContainText('→ alice');
  await expect(A.page.locator(`[data-testid="board-${s.guestId}"]`)).toContainText('→ alice');
  await expect(B.page.locator(`[data-testid="board-${s.guestId}"] [data-testid="rows-used"]`)).toHaveText('1/6');

  // FIX 1: up to this point the guest's network traffic never contained either active secret.
  const leaked = guestFrames.filter((f) => f.includes(`"${s.hostSecret}"`) || f.includes(`"${s.guestSecret}"`));
  expect(leaked, 'secret words must not reach the guest during play').toEqual([]);
  expect(guestFrames.some((f) => f.includes('"secret"'))).toBe(false);

  // 4. A steals B's word → end screens.
  await A.page.getByTestId(`board-${s.guestId}`).click();
  await typeWord(A.page, s.guestSecret);
  await expect(A.page.getByTestId('end-headline')).toHaveText('You win!', { timeout: 10_000 });
  await expect(A.page.getByTestId('end-reason')).toHaveText('Word stolen');
  await expect(B.page.getByTestId('end-headline')).toHaveText('You lose');
  await expect(C.page.getByTestId('end-headline')).toHaveText('Match over');
  // FR-6.2: both secrets revealed at the end.
  await expect(B.page.getByTestId('revealed-secret')).toHaveCount(2);
  await expect(B.page.getByTestId('end-screen').locator('..')).toContainText(s.hostSecret);
  await expect(B.page.getByTestId('waiting-rematch')).toBeVisible();

  // 5. Rematch → both return to the countdown / game with fresh boards.
  await A.page.getByTestId('rematch').click();
  await waitForPlay(A.page, B.page);
  await expect(B.page.locator(`[data-testid="board-${s.guestId}"] [data-testid="rows-used"]`)).toHaveText('0/6');
  const s2 = await readSecrets(A.page);
  expect(s2.hostSecret).not.toBe(s2.guestSecret);

  await Promise.all([A.context.close(), B.context.close(), C.context.close()]);
});

test('guest refresh mid-match resynchronises (E-14) and play continues', async ({ browser }) => {
  const A = await newPlayer(browser);
  const B = await newPlayer(browser);
  const code = await createRoom(A.page);
  await joinAsGuest(B.page, code);
  await A.page.getByTestId('start-game').click();
  await waitForPlay(A.page, B.page);
  const s = await readSecrets(A.page);
  const safe = CANDIDATES.filter((w) => w !== s.hostSecret && w !== s.guestSecret);

  await typeWord(B.page, safe[0]!);
  await expect(B.page.locator(`[data-testid="board-${s.guestId}"] [data-testid="rows-used"]`)).toHaveText('1/6');

  await B.page.reload();
  // Same tab → same playerId (sessionStorage) → still a player, board restored from the host.
  await expect(B.page.getByTestId('keyboard')).toBeVisible();
  await expect(B.page.locator(`[data-testid="board-${s.guestId}"] [data-testid="rows-used"]`)).toHaveText('1/6');
  await expect(A.page.locator(`[data-testid="board-${s.guestId}"]`)).not.toContainText('offline', { timeout: 5_000 });

  // Sequence numbers survive the refresh: the next guess is accepted, not dropped as a replay.
  await typeWord(B.page, safe[1]!);
  await expect(B.page.locator(`[data-testid="board-${s.guestId}"] [data-testid="rows-used"]`)).toHaveText('2/6');
  await expect(A.page.locator(`[data-testid="board-${s.guestId}"] [data-testid="rows-used"]`)).toHaveText('2/6');

  await Promise.all([A.context.close(), B.context.close()]);
});

test('host refresh mid-match restores the referee state (E-15) and the match continues', async ({ browser }) => {
  const A = await newPlayer(browser);
  const B = await newPlayer(browser);
  const code = await createRoom(A.page);
  await joinAsGuest(B.page, code);
  await A.page.getByTestId('start-game').click();
  await waitForPlay(A.page, B.page);
  const before = await readSecrets(A.page);
  const safe = CANDIDATES.filter((w) => w !== before.hostSecret && w !== before.guestSecret);
  await typeWord(A.page, safe[0]!);
  await typeWord(B.page, safe[1]!);
  await expect(B.page.locator(`[data-testid="board-${before.hostId}"] [data-testid="rows-used"]`)).toHaveText('1/6');

  await A.page.reload();
  await expect(A.page.getByTestId('keyboard')).toBeVisible();
  const after = await readSecrets(A.page);
  expect(after).toEqual(before); // same secrets, same players — state restored from sessionStorage
  await expect(A.page.locator(`[data-testid="board-${before.hostId}"] [data-testid="rows-used"]`)).toHaveText('1/6');
  await expect(A.page.locator(`[data-testid="board-${before.guestId}"] [data-testid="rows-used"]`)).toHaveText('1/6');

  // Guest keeps playing against the restored referee.
  await typeWord(B.page, safe[2]!);
  await expect(A.page.locator(`[data-testid="board-${before.guestId}"] [data-testid="rows-used"]`)).toHaveText('2/6');
  await expect(B.page.getByTestId('message-title')).toHaveCount(0); // no "Host left" screen

  await Promise.all([A.context.close(), B.context.close()]);
});

test('unknown room shows "Room not found" (E-17)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('wr:nick', 'carol'));
  await page.goto('/room/ZZZZ');
  await expect(page.getByTestId('message-title')).toHaveText('Room not found', { timeout: 12_000 });
});

import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * v1.1 amendment §9.2 — three players: one waits, the duel winner is paired with the waiting
 * player, a champion is declared; plus the Spacebar mode toggle (FR-4.2a).
 * `?debug=1` → 20 s duels and a 4 s result beat; `window.__WR_HOST__` exposes the referee.
 */

interface HostView {
  hostId: string;
  players: { id: string; nickname: string; status: string; duelId?: string }[];
  duels: { id: string; playerIds: [string, string]; phase: string }[];
  secrets: Record<string, string>;
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

async function hostView(host: Page): Promise<HostView> {
  return host.evaluate(() => {
    const h = (
      window as unknown as {
        __WR_HOST__: {
          privateState: {
            hostId: string;
            players: { id: string; nickname: string; status: string; duelId?: string }[];
            duels: { id: string; playerIds: [string, string]; state: { phase: string } }[];
          };
          secretsByPlayer(): Record<string, string>;
        };
      }
    ).__WR_HOST__;
    const s = h.privateState;
    return {
      hostId: s.hostId,
      players: s.players.map((p) => ({ id: p.id, nickname: p.nickname, status: p.status, duelId: p.duelId })),
      duels: s.duels.map((d) => ({ id: d.id, playerIds: d.playerIds, phase: d.state.phase })),
      secrets: h.secretsByPlayer(),
    };
  });
}

async function typeWord(page: Page, word: string) {
  await page.keyboard.type(word.toLowerCase(), { delay: 15 });
  await page.keyboard.press('Enter');
}

async function waitForPlay(page: Page) {
  await expect(page.getByTestId('keyboard')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('timer').filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });
}

test('king of the hill: waiting room, re-pairing, champion, Space toggle', async ({ browser }) => {
  const pages: Record<string, Page> = {
    alice: await newPage(browser),
    bob: await newPage(browser),
    cat: await newPage(browser),
  };
  const host = pages.alice!;

  // Lobby: host raises the cap to 3 (KH-1); two guests join.
  await host.goto('/?debug=1&seed=7');
  await host.getByTestId('nickname-input').fill('alice');
  await host.getByTestId('create-room').click();
  await host.waitForURL(/\/room\/[A-Z]{4}/);
  const code = (await host.getByTestId('room-code').textContent())!.trim();
  await expect(host.getByTestId('player-cap')).toHaveText('2');
  await host.getByTestId('cap-up').click();
  await expect(host.getByTestId('player-cap')).toHaveText('3');
  for (const nick of ['bob', 'cat']) {
    const p = pages[nick]!;
    await p.goto(`/room/${code}`);
    await p.getByTestId('gate-nickname').fill(nick);
    await p.getByTestId('gate-join').click();
    await expect(p.getByTestId('waiting-host')).toBeVisible();
  }
  await expect(host.getByTestId('player-list')).toContainText('cat');
  await host.getByTestId('start-game').click();

  // KH-2: one duel, one random player waits.
  await expect.poll(async () => (await hostView(host)).duels.length).toBe(1);
  const v1 = await hostView(host);
  const nick = (id: string) => v1.players.find((p) => p.id === id)!.nickname;
  const waiting = v1.players.find((p) => p.status === 'waiting')!;
  const [xId, yId] = v1.duels[0]!.playerIds;
  const X = pages[nick(xId)]!;
  const Y = pages[nick(yId)]!;
  const W = pages[waiting.nickname]!;
  await expect(W.getByTestId('waiting-room')).toBeVisible();
  await waitForPlay(X);
  await waitForPlay(Y);

  // KH-4: duelists only ever see two boards.
  await expect(X.locator('[role="group"][data-testid^="board-"]')).toHaveCount(2);
  await expect(X.getByTestId(`board-${waiting.id}`)).toHaveCount(0);

  // FR-4.2a: Space toggles own ⇄ steal, keeps the draft, and doesn't scroll.
  await X.keyboard.type('ab');
  const scrollBefore = await X.evaluate(() => window.scrollY);
  await X.keyboard.press('Space');
  await expect(X.getByTestId('mode-steal')).toHaveAttribute('aria-pressed', 'true');
  await expect(X.getByTestId('mode-announcer')).toContainText('Steal mode');
  await expect(X.locator(`[data-testid="board-${xId}"] [role="img"][aria-label="A"]`)).toHaveCount(1); // FR-4.3
  await X.keyboard.press('Space');
  await expect(X.getByTestId('mode-own')).toHaveAttribute('aria-pressed', 'true');
  expect(await X.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await X.keyboard.press('Backspace');
  await X.keyboard.press('Backspace');

  // X steals Y's word (Space into steal mode, then type it).
  await X.keyboard.press('Space');
  await typeWord(X, v1.secrets[yId]!);
  await expect(X.getByTestId('duel-result-headline')).toHaveText('Victory!', { timeout: 10_000 });
  await expect(X.getByTestId('my-streak')).toContainText('Streak 1');
  await expect(X.getByTestId('next-challenger')).toContainText(waiting.nickname);
  await expect(Y.getByTestId('duel-result-headline')).toHaveText('Knocked out');
  await expect(Y.getByTestId('knocked-out-rank')).toHaveText('3rd of 3');

  // KH-9: after the result beat the winner meets the waiting player in a fresh duel.
  await waitForPlay(X);
  await waitForPlay(W);
  await expect(X.locator(`[data-testid="board-${waiting.id}"]`)).toBeVisible();
  await expect(X.locator(`[data-testid="board-${xId}"] [data-testid="rows-used"]`)).toHaveText('0/6');
  await expect(X.locator(`[data-testid="board-${xId}"] [data-testid="streak"]`)).toHaveText('👑1');
  // The knocked-out player now spectates the only live duel.
  await expect(Y.getByText('Spectating')).toBeVisible({ timeout: 10_000 });

  // W steals X's word → W is champion.
  const v2 = await hostView(host);
  await W.getByTestId(`board-${xId}`).click();
  await typeWord(W, v2.secrets[xId]!);
  await expect(W.getByTestId('end-headline')).toHaveText('Champion!', { timeout: 10_000 });
  await expect(X.getByTestId('end-headline')).toHaveText('Knocked out — 2nd');
  await expect(Y.getByTestId('standings')).toContainText(waiting.nickname);
  await expect(Y.getByTestId('standings').locator('li')).toHaveCount(3);
  await expect(host.getByTestId('rematch')).toHaveText('New session');

  // KH-13: New session reshuffles everyone back into duels.
  await host.getByTestId('rematch').click();
  await expect.poll(async () => (await hostView(host)).duels.length).toBe(1);
  for (const p of Object.values(pages)) await p.context().close();
});

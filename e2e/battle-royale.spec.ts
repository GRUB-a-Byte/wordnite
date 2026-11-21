import { expect, test, type Browser, type Page } from '@playwright/test';
import { createRoom, hostRoster, joinRoom, newPlayer, typeWord, waitForPlay, type HostPlayer } from './helpers';

/**
 * Battle royale end to end: host caps the room at 10, starts with only 4 players (no need to fill
 * the room). The referee pairs everyone at random into mutual duels (A↔B, C↔D) — nobody chooses.
 * A 5th person arrives mid-match and can only spectate. Both duels are fought out; the winner who
 * finishes first waits until the other duel ends, then the two winners are paired. Everyone gets
 * final standings, and on Rematch the late arrival joins as a player.
 */

async function newPage(browser: Browser): Promise<Page> {
  return (await newPlayer(browser)).page;
}

async function hostPlayers(host: Page): Promise<HostPlayer[]> {
  return (await hostRoster(host)).players;
}

/** Click your opponent's board (steal mode) and type their word. */
async function stealOpponent(page: Page, opponent: HostPlayer) {
  await page.getByTestId(`board-${opponent.id}`).click();
  await expect(page.getByTestId('mode-steal')).toHaveAttribute('aria-pressed', 'true');
  await typeWord(page, opponent.secret);
}

test('battle royale: start below the cap, random mutual pairs, late joiner spectates, winners re-paired, standings, rematch', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const host = await newPage(browser);
  const code = await createRoom(host, { nickname: 'host', seed: 5 });

  // Host-only cap control: make it a 10-player room.
  await host.getByTestId('cap-10').click();
  await expect(host.getByTestId('player-cap-input')).toHaveValue('10');

  // Only 1 player → cannot start.
  await expect(host.getByTestId('start-game')).toBeDisabled();

  const pages = new Map<string, Page>([['host', host]]);
  for (const name of ['bea', 'cal', 'dee']) {
    const g = await newPage(browser);
    await joinRoom(g, code, name);
    await expect(g.getByTestId('waiting-host')).toBeVisible();
    await expect(g.getByTestId('player-cap')).toHaveCount(0); // the cap control is host-only
    pages.set(name, g);
  }
  const guests = [...pages.values()].slice(1);
  await expect(host.getByTestId('player-list')).toContainText('dee');
  // 4 of 10 — the room does not need to be full to start.
  await expect(host.getByTestId('start-hint')).toContainText('4 players ready');
  await expect(host.getByTestId('start-game')).toBeEnabled();
  await host.getByTestId('start-game').click();
  await waitForPlay(host, ...guests);
  await expect(host.getByTestId('arena-bar')).toContainText('4 alive');

  // Symmetric pairs: everyone has exactly ONE opponent, who has them as their opponent too.
  let roster = await hostPlayers(host);
  const named = (nickname: string) => roster.find((p) => p.nickname === nickname)!;
  const byId = (id: string | undefined) => roster.find((p) => p.id === id)!;
  for (const p of roster) expect(byId(p.targetId).targetId).toBe(p.id);
  for (const [name, page] of pages) {
    const opponent = byId(named(name).targetId);
    await expect(page.getByTestId('opponent-name')).toHaveText(opponent.nickname); // each screen names its opponent
    await expect(page.getByTestId(`board-${opponent.id}`)).toBeVisible(); // …and shows their board
  }
  await expect(host.getByTestId('target-option')).toHaveCount(0); // nothing to choose

  // A 5th person arrives mid-match → spectates (arena grid of all 4 boards).
  const late = await newPage(browser);
  await joinRoom(late, code, 'eve');
  await expect(late.getByTestId('arena-grid')).toBeVisible();
  await expect(late.locator('[data-testid^="mini-"]')).toHaveCount(4);

  // Duel 1: the host knocks out their opponent. The other duel is still on → the host waits.
  const hostOpponent = byId(named('host').targetId);
  const [otherWinner, otherLoser] = roster.filter((p) => p.id !== named('host').id && p.id !== hostOpponent.id);
  await stealOpponent(host, hostOpponent);
  await expect(host.getByTestId('arena-bar')).toContainText('3 alive');
  await expect(host.getByTestId('opponent')).toContainText('waiting for a free opponent');
  await expect(host.getByTestId('waiting-opponent')).toBeVisible();
  await expect(pages.get(hostOpponent.nickname)!.getByTestId('keyboard')).toBeVisible(); // knocked out → keeps watching

  // Duel 2: fought out in the other pair → the two winners are paired with each other.
  await stealOpponent(pages.get(otherWinner!.nickname)!, otherLoser!);
  await expect(host.getByTestId('arena-bar')).toContainText('2 alive');
  await expect.poll(async () => (await hostPlayers(host)).find((p) => p.nickname === 'host')!.targetId).toBe(otherWinner!.id);
  roster = await hostPlayers(host);
  expect(byId(otherWinner!.id).targetId).toBe(named('host').id); // mutual
  await expect(host.getByTestId('opponent-name')).toHaveText(otherWinner!.nickname);
  await expect(pages.get(otherWinner!.nickname)!.getByTestId('opponent-name')).toHaveText('host');
  await expect(host.getByTestId('end-screen')).toHaveCount(0); // still playing

  // Final duel.
  await stealOpponent(host, byId(otherWinner!.id));

  // Final standings everywhere.
  await expect(host.getByTestId('end-headline')).toHaveText('You win!', { timeout: 10_000 });
  await expect(host.getByTestId('end-reason')).toHaveText('Last one standing');
  await expect(host.getByTestId('standings').locator('li')).toHaveCount(4);
  for (const g of guests) {
    await expect(g.getByTestId('end-headline')).toHaveText('You lose');
    await expect(g.getByTestId('end-place')).toContainText('of 4');
  }
  await expect(late.getByTestId('standings')).toBeVisible();
  await expect(late.getByTestId('waiting-rematch')).toContainText('next match');
  await expect(host.getByTestId('next-match-size')).toContainText('5 players');

  // Rematch: the late arrival is now a player — 5 players → two duels, one player waits.
  await host.getByTestId('rematch').click();
  await waitForPlay(host, ...guests, late);
  await expect(host.getByTestId('arena-bar')).toContainText('5 alive');
  roster = await hostPlayers(host);
  expect(roster.filter((p) => !p.targetId)).toHaveLength(1);
  for (const p of roster.filter((q) => q.targetId)) expect(byId(p.targetId).targetId).toBe(p.id);
});

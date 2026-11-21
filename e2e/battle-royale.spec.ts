import { expect, test, type Browser, type Page } from '@playwright/test';
import { createRoom, hostRoster, joinRoom, newPlayer, typeWord, waitForPlay, type HostPlayer } from './helpers';

/**
 * Battle royale end to end: host caps the room at 10, starts with only 4 players (no need to fill
 * the room), a 5th person arrives mid-match and can only spectate, the host knocks players out one
 * by one (the match continues after each steal), everyone gets final standings, and on Rematch the
 * late arrival joins as a player.
 */

async function newPage(browser: Browser): Promise<Page> {
  return (await newPlayer(browser)).page;
}

async function hostPlayers(host: Page): Promise<HostPlayer[]> {
  return (await hostRoster(host)).players;
}

test('battle royale: start below the cap, late joiner spectates, eliminations, standings, late joiner plays the rematch', async ({
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

  const guests: Page[] = [];
  for (const name of ['bea', 'cal', 'dee']) {
    const g = await newPage(browser);
    await joinRoom(g, code, name);
    await expect(g.getByTestId('waiting-host')).toBeVisible();
    await expect(g.getByTestId('player-cap')).toHaveCount(0); // the cap control is host-only
    guests.push(g);
  }
  await expect(host.getByTestId('player-list')).toContainText('dee');
  // 4 of 10 — the room does not need to be full to start.
  await expect(host.getByTestId('start-hint')).toContainText('4 players ready');
  await expect(host.getByTestId('start-game')).toBeEnabled();
  await host.getByTestId('start-game').click();
  await waitForPlay(host, ...guests);
  await expect(host.getByTestId('arena-bar')).toContainText('4 alive');

  // Each player has their OWN shortlist of up to 3 opponents to choose from (here: the 3 others).
  for (const p of [host, ...guests]) await expect(p.getByTestId('target-option')).toHaveCount(3);
  {
    const players = await hostPlayers(host);
    const me = players.find((p) => p.nickname === 'host')!;
    const pick = me.targetOptions!.find((id) => id !== me.targetId)!;
    const pickName = players.find((p) => p.id === pick)!.nickname;
    await host.getByTestId('target-option').filter({ hasText: pickName }).click(); // choose whom to attack
    await expect(host.getByTestId(`board-${pick}`)).toBeVisible(); // their board is shown
    await expect(host.getByTestId('mode-steal')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await hostPlayers(host)).find((p) => p.nickname === 'host')!.targetId).toBe(pick); // referee knows
    await host.keyboard.press('Escape');
  }

  // A 5th person arrives mid-match → spectates (arena grid of all 4 boards).
  const late = await newPage(browser);
  await joinRoom(late, code, 'eve');
  await expect(late.getByTestId('arena-grid')).toBeVisible();
  await expect(late.locator('[data-testid^="mini-"]')).toHaveCount(4);

  // The host steals target after target. After each knock-out the match continues.
  const byName = new Map<string, Page>([['bea', guests[0]!], ['cal', guests[1]!], ['dee', guests[2]!]]);
  for (let round = 1; round <= 3; round++) {
    const players = await hostPlayers(host);
    const me = players.find((p) => p.nickname === 'host')!;
    const target = players.find((p) => p.id === me.targetId)!;
    expect(target.status).toBe('alive');
    await host.getByTestId(`board-${target.id}`).click();
    await expect(host.getByTestId('mode-steal')).toHaveAttribute('aria-pressed', 'true');
    await typeWord(host, target.secret);
    if (round < 3) {
      await expect(host.getByTestId('arena-bar')).toContainText(`${4 - round} alive`);
      await expect(host.getByTestId('end-screen')).toHaveCount(0); // still playing
      const victim = byName.get(target.nickname)!;
      await expect(victim.getByTestId('keyboard')).toBeVisible(); // knocked-out players keep watching
      await expect.poll(async () => (await hostPlayers(host)).find((p) => p.nickname === 'host')!.targetId).not.toBe(target.id);
    }
  }

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

  // Rematch: the late arrival is now a player.
  await host.getByTestId('rematch').click();
  await waitForPlay(host, ...guests, late);
  await expect(host.getByTestId('arena-bar')).toContainText('5 alive');
});

import { expect, type Browser, type Page } from '@playwright/test';

/**
 * Shared Playwright helpers (not a spec: Playwright only runs *.spec.ts).
 * Rooms are created with the `?debug=1&seed=N` test hooks: deterministic secrets, and
 * `window.__WR_HOST__` on the HOST page only (the host is the referee and holds the secrets anyway —
 * see ARCHITECTURE.md).
 */

/** A fresh browser context (its own sessionStorage → its own player identity) with one page. */
export async function newPlayer(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

/** Creates a room from the home page (with the debug hooks) and returns its 4-letter code. */
export async function createRoom(page: Page, { nickname = 'alice', seed = 42 } = {}): Promise<string> {
  await page.goto(`/?debug=1&seed=${seed}`);
  await page.getByTestId('nickname-input').fill(nickname);
  await page.getByTestId('create-room').click();
  await page.waitForURL(/\/room\/[A-Z]{4}/);
  const code = (await page.getByTestId('room-code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z]{4}$/);
  return code;
}

/** Opens the room link and gets through the nickname gate. Where the joiner lands is up to the caller to assert. */
export async function joinRoom(page: Page, code: string, nickname: string) {
  await page.goto(`/room/${code}`);
  await page.getByTestId('gate-nickname').fill(nickname);
  await page.getByTestId('gate-join').click();
}

/** The match timer only renders in PLAYING / OVERTIME, so this waits out the 3-2-1 countdown. */
export async function waitForPlay(...pages: Page[]) {
  for (const page of pages) {
    await expect(page.getByTestId('keyboard').or(page.getByText('Spectating'))).toBeVisible();
    await expect(page.getByTestId('timer').filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 });
  }
}

/** Types a word on the physical keyboard and submits it. */
export async function typeWord(page: Page, word: string) {
  await page.keyboard.type(word.toLowerCase(), { delay: 15 });
  await page.keyboard.press('Enter');
}

export interface HostPlayer {
  id: string;
  nickname: string;
  secret: string;
  status: string;
  targetId?: string;
  targetOptions?: string[];
}

/** The referee's private roster (incl. secrets), read through the HOST page's debug hook. */
export async function hostRoster(host: Page): Promise<{ hostId: string; players: HostPlayer[] }> {
  return host.evaluate(() => {
    const s = (window as unknown as { __WR_HOST__: { privateState: { hostId: string; players: HostPlayer[] } } }).__WR_HOST__
      .privateState;
    return {
      hostId: s.hostId,
      players: s.players.map((p) => ({
        id: p.id,
        nickname: p.nickname,
        secret: p.secret,
        status: p.status,
        targetId: p.targetId,
        targetOptions: p.targetOptions,
      })),
    };
  });
}

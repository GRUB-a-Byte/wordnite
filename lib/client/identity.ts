import { generatePlayerId } from './ids';

/**
 * Browser-session identity (FIX 7). The playerId lives in sessionStorage, so it survives a refresh
 * of the same tab (E-14) but two tabs are two different players (handy for local testing).
 * Nicknames live in localStorage (FR-1.1). Host status is a per-room sessionStorage claim (FR-1.3).
 */
const PID_KEY = 'wr:pid';
const NICK_KEY = 'wr:nick';
const hostKey = (code: string) => `wr:host:${code}`;
const seqKey = (code: string) => `wr:seq:${code}`;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function getPlayerId(): string {
  return safe(() => {
    let id = sessionStorage.getItem(PID_KEY);
    if (!id) {
      id = generatePlayerId();
      sessionStorage.setItem(PID_KEY, id);
    }
    return id;
  }, generatePlayerId());
}

export function getNickname(): string {
  return safe(() => localStorage.getItem(NICK_KEY) ?? '', '');
}

export function setNickname(nick: string): void {
  safe(() => localStorage.setItem(NICK_KEY, nick), undefined);
}

export function claimHost(code: string, playerId: string): void {
  safe(() => sessionStorage.setItem(hostKey(code), playerId), undefined);
}

export function isHostOf(code: string, playerId: string): boolean {
  return safe(() => sessionStorage.getItem(hostKey(code)) === playerId, false);
}

export function loadSeq(code: string): number {
  return safe(() => Number(sessionStorage.getItem(seqKey(code)) ?? 0) || 0, 0);
}

export function saveSeq(code: string, seq: number): void {
  safe(() => sessionStorage.setItem(seqKey(code), String(seq)), undefined);
}

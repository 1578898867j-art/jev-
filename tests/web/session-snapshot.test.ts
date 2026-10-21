import { describe, expect, it } from 'vitest';
import type { SessionView } from '../../packages/shared/src/contracts.js';
import { canApplySessionSnapshot } from '../../web/src/App.js';

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 'session-a',
    puzzle: { id: 'puzzle-a', version: '1', title: '故事', surface: '湯面', requiredClueCount: 2 },
    status: 'playing',
    revision: 1,
    discoveredClues: [],
    hintsUsed: 0,
    messages: [],
    ...overrides,
  };
}

describe('canApplySessionSnapshot', () => {
  it('rejects another session and an older revision', () => {
    expect(canApplySessionSnapshot(session(), session({ id: 'session-b', revision: 9 }))).toBe(false);
    expect(canApplySessionSnapshot(session({ revision: 4 }), session({ revision: 3 }))).toBe(false);
  });

  it('does not let a late playing snapshot rewind a completed session', () => {
    expect(canApplySessionSnapshot(
      session({ status: 'completed', revision: 5, solution: { text: '真相' } }),
      session({ status: 'playing', revision: 5 }),
    )).toBe(false);
    expect(canApplySessionSnapshot(
      session({ status: 'completed', revision: 5, solution: { text: '真相' } }),
      session({ status: 'left', revision: 6 }),
    )).toBe(true);
  });

  it('accepts a newer session revision and refuses to roll back an unlock', () => {
    expect(canApplySessionSnapshot(session(), session({ revision: 2 }))).toBe(true);
    expect(canApplySessionSnapshot(
      session({ status: 'unlocked', revision: 2 }),
      session({ status: 'playing', revision: 3 }),
    )).toBe(false);
  });
});

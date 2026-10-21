import { describe, expect, it } from 'vitest';
import {
  emptyRetryAfterState,
  isRetryAfterActive,
  parseRetryAfterDeadline,
  withRetryAfter,
} from '../../web/src/retry-policy.js';

describe('Retry-After client gate', () => {
  it('parses both delay-seconds and HTTP dates', () => {
    expect(parseRetryAfterDeadline('2', 1_000)).toBe(3_000);
    expect(parseRetryAfterDeadline('Thu, 01 Jan 1970 00:00:05 GMT', 1_000)).toBe(5_000);
    expect(parseRetryAfterDeadline('not-a-date', 1_000)).toBeUndefined();
    expect(parseRetryAfterDeadline('-1', 1_000)).toBeUndefined();
  });

  it('blocks through the deadline, then allows retry and starts a new session clean', () => {
    const active = withRetryAfter(emptyRetryAfterState(), 5_000);
    expect(isRetryAfterActive(active, 4_999)).toBe(true);
    expect(isRetryAfterActive(active, 5_000)).toBe(false);

    const newSession = emptyRetryAfterState();
    expect(newSession.blockedUntil).toBeNull();
    expect(isRetryAfterActive(newSession, 4_999)).toBe(false);
  });

  it('keeps a later existing rate limit instead of shortening it', () => {
    const active = withRetryAfter({ blockedUntil: 8_000 }, 5_000);
    expect(active.blockedUntil).toBe(8_000);
  });
});

export type RetryAfterState = { blockedUntil: number | null };

export function emptyRetryAfterState(): RetryAfterState {
  return { blockedUntil: null };
}

export function parseRetryAfterDeadline(value: string | null, now = Date.now()): number | undefined {
  const header = value?.trim();
  if (!header) return undefined;

  if (/^\d+$/.test(header)) {
    return now + Number(header) * 1000;
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(header)) return undefined;

  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp) ? Math.max(now, timestamp) : undefined;
}

export function withRetryAfter(state: RetryAfterState, deadline: number): RetryAfterState {
  if (!Number.isFinite(deadline)) return state;
  return { blockedUntil: Math.max(state.blockedUntil ?? 0, deadline) };
}

export function isRetryAfterActive(state: RetryAfterState, now = Date.now()): boolean {
  return state.blockedUntil !== null && state.blockedUntil > now;
}

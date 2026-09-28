export const DEFAULT_FTP_POLL_INTERVAL_MINUTES = 15;
const MAX_FTP_POLL_INTERVAL_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;

export function resolveFtpPollIntervalMs(configuredValue: string | undefined): number {
  const value = configuredValue?.trim();
  if (!value) return DEFAULT_FTP_POLL_INTERVAL_MINUTES * MINUTE_MS;

  if (!/^\d+$/.test(value)) {
    throw new Error("SERVICE_DESK_FTP_POLL_INTERVAL_MINUTES must be a whole number of minutes");
  }

  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_FTP_POLL_INTERVAL_MINUTES) {
    throw new Error(`SERVICE_DESK_FTP_POLL_INTERVAL_MINUTES must be between 1 and ${MAX_FTP_POLL_INTERVAL_MINUTES}`);
  }

  return minutes * MINUTE_MS;
}

export function startFtpPolling(
  run: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
  scheduleInterval: typeof setInterval = setInterval,
): ReturnType<typeof setInterval> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("FTP polling interval must be a positive integer number of milliseconds");
  }

  const timer = scheduleInterval(() => {
    try {
      void Promise.resolve(run()).catch(onError);
    } catch (error) {
      onError(error);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export function createNonOverlappingRunner() {
  let inFlight = false;

  return async function runNonOverlapping<T>(
    operation: () => Promise<T>,
  ): Promise<{ locked: true } | { locked: false; value: T }> {
    if (inFlight) return { locked: true };
    inFlight = true;
    try {
      return { locked: false, value: await operation() };
    } finally {
      inFlight = false;
    }
  };
}
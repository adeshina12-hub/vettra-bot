/**
 * Shared fetch wrapper for the keyless market/security APIs. An unbounded
 * fetch inside a Telegram handler leaves the user staring at "scanning..."
 * until Telegraf itself gives up, so every call here is time-boxed.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

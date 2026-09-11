import { config } from "../config.js";
import { fetchWithTimeout } from "./http.js";

/**
 * Shared OpenSea API v2 client for the NFT scanners.
 *
 * Per-collection endpoints (stats, metadata) work without an API key. The
 * /collections LISTING endpoint does not — with a key it becomes the discovery
 * source for the emerging-collection search; without one, only scanners that
 * work from a known slug list can run.
 */

const OPENSEA_BASE = "https://api.opensea.io/api/v2";

export interface OpenSeaStats {
  total?: {
    volume?: number;
    sales?: number;
    num_owners?: number;
    floor_price?: number;
    /** Not always ETH — Robinhood Chain quotes in USDG, for example. */
    floor_price_symbol?: string;
    volume_symbol?: string;
  };
  intervals?: Array<{ interval: string; volume?: number; sales?: number }>;
}

export interface OpenSeaCollection {
  collection?: string;
  name?: string;
  description?: string;
  image_url?: string;
  opensea_url?: string;
  project_url?: string;
  discord_url?: string;
  twitter_username?: string;
  safelist_status?: string;
  category?: string;
  is_disabled?: boolean;
  is_nsfw?: boolean;
  created_date?: string;
  total_supply?: number;
  contracts?: Array<{ address?: string; chain?: string }>;
}

export function hasOpenSeaKey(): boolean {
  return Boolean(config.opensea.apiKey);
}

function headers(): Record<string, string> {
  const value: Record<string, string> = { Accept: "application/json" };
  if (config.opensea.apiKey) value["X-API-KEY"] = config.opensea.apiKey;
  return value;
}

/**
 * Retries only throttling and transient server errors.
 *
 * Note on 401: OpenSea returns it both for a slug that does not exist and for
 * keyless requests it decides to refuse, and the same slug that 401s on one
 * run answers 200 on the next. Retrying it inline was measured to make things
 * worse (more refusals, 4x the runtime) — pressure is the trigger, so 401 is
 * treated as terminal for that slug.
 */
export async function openseaJson<T>(path: string, label: string, init: RequestInit = {}): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(`${OPENSEA_BASE}${path}`, {
        ...init,
        headers: { ...headers(), ...(init.body ? { "Content-Type": "application/json" } : {}) },
      });
      if (response.ok) return (await response.json()) as T;
      if (response.status !== 429 && response.status < 500) return null;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`[opensea] ${label} lookup failed:`, String(err));
        return null;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
  }
  return null;
}

export function fetchStats(slug: string): Promise<OpenSeaStats | null> {
  return openseaJson<OpenSeaStats>(`/collections/${slug}/stats`, `stats:${slug}`);
}

export function fetchCollection(slug: string): Promise<OpenSeaCollection | null> {
  return openseaJson<OpenSeaCollection>(`/collections/${slug}`, `collection:${slug}`);
}

/**
 * Lists collections. Requires an API key. `order_by: "seven_day_volume"`
 * surfaces what is actually trading right now, which is the pool the
 * emerging-collection search filters down.
 */
export async function listCollections(options: {
  chain?: string;
  orderBy?: "seven_day_volume" | "created_date" | "market_cap" | "num_owners";
  limit?: number;
  next?: string;
}): Promise<{ collections: OpenSeaCollection[]; next?: string }> {
  const params = new URLSearchParams({
    chain: options.chain ?? "ethereum",
    order_by: options.orderBy ?? "seven_day_volume",
    limit: String(Math.min(options.limit ?? 100, 100)),
  });
  if (options.next) params.set("next", options.next);

  const payload = await openseaJson<{ collections?: OpenSeaCollection[]; next?: string }>(
    `/collections?${params}`,
    "collections listing"
  );
  return { collections: payload?.collections ?? [], next: payload?.next };
}

/** Splits an OpenSea stats payload into the intervals the scanners care about. */
export function readIntervals(stats: OpenSeaStats): {
  oneDay: { volume: number; sales: number };
  sevenDay: { volume: number; sales: number };
  thirtyDay: { volume: number; sales: number };
} {
  const map = Object.fromEntries((stats.intervals ?? []).map((item) => [item.interval, item]));
  const read = (key: string) => ({
    volume: map[key]?.volume ?? 0,
    sales: map[key]?.sales ?? 0,
  });
  return { oneDay: read("one_day"), sevenDay: read("seven_day"), thirtyDay: read("thirty_day") };
}

/**
 * Takes `count` items starting at `offset`, wrapping around the end.
 *
 * The scanners rank far more collections than any single reply shows, so
 * without this a user scanning repeatedly sees the identical top 5 forever.
 * Callers advance the offset between calls to page through the whole ranked
 * list and then cycle.
 */
export function sliceRotating<T>(items: T[], offset: number, count: number): T[] {
  if (items.length === 0) return [];
  const size = Math.min(count, items.length);
  const start = ((offset % items.length) + items.length) % items.length;
  return Array.from({ length: size }, (_, index) => items[(start + index) % items.length]);
}

/**
 * Runs `worker` over `items` with bounded concurrency — an unbounded burst of
 * 100+ parallel requests is a good way to get rate limited.
 */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const queue = [...items];
  const results: R[] = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) return;
        results.push(await worker(item));
      }
    })
  );
  return results;
}

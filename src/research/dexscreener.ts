import { fetchWithTimeout } from "./http.js";

/**
 * DexScreener token lookup — keyless and covers every DEX-traded token on
 * ~30 chains, which is exactly the surface meme coins live on (they are
 * almost never on CoinGecko early, so the CoinGecko resolver used by the
 * main research pipeline is useless for them).
 */

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  txns?: Partial<Record<"m5" | "h1" | "h6" | "h24", { buys: number; sells: number }>>;
  volume?: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  priceChange?: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url?: string; label?: string }>;
    socials?: Array<{ url?: string; type?: string }>;
  };
}

const TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens";
const CACHE_MS = 60_000;

const pairCache = new Map<string, { expiresAt: number; pairs: DexScreenerPair[] }>();

/**
 * Returns every pair where `address` is the BASE token, sorted by liquidity.
 * Base-only matters: DexScreener also returns pairs where the address is the
 * quote asset, and in those `priceUsd`/`marketCap` describe the *other*
 * token — reading them would report a completely wrong price.
 */
export async function fetchTokenPairs(address: string): Promise<DexScreenerPair[]> {
  const key = address.toLowerCase();
  const cached = pairCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.pairs;

  let response: Response;
  try {
    response = await fetchWithTimeout(`${TOKENS_URL}/${encodeURIComponent(address)}`, {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    throw new Error(`DexScreener is unreachable right now (${String(err)})`);
  }
  if (!response.ok) throw new Error(`DexScreener lookup failed: ${response.status}`);

  const payload = (await response.json()) as { pairs?: DexScreenerPair[] | null };
  const all = payload.pairs ?? [];
  const basePairs = all
    .filter((pair) => pair.baseToken?.address?.toLowerCase() === key)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

  if (basePairs.length === 0 && all.length > 0) {
    throw new Error("This address only trades as a quote asset (e.g. WETH/USDC), not as a meme token.");
  }

  pairCache.set(key, { expiresAt: Date.now() + CACHE_MS, pairs: basePairs });
  return basePairs;
}

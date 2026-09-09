import { fetchWithTimeout } from "./http.js";
import type { MemeSecuritySnapshot } from "../types.js";

/**
 * Contract-safety lookup via GoPlus Security (keyless, free tier).
 *
 * This is the half of meme-coin due diligence that price charts cannot
 * show: honeypots, unlocked LP, live mint/freeze authorities, and holder
 * concentration. Everything here degrades to `undefined` rather than
 * throwing — a missing safety field must read as "unknown", never as "safe".
 */

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const CACHE_MS = 3 * 60_000;

// DexScreener chain slug -> GoPlus chain id. Chains absent here simply skip
// the security pass (the report says so) instead of failing the whole scan.
const GOPLUS_CHAIN_IDS: Record<string, string> = {
  ethereum: "1",
  bsc: "56",
  polygon: "137",
  arbitrum: "42161",
  optimism: "10",
  avalanche: "43114",
  base: "8453",
  cronos: "25",
  zksync: "324",
  linea: "59144",
  mantle: "5000",
  scroll: "534352",
  opbnb: "204",
  berachain: "80094",
  sonic: "146",
  unichain: "130",
  abstract: "2741",
  soneium: "1868",
  story: "1514",
  monad: "143",
  worldchain: "480",
  gnosis: "100",
  tron: "tron",
  solana: "solana",
};

const BURN_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "0x0000000000000000000000000000000000000001",
  "11111111111111111111111111111111",
]);

const LOCKED_TAG = /lock|burn|dead|vesting|timelock/i;
const POOL_TAG = /pool|pair|lp|amm|dex|router|bonding/i;

const securityCache = new Map<string, { expiresAt: number; value: MemeSecuritySnapshot | null }>();

export function supportsSecurityCheck(chain: string): boolean {
  return chain.toLowerCase() in GOPLUS_CHAIN_IDS;
}

interface GoPlusHolder {
  address?: string;
  account?: string;
  tag?: string;
  percent?: string | number;
  is_locked?: number;
  is_contract?: number;
}

/**
 * @param poolAddresses pair addresses from DexScreener — excluded from the
 * top-10 holder figure, since liquidity sitting in an AMM pool is not a
 * whale who can dump on you.
 */
export async function fetchTokenSecurity(
  chain: string,
  address: string,
  poolAddresses: string[] = []
): Promise<MemeSecuritySnapshot | null> {
  const chainId = GOPLUS_CHAIN_IDS[chain.toLowerCase()];
  if (!chainId) return null;

  const cacheKey = `${chainId}:${address.toLowerCase()}`;
  const cached = securityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const excluded = new Set(poolAddresses.map((item) => item.toLowerCase()));
  let value: MemeSecuritySnapshot | null = null;

  try {
    const path = chainId === "solana"
      ? `/solana/token_security?contract_addresses=${encodeURIComponent(address)}`
      : `/token_security/${chainId}?contract_addresses=${encodeURIComponent(address)}`;
    const response = await fetchWithTimeout(`${GOPLUS_BASE}${path}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`status ${response.status}`);

    const payload = (await response.json()) as { code?: number; result?: Record<string, any> };
    // GoPlus keys the result by the address, lowercased on EVM but
    // case-preserved on Solana, so match case-insensitively.
    const entry = Object.entries(payload.result ?? {}).find(
      ([key]) => key.toLowerCase() === address.toLowerCase()
    )?.[1];
    if (entry) {
      value = chainId === "solana" ? parseSolana(entry, excluded) : parseEvm(entry, excluded);
    }
  } catch (err) {
    console.warn(`[meme] GoPlus security lookup failed for ${address} on ${chain}:`, String(err));
    value = null;
  }

  securityCache.set(cacheKey, { expiresAt: Date.now() + CACHE_MS, value });
  return value;
}

function parseEvm(data: any, excluded: Set<string>): MemeSecuritySnapshot {
  const owner = String(data.owner_address ?? "").toLowerCase();
  return {
    source: "goplus",
    honeypot: flag(data.is_honeypot),
    buyTaxPct: pct(data.buy_tax),
    sellTaxPct: pct(data.sell_tax),
    // A zero/burn owner (or no owner at all) means renounced — nobody can
    // flip taxes or pause transfers after you buy.
    ownerRenounced: data.owner_address === undefined ? undefined : owner === "" || BURN_ADDRESSES.has(owner),
    mintable: flag(data.is_mintable),
    transferPausable: flag(data.transfer_pausable),
    blacklistable: flag(data.is_blacklisted),
    proxy: flag(data.is_proxy),
    openSource: flag(data.is_open_source),
    holderCount: num(data.holder_count),
    top10HolderPct: topHolderPct(data.holders, excluded, (h) => h.address),
    lpLockedOrBurnedPct: lpLockedPct(data.lp_holders),
  };
}

function parseSolana(data: any, excluded: Set<string>): MemeSecuritySnapshot {
  return {
    source: "goplus",
    // Solana SPL tokens have no honeypot/tax mechanics in the EVM sense;
    // the equivalent kill-switches are the mint and freeze authorities.
    mintable: authorityActive(data.mintable),
    freezable: authorityActive(data.freezable),
    metadataMutable: authorityActive(data.metadata_mutable),
    buyTaxPct: pct(data.transfer_fee?.transfer_fee_percent ?? data.transfer_fee?.fee_rate),
    sellTaxPct: pct(data.transfer_fee?.transfer_fee_percent ?? data.transfer_fee?.fee_rate),
    holderCount: num(data.holder_count),
    top10HolderPct: topHolderPct(data.holders, excluded, (h) => h.account ?? h.address),
    lpLockedOrBurnedPct: solanaLpBurnedPct(data.dex),
  };
}

function topHolderPct(
  holders: unknown,
  excluded: Set<string>,
  addressOf: (holder: GoPlusHolder) => string | undefined
): number | undefined {
  if (!Array.isArray(holders) || holders.length === 0) return undefined;
  let total = 0;
  for (const holder of holders.slice(0, 10) as GoPlusHolder[]) {
    const address = (addressOf(holder) ?? "").toLowerCase();
    if (excluded.has(address) || BURN_ADDRESSES.has(address)) continue;
    if (holder.is_locked === 1) continue;
    const tag = holder.tag ?? "";
    if (LOCKED_TAG.test(tag) || POOL_TAG.test(tag)) continue;
    total += num(holder.percent) ?? 0;
  }
  return total * 100;
}

function lpLockedPct(lpHolders: unknown): number | undefined {
  if (!Array.isArray(lpHolders) || lpHolders.length === 0) return undefined;
  let locked = 0;
  for (const holder of lpHolders as GoPlusHolder[]) {
    const address = (holder.address ?? "").toLowerCase();
    const isLocked = holder.is_locked === 1 || BURN_ADDRESSES.has(address) || LOCKED_TAG.test(holder.tag ?? "");
    if (isLocked) locked += num(holder.percent) ?? 0;
  }
  return locked * 100;
}

/** Solana has no LP-token holder list; GoPlus reports a per-pool burn share instead. */
function solanaLpBurnedPct(dex: unknown): number | undefined {
  if (!Array.isArray(dex) || dex.length === 0) return undefined;
  const burns = dex
    .map((pool: any) => num(pool?.burn_percent))
    .filter((value): value is number => typeof value === "number");
  return burns.length ? Math.max(...burns) : undefined;
}

function authorityActive(field: unknown): boolean | undefined {
  if (!field || typeof field !== "object") return undefined;
  const status = (field as { status?: string | number }).status;
  if (status === undefined) return undefined;
  return String(status) === "1";
}

function flag(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value) === "1";
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** GoPlus returns taxes and shares as fractions ("0.05" = 5%). */
function pct(value: unknown): number | undefined {
  const parsed = num(value);
  return parsed === undefined ? undefined : parsed * 100;
}

import { fetchStats, hasOpenSeaKey, listCollections, mapLimit, readIntervals, sliceRotating } from "./opensea.js";

/**
 * Emerging NFT search — collections that are early but already showing real
 * traction, the mirror image of the dormant scanner.
 *
 * Discovery uses OpenSea's collection listing ordered by seven-day volume,
 * which surfaces what is actually trading right now rather than what was big
 * in 2021. That pool is then filtered down to collections that are still
 * EARLY (low lifetime volume — the run has not happened yet) and ACCELERATING
 * (recent daily trade rate above their own 30-day rate).
 *
 * The filters exist because that raw pool is full of single-sale art pieces:
 * a 1-of-1 selling once for 15 ETH shows perfect "momentum" and 1 owner. Real
 * traction means many sales across many wallets.
 */

const SCAN_CACHE_MS = 15 * 60_000;
const CANDIDATE_POOL = 100;

export interface EmergingNftCollection {
  slug: string;
  name: string;
  openseaUrl: string;
  lifetimeVolumeEth: number;
  floorPriceEth?: number;
  owners: number;
  totalSupply?: number;
  volume7dEth: number;
  sales7d: number;
  volume24hEth: number;
  sales24h: number;
  volume30dEth: number;
  /** Last-7-day daily trade rate vs the 30-day daily rate. >1 = accelerating. */
  momentum: number;
  /** 0-100 composite of momentum, traction, distribution and how early it is. */
  potentialScore: number;
  verified: boolean;
  summary: string;
  twitterHandle?: string;
  twitterUrl?: string;
  website?: string;
  discord?: string;
  category?: string;
}

export interface EmergingNftScanResult {
  collections: EmergingNftCollection[];
  scanned: number;
  qualified: number;
  maxLifetimeVolumeEth: number;
  minSales7d: number;
}

let scanCache: { expiresAt: number; result: EmergingNftScanResult } | null = null;

export async function findEmergingNftCollections(
  limit = 5,
  options: {
    maxLifetimeVolumeEth?: number;
    minSales7d?: number;
    minOwners?: number;
    minVolume7dEth?: number;
    offset?: number;
  } = {}
): Promise<EmergingNftScanResult> {
  // Above this a collection has already had its run — it is no longer "early".
  const maxLifetimeVolumeEth = options.maxLifetimeVolumeEth ?? 5_000;
  // The single most important junk filter: kills 1-of-1 art and wash trades.
  const minSales7d = options.minSales7d ?? 25;
  const minOwners = options.minOwners ?? 50;
  const minVolume7dEth = options.minVolume7dEth ?? 0.5;
  const offset = options.offset ?? 0;

  if (scanCache && scanCache.expiresAt > Date.now()) {
    return { ...scanCache.result, collections: sliceRotating(scanCache.result.collections, offset, Math.max(1, limit)) };
  }

  if (!hasOpenSeaKey()) {
    throw new Error("NFT search needs an OpenSea API key. Set OPENSEA_API_KEY in the backend environment.");
  }

  const { collections } = await listCollections({ orderBy: "seven_day_volume", limit: CANDIDATE_POOL });
  const candidates = collections.filter((item) => item.collection && !item.is_disabled && !item.is_nsfw);
  if (candidates.length === 0) {
    throw new Error("OpenSea returned no collections to scan. Check the API key and try again.");
  }

  const rows = await mapLimit(candidates, 5, async (item): Promise<EmergingNftCollection | null> => {
    const slug = item.collection!;
    const stats = await fetchStats(slug);
    if (!stats?.total) return null;

    const { oneDay, sevenDay, thirtyDay } = readIntervals(stats);
    const lifetimeVolumeEth = stats.total.volume ?? 0;
    const owners = stats.total.num_owners ?? 0;
    const floorPriceEth = stats.total.floor_price;

    // A collection trading its entire 30-day volume inside the last 7 days
    // maxes this out at 30/7 — that is a brand-new launch, the strongest
    // "early" signal available without a reliable creation date.
    const momentum = thirtyDay.volume > 0 ? (sevenDay.volume / 7) / (thirtyDay.volume / 30) : 0;

    return {
      slug,
      name: item.name || slug,
      openseaUrl: item.opensea_url || `https://opensea.io/collection/${slug}`,
      lifetimeVolumeEth,
      floorPriceEth,
      owners,
      totalSupply: item.total_supply,
      volume7dEth: sevenDay.volume,
      sales7d: sevenDay.sales,
      volume24hEth: oneDay.volume,
      sales24h: oneDay.sales,
      volume30dEth: thirtyDay.volume,
      momentum,
      potentialScore: 0, // set below, once all rows are known
      verified: item.safelist_status === "verified" || item.safelist_status === "approved",
      summary: "",
      twitterHandle: item.twitter_username || undefined,
      twitterUrl: item.twitter_username ? `https://x.com/${item.twitter_username}` : undefined,
      website: item.project_url || undefined,
      discord: item.discord_url || undefined,
      category: item.category || undefined,
    };
  });

  const scanned = rows.filter((row): row is EmergingNftCollection => row !== null);

  const qualified = scanned
    .filter((row) =>
      row.lifetimeVolumeEth > 0 &&
      row.lifetimeVolumeEth <= maxLifetimeVolumeEth &&
      row.sales7d >= minSales7d &&
      row.owners >= minOwners &&
      row.volume7dEth >= minVolume7dEth &&
      (row.floorPriceEth ?? 0) > 0
    )
    .map((row) => ({
      ...row,
      potentialScore: potentialFrom(row),
      summary: summarize(row),
    }))
    .sort((a, b) => b.potentialScore - a.potentialScore);

  const result: EmergingNftScanResult = {
    collections: qualified,
    scanned: scanned.length,
    qualified: qualified.length,
    maxLifetimeVolumeEth,
    minSales7d,
  };

  scanCache = { expiresAt: Date.now() + SCAN_CACHE_MS, result };
  return { ...result, collections: sliceRotating(qualified, offset, Math.max(1, limit)) };
}

/**
 * Composite of four independent signals, so no single one can carry a
 * collection: is it speeding up, are people actually trading it, is it held
 * broadly, and is it still early enough to matter.
 */
function potentialFrom(row: EmergingNftCollection): number {
  // Acceleration: 1.0 (steady) scores 0, 3.0+ (most volume in the last week) maxes.
  const momentum = scale(row.momentum, 1, 3) * 30;

  // Traction: 25 sales in 7d scores 0, 2000+ maxes. Log-scaled — the gap
  // between 25 and 250 sales matters far more than 2000 vs 4000.
  const traction = scaleLog(row.sales7d, 25, 2_000) * 25;

  // Distribution: a wide holder base is harder to fake than volume.
  const distribution = scaleLog(row.owners, 50, 3_000) * 20;

  // Earliness: the lower the lifetime volume, the more room ahead of it.
  const earliness = (1 - scaleLog(row.lifetimeVolumeEth, 5, 5_000)) * 15;

  // Still alive today — momentum from a spike that already died is worthless.
  const alive = row.sales24h > 0 ? 5 : 0;
  const credible = row.verified ? 3 : 0;
  const reachable = row.twitterHandle || row.website ? 2 : 0;

  return clamp(momentum + traction + distribution + earliness + alive + credible + reachable);
}

function summarize(row: EmergingNftCollection): string {
  const pace = row.momentum >= 2.5
    ? "almost all of its volume traded in the last week"
    : row.momentum >= 1.5
      ? `trading ${row.momentum.toFixed(1)}x faster than its 30-day pace`
      : "holding a steady pace";
  return `${row.sales7d.toLocaleString()} sales across ${row.owners.toLocaleString()} owners in 7 days — ${pace}. Lifetime volume is still only ${row.lifetimeVolumeEth.toFixed(0)} ETH.`;
}

/** Linear 0-1 position of `value` between `low` and `high`. */
function scale(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

/** Log-scaled 0-1 position, for quantities that span orders of magnitude. */
function scaleLog(value: number, low: number, high: number): number {
  const safe = Math.max(value, low);
  return Math.max(0, Math.min(1, (Math.log(safe) - Math.log(low)) / (Math.log(high) - Math.log(low))));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

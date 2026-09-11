import { fetchCoinGecko } from "./coingecko.js";
import { fetchCollection, fetchStats, hasOpenSeaKey, mapLimit, readIntervals, sliceRotating } from "./opensea.js";

/**
 * Dormant blue-chip NFT scanner.
 *
 * Finds collections that once traded enormous volume on OpenSea but have
 * gone quiet, and returns the X handle / website so you can check whether
 * the team is still around. OpenSea's per-collection endpoints work without
 * an API key (the listing endpoint does not, which is why the candidate
 * universe below is a curated seed list rather than a live query).
 *
 * Dormancy is measured as the share of a collection's LIFETIME volume that
 * traded in the last 30 days. That avoids needing each collection's launch
 * date, and it self-normalizes: a collection trading its usual amount scores
 * a high share, one that has flatlined scores near zero.
 */

const SCAN_CACHE_MS = 30 * 60_000;

// Verified against the live API — every slug here returns stats. OpenSea
// answers 401 (not 404) for a slug that does not exist, so unverified
// guesses would read as auth failures.
// Wrapper/utility contracts (wrapped-cryptopunks, clonex-mintvial) are
// deliberately absent: they show enormous lifetime volume and zero recent
// trades, but they have no team, no socials, and no one to check up on.
const SEED_COLLECTIONS = [
  "boredapeyachtclub", "mutant-ape-yacht-club", "bored-ape-kennel-club", "cryptopunks",
  "azuki", "beanzofficial", "doodles-official", "clonex", "moonbirds", "moonbirds-oddities",
  "pudgypenguins", "lilpudgys", "pudgyrods", "otherdeed", "otherdeed-expanded", "cool-cats-nft",
  "world-of-women-nft", "world-of-women-galaxy", "veefriends", "meebits", "cyberkongz", "hashmasks",
  "0n1-force", "deadfellaz", "mfers", "goblintownwtf", "invisiblefriends", "chromie-squiggle-by-snowfro",
  "ringers-by-dmitri-cherniak", "terraforms", "nouns", "sappy-seals", "chimpersnft", "degods-eth",
  "guttercatgang", "alienfrensnft", "opepen-edition", "renga", "digidaigaku", "karafuru",
  "forgottenruneswizardscult", "milady", "remilio-babies", "schizoposters", "thecurrency", "flyfish-club",
  "vv-checks-originals", "genuine-undead", "nakamigos", "psychedelics-anonymous-genesis", "hapeprime",
  "impostors-genesis-aliens", "pixelmongen1", "dourdarcels",
];

export interface DormantNftCollection {
  slug: string;
  name: string;
  openseaUrl: string;
  lifetimeVolumeEth: number;
  lifetimeSales: number;
  floorPriceEth?: number;
  owners?: number;
  volume30dEth: number;
  sales30d: number;
  volume24hEth: number;
  sales24h: number;
  /** Share of lifetime volume traded in the last 30 days (1 = 100%). */
  recentShare: number;
  /** 0-100, higher = quieter relative to its own history. */
  dormancyScore: number;
  /** 0-100, based on lifetime volume. */
  prominenceScore: number;
  rankScore: number;
  summary: string;
  /** Whether socials/website have already been fetched for this row. */
  enriched?: boolean;
  twitterHandle?: string;
  twitterUrl?: string;
  website?: string;
  discord?: string;
  createdDate?: string;
  totalSupply?: number;
  contractAddress?: string;
  /** How far the floor sits below its all-time high, from CoinGecko. */
  athChangePct?: number;
  floor1yChangePct?: number;
}

export interface DormantNftScanResult {
  collections: DormantNftCollection[];
  scanned: number;
  qualified: number;
  stillActive: number;
  minLifetimeVolumeEth: number;
  maxRecentSharePct: number;
}

let scanCache: { expiresAt: number; result: DormantNftScanResult } | null = null;

export async function findDormantNftCollections(
  limit = 5,
  options: { minLifetimeVolumeEth?: number; maxRecentShare?: number; minOwners?: number; offset?: number } = {}
): Promise<DormantNftScanResult> {
  const minLifetimeVolumeEth = options.minLifetimeVolumeEth ?? 10_000;
  const maxRecentShare = options.maxRecentShare ?? 0.001; // 0.1% of lifetime volume in 30d
  // Filters out derivative/utility contracts that look dormant but have no
  // real holder base to speak of.
  const minOwners = options.minOwners ?? 200;
  const offset = options.offset ?? 0;

  // The universe changes slowly and each scan is ~54 upstream calls, so the
  // ranked list is cached and only the presentation slice varies by `limit`.
  if (scanCache && scanCache.expiresAt > Date.now()) {
    return { ...scanCache.result, collections: await enrichTop(scanCache.result, limit, offset) };
  }

  const buildRow = async (slug: string): Promise<DormantNftCollection | null> => {
    const stats = await fetchStats(slug);
    if (!stats?.total) return null;
    const { oneDay, thirtyDay } = readIntervals(stats);

    const lifetimeVolumeEth = stats.total.volume ?? 0;
    const volume30dEth = thirtyDay.volume;
    if (lifetimeVolumeEth <= 0) return null;

    const recentShare = volume30dEth / lifetimeVolumeEth;
    const dormancyScore = dormancyFrom(recentShare);
    const prominenceScore = prominenceFrom(lifetimeVolumeEth);

    return {
      slug,
      name: slug,
      openseaUrl: `https://opensea.io/collection/${slug}`,
      lifetimeVolumeEth,
      lifetimeSales: stats.total.sales ?? 0,
      floorPriceEth: stats.total.floor_price,
      owners: stats.total.num_owners,
      volume30dEth,
      sales30d: thirtyDay.sales,
      volume24hEth: oneDay.volume,
      sales24h: oneDay.sales,
      recentShare,
      dormancyScore,
      prominenceScore,
      // Weighted toward dormancy, but a former giant outranks a mid-tier
      // collection at the same level of quiet.
      rankScore: Math.round(dormancyScore * 0.6 + prominenceScore * 0.4),
      summary: summarize(lifetimeVolumeEth, volume30dEth, thirtyDay.sales, recentShare),
    };
  };

  const rows = await mapLimit(SEED_COLLECTIONS, 4, buildRow);
  const scanned = rows.filter((row): row is DormantNftCollection => row !== null);

  // Keyless typically resolves ~45 of the ~54 seeds. The rest answer 401,
  // and measurably do NOT come back on retry (tried: inline backoff and a
  // slow second pass, both recovered nothing) — OpenSea gates a rotating
  // subset behind auth. Set OPENSEA_API_KEY to cover the full list.
  if (scanned.length < SEED_COLLECTIONS.length) {
    console.warn(
      `[nft] ${scanned.length}/${SEED_COLLECTIONS.length} collections resolved` +
      (hasOpenSeaKey() ? "" : " — set OPENSEA_API_KEY to reach the rest")
    );
  }
  const prominent = scanned.filter(
    (row) => row.lifetimeVolumeEth >= minLifetimeVolumeEth && (row.owners ?? 0) >= minOwners
  );
  const qualified = prominent
    .filter((row) => row.recentShare <= maxRecentShare)
    .sort((a, b) => b.rankScore - a.rankScore);

  const result: DormantNftScanResult = {
    collections: qualified,
    scanned: scanned.length,
    qualified: qualified.length,
    stillActive: prominent.length - qualified.length,
    minLifetimeVolumeEth,
    maxRecentSharePct: maxRecentShare * 100,
  };

  scanCache = { expiresAt: Date.now() + SCAN_CACHE_MS, result };
  return { ...result, collections: await enrichTop(result, limit, offset) };
}

/**
 * Socials/website are only fetched for the rows actually being shown —
 * enriching all 54 would triple the request count for data nobody reads.
 * Enriched rows are written back into the cached scan so repeat calls
 * (the common case, since the bot defaults to the same top 5) cost nothing.
 */
async function enrichTop(result: DormantNftScanResult, limit: number, offset: number): Promise<DormantNftCollection[]> {
  const slice = sliceRotating(result.collections, offset, Math.max(1, limit));
  const enriched = await mapLimit(slice, 4, async (row) => {
    if (row.enriched) return row;
    const detail = await fetchCollection(row.slug);
    const contractAddress = detail?.contracts?.find((contract) => contract.address)?.address;

    const withDetail: DormantNftCollection = {
      ...row,
      enriched: true,
      name: detail?.name || row.name,
      openseaUrl: detail?.opensea_url || row.openseaUrl,
      website: detail?.project_url || undefined,
      discord: detail?.discord_url || undefined,
      twitterHandle: detail?.twitter_username || undefined,
      twitterUrl: detail?.twitter_username ? `https://x.com/${detail.twitter_username}` : undefined,
      createdDate: detail?.created_date,
      totalSupply: detail?.total_supply,
      contractAddress,
    };

    // CoinGecko fills in how far the floor has fallen from its peak, and
    // backfills socials when OpenSea has none on file.
    if (contractAddress) {
      try {
        const cg = await fetchCoinGecko<{
          ath_change_percentage?: { native_currency?: number };
          floor_price_1y_percentage_change?: { native_currency?: number };
          links?: { homepage?: string; twitter?: string };
        }>(`/nfts/ethereum/contract/${contractAddress}`);
        withDetail.athChangePct = cg.ath_change_percentage?.native_currency;
        withDetail.floor1yChangePct = cg.floor_price_1y_percentage_change?.native_currency;
        if (!withDetail.website && cg.links?.homepage) withDetail.website = cg.links.homepage;
        if (!withDetail.twitterUrl && cg.links?.twitter) {
          withDetail.twitterUrl = cg.links.twitter;
          withDetail.twitterHandle = cg.links.twitter.split("/").filter(Boolean).pop();
        }
      } catch (err) {
        console.warn(`[nft] CoinGecko enrichment skipped for ${row.slug}:`, String(err));
      }
    }

    return withDetail;
  });

  // mapLimit does not preserve input order, so restore the ranked order and
  // write the enriched rows back into the cached scan.
  for (const row of enriched) {
    const index = result.collections.findIndex((item) => item.slug === row.slug);
    if (index >= 0) result.collections[index] = row;
  }
  return sliceRotating(result.collections, offset, Math.max(1, limit));
}

/** Log-scaled: 0.5% of lifetime volume in 30d = still trading (0), 0.02% = flatlined (100). */
function dormancyFrom(recentShare: number): number {
  const active = 0.005;
  const dead = 0.0002;
  const share = Math.max(recentShare, 1e-7);
  const ratio = (Math.log(active) - Math.log(share)) / (Math.log(active) - Math.log(dead));
  return clamp(ratio * 100);
}

/** Log-scaled: 10k ETH lifetime = 0, 1.5M ETH (CryptoPunks tier) = 100. */
function prominenceFrom(lifetimeVolumeEth: number): number {
  const floor = 10_000;
  const ceiling = 1_500_000;
  const ratio = (Math.log(Math.max(lifetimeVolumeEth, floor)) - Math.log(floor)) / (Math.log(ceiling) - Math.log(floor));
  return clamp(ratio * 100);
}

function summarize(lifetime: number, volume30d: number, sales30d: number, share: number): string {
  const pct = share * 100;
  const traded = volume30d < 0.01
    ? "nothing has traded in 30 days"
    : `only ${volume30d.toFixed(1)} ETH across ${sales30d} sale${sales30d === 1 ? "" : "s"} in 30 days`;
  return `Did ${Math.round(lifetime).toLocaleString()} ETH lifetime, ${traded} — ${pct < 0.01 ? "<0.01" : pct.toFixed(3)}% of its all-time volume.`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

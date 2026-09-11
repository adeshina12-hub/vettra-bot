import { fetchWithTimeout } from "./http.js";

/**
 * Upcoming NFT mints, scraped from mintdeck.fun on demand.
 *
 * Mint Deck is a Next.js app with no public JSON API (every /api/* guess
 * returns 404), but it server-renders the full listing, so the tiles are
 * parsed straight out of the HTML. Each tile carries name, chain, mint date,
 * supply, price, and the project's socials.
 *
 * The markup is someone else's and can change without warning, so parsing is
 * defensive throughout: a tile that no longer matches is skipped rather than
 * throwing, and an empty result reports "the page layout changed" instead of
 * pretending there are no upcoming mints.
 */

const MINTDECK_URL = "https://mintdeck.fun/";
const CACHE_MS = 10 * 60_000;

export interface UpcomingMint {
  name: string;
  chain?: string;
  /** As displayed: an actual date ("16/09"), "TBA", or similar. */
  mintDate: string;
  supply: string;
  price: string;
  /** True when the mint has a real date rather than TBA. */
  dated: boolean;
  twitterHandle?: string;
  twitterUrl?: string;
  website?: string;
  discord?: string;
  telegram?: string;
}

export interface UpcomingMintScanResult {
  mints: UpcomingMint[];
  total: number;
  dated: number;
  source: string;
  fetchedAt: string;
}

let cache: { expiresAt: number; result: UpcomingMintScanResult } | null = null;

export async function findUpcomingMints(
  limit = 5,
  options: { offset?: number; datedFirst?: boolean } = {}
): Promise<UpcomingMintScanResult> {
  const offset = options.offset ?? 0;
  const datedFirst = options.datedFirst ?? true;

  const all = await loadMints();
  // A mint with a real date is more actionable than one marked TBA, so those
  // lead — but TBAs still rotate into view rather than being dropped.
  const ordered = datedFirst
    ? [...all.mints].sort((a, b) => Number(b.dated) - Number(a.dated))
    : all.mints;

  return { ...all, mints: rotate(ordered, offset, limit) };
}

async function loadMints(): Promise<UpcomingMintScanResult> {
  if (cache && cache.expiresAt > Date.now()) return cache.result;

  let response: Response;
  try {
    response = await fetchWithTimeout(MINTDECK_URL, {
      headers: {
        // Without a browser-ish UA some hosts serve a challenge page instead.
        "User-Agent": "Mozilla/5.0 (compatible; VettraBot/1.0; +https://mintdeck.fun)",
        Accept: "text/html,application/xhtml+xml",
      },
    }, 15_000);
  } catch (err) {
    throw new Error(`Could not reach mintdeck.fun (${String(err)})`);
  }
  if (!response.ok) throw new Error(`mintdeck.fun returned ${response.status}`);

  const html = await response.text();
  const mints = parseMints(html);
  if (mints.length === 0) {
    throw new Error("No mints could be read from mintdeck.fun — the page layout may have changed.");
  }

  const result: UpcomingMintScanResult = {
    mints,
    total: mints.length,
    dated: mints.filter((mint) => mint.dated).length,
    source: MINTDECK_URL,
    fetchedAt: new Date().toISOString(),
  };
  cache = { expiresAt: Date.now() + CACHE_MS, result };
  return result;
}

export function parseMints(html: string): UpcomingMint[] {
  const mints: UpcomingMint[] = [];
  // Each listing is one <article class="tile">…</article>.
  const tiles = html.split('<article class="tile"').slice(1);

  for (const raw of tiles) {
    const tile = raw.slice(0, raw.indexOf("</article>") + 1 || undefined);
    const name = decode(match(tile, /<h3 class="tile__name">([^<]*)<\/h3>/));
    if (!name) continue;

    const mintDate = decode(stat(tile, "mint")) || "TBA";
    const socials = [...tile.matchAll(/<a class="social" href="([^"]+)"/g)].map((item) => item[1]);

    mints.push({
      name,
      chain: decode(match(tile, /<span class="chip">([^<]*)<\/span>/)) || undefined,
      mintDate,
      supply: decode(stat(tile, "supply")) || "TBA",
      price: decode(stat(tile, "price")) || "TBA",
      dated: !/^tba$/i.test(mintDate.trim()),
      ...readSocials(socials),
    });
  }

  return mints;
}

function readSocials(urls: string[]): Pick<UpcomingMint, "twitterHandle" | "twitterUrl" | "website" | "discord" | "telegram"> {
  const twitterUrl = urls.find((url) => /(?:^|\/\/)(?:www\.)?(?:x|twitter)\.com\//i.test(url));
  const discord = urls.find((url) => /discord\.(gg|com)/i.test(url));
  const telegram = urls.find((url) => /(?:t\.me|telegram\.)/i.test(url));
  const website = urls.find((url) => url !== twitterUrl && url !== discord && url !== telegram);
  return {
    twitterUrl,
    twitterHandle: twitterUrl ? twitterUrl.split("/").filter(Boolean).pop() : undefined,
    website,
    discord,
    telegram,
  };
}

/** Reads one of the three stat blocks (mint / supply / price) from a tile. */
function stat(tile: string, kind: "mint" | "supply" | "price"): string {
  const pattern = new RegExp(
    `class="stat stat--${kind}">\\s*<span class="stat__label">[^<]*</span>\\s*<span class="stat__value[^"]*">([^<]*)<`
  );
  return match(tile, pattern);
}

function match(source: string, pattern: RegExp): string {
  return source.match(pattern)?.[1]?.trim() ?? "";
}

/** The page emits numeric HTML entities (e.g. Noah&#x27;s Arc). */
function decode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function rotate<T>(items: T[], offset: number, count: number): T[] {
  if (items.length === 0) return [];
  const size = Math.min(count, items.length);
  const start = ((offset % items.length) + items.length) % items.length;
  return Array.from({ length: size }, (_, index) => items[(start + index) % items.length]);
}

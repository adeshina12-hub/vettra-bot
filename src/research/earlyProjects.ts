import { config } from "../config.js";
import { reserveExternalApiRequests } from "../storage/db.js";

export interface EarlyCandidate {
  key: string;
  source: "moni" | "github" | "defillama";
  name: string;
  xHandle?: string;
  xFollowers?: number;
  xAccountAge?: string;
  moniScore?: number;
  moniPrediction?: number;
  smartFollowers?: number;
  smartFollowerTags: string[];
  category?: string;
  description?: string;
  chain?: string;
  url?: string;
  repoUrl?: string;
  repoStars?: number;
  repoTopics: string[];
  githubFollowers?: number;
  githubCreatedAt?: string;
}

export interface EarlyScore {
  qualifies: boolean;
  score: number;
  chain: string;
  category: string;
  stage: string;
  why: string;
}

export interface ScoredEarlyProject {
  candidate: EarlyCandidate;
  score: EarlyScore;
}

export interface EarlyScanResult {
  projects: ScoredEarlyProject[];
  discovered: number;
  selected: number;
  scored: number;
  scoringFailed: number;
  qualified: number;
  minimumSmartFollowers: number;
  sources: { moni: number; github: number; defillama: number };
}

const MONI_URL = "https://api.discover.getmoni.io/api/v3/projects/";
let moniCache: EarlyCandidate[] | null = null;
let moniCacheAt = 0;
const MONI_CACHE_MS = 15 * 60_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function tags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((tag) => typeof tag === "string" ? tag : tag?.name ?? tag?.slug).filter(Boolean);
}

function handleFromUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.split("/").filter(Boolean).pop();
}

async function discoverMoni(): Promise<EarlyCandidate[]> {
  if (!config.moni.apiKey) throw new Error("MONI_API_KEY is not configured");
  if (moniCache && Date.now() - moniCacheAt < MONI_CACHE_MS) return moniCache;
  const allowed = await reserveExternalApiRequests("moni", 1, config.moni.dailyRequestCap);
  if (!allowed) throw new Error(`Moni daily request cap reached (${config.moni.dailyRequestCap})`);
  const params = new URLSearchParams({
    feedTimeframe: process.env.MONI_FEED_TIMEFRAME ?? "D30",
    changesTimeframe: "H24",
    orderBy: "CREATED_AT",
    orderByDirection: "DESC",
    // Fetch the full test pool before applying smart-follower qualification.
    limit: "50",
    offset: "0",
    minMlProjectPredictionPercents: "0",
  });
  const response = await fetchWithTimeout(`${MONI_URL}?${params}`, { headers: { "Api-Key": config.moni.apiKey, Accept: "application/json" } });
  if (!response.ok) throw new Error(`Moni discovery failed: ${response.status}`);
  const payload = await response.json() as { items?: any[] };
  moniCache = (payload.items ?? []).flatMap((item): EarlyCandidate[] => {
    const meta = item.meta ?? {};
    const engagement = item.smartEngagement ?? {};
    const profile = item.smartProfile ?? {};
    const xHandle = handleFromUrl(meta.userUrl);
    if (!xHandle) return [];
    const projectTags = tags(profile.projectTags);
    const name = meta.displayName ?? meta.name ?? meta.username ?? xHandle;
    return [{
      key: `moni:${xHandle.toLowerCase()}`, source: "moni", name: String(name), xHandle,
      xFollowers: numberValue(engagement.followersCount, engagement.followers_count, meta.followersCount, item.followersCount),
      xAccountAge: meta.accountAgeDays != null ? `${meta.accountAgeDays} days old` : undefined,
      moniScore: numberValue(engagement.moniScore, item.moniScore, profile.moniScore, meta.moniScore),
      moniPrediction: numberValue(profile.mlProjectPrediction, item.mlProjectPrediction, meta.mlProjectPrediction),
      smartFollowers: numberValue(engagement.smartFollowersCount, engagement.smartsCount),
      smartFollowerTags: tags(profile.smartTags),
      category: projectTags[0],
      description: item.description ?? profile.description ?? meta.description ?? profile.bio ?? meta.bio ?? undefined,
      chain: tags(profile.chains).join(", "), url: meta.userUrl, repoTopics: [],
    }];
  });
  moniCacheAt = Date.now();
  return moniCache;
}

/* Disabled while testing Moni qualification only.
async function discoverGitHub(): Promise<EarlyCandidate[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (config.github.token) headers.Authorization = `Bearer ${config.github.token}`;
  const seen = new Set<string>();
  const results: EarlyCandidate[] = [];
  const since = new Date(Date.now() - Number(process.env.LOOKBACK_HOURS ?? 24) * 3600_000).toISOString().slice(0, 10);
  for (const topic of TOPIC_QUERIES) {
    let response: Response;
    try {
      response = await fetchWithTimeout(`https://api.github.com/search/repositories?q=topic:${topic}+pushed:>${since}+fork:false&sort=updated&order=desc&per_page=10`, { headers });
    } catch (err) {
      console.warn(`[early] GitHub search unavailable for ${topic}: ${String(err)}`);
      continue;
    }
    if (!response.ok) continue;
    const payload = await response.json() as { items?: any[] };
    for (const repo of payload.items ?? []) {
      const owner = repo.owner?.login;
      if (!owner || seen.has(owner.toLowerCase())) continue;
      seen.add(owner.toLowerCase());
      results.push({ key: `github:${owner.toLowerCase()}`, source: "github", name: owner, githubFollowers: undefined,
        smartFollowerTags: [], description: repo.description ?? undefined, repoUrl: repo.html_url, repoStars: repo.stargazers_count ?? 0,
        repoTopics: repo.topics ?? [], url: repo.html_url });
    }
  }
  const enriched = await Promise.all(results.map(async (candidate) => {
    try {
      const response = await fetchWithTimeout(`https://api.github.com/users/${candidate.name}`, { headers });
      if (!response.ok) return candidate;
      const profile = await response.json() as any;
      return { ...candidate, description: profile.bio ?? candidate.description, xHandle: profile.twitter_username ?? undefined,
        githubFollowers: profile.followers ?? 0, githubCreatedAt: profile.created_at, url: profile.html_url };
    } catch (err) {
      console.warn(`[early] GitHub profile unavailable for ${candidate.name}: ${String(err)}`);
      return candidate;
    }
  }));
  return enriched.filter((item) => (item.githubFollowers ?? 0) <= Number(process.env.MAX_GITHUB_FOLLOWERS ?? 1000) * 3);
}
*/

/* Disabled while testing Moni qualification only.
async function discoverDefiLlama(): Promise<EarlyCandidate[]> {
  let response: Response;
  try {
    response = await fetchWithTimeout("https://api.llama.fi/protocols");
  } catch (err) {
    console.warn(`[early] DeFiLlama unavailable: ${String(err)}`);
    return [];
  }
  if (!response.ok) return [];
  const cutoff = Date.now() / 1000 - Number(process.env.LOOKBACK_HOURS ?? 24) * 3600;
  const protocols = await response.json() as any[];
  return protocols.filter((protocol) => typeof protocol.listedAt === "number" && protocol.listedAt >= cutoff).map((protocol) => ({
    key: `defillama:${String(protocol.slug ?? protocol.name).toLowerCase()}`, source: "defillama", name: protocol.name,
    smartFollowerTags: [], description: protocol.description, chain: protocol.chain, url: protocol.url, xHandle: protocol.twitter,
    repoTopics: [],
  }));
}
*/

function buildMoniScore(candidate: EarlyCandidate): EarlyScore {
  const score = candidate.moniScore ?? candidate.moniPrediction ?? 0;
  return {
    // This is a presentation shape for the existing Telegram response.
    qualifies: true,
    score: Math.max(0, Math.min(100, score)),
    chain: candidate.chain || "Unknown",
    category: candidate.category || "Unknown",
    stage: "Early project",
    why: candidate.description || "No description available",
  };
}

export async function findEarlyProjects(limit = 3): Promise<EarlyScanResult> {
  const [moniResult] = await Promise.allSettled([discoverMoni()]);
  if (moniResult.status === "rejected") throw moniResult.reason;
  const moni = moniResult.value;
  // Moni is the only source in this mode. Keep every returned item and use
  // Moni's own score; no LLM qualification or threshold is applied.
  const candidates = moni.slice(0, limit);
  const results: ScoredEarlyProject[] = [];
  for (const candidate of candidates) results.push({ candidate, score: buildMoniScore(candidate) });
  const qualified = results;
  return {
    projects: qualified,
    discovered: moni.length,
    selected: candidates.length,
    scored: results.length,
    scoringFailed: 0,
    qualified: qualified.length,
    minimumSmartFollowers: 0,
    sources: { moni: moni.length, github: 0, defillama: 0 },
  };
}

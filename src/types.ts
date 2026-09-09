/**
 * A raw signal pulled from one source, before scoring.
 * Every collector (on-chain, social, news) normalizes into this shape
 * so the agent core can reason over them uniformly.
 */
export interface RawSignal {
  id: string;                 // stable dedup key, e.g. `${source}:${externalId}`
  source: "onchain" | "social" | "news";
  subSource: string;          // e.g. "dexscreener", "x", "rss:theblock"
  asset?: string;              // token symbol / contract address if applicable
  title: string;               // short human-readable summary
  detail: string;              // fuller text the LLM will read
  url?: string;
  metricValue?: number;        // e.g. % liquidity change, mention count, funding amount
  metricLabel?: string;        // what metricValue represents
  observedAt: string;          // ISO timestamp
}

/**
 * Output of the agent core: a ranked, explained opportunity built from
 * one or more correlated RawSignals.
 */
export interface Opportunity {
  id: string;
  title: string;
  asset?: string;
  score: number;                // 0-100
  reasoning: string;             // why the agent thinks this matters
  supportingSignalIds: string[];
  category: "new_narrative" | "smart_money" | "social_spike" | "news_catalyst" | "other";
  createdAt: string;
}

export interface ScoredBatch {
  opportunities: Opportunity[];
}

// --- Due-diligence research agent types ---

export interface ProjectProfile {
  query: string;
  name: string;
  symbol?: string;
  coingeckoId?: string;
  contractAddress?: string;
  chain?: string;
  website?: string;
  whitepaperUrl?: string;
  githubRepo?: string; // "owner/repo"
  twitterHandle?: string;
}

export interface CriterionResult {
  criterion: string;
  label: string;
  findings: string;
  data?: Record<string, unknown>;
  confidence: "high" | "medium" | "low";
}

export interface ModelAgreement {
  providers: string[];
  agreed: boolean;
  note?: string;
}

export interface ResearchReport {
  id: string;
  query: string;
  profile: ProjectProfile;
  criteria: CriterionResult[];
  overallScore: number;
  verdict: string;
  strengths: string[];
  redFlags: string[];
  modelAgreement?: ModelAgreement;
  createdAt: string;
}

// --- Meme coin scanner (contract address → degen due diligence) ---

export type MemeCheckStatus = "pass" | "warn" | "fail" | "unknown";

/** One deterministic due-diligence check, so the numbers never come from an LLM. */
export interface MemeCheck {
  label: string;
  status: MemeCheckStatus;
  detail: string;
}

export interface MemeMarketSnapshot {
  address: string;
  name: string;
  symbol: string;
  chain: string;
  dex: string;
  pairAddress: string;
  pairUrl: string;
  pairCount: number;
  priceUsd?: number;
  marketCap?: number;
  fdv?: number;
  liquidityUsd?: number;
  /** Liquidity summed across every pair for this token on the same chain. */
  totalLiquidityUsd?: number;
  volume24h?: number;
  volume1h?: number;
  priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns24h?: { buys: number; sells: number };
  txns1h?: { buys: number; sells: number };
  ageHours?: number;
  createdAt?: string;
  websites: string[];
  socials: string[];
  imageUrl?: string;
}

export interface MemeSecuritySnapshot {
  source: "goplus";
  honeypot?: boolean;
  buyTaxPct?: number;
  sellTaxPct?: number;
  ownerRenounced?: boolean;
  mintable?: boolean;
  /** Solana only — a live freeze authority can lock every holder's balance. */
  freezable?: boolean;
  metadataMutable?: boolean;
  transferPausable?: boolean;
  blacklistable?: boolean;
  proxy?: boolean;
  openSource?: boolean;
  holderCount?: number;
  /** Top-10 share excluding pools, burn addresses, and locked balances. */
  top10HolderPct?: number;
  lpLockedOrBurnedPct?: number;
}

export interface MemeCoinReport {
  id: string;
  address: string;
  market: MemeMarketSnapshot;
  security?: MemeSecuritySnapshot;
  /** 0-100, rule-based (not model-generated). */
  degenScore: number;
  rating: string;
  /** Non-empty means "do not touch", regardless of everything else. */
  dealBreakers: string[];
  checks: MemeCheck[];
  verdict: string;
  bullCase: string[];
  redFlags: string[];
  positionSizing: string;
  providers: string[];
  disclaimer: string;
  createdAt: string;
}

export type AuditSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface SecurityAuditFinding {
  severity: AuditSeverity;
  title: string;
  category: string;
  location: string;
  explanation: string;
  remediation: string;
  confidence: "high" | "medium" | "low";
}

export interface SecurityAuditReport {
  id: string;
  contractName: string;
  summary: string;
  riskRating: AuditSeverity;
  findings: SecurityAuditFinding[];
  providers: string[];
  disclaimer: string;
  createdAt: string;
}

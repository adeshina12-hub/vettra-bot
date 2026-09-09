import { generateWithConsensus } from "../agent/llm/index.js";
import { fetchTokenPairs, type DexScreenerPair } from "./dexscreener.js";
import { fetchTokenSecurity, supportsSecurityCheck } from "./tokenSecurity.js";
import type {
  MemeCheck,
  MemeCheckStatus,
  MemeCoinReport,
  MemeMarketSnapshot,
  MemeSecuritySnapshot,
} from "../types.js";

/**
 * Meme-coin scanner: contract address in, degen due diligence out.
 *
 * Deliberately split in two. The *score* is rule-based arithmetic over
 * DexScreener market data and GoPlus contract safety — a model must never
 * be the thing that decides whether LP is locked. The *narrative* (verdict,
 * bull case, sizing) is the LLM's job, and if no provider answers the
 * report still ships with a deterministic fallback verdict.
 */

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REPORT_CACHE_MS = 3 * 60_000;
const DISCLAIMER =
  "Meme coins are high-risk and can go to zero in minutes. This is automated research, not financial advice.";

const SYSTEM_PROMPT = `You are a seasoned degen trader who has been rugged enough times to be honest about risk. You are given already-verified market and contract-safety data for a meme coin, plus a rule-based score computed from that data. Do not invent numbers, holders, partnerships, or narrative that is not in the data — if something is unknown, say it is unknown and treat unknown as risk.

Judge it the way a degen actually decides: can I get in and out (liquidity vs market cap), is there real trading (volume and buy/sell flow), can the deployer kill me (mint authority, unlocked LP, taxes, honeypot, whale concentration), and is this early or already extended.

Return ONLY valid JSON, no markdown fences:
{
  "verdict": "2-4 blunt sentences a trader would read before aping",
  "bullCase": ["what genuinely looks good, evidence-based; empty array if nothing does"],
  "redFlags": ["biggest concrete risks - always at least one"],
  "positionSizing": "one sentence of concrete risk guidance for this specific setup"
}`;

const reportCache = new Map<string, { expiresAt: number; report: MemeCoinReport }>();

export function looksLikeContractAddress(value: string): boolean {
  const trimmed = value.trim();
  return EVM_ADDRESS.test(trimmed) || SOLANA_ADDRESS.test(trimmed);
}

export async function analyzeMemeCoin(rawAddress: string): Promise<MemeCoinReport> {
  const address = rawAddress.trim();
  if (!looksLikeContractAddress(address)) {
    throw new Error("That does not look like a contract address. Send an EVM address (0x…) or a Solana mint address.");
  }

  const cacheKey = address.toLowerCase();
  const cached = reportCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.report;

  const pairs = await fetchTokenPairs(address);
  if (pairs.length === 0) {
    throw new Error("No DEX pair found for that address. It may be unlaunched, on an unsupported chain, or not a token.");
  }

  const market = buildMarketSnapshot(address, pairs);
  const security = supportsSecurityCheck(market.chain)
    ? await fetchTokenSecurity(
        market.chain,
        address,
        pairs.map((pair) => pair.pairAddress).filter(Boolean)
      )
    : null;

  const { score, rating, checks, dealBreakers } = scoreMemeCoin(market, security);
  const narrative = await describeMemeCoin(market, security, score, rating, checks, dealBreakers);

  const report: MemeCoinReport = {
    id: `meme:${market.chain}:${cacheKey}:${Date.now()}`,
    address,
    market,
    security: security ?? undefined,
    degenScore: score,
    rating,
    dealBreakers,
    checks,
    verdict: narrative.verdict,
    bullCase: narrative.bullCase,
    redFlags: narrative.redFlags,
    positionSizing: narrative.positionSizing,
    providers: narrative.providers,
    disclaimer: DISCLAIMER,
    createdAt: new Date().toISOString(),
  };

  reportCache.set(cacheKey, { expiresAt: Date.now() + REPORT_CACHE_MS, report });
  return report;
}

// --- Market snapshot ---

function buildMarketSnapshot(address: string, pairs: DexScreenerPair[]): MemeMarketSnapshot {
  // Deepest pair prices the token; thin pairs quote nonsense prices.
  const primary = pairs[0];
  const sameChain = pairs.filter((pair) => pair.chainId === primary.chainId);
  const totalLiquidityUsd = sameChain.reduce((sum, pair) => sum + (pair.liquidity?.usd ?? 0), 0);

  // Token age tracks the FIRST pair ever opened, not the deepest one — a
  // fresh migration pool on an old token should not read as "launched today".
  const createdAtMs = pairs
    .map((pair) => pair.pairCreatedAt)
    .filter((value): value is number => typeof value === "number" && value > 0)
    .sort((a, b) => a - b)[0];

  return {
    address,
    name: primary.baseToken?.name ?? "Unknown token",
    symbol: primary.baseToken?.symbol ?? "?",
    chain: primary.chainId,
    dex: primary.dexId,
    pairAddress: primary.pairAddress,
    pairUrl: primary.url,
    pairCount: sameChain.length,
    priceUsd: toNumber(primary.priceUsd),
    marketCap: primary.marketCap,
    fdv: primary.fdv,
    liquidityUsd: primary.liquidity?.usd,
    totalLiquidityUsd,
    volume24h: primary.volume?.h24,
    volume1h: primary.volume?.h1,
    priceChange: {
      m5: primary.priceChange?.m5,
      h1: primary.priceChange?.h1,
      h6: primary.priceChange?.h6,
      h24: primary.priceChange?.h24,
    },
    txns24h: primary.txns?.h24,
    txns1h: primary.txns?.h1,
    ageHours: createdAtMs ? (Date.now() - createdAtMs) / 3_600_000 : undefined,
    createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : undefined,
    websites: (primary.info?.websites ?? []).map((site) => site.url ?? "").filter(Boolean),
    socials: (primary.info?.socials ?? []).map((social) => social.url ?? "").filter(Boolean),
    imageUrl: primary.info?.imageUrl,
  };
}

// --- Deterministic scoring ---

interface ScoreResult {
  score: number;
  rating: string;
  checks: MemeCheck[];
  dealBreakers: string[];
}

interface CheckSpec {
  label: string;
  status: MemeCheckStatus;
  detail: string;
  delta: number;
  dealBreaker?: boolean;
}

function scoreMemeCoin(market: MemeMarketSnapshot, security: MemeSecuritySnapshot | null): ScoreResult {
  const specs: CheckSpec[] = [];
  const liquidity = market.totalLiquidityUsd || market.liquidityUsd;
  const marketCap = market.marketCap ?? market.fdv;

  // 1. Exit depth — the single thing that decides whether you can sell.
  if (liquidity === undefined) {
    specs.push({ label: "Liquidity", status: "unknown", detail: "No liquidity reported.", delta: -8 });
  } else if (liquidity >= 250_000) {
    specs.push({ label: "Liquidity", status: "pass", detail: `${usd(liquidity)} pooled — size can exit.`, delta: 12 });
  } else if (liquidity >= 100_000) {
    specs.push({ label: "Liquidity", status: "pass", detail: `${usd(liquidity)} pooled — decent depth.`, delta: 9 });
  } else if (liquidity >= 50_000) {
    specs.push({ label: "Liquidity", status: "warn", detail: `${usd(liquidity)} pooled — thin, expect slippage.`, delta: 4 });
  } else if (liquidity >= 15_000) {
    specs.push({ label: "Liquidity", status: "warn", detail: `${usd(liquidity)} pooled — very thin, exit only in small clips.`, delta: -4 });
  } else {
    specs.push({ label: "Liquidity", status: "fail", detail: `${usd(liquidity)} pooled — trivially ruggable.`, delta: -16 });
  }

  // 2. Liquidity vs valuation — a $10M cap on $30k of liquidity is a paper price.
  if (liquidity !== undefined && marketCap) {
    const ratio = liquidity / marketCap;
    if (ratio >= 0.1) {
      specs.push({ label: "Liquidity / market cap", status: "pass", detail: `${(ratio * 100).toFixed(1)}% of the cap is pooled — the price is real.`, delta: 8 });
    } else if (ratio >= 0.05) {
      specs.push({ label: "Liquidity / market cap", status: "pass", detail: `${(ratio * 100).toFixed(1)}% of the cap is pooled.`, delta: 4 });
    } else if (ratio >= 0.02) {
      specs.push({ label: "Liquidity / market cap", status: "warn", detail: `Only ${(ratio * 100).toFixed(1)}% of the cap is pooled — the valuation is thin air.`, delta: -3 });
    } else {
      specs.push({ label: "Liquidity / market cap", status: "fail", detail: `Only ${(ratio * 100).toFixed(2)}% of the cap is pooled — a small sell craters it.`, delta: -10 });
    }
  }

  // 3. Turnover — is anyone actually trading, or is this a chart with no bids?
  if (liquidity && liquidity > 0 && market.volume24h !== undefined) {
    const turnover = market.volume24h / liquidity;
    if (turnover >= 0.5 && turnover <= 20) {
      specs.push({ label: "24h turnover", status: "pass", detail: `${usd(market.volume24h)} volume = ${turnover.toFixed(1)}x liquidity — live market.`, delta: 8 });
    } else if (turnover > 20) {
      specs.push({ label: "24h turnover", status: "warn", detail: `${turnover.toFixed(0)}x liquidity churned in 24h — hot, possibly wash-traded.`, delta: 1 });
    } else if (turnover >= 0.1) {
      specs.push({ label: "24h turnover", status: "warn", detail: `${usd(market.volume24h)} volume = ${turnover.toFixed(2)}x liquidity — quiet.`, delta: -3 });
    } else {
      specs.push({ label: "24h turnover", status: "fail", detail: `${usd(market.volume24h)} volume against ${usd(liquidity)} liquidity — effectively dead.`, delta: -10 });
    }
  }

  // 4. Buy/sell flow.
  const txns = market.txns24h;
  if (txns && txns.buys + txns.sells >= 20) {
    const ratio = txns.buys / Math.max(txns.sells, 1);
    if (ratio >= 1.2) {
      specs.push({ label: "Buy pressure", status: "pass", detail: `${txns.buys} buys vs ${txns.sells} sells in 24h.`, delta: 6 });
    } else if (ratio >= 0.8) {
      specs.push({ label: "Buy pressure", status: "pass", detail: `Balanced flow: ${txns.buys} buys vs ${txns.sells} sells.`, delta: 2 });
    } else {
      specs.push({ label: "Buy pressure", status: "warn", detail: `Sellers in control: ${txns.buys} buys vs ${txns.sells} sells.`, delta: -6 });
    }
  } else if (txns) {
    specs.push({ label: "Buy pressure", status: "warn", detail: `Only ${txns.buys + txns.sells} trades in 24h — almost no participants.`, delta: -6 });
  }

  // 5. Age. New is where the upside is, and also where the rugs are.
  const age = market.ageHours;
  if (age === undefined) {
    specs.push({ label: "Token age", status: "unknown", detail: "Launch time unknown.", delta: -2 });
  } else if (age < 1) {
    specs.push({ label: "Token age", status: "warn", detail: `Launched ${Math.round(age * 60)} minutes ago — maximum risk, nothing is proven.`, delta: -8 });
  } else if (age < 24) {
    specs.push({ label: "Token age", status: "warn", detail: `${age.toFixed(1)} hours old — still in rug window.`, delta: -3 });
  } else if (age < 24 * 7) {
    specs.push({ label: "Token age", status: "pass", detail: `${(age / 24).toFixed(1)} days old — survived the first days.`, delta: 3 });
  } else if (age < 24 * 90) {
    specs.push({ label: "Token age", status: "pass", detail: `${(age / 24).toFixed(0)} days old.`, delta: 6 });
  } else {
    specs.push({ label: "Token age", status: "pass", detail: `${(age / 24 / 30).toFixed(0)} months old — an established meme.`, delta: 8 });
  }

  // 6. Momentum context — being right about the coin and late to the move
  // are different problems.
  const change24h = market.priceChange.h24;
  if (typeof change24h === "number") {
    if (change24h >= 300) {
      specs.push({ label: "24h momentum", status: "warn", detail: `+${change24h.toFixed(0)}% in 24h — parabolic, you would be buying someone's exit.`, delta: -4 });
    } else if (change24h <= -50) {
      specs.push({ label: "24h momentum", status: "fail", detail: `${change24h.toFixed(0)}% in 24h — actively bleeding out.`, delta: -6 });
    } else if (change24h > 0) {
      specs.push({ label: "24h momentum", status: "pass", detail: `+${change24h.toFixed(1)}% in 24h.`, delta: 2 });
    } else {
      specs.push({ label: "24h momentum", status: "warn", detail: `${change24h.toFixed(1)}% in 24h.`, delta: 0 });
    }
  }

  // 7. Socials presence.
  const links = market.websites.length + market.socials.length;
  if (links >= 2) {
    specs.push({ label: "Socials", status: "pass", detail: `${links} official links listed on DexScreener.`, delta: 3 });
  } else if (links === 1) {
    specs.push({ label: "Socials", status: "warn", detail: "Only one official link listed.", delta: 0 });
  } else {
    specs.push({ label: "Socials", status: "warn", detail: "No website or socials listed — no community to sustain a bid.", delta: -4 });
  }

  specs.push(...securityChecks(market, security));

  const dealBreakers = specs.filter((spec) => spec.dealBreaker).map((spec) => spec.detail);
  const raw = specs.reduce((total, spec) => total + spec.delta, 50);
  const score = dealBreakers.length > 0 ? Math.min(clamp(raw), 8) : clamp(raw);

  return {
    score,
    rating: ratingFor(score, dealBreakers.length > 0),
    checks: specs.map(({ label, status, detail }) => ({ label, status, detail })),
    dealBreakers,
  };
}

function securityChecks(market: MemeMarketSnapshot, security: MemeSecuritySnapshot | null): CheckSpec[] {
  if (!security) {
    return [{
      label: "Contract safety",
      status: "unknown",
      detail: supportsSecurityCheck(market.chain)
        ? "Safety provider returned nothing for this token — treat contract risk as unverified."
        : `No contract-safety provider covers ${market.chain} — honeypot and LP risk are unverified.`,
      delta: -8,
    }];
  }

  const specs: CheckSpec[] = [];

  if (security.honeypot === true) {
    specs.push({ label: "Honeypot", status: "fail", detail: "Contract is flagged as a honeypot — buys work, sells do not.", delta: -40, dealBreaker: true });
  } else if (security.honeypot === false) {
    specs.push({ label: "Honeypot", status: "pass", detail: "No honeypot behaviour detected in simulation.", delta: 8 });
  }

  const tax = Math.max(security.buyTaxPct ?? 0, security.sellTaxPct ?? 0);
  if (security.buyTaxPct !== undefined || security.sellTaxPct !== undefined) {
    const label = `${(security.buyTaxPct ?? 0).toFixed(1)}% buy / ${(security.sellTaxPct ?? 0).toFixed(1)}% sell`;
    if (tax > 25) {
      specs.push({ label: "Taxes", status: "fail", detail: `Extractive tax: ${label}.`, delta: -20, dealBreaker: true });
    } else if (tax > 10) {
      specs.push({ label: "Taxes", status: "fail", detail: `High tax: ${label} — the deployer earns whether you win or lose.`, delta: -10 });
    } else if (tax > 5) {
      specs.push({ label: "Taxes", status: "warn", detail: `Tax: ${label}.`, delta: -2 });
    } else {
      specs.push({ label: "Taxes", status: "pass", detail: `Low tax: ${label}.`, delta: 4 });
    }
  }

  if (security.lpLockedOrBurnedPct !== undefined) {
    const locked = security.lpLockedOrBurnedPct;
    if (locked >= 90) {
      specs.push({ label: "LP locked/burned", status: "pass", detail: `${locked.toFixed(1)}% of LP is burned or locked — no instant pull.`, delta: 10 });
    } else if (locked >= 50) {
      specs.push({ label: "LP locked/burned", status: "warn", detail: `${locked.toFixed(1)}% of LP is locked — the rest can be pulled.`, delta: 3 });
    } else {
      specs.push({ label: "LP locked/burned", status: "fail", detail: `Only ${locked.toFixed(1)}% of LP is locked — liquidity can be removed at will.`, delta: -14 });
    }
  } else {
    specs.push({ label: "LP locked/burned", status: "unknown", detail: "LP lock status unverified — assume it can be pulled.", delta: -5 });
  }

  if (security.mintable === true) {
    specs.push({ label: "Mint authority", status: "fail", detail: "Supply is still mintable — your bag can be diluted at any time.", delta: -14 });
  } else if (security.mintable === false) {
    specs.push({ label: "Mint authority", status: "pass", detail: "Supply is fixed, minting is disabled.", delta: 6 });
  }

  if (security.freezable === true) {
    specs.push({ label: "Freeze authority", status: "fail", detail: "Freeze authority is live — your tokens can be frozen in your wallet.", delta: -30, dealBreaker: true });
  } else if (security.freezable === false) {
    specs.push({ label: "Freeze authority", status: "pass", detail: "Freeze authority revoked.", delta: 6 });
  }

  if (security.ownerRenounced === true) {
    specs.push({ label: "Ownership", status: "pass", detail: "Ownership renounced.", delta: 5 });
  } else if (security.ownerRenounced === false) {
    specs.push({ label: "Ownership", status: "warn", detail: "Owner still controls the contract and can change its rules.", delta: -5 });
  }

  if (security.transferPausable === true) {
    specs.push({ label: "Transfer pausable", status: "fail", detail: "Transfers can be paused by the owner — an exit can be switched off.", delta: -10 });
  }
  if (security.blacklistable === true) {
    specs.push({ label: "Blacklist", status: "warn", detail: "The contract can blacklist wallets, including yours.", delta: -6 });
  }
  if (security.openSource === false) {
    specs.push({ label: "Source code", status: "fail", detail: "Contract is not verified — nobody can read what it actually does.", delta: -12 });
  }
  if (security.proxy === true) {
    specs.push({ label: "Proxy contract", status: "warn", detail: "Upgradeable proxy — the logic you audited can be swapped out.", delta: -5 });
  }
  if (security.metadataMutable === true) {
    specs.push({ label: "Metadata", status: "warn", detail: "Token metadata is still mutable (name/image can change).", delta: -3 });
  }

  if (security.top10HolderPct !== undefined) {
    const top10 = security.top10HolderPct;
    if (top10 > 50) {
      specs.push({ label: "Whale concentration", status: "fail", detail: `Top 10 non-pool wallets hold ${top10.toFixed(1)}% — a handful of exits ends this.`, delta: -16 });
    } else if (top10 > 30) {
      specs.push({ label: "Whale concentration", status: "fail", detail: `Top 10 non-pool wallets hold ${top10.toFixed(1)}%.`, delta: -8 });
    } else if (top10 > 15) {
      specs.push({ label: "Whale concentration", status: "warn", detail: `Top 10 non-pool wallets hold ${top10.toFixed(1)}%.`, delta: -2 });
    } else {
      specs.push({ label: "Whale concentration", status: "pass", detail: `Top 10 non-pool wallets hold ${top10.toFixed(1)}% — well distributed.`, delta: 6 });
    }
  }

  if (security.holderCount !== undefined) {
    const holders = security.holderCount;
    if (holders >= 10_000) {
      specs.push({ label: "Holders", status: "pass", detail: `${holders.toLocaleString()} holders.`, delta: 6 });
    } else if (holders >= 1_000) {
      specs.push({ label: "Holders", status: "pass", detail: `${holders.toLocaleString()} holders.`, delta: 3 });
    } else if (holders >= 200) {
      specs.push({ label: "Holders", status: "warn", detail: `${holders.toLocaleString()} holders — still a small crowd.`, delta: 0 });
    } else {
      specs.push({ label: "Holders", status: "fail", detail: `Only ${holders.toLocaleString()} holders — barely distributed.`, delta: -7 });
    }
  }

  return specs;
}

function ratingFor(score: number, hasDealBreaker: boolean): string {
  if (hasDealBreaker) return "🚨 AVOID — critical contract risk";
  if (score >= 75) return "🔥 Strong degen setup";
  if (score >= 60) return "⚡ Playable with size discipline";
  if (score >= 45) return "👀 Mixed — small size only";
  if (score >= 30) return "⚠️ High risk — likely pass";
  return "🚨 Avoid";
}

// --- Narrative layer ---

interface Narrative {
  verdict: string;
  bullCase: string[];
  redFlags: string[];
  positionSizing: string;
  providers: string[];
}

async function describeMemeCoin(
  market: MemeMarketSnapshot,
  security: MemeSecuritySnapshot | null,
  score: number,
  rating: string,
  checks: MemeCheck[],
  dealBreakers: string[]
): Promise<Narrative> {
  const facts = [
    `Token: ${market.name} (${market.symbol}) on ${market.chain} via ${market.dex}`,
    `Contract: ${market.address}`,
    `Price: ${market.priceUsd !== undefined ? `$${market.priceUsd}` : "unknown"}`,
    `Market cap: ${usd(market.marketCap)} | FDV: ${usd(market.fdv)}`,
    `Liquidity: ${usd(market.totalLiquidityUsd ?? market.liquidityUsd)} across ${market.pairCount} pair(s)`,
    `Volume 24h: ${usd(market.volume24h)} | 1h: ${usd(market.volume1h)}`,
    `Price change - 5m: ${fmtPct(market.priceChange.m5)}, 1h: ${fmtPct(market.priceChange.h1)}, 6h: ${fmtPct(market.priceChange.h6)}, 24h: ${fmtPct(market.priceChange.h24)}`,
    `Trades 24h: ${market.txns24h ? `${market.txns24h.buys} buys / ${market.txns24h.sells} sells` : "unknown"}`,
    `Age: ${market.ageHours !== undefined ? `${(market.ageHours / 24).toFixed(1)} days` : "unknown"}`,
    `Links: ${[...market.websites, ...market.socials].join(", ") || "none listed"}`,
    security
      ? `Contract safety (GoPlus): ${JSON.stringify(security)}`
      : "Contract safety: no data available for this chain — unverified.",
    "",
    `Rule-based degen score: ${score}/100 (${rating})`,
    dealBreakers.length ? `DEAL BREAKERS: ${dealBreakers.join(" | ")}` : "No deal breakers detected.",
    "",
    "Checks:",
    ...checks.map((check) => `- [${check.status.toUpperCase()}] ${check.label}: ${check.detail}`),
  ].join("\n");

  try {
    const { primary, results } = await generateWithConsensus<{
      verdict?: string;
      bullCase?: string[];
      redFlags?: string[];
      positionSizing?: string;
    }>(SYSTEM_PROMPT, facts, 1500);

    if (primary?.verdict) {
      return {
        verdict: primary.verdict,
        bullCase: cleanList(primary.bullCase),
        redFlags: cleanList(primary.redFlags).length ? cleanList(primary.redFlags) : fallbackRedFlags(checks, dealBreakers),
        positionSizing: primary.positionSizing || fallbackSizing(score, dealBreakers.length > 0),
        providers: results.filter((result) => result.output !== null).map((result) => result.provider),
      };
    }
  } catch (err) {
    console.warn("[meme] narrative generation unavailable, falling back to rule-based summary:", String(err));
  }

  return { ...fallbackNarrative(market, score, rating, checks, dealBreakers), providers: [] };
}

function fallbackNarrative(
  market: MemeMarketSnapshot,
  score: number,
  rating: string,
  checks: MemeCheck[],
  dealBreakers: string[]
): Omit<Narrative, "providers"> {
  return {
    verdict:
      `${market.name} (${market.symbol}) scores ${score}/100 on the rule-based checks — ${rating.replace(/^[^\w]+/, "")}. ` +
      `No AI verdict was available, so this summary is built purely from the market and contract data above.`,
    bullCase: checks.filter((check) => check.status === "pass").slice(0, 4).map((check) => `${check.label}: ${check.detail}`),
    redFlags: fallbackRedFlags(checks, dealBreakers),
    positionSizing: fallbackSizing(score, dealBreakers.length > 0),
  };
}

function fallbackRedFlags(checks: MemeCheck[], dealBreakers: string[]): string[] {
  const flags = [
    ...dealBreakers,
    ...checks
      .filter((check) => check.status === "fail" || check.status === "unknown")
      .map((check) => `${check.label}: ${check.detail}`),
  ];
  return flags.length ? [...new Set(flags)].slice(0, 6) : ["Meme coins carry total-loss risk regardless of how the checks read."];
}

function fallbackSizing(score: number, hasDealBreaker: boolean): string {
  if (hasDealBreaker) return "Do not take a position — the contract itself can take your money.";
  if (score >= 75) return "Tradeable size for a meme, but still treat the whole position as expendable.";
  if (score >= 60) return "Small size only, with a predefined exit before you buy.";
  if (score >= 45) return "Lottery-ticket size at most — money you will not miss.";
  return "Skip it. The risk is not being paid for here.";
}

// --- Formatting helpers ---

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 6);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function usd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "n/a";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

/** Meme prices are frequently sub-cent, where toFixed(2) prints "$0.00". */
export function price(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "n/a";
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.0001) return `$${value.toFixed(6)}`;
  return `$${value.toPrecision(4)}`;
}

export function fmtPct(value: number | undefined): string {
  return typeof value === "number" ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}%` : "n/a";
}

export function formatAge(hours: number | undefined): string {
  if (hours === undefined) return "unknown";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  if (days < 60) return `${days.toFixed(0)}d`;
  return `${(days / 30).toFixed(0)}mo`;
}

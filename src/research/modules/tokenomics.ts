import type { CriterionResult, ProjectProfile } from "../../types.js";
import { fetchCoinGecko } from "../coingecko.js";

export async function analyzeTokenomics(profile: ProjectProfile): Promise<CriterionResult> {
  if (!profile.coingeckoId) {
    return {
      criterion: "tokenomics",
      label: "Tokenomics",
      findings: "No market listing resolved — cannot pull supply/market data.",
      confidence: "low",
    };
  }

  try {
    const data = await fetchCoinGecko<any>(
      `/coins/${profile.coingeckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`
    );
    const md = data.market_data;

    const circulating = md.circulating_supply as number | null;
    const total = md.total_supply as number | null;
    const circPct = circulating && total ? ((circulating / total) * 100).toFixed(1) : null;
    const marketCap = md.market_cap?.usd as number | undefined;
    const fdv = md.fully_diluted_valuation?.usd as number | undefined;
    const mcapFdvRatio = marketCap && fdv ? (marketCap / fdv) : null;

    const dilutionNote =
      mcapFdvRatio !== null
        ? mcapFdvRatio < 0.5
          ? " Market cap is well below FDV — significant future dilution as more supply unlocks, worth weighing against the unlock schedule."
          : ""
        : "";

    return {
      criterion: "tokenomics",
      label: "Tokenomics",
      findings: `Market cap: $${marketCap?.toLocaleString() ?? "n/a"}. Fully diluted valuation: $${fdv?.toLocaleString() ?? "n/a"}. Circulating supply: ${circPct ?? "n/a"}% of total supply. Max supply: ${md.max_supply?.toLocaleString() ?? "uncapped/unknown"}.${dilutionNote}`,
      data: {
        marketCap,
        fdv,
        circulatingSupply: circulating,
        totalSupply: total,
        maxSupply: md.max_supply,
        marketCapToFdvRatio: mcapFdvRatio,
      },
      confidence: "high",
    };
  } catch (err) {
    console.error("[tokenomics] failed:", err);
    return {
      criterion: "tokenomics",
      label: "Tokenomics",
      findings: "Failed to fetch tokenomics data.",
      confidence: "low",
    };
  }
}

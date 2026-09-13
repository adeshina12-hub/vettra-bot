import { config } from "../../config.js";
import type { CriterionResult, ProjectProfile } from "../../types.js";
import { fetchCoinGecko } from "../coingecko.js";

export async function analyzeCommunity(profile: ProjectProfile): Promise<CriterionResult> {
  const notes: string[] = [];
  const data: Record<string, unknown> = {};

  if (profile.coingeckoId) {
    try {
      const responseData = await fetchCoinGecko<any>(
        `/coins/${profile.coingeckoId}?localization=false&tickers=false&market_data=false&community_data=true&developer_data=false`
      );
      const cd = responseData.community_data ?? {};
      notes.push(
        `X/Twitter followers: ${cd.twitter_followers?.toLocaleString() ?? "n/a"}. Reddit subscribers: ${cd.reddit_subscribers?.toLocaleString() ?? "n/a"}.`
      );
      data.twitterFollowers = cd.twitter_followers;
      data.redditSubscribers = cd.reddit_subscribers;
    } catch (err) {
      console.error("[community] CoinGecko fetch failed:", err);
    }
  }

  // Sorsa gives a *quality* signal (is the account/community real vs. bot-heavy),
  // which raw follower counts can't — that's the point of including it here.
  if (config.social.sorsaApiKey && profile.twitterHandle) {
    try {
      const url = new URL("https://api.sorsa.io/v3/score");
      url.searchParams.set("username", profile.twitterHandle);
      const res = await fetch(url, { headers: { ApiKey: config.social.sorsaApiKey } });
      if (res.ok) {
        const scoreData = await res.json();
        notes.push(`Sorsa crypto-influence score for @${profile.twitterHandle}: ${scoreData.score?.toFixed?.(2) ?? scoreData.score}.`);
        data.sorsaScore = scoreData.score;
      }
    } catch (err) {
      console.error("[community] Sorsa fetch failed:", err);
    }
  }

  if (notes.length === 0) {
    return {
      criterion: "community_quality",
      label: "Community Quality",
      findings: "No community data available (project not listed, or no X handle resolved).",
      confidence: "low",
    };
  }

  return {
    criterion: "community_quality",
    label: "Community Quality",
    findings: notes.join(" "),
    data,
    confidence: notes.length > 1 ? "high" : "medium",
  };
}

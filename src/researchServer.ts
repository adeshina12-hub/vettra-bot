import express from "express";
import { runResearch } from "./research/runResearch.js";
import { analyzeMemeCoin } from "./research/memeCoin.js";
import { findDormantNftCollections } from "./research/nftCollections.js";
import { findEmergingNftCollections } from "./research/emergingNfts.js";
import { findUpcomingMints } from "./research/upcomingMints.js";
import { runAudit } from "./securityAudit.js";

/**
 * Standalone server for the research pipeline. Kept separate from the
 * Next.js app deliberately — LLM-driven multi-step research can take
 * 10-30+ seconds, which doesn't fit Next.js API routes' serverless
 * execution model. This process runs continuously; Next.js's
 * /api/research route just proxies to it.
 */

const app = express();
app.use(express.json());

app.post("/research", async (req, res) => {
  const { query } = req.body ?? {};
  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "Missing 'query' string in request body" });
    return;
  }

  try {
    const report = await runResearch(query);
    res.json(report);
  } catch (err) {
    console.error("[research-server] research run failed:", err);
    res.status(500).json({ error: "Research run failed", detail: String(err) });
  }
});

app.post("/meme", async (req, res) => {
  const { address } = req.body ?? {};
  if (!address || typeof address !== "string") {
    res.status(400).json({ error: "Missing 'address' string in request body" });
    return;
  }

  try {
    res.json(await analyzeMemeCoin(address));
  } catch (err) {
    console.error("[research-server] meme scan failed:", err);
    // Bad/unlisted addresses are user error, not a server fault — a 400 lets
    // the caller show the message instead of a generic failure.
    res.status(400).json({ error: "Meme coin scan failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/nfts/dormant", async (req, res) => {
  const limit = Number(req.query.limit ?? 5);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    res.status(400).json({ error: "'limit' must be an integer between 1 and 50" });
    return;
  }

  try {
    res.json(await findDormantNftCollections(limit));
  } catch (err) {
    console.error("[research-server] dormant NFT scan failed:", err);
    res.status(500).json({ error: "Dormant NFT scan failed", detail: String(err) });
  }
});

app.get("/nfts/emerging", async (req, res) => {
  const limit = Number(req.query.limit ?? 5);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    res.status(400).json({ error: "'limit' must be an integer between 1 and 50" });
    return;
  }

  try {
    res.json(await findEmergingNftCollections(limit));
  } catch (err) {
    console.error("[research-server] emerging NFT search failed:", err);
    res.status(500).json({ error: "Emerging NFT search failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/nfts/mints", async (req, res) => {
  const limit = Number(req.query.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    res.status(400).json({ error: "'limit' must be an integer between 1 and 50" });
    return;
  }

  try {
    res.json(await findUpcomingMints(limit, { offset: Number(req.query.offset ?? 0) || 0 }));
  } catch (err) {
    console.error("[research-server] upcoming mints failed:", err);
    res.status(502).json({ error: "Upcoming mints failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/audit", async (req, res) => {
  const { source } = req.body ?? {};
  if (!source || typeof source !== "string") {
    res.status(400).json({ error: "Missing 'source' string in request body" });
    return;
  }

  try {
    res.json(await runAudit(source));
  } catch (err) {
    console.error("[research-server] audit failed:", err);
    res.status(500).json({ error: "Security audit failed", detail: String(err) });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = Number(process.env.PORT ?? process.env.RESEARCH_SERVER_PORT ?? 5001);
app.listen(PORT, () => {
  console.log(`[research-server] listening on http://localhost:${PORT}`);
});

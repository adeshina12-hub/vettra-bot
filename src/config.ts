import "dotenv/config";

function required(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  // Deprecated — old signals-module scorer reads this directly. New code
  // should use config.llm instead. Left in place so it doesn't break until
  // the research-agent rebuild replaces scorer.ts.
  anthropicApiKey: required("ANTHROPIC_API_KEY"),

  llm: {
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    geminiApiKey: required("GEMINI_API_KEY"),
    chainGptApiKey: required("CHAIN_GPT_API_KEY"),
    geminiModel: required("GEMINI_MODEL", "gemini-3.6-flash"),
    chainGptResearchModel: required("CHAIN_GPT_RESEARCH_MODEL", "general_assistant"),
    chainGptAuditModel: required("CHAIN_GPT_AUDIT_MODEL", "smart_contract_auditor"),
    chainGptEnabled: required("CHAIN_GPT_ENABLED", "true").toLowerCase() === "true",
    dailySpendCapUsd: Number(required("LLM_DAILY_SPEND_CAP_USD", "5")),
    estimatedCallCostUsd: Number(required("LLM_ESTIMATED_CALL_COST_USD", "0.05")),
  },

  bot: {
    dailyReportLimit: Number(required("BOT_DAILY_REPORT_LIMIT", "5")),
    dailyEarlyScanLimit: Number(required("BOT_DAILY_EARLY_SCAN_LIMIT", "2")),
    dailyMemeScanLimit: Number(required("BOT_DAILY_MEME_SCAN_LIMIT", "15")),
    dailyNftScanLimit: Number(required("BOT_DAILY_NFT_SCAN_LIMIT", "10")),
    dailyNftSearchLimit: Number(required("BOT_DAILY_NFT_SEARCH_LIMIT", "10")),
    dailyMintScanLimit: Number(required("BOT_DAILY_MINT_SCAN_LIMIT", "15")),
    dailySnipeLimit: Number(required("BOT_DAILY_SNIPE_LIMIT", "25")),
    cacheMinutes: Number(required("BOT_REPORT_CACHE_MINUTES", "60")),
    analyticsAdminChatId: required("BOT_ANALYTICS_ADMIN_CHAT_ID"),
    // Permanent owners: always admin, and cannot be removed via bot commands.
    // Everyone else is granted/revoked at runtime with /addadmin, /removeadmin.
    adminUserIds: required("BOT_ADMIN_USER_IDS")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0),
  },

  coingecko: {
    apiKey: required("COINGECKO_API_KEY"),
  },

  // Optional — OpenSea's per-collection stats/metadata endpoints work
  // keyless. A key (https://docs.opensea.io) raises rate limits.
  opensea: {
    apiKey: required("OPENSEA_API_KEY"),
  },

  // Optional - GitHub allows 60 unauthenticated requests/hour, 5000 with a
  // token. A classic PAT with no scopes selected (public read access) is enough.
  github: {
    token: required("GITHUB_TOKEN"),
  },

  // Master key for encrypting custodial private keys at rest. 32 bytes as
  // hex (openssl rand -hex 32). Wallet features refuse to run without it.
  wallet: {
    encryptionKey: required("WALLET_ENCRYPTION_KEY"),
  },

  rpc: {
    eth: required("ETH_RPC_URL"),
    // Arc publishes no public RPC yet (it is absent from the canonical EVM
    // chain registry and every known endpoint refuses), so buying on Arc
    // stays off until an endpoint is supplied here.
    arc: required("ARC_RPC_URL"),
    // Verified against chainid.network and confirmed live via eth_chainId.
    robinhood: required("ROBINHOOD_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
    base: required("BASE_RPC_URL"),
    bsc: required("BSC_RPC_URL"),
  },

  social: {
    lunarCrushApiKey: required("LUNARCRUSH_API_KEY"),
    sorsaApiKey: required("SORSA_API_KEY"), // optional - only used for on-demand credibility lookups
    telegramMonitorBotToken: required("TELEGRAM_MONITOR_BOT_TOKEN"),
  },

  dune: {
    apiKey: required("DUNE_API_KEY"),
    queryId: required("DUNE_QUERY_ID"),
  },

  nansen: {
    apiKey: required("NANSEN_API_KEY"),
  },

  alertBot: {
    token: required("TELEGRAM_ALERT_BOT_TOKEN"),
    chatId: required("TELEGRAM_ALERT_CHAT_ID"),
  },

  moni: {
    apiKey: required("MONI_API_KEY"),
    dailyRequestCap: Number(required("MONI_DAILY_REQUEST_CAP", "100")),
  },

  dashboardPort: Number(required("DASHBOARD_PORT", "4000")),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceKey: required("SUPABASE_SERVICE_KEY"),
};

import "dotenv/config";
function required(name, fallback = "") {
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
        chainGptModel: required("CHAIN_GPT_MODEL", "general_assistant"),
        dailySpendCapUsd: Number(required("LLM_DAILY_SPEND_CAP_USD", "5")),
        estimatedCallCostUsd: Number(required("LLM_ESTIMATED_CALL_COST_USD", "0.05")),
    },
    bot: {
        dailyReportLimit: Number(required("BOT_DAILY_REPORT_LIMIT", "5")),
        cacheMinutes: Number(required("BOT_REPORT_CACHE_MINUTES", "60")),
        analyticsAdminChatId: required("BOT_ANALYTICS_ADMIN_CHAT_ID"),
    },
    coingecko: {
        apiKey: required("COINGECKO_API_KEY"),
    },
    // Optional - GitHub allows 60 unauthenticated requests/hour, 5000 with a
    // token. A classic PAT with no scopes selected (public read access) is enough.
    github: {
        token: required("GITHUB_TOKEN"),
    },
    rpc: {
        eth: required("ETH_RPC_URL"),
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
    },
    dashboardPort: Number(required("DASHBOARD_PORT", "4000")),
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceKey: required("SUPABASE_SERVICE_KEY"),
};

import { config } from "../../config.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { GeminiProvider } from "./geminiProvider.js";
import { ChainGptProvider } from "./chainGptProvider.js";
import { reserveLlmBudget } from "../../storage/db.js";
/**
 * Returns every provider that currently has a valid-looking key configured.
 * Gemini listed first so that when only a Gemini key is set (e.g. no
 * Anthropic credits yet), it's used without any other config change.
 */
export function getAvailableProviders() {
    const providers = [];
    if (config.llm.geminiApiKey)
        providers.push(new GeminiProvider());
    if (config.llm.anthropicApiKey)
        providers.push(new AnthropicProvider());
    if (config.llm.chainGptApiKey)
        providers.push(new ChainGptProvider());
    return providers;
}
/**
 * Runs the same prompt across every configured provider in parallel.
 * With one provider configured, this just calls it (no extra cost/latency
 * beyond that one call). With more than one, you get every model's
 * output back so a synthesis step can cross-check them — e.g. flag when
 * Gemini and Claude scored the same project very differently, which is
 * itself useful signal that the research is ambiguous.
 */
export async function generateWithConsensus(system, userPrompt, maxTokens = 4000) {
    const providers = getAvailableProviders();
    if (providers.length === 0) {
        throw new Error("No LLM provider configured — set GEMINI_API_KEY, ANTHROPIC_API_KEY, and/or CHAIN_GPT_API_KEY in .env");
    }
    const results = await Promise.all(providers.map(async (p) => {
        try {
            const allowed = await reserveLlmBudget(p.name, config.llm.estimatedCallCostUsd, config.llm.dailySpendCapUsd);
            if (!allowed)
                throw new Error(`daily LLM spend cap reached ($${config.llm.dailySpendCapUsd})`);
            const output = await p.generateJSON(system, userPrompt, maxTokens);
            return { provider: p.name, output };
        }
        catch (err) {
            console.error(`[llm] ${p.name} call failed:`, err);
            return { provider: p.name, output: null };
        }
    }));
    const primary = results.find((r) => r.output !== null)?.output ?? null;
    return { results, primary };
}

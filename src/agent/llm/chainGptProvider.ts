import { config } from "../../config.js";
import { parseJsonLoose, type LLMProvider } from "./provider.js";

const CHAIN_GPT_AUDITOR_URL = "https://api.chaingpt.org/chat/stream";

export class ChainGptProvider implements LLMProvider {
  readonly name = "chaingpt";

  constructor(private readonly model = config.llm.chainGptResearchModel) {}

  async generateJSON<T = any>(system: string, userPrompt: string): Promise<T | null> {
    const response = await fetch(CHAIN_GPT_AUDITOR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.llm.chainGptApiKey}`,
        "Content-Type": "application/json",
        Accept: "text/plain, application/json",
      },
      body: JSON.stringify({
        model: this.model,
        question: `${system}\n\n${userPrompt}`,
        chatHistory: "off",
      }),
    });

    if (!response.ok) {
      const errorBody = (await response.text()).slice(0, 500);
      throw new Error(`ChainGPT request failed: ${response.status} ${errorBody || "empty response"}`);
    }
    const text = await response.text();
    const parsedResponse = parseJsonLoose<{ data?: { bot?: string }; bot?: string }>(text);
    const output = parsedResponse?.data?.bot ?? parsedResponse?.bot ?? text;
    return parseJsonLoose<T>(output);
  }
}
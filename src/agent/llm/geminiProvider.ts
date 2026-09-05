import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config.js";
import { parseJsonLoose, type LLMProvider } from "./provider.js";

const GEMINI_MODEL = config.llm.geminiModel || "gemini-3.6-flash";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  private client: GoogleGenerativeAI;

  constructor() {
    this.client = new GoogleGenerativeAI(config.llm.geminiApiKey);
  }

  async generateJSON<T = any>(system: string, userPrompt: string, maxTokens = 4000): Promise<T | null> {
    const model = this.client.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: system,
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await model.generateContent(userPrompt);
        return parseJsonLoose<T>(result.response.text());
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (![429, 500, 502, 503, 504].includes(status ?? 0) || attempt === 2) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
      }
    }

    return null;
  }
}

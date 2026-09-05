import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config.js";
import { parseJsonLoose } from "./provider.js";
const GEMINI_MODEL = config.llm.geminiModel || "gemini-3.6-flash";
export class GeminiProvider {
    name = "gemini";
    client;
    constructor() {
        this.client = new GoogleGenerativeAI(config.llm.geminiApiKey);
    }
    async generateJSON(system, userPrompt, maxTokens = 4000) {
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
                return parseJsonLoose(result.response.text());
            }
            catch (err) {
                const status = err.status;
                if (![429, 500, 502, 503, 504].includes(status ?? 0) || attempt === 2)
                    throw err;
                await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
            }
        }
        return null;
    }
}

import { config } from "../../config.js";
import { parseJsonLoose } from "./provider.js";
const CHAIN_GPT_AUDITOR_URL = "https://api.chaingpt.org/chat/stream";
export class ChainGptProvider {
    model;
    name = "chaingpt";
    constructor(model = config.llm.chainGptResearchModel) {
        this.model = model;
    }
    async generateJSON(system, userPrompt) {
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
        const parsedResponse = parseJsonLoose(text);
        const output = parsedResponse?.data?.bot ?? parsedResponse?.bot ?? text;
        return parseJsonLoose(output);
    }
}

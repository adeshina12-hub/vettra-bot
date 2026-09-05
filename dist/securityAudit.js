import { generateWithConsensus, getAvailableAuditProviders } from "./agent/llm/index.js";
const MAX_SOURCE_LENGTH = 200_000;
const DISCLAIMER = "AI-assisted review only. This is not a formal security audit and must not be the sole basis for deploying a contract.";
const SYSTEM_PROMPT = `You are a senior smart-contract security auditor. Review Solidity code defensively and report only issues supported by the source. Return valid JSON only, with this exact shape:
{"contractName":"string","summary":"string","riskRating":"critical|high|medium|low|info","findings":[{"severity":"critical|high|medium|low|info","title":"string","category":"string","location":"string","explanation":"string","remediation":"string","confidence":"high|medium|low"}]}
Use an empty findings array when no issue is supported. Include reentrancy, access control, arithmetic, oracle, flash-loan, denial-of-service, upgradeability, validation, and economic risks where applicable. Never claim that an issue is exploitable without explaining the code path. Keep each finding actionable.`;
function normalizeFinding(finding) {
    const severities = new Set(["critical", "high", "medium", "low", "info"]);
    const confidence = new Set(["high", "medium", "low"]);
    return {
        severity: severities.has(finding.severity ?? "") ? finding.severity : "info",
        title: String(finding.title ?? "Unspecified finding"),
        category: String(finding.category ?? "General"),
        location: String(finding.location ?? "Not specified"),
        explanation: String(finding.explanation ?? "No explanation provided."),
        remediation: String(finding.remediation ?? "Review this behavior manually."),
        confidence: confidence.has(finding.confidence ?? "") ? finding.confidence : "low",
    };
}
export async function runAudit(source) {
    const normalizedSource = source.trim();
    if (!normalizedSource)
        throw new Error("Contract source is required");
    if (normalizedSource.length > MAX_SOURCE_LENGTH)
        throw new Error(`Contract source is too large (maximum ${MAX_SOURCE_LENGTH} characters)`);
    const result = await generateWithConsensus(SYSTEM_PROMPT, `Audit this Solidity contract. Return the exact JSON structure requested above.\n\nSolidity source:\n${normalizedSource}`, 8000, getAvailableAuditProviders());
    if (!result.primary)
        throw new Error("No configured LLM could complete the security audit");
    const riskRatings = new Set(["critical", "high", "medium", "low", "info"]);
    return {
        id: crypto.randomUUID(),
        contractName: result.primary.contractName || "Pasted Solidity contract",
        summary: result.primary.summary || "No summary was returned.",
        riskRating: riskRatings.has(result.primary.riskRating ?? "") ? result.primary.riskRating : "info",
        findings: (result.primary.findings ?? []).map(normalizeFinding),
        providers: result.results.filter((item) => item.output !== null).map((item) => item.provider),
        disclaimer: DISCLAIMER,
        createdAt: new Date().toISOString(),
    };
}

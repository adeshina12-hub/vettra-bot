import { Markup, Telegraf } from "telegraf";
import { config } from "../config.js";
import { runResearch } from "../research/runResearch.js";
import { findEarlyProjects, type EarlyScanResult } from "../research/earlyProjects.js";
import { claimBotEarlyScan, claimBotResearch, getBotAnalytics, getCachedReport, recordBotResearch, recordBotUser } from "../storage/db.js";
import type { Opportunity } from "../types.js";

const bot = config.alertBot.token ? new Telegraf(config.alertBot.token) : null;
const awaitingResearchName = new Set<number>();
const inFlightResearch = new Map<string, Promise<Awaited<ReturnType<typeof runResearch>>>>();

export async function sendOpportunityAlert(opp: Opportunity): Promise<void> {
  if (!bot || !config.alertBot.chatId) {
    console.log(`[telegram] (not configured) would alert: ${opp.title} (score ${opp.score})`);
    return;
  }

  const emoji = opp.score >= 85 ? "🔥" : opp.score >= 70 ? "⚡" : "👀";
  const message =
    `${emoji} *${escapeMd(opp.title)}*\n` +
    (opp.asset ? `Asset: \`${opp.asset}\`\n` : "") +
    `Score: *${opp.score}/100* · ${opp.category}\n\n` +
    `${escapeMd(opp.reasoning)}`;

  try {
    await bot.telegram.sendMessage(config.alertBot.chatId, message, { parse_mode: "MarkdownV2" });
  } catch (err) {
    console.error("[telegram] failed to send alert:", err);
  }
}

export function startUnifiedBot(): void {
  if (!bot) {
    console.log("[telegram] command bot disabled: TELEGRAM_ALERT_BOT_TOKEN is not configured");
    return;
  }

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      await recordBotUser(
        ctx.from.id,
        ctx.from.username,
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || undefined,
      );
    }
    return next();
  });

  bot.start(async (ctx) => {
    awaitingResearchName.delete(ctx.chat.id);
    await ctx.reply(welcomeMessage(), mainMenu());
  });

  bot.hears("Research a project", async (ctx) => {
    awaitingResearchName.add(ctx.chat.id);
    await ctx.reply(
      "🔎 *Research mode*\n\nSend me a project name or ticker, for example:\n`Ethereum`\n`AAVE`\n`Uniswap`\n\nI will gather the available signals and return a scored verdict.",
      { parse_mode: "Markdown", ...mainMenu(true) },
    );
  });

  bot.hears("Early projects", async (ctx) => {
    await ctx.reply("🌱 How many fresh projects should I scan? Choose a number or use /early 3.", earlyCountMenu());
  });

  bot.hears("Help", async (ctx) => {
    await ctx.reply(helpMessage(), mainMenu());
  });

  bot.hears("Back to menu", async (ctx) => {
    awaitingResearchName.delete(ctx.chat.id);
    await ctx.reply(welcomeMessage(), mainMenu());
  });

  bot.hears(/^Early scan: ([1-9]|10)$/, async (ctx) => {
    const match = ctx.message.text.match(/^Early scan: ([1-9]|10)$/);
    await runEarlyCommand(ctx, Number(match?.[1] ?? 3));
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpMessage(), mainMenu());
  });

  bot.command("analytics", async (ctx) => {
    if (String(ctx.chat.id) !== config.bot.analyticsAdminChatId) {
      await ctx.reply("This command is only available to the bot administrator.");
      return;
    }
    const analytics = await getBotAnalytics();
    const topProjects = analytics.topProjects.length
      ? analytics.topProjects.map((item, index) => `${index + 1}. ${item.query}: ${item.count}`).join("\n")
      : "No research yet.";
    await ctx.reply(`Analytics\nUnique users: ${analytics.users}\nReports run: ${analytics.reports}\nEarly scans: ${analytics.earlyScans}\n\nMost searched projects:\n${topProjects}`);
  });

  bot.command("research", async (ctx) => {
    const query = getCommandArgs(ctx.message.text);
    if (!query) {
      awaitingResearchName.add(ctx.chat.id);
      await ctx.reply("🔎 Send me the project name or ticker you want to research.", mainMenu(true));
      return;
    }

    await runResearchCommand(ctx, query);
  });

  bot.command("early", async (ctx) => {
    const rawLimit = getCommandArgs(ctx.message.text) || "3";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      await ctx.reply("Usage: /early [1-10]");
      return;
    }

    await runEarlyCommand(ctx, limit);
  });

  bot.on("text", async (ctx, next) => {
    if (!awaitingResearchName.has(ctx.chat.id)) return next();
    awaitingResearchName.delete(ctx.chat.id);
    await runResearchCommand(ctx, ctx.message.text.trim());
  });

  bot.catch(async (err, ctx) => {
    console.error(`[telegram] command failed for update ${ctx.update.update_id}:`, err);
    try {
      await ctx.reply("That request took too long or failed upstream. Please try again in a moment.", mainMenu());
    } catch (replyError) {
      console.error("[telegram] failed to send command error:", replyError);
    }
  });

  console.log("[telegram] starting unified command bot...");
  bot.launch({}, () => console.log("[telegram] unified command bot listening; try /help"))
    .catch((err) => {
      console.error("[telegram] failed to connect or start polling:", err);
      console.error("[telegram] make sure no other copy of this bot is running, then retry npm run bot");
      process.exit(1);
    });
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

function mainMenu(back = false) {
  return Markup.keyboard([
    ["Research a project", "Early projects"],
    ["Help", ...(back ? ["Back to menu"] : [])],
  ]).resize().persistent();
}

function earlyCountMenu() {
  return Markup.keyboard([["Early scan: 1", "Early scan: 3", "Early scan: 5"], ["Early scan: 10"], ["Help"]]).resize().oneTime();
}

function welcomeMessage(): string {
  return "🚀 *Welcome to Vettra Research*\n\n" +
    "Your Web3 research desk for project signals, early builders, and clear verdicts.\n\n" +
    "Choose a workflow below to get started.";
}

function helpMessage(): string {
  return "💡 *How I can help*\n\n" +
    "🔎 *Research a project*\nSend a name or ticker and I will return a scored research verdict, strengths, and red flags.\n\n" +
    "🌱 *Early projects*\nScan for promising early builders.\n\n" +
    "Shortcuts: /research <name> · /early [1-10]";
}

async function runResearchCommand(ctx: {
  reply: (text: string, extra?: object) => Promise<unknown>;
  from?: { id: number };
}, query: string): Promise<void> {
  if (!query) {
    await ctx.reply("Please enter a project name or ticker.", mainMenu(true));
    return;
  }
  if (!ctx.from) {
    await ctx.reply("I could not identify your Telegram account. Please try again.", mainMenu());
    return;
  }

  try {
    const claimed = await claimBotResearch(ctx.from.id, query, config.bot.dailyReportLimit);
    if (!claimed) {
      await ctx.reply(`Daily limit reached. You can run up to ${config.bot.dailyReportLimit} reports per day.`, mainMenu());
      return;
    }

    const cached = await getCachedReport(query, config.bot.cacheMinutes);
    if (cached) {
      await recordBotResearch(ctx.from.id, query, true);
      await ctx.reply(formatResearchReport(cached), { parse_mode: "MarkdownV2", ...mainMenu() });
      return;
    }

    await ctx.reply(`🔎 Researching ${query}...`);
    const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
    let research = inFlightResearch.get(normalized);
    if (!research) {
      research = runResearch(query);
      inFlightResearch.set(normalized, research);
      void research.finally(() => inFlightResearch.delete(normalized));
    }
    const report = await research;
    await recordBotResearch(ctx.from.id, query, false);
    await ctx.reply(formatResearchReport(report), { parse_mode: "MarkdownV2", ...mainMenu() });
  } catch (err) {
    console.error("[telegram] research command failed:", err);
    await ctx.reply(`Research failed: ${String(err).slice(0, 300)}`, mainMenu());
  }
}

async function runEarlyCommand(ctx: {
  reply: (text: string, extra?: object) => Promise<unknown>;
  from?: { id: number };
}, limit: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("I could not identify your Telegram account. Please try again.", mainMenu());
    return;
  }
  await ctx.reply(`🌱 Fetching ${limit} early projects...`);
  try {
    const claimed = await claimBotEarlyScan(userId, config.bot.dailyEarlyScanLimit);
    if (!claimed) {
      await ctx.reply(`Daily early-project limit reached. You can run up to ${config.bot.dailyEarlyScanLimit} scans per day.`, mainMenu());
      return;
    }
    const scan = await findEarlyProjects(limit);
    await ctx.reply(formatEarlyResults(scan), { parse_mode: "MarkdownV2", ...mainMenu() });
  } catch (err) {
    console.error("[telegram] early command failed:", err);
    await ctx.reply(`Early-project scan failed: ${String(err).slice(0, 300)}`, mainMenu());
  }
}

function getCommandArgs(text: string): string {
  return text.replace(/^\/\S+\s*/, "").trim();
}

function formatResearchReport(report: Awaited<ReturnType<typeof runResearch>>): string {
  const strengths = report.strengths.length ? report.strengths.map((item) => `• ${escapeMd(item)}`).join("\n") : "None reported";
  const redFlags = report.redFlags.length ? report.redFlags.map((item) => `• ${escapeMd(item)}`).join("\n") : "None reported";
  return `*${escapeMd(report.profile.name)}*\nScore: *${report.overallScore}/100*\nVerdict: *${escapeMd(report.verdict)}*\n\n*Strengths*\n${strengths}\n\n*Red flags*\n${redFlags}`;
}

function formatEarlyResults(scan: EarlyScanResult): string {
  if (!scan.projects.length) return "No projects found in the current feed\\.";
  return scan.projects.map((item) => {
    const candidate = item.candidate;
    const link = candidate.xHandle ? `https://x.com/${candidate.xHandle.replace(/^@/, "")}` : candidate.url || candidate.repoUrl;
    const handle = candidate.xHandle ? `@${candidate.xHandle.replace(/^@/, "")}` : candidate.name;
    return `🚀 *NEW WEB3 PROJECT*\n\n*${escapeMd(handle)}*\nFollowers: ${candidate.xFollowers ?? "unknown"}\nKey followers: ${candidate.smartFollowers ?? "unknown"}\nChain: ${escapeMd(item.score.chain)}\nCategory: ${escapeMd(item.score.category)}\nStage: ${escapeMd(item.score.stage)}\nScore: *${item.score.score}/100*\n\nDescription: ${escapeMd(candidate.description || "No description available")}${link ? `\n\nX: [${escapeMd(link)}](${escapeMd(link)})` : ""}`;
  }).join("\n\n");
}

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

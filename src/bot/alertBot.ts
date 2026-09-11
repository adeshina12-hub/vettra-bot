import { Markup, Telegraf } from "telegraf";
import { config } from "../config.js";
import { runResearch } from "../research/runResearch.js";
import { findEarlyProjects, type EarlyScanResult } from "../research/earlyProjects.js";
import { analyzeMemeCoin, formatAge, fmtPct, looksLikeContractAddress, price, usd } from "../research/memeCoin.js";
import { findDormantNftCollections, type DormantNftScanResult } from "../research/nftCollections.js";
import { findEmergingNftCollections, type EmergingNftScanResult } from "../research/emergingNfts.js";
import { findUpcomingMints, type UpcomingMintScanResult } from "../research/upcomingMints.js";
import { grantAdmin, isAdmin, isOwner, listAdmins, refreshAdmins, revokeAdmin } from "./admins.js";
import { createWallet, exportPrivateKey, getBalances, getWallet, isTradableChain, tradableChains, withdraw, type SupportedChain } from "../wallet/wallet.js";
import { executeSnipe } from "../wallet/snipe.js";
import { CHAIN_LABELS, SELECTABLE_CHAINS, looksLikeNftContract, lookupNftByContract, type NftLookupResult } from "../research/nftLookup.js";
import { claimBotEarlyScan, claimBotMemeScan, claimBotMintScan, claimBotNftScan, claimBotNftSearch, claimBotSnipeLookup, claimBotResearch, findBotUserByUsername, getBotAnalytics, getCachedReport, recordBotResearch, recordBotUser } from "../storage/db.js";
import type { MemeCoinReport, Opportunity } from "../types.js";

const bot = config.alertBot.token ? new Telegraf(config.alertBot.token) : null;
const awaitingResearchName = new Set<number>();
const awaitingMemeAddress = new Set<number>();
const awaitingNftContract = new Set<number>();
/** Chain the user picked for their next snipe; absent means search all. */
const snipeChainChoice = new Map<number, string>();
/** Last snipe lookup per user, so /buy <n> knows which listing was meant. */
const lastSnipeLookup = new Map<number, NftLookupResult>();
const inFlightResearch = new Map<string, Promise<Awaited<ReturnType<typeof runResearch>>>>();
const inFlightMemeScans = new Map<string, Promise<MemeCoinReport>>();
// Telegram rejects messages over 4096 characters outright.
const TELEGRAM_MAX_MESSAGE = 3900;

/**
 * Per-user read positions into each ranked list. The scanners rank far more
 * results than one reply shows, so without these a user scanning repeatedly
 * would see the identical entries every time. Each scan advances the user's
 * position and wraps at the end.
 */
const scanOffsets = new Map<string, number>();

function takeOffset(kind: string, userId: number, shown: number): number {
  const key = `${kind}:${userId}`;
  const current = scanOffsets.get(key) ?? 0;
  scanOffsets.set(key, current + shown);
  return current;
}

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
    clearModes(ctx.chat.id);
    await ctx.reply(welcomeMessage(), mainMenu());
  });

  bot.hears("Research a project", async (ctx) => {
    clearModes(ctx.chat.id);
    awaitingResearchName.add(ctx.chat.id);
    await ctx.reply(
      "🔎 *Research mode*\n\nSend me a project name or ticker, for example:\n`Ethereum`\n`AAVE`\n`Uniswap`\n\nI will gather the available signals and return a scored verdict.",
      { parse_mode: "Markdown", ...mainMenu(true) },
    );
  });

  bot.hears("Meme coin scan", async (ctx) => {
    clearModes(ctx.chat.id);
    awaitingMemeAddress.add(ctx.chat.id);
    await ctx.reply(memeModeMessage(), { parse_mode: "Markdown", ...mainMenu(true) });
  });

  bot.hears("Early projects", async (ctx) => {
    clearModes(ctx.chat.id);
    await ctx.reply("🌱 How many fresh projects should I scan? Choose a number or use /early 3.", earlyCountMenu());
  });

  bot.hears("NFT search", async (ctx) => {
    clearModes(ctx.chat.id);
    await ctx.reply("🔭 How many early collections should I surface? Each scan shows different ones.", countMenu("NFT scan"));
  });

  bot.hears(/^NFT scan: ([1-9]|10)$/, async (ctx) => {
    await runNftSearchCommand(ctx, Number(ctx.message.text.match(/([1-9]|10)$/)?.[1] ?? 5));
  });

  bot.command("nftsearch", async (ctx) => {
    const rawLimit = getCommandArgs(ctx.message.text) || "5";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      await ctx.reply("Usage: /nftsearch [1-10]");
      return;
    }

    clearModes(ctx.chat.id);
    await runNftSearchCommand(ctx, limit);
  });

  bot.hears("Upcoming mints", async (ctx) => {
    clearModes(ctx.chat.id);
    await ctx.reply("🗓 How many upcoming mints should I pull? Each scan shows different ones.", countMenu("Mint scan"));
  });

  bot.hears(/^Mint scan: ([1-9]|10)$/, async (ctx) => {
    await runMintsCommand(ctx, Number(ctx.message.text.match(/([1-9]|10)$/)?.[1] ?? 5));
  });

  bot.command("mints", async (ctx) => {
    const rawLimit = getCommandArgs(ctx.message.text) || "5";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      await ctx.reply("Usage: /mints [1-10]");
      return;
    }

    clearModes(ctx.chat.id);
    await runMintsCommand(ctx, limit);
  });

  bot.hears("NFT snipe", async (ctx) => {
    clearModes(ctx.chat.id);
    await ctx.reply("🎯 Which chain is the NFT on?", chainMenu());
  });

  bot.hears(/^Chain: (.+)$/, async (ctx) => {
    const label = ctx.message.text.replace(/^Chain: /, "").trim();
    clearModes(ctx.chat.id);

    if (label === "Any") {
      snipeChainChoice.delete(ctx.chat.id);
    } else {
      const chain = SELECTABLE_CHAINS.find((key) => CHAIN_LABELS[key] === label);
      if (!chain) {
        await ctx.reply("Unknown chain. Pick one from the keyboard.", chainMenu());
        return;
      }
      snipeChainChoice.set(ctx.chat.id, chain);
    }

    awaitingNftContract.add(ctx.chat.id);
    await ctx.reply(snipeModeMessage(snipeChainChoice.get(ctx.chat.id)), { parse_mode: "Markdown", ...mainMenu(true) });
  });

  bot.command("snipe", async (ctx) => {
    const [address, chainArg] = getCommandArgs(ctx.message.text).split(/\s+/);
    if (!address) {
      clearModes(ctx.chat.id);
      await ctx.reply("🎯 Which chain is the NFT on?", chainMenu());
      return;
    }
    if (chainArg) {
      const chain = SELECTABLE_CHAINS.find((key) => key === chainArg.toLowerCase());
      if (!chain) {
        await ctx.reply(`Unknown chain "${chainArg}". Options: ${SELECTABLE_CHAINS.join(", ")}`);
        return;
      }
      snipeChainChoice.set(ctx.chat.id, chain);
    }
    await runNftSnipeLookup(ctx, address, snipeChainChoice.get(ctx.chat.id));
  });

  bot.command("buy", async (ctx) => {
    const index = Number(getCommandArgs(ctx.message.text) || "1");
    if (!Number.isInteger(index) || index < 1 || index > 5) {
      await ctx.reply("Usage: /buy <1-5> — the number next to the listing you want.");
      return;
    }
    await runNftBuy(ctx, index);
  });

  bot.hears("Wallet", async (ctx) => {
    clearModes(ctx.chat.id);
    await runWalletCommand(ctx);
  });

  bot.command("wallet", async (ctx) => {
    clearModes(ctx.chat.id);
    await runWalletCommand(ctx);
  });

  bot.command("balance", async (ctx) => {
    await runWalletCommand(ctx);
  });

  bot.command("deposit", async (ctx) => {
    try {
      const wallet = await getWallet(ctx.from.id);
      if (!wallet) {
        await ctx.reply("You do not have a wallet yet. Use /wallet to create one.", mainMenu());
        return;
      }
      await ctx.reply(
        `Send ETH on *Base* or BNB on *BNB Chain* to this address\\.\n\n` +
        `${escapeMd("Both chains use the same address:")}\n\`${wallet.address}\`\n\n` +
        `⚠️ ${escapeMd("Only send on Base or BNB Chain. Funds sent on other networks are lost.")}`,
        { parse_mode: "MarkdownV2", ...mainMenu() },
      );
    } catch (err) {
      await ctx.reply(walletErrorMessage(err), mainMenu());
    }
  });

  bot.command("withdraw", async (ctx) => {
    const [chainArg, to, amount] = getCommandArgs(ctx.message.text).split(/\s+/);
    if (!chainArg || !to || !amount) {
      await ctx.reply(
        "Usage: /withdraw <base|bsc> <address> <amount|max>\n\n" +
        "Example: /withdraw base 0xYourAddress 0.01\n" +
        "Example: /withdraw bsc 0xYourAddress max",
      );
      return;
    }
    if (!isTradableChain(chainArg.toLowerCase())) {
      const options = tradableChains().map((item) => item.key).join(", ") || "none configured";
      await ctx.reply(`Chain must be one of: ${options}.`);
      return;
    }

    try {
      await ctx.reply("Sending...");
      const result = await withdraw(ctx.from.id, chainArg.toLowerCase() as SupportedChain, to, amount === "max" ? "max" : amount);
      await ctx.reply(
        `✅ Sent ${escapeMd(result.amount)} ${escapeMd(result.symbol)}\\.\n\n[View transaction](${escapeUrl(result.explorerUrl)})`,
        // Telegraf's typings for a raw ctx use link_preview_options, not the
        // legacy disable_web_page_preview the structurally-typed helpers pass.
        { parse_mode: "MarkdownV2", link_preview_options: { is_disabled: true }, ...mainMenu() },
      );
    } catch (err) {
      await ctx.reply(walletErrorMessage(err), mainMenu());
    }
  });

  bot.command("export", async (ctx) => {
    if (getCommandArgs(ctx.message.text).trim().toUpperCase() !== "CONFIRM") {
      await ctx.reply(
        "⚠️ This reveals your private key in this chat.\n\n" +
        "Anyone who sees it controls your funds, and Telegram keeps message history on its servers. " +
        "Move your funds out first if you are unsure.\n\n" +
        "If you understand, send:  /export CONFIRM",
      );
      return;
    }

    try {
      const key = await exportPrivateKey(ctx.from.id);
      await ctx.reply(
        `${escapeMd("Your private key:")}\n\n\`${key}\`\n\n${escapeMd("Delete this message once you have saved it.")}`,
        { parse_mode: "MarkdownV2" },
      );
    } catch (err) {
      await ctx.reply(walletErrorMessage(err), mainMenu());
    }
  });

  bot.command("myid", async (ctx) => {
    // So a user can send their id to an owner who wants to grant them access.
    await ctx.reply(`Your Telegram user ID is ${ctx.from.id}`);
  });

  bot.command("admins", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    try {
      const { owners, granted } = await listAdmins();
      const grantedList = granted.length
        ? granted.map((row) => `• ${row.username ? `@${row.username}` : row.display_name ?? "unknown"} (${row.telegram_user_id})`).join("\n")
        : "• none";
      await ctx.reply(`Admins\n\nOwners (from env, permanent):\n${owners.map((id) => `• ${id}`).join("\n") || "• none"}\n\nGranted:\n${grantedList}\n\nAdd with /addadmin <user id or @username>`);
    } catch (err) {
      await ctx.reply(adminErrorMessage(err));
    }
  });

  bot.command("addadmin", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const target = await resolveUserArg(getCommandArgs(ctx.message.text));
    if (!target) {
      await ctx.reply("Usage: /addadmin <user id or @username>\n\nThe user must have messaged the bot before you can add them by @username. Otherwise ask them for /myid.");
      return;
    }

    try {
      await grantAdmin(target.id, target.username);
      await ctx.reply(`✅ ${target.label} is now an admin. They can now use /nfts and /analytics.`);
    } catch (err) {
      await ctx.reply(adminErrorMessage(err));
    }
  });

  bot.command("removeadmin", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const target = await resolveUserArg(getCommandArgs(ctx.message.text));
    if (!target) {
      await ctx.reply("Usage: /removeadmin <user id or @username>");
      return;
    }
    if (isOwner(target.id)) {
      await ctx.reply("That user is a permanent owner (set in BOT_ADMIN_USER_IDS) and cannot be removed from inside the bot.");
      return;
    }

    try {
      await revokeAdmin(target.id);
      await ctx.reply(`✅ ${target.label} is no longer an admin.`);
    } catch (err) {
      await ctx.reply(adminErrorMessage(err));
    }
  });

  bot.hears("Help", async (ctx) => {
    await ctx.reply(helpMessage(ctx.from?.id), mainMenu());
  });

  bot.hears("Back to menu", async (ctx) => {
    clearModes(ctx.chat.id);
    await ctx.reply(welcomeMessage(), mainMenu());
  });

  bot.hears(/^Early scan: ([1-9]|10)$/, async (ctx) => {
    const match = ctx.message.text.match(/^Early scan: ([1-9]|10)$/);
    await runEarlyCommand(ctx, Number(match?.[1] ?? 3));
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpMessage(ctx.from?.id), mainMenu());
  });

  bot.command("analytics", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const analytics = await getBotAnalytics();
    const topProjects = analytics.topProjects.length
      ? analytics.topProjects.map((item, index) => `${index + 1}. ${item.query}: ${item.count}`).join("\n")
      : "No research yet.";
    const topMemes = analytics.topMemeTokens.length
      ? analytics.topMemeTokens.map((item, index) => `${index + 1}. ${item.query}: ${item.count}`).join("\n")
      : "No meme scans yet.";
    await ctx.reply(`Analytics\nUnique users: ${analytics.users}\nReports run: ${analytics.reports}\nEarly scans: ${analytics.earlyScans}\nMeme scans: ${analytics.memeScans}\nNFT scans: ${analytics.nftScans}\n\nMost searched projects:\n${topProjects}\n\nMost scanned meme tokens:\n${topMemes}`);
  });

  bot.command("research", async (ctx) => {
    const query = getCommandArgs(ctx.message.text);
    if (!query) {
      clearModes(ctx.chat.id);
      awaitingResearchName.add(ctx.chat.id);
      await ctx.reply("🔎 Send me the project name or ticker you want to research.", mainMenu(true));
      return;
    }

    await runResearchCommand(ctx, query);
  });

  bot.command("meme", async (ctx) => {
    const address = getCommandArgs(ctx.message.text);
    if (!address) {
      clearModes(ctx.chat.id);
      awaitingMemeAddress.add(ctx.chat.id);
      await ctx.reply(memeModeMessage(), { parse_mode: "Markdown", ...mainMenu(true) });
      return;
    }

    await runMemeCommand(ctx, address);
  });

  bot.command("nfts", async (ctx) => {
    const rawLimit = getCommandArgs(ctx.message.text) || "5";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      await ctx.reply("Usage: /nfts [1-10]");
      return;
    }

    clearModes(ctx.chat.id);
    await runNftCommand(ctx, limit);
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
    const text = ctx.message.text.trim();

    if (awaitingNftContract.has(ctx.chat.id)) {
      awaitingNftContract.delete(ctx.chat.id);
      await runNftSnipeLookup(ctx, text, snipeChainChoice.get(ctx.chat.id));
      return;
    }

    if (awaitingMemeAddress.has(ctx.chat.id)) {
      awaitingMemeAddress.delete(ctx.chat.id);
      await runMemeCommand(ctx, text);
      return;
    }

    if (awaitingResearchName.has(ctx.chat.id)) {
      awaitingResearchName.delete(ctx.chat.id);
      // A pasted contract address is never a project name — route it to the
      // scanner rather than sending "0x…" to the CoinGecko resolver.
      if (looksLikeContractAddress(text)) {
        await runMemeCommand(ctx, text);
        return;
      }
      await runResearchCommand(ctx, text);
      return;
    }

    // Outside any mode, a bare contract address is an unambiguous request to
    // scan that token — no menu step needed.
    if (looksLikeContractAddress(text)) {
      await runMemeCommand(ctx, text);
      return;
    }

    return next();
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
  // Warm the admin cache before the first message arrives, so an admin's very
  // first reply already carries the admin keyboard.
  void refreshAdmins();
  bot.launch({}, () => console.log("[telegram] unified command bot listening; try /help"))
    .catch((err) => {
      console.error("[telegram] failed to connect or start polling:", err);
      console.error("[telegram] make sure no other copy of this bot is running, then retry npm run bot");
      process.exit(1);
    });
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

/**
 * Every button here is available to everyone. Admin-only features are
 * command-only and never appear on the keyboard (like /analytics), so the
 * menu does not vary by user.
 */
function mainMenu(back = false) {
  return Markup.keyboard([
    ["Early projects", "Meme coin scan"],
    ["NFT search", "Upcoming mints"],
    ["NFT snipe", "Wallet"],
    ["Research a project", "Help"],
    ...(back ? [["Back to menu"]] : []),
  ]).resize().persistent();
}

function clearModes(chatId: number): void {
  awaitingResearchName.delete(chatId);
  awaitingMemeAddress.delete(chatId);
  awaitingNftContract.delete(chatId);
}

/**
 * Runtime admin management needs the bot_users.is_admin column. Until that
 * migration is applied, env-based owners still work — so point at the fix
 * rather than surfacing a raw PostgREST error.
 */
function adminErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (detail.includes("is_admin")) {
    return "The admin table is not migrated yet. Run this once in the Supabase SQL editor:\n\n" +
      "alter table bot_users add column if not exists is_admin boolean not null default false;\n\n" +
      "Owners in BOT_ADMIN_USER_IDS keep working without it.";
  }
  return `Admin update failed: ${detail.slice(0, 300)}`;
}

/** Replies with a refusal and returns false when the sender is not an admin. */
async function requireAdmin(ctx: {
  reply: (text: string, extra?: object) => Promise<unknown>;
  from?: { id: number };
}): Promise<boolean> {
  if (isAdmin(ctx.from?.id)) return true;
  // Re-check against the database before refusing: the cache may be cold on a
  // fresh restart, or stale for an admin granted seconds ago on another node.
  await refreshAdmins();
  if (isAdmin(ctx.from?.id)) return true;
  await ctx.reply("🔒 This command is admin-only.");
  return false;
}

/**
 * Accepts either a numeric Telegram user id or an @username. Usernames can
 * only be resolved for people the bot has already seen — Telegram gives bots
 * no way to look up a username they have never interacted with.
 */
async function resolveUserArg(arg: string): Promise<{ id: number; username?: string; label: string } | null> {
  const value = arg.trim();
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) {
    return { id: numeric, label: String(numeric) };
  }

  if (!value.startsWith("@")) return null;
  const match = await findBotUserByUsername(value);
  if (!match) return null;
  return {
    id: match.telegram_user_id,
    username: match.username ?? undefined,
    label: match.username ? `@${match.username}` : String(match.telegram_user_id),
  };
}

function earlyCountMenu() {
  return Markup.keyboard([["Early scan: 1", "Early scan: 3", "Early scan: 5"], ["Early scan: 10"], ["Help"]]).resize().oneTime();
}

/** Count picker shared by the NFT search and upcoming-mint scans. */
function countMenu(prefix: string) {
  return Markup.keyboard([
    [`${prefix}: 3`, `${prefix}: 5`],
    [`${prefix}: 8`, `${prefix}: 10`],
    ["Back to menu"],
  ]).resize().oneTime();
}

function welcomeMessage(): string {
  return "🚀 *Welcome to Vettra Research*\n\n" +
    "Your Web3 research desk for project signals, early builders, and clear verdicts.\n\n" +
    "Choose a workflow below to get started.";
}

function helpMessage(userId?: number): string {
  const base = "💡 *How I can help*\n\n" +
    "🌱 *Early projects*\nScan for promising early builders.\n\n" +
    "🐸 *Meme coin scan*\nPaste any token contract address and I will pull its live DexScreener price, market cap, FDV, and liquidity, run contract-safety checks (honeypot, LP lock, mint authority, whale concentration), and give you a degen verdict.\n\n" +
    "🔎 *Research a project*\nSend a name or ticker and I will return a scored research verdict, strengths, and red flags.\n\n" +
    "🔭 *NFT search*\nEarly OpenSea collections that are still small but already picking up real trading traction, scored 0-100 on potential — with their X handle and website.\n\n" +
    "🗓 *Upcoming mints*\nNFT mints that have not happened yet, pulled live from Mint Deck with date, supply, price and socials.\n\n" +
    "🎯 *NFT snipe*\nPaste an NFT contract address to see its floor, volume, owners and cheapest live listings, then buy straight from your bot wallet. Links to OpenSea, Blur, Magic Eden, Element and OKX too.\n\n" +
    "👛 *Wallet*\nA trading wallet on Base and BNB Chain, created for you here. Fund it, check balances, and withdraw any time.\n\n" +
    "Every scan lets you pick how many results you want, and shows different ones each time.\n\n" +
    "Shortcuts: /early [1-10] · /meme <contract> · /research <name> · /nftsearch [1-10] · /mints [1-10]\n" +
    "Wallet: /wallet · /deposit · /withdraw <base or bsc> <address> <amount or max> · /export";

  if (!isAdmin(userId)) return base;

  return base + "\n\n" +
    "🔒 *Admin only* (no buttons, commands only)\n" +
    "🖼 *Dormant NFTs* — /nfts [1-10]\nBlue-chip collections that traded huge volume historically but have gone quiet, with their X handle and website.\n\n" +
    "Admin commands: /nfts [1-10] · /analytics · /admins · /addadmin <id or @user> · /removeadmin <id or @user>";
}

function memeModeMessage(): string {
  return "🐸 *Meme coin scan*\n\nPaste the token's contract address and I will do the due diligence.\n\n" +
    "EVM (ETH, Base, BSC, Arbitrum…):\n`0x6982508145454Ce325dDbE47a25d4ec3d2311933`\n\n" +
    "Solana mint address:\n`DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`\n\n" +
    "You get price, market cap, FDV, liquidity, volume, buy/sell flow, contract-safety checks, and a degen score out of 100.";
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

async function runMemeCommand(ctx: {
  reply: (text: string, extra?: object) => Promise<unknown>;
  from?: { id: number };
}, rawAddress: string): Promise<void> {
  const address = rawAddress.trim();
  if (!ctx.from) {
    await ctx.reply("I could not identify your Telegram account. Please try again.", mainMenu());
    return;
  }
  if (!looksLikeContractAddress(address)) {
    await ctx.reply(
      "That does not look like a contract address.\n\nSend an EVM address starting with 0x, or a Solana mint address. You can copy it from the DexScreener page of the token.",
      mainMenu(true),
    );
    return;
  }

  try {
    const claimed = await claimBotMemeScan(ctx.from.id, address, config.bot.dailyMemeScanLimit);
    if (!claimed) {
      await ctx.reply(`Daily limit reached. You can run up to ${config.bot.dailyMemeScanLimit} meme scans per day.`, mainMenu());
      return;
    }

    await ctx.reply("🐸 Scanning the contract, liquidity, and holders...");

    // Same de-duplication the research flow uses: several users hitting the
    // same trending contract at once share one set of upstream calls.
    const key = address.toLowerCase();
    let scan = inFlightMemeScans.get(key);
    if (!scan) {
      scan = analyzeMemeCoin(address);
      inFlightMemeScans.set(key, scan);
      void scan.finally(() => inFlightMemeScans.delete(key));
    }
    const report = await scan;
    await ctx.reply(formatMemeReport(report), { parse_mode: "MarkdownV2", disable_web_page_preview: true, ...mainMenu() });
  } catch (err) {
    console.error("[telegram] meme scan failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Meme scan failed: ${detail.slice(0, 300)}`, mainMenu());
  }
}

async function runNftCommand(ctx: {
  reply: (text: string, extra?: object) => Promise<unknown>;
  from?: { id: number };
}, limit: number): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("I could not identify your Telegram account. Please try again.", mainMenu());
    return;
  }

  // The real gate. Hiding the button is cosmetic — a non-admin can still type
  // /nfts or send the button's text, so authorization is enforced here.
  if (!isAdmin(ctx.from.id)) {
    // The cache may simply be cold or stale for a freshly granted admin.
    await refreshAdmins();
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("🔒 The dormant NFT scanner is admin-only.", mainMenu());
      return;
    }
  }

  try {
    const claimed = await claimBotNftScan(ctx.from.id, config.bot.dailyNftScanLimit);
    if (!claimed) {
      await ctx.reply(`Daily limit reached. You can run up to ${config.bot.dailyNftScanLimit} NFT scans per day.`, mainMenu());
      return;
    }

    await ctx.reply("🖼 Checking OpenSea for blue chips that have gone quiet...");
    const scan = await findDormantNftCollections(limit, { offset: takeOffset("nfts", ctx.from.id, limit) });
    await ctx.reply(formatNftScan(scan), { parse_mode: "MarkdownV2", disable_web_page_preview: true, ...mainMenu() });
  } catch (err) {
    console.error("[telegram] NFT scan failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Dormant NFT scan failed: ${detail.slice(0, 300)}`, mainMenu());
  }
}

async function runNftSearchCommand(ctx: {
  reply: (text: string, extra?: object) => Promise<unknown>;
  from?: { id: number };
}, limit: number): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("I could not identify your Telegram account. Please try again.", mainMenu());
    return;
  }

  try {
    const claimed = await claimBotNftSearch(ctx.from.id, config.bot.dailyNftSearchLimit);
    if (!claimed) {
      await ctx.reply(`Daily limit reached. You can run up to ${config.bot.dailyNftSearchLimit} NFT searches per day.`, mainMenu());
      return;
    }

    await ctx.reply("🔭 Scanning OpenSea for early collections picking up traction...");
    const scan = await findEmergingNftCollections(limit, { offset: takeOffset("nftsearch", ctx.from.id, limit) });
    await ctx.reply(formatNftSearch(scan), { parse_mode: "MarkdownV2", disable_web_page_preview: true, ...mainMenu() });
  } catch (err) {
    console.error("[telegram] NFT search failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    await ctx.reply(`NFT search failed: ${detail.slice(0, 300)}`, mainMenu());
  }
}

async function runMintsCommand(ctx: {
  reply: (text: string, extra?: object) => Promise<unknown>;
  from?: { id: number };
}, limit: number): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("I could not identify your Telegram account. Please try again.", mainMenu());
    return;
  }

  try {
    const claimed = await claimBotMintScan(ctx.from.id, config.bot.dailyMintScanLimit);
    if (!claimed) {
      await ctx.reply(`Daily limit reached. You can run up to ${config.bot.dailyMintScanLimit} mint scans per day.`, mainMenu());
      return;
    }

    await ctx.reply("🗓 Pulling upcoming mints from Mint Deck...");
    const scan = await findUpcomingMints(limit, { offset: takeOffset("mints", ctx.from.id, limit) });
    await ctx.reply(formatMints(scan), { parse_mode: "MarkdownV2", disable_web_page_preview: true, ...mainMenu() });
  } catch (err) {
    console.error("[telegram] mint scan failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Upcoming mints failed: ${detail.slice(0, 300)}`, mainMenu());
  }
}

async function runNftSnipeLookup(ctx: {
  reply: (text: string, extra?: object) => Promise<unknown>;
  from?: { id: number };
}, rawAddress: string, chainHint?: string): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("I could not identify your Telegram account. Please try again.", mainMenu());
    return;
  }
  if (!looksLikeNftContract(rawAddress)) {
    await ctx.reply("That does not look like an NFT contract address. Send an EVM address starting with 0x.", mainMenu(true));
    return;
  }

  try {
    const claimed = await claimBotSnipeLookup(ctx.from.id, config.bot.dailySnipeLimit);
    if (!claimed) {
      await ctx.reply(`Daily limit reached. You can run up to ${config.bot.dailySnipeLimit} NFT lookups per day.`, mainMenu());
      return;
    }

    await ctx.reply(
      chainHint
        ? `🎯 Looking that up on ${CHAIN_LABELS[chainHint] ?? chainHint}...`
        : "🎯 Finding that collection and its cheapest listings..."
    );
    const result = await lookupNftByContract(rawAddress, chainHint);
    lastSnipeLookup.set(ctx.from.id, result);
    await ctx.reply(formatNftSnipe(result), { parse_mode: "MarkdownV2", disable_web_page_preview: true, ...mainMenu() });
  } catch (err) {
    console.error("[telegram] NFT lookup failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    await ctx.reply(`NFT lookup failed: ${detail.slice(0, 300)}`, mainMenu());
  }
}

async function runNftBuy(ctx: {
  reply: (text: string, extra?: object) => Promise<unknown>;
  from?: { id: number };
}, index: number): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("I could not identify your Telegram account. Please try again.", mainMenu());
    return;
  }

  const lookup = lastSnipeLookup.get(ctx.from.id);
  if (!lookup) {
    await ctx.reply("Look up a collection first: press NFT snipe and paste the contract address.", mainMenu());
    return;
  }

  const listing = lookup.listings[index - 1];
  if (!listing) {
    await ctx.reply(`There is no listing #${index}. That collection had ${lookup.listings.length} listing(s).`, mainMenu());
    return;
  }
  if (!lookup.tradable) {
    await ctx.reply(
      `The bot can only buy on Base and BNB Chain right now, and this collection is on ${lookup.chainLabel}. ` +
      `You can still buy it here: ${listing.openseaUrl}`,
      mainMenu(),
    );
    return;
  }

  try {
    const wallet = await getWallet(ctx.from.id);
    if (!wallet) {
      await ctx.reply("Create your trading wallet first with /wallet, then fund it with /deposit.", mainMenu());
      return;
    }

    await ctx.reply(`Buying token #${listing.tokenId} for ${listing.priceEth} ${listing.currency}...`);
    const result = await executeSnipe(ctx.from.id, listing, wallet.address);
    const lines = [
      `✅ ${escapeMd("Bought")} *${escapeMd(`#${result.tokenId}`)}* ${escapeMd(`for ${result.pricePaid} ${result.symbol}.`)}`,
    ];
    if (result.approvalHash) lines.push(escapeMd("(approved the payment token first)"));
    // Chains without a known block explorer still confirm, just without a link.
    lines.push(result.explorerUrl
      ? `\n[View transaction](${escapeUrl(result.explorerUrl)})`
      : `\n${escapeMd(`Tx: ${result.hash}`)}`);

    await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2", disable_web_page_preview: true, ...mainMenu() });
  } catch (err) {
    console.error("[telegram] NFT buy failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Purchase failed: ${detail.slice(0, 400)}`, mainMenu());
  }
}

export function formatNftSnipe(result: NftLookupResult): string {
  const header = [
    `🎯 *${escapeMd(result.name)}*${result.verified ? " ✅" : ""}`,
    `${escapeMd(result.chainLabel)}${result.totalSupply ? ` · ${escapeMd(result.totalSupply.toLocaleString())} items` : ""}`,
    `\`${result.contract}\``,
  ].join("\n");

  // Quote in the collection's own currency: Robinhood Chain prices in USDG,
  // and printing "6 ETH" for 6 USDG misstates the value by orders of magnitude.
  const unit = result.currencySymbol;
  const stats = [
    `💰 Floor: ${escapeMd(amount(result.floorPriceEth, unit))} · 👥 ${escapeMd((result.owners ?? 0).toLocaleString())} owners`,
    `📈 24h: ${escapeMd(`${(result.volume24hEth ?? 0).toFixed(2)} ${unit} / ${plural(result.sales24h ?? 0, "sale")}`)}`,
    `📊 7d: ${escapeMd(`${(result.volume7dEth ?? 0).toFixed(1)} ${unit} / ${plural(result.sales7d ?? 0, "sale")}`)}`,
    `🏛 Lifetime: ${escapeMd(`${Math.round(result.lifetimeVolumeEth ?? 0).toLocaleString()} ${unit}`)}`,
  ].join("\n");

  const sections = [header, stats];

  if (result.listings.length) {
    const rows = result.listings.slice(0, 5).map((listing, index) =>
      `${index + 1}\\. \\#${escapeMd(listing.tokenId)} — *${escapeMd(String(Number(listing.priceEth.toFixed(6))))} ${escapeMd(listing.currency)}*` +
      `${listing.basic ? "" : " _\\(auction\\)_"}`
    );
    sections.push(`*Cheapest listings*\n${rows.join("\n")}`);
    sections.push(
      result.tradable
        ? `Buy with your bot wallet: \`/buy 1\` … \`/buy ${Math.min(result.listings.length, 5)}\``
        : `⚠️ The bot buys on Base and BNB Chain only\\. This is on ${escapeMd(result.chainLabel)} — use the marketplace links below\\.`
    );
  } else {
    sections.push("*Cheapest listings*\nNothing is listed for sale right now\\.");
  }

  const links = result.marketplaces.map((market) => `[${escapeMd(market.name)}](${escapeUrl(market.url)})`).join(" · ");
  sections.push(`*Marketplaces*\n${links}`);

  const socials = [
    result.twitterUrl ? `[X](${escapeUrl(result.twitterUrl)})` : null,
    result.website ? `[Website](${escapeUrl(result.website)})` : null,
    result.discord ? `[Discord](${escapeUrl(result.discord)})` : null,
  ].filter(Boolean).join(" · ");
  if (socials) sections.push(`*Links*\n${socials}`);

  sections.push("_NFT prices move fast and listings can disappear between the quote and the purchase\\. Not financial advice\\._");
  return truncateMessage(sections.join("\n\n"));
}

function chainMenu() {
  // "Any" first: auto-detection is right for most users, who will not know
  // which chain a pasted address belongs to.
  const labels = SELECTABLE_CHAINS.map((key) => `Chain: ${CHAIN_LABELS[key]}`);
  const rows: string[][] = [["Chain: Any"]];
  for (let i = 0; i < labels.length; i += 2) rows.push(labels.slice(i, i + 2));
  rows.push(["Back to menu"]);
  return Markup.keyboard(rows).resize().oneTime();
}

function snipeModeMessage(chain?: string): string {
  // Arc mainnet has not launched, so OpenSea lists nothing on it. Say that up
  // front instead of letting the user paste an address and get "not found".
  if (chain === "arc") {
    return "🎯 *NFT snipe — Arc*\n\n" +
      "Arc mainnet has not launched yet — Circle currently runs Arc on testnet only, and no NFTs are listed on it.\n\n" +
      "Pick another chain, or use *Any* to search everywhere. I will switch Arc on automatically once it goes live.";
  }

  const scope = chain
    ? `Searching *${CHAIN_LABELS[chain] ?? chain}* only.`
    : "I will search Ethereum, Base, BNB Chain, Arc, Robinhood Chain, Polygon, Arbitrum and Optimism automatically.";

  const buyable = tradableChains();
  const buyLine = buyable.length
    ? `Buying from your bot wallet works on ${buyable.map((item) => item.name).join(" and ")} — elsewhere I give you the marketplace links.`
    : "No chain has an RPC configured yet, so I can show listings but not buy. The operator needs to set the RPC URLs.";

  return "🎯 *NFT snipe*\n\nPaste the NFT collection's contract address and I will show its floor, volume, owners and the cheapest live listings.\n\n" +
    `${scope}\n\n` +
    "Example:\n`0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d`\n\n" +
    buyLine;
}

async function runWalletCommand(ctx: {
  reply: (text: string, extra?: object) => Promise<unknown>;
  from?: { id: number };
}): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("I could not identify your Telegram account. Please try again.", mainMenu());
    return;
  }

  try {
    const { wallet, created } = await createWallet(ctx.from.id);
    const balances = await getBalances(wallet.address);

    const lines = [
      created ? "🎉 *Your trading wallet is ready*" : "👛 *Your trading wallet*",
      `\`${wallet.address}\``,
      "",
      ...balances.map((item) =>
        `${escapeMd(item.chain.name)}: *${escapeMd(trimBalance(item.balance))} ${escapeMd(item.chain.symbol)}*${item.error ? " ⚠️" : ""}`
      ),
      "",
      // Escaped programmatically rather than by hand: these lines contain
      // <angle brackets> and pipes, and hand-escaping missed ">" (which
      // MarkdownV2 reserves for blockquotes) and broke the whole message.
      escapeMd("Fund it by sending ETH on Base or BNB on BNB Chain to the address above."),
      "",
      escapeMd("/deposit — show the address again"),
      escapeMd("/withdraw <base|bsc> <address> <amount|max>"),
      escapeMd("/export — reveal your private key"),
    ];

    if (created) {
      lines.push(
        "",
        "⚠️ This wallet is *custodial*: " +
        escapeMd("the bot holds the key so it can trade for you. Only keep what you are actively trading with, and use /export to take self-custody at any time."),
      );
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2", ...mainMenu() });
  } catch (err) {
    console.error("[telegram] wallet command failed:", err);
    await ctx.reply(walletErrorMessage(err), mainMenu());
  }
}

/** Turns the "key not configured" case into an operator-actionable message. */
function walletErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (detail.includes("WALLET_ENCRYPTION_KEY")) {
    return "Wallet features are not enabled on this deployment yet. The operator needs to set WALLET_ENCRYPTION_KEY.";
  }
  if (detail.includes("bot_wallets")) {
    return "The wallet table is not migrated yet. The operator needs to run the bot_wallets migration in Supabase.";
  }
  return detail.slice(0, 300);
}

/** 0.010000000000000002 → 0.01 */
function trimBalance(value: string): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  if (num === 0) return "0";
  if (num < 0.000001) return num.toExponential(2);
  return String(Number(num.toFixed(6)));
}

function getCommandArgs(text: string): string {
  return text.replace(/^\/\S+\s*/, "").trim();
}

export function formatMints(scan: UpcomingMintScanResult): string {
  if (!scan.mints.length) {
    return "No upcoming mints are listed right now\\. Try again later\\.";
  }

  const header =
    "🗓 *Upcoming NFT mints*\n" +
    escapeMd(`${scan.total} listed on Mint Deck, ${scan.dated} with a confirmed date.`);

  const entries = scan.mints.map((mint) => {
    const links = [
      mint.twitterUrl ? `[X](${escapeUrl(mint.twitterUrl)})` : null,
      mint.website ? `[Website](${escapeUrl(mint.website)})` : null,
      mint.discord ? `[Discord](${escapeUrl(mint.discord)})` : null,
      mint.telegram ? `[Telegram](${escapeUrl(mint.telegram)})` : null,
    ].filter(Boolean).join(" · ");

    return [
      `${mint.dated ? "📅" : "❓"} *${escapeMd(mint.name)}*${mint.chain ? ` · ${escapeMd(mint.chain)}` : ""}`,
      `🕒 Mint: ${escapeMd(mint.mintDate)} · 🔢 Supply: ${escapeMd(mint.supply)} · 💰 Price: ${escapeMd(mint.price)}`,
      mint.twitterHandle ? `🐦 X: @${escapeMd(mint.twitterHandle)}` : "🐦 X: not listed",
      links || "_no links listed_",
    ].join("\n");
  });

  const footer =
    `[Browse all on Mint Deck](${escapeUrl(scan.source)})\n` +
    "_Dates and prices are as published by the projects and change often\\. Always confirm on the official account before minting\\._";

  return truncateMessage([header, ...entries, footer].join("\n\n"));
}

export function formatNftSearch(scan: EmergingNftScanResult): string {
  if (!scan.collections.length) {
    return `No early collections cleared the filters right now \\(scanned ${scan.scanned}\\)\\. The bar is at least ${scan.minSales7d} sales in 7 days and under ${escapeMd(scan.maxLifetimeVolumeEth.toLocaleString())} ETH lifetime volume\\. Try again later\\.`;
  }

  const header =
    "🔭 *Early NFT collections*\n" +
    escapeMd(`${scan.qualified} of ${scan.scanned} collections are still early (under ${scan.maxLifetimeVolumeEth.toLocaleString()} ETH lifetime) and actively trading.`);

  const entries = scan.collections.map((item, index) => {
    const links = [
      item.twitterUrl ? `[X](${escapeUrl(item.twitterUrl)})` : null,
      item.website ? `[Website](${escapeUrl(item.website)})` : null,
      `[OpenSea](${escapeUrl(item.openseaUrl)})`,
    ].filter(Boolean).join(" · ");

    return [
      `${index + 1}\\. *${escapeMd(item.name)}*${item.verified ? " ✅" : ""} — potential ${item.potentialScore}/100`,
      escapeMd(item.summary),
      `💰 Floor: ${escapeMd(eth(item.floorPriceEth))} · 👥 ${escapeMd(item.owners.toLocaleString())} owners`,
      `📈 7d: ${escapeMd(`${item.volume7dEth.toFixed(1)} ETH / ${plural(item.sales7d, "sale")}`)} · 24h: ${escapeMd(`${item.volume24hEth.toFixed(2)} ETH / ${plural(item.sales24h, "sale")}`)}`,
      `⚡ Momentum: ${escapeMd(`${item.momentum.toFixed(1)}x its 30-day pace`)}`,
      item.twitterHandle ? `🐦 X: @${escapeMd(item.twitterHandle)}` : "🐦 X: not listed",
      links,
    ].join("\n");
  });

  const footer = "_Early collections are high\\-risk and often illiquid\\. Not financial advice\\._";
  return truncateMessage([header, ...entries, footer].join("\n\n"));
}

export function formatNftScan(scan: DormantNftScanResult): string {
  if (!scan.collections.length) {
    return `No collections matched the dormancy filter \\(scanned ${scan.scanned}, min ${scan.minLifetimeVolumeEth.toLocaleString()} ETH lifetime volume\\)\\.`;
  }

  const header =
    `🖼 *Dormant blue chips*\n` +
    escapeMd(`${scan.qualified} of ${scan.scanned} tracked collections are trading under ${scan.maxRecentSharePct}% of their lifetime volume per month.`);

  const entries = scan.collections.map((item, index) => {
    const links = [
      item.twitterUrl ? `[X](${escapeUrl(item.twitterUrl)})` : null,
      item.website ? `[Website](${escapeUrl(item.website)})` : null,
      `[OpenSea](${escapeUrl(item.openseaUrl)})`,
    ].filter(Boolean).join(" · ");

    const lines = [
      `${index + 1}\\. *${escapeMd(item.name)}* — dormancy ${item.dormancyScore}/100`,
      escapeMd(item.summary),
      `💰 Floor: ${escapeMd(eth(item.floorPriceEth))} · 👥 ${escapeMd((item.owners ?? 0).toLocaleString())} owners`,
      `📉 24h: ${escapeMd(`${item.volume24hEth.toFixed(2)} ETH / ${item.sales24h} sales`)}${item.athChangePct !== undefined ? ` · ${escapeMd(`${item.athChangePct.toFixed(0)}% from ATH`)}` : ""}`,
      item.twitterHandle ? `🐦 X: @${escapeMd(item.twitterHandle)}` : "🐦 X: not listed on OpenSea",
      item.website ? `🌐 ${escapeMd(item.website)}` : "🌐 Website: not listed",
      links,
    ];
    return lines.join("\n");
  });

  return truncateMessage([header, ...entries].join("\n\n"));
}

export function formatMemeReport(report: MemeCoinReport): string {
  const { market, security } = report;
  const flow = market.txns24h ? `${market.txns24h.buys} buys / ${market.txns24h.sells} sells` : "n/a";
  const liquidity = market.totalLiquidityUsd ?? market.liquidityUsd;

  const header = [
    `🐸 *${escapeMd(market.name)}* \\(${escapeMd(market.symbol)}\\)`,
    `${escapeMd(market.chain)} · ${escapeMd(market.dex)} · ${market.pairCount} pair${market.pairCount === 1 ? "" : "s"}`,
    // Inside a MarkdownV2 code span only ` and \ are special, and a contract
    // address contains neither — escaping here would print literal backslashes.
    `\`${market.address}\``,
  ].join("\n");

  const stats = [
    `💵 Price: *${escapeMd(price(market.priceUsd))}*`,
    `📊 Market cap: *${escapeMd(usd(market.marketCap))}*`,
    `🧮 FDV: *${escapeMd(usd(market.fdv))}*`,
    `💧 Liquidity: ${escapeMd(usd(liquidity))}`,
    `📈 Volume 24h: ${escapeMd(usd(market.volume24h))} · ${escapeMd(flow)}`,
    `⏱ 1h ${escapeMd(fmtPct(market.priceChange.h1))} · 6h ${escapeMd(fmtPct(market.priceChange.h6))} · 24h ${escapeMd(fmtPct(market.priceChange.h24))}`,
    `🕒 Age: ${escapeMd(formatAge(market.ageHours))}${security?.holderCount !== undefined ? ` · 👥 ${escapeMd(security.holderCount.toLocaleString())} holders` : ""}`,
  ].join("\n");

  // Passing checks get collapsed to a count — what a degen needs to read is
  // what is wrong, not confirmation of what is fine.
  const concerns = report.checks.filter((check) => check.status === "fail" || check.status === "unknown" || check.status === "warn");
  const passed = report.checks.length - concerns.length;
  const checkLines = concerns
    .slice(0, 8)
    .map((check) => `${check.status === "fail" ? "❌" : check.status === "warn" ? "⚠️" : "❔"} *${escapeMd(check.label)}* — ${escapeMd(check.detail)}`)
    .join("\n");

  const sections = [
    header,
    stats,
    `🎯 *Degen score: ${report.degenScore}/100*\n${escapeMd(report.rating)}`,
  ];

  if (report.dealBreakers.length) {
    sections.push(`🛑 *Deal breakers*\n${report.dealBreakers.map((item) => `• ${escapeMd(item)}`).join("\n")}`);
  }
  if (checkLines) {
    sections.push(`*Due diligence*\n${checkLines}${passed > 0 ? `\n✅ ${passed} other check${passed === 1 ? "" : "s"} passed` : ""}`);
  } else if (passed > 0) {
    sections.push(`*Due diligence*\n✅ All ${passed} checks passed`);
  }

  sections.push(`*Verdict*\n${escapeMd(report.verdict)}`);
  if (report.bullCase.length) {
    sections.push(`*Bull case*\n${report.bullCase.map((item) => `• ${escapeMd(item)}`).join("\n")}`);
  }
  if (report.redFlags.length) {
    sections.push(`*Red flags*\n${report.redFlags.map((item) => `• ${escapeMd(item)}`).join("\n")}`);
  }
  sections.push(`*Sizing*\n${escapeMd(report.positionSizing)}`);
  sections.push(`[Open on DexScreener](${escapeUrl(market.pairUrl)})`);
  sections.push(`_${escapeMd(report.disclaimer)}_`);

  return truncateMessage(sections.join("\n\n"));
}

/**
 * Trims to Telegram's message ceiling on a line boundary — cutting mid-line
 * can leave an unmatched `*` or `[` and MarkdownV2 then rejects the whole send.
 */
function truncateMessage(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE) return text;
  const clipped = text.slice(0, TELEGRAM_MAX_MESSAGE);
  return `${clipped.slice(0, clipped.lastIndexOf("\n"))}\n\n_Report truncated\\._`;
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

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/** OpenSea reports floors as raw floats (0.15684999999999927) — trim the noise. */
function amount(value: number | undefined, unit = "ETH"): string {
  if (value === undefined || !Number.isFinite(value)) return "n/a";
  if (value >= 100) return `${value.toFixed(0)} ${unit}`;
  if (value >= 1) return `${value.toFixed(2)} ${unit}`;
  return `${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")} ${unit}`;
}

function eth(value: number | undefined): string {
  return amount(value, "ETH");
}

/** Inside a MarkdownV2 link destination only ")" and "\" need escaping. */
function escapeUrl(url: string): string {
  return url.replace(/[)\\]/g, "\\$&");
}

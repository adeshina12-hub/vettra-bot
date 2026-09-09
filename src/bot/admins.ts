import { config } from "../config.js";
import { fetchBotAdmins, setBotAdmin, type BotAdminRow } from "../storage/db.js";

/**
 * Admin allowlist for the bot.
 *
 * Kept in an in-memory cache so `isAdmin` can be synchronous: the menu is
 * rebuilt on every single reply, and awaiting a Supabase round-trip each time
 * would add latency to every message the bot sends.
 *
 * Two tiers:
 *  - Owners come from BOT_ADMIN_USER_IDS. Always admin, cannot be removed
 *    from inside the bot, and work even if the database is unreachable.
 *  - Granted admins live in bot_users.is_admin and are managed at runtime
 *    with /addadmin and /removeadmin.
 */

const REFRESH_MS = 60_000;

let grantedIds = new Set<number>();
let refreshedAt = 0;
let refreshing: Promise<void> | null = null;

function ownerIds(): Set<number> {
  const ids = new Set(config.bot.adminUserIds);
  // Backwards compatibility: the analytics admin was configured before this
  // allowlist existed, and should not lose access.
  const legacy = Number(config.bot.analyticsAdminChatId);
  if (Number.isInteger(legacy) && legacy > 0) ids.add(legacy);
  return ids;
}

export function isOwner(userId?: number): boolean {
  return userId !== undefined && ownerIds().has(userId);
}

/**
 * Synchronous by design. If the cache is stale it still answers immediately
 * from what it has and refreshes in the background — a newly granted admin
 * is picked up within a minute, and instantly when granted through the bot
 * (refreshAdmins is awaited there).
 */
export function isAdmin(userId?: number): boolean {
  if (userId === undefined) return false;
  if (Date.now() - refreshedAt > REFRESH_MS) void refreshAdmins();
  return ownerIds().has(userId) || grantedIds.has(userId);
}

export async function refreshAdmins(): Promise<void> {
  // Collapse concurrent refreshes — every inbound message can trigger one.
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const rows = await fetchBotAdmins();
      grantedIds = new Set(rows.map((row) => row.telegram_user_id));
      refreshedAt = Date.now();
    } catch (err) {
      console.error("[admins] failed to refresh admin list:", err);
      // Keep serving the previous cache, but retry sooner than a full window.
      refreshedAt = Date.now() - REFRESH_MS / 2;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function grantAdmin(userId: number, username?: string): Promise<void> {
  await setBotAdmin(userId, true, username);
  await forceRefresh();
}

export async function revokeAdmin(userId: number): Promise<void> {
  await setBotAdmin(userId, false);
  await forceRefresh();
}

export async function listAdmins(): Promise<{ owners: number[]; granted: BotAdminRow[] }> {
  const granted = await fetchBotAdmins();
  return { owners: [...ownerIds()], granted };
}

async function forceRefresh(): Promise<void> {
  refreshedAt = 0;
  await refreshAdmins();
}

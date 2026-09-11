import { ethers } from "ethers";
import { config } from "../config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { getWalletRow, insertWalletRow } from "../storage/db.js";

/**
 * Custodial trading wallets for the sniper.
 *
 * One wallet per Telegram user, generated server-side so a user can fund and
 * trade without leaving the chat. The private key is encrypted at rest (see
 * crypto.ts) and only decrypted in memory for the moment a transaction is
 * signed — it is never logged, never stored in plaintext, and never sent to
 * any external service.
 *
 * The same address is used on both chains: Base and BSC are both EVM, so one
 * keypair controls both, which is what users expect from a trading bot.
 */

export type SupportedChain = "base" | "bsc" | "arc" | "robinhood";

export interface ChainInfo {
  key: SupportedChain;
  name: string;
  chainId: number;
  symbol: string;
  /** Empty when no block explorer is known — the UI omits the link. */
  explorer: string;
  rpcUrl: string;
}

export const CHAINS: Record<SupportedChain, ChainInfo> = {
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    symbol: "ETH",
    explorer: "https://basescan.org",
    get rpcUrl() { return config.rpc.base; },
  },
  bsc: {
    key: "bsc",
    name: "BNB Chain",
    chainId: 56,
    symbol: "BNB",
    explorer: "https://bscscan.com",
    get rpcUrl() { return config.rpc.bsc; },
  },
  // Arc pays gas in USDC, not ETH (the native balance and the USDC ERC-20 are
  // the same funds). Chain 5042 is Arc MAINNET, which had not launched as of
  // Sept 2026 — Circle's docs list testnet only (5042002), and no mainnet RPC
  // or explorer exists. Wired anyway so it activates the day it ships.
  arc: {
    key: "arc",
    name: "Arc",
    chainId: 5042,
    symbol: "USDC",
    explorer: "",
    get rpcUrl() { return config.rpc.arc; },
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    symbol: "ETH",
    explorer: "https://robinscan.io",
    get rpcUrl() { return config.rpc.robinhood; },
  },
};

export function isSupportedChain(value: string): value is SupportedChain {
  return value in CHAINS;
}

/** A chain is only tradable once an RPC is configured for it. */
export function isTradableChain(value: string): value is SupportedChain {
  return isSupportedChain(value) && Boolean(CHAINS[value].rpcUrl);
}

export function tradableChains(): ChainInfo[] {
  return Object.values(CHAINS).filter((chain) => Boolean(chain.rpcUrl));
}

export interface UserWallet {
  address: string;
  createdAt: string;
}

export interface ChainBalance {
  chain: ChainInfo;
  /** Formatted native balance, e.g. "0.0142". */
  balance: string;
  raw: bigint;
  error?: string;
}

const providers = new Map<SupportedChain, ethers.JsonRpcProvider>();

function providerFor(chain: SupportedChain): ethers.JsonRpcProvider {
  const existing = providers.get(chain);
  if (existing) return existing;

  const info = CHAINS[chain];
  if (!info.rpcUrl) throw new Error(`No RPC configured for ${info.name}. Set ${chain.toUpperCase()}_RPC_URL.`);
  // staticNetwork avoids a chainId round-trip on every single call.
  const provider = new ethers.JsonRpcProvider(info.rpcUrl, info.chainId, { staticNetwork: true });
  providers.set(chain, provider);
  return provider;
}

export async function getWallet(userId: number): Promise<UserWallet | null> {
  const row = await getWalletRow(userId);
  return row ? { address: row.address, createdAt: row.created_at } : null;
}

/**
 * Creates a wallet, or returns the existing one. Never regenerates: silently
 * replacing a funded wallet would strand the user's money.
 */
export async function createWallet(userId: number): Promise<{ wallet: UserWallet; created: boolean }> {
  const existing = await getWallet(userId);
  if (existing) return { wallet: existing, created: false };

  const generated = ethers.Wallet.createRandom();
  const secret = encryptSecret(generated.privateKey);
  const createdAt = new Date().toISOString();

  await insertWalletRow({
    telegram_user_id: userId,
    address: generated.address,
    encrypted_key: secret.ciphertext,
    key_iv: secret.iv,
    key_tag: secret.authTag,
    created_at: createdAt,
  });

  return { wallet: { address: generated.address, createdAt }, created: true };
}

/** Decrypts the key and returns a signer. Keep the result short-lived. */
export async function signerForChain(userId: number, chain: SupportedChain): Promise<ethers.Wallet> {
  return signerFor(userId, chain);
}

async function signerFor(userId: number, chain: SupportedChain): Promise<ethers.Wallet> {
  const row = await getWalletRow(userId);
  if (!row) throw new Error("You do not have a wallet yet. Use /wallet to create one.");

  const privateKey = decryptSecret({
    ciphertext: row.encrypted_key,
    iv: row.key_iv,
    authTag: row.key_tag,
  });
  return new ethers.Wallet(privateKey, providerFor(chain));
}

export async function getBalances(address: string): Promise<ChainBalance[]> {
  // Only chains with a configured RPC — listing Arc/Robinhood with a
  // permanent ⚠️ would read as a fault rather than "not enabled here".
  return Promise.all(
    tradableChains().map(async ({ key }) => {
      const chain = CHAINS[key];
      try {
        const raw = await providerFor(key).getBalance(address);
        return { chain, raw, balance: ethers.formatEther(raw) };
      } catch (err) {
        // One dead RPC should not hide the other chain's balance.
        return { chain, raw: 0n, balance: "0", error: String(err).slice(0, 120) };
      }
    })
  );
}

/**
 * Exports the private key. The caller is responsible for warning the user —
 * anything revealed in a Telegram chat is stored on Telegram's servers.
 */
export async function exportPrivateKey(userId: number): Promise<string> {
  const row = await getWalletRow(userId);
  if (!row) throw new Error("You do not have a wallet yet. Use /wallet to create one.");
  return decryptSecret({ ciphertext: row.encrypted_key, iv: row.key_iv, authTag: row.key_tag });
}

export interface WithdrawResult {
  hash: string;
  explorerUrl: string;
  amount: string;
  symbol: string;
}

/**
 * Sends native currency out of the custodial wallet.
 *
 * "max" leaves the estimated gas cost behind, with a margin, so the transfer
 * cannot fail for being one wei short of affordable.
 */
export async function withdraw(
  userId: number,
  chain: SupportedChain,
  to: string,
  amount: string | "max"
): Promise<WithdrawResult> {
  if (!ethers.isAddress(to)) throw new Error(`"${to}" is not a valid wallet address.`);

  const info = CHAINS[chain];
  const signer = await signerFor(userId, chain);
  const provider = providerFor(chain);
  const balance = await provider.getBalance(signer.address);
  if (balance === 0n) throw new Error(`Your ${info.name} balance is 0 — nothing to withdraw.`);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const gasLimit = 21_000n;
  // 30% headroom: base fee can rise between estimating and landing.
  const gasCost = (gasPrice * gasLimit * 130n) / 100n;

  let value: bigint;
  if (amount === "max") {
    if (balance <= gasCost) throw new Error(`Your ${info.name} balance (${ethers.formatEther(balance)} ${info.symbol}) does not cover gas.`);
    value = balance - gasCost;
  } else {
    try {
      value = ethers.parseEther(amount);
    } catch {
      throw new Error(`"${amount}" is not a valid amount.`);
    }
    if (value <= 0n) throw new Error("Amount must be greater than zero.");
    if (value + gasCost > balance) {
      throw new Error(
        `Not enough ${info.symbol}. Balance is ${ethers.formatEther(balance)}, and ~${ethers.formatEther(gasCost)} is needed for gas. Use "max" to send everything minus gas.`
      );
    }
  }

  const tx = await signer.sendTransaction({ to, value, gasLimit });
  return {
    hash: tx.hash,
    explorerUrl: `${info.explorer}/tx/${tx.hash}`,
    amount: ethers.formatEther(value),
    symbol: info.symbol,
  };
}

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * Envelope encryption for custodial private keys.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt
 * rather than silently yielding a wrong key. Every record gets a fresh random
 * IV — reusing an IV under the same key breaks GCM catastrophically.
 *
 * The master key lives only in WALLET_ENCRYPTION_KEY, never in the database,
 * so a leaked database dump alone does not expose any user's funds. That also
 * means losing the key permanently orphans every wallet: back it up somewhere
 * other than the server it runs on.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

let cachedKey: Buffer | null = null;

/**
 * Fails loudly rather than falling back to a default or derived key — a
 * predictable key here would make the whole scheme decorative.
 */
export function walletKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = config.wallet.encryptionKey.trim();
  if (!raw) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY is not set. Generate one with:  openssl rand -hex 32  " +
      "and store it outside the database. Wallet features stay disabled until it is set."
    );
  }

  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(`WALLET_ENCRYPTION_KEY must be exactly ${KEY_BYTES} bytes as ${KEY_BYTES * 2} hex characters (got ${key.length} bytes).`);
  }
  // An all-zero or repeated-byte key is almost certainly a placeholder.
  if (key.every((byte) => byte === key[0])) {
    throw new Error("WALLET_ENCRYPTION_KEY looks like a placeholder (all bytes identical). Generate a real one with: openssl rand -hex 32");
  }

  cachedKey = key;
  return key;
}

export function isWalletEncryptionConfigured(): boolean {
  try {
    walletKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", walletKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const decipher = createDecipheriv("aes-256-gcm", walletKey(), Buffer.from(secret.iv, "hex"));
  decipher.setAuthTag(Buffer.from(secret.authTag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/** Constant-time compare, for any future confirmation-token checks. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

import { ethers } from "ethers";
import { openseaJson } from "../research/opensea.js";
import { CHAINS, isTradableChain, signerForChain, type SupportedChain } from "./wallet.js";
import type { NftListing } from "../research/nftLookup.js";

/**
 * Executes an NFT purchase from a user's custodial wallet.
 *
 * Orders are fulfilled through Seaport, but this code does not construct or
 * sign Seaport orders itself. OpenSea's /listings/fulfillment_data endpoint
 * returns the exact target, value and struct for the transaction; we
 * ABI-encode and send it. That stays correct across Seaport versions without
 * reimplementing the protocol.
 *
 * Two payment paths, decided by the order itself rather than by chain:
 *  - Native (ETH on Base, ETH on Robinhood): value is sent with the call.
 *  - ERC-20 (USDG on Robinhood, USDC on Arc): value is zero and the token
 *    must be approved to Seaport first, or the fulfilment reverts.
 *
 * Only "basic" listings are executed. Auctions and criteria offers use
 * different fulfilment functions with different argument shapes, and guessing
 * at them with real money is how funds get lost.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

/**
 * Seaport's BasicOrderParameters, in declaration order.
 *
 * OpenSea returns the struct as a JSON object with named fields, but the
 * function signature it also returns is unnamed — so the values must be
 * ordered by hand to ABI-encode them. This order is fixed by the deployed
 * Seaport contract and must match it exactly.
 */
const BASIC_ORDER_FIELDS = [
  "considerationToken",
  "considerationIdentifier",
  "considerationAmount",
  "offerer",
  "zone",
  "offerToken",
  "offerIdentifier",
  "offerAmount",
  "basicOrderType",
  "startTime",
  "endTime",
  "zoneHash",
  "salt",
  "offererConduitKey",
  "fulfillerConduitKey",
  "totalOriginalAdditionalRecipients",
  "additionalRecipients",
  "signature",
] as const;

interface FulfillmentResponse {
  fulfillment_data?: {
    transaction?: {
      function?: string;
      to?: string;
      value?: number | string;
      chain?: number;
      input_data?: Record<string, any>;
    };
  };
}

export interface SnipeResult {
  hash: string;
  explorerUrl: string;
  pricePaid: string;
  symbol: string;
  tokenId: string;
  approvalHash?: string;
}

export async function executeSnipe(userId: number, listing: NftListing, address: string): Promise<SnipeResult> {
  if (!listing.basic) {
    throw new Error("This listing is an auction or a criteria offer, which the bot cannot fulfil directly. Open it on the marketplace to buy.");
  }
  if (!isTradableChain(listing.chain)) {
    const info = CHAINS[listing.chain as SupportedChain];
    throw new Error(
      info
        ? `Buying on ${info.name} is not enabled — no RPC is configured for it.`
        : `Buying on ${listing.chain} is not supported yet.`
    );
  }

  const chain = listing.chain as SupportedChain;
  const info = CHAINS[chain];

  const payload = await openseaJson<FulfillmentResponse>(
    "/listings/fulfillment_data",
    `fulfillment:${listing.orderHash}`,
    {
      method: "POST",
      body: JSON.stringify({
        listing: { hash: listing.orderHash, chain: listing.chain, protocol_address: listing.protocolAddress },
        fulfiller: { address },
      }),
    }
  );

  const tx = payload?.fulfillment_data?.transaction;
  if (!tx?.to || !tx.function || !tx.input_data) {
    throw new Error("Could not get fulfilment data for this listing. It may have just been bought or cancelled.");
  }

  const parameters = tx.input_data.parameters;
  if (!parameters || typeof parameters !== "object") {
    throw new Error("Fulfilment data came back in an unexpected shape.");
  }

  // The order states its own total: the offerer's cut plus every fee
  // recipient. Trusting listing.priceWei instead would under-pay and revert.
  const total = orderTotal(parameters);
  const paymentToken = String(parameters.considerationToken ?? ZERO_ADDRESS);
  const payingWithToken = paymentToken.toLowerCase() !== ZERO_ADDRESS;

  const signer = await signerForChain(userId, chain);
  const provider = signer.provider!;
  const nativeBalance = await provider.getBalance(address);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  // Seaport basic fulfilment runs ~150-250k gas; 300k leaves headroom.
  const gasReserve = gasPrice * 300_000n;

  const data = encodeFulfillment(tx.function, parameters);
  let approvalHash: string | undefined;
  let paidLabel: string;
  let paidSymbol: string;

  if (payingWithToken) {
    const token = new ethers.Contract(paymentToken, ERC20_ABI, signer);
    const [tokenBalance, allowance, decimals, symbol] = await Promise.all([
      token.balanceOf(address) as Promise<bigint>,
      token.allowance(address, tx.to) as Promise<bigint>,
      token.decimals().catch(() => 18) as Promise<number>,
      token.symbol().catch(() => "tokens") as Promise<string>,
    ]);

    if (tokenBalance < total) {
      throw new Error(
        `Not enough ${symbol}. This listing costs ${ethers.formatUnits(total, decimals)} ${symbol} ` +
        `and your wallet holds ${ethers.formatUnits(tokenBalance, decimals)}. Send ${symbol} on ${info.name} to your bot wallet.`
      );
    }
    if (nativeBalance < gasReserve) {
      throw new Error(
        `Not enough ${info.symbol} for gas on ${info.name}. About ${ethers.formatEther(gasReserve)} is needed and you have ${ethers.formatEther(nativeBalance)}.`
      );
    }

    // Seaport pulls the tokens, so it needs an allowance first. Approve the
    // exact amount rather than unlimited: a bot-held key should not leave a
    // standing infinite approval behind after one purchase.
    if (allowance < total) {
      const approveTx = await token.approve(tx.to, total);
      await approveTx.wait();
      approvalHash = approveTx.hash;
    }

    paidLabel = ethers.formatUnits(total, decimals);
    paidSymbol = symbol;
  } else {
    if (nativeBalance < total + gasReserve) {
      throw new Error(
        `Not enough ${info.symbol}. This costs ${ethers.formatEther(total)} plus about ` +
        `${ethers.formatEther(gasReserve)} gas, and your ${info.name} balance is ` +
        `${ethers.formatEther(nativeBalance)}. Use /deposit to fund your wallet.`
      );
    }
    paidLabel = ethers.formatEther(total);
    paidSymbol = info.symbol;
  }

  const sent = await signer.sendTransaction({
    to: tx.to,
    data,
    // Zero for ERC-20 orders: the tokens move via the approval, not the call.
    value: payingWithToken ? 0n : total,
  });

  return {
    hash: sent.hash,
    explorerUrl: info.explorer ? `${info.explorer}/tx/${sent.hash}` : "",
    pricePaid: paidLabel,
    symbol: paidSymbol,
    tokenId: listing.tokenId,
    approvalHash,
  };
}

/** Offerer's amount plus every additional recipient (marketplace + creator fees). */
function orderTotal(parameters: Record<string, any>): bigint {
  const base = BigInt(parameters.considerationAmount ?? 0);
  const extras = (parameters.additionalRecipients ?? []) as Array<{ amount?: string | number }>;
  return extras.reduce((sum, item) => sum + BigInt(item.amount ?? 0), base);
}

/**
 * ABI-encodes the call OpenSea described. The signature it returns is
 * unnamed, so struct fields are reordered into declaration order before
 * encoding — see BASIC_ORDER_FIELDS.
 */
function encodeFulfillment(functionSignature: string, parameters: Record<string, any>): string {
  const name = functionSignature.slice(0, functionSignature.indexOf("("));
  if (!name.startsWith("fulfillBasicOrder")) {
    throw new Error(`Unsupported fulfilment method (${name}). Open this listing on the marketplace to buy it.`);
  }

  const ordered = BASIC_ORDER_FIELDS.map((field) => {
    const value = parameters[field];
    if (value === undefined) throw new Error(`Fulfilment data is missing "${field}".`);
    // additionalRecipients is a tuple array of (amount, recipient).
    if (field === "additionalRecipients") {
      return (value as Array<{ amount: string; recipient: string }>).map((item) => [item.amount, item.recipient]);
    }
    return value;
  });

  return new ethers.Interface([`function ${functionSignature}`]).encodeFunctionData(name, [ordered]);
}

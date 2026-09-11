import { fetchStats, fetchCollection, openseaJson, readIntervals, mapLimit } from "./opensea.js";
import { isTradableChain } from "../wallet/wallet.js";

/**
 * NFT lookup by contract address — the entry point for the sniper.
 *
 * A user pastes a contract address; this resolves which chain it lives on,
 * pulls the collection's stats and socials, and fetches the cheapest live
 * listings so they can buy immediately.
 *
 * Chain is discovered by asking OpenSea for the contract on each supported
 * chain, because a bare 0x address carries no chain information and users
 * will not know (or type) which one they mean.
 */

// Ordered by how likely a pasted NFT contract is to live there, so the common
// case resolves on the first request.
const LOOKUP_CHAINS = ["ethereum", "base", "bsc", "arc", "robinhood", "matic", "arbitrum", "optimism"] as const;
export type LookupChain = (typeof LOOKUP_CHAINS)[number];

export const CHAIN_LABELS: Record<string, string> = {
  ethereum: "Ethereum",
  base: "Base",
  bsc: "BNB Chain",
  arc: "Arc",
  robinhood: "Robinhood Chain",
  matic: "Polygon",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
};

/** Chains offered in the snipe chain picker, in menu order. */
export const SELECTABLE_CHAINS: LookupChain[] = [...LOOKUP_CHAINS];

export interface NftListing {
  orderHash: string;
  chain: string;
  protocolAddress: string;
  tokenId: string;
  priceWei: string;
  priceEth: number;
  currency: string;
  /** OpenSea only fulfils "basic" orders through the simple calldata path. */
  basic: boolean;
  openseaUrl: string;
}

export interface NftLookupResult {
  contract: string;
  chain: string;
  chainLabel: string;
  slug: string;
  name: string;
  description?: string;
  imageUrl?: string;
  openseaUrl: string;
  verified: boolean;
  totalSupply?: number;
  owners?: number;
  floorPriceEth?: number;
  /** Currency the floor and volume are quoted in — not always ETH. */
  currencySymbol: string;
  lifetimeVolumeEth?: number;
  volume24hEth?: number;
  sales24h?: number;
  volume7dEth?: number;
  sales7d?: number;
  twitterHandle?: string;
  twitterUrl?: string;
  website?: string;
  discord?: string;
  listings: NftListing[];
  /** Buy links for the major marketplaces that carry this contract. */
  marketplaces: Array<{ name: string; url: string }>;
  /** True when the bot can execute the buy itself. */
  tradable: boolean;
}

interface ContractResponse {
  address?: string;
  chain?: string;
  collection?: string;
  name?: string;
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export function looksLikeNftContract(value: string): boolean {
  return EVM_ADDRESS.test(value.trim());
}

/**
 * Resolves a contract to its OpenSea collection, trying each chain until one
 * answers. A 404 here just means "not on this chain", not an error.
 */
async function resolveContract(address: string, chainHint?: string): Promise<ContractResponse | null> {
  // An explicit chain choice is a filter, not a preference: falling back to
  // other chains would report a Base collection to someone who asked for Arc.
  const chains = chainHint ? [chainHint] : [...LOOKUP_CHAINS];
  for (const chain of chains) {
    const result = await openseaJson<ContractResponse>(
      `/chain/${chain}/contract/${address}`,
      `contract:${chain}:${address}`
    );
    if (result?.collection) return { ...result, chain: result.chain ?? chain };
  }
  return null;
}

export async function lookupNftByContract(rawAddress: string, chainHint?: string): Promise<NftLookupResult> {
  const contract = rawAddress.trim();
  if (!looksLikeNftContract(contract)) {
    throw new Error("That does not look like an NFT contract address. Send an EVM address starting with 0x.");
  }

  const resolved = await resolveContract(contract, chainHint);
  if (!resolved?.collection) {
    // A chain hint means the user explicitly chose that chain, so say the
    // contract is not there rather than listing every chain searched.
    throw new Error(
      chainHint
        ? `No NFT collection found for that contract on ${CHAIN_LABELS[chainHint] ?? chainHint}. Try "Any chain" to search everywhere.`
        : `No NFT collection found for that contract on ${SELECTABLE_CHAINS.map((c) => CHAIN_LABELS[c]).join(", ")}. ` +
          "Check the address, or it may be a token contract rather than an NFT."
    );
  }

  const slug = resolved.collection;
  const chain = resolved.chain ?? "ethereum";
  const [collection, stats, listings] = await Promise.all([
    fetchCollection(slug),
    fetchStats(slug),
    fetchBestListings(slug),
  ]);

  const intervals = stats ? readIntervals(stats) : null;

  return {
    contract,
    chain,
    chainLabel: CHAIN_LABELS[chain] ?? chain,
    slug,
    name: collection?.name || resolved.name || slug,
    description: collection?.description?.slice(0, 300) || undefined,
    imageUrl: collection?.image_url,
    openseaUrl: collection?.opensea_url || `https://opensea.io/collection/${slug}`,
    verified: collection?.safelist_status === "verified" || collection?.safelist_status === "approved",
    totalSupply: collection?.total_supply,
    owners: stats?.total?.num_owners,
    floorPriceEth: stats?.total?.floor_price,
    currencySymbol: stats?.total?.floor_price_symbol || stats?.total?.volume_symbol || listings[0]?.currency || "ETH",
    lifetimeVolumeEth: stats?.total?.volume,
    volume24hEth: intervals?.oneDay.volume,
    sales24h: intervals?.oneDay.sales,
    volume7dEth: intervals?.sevenDay.volume,
    sales7d: intervals?.sevenDay.sales,
    twitterHandle: collection?.twitter_username || undefined,
    twitterUrl: collection?.twitter_username ? `https://x.com/${collection.twitter_username}` : undefined,
    website: collection?.project_url || undefined,
    discord: collection?.discord_url || undefined,
    listings,
    marketplaces: marketplaceLinks(chain, contract, slug),
    tradable: isTradableChain(chain),
  };
}

interface BestListingsResponse {
  listings?: Array<{
    order_hash?: string;
    chain?: string;
    protocol_address?: string;
    type?: string;
    price?: { current?: { value?: string; currency?: string; decimals?: number } };
    protocol_data?: { parameters?: { offer?: Array<{ token?: string; identifierOrCriteria?: string }> } };
  }>;
}

export async function fetchBestListings(slug: string, limit = 5): Promise<NftListing[]> {
  // Over-fetch: OpenSea returns several competing orders for the same token,
  // and after de-duplication those collapse into far fewer distinct NFTs.
  const payload = await openseaJson<BestListingsResponse>(
    `/listings/collection/${slug}/best?limit=${Math.min(limit * 4, 50)}`,
    `listings:${slug}`
  );

  const parsed = (payload?.listings ?? []).flatMap((item): NftListing[] => {
    const offer = item.protocol_data?.parameters?.offer?.[0];
    const priceWei = item.price?.current?.value;
    if (!item.order_hash || !item.protocol_address || !offer?.identifierOrCriteria || !priceWei) return [];

    const decimals = item.price?.current?.decimals ?? 18;
    return [{
      orderHash: item.order_hash,
      chain: item.chain ?? "ethereum",
      protocolAddress: item.protocol_address,
      tokenId: offer.identifierOrCriteria,
      priceWei,
      priceEth: Number(priceWei) / 10 ** decimals,
      currency: item.price?.current?.currency ?? "ETH",
      // Non-basic orders (auctions, criteria offers) need a different
      // fulfilment path than the simple calldata this bot sends.
      basic: (item.type ?? "basic") === "basic",
      openseaUrl: `https://opensea.io/assets/${item.chain ?? "ethereum"}/${offer.token}/${offer.identifierOrCriteria}`,
    }];
  }).sort((a, b) => a.priceEth - b.priceEth);

  // Keep only the cheapest order per token, so the user picks between five
  // different NFTs rather than five competing offers on the same one.
  const cheapestPerToken = new Map<string, NftListing>();
  for (const listing of parsed) {
    if (!cheapestPerToken.has(listing.tokenId)) cheapestPerToken.set(listing.tokenId, listing);
  }
  return [...cheapestPerToken.values()].slice(0, limit);
}

/**
 * Deep links into the major marketplaces. These are all collection-level
 * URLs keyed by contract address, which every one of these sites supports —
 * so the link works even when that marketplace has no listing indexed yet.
 */
function marketplaceLinks(chain: string, contract: string, slug: string): Array<{ name: string; url: string }> {
  const links = [{ name: "OpenSea", url: `https://opensea.io/collection/${slug}` }];

  const magicEdenChain: Record<string, string> = { ethereum: "ethereum", base: "base", bsc: "bsc", matic: "polygon", arbitrum: "arbitrum" };
  if (magicEdenChain[chain]) {
    links.push({ name: "Magic Eden", url: `https://magiceden.io/collections/${magicEdenChain[chain]}/${contract}` });
  }
  if (chain === "ethereum") {
    links.push({ name: "Blur", url: `https://blur.io/collection/${slug}` });
  }
  const elementChain: Record<string, string> = { ethereum: "ethereum", base: "base", bsc: "bsc", matic: "polygon" };
  if (elementChain[chain]) {
    links.push({ name: "Element", url: `https://element.market/collections/${contract}` });
  }
  const okxChain: Record<string, string> = { ethereum: "eth", base: "base", bsc: "bsc", matic: "polygon" };
  if (okxChain[chain]) {
    links.push({ name: "OKX", url: `https://www.okx.com/web3/marketplace/nft/collection/${okxChain[chain]}/${contract}` });
  }
  return links;
}

export { mapLimit };

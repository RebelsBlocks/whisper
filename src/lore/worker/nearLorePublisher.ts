import type { LoreBatch } from '../types.js';
import { publishMarkdownToNearSocial } from '../../infra/near/socialPublisher.js';
import { logger } from '../../utils/logger.js';

export type LorePublishResult = {
  rootKey: string;
  partKeys: string[];
  txHashes: Array<string | undefined>;
};

/**
 * Prefix NEAR account IDs with "@" so NEAR Social sends notifications to tagged players.
 * E.g., "crans.near dominated the table" → "@crans.near dominated the table"
 * Already-prefixed mentions are left untouched.
 */
function prefixNearMentions(text: string): string {
  return text.replace(/(?<!@)\b([a-z0-9][a-z0-9._-]*\.(?:near|testnet))\b/gi, '@$1');
}

function buildRootKey(batch: LoreBatch): { rootKey: string; fromRound: number; toRound: number } {
  const fromRound = batch.rounds[0]?.roundNumber ?? 0;
  const toRound = batch.rounds[batch.rounds.length - 1]?.roundNumber ?? 0;
  const rootKey = `lore_${fromRound}_${toRound}_${batch.createdAt}`;
  return { rootKey, fromRound, toRound };
}

export async function publishLoreThread(batch: LoreBatch, parts: string[]): Promise<LorePublishResult> {
  const { rootKey } = buildRootKey(batch);
  if (!parts.length) {
    return { rootKey, partKeys: [], txHashes: [] };
  }

  const n = parts.length;
  const partKeys: string[] = [];
  const txHashes: Array<string | undefined> = [];

  for (let i = 0; i < n; i++) {
    const partNo = i + 1;
    const key = partNo === 1 ? rootKey : `${rootKey}_p${partNo}`;
    partKeys.push(key);

    // Post only the generated lore. Root key and part numbering are encoded in the SocialDB key,
    // not in the human-facing text.
    // Prefix NEAR account IDs with "@" so NEAR Social sends notifications to mentioned players.
    const body = prefixNearMentions(parts[i] ?? '');

    logger.info('lore_posting', { batchId: batch.id, key, part: partNo, total: n });
    const res = await publishMarkdownToNearSocial(body, key);
    txHashes.push(res.txHash);
    logger.info('lore_posted', { batchId: batch.id, key, txHash: res.txHash });
  }

  return { rootKey, partKeys, txHashes };
}


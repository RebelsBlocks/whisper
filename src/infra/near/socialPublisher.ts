import { connect, keyStores, KeyPair } from 'near-api-js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

export type NearPublishResult = {
  txHash?: string;
  receiptIds?: string[];
  elapsedMs?: number;
  rpcUrl?: string;
  networkId?: string;
};

// Serialize publishes from a single signer account to avoid nonce races and to reduce RPC pressure.
let publishQueue: Promise<void> = Promise.resolve();

async function getNearAccountContext(): Promise<{
  account: any;
  publicKey: string;
}> {
  if (!config.nearAccountId || !config.nearPrivateKey || !config.nearNetworkId) {
    throw new Error('NEAR env not configured (NEAR_NETWORK_ID, NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY)');
  }

  const keyStore = new keyStores.InMemoryKeyStore();
  // near-api-js v5 types KeyPair.fromString() as KeyPairString (e.g. `ed25519:...`)
  const keyPair = KeyPair.fromString(config.nearPrivateKey as any);
  await keyStore.setKey(config.nearNetworkId, config.nearAccountId, keyPair);

  // NOTE: avoid TS "excess property" false-positives across near-api-js/@near-js type versions.
  const connectConfig = {
    networkId: config.nearNetworkId,
    nodeUrl: config.nearNodeUrl,
    walletUrl: config.nearNetworkId === 'mainnet' ? 'https://wallet.near.org' : 'https://wallet.testnet.near.org',
    helperUrl: config.nearNetworkId === 'mainnet' ? 'https://helper.mainnet.near.org' : 'https://helper.testnet.near.org',
    keyStore,
  } as any;

  const near = await connect(connectConfig);

  const account = await near.account(config.nearAccountId);
  const publicKey = (keyPair.getPublicKey() as any).toString();
  return { account, publicKey };
}

export async function checkNearSocialConnection(): Promise<{
  networkId: string;
  accountId: string;
  socialContractId: string;
  publicKey: string;
  keyIsOnAccount: boolean;
}> {
  const { account, publicKey } = await getNearAccountContext();

  // Verify that the provided private key corresponds to an access key on the account.
  const accessKeys: Array<{ public_key: string }> = await account.getAccessKeys();
  const keyIsOnAccount = accessKeys.some(k => k.public_key === publicKey);

  return {
    networkId: config.nearNetworkId,
    accountId: config.nearAccountId,
    socialContractId: config.nearSocialContractId,
    publicKey,
    keyIsOnAccount,
  };
}

export async function publishMarkdownToNearSocial(markdown: string, key: string): Promise<NearPublishResult> {
  const jobFn = async (): Promise<NearPublishResult> => {
    // If NEAR is not configured, just no-op (keeps local dev simple).
    if (!config.nearAccountId || !config.nearPrivateKey || !config.nearNetworkId) {
      return {};
    }

    const start = Date.now();
    const { account } = await getNearAccountContext();

    // --- Storage deposit estimation ---
    // NEAR storage cost (rule of thumb): ~1e19 yoctoNEAR per byte (≈ 1 NEAR per 100kB).
    // Use UTF-8 byte length (1 znak != 1 bajt dla unicode).
    const YOCTO_PER_BYTE = BigInt('10000000000000000000'); // 1e19
    const overheadBytes = 512; // small cushion for tree/node overhead

    const postValue = JSON.stringify({ type: 'md', text: markdown });
    const indexValue = JSON.stringify({ key, value: { type: 'md', ts: Date.now() } });

    const bytes =
      Buffer.byteLength(config.nearAccountId, 'utf8') +
      Buffer.byteLength('post', 'utf8') +
      Buffer.byteLength(key, 'utf8') +
      Buffer.byteLength(postValue, 'utf8') +
      Buffer.byteLength('index', 'utf8') +
      Buffer.byteLength('post', 'utf8') +
      Buffer.byteLength(key, 'utf8') +
      Buffer.byteLength(indexValue, 'utf8') +
      overheadBytes;

    // Add 15% safety margin (contract may have additional overhead).
    const base = BigInt(bytes) * YOCTO_PER_BYTE;
    const depositYocto = base + (base / BigInt(100)) * BigInt(15);

    // SocialDB stores arbitrary JSON trees.
    // To avoid overwriting, every post is stored under a unique key in both:
    // - `${accountId}/post/${key}`
    // - `${accountId}/index/post/${key}` (index entry)
    const data = {
      [config.nearAccountId]: {
        post: {
          [key]: postValue,
        },
        index: {
          post: {
            [key]: indexValue,
          },
        },
      },
    };

    const gas = BigInt('30000000000000'); // 30 TGas

    // IMPORTANT: do not wrap this in our own timeout.
    // We wait for near-api-js outcome/receipt lifecycle.
    const outcome = await account.functionCall({
      contractId: config.nearSocialContractId,
      methodName: 'set',
      args: { data },
      gas,
      attachedDeposit: depositYocto,
    });

    const txHash = (outcome as any)?.transaction_outcome?.id;
    const receiptIds = (outcome as any)?.transaction_outcome?.outcome?.receipt_ids;
    const status = (outcome as any)?.status;

    // If RPC returned an execution failure, surface it.
    if (status && typeof status === 'object' && 'Failure' in status) {
      throw new Error(`NEAR tx failed (status.Failure): ${JSON.stringify(status)}`);
    }
    if (!txHash) {
      throw new Error(`NEAR tx missing hash in outcome: ${JSON.stringify(outcome)}`);
    }

    return {
      txHash,
      receiptIds,
      elapsedMs: Date.now() - start,
      rpcUrl: config.nearNodeUrl,
      networkId: config.nearNetworkId,
    };
  };

  // Enqueue job to run sequentially; keep queue alive even if job fails.
  const queued = publishQueue.then(jobFn);
  publishQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}


import * as cliProgress from 'cli-progress';
import { readFile } from 'fs/promises';
import path from 'path';
import log from 'loglevel';
import {
  createCandyMachineV2,
  loadCandyProgram,
  loadWalletKey,
} from '../helpers/accounts';
import { PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { BN, Program, web3 } from '@project-serum/anchor';

import { loadCache, saveCache } from '../helpers/cache';
import { arweaveUpload } from '../helpers/upload/arweave';
import { makeArweaveBundleUploadGenerator } from '../helpers/upload/arweave-bundle';
import { awsUpload } from '../helpers/upload/aws';
import { ipfsCreds, ipfsUpload } from '../helpers/upload/ipfs';

import { StorageType } from '../helpers/storage-type';
import { AssetKey } from '../types';
import { chunks, sleep } from '../helpers/various';
import { nftStorageUpload } from '../helpers/upload/nft-storage';

export async function uploadV2({
  files,
  cacheName,
  env,
  totalNFTs,
  storage,
  retainAuthority,
  mutable,
  nftStorageKey,
  ipfsCredentials,
  awsS3Bucket,
  batchSize,
  price,
  treasuryWallet,
  splToken,
  gatekeeper,
  goLiveDate,
  endSettings,
  whitelistMintSettings,
  hiddenSettings,
  uuid,
  walletKeyPair,
  anchorProgram,
  arweaveJwk,
  rateLimit,
}: {
  files: string[];
  cacheName: string;
  env: string;
  totalNFTs: number;
  storage: string;
  retainAuthority: boolean;
  mutable: boolean;
  nftStorageKey: string;
  ipfsCredentials: ipfsCreds;
  awsS3Bucket: string;
  batchSize: number;
  price: BN;
  treasuryWallet: PublicKey;
  splToken: PublicKey;
  gatekeeper: null | {
    expireOnUse: boolean;
    gatekeeperNetwork: web3.PublicKey;
  };
  goLiveDate: null | BN;
  endSettings: null | [number, BN];
  whitelistMintSettings: null | {
    mode: any;
    mint: PublicKey;
    presale: boolean;
    discountPrice: null | BN;
  };
  hiddenSettings: null | {
    name: string;
    uri: string;
    hash: Uint8Array;
  };
  uuid: string;
  walletKeyPair: web3.Keypair;
  anchorProgram: Program;
  arweaveJwk: string;
  rateLimit: number;
}): Promise<boolean> {
  let uploadSuccessful = true;
  const savedContent = loadCache(cacheName, env);
  const cacheContent = savedContent || {};

  if (!cacheContent.program) {
    cacheContent.program = {};
  }

  if (!cacheContent.items) {
    cacheContent.items = {};
  }

  const dedupedAssetKeys = getAssetKeysNeedingUpload(cacheContent.items, files);
  const dirname = path.dirname(files[0]);
  let candyMachine = cacheContent.program.candyMachine
    ? new PublicKey(cacheContent.program.candyMachine)
    : undefined;

  if (!cacheContent.program.uuid) {
    const firstAssetManifest = getAssetManifest(dirname, '0');

    try {
      const remainingAccounts = [];

      if (splToken) {
        const splTokenKey = new PublicKey(splToken);

        remainingAccounts.push({
          pubkey: splTokenKey,
          isWritable: false,
          isSigner: false,
        });
      }

      if (
        !firstAssetManifest.properties?.creators?.every(
          creator => creator.address !== undefined,
        )
      ) {
        throw new Error('Creator address is missing');
      }

      // initialize candy
      log.info(`initializing candy machine`);
      const res = await createCandyMachineV2(
        anchorProgram,
        walletKeyPair,
        treasuryWallet,
        splToken,
        {
          itemsAvailable: new BN(totalNFTs),
          uuid,
          symbol: firstAssetManifest.symbol,
          sellerFeeBasisPoints: firstAssetManifest.seller_fee_basis_points,
          isMutable: mutable,
          maxSupply: new BN(0),
          retainAuthority: retainAuthority,
          gatekeeper,
          goLiveDate,
          price,
          endSettings,
          whitelistMintSettings,
          hiddenSettings,
          creators: firstAssetManifest.properties.creators.map(creator => {
            return {
              address: new PublicKey(creator.address),
              verified: true,
              share: creator.share,
            };
          }),
        },
      );
      cacheContent.program.uuid = res.uuid;
      cacheContent.program.candyMachine = res.candyMachine.toBase58();
      candyMachine = res.candyMachine;

      log.info(
        `initialized config for a candy machine with publickey: ${res.candyMachine.toBase58()}`,
      );

      saveCache(cacheName, env, cacheContent);
    } catch (exx) {
      log.error('Error deploying config to Solana network.', exx);
      throw exx;
    }
  } else {
    log.info(
      `config for a candy machine with publickey: ${cacheContent.program.candyMachine} has been already initialized`,
    );
  }

  console.log('Uploading Size', dedupedAssetKeys.length, dedupedAssetKeys[0]);

  if (dedupedAssetKeys.length) {
    if (
      storage === StorageType.ArweaveBundle ||
      storage === StorageType.ArweaveSol
    ) {
      // Initialize the Arweave Bundle Upload Generator.
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Generator
      const arweaveBundleUploadGenerator = makeArweaveBundleUploadGenerator(
        storage,
        dirname,
        dedupedAssetKeys,
        storage === StorageType.ArweaveBundle
          ? JSON.parse((await readFile(arweaveJwk)).toString())
          : undefined,
        storage === StorageType.ArweaveSol ? walletKeyPair : undefined,
      );

      let result = arweaveBundleUploadGenerator.next();
      // Loop over every uploaded bundle of asset filepairs (PNG + JSON)
      // and save the results to the Cache object, persist it to the Cache file.
      while (!result.done) {
        const { cacheKeys, arweavePathManifestLinks, updatedManifests } =
          await result.value;
        updateCacheAfterUpload(
          cacheContent,
          cacheKeys,
          arweavePathManifestLinks,
          updatedManifests,
        );

        saveCache(cacheName, env, cacheContent);
        log.info('Saved bundle upload result to cache.');
        result = arweaveBundleUploadGenerator.next();
      }
      log.info('Upload done.');
    } else {
      const assetsPerBatch = batchSize || 10;

      log.info(
        `Splitting ${dedupedAssetKeys.length} assets in batches of ${assetsPerBatch}`,
      );

      const batchedAssets = chunks(dedupedAssetKeys, assetsPerBatch);

      for (const batch of batchedAssets) {
        log.info(
          `Uploading assets ${batch[0].index}-${batch[batch.length - 1].index}`,
        );

        const progressBar = new cliProgress.SingleBar(
          {},
          cliProgress.Presets.shades_classic,
        );
        progressBar.start(dedupedAssetKeys.length, 0);

        await Promise.all(
          batch.map(async asset => {
            const manifest = getAssetManifest(
              dirname,
              asset.index.includes('json')
                ? asset.index
                : `${asset.index}.json`,
            );

            const image = path.join(dirname, `${manifest.image}`);
            const animation =
              'animation_url' in manifest
                ? path.join(dirname, `${manifest.animation_url}`)
                : undefined;
            const manifestBuffer = Buffer.from(JSON.stringify(manifest));

            if (
              animation &&
              (!fs.existsSync(animation) || !fs.lstatSync(animation).isFile())
            ) {
              throw new Error(
                `Missing file for the animation_url specified in ${batch[0].index}.json`,
              );
            }

            let link, imageLink, animationLink;
            try {
              switch (storage) {
                case StorageType.NftStorage:
                  [link, imageLink, animationLink] = await nftStorageUpload(
                    image,
                    animation,
                    manifestBuffer,
                    walletKeyPair,
                    env,
                    nftStorageKey,
                  );
                  break;
                case StorageType.Ipfs:
                  [link, imageLink, animationLink] = await ipfsUpload(
                    ipfsCredentials,
                    image,
                    animation,
                    manifestBuffer,
                  );
                  break;
                case StorageType.Aws:
                  [link, imageLink, animationLink] = await awsUpload(
                    awsS3Bucket,
                    image,
                    animation,
                    manifestBuffer,
                  );
                  break;
                case StorageType.Arweave:
                default:
                  [link, imageLink] = await arweaveUpload(
                    walletKeyPair,
                    anchorProgram,
                    env,
                    image,
                    manifestBuffer,
                    manifest,
                    asset.index,
                  );
              }
              if (
                animation
                  ? link && imageLink && animationLink
                  : link && imageLink
              ) {
                log.debug('Updating cache for ', asset.index);
                cacheContent.items[asset.index] = {
                  link,
                  name: manifest.name,
                  onChain: false,
                };
                saveCache(cacheName, env, cacheContent);
                progressBar.increment();
              }
            } catch (err) {
              log.error(
                `Error uploading ${JSON.stringify(asset)} asset (skipping)`,
                err,
              );
              await sleep(5000);
            }
          }),
        );

        progressBar.stop();
      }
    }
    saveCache(cacheName, env, cacheContent);
  }

  if (!hiddenSettings) {
    uploadSuccessful = await writeIndices({
      anchorProgram,
      cacheContent,
      cacheName,
      env,
      candyMachine,
      walletKeyPair,
      uploadSuccessful,
      rateLimit,
    });
  } else {
    log.info('Skipping upload to chain as this is a hidden Candy Machine');
  }

  console.log(`Done. Successful = ${uploadSuccessful}.`);
  return uploadSuccessful;
}

/**
 * The Cache object, represented in its minimal form.
 */
type Cache = {
  program: {
    config?: string;
  };
  items: {
    [key: string]: any;
  };
};

/**
 * The Manifest object for a given asset.
 * This object holds the contents of the asset's JSON file.
 * Represented here in its minimal form.
 */
type Manifest = {
  image: string;
  animation_url: string;
  name: string;
  symbol: string;
  seller_fee_basis_points: number;
  properties: {
    files: Array<{ type: string; uri: string }>;
    creators: Array<{
      address: string;
      share: number;
    }>;
  };
};

/**
 * From the Cache object & a list of file paths, return a list of asset keys
 * (filenames without extension nor path) that should be uploaded, sorted numerically in ascending order.
 * Assets which should be uploaded either are not present in the Cache object,
 * or do not truthy value for the `link` property.
 */
function getAssetKeysNeedingUpload(
  items: Cache['items'],
  files: string[],
): AssetKey[] {
  const all = [
    ...new Set([
      ...Object.keys(items),
      ...files.map(filePath => path.basename(filePath)),
    ]),
  ];
  const keyMap = {};
  return all
    .filter(k => !k.includes('.json'))
    .reduce((acc, assetKey) => {
      const ext = path.extname(assetKey);
      const key = path.basename(assetKey, ext);

      if (!items[key]?.link && !keyMap[key]) {
        keyMap[key] = true;
        acc.push({ mediaExt: ext, index: key });
      }
      return acc;
    }, [])
    .sort(
      (a, b) => Number.parseInt(a.index, 10) - Number.parseInt(b.index, 10),
    );
}

/**
 * Returns a Manifest from a path and an assetKey
 * Replaces image.ext => index.ext
 * Replaces animation_url.ext => index.ext
 */
export function getAssetManifest(dirname: string, assetKey: string): Manifest {
  const assetIndex = assetKey.includes('.json')
    ? assetKey.substring(0, assetKey.length - 5)
    : assetKey;
  const manifestPath = path.join(dirname, `${assetIndex}.json`);
  const manifest: Manifest = JSON.parse(
    fs.readFileSync(manifestPath).toString(),
  );
  manifest.image = manifest.image.replace('image', assetIndex);

  if ('animation_url' in manifest) {
    manifest.animation_url = manifest.animation_url.replace(
      'animation_url',
      assetIndex,
    );
  }
  return manifest;
}

/**
 * For each asset present in the Cache object, write to the deployed
 * configuration an additional line with the name of the asset and the link
 * to its manifest, if the asset was not already written according to the
 * value of `onChain` property in the Cache object, for said asset.
 */
async function writeIndices({
  anchorProgram,
  cacheContent,
  cacheName,
  env,
  candyMachine,
  walletKeyPair,
  uploadSuccessful,
  rateLimit,
}: {
  anchorProgram: Program;
  cacheContent: any;
  cacheName: string;
  env: any;
  candyMachine: any;
  walletKeyPair: web3.Keypair;
  uploadSuccessful: boolean;
  rateLimit: number;
}) {
  const keys = Object.keys(cacheContent.items);

  try {
    let promiseArray = [];
    const allIndexesInSlice = Array.from(Array(keys.length).keys());
    let offset = 0;
    while (offset < allIndexesInSlice.length) {
      let length = 0;
      let index = 0;
      let indexes = allIndexesInSlice.slice(offset, offset + 16);
      while (length < 850 && index < 16 && indexes[index] !== undefined) {
        length +=
          cacheContent.items[keys[indexes[index]]].link.length +
          cacheContent.items[keys[indexes[index]]].name.length;
        if (length < 850) index++;
      }
      indexes = allIndexesInSlice.slice(offset, offset + index);
      offset += index;
      const onChain = indexes.filter(i => {
        const index = keys[i];
        return cacheContent.items[index]?.onChain || false;
      });
      const ind = keys[indexes[0]];

      if (onChain.length != indexes.length) {
        promiseArray.push(() => {
          log.info(
            `Writing indices ${ind}-${keys[indexes[indexes.length - 1]]}`,
          );
          return anchorProgram.rpc
            .addConfigLines(
              ind,
              indexes.map(i => ({
                uri: cacheContent.items[keys[i]].link,
                name: cacheContent.items[keys[i]].name,
              })),
              {
                accounts: {
                  candyMachine,
                  authority: walletKeyPair.publicKey,
                },
                signers: [walletKeyPair],
              },
            )
            .then(() => {
              indexes.forEach(i => {
                cacheContent.items[keys[i]] = {
                  ...cacheContent.items[keys[i]],
                  onChain: true,
                  verifyRun: false,
                };
              });
              saveCache(cacheName, env, cacheContent);
            })
            .catch(err => {
              log.error(
                `Saving config line ${ind}-${
                  keys[indexes[indexes.length - 1]]
                } failed`,
                err,
              );
              uploadSuccessful = false;
            });
        });
      }
    }
    promiseArray = promiseArray.map((p, i) => {
      return async () => {
        await sleep(1000 * Math.floor(i / rateLimit));
        await p();
      };
    });
    await Promise.allSettled(promiseArray.map(p => p()));
  } catch (e) {
    log.error(e);
  } finally {
    saveCache(cacheName, env, cacheContent);
  }
  return uploadSuccessful;
}

/**
 * Save the Candy Machine's authority (public key) to the Cache object / file.
 */
function setAuthority(publicKey, cache, cacheName, env) {
  cache.authority = publicKey.toBase58();
  saveCache(cacheName, env, cache);
}

/**
 * Update the Cache object for assets that were uploaded with their matching
 * Manifest link. Also set the `onChain` property to `false` so we know this
 * asset should later be appended to the deployed Candy Machine program's
 * configuration on chain.
 */
function updateCacheAfterUpload(
  cache: Cache,
  cacheKeys: Array<keyof Cache['items']>,
  links: string[],
  manifests: Manifest[],
) {
  cacheKeys.forEach((cacheKey, idx) => {
    cache.items[cacheKey] = {
      link: links[idx],
      name: manifests[idx].name,
      onChain: false,
    };
  });
}

type UploadParams = {
  files: string[];
  cacheName: string;
  env: string;
  keypair: string;
  storage: string;
  rpcUrl: string;
  ipfsCredentials: ipfsCreds;
  awsS3Bucket: string;
  arweaveJwk: string;
  batchSize: number;
};
export async function upload({
  files,
  cacheName,
  env,
  keypair,
  storage,
  rpcUrl,
  ipfsCredentials,
  awsS3Bucket,
  arweaveJwk,
  batchSize,
}: UploadParams): Promise<boolean> {
  // Read the content of the Cache file into the Cache object, initialize it
  // otherwise.
  const cache: Cache | undefined = loadCache(cacheName, env);
  if (cache === undefined) {
    log.error(
      'Existing cache not found. To create a new candy machine, please use candy machine v2.',
    );
    throw new Error('Existing cache not found');
  }

  // Make sure config exists in cache
  if (!cache.program?.config) {
    log.error(
      'existing config account not found in cache. To create a new candy machine, please use candy machine v2.',
    );
    throw new Error('config account not found in cache');
  }
  const config = new PublicKey(cache.program.config);

  cache.items = cache.items || {};

  // Retrieve the directory path where the assets are located.
  const dirname = path.dirname(files[0]);
  // Compile a sorted list of assets which need to be uploaded.
  const dedupedAssetKeys = getAssetKeysNeedingUpload(cache.items, files);

  // Initialize variables that might be needed for uploded depending on storage
  // type.
  // These will be needed anyway either to initialize the
  // Candy Machine Custom Program configuration, or to write the assets
  // to the deployed configuration on chain.
  const walletKeyPair = loadWalletKey(keypair);
  const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);
  // Some assets need to be uploaded.
  if (dedupedAssetKeys.length) {
    // Arweave Native storage leverages Arweave Bundles.
    // It allows to ncapsulate multiple independent data transactions
    // into a single top level transaction,
    // which pays the reward for all bundled data.
    // https://github.com/Bundlr-Network/arbundles
    // Each bundle consists of one or multiple asset filepair (PNG + JSON).
    if (
      storage === StorageType.ArweaveBundle ||
      storage === StorageType.ArweaveSol
    ) {
      // Initialize the Arweave Bundle Upload Generator.
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Generator
      const arweaveBundleUploadGenerator = makeArweaveBundleUploadGenerator(
        storage,
        dirname,
        dedupedAssetKeys,
        storage === StorageType.ArweaveBundle
          ? JSON.parse((await readFile(arweaveJwk)).toString())
          : undefined,
        storage === StorageType.ArweaveSol ? walletKeyPair : undefined,
      );

      let result = arweaveBundleUploadGenerator.next();
      // Loop over every uploaded bundle of asset filepairs (PNG + JSON)
      // and save the results to the Cache object, persist it to the Cache file.
      while (!result.done) {
        const { cacheKeys, arweavePathManifestLinks, updatedManifests } =
          await result.value;
        updateCacheAfterUpload(
          cache,
          cacheKeys,
          arweavePathManifestLinks,
          updatedManifests,
        );
        saveCache(cacheName, env, cache);
        log.info('Saved bundle upload result to cache.');
        result = arweaveBundleUploadGenerator.next();
      }
      log.info('Upload done.');
    } else {
      // For other storage methods, we upload the files individually.
      const SIZE = dedupedAssetKeys.length;
      const tick = SIZE / 100; // print every one percent
      let lastPrinted = 0;

      await Promise.all(
        chunks(Array.from(Array(SIZE).keys()), batchSize || 50).map(
          async allIndexesInSlice => {
            for (let i = 0; i < allIndexesInSlice.length; i++) {
              const assetKey = dedupedAssetKeys[i];
              const image = path.join(
                dirname,
                `${assetKey.index}${assetKey.mediaExt}`,
              );
              const manifest = getAssetManifest(dirname, assetKey.index);
              let animation = undefined;
              if ('animation_url' in manifest) {
                animation = path.join(dirname, `${manifest.animation_url}`);
              }
              const manifestBuffer = Buffer.from(JSON.stringify(manifest));
              if (i >= lastPrinted + tick || i === 0) {
                lastPrinted = i;
                log.info(`Processing asset: ${assetKey}`);
              }

              let link, imageLink, animationLink;
              try {
                switch (storage) {
                  case StorageType.Ipfs:
                    [link, imageLink, animationLink] = await ipfsUpload(
                      ipfsCredentials,
                      image,
                      animation,
                      manifestBuffer,
                    );
                    break;
                  case StorageType.Aws:
                    [link, imageLink, animationLink] = await awsUpload(
                      awsS3Bucket,
                      image,
                      animation,
                      manifestBuffer,
                    );
                    break;
                  case StorageType.Arweave:
                  default:
                    [link, imageLink] = await arweaveUpload(
                      walletKeyPair,
                      anchorProgram,
                      env,
                      image,
                      manifestBuffer,
                      manifest,
                      i,
                    );
                }
                if (
                  animation
                    ? link && imageLink && animationLink
                    : link && imageLink
                ) {
                  log.debug('Updating cache for ', assetKey);
                  cache.items[assetKey.index] = {
                    link,
                    imageLink,
                    name: manifest.name,
                    onChain: false,
                  };
                  saveCache(cacheName, env, cache);
                }
              } catch (err) {
                log.error(`Error uploading file ${assetKey}`, err);
                throw err;
              }
            }
          },
        ),
      );
    }

    setAuthority(walletKeyPair.publicKey, cache, cacheName, env);

    return writeIndices({
      anchorProgram,
      cacheContent: cache,
      cacheName,
      env,
      candyMachine: config,
      walletKeyPair,
      uploadSuccessful: true,
      rateLimit: 10,
    });
  }
}

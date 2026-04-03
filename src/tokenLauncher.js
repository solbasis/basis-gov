// ─── BASIS Gov — Devnet Token Launcher ────────────────────────────────────────
// Devnet-only utilities: create SPL tokens with Metaplex metadata, airdrop SOL,
// mint additional supply. Foundation for future full token launcher features.

import {
  Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL, PublicKey,
  SYSVAR_RENT_PUBKEY, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import {
  createCreateMetadataAccountV3Instruction,
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
} from '@metaplex-foundation/mpl-token-metadata';
import { getConnection, getPublicKey, getAdapter } from './wallet.js';
import { getDevNetwork, netMintKey, netDecimalsKey, netRealmNameKey } from './config.js';

// ─── Token identity (mirrors mainnet $BASIS) ──────────────────────────────────
export const TEST_TOKEN_NAME     = 'Basis';
export const TEST_TOKEN_SYMBOL   = 'BASIS';
export const TEST_TOKEN_DECIMALS = 6;
export const TEST_TOKEN_SUPPLY   = 1_000_000_000; // 1B

// ─── Priority fee config (matches pump.fun approach) ─────────────────────────
const COMPUTE_UNIT_PRICE = 100_000; // microLamports — high priority for fast inclusion
const COMPUTE_UNITS_MINT = 400_000; // generous limit for multi-instruction mint tx
const COMPUTE_UNITS_META = 200_000; // metadata tx is simpler

// ─── Helpers ──────────────────────────────────────────────────────────────────
function stored(key, fallback = null) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

// All mint/realm functions are per-network — reads/writes use the active network key.
// Legacy devnet_* keys are checked as fallback so existing devnet data keeps working.

export function getDevnetMint() {
  const net = getDevNetwork();
  return stored(netMintKey(net))
    ?? (net === 'devnet' ? stored('devnet_basis_mint') : null);
}

export function getDevnetDecimals() {
  const net = getDevNetwork();
  return parseInt(
    stored(netDecimalsKey(net))
    ?? (net === 'devnet' ? stored('devnet_basis_decimals') : null)
    ?? '6'
  );
}

export function clearDevnetMint() {
  const net = getDevNetwork();
  localStorage.removeItem(netMintKey(net));
  localStorage.removeItem(netDecimalsKey(net));
  // Also clear legacy key if on devnet
  if (net === 'devnet') {
    localStorage.removeItem('devnet_basis_mint');
    localStorage.removeItem('devnet_basis_decimals');
  }
}

export function getDevnetRealmName() {
  const net = getDevNetwork();
  return stored(netRealmNameKey(net))
    ?? (net === 'devnet' ? stored('devnet_realm_name') : null)
    ?? 'BASIS DAO';
}

export function setDevnetRealmName(name) {
  const net = getDevNetwork();
  localStorage.setItem(netRealmNameKey(net), name.trim());
}

// ─── Full network reset — clears active network's local state + Firebase ───────
export async function fullDevnetReset(deleteFirebaseConfig) {
  const net = getDevNetwork();
  localStorage.removeItem(netMintKey(net));
  localStorage.removeItem(netDecimalsKey(net));
  localStorage.removeItem(netRealmNameKey(net));
  // Clear legacy devnet keys too if on devnet
  if (net === 'devnet') {
    localStorage.removeItem('devnet_basis_mint');
    localStorage.removeItem('devnet_basis_decimals');
    localStorage.removeItem('devnet_realm_name');
  }
  await deleteFirebaseConfig();
}

function saveDevnetMint(mint, decimals) {
  const net = getDevNetwork();
  localStorage.setItem(netMintKey(net),     mint);
  localStorage.setItem(netDecimalsKey(net), String(decimals));
}

// ─── Add priority fee instructions to a transaction ──────────────────────────
function addPriorityFee(tx, units = COMPUTE_UNITS_MINT) {
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
  );
  return tx;
}

// ─── Send + confirm with polling and periodic resend ─────────────────────────
// Uses getSignatureStatuses (polling) instead of websocket confirmTransaction,
// resending the raw tx every 15s to combat dropped packets on devnet.
async function sendAndConfirm(conn, signedTx, label = 'TX') {
  const rawTx = signedTx.serialize();
  const sig   = await conn.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 0 });
  console.log(`[${label}] sent:`, sig);

  const TIMEOUT_MS      = 90_000;
  const RESEND_EVERY_MS = 15_000;
  const POLL_MS         = 1_500;
  const start           = Date.now();
  let   lastResend      = start;

  while (Date.now() - start < TIMEOUT_MS) {
    const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
    const status = value?.[0];
    if (status) {
      if (status.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        console.log(`[${label}] confirmed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return sig;
      }
    }
    // Resend periodically — devnet drops packets frequently
    if (Date.now() - lastResend >= RESEND_EVERY_MS) {
      conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastResend = Date.now();
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`${label} timed out after ${TIMEOUT_MS / 1000}s — check Solana Explorer for status`);
}

// ─── Metadata PDA ─────────────────────────────────────────────────────────────
function findMetadataPda(mintPk) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

// ─── SOL balance ──────────────────────────────────────────────────────────────
export async function getSolBalance() {
  const conn   = getConnection();
  const wallet = getPublicKey();
  if (!wallet) return null;
  try {
    const lamports = await conn.getBalance(wallet);
    return lamports / LAMPORTS_PER_SOL;
  } catch { return null; }
}

// ─── SOL airdrop (devnet) ─────────────────────────────────────────────────────
export async function airdropSol(amount = 2) {
  const conn   = getConnection();
  const wallet = getPublicKey();
  if (!wallet) throw new Error('Wallet not connected');

  const sig = await conn.requestAirdrop(wallet, amount * LAMPORTS_PER_SOL);
  // Airdrop uses simple polling — no resend needed
  const TIMEOUT = 60_000;
  const start   = Date.now();
  while (Date.now() - start < TIMEOUT) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const st = value?.[0];
    if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      return sig;
    }
    if (st?.err) throw new Error(`Airdrop failed: ${JSON.stringify(st.err)}`);
    await new Promise(r => setTimeout(r, 1_500));
  }
  throw new Error('Airdrop timed out — try the Solana faucet link instead');
}

// ─── Create test $BASIS token ─────────────────────────────────────────────────
// TX1: createAccount + initMint + createATA + mintTo (with priority fee)
// TX2: Metaplex metadata V3 — name "Basis" / symbol "BASIS" (best-effort)
export async function launchTestToken({
  decimals = TEST_TOKEN_DECIMALS,
  supply   = TEST_TOKEN_SUPPLY,
  name     = TEST_TOKEN_NAME,
  symbol   = TEST_TOKEN_SYMBOL,
} = {}) {
  const conn    = getConnection();
  const payer   = getPublicKey();
  const adapter = getAdapter();
  if (!payer || !adapter) throw new Error('Wallet not connected');

  const mintKeypair = Keypair.generate();
  const mintPk      = mintKeypair.publicKey;
  const mintRent    = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
  const ata         = await getAssociatedTokenAddress(mintPk, payer);
  const rawSupply   = BigInt(supply) * BigInt(10 ** decimals);
  const metadataPda = findMetadataPda(mintPk);

  // ── TX 1: Create mint + ATA + mint supply (with priority fee) ────────────────
  const tx1 = new Transaction();
  addPriorityFee(tx1, COMPUTE_UNITS_MINT);
  tx1.add(
    SystemProgram.createAccount({
      fromPubkey:       payer,
      newAccountPubkey: mintPk,
      space:            MINT_SIZE,
      lamports:         mintRent,
      programId:        TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mintPk, decimals, payer, null),
    createAssociatedTokenAccountInstruction(payer, ata, payer, mintPk),
    createMintToInstruction(mintPk, ata, payer, rawSupply),
  );

  const { blockhash: bh1 } = await conn.getLatestBlockhash('confirmed');
  tx1.recentBlockhash = bh1;
  tx1.feePayer        = payer;
  tx1.partialSign(mintKeypair);
  const signed1 = await adapter.signTransaction(tx1);
  await sendAndConfirm(conn, signed1, 'mint');

  // Save mint immediately after TX1 — metadata is best-effort
  const mintStr = mintPk.toBase58();
  saveDevnetMint(mintStr, decimals);

  // ── TX 2: Metaplex token metadata (name + symbol) — best-effort ───────────
  let metaSig = null;
  try {
    const tx2 = new Transaction();
    addPriorityFee(tx2, COMPUTE_UNITS_META);
    tx2.add(
      createCreateMetadataAccountV3Instruction(
        {
          metadata:        metadataPda,
          mint:            mintPk,
          mintAuthority:   payer,
          payer:           payer,
          updateAuthority: payer,
          systemProgram:   SystemProgram.programId,
          rent:            SYSVAR_RENT_PUBKEY,
        },
        {
          createMetadataAccountArgsV3: {
            data: {
              name,
              symbol,
              uri:                   '',
              sellerFeeBasisPoints:   0,
              creators:              null,
              collection:            null,
              uses:                  null,
            },
            isMutable:         true,
            collectionDetails: null,
          },
        },
      ),
    );

    const { blockhash: bh2 } = await conn.getLatestBlockhash('confirmed');
    tx2.recentBlockhash = bh2;
    tx2.feePayer        = payer;
    const signed2 = await adapter.signTransaction(tx2);
    metaSig = await sendAndConfirm(conn, signed2, 'metadata');
  } catch (metaErr) {
    console.warn('[tokenLauncher] Metadata TX failed (token still created):', metaErr?.message ?? metaErr);
  }

  return { mint: mintStr, ata: ata.toBase58(), supply, decimals, name, symbol, sig: null, metaSig };
}

// ─── Mint more tokens to wallet (must be mint authority) ──────────────────────
export async function mintMoreTokens(mintStr, amount) {
  const conn    = getConnection();
  const payer   = getPublicKey();
  const adapter = getAdapter();
  if (!payer || !adapter) throw new Error('Wallet not connected');

  const mintPk   = new PublicKey(mintStr);
  const ata      = await getAssociatedTokenAddress(mintPk, payer);
  const decimals = getDevnetDecimals();
  const rawAmt   = BigInt(amount) * BigInt(10 ** decimals);

  const tx = new Transaction();
  addPriorityFee(tx, 100_000);
  tx.add(createMintToInstruction(mintPk, ata, payer, rawAmt));

  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer        = payer;

  const signed = await adapter.signTransaction(tx);
  return sendAndConfirm(conn, signed, 'mint-more');
}

// ─── Universal token burner ───────────────────────────────────────────────────
// Burns any SPL token from the wallet's ATA.
// amount = null  → burn entire balance
// closeAccount   → close the ATA after burning, recovering ~0.002 SOL rent
export async function burnTokens(mintStr, amount = null, closeAccount = false) {
  const conn    = getConnection();
  const payer   = getPublicKey();
  const adapter = getAdapter();
  if (!payer || !adapter) throw new Error('Wallet not connected');

  const mintPk = new PublicKey(mintStr);
  const ata    = await getAssociatedTokenAddress(mintPk, payer);

  // Fetch live token account info (decimals + balance from chain)
  let info;
  try {
    info = await conn.getTokenAccountBalance(ata);
  } catch {
    throw new Error('Token account not found — wallet may not hold this token');
  }

  const decimals = info.value.decimals;
  const rawBalance = BigInt(info.value.amount);

  let rawAmt;
  if (amount === null) {
    rawAmt = rawBalance;
  } else {
    rawAmt = BigInt(Math.round(amount * 10 ** decimals));
    if (rawAmt > rawBalance) throw new Error(`Insufficient balance: have ${info.value.uiAmount}, trying to burn ${amount}`);
  }
  if (rawAmt === 0n && !closeAccount) throw new Error('Nothing to burn — balance is zero');

  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  );

  // Burn
  if (rawAmt > 0n) {
    tx.add(createBurnInstruction(ata, mintPk, payer, rawAmt));
  }

  // Close account (reclaim ~0.002 SOL rent) — only valid after full burn
  if (closeAccount) {
    const burnAll = rawAmt === rawBalance;
    if (!burnAll) throw new Error('Can only close account after burning entire balance');
    tx.add(createCloseAccountInstruction(ata, payer, payer)); // send rent to wallet
  }

  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer        = payer;

  const signed = await adapter.signTransaction(tx);
  return sendAndConfirm(conn, signed, closeAccount ? 'burn+close' : 'burn');
}

// ─── Get any token account info for a given mint ──────────────────────────────
export async function getTokenAccountInfo(mintStr) {
  const conn   = getConnection();
  const payer  = getPublicKey();
  if (!payer) return null;
  try {
    const mintPk = new PublicKey(mintStr);
    const ata    = await getAssociatedTokenAddress(mintPk, payer);
    const info   = await conn.getTokenAccountBalance(ata);
    return {
      ata:      ata.toBase58(),
      amount:   info.value.uiAmount ?? 0,
      decimals: info.value.decimals,
      raw:      info.value.amount,
    };
  } catch { return null; }
}

// ─── Token balance ────────────────────────────────────────────────────────────
export async function getTestTokenBalance(mintStr) {
  const conn   = getConnection();
  const payer  = getPublicKey();
  if (!payer) return null;

  const mintPk = new PublicKey(mintStr);
  const ata    = await getAssociatedTokenAddress(mintPk, payer);
  try {
    const info = await conn.getTokenAccountBalance(ata);
    return info.value.uiAmount ?? 0;
  } catch { return 0; }
}

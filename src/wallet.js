// ─── BASIS Gov — Wallet Connection ────────────────────────────────────────────
import { PhantomWalletAdapter }  from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { Connection }            from '@solana/web3.js';
import { HELIUS_RPC, IS_DEVNET, DEV_NETWORK_RPCS, getDevNetwork } from './config.js';

const adapters = {
  phantom:  new PhantomWalletAdapter(),
  solflare: new SolflareWalletAdapter(),
};

let _adapter    = null;
let _connection = null;

export function getConnection() {
  if (!_connection) {
    const rpc = IS_DEVNET
      ? (DEV_NETWORK_RPCS[getDevNetwork()] ?? HELIUS_RPC)
      : HELIUS_RPC;
    _connection = new Connection(rpc, 'confirmed');
  }
  return _connection;
}

// Call when switching dev networks — forces a new Connection on next getConnection()
export function resetConnection() {
  _connection = null;
}

export const isConnected  = () => !!_adapter?.publicKey;
export const getPublicKey = () => _adapter?.publicKey ?? null;
export const getAdapter   = () => _adapter;

// ─── Connect ──────────────────────────────────────────────────────────────────
export async function connect(provider) {
  const adapter = adapters[provider];
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  try {
    await adapter.connect();
  } catch (e) {
    const msg = e?.message ?? '';
    if (msg.toLowerCase().includes('not found') || !adapter.readyState || adapter.readyState === 'NotDetected' || adapter.readyState === 'Unsupported') {
      const installUrls = {
        phantom:  'https://phantom.app/download',
        solflare: 'https://solflare.com/download',
      };
      const url = installUrls[provider] ?? 'https://solana.com/ecosystem/wallets';
      throw new Error(`${provider.charAt(0).toUpperCase() + provider.slice(1)} wallet not found. Install it from ${url} and reload the page.`);
    }
    throw e;
  }
  _adapter = adapter;
  return adapter.publicKey;
}

// ─── Disconnect ───────────────────────────────────────────────────────────────
export async function disconnect() {
  if (_adapter) { try { await _adapter.disconnect(); } catch (_) {} }
  _adapter = null;
}

// ─── Send + confirm with polling and periodic resend ─────────────────────────
// rawTx: serialized transaction buffer, OR null if sig is pre-provided
async function sendAndConfirm(conn, rawTx, label = 'TX', preSig = null) {
  const sig = preSig ?? await conn.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 0 });
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
      if (status.err) throw new Error(`${label} failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        console.log(`[${label}] confirmed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return sig;
      }
    }
    if (rawTx && Date.now() - lastResend >= RESEND_EVERY_MS) {
      conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastResend = Date.now();
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`${label} timed out after ${TIMEOUT_MS / 1000}s`);
}

// ─── Sign and send transaction ────────────────────────────────────────────────
export async function signAndSend(transaction, label = 'TX') {
  if (!_adapter?.publicKey) throw new Error('Wallet not connected');
  const conn  = getConnection();
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer        = _adapter.publicKey;
  const signed = await _adapter.signTransaction(transaction);
  const rawTx  = signed.serialize();
  return sendAndConfirm(conn, rawTx, label);
}

// ─── Sign and send — skip preflight (uses Phantom's signAndSendTransaction) ──
// Use when you've already validated the TX locally (pre-simulation).
// This bypasses Phantom's own simulation dialog that can show false warnings.
export async function signAndSendSkipSim(transaction, label = 'TX') {
  if (!_adapter?.publicKey) throw new Error('Wallet not connected');
  const conn = getConnection();
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer        = _adapter.publicKey;

  // Use the adapter's sendTransaction with skipPreflight so Phantom doesn't
  // re-simulate (we already confirmed the TX is valid on devnet RPC).
  const sig = await _adapter.sendTransaction(transaction, conn, { skipPreflight: true });
  console.log(`[${label}] sent (skipPreflight):`, sig);
  return sendAndConfirm(conn, null, label, sig);
}

import { PublicKey } from '@solana/web3.js';

// ─── Network mode (set by Vite --mode devnet) ─────────────────────────────────
export const IS_DEVNET     = import.meta.env.VITE_NETWORK === 'devnet';
export const NETWORK_LABEL = IS_DEVNET ? 'DEVNET' : 'MAINNET';

// ─── Token ────────────────────────────────────────────────────────────────────
export const BASIS_DECIMALS = 6;
export const BASIS_FACTOR   = 1_000_000; // 10^6 — raw units per token

const MAINNET_BASIS_MINT = 'A5BJBQUTR5sTzkM89hRDuApWyvgjdXpR7B7rW1r9pump';

// ─── Dev network switcher (runtime, dev app only) ─────────────────────────────
// Lets the dev app point at devnet, testnet, or mainnet without a rebuild.
export const DEV_NETWORK_RPCS = {
  devnet:  'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  mainnet: import.meta.env.VITE_MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com',
};

const _ls = (key, fallback = null) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};

export const getDevNetwork = () =>
  (IS_DEVNET && typeof localStorage !== 'undefined')
    ? (_ls('dev_network') ?? 'devnet')
    : 'mainnet';

export const setDevNetwork = (n) => {
  try { localStorage.setItem('dev_network', n); } catch {}
};

// ─── Per-network localStorage key helpers ─────────────────────────────────────
// Keys: basis_mint_{network}, basis_decimals_{network}, realm_name_{network}
// Legacy devnet keys (devnet_basis_mint, devnet_realm_name) are read as fallback.
export const netMintKey      = (net) => `basis_mint_${net}`;
export const netDecimalsKey  = (net) => `basis_decimals_${net}`;
export const netRealmNameKey = (net) => `realm_name_${net}`;

// ─── BASIS_MINT — dynamic, reads per active network ───────────────────────────
// Always call at runtime — never cache the result.
export function getBasisMint() {
  if (!IS_DEVNET) return new PublicKey(MAINNET_BASIS_MINT);
  const net = getDevNetwork();
  if (net === 'mainnet') return new PublicKey(MAINNET_BASIS_MINT);
  // Read per-network key; fall back to legacy 'devnet_basis_mint' for devnet
  const stored = _ls(netMintKey(net))
    ?? (net === 'devnet' ? _ls('devnet_basis_mint') : null);
  return stored ? new PublicKey(stored) : null;
}

// ─── REALM_NAME — dynamic, reads per active network ──────────────────────────
export function getRealmName() {
  if (!IS_DEVNET) return 'BASIS DAO';
  const net = getDevNetwork();
  if (net === 'mainnet') return 'BASIS DAO';
  // Fall back to legacy 'devnet_realm_name' for devnet
  return _ls(netRealmNameKey(net))
    ?? (net === 'devnet' ? _ls('devnet_realm_name') : null)
    ?? 'BASIS DAO';
}

// ─── SPL Governance ───────────────────────────────────────────────────────────
export const GOVERNANCE_PROGRAM_ID = new PublicKey('GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw');
export const PROGRAM_VERSION        = 3;

export const MIN_COMMUNITY_TOKENS_TO_CREATE_GOVERNANCE = 10_000_000; // 10M

// ─── RPC ──────────────────────────────────────────────────────────────────────
export const HELIUS_RPC = import.meta.env.VITE_RPC
  ?? (IS_DEVNET ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');

// ─── Firebase ─────────────────────────────────────────────────────────────────
export const FIREBASE_CONFIG = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

if (import.meta.env.VITE_FIREBASE_API_KEY === undefined || import.meta.env.VITE_FIREBASE_PROJECT_ID === undefined) {
  console.error('[config] Missing Firebase env vars — check .env file');
}

// ─── Build-time devnet flag (for tree-shaking devnet-only code in mainnet builds) ─
export const IS_DEVNET_BUILD = typeof __IS_DEVNET__ !== 'undefined' ? __IS_DEVNET__ : (import.meta.env.VITE_NETWORK === 'devnet');

// ─── NFT boost (UI display only; on-chain vote = raw token amount) ─────────────
export const NFT_BOOST_MULTIPLIER = 1.5;
export const NFT_NAME_FILTER      = 'basis';

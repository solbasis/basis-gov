// ─── BASIS Gov — Wallet Connection (Phantom & Solflare, no build step) ────────

let _provider = null;   // 'phantom' | 'solflare'
let _pubkey   = null;

// ─── State accessors ──────────────────────────────────────────────────────────
export const isConnected  = () => _pubkey !== null;
export const getPublicKey = () => _pubkey;
export const getProvider  = () => _provider;

// ─── Connect ──────────────────────────────────────────────────────────────────
export async function connect(provider) {
  if (provider === 'phantom') {
    const ph = window.phantom?.solana;
    if (!ph?.isPhantom) throw new Error('Phantom not found — install it at phantom.app');
    const res = await ph.connect();
    _pubkey   = res.publicKey.toString();
    _provider = 'phantom';
    return _pubkey;
  }

  if (provider === 'solflare') {
    const sf = window.solflare;
    if (!sf?.isSolflare) throw new Error('Solflare not found — install it at solflare.com');
    await sf.connect();
    _pubkey   = sf.publicKey.toString();
    _provider = 'solflare';
    return _pubkey;
  }

  throw new Error('Unknown wallet provider');
}

// ─── Disconnect ───────────────────────────────────────────────────────────────
export async function disconnect() {
  try {
    if (_provider === 'phantom')  await window.phantom?.solana?.disconnect();
    if (_provider === 'solflare') await window.solflare?.disconnect();
  } catch (_) { /* ignore */ }
  _provider = null;
  _pubkey   = null;
}

// ─── Sign a text message and return hex signature ─────────────────────────────
export async function signMessage(message) {
  if (!_pubkey) throw new Error('Wallet not connected');
  const encoded = new TextEncoder().encode(message);

  if (_provider === 'phantom') {
    const { signature } = await window.phantom.solana.signMessage(encoded, 'utf8');
    return _toHex(signature);
  }

  if (_provider === 'solflare') {
    const { signature } = await window.solflare.signMessage(encoded, 'utf8');
    return _toHex(signature);
  }

  throw new Error('No wallet connected');
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function _toHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── BASIS Gov — Firebase (proposal metadata store) ───────────────────────────
import { initializeApp }                          from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs, orderBy, query, limit } from 'firebase/firestore';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { FIREBASE_CONFIG, IS_DEVNET, getDevNetwork } from './config.js';

const app = initializeApp(FIREBASE_CONFIG);

// ─── App Check — mainnet builds only ─────────────────────────────────────────
// Dev builds skip App Check entirely. Devnet/testnet config is stored in
// localStorage (no Firestore write needed), so App Check is irrelevant there.
if (!IS_DEVNET) {
  const _siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  if (_siteKey && _siteKey !== 'YOUR_RECAPTCHA_V3_SITE_KEY') {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(_siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } else {
    console.warn('[firebase] App Check not initialized — set VITE_RECAPTCHA_SITE_KEY in .env');
  }
}

const db = getFirestore(app);

// ─── Collection / document names — dynamic per active network ─────────────────
// mainnet → 'gov' / 'proposals-meta'
// devnet  → 'gov-devnet' / 'proposals-meta-devnet'
// testnet → 'gov-testnet' / 'proposals-meta-testnet'
const govDocId     = () => IS_DEVNET && getDevNetwork() !== 'mainnet'
  ? `gov-${getDevNetwork()}`            : 'gov';
const proposalsCol = () => IS_DEVNET && getDevNetwork() !== 'mainnet'
  ? `proposals-meta-${getDevNetwork()}` : 'proposals-meta';

// ─── Config key (localStorage) ────────────────────────────────────────────────
// Devnet and testnet realm config is stored in localStorage instead of Firestore.
// Mainnet also uses localStorage as a fallback/override when Firestore is blocked
// by App Check (e.g. dev builds, or after updateGovernanceDuration persists a
// new governance PK that can't be written to Firestore).
const devConfigKey      = () => `gov_config_${getDevNetwork()}`;
const isDevNetwork      = () => IS_DEVNET && getDevNetwork() !== 'mainnet';
const MAINNET_LOCAL_KEY = 'gov_config_mainnet_override';

// ─── Gov config (realm + governance pubkeys) ──────────────────────────────────
// ─── Mainnet fallback config ──────────────────────────────────────────────────
// Hardcoded as a reliable fallback — Firestore App Check enforcement can block
// unauthenticated reads even with 'allow read: if true' rules. These addresses
// are deterministic on-chain and never change.
const MAINNET_FALLBACK_CONFIG = {
  realmPk:      '4egfZcetidvkusXsKEbKaERncRL7RvqvDRSCHrgGoqEn',
  governancePk: '4LRPzLGwGPPJZhrGpNERs8nWwypQBCiRM5e61XFkAbwF',
};

export async function getGovConfig() {
  if (isDevNetwork()) {
    // 1. Try localStorage first (fast, no Firestore needed)
    const stored = localStorage.getItem(devConfigKey());
    if (stored) {
      try { return JSON.parse(stored); } catch { localStorage.removeItem(devConfigKey()); }
    }
    // 2. Fallback: try Firestore (migrates old configs saved before this change)
    try {
      const snap = await getDoc(doc(db, 'config', govDocId()));
      if (snap.exists()) {
        const data = snap.data();
        localStorage.setItem(devConfigKey(), JSON.stringify(data)); // migrate
        return data;
      }
    } catch (e) {
      console.warn('[getGovConfig] Firestore fallback skipped:', e.message);
    }
    return null;
  }
  // Mainnet: try Firestore first, then localStorage override, then hardcoded fallback
  try {
    const snap = await getDoc(doc(db, 'config', govDocId()));
    if (snap.exists()) return snap.data();
  } catch (e) {
    console.warn('[getGovConfig] Firestore read blocked, using hardcoded mainnet config:', e.message);
  }
  // Check for a localStorage override (written by setGovConfig when Firestore is blocked)
  try {
    const local = localStorage.getItem(MAINNET_LOCAL_KEY);
    if (local) {
      const parsed = JSON.parse(local);
      if (parsed?.realmPk && parsed?.governancePk) {
        console.log('[getGovConfig] using mainnet localStorage override:', parsed.governancePk);
        return parsed;
      }
    }
  } catch { localStorage.removeItem(MAINNET_LOCAL_KEY); }
  return MAINNET_FALLBACK_CONFIG;
}

export async function setGovConfig(data) {
  if (isDevNetwork()) {
    localStorage.setItem(devConfigKey(), JSON.stringify(data));
    return;
  }
  // Mainnet: write to Firestore; if blocked by App Check, persist to localStorage
  // so governance PK updates (e.g. updateGovernanceDuration) survive page reloads.
  try {
    await setDoc(doc(db, 'config', govDocId()), data, { merge: true });
  } catch (e) {
    console.warn('[setGovConfig] Firestore write blocked, saving to localStorage:', e.message);
    try {
      const existing = JSON.parse(localStorage.getItem(MAINNET_LOCAL_KEY) ?? '{}');
      localStorage.setItem(MAINNET_LOCAL_KEY, JSON.stringify({ ...existing, ...data }));
    } catch { localStorage.setItem(MAINNET_LOCAL_KEY, JSON.stringify(data)); }
  }
}

export async function deleteGovConfig() {
  if (isDevNetwork()) {
    localStorage.removeItem(devConfigKey());
    return;
  }
  await deleteDoc(doc(db, 'config', govDocId()));
}

// ─── Proposal metadata (description lives here; on-chain stores title + snippet) ─
// Devnet/testnet → localStorage only.
// Mainnet → Firestore with localStorage as write-fallback (App Check blocks writes)
//           and read-fallback (App Check blocks reads too).
const devMetaKey      = () => `proposal_meta_${getDevNetwork()}`;
const MAINNET_META_KEY = 'proposal_meta_mainnet';

function devMetaRead() {
  try { return JSON.parse(localStorage.getItem(devMetaKey()) ?? '{}'); } catch { return {}; }
}
function devMetaWrite(obj) {
  try { localStorage.setItem(devMetaKey(), JSON.stringify(obj)); } catch {}
}
function mainnetMetaRead() {
  try { return JSON.parse(localStorage.getItem(MAINNET_META_KEY) ?? '{}'); } catch { return {}; }
}
function mainnetMetaWrite(pk, data) {
  try {
    const all = mainnetMetaRead();
    all[pk] = data;
    localStorage.setItem(MAINNET_META_KEY, JSON.stringify(all));
  } catch {}
}

export async function saveProposalMeta(proposalPk, { description, author, createdAt }) {
  const payload = { description, author, createdAt: Math.floor((createdAt ?? Date.now()) / 1000) };
  if (isDevNetwork()) {
    const all = devMetaRead();
    all[proposalPk] = payload;
    devMetaWrite(all);
    return;
  }
  // Mainnet: always cache locally first so reads never fail even if Firestore is blocked
  mainnetMetaWrite(proposalPk, payload);
  try {
    await setDoc(doc(db, proposalsCol(), proposalPk), payload);
  } catch (e) {
    console.warn('[saveProposalMeta] Firestore write blocked, saved to localStorage:', e.message);
  }
}

export async function getProposalMeta(proposalPk) {
  if (isDevNetwork()) {
    return devMetaRead()[proposalPk] ?? null;
  }
  // Mainnet: try Firestore, fall back to localStorage cache
  try {
    const snap = await getDoc(doc(db, proposalsCol(), proposalPk));
    if (snap.exists()) {
      mainnetMetaWrite(proposalPk, snap.data()); // keep local cache fresh
      return snap.data();
    }
  } catch (e) {
    console.warn('[getProposalMeta] Firestore read blocked, using localStorage:', e.message);
  }
  return mainnetMetaRead()[proposalPk] ?? null;
}

export async function getAllProposalMeta() {
  if (isDevNetwork()) {
    return devMetaRead();
  }
  // Mainnet: try Firestore, merge with localStorage cache (local may have entries Firestore doesn't)
  const local = mainnetMetaRead();
  try {
    const snap = await getDocs(
      query(collection(db, proposalsCol()), orderBy('createdAt', 'desc'), limit(200)),
    );
    const result = { ...local };
    snap.docs.forEach(d => { result[d.id] = d.data(); });
    return result;
  } catch (e) {
    console.warn('[getAllProposalMeta] Firestore read blocked, using localStorage:', e.message);
    return local;
  }
}

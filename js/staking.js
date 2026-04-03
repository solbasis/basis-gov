// ─── BASIS Gov — Staking Logic ────────────────────────────────────────────────
import {
  BASIS_MINT, HELIUS_URL, NFT_NAME_FILTER,
  COOLDOWN_DAYS, DEFAULT_REWARD_APY,
} from './config.js';

let _db  = null;
let _rId = 0;

export function initStaking(db) { _db = db; }

// ─── Helius JSON-RPC helper ───────────────────────────────────────────────────
async function rpc(method, params) {
  const id  = ++_rId;
  const res = await fetch(HELIUS_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'RPC error');
  return json.result;
}

// ─── On-chain reads ───────────────────────────────────────────────────────────
export async function getOnChainBasisBalance(wallet) {
  const result = await rpc('getTokenAccountsByOwner', [
    wallet,
    { mint: BASIS_MINT },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  const accounts = result?.value ?? [];
  return accounts.reduce(
    (sum, a) => sum + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
    0,
  );
}

export async function checkNFTBoost(wallet) {
  const result = await rpc('getAssetsByOwner', {
    ownerAddress:   wallet,
    page:           1,
    limit:          1000,
    displayOptions: { showFungible: false, showNativeBalance: false },
  });
  const items = result?.items ?? [];
  return items.some(a =>
    (a.content?.metadata?.name || '').toLowerCase().includes(NFT_NAME_FILTER),
  );
}

// ─── Firestore reads ──────────────────────────────────────────────────────────
export async function getStakeRecord(wallet) {
  const doc = await _db.collection('stakes').doc(wallet).get();
  return doc.exists ? doc.data() : null;
}

export function watchStakeRecord(wallet, cb) {
  return _db.collection('stakes').doc(wallet).onSnapshot(doc =>
    cb(doc.exists ? doc.data() : null),
  );
}

export async function getConfig() {
  const doc = await _db.collection('config').doc('settings').get();
  if (doc.exists) return doc.data();
  const defaults = {
    rewardRateAPY:   DEFAULT_REWARD_APY,
    cooldownDays:    COOLDOWN_DAYS,
    minProposalStake: 10_000_000,
    quorumPercent:   5,
    totalStaked:     0,
  };
  await _db.collection('config').doc('settings').set(defaults);
  return defaults;
}

// ─── Reward calculation ───────────────────────────────────────────────────────
export function computePendingRewards(record, apy) {
  if (!record?.stakedAmount || record.stakedAmount <= 0) return 0;
  const ref = record.lastClaimAt
    ? (record.lastClaimAt.toDate ? record.lastClaimAt.toDate() : new Date(record.lastClaimAt))
    : (record.stakedAt?.toDate   ? record.stakedAt.toDate()   : new Date());
  const daysSince = Math.max(0, (Date.now() - ref.getTime()) / 86_400_000);
  return record.stakedAmount * (apy / 100) * (daysSince / 365);
}

// ─── Stake ────────────────────────────────────────────────────────────────────
export async function stakeTokens(wallet, amount, signature) {
  await _db.runTransaction(async tx => {
    const stakeRef  = _db.collection('stakes').doc(wallet);
    const configRef = _db.collection('config').doc('settings');

    const [stakeDoc, configDoc] = await Promise.all([
      tx.get(stakeRef),
      tx.get(configRef),
    ]);

    const oldData   = stakeDoc.exists ? stakeDoc.data() : null;
    const oldAmount = oldData?.stakedAmount ?? 0;
    const delta     = amount - oldAmount;

    const cfg = configDoc.exists
      ? configDoc.data()
      : { rewardRateAPY: DEFAULT_REWARD_APY, totalStaked: 0 };
    const apy          = cfg.rewardRateAPY ?? DEFAULT_REWARD_APY;
    const currentTotal = cfg.totalStaked   ?? 0;

    // Accumulate any unredeemed rewards before changing stake amount
    const pendingRewards =
      (oldData?.pendingRewards ?? 0) + computePendingRewards(oldData, apy);

    tx.set(stakeRef, {
      stakedAmount:      amount,
      stakedAt:          firebase.firestore.FieldValue.serverTimestamp(),
      cooldownEndsAt:    null,
      cooldownAmount:    0,
      pendingRewards,
      lastClaimAt:       firebase.firestore.FieldValue.serverTimestamp(),
      lastStakeSignature: signature,
    }, { merge: true });

    if (!configDoc.exists) {
      tx.set(configRef, {
        ...{ rewardRateAPY: DEFAULT_REWARD_APY, cooldownDays: COOLDOWN_DAYS,
             minProposalStake: 10_000_000, quorumPercent: 5 },
        totalStaked: Math.max(0, currentTotal + delta),
      });
    } else {
      tx.update(configRef, { totalStaked: Math.max(0, currentTotal + delta) });
    }
  });
}

// ─── Initiate unstake (starts cooldown) ───────────────────────────────────────
export async function initiateUnstake(wallet, signature) {
  const record = await getStakeRecord(wallet);
  if (!record?.stakedAmount) throw new Error('No active stake to unstake');
  if (record.cooldownEndsAt) throw new Error('Cooldown already in progress');

  const cooldownEnd = new Date(Date.now() + COOLDOWN_DAYS * 86_400_000);
  await _db.collection('stakes').doc(wallet).update({
    cooldownEndsAt:       cooldownEnd,
    cooldownAmount:       record.stakedAmount,
    lastUnstakeSignature: signature,
  });
}

// ─── Finalize unstake (after cooldown ends) ───────────────────────────────────
export async function finalizeUnstake(wallet) {
  const record = await getStakeRecord(wallet);
  if (!record?.cooldownEndsAt) throw new Error('No cooldown in progress');

  const cooldownEnd = record.cooldownEndsAt.toDate
    ? record.cooldownEndsAt.toDate()
    : new Date(record.cooldownEndsAt);
  if (Date.now() < cooldownEnd.getTime()) throw new Error('Cooldown not yet complete');

  await _db.runTransaction(async tx => {
    const stakeRef  = _db.collection('stakes').doc(wallet);
    const configRef = _db.collection('config').doc('settings');
    const configDoc = await tx.get(configRef);
    const currentTotal = configDoc.exists ? (configDoc.data().totalStaked ?? 0) : 0;
    const unstakeAmt   = record.cooldownAmount ?? record.stakedAmount;

    tx.update(stakeRef, {
      stakedAmount:   0,
      cooldownEndsAt: null,
      cooldownAmount: 0,
    });
    if (configDoc.exists) {
      tx.update(configRef, { totalStaked: Math.max(0, currentTotal - unstakeAmt) });
    }
  });
}

// ─── Claim rewards (marks as claimed; team distributes tokens separately) ──────
export async function claimRewards(wallet, amount, signature) {
  await _db.collection('stakes').doc(wallet).update({
    pendingRewards:    0,
    lastClaimAt:       firebase.firestore.FieldValue.serverTimestamp(),
    totalClaimed:      firebase.firestore.FieldValue.increment(amount),
    lastClaimSignature: signature,
  });
}

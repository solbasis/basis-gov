// ─── BASIS Gov — Proposals & Voting Logic ─────────────────────────────────────
import { NFT_BOOST_MULTIPLIER } from './config.js';
import { getOnChainBasisBalance, checkNFTBoost, getStakeRecord, getConfig } from './staking.js';
import { signMessage, getPublicKey } from './wallet.js';

let _db         = null;
let _unsubDetail = null;

export function initProposals(db) { _db = db; }

// ─── Status helpers ───────────────────────────────────────────────────────────
export function computeStatus(proposal) {
  if (proposal.status !== 'active') return proposal.status;

  const endsAt = proposal.endsAt?.toDate
    ? proposal.endsAt.toDate()
    : new Date(proposal.endsAt);

  if (Date.now() < endsAt.getTime()) return 'active';

  const yes     = proposal.yesWeight     || 0;
  const no      = proposal.noWeight      || 0;
  const abstain = proposal.abstainWeight || 0;
  const total   = yes + no + abstain;

  if (total < (proposal.quorumTarget || 0)) return 'no_quorum';
  return yes > no ? 'passed' : 'failed';
}

// Auto-update expired proposals' status in Firestore (first client wins)
export function finalizeExpiredProposals(proposals) {
  for (const p of proposals) {
    if (p.status !== 'active') continue;
    const newStatus = computeStatus(p);
    if (newStatus !== 'active') {
      _db.collection('proposals').doc(p.id)
        .update({ status: newStatus })
        .catch(() => {});
    }
  }
}

// ─── Proposal list watcher ────────────────────────────────────────────────────
export function watchProposals(cb) {
  return _db.collection('proposals')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .onSnapshot(snap => {
      const proposals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      finalizeExpiredProposals(proposals);
      cb(proposals);
    });
}

// ─── Proposal detail watcher ──────────────────────────────────────────────────
export function watchProposalDetail(proposalId, cb) {
  if (_unsubDetail) { _unsubDetail(); _unsubDetail = null; }
  _unsubDetail = _db.collection('proposals').doc(proposalId)
    .onSnapshot(doc => cb(doc.exists ? { id: doc.id, ...doc.data() } : null));
  return _unsubDetail;
}

export function stopWatchingDetail() {
  if (_unsubDetail) { _unsubDetail(); _unsubDetail = null; }
}

// ─── Create proposal ──────────────────────────────────────────────────────────
export async function createProposal(title, description, durationHours) {
  const wallet = getPublicKey();
  if (!wallet) throw new Error('Wallet not connected');

  const [stakeRecord, onChainBal, config] = await Promise.all([
    getStakeRecord(wallet),
    getOnChainBasisBalance(wallet),
    getConfig(),
  ]);

  const effectiveStake = Math.min(stakeRecord?.stakedAmount ?? 0, onChainBal);
  if (effectiveStake < 10_000_000) {
    throw new Error(
      `Need 10,000,000+ staked $BASIS. ` +
      `You have ${_fmtAmt(effectiveStake)} staked (on-chain verified).`,
    );
  }

  const msg       = `BASIS-GOV:CREATE:${title.trim()}:${Date.now()}`;
  const signature = await signMessage(msg);
  const endsAt    = new Date(Date.now() + durationHours * 3_600_000);

  const ref = await _db.collection('proposals').add({
    title:            title.trim(),
    description:      description.trim(),
    author:           wallet,
    createdAt:        firebase.firestore.FieldValue.serverTimestamp(),
    endsAt,
    status:           'active',
    yesWeight:        0,
    noWeight:         0,
    abstainWeight:    0,
    quorumTarget:     (config.totalStaked ?? 0) * ((config.quorumPercent ?? 5) / 100),
    creatorSignature: signature,
  });

  return ref.id;
}

// ─── Cast vote ────────────────────────────────────────────────────────────────
export async function castVote(proposalId, choice) {
  const wallet = getPublicKey();
  if (!wallet) throw new Error('Wallet not connected');
  if (!['yes', 'no', 'abstain'].includes(choice)) throw new Error('Invalid choice');

  // Check for existing vote first (fast path)
  const existingVote = await _db.collection('votes').doc(`${proposalId}_${wallet}`).get();
  if (existingVote.exists) throw new Error('You have already voted on this proposal');

  // Parallel on-chain reads
  const [stakeRecord, onChainBal, hasNFT] = await Promise.all([
    getStakeRecord(wallet),
    getOnChainBasisBalance(wallet),
    checkNFTBoost(wallet),
  ]);

  const stakedAmount = stakeRecord?.stakedAmount ?? 0;
  if (stakedAmount <= 0) throw new Error('Stake $BASIS first to vote');

  const effectiveWeight = Math.min(stakedAmount, onChainBal);
  if (effectiveWeight <= 0) throw new Error('On-chain $BASIS balance is zero');

  const votingWeight = hasNFT ? effectiveWeight * NFT_BOOST_MULTIPLIER : effectiveWeight;

  // Sign the vote
  const msg       = `BASIS-GOV:VOTE:${proposalId}:${choice}:${Date.now()}`;
  const signature = await signMessage(msg);

  // Atomic write
  const voteRef     = _db.collection('votes').doc(`${proposalId}_${wallet}`);
  const proposalRef = _db.collection('proposals').doc(proposalId);

  await _db.runTransaction(async tx => {
    const [proposalDoc, voteDoc] = await Promise.all([
      tx.get(proposalRef),
      tx.get(voteRef),
    ]);

    if (!proposalDoc.exists) throw new Error('Proposal not found');
    if (voteDoc.exists)      throw new Error('Already voted on this proposal');

    const p      = proposalDoc.data();
    if (p.status !== 'active') throw new Error('Proposal is no longer active');

    const endsAt = p.endsAt?.toDate ? p.endsAt.toDate() : new Date(p.endsAt);
    if (Date.now() > endsAt.getTime()) throw new Error('Voting period has ended');

    tx.set(voteRef, {
      proposalId,
      voter:          wallet,
      choice,
      weight:         votingWeight,
      effectiveWeight,
      nftBoost:       hasNFT,
      timestamp:      firebase.firestore.FieldValue.serverTimestamp(),
      signature,
    });

    const field = choice === 'yes' ? 'yesWeight'
                : choice === 'no'  ? 'noWeight'
                :                    'abstainWeight';
    tx.update(proposalRef, {
      [field]: firebase.firestore.FieldValue.increment(votingWeight),
    });
  });

  return { weight: votingWeight, nftBoost: hasNFT };
}

// ─── My vote history ──────────────────────────────────────────────────────────
export async function getMyVotes(wallet) {
  const snap = await _db.collection('votes')
    .where('voter', '==', wallet)
    .get();

  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const ta = a.timestamp?.toDate ? a.timestamp.toDate().getTime() : 0;
      const tb = b.timestamp?.toDate ? b.timestamp.toDate().getTime() : 0;
      return tb - ta;
    });
}

// ─── Format helper (used by this module) ─────────────────────────────────────
function _fmtAmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

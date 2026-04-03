// ─── BASIS Gov — SPL Governance interactions ──────────────────────────────────
import {
  getRealm,
  getGovernance,
  getAllGovernances,
  getProposal,
  getProposalsByGovernance,
  getTokenOwnerRecord,
  getTokenOwnerRecordAddress,
  getVoteRecordAddress,
  getVoteRecord,
  withCreateRealm,
  withCreateGovernance,
  withDepositGoverningTokens,
  withWithdrawGoverningTokens,
  withCreateTokenOwnerRecord,
  withCreateProposal,
  withSignOffProposal,
  withCastVote,
  withRelinquishVote,
  withFinalizeVote,
  withCancelProposal,
  getGovernanceProgramVersion,
  VoteType,
  Vote,
  VoteKind,
  VoteChoice,
  GovernanceConfig,
  VoteTipping,
  VoteThreshold,
  VoteThresholdType,
  MintMaxVoteWeightSource,
  GoverningTokenConfigAccountArgs,
  GoverningTokenType,
  ProposalState,
} from '@solana/spl-governance';

import {
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';

function withPriority(tx, units = 400_000) {
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  );
  return tx;
}

import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';

import BN from 'bn.js';

import {
  GOVERNANCE_PROGRAM_ID,
  PROGRAM_VERSION,
  getBasisMint,
  BASIS_FACTOR,
  MIN_COMMUNITY_TOKENS_TO_CREATE_GOVERNANCE,
  getRealmName,
} from './config.js';

import { getConnection, getPublicKey, signAndSend, signAndSendSkipSim } from './wallet.js';
import { getGovConfig, setGovConfig }              from './firebase.js';

// ─── SPL Governance program error code descriptions (Custom error - 500 = index)
// Derived from @solana/spl-governance GovernanceError array in errors.js
function _govErrDesc(code) {
  const ERRORS = [
    'Invalid instruction',                                     // 500
    'Realm already exists',                                    // 501
    'Invalid realm',                                           // 502
    'Invalid Governing Token Mint',                            // 503
    'Governing Token Owner must sign',                         // 504
    'Governing Token Owner or Delegate must sign',             // 505
    'All votes must be relinquished to withdraw',              // 506
    'Invalid Token Owner Record address',                      // 507
    'Invalid GoverningMint for TokenOwnerRecord',              // 508
    'Invalid Realm for TokenOwnerRecord',                      // 509
    'Invalid Proposal for ProposalTransaction',                // 510
    'Invalid Signatory account address',                       // 511
    'Signatory already signed off',                            // 512
    'Signatory must sign',                                     // 513
    'Invalid Proposal Owner',                                  // 514
    'Invalid Proposal for VoterRecord',                        // 515
    'Invalid GoverningTokenOwner for VoteRecord',              // 516
    'Vote threshold out of range',                             // 517
    'Proposal already exists',                                 // 518
    'Token Owner already voted on this Proposal',              // 519
    "Not enough tokens to create Proposal",                    // 520
    "Can't edit Signatories",                                  // 521
    'Invalid Proposal state',                                  // 522
    "Can't edit instructions",                                 // 523
    "Can't execute instruction",                               // 524
    "Can't execute within hold up time",                       // 525
    'Instruction already executed',                            // 526
    'Invalid Instruction index',                               // 527
    'Hold up time below minimum',                              // 528
    'Instruction at index already exists',                     // 529
    "Can't sign off",                                          // 530
    "Can't vote — proposal not in Voting state",               // 531
    "Can't finalize vote",                                     // 532
    "Can't cancel Proposal",                                   // 533
    'Vote already relinquished',                               // 534
    "Can't finalize — voting still in progress",               // 535
    'Proposal voting time expired',                            // 536
  ];
  const desc = ERRORS[code - 500];
  return desc ?? null;
}

// ─── Cached state ─────────────────────────────────────────────────────────────
let _realm      = null;   // ProgramAccount<RealmV2>
let _governance = null;   // ProgramAccount<GovernanceV2>
let _realmPk    = null;
let _govPk      = null;

// ─── Load realm from Firebase config ──────────────────────────────────────────
export async function loadRealm() {
  const cfg = await getGovConfig();
  if (!cfg?.realmPk) return null;

  const conn = getConnection();
  _realmPk   = new PublicKey(cfg.realmPk);
  _realm     = await getRealm(conn, _realmPk);

  if (cfg.governancePk) {
    // Explicit governance PK stored in config — use it directly
    _govPk      = new PublicKey(cfg.governancePk);
    _governance = await getGovernance(conn, _govPk);
  } else {
    // No governance PK in config (Firestore blocked or first boot) —
    // query all governances for the realm and pick the one with the
    // longest valid voting duration.
    const govs  = await getAllGovernances(conn, GOVERNANCE_PROGRAM_ID, _realmPk);
    const valid = govs
      .filter(g => g.account.config.baseVotingTime > 0)
      .sort((a, b) => b.account.config.baseVotingTime - a.account.config.baseVotingTime);
    if (!valid.length) throw new Error('No valid governance found for realm');
    _governance = valid[0];
    _govPk      = valid[0].pubkey;
    console.log('[loadRealm] dynamic governance resolved:', _govPk.toBase58(),
      '— baseVotingTime:', _governance.account.config.baseVotingTime, 's');
  }

  return { realm: _realm, governance: _governance };
}

export const getRealmPk        = () => _realmPk;
export const getGovernancePk   = () => _govPk;
export const getRealmData      = () => _realm;
export const getGovernanceData = () => _governance;

// Clears all cached realm state — call after switching dev network
export function resetRealmState() {
  _realm      = null;
  _governance = null;
  _realmPk    = null;
  _govPk      = null;
}

// ─── One-time admin setup: create Realm + Governance ─────────────────────────
export async function setupRealm(votingDurationSeconds = 72 * 3600) {
  if (!getBasisMint()) throw new Error('Test token not configured. Use Dev Tools tab first.');
  const conn     = getConnection();
  const wallet   = getPublicKey();
  if (!wallet) throw new Error('Wallet not connected');

  // getGovernanceProgramVersion can mis-detect as 1 when it can't read program
  // data accounts on devnet. The on-chain program logs VERSION:"3.1.2" so we
  // floor at 3 to ensure correct instruction format is used.
  const _detectedVersion = await getGovernanceProgramVersion(conn, GOVERNANCE_PROGRAM_ID);
  const version = Math.max(_detectedVersion, 3);
  console.log(`[realm] governance program version: detected=${_detectedVersion} using=${version}`);

  // ── 1. Create Realm ──────────────────────────────────────────────────────────
  const realmIxs = [];
  // GoverningTokenConfigAccountArgs is only supported in program v2+
  const communityTokenConfig = version >= 2
    ? new GoverningTokenConfigAccountArgs({
        voterWeightAddin:    undefined,
        maxVoterWeightAddin: undefined,
        tokenType:           GoverningTokenType.Liquid,
      })
    : undefined;

  const realmPk  = await withCreateRealm(
    realmIxs,
    GOVERNANCE_PROGRAM_ID,
    version,
    getRealmName(),
    wallet,          // realm authority
    getBasisMint(),      // community mint
    wallet,          // payer
    undefined,       // no council mint
    MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION,
    new BN(String(10 ** 10)),  // 100% of supply can participate
    communityTokenConfig,
    undefined,       // no council token config
  );

  // Pre-check: if realm already exists on-chain, skip TX entirely (avoids
  // Phantom simulation warning when re-running setup after a previous deployment).
  let realmExists = false;
  try {
    const existingRealm = await getRealm(conn, realmPk);
    realmExists = true;
    // Verify the existing realm's community mint matches our current token.
    // Mismatch means a previous realm was deployed with a different token under
    // the same name — the TOR would fail with "Invalid Governing Token Mint".
    const onChainMint = existingRealm.account.communityMint;
    if (!onChainMint.equals(getBasisMint())) {
      throw new Error(
        `Realm "${getRealmName()}" already exists on-chain with a DIFFERENT community mint.\n\n` +
        `On-chain mint: ${onChainMint.toBase58()}\n` +
        `Current mint:  ${getBasisMint().toBase58()}\n\n` +
        `Fix: Dev Tools → Danger Zone → enter a new realm name → RESET REALM ONLY.`
      );
    }
  } catch (e) {
    if (realmExists) throw e; // re-throw our mint mismatch error
    // otherwise realm just doesn't exist yet — continue to create it
  }

  if (!realmExists) {
    const realmTx = withPriority(new Transaction().add(...realmIxs), 400_000);
    await signAndSend(realmTx, 'create-realm');
  } else {
    console.log('[realm] realm already exists on-chain, skipping create-realm TX');
  }

  // ── 2. Create Token Owner Record for admin (needed to create governance) ─────
  // withCreateTokenOwnerRecord (v3+) creates the TOR without requiring a deposit
  // or an existing ATA — eliminates the "Token Account doesn't exist" simulation error.
  const torPk = await getTokenOwnerRecordAddress(GOVERNANCE_PROGRAM_ID, realmPk, getBasisMint(), wallet);
  let torExists = false;
  try { await getTokenOwnerRecord(conn, torPk); torExists = true; } catch (_) {}

  if (!torExists) {
    const torIxs = [];
    await withCreateTokenOwnerRecord(
      torIxs,
      GOVERNANCE_PROGRAM_ID,
      version,
      realmPk,
      wallet,      // governing token owner
      getBasisMint(),
      wallet,      // payer
    );
    await signAndSend(withPriority(new Transaction().add(...torIxs), 200_000), 'create-tor');
  } else {
    console.log('[realm] token owner record already exists, skipping create-tor TX');
  }

  // ── 3. Create Governance ──────────────────────────────────────────────────────
  const govCfg = new GovernanceConfig({
    communityVoteThreshold:             new VoteThreshold({ type: VoteThresholdType.YesVotePercentage, value: 1 }),
    minCommunityTokensToCreateProposal: new BN(String(MIN_COMMUNITY_TOKENS_TO_CREATE_GOVERNANCE * BASIS_FACTOR)),
    minInstructionHoldUpTime:           0,           // SDK field (not minTransactionHoldUpTime)
    baseVotingTime:                     votingDurationSeconds,  // SDK field (not maxVotingTime)
    communityVoteTipping:               VoteTipping.Disabled,
    councilVoteThreshold:               new VoteThreshold({ type: VoteThresholdType.Disabled }),
    councilVetoVoteThreshold:           new VoteThreshold({ type: VoteThresholdType.Disabled }),
    minCouncilTokensToCreateProposal:   new BN(0),   // SDK field (not minCouncilWeightToCreateProposal)
    councilVoteTipping:                 VoteTipping.Disabled,
    communityVetoVoteThreshold:         new VoteThreshold({ type: VoteThresholdType.Disabled }),
    votingCoolOffTime:                  0,
    depositExemptProposalCount:         254,
  });

  const govIxs = [];
  const govPk  = await withCreateGovernance(
    govIxs,
    GOVERNANCE_PROGRAM_ID,
    version,
    realmPk,
    undefined,   // no governed account (pure token governance)
    govCfg,
    torPk,
    wallet,      // governance authority
    wallet,      // payer
    undefined,   // no voter weight record
  );

  // Pre-check: skip governance TX if it already exists
  let govExists = false;
  try { await getGovernance(conn, govPk); govExists = true; } catch (_) {}

  if (!govExists) {
    await signAndSend(withPriority(new Transaction().add(...govIxs), 300_000), 'create-governance');
  } else {
    console.log('[realm] governance already exists on-chain, skipping create-governance TX');
  }

  // ── 4. Persist addresses to Firebase ─────────────────────────────────────────
  await setGovConfig({
    realmPk:      realmPk.toBase58(),
    governancePk: govPk.toBase58(),
    createdAt:    Date.now(),
    createdBy:    wallet.toBase58(),
  });

  _realmPk    = realmPk;
  _govPk      = govPk;
  _realm      = await getRealm(conn, realmPk);
  _governance = await getGovernance(conn, govPk);

  return { realmPk: realmPk.toBase58(), governancePk: govPk.toBase58() };
}

// ─── Update governance config (duration + vote threshold) ─────────────────────
// SPL Governance has no in-place config update — a new governance is created
// with the desired settings under a deterministic governed account.
// Each (duration, threshold) combo maps to a unique well-known program ID so
// the PDA is deterministic and never collides across combos.
const _GOVERNED_ACCOUNTS = {
  // [durationSecs][thresholdPct] → governed account (PDA seed)
  259200: {
     1: () => _realmPk,
     5: () => new PublicKey('11111111111111111111111111111111'),       // System Program
    10: () => new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // Token Program
  },
  604800: {
     1: () => GOVERNANCE_PROGRAM_ID,
     5: () => new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bsX'), // Assoc Token Program
    10: () => new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),   // Metaplex Metadata
  },
  // Devnet short durations (threshold irrelevant — use realmPk variants)
  10:   { 1: () => new PublicKey('SysvarC1ock11111111111111111111111111111111') },
  60:   { 1: () => new PublicKey('SysvarRent111111111111111111111111111111111') },
  3600: { 1: () => _realmPk },
};

export async function updateGovernanceDuration(durationSecs, thresholdPct = 1) {
  const conn   = getConnection();
  const wallet = getPublicKey();
  if (!wallet)            throw new Error('Wallet not connected');
  if (!_realmPk || !_govPk) throw new Error('Realm not initialised');

  const version = Math.max(await getGovernanceProgramVersion(conn, GOVERNANCE_PROGRAM_ID), 3);

  const accountFn = _GOVERNED_ACCOUNTS[durationSecs]?.[thresholdPct]
                 ?? _GOVERNED_ACCOUNTS[durationSecs]?.[1]
                 ?? (() => _realmPk);
  const governedAccount = accountFn();

  const govCfg = new GovernanceConfig({
    communityVoteThreshold:             new VoteThreshold({ type: VoteThresholdType.YesVotePercentage, value: thresholdPct }),
    minCommunityTokensToCreateProposal: new BN(String(MIN_COMMUNITY_TOKENS_TO_CREATE_GOVERNANCE * BASIS_FACTOR)),
    minInstructionHoldUpTime:           0,
    baseVotingTime:                     durationSecs,
    communityVoteTipping:               VoteTipping.Disabled,
    councilVoteThreshold:               new VoteThreshold({ type: VoteThresholdType.Disabled }),
    councilVetoVoteThreshold:           new VoteThreshold({ type: VoteThresholdType.Disabled }),
    minCouncilTokensToCreateProposal:   new BN(0),
    councilVoteTipping:                 VoteTipping.Disabled,
    communityVetoVoteThreshold:         new VoteThreshold({ type: VoteThresholdType.Disabled }),
    votingCoolOffTime:                  0,
    depositExemptProposalCount:         254,
  });

  const torPk = await getTokenOwnerRecordAddress(
    GOVERNANCE_PROGRAM_ID, _realmPk, getBasisMint(), wallet,
  );

  const govIxs = [];
  const govPk  = await withCreateGovernance(
    govIxs, GOVERNANCE_PROGRAM_ID, version,
    _realmPk, governedAccount, govCfg,
    torPk, wallet, wallet, undefined,
  );

  let govExists = false;
  try { await getGovernance(conn, govPk); govExists = true; } catch (_) {}

  if (!govExists) {
    await signAndSend(withPriority(new Transaction().add(...govIxs), 300_000), 'update-governance');
  } else {
    console.log('[updateGovernanceDuration] governance already exists:', govPk.toBase58());
  }

  // Persist new active governance PK to Firebase config
  await setGovConfig({
    realmPk:      _realmPk.toBase58(),
    governancePk: govPk.toBase58(),
    updatedAt:    Date.now(),
  });

  // Update cached state immediately
  _govPk      = govPk;
  _governance = await getGovernance(conn, govPk);

  return govPk.toBase58();
}

// ─── Deposit $BASIS into the realm vault ──────────────────────────────────────
export async function depositTokens(amount) {
  if (!getBasisMint()) throw new Error('Test token not configured. Use Dev Tools tab first.');
  const conn   = getConnection();
  const wallet = getPublicKey();
  if (!wallet) throw new Error('Wallet not connected');
  if (!_realmPk) throw new Error('Realm not initialised');

  const version   = PROGRAM_VERSION;
  const ataOrTx   = await _getOrCreateATA(wallet);
  const rawAmount = new BN(String(Math.floor(amount * BASIS_FACTOR)));
  const ixs       = [];

  // Create ATA if missing
  if (ataOrTx.createIx) ixs.push(ataOrTx.createIx);

  await withDepositGoverningTokens(
    ixs,
    GOVERNANCE_PROGRAM_ID,
    version,
    _realmPk,
    ataOrTx.ata,     // source token account
    getBasisMint(),
    wallet,          // token owner
    wallet,          // transfer authority
    wallet,          // payer
    rawAmount,
  );

  return signAndSend(withPriority(new Transaction().add(...ixs), 300_000), 'deposit');
}

// ─── Withdraw all $BASIS from the realm vault ─────────────────────────────────
export async function withdrawTokens() {
  if (!getBasisMint()) throw new Error('Test token not configured. Use Dev Tools tab first.');
  const conn   = getConnection();
  const wallet = getPublicKey();
  if (!wallet) throw new Error('Wallet not connected');
  if (!_realmPk) throw new Error('Realm not initialised');

  const ataOrTx = await _getOrCreateATA(wallet);
  const ixs     = [];
  if (ataOrTx.createIx) ixs.push(ataOrTx.createIx);

  await withWithdrawGoverningTokens(
    ixs,
    GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    _realmPk,
    ataOrTx.ata,    // destination (user's ATA)
    getBasisMint(),
    wallet,
  );

  return signAndSend(withPriority(new Transaction().add(...ixs), 300_000), 'withdraw');
}

// ─── Get Token Owner Record (staked balance + vote counts) ────────────────────
export async function getStakeInfo(walletPk) {
  if (!_realmPk) return null;
  const conn  = getConnection();
  const torPk = await getTokenOwnerRecordAddress(
    GOVERNANCE_PROGRAM_ID, _realmPk, getBasisMint(), walletPk,
  );
  try {
    const tor = await getTokenOwnerRecord(conn, torPk);
    return {
      pubkey:              torPk,
      depositedAmount:     tor.account.governingTokenDepositAmount.toNumber() / BASIS_FACTOR,
      unrelinquishedVotes: tor.account.unrelinquishedVotesCount,
      outstandingVotes:    tor.account.outstandingProposalCount,
    };
  } catch (_) {
    return null; // account doesn't exist yet (never deposited)
  }
}

// ─── Create a proposal on-chain (returns proposal pubkey) ─────────────────────
export async function createProposal(title, descriptionLink) {
  const conn   = getConnection();
  const wallet = getPublicKey();
  if (!wallet)  throw new Error('Wallet not connected');
  if (!_realmPk || !_govPk) throw new Error('Realm not initialised');

  const gov       = await getGovernance(conn, _govPk);
  const nextIndex = gov.account.proposalCount;

  const torPk = await getTokenOwnerRecordAddress(
    GOVERNANCE_PROGRAM_ID, _realmPk, getBasisMint(), wallet,
  );

  const ixs = [];
  const proposalPk = await withCreateProposal(
    ixs,
    GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    _realmPk,
    _govPk,
    torPk,
    title,
    descriptionLink,     // stored in Firebase, referenced here as a short key
    getBasisMint(),
    wallet,              // governance authority
    nextIndex,
    VoteType.SINGLE_CHOICE,
    ['Approve'],         // single option label
    true,                // useDenyOption — enables YES/NO voting
    wallet,              // payer
  );

  // Sign off immediately so proposal moves from Draft → Voting
  await withSignOffProposal(
    ixs,
    GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    _realmPk,
    _govPk,
    proposalPk,
    wallet,   // signatory (creator signs off on their own proposal)
    undefined,
    torPk,
  );

  await signAndSend(withPriority(new Transaction().add(...ixs), 400_000), 'create-proposal');
  return proposalPk.toBase58();
}

// ─── Cast vote (YES = Approve, NO = Deny) ─────────────────────────────────────
export async function castVote(proposalPkStr, voteChoice) {
  const conn       = getConnection();
  const wallet     = getPublicKey();
  if (!wallet)            throw new Error('Wallet not connected');
  if (!_realmPk)          throw new Error('Realm not initialised');

  const proposalPk = new PublicKey(proposalPkStr);
  const proposal   = await getProposal(conn, proposalPk);
  // Use the governance the proposal was created under, not _govPk
  const govPk      = proposal.account.governance;

  const voterTorPk = await getTokenOwnerRecordAddress(
    GOVERNANCE_PROGRAM_ID, _realmPk, getBasisMint(), wallet,
  );

  const vote = voteChoice === 'yes'
    ? new Vote({
        voteType:       VoteKind.Approve,
        approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
        deny:           undefined,
        veto:           undefined,
      })
    : new Vote({
        voteType:       VoteKind.Deny,
        approveChoices: undefined,
        deny:           undefined,
        veto:           undefined,
      });

  const ixs = [];
  await withCastVote(
    ixs,
    GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    _realmPk,
    govPk,
    proposalPk,
    proposal.account.tokenOwnerRecord,  // proposer's TOR
    voterTorPk,
    wallet,          // governing token owner (voter)
    getBasisMint(),
    vote,
    wallet,          // payer
  );

  const tx = withPriority(new Transaction().add(...ixs), 300_000);

  // Pre-simulate on our own RPC so we can surface the exact program error
  // before Phantom shows its simulation dialog (which shows raw errors).
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer        = wallet;

  const sim = await conn.simulateTransaction(tx);
  console.log('[castVote] simulation result:', JSON.stringify(sim.value));
  if (sim.value.err) {
    const logs     = sim.value.logs ?? [];
    const errObj   = sim.value.err;
    // Extract custom program error code (e.g. { InstructionError: [0, { Custom: 511 }] })
    let codeMsg = '';
    const custom = errObj?.InstructionError?.[1]?.Custom;
    if (custom !== undefined) {
      const hex  = '0x' + custom.toString(16);
      const desc = _govErrDesc(custom);
      codeMsg = ` (program error ${hex}${desc ? ': ' + desc : ''})`;
    }
    const errLine = logs.findLast?.(l => l.includes('Error') || l.includes('failed')) ?? '';
    throw new Error(`Vote simulation failed${codeMsg}${errLine ? '\n' + errLine : ''}`);
  }
  console.log('[castVote] simulation OK — sending to Phantom (skipPreflight)');

  // Simulation passed on our devnet RPC — use skipPreflight to avoid Phantom
  // re-simulating and showing a false-positive warning dialog.
  return signAndSendSkipSim(tx, 'cast-vote');
}

// ─── Relinquish vote (required before withdrawing if voted on active proposal) ─
export async function relinquishVote(proposalPkStr) {
  const conn       = getConnection();
  const wallet     = getPublicKey();
  if (!wallet)            throw new Error('Wallet not connected');
  if (!_realmPk)          throw new Error('Realm not initialised');

  const proposalPk = new PublicKey(proposalPkStr);
  // Use the governance the proposal was actually created under, not _govPk
  const proposal   = await getProposal(conn, proposalPk);
  const govPk      = proposal.account.governance;
  const torPk      = await getTokenOwnerRecordAddress(
    GOVERNANCE_PROGRAM_ID, _realmPk, getBasisMint(), wallet,
  );
  const voteRecordPk = await getVoteRecordAddress(
    GOVERNANCE_PROGRAM_ID, proposalPk, torPk,
  );

  const ixs = [];
  await withRelinquishVote(
    ixs,
    GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    _realmPk,
    govPk,
    proposalPk,
    torPk,
    getBasisMint(),
    voteRecordPk,
    wallet,   // governance authority
    wallet,   // beneficiary (gets back rent lamports)
  );

  return signAndSend(withPriority(new Transaction().add(...ixs), 300_000));
}

// ─── Finalize a completed proposal (anyone can call) ─────────────────────────
export async function finalizeVote(proposalPkStr) {
  const conn       = getConnection();
  const wallet     = getPublicKey();
  if (!wallet)            throw new Error('Wallet not connected');
  if (!_realmPk)          throw new Error('Realm not initialised');

  const proposalPk = new PublicKey(proposalPkStr);
  const proposal   = await getProposal(conn, proposalPk);
  const govPk      = proposal.account.governance;

  const ixs = [];
  await withFinalizeVote(
    ixs,
    GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    _realmPk,
    govPk,
    proposalPk,
    proposal.account.tokenOwnerRecord,
    getBasisMint(),
    undefined, // no maxVoterWeightRecord
  );

  return signAndSend(withPriority(new Transaction().add(...ixs), 300_000));
}

// ─── Cancel all open (Voting) proposals owned by this wallet ─────────────────
// Dev-tool escape hatch: lets you unblock withdrawal without waiting for expiry.
// CancelProposal immediately sets state → Cancelled and decrements
// outstandingProposalCount on the Token Owner Record.
export async function cancelAllProposals() {
  const conn   = getConnection();
  const wallet = getPublicKey();
  if (!wallet)            throw new Error('Wallet not connected');
  if (!_realmPk || !_govPk) throw new Error('Realm not initialised');

  const proposals = await getProposalsByGovernance(conn, GOVERNANCE_PROGRAM_ID, _govPk);
  const cancelable = proposals.filter(p => p.account.state === ProposalState.Voting);
  if (cancelable.length === 0) throw new Error('No open proposals to cancel');

  const torPk = await getTokenOwnerRecordAddress(
    GOVERNANCE_PROGRAM_ID, _realmPk, getBasisMint(), wallet,
  );

  const sigs = [];
  for (const p of cancelable) {
    const ixs = [];
    await withCancelProposal(
      ixs,
      GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      _realmPk,
      _govPk,
      p.pubkey,
      torPk,   // proposalOwnerRecord (must be the TOR of the proposal creator)
      wallet,  // governanceAuthority (TOR owner must sign)
    );
    const sig = await signAndSend(withPriority(new Transaction().add(...ixs), 200_000), 'cancel-proposal');
    sigs.push(sig);
  }
  return sigs;
}

// ─── List proposals across ALL governance accounts for the realm ───────────────
// Proposals are tied to the governance they were created under. Fetching only
// _govPk misses proposals from previous governance accounts (e.g. created under
// the 1-hour governance before the duration was changed to 3D/7D).
export async function listProposals() {
  if (!_realmPk) return [];
  const conn = getConnection();
  const allGovs = await getAllGovernances(conn, GOVERNANCE_PROGRAM_ID, _realmPk);
  const results = await Promise.allSettled(
    allGovs.map(g => getProposalsByGovernance(conn, GOVERNANCE_PROGRAM_ID, g.pubkey))
  );
  const proposals = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  // Deduplicate by pubkey (shouldn't happen, but be safe)
  const seen = new Set();
  return proposals
    .filter(p => {
      if (p.account.state === ProposalState.Cancelled) return false;
      const key = p.pubkey.toBase58();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const ta = a.account.draftAt?.toNumber() ?? 0;
      const tb = b.account.draftAt?.toNumber() ?? 0;
      return tb - ta;
    });
}

// ─── Check if wallet has voted on a proposal ──────────────────────────────────
export async function getMyVoteRecord(proposalPkStr, walletPk) {
  if (!_realmPk) return null;
  const conn       = getConnection();
  const proposalPk = new PublicKey(proposalPkStr);
  const torPk      = await getTokenOwnerRecordAddress(
    GOVERNANCE_PROGRAM_ID, _realmPk, getBasisMint(), walletPk,
  );
  const voteRecordPk = await getVoteRecordAddress(
    GOVERNANCE_PROGRAM_ID, proposalPk, torPk,
  );
  try {
    return await getVoteRecord(conn, voteRecordPk);
  } catch (_) {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Always return an idempotent create instruction — no RPC lookup needed.
// createAssociatedTokenAccountIdempotentInstruction is a no-op if ATA already
// exists, so it's safe to include unconditionally (avoids stale-cache failures).
async function _getOrCreateATA(walletPk) {
  const ata = await getAssociatedTokenAddress(getBasisMint(), walletPk);
  const createIx = createAssociatedTokenAccountIdempotentInstruction(
    walletPk, ata, walletPk, getBasisMint(),
  );
  return { ata, createIx };
}

// ─── Human-readable proposal state ────────────────────────────────────────────
export function proposalStateLabel(state) {
  const map = {
    [ProposalState.Draft]:             'DRAFT',
    [ProposalState.SigningOff]:        'SIGNING OFF',
    [ProposalState.Voting]:            'ACTIVE',
    [ProposalState.Succeeded]:         'PASSED',
    [ProposalState.Executing]:         'PASSED',
    [ProposalState.Completed]:         'PASSED',
    [ProposalState.Cancelled]:         'CANCELLED',
    [ProposalState.Defeated]:          'FAILED',
    [ProposalState.ExecutingWithErrors]:'FAILED',
    [ProposalState.Vetoed]:            'VETOED',
  };
  return map[state] ?? 'UNKNOWN';
}

export { ProposalState };

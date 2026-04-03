// ─── BASIS Gov — Main Application ────────────────────────────────────────────
import { FIREBASE_CONFIG, VOTING_DURATIONS, MIN_PROPOSAL_STAKE } from './config.js';
import { connect, disconnect, isConnected, getPublicKey, signMessage } from './wallet.js';
import {
  initStaking, getOnChainBasisBalance, getConfig,
  getStakeRecord, watchStakeRecord,
  stakeTokens, initiateUnstake, finalizeUnstake,
  claimRewards, computePendingRewards, checkNFTBoost,
} from './staking.js';
import {
  initProposals, watchProposals, watchProposalDetail, stopWatchingDetail,
  createProposal, castVote, getMyVotes, computeStatus,
} from './proposals.js';

// ─── Firebase init ────────────────────────────────────────────────────────────
if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore();
initStaking(db);
initProposals(db);

// ─── State ────────────────────────────────────────────────────────────────────
let _unsubProposals  = null;
let _unsubStake      = null;
let _stakeRecord     = null;
let _onChainBalance  = 0;
let _config          = { rewardRateAPY: 20, cooldownDays: 7, minProposalStake: 10_000_000, quorumPercent: 5, totalStaked: 0 };
let _hasNFT          = false;
let _currentTab      = 'stake';
let _activeProposals = [];
let _pastProposals   = [];

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function showToast(msg, type = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className   = 'toast show ' + type;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 4000);
}

function setBtn(id, text, disabled = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.disabled    = disabled;
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function fmtAmt(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtCountdown(endsAt) {
  if (!endsAt) return '—';
  const end  = endsAt.toDate ? endsAt.toDate() : new Date(endsAt);
  const diff = end.getTime() - Date.now();
  if (diff <= 0) return 'ENDED';
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (d > 0) return `${d}D ${h}H ${m}M`;
  if (h > 0) return `${h}H ${m}M`;
  return `${m}M`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().split('T')[0];
}

function badgeHtml(status) {
  const map = {
    active:   '<span class="badge badge-active">[ACTIVE]</span>',
    passed:   '<span class="badge badge-passed">[PASSED]</span>',
    failed:   '<span class="badge badge-failed">[FAILED]</span>',
    no_quorum:'<span class="badge badge-noquorum">[NO QUORUM]</span>',
    pending:  '<span class="badge badge-pending">[PENDING]</span>',
  };
  return map[status] || map.pending;
}

function shortKey(k) { return k ? k.slice(0, 6) + '…' + k.slice(-4) : '—'; }

// ─── Tab navigation ───────────────────────────────────────────────────────────
function switchTab(tab) {
  _currentTab = tab;
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-tab]').forEach(b => b.classList.remove('active'));
  const pane = $('tab-' + tab);
  if (pane) pane.classList.add('active');
  const btn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (btn) { btn.classList.add('active'); btn.setAttribute('aria-current', 'page'); }
  if (tab !== 'detail') stopWatchingDetail();
  if (tab === 'activity' && isConnected()) renderActivity();
  // Close mobile sidebar
  $('sidebar')?.classList.remove('open');
  $('sidebarBackdrop')?.classList.remove('open');
}

document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
$('sidebarToggle')?.addEventListener('click', () => {
  $('sidebar').classList.toggle('open');
  $('sidebarBackdrop').classList.toggle('open');
});
$('sidebarBackdrop')?.addEventListener('click', () => {
  $('sidebar').classList.remove('open');
  $('sidebarBackdrop').classList.remove('open');
});

// ─── Wallet UI ────────────────────────────────────────────────────────────────
function updateWalletUI() {
  const wallet    = getPublicKey();
  const statusEl  = $('walletStatus');
  const btnEl     = $('walletBtn');
  const sidebarEl = $('sidebarWallet');

  if (wallet) {
    statusEl.textContent  = shortKey(wallet);
    statusEl.className    = 'wallet-chip connected';
    btnEl.textContent     = '[ DISCONNECT ]';
    if (sidebarEl) sidebarEl.innerHTML =
      `<div class="net-status"><span class="dot-live" aria-hidden="true"></span>SOLANA MAINNET</div>
       <div class="wallet-addr">${esc(shortKey(wallet))}</div>`;
  } else {
    statusEl.textContent  = 'NOT CONNECTED';
    statusEl.className    = 'wallet-chip';
    btnEl.textContent     = '[ CONNECT WALLET ]';
    if (sidebarEl) sidebarEl.innerHTML =
      `<div class="net-status"><span class="dot-live" aria-hidden="true"></span>SOLANA MAINNET</div>`;
  }
}

$('walletBtn')?.addEventListener('click', async () => {
  if (isConnected()) {
    await disconnect();
    _stakeRecord    = null;
    _onChainBalance = 0;
    _hasNFT         = false;
    if (_unsubStake) { _unsubStake(); _unsubStake = null; }
    updateWalletUI();
    renderStakeTab();
    return;
  }
  $('walletModal').classList.add('open');
});

$('walletModalClose')?.addEventListener('click', () =>
  $('walletModal').classList.remove('open'),
);

document.querySelectorAll('.wallet-option').forEach(btn => {
  btn.addEventListener('click', async () => {
    const provider = btn.dataset.wallet;
    $('walletModal').classList.remove('open');
    try {
      await connect(provider);
      updateWalletUI();
      await loadUserData();
    } catch (e) {
      showToast(e.message, 'err');
    }
  });
});

// ─── Load user data after connect ────────────────────────────────────────────
async function loadUserData() {
  const wallet = getPublicKey();
  if (!wallet) return;

  // Parallel load
  [_config, _onChainBalance, _hasNFT] = await Promise.all([
    getConfig(),
    getOnChainBasisBalance(wallet),
    checkNFTBoost(wallet),
  ]);

  // Watch stake record in real time
  if (_unsubStake) _unsubStake();
  _unsubStake = watchStakeRecord(wallet, record => {
    _stakeRecord = record;
    renderStakeTab();
  });

  renderStakeTab();
}

// ════════════════════════════════════════════════════════════════════════════════
//  STAKE TAB
// ════════════════════════════════════════════════════════════════════════════════
function renderStakeTab() {
  const wallet = getPublicKey();

  if (!wallet) {
    $('stakeContent').innerHTML = `
      <div class="connect-prompt panel">
        <div class="mbar"><div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://STAKE</div></div><div class="mstatus">OFFLINE</div></div>
        <p class="prose" style="margin-top:8px">Connect your wallet to view your staking dashboard.</p>
        <button class="btn btn-primary" id="stakeConnectBtn" style="margin-top:16px">[ CONNECT WALLET ]</button>
      </div>`;
    $('stakeConnectBtn')?.addEventListener('click', () =>
      $('walletModal').classList.add('open'),
    );
    return;
  }

  const record         = _stakeRecord;
  const staked         = record?.stakedAmount ?? 0;
  const onChain        = _onChainBalance;
  const effective      = Math.min(staked, onChain);
  const voteWeight     = _hasNFT ? effective * 1.5 : effective;
  const apy            = _config?.rewardRateAPY ?? 20;
  const pending        = (record?.pendingRewards ?? 0) + computePendingRewards(record, apy);
  const inCooldown     = !!record?.cooldownEndsAt;
  const cooldownEnd    = record?.cooldownEndsAt
    ? (record.cooldownEndsAt.toDate ? record.cooldownEndsAt.toDate() : new Date(record.cooldownEndsAt))
    : null;
  const cooldownDone   = cooldownEnd && Date.now() >= cooldownEnd.getTime();

  $('stakeContent').innerHTML = `
    <!-- Stats row -->
    <div class="stake-stats">
      <div class="metric-card">
        <div class="mc-label">ON-CHAIN BALANCE</div>
        <div class="mc-val">${fmtAmt(onChain)}</div>
        <div class="mc-sub">$BASIS IN WALLET</div>
      </div>
      <div class="metric-card featured">
        <div class="mc-label">STAKED AMOUNT</div>
        <div class="mc-val">${fmtAmt(staked)}</div>
        <div class="mc-sub">COMMITTED</div>
      </div>
      <div class="metric-card">
        <div class="mc-label">VOTE WEIGHT</div>
        <div class="mc-val">${fmtAmt(voteWeight)}</div>
        <div class="mc-sub">${_hasNFT ? '1.5× NFT BOOST' : 'NO BOOST'}</div>
      </div>
      <div class="metric-card">
        <div class="mc-label">PENDING REWARDS</div>
        <div class="mc-val">${fmtAmt(pending)}</div>
        <div class="mc-sub">${apy}% APY</div>
      </div>
    </div>

    <!-- NFT boost notice -->
    ${_hasNFT ? `
    <div class="notice notice-boost">
      <span class="notice-icon">◆</span> BASIS GENESIS NFT DETECTED — 1.5× VOTE MULTIPLIER ACTIVE
    </div>` : ''}

    <!-- Stake panel -->
    <div class="panel" style="margin-top:20px">
      <div class="mbar">
        <div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://STAKE-TOKENS</div></div>
        <div class="mstatus">${staked > 0 ? 'ACTIVE' : 'READY'}</div>
      </div>
      <h2>> STAKE $BASIS</h2>
      <p class="prose">Staking commits your $BASIS as governance collateral. Your on-chain balance is verified at every vote. Minimum 10,000,000 to create proposals.</p>
      ${inCooldown && !cooldownDone ? `
      <div class="notice notice-warn" style="margin:14px 0">
        ⚠ UNSTAKE COOLDOWN ACTIVE — ends in ${fmtCountdown(record.cooldownEndsAt)}<br>
        <span style="font-size:0.72rem;color:var(--text-dim)">You can still vote with your current stake weight during cooldown.</span>
      </div>` : ''}
      <div class="inp-row" style="margin-top:14px">
        <input type="number" id="stakeInput" class="tool-input" placeholder="Amount to stake (e.g. 1000000)" min="1" ${inCooldown && !cooldownDone ? 'disabled' : ''}>
        <button class="btn btn-primary" id="stakeBtn" ${inCooldown && !cooldownDone ? 'disabled' : ''}>[ STAKE ]</button>
      </div>
      <div class="btn-row" style="margin-top:12px">
        ${staked > 0 && !inCooldown ? `<button class="btn" id="unstakeBtn">[ INITIATE UNSTAKE ]</button>` : ''}
        ${cooldownDone ? `<button class="btn btn-primary" id="finalizeBtn">[ FINALIZE UNSTAKE ]</button>` : ''}
        ${pending > 0.01 ? `<button class="btn" id="claimBtn">[ CLAIM ${fmtAmt(pending)} $BASIS ]</button>` : ''}
      </div>
      ${pending > 0.01 ? `<p class="prose" style="margin-top:8px;font-size:0.76rem">⚡ Rewards are distributed periodically by the team. Claiming records your request on-chain.</p>` : ''}
    </div>`;

  // Wire up stake button
  $('stakeBtn')?.addEventListener('click', handleStake);
  $('unstakeBtn')?.addEventListener('click', handleUnstake);
  $('finalizeBtn')?.addEventListener('click', handleFinalizeUnstake);
  $('claimBtn')?.addEventListener('click', handleClaim);
}

async function handleStake() {
  const input  = parseFloat($('stakeInput').value);
  if (!input || input <= 0) return showToast('Enter a valid stake amount', 'err');
  if (input > _onChainBalance) return showToast(`Insufficient on-chain balance (${fmtAmt(_onChainBalance)} $BASIS)`, 'err');

  setBtn('stakeBtn', '[ SIGNING… ]', true);
  try {
    const sig = await signMessage(`BASIS-GOV:STAKE:${input}:${Date.now()}`);
    await stakeTokens(getPublicKey(), input, sig);
    _onChainBalance = await getOnChainBasisBalance(getPublicKey());
    showToast(`Staked ${fmtAmt(input)} $BASIS`, 'ok');
    $('stakeInput').value = '';
  } catch (e) {
    showToast(e.message, 'err');
  } finally {
    setBtn('stakeBtn', '[ STAKE ]', false);
  }
}

async function handleUnstake() {
  if (!confirm(`Initiate unstake? Tokens will be released after a ${_config.cooldownDays ?? 7}-day cooldown. You can still vote during this period.`)) return;
  setBtn('unstakeBtn', '[ SIGNING… ]', true);
  try {
    const sig = await signMessage(`BASIS-GOV:UNSTAKE:${Date.now()}`);
    await initiateUnstake(getPublicKey(), sig);
    showToast('Cooldown started. Come back in 7 days to finalize.', 'ok');
  } catch (e) {
    showToast(e.message, 'err');
  }
}

async function handleFinalizeUnstake() {
  setBtn('finalizeBtn', '[ FINALIZING… ]', true);
  try {
    await finalizeUnstake(getPublicKey());
    showToast('Unstake complete. Tokens are now free.', 'ok');
  } catch (e) {
    showToast(e.message, 'err');
  }
}

async function handleClaim() {
  const apy     = _config?.rewardRateAPY ?? 20;
  const pending = (_stakeRecord?.pendingRewards ?? 0) + computePendingRewards(_stakeRecord, apy);
  if (pending < 0.01) return;
  setBtn('claimBtn', '[ SIGNING… ]', true);
  try {
    const sig = await signMessage(`BASIS-GOV:CLAIM:${pending}:${Date.now()}`);
    await claimRewards(getPublicKey(), pending, sig);
    showToast(`Claim of ${fmtAmt(pending)} $BASIS recorded. Distribution pending.`, 'ok');
  } catch (e) {
    showToast(e.message, 'err');
  } finally {
    setBtn('claimBtn', `[ CLAIM ]`, false);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
//  PROPOSALS TAB
// ════════════════════════════════════════════════════════════════════════════════
function renderProposalCard(p) {
  const status   = computeStatus(p);
  const yes      = p.yesWeight     || 0;
  const no       = p.noWeight      || 0;
  const abstain  = p.abstainWeight || 0;
  const total    = yes + no + abstain || 1;
  const yesPct   = ((yes / total) * 100).toFixed(1);
  const noPct    = ((no  / total) * 100).toFixed(1);
  return `
    <article class="proposal-card" role="button" tabindex="0" data-id="${esc(p.id)}">
      <div class="pc-head">
        <div class="pc-title">${esc(p.title)}</div>
        ${badgeHtml(status)}
      </div>
      <p class="pc-desc">${esc((p.description || '').slice(0, 120))}${(p.description || '').length > 120 ? '…' : ''}</p>
      <div class="vote-preview">
        <div class="vp-row">
          <span class="vp-label yes-label">YES</span>
          <div class="vote-bar-track"><div class="vote-bar-fill yes" style="width:${yesPct}%"></div></div>
          <span class="vp-pct">${yesPct}%</span>
        </div>
        <div class="vp-row">
          <span class="vp-label no-label">NO</span>
          <div class="vote-bar-track"><div class="vote-bar-fill no" style="width:${noPct}%"></div></div>
          <span class="vp-pct">${noPct}%</span>
        </div>
      </div>
      <div class="pc-foot">
        <span class="pc-by">BY ${esc(shortKey(p.author))}</span>
        <span class="pc-time">${status === 'active' ? fmtCountdown(p.endsAt) : fmtDate(p.createdAt)}</span>
      </div>
    </article>`;
}

function renderProposalsList(proposals) {
  const active = proposals.filter(p => computeStatus(p) === 'active');
  const past   = proposals.filter(p => computeStatus(p) !== 'active');

  const activeHtml = active.length
    ? active.map(renderProposalCard).join('')
    : '<div class="empty-state">No active proposals.</div>';

  const pastHtml = past.length
    ? past.map(renderProposalCard).join('')
    : '<div class="empty-state">No past proposals.</div>';

  $('activeProposals').innerHTML  = activeHtml;
  $('pastProposals').innerHTML    = pastHtml;

  document.querySelectorAll('.proposal-card').forEach(card => {
    const open = () => openProposalDetail(card.dataset.id);
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(); });
  });
}

function startWatchingProposals() {
  if (_unsubProposals) return;
  _unsubProposals = watchProposals(proposals => {
    _activeProposals = proposals.filter(p => computeStatus(p) === 'active');
    _pastProposals   = proposals.filter(p => computeStatus(p) !== 'active');
    renderProposalsList(proposals);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
//  PROPOSAL DETAIL TAB
// ════════════════════════════════════════════════════════════════════════════════
function openProposalDetail(proposalId) {
  switchTab('detail');
  $('detailContent').innerHTML = `<div class="loading-msg">LOADING…</div>`;

  watchProposalDetail(proposalId, proposal => {
    if (!proposal) {
      $('detailContent').innerHTML = `<div class="empty-state">Proposal not found.</div>`;
      return;
    }
    renderDetail(proposal);
  });
}

function renderDetail(p) {
  const status  = computeStatus(p);
  const yes     = p.yesWeight     || 0;
  const no      = p.noWeight      || 0;
  const abstain = p.abstainWeight || 0;
  const total   = yes + no + abstain || 1;
  const yesPct    = ((yes / total) * 100).toFixed(1);
  const noPct     = ((no  / total) * 100).toFixed(1);
  const abstPct   = ((abstain / total) * 100).toFixed(1);
  const quorum    = p.quorumTarget || 0;
  const quorumPct = quorum > 0 ? Math.min(100, ((total / quorum) * 100)).toFixed(1) : '—';
  const quorumMet = quorum > 0 && (yes + no + abstain) >= quorum;

  const canVote   = isConnected() && status === 'active';

  $('detailContent').innerHTML = `
    <div class="detail-head">
      <button class="btn btn-sm" id="backBtn">[ ← PROPOSALS ]</button>
      ${badgeHtml(status)}
    </div>

    <div class="panel" style="margin-top:16px">
      <div class="mbar">
        <div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://PROPOSAL</div></div>
        <div class="mstatus ${status === 'active' ? 'live' : ''}">${status === 'active' ? fmtCountdown(p.endsAt) : status.toUpperCase()}</div>
      </div>

      <h2 style="font-size:1.1rem;margin-bottom:8px">> ${esc(p.title)}</h2>
      <div class="kv" style="margin-bottom:16px">
        <div class="kv-row"><span class="kv-k">AUTHOR</span><span class="kv-v" style="font-size:0.72rem">${esc(p.author || '—')}</span></div>
        <div class="kv-row"><span class="kv-k">CREATED</span><span class="kv-v">${fmtDate(p.createdAt)}</span></div>
        <div class="kv-row"><span class="kv-k">${status === 'active' ? 'ENDS IN' : 'ENDED'}</span><span class="kv-v">${status === 'active' ? fmtCountdown(p.endsAt) : fmtDate(p.endsAt)}</span></div>
      </div>

      <div class="prose" style="white-space:pre-wrap;margin-bottom:20px">${esc(p.description)}</div>

      <!-- Vote breakdown -->
      <div class="vote-section">
        <div class="vote-title">VOTE BREAKDOWN</div>
        <div class="vote-bars">
          <div class="vb-row">
            <span class="vb-label yes-label">YES</span>
            <div class="vote-bar-track"><div class="vote-bar-fill yes" style="width:${yesPct}%"></div></div>
            <span class="vb-pct">${yesPct}%</span>
            <span class="vb-weight">${fmtAmt(yes)}</span>
          </div>
          <div class="vb-row">
            <span class="vb-label no-label">NO</span>
            <div class="vote-bar-track"><div class="vote-bar-fill no" style="width:${noPct}%"></div></div>
            <span class="vb-pct">${noPct}%</span>
            <span class="vb-weight">${fmtAmt(no)}</span>
          </div>
          <div class="vb-row">
            <span class="vb-label abs-label">ABS</span>
            <div class="vote-bar-track"><div class="vote-bar-fill abs" style="width:${abstPct}%"></div></div>
            <span class="vb-pct">${abstPct}%</span>
            <span class="vb-weight">${fmtAmt(abstain)}</span>
          </div>
        </div>

        <!-- Quorum bar -->
        <div class="quorum-section">
          <div class="quorum-label">
            QUORUM ${quorumMet ? '<span class="badge badge-passed">[MET]</span>' : '<span class="badge badge-pending">[PENDING]</span>'}
          </div>
          <div class="vote-bar-track" style="margin:6px 0">
            <div class="vote-bar-fill ${quorumMet ? 'yes' : 'abs'}" style="width:${typeof quorumPct === 'string' && quorumPct !== '—' ? quorumPct : 0}%"></div>
          </div>
          <div class="quorum-meta">${fmtAmt(yes + no + abstain)} / ${fmtAmt(quorum)} required ${quorumPct !== '—' ? `(${quorumPct}%)` : ''}</div>
        </div>
      </div>

      <!-- Voting buttons -->
      ${canVote ? `
      <div class="vote-actions">
        <div class="vote-actions-label">CAST YOUR VOTE</div>
        <div class="btn-row">
          <button class="btn btn-vote-yes"  id="voteYes">[ VOTE YES ]</button>
          <button class="btn btn-vote-no"   id="voteNo">[ VOTE NO ]</button>
          <button class="btn btn-vote-abs"  id="voteAbs">[ ABSTAIN ]</button>
        </div>
        <p class="prose" style="font-size:0.76rem;margin-top:8px">Your wallet will be asked to sign this vote. Signing is free — no SOL spent.</p>
      </div>` : !isConnected() ? `
      <div class="notice notice-warn" style="margin-top:16px">Connect your wallet to vote.</div>` : `
      <div class="notice" style="margin-top:16px">Voting is closed for this proposal.</div>`}
    </div>`;

  $('backBtn')?.addEventListener('click', () => switchTab('proposals'));

  if (canVote) {
    $('voteYes')?.addEventListener('click', () => handleVote(p.id, 'yes'));
    $('voteNo')?.addEventListener('click',  () => handleVote(p.id, 'no'));
    $('voteAbs')?.addEventListener('click', () => handleVote(p.id, 'abstain'));
  }
}

async function handleVote(proposalId, choice) {
  const btnId = choice === 'yes' ? 'voteYes' : choice === 'no' ? 'voteNo' : 'voteAbs';
  setBtn(btnId, '[ SIGNING… ]', true);
  ['voteYes', 'voteNo', 'voteAbs'].forEach(id => { if ($( id)) $(id).disabled = true; });

  try {
    const result = await castVote(proposalId, choice);
    const boost  = result.nftBoost ? ' (1.5× NFT boost applied)' : '';
    showToast(`Vote cast — ${fmtAmt(result.weight)} weight${boost}`, 'ok');
  } catch (e) {
    showToast(e.message, 'err');
    ['voteYes', 'voteNo', 'voteAbs'].forEach(id => { if ($(id)) $(id).disabled = false; });
    setBtn(btnId, choice === 'yes' ? '[ VOTE YES ]' : choice === 'no' ? '[ VOTE NO ]' : '[ ABSTAIN ]');
  }
}

// ════════════════════════════════════════════════════════════════════════════════
//  CREATE PROPOSAL TAB
// ════════════════════════════════════════════════════════════════════════════════
// Duration selector state
let _selectedDuration = 72;
document.querySelectorAll('.duration-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.duration-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _selectedDuration = parseInt(btn.dataset.hours, 10);
  });
});

$('submitProposalBtn')?.addEventListener('click', async () => {
  const title = $('propTitle')?.value?.trim();
  const desc  = $('propDesc')?.value?.trim();

  if (!title) return showToast('Title is required', 'err');
  if (!desc)  return showToast('Description is required', 'err');
  if (!isConnected()) return showToast('Connect your wallet first', 'err');

  setBtn('submitProposalBtn', '[ SUBMITTING… ]', true);
  try {
    const id = await createProposal(title, desc, _selectedDuration);
    showToast('Proposal created!', 'ok');
    $('propTitle').value = '';
    $('propDesc').value  = '';
    switchTab('proposals');
    setTimeout(() => openProposalDetail(id), 600);
  } catch (e) {
    showToast(e.message, 'err');
  } finally {
    setBtn('submitProposalBtn', '[ CREATE PROPOSAL ]', false);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  ACTIVITY TAB
// ════════════════════════════════════════════════════════════════════════════════
async function renderActivity() {
  const wallet = getPublicKey();
  if (!wallet) {
    $('activityContent').innerHTML = `<div class="empty-state">Connect your wallet to view your activity.</div>`;
    return;
  }

  $('activityContent').innerHTML = `<div class="loading-msg">LOADING…</div>`;

  try {
    const [record, votes, config] = await Promise.all([
      getStakeRecord(wallet),
      getMyVotes(wallet),
      getConfig(),
    ]);

    const staked   = record?.stakedAmount ?? 0;
    const pending  = (record?.pendingRewards ?? 0) + computePendingRewards(record, config.rewardRateAPY ?? 20);
    const claimed  = record?.totalClaimed ?? 0;

    const stakeHtml = `
      <div class="panel">
        <div class="mbar"><div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://MY-STAKE</div></div><div class="mstatus">${staked > 0 ? 'ACTIVE' : 'NONE'}</div></div>
        <h2>> MY STAKING RECORD</h2>
        <div class="kv">
          <div class="kv-row"><span class="kv-k">WALLET</span><span class="kv-v" style="font-size:0.70rem">${esc(wallet)}</span></div>
          <div class="kv-row"><span class="kv-k">STAKED</span><span class="kv-v">${fmtAmt(staked)} $BASIS</span></div>
          <div class="kv-row"><span class="kv-k">PENDING REWARDS</span><span class="kv-v">${fmtAmt(pending)} $BASIS</span></div>
          <div class="kv-row"><span class="kv-k">TOTAL CLAIMED</span><span class="kv-v">${fmtAmt(claimed)} $BASIS</span></div>
          <div class="kv-row"><span class="kv-k">NFT BOOST</span><span class="kv-v">${_hasNFT ? '✓ 1.5× ACTIVE' : '—'}</span></div>
          ${record?.stakedAt ? `<div class="kv-row"><span class="kv-k">STAKED SINCE</span><span class="kv-v">${fmtDate(record.stakedAt)}</span></div>` : ''}
          ${record?.cooldownEndsAt ? `<div class="kv-row"><span class="kv-k">COOLDOWN ENDS</span><span class="kv-v">${fmtCountdown(record.cooldownEndsAt)}</span></div>` : ''}
        </div>
      </div>`;

    const voteRows = votes.map(v => `
      <tr>
        <td style="font-size:0.72rem;word-break:break-all">${esc(v.proposalId)}</td>
        <td><span class="badge ${v.choice === 'yes' ? 'badge-passed' : v.choice === 'no' ? 'badge-failed' : 'badge-noquorum'}">${esc(v.choice?.toUpperCase())}</span></td>
        <td>${fmtAmt(v.weight)}</td>
        <td>${v.nftBoost ? '1.5×' : '—'}</td>
        <td>${fmtDate(v.timestamp)}</td>
      </tr>`).join('');

    const votesHtml = `
      <div class="panel" style="margin-top:20px">
        <div class="mbar"><div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://MY-VOTES</div></div><div class="mstatus">${votes.length} VOTE${votes.length !== 1 ? 'S' : ''}</div></div>
        <h2>> MY VOTES</h2>
        ${votes.length ? `
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>PROPOSAL ID</th><th>CHOICE</th><th>WEIGHT</th><th>BOOST</th><th>DATE</th></tr></thead>
            <tbody>${voteRows}</tbody>
          </table>
        </div>` : '<div class="empty-state">No votes cast yet.</div>'}
      </div>`;

    $('activityContent').innerHTML = stakeHtml + votesHtml;
  } catch (e) {
    $('activityContent').innerHTML = `<div class="empty-state">Error loading activity: ${esc(e.message)}</div>`;
  }
}

// ─── Countdown ticker (refreshes visible countdowns every 30s) ────────────────
setInterval(() => {
  if (_currentTab === 'proposals') renderProposalsList([..._activeProposals, ..._pastProposals]);
}, 30_000);

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  updateWalletUI();
  startWatchingProposals();
  getConfig().then(cfg => { _config = cfg; }).catch(() => {});

  // Footer clock
  function tickFooter() {
    const el = $('tf-timestamp');
    if (el) el.textContent = new Date().toUTCString().slice(17, 25) + ' UTC';
  }
  tickFooter();
  setInterval(tickFooter, 1000);
})();

// ─── BASIS Gov — Main Application ────────────────────────────────────────────
import './polyfill.js'; // MUST be first — sets globalThis.Buffer before Solana deps evaluate
import { PublicKey } from '@solana/web3.js';
import { ProposalState } from '@solana/spl-governance';

import { connect, disconnect, isConnected, getPublicKey, getConnection, resetConnection } from './wallet.js';
import {
  loadRealm, getRealmData, getGovernanceData, getRealmPk, getGovernancePk,
  setupRealm, updateGovernanceDuration, depositTokens, withdrawTokens,
  getStakeInfo, createProposal, castVote, relinquishVote, finalizeVote,
  cancelAllProposals, listProposals, getMyVoteRecord, proposalStateLabel,
  resetRealmState,
} from './realm.js';
import {
  getGovConfig, getAllProposalMeta, getProposalMeta, saveProposalMeta,
} from './firebase.js';
import { IS_DEVNET, NETWORK_LABEL, getDevNetwork, setDevNetwork, DEV_NETWORK_RPCS } from './config.js';
import {
  airdropSol, launchTestToken, mintMoreTokens,
  getTestTokenBalance, getDevnetMint, clearDevnetMint,
  getSolBalance, TEST_TOKEN_NAME, TEST_TOKEN_SYMBOL, TEST_TOKEN_DECIMALS, TEST_TOKEN_SUPPLY,
  fullDevnetReset, getDevnetRealmName, setDevnetRealmName,
  burnTokens, getTokenAccountInfo,
} from './tokenLauncher.js';
import { deleteGovConfig } from './firebase.js';

// ─── Global error handlers ────────────────────────────────────────────────────
window.addEventListener('unhandledrejection', (event) => {
  console.error('[unhandledrejection]', event.reason);
  const msg = event.reason?.message ?? String(event.reason ?? 'Unknown async error');
  const t = document.getElementById('toast');
  if (t) { t.textContent = msg; t.className = 'toast show err'; clearTimeout(t._tid); t._tid = setTimeout(() => t.classList.remove('show'), 5000); }
});
window.addEventListener('error', (event) => {
  console.error('[onerror]', event.error ?? event.message);
  const msg = event.error?.message ?? event.message ?? 'Unknown error';
  const t = document.getElementById('toast');
  if (t) { t.textContent = msg; t.className = 'toast show err'; clearTimeout(t._tid); t._tid = setTimeout(() => t.classList.remove('show'), 5000); }
});

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function toast(msg, type = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className   = `toast show ${type}`;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 5000);
  if (!t._hoverBound) {
    t._hoverBound = true;
    t.addEventListener('mouseover', () => { clearTimeout(t._tid); t._tid = null; });
    t.addEventListener('mouseout',  () => { t._tid = setTimeout(() => t.classList.remove('show'), 5000); });
  }
}

function setBtn(id, text, disabled = false) {
  const el = $(id); if (!el) return;
  el.textContent = text; el.disabled = disabled;
}

// ─── Formatting ───────────────────────────────────────────────────────────────
const fmtN = n => n == null || isNaN(n) ? '0'
  : n >= 1e9 ? (n/1e9).toFixed(2)+'B'
  : n >= 1e6 ? (n/1e6).toFixed(2)+'M'
  : n >= 1e3 ? (n/1e3).toFixed(1)+'K'
  : n.toLocaleString('en-US', { maximumFractionDigits: 2 });

const fmtDate = ts => ts ? new Date(ts * 1000).toISOString().slice(0,10) : '—';

function fmtCountdown(endTs) {
  const diff = (endTs * 1000) - Date.now();
  if (diff <= 0) return 'ENDED';
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000)  / 60_000);
  if (d > 0) return `${d}D ${h}H ${m}M`;
  if (h > 0) return `${h}H ${m}M`;
  return `${m}M`;
}

function statusBadge(state) {
  const label = proposalStateLabel(state);
  const cls   = label === 'ACTIVE' ? 'badge-active'
              : label === 'PASSED' ? 'badge-passed'
              : label === 'FAILED' ? 'badge-failed'
              : 'badge-pending';
  return `<span class="badge ${cls}">[${label}]</span>`;
}

const shortKey = k => k ? k.slice(0,6)+'…'+k.slice(-4) : '—';

// ─── State ────────────────────────────────────────────────────────────────────
let _tab         = 'stake';
let _stakeInfo   = null;
let _realmReady  = false;
let _proposals   = [];
let _proposalMeta = {};
let _detailPk    = null;

// ─── Tab navigation ───────────────────────────────────────────────────────────
function switchTab(tab) {
  _tab = tab;
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-tab]').forEach(b => {
    b.classList.remove('active'); b.removeAttribute('aria-current');
  });
  const pane = $('tab-'+tab); if (pane) pane.classList.add('active');
  const btn  = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (btn) { btn.classList.add('active'); btn.setAttribute('aria-current','page'); }
  $('sidebar')?.classList.remove('open');
  $('sidebarBackdrop')?.classList.remove('open');
  if (tab === 'proposals') renderProposals();
  if (tab === 'activity' && isConnected()) renderActivity();
  if (tab === 'devtools') renderDevtools();
  if (tab === 'create') renderCreateStatus();
}
document.querySelectorAll('.nav-item[data-tab]').forEach(b =>
  b.addEventListener('click', () => switchTab(b.dataset.tab))
);
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
  const wallet  = getPublicKey();
  const status  = $('walletStatus');
  const btn     = $('walletBtn');
  const foot    = $('sidebarWallet');
  // Use runtime network for the dev app, build-time label for mainnet build
  const netLabel = IS_DEVNET
    ? (NET_LABELS[getDevNetwork()] ?? `SOLANA ${NETWORK_LABEL}`)
    : `SOLANA ${NETWORK_LABEL}`;
  const netColor = IS_DEVNET
    ? (NET_COLORS[getDevNetwork()] ?? 'var(--accent-ok)')
    : 'var(--accent-ok)';

  if (wallet) {
    status.textContent = shortKey(wallet.toBase58());
    status.className   = 'wallet-chip connected';
    btn.textContent    = '[ DISCONNECT ]';
    if (foot) foot.innerHTML = `
      <div class="net-status"><span class="dot-live" style="background:${netColor}" aria-hidden="true"></span>${netLabel}</div>
      <div class="wallet-addr">${esc(shortKey(wallet.toBase58()))}</div>`;
  } else {
    status.textContent = 'NOT CONNECTED';
    status.className   = 'wallet-chip';
    btn.textContent    = '[ CONNECT WALLET ]';
    if (foot) foot.innerHTML =
      `<div class="net-status"><span class="dot-live" style="background:${netColor}" aria-hidden="true"></span>${netLabel}</div>`;
  }
}

$('walletBtn')?.addEventListener('click', async () => {
  if (isConnected()) {
    await disconnect();
    _stakeInfo = null;
    updateWalletUI();
    renderStake();
    if (IS_DEVNET) renderAdmin();
    renderCreateStatus();
    if (_tab === 'devtools') renderDevtools();
    return;
  }
  $('walletModal').classList.add('open');
});
$('walletModalClose')?.addEventListener('click', () =>
  $('walletModal').classList.remove('open'),
);
document.querySelectorAll('.wallet-option').forEach(btn => {
  btn.addEventListener('click', async () => {
    $('walletModal').classList.remove('open');
    try {
      await connect(btn.dataset.wallet);
      updateWalletUI();
      if (IS_DEVNET) renderAdmin();
      renderCreateStatus();
      if (_tab === 'devtools') renderDevtools();
      await refreshUserData();
    } catch (e) { console.error('[walletConnect]', e); toast(e.message, 'err'); }
  });
});

async function refreshUserData() {
  const wallet = getPublicKey();
  if (!wallet || !_realmReady) return;
  _stakeInfo = await getStakeInfo(wallet);
  renderStake();
  renderCreateStatus();
}

// ════════════════════════════════════════════════════════════════════════════════
//  STAKE TAB
// ════════════════════════════════════════════════════════════════════════════════
function renderStake() {
  const el = $('stakeContent');
  if (!_realmReady) {
    el.innerHTML = `
      <div class="panel">
        <div class="mbar"><div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://STAKE</div></div><div class="mstatus">PENDING</div></div>
        <p class="prose" style="margin-top:8px">Realm not yet deployed. Go to <strong>Admin</strong> tab to set up the on-chain DAO.</p>
      </div>`;
    return;
  }
  if (!isConnected()) {
    el.innerHTML = `
      <div class="panel">
        <div class="mbar"><div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://STAKE</div></div><div class="mstatus">OFFLINE</div></div>
        <p class="prose" style="margin-top:8px">Connect your wallet to manage your stake.</p>
        <button class="btn btn-primary" id="stakeConnectBtn" style="margin-top:14px">[ CONNECT WALLET ]</button>
      </div>`;
    $('stakeConnectBtn')?.addEventListener('click', () => $('walletModal').classList.add('open'));
    return;
  }

  const staked      = _stakeInfo?.depositedAmount ?? 0;
  const votes       = _stakeInfo?.unrelinquishedVotes ?? 0;
  const outstanding = _stakeInfo?.outstandingVotes ?? 0;
  const locked      = votes > 0 || outstanding > 0;
  // SPL Governance locks ALL tokens when any proposal/vote is active.
  // There is no "partial lock" — you either can withdraw everything or nothing.
  const lockReason  = votes > 0
    ? `${votes} active vote${votes > 1 ? 's' : ''} — relinquish in Proposals tab first`
    : outstanding > 0
      ? `${outstanding} open proposal${outstanding > 1 ? 's' : ''} — finalize or cancel in Proposals tab first`
      : '';

  el.innerHTML = `
    <div class="stake-stats">
      <div class="metric-card featured">
        <div class="mc-label">STAKED ON-CHAIN</div>
        <div class="mc-val">${fmtN(staked)}</div>
        <div class="mc-sub">$BASIS IN VAULT</div>
      </div>
      <div class="metric-card">
        <div class="mc-label">ACTIVE VOTES</div>
        <div class="mc-val">${votes}</div>
        <div class="mc-sub">${votes > 0 ? 'LOCKED' : 'CLEAR'}</div>
      </div>
      <div class="metric-card">
        <div class="mc-label">OPEN PROPOSALS</div>
        <div class="mc-val">${outstanding}</div>
        <div class="mc-sub">${outstanding > 0 ? 'LOCKED' : 'CLEAR'}</div>
      </div>
    </div>

    ${locked ? `
    <div class="notice notice-warn" style="margin-top:14px">
      ⚠ <strong>${fmtN(staked)} $BASIS locked</strong> — ${lockReason}.
    </div>` : ''}

    <div class="panel" style="margin-top:20px">
      <div class="mbar">
        <div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://DEPOSIT</div></div>
        <div class="mstatus ${staked > 0 ? 'live' : ''}">VAULT</div>
      </div>
      <h2>> MANAGE STAKE</h2>
      <div class="inp-row" style="margin-top:14px">
        <input type="number" id="depositInput" class="tool-input" placeholder="Amount" min="1">
        <button class="btn" id="depositMinBtn" title="10,000,000 — minimum to create proposals">[ MIN ]</button>
        <button class="btn" id="depositMaxBtn" title="Fill wallet balance">[ MAX ]</button>
        <button class="btn btn-primary" id="depositBtn">[ DEPOSIT ]</button>
      </div>
      <div style="font-size:0.7rem;opacity:.5;margin-top:6px">Min to create proposals: 10,000,000 $BASIS</div>
      ${staked > 0 ? `
      <div style="margin-top:12px">
        ${locked
          ? `<button class="btn" id="withdrawBtn" disabled>[ WITHDRAW — LOCKED ]</button>`
          : `<button class="btn btn-primary" id="withdrawBtn">[ WITHDRAW ALL ]</button>`}
      </div>` : ''}
    </div>

    <div class="notice" style="margin-top:12px">
      <span class="notice-icon">◈</span> On-chain transactions — a small SOL fee applies. Withdrawing requires no active votes or open proposals.
    </div>`;

  $('depositBtn')?.addEventListener('click', handleDeposit);
  $('withdrawBtn')?.addEventListener('click', handleWithdraw);
  $('depositMinBtn')?.addEventListener('click', () => {
    const inp = $('depositInput'); if (inp) inp.value = '10000000';
  });
  $('depositMaxBtn')?.addEventListener('click', async () => {
    const mintAddr = IS_DEVNET ? getDevnetMint() : 'A5BJBQUTR5sTzkM89hRDuApWyvgjdXpR7B7rW1r9pump';
    if (!mintAddr) return;
    const bal = await getTestTokenBalance(mintAddr).catch(() => null);
    if (bal != null) { const inp = $('depositInput'); if (inp) inp.value = Math.floor(bal); }
  });
}

async function handleDeposit() {
  const amount = parseFloat($('depositInput').value);
  if (!amount || amount <= 0) return toast('Enter a valid amount', 'err');
  if (IS_DEVNET && getDevNetwork() === 'mainnet') {
    if (!confirm('⚠ MAINNET — This uses real SOL and real $BASIS. Continue?')) return;
  }
  setBtn('depositBtn', '[ CONFIRMING… ]', true);
  try {
    const sig = await depositTokens(amount);
    toast(`Deposited ${fmtN(amount)} $BASIS — tx: ${shortKey(sig)}`, 'ok');
    $('depositInput').value = '';
    _stakeInfo = await getStakeInfo(getPublicKey());
    renderStake();
  } catch (e) { console.error('[handleDeposit]', e); toast(e.message, 'err'); }
  finally { setBtn('depositBtn', '[ DEPOSIT ]', false); }
}

async function handleWithdraw() {
  if (!confirm('Withdraw all staked $BASIS from the vault?')) return;
  if (IS_DEVNET && getDevNetwork() === 'mainnet') {
    if (!confirm('⚠ MAINNET — This uses real SOL and real $BASIS. Continue?')) return;
  }
  setBtn('withdrawBtn', '[ CONFIRMING… ]', true);
  try {
    const sig = await withdrawTokens();
    toast(`Withdrawal confirmed — tx: ${shortKey(sig)}`, 'ok');
    _stakeInfo = await getStakeInfo(getPublicKey());
    renderStake();
  } catch (e) { console.error('[handleWithdraw]', e); toast(e.message, 'err'); }
  finally { setBtn('withdrawBtn', '[ WITHDRAW ALL ]', false); }
}

// ════════════════════════════════════════════════════════════════════════════════
//  PROPOSALS TAB
// ════════════════════════════════════════════════════════════════════════════════
function renderProposals() {
  const active = _proposals.filter(p => p.account.state === ProposalState.Voting);
  const past   = _proposals.filter(p => p.account.state !== ProposalState.Voting);

  $('activeProposals').innerHTML = active.length
    ? active.map(p => proposalCard(p)).join('')
    : '<div class="empty-state">No active proposals.</div>';

  $('pastProposals').innerHTML = past.length
    ? past.map(p => proposalCard(p)).join('')
    : '<div class="empty-state">No past proposals.</div>';

  document.querySelectorAll('.proposal-card').forEach(c => {
    const open = () => openDetail(c.dataset.id);
    c.addEventListener('click', open);
    c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(); });
  });
}

function proposalCard(p) {
  const state   = p.account.state;
  const yes     = p.account.getYesVoteCount().toNumber() / 1e6;
  const no      = p.account.getNoVoteCount().toNumber()  / 1e6;
  const total   = yes + no || 1;
  const yesPct  = ((yes / total) * 100).toFixed(1);
  const noPct   = ((no  / total) * 100).toFixed(1);
  const pk      = p.pubkey.toBase58();
  const meta    = _proposalMeta[pk] ?? {};
  const endTs   = p.account.votingCompletedAt?.toNumber()
               ?? (p.account.votingAt?.toNumber() ?? 0) + (p.account.maxVotingTime ?? getGovernanceData()?.account.config?.baseVotingTime ?? 604800);
  const isVoting = state === ProposalState.Voting;

  return `
    <article class="proposal-card" role="button" tabindex="0" data-id="${esc(pk)}">
      <div class="pc-head">
        <div class="pc-title">${esc(p.account.name)}</div>
        ${statusBadge(state)}
      </div>
      <p class="pc-desc">${esc((meta.description ?? '').slice(0, 120))}${(meta.description ?? '').length > 120 ? '…' : ''}</p>
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
        <span class="pc-by">BY ${esc(shortKey(meta.author ?? p.account.tokenOwnerRecord?.toBase58()))}</span>
        <span class="pc-time">${isVoting ? fmtCountdown(endTs) : fmtDate(p.account.votingAt?.toNumber())}</span>
      </div>
    </article>`;
}

// ════════════════════════════════════════════════════════════════════════════════
//  PROPOSAL DETAIL TAB
// ════════════════════════════════════════════════════════════════════════════════
async function openDetail(proposalPkStr) {
  _detailPk = proposalPkStr;
  switchTab('detail');
  $('detailContent').innerHTML = '<div class="loading-msg">LOADING…</div>';

  try {
    const conn     = getConnection();
    const proposal = await (await import('@solana/spl-governance'))
      .getProposal(conn, new PublicKey(proposalPkStr));
    const meta     = await getProposalMeta(proposalPkStr);
    const wallet   = getPublicKey();
    const myVote   = await (async () => {
      try { return wallet ? await getMyVoteRecord(proposalPkStr, wallet) : null; }
      catch { return null; }
    })();

    renderDetail(proposal, meta, myVote);
  } catch (e) {
    $('detailContent').innerHTML = `<div class="empty-state">Error: ${esc(e.message)}</div>`;
  }
}

function renderDetail(proposal, meta, myVote) {
  const pk      = proposal.pubkey.toBase58();
  const state   = proposal.account.state;
  const yes     = proposal.account.getYesVoteCount().toNumber() / 1e6;
  const no      = proposal.account.getNoVoteCount().toNumber()  / 1e6;
  const total   = yes + no || 1;
  const yesPct  = ((yes / total) * 100).toFixed(1);
  const noPct   = ((no  / total) * 100).toFixed(1);
  const maxTime = proposal.account.maxVotingTime
               ?? getGovernanceData()?.account.config?.baseVotingTime
               ?? 604800;
  const endTs   = proposal.account.votingCompletedAt?.toNumber()
               ?? (proposal.account.votingAt?.toNumber() ?? 0) + maxTime;
  const isVoting   = state === ProposalState.Voting;
  const isExpired  = isVoting && (endTs * 1000) < Date.now();
  const canVote    = isConnected() && isVoting && !isExpired && !myVote && (_stakeInfo?.depositedAmount ?? 0) > 0;
  const canFinal   = isExpired;
  const canRelinquish = myVote && !myVote.account.isRelinquished;
  const alreadyVoted  = !!myVote;
  const myChoice      = myVote?.account.vote?.voteType === 0 ? 'YES' : 'NO';

  $('detailContent').innerHTML = `
    <div class="detail-head">
      <button class="btn btn-sm" id="backBtn">[ ← PROPOSALS ]</button>
      ${statusBadge(state)}
    </div>

    <div class="panel" style="margin-top:16px">
      <div class="mbar">
        <div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://PROPOSAL</div></div>
        <div class="mstatus ${isVoting ? 'live' : ''}">${isVoting ? fmtCountdown(endTs) : proposalStateLabel(state)}</div>
      </div>

      <h2 style="font-size:1.1rem;margin-bottom:10px">> ${esc(proposal.account.name)}</h2>

      <div class="kv" style="margin-bottom:16px">
        <div class="kv-row"><span class="kv-k">PROPOSAL ID</span><span class="kv-v" style="font-size:0.68rem">${esc(pk)}</span></div>
        <div class="kv-row"><span class="kv-k">CREATED</span><span class="kv-v">${fmtDate(proposal.account.draftAt?.toNumber())}</span></div>
        <div class="kv-row"><span class="kv-k">${isVoting ? 'ENDS IN' : 'ENDED'}</span><span class="kv-v">${isVoting ? fmtCountdown(endTs) : fmtDate(endTs)}</span></div>
      </div>

      <div class="prose" style="white-space:pre-wrap;margin-bottom:20px">${esc(meta?.description ?? '(No description stored)')}</div>

      <div class="vote-section">
        <div class="vote-title">VOTE BREAKDOWN — ON-CHAIN</div>
        <div class="vote-bars">
          <div class="vb-row">
            <span class="vb-label yes-label">YES</span>
            <div class="vote-bar-track"><div class="vote-bar-fill yes" style="width:${yesPct}%"></div></div>
            <span class="vb-pct">${yesPct}%</span>
            <span class="vb-weight">${fmtN(yes)}</span>
          </div>
          <div class="vb-row">
            <span class="vb-label no-label">NO</span>
            <div class="vote-bar-track"><div class="vote-bar-fill no" style="width:${noPct}%"></div></div>
            <span class="vb-pct">${noPct}%</span>
            <span class="vb-weight">${fmtN(no)}</span>
          </div>
        </div>
      </div>

      ${alreadyVoted ? `<div class="notice notice-boost" style="margin-top:14px">✓ YOU VOTED ${myChoice} ON THIS PROPOSAL</div>` : ''}

      ${canVote ? `
      <div class="vote-actions">
        <div class="vote-actions-label">CAST YOUR VOTE (ON-CHAIN — REAL TRANSACTION)</div>
        <div class="btn-row">
          <button class="btn btn-vote-yes" id="voteYes">[ VOTE YES ]</button>
          <button class="btn btn-vote-no"  id="voteNo">[ VOTE NO ]</button>
        </div>
        <p class="prose" style="font-size:0.76rem;margin-top:8px">Signing this transaction casts your vote on-chain. Your staked $BASIS is locked until you relinquish the vote after the proposal closes.</p>
      </div>` : ''}

      ${canFinal ? `
      <div class="vote-actions" style="margin-top:16px">
        <button class="btn btn-primary" id="finalizeBtn">[ FINALIZE VOTE ]</button>
        <p class="prose" style="font-size:0.76rem;margin-top:8px">Voting period has ended. Anyone can finalize to determine the outcome.</p>
      </div>` : ''}

      ${canRelinquish ? `
      <div class="vote-actions" style="margin-top:16px">
        <button class="btn btn-primary" id="relinquishBtn">[ RELINQUISH VOTE ]</button>
        <p class="prose" style="font-size:0.76rem;margin-top:8px">${isVoting
          ? 'Relinquishing removes your vote and unlocks your tokens after the proposal closes.'
          : '⚠ This proposal has ended but your vote is still locked on-chain. Relinquishing will unlock your staked $BASIS.'}</p>
      </div>` : ''}

      ${isExpired && !canFinal ? '' : ''}
      ${isExpired ? `<div class="notice notice-warn" style="margin-top:14px">⚠ Voting period expired — finalize to close this proposal.</div>` : ''}
      ${!isConnected() && !isExpired ? `<div class="notice notice-warn" style="margin-top:14px">Connect wallet to vote.</div>` : ''}
      ${isConnected() && !canVote && !alreadyVoted && isVoting && !isExpired && (_stakeInfo?.depositedAmount ?? 0) === 0
        ? `<div class="notice notice-warn" style="margin-top:14px">Deposit $BASIS first to vote.</div>` : ''}
    </div>`;

  $('backBtn')?.addEventListener('click', () => switchTab('proposals'));
  $('voteYes')?.addEventListener('click', () => handleVote(pk, 'yes'));
  $('voteNo')?.addEventListener('click',  () => handleVote(pk, 'no'));
  $('finalizeBtn')?.addEventListener('click', () => handleFinalize(pk));
  $('relinquishBtn')?.addEventListener('click', () => handleRelinquish(pk));
}

async function handleVote(pk, choice) {
  if (IS_DEVNET && getDevNetwork() === 'mainnet') {
    if (!confirm('⚠ MAINNET — This uses real SOL and real $BASIS. Continue?')) return;
  }
  const id = choice === 'yes' ? 'voteYes' : 'voteNo';
  setBtn(id, '[ SIMULATING… ]', true);
  ['voteYes','voteNo'].forEach(x => { if ($(x)) $(x).disabled = true; });
  try {
    toast('Verifying vote on devnet… approve in Phantom if prompted.', 'info');
    const sig = await castVote(pk, choice);
    toast(`Vote cast on-chain — tx: ${shortKey(sig)}`, 'ok');
    _stakeInfo = await getStakeInfo(getPublicKey());
    await openDetail(pk);
  } catch (e) {
    console.error('[handleVote]', e);
    toast(e.message, 'err');
    setBtn(id, choice === 'yes' ? '[ VOTE YES ]' : '[ VOTE NO ]', false);
    ['voteYes','voteNo'].forEach(x => { if ($(x)) $(x).disabled = false; });
  }
}

async function handleFinalize(pk) {
  setBtn('finalizeBtn', '[ FINALIZING… ]', true);
  try {
    const sig = await finalizeVote(pk);
    toast(`Proposal finalized — tx: ${shortKey(sig)}`, 'ok');
    await refreshProposals();
    await openDetail(pk);
  } catch (e) { console.error('[handleFinalize]', e); toast(e.message, 'err'); setBtn('finalizeBtn', '[ FINALIZE VOTE ]', false); }
}

async function handleRelinquish(pk) {
  setBtn('relinquishBtn', '[ CONFIRMING… ]', true);
  try {
    const sig = await relinquishVote(pk);
    toast(`Vote relinquished — tx: ${shortKey(sig)}`, 'ok');
    _stakeInfo = await getStakeInfo(getPublicKey());
    await openDetail(pk);
  } catch (e) { console.error('[handleRelinquish]', e); toast(e.message, 'err'); setBtn('relinquishBtn', '[ RELINQUISH VOTE ]', false); }
}

// Auto-relinquish votes on finished proposals so users never get permanently locked.
// Runs silently after every proposal refresh when a wallet is connected.
async function autoRelinquishStaleVotes() {
  const wallet = getPublicKey();
  if (!wallet || !_proposals.length) return;

  // Only check proposals that are no longer in Voting state
  const finished = _proposals.filter(p => p.account.state !== ProposalState.Voting);
  if (!finished.length) return;

  const toRelinquish = [];
  await Promise.allSettled(finished.map(async p => {
    try {
      const vr = await getMyVoteRecord(p.pubkey.toBase58(), wallet);
      if (vr && !vr.account.isRelinquished) toRelinquish.push(p.pubkey.toBase58());
    } catch { /* skip — vote record may not exist */ }
  }));

  if (!toRelinquish.length) return;

  let relinquished = 0;
  for (const pk of toRelinquish) {
    try {
      await relinquishVote(pk);
      relinquished++;
    } catch (e) {
      console.warn('[autoRelinquish] failed for', pk, e.message);
    }
  }

  if (relinquished > 0) {
    toast(`Auto-relinquished ${relinquished} stale vote${relinquished > 1 ? 's' : ''} — stake unlocked`, 'ok');
    _stakeInfo = await getStakeInfo(wallet);
    renderStake();
    renderCreateStatus();
  }
}

// ════════════════════════════════════════════════════════════════════════════════
//  CREATE PROPOSAL TAB
// ════════════════════════════════════════════════════════════════════════════════
function renderCreateStatus() {
  const el = $('createStakeStatus');
  if (!el) return;
  if (!isConnected()) {
    el.innerHTML = `<div class="notice notice-warn">Connect your wallet to create proposals. <button class="btn btn-sm" id="createConnectBtn" style="margin-left:8px">[ CONNECT ]</button></div>`;
    $('createConnectBtn')?.addEventListener('click', () => $('walletModal').classList.add('open'));
    return;
  }
  const staked = _stakeInfo?.depositedAmount ?? 0;
  const need   = 10_000_000;
  if (staked >= need) {
    el.innerHTML = `<div class="notice notice-boost">✓ ${fmtN(staked)} $BASIS staked — eligible to create proposals.</div>`;
  } else {
    el.innerHTML = `
      <div class="notice notice-warn">
        ⚠ You need <strong>${fmtN(need)} staked $BASIS</strong> to create a proposal.
        You currently have <strong>${fmtN(staked)}</strong>.
        <button class="btn btn-sm btn-primary" id="goStakeBtn" style="margin-left:8px">[ GO TO STAKE → ]</button>
      </div>`;
    $('goStakeBtn')?.addEventListener('click', () => switchTab('stake'));
  }
}

$('submitProposalBtn')?.addEventListener('click', async () => {
  const title = $('propTitle')?.value?.trim();
  const desc  = $('propDesc')?.value?.trim();
  if (!title)        return toast('Title is required', 'err');
  if (!desc)         return toast('Description is required', 'err');
  if (!isConnected()) return toast('Connect wallet first', 'err');
  if (!_realmReady)  return toast('Realm not initialised', 'err');

  const staked = _stakeInfo?.depositedAmount ?? 0;
  if (staked < 10_000_000) {
    toast('Not enough staked $BASIS — go to the STAKE tab to deposit first.', 'err');
    switchTab('stake');
    return;
  }

  setBtn('submitProposalBtn', '[ SUBMITTING… ]', true);
  try {
    const wallet     = getPublicKey();
    // On-chain description_link stores the first 200 chars of the description
    // so Realms.today can display it. Full description is saved to Firebase/localStorage.
    const descSnippet = desc.slice(0, 200);
    const proposalPk = await createProposal(title, descSnippet);
    await saveProposalMeta(proposalPk, {
      description: desc,
      author:      wallet.toBase58(),
      createdAt:   Date.now(),
    });
    toast('Proposal created on-chain!', 'ok');
    $('propTitle').value = '';
    $('propDesc').value  = '';
    await refreshProposals();
    switchTab('proposals');
    setTimeout(() => openDetail(proposalPk), 400);
  } catch (e) {
    console.error('[submitProposal] failed:', e);
    toast(e.message, 'err');
  }
  finally { setBtn('submitProposalBtn', '[ CREATE PROPOSAL ]', false); }
});

// ════════════════════════════════════════════════════════════════════════════════
//  ACTIVITY TAB
// ════════════════════════════════════════════════════════════════════════════════
async function renderActivity() {
  const wallet = getPublicKey();
  if (!wallet) { $('activityContent').innerHTML = '<div class="empty-state">Connect wallet to view activity.</div>'; return; }
  $('activityContent').innerHTML = '<div class="loading-msg">LOADING…</div>';
  try {
    const info = await getStakeInfo(wallet);
    $('activityContent').innerHTML = `
      <div class="panel">
        <div class="mbar"><div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://MY-STAKE</div></div><div class="mstatus">${info?.depositedAmount > 0 ? 'ACTIVE' : 'NONE'}</div></div>
        <h2>> MY ON-CHAIN STAKE</h2>
        <div class="kv">
          <div class="kv-row"><span class="kv-k">WALLET</span><span class="kv-v" style="font-size:0.68rem">${esc(wallet.toBase58())}</span></div>
          <div class="kv-row"><span class="kv-k">STAKED (VAULT)</span><span class="kv-v">${fmtN(info?.depositedAmount ?? 0)} $BASIS</span></div>
          <div class="kv-row"><span class="kv-k">ACTIVE VOTES</span><span class="kv-v">${info?.unrelinquishedVotes ?? 0}</span></div>
          <div class="kv-row"><span class="kv-k">TOKEN OWNER RECORD</span><span class="kv-v" style="font-size:0.68rem">${info?.pubkey ? esc(info.pubkey.toBase58()) : '—'}</span></div>
        </div>
        ${info?.pubkey ? `
        <div style="margin-top:14px">
          <a href="https://app.realms.today" target="_blank" rel="noopener noreferrer" class="btn btn-sm">[ VIEW ON REALMS ]</a>
        </div>` : ''}
      </div>`;
  } catch (e) {
    $('activityContent').innerHTML = `<div class="empty-state">Error: ${esc(e.message)}</div>`;
  }
}

// ════════════════════════════════════════════════════════════════════════════════
//  ADMIN TAB (Realm setup)
// ════════════════════════════════════════════════════════════════════════════════
function renderAdmin() {
  const el = $('adminContent');
  if (!el) return;

  if (_realmReady) {
    const govData    = getGovernanceData();
    const curSecs    = govData?.account.config.baseVotingTime ?? 0;
    const curPct     = govData?.account.config.communityVoteThreshold?.value ?? 1;
    const curLabel   = curSecs >= 604800 ? '7 DAYS'
                     : curSecs >= 259200 ? '3 DAYS'
                     : curSecs >= 86400  ? `${(curSecs/86400).toFixed(0)} DAYS`
                     : curSecs >= 3600   ? `${(curSecs/3600).toFixed(0)} HOURS`
                     : `${curSecs}S`;

    el.innerHTML = `
      <!-- ── Realm info ──────────────────────────────────────────────────── -->
      <div class="panel">
        <div class="mbar"><div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://REALM</div></div><div class="mstatus live">LIVE</div></div>
        <h2>> REALM DEPLOYED</h2>
        <div class="kv">
          <div class="kv-row"><span class="kv-k">REALM</span><span class="kv-v" style="font-size:0.68rem">${esc(getRealmPk()?.toBase58())}</span></div>
          <div class="kv-row"><span class="kv-k">GOVERNANCE</span><span class="kv-v" style="font-size:0.68rem">${esc(getGovernancePk()?.toBase58())}</span></div>
          <div class="kv-row"><span class="kv-k">PROGRAM</span><span class="kv-v" style="font-size:0.68rem">GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw</span></div>
        </div>
        <div style="margin-top:14px">
          <a href="https://app.realms.today/dao/${esc(getRealmPk()?.toBase58())}" target="_blank" rel="noopener noreferrer" class="btn">[ VIEW ON REALMS ]</a>
        </div>
      </div>

      <!-- ── Governance settings ───────────────────────────────────────────── -->
      <div class="panel" style="margin-top:16px">
        <div class="mbar"><div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://GOVERNANCE</div></div><div class="mstatus live">SETTINGS</div></div>
        <h2>> GOVERNANCE SETTINGS</h2>
        <div class="kv" style="margin:12px 0 16px">
          <div class="kv-row"><span class="kv-k">VOTING DURATION</span><span class="kv-v" style="color:var(--accent-ok);font-weight:600">${curLabel}</span></div>
          <div class="kv-row"><span class="kv-k">PASS THRESHOLD</span><span class="kv-v" style="color:var(--accent-ok);font-weight:600">${curPct}% YES</span></div>
          <div class="kv-row"><span class="kv-k">MIN TOKENS TO PROPOSE</span><span class="kv-v">10,000,000 $BASIS</span></div>
        </div>
        <label class="form-label">VOTING DURATION</label>
        <div class="duration-grid" style="margin-top:8px">
          ${IS_DEVNET ? `
            <button class="duration-btn" data-secs="10"    type="button">10S</button>
            <button class="duration-btn" data-secs="60"    type="button">60S</button>
            <button class="duration-btn" data-secs="3600"  type="button">1H</button>
          ` : ''}
          <button class="duration-btn ${curSecs===259200?'active':''}" data-secs="259200" type="button">3 DAYS</button>
          <button class="duration-btn ${curSecs===604800?'active':''}" data-secs="604800" type="button">7 DAYS</button>
        </div>
        <label class="form-label" style="margin-top:14px">PASS THRESHOLD</label>
        <div class="duration-grid" style="margin-top:8px">
          <button class="threshold-btn ${curPct===1?'active':''}"  data-pct="1"  type="button">1%</button>
          <button class="threshold-btn ${curPct===5?'active':''}"  data-pct="5"  type="button">5%</button>
          <button class="threshold-btn ${curPct===10?'active':''}" data-pct="10" type="button">10%</button>
        </div>
        <p class="prose" style="font-size:0.76rem;margin-top:8px;opacity:.7">
          SPL Governance does not support in-place config edits. Each unique combination of
          duration + threshold creates a fresh governance account on-chain — one transaction,
          small SOL rent fee. Existing proposals are unaffected.
        </p>
        <button class="btn btn-primary" id="applyGovDurationBtn" style="margin-top:12px"
          ${!isConnected() ? 'disabled' : ''}>[ APPLY SETTINGS ]</button>
        ${!isConnected() ? '<p class="prose" style="margin-top:8px;font-size:0.76rem">Connect wallet first.</p>' : ''}
      </div>`;

    let govDurationSecs = curSecs || 604800;
    let govThresholdPct = curPct || 1;

    el.querySelectorAll('.duration-btn').forEach(b => {
      b.addEventListener('click', () => {
        el.querySelectorAll('.duration-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        govDurationSecs = parseInt(b.dataset.secs, 10);
      });
    });

    el.querySelectorAll('.threshold-btn').forEach(b => {
      b.addEventListener('click', () => {
        el.querySelectorAll('.threshold-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        govThresholdPct = parseInt(b.dataset.pct, 10);
      });
    });

    $('applyGovDurationBtn')?.addEventListener('click', async () => {
      const dLabel = govDurationSecs >= 86400 ? `${(govDurationSecs/86400).toFixed(0)} days`
                   : govDurationSecs >= 3600  ? `${(govDurationSecs/3600).toFixed(0)} hours`
                   : `${govDurationSecs}s`;
      if (!confirm(`Apply: ${dLabel} voting / ${govThresholdPct}% pass threshold?\nThis creates a new governance account on-chain.`)) return;
      setBtn('applyGovDurationBtn', '[ APPLYING… ]', true);
      try {
        const newGovPk = await updateGovernanceDuration(govDurationSecs, govThresholdPct);
        toast(`Governance updated — ${dLabel} / ${govThresholdPct}% | ${shortKey(newGovPk)}`, 'ok');
        renderAdmin();
        renderCreateStatus();
      } catch (e) {
        console.error('[applyGovDuration]', e);
        toast(e.message, 'err');
        setBtn('applyGovDurationBtn', '[ APPLY SETTINGS ]', false);
      }
    });
    return;
  }

  // ── Realm not yet deployed ──────────────────────────────────────────────────
  if (!IS_DEVNET) {
    el.innerHTML = `
      <div class="panel">
        <div class="mbar"><div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://REALM</div></div><div class="mstatus">PENDING</div></div>
        <h2>> REALM NOT LOADED</h2>
        <p class="prose" style="margin-top:8px">The realm is deployed on mainnet but has not loaded yet. Try refreshing the page.</p>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="panel">
      <div class="mbar"><div class="mbar-l"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="mlabel">BASIS://SETUP</div></div><div class="mstatus">PENDING</div></div>
      <h2>> DEPLOY REALM</h2>
      <p class="prose">This creates the BASIS DAO Realm on Solana ${IS_DEVNET ? getDevNetwork().toUpperCase() : 'MAINNET'} using the SPL Governance program. This is a one-time admin action. You must hold $BASIS in your wallet.</p>
      <div class="notice notice-warn" style="margin:14px 0">⚠ This sends multiple transactions and costs SOL for rent. Only run once. Ensure your wallet is the intended admin.</div>
      <div class="form-group" style="margin-top:14px">
        <label class="form-label">VOTING DURATION (applies to all proposals)</label>
        <div class="duration-grid">
          ${IS_DEVNET ? `
            <button class="duration-btn" data-secs="10"    type="button">10S</button>
            <button class="duration-btn" data-secs="60"    type="button">60S</button>
            <button class="duration-btn" data-secs="3600"  type="button">1H</button>
            <button class="duration-btn" data-secs="21600" type="button">6H</button>
          ` : ''}
          <button class="duration-btn" data-secs="86400"   type="button">24H</button>
          <button class="duration-btn" data-secs="259200"  type="button">72H</button>
          <button class="duration-btn active" data-secs="604800" type="button">7D</button>
        </div>
        ${IS_DEVNET ? '<p class="prose" style="margin-top:6px;font-size:0.76rem">Tip: use <strong>10S</strong> or <strong>60S</strong> on devnet — proposals expire fast so you can vote → finalize the full cycle in seconds.</p>' : ''}
      </div>
      <button class="btn btn-primary" id="createRealmBtn" style="margin-top:6px" ${!isConnected() ? 'disabled' : ''}>[ CREATE REALM ON-CHAIN ]</button>
      ${!isConnected() ? '<p class="prose" style="margin-top:8px;font-size:0.76rem">Connect wallet first.</p>' : ''}
    </div>`;

  let setupDurationSecs = 604800;
  el.querySelectorAll('.duration-btn').forEach(b => {
    b.addEventListener('click', () => {
      el.querySelectorAll('.duration-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      setupDurationSecs = parseInt(b.dataset.secs, 10);
    });
  });

  $('createRealmBtn')?.addEventListener('click', async () => {
    if (!confirm(`Deploy BASIS DAO Realm on Solana ${IS_DEVNET ? getDevNetwork().toUpperCase() : 'MAINNET'}? This costs SOL and is irreversible.`)) return;
    setBtn('createRealmBtn', '[ DEPLOYING… ]', true);
    try {
      const result = await setupRealm(setupDurationSecs);
      toast(`Realm deployed! ${shortKey(result.realmPk)}`, 'ok');
      _realmReady = true;
      renderAdmin();
      renderStake();
      renderCreateStatus();
      await refreshProposals();
      if (isConnected()) refreshUserData();
    } catch (e) { console.error('[createRealm]', e); toast(e.message, 'err'); setBtn('createRealmBtn', '[ CREATE REALM ON-CHAIN ]', false); }
  });
}

// ════════════════════════════════════════════════════════════════════════════════
//  DEV TOOLS TAB (devnet only)
// ════════════════════════════════════════════════════════════════════════════════
async function renderDevtools() {
  const el = $('devtoolsContent');
  if (!el) return;

  const wallet   = getPublicKey();
  const mint     = getDevnetMint();
  const walletStr = wallet?.toBase58() ?? null;

  // Show skeleton immediately so tab feels instant, then fetch balances
  el.innerHTML = '<div class="loading-msg" style="padding:20px">LOADING BALANCES…</div>';

  const [solBal, basisBal] = wallet
    ? await Promise.all([
        getSolBalance().catch(() => null),
        mint ? getTestTokenBalance(mint).catch(() => null) : Promise.resolve(null),
      ])
    : [null, null];

  const fmtSol   = v => v == null ? '—' : v.toFixed(4) + ' SOL';
  const fmtBasis  = v => v == null ? '—' : fmtN(v) + ' $BASIS';
  const shortAddr = a => a ? a.slice(0,6) + '…' + a.slice(-4) : '—';
  const activeNet = getDevNetwork();
  const activeRpc = DEV_NETWORK_RPCS[activeNet] ?? '—';

  const netColor = { devnet: 'var(--accent-warn)', testnet: '#a78bfa', mainnet: 'var(--accent-ok)' };
  const netLabel = { devnet: '⬡ DEVNET', testnet: '⬡ TESTNET', mainnet: '◈ MAINNET' };

  // Step completion flags
  const hasSol   = solBal != null && solBal > 0.05;
  const hasToken = !!mint;
  const hasRealm = _realmReady;

  const step = s => `<span style="color:var(--accent-warn);font-weight:600">[${s}]</span>`;
  const ok   = `<span style="color:var(--accent-ok)">[✓]</span>`;

  el.innerHTML = `
    <!-- ── Environment ─────────────────────────────────────────────────────── -->
    <div class="panel" style="margin-bottom:12px">
      <div class="mbar">
        <div class="mbar-l">
          <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
          <div class="mlabel">BASIS://DEV-CONSOLE</div>
        </div>
        <div class="mstatus" style="color:${netColor[activeNet]}">${netLabel[activeNet]}</div>
      </div>
      ${activeNet === 'mainnet'
        ? `<div class="notice notice-warn" style="margin:10px 0 14px">⚠ <strong>MAINNET</strong> — real SOL and real $BASIS. Transactions are irreversible.</div>`
        : `<div class="notice notice-warn" style="margin:10px 0 14px">⚠ ${activeNet.toUpperCase()} — test tokens only, no real value.</div>`}
      <div class="kv">
        <div class="kv-row"><span class="kv-k">NETWORK</span>    <span class="kv-v" style="color:${netColor[activeNet]}">${activeNet.toUpperCase()}</span></div>
        <div class="kv-row"><span class="kv-k">RPC</span>         <span class="kv-v" style="font-size:0.68rem">${esc(activeRpc)}</span></div>
        <div class="kv-row"><span class="kv-k">FIRESTORE</span>  <span class="kv-v" style="font-size:0.68rem">${activeNet === 'mainnet' ? 'gov / proposals-meta' : `gov-${activeNet} / proposals-meta-${activeNet}`}</span></div>
        <div class="kv-row"><span class="kv-k">GOV PROGRAM</span><span class="kv-v" style="font-size:0.68rem">GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw</span></div>
      </div>
      <p class="prose" style="font-size:0.72rem;margin-top:10px;opacity:.7">Use the network selector in the top bar to switch between DEVNET, TESTNET, and MAINNET.</p>
    </div>

    <!-- ── Wallet ─────────────────────────────────────────────────────────── -->
    <div class="panel" style="margin-bottom:12px">
      <div class="mbar">
        <div class="mbar-l">
          <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
          <div class="mlabel">BASIS://WALLET</div>
        </div>
        <div class="mstatus ${wallet ? 'live' : ''}">${wallet ? 'CONNECTED' : 'DISCONNECTED'}</div>
      </div>

      ${!wallet ? `
        <p class="prose" style="margin-top:10px">Connect your wallet (set to <strong>${activeNet.charAt(0).toUpperCase() + activeNet.slice(1)}</strong> in wallet settings) to begin.</p>
        <button class="btn btn-primary" id="dtConnectBtn" style="margin-top:10px">[ CONNECT WALLET ]</button>
      ` : `
        <div class="kv" style="margin-top:10px">
          <div class="kv-row">
            <span class="kv-k">ADDRESS</span>
            <span class="kv-v">
              <span style="font-size:0.72rem;letter-spacing:0.02em">${esc(walletStr)}</span>
            </span>
          </div>
          <div class="kv-row"><span class="kv-k">SOL BALANCE</span><span class="kv-v ${hasSol ? '' : 'text-warn'}">${fmtSol(solBal)}</span></div>
          ${mint ? `<div class="kv-row"><span class="kv-k">$BASIS BALANCE</span><span class="kv-v">${fmtBasis(basisBal)}</span></div>` : ''}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <a href="https://faucet.solana.com/?address=${esc(walletStr)}&amount=2&network=devnet"
             target="_blank" rel="noopener noreferrer" class="btn btn-primary">[ OPEN SOLANA FAUCET ↗ ]</a>
          <button class="btn" id="airdropBtn" type="button">[ TRY RPC AIRDROP ]</button>
          <button class="btn" id="refreshBalBtn" type="button">[ REFRESH ]</button>
        </div>
      `}
    </div>

    <!-- ── Token ──────────────────────────────────────────────────────────── -->
    <div class="panel" style="margin-bottom:12px">
      <div class="mbar">
        <div class="mbar-l">
          <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
          <div class="mlabel">BASIS://$BASIS-TOKEN</div>
        </div>
        <div class="mstatus ${hasToken ? 'live' : ''}">${hasToken ? 'DEPLOYED' : 'NOT CREATED'}</div>
      </div>

      ${!wallet ? `<p class="prose" style="margin-top:10px;opacity:.6">Connect wallet first.</p>` : !hasToken ? `
        <div class="kv" style="margin-top:10px">
          <div class="kv-row"><span class="kv-k">NAME</span>    <span class="kv-v">${esc(TEST_TOKEN_NAME)}</span></div>
          <div class="kv-row"><span class="kv-k">SYMBOL</span>  <span class="kv-v">$${esc(TEST_TOKEN_SYMBOL)}</span></div>
          <div class="kv-row"><span class="kv-k">DECIMALS</span><span class="kv-v">${TEST_TOKEN_DECIMALS}</span></div>
          <div class="kv-row"><span class="kv-k">SUPPLY</span>  <span class="kv-v">${fmtN(TEST_TOKEN_SUPPLY)} (minted to wallet)</span></div>
          <div class="kv-row"><span class="kv-k">METADATA</span><span class="kv-v">Metaplex Token Metadata Program</span></div>
        </div>
        <button class="btn btn-primary" id="createTokenBtn" style="margin-top:14px" ${!hasSol ? 'disabled title="Need SOL first"' : ''}>
          [ DEPLOY TEST $BASIS TOKEN ]
        </button>
        ${!hasSol ? '<p class="prose" style="margin-top:8px;font-size:0.72rem;opacity:.7">↑ Fund wallet with devnet SOL first.</p>' : ''}
      ` : `
        <div class="kv" style="margin-top:10px">
          <div class="kv-row"><span class="kv-k">NAME</span>    <span class="kv-v">${esc(TEST_TOKEN_NAME)}</span></div>
          <div class="kv-row"><span class="kv-k">SYMBOL</span>  <span class="kv-v">$${esc(TEST_TOKEN_SYMBOL)}</span></div>
          <div class="kv-row"><span class="kv-k">DECIMALS</span><span class="kv-v">${TEST_TOKEN_DECIMALS}</span></div>
          <div class="kv-row"><span class="kv-k">MINT</span>    <span class="kv-v" style="font-size:0.68rem">${esc(mint)}</span></div>
          <div class="kv-row"><span class="kv-k">WALLET BAL</span><span class="kv-v">${fmtBasis(basisBal)}</span></div>
          <div class="kv-row">
            <span class="kv-k">EXPLORER</span>
            <span class="kv-v">
              <a href="https://explorer.solana.com/address/${esc(mint)}${activeNet === 'mainnet' ? '' : `?cluster=${activeNet}`}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">view ↗</a>
            </span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center">
          <input type="number" id="mintMoreAmt" class="tool-input" style="width:150px"
                 placeholder="Amount" min="1" value="1000000">
          <button class="btn" id="mintMoreBtn" type="button">[ MINT MORE ]</button>
        </div>
        <button class="btn" id="resetMintBtn" style="margin-top:10px;opacity:0.5;font-size:0.72rem" type="button">
          [ RESET — DESTROY LOCAL REFERENCE ]
        </button>
      `}
    </div>

    <!-- ── Token Burner ──────────────────────────────────────────────────── -->
    <div class="panel" style="margin-bottom:12px">
      <div class="mbar">
        <div class="mbar-l">
          <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
          <div class="mlabel">BASIS://TOKEN-BURNER</div>
        </div>
        <div class="mstatus" style="color:var(--accent-warn)">IRREVERSIBLE</div>
      </div>
      <div class="notice notice-warn" style="margin:10px 0 14px">
        ⚠ Burns any SPL token from your wallet. Closing the account recovers ~0.002 SOL rent. All burns are permanent.
      </div>

      <div class="form-group" style="margin-bottom:10px">
        <label class="form-label">MINT ADDRESS</label>
        <input type="text" id="burnMintInput" class="tool-input"
               placeholder="Enter any SPL token mint address"
               value="${esc(mint ?? '')}"
               spellcheck="false" autocomplete="off">
      </div>

      <div id="burnAccountInfo" style="margin-bottom:10px"></div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <input type="number" id="burnAmt" class="tool-input" style="width:160px"
               placeholder="Amount" min="0" step="any">
        <button class="btn" id="burnLookupBtn" type="button">[ LOOKUP ]</button>
        <button class="btn" id="burnBtn" type="button" style="border-color:var(--accent-warn);color:var(--accent-warn)">
          [ BURN ]
        </button>
        <button class="btn" id="burnAllBtn" type="button" style="border-color:var(--accent-warn);color:var(--accent-warn)">
          [ BURN ALL ]
        </button>
        <button class="btn" id="burnAndCloseBtn" type="button" style="border-color:var(--accent-err,#ff4444);color:var(--accent-err,#ff4444)">
          [ BURN ALL + CLOSE ACCOUNT ]
        </button>
      </div>
    </div>

    <!-- ── Next Steps ─────────────────────────────────────────────────────── -->
    <div class="panel">
      <div class="mbar">
        <div class="mbar-l">
          <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
          <div class="mlabel">BASIS://SETUP-CHECKLIST</div>
        </div>
        <div class="mstatus">${hasRealm ? 'COMPLETE' : 'IN PROGRESS'}</div>
      </div>
      <div class="kv" style="margin-top:10px">
        <div class="kv-row">
          <span class="kv-k">${hasSol ? ok : step('1')}</span>
          <span class="kv-v">Fund wallet with devnet SOL</span>
        </div>
        <div class="kv-row">
          <span class="kv-k">${hasToken ? ok : step('2')}</span>
          <span class="kv-v">Deploy test $BASIS token on devnet</span>
        </div>
        <div class="kv-row">
          <span class="kv-k">${hasRealm ? ok : step('3')}</span>
          <span class="kv-v">Deploy BASIS DAO realm (Admin tab)</span>
        </div>
        <div class="kv-row">
          <span class="kv-k">${step('4')}</span>
          <span class="kv-v">Stake $BASIS → create proposal → vote</span>
        </div>
      </div>
      ${hasToken && !hasRealm ? `
        <button class="btn btn-primary" data-tab="admin" style="margin-top:14px">[ GO TO ADMIN → DEPLOY REALM ]</button>
      ` : ''}
    </div>

    <!-- ── Proposal Tools ───────────────────────────────────────────────── -->
    ${hasRealm && wallet ? `
    <div class="panel" style="margin-bottom:12px">
      <div class="mbar">
        <div class="mbar-l">
          <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
          <div class="mlabel">BASIS://PROPOSAL-TOOLS</div>
        </div>
        <div class="mstatus" style="color:var(--accent-warn)">DEV ONLY</div>
      </div>
      <p class="prose" style="margin-top:10px;margin-bottom:12px">
        Use these tools to manage proposals mid-test without waiting for voting periods to expire.
      </p>
      <div class="kv" style="margin-bottom:12px">
        <div class="kv-row"><span class="kv-k">OPEN PROPOSALS</span><span class="kv-v">${_stakeInfo?.outstandingVotes ?? '—'}</span></div>
        <div class="kv-row"><span class="kv-k">UNRELINQUISHED VOTES</span><span class="kv-v">${_stakeInfo?.unrelinquishedVotes ?? '—'}</span></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="cancelAllProposalsBtn" type="button"
                style="border-color:var(--accent-warn);color:var(--accent-warn)">
          [ CANCEL ALL OPEN PROPOSALS ]
        </button>
      </div>
      <p class="prose" style="font-size:0.72rem;margin-top:10px;opacity:.7">
        Cancels every proposal in <strong>Voting</strong> state that you own — moves them to <strong>Cancelled</strong>, zeroes your outstanding proposal count, and unblocks token withdrawal. To properly test pass/fail outcomes, redeploy the realm with <strong>10S</strong> or <strong>60S</strong> voting duration in the Admin tab.
      </p>
    </div>
    ` : ''}

    <!-- ── Danger Zone ───────────────────────────────────────────────────── -->
    <div class="panel" style="margin-bottom:12px;border-color:var(--accent-err,#ff4444)22">
      <div class="mbar">
        <div class="mbar-l">
          <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
          <div class="mlabel">BASIS://DANGER-ZONE</div>
        </div>
        <div class="mstatus" style="color:var(--accent-err,#ff4444)">DESTRUCTIVE</div>
      </div>
      <div class="notice notice-warn" style="margin:10px 0 14px">
        ⚠ These actions clear local state and Firebase config. On-chain accounts on devnet are abandoned (cannot be deleted). To deploy a fresh realm, you must use a new realm name.
      </div>

      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">NEW REALM NAME <span style="color:var(--accent-warn);font-size:0.7rem">(change this before resetting)</span></label>
        <input type="text" id="newRealmNameInput" class="tool-input"
               placeholder="e.g. BASIS DAO DEV 2"
               value=""
               maxlength="32" spellcheck="false" autocomplete="off">
        <div style="font-size:0.68rem;opacity:.6;margin-top:4px">Current: <strong>${esc(getDevnetRealmName())}</strong> — type a new name above</div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="resetRealmOnlyBtn" type="button" style="border-color:var(--accent-warn);color:var(--accent-warn)">
          [ RESET REALM ONLY ]
        </button>
        <button class="btn" id="fullResetBtn" type="button" style="border-color:var(--accent-err,#ff4444);color:var(--accent-err,#ff4444)">
          [ FULL RESET — TOKEN + REALM ]
        </button>
      </div>
    </div>`;

  // ── Event bindings ─────────────────────────────────────────────────────────
  $('dtConnectBtn')?.addEventListener('click', () => $('walletModal').classList.add('open'));

  $('airdropBtn')?.addEventListener('click', async () => {
    setBtn('airdropBtn', '[ AIRDROPPING… ]', true);
    try {
      await airdropSol(2);
      toast('2 SOL airdropped! Refreshing…', 'ok');
      renderDevtools();
    } catch (e) { console.error('[airdrop]', e); toast(e.message, 'err'); setBtn('airdropBtn', '[ TRY RPC AIRDROP ]', false); }
  });

  $('refreshBalBtn')?.addEventListener('click', () => renderDevtools().catch(e => toast(e.message, 'err')));

  $('createTokenBtn')?.addEventListener('click', async () => {
    setBtn('createTokenBtn', '[ DEPLOYING TOKEN… ]', true);
    try {
      const result = await launchTestToken();
      const msg = result.metaSig
        ? `$${result.symbol} deployed with metadata on-chain.`
        : `$${result.symbol} deployed (metadata skipped — need more SOL for rent).`;
      toast(msg, 'ok');
      location.reload();
    } catch (e) { console.error('[createToken]', e); toast(e.message, 'err'); setBtn('createTokenBtn', '[ DEPLOY TEST $BASIS TOKEN ]', false); }
  });

  $('mintMoreBtn')?.addEventListener('click', async () => {
    const amt = parseFloat($('mintMoreAmt')?.value ?? '0');
    if (!amt || amt <= 0) { toast('Enter a valid amount', 'err'); return; }
    setBtn('mintMoreBtn', '[ MINTING… ]', true);
    try {
      await mintMoreTokens(mint, amt);
      toast(`Minted ${fmtN(amt)} $${TEST_TOKEN_SYMBOL}`, 'ok');
      renderDevtools();
    } catch (e) { console.error('[mintMore]', e); toast(e.message, 'err'); setBtn('mintMoreBtn', '[ MINT MORE ]', false); }
  });

  $('resetMintBtn')?.addEventListener('click', () => {
    if (!confirm('Remove local token reference? This only clears the saved address — the on-chain token still exists.')) return;
    clearDevnetMint();
    location.reload();
  });

  // ── Token Burner ───────────────────────────────────────────────────────────
  const getBurnMint = () => $('burnMintInput')?.value?.trim();

  const showBurnInfo = async () => {
    const m = getBurnMint();
    const infoEl = $('burnAccountInfo');
    if (!infoEl || !m) return;
    if (!isConnected()) { infoEl.innerHTML = '<p class="prose" style="opacity:.6;font-size:0.72rem">Connect wallet to look up balance.</p>'; return; }
    infoEl.innerHTML = '<p class="prose" style="opacity:.6;font-size:0.72rem">Looking up…</p>';
    try {
      const info = await getTokenAccountInfo(m);
      if (!info) {
        infoEl.innerHTML = '<p class="prose" style="color:var(--accent-err,#ff4444);font-size:0.72rem">No token account found for this mint in your wallet.</p>';
      } else {
        infoEl.innerHTML = `<div class="kv" style="margin-bottom:4px">
          <div class="kv-row"><span class="kv-k">ATA</span><span class="kv-v" style="font-size:0.65rem">${esc(info.ata)}</span></div>
          <div class="kv-row"><span class="kv-k">BALANCE</span><span class="kv-v">${fmtN(info.amount)} (${info.decimals} decimals)</span></div>
          <div class="kv-row"><span class="kv-k">RAW</span><span class="kv-v" style="font-size:0.68rem">${esc(info.raw)}</span></div>
        </div>`;
      }
    } catch (e) { infoEl.innerHTML = `<p class="prose" style="color:var(--accent-err,#ff4444);font-size:0.72rem">${esc(e.message)}</p>`; }
  };

  // Auto-lookup if mint is pre-filled
  if (getBurnMint()) showBurnInfo();

  $('burnLookupBtn')?.addEventListener('click', showBurnInfo);

  $('burnBtn')?.addEventListener('click', async () => {
    const m   = getBurnMint();
    const amt = parseFloat($('burnAmt')?.value);
    if (!isConnected()) { toast('Connect wallet first', 'err'); return; }
    if (!m)        { toast('Enter a mint address', 'err'); return; }
    if (!amt || amt <= 0) { toast('Enter an amount to burn', 'err'); return; }
    if (!confirm(`Burn ${fmtN(amt)} tokens from mint ${m.slice(0,8)}…? Permanent.`)) return;
    setBtn('burnBtn', '[ BURNING… ]', true);
    try {
      await burnTokens(m, amt, false);
      toast(`Burned ${fmtN(amt)} tokens`, 'ok');
      showBurnInfo();
    } catch (e) { console.error('[burnTokens]', e); toast(e.message, 'err'); }
    finally { setBtn('burnBtn', '[ BURN ]', false); }
  });

  $('burnAllBtn')?.addEventListener('click', async () => {
    const m = getBurnMint();
    if (!isConnected()) { toast('Connect wallet first', 'err'); return; }
    if (!m) { toast('Enter a mint address', 'err'); return; }
    if (!confirm(`Burn ALL tokens for mint ${m.slice(0,8)}…? Permanent.`)) return;
    setBtn('burnAllBtn', '[ BURNING… ]', true);
    try {
      await burnTokens(m, null, false);
      toast('All tokens burned', 'ok');
      showBurnInfo();
    } catch (e) { console.error('[burnAllTokens]', e); toast(e.message, 'err'); }
    finally { setBtn('burnAllBtn', '[ BURN ALL ]', false); }
  });

  $('burnAndCloseBtn')?.addEventListener('click', async () => {
    const m = getBurnMint();
    if (!isConnected()) { toast('Connect wallet first', 'err'); return; }
    if (!m) { toast('Enter a mint address', 'err'); return; }
    if (!confirm(`Burn ALL tokens and CLOSE the token account for mint ${m.slice(0,8)}…?\n\nThis recovers ~0.002 SOL rent. Permanent.`)) return;
    setBtn('burnAndCloseBtn', '[ BURNING + CLOSING… ]', true);
    try {
      await burnTokens(m, null, true);
      toast('Tokens burned and account closed — rent recovered', 'ok');
      $('burnAccountInfo').innerHTML = '<p class="prose" style="font-size:0.72rem;opacity:.6">Account closed.</p>';
      if (m === mint) renderDevtools(); // refresh if it was the tracked token
    } catch (e) { console.error('[burnAndClose]', e); toast(e.message, 'err'); }
    finally { setBtn('burnAndCloseBtn', '[ BURN ALL + CLOSE ACCOUNT ]', false); }
  });

  // ── Cancel all open proposals ─────────────────────────────────────────────
  $('cancelAllProposalsBtn')?.addEventListener('click', async () => {
    if (!confirm('Cancel ALL open proposals?\n\nThis immediately closes every Voting-state proposal. Cancelled proposals cannot be re-opened.\n\nYour staked tokens will be unlocked for withdrawal.')) return;
    setBtn('cancelAllProposalsBtn', '[ CANCELLING… ]', true);
    try {
      const sigs = await cancelAllProposals();
      toast(`${sigs.length} proposal(s) cancelled — tokens unlocked for withdrawal.`, 'ok');
      _stakeInfo = await getStakeInfo(getPublicKey());
      await refreshProposals();
      renderDevtools();
      renderStake();
    } catch (e) {
      console.error('[cancelAllProposals]', e);
      toast(e.message, 'err');
      setBtn('cancelAllProposalsBtn', '[ CANCEL ALL OPEN PROPOSALS ]', false);
    }
  });

  // ── Reset: realm only ────────────────────────────────────────────────────────
  $('resetRealmOnlyBtn')?.addEventListener('click', async () => {
    const newName = $('newRealmNameInput')?.value?.trim();
    if (!newName) { toast('Enter a new realm name first', 'err'); return; }
    if (!confirm(`Reset realm config?\n\nNew realm name: "${newName}"\n\nThis clears Firebase config + sets new realm name. Your token (${mint ?? 'none'}) is kept.\nOn-chain accounts are abandoned.`)) return;
    setBtn('resetRealmOnlyBtn', '[ RESETTING… ]', true);
    try {
      if (newName !== getDevnetRealmName()) setDevnetRealmName(newName);
      await deleteGovConfig();
      toast('Realm config cleared. Reload and go to Admin to deploy fresh realm.', 'ok');
      location.reload();
    } catch (e) { console.error('[resetRealmOnly]', e); toast(e.message, 'err'); setBtn('resetRealmOnlyBtn', '[ RESET REALM ONLY ]', false); }
  });

  // ── Full reset: token + realm ─────────────────────────────────────────────
  $('fullResetBtn')?.addEventListener('click', async () => {
    const newName = $('newRealmNameInput')?.value?.trim();
    if (!newName) { toast('Enter a new realm name first', 'err'); return; }
    if (newName === getDevnetRealmName() && newName === 'BASIS DAO') {
      toast('Change the realm name above before resetting — enter a new unique name first.', 'err'); return;
    }
    if (!confirm(`FULL RESET?\n\nNew realm name: "${newName}"\n\nThis destroys ALL local state:\n• Clears token reference\n• Clears Firebase realm config\n• Sets new realm name: "${newName}"\n\nOn-chain accounts are abandoned on devnet.`)) return;
    setBtn('fullResetBtn', '[ RESETTING… ]', true);
    try {
      // fullDevnetReset clears devnet_realm_name — save new name AFTER the reset
      await fullDevnetReset(deleteGovConfig);
      setDevnetRealmName(newName);
      toast('Full reset complete. Reload and start from Dev Tools step 1.', 'ok');
      location.reload();
    } catch (e) { console.error('[fullReset]', e); toast(e.message, 'err'); setBtn('fullResetBtn', '[ FULL RESET — TOKEN + REALM ]', false); }
  });

  el.querySelectorAll('[data-tab]').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );
}

// ─── Refresh proposals list ───────────────────────────────────────────────────
async function refreshProposals() {
  if (!_realmReady) return;
  try {
    const [proposalsResult, metaResult] = await Promise.allSettled([
      listProposals(),
      getAllProposalMeta(),
    ]);
    if (proposalsResult.status === 'fulfilled') _proposals    = proposalsResult.value;
    else console.error('[refreshProposals] listProposals failed:', proposalsResult.reason);
    if (metaResult.status === 'fulfilled')     _proposalMeta = metaResult.value;
    else console.warn('[refreshProposals] getAllProposalMeta failed (proposals still shown):', metaResult.reason?.message);
    renderProposals();
    // Fire-and-forget: silently clear any votes stuck on finished proposals
    autoRelinquishStaleVotes().catch(e => console.warn('[autoRelinquish] sweep error:', e.message));
  } catch (e) {
    console.error('[refreshProposals] failed:', e);
  }
}

// ─── Footer clock ─────────────────────────────────────────────────────────────
function tickFooter() {
  const el = $('tf-timestamp');
  if (el) el.textContent = new Date().toUTCString().slice(17,25) + ' UTC';
}
setInterval(tickFooter, 1000);

// ─── Create proposal tab → nav button wiring ──────────────────────────────────
document.querySelectorAll('[data-tab="create"]').forEach(el =>
  el.addEventListener('click', () => switchTab('create'))
);
$('propDesc')?.addEventListener('input', function() {
  const el = $('descCount'); if (el) el.textContent = `${this.value.length} / 2000`;
});

// ─── Network switcher (module-level, drives topbar + full app refresh) ────────
const NET_COLORS = { devnet: 'var(--accent-warn)', testnet: '#a78bfa', mainnet: 'var(--accent-ok)' };
const NET_LABELS = { devnet: 'SOLANA DEVNET',      testnet: 'SOLANA TESTNET', mainnet: 'SOLANA MAINNET' };

function updateNetSwitcher(net) {
  // Topbar buttons
  document.querySelectorAll('.net-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.net === net);
  });
  // Sidebar footer
  const foot = $('sidebarWallet');
  if (foot) foot.innerHTML =
    `<div class="net-status"><span class="dot-live" style="background:${NET_COLORS[net]}" aria-hidden="true"></span>${NET_LABELS[net]}</div>`;
}

async function switchNet(net) {
  if (net === getDevNetwork()) return;
  setDevNetwork(net);
  resetConnection();
  resetRealmState();
  _realmReady    = false;
  _stakeInfo     = null;
  _proposals     = [];
  _proposalMeta  = {};
  updateNetSwitcher(net);
  updateWalletUI();
  const realmData = await loadRealm().catch(() => null);
  if (realmData) {
    _realmReady = true;
    await refreshProposals();
  }
  renderStake();
  if (IS_DEVNET) renderAdmin();
  renderCreateStatus();
  if (_tab === 'devtools') renderDevtools();
  if (isConnected()) refreshUserData();
  toast(`Switched to ${net.toUpperCase()}`, 'info');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  // Show devnet-only nav items and tab panes
  if (IS_DEVNET) {
    document.querySelectorAll('.devnet-only').forEach(el => el.style.display = '');
    document.title = 'BASIS GOV — DEV';
    // Set initial topbar active state and wire click handlers
    updateNetSwitcher(getDevNetwork());
    document.querySelectorAll('.net-btn').forEach(b =>
      b.addEventListener('click', () => switchNet(b.dataset.net))
    );
  }

  updateWalletUI();
  tickFooter();
  renderStake();
  if (IS_DEVNET) renderAdmin();

  // Load realm config
  const realmData = await loadRealm().catch(() => null);
  if (realmData) {
    _realmReady = true;
    if (IS_DEVNET) renderAdmin();
    await refreshProposals();
    renderStake();
    // Wallet may have connected before the realm finished loading — catch up now
    if (isConnected()) await refreshUserData();
  }

  // Auto-refresh proposals every 60s
  setInterval(refreshProposals, 60_000);
})();

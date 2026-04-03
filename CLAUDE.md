# basis-gov

SPL Governance DAO interface for BASIS DAO. Allows token holders to create proposals, vote, and manage the realm.

## What it does
- Realm creation and council management
- Proposal creation, voting (yes/no/abstain), and execution
- Token deposit/withdrawal for voting power
- NFT boost display (1.5× multiplier, UI-only)
- Devnet tooling: airdrop, test token creation, devnet reset
- Off-chain governance metadata stored in Firebase/Firestore

## Key files
| File | Role |
|---|---|
| `src/app.js` | Main UI (74K) — proposals, voting, realm management |
| `src/realm.js` | SPL Governance instructions (31.5K) — core Solana logic |
| `src/config.js` | Network config, BASIS mint, RPC, Firebase keys |
| `src/wallet.js` | Phantom/Solflare connection |
| `src/firebase.js` | Firestore: realm metadata, proposal enrichment |
| `src/tokenLauncher.js` | Dev tools — airdrop, test token, devnet reset |
| `firestore.rules` | Firestore security rules for governance data |

## Solana stack (current — legacy)
- `@solana/web3.js` `^1.95.3` — Connection, Transaction, PublicKey
- `@solana/spl-governance` `0.3.28` — Realm, Proposal, Vote structs and instructions
- `@solana/spl-token` `^0.4.9` — Token account operations
- `@metaplex-foundation/mpl-token-metadata` `^2.13.0` — NFT metadata reads
- Wallet adapters: Phantom, Solflare

## Skill guidance
The `solana-dev` skill is highest priority here:

### Security (CRITICAL — real DAO funds)
- `realm.js` builds SPL Governance instructions manually — verify with `references/security.md`
- Check for: unchecked account ownership, missing signer validation, PDA derivation correctness
- All proposal execution paths must validate account authority before sending

### Dependency issues
- `references/compatibility-matrix.md` — spl-governance 0.3.28 + spl-token 0.4.9 compatibility
- `references/common-errors.md` — for Transaction simulation failures, AccountNotFound errors

### Future migration
- `references/kit-web3-interop.md` — migration path from `@solana/web3.js` v1 to `@solana/kit`
- The polyfill requirements in `vite.config.js` disappear entirely on `@solana/kit`

## Config
- SPL Governance program: `GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw` (v3)
- BASIS mint (mainnet): `A5BJBQUTR5sTzkM89hRDuApWyvgjdXpR7B7rW1r9pump`
- Min tokens to create governance: 10,000,000 BASIS
- RPC: Helius via `VITE_RPC` env var

## Dev
```bash
npm run dev          # mainnet, localhost:5173
npm run dev:devnet   # devnet mode
npm run build
npm run build:devnet
```

## Environment vars (.env)
```
VITE_RPC=             # Helius mainnet RPC URL
VITE_MAINNET_RPC=     # fallback mainnet RPC
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

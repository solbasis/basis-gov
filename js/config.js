// ─── BASIS Gov — Shared Constants ─────────────────────────────────────────────
export const BASIS_MINT           = 'A5BJBQUTR5sTzkM89hRDuApWyvgjdXpR7B7rW1r9pump';
export const HELIUS_URL           = 'https://mainnet.helius-rpc.com/?api-key=00ddde2e-972f-4cbf-a505-f17e13f54dfb';
export const BASIS_SUPPLY         = 1_000_000_000;

export const MIN_PROPOSAL_STAKE   = 10_000_000;   // 10M $BASIS
export const QUORUM_PERCENT       = 5;             // 5% of total staked
export const COOLDOWN_DAYS        = 7;             // 7-day unstake cooldown
export const NFT_BOOST_MULTIPLIER = 1.5;           // Genesis NFT voting boost
export const NFT_NAME_FILTER      = 'basis';       // NFT name contains this
export const DEFAULT_REWARD_APY   = 20;            // 20% APY default

export const VOTING_DURATIONS = [
  { label: '24H',  hours: 24  },
  { label: '48H',  hours: 48  },
  { label: '72H',  hours: 72  },
  { label: '7D',   hours: 168 },
];

export const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyDh3Xdavtn8q3w_g6kiDyWJfK5jeMD46ww',
  authDomain:        'basis-acfec.firebaseapp.com',
  projectId:         'basis-acfec',
  storageBucket:     'basis-acfec.firebasestorage.app',
  messagingSenderId: '884887459105',
  appId:             '1:884887459105:web:e39be97abde4afcc271a60',
};

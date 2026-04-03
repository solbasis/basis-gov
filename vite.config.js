import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    nodePolyfills({
      globals:  { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  define: {
    'process.env': {},
    '__IS_DEVNET__': JSON.stringify(mode === 'devnet'),
  },
  build: {
    target:  'esnext',
    outDir:  mode === 'devnet' ? 'dist-devnet' : 'dist',
    commonjsOptions: { transformMixedEsModules: true },
    rollupOptions: {
      output: {
        manualChunks: {
          solana:      ['@solana/web3.js'],
          governance:  ['@solana/spl-governance'],
          'spl-token': ['@solana/spl-token'],
          firebase:    ['firebase/app', 'firebase/firestore'],
        },
      },
    },
  },
}));

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// FiveM's CEF is Chromium 103: the build targets it, and every asset path is
// relative (base './') so it resolves under nui://cis_database/.
const TARGET = 'chrome103';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    target: TARGET,
    cssTarget: TARGET,
  },
});

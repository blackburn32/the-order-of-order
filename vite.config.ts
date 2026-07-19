import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 2000
  },
  server: {
    port: 5173,
    open: false
  }
});

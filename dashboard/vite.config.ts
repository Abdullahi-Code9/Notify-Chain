/// <reference types="vite/client" />
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = dirname(fileURLToPath(import.meta.url));

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: securityHeaders,
    // Workspace path contains ':' (Core-Foundry:Notify-Chain), which breaks Vite's default fs allow checks.
    fs: {
      strict: false,
      allow: [rootDir],
    },
  },
  preview: {
    headers: securityHeaders,
  },
});

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
  'Content-Security-Policy': [
    // Default source restrictions
    "default-src 'self'",
    
    // Script sources - allow 'self' and 'unsafe-inline' for Vite dev mode (hashes would be better for production)
    "script-src 'self' 'unsafe-inline'",
    
    // Style sources - allow 'self' and 'unsafe-inline' for CSS-in-JS and component libraries
    "style-src 'self' 'unsafe-inline'",
    
    // Font sources - allow 'self' and data URLs for inline fonts
    "font-src 'self' data:",
    
    // Image sources - allow 'self', data URLs, and blob URLs for generated images
    "img-src 'self' data: blob:",
    
    // Connect sources - allow 'self' and local API endpoints
    "connect-src 'self' http://localhost:8787 ws://localhost:8787",
    
    // Media sources - allow 'self'
    "media-src 'self'",
    
    // Object sources - restrict to none (no Flash, Java applets, etc.)
    "object-src 'none'",
    
    // Frame sources - allow 'self' for embedded content
    "frame-src 'self'",
    
    // Base URI - restrict to 'self' to prevent base tag injection
    "base-uri 'self'",
    
    // Form action - restrict to 'self' to prevent form submission to malicious sites
    "form-action 'self'",
    
    // Frame ancestors - restrict to 'self' (redundant with X-Frame-Options but more granular)
    "frame-ancestors 'self'",
    
    // Upgrade insecure requests - upgrade HTTP to HTTPS
    "upgrade-insecure-requests"
  ].join('; '),
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

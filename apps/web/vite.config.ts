/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The daemon the dev server proxies to; it must run with `WEB_ORIGIN=http://localhost:5173` (or the dev URL in use). */
const daemon = process.env.SUPERCAL_DAEMON_URL ?? 'http://localhost:4316';
const proxied = Object.fromEntries(['/api', '/dav', '/ics', '/.well-known'].map((path) => [path, { target: daemon, changeOrigin: false }]));

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  server: { proxy: proxied },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

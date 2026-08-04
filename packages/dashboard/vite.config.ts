import { defineConfig } from 'vite';

/**
 * Dashboard dev server.
 *
 * Binds loopback only. The daemon API is proxied so the browser avoids a
 * cross-origin token dance in development; in production the daemon serves the
 * built assets itself.
 */
export default defineConfig({
  // TODO: add `react()` from @vitejs/plugin-react once deps are installed.
  plugins: [],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:47317', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:47317', ws: true },
    },
  },
  build: {
    outDir: 'dist/web',
    sourcemap: true,
  },
  test: {
    name: 'dashboard',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

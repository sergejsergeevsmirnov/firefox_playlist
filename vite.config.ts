import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [{
    name: 'dash-csp-global',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/dash.all.min.js')) return;
      // Webpack's legacy global-object fallback is unreachable on Firefox 140+.
      // Remove its string evaluator so the packaged library passes extension CSP lint.
      const fallback = 'new Function("return this")()';
      if (code.split(fallback).length !== 2) throw new Error('Review dash.js CSP transform after dependency update');
      return { code: code.replace(fallback, 'globalThis'), map: null };
    },
  }],
  build: {
    target: 'firefox140',
    rollupOptions: { input: { sidebar: resolve('sidebar.html'), player: resolve('player.html') } },
    chunkSizeWarningLimit: 1500,
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Receipt OCR (tesseract.js) needs a web worker, a WASM core and the
// language models at runtime. By default tesseract.js pulls all three from
// cdn.jsdelivr.net, which the CSP in vercel.json (script-src/connect-src
// 'self') blocks — so they're served same-origin under /tesseract/ instead,
// straight from node_modules: emitted into dist/ on build, served by a
// middleware in dev. Keep in sync with OCR_PATHS in
// src/features/transactions/receiptOcr.js.
function tesseractAssets() {
  const pkgDir = name => path.dirname(require.resolve(`${name}/package.json`));
  const files = {
    'tesseract/worker.min.js': path.join(pkgDir('tesseract.js'), 'dist/worker.min.js'),
    // Only the LSTM cores: the app always runs OEM.LSTM_ONLY. tesseract.js
    // picks plain/simd/relaxed-simd at runtime based on browser support.
    ...Object.fromEntries(['', 'simd-', 'relaxedsimd-'].map(v => [
      `tesseract/core/tesseract-core-${v}lstm.wasm.js`,
      path.join(pkgDir('tesseract.js-core'), `tesseract-core-${v}lstm.wasm.js`),
    ])),
    ...Object.fromEntries(['ita', 'eng'].map(lang => [
      `tesseract/lang/${lang}.traineddata.gz`,
      path.join(pkgDir(`@tesseract.js-data/${lang}`), `4.0.0_best_int/${lang}.traineddata.gz`),
    ])),
  };

  return {
    name: 'tesseract-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const src = files[(req.url || '').split('?')[0].replace(/^\//, '')];
        if (!src) return next();
        res.setHeader('Content-Type', src.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        fs.createReadStream(src).pipe(res);
      });
    },
    generateBundle() {
      for (const [fileName, src] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(src) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tesseractAssets()],
  build: {
    rollupOptions: {
      external: [],
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
    },
  },
});

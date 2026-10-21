import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(webRoot, '..');
const toPosix = (path: string): string => path.replaceAll('\\', '/');
const deniedProjectDirectories = [
  '.omx',
  '.npm-cache',
  'android',
  'content',
  'docs',
  'eval',
  'packages',
  'server',
].map((directory) => `${toPosix(resolve(projectRoot, directory))}/**`);

export default defineConfig({
  root: webRoot,
  envDir: false,
  plugins: [react()],
  define: {
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(process.env.VITE_API_BASE_URL ?? ''),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      strict: true,
      allow: [webRoot, resolve(projectRoot, 'node_modules')],
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        ...deniedProjectDirectories,
      ],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

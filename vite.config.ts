import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], base: './', build: { outDir: 'dist' }, server: { host: '127.0.0.1', port: 5173, proxy: { '/admin': 'http://127.0.0.1:4317', '/v1': 'http://127.0.0.1:4317' } } });

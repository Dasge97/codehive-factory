import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const PUERTO_SERVIDOR = process.env.CODEHIVE_PORT ?? '4610';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
  },
  server: {
    port: 4611,
    // En desarrollo, la web corre en su propio puerto y las llamadas a la API van al
    // servicio de coordinación.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${PUERTO_SERVIDOR}`,
        changeOrigin: true,
      },
    },
  },
});

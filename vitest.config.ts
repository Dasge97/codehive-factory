import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Las pruebas del servidor corren en Node; las de la web necesitan un navegador
    // simulado, así que cada carpeta tiene su propio entorno.
    projects: [
      {
        test: {
          name: 'servidor',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          include: ['web/**/*.test.tsx'],
          environment: 'jsdom',
          globals: true,
          setupFiles: ['web/src/test-setup.ts'],
        },
      },
    ],
  },
});

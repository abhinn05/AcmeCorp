import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The front end never talks to the database, the mail server or the model. In
 * development it talks to the back end through this proxy, so there is one
 * origin in the browser and no API base URL to configure.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});

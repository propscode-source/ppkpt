import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { createApp } from './lib/app';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';

const PORT = Number(process.env.PORT) || 3000;

async function startDevServer() {
  const app = createApp();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(process.cwd(), 'dist');
    const express = (await import('express')).default;
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('\n[WARN] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diset di .env.local');
    }
    if (!process.env.ENCRYPTION_KEY) {
      console.warn('[WARN] ENCRYPTION_KEY belum diset — data sensitif tidak bisa dienkripsi.');
    }
    if (fs.existsSync(path.join(process.cwd(), 'database.json'))) {
      console.warn('[INFO] database.json terdeteksi tapi server sekarang pakai Supabase. File ini diabaikan.');
    }
  });
}

startDevServer().catch((err) => {
  console.error('Dev server failed to start:', err);
  process.exit(1);
});

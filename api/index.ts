import type { IncomingMessage, ServerResponse } from 'http';
import { createApp } from '../lib/app.js';

let appInstance: ReturnType<typeof createApp> | null = null;
let initError: Error | null = null;

function getApp() {
  if (initError) throw initError;
  if (!appInstance) {
    try {
      appInstance = createApp();
    } catch (err) {
      initError = err as Error;
      throw err;
    }
  }
  return appInstance;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/api/debug' || req.url?.startsWith('/api/debug?')) {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        url: req.url,
        env: {
          SUPABASE_URL: !!process.env.SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
          ENCRYPTION_KEY: !!process.env.ENCRYPTION_KEY
        },
        initError: initError ? { message: initError.message, stack: initError.stack } : null,
        node: process.version
      })
    );
    return;
  }

  try {
    const app = getApp();
    return app(req, res);
  } catch (err: any) {
    console.error('Function init/runtime error:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'Function crashed',
        message: err?.message || String(err),
        stack: err?.stack
      })
    );
  }
}

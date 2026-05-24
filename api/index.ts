import type { IncomingMessage, ServerResponse } from 'http';

let appPromise: Promise<any> | null = null;
let initError: Error | null = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const { createApp } = await import('../lib/app');
      return createApp();
    })().catch((err) => {
      initError = err as Error;
      throw err;
    });
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // Debug endpoint that does NOT depend on Supabase / encryption
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
    const app = await getApp();
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

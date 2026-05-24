import type { IncomingMessage, ServerResponse } from 'http';

let appPromise: Promise<any> | null = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const mod = await import('../lib/app.js');
      return mod.createApp();
    })();
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // Debug endpoint - does NOT load lib/app, so it works even if app crashes at init
  if (req.url === '/api/debug' || req.url?.startsWith('/api/debug?')) {
    let importErr: any = null;
    try {
      await getApp();
    } catch (e) {
      importErr = e;
    }
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
        importError: importErr ? { message: importErr.message, stack: importErr.stack } : null,
        node: process.version
      }, null, 2)
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

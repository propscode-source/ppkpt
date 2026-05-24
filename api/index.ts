import type { IncomingMessage, ServerResponse } from 'http';
import { createApp } from '../lib/app.js';

let appInstance: ReturnType<typeof createApp> | null = null;
let appError: Error | null = null;

function getApp() {
  if (appError) throw appError;
  if (!appInstance) {
    try {
      appInstance = createApp();
    } catch (e) {
      appError = e as Error;
      throw e;
    }
  }
  return appInstance;
}

function sendJson(res: ServerResponse, status: number, body: any) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body, null, 2));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // ---- DEBUG: always responds, regardless of app state ----
  if (req.url === '/api/debug' || req.url?.startsWith('/api/debug?')) {
    let createErr: any = null;
    try {
      getApp();
    } catch (e) {
      createErr = e;
    }
    sendJson(res, 200, {
      ok: true,
      url: req.url,
      env: {
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        ENCRYPTION_KEY: !!process.env.ENCRYPTION_KEY
      },
      createAppError: createErr ? { message: createErr.message, stack: createErr.stack } : null,
      node: process.version
    });
    return;
  }

  try {
    const app = getApp();
    return app(req, res);
  } catch (err: any) {
    console.error('Function runtime error:', err);
    sendJson(res, 500, {
      error: 'Function crashed',
      message: err?.message || String(err),
      stack: err?.stack
    });
  }
}

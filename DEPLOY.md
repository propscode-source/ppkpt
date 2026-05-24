# Deploy PPKPT FASILKOM UNSRI ke Vercel + Supabase

## 1. Setup Supabase

1. Buat project baru di https://supabase.com → tunggu provisioning selesai.
2. Buka **SQL Editor** → New query → paste isi [`database_schema.sql`](database_schema.sql) → **Run**.
   - Script ini membuat tabel `users`, `settings`, `reports`, `audit_logs`, RLS, indexes, dan 3 storage bucket: `evidence`, `documents`, `exports`.
3. Catat dari **Project Settings → API**:
   - `Project URL` → akan jadi `SUPABASE_URL`
   - `service_role` key (di section "Project API keys") → akan jadi `SUPABASE_SERVICE_ROLE_KEY`. **JANGAN gunakan `anon` key di server.**

## 2. Setup Vercel

1. Push repo ini ke GitHub (atau import langsung folder via Vercel CLI).
2. https://vercel.com → **New Project** → import repo.
3. **Build & Output Settings** — biarkan default; sudah didikte oleh `vercel.json`:
   - Build command: `vite build`
   - Output directory: `dist`
   - Install command: `npm install`
4. **Environment Variables** — tambahkan untuk semua environments (Production, Preview, Development):
   ```
   SUPABASE_URL=https://YOUR-REF.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...   (service_role, RAHASIA)
   ENCRYPTION_KEY=<32-byte hex random>
   ```
   Generate `ENCRYPTION_KEY`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
5. Klik **Deploy**.

## 3. Verifikasi

- Buka `https://<your-app>.vercel.app/api/health` → harus return `{ status: "ok", db_type: "supabase" }`.
- Buka landing page → coba submit laporan dengan satu file bukti kecil.
- Login admin: `admin` / `password` → **WAJIB ganti password lewat menu Users segera**. Password baru akan di-hash bcrypt otomatis.

## 4. Dev lokal

```bash
cp .env.example .env.local   # isi dengan kredensial Supabase yang sama
npm install
npm run dev                  # http://localhost:3000
```

## Catatan penting

- **Body size limit Vercel**: Hobby plan 4.5MB per request, Pro 50MB. Setting `max_upload_size_mb` (default 10) hanya akan efektif sampai limit plan Vercel.
- **Default password admin masih plaintext** sampai diganti pertama kali. Server mendukung fallback plaintext supaya bootstrap login bekerja.
- **File-file legacy** (`database.json`, `uploads/`, `exports/`, `src.backup/`, `server.backup.ts`, `test-*.ts`, `fix.cjs`, `supabase.ts`) sudah masuk `.gitignore` dan tidak akan ikut deploy. Bisa dihapus manual kalau tidak lagi dipakai.
- **PDFKit** butuh font Helvetica yang dibundle dalam package — sudah otomatis.
- **archiver-zip-encrypted** tidak punya types → di-suppress dengan `// @ts-ignore` di `lib/app.ts`.

## Arsitektur

```
Browser → Vercel CDN (dist/index.html, static assets)
        ↘ /api/* → api/[...path].ts (serverless) → lib/app.ts (Express)
                                                       ↓
                                                   Supabase (Postgres + Storage)
```

Express app di `lib/app.ts` dipakai oleh:
- Production: di-wrap oleh `api/[...path].ts` (Vercel Node runtime)
- Development: di-mount di `server.ts` bareng Vite middleware (tsx server.ts)

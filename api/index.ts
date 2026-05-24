// =============================================================================
// PPKPT FASILKOM UNSRI — Vercel serverless handler (self-contained, no relative imports)
// All helper code is inlined to bypass Vercel NFT tracing/compilation quirks for /lib.
// For local dev (server.ts), the modular lib/ folder is used instead.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';
import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { PassThrough } from 'stream';
import path from 'path';
import bcrypt from 'bcryptjs';
import CryptoJS from 'crypto-js';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// LAZY SUPABASE
// =============================================================================
const EVIDENCE_BUCKET = 'evidence';
const DOCUMENTS_BUCKET = 'documents';
const EXPORTS_BUCKET = 'exports';

let _client: SupabaseClient | null = null;
function initSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars must be set.');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}
const supabase = new Proxy({} as SupabaseClient, {
  get(_t, prop) {
    if (!_client) _client = initSupabase();
    const v = (_client as any)[prop];
    return typeof v === 'function' ? v.bind(_client) : v;
  }
});

// =============================================================================
// ENCRYPTION
// =============================================================================
const encrypt = (text: string | null | undefined): string | null => {
  const key = process.env.ENCRYPTION_KEY;
  if (!text || !key) return null;
  return CryptoJS.AES.encrypt(text, key).toString();
};
const decrypt = (ciphertext: string | null | undefined): string | null => {
  const key = process.env.ENCRYPTION_KEY;
  if (!ciphertext || !key) return null;
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    return bytes.toString(CryptoJS.enc.Utf8) || null;
  } catch {
    return null;
  }
};

// =============================================================================
// PASSWORD
// =============================================================================
async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    return bcrypt.compare(plain, stored);
  }
  return plain === stored;
}

// =============================================================================
// STORAGE
// =============================================================================
interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}
async function uploadToStorage(bucket: string, file: UploadedFile, prefix = ''): Promise<string> {
  const ext = path.extname(file.originalname);
  const filename = `${prefix}${prefix ? '-' : ''}${Date.now()}-${uuidv4()}${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(filename, file.buffer, {
    contentType: file.mimetype,
    upsert: false
  });
  if (error) throw new Error(`Upload gagal: ${error.message}`);
  return filename;
}
async function downloadFromStorage(bucket: string, p: string): Promise<Buffer | null> {
  const { data, error } = await supabase.storage.from(bucket).download(p);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}
async function getSignedUrl(bucket: string, p: string, expiresIn = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(p, expiresIn);
  if (error || !data) return null;
  return data.signedUrl;
}

// =============================================================================
// HEAVY LIBS — lazy-loaded to avoid breaking the whole function if they fail
// =============================================================================
let zipFormatRegistered = false;
async function loadZipLibs() {
  const archiverMod: any = (await import('archiver')).default;
  if (!zipFormatRegistered) {
    const zipEnc: any = (await import('archiver-zip-encrypted')).default;
    archiverMod.registerFormat('zip-encrypted', zipEnc);
    zipFormatRegistered = true;
  }
  return archiverMod;
}
async function loadPdf() {
  const mod: any = await import('pdfkit');
  return mod.default || mod;
}

// =============================================================================
// EXPRESS APP
// =============================================================================
const DEFAULT_SETTINGS = {
  sla_pending: 7,
  sla_investigating: 30,
  sla_recommended: 7,
  sla_resolved: 7,
  max_upload_size_mb: 10,
  categories: [
    'Kekerasan Fisik',
    'Kekerasan Psikis',
    'Kekerasan Seksual',
    'Perundungan (Bullying)',
    'Intoleransi',
    'Pelecehan Seksual via Media Elektronik',
    'Lainnya'
  ]
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

async function getSettings() {
  const { data, error } = await supabase.from('settings').select('*').limit(1).maybeSingle();
  if (error || !data) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...data };
}

const sizeLimitMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await getSettings();
    const maxMb = settings.max_upload_size_mb || 10;
    const maxSize = maxMb * 1024 * 1024;
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > maxSize + 5 * 1024 * 1024) {
      return res.status(413).json({ error: `File terlalu besar. Maksimum upload adalah ${maxMb} MB.` });
    }
    next();
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'size middleware failed' });
  }
};

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString(), db_type: 'supabase' });
  });

  // ---- PUBLIC REPORTING ----
  app.post('/api/reports', sizeLimitMiddleware, upload.single('evidence'), async (req, res) => {
    try {
      const {
        reporter_name,
        reporter_contact,
        reporter_identity_number,
        is_anonymous,
        victim_name,
        category,
        incident_date,
        incident_location,
        chronology
      } = req.body;

      let evidence_url: string | null = null;
      if (req.file) {
        evidence_url = await uploadToStorage(
          EVIDENCE_BUCKET,
          {
            buffer: req.file.buffer,
            originalname: req.file.originalname,
            mimetype: req.file.mimetype
          },
          'evidence'
        );
      }

      const gen = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = 'PPK-';
        for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
        return code;
      };

      let tracking_code = gen();
      for (let i = 0; i < 5; i++) {
        const { data: exists } = await supabase
          .from('reports')
          .select('id')
          .eq('tracking_code', tracking_code)
          .maybeSingle();
        if (!exists) break;
        tracking_code = gen();
      }

      const anonymous = is_anonymous === 'true' || is_anonymous === true;

      const { error } = await supabase.from('reports').insert({
        tracking_code,
        reporter_name: anonymous ? null : encrypt(reporter_name),
        reporter_contact: anonymous ? null : encrypt(reporter_contact),
        reporter_identity_number: anonymous ? null : encrypt(reporter_identity_number),
        is_anonymous: anonymous,
        victim_name: encrypt(victim_name),
        category,
        incident_date,
        incident_location,
        chronology,
        evidence_url,
        status: 'PENDING'
      });
      if (error) throw new Error(error.message);

      res.status(201).json({ success: true, tracking_code, message: 'Laporan berhasil dikirim.' });
    } catch (error: any) {
      console.error('Upload Error:', error);
      res.status(500).json({ error: error.message || 'Gagal mengirim laporan' });
    }
  });

  app.get('/api/reports/track/:code', async (req, res) => {
    try {
      const { data: report, error } = await supabase
        .from('reports')
        .select('tracking_code, status, created_at, nomor_sk_sanksi, tanggal_sk_sanksi')
        .eq('tracking_code', req.params.code)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!report) return res.status(404).json({ error: 'Kode tracking tidak ditemukan' });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // ---- AUTH ----
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('username', username)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      const ok = await verifyPassword(password, user.password);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      res.json({ id: user.id, username: user.username, role: user.role });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // ---- ADMIN REPORTS ----
  app.get('/api/admin/reports', async (req, res) => {
    try {
      const { userId, role } = req.query as { userId?: string; role?: string };
      if (role !== 'admin' && role !== 'satgas') {
        return res.status(403).json({ error: 'Unauthorized' });
      }
      let q = supabase.from('reports').select('*').order('created_at', { ascending: false });
      if (role === 'satgas') q = q.eq('assigned_to', userId);
      const { data: reports, error } = await q;
      if (error) throw new Error(error.message);

      const { data: logs } = await supabase.from('audit_logs').select('report_id, created_at');
      const lastMap = new Map<string, string>();
      (logs || []).forEach((l: any) => {
        const prev = lastMap.get(l.report_id);
        if (!prev || new Date(l.created_at) > new Date(prev)) lastMap.set(l.report_id, l.created_at);
      });

      const out = (reports || []).map((r: any) => {
        let victim = decrypt(r.victim_name) || '';
        if (role === 'admin' && victim) {
          victim = victim.split(' ').map((p: string) => p.charAt(0) + '*'.repeat(Math.max(1, p.length - 1))).join(' ');
        }
        return {
          ...r,
          reporter_name: decrypt(r.reporter_name),
          reporter_contact: decrypt(r.reporter_contact),
          reporter_identity_number: decrypt(r.reporter_identity_number),
          victim_name: victim,
          last_updated_at: lastMap.get(r.id) || r.created_at
        };
      });
      res.json(out);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.patch(
    '/api/admin/reports/:id/status',
    sizeLimitMiddleware,
    upload.fields([
      { name: 'file_ringkasan_kasus', maxCount: 1 },
      { name: 'file_surat_rekomendasi', maxCount: 1 },
      { name: 'file_sk_sanksi', maxCount: 1 }
    ]),
    async (req, res) => {
      try {
        const {
          status,
          catatan_petugas,
          user_id_satgas,
          identitas_korban,
          identitas_saksi,
          tanggal_surat_rekomendasi,
          nomor_sk_sanksi,
          tanggal_sk_sanksi
        } = req.body;
        const reportId = req.params.id;
        if (!catatan_petugas || !user_id_satgas) {
          return res.status(400).json({ error: 'Catatan petugas dan ID Satgas wajib diisi.' });
        }

        const { data: report, error: fErr } = await supabase
          .from('reports')
          .select('*')
          .eq('id', reportId)
          .maybeSingle();
        if (fErr) throw new Error(fErr.message);
        if (!report) return res.status(404).json({ error: 'Report not found' });

        const prevStatus = report.status;
        const files = req.files as { [k: string]: Express.Multer.File[] };
        const update: Record<string, any> = { status };

        const uploadField = async (field: string) => {
          const f = files?.[field]?.[0];
          if (!f) return null;
          return uploadToStorage(
            DOCUMENTS_BUCKET,
            { buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype },
            field
          );
        };

        if (status === 'RECOMMENDED') {
          update.identitas_korban = encrypt(identitas_korban || '');
          update.identitas_saksi = encrypt(identitas_saksi || '');
          update.tanggal_surat_rekomendasi = tanggal_surat_rekomendasi;
          const a = await uploadField('file_ringkasan_kasus');
          const b = await uploadField('file_surat_rekomendasi');
          if (a) update.file_ringkasan_kasus = a;
          if (b) update.file_surat_rekomendasi = b;
        }
        if (status === 'RESOLVED') {
          update.nomor_sk_sanksi = nomor_sk_sanksi;
          update.tanggal_sk_sanksi = tanggal_sk_sanksi;
          const c = await uploadField('file_sk_sanksi');
          if (c) update.file_sk_sanksi = c;
        }

        const { error: uErr } = await supabase.from('reports').update(update).eq('id', reportId);
        if (uErr) throw new Error(uErr.message);

        const { error: lErr } = await supabase.from('audit_logs').insert({
          report_id: reportId,
          user_id_satgas,
          action: 'UPDATE_STATUS',
          previous_status: prevStatus,
          new_status: status,
          catatan_petugas
        });
        if (lErr) throw new Error(lErr.message);

        res.json({ success: true });
      } catch (error: any) {
        console.error('Status Update Error:', error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
      }
    }
  );

  app.get('/api/admin/reports/:id/logs', async (req, res) => {
    try {
      const { data: logs, error } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('report_id', req.params.id)
        .neq('action', 'EXPORT_ZIP')
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message);

      const userIds = Array.from(new Set((logs || []).map((l: any) => l.user_id_satgas).filter(Boolean)));
      const { data: users } = userIds.length
        ? await supabase.from('users').select('id, username').in('id', userIds)
        : { data: [] as any[] };
      const map = new Map((users || []).map((u: any) => [u.id, u.username]));
      res.json((logs || []).map((l: any) => ({ ...l, officer_name: map.get(l.user_id_satgas) || 'Unknown' })));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.patch('/api/admin/reports/:id/assign', async (req, res) => {
    try {
      const { assigned_to, user_id_admin } = req.body;
      const reportId = req.params.id;
      if (!assigned_to || !user_id_admin) {
        return res.status(400).json({ error: 'ID Satgas dan ID Admin wajib diisi.' });
      }
      const { data: report, error: fErr } = await supabase
        .from('reports')
        .select('status')
        .eq('id', reportId)
        .maybeSingle();
      if (fErr) throw new Error(fErr.message);
      if (!report) return res.status(404).json({ error: 'Report not found' });

      const { error: uErr } = await supabase.from('reports').update({ assigned_to }).eq('id', reportId);
      if (uErr) throw new Error(uErr.message);

      await supabase.from('audit_logs').insert({
        report_id: reportId,
        user_id_satgas: user_id_admin,
        action: 'ASSIGN_SATGAS',
        previous_status: report.status,
        new_status: report.status,
        catatan_petugas: 'Admin menugaskan satgas'
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // ---- EXPORT ZIP ----
  app.post('/api/admin/reports/:id/export', async (req, res) => {
    try {
      const archiverMod = await loadZipLibs();
      const PDFDocument = await loadPdf();
      const { password, username } = req.body;
      const reportId = req.params.id;

      const { data: user, error: uErr } = await supabase
        .from('users')
        .select('*')
        .eq('username', username)
        .maybeSingle();
      if (uErr) throw new Error(uErr.message);
      if (!user) return res.status(401).json({ error: 'Konfirmasi password gagal. Akses ditolak.' });
      const ok = await verifyPassword(password, user.password);
      if (!ok) return res.status(401).json({ error: 'Konfirmasi password gagal. Akses ditolak.' });

      const { data: report, error: rErr } = await supabase
        .from('reports')
        .select('*')
        .eq('id', reportId)
        .maybeSingle();
      if (rErr) throw new Error(rErr.message);
      if (!report) return res.status(404).json({ error: 'Laporan tidak ditemukan.' });

      const { data: logsRaw } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('report_id', reportId)
        .neq('action', 'EXPORT_ZIP')
        .order('created_at', { ascending: true });
      const userIds = Array.from(new Set((logsRaw || []).map((l: any) => l.user_id_satgas).filter(Boolean)));
      const { data: users } = userIds.length
        ? await supabase.from('users').select('id, username').in('id', userIds)
        : { data: [] as any[] };
      const uMap = new Map((users || []).map((u: any) => [u.id, u.username]));
      const logs = (logsRaw || []).map((l: any) => ({ ...l, officer_name: uMap.get(l.user_id_satgas) || 'Unknown' }));

      const zipPassword = crypto.randomBytes(6).toString('hex').toUpperCase();
      const zipFileName = `Export-${report.tracking_code}-${Date.now()}.zip`;

      const doc = new PDFDocument({ margin: 50 });
      const pdfBuffers: Buffer[] = [];
      doc.on('data', (c: Buffer) => pdfBuffers.push(c));
      const pdfPromise = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(pdfBuffers))));

      doc.fontSize(20).text('LAPORAN RESMI PPKPT FASILKOM UNSRI', { align: 'center' }).moveDown();
      doc.fontSize(10).text(`Dicetak pada: ${new Date().toLocaleString('id-ID')}`, { align: 'right' }).moveDown();
      doc.fontSize(12).font('Helvetica-Bold').text('INFORMASI LAPORAN');
      doc.font('Helvetica').fontSize(10);
      doc.text(`Kode Tracking: ${report.tracking_code}`);
      doc.text(`Status: ${report.status}`);
      doc.text(`Tanggal Lapor: ${report.created_at || '-'}`).moveDown();
      doc.fontSize(12).font('Helvetica-Bold').text('IDENTITAS PELAPOR');
      doc.font('Helvetica').fontSize(10);
      if (report.is_anonymous) {
        doc.text('Status: ANONIM');
      } else {
        doc.text(`Nama: ${decrypt(report.reporter_name)}`);
        doc.text(`NIM/NIP: ${decrypt(report.reporter_identity_number)}`);
        doc.text(`Kontak: ${decrypt(report.reporter_contact)}`);
      }
      doc.moveDown();
      doc.fontSize(12).font('Helvetica-Bold').text('DETAIL KEJADIAN');
      doc.font('Helvetica').fontSize(10);
      doc.text(`Kategori: ${report.category}`);
      doc.text(`Korban: ${decrypt(report.victim_name)}`);
      doc.text(`Tanggal Kejadian: ${report.incident_date}`);
      doc.text(`Lokasi Kejadian: ${report.incident_location}`).moveDown();
      doc.fontSize(12).font('Helvetica-Bold').text('KRONOLOGI');
      doc.font('Helvetica').fontSize(10).text(report.chronology, { align: 'justify' }).moveDown();
      doc.fontSize(12).font('Helvetica-Bold').text('RIWAYAT PENANGANAN');
      doc.font('Helvetica').fontSize(10);
      logs.forEach((log: any, i: number) => {
        doc.text(`${i + 1}. [${log.created_at}] ${log.previous_status || 'START'} -> ${log.new_status || log.action}`);
        doc.text(`   Catatan: ${log.catatan_petugas || '-'}`, { indent: 15 });
        doc.text(`   Petugas: ${log.officer_name || 'System'}`, { indent: 15 }).moveDown(0.5);
      });
      doc.end();
      const pdfBuffer = await pdfPromise;

      const archive = archiverMod('zip-encrypted', {
        zlib: { level: 9 },
        encryptionMethod: 'aes256',
        password: zipPassword
      });
      const passthrough = new PassThrough();
      const zipChunks: Buffer[] = [];
      passthrough.on('data', (c: Buffer) => zipChunks.push(c));
      const zipDone = new Promise<Buffer>((resolve, reject) => {
        passthrough.on('end', () => resolve(Buffer.concat(zipChunks)));
        passthrough.on('error', reject);
        archive.on('error', reject);
      });
      archive.pipe(passthrough);

      archive.append(pdfBuffer, { name: 'Ringkasan/Laporan-Resmi-PPKPT.pdf' });
      archive.append(
        `LAPORAN PPKPT FASILKOM UNSRI\nKODE: ${report.tracking_code}\n... (Lihat PDF untuk detail lengkap)`,
        { name: 'Ringkasan/Ringkasan-Singkat.txt' }
      );

      if (report.evidence_url) {
        const buf = await downloadFromStorage(EVIDENCE_BUCKET, report.evidence_url);
        if (buf) {
          const ext = report.evidence_url.includes('.') ? report.evidence_url.slice(report.evidence_url.lastIndexOf('.')) : '';
          archive.append(buf, { name: `Bukti_Digital/BUKTI-UTAMA${ext}` });
        }
      }
      archive.append(
        logs
          .map((l: any) => `[${l.created_at}] ${l.action}: ${l.previous_status} -> ${l.new_status} | Petugas: ${l.officer_name} | Catatan: ${l.catatan_petugas}`)
          .join('\n'),
        { name: 'Log/Audit-Trail-Lengkap.txt' }
      );
      await archive.finalize();
      const zipBuffer = await zipDone;

      const { error: upErr } = await supabase.storage
        .from(EXPORTS_BUCKET)
        .upload(zipFileName, zipBuffer, { contentType: 'application/zip', upsert: false });
      if (upErr) throw new Error(`Upload ZIP gagal: ${upErr.message}`);

      const signed = await getSignedUrl(EXPORTS_BUCKET, zipFileName, 3600);
      if (!signed) throw new Error('Gagal membuat signed URL untuk ZIP.');

      res.json({ success: true, zip_password: zipPassword, download_url: signed });
    } catch (error: any) {
      console.error('ZIP Generation Error:', error);
      res.status(500).json({ error: error.message || 'Gagal membuat file ZIP.' });
    }
  });

  // ---- USERS ----
  app.get('/api/admin/users', async (_req, res) => {
    try {
      const { data, error } = await supabase.from('users').select('id, username, role');
      if (error) throw new Error(error.message);
      res.json(data || []);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.post('/api/admin/users', async (req, res) => {
    try {
      const { username, password, role } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi.' });
      const { data: existing } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
      if (existing) return res.status(400).json({ error: 'Username sudah digunakan.' });
      const hashed = await hashPassword(password);
      const { data, error } = await supabase
        .from('users')
        .insert({ username, password: hashed, role: role || 'satgas' })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      res.status(201).json({ success: true, id: data.id });
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Terjadi kesalahan.' });
    }
  });

  app.patch('/api/admin/users/:id', async (req, res) => {
    try {
      const { username, password, role } = req.body;
      const update: Record<string, any> = {};
      if (username) update.username = username;
      if (role) update.role = role;
      if (password) update.password = await hashPassword(password);
      const { error } = await supabase.from('users').update(update).eq('id', req.params.id);
      if (error) throw new Error(error.message);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Gagal memperbarui user.' });
    }
  });

  app.delete('/api/admin/users/:id', async (req, res) => {
    try {
      const { error } = await supabase.from('users').delete().eq('id', req.params.id);
      if (error) throw new Error(error.message);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Gagal menghapus user.' });
    }
  });

  // ---- SETTINGS ----
  app.get('/api/admin/settings', async (_req, res) => {
    try {
      res.json(await getSettings());
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.patch('/api/admin/settings', async (req, res) => {
    try {
      const { data: row } = await supabase.from('settings').select('id').limit(1).maybeSingle();
      if (!row) {
        const { error } = await supabase.from('settings').insert(req.body);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from('settings').update(req.body).eq('id', row.id);
        if (error) throw new Error(error.message);
      }
      res.json({ success: true, settings: await getSettings() });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // ---- FILE PROXY ----
  app.get('/api/files/:bucket/:filename', async (req, res) => {
    try {
      const { bucket, filename } = req.params;
      const allowed = [EVIDENCE_BUCKET, DOCUMENTS_BUCKET, EXPORTS_BUCKET];
      if (!allowed.includes(bucket)) return res.status(400).json({ error: 'Bucket tidak dikenali.' });
      const signed = await getSignedUrl(bucket, filename, 300);
      if (!signed) return res.status(404).json({ error: 'File tidak ditemukan.' });
      res.redirect(signed);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.use('/api', (err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('API Error:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  });

  return app;
}

// =============================================================================
// VERCEL HANDLER
// =============================================================================
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
    return (app as any)(req, res);
  } catch (err: any) {
    console.error('Function runtime error:', err);
    sendJson(res, 500, {
      error: 'Function crashed',
      message: err?.message || String(err),
      stack: err?.stack
    });
  }
}

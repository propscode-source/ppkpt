import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { PassThrough } from 'stream';

import { supabase, EVIDENCE_BUCKET, DOCUMENTS_BUCKET, EXPORTS_BUCKET } from './supabase.js';
import { encrypt, decrypt } from './encryption.js';
import { uploadToStorage, downloadFromStorage, getSignedUrl } from './storage.js';
import { hashPassword, verifyPassword } from './password.js';

// Heavy/optional libs (archiver, pdfkit) loaded lazily inside the export endpoint
// to avoid breaking the entire function if these modules fail to resolve.
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
  limits: { fileSize: 50 * 1024 * 1024 } // hard ceiling; per-tenant limit enforced below
});

async function getSettings() {
  const { data, error } = await supabase.from('settings').select('*').limit(1).maybeSingle();
  if (error || !data) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...data };
}

const sizeLimitMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const settings = await getSettings();
  const maxMb = settings.max_upload_size_mb || 10;
  const maxSize = maxMb * 1024 * 1024;
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);

  if (contentLength > maxSize + 5 * 1024 * 1024) {
    return res.status(413).json({ error: `File terlalu besar. Maksimum upload adalah ${maxMb} MB.` });
  }
  next();
};

export function createApp() {
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
            mimetype: req.file.mimetype,
            size: req.file.size
          },
          'evidence'
        );
      }

      const generateTrackingCode = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = 'PPK-';
        for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
        return code;
      };

      let tracking_code = generateTrackingCode();
      for (let i = 0; i < 5; i++) {
        const { data: exists } = await supabase
          .from('reports')
          .select('id')
          .eq('tracking_code', tracking_code)
          .maybeSingle();
        if (!exists) break;
        tracking_code = generateTrackingCode();
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

      let query = supabase.from('reports').select('*').order('created_at', { ascending: false });
      if (role === 'satgas') {
        query = query.eq('assigned_to', userId);
      }
      const { data: reports, error } = await query;
      if (error) throw new Error(error.message);

      const { data: logs } = await supabase
        .from('audit_logs')
        .select('report_id, created_at');

      const lastUpdatedMap = new Map<string, string>();
      (logs || []).forEach((l) => {
        const prev = lastUpdatedMap.get(l.report_id);
        if (!prev || new Date(l.created_at) > new Date(prev)) {
          lastUpdatedMap.set(l.report_id, l.created_at);
        }
      });

      const decryptedReports = (reports || []).map((r: any) => {
        let victimName = decrypt(r.victim_name) || '';
        if (role === 'admin' && victimName) {
          victimName = victimName
            .split(' ')
            .map((p: string) => p.charAt(0) + '*'.repeat(Math.max(1, p.length - 1)))
            .join(' ');
        }
        return {
          ...r,
          reporter_name: decrypt(r.reporter_name),
          reporter_contact: decrypt(r.reporter_contact),
          reporter_identity_number: decrypt(r.reporter_identity_number),
          victim_name: victimName,
          last_updated_at: lastUpdatedMap.get(r.id) || r.created_at
        };
      });

      res.json(decryptedReports);
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

        const { data: report, error: fetchErr } = await supabase
          .from('reports')
          .select('*')
          .eq('id', reportId)
          .maybeSingle();
        if (fetchErr) throw new Error(fetchErr.message);
        if (!report) return res.status(404).json({ error: 'Report not found' });

        const prevStatus = report.status;
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };

        const update: Record<string, any> = { status };

        const uploadField = async (field: string) => {
          const f = files?.[field]?.[0];
          if (!f) return null;
          return uploadToStorage(
            DOCUMENTS_BUCKET,
            { buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype, size: f.size },
            field
          );
        };

        if (status === 'RECOMMENDED') {
          update.identitas_korban = encrypt(identitas_korban || '');
          update.identitas_saksi = encrypt(identitas_saksi || '');
          update.tanggal_surat_rekomendasi = tanggal_surat_rekomendasi;
          const ringkasan = await uploadField('file_ringkasan_kasus');
          const rekomendasi = await uploadField('file_surat_rekomendasi');
          if (ringkasan) update.file_ringkasan_kasus = ringkasan;
          if (rekomendasi) update.file_surat_rekomendasi = rekomendasi;
        }

        if (status === 'RESOLVED') {
          update.nomor_sk_sanksi = nomor_sk_sanksi;
          update.tanggal_sk_sanksi = tanggal_sk_sanksi;
          const sk = await uploadField('file_sk_sanksi');
          if (sk) update.file_sk_sanksi = sk;
        }

        const { error: updErr } = await supabase.from('reports').update(update).eq('id', reportId);
        if (updErr) throw new Error(updErr.message);

        const { error: logErr } = await supabase.from('audit_logs').insert({
          report_id: reportId,
          user_id_satgas,
          action: 'UPDATE_STATUS',
          previous_status: prevStatus,
          new_status: status,
          catatan_petugas
        });
        if (logErr) throw new Error(logErr.message);

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

      const userIds = Array.from(new Set((logs || []).map((l) => l.user_id_satgas).filter(Boolean)));
      const { data: users } = userIds.length
        ? await supabase.from('users').select('id, username').in('id', userIds)
        : { data: [] as any[] };
      const userMap = new Map((users || []).map((u: any) => [u.id, u.username]));

      const formatted = (logs || []).map((l) => ({
        ...l,
        officer_name: userMap.get(l.user_id_satgas) || 'Unknown'
      }));
      res.json(formatted);
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

      const { data: report, error: fetchErr } = await supabase
        .from('reports')
        .select('status')
        .eq('id', reportId)
        .maybeSingle();
      if (fetchErr) throw new Error(fetchErr.message);
      if (!report) return res.status(404).json({ error: 'Report not found' });

      const { error: updErr } = await supabase
        .from('reports')
        .update({ assigned_to })
        .eq('id', reportId);
      if (updErr) throw new Error(updErr.message);

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
      const archiver = await loadZipLibs();
      const PDFDocument = await loadPdf();
      const { password, username } = req.body;
      const reportId = req.params.id;

      const { data: user, error: userErr } = await supabase
        .from('users')
        .select('*')
        .eq('username', username)
        .maybeSingle();
      if (userErr) throw new Error(userErr.message);
      if (!user) return res.status(401).json({ error: 'Konfirmasi password gagal. Akses ditolak.' });

      const ok = await verifyPassword(password, user.password);
      if (!ok) return res.status(401).json({ error: 'Konfirmasi password gagal. Akses ditolak.' });

      const { data: report, error: repErr } = await supabase
        .from('reports')
        .select('*')
        .eq('id', reportId)
        .maybeSingle();
      if (repErr) throw new Error(repErr.message);
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
      const userMap = new Map((users || []).map((u: any) => [u.id, u.username]));
      const logs = (logsRaw || []).map((l: any) => ({
        ...l,
        officer_name: userMap.get(l.user_id_satgas) || 'Unknown'
      }));

      const zipPassword = crypto.randomBytes(6).toString('hex').toUpperCase();
      const zipFileName = `Export-${report.tracking_code}-${Date.now()}.zip`;

      // Build PDF in memory
      const doc = new PDFDocument({ margin: 50 });
      const pdfBuffers: Buffer[] = [];
      doc.on('data', (chunk) => pdfBuffers.push(chunk));
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
      logs.forEach((log: any, index: number) => {
        doc.text(`${index + 1}. [${log.created_at}] ${log.previous_status || 'START'} -> ${log.new_status || log.action}`);
        doc.text(`   Catatan: ${log.catatan_petugas || '-'}`, { indent: 15 });
        doc.text(`   Petugas: ${log.officer_name || 'System'}`, { indent: 15 }).moveDown(0.5);
      });
      doc.end();
      const pdfBuffer = await pdfPromise;

      // Build encrypted ZIP in memory
      const archive = archiver('zip-encrypted', {
        zlib: { level: 9 },
        encryptionMethod: 'aes256',
        password: zipPassword
      } as any);
      const passthrough = new PassThrough();
      const zipChunks: Buffer[] = [];
      passthrough.on('data', (c) => zipChunks.push(c));
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
          .map(
            (l: any) =>
              `[${l.created_at}] ${l.action}: ${l.previous_status} -> ${l.new_status} | Petugas: ${l.officer_name} | Catatan: ${l.catatan_petugas}`
          )
          .join('\n'),
        { name: 'Log/Audit-Trail-Lengkap.txt' }
      );

      await archive.finalize();
      const zipBuffer = await zipDone;

      const { error: upErr } = await supabase.storage
        .from(EXPORTS_BUCKET)
        .upload(zipFileName, zipBuffer, { contentType: 'application/zip', upsert: false });
      if (upErr) throw new Error(`Upload ZIP gagal: ${upErr.message}`);

      const signed = await getSignedUrl(EXPORTS_BUCKET, zipFileName, 60 * 60);
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

      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .eq('username', username)
        .maybeSingle();
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
      const settings = await getSettings();
      res.json(settings);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.patch('/api/admin/settings', async (req, res) => {
    try {
      const { data: row } = await supabase.from('settings').select('id').limit(1).maybeSingle();
      if (!row) {
        const { error: insErr } = await supabase.from('settings').insert(req.body);
        if (insErr) throw new Error(insErr.message);
      } else {
        const { error: updErr } = await supabase.from('settings').update(req.body).eq('id', row.id);
        if (updErr) throw new Error(updErr.message);
      }
      const settings = await getSettings();
      res.json({ success: true, settings });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // ---- FILE PROXY (signed URL redirect) ----
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

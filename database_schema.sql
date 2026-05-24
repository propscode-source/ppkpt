-- =============================================================================
-- PPKPT FASILKOM UNSRI - Schema untuk Supabase
-- Jalankan di SQL Editor Supabase (Project → SQL → New query → Run)
-- =============================================================================

-- ============ TABLES ============

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'satgas'
);

CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sla_pending INTEGER DEFAULT 7,
  sla_investigating INTEGER DEFAULT 30,
  sla_recommended INTEGER DEFAULT 7,
  sla_resolved INTEGER DEFAULT 7,
  max_upload_size_mb INTEGER DEFAULT 10,
  categories JSONB DEFAULT '["Kekerasan Fisik", "Kekerasan Psikis", "Kekerasan Seksual", "Perundungan (Bullying)", "Intoleransi", "Pelecehan Seksual via Media Elektronik", "Lainnya"]'::jsonb
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_code TEXT UNIQUE NOT NULL,
  reporter_name TEXT,
  reporter_contact TEXT,
  reporter_identity_number TEXT,
  is_anonymous BOOLEAN DEFAULT FALSE,
  victim_name TEXT,
  category TEXT,
  incident_date TEXT,
  incident_location TEXT,
  chronology TEXT,
  evidence_url TEXT,
  status TEXT DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  identitas_korban TEXT,
  identitas_saksi TEXT,
  tanggal_surat_rekomendasi TEXT,
  file_ringkasan_kasus TEXT,
  file_surat_rekomendasi TEXT,
  nomor_sk_sanksi TEXT,
  tanggal_sk_sanksi TEXT,
  file_sk_sanksi TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID REFERENCES reports(id) ON DELETE CASCADE,
  user_id_satgas UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT,
  previous_status TEXT,
  new_status TEXT,
  catatan_petugas TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ INDEXES ============

CREATE INDEX IF NOT EXISTS idx_reports_tracking_code ON reports(tracking_code);
CREATE INDEX IF NOT EXISTS idx_reports_assigned_to ON reports(assigned_to);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_report_id ON audit_logs(report_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- ============ ROW LEVEL SECURITY ============
-- API server pakai service_role key (bypass RLS), tapi RLS tetap diaktifkan
-- supaya kalau ada akses pakai anon/public key, semua tabel ter-deny by default.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- (Sengaja TIDAK dibuat policy SELECT/INSERT untuk role anon.
--  Semua akses harus lewat server pakai service_role key.)

-- ============ DEFAULT DATA ============

-- Default admin: username=admin password=password
-- Disimpan sebagai PLAINTEXT awal. Server auth memiliki fallback compare plaintext.
-- WAJIB GANTI lewat /admin → Users segera setelah login pertama —
-- saat password di-set ulang, value baru otomatis di-hash bcrypt.
INSERT INTO users (username, password, role) VALUES
  ('admin', 'password', 'admin')
ON CONFLICT (username) DO NOTHING;

INSERT INTO settings (sla_pending) VALUES (7)
ON CONFLICT DO NOTHING;

-- ============ STORAGE BUCKETS ============
-- Buat 3 bucket private. Server pakai service_role key sehingga bisa
-- baca/tulis tanpa policy tambahan. URL diakses lewat signed URL (expiring).

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('evidence',  'evidence',  false),
  ('documents', 'documents', false),
  ('exports',   'exports',   false)
ON CONFLICT (id) DO NOTHING;

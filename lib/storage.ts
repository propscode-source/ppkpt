import { supabase } from './supabase.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export async function uploadToStorage(
  bucket: string,
  file: UploadedFile,
  prefix = ''
): Promise<string> {
  const ext = path.extname(file.originalname);
  const filename = `${prefix}${prefix ? '-' : ''}${Date.now()}-${uuidv4()}${ext}`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(filename, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });

  if (error) throw new Error(`Upload gagal: ${error.message}`);
  return filename;
}

export async function downloadFromStorage(bucket: string, path: string): Promise<Buffer | null> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return null;
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function getSignedUrl(
  bucket: string,
  path: string,
  expiresIn = 3600
): Promise<string | null> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (error || !data) return null;
  return data.signedUrl;
}

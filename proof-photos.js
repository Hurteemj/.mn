/* proof-photos.js
 * Proof-of-volunteering photos: per-event requirement (set by the organization)
 * and photo uploads (done by volunteers).
 *
 * Needs the global `supabaseClient` from supabase-client.js, so load it AFTER that file.
 * Database setup: run proof_photos_migration.sql once in the Supabase SQL editor.
 */

const PROOF_BUCKET = 'proof-photos';
const PROOF_LIMITS = {
  minAllowed: 1,            // an org may not ask for fewer than 1 photo
  maxAllowed: 10,           // ...or more than 10
  descMax: 500,             // characters in the "what should the photo show" text
  maxDimension: 1600,       // photos are downscaled to this many px on the long edge
  fileMaxBytes: 5 * 1024 * 1024,
  signedUrlSeconds: 3600,
};
const PROOF_DEFAULT_REQ = { required: false, min: 1, max: 3, description: '' };

/* ---------- requirement (organization side) ---------- */

function normalizeProofRequirement(row) {
  if (!row) return { ...PROOF_DEFAULT_REQ };
  return {
    required: !!row.proof_required,
    min: row.proof_min_photos || PROOF_DEFAULT_REQ.min,
    max: row.proof_max_photos || PROOF_DEFAULT_REQ.max,
    description: row.proof_description || '',
  };
}

/** Returns an error message (Mongolian) or null when the requirement is valid. */
function validateProofRequirement(req) {
  if (!req.required) return null;
  const { minAllowed, maxAllowed, descMax } = PROOF_LIMITS;
  if (!Number.isInteger(req.min) || req.min < minAllowed || req.min > maxAllowed) {
    return `Доод хэмжээ ${minAllowed}–${maxAllowed} хооронд бүхэл тоо байх ёстой.`;
  }
  if (!Number.isInteger(req.max) || req.max < req.min || req.max > maxAllowed) {
    return `Дээд хэмжээ доод хэмжээнээс багагүй, ${maxAllowed}-аас ихгүй бүхэл тоо байх ёстой.`;
  }
  const desc = (req.description || '').trim();
  if (!desc) return 'Ямар зураг оруулахыг тайлбарлана уу.';
  if (desc.length > descMax) return `Тайлбар ${descMax} тэмдэгтээс хэтрэхгүй байх ёстой.`;
  return null;
}

async function getProofRequirement(opportunityId) {
  const { data, error } = await supabaseClient
    .from('opportunities')
    .select('proof_required, proof_min_photos, proof_max_photos, proof_description')
    .eq('id', opportunityId)
    .maybeSingle();
  if (error) throw error;
  return normalizeProofRequirement(data);
}

async function saveProofRequirement(opportunityId, req) {
  const problem = validateProofRequirement(req);
  if (problem) throw new Error(problem);

  const payload = req.required
    ? {
        proof_required: true,
        proof_min_photos: req.min,
        proof_max_photos: req.max,
        proof_description: req.description.trim(),
      }
    // Turning it off keeps the previous numbers/text so the org can switch it back on.
    : { proof_required: false };

  const { data, error } = await supabaseClient
    .from('opportunities')
    .update(payload)
    .eq('id', opportunityId)
    .select('proof_required, proof_min_photos, proof_max_photos, proof_description')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Хадгалах эрх олдсонгүй.');
  return normalizeProofRequirement(data);
}

/** Volunteer side: requirement for each of my applications -> { [applicationId]: requirement } */
async function getProofRequirementsByApplication(applicationIds) {
  const ids = (applicationIds || []).filter(id => !String(id).startsWith('cert-'));
  if (!ids.length) return {};
  const { data, error } = await supabaseClient
    .from('applications')
    .select('id, opportunities(proof_required, proof_min_photos, proof_max_photos, proof_description)')
    .in('id', ids);
  if (error) throw error;
  const out = {};
  (data || []).forEach(row => {
    const opp = Array.isArray(row.opportunities) ? row.opportunities[0] : row.opportunities;
    out[String(row.id)] = normalizeProofRequirement(opp);
  });
  return out;
}

/* ---------- photos ---------- */

/** -> { [applicationId]: [{ id, url, path, createdAt }] } (oldest first) */
async function getProofPhotos(applicationIds) {
  const ids = (applicationIds || []).filter(id => !String(id).startsWith('cert-'));
  if (!ids.length) return {};

  const { data, error } = await supabaseClient
    .from('application_proof_photos')
    .select('id, application_id, storage_path, created_at')
    .in('application_id', ids)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) return {};

  const { data: signed, error: signError } = await supabaseClient.storage
    .from(PROOF_BUCKET)
    .createSignedUrls(rows.map(r => r.storage_path), PROOF_LIMITS.signedUrlSeconds);
  if (signError) throw signError;
  const urlByPath = {};
  (signed || []).forEach(s => { if (s.signedUrl) urlByPath[s.path] = s.signedUrl; });

  const out = {};
  rows.forEach(r => {
    const key = String(r.application_id);
    (out[key] = out[key] || []).push({
      id: r.id,
      path: r.storage_path,
      url: urlByPath[r.storage_path] || '',
      createdAt: r.created_at,
    });
  });
  return out;
}

async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    try { return await createImageBitmap(file); } catch (__) { return null; }
  }
}

/** Downscales + re-encodes as JPEG so phone photos upload quickly. */
async function prepareProofImage(file) {
  if (!file || !/^image\//.test(file.type)) {
    throw new Error('Зөвхөн зураг (JPG, PNG, WebP) оруулна уу.');
  }
  const bitmap = await decodeImage(file);
  if (!bitmap) {
    // Browser can't decode it (e.g. HEIC). Upload as-is only if it is a supported type.
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && file.size <= PROOF_LIMITS.fileMaxBytes) {
      return file;
    }
    throw new Error('Энэ зургийг уншиж чадсангүй. JPG эсвэл PNG форматтай зураг ашиглана уу.');
  }
  const scale = Math.min(1, PROOF_LIMITS.maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Зургийг боловсруулж чадсангүй.');
  if (blob.size > PROOF_LIMITS.fileMaxBytes) throw new Error('Зураг хэт том байна (5MB-аас бага байх ёстой).');
  return blob;
}

function proofErrorMessage(err) {
  const msg = (err && err.message) || String(err);
  if (msg.includes('proof_photo_limit_reached')) return 'Зургийн дээд хэмжээнд хүрсэн байна.';
  if (msg.includes('proof_photos_not_required')) return 'Энэ ажилд нотолгооны зураг шаардаагүй байна.';
  return msg;
}

async function uploadProofPhoto(applicationId, file) {
  const { data: userData } = await supabaseClient.auth.getUser();
  const user = userData && userData.user;
  if (!user) throw new Error('Нэвтэрч орно уу.');

  const blob = await prepareProofImage(file);
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${user.id}/${applicationId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error: upError } = await supabaseClient.storage
    .from(PROOF_BUCKET)
    .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
  if (upError) throw new Error(proofErrorMessage(upError));

  const { data, error } = await supabaseClient
    .from('application_proof_photos')
    .insert({ application_id: applicationId, volunteer_id: user.id, storage_path: path })
    .select('id')
    .single();
  if (error) {
    await supabaseClient.storage.from(PROOF_BUCKET).remove([path]); // don't leave an orphan file
    throw new Error(proofErrorMessage(error));
  }
  return data;
}

async function deleteProofPhoto(photo) {
  const { error } = await supabaseClient.from('application_proof_photos').delete().eq('id', photo.id);
  if (error) throw error;
  await supabaseClient.storage.from(PROOF_BUCKET).remove([photo.path]);
}

/* ---------- display helpers ---------- */

function proofRangeText(req) {
  return req.min === req.max ? `${req.min} зураг` : `${req.min}–${req.max} зураг`;
}

/** count = photos already submitted (including any legacy attendance photo) */
function proofState(req, count) {
  if (!req || !req.required) {
    return { required: false, ok: true, count, missing: 0, slotsLeft: 0, canAdd: false };
  }
  return {
    required: true,
    ok: count >= req.min,
    count,
    missing: Math.max(0, req.min - count),
    slotsLeft: Math.max(0, req.max - count),
    canAdd: count < req.max,
  };
}

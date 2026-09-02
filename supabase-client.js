
const SUPABASE_URL = "https://ojakrptuwdngewmuazgg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HRKweLS7ovBiNtR8K7Un8g_q9Dn8kEV";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function isCurrentUserAdmin() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return false;

  const { data, error } = await supabaseClient
    .from('admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    console.error('Admin check failed:', error.message);
    return false;
  }
  return !!data;
}

async function redirectIfLoggedIn() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;

  if (await isCurrentUserAdmin()) {
    window.location.href = 'admin_review.html';
    return;
  }

  const profile = await getCurrentProfile();
  window.location.href = (profile && profile.role === 'org') ? 'main_org.html' : 'main_vol.html';
}

async function requireSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = "login.html";
    return null;
  }
  return session;
}

async function getCurrentProfile() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;

  const { data: volunteer, error: volunteerError } = await supabaseClient
    .from("volunteers")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (volunteerError) {
    console.error("Failed to load volunteer profile:", volunteerError.message);
  }
  if (volunteer) return { ...volunteer, role: "volunteer" };

  const { data: org, error: orgError } = await supabaseClient
    .from("organizations")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (orgError) {
    console.error("Failed to load organization profile:", orgError.message);
  }
  if (org) return { ...org, role: "org" };

  console.error("No volunteer or organization row found for user:", user.id);
  return null;
}

async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.href = "login.html";
}

async function getPlatformStats() {
  const { data, error } = await supabaseClient.rpc('get_platform_stats');
  if (error) {
    console.error("Failed to load platform stats:", error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    volunteerCount: Number(row.volunteer_count) || 0,
    organizationCount: Number(row.organization_count) || 0,
    totalHours: Number(row.total_hours) || 0,
  };
}

const OPPORTUNITY_CATEGORY_LABELS = {
  education: "Боловсрол",
  environment: "Байгаль орчин",
  health: "Эрүүл мэнд",
  animals: "Амьтан хамгаалал",
  community: "Нийгэм",
  other: "Бусад",
};

async function getOrganizationsDirectory(search = "") {
  let orgQuery = supabaseClient.from("organizations_public").select("id, org_name, about, city, verification_status, avatar_url, website, about_page");
  if (search && search.trim()) {
    orgQuery = orgQuery.ilike("org_name", `%${search.trim()}%`);
  }

  const { data: orgs, error: orgError } = await orgQuery.order("org_name");
  if (orgError) {
    console.error("Failed to load organizations:", orgError.message);
    return [];
  }
  if (!orgs || orgs.length === 0) return [];

  const { data: opps, error: oppError } = await supabaseClient
    .from("opportunities")
    .select("org_id, category")
    .eq("status", "active")
    .in("org_id", orgs.map(o => o.id));
  if (oppError) {
    console.error("Failed to load opportunity counts:", oppError.message);
  }

  const statsByOrg = {};
  for (const opp of (opps || [])) {
    const s = statsByOrg[opp.org_id] || (statsByOrg[opp.org_id] = { count: 0, byCategory: {} });
    s.count += 1;
    s.byCategory[opp.category] = (s.byCategory[opp.category] || 0) + 1;
  }

  return orgs.map(org => {
    const s = statsByOrg[org.id];
    let categoryLabel = "";
    if (s) {
      const topCategory = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1])[0][0];
      categoryLabel = OPPORTUNITY_CATEGORY_LABELS[topCategory] || "";
    }
    const about = normalizeAboutPage(org.about_page);
    return {
      id: org.id,
      orgName: org.org_name,
      about: org.about,
      city: org.city,
      jobCount: s ? s.count : 0,
      category: categoryLabel,
      verificationStatus: org.verification_status,
      avatarUrl: org.avatar_url,
      website: org.website,
      socialLinks: about.social_links,
    };
  });
}

async function getOrgApplicants() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return [];

  const { data: opps, error: oppError } = await supabaseClient
    .from("opportunities")
    .select("id, title, hours_estimate, experience_required, experience_question, motivation_question")
    .eq("org_id", user.id);
  if (oppError) {
    console.error("Failed to load opportunities for applicants:", oppError.message);
    return [];
  }
  if (!opps || opps.length === 0) return [];

  const oppById = {};
  opps.forEach(o => { oppById[o.id] = o; });

  const { data: apps, error: appError } = await supabaseClient
    .from("applications")
    .select(`
      id,
      status,
      hours_logged,
      applied_at,
      opportunity_id,
      applicant_experience,
      applicant_motivation,
      volunteer:volunteers ( id, first_name, last_name, birthdate, phone, city, interests, about, avatar_url, instagram_url, facebook_url, workplace, education )
    `)
    .in("opportunity_id", opps.map(o => o.id))
    .order("applied_at", { ascending: false });
  if (appError) {
    console.error("Failed to load applicants:", appError.message);
    return [];
  }

  return (apps || []).map(a => ({ ...a, opportunity: oppById[a.opportunity_id] }));
}

async function getOpportunityById(oppId) {
  const { data, error } = await supabaseClient
    .from("opportunities")
    .select("*")
    .eq("id", oppId)
    .single();
  if (error) {
    console.error("Failed to load opportunity:", error.message);
    return null;
  }
  return data;
}

async function getMyApplicationForOpportunity(oppId) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabaseClient
    .from("applications")
    .select("id, status, hours_logged")
    .eq("opportunity_id", oppId)
    .eq("volunteer_id", user.id)
    .maybeSingle();
  if (error) {
    console.error("Failed to load my application:", error.message);
    return null;
  }
  return data;
}

async function getApplicantsForOpportunity(oppId) {
  const { data, error } = await supabaseClient
    .from("applications")
    .select(`
      id, status, hours_logged, applied_at, opportunity_id,
      applicant_experience, applicant_motivation,
      volunteer:volunteers ( id, first_name, last_name, birthdate, phone, city, interests, about, avatar_url, instagram_url, facebook_url, workplace, education )
    `)
    .eq("opportunity_id", oppId)
    .order("applied_at", { ascending: false });
  if (error) {
    console.error("Failed to load applicants for opportunity:", error.message);
    return [];
  }
  return data || [];
}

async function confirmApplication(applicationId) {
  const { error } = await supabaseClient
    .from("applications")
    .update({ status: "confirmed" })
    .eq("id", applicationId);
  if (error) throw error;
}

async function declineApplication(applicationId) {
  const { error } = await supabaseClient
    .from("applications")
    .update({ status: "cancelled" })
    .eq("id", applicationId);
  if (error) throw error;
}

async function completeApplication(applicationId, hoursLogged) {
  const { error } = await supabaseClient
    .from("applications")
    .update({ status: "completed", hours_logged: hoursLogged })
    .eq("id", applicationId);
  if (error) throw error;
}

const CERTIFICATE_BUCKET = "certificates";

async function getCertificateTemplate(orgId) {
  const { data, error } = await supabaseClient
    .from("certificate_templates")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("Failed to load certificate template:", error.message);
    return null;
  }
  return data;
}

async function saveCertificateTemplate({ file, xPercent, yPercent, fontSize, fontColor }) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const payload = {
    org_id: user.id,
    name_x: xPercent,
    name_y: yPercent,
    font_size: fontSize,
    font_color: fontColor,
    updated_at: new Date().toISOString(),
  };

  if (file) {
    const storagePath = `${user.id}/template.png`;
    const { error: uploadError } = await supabaseClient.storage
      .from(CERTIFICATE_BUCKET)
      .upload(storagePath, file, { upsert: true, contentType: "image/png" });
    if (uploadError) throw uploadError;
    payload.storage_path = storagePath;
  } else {

    const existing = await getCertificateTemplate(user.id);
    if (!existing || !existing.storage_path) {
      throw new Error("Эхлээд загвар зургаа оруулна уу.");
    }
    payload.storage_path = existing.storage_path;
  }

  const { data, error } = await supabaseClient
    .from("certificate_templates")
    .upsert(payload, { onConflict: "org_id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

function getCertificateTemplateUrl(storagePath, cacheBust) {
  const { data } = supabaseClient.storage.from(CERTIFICATE_BUCKET).getPublicUrl(storagePath);
  if (!data) return null;
  return cacheBust ? `${data.publicUrl}?v=${encodeURIComponent(cacheBust)}` : data.publicUrl;
}

function _loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Загвар зургийг ачаалж чадсангүй."));
    img.src = src;
  });
}

async function _drawCertificate(img, name, template) {
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (e) {  }
  }

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const fontSize = Number(template.font_size) || 28;
  ctx.font = `600 ${fontSize}px "Golos Text", Arial, sans-serif`;
  ctx.fillStyle = template.font_color || "#1a1a1a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const x = (Number(template.name_x) / 100) * canvas.width;
  const y = (Number(template.name_y) / 100) * canvas.height;
  ctx.fillText(name, x, y);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b); else reject(new Error("Зураг үүсгэхэд алдаа гарлаа."));
    }, "image/png");
  });

  return {
    blob,
    pixelX: Math.round(x),
    pixelY: Math.round(y),
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    fontSize,
  };
}

async function buildCertificateImage(templateUrl, name, template) {
  const img = await _loadImage(templateUrl);
  return _drawCertificate(img, name, template);
}

async function buildCertificateImageFromFile(file, name, template) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await _loadImage(objectUrl);
    return await _drawCertificate(img, name, template);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

const CERTIFICATES_TABLE = "certificates";

async function issueCertificate(applicationId) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const { data: app, error: appError } = await supabaseClient
    .from("applications")
    .select(`
      id, status, opportunity_id, hours_logged,
      volunteer:volunteers ( id, first_name, last_name ),
      opportunity:opportunities ( id, title, org_id, organization:organizations ( org_name ) )
    `)
    .eq("id", applicationId)
    .single();
  if (appError) throw appError;
  if (!app || app.status !== "completed") {
    throw new Error("Зөвхөн дууссан ажилд гэрчилгээ үүсгэнэ.");
  }

  const orgId = app.opportunity.org_id;
  const template = await getCertificateTemplate(orgId);
  if (!template) throw new Error("Энэ байгууллага гэрчилгээний загвар байршуулаагүй байна.");

  const fullName = [app.volunteer.first_name, app.volunteer.last_name].filter(Boolean).join(" ") || "Сайн дурын ажилтан";
  const templateUrl = getCertificateTemplateUrl(template.storage_path, template.updated_at);
  const result = await buildCertificateImage(templateUrl, fullName, template);

  const storagePath = `${orgId}/${app.volunteer.id}/${app.opportunity_id}.png`;
  const { error: uploadError } = await supabaseClient.storage
    .from(CERTIFICATE_BUCKET)
    .upload(storagePath, result.blob, { upsert: true, contentType: "image/png" });
  if (uploadError) throw uploadError;

  const { data: certRow, error: certError } = await supabaseClient
    .from(CERTIFICATES_TABLE)
    .upsert({
      application_id: app.id,
      volunteer_id: app.volunteer.id,
      opportunity_id: app.opportunity_id,
      org_id: orgId,
      org_name: app.opportunity.organization ? app.opportunity.organization.org_name : null,
      opportunity_title: app.opportunity.title,
      hours_logged: app.hours_logged,
      storage_path: storagePath,
      issued_at: new Date().toISOString(),
    }, { onConflict: "application_id" })
    .select()
    .single();
  if (certError) throw certError;

  return { ...certRow, url: getCertificateTemplateUrl(storagePath, certRow.issued_at) };
}

async function getIssuedCertificates(applicationIds) {
  if (!applicationIds || applicationIds.length === 0) return {};
  const { data, error } = await supabaseClient
    .from(CERTIFICATES_TABLE)
    .select("application_id, storage_path, issued_at")
    .in("application_id", applicationIds);
  if (error) {
    console.error("Failed to load issued certificates:", error.message);
    return {};
  }
  const byApp = {};
  (data || []).forEach(c => { byApp[c.application_id] = c; });
  return byApp;
}

async function getMyCertificates() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabaseClient
    .from(CERTIFICATES_TABLE)
    .select(`
      id, application_id, storage_path, issued_at, org_name, opportunity_title, hours_logged,
      opportunity:opportunities!left ( id, title, organization:organizations!left ( org_name ) )
    `)
    .eq("volunteer_id", user.id)
    .order("issued_at", { ascending: false });
  if (error) {
    console.error("Failed to load certificates:", error.message);
    return [];
  }

  return (data || []).map(c => ({
    ...c,
    url: getCertificateTemplateUrl(c.storage_path, c.issued_at),
    displayOrgName: (c.opportunity && c.opportunity.organization && c.opportunity.organization.org_name) || c.org_name || "Байгууллага",
    displayOpportunityTitle: (c.opportunity && c.opportunity.title) || c.opportunity_title || "Ажил",
  }));
}

async function updateVolunteerProfile(fields) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const { data, error } = await supabaseClient
    .from("volunteers")
    .update(fields)
    .eq("id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getMyActivities() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabaseClient
    .from("applications")
    .select(`
      id,
      status,
      hours_logged,
      applied_at,
      opportunity:opportunities (
        id,
        title,
        event_date,
        schedule_note,
        is_recurring,
        hours_estimate,
        organization:organizations ( id, org_name, verification_status )
      )
    `)
    .eq("volunteer_id", user.id)
    .order("applied_at", { ascending: false });

  if (error) {
    console.error("Failed to load activities:", error.message);
    return [];
  }
  return data || [];
}

async function getMyHoursSummary() {
  const activities = await getMyActivities();
  const live = activities.filter(a => a.status !== "cancelled");

  const totalHours = live.reduce((sum, a) => sum + (Number(a.hours_logged) || 0), 0);
  const activeCount = live.filter(a => a.status === "pending" || a.status === "confirmed").length;
  const doneCount = live.filter(a => a.status === "completed").length;

  return { totalHours, activeCount, doneCount, activities: live };
}

async function getOpenOpportunities({ search = "", category = "" } = {}) {
  let query = supabaseClient
    .from("opportunities")
    .select(`
      id, title, description, category, location_type, location_label,
      is_recurring, event_date, schedule_note, hours_estimate,
      volunteers_needed, status, created_at,
      experience_required, experience_needed, benefits_provided, certificate_type,
      experience_question, motivation_question,
      organization:organizations ( id, org_name, verification_status )
    `)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (category) query = query.eq("category", category);
  if (search && search.trim()) query = query.ilike("title", `%${search.trim()}%`);

  const { data: opps, error } = await query;
  if (error) {
    console.error("Failed to load opportunities:", error.message);
    return [];
  }
  if (!opps || opps.length === 0) return [];

  const { data: stats, error: statsError } = await supabaseClient
    .from("opportunity_stats")
    .select("*")
    .in("opportunity_id", opps.map(o => o.id));
  if (statsError) {
    console.error("Failed to load opportunity stats:", statsError.message);
  }
  const countsById = {};
  (stats || []).forEach(s => { countsById[s.opportunity_id] = s.applicant_count; });

  return opps.map(o => ({ ...o, applicant_count: countsById[o.id] || 0 }));
}

async function getAllOrgsForAdmin() {
  const { data, error } = await supabaseClient
    .from("organizations")
    .select("*")
    .order("org_name");

  if (error) {
    console.error("Failed to load organizations for admin:", error.message);
    return [];
  }
  return data || [];
}

async function setBanned(orgId, banned) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot update ban status");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("organizations")
    .update({ banned })
    .eq("id", orgId)
    .select();

  if (error) {
    console.error("Ban update failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) {
    console.error("Ban update affected 0 rows — likely blocked by an RLS policy.");
    return null;
  }
  return data;
}

async function getPendingOrgs() {
  const { data, error } = await supabaseClient
    .from("organizations")
    .select("*")
    .eq("verification_status", "pending");

  if (error) {
    console.error("Failed to load pending orgs:", error.message);
    return [];
  }
  return data || [];
}

async function setVerification(orgId, status, notes = "") {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot update verification status");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("organizations")
    .update({
      verification_status: status,
      verified_at: new Date().toISOString(),
      verified_by: user.id,
      verification_notes: notes,
    })
    .eq("id", orgId)
    .select();

  if (error) {
    console.error("Update failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) {
    console.error("Update affected 0 rows — likely blocked by an RLS policy.");
    return null;
  }
  return data;
}

function normalizeAboutPage(raw) {
  return {
    founded_year: (raw && raw.founded_year) || '',
    focus_tags: (raw && raw.focus_tags) || [],
    paragraphs: (raw && raw.paragraphs) || [],
    mission: (raw && raw.mission) || '',
    social_links: (raw && raw.social_links) || [],
  };
}

async function updateOrgProfile(fields) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const { data, error } = await supabaseClient
    .from("organizations")
    .update(fields)
    .eq("id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function uploadOrgAvatar(file) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${user.id}/avatar.${ext}`;

  const { error: uploadError } = await supabaseClient
    .storage
    .from('org-avatars')
    .upload(path, file, { upsert: true, cacheControl: '3600' });
  if (uploadError) throw uploadError;

  const { data: urlData } = supabaseClient
    .storage
    .from('org-avatars')
    .getPublicUrl(path);

  const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

  const { data, error } = await supabaseClient
    .from("organizations")
    .update({ avatar_url: publicUrl })
    .eq("id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getOrganizationById(orgId) {
  const { data, error } = await supabaseClient
    .from("organizations_public")
    .select("*")
    .eq("id", orgId)
    .maybeSingle();
  if (error) {
    console.error("Failed to load organization:", error.message);
    return null;
  }
  return data;
}

async function getOpportunitiesByOrg(orgId) {
  const { data: opps, error } = await supabaseClient
    .from("opportunities")
    .select(`
      id, title, description, category, location_type, location_label,
      is_recurring, event_date, schedule_note, hours_estimate,
      volunteers_needed, status, created_at
    `)
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("Failed to load organization's opportunities:", error.message);
    return [];
  }
  if (!opps || opps.length === 0) return [];

  const { data: stats, error: statsError } = await supabaseClient
    .from("opportunity_stats")
    .select("*")
    .in("opportunity_id", opps.map(o => o.id));
  if (statsError) {
    console.error("Failed to load opportunity stats:", statsError.message);
  }
  const countsById = {};
  (stats || []).forEach(s => { countsById[s.opportunity_id] = s.applicant_count; });

  return opps.map(o => ({ ...o, applicant_count: countsById[o.id] || 0 }));
}

async function deleteOwnAccount() {
  const { error } = await supabaseClient.rpc('delete_own_account');
  if (error) throw error;
}

const REPORT_REASON_LABELS = {
  spam: 'Спам / хуурамч',
  scam: 'Луйвар / мөнгө шаардсан',
  inappropriate: 'Зохисгүй контент',
  no_show: 'Ажил зарлаад юу ч хийгээгүй',
  other: 'Бусад шалтгаан',
};

async function reportOrganization(orgId, reason, details = "") {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot submit report");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("org_reports")
    .insert({
      org_id: orgId,
      reporter_id: user.id,
      reason,
      details,
    })
    .select()
    .single();

  if (error) {
    console.error("Report submission failed:", error.message);
    return null;
  }
  return data;
}

async function reportOpportunity(opportunityId, orgId, reason, details = "") {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot submit report");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("org_reports")
    .insert({
      org_id: orgId,
      opportunity_id: opportunityId,
      reporter_id: user.id,
      reason,
      details,
    })
    .select()
    .single();

  if (error) {
    console.error("Report submission failed:", error.message);
    return null;
  }
  return data;
}

async function getAllReportsForAdmin() {
  const { data, error } = await supabaseClient
    .from("org_reports")
    .select(`
      id, reason, details, status, created_at, resolved_at, resolved_notes,
      organization:organizations ( id, org_name, verification_status, banned ),
      opportunity:opportunities ( id, title )
    `)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load reports for admin:", error.message);
    return [];
  }
  return data || [];
}

async function resolveReport(reportId, status, notes = "") {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot update report");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("org_reports")
    .update({
      status,
      resolved_at: status === 'open' ? null : new Date().toISOString(),
      resolved_by: user.id,
      resolved_notes: notes,
    })
    .eq("id", reportId)
    .select();

  if (error) {
    console.error("Report update failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) {
    console.error("Report update affected 0 rows — likely blocked by an RLS policy.");
    return null;
  }
  return data;
}

async function submitFeedback({ name, email, message }) {

  const { error } = await supabaseClient
    .from("feedback")
    .insert({ name, email, message });
  if (error) throw error;
}

async function getAllFeedbackForAdmin() {
  const { data, error } = await supabaseClient
    .from("feedback")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("Failed to load feedback:", error.message);
    return [];
  }
  return data || [];
}

async function updateFeedbackStatus(feedbackId, status) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot update feedback status");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("feedback")
    .update({ status })
    .eq("id", feedbackId)
    .select();

  if (error) {
    console.error("Feedback status update failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) {
    console.error("Feedback update affected 0 rows — likely blocked by an RLS policy.");
    return null;
  }
  return data;
}

async function uploadVolunteerAvatar(file) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${user.id}/avatar.${ext}`;

  const { error: uploadError } = await supabaseClient
    .storage
    .from('volunteer-avatars')
    .upload(path, file, { upsert: true, cacheControl: '3600' });
  if (uploadError) throw uploadError;

  const { data: urlData } = supabaseClient
    .storage
    .from('volunteer-avatars')
    .getPublicUrl(path);

  const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

  const { data, error } = await supabaseClient
    .from("volunteers")
    .update({ avatar_url: publicUrl })
    .eq("id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

const OPPORTUNITY_IMAGE_BUCKET = "opportunity-images";

async function uploadOpportunityImage(oppId, file) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const path = `${user.id}/${oppId}.png`;

  const { error: uploadError } = await supabaseClient
    .storage
    .from(OPPORTUNITY_IMAGE_BUCKET)
    .upload(path, file, { upsert: true, cacheControl: '3600', contentType: 'image/png' });
  if (uploadError) throw uploadError;

  const { data: urlData } = supabaseClient
    .storage
    .from(OPPORTUNITY_IMAGE_BUCKET)
    .getPublicUrl(path);

  const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

  const { data, error } = await supabaseClient
    .from("opportunities")
    .update({ image_url: publicUrl })
    .eq("id", oppId)
    .eq("org_id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function removeOpportunityImage(oppId) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const path = `${user.id}/${oppId}.png`;
  const { error: removeError } = await supabaseClient.storage.from(OPPORTUNITY_IMAGE_BUCKET).remove([path]);
  if (removeError) {

    console.error("Failed to delete opportunity image file:", removeError.message);
  }

  const { data, error } = await supabaseClient
    .from("opportunities")
    .update({ image_url: null })
    .eq("id", oppId)
    .eq("org_id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

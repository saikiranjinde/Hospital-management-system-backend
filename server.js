require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const app = express();

// ── CORS ───────────────────────────────────────────────────────────
app.use(cors({ origin: "*", methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.options("*", cors());
app.use(express.json());

// ── Force JSON on all /api routes (prevents <!DOCTYPE> JSON error) ─
app.use("/api", (req, res, next) => { res.setHeader("Content-Type","application/json"); next(); });

// ── Supabase ───────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const JWT_SECRET = process.env.JWT_SECRET || "medicare_jwt_secret_2025";

// ── Admin credentials ──────────────────────────────────────────────
const ADMIN_ID   = "admin@123";
const ADMIN_PASS = "9529007961";

// ── Auth middleware ────────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid or expired token" }); }
};
const adminAuth = (req, res, next) =>
  auth(req, res, () => req.user.is_admin ? next() : res.status(403).json({ error: "Admin only" }));

// ── Gemini key helper ──────────────────────────────────────────────
async function getGeminiKey() {
  try {
    const { data } = await supabase.from("settings").select("value").eq("key","gemini_api_key").single();
    const db  = (data?.value || "").trim();
    const env = (process.env.GEMINI_API_KEY || "").trim();
    if (db.length > 20)  return db;
    if (env.length > 20) return env;
    return null;
  } catch {
    const env = (process.env.GEMINI_API_KEY || "").trim();
    return env.length > 20 ? env : null;
  }
}

// ── Gemini REST call via fetch() — NO SDK, prevents Project Id error
async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1500 }
    })
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || ` ${resp.status}`);
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty Gemini response");
  return text;
}

// ══ AUTH ══════════════════════════════════════════════════════════
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, phone, age, blood_group } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Name, email, password required" });
    const { data: ex } = await supabase.from("users").select("id").eq("email", email).single();
    if (ex) return res.status(409).json({ error: "Email already registered" });
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const { error } = await supabase.from("users").insert({
      id, name, email, password: hashed, phone: phone||null,
      age: age ? parseInt(age) : null, blood_group: blood_group||null, is_admin: false, is_active: true
    });
    if (error) throw error;
    const token = jwt.sign({ id, email, name, is_admin: false }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id, name, email, phone, age, blood_group, is_admin: false } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (email === ADMIN_ID && password === ADMIN_PASS) {
      const token = jwt.sign({ id: "admin", email: ADMIN_ID, name: "Administrator", is_admin: true }, JWT_SECRET, { expiresIn: "7d" });
      return res.json({ token, user: { id: "admin", name: "Administrator", email: ADMIN_ID, is_admin: true } });
    }
    const { data: user, error } = await supabase.from("users").select("*").eq("email", email).single();
    if (error || !user) return res.status(404).json({ error: "User not found" });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: "Incorrect password" });
    if (!user.is_active) return res.status(403).json({ error: "Account blocked. Contact admin." });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: "7d" });
    const { password: _, ...safe } = user;
    res.json({ token, user: safe });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/auth/me", auth, async (req, res) => {
  try {
    if (req.user.is_admin && req.user.id === "admin")
      return res.json({ id: "admin", name: "Administrator", email: ADMIN_ID, is_admin: true });
    const { data, error } = await supabase.from("users").select("*").eq("id", req.user.id).single();
    if (error || !data) return res.status(404).json({ error: "User not found" });
    const { password: _, ...safe } = data;
    res.json(safe);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ DOCTORS ═══════════════════════════════════════════════════════
app.get("/api/doctors", async (req, res) => {
  const { data, error } = await supabase.from("doctors").select("*").eq("is_active", true).order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.get("/api/admin/doctors", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("doctors").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.post("/api/admin/doctors", adminAuth, async (req, res) => {
  try {
    const { name, specialization, qualification, experience, email, phone,
      available_days, available_time_start, available_time_end, consultation_fee } = req.body;
    if (!name || !specialization) return res.status(400).json({ error: "Name and specialization required" });
    const { data, error } = await supabase.from("doctors").insert({
      id: uuidv4(), name, specialization, qualification: qualification||null,
      experience: experience ? parseInt(experience) : 0, email: email||null, phone: phone||null,
      available_days: available_days || ["Monday","Tuesday","Wednesday","Thursday","Friday"],
      available_time_start: available_time_start||"09:00",
      available_time_end: available_time_end||"17:00",
      consultation_fee: consultation_fee ? parseInt(consultation_fee) : 500,
      is_active: true, is_available_today: true
    }).select().single();
    if (error) throw error;
    res.json({ message: "Doctor added", doctor: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/api/admin/doctors/:id", adminAuth, async (req, res) => {
  const { error } = await supabase.from("doctors").update({ ...req.body, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "Doctor updated" });
});
app.delete("/api/admin/doctors/:id", adminAuth, async (req, res) => {
  const { error } = await supabase.from("doctors").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "Doctor deactivated" });
});
app.patch("/api/admin/doctors/:id/availability", adminAuth, async (req, res) => {
  const { is_available_today, available_days, available_time_start, available_time_end } = req.body;
  const { error } = await supabase.from("doctors").update({
    is_available_today, available_days, available_time_start, available_time_end,
    updated_at: new Date().toISOString()
  }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "Availability updated" });
});

// ══ BOOKINGS ══════════════════════════════════════════════════════
app.post("/api/bookings", auth, async (req, res) => {
  try {
    const { doctor_id, doctor_name, specialization, patient_name, patient_age, problem, appointment_date, appointment_time } = req.body;
    if (!doctor_id || !problem || !appointment_date || !appointment_time)
      return res.status(400).json({ error: "Missing required fields" });
    const { data, error } = await supabase.from("bookings").insert({
      id: uuidv4(), user_id: req.user.id, user_name: req.user.name, user_email: req.user.email,
      doctor_id, doctor_name: doctor_name||"", specialization: specialization||"",
      patient_name: patient_name||req.user.name, patient_age: patient_age ? parseInt(patient_age) : null,
      problem, appointment_date, appointment_time, status: "pending", admin_notes: null, ai_suggestion: null
    }).select().single();
    if (error) throw error;
    await supabase.from("notifications").insert({
      id: uuidv4(), user_id: req.user.id, title: "Appointment Submitted 🎉",
      message: `Your appointment with Dr. ${doctor_name} on ${appointment_date} at ${appointment_time} is received.`,
      type: "booking", is_read: false
    });
    res.json({ message: "Booking created", booking: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/api/bookings", auth, async (req, res) => {
  const { data, error } = await supabase.from("bookings").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.get("/api/admin/bookings", adminAuth, async (req, res) => {
  try {
    let q = supabase.from("bookings").select("*").order("created_at", { ascending: false });
    if (req.query.status && req.query.status !== "all") q = q.eq("status", req.query.status);
    if (req.query.date) q = q.eq("appointment_date", req.query.date);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch("/api/admin/bookings/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_notes, appointment_date, appointment_time } = req.body;
    const { data: bk } = await supabase.from("bookings").select("*").eq("id", id).single();
    if (!bk) return res.status(404).json({ error: "Booking not found" });
    const upd = { status, admin_notes: admin_notes||null, updated_at: new Date().toISOString() };
    if (appointment_date) upd.appointment_date = appointment_date;
    if (appointment_time) upd.appointment_time = appointment_time;
    const { error } = await supabase.from("bookings").update(upd).eq("id", id);
    if (error) throw error;
    const fd = appointment_date||bk.appointment_date, ft = appointment_time||bk.appointment_time;
    const msgs = {
      confirmed:   `✅ Appointment with Dr. ${bk.doctor_name} CONFIRMED for ${fd} at ${ft}.`,
      cancelled:   `❌ Appointment with Dr. ${bk.doctor_name} cancelled.${admin_notes?" Reason: "+admin_notes:""}`,
      completed:   `🎊 Visit with Dr. ${bk.doctor_name} complete. Thank you!`,
      rescheduled: `📅 Appointment rescheduled to ${fd} at ${ft}.`
    };
    if (msgs[status]) await supabase.from("notifications").insert({
      id: uuidv4(), user_id: bk.user_id,
      title: `Appointment ${status.charAt(0).toUpperCase()+status.slice(1)}`,
      message: msgs[status], type: "appointment_update", is_read: false
    });
    res.json({ message: "Booking updated and patient notified" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ USERS ════════════════════════════════════════════════════════
app.get("/api/admin/users", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("users")
    .select("id,name,email,phone,age,blood_group,is_admin,is_active,created_at")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.patch("/api/admin/users/:id", adminAuth, async (req, res) => {
  const { error } = await supabase.from("users")
    .update({ is_active: req.body.is_active, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "User updated" });
});

// ══ NOTIFICATIONS ═════════════════════════════════════════════════
app.get("/api/notifications", auth, async (req, res) => {
  try {
    const q = req.user.is_admin
      ? supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(50)
      : supabase.from("notifications").select("*").or(`user_id.eq.${req.user.id},user_id.eq.all`).order("created_at", { ascending: false }).limit(30);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch("/api/notifications/:id/read", auth, async (req, res) => {
  const { error } = await supabase.from("notifications").update({ is_read: true }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "Marked read" });
});
app.post("/api/admin/notifications", adminAuth, async (req, res) => {
  try {
    const { user_id, title, message, type } = req.body;
    if (!title || !message) return res.status(400).json({ error: "Title and message required" });
    const { error } = await supabase.from("notifications").insert({
      id: uuidv4(), user_id: user_id||"all", title, message, type: type||"announcement", is_read: false
    });
    if (error) throw error;
    res.json({ message: "Notification sent" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ AI — Fixed: direct fetch, no SDK ═════════════════════════════
app.post("/api/ai/suggest", auth, async (req, res) => {
  try {
    const { problem, patient_age, patient_name } = req.body;
    if (!problem) return res.status(400).json({ error: "Problem required" });
    const apiKey = await getGeminiKey();
    if (!apiKey) return res.status(503).json({ error: "AI not configured. Admin must add Gemini API key in Settings." });
    const prompt = `You are a compassionate health assistant at MediCare+ Hospital.
Patient: ${patient_name||"Patient"}, Age: ${patient_age||"Unknown"}
Symptoms: "${problem}"

RULES: ONLY home remedies. NO medicines, drugs, or supplements.

**🏠 Home Remedies for Temporary Relief:**
• (2-3 specific home remedies) suggest only in simple words and in short don't give them a long answer 
**💚 From MediCare+:**
(One warm sentence about their appointment in short)`;

    const suggestion = await callGemini(apiKey, prompt);
    const { data: latest } = await supabase.from("bookings").select("id").eq("user_id", req.user.id).order("created_at", { ascending: false }).limit(1).single();
    if (latest) await supabase.from("bookings").update({ ai_suggestion: suggestion }).eq("id", latest.id);
    res.json({ suggestion });
  } catch (err) { console.error("Gemini:", err.message); res.status(500).json({ error: "AI error: " + err.message }); }
});

app.post("/api/admin/test-gemini", adminAuth, async (req, res) => {
  try {
    const key = (req.body.api_key||"").trim() || await getGeminiKey();
    if (!key) return res.status(400).json({ success: false, error: "No API key" });
    const result = await callGemini(key, "Say 'MediCare AI is working!' in one sentence.");
    res.json({ success: true, message: "Key is valid!", response: result });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ══ SETTINGS ══════════════════════════════════════════════════════
app.get("/api/settings", adminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from("settings").select("value").eq("key","gemini_api_key").single();
    const db  = (data?.value||"").trim();
    const env = (process.env.GEMINI_API_KEY||"").trim();
    const act = db.length > 20 ? db : env;
    const masked = act.length > 20 ? act.substring(0,7)+"••••••••"+act.slice(-4) : "";
    res.json({ has_key: act.length > 20, masked_key: masked, source: db.length>20?"database":env.length>20?"environment":"none", env_key_set: env.length>20 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/api/settings/gemini", adminAuth, async (req, res) => {
  try {
    const key = (req.body.api_key||"").trim();
    if (key.length < 20) return res.status(400).json({ error: "API key looks invalid" });
    const { error } = await supabase.from("settings").upsert({ key: "gemini_api_key", value: key, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    res.json({ message: "API key saved" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const [bkR, uR, dR] = await Promise.all([
      supabase.from("bookings").select("status,created_at"),
      supabase.from("users").select("id,created_at").eq("is_admin",false),
      supabase.from("doctors").select("id").eq("is_active",true)
    ]);
    const bk = bkR.data||[];
    const c  = bk.reduce((a,b) => { a[b.status]=(a[b.status]||0)+1; return a; },{});
    const now = new Date();
    const trend = Array.from({length:7},(_,i) => {
      const d = new Date(now); d.setDate(d.getDate()-(6-i));
      const ds = d.toISOString().split("T")[0];
      return { date: d.toLocaleDateString("en-IN",{weekday:"short"}), count: bk.filter(b=>b.created_at?.startsWith(ds)).length };
    });
    res.json({ total_bookings:bk.length, pending:c.pending||0, confirmed:c.confirmed||0, completed:c.completed||0, cancelled:c.cancelled||0, total_patients:(uR.data||[]).length, active_doctors:(dR.data||[]).length, trend });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health + 404 ──────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status:"ok", v:"3.0", time: new Date().toISOString() }));
app.get("/", (req, res) => res.json({ message:"MediCare+ HMS v3 ✅" }));
app.use((req, res) => res.status(404).json({ error:`Route not found: ${req.method} ${req.path}` }));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🏥 MediCare+ HMS v3 on port ${PORT}`);
  console.log(`🔐 Admin: ${ADMIN_ID} / ${ADMIN_PASS}`);
});

require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const { createClient } = require("@supabase/supabase-js");
const bcrypt    = require("bcryptjs");
const jwt       = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

// ══ OTP STORE (in-memory, 10-min expiry) ══════════════════════════
const _otpMap = {};
function generateOTP() { return String(Math.floor(100000 + Math.random() * 900000)); }
function saveOTP(email, otp, purpose) {
  _otpMap[email.toLowerCase()] = { otp, purpose, expiresAt: Date.now() + 10*60*1000 };
}
function verifyOTP(email, otp, purpose) {
  const r = _otpMap[email.toLowerCase()];
  if (!r) return { valid:false, error:"No OTP found. Request a new one." };
  if (r.purpose !== purpose) return { valid:false, error:"Invalid OTP." };
  if (Date.now() > r.expiresAt) { delete _otpMap[email.toLowerCase()]; return { valid:false, error:"OTP expired. Request a new one." }; }
  if (r.otp !== otp.toString().trim()) return { valid:false, error:"Incorrect OTP. Try again." };
  delete _otpMap[email.toLowerCase()];
  return { valid:true };
}
function otpEmailHtml(otp, purpose) {
  const title = purpose === "admin_change_password" ? "Admin Password Change" : "Password Reset";
  const html = [
    '<div style="font-family:Arial,sans-serif;max-width:460px;margin:0 auto;border:1px solid #ddd;border-radius:14px;overflow:hidden">',
    '<div style="background:linear-gradient(135deg,#0B6E6E,#11B5B5);padding:22px 28px;color:#fff">',
    '<h2 style="margin:0;font-size:20px">&#128274; MediCare+ &mdash; ' + title + '</h2></div>',
    '<div style="padding:28px;text-align:center">',
    '<p style="font-size:14px;color:#444;margin-bottom:20px">Your One-Time Password:</p>',
    '<div style="background:#f0fafa;border:2px dashed #0B6E6E;border-radius:12px;padding:20px;margin-bottom:20px">',
    '<span style="font-size:40px;font-weight:900;letter-spacing:12px;color:#0B6E6E;font-family:monospace">' + otp + '</span></div>',
    '<p style="font-size:12px;color:#888">Expires in <strong>10 minutes</strong> &bull; One-time use only</p></div>',
    '<div style="background:#f5f7fa;padding:12px;text-align:center;font-size:11px;color:#aaa">MediCare+ Hospital</div></div>'
  ].join("");
  return html;
}


// ══ OTP STORE (in-memory, 10-min expiry) ══════════════════════════

// ══════════════════════════════════════════════════════════════════
// SETTINGS CACHE — loads all keys from Supabase settings table
// Falls back to env vars if DB value is empty
// ══════════════════════════════════════════════════════════════════
let _settingsCache = null;
let _settingsCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

async function getSettings() {
  if (_settingsCache && Date.now() - _settingsCacheTime < CACHE_TTL) return _settingsCache;
  try {
    const { data } = await supabase.from("settings").select("key,value");
    const map = {};
    (data || []).forEach(r => { map[r.key] = (r.value || "").trim(); });
    // Fall back to env vars for any empty DB value
    const cfg = {
      gemini_api_key:     map.gemini_api_key     || (process.env.GEMINI_API_KEY     || "").trim(),
      admin_email:        map.admin_email         || (process.env.ADMIN_EMAIL        || "").trim(),
      brevo_api_key:      map.brevo_api_key       || (process.env.BREVO_API_KEY       || "").trim(),
      brevo_from:         map.brevo_from          || (process.env.BREVO_FROM          || "").trim(),
      telegram_bot_token: map.telegram_bot_token  || (process.env.TELEGRAM_BOT_TOKEN|| "").trim(),
      telegram_chat_id:   map.telegram_chat_id    || (process.env.TELEGRAM_CHAT_ID  || "").trim(),
      twilio_account_sid: map.twilio_account_sid  || (process.env.TWILIO_ACCOUNT_SID|| "").trim(),
      twilio_auth_token:  map.twilio_auth_token   || (process.env.TWILIO_AUTH_TOKEN || "").trim(),
      twilio_from:        map.twilio_from         || (process.env.TWILIO_WHATSAPP_FROM||"whatsapp:+14155238886").trim(),
      admin_whatsapp:     map.admin_whatsapp       || (process.env.ADMIN_WHATSAPP   || "").trim(),
    };
    _settingsCache = cfg;
    _settingsCacheTime = Date.now();
    return cfg;
  } catch {
    // Full env fallback
    return {
      gemini_api_key:     (process.env.GEMINI_API_KEY     ||"").trim(),
      admin_email:        (process.env.ADMIN_EMAIL         ||"").trim(),
      brevo_api_key:      (process.env.BREVO_API_KEY        ||"").trim(),
      brevo_from:         (process.env.BREVO_FROM           ||"").trim(),
      telegram_bot_token: (process.env.TELEGRAM_BOT_TOKEN  ||"").trim(),
      telegram_chat_id:   (process.env.TELEGRAM_CHAT_ID    ||"").trim(),
      twilio_account_sid: (process.env.TWILIO_ACCOUNT_SID  ||"").trim(),
      twilio_auth_token:  (process.env.TWILIO_AUTH_TOKEN   ||"").trim(),
      twilio_from:        (process.env.TWILIO_WHATSAPP_FROM ||"whatsapp:+14155238886").trim(),
      admin_whatsapp:     (process.env.ADMIN_WHATSAPP       ||"").trim(),
    };
  }
}

async function saveSetting(key, value) {
  await supabase.from("settings").upsert({ key, value: value||"", updated_at: new Date().toISOString() }, { onConflict: "key" });
  _settingsCache = null; // bust cache
}

// ══════════════════════════════════════════════════════════════════
// GEMINI 2.5 FLASH — REST fetch, no SDK
// ══════════════════════════════════════════════════════════════════
async function callGemini(apiKey, prompt) {
  // Try gemini-2.5-flash first, fall back to 2.0-flash
  const models = ["gemini-2.5-flash-preview-04-17", "gemini-2.0-flash"];
  let lastErr;
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1800, topP: 0.9 }
        })
      });
      const json = await resp.json();
      if (!resp.ok) { lastErr = new Error(json?.error?.message || `Gemini ${resp.status}`); continue; }
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { lastErr = new Error("Empty response"); continue; }
      console.log(`✅ Gemini (${model}) responded`);
      return text;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Gemini unavailable");
}

// ══════════════════════════════════════════════════════════════════
// FALLBACK HOME REMEDIES (shown when Gemini is unavailable)
// ══════════════════════════════════════════════════════════════════
const REMEDY_FALLBACKS = {
  fever: {
    icon: "🌡️", label: "Fever",
    remedies: ["Stay hydrated — drink water, coconut water, or ORS every 30 minutes","Apply a cool damp cloth on forehead, neck, and armpits","Rest in a cool, well-ventilated room","Wear light, breathable cotton clothing","Sip warm turmeric milk (haldi doodh) — natural anti-inflammatory"],
    comfort: ["Keep room temperature cool, use a fan if needed","Avoid thick blankets — use a light sheet only","Eat light foods like khichdi, curd rice, or dal"],
    emergency: ["Fever above 104°F (40°C) that won't reduce","Seizures, confusion, or severe headache","Rash appearing with high fever","Difficulty breathing"]
  },
  cold: {
    icon: "🤧", label: "Cold & Runny Nose",
    remedies: ["Steam inhalation with a few drops of eucalyptus oil — 2x daily","Ginger-honey-lemon tea — boil ginger in water, add honey and lemon","Gargle with warm salt water (1/2 tsp salt in warm water) 3x daily","Tulsi (Holy Basil) kadha — boil 10 tulsi leaves in 2 cups water","Apply warm mustard oil around nostrils at bedtime"],
    comfort: ["Sleep with head slightly elevated using an extra pillow","Keep room warm and humid — use a wet towel on a warm surface","Avoid cold drinks, ice cream, and cold food"],
    emergency: ["Difficulty breathing or shortness of breath","High fever (above 103°F) with cold symptoms","Symptoms lasting more than 10 days","Chest pain or tightness"]
  },
  cough: {
    icon: "😮‍💨", label: "Cough",
    remedies: ["Mix 1 tsp honey with a pinch of black pepper powder — take twice daily","Ginger juice with honey — 1 tsp each, 3 times a day","Warm turmeric milk at bedtime","Steam inhalation with eucalyptus or peppermint oil","Clove (laung) chewed slowly — natural throat soother"],
    comfort: ["Stay hydrated with warm liquids throughout the day","Avoid cold air, dust, and smoke","Elevate head at night to reduce night coughing"],
    emergency: ["Coughing up blood","Chest pain while coughing","Breathlessness or wheezing","Cough lasting more than 3 weeks"]
  },
  headache: {
    icon: "🤕", label: "Headache",
    remedies: ["Apply peppermint oil on temples and forehead — gentle circular massage","Cold compress on forehead for tension headaches","Ginger tea — boil fresh ginger in water for 5 minutes","Drink a large glass of water immediately — dehydration is a common cause","Clove powder with salt in warm water — 1/2 tsp each"],
    comfort: ["Lie down in a dark, quiet room","Avoid screen time (phone, laptop) during headache","Gentle neck and shoulder stretches"],
    emergency: ["Sudden severe headache ('thunderclap')","Headache with stiff neck and fever","Vision changes, confusion, or weakness","Headache after head injury"]
  },
  stomach: {
    icon: "🤢", label: "Stomach Pain / Nausea",
    remedies: ["Ajwain (carom seeds) with warm water — 1 tsp ajwain + pinch of salt","Jeera (cumin) water — boil 1 tsp cumin in 2 cups water, cool and drink","Ginger tea — fresh ginger in hot water soothes nausea","Hing (asafoetida) with warm water — small pinch, good for gas/bloating","Banana + curd (BRAT approach) — gentle on stomach"],
    comfort: ["Eat small, frequent meals — avoid large meals","Avoid spicy, oily, and processed food","Rest in semi-reclined position after eating"],
    emergency: ["Severe, sharp abdominal pain","Blood in vomit or stool","Rigid or bloated abdomen","Persistent vomiting for more than 24 hours"]
  },
  back: {
    icon: "🦴", label: "Back Pain",
    remedies: ["Apply warm compress or heat pad on painful area for 15-20 minutes","Mix 1 tsp turmeric in warm milk — drink twice daily","Garlic cloves fried in mustard oil — apply when cooled","Gentle cat-cow stretches lying on the floor","Epsom salt warm water soak if full bath is possible"],
    comfort: ["Avoid heavy lifting completely","Sleep on a firm mattress with a pillow under knees","Stand and walk slowly every 30 minutes — don't stay still too long"],
    emergency: ["Numbness or tingling down the legs","Loss of bladder or bowel control","Severe pain that doesn't reduce at all","Pain after a fall or accident"]
  },
  throat: {
    icon: "😣", label: "Sore Throat",
    remedies: ["Gargle with warm salt water every 2-3 hours","Honey + ginger + turmeric mix — 1 tsp each, take 3x daily","Mulethi (licorice root) tea — boil in water and sip slowly","Clove (laung) — keep 1-2 in mouth and let juice soothe throat","Warm lemon water with a small pinch of black pepper"],
    comfort: ["Avoid cold water, ice cream, and cold drinks completely","Speak less to rest your vocal cords","Use a warm water humidifier near you"],
    emergency: ["Difficulty breathing or swallowing","Severe throat swelling visible to others","High fever above 103°F","Drooling or inability to open mouth wide"]
  },
  default: {
    icon: "🌿", label: "General Discomfort",
    remedies: ["Stay well hydrated — drink 8-10 glasses of warm or room-temperature water","Rest well — avoid strenuous activity and get 7-8 hours of sleep","Turmeric golden milk — 1 tsp turmeric in warm milk, twice a day","Light diet — khichdi, curd rice, boiled vegetables, avoid spicy and oily food","Deep breathing exercises — 5 minutes of slow deep breaths, 3x a day"],
    comfort: ["Keep your environment clean and well-ventilated","Wear comfortable, loose-fitting clothes","Avoid stress — gentle meditation or music can help"],
    emergency: ["Symptoms rapidly getting worse within hours","High fever above 103°F (39.4°C)","Difficulty breathing or chest pain","Loss of consciousness or confusion"]
  }
};

function getFallbackRemedy(problem) {
  const p = (problem || "").toLowerCase();
  let key = "default";
  if (p.match(/fever|temperature|hot|chills|shiver/))      key = "fever";
  else if (p.match(/cold|runny nose|sneezing|nasal|flu/))  key = "cold";
  else if (p.match(/cough|coug|throat|phlegm|mucus/))      key = "cough";
  else if (p.match(/headache|head ache|migraine|head pain/)) key = "headache";
  else if (p.match(/stomach|nausea|vomit|gastric|gas|bloat|acidity|indigestion/)) key = "stomach";
  else if (p.match(/back pain|backache|spine|lumbar/))     key = "back";
  else if (p.match(/sore throat|throat pain|tonsil/))      key = "throat";

  const r = REMEDY_FALLBACKS[key];
  return `**${r.icon} Home Remedies for ${r.label}:**
${r.remedies.map(x => "• " + x).join("\n")}

**🛁 Comfort Measures:**
${r.comfort.map(x => "• " + x).join("\n")}

**⚠️ Seek Emergency Help If:**
${r.emergency.map(x => "• " + x).join("\n")}

**💚 From MediCare+:**
Your doctor appointment is being arranged. These remedies provide temporary relief — please follow your doctor's advice after the consultation. We care for your wellbeing! 🏥`;
}

// ══════════════════════════════════════════════════════════════════
// EMAIL via Nodemailer (Gmail SMTP)
// ══════════════════════════════════════════════════════════════════
async function sendEmail(to, subject, htmlBody, bookingId, type) {
  // Bust cache so latest keys are always used
  _settingsCache = null;
  const cfg     = await getSettings();
  const apiKey  = (cfg.brevo_api_key || "").trim();
  const fromRaw = (cfg.brevo_from    || "").trim();
  const logEntry = { id: uuidv4(), to_email: to, subject, status: "skipped", type: type||"general", booking_id: bookingId||null };

  // ── Guard: API key ──
  if (!apiKey || apiKey.length < 10) {
    const reason = "Brevo API key not set — add it in Admin → API Keys & Email";
    console.log(`⚠️  Email skipped (${reason}) | To: ${to}`);
    try { await supabase.from("email_logs").insert({ ...logEntry, status: "skipped", error: reason }); } catch(_){}
    return { skipped: true, reason };
  }

  // ── Guard: recipient ──
  if (!to || !to.includes("@")) {
    console.log(`⚠️  Email skipped — invalid recipient: "${to}"`);
    return { skipped: true, reason: "Invalid recipient email" };
  }

  // ── Parse sender ──
  // fromRaw can be:  "MediCare+ <noreply@yourdomain.com>"  OR  "noreply@yourdomain.com"
  let senderName  = "MediCare+";
  let senderEmail = "";
  const match = fromRaw.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (match) {
    senderName  = match[1].trim() || "MediCare+";
    senderEmail = match[2].trim();
  } else if (fromRaw.includes("@")) {
    senderEmail = fromRaw;
  }

  // ── Guard: sender not configured ──
  if (!senderEmail || !senderEmail.includes("@")) {
    const reason = "Sender email (brevo_from) not set in Admin → API Keys & Email. Set it to your verified Brevo sender e.g. MediCare+ <noreply@yourdomain.com>";
    console.error(`❌ Email blocked — ${reason}`);
    try { await supabase.from("email_logs").insert({ ...logEntry, status: "failed", error: reason }); } catch(_){}
    return { error: reason };
  }

  // ── Send via Brevo REST API ──
  console.log(`📧 Sending email → ${to} | From: ${senderName} <${senderEmail}> | Subject: ${subject}`);

  try {
    const payload = {
      sender:      { name: senderName, email: senderEmail },
      to:          [{ email: to }],
      subject:     subject,
      htmlContent: htmlBody
    };

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key":      apiKey,
        "Content-Type": "application/json",
        "Accept":       "application/json"
      },
      body: JSON.stringify(payload)
    });

    const json = await resp.json();
    console.log(`📧 Brevo response: ${resp.status}`, JSON.stringify(json).substring(0, 200));

    if (!resp.ok) {
      let friendly = json?.message || json?.error || `Brevo HTTP ${resp.status}`;
      if (resp.status === 401)
        friendly = "Invalid Brevo API key. Copy it fresh from app.brevo.com → Settings → API Keys.";
      else if (resp.status === 403)
        friendly = "Brevo API key doesn't have email sending permission. Create a new key with full access.";
      else if (resp.status === 400 && (json?.message || "").toLowerCase().includes("sender"))
        friendly = `Sender '${senderEmail}' is not verified in Brevo. Go to app.brevo.com → Senders & Domains → add & verify your email first.`;
      else if (resp.status === 400 && (json?.message || "").toLowerCase().includes("contact"))
        friendly = `Recipient '${to}' is blocked or unsubscribed in Brevo. Check Contacts in Brevo dashboard.`;
      else if (resp.status === 400)
        friendly = `Brevo rejected: ${json?.message || "Bad request"} | Payload: sender=${senderEmail}, to=${to}`;
      console.error(`❌ Email FAILED → ${to} | ${friendly}`);
      try { await supabase.from("email_logs").insert({ ...logEntry, status: "failed", error: friendly }); } catch(_){}
      return { error: friendly };
    }

    const msgId = json?.messageId || json?.id || "ok";
    console.log(`✅ Email SENT → ${to} | Brevo messageId: ${msgId}`);
    try { await supabase.from("email_logs").insert({ ...logEntry, status: "sent" }); } catch(_){}
    return { messageId: msgId };

  } catch (e) {
    const friendly = `Network/fetch error: ${e.message}`;
    console.error(`❌ Email ERROR → ${to} | ${friendly}`);
    try { await supabase.from("email_logs").insert({ ...logEntry, status: "failed", error: friendly }); } catch(_){}
    return { error: friendly };
  }
}

// ── Email HTML templates ───────────────────────────────────────────
function emailHtml(color, icon, title, name, body, footer = "") {
  return `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f5f7fa;font-family:Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:linear-gradient(135deg,${color});padding:24px 28px;color:#fff">
    <div style="font-size:36px;margin-bottom:10px">${icon}</div>
    <h2 style="margin:0 0 4px;font-size:20px">${title}</h2>
    <p style="margin:0;opacity:.85;font-size:13px">MediCare+ Hospital Management System</p>
  </div>
  <div style="padding:28px;font-size:14px;color:#333;line-height:1.8">
    Hi <strong>${name}</strong>,<br><br>${body}
  </div>
  ${footer ? `<div style="padding:14px 28px;background:#f8f9fa;font-size:12px;color:#666;border-top:1px solid #eee">${footer}</div>` : ""}
  <div style="padding:14px 28px;text-align:center;font-size:11px;color:#aaa;background:#f5f7fa">
    MediCare+ HMS · Do not reply to this email
  </div>
</div></body></html>`;
}

function bookingRow(label, value) {
  return `<tr><td style="padding:7px 0;color:#888;font-size:13px;width:42%;vertical-align:top">${label}</td><td style="font-size:13px;color:#222;font-weight:600">${value}</td></tr>`;
}

async function emailNewBooking(booking) {
  const cfg = await getSettings();
  const adminTarget = cfg.admin_email; // admin_email set in API Keys panel

  // Email to admin
  if (adminTarget) {
    await sendEmail(
      adminTarget,
      `🏥 New Booking — ${booking.patient_name} → Dr. ${booking.doctor_name}`,
      emailHtml("#0B6E6E,#11B5B5", "🏥", "New Appointment Received", "Admin",
        `A new appointment has been booked. Please review and confirm.<br><br>
        <table style="width:100%;border-collapse:collapse">
          ${bookingRow("Patient", `${booking.patient_name} (${booking.patient_age||"?"}y)`)}
          ${bookingRow("Email", booking.user_email)}
          ${bookingRow("Phone", booking.phone || "Not provided")}
          ${bookingRow("Doctor", `Dr. ${booking.doctor_name}`)}
          ${bookingRow("Dept", booking.specialization)}
          ${bookingRow("Date", booking.appointment_date)}
          ${bookingRow("Time", booking.appointment_time)}
          ${bookingRow("Problem", booking.problem)}
        </table>
        <div style="margin-top:22px;text-align:center">
          <a href="https://hospital-management-system-6exp.onrender.com" style="background:#0B6E6E;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Open Admin Panel →</a>
        </div>`,
        `Admin email sent automatically on every new booking.`
      ), booking.id, "booking_admin"
    );
  }

  // Confirmation email to patient (using their login email)
  if (booking.user_email) {
    await sendEmail(
      booking.user_email,
      `🏥 Appointment Received — Dr. ${booking.doctor_name} on ${booking.appointment_date}`,
      emailHtml("#0B6E6E,#11B5B5", "✅", "Appointment Received!", booking.patient_name,
        `Your appointment has been successfully submitted and is awaiting confirmation.<br><br>
        <table style="width:100%;border-collapse:collapse">
          ${bookingRow("Doctor", `Dr. ${booking.doctor_name}`)}
          ${bookingRow("Specialization", booking.specialization)}
          ${bookingRow("Date", booking.appointment_date)}
          ${bookingRow("Time", booking.appointment_time)}
          ${bookingRow("Status", "⏳ Pending Confirmation")}
        </table><br>
        We will send you an email once the doctor confirms your appointment.`
      ), booking.id, "booking_patient"
    );
  }
}

async function emailStatusUpdate(patientEmail, patientName, booking, status) {
  if (!patientEmail) return;
  const configs = {
    confirmed:   { icon:"✅", color:"#16a34a,#4ade80", title:"Appointment CONFIRMED!", body:`Great news! Your appointment is officially confirmed. ✔️<br><br><table style="width:100%;border-collapse:collapse">${bookingRow("Doctor",`Dr. ${booking.doctor_name}`)}${bookingRow("Date",booking.appointment_date)}${bookingRow("Time",booking.appointment_time)}</table>${booking.admin_notes?`<br>📝 <em>${booking.admin_notes}</em>`:""}<br><br>Please arrive <strong>10 minutes early</strong> and bring any previous prescriptions.` },
    cancelled:   { icon:"❌", color:"#dc2626,#f87171", title:"Appointment Cancelled", body:`Your appointment with Dr. ${booking.doctor_name} has been cancelled.${booking.admin_notes?`<br><br>📝 <strong>Reason:</strong> ${booking.admin_notes}`:""}<br><br>Please book a new appointment at your convenience.` },
    rescheduled: { icon:"📅", color:"#2563eb,#60a5fa", title:"Appointment Rescheduled", body:`Your appointment has been rescheduled.<br><br><table style="width:100%;border-collapse:collapse">${bookingRow("Doctor",`Dr. ${booking.doctor_name}`)}${bookingRow("New Date",booking.appointment_date)}${bookingRow("New Time",booking.appointment_time)}</table>${booking.admin_notes?`<br>📝 ${booking.admin_notes}`:""}` },
    completed:   { icon:"🎊", color:"#7c3aed,#c084fc", title:"Visit Complete — Thank You!", body:`Your visit with <strong>Dr. ${booking.doctor_name}</strong> is marked complete. We hope you're feeling better! 💚${booking.admin_notes?`<br><br>📝 <strong>Follow-up note:</strong> ${booking.admin_notes}`:""}<br><br>Book a follow-up appointment anytime if needed.` }
  };
  const c = configs[status]; if (!c) return;
  await sendEmail(
    patientEmail,
    `${c.icon} Appointment ${status.charAt(0).toUpperCase()+status.slice(1)} — MediCare+`,
    emailHtml(c.color, c.icon, c.title, patientName, c.body),
    booking.id, status
  );
}

// ══════════════════════════════════════════════════════════════════
// WHATSAPP (Twilio)
// ══════════════════════════════════════════════════════════════════
async function sendWhatsApp(toRaw, message) {
  const cfg = await getSettings();
  const sid = cfg.twilio_account_sid, token = cfg.twilio_auth_token, from = cfg.twilio_from;
  if (!sid || sid.length < 10) { console.log("ℹ️  WhatsApp skipped"); return { skipped: true }; }
  let num = String(toRaw).replace(/\D/g,"");
  if (num.length === 10) num = "91" + num;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded", "Authorization":"Basic "+Buffer.from(`${sid}:${token}`).toString("base64") },
    body: new URLSearchParams({ From: from, To:`whatsapp:+${num}`, Body: message }).toString()
  });
  const json = await resp.json();
  if (!resp.ok) return { error: json?.message };
  return { sid: json.sid };
}

// ══════════════════════════════════════════════════════════════════
// TELEGRAM
// ══════════════════════════════════════════════════════════════════
async function sendTelegram(message) {
  const cfg = await getSettings();
  const token = cfg.telegram_bot_token, chat_id = cfg.telegram_chat_id;
  if (!token || !chat_id) { console.log("ℹ️  Telegram skipped"); return { skipped: true }; }
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ chat_id, text: message, parse_mode:"Markdown" })
  });
  const json = await resp.json();
  if (!json.ok) return { error: json.description };
  return { message_id: json.result?.message_id };
}

// ══════════════════════════════════════════════════════════════════
// MASTER ALERT — sends via all configured channels
// ══════════════════════════════════════════════════════════════════
async function sendAllAlerts(booking, type) {
  const cfg = await getSettings();
  const tasks = [];
  // Email (always try — most reliable)
  tasks.push(emailNewBooking(booking));
  // WhatsApp
  if (cfg.twilio_account_sid) {
    const adminNum = cfg.admin_whatsapp.replace(/\D/g,"");
    if (adminNum) tasks.push(sendWhatsApp(adminNum,
      `🏥 *New Booking!*\n👤 ${booking.patient_name} → Dr. ${booking.doctor_name}\n📅 ${booking.appointment_date} ${booking.appointment_time}\n📋 ${booking.problem.substring(0,80)}`
    ));
    if (booking.phone) tasks.push(sendWhatsApp(booking.phone,
      `✅ *Appointment Received!*\nHi ${booking.patient_name}! Your appointment with Dr. ${booking.doctor_name} on ${booking.appointment_date} at ${booking.appointment_time} is confirmed. We will notify you once confirmed. – MediCare+`
    ));
  }
  // Telegram
  if (cfg.telegram_bot_token) {
    tasks.push(sendTelegram(
      `🏥 *New Booking!*\n👤 ${booking.patient_name} → Dr. ${booking.doctor_name}\n📅 ${booking.appointment_date} ${booking.appointment_time}\n📋 ${booking.problem.substring(0,100)}`
    ));
  }
  await Promise.allSettled(tasks);
}

async function sendStatusAlerts(patientEmail, patientName, phone, booking, status) {
  const cfg = await getSettings();
  const tasks = [];
  if (patientEmail) tasks.push(emailStatusUpdate(patientEmail, patientName, booking, status));
  if (cfg.twilio_account_sid && phone) {
    const msgs = {
      confirmed:`✅ *Appointment CONFIRMED!*\nDr. ${booking.doctor_name} on ${booking.appointment_date} at ${booking.appointment_time}.\n– MediCare+`,
      cancelled:`❌ *Appointment Cancelled*\nDr. ${booking.doctor_name}${booking.admin_notes?"\nReason: "+booking.admin_notes:""}.\n– MediCare+`,
      rescheduled:`📅 *Appointment Rescheduled*\nNew: ${booking.appointment_date} at ${booking.appointment_time}.\n– MediCare+`,
      completed:`🎊 *Visit Complete!*\nThank you for visiting MediCare+. Feel better soon! 💚`
    };
    if (msgs[status]) tasks.push(sendWhatsApp(phone, msgs[status]));
  }
  await Promise.allSettled(tasks);
}

// ══════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════════
const auth = (req, res, next) => {
  const t = req.headers.authorization?.split(" ")[1];
  if (!t) return res.status(401).json({ error: "No token provided" });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid or expired token" }); }
};
const adminAuth = (req, res, next) =>
  auth(req, res, () => req.user.is_admin ? next() : res.status(403).json({ error: "Admin only" }));

// ══ AUTH ══════════════════════════════════════════════════════════
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, phone, age, blood_group } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Name, email, password required" });
    const { data: ex } = await supabase.from("users").select("id").eq("email", email).single();
    if (ex) return res.status(409).json({ error: "Email already registered" });
    const hashed = await bcrypt.hash(password, 10), id = uuidv4();
    const { error } = await supabase.from("users").insert({ id, name, email, password: hashed, phone: phone||null, age: age?parseInt(age):null, blood_group: blood_group||null, is_admin: false, is_active: true });
    if (error) throw error;
    const token = jwt.sign({ id, email, name, is_admin: false }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id, name, email, phone, age, blood_group, is_admin: false } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (email === ADMIN_ID) {
      // Check DB password hash first (set via change-password), then fallback to hardcoded
      const cfg = await getSettings();
      const dbHash = cfg.admin_password_hash || "";
      let passwordOk = false;
      if (dbHash && dbHash.length > 10) {
        passwordOk = await bcrypt.compare(password, dbHash);
      } else {
        passwordOk = (password === ADMIN_PASS);
      }
      if (!passwordOk) return res.status(401).json({ error: "Incorrect admin password." });
      const token = jwt.sign({ id: "admin", email: ADMIN_ID, name: "Administrator", is_admin: true }, JWT_SECRET, { expiresIn: "7d" });
      return res.json({ token, user: { id: "admin", name: "Administrator", email: ADMIN_ID, is_admin: true } });
    }
    const { data: user, error } = await supabase.from("users").select("*").eq("email", email).single();
    if (error || !user) return res.status(404).json({ error: "User not found" });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: "Incorrect password" });
    if (!user.is_active) return res.status(403).json({ error: "Account blocked" });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: "7d" });
    const { password: _, ...safe } = user;
    res.json({ token, user: safe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/auth/me", auth, async (req, res) => {
  try {
    if (req.user.is_admin && req.user.id === "admin") return res.json({ id: "admin", name: "Administrator", email: ADMIN_ID, is_admin: true });
    const { data, error } = await supabase.from("users").select("*").eq("id", req.user.id).single();
    if (error || !data) return res.status(404).json({ error: "Not found" });
    const { password: _, ...safe } = data;
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ══ FORGOT PASSWORD (user) ════════════════════════════════════════

// Step 1: Send OTP to user's registered email
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const { data: user } = await supabase.from("users").select("id,name,email").eq("email", email.toLowerCase()).single();
    if (!user) return res.status(404).json({ error: "No account found with this email address." });

    const otp = generateOTP();
    saveOTP(email, otp, "forgot_password");

    const result = await sendEmail(
      user.email,
      "🔐 MediCare+ Password Reset OTP",
      otpEmailHtml(otp, "forgot_password"),
      null, "otp"
    );

    if (result.skipped) return res.status(503).json({ error: "Email service not configured. Contact admin." });
    if (result.error)   return res.status(500).json({ error: "Could not send OTP: " + result.error });

    console.log(`📧 Forgot password OTP sent to ${user.email}`);
    res.json({ message: "OTP sent to your registered email address." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 2: Verify OTP + set new password
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { email, otp, new_password } = req.body;
    if (!email || !otp || !new_password) return res.status(400).json({ error: "Email, OTP, and new password required" });
    if (new_password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const check = verifyOTP(email, otp, "forgot_password");
    if (!check.valid) return res.status(400).json({ error: check.error });

    const hashed = await bcrypt.hash(new_password, 10);
    const { error } = await supabase.from("users").update({ password: hashed, updated_at: new Date().toISOString() }).eq("email", email.toLowerCase());
    if (error) throw error;

    res.json({ message: "Password reset successfully. You can now login with your new password." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ DOCTORS ═══════════════════════════════════════════════════════
app.get("/api/doctors", async (req, res) => {
  const { data, error } = await supabase.from("doctors").select("*").eq("is_active", true).order("name");
  if (error) return res.status(500).json({ error: error.message }); res.json(data);
});
app.get("/api/admin/doctors", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("doctors").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message }); res.json(data);
});
app.post("/api/admin/doctors", adminAuth, async (req, res) => {
  try {
    const { name, specialization, qualification, experience, email, phone, available_days, available_time_start, available_time_end, consultation_fee } = req.body;
    if (!name || !specialization) return res.status(400).json({ error: "Name and specialization required" });
    const { data, error } = await supabase.from("doctors").insert({ id: uuidv4(), name, specialization, qualification: qualification||null, experience: experience?parseInt(experience):0, email: email||null, phone: phone||null, available_days: available_days||["Monday","Tuesday","Wednesday","Thursday","Friday"], available_time_start: available_time_start||"09:00", available_time_end: available_time_end||"17:00", consultation_fee: consultation_fee?parseInt(consultation_fee):500, is_active: true, is_available_today: true }).select().single();
    if (error) throw error; res.json({ message: "Doctor added", doctor: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/api/admin/doctors/:id", adminAuth, async (req, res) => {
  const { error } = await supabase.from("doctors").update({ ...req.body, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message }); res.json({ message: "Doctor updated" });
});
app.delete("/api/admin/doctors/:id", adminAuth, async (req, res) => {
  const { error } = await supabase.from("doctors").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message }); res.json({ message: "Doctor deactivated" });
});
app.patch("/api/admin/doctors/:id/availability", adminAuth, async (req, res) => {
  const { is_available_today, available_days, available_time_start, available_time_end } = req.body;
  const { error } = await supabase.from("doctors").update({ is_available_today, available_days, available_time_start, available_time_end, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message }); res.json({ message: "Updated" });
});

// ══ BOOKINGS ══════════════════════════════════════════════════════
app.post("/api/bookings", auth, async (req, res) => {
  try {
    const { doctor_id, doctor_name, specialization, patient_name, patient_age, problem, appointment_date, appointment_time } = req.body;
    if (!doctor_id || !problem || !appointment_date || !appointment_time) return res.status(400).json({ error: "Missing required fields" });
    const { data: uRow } = await supabase.from("users").select("phone,email").eq("id", req.user.id).single();
    const phone = uRow?.phone || null;
    const { data, error } = await supabase.from("bookings").insert({
      id: uuidv4(), user_id: req.user.id, user_name: req.user.name, user_email: req.user.email,
      doctor_id, doctor_name: doctor_name||"", specialization: specialization||"",
      patient_name: patient_name||req.user.name, patient_age: patient_age?parseInt(patient_age):null,
      problem, appointment_date, appointment_time, status: "pending", admin_notes: null, ai_suggestion: null
    }).select().single();
    if (error) throw error;
    await supabase.from("notifications").insert({ id: uuidv4(), user_id: req.user.id, title: "Appointment Submitted 🎉", message: `Your appointment with Dr. ${doctor_name} on ${appointment_date} at ${appointment_time} is received.`, type: "booking", is_read: false });
    // All alerts in background (email + whatsapp + telegram)
    sendAllAlerts({ ...data, phone }, "new_booking").catch(e => console.error("Alert error:", e.message));
    res.json({ message: "Booking created", booking: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/bookings", auth, async (req, res) => {
  const { data, error } = await supabase.from("bookings").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message }); res.json(data);
});
app.get("/api/admin/bookings", adminAuth, async (req, res) => {
  try {
    let q = supabase.from("bookings").select("*").order("created_at", { ascending: false });
    if (req.query.status && req.query.status !== "all") q = q.eq("status", req.query.status);
    if (req.query.date) q = q.eq("appointment_date", req.query.date);
    const { data, error } = await q;
    if (error) throw error; res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const notifMsgs = {
      confirmed:   `✅ Appointment with Dr. ${bk.doctor_name} CONFIRMED for ${fd} at ${ft}.`,
      cancelled:   `❌ Appointment with Dr. ${bk.doctor_name} cancelled.${admin_notes?" Reason: "+admin_notes:""}`,
      completed:   `🎊 Visit with Dr. ${bk.doctor_name} complete. Thank you!`,
      rescheduled: `📅 Appointment rescheduled to ${fd} at ${ft}.`
    };
    if (notifMsgs[status]) await supabase.from("notifications").insert({ id: uuidv4(), user_id: bk.user_id, title: `Appointment ${status.charAt(0).toUpperCase()+status.slice(1)}`, message: notifMsgs[status], type: "appointment_update", is_read: false });
    // Status update alerts to patient
    if (["confirmed","cancelled","rescheduled","completed"].includes(status)) {
      const { data: uRow } = await supabase.from("users").select("phone,email,name").eq("id", bk.user_id).single();
      const updBk = { ...bk, appointment_date: fd, appointment_time: ft, admin_notes: admin_notes||null };
      sendStatusAlerts(uRow?.email, uRow?.name||bk.user_name, uRow?.phone, updBk, status).catch(() => {});
    }
    res.json({ message: "Booking updated and patient notified" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ USERS ════════════════════════════════════════════════════════
app.get("/api/admin/users", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("users").select("id,name,email,phone,age,blood_group,is_admin,is_active,created_at").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message }); res.json(data);
});
app.patch("/api/admin/users/:id", adminAuth, async (req, res) => {
  const { error } = await supabase.from("users").update({ is_active: req.body.is_active, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message }); res.json({ message: "User updated" });
});

// Delete (anonymize) patient — keeps booking history intact
app.delete("/api/admin/users/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("users").update({
      name: "Deleted User",
      email: `deleted_${id}@deleted.invalid`,
      phone: null, age: null, blood_group: null,
      is_active: false,
      updated_at: new Date().toISOString()
    }).eq("id", id);
    if (error) throw error;
    res.json({ message: "User deleted and anonymized" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ NOTIFICATIONS ═════════════════════════════════════════════════
app.get("/api/notifications", auth, async (req, res) => {
  try {
    const q = req.user.is_admin
      ? supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(50)
      : supabase.from("notifications").select("*").or(`user_id.eq.${req.user.id},user_id.eq.all`).order("created_at", { ascending: false }).limit(30);
    const { data, error } = await q;
    if (error) throw error; res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/notifications/:id/read", auth, async (req, res) => {
  const { error } = await supabase.from("notifications").update({ is_read: true }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message }); res.json({ message: "Marked read" });
});
app.post("/api/admin/notifications", adminAuth, async (req, res) => {
  try {
    const { user_id, title, message, type } = req.body;
    if (!title || !message) return res.status(400).json({ error: "Title and message required" });
    const { error } = await supabase.from("notifications").insert({ id: uuidv4(), user_id: user_id||"all", title, message, type: type||"announcement", is_read: false });
    if (error) throw error; res.json({ message: "Sent" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ AI — Gemini 2.5 Flash with fallback ═══════════════════════════
app.post("/api/ai/suggest", auth, async (req, res) => {
  try {
    const { problem, patient_age, patient_name } = req.body;
    if (!problem) return res.status(400).json({ error: "Problem required" });
    const cfg = await getSettings();
    const key = cfg.gemini_api_key;

    if (!key) {
      // No key configured — return fallback
      const fallback = getFallbackRemedy(problem);
      return res.json({ suggestion: fallback, source: "fallback", note: "AI not configured. Showing saved home remedies." });
    }

    const prompt = `You are a compassionate health assistant at MediCare+ Hospital.
Patient: ${patient_name||"Patient"}, Age: ${patient_age||"Unknown"}
Symptoms: "${problem}"

STRICT RULES: ONLY home remedies and natural relief. NO medicines, drugs, or supplements of any kind.

**🏠 Home Remedies for Temporary Relief:**
• (List 4-6 specific, practical home remedies tailored to these exact symptoms)

**🛁 Comfort Measures:**
• (2-3 immediate comfort tips)

**⚠️ Seek Emergency Help If:**
• (2-3 red flag warning signs specific to these symptoms)

**💚 From MediCare+:**
(One warm, encouraging sentence about their upcoming appointment)

Be specific, warm, and practical. No medicines.`;

    let suggestion, source = "gemini-2.5-flash";
    try {
      suggestion = await callGemini(key, prompt);
    } catch (aiErr) {
      console.log("⚠️  Gemini failed, using fallback:", aiErr.message);
      suggestion = getFallbackRemedy(problem);
      source = "fallback";
    }

    // Save to latest booking
    const { data: latest } = await supabase.from("bookings").select("id").eq("user_id", req.user.id).order("created_at", { ascending: false }).limit(1).single();
    if (latest) await supabase.from("bookings").update({ ai_suggestion: suggestion }).eq("id", latest.id);

    res.json({ suggestion, source });
  } catch (e) { res.status(500).json({ error: "AI error: " + e.message }); }
});

app.post("/api/admin/test-gemini", adminAuth, async (req, res) => {
  try {
    const cfg = await getSettings();
    const key = (req.body.api_key||"").trim() || cfg.gemini_api_key;
    if (!key) return res.status(400).json({ success: false, error: "No API key configured" });
    const result = await callGemini(key, "Say 'MediCare AI using Gemini 2.5 Flash is working!' in one short sentence.");
    res.json({ success: true, message: "Key is valid! Gemini 2.5 Flash responding.", response: result });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ══ EMAIL LOGS ════════════════════════════════════════════════════
app.get("/api/admin/email-logs", adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("email_logs").select("*").order("created_at", { ascending: false }).limit(50);
    if (error) throw error; res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// ── Direct email test — shows full Brevo response ────────────────
app.post("/api/admin/email-test-direct", adminAuth, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: "Provide a 'to' email" });
    const result = await sendEmail(
      to,
      "✅ MediCare+ Email Test — " + new Date().toLocaleTimeString(),
      `<div style="font-family:Arial;padding:24px;max-width:480px;margin:0 auto;border:1px solid #ddd;border-radius:12px">
        <h2 style="color:#0B6E6E">🏥 MediCare+ Email Test</h2>
        <p>If you received this, your Brevo email is configured correctly! 🎉</p>
        <p style="color:#888;font-size:12px">Sent at: ${new Date().toISOString()}</p>
      </div>`,
      null, "test"
    );
    res.json({
      success: !result.error && !result.skipped,
      result,
      message: result.messageId
        ? "Email sent successfully! Check your inbox (and spam folder)."
        : result.skipped
        ? "Email was SKIPPED: " + result.reason
        : "Email FAILED: " + result.error
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Debug: show Brevo config status ──────────────────────────────
app.get("/api/admin/debug-email", adminAuth, async (req, res) => {
  _settingsCache = null; // force fresh load
  const cfg        = await getSettings();
  const apiKey     = (cfg.brevo_api_key || "").trim();
  const from       = (cfg.brevo_from    || "").trim();
  const adminEmail = (cfg.admin_email   || "").trim();

  const issues = [];
  if (!apiKey || apiKey.length < 10)
    issues.push("❌ Brevo API key not set — get it from app.brevo.com → Settings → API Keys → Create a new key");
  else if (!apiKey.startsWith("xkeysib-"))
    issues.push("⚠️ Brevo API key usually starts with 'xkeysib-' — double check you copied the full key");
  if (!adminEmail)
    issues.push("⚠️ Admin Email not set — you won't receive booking alert emails");
  if (!from)
    issues.push("⚠️ Sender Email not set — set it to your verified Brevo sender e.g. 'MediCare+ <noreply@yourdomain.com>'");

  res.json({
    brevo_api_key: apiKey ? apiKey.substring(0,10)+"••••"+apiKey.slice(-4) : "NOT SET",
    brevo_from:    from || "NOT SET — please configure in API Keys",
    admin_email:   adminEmail || "NOT SET",
    ready:         apiKey.length > 10 && from.length > 5,
    issues:        issues.length ? issues : ["✅ Brevo config looks correct! Try sending a test email."]
  });
});

// ══ TEST ALL CHANNELS ═════════════════════════════════════════════
app.post("/api/admin/test-channel", adminAuth, async (req, res) => {
  try {
    const { channel, phone, email: testEmail } = req.body;
    if (channel === "email") {
      if (!testEmail) return res.status(400).json({ error: "Email address required" });
      const r = await sendEmail(testEmail, "✅ MediCare+ Email Test", emailHtml("#0B6E6E,#11B5B5", "✅", "Email Test Successful!", "Admin", "This is a test email from MediCare+ HMS. Email notifications are working correctly! 🎉"), null, "test");
      if (r.skipped) return res.json({ success: false, message: "Gmail not configured in API Keys settings." });
      if (r.error)   return res.status(400).json({ success: false, error: r.error });
      return res.json({ success: true, message: `Test email sent to ${testEmail}` });
    }
    if (channel === "telegram") {
      const r = await sendTelegram("✅ *MediCare+ Telegram Test*\n\nTelegram notifications are working! 🎉\n_– MediCare+ Admin_");
      if (r.skipped) return res.json({ success: false, message: "Telegram not configured in API Keys settings." });
      if (r.error)   return res.status(400).json({ success: false, error: r.error });
      return res.json({ success: true, message: "Test Telegram message sent!" });
    }
    if (channel === "whatsapp") {
      if (!phone) return res.status(400).json({ error: "Phone number required" });
      const r = await sendWhatsApp(phone, "✅ *MediCare+ WhatsApp Test*\n\nWhatsApp notifications are working! 🎉\n_– MediCare+ Admin_");
      if (r.skipped) return res.json({ success: false, message: "WhatsApp (Twilio) not configured in API Keys settings." });
      if (r.error)   return res.status(400).json({ success: false, error: r.error });
      return res.json({ success: true, message: `Test WhatsApp sent! SID: ${r.sid}` });
    }
    res.status(400).json({ error: "Unknown channel" });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══ SETTINGS — GET ALL ════════════════════════════════════════════
app.get("/api/settings", adminAuth, async (req, res) => {
  try {
    const cfg = await getSettings();
    const mask = (v, show=4) => v && v.length > 8 ? v.substring(0,6)+"••••"+v.slice(-show) : v ? "••••••" : "";
    res.json({
      // Gemini
      gemini_api_key: { set: cfg.gemini_api_key.length > 10, masked: mask(cfg.gemini_api_key) },
      // Email via Brevo
      brevo_api_key: { set: cfg.brevo_api_key.length > 10, masked: mask(cfg.brevo_api_key) },
      brevo_from:    { set: cfg.brevo_from.length > 5,     value: cfg.brevo_from },
      admin_email:    { set: cfg.admin_email.length > 3,     value: cfg.admin_email },
      // Telegram
      telegram_bot_token: { set: cfg.telegram_bot_token.length > 10, masked: mask(cfg.telegram_bot_token) },
      telegram_chat_id:   { set: cfg.telegram_chat_id.length > 2,    value: cfg.telegram_chat_id },
      // WhatsApp
      twilio_account_sid: { set: cfg.twilio_account_sid.length > 10, masked: mask(cfg.twilio_account_sid) },
      twilio_auth_token:  { set: cfg.twilio_auth_token.length > 10,  masked: mask(cfg.twilio_auth_token) },
      twilio_from:        { set: cfg.twilio_from.length > 5,          value: cfg.twilio_from },
      admin_whatsapp:     { set: cfg.admin_whatsapp.length > 5,       value: cfg.admin_whatsapp },
      // Summary
      channels: {
        email:     cfg.brevo_api_key.length > 10 && cfg.brevo_from.length > 5,
        telegram:  cfg.telegram_bot_token.length > 10 && cfg.telegram_chat_id.length > 2,
        whatsapp:  cfg.twilio_account_sid.length > 10 && cfg.twilio_auth_token.length > 10,
        ai_active: cfg.gemini_api_key.length > 10
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ SETTINGS — SAVE INDIVIDUAL KEY ════════════════════════════════
app.put("/api/settings/:key", adminAuth, async (req, res) => {
  try {
    const { key } = req.params;
    const allowed = ["gemini_api_key","admin_email","brevo_api_key","brevo_from","telegram_bot_token","telegram_chat_id","twilio_account_sid","twilio_auth_token","twilio_from","admin_whatsapp","admin_password_hash"];
    if (!allowed.includes(key)) return res.status(400).json({ error: "Unknown setting key" });
    const value = (req.body.value || "").trim();
    await saveSetting(key, value);
    res.json({ message: `${key} saved successfully` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ STATS ══════════════════════════════════════════════════════════
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const [bkR, uR, dR, elR] = await Promise.all([
      supabase.from("bookings").select("status,created_at"),
      supabase.from("users").select("id,created_at").eq("is_admin", false),
      supabase.from("doctors").select("id").eq("is_active", true),
      supabase.from("email_logs").select("status").gte("created_at", new Date(Date.now()-86400000).toISOString())
    ]);
    const bk = bkR.data||[], el = elR.data||[];
    const c = bk.reduce((a,b) => { a[b.status]=(a[b.status]||0)+1; return a; }, {});
    const now = new Date();
    const trend = Array.from({length:7}, (_,i) => {
      const d = new Date(now); d.setDate(d.getDate()-(6-i));
      const ds = d.toISOString().split("T")[0];
      return { date: d.toLocaleDateString("en-IN",{weekday:"short"}), count: bk.filter(b=>b.created_at?.startsWith(ds)).length };
    });
    res.json({
      total_bookings: bk.length, pending: c.pending||0, confirmed: c.confirmed||0,
      completed: c.completed||0, cancelled: c.cancelled||0,
      total_patients: (uR.data||[]).length, active_doctors: (dR.data||[]).length,
      emails_today: el.length,
      emails_sent: el.filter(e=>e.status==="sent").length,
      emails_failed: el.filter(e=>e.status==="failed").length,
      trend
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Health ─────────────────────────────────────────────────────────


// ══ ADMIN CHANGE PASSWORD via OTP ════════════════════════════════

// Step 1: Send OTP to admin_email in settings
app.post("/api/admin/send-change-password-otp", adminAuth, async (req, res) => {
  try {
    const cfg = await getSettings();
    const adminEmail = cfg.admin_email;
    if (!adminEmail || !adminEmail.includes("@")) {
      return res.status(400).json({ error: "Admin email not configured. Set it in API Keys & Email settings first." });
    }

    const otp = generateOTP();
    saveOTP(adminEmail, otp, "admin_change_password");

    const result = await sendEmail(
      adminEmail,
      "🔐 MediCare+ Admin Password Change OTP",
      otpEmailHtml(otp, "admin_change_password"),
      null, "otp"
    );

    if (result.skipped) return res.status(503).json({ error: "Email not configured. Add Brevo keys in API Keys settings." });
    if (result.error)   return res.status(500).json({ error: "Could not send OTP: " + result.error });

    res.json({ message: `OTP sent to ${adminEmail.split("@")[0]}@***`, email_hint: adminEmail.split("@")[0] + "@***" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 2: Verify OTP + update admin password
app.post("/api/admin/confirm-change-password", adminAuth, async (req, res) => {
  try {
    const { otp, new_password } = req.body;
    if (!otp || !new_password) return res.status(400).json({ error: "OTP and new password required" });
    if (new_password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const cfg = await getSettings();
    const adminEmail = cfg.admin_email;
    if (!adminEmail) return res.status(400).json({ error: "Admin email not set" });

    const check = verifyOTP(adminEmail, otp, "admin_change_password");
    if (!check.valid) return res.status(400).json({ error: check.error });

    // Save new password in settings table (hashed)
    const hashed = await bcrypt.hash(new_password, 10);
    await saveSetting("admin_password_hash", hashed);
    _settingsCache = null;

    res.json({ message: "Admin password changed successfully! Use your new password on next login." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ══ EMAIL BROADCAST (admin sends to all or specific patients) ═════
app.post("/api/admin/email-blast", adminAuth, async (req, res) => {
  try {
    const { subject, body, recipient_ids } = req.body;
    if (!subject || !body) return res.status(400).json({ error: "Subject and body required" });
    if (!recipient_ids || !recipient_ids.length) return res.status(400).json({ error: "No recipients" });

    // Fetch user emails from DB
    const { data: users, error } = await supabase
      .from("users")
      .select("id,name,email")
      .in("id", recipient_ids)
      .eq("is_active", true);
    if (error) throw error;

    const withEmail = (users || []).filter(u => u.email && u.email.includes("@"));
    if (!withEmail.length) return res.status(400).json({ error: "No valid email addresses found for selected recipients" });

    // Build branded HTML email
    const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f5f7fa;font-family:Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:linear-gradient(135deg,#0B6E6E,#11B5B5);padding:22px 28px;color:#fff">
    <h2 style="margin:0 0 4px;font-size:20px">🏥 MediCare+</h2>
    <p style="margin:0;opacity:.8;font-size:13px">${subject}</p>
  </div>
  <div style="padding:26px 28px;font-size:14px;color:#333;line-height:1.8">
    ${body.split("\n").join("<br>")}
  </div>
  <div style="padding:14px 28px;text-align:center;font-size:11px;color:#aaa;background:#f5f7fa;border-top:1px solid #eee">
    MediCare+ Hospital · You're receiving this because you registered with us
  </div>
</div></body></html>`;

    let sent = 0, failed = 0;
    // Send to all recipients (in batches to avoid rate limits)
    for (const user of withEmail) {
      try {
        const result = await sendEmail(user.email, subject, htmlBody, null, "blast");
        if (result.skipped || result.error) failed++;
        else sent++;
      } catch { failed++; }
      // Small delay between sends to respect Brevo rate limits
      if (withEmail.length > 5) await new Promise(r => setTimeout(r, 200));
    }

    res.json({
      message: `Email blast complete`,
      sent, failed, total: withEmail.length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ OFFERS & HEALTH PACKAGES ══════════════════════════════════════

// Public — user.html fetches this
app.get("/api/offers", async (req, res) => {
  const { data, error } = await supabase
    .from("offers").select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Admin — get all (including inactive)
app.get("/api/admin/offers", adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("offers").select("*")
    .order("sort_order", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Admin — create offer
app.post("/api/admin/offers", adminAuth, async (req, res) => {
  try {
    const { tag, title, description, value, is_active, sort_order } = req.body;
    if (!tag || !title || !value) return res.status(400).json({ error: "Tag, title, and value required" });
    const { data, error } = await supabase.from("offers").insert({
      tag: tag.toUpperCase(), title, description: description||"", value,
      is_active: is_active !== false, sort_order: sort_order || 0,
      updated_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    res.json({ message: "Offer created", offer: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — update offer
app.put("/api/admin/offers/:id", adminAuth, async (req, res) => {
  try {
    const { tag, title, description, value, is_active, sort_order } = req.body;
    const { error } = await supabase.from("offers").update({
      tag: tag?.toUpperCase(), title, description, value,
      is_active, sort_order, updated_at: new Date().toISOString()
    }).eq("id", req.params.id);
    if (error) throw error;
    res.json({ message: "Offer updated" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — delete offer
app.delete("/api/admin/offers/:id", adminAuth, async (req, res) => {
  const { error } = await supabase.from("offers").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "Offer deleted" });
});

// Admin — toggle active
app.patch("/api/admin/offers/:id/toggle", adminAuth, async (req, res) => {
  const { is_active } = req.body;
  const { error } = await supabase.from("offers")
    .update({ is_active, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "Updated" });
});


// ══ SCHEDULED EMAIL SETTINGS ══════════════════════════════════════

app.get("/api/admin/email-schedule", adminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from("settings").select("key,value")
      .in("key", ["schedule_enabled","schedule_interval","schedule_interval_unit","schedule_subject","schedule_body","schedule_last_sent","schedule_next_send"]);
    const map = {};
    (data||[]).forEach(r => { map[r.key] = r.value; });
    res.json({
      enabled:       map.schedule_enabled === "true",
      interval:      parseInt(map.schedule_interval || "7"),
      interval_unit: map.schedule_interval_unit || "days",
      subject:       map.schedule_subject || "",
      body:          map.schedule_body    || "",
      last_sent:     map.schedule_last_sent || null,
      next_send:     map.schedule_next_send  || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/admin/email-schedule", adminAuth, async (req, res) => {
  try {
    const { enabled, interval, interval_unit, subject, body } = req.body;
    const intervalDays = interval_unit === "weeks" ? (interval||1) * 7 : (interval||7);
    const nextSend = enabled
      ? new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const pairs = [
      ["schedule_enabled",       enabled ? "true" : "false"],
      ["schedule_interval",      String(interval || 7)],
      ["schedule_interval_unit", interval_unit || "days"],
      ["schedule_subject",       subject || ""],
      ["schedule_body",          body || ""],
      ["schedule_next_send",     nextSend || ""],
    ];
    for (const [key, value] of pairs) {
      await supabase.from("settings").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    }
    res.json({ message: "Schedule saved", next_send: nextSend });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trigger scheduled email now (also called by the check endpoint)
async function runScheduledEmailIfDue() {
  try {
    const { data } = await supabase.from("settings").select("key,value")
      .in("key", ["schedule_enabled","schedule_interval","schedule_interval_unit","schedule_subject","schedule_body","schedule_next_send"]);
    const map = {};
    (data||[]).forEach(r => { map[r.key] = r.value; });

    if (map.schedule_enabled !== "true") return { skipped: true, reason: "Schedule disabled" };
    if (!map.schedule_subject || !map.schedule_body) return { skipped: true, reason: "No subject or body configured" };

    const nextSend = map.schedule_next_send ? new Date(map.schedule_next_send) : null;
    if (nextSend && nextSend > new Date()) {
      return { skipped: true, reason: `Not due yet. Next send: ${nextSend.toLocaleString()}` };
    }

    // Fetch all active patients with emails
    const { data: users } = await supabase.from("users").select("id,name,email").eq("is_active", true).eq("is_admin", false);
    const recipients = (users||[]).filter(u => u.email && u.email.includes("@") && !u.email.includes("@deleted"));
    if (!recipients.length) return { skipped: true, reason: "No active patients with email" };

    const subject = map.schedule_subject;
    const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f5f7fa;font-family:Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:linear-gradient(135deg,#0B6E6E,#11B5B5);padding:22px 28px;color:#fff">
    <h2 style="margin:0 0 4px;font-size:20px">🏥 MediCare+</h2>
    <p style="margin:0;opacity:.8;font-size:13px">${subject}</p>
  </div>
  <div style="padding:26px 28px;font-size:14px;color:#333;line-height:1.8">
    ${map.schedule_body.split("\n").join("<br>")}
  </div>
  <div style="padding:14px 28px;text-align:center;font-size:11px;color:#aaa;background:#f5f7fa;border-top:1px solid #eee">
    MediCare+ Hospital · You received this as a registered patient
  </div>
</div></body></html>`;

    let sent = 0, failed = 0;
    for (const user of recipients) {
      const r = await sendEmail(user.email, subject, htmlBody, null, "scheduled");
      if (r.messageId) sent++; else failed++;
      if (recipients.length > 5) await new Promise(r => setTimeout(r, 200));
    }

    // Update last sent + compute next
    const intervalDays = map.schedule_interval_unit === "weeks"
      ? parseInt(map.schedule_interval||7) * 7
      : parseInt(map.schedule_interval||7);
    const nextSendDate = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000).toISOString();

    await supabase.from("settings").upsert([
      { key: "schedule_last_sent", value: new Date().toISOString(), updated_at: new Date().toISOString() },
      { key: "schedule_next_send", value: nextSendDate,             updated_at: new Date().toISOString() }
    ], { onConflict: "key" });

    console.log(`✅ Scheduled email sent: ${sent} sent, ${failed} failed`);
    return { sent, failed, total: recipients.length, next_send: nextSendDate };
  } catch (e) {
    console.error("Scheduled email error:", e.message);
    return { error: e.message };
  }
}

// Manual trigger endpoint + auto-check on each call
app.post("/api/admin/email-schedule/send-now", adminAuth, async (req, res) => {
  try {
    const result = await runScheduledEmailIfDue();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Heartbeat — call this from admin panel periodically to trigger due emails
app.get("/api/admin/email-schedule/check", adminAuth, async (req, res) => {
  const result = await runScheduledEmailIfDue();
  res.json(result);
});

app.get("/health", (req, res) => res.json({ status:"ok", v:"4.0", time: new Date().toISOString() }));
app.get("/", (req, res) => res.json({ message:"MediCare+ HMS v4.0 ✅" }));
app.use((req, res) => res.status(404).json({ error:`Not found: ${req.method} ${req.path}` }));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🏥 MediCare+ HMS v4.0 on port ${PORT}`);
  console.log(`🔐 Admin: ${ADMIN_ID} / ${ADMIN_PASS}`);
  console.log(`🤖 AI: Gemini 2.5 Flash (with fallback home remedies)`);
  console.log(`📧 Email: ${process.env.BREVO_API_KEY?"✅ BREVO_API_KEY env var set":"Check Admin Panel → API Keys → Brevo"}`);
});

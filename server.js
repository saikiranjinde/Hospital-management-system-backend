require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Firebase Admin Init ───────────────────────────────────────────
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // Fallback: load from local file for development
  try {
    serviceAccount = require("./serviceAccountKey.json");
  } catch {
    console.warn("No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT env var.");
  }
}

if (serviceAccount) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else {
  admin.initializeApp();
}

const db = admin.firestore();
const JWT_SECRET = process.env.JWT_SECRET || "medicare_super_secret_2025";

// ─── Auth Middleware ───────────────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

const adminMiddleware = (req, res, next) => {
  authMiddleware(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: "Admin access required" });
    next();
  });
};

// ─── Helper: Get Gemini API Key ───────────────────────────────────
async function getGeminiKey() {
  try {
    const doc = await db.collection("settings").doc("gemini").get();
    if (doc.exists && doc.data().apiKey) return doc.data().apiKey;
  } catch {}
  return process.env.GEMINI_API_KEY || "";
}

// ═══════════════════════════════════════════════════════════════════
// ─── AUTH ROUTES ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// Register
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, phone, age, bloodGroup } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing required fields" });

    const existingUser = await db.collection("users").where("email", "==", email).get();
    if (!existingUser.empty) return res.status(409).json({ error: "Email already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const userData = {
      id: userId, name, email, phone: phone || "", age: age || "",
      bloodGroup: bloodGroup || "", password: hashedPassword,
      isAdmin: false, createdAt: new Date().toISOString(), isActive: true
    };

    await db.collection("users").doc(userId).set(userData);
    const token = jwt.sign({ id: userId, email, name, isAdmin: false }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: userId, name, email, phone, age, bloodGroup, isAdmin: false } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    // Admin check
    if (email === "admin123" && password === "admin123") {
      const token = jwt.sign({ id: "admin", email: "admin123", name: "Administrator", isAdmin: true }, JWT_SECRET, { expiresIn: "7d" });
      return res.json({ token, user: { id: "admin", name: "Administrator", email: "admin123", isAdmin: true } });
    }

    const snapshot = await db.collection("users").where("email", "==", email).get();
    if (snapshot.empty) return res.status(404).json({ error: "User not found" });

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();
    const isValid = await bcrypt.compare(password, userData.password);
    if (!isValid) return res.status(401).json({ error: "Invalid password" });

    const token = jwt.sign(
      { id: userData.id, email: userData.email, name: userData.name, isAdmin: userData.isAdmin || false },
      JWT_SECRET, { expiresIn: "7d" }
    );
    const { password: _, ...safeUser } = userData;
    res.json({ token, user: safeUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Current User
app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    if (req.user.isAdmin && req.user.id === "admin") {
      return res.json({ id: "admin", name: "Administrator", email: "admin123", isAdmin: true });
    }
    const doc = await db.collection("users").doc(req.user.id).get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });
    const { password, ...safeUser } = doc.data();
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ─── DOCTORS ROUTES ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// Get all doctors (public)
app.get("/api/doctors", async (req, res) => {
  try {
    const snapshot = await db.collection("doctors").where("isActive", "==", true).get();
    const doctors = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all doctors including inactive (admin)
app.get("/api/admin/doctors", adminMiddleware, async (req, res) => {
  try {
    const snapshot = await db.collection("doctors").get();
    const doctors = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add doctor (admin)
app.post("/api/admin/doctors", adminMiddleware, async (req, res) => {
  try {
    const { name, specialization, qualification, experience, email, phone, availableDays, availableTimeStart, availableTimeEnd, consultationFee, image } = req.body;
    if (!name || !specialization) return res.status(400).json({ error: "Name and specialization are required" });
    const doctorId = uuidv4();
    const doctorData = {
      id: doctorId, name, specialization, qualification: qualification || "",
      experience: experience || 0, email: email || "", phone: phone || "",
      availableDays: availableDays || ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      availableTimeStart: availableTimeStart || "09:00",
      availableTimeEnd: availableTimeEnd || "17:00",
      consultationFee: consultationFee || 500,
      image: image || "", isActive: true, createdAt: new Date().toISOString()
    };
    await db.collection("doctors").doc(doctorId).set(doctorData);
    res.json({ message: "Doctor added successfully", doctor: doctorData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update doctor (admin)
app.put("/api/admin/doctors/:id", adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body, updatedAt: new Date().toISOString() };
    await db.collection("doctors").doc(id).update(updates);
    res.json({ message: "Doctor updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete / Deactivate doctor (admin)
app.delete("/api/admin/doctors/:id", adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection("doctors").doc(id).update({ isActive: false, updatedAt: new Date().toISOString() });
    res.json({ message: "Doctor deactivated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update doctor availability
app.patch("/api/admin/doctors/:id/availability", adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { availableDays, availableTimeStart, availableTimeEnd, isAvailableToday } = req.body;
    await db.collection("doctors").doc(id).update({
      availableDays, availableTimeStart, availableTimeEnd,
      isAvailableToday: isAvailableToday !== undefined ? isAvailableToday : true,
      updatedAt: new Date().toISOString()
    });
    res.json({ message: "Availability updated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ─── BOOKINGS ROUTES ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// Create booking (user)
app.post("/api/bookings", authMiddleware, async (req, res) => {
  try {
    const { doctorId, doctorName, specialization, patientName, patientAge, problem, appointmentDate, appointmentTime } = req.body;
    if (!doctorId || !problem || !appointmentDate || !appointmentTime) {
      return res.status(400).json({ error: "Missing required booking fields" });
    }
    const bookingId = uuidv4();
    const bookingData = {
      id: bookingId, userId: req.user.id, userName: req.user.name,
      userEmail: req.user.email, doctorId, doctorName: doctorName || "",
      specialization: specialization || "", patientName: patientName || req.user.name,
      patientAge: patientAge || "", problem, appointmentDate, appointmentTime,
      status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      adminNotes: "", aiSuggestion: ""
    };
    await db.collection("bookings").doc(bookingId).set(bookingData);

    // Create notification for user
    await db.collection("notifications").add({
      userId: req.user.id, title: "Appointment Booked! 🎉",
      message: `Your appointment with ${doctorName} on ${appointmentDate} at ${appointmentTime} has been submitted. Awaiting confirmation.`,
      type: "booking", isRead: false, createdAt: new Date().toISOString()
    });

    res.json({ message: "Booking created successfully", booking: bookingData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's own bookings
app.get("/api/bookings", authMiddleware, async (req, res) => {
  try {
    const snapshot = await db.collection("bookings")
      .where("userId", "==", req.user.id)
      .orderBy("createdAt", "desc").get();
    const bookings = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN BOOKING ROUTES ─────────────────────────────────────────

// Get all bookings (admin)
app.get("/api/admin/bookings", adminMiddleware, async (req, res) => {
  try {
    const { status, date } = req.query;
    let query = db.collection("bookings").orderBy("createdAt", "desc");
    const snapshot = await query.get();
    let bookings = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (status && status !== "all") bookings = bookings.filter((b) => b.status === status);
    if (date) bookings = bookings.filter((b) => b.appointmentDate === date);
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update booking status (admin)
app.patch("/api/admin/bookings/:id", adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNotes, appointmentDate, appointmentTime } = req.body;
    const bookingDoc = await db.collection("bookings").doc(id).get();
    if (!bookingDoc.exists) return res.status(404).json({ error: "Booking not found" });

    const booking = bookingDoc.data();
    const updates = { status, adminNotes: adminNotes || "", updatedAt: new Date().toISOString() };
    if (appointmentDate) updates.appointmentDate = appointmentDate;
    if (appointmentTime) updates.appointmentTime = appointmentTime;

    await db.collection("bookings").doc(id).update(updates);

    // Auto notification to patient
    const statusMessages = {
      confirmed: `✅ Your appointment with Dr. ${booking.doctorName} on ${updates.appointmentDate || booking.appointmentDate} at ${updates.appointmentTime || booking.appointmentTime} has been CONFIRMED!`,
      cancelled: `❌ Your appointment with Dr. ${booking.doctorName} has been cancelled. ${adminNotes ? "Reason: " + adminNotes : "Please rebook if needed."}`,
      completed: `🎊 Your appointment with Dr. ${booking.doctorName} is marked as completed. Thank you for choosing MediCare!`,
      rescheduled: `📅 Your appointment with Dr. ${booking.doctorName} has been rescheduled to ${updates.appointmentDate || booking.appointmentDate} at ${updates.appointmentTime || booking.appointmentTime}.`
    };

    if (statusMessages[status]) {
      await db.collection("notifications").add({
        userId: booking.userId, title: `Appointment ${status.charAt(0).toUpperCase() + status.slice(1)}`,
        message: statusMessages[status], type: "appointment_update",
        isRead: false, createdAt: new Date().toISOString()
      });
    }

    res.json({ message: "Booking updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ─── USER MANAGEMENT (ADMIN) ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

app.get("/api/admin/users", adminMiddleware, async (req, res) => {
  try {
    const snapshot = await db.collection("users").orderBy("createdAt", "desc").get();
    const users = snapshot.docs.map((d) => {
      const { password, ...u } = d.data();
      return u;
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/admin/users/:id", adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    await db.collection("users").doc(id).update({ isActive, updatedAt: new Date().toISOString() });
    res.json({ message: "User updated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ─── NOTIFICATIONS ROUTES ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// Get user notifications
app.get("/api/notifications", authMiddleware, async (req, res) => {
  try {
    let query;
    if (req.user.isAdmin) {
      const snapshot = await db.collection("notifications").orderBy("createdAt", "desc").limit(50).get();
      return res.json(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
    }
    const snapshot = await db.collection("notifications")
      .where("userId", "in", [req.user.id, "all"])
      .orderBy("createdAt", "desc").limit(30).get();
    res.json(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark notification as read
app.patch("/api/notifications/:id/read", authMiddleware, async (req, res) => {
  try {
    await db.collection("notifications").doc(req.params.id).update({ isRead: true });
    res.json({ message: "Notification marked as read" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send notification (admin) - can send to specific user or all
app.post("/api/admin/notifications", adminMiddleware, async (req, res) => {
  try {
    const { userId, title, message, type } = req.body;
    await db.collection("notifications").add({
      userId: userId || "all", title, message, type: type || "announcement",
      isRead: false, createdAt: new Date().toISOString()
    });
    res.json({ message: "Notification sent successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ─── AI / GEMINI ROUTES ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

app.post("/api/ai/suggest", authMiddleware, async (req, res) => {
  try {
    const { problem, patientAge, patientName } = req.body;
    if (!problem) return res.status(400).json({ error: "Problem description is required" });

    const apiKey = await getGeminiKey();
    if (!apiKey) return res.status(503).json({ error: "AI service not configured. Admin needs to add Gemini API key." });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `You are a compassionate medical assistant at MediCare Hospital. A patient named ${patientName || "the patient"}, aged ${patientAge || "unknown"}, is experiencing: "${problem}".

IMPORTANT RULES:
1. ONLY suggest home remedies and natural relief methods - NO medicines, NO drugs, NO supplements
2. Be warm, empathetic and reassuring
3. Keep suggestions practical and safe
4. Always remind them their doctor appointment is being confirmed
5. Format your response with clear sections

Please provide:
**🏠 Temporary Home Remedies:**
(List 4-6 practical home remedies for their symptoms)

**🫧 Comfort Measures:**
(2-3 immediate comfort tips)

**⚠️ When to Seek Immediate Help:**
(Warning signs they should watch for)

**💬 Reassurance:**
(A warm, encouraging message about their upcoming appointment)

Remember: Only home remedies, no medications.`;

    const result = await model.generateContent(prompt);
    const suggestion = result.response.text();

    // Save AI suggestion to the latest booking
    const bookingsSnap = await db.collection("bookings")
      .where("userId", "==", req.user.id)
      .orderBy("createdAt", "desc").limit(1).get();
    if (!bookingsSnap.empty) {
      await db.collection("bookings").doc(bookingsSnap.docs[0].id).update({ aiSuggestion: suggestion });
    }

    res.json({ suggestion });
  } catch (err) {
    console.error("Gemini error:", err.message);
    res.status(500).json({ error: "AI service error: " + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ─── SETTINGS ROUTES (ADMIN) ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

app.get("/api/settings", adminMiddleware, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("gemini").get();
    const envKey = process.env.GEMINI_API_KEY || "";
    if (doc.exists) {
      const data = doc.data();
      const key = data.apiKey || "";
      // Mask the key for display
      const maskedKey = key ? key.substring(0, 8) + "..." + key.substring(key.length - 4) : "";
      return res.json({ hasKey: !!key, maskedKey, source: "database", envKeySet: !!envKey });
    }
    res.json({ hasKey: !!envKey, maskedKey: envKey ? "From ENV" : "", source: "env", envKeySet: !!envKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/settings/gemini", adminMiddleware, async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ error: "API key is required" });
    await db.collection("settings").doc("gemini").set({ apiKey, updatedAt: new Date().toISOString() });
    res.json({ message: "Gemini API key updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health Check ──────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", service: "MediCare HMS", timestamp: new Date().toISOString() }));
app.get("/", (req, res) => res.json({ message: "MediCare Hospital Management System API", version: "1.0.0" }));

// ─── Start Server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🏥 MediCare HMS Server running on port ${PORT}`));

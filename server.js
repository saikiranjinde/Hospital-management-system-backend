const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Initialize services
let genAI;
let supabase;

try {
  if (process.env.GOOGLE_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  }
} catch (err) {
  console.error('Google AI init error:', err.message);
}

try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  }
} catch (err) {
  console.error('Supabase init error:', err.message);
}

// UUID Generator
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({
    status: 'Hospital Management System is running',
    timestamp: new Date(),
    port: PORT,
    googleAI: !!genAI,
    supabase: !!supabase
  });
});

// ============ AUTH ROUTES ============
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, userType } = req.body;

    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { data, error } = await supabase.auth.signUpWithPassword({
      email,
      password,
    });

    if (error) return res.status(400).json({ error: error.message });

    await supabase.from('users').insert([{
      id: data.user.id,
      email,
      name,
      user_type: userType,
    }]);

    res.json({ success: true, user: data.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, user: data.user, session: data.session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PATIENT ROUTES ============
app.get('/api/patients', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabase.from('patients').select('*');
    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/patients', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { name, email, phone, age, gender, medicalHistory } = req.body;

    const { data, error } = await supabase
      .from('patients')
      .insert([{
        id: generateUUID(),
        name,
        email,
        phone,
        age,
        gender,
        medical_history: medicalHistory,
      }])
      .select();

    if (error) throw error;

    res.json({ success: true, patient: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/patients/:id', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabase
      .from('patients')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ APPOINTMENT ROUTES ============
app.get('/api/appointments', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabase
      .from('appointments')
      .select('*, patients(name, email), doctors(name, specialization)')
      .order('appointment_date', { ascending: true });

    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/appointments', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { patientId, doctorId, appointmentDate, reason, notes } = req.body;

    const { data, error } = await supabase
      .from('appointments')
      .insert([{
        id: generateUUID(),
        patient_id: patientId,
        doctor_id: doctorId,
        appointment_date: appointmentDate,
        reason,
        notes,
        status: 'scheduled',
      }])
      .select();

    if (error) throw error;

    res.json({ success: true, appointment: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/appointments/:id', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { status } = req.body;

    const { data, error } = await supabase
      .from('appointments')
      .update({ status })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;

    res.json({ success: true, appointment: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ DOCTOR ROUTES ============
app.get('/api/doctors', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabase.from('doctors').select('*');
    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/doctors', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { name, email, phone, specialization, licenseNumber } = req.body;

    const { data, error } = await supabase
      .from('doctors')
      .insert([{
        id: generateUUID(),
        name,
        email,
        phone,
        specialization,
        license_number: licenseNumber,
      }])
      .select();

    if (error) throw error;

    res.json({ success: true, doctor: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ MEDICAL RECORDS ============
app.get('/api/medical-records/:patientId', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabase
      .from('medical_records')
      .select('*')
      .eq('patient_id', req.params.patientId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/medical-records', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { patientId, recordType, description, findings } = req.body;

    const { data, error } = await supabase
      .from('medical_records')
      .insert([{
        id: generateUUID(),
        patient_id: patientId,
        record_type: recordType,
        description,
        findings,
      }])
      .select();

    if (error) throw error;

    res.json({ success: true, record: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ AI CHAT ============
app.post('/api/chat', async (req, res) => {
  try {
    if (!genAI) return res.status(500).json({ error: 'Google AI not configured' });

    const { message, patientData } = req.body;

    const systemPrompt = `You are a helpful hospital medical assistant. You help patients understand their symptoms and conditions.
IMPORTANT: You are NOT a replacement for real doctors. Always recommend consulting with a healthcare professional.

Patient Info:
- Age: ${patientData?.age || 'Not provided'}
- Gender: ${patientData?.gender || 'Not provided'}
- Medical History: ${patientData?.medicalHistory || 'Not provided'}

Provide empathetic responses and remind patients to consult with a doctor.`;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: message }] }],
      systemInstruction: systemPrompt,
    });

    const response = result.response.text();

    res.json({
      success: true,
      response,
      timestamp: new Date()
    });
  } catch (err) {
    console.error('AI Chat Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ NOTIFICATIONS ============
app.get('/api/notifications/:userId', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { userId, patientId, appointmentId, type, title, message } = req.body;

    const { data, error } = await supabase
      .from('notifications')
      .insert([{
        id: generateUUID(),
        user_id: userId,
        patient_id: patientId,
        appointment_id: appointmentId,
        type,
        title,
        message,
      }])
      .select();

    if (error) throw error;

    res.json({ success: true, notification: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabase
      .from('notifications')
      .update({ read: true, read_at: new Date() })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;

    res.json({ success: true, notification: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notifications/:id', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ADMIN APPOINTMENTS ============
app.get('/api/admin/appointments-pending', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabase
      .from('appointments')
      .select(`*,
        patients(name, email, phone),
        doctors(name, specialization, email),
        appointment_confirmations(*)
      `)
      .order('appointment_date', { ascending: true });

    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/confirm-appointment', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { appointmentId, doctorId, adminNotes, suggestedDate } = req.body;

    const { data: confirmData, error: confirmError } = await supabase
      .from('appointment_confirmations')
      .insert([{
        id: generateUUID(),
        appointment_id: appointmentId,
        confirmed_by: doctorId,
        confirmation_date: new Date(),
        admin_notes: adminNotes,
        suggested_date: suggestedDate || null,
        status: suggestedDate ? 'suggested' : 'confirmed',
      }])
      .select();

    if (confirmError) throw confirmError;

    const { data: aptData, error: aptError } = await supabase
      .from('appointments')
      .update({ status: suggestedDate ? 'rescheduled' : 'confirmed' })
      .eq('id', appointmentId)
      .select();

    if (aptError) throw aptError;

    res.json({ success: true, confirmation: confirmData[0], appointment: aptData[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/reject-appointment/:id', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const { reason } = req.body;

    const { data: aptData, error: aptError } = await supabase
      .from('appointments')
      .update({ status: 'cancelled' })
      .eq('id', req.params.id)
      .select();

    if (aptError) throw aptError;

    res.json({ success: true, appointment: aptData[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ANALYTICS ============
app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Database not configured' });

    const patientsCount = await supabase
      .from('patients')
      .select('*', { count: 'exact', head: true });

    const appointmentsCount = await supabase
      .from('appointments')
      .select('*', { count: 'exact', head: true });

    const doctorsCount = await supabase
      .from('doctors')
      .select('*', { count: 'exact', head: true });

    res.json({
      totalPatients: patientsCount.count || 0,
      totalAppointments: appointmentsCount.count || 0,
      totalDoctors: doctorsCount.count || 0,
      timestamp: new Date()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message });
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log(`🏥 Hospital Management System running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Google AI: ${genAI ? '✓' : '✗'}`);
  console.log(`Supabase: ${supabase ? '✓' : '✗'}`);
});

module.exports = app;

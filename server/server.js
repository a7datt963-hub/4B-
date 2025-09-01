// =====================
// server.js (نسخة مدمجة)
// =====================
require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// ------------ CONFIG ------------
const CFG = {
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || "",
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || "",
  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || "",
  BOT_BALANCE_CHAT: process.env.BOT_BALANCE_CHAT || "",
  BOT_ADMIN_CMD_TOKEN: process.env.BOT_ADMIN_CMD_TOKEN || "",
  BOT_ADMIN_CMD_CHAT: process.env.BOT_ADMIN_CMD_CHAT || "",
  BOT_LOGIN_REPORT_TOKEN: process.env.BOT_LOGIN_REPORT_TOKEN || "",
  BOT_LOGIN_REPORT_CHAT: process.env.BOT_LOGIN_REPORT_CHAT || "",
  BOT_HELP_TOKEN: process.env.BOT_HELP_TOKEN || "",
  BOT_HELP_CHAT: process.env.BOT_HELP_CHAT || "",
  BOT_OFFERS_TOKEN: process.env.BOT_OFFERS_TOKEN || "",
  BOT_OFFERS_CHAT: process.env.BOT_OFFERS_CHAT || "",
  BOT_NOTIFY_TOKEN: process.env.BOT_NOTIFY_TOKEN || "",
  BOT_NOTIFY_CHAT: process.env.BOT_NOTIFY_CHAT || "",
  IMGBB_KEY: process.env.IMGBB_KEY || ""
};

const DATA_FILE = path.join(__dirname, 'data.json');

// ------------ Supabase init ------------
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);

let supabase = null;
if (SUPABASE_ENABLED) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('✅ Supabase client ready');
} else {
  console.log('⚠️ Supabase not enabled (check env vars)');
}

// ------------ Local JSON fallback ------------
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const init = { profiles: [], orders: [], charges: [], offers: [], notifications: [] };
      fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { profiles: [], orders: [], charges: [], offers: [], notifications: [] };
  }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
let DB = loadData();

// ------------ Static files ------------
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/', express.static(PUBLIC_DIR));

// ------------ Uploads ------------
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
  try {
    if (CFG.IMGBB_KEY) {
      try {
        const imgBase64 = req.file.buffer.toString('base64');
        const params = new URLSearchParams();
        params.append('image', imgBase64);
        params.append('name', req.file.originalname || `upload-${Date.now()}`);
        const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${CFG.IMGBB_KEY}`, { method: 'POST', body: params });
        const imgbbJson = await imgbbResp.json().catch(() => null);
        if (imgbbJson && imgbbJson.success && imgbbJson.data && imgbbJson.data.url) {
          return res.json({ ok: true, url: imgbbJson.data.url, provider: 'imgbb' });
        }
      } catch { }
    }
    const safeName = Date.now() + '-' + req.file.originalname.replace(/\s+/g, '_');
    fs.writeFileSync(path.join(UPLOADS_DIR, safeName), req.file.buffer);
    return res.json({ ok: true, url: `/uploads/${safeName}`, provider: 'local' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------ Helpers ------------
async function findProfileByEmailOrPhone({ email, phone }) {
  if (SUPABASE_ENABLED) {
    if (email) {
      const { data } = await supabase.from('profiles').select('*').eq('email', email).maybeSingle();
      if (data) return data;
    }
    if (phone) {
      const { data } = await supabase.from('profiles').select('*').eq('phone', phone).maybeSingle();
      if (data) return data;
    }
    return null;
  } else {
    return DB.profiles.find(p => p.email === email || p.phone === phone) || null;
  }
}

async function insertProfile(p) {
  if (SUPABASE_ENABLED) {
    const { error } = await supabase.from('profiles').insert([p]);
    if (error) console.error('insertProfile error', error);
  } else {
    DB.profiles.push(p); saveData(DB);
  }
}

// ------------ API endpoints ------------

// إنشاء حساب
app.post('/api/register', async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!email && !phone) return res.status(400).json({ ok: false, error: 'email_or_phone_required' });

  const existing = await findProfileByEmailOrPhone({ email, phone });
  if (existing) return res.status(409).json({ ok: false, error: 'account_exists' });

  const personalNumber = String(Math.floor(1000000 + Math.random() * 9000000));
  const profile = { personal_number: personalNumber, name, email, phone, password, balance: 0 };

  await insertProfile(profile);
  res.json({ ok: true, profile });
});

// البحث عن حساب
app.post('/api/search-profile', async (req, res) => {
  const { email, phone } = req.body;
  const profile = await findProfileByEmailOrPhone({ email, phone });
  if (!profile) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, profile });
});

// تسجيل الدخول
app.post('/api/login', async (req, res) => {
  const { email, phone, password } = req.body;
  const profile = await findProfileByEmailOrPhone({ email, phone });
  if (!profile) return res.status(404).json({ ok: false, error: 'not_found' });
  if (profile.password !== password) return res.status(403).json({ ok: false, error: 'wrong_password' });
  res.json({ ok: true, profile });
});

// (ممكن تضيف باقي الـ endpoints الخاصة بالطلبات/الشحن مثل ملفك الأصلي)

// ------------ Fallback ------------
app.get('*', (req, res) => {
  const pIndex = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(pIndex)) return res.sendFile(pIndex);
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  res.status(404).send('index.html not found');
});

// ------------ Start server ------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

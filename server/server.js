// server.js
// نسخة مُعدّلة: يدعم Supabase (اختياري) أو fallback محلي عبر data.json
// يتضمن: /api/ping, /api/search-profile, /api/register, /api/login, /api/upload, /api/charges, /api/support
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- Config ---------- */
const CFG = {
  IMGBB_KEY: process.env.IMGBB_KEY || ''
};

const DATA_FILE = path.join(__dirname, 'data.json');

/* ---------- Supabase init (optional) ---------- */
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || ''; // ضع هنا اسم المتغير كما في Render
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);

let supabase = null;
if (SUPABASE_ENABLED) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('Supabase enabled');
  } catch (e) {
    console.error('Failed to init supabase client', e);
  }
} else {
  console.log('Supabase NOT enabled (SUPABASE_URL / SUPABASE_SERVICE_KEY missing)');
}

/* ---------- Local JSON DB (fallback) ---------- */
function loadData(){
  try{
    if(!fs.existsSync(DATA_FILE)){
      const init = { profiles: [], orders: [], charges: [], offers: [], notifications: [], profileEditRequests: {}, blocked: [], tgOffsets: {} };
      fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  }catch(e){
    console.error('loadData error', e);
    return { profiles:[], orders:[], charges:[], offers:[], notifications:[], profileEditRequests:{}, blocked:[], tgOffsets:{} };
  }
}
function saveData(d){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }catch(e){ console.error('saveData error', e); } }
let DB = loadData();

/* ---------- Helpers ---------- */
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended:true, limit:'10mb' }));

const PUBLIC_DIR = path.join(__dirname, 'public');
if(!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/', express.static(PUBLIC_DIR));

/* Multer for uploads (memory) */
const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

/* ---------- Simple helpers for profiles (Supabase or local) ---------- */
async function findProfileByPersonal(personal){
  if(SUPABASE_ENABLED){
    try{
      const { data, error } = await supabase.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if(error) { console.warn('supabase findProfile error', error); return null; }
      if(!data) return null;
      return {
        personalNumber: data.personal_number,
        name: data.name,
        email: data.email,
        phone: data.phone,
        password: data.password,
        balance: Number(data.balance || 0),
        canEdit: !!data.can_edit,
        lastLogin: data.last_login
      };
    }catch(e){ console.error(e); return null; }
  } else {
    return DB.profiles.find(p => String(p.personalNumber) === String(personal)) || null;
  }
}

async function findProfileByEmailOrPhone({ email, phone }){
  if(SUPABASE_ENABLED){
    try{
      if(email){
        const normEmail = String(email).trim().toLowerCase();
        const { data, error } = await supabase.from('profiles').select('*').ilike('email', normEmail).limit(1).maybeSingle();
        if(error) console.warn('supabase find by email err', error);
        if(data) return {
          personalNumber: data.personal_number,
          name: data.name,
          email: data.email,
          phone: data.phone,
          password: data.password,
          balance: Number(data.balance || 0),
          canEdit: !!data.can_edit
        };
      }
      if(phone){
        const normPhone = String(phone).trim();
        const { data, error } = await supabase.from('profiles').select('*').eq('phone', normPhone).limit(1).maybeSingle();
        if(error) console.warn('supabase find by phone err', error);
        if(data) return {
          personalNumber: data.personal_number,
          name: data.name,
          email: data.email,
          phone: data.phone,
          password: data.password,
          balance: Number(data.balance || 0),
          canEdit: !!data.can_edit
        };
      }
      return null;
    }catch(e){ console.error(e); return null; }
  } else {
    if(email){
      const normEmail = String(email).trim().toLowerCase();
      const p = DB.profiles.find(pp => pp.email && String(pp.email).toLowerCase() === normEmail);
      if(p) return p;
    }
    if(phone){
      const normPhone = String(phone).trim();
      const p = DB.profiles.find(pp => pp.phone && String(pp.phone) === normPhone);
      if(p) return p;
    }
    return null;
  }
}

/* ---------- Upload endpoint (imgbb fallback + local) ---------- */
app.post('/api/upload', uploadMemory.single('file'), async (req, res) => {
  if(!req.file) return res.status(400).json({ ok:false, error:'no_file' });
  try{
    // try imgbb if key present
    if(CFG.IMGBB_KEY){
      try{
        const imgBase64 = req.file.buffer.toString('base64');
        const params = new URLSearchParams();
        params.append('image', imgBase64);
        params.append('name', req.file.originalname || `upload-${Date.now()}`);
        const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${CFG.IMGBB_KEY}`, { method:'POST', body: params });
        const imgbbJson = await imgbbResp.json().catch(()=>null);
        if(imgbbJson && imgbbJson.success && imgbbJson.data && imgbbJson.data.url){
          return res.json({ ok:true, url: imgbbJson.data.url, provider:'imgbb' });
        }
      }catch(e){ console.warn('imgbb upload failed', e); }
    }

    // fallback local save
    const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
    if(!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const safeName = Date.now() + '-' + (req.file.originalname ? req.file.originalname.replace(/\s+/g,'_') : 'upload.jpg');
    const destPath = path.join(UPLOADS_DIR, safeName);
    fs.writeFileSync(destPath, req.file.buffer);
    const fullUrl = `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(safeName)}`;
    return res.json({ ok:true, url: fullUrl, provider:'local' });
  }catch(err){
    console.error('upload handler error', err);
    return res.status(500).json({ ok:false, error: err.message || 'upload_failed' });
  }
});

/* ---------- Simple ping for debugging ---------- */
app.get('/api/ping', (req, res) => res.json({ ok:true, now: new Date().toISOString() }));

/* ---------- search-profile ---------- */
app.post('/api/search-profile', async (req, res) => {
  try {
    const { email, phone } = req.body || {};
    if(!email && !phone) return res.status(400).json({ ok:false, error:'need_email_or_phone' });

    const prof = await findProfileByEmailOrPhone({ email, phone });
    if(!prof) return res.status(404).json({ ok:false, error:'not_found' });
    return res.json({ ok:true, profile: prof });
  } catch (err) {
    console.error('search-profile err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- register (deterministic personal number, collision handling) ---------- */
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};
    if(!name) return res.status(400).json({ ok:false, error:'missing_name' });
    if(!email && !phone) return res.status(400).json({ ok:false, error:'need_email_or_phone' });

    const normName = String(name).trim();
    const normEmail = email ? String(email).trim().toLowerCase() : null;
    const normPhone = phone ? String(phone).trim() : null;

    // existing?
    const existing = await findProfileByEmailOrPhone({ email: normEmail, phone: normPhone });
    if(existing) return res.json({ ok:true, profile: existing });

    // deterministic number from hash
    const baseForHash = ((normEmail || '') + '|' + (normPhone || '') + '|' + normName);
    const hash = crypto.createHash('sha256').update(baseForHash).digest('hex');
    let num = parseInt(hash.slice(0, 12), 16) % 10000000; // 0..9999999
    let personalNumber = String(num).padStart(7, '0');

    // collision resolution
    let tries = 0;
    while (true) {
      if (SUPABASE_ENABLED){
        const { data: dup } = await supabase.from('profiles').select('*').eq('personal_number', personalNumber).limit(1).maybeSingle();
        if(!dup) break;
        const sameEmail = normEmail && dup.email && String(dup.email).toLowerCase() === normEmail;
        const samePhone = normPhone && dup.phone && String(dup.phone) === normPhone;
        if(sameEmail || samePhone){
          return res.json({ ok:true, profile: {
            personalNumber: dup.personal_number, name: dup.name, email: dup.email, phone: dup.phone, password: dup.password, balance: Number(dup.balance||0), canEdit: !!dup.can_edit
          }});
        }
      } else {
        const dupLocal = DB.profiles.find(p => String(p.personalNumber) === personalNumber);
        if(!dupLocal) break;
        const sameEmail = normEmail && dupLocal.email && String(dupLocal.email).toLowerCase() === normEmail;
        const samePhone = normPhone && dupLocal.phone && String(dupLocal.phone) === normPhone;
        if(sameEmail || samePhone) return res.json({ ok:true, profile: dupLocal });
      }

      tries++;
      personalNumber = String((parseInt(personalNumber, 10) + tries) % 10000000).padStart(7, '0');
      if(tries > 50) personalNumber = String(Date.now()).slice(-7);
    }

    // insert
    if(SUPABASE_ENABLED){
      const toInsert = {
        personal_number: personalNumber, name: normName, email: normEmail || '', phone: normPhone || '', password: password || '', balance: 0, can_edit: false, last_login: null
      };
      const { error } = await supabase.from('profiles').insert(toInsert);
      if(error) { console.error('supabase insert profile err', error); return res.status(500).json({ ok:false, error:'db_insert_error' }); }
      return res.json({ ok:true, profile: { personalNumber: toInsert.personal_number, name: toInsert.name, email: toInsert.email, phone: toInsert.phone, password: toInsert.password, balance:0, canEdit:false }});
    } else {
      const newProf = { personalNumber, name: normName, email: normEmail||'', phone: normPhone||'', password: password||'', balance:0, canEdit:false, lastLogin: null };
      DB.profiles.push(newProf);
      saveData(DB);
      return res.json({ ok:true, profile: newProf });
    }

  } catch (err) {
    console.error('register err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- login ---------- */
app.post('/api/login', async (req, res) => {
  try{
    const { personalNumber, email, password } = req.body || {};
    let p = null;
    if(SUPABASE_ENABLED){
      if(personalNumber) p = await findProfileByPersonal(personalNumber);
      else if(email) {
        const { data } = await supabase.from('profiles').select('*').ilike('email', String(email)).limit(1).maybeSingle();
        if(data) p = { personalNumber: data.personal_number, name: data.name, email: data.email, phone: data.phone, password: data.password, balance: Number(data.balance||0), canEdit: !!data.can_edit };
      }
      if(!p) return res.status(404).json({ ok:false, error:'not_found' });
      if(p.password && String(p.password).length > 0){
        if(typeof password === 'undefined' || String(password) !== String(p.password)) return res.status(401).json({ ok:false, error:'invalid_password' });
      }
      await supabase.from('profiles').update({ last_login: new Date().toISOString() }).eq('personal_number', String(p.personalNumber));
      return res.json({ ok:true, profile: p });
    } else {
      if(personalNumber) p = DB.profiles.find(x => String(x.personalNumber) === String(personalNumber));
      else if(email) p = DB.profiles.find(x => x.email && String(x.email).toLowerCase() === String(email).toLowerCase());
      if(!p) return res.status(404).json({ ok:false, error:'not_found' });
      if(p.password && String(p.password).length > 0){
        if(typeof password === 'undefined' || String(password) !== String(p.password)) return res.status(401).json({ ok:false, error:'invalid_password' });
      }
      p.lastLogin = new Date().toISOString();
      saveData(DB);
      return res.json({ ok:true, profile: p });
    }
  }catch(err){
    console.error('login err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- charges (topups) ---------- */
app.post('/api/charges', async (req, res) => {
  try {
    const { personal, phone, amount, method, fileLink } = req.body || {};
    if(!personal || !amount) return res.status(400).json({ ok:false, error:'missing_fields' });

    if(SUPABASE_ENABLED){
      const toInsert = {
        personal_number: String(personal),
        phone: phone || '',
        amount: Number(amount),
        method: method || '',
        file_link: fileLink || '',
        status: 'pending',
        created_at: new Date().toISOString()
      };
      const { error } = await supabase.from('charges').insert(toInsert);
      if(error) { console.error('supabase charges insert err', error); return res.status(500).json({ ok:false, error:'db_insert_error' }); }
      return res.json({ ok:true, charge: toInsert });
    } else {
      const newId = Date.now();
      const rec = { id: newId, personal, phone: phone||'', amount: Number(amount), method: method||'', file_link: fileLink||'', status:'pending', created_at: new Date().toISOString() };
      DB.charges.push(rec);
      saveData(DB);
      return res.json({ ok:true, charge: rec });
    }
  } catch (err) {
    console.error('/api/charges err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- support / notifications ---------- */
app.post('/api/support', async (req, res) => {
  try {
    const { personal, text } = req.body || {};
    if(!personal || !text) return res.status(400).json({ ok:false, error:'missing_fields' });

    if(SUPABASE_ENABLED){
      const row = { id: `notif-${Date.now()}`, personal: String(personal), text: String(text), read:false, created_at: new Date().toISOString() };
      const { error } = await supabase.from('notifications').insert(row);
      if(error) { console.error('supabase notifications insert err', error); return res.status(500).json({ ok:false, error:'db_insert_error' }); }
      return res.json({ ok:true });
    } else {
      const n = { id: `notif-${Date.now()}`, personal: String(personal), text: String(text), read:false, created_at: new Date().toISOString() };
      DB.notifications.push(n);
      saveData(DB);
      return res.json({ ok:true });
    }
  } catch (err) {
    console.error('/api/support err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- fallback SPA handler (serve index.html) ---------- */
app.get('*', (req, res) => {
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if(fs.existsSync(indexFile)) return res.sendFile(indexFile);
  return res.status(404).send('Not Found');
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} — ENV SUPABASE_ENABLED=${SUPABASE_ENABLED}`);
});

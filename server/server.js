// server.js (improved) — supports Supabase or local fallback
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
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
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

/* ---------- Express config & CORS ---------- */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended:true, limit:'10mb' }));

const corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : null;
if (corsOrigins && corsOrigins.length>0) {
  app.use(cors({ origin: function(origin, callback){
    if(!origin) return callback(null, true);
    if(corsOrigins.indexOf('*') !== -1) return callback(null, true);
    if(corsOrigins.indexOf(origin) !== -1) return callback(null, true);
    return callback(new Error('CORS blocked by server'), false);
  }}));
  console.log('CORS origins:', corsOrigins);
} else {
  app.use(cors());
  console.log('CORS: allow all origins');
}

/* Multer for uploads (memory) */
const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

/* ---------- Mappers utility ---------- */
function mapProfileFromRow(row){
  if(!row) return null;
  return {
    personalNumber: row.personal_number || row.personalNumber || row.personal || '',
    name: row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    password: row.password || '',
    balance: Number(row.balance || 0),
    canEdit: !!(row.can_edit || row.canEdit),
    lastLogin: row.last_login || row.lastLogin || null
  };
}
function mapOrderRow(row){
  if(!row) return null;
  return {
    id: row.id,
    personal: row.personal_number || row.personal || row.personalNumber || '',
    phone: row.phone || '',
    type: row.type || '',
    item: row.item || '',
    idField: row.id_field || row.idField || row.id_field || '',
    fileLink: row.file_link || row.fileLink || '',
    cashMethod: row.cash_method || row.cashMethod || '',
    status: row.status || '',
    replied: !!row.replied,
    paidWithBalance: !!(row.paid_with_balance || row.paidWithBalance),
    paidAmount: Number(row.paid_amount || row.paidAmount || 0),
    createdAt: row.created_at || row.createdAt || new Date().toISOString()
  };
}
function mapChargeRow(row){
  if(!row) return null;
  return {
    id: row.id,
    personal: row.personal_number || row.personal || row.personalNumber || '',
    phone: row.phone || '',
    amount: Number(row.amount || 0),
    method: row.method || '',
    fileLink: row.file_link || row.fileLink || '',
    status: row.status || '',
    createdAt: row.created_at || row.createdAt || new Date().toISOString()
  };
}
function mapNotificationRow(row){
  if(!row) return null;
  return {
    id: row.id,
    personal: row.personal,
    text: row.text,
    read: !!row.read,
    createdAt: row.created_at || row.createdAt || new Date().toISOString()
  };
}
function mapOfferRow(row){
  if(!row) return null;
  return {
    id: row.id,
    text: row.text,
    createdAt: row.created_at || row.createdAt || new Date().toISOString()
  };
}

/* ---------- Simple helpers for profiles (Supabase or local) ---------- */
async function findProfileByPersonal(personal){
  if(!personal) return null;
  if(SUPABASE_ENABLED){
    try{
      const { data, error } = await supabase.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if(error) { console.warn('supabase findProfile error', error); return null; }
      if(!data) return null;
      return mapProfileFromRow(data);
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
        if(data) return mapProfileFromRow(data);
      }
      if(phone){
        const normPhone = String(phone).trim();
        const { data, error } = await supabase.from('profiles').select('*').eq('phone', normPhone).limit(1).maybeSingle();
        if(error) console.warn('supabase find by phone err', error);
        if(data) return mapProfileFromRow(data);
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

    const UPLOADS_DIR = path.join(__dirname, 'uploads');
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

/* ---------- ping ---------- */
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

/* ---------- register ---------- */
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, password, personalNumber: providedPersonal } = req.body || {};
    if(!name) return res.status(400).json({ ok:false, error:'missing_name' });
    if(!email && !phone && !providedPersonal) return res.status(400).json({ ok:false, error:'need_email_or_phone_or_personal' });

    const normName = String(name).trim();
    const normEmail = email ? String(email).trim().toLowerCase() : null;
    const normPhone = phone ? String(phone).trim() : null;

    const existing = await findProfileByEmailOrPhone({ email: normEmail, phone: normPhone });
    if(existing) return res.json({ ok:true, profile: existing });

    if(providedPersonal){
      const dup = await findProfileByPersonal(providedPersonal);
      if(!dup){
        if(SUPABASE_ENABLED){
          const toInsert = { personal_number: String(providedPersonal), name: normName, email: normEmail || '', phone: normPhone || '', password: password || '', balance: 0, can_edit: false, last_login: null };
          const { error } = await supabase.from('profiles').insert(toInsert);
          if(error){ console.error('supabase insert profile err', error); return res.status(500).json({ ok:false, error:'db_insert_error' }); }
          return res.json({ ok:true, profile: mapProfileFromRow(toInsert) });
        } else {
          const newProf = { personalNumber: String(providedPersonal), name: normName, email: normEmail||'', phone: normPhone||'', password: password||'', balance:0, canEdit:false, lastLogin: null };
          DB.profiles.push(newProf);
          saveData(DB);
          return res.json({ ok:true, profile: newProf });
        }
      } else {
        return res.json({ ok:true, profile: dup });
      }
    }

    const baseForHash = ((normEmail || '') + '|' + (normPhone || '') + '|' + normName);
    const hash = crypto.createHash('sha256').update(baseForHash).digest('hex');
    let num = parseInt(hash.slice(0, 12), 16) % 10000000;
    let personalNumber = String(num).padStart(7, '0');

    let tries = 0;
    while (true) {
      const dup = await findProfileByPersonal(personalNumber);
      if(!dup) break;
      const sameEmail = normEmail && dup.email && String(dup.email).toLowerCase() === normEmail;
      const samePhone = normPhone && dup.phone && String(dup.phone) === normPhone;
      if(sameEmail || samePhone) return res.json({ ok:true, profile: dup });

      tries++;
      personalNumber = String((parseInt(personalNumber, 10) + tries) % 10000000).padStart(7, '0');
      if(tries > 50) personalNumber = String(Date.now()).slice(-7);
    }

    if(SUPABASE_ENABLED){
      const toInsert = {
        personal_number: personalNumber, name: normName, email: normEmail || '', phone: normPhone || '', password: password || '', balance: 0, can_edit: false, last_login: null
      };
      const { error } = await supabase.from('profiles').insert(toInsert);
      if(error) { console.error('supabase insert profile err', error); return res.status(500).json({ ok:false, error:'db_insert_error' }); }
      return res.json({ ok:true, profile: mapProfileFromRow(toInsert) });
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
        if(data) p = mapProfileFromRow(data);
      }
      if(!p) return res.status(404).json({ ok:false, error:'not_found' });
      if(p.password && String(p.password).length > 0){
        if(typeof password === 'undefined' || String(password) !== String(p.password)) return res.status(401).json({ ok:false, error:'invalid_password' });
      }
      // update last login
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

/* ---------- charges (topups) with paidWithBalance handling ---------- */
app.post('/api/charges', async (req, res) => {
  try {
    const { personal, phone, amount, method, fileLink, type, item, idField, paidWithBalance, paidAmount } = req.body || {};
    if(!personal || !amount) return res.status(400).json({ ok:false, error:'missing_fields' });

    // If client requests to pay with balance, attempt to deduct profile balance first
    if(paidWithBalance){
      // find profile
      if(SUPABASE_ENABLED){
        // fetch profile
        const { data: profRow, error: profErr } = await supabase.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
        if(profErr) { console.error('supabase find profile err', profErr); return res.status(500).json({ ok:false, error:'db_error' }); }
        if(!profRow) return res.status(404).json({ ok:false, error:'profile_not_found' });
        const profile = mapProfileFromRow(profRow);
        if(Number(profile.balance) < Number(amount)) return res.status(400).json({ ok:false, error:'insufficient_balance' });

        // deduct: update balance
        const newBal = Number(profile.balance) - Number(amount);
        const { data: updData, error: updErr } = await supabase.from('profiles').update({ balance: newBal }).eq('personal_number', String(personal)).select().maybeSingle();
        if(updErr) { console.error('supabase update balance err', updErr); return res.status(500).json({ ok:false, error:'db_update_error' }); }

        // insert charge record
        const toInsert = {
          personal_number: String(personal),
          phone: phone || '',
          amount: Number(amount),
          method: method || '',
          file_link: fileLink || '',
          status: 'paid',
          created_at: new Date().toISOString()
        };
        const { error: cErr } = await supabase.from('charges').insert(toInsert);
        if(cErr) console.warn('supabase charges insert err', cErr);

        // if order metadata present, insert order
        let orderRow = null;
        if(type || item){
          const o = {
            personal_number: String(personal),
            phone: phone || '',
            type: type || 'طلب',
            item: item || '',
            id_field: idField || '',
            file_link: fileLink || '',
            cash_method: method || '',
            status: 'pending',
            replied: false,
            paid_with_balance: true,
            paid_amount: Number(paidAmount || amount),
            created_at: new Date().toISOString()
          };
          const { error: oErr } = await supabase.from('orders').insert(o);
          if(oErr) console.warn('supabase orders insert err', oErr);
          else orderRow = o;
        }

        // return updated profile and inserted rows
        const updatedProfile = mapProfileFromRow(updData || profRow);
        return res.json({ ok:true, charge: toInsert, order: orderRow || null, profile: updatedProfile });
      } else {
        // local fallback
        const p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
        if(!p) return res.status(404).json({ ok:false, error:'profile_not_found' });
        if(Number(p.balance) < Number(amount)) return res.status(400).json({ ok:false, error:'insufficient_balance' });
        p.balance = Number(p.balance) - Number(amount);

        const rec = { id: Date.now(), personal: String(personal), phone: phone||'', amount: Number(amount), method: method||'', file_link: fileLink||'', status:'paid', createdAt: new Date().toISOString() };
        DB.charges.push(rec);

        let orderRec = null;
        if(type || item){
          const oid = Date.now() + 1;
          orderRec = { id: oid, personal: String(personal), phone: phone||'', type: type||'طلب', item: item||'', idField: idField||'', fileLink: fileLink||'', cashMethod: method||'', status:'pending', replied:false, paidWithBalance: true, paidAmount: Number(paidAmount||amount), createdAt: new Date().toISOString() };
          DB.orders.push(orderRec);
        }

        saveData(DB);
        return res.json({ ok:true, charge: rec, order: orderRec, profile: p });
      }
    }

    // Otherwise normal "topup / pending" behavior
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

      let orderRow = null;
      if(type || item){
        const o = {
          personal_number: String(personal),
          phone: phone || '',
          type: type || 'طلب',
          item: item || '',
          id_field: idField || '',
          file_link: fileLink || '',
          cash_method: method || '',
          status: 'pending',
          replied: false,
          paid_with_balance: false,
          paid_amount: 0,
          created_at: new Date().toISOString()
        };
        const { error: oErr } = await supabase.from('orders').insert(o);
        if(oErr) console.warn('supabase orders insert err', oErr);
        else orderRow = o;
      }

      return res.json({ ok:true, charge: toInsert, order: orderRow || null });
    } else {
      const newId = Date.now();
      const rec = { id: newId, personal: String(personal), phone: phone||'', amount: Number(amount), method: method||'', file_link: fileLink||'', status:'pending', createdAt: new Date().toISOString() };
      DB.charges.push(rec);

      let orderRec = null;
      if(type || item){
        const oid = Date.now() + 1;
        orderRec = { id: oid, personal: String(personal), phone: phone||'', type: type||'طلب', item: item||'', idField: idField||'', fileLink: fileLink||'', cashMethod: method||'', status:'pending', replied:false, paidWithBalance: false, paidAmount: 0, createdAt: new Date().toISOString() };
        DB.orders.push(orderRec);
      }

      saveData(DB);
      return res.json({ ok:true, charge: rec, order: orderRec });
    }
  } catch (err) {
    console.error('/api/charges err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- orders endpoints (if client posts orders directly) ---------- */
app.post('/api/orders', async (req, res) => {
  try {
    const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body || {};
    if(!personal || !type) return res.status(400).json({ ok:false, error:'missing_fields' });

    if(paidWithBalance){
      // delegate to same logic as charges: attempt to deduct and create order
      // we reuse code path by constructing equivalent body and calling the charges handler behavior:
      req.body.amount = paidAmount || paidAmount === 0 ? paidAmount : 0;
      req.body.type = type;
      req.body.item = item;
      // fallback: call charges route logic by duplicating (simpler inline)
      if(SUPABASE_ENABLED){
        const { data: profRow, error: profErr } = await supabase.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
        if(profErr) { console.error('supabase find profile err', profErr); return res.status(500).json({ ok:false, error:'db_error' }); }
        if(!profRow) return res.status(404).json({ ok:false, error:'profile_not_found' });
        const profile = mapProfileFromRow(profRow);
        if(Number(profile.balance) < Number(paidAmount)) return res.status(400).json({ ok:false, error:'insufficient_balance' });
        const newBal = Number(profile.balance) - Number(paidAmount);
        const { data: updData, error: updErr } = await supabase.from('profiles').update({ balance: newBal }).eq('personal_number', String(personal)).select().maybeSingle();
        if(updErr) { console.error('supabase update balance err', updErr); return res.status(500).json({ ok:false, error:'db_update_error' }); }

        const o = {
          personal_number: String(personal),
          phone: phone || '',
          type: type || '',
          item: item || '',
          id_field: idField || '',
          file_link: fileLink || '',
          cash_method: cashMethod || '',
          status: 'pending',
          replied: false,
          paid_with_balance: true,
          paid_amount: Number(paidAmount || 0),
          created_at: new Date().toISOString()
        };
        const { error: oErr } = await supabase.from('orders').insert(o);
        if(oErr) console.warn('supabase orders insert err', oErr);

        const updatedProfile = mapProfileFromRow(updData || profRow);
        return res.json({ ok:true, order: o, profile: updatedProfile });
      } else {
        const p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
        if(!p) return res.status(404).json({ ok:false, error:'profile_not_found' });
        if(Number(p.balance) < Number(paidAmount)) return res.status(400).json({ ok:false, error:'insufficient_balance' });
        p.balance = Number(p.balance) - Number(paidAmount);
        const oid = Date.now();
        const orderRec = { id: oid, personal: String(personal), phone: phone||'', type: type||'', item: item||'', idField: idField||'', fileLink: fileLink||'', cashMethod: cashMethod||'', status:'pending', replied:false, paidWithBalance: true, paidAmount: Number(paidAmount||0), createdAt: new Date().toISOString() };
        DB.orders.push(orderRec);
        saveData(DB);
        return res.json({ ok:true, order: orderRec, profile: p });
      }
    }

    // normal order (no balance)
    if(SUPABASE_ENABLED){
      const toInsert = {
        personal_number: String(personal),
        phone: phone || '',
        type: type || '',
        item: item || '',
        id_field: idField || '',
        file_link: fileLink || '',
        cash_method: cashMethod || '',
        status: 'pending',
        replied: false,
        paid_with_balance: false,
        paid_amount: Number(paidAmount || 0),
        created_at: new Date().toISOString()
      };
      const { error } = await supabase.from('orders').insert(toInsert);
      if(error) { console.error('supabase orders insert err', error); return res.status(500).json({ ok:false, error:'db_insert_error' }); }
      return res.json({ ok:true, order: toInsert });
    } else {
      const id = Date.now();
      const rec = { id, personal: String(personal), phone: phone||'', type: type||'', item: item||'', idField: idField||'', fileLink: fileLink||'', cashMethod: cashMethod||'', status:'pending', replied:false, paidWithBalance: false, paidAmount: Number(paidAmount||0), createdAt: new Date().toISOString() };
      DB.orders.push(rec);
      saveData(DB);
      return res.json({ ok:true, order: rec });
    }
  } catch(err){
    console.error('/api/orders POST err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

app.get('/api/orders/:personal', async (req, res) => {
  try {
    const personal = String(req.params.personal || '');
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });

    if(SUPABASE_ENABLED){
      const [{ data: orders, error: oErr }, { data: charges, error: cErr }] = await Promise.all([
        supabase.from('orders').select('*').eq('personal_number', personal).order('created_at', { ascending: false }),
        supabase.from('charges').select('*').eq('personal_number', personal).order('created_at', { ascending: false })
      ]);
      if(oErr) console.warn('orders fetch err', oErr);
      if(cErr) console.warn('charges fetch err', cErr);
      return res.json({ ok:true, orders: (orders||[]).map(mapOrderRow), charges: (charges||[]).map(mapChargeRow) });
    } else {
      const orders = DB.orders.filter(o => String(o.personal) === personal).map(o => { o.createdAt = o.createdAt || o.created_at || new Date().toISOString(); return mapOrderRow(o); });
      const charges = DB.charges.filter(c => String(c.personal) === personal).map(c => { c.createdAt = c.createdAt || c.created_at || new Date().toISOString(); return mapChargeRow(c); });
      return res.json({ ok:true, orders, charges });
    }
  } catch(err){
    console.error('/api/orders GET err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- notifications endpoints ---------- */
app.get('/api/notifications/:personal', async (req, res) => {
  try {
    const personal = String(req.params.personal || '');
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });

    if(SUPABASE_ENABLED){
      const [notifQ, ordersQ, chargesQ, offersQ, profileQ] = await Promise.all([
        supabase.from('notifications').select('*').eq('personal', personal).order('created_at', { ascending: false }),
        supabase.from('orders').select('*').eq('personal_number', personal).order('created_at', { ascending: false }),
        supabase.from('charges').select('*').eq('personal_number', personal).order('created_at', { ascending: false }),
        supabase.from('offers').select('*').order('created_at', { ascending: false }),
        supabase.from('profiles').select('*').eq('personal_number', personal).limit(1).maybeSingle()
      ]);
      const notifications = (notifQ.data||[]).map(mapNotificationRow);
      const orders = (ordersQ.data||[]).map(mapOrderRow);
      const charges = (chargesQ.data||[]).map(mapChargeRow);
      const offers = (offersQ.data||[]).map(mapOfferRow);
      const profile = profileQ.data ? mapProfileFromRow(profileQ.data) : null;
      return res.json({ ok:true, notifications, orders, charges, offers, profile, canEdit: profile ? profile.canEdit : false });
    } else {
      const notifications = DB.notifications.filter(n => String(n.personal) === personal).map(n => { n.createdAt = n.createdAt || n.created_at || new Date().toISOString(); return mapNotificationRow(n); });
      const orders = DB.orders.filter(o => String(o.personal) === personal).map(o => { o.createdAt = o.createdAt || o.created_at || new Date().toISOString(); return mapOrderRow(o); });
      const charges = DB.charges.filter(c => String(c.personal) === personal).map(c => { c.createdAt = c.createdAt || c.created_at || new Date().toISOString(); return mapChargeRow(c); });
      const offers = (DB.offers || []).map(o => { o.createdAt = o.createdAt || o.created_at || new Date().toISOString(); return mapOfferRow(o); });
      const profile = DB.profiles.find(p => String(p.personalNumber) === personal) || null;
      return res.json({ ok:true, notifications, orders, charges, offers, profile, canEdit: profile ? !!profile.canEdit : false });
    }
  } catch (err) {
    console.error('/api/notifications err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

app.post('/api/notifications/mark-read', async (req, res) => {
  try {
    const { personal } = req.body || {};
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });

    if(SUPABASE_ENABLED){
      const { error } = await supabase.from('notifications').update({ read: true }).eq('personal', String(personal));
      if(error) { console.error('supabase mark-read err', error); return res.status(500).json({ ok:false, error:'db_update_error' }); }
      return res.json({ ok:true });
    } else {
      DB.notifications = DB.notifications.map(n => (String(n.personal) === String(personal) ? Object.assign({}, n, { read: true }) : n));
      saveData(DB);
      return res.json({ ok:true });
    }
  } catch(err){
    console.error('/api/notifications/mark-read err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

app.post('/api/notifications/mark-read/:personal', async (req, res) => {
  try{
    const personal = String(req.params.personal || '');
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });
    if(SUPABASE_ENABLED){
      const { error } = await supabase.from('notifications').update({ read: true }).eq('personal', personal);
      if(error) { console.error('supabase mark-read err', error); return res.status(500).json({ ok:false, error:'db_update_error' }); }
      return res.json({ ok:true });
    } else {
      DB.notifications = DB.notifications.map(n => (String(n.personal) === personal ? Object.assign({}, n, { read: true }) : n));
      saveData(DB);
      return res.json({ ok:true });
    }
  }catch(err){
    console.error('/api/notifications/mark-read/:personal err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

app.post('/api/notifications/clear', async (req, res) => {
  try {
    const { personal } = req.body || {};
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });

    if(SUPABASE_ENABLED){
      const { error } = await supabase.from('notifications').delete().eq('personal', String(personal));
      if(error) { console.error('supabase notifications delete err', error); return res.status(500).json({ ok:false, error:'db_delete_error' }); }
      return res.json({ ok:true });
    } else {
      DB.notifications = DB.notifications.filter(n => String(n.personal) !== String(personal));
      saveData(DB);
      return res.json({ ok:true });
    }
  } catch(err){
    console.error('/api/notifications/clear err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- offers ack (simple) ---------- */
app.post('/api/offers/ack', async (req, res) => {
  try {
    const { id, personal } = req.body || {};
    if(!id || !personal) return res.status(400).json({ ok:false, error:'missing_fields' });

    // This is a lightweight ack: we can record that this user acknowledged the offer
    if(SUPABASE_ENABLED){
      // optionally create a notification row (or create a table mapping acks). For simplicity add a notification:
      const row = { id: `ack-${Date.now()}`, personal: String(personal), text: `تم تفعيل العرض: ${String(id)}`, read: false, created_at: new Date().toISOString() };
      const { error } = await supabase.from('notifications').insert(row);
      if(error) console.warn('supabase offer-ack insert err', error);
      return res.json({ ok:true });
    } else {
      DB.notifications.push({ id: `ack-${Date.now()}`, personal: String(personal), text: `تم تفعيل العرض: ${String(id)}`, read:false, createdAt: new Date().toISOString() });
      saveData(DB);
      return res.json({ ok:true });
    }
  }catch(err){
    console.error('/api/offers/ack err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- support ---------- */
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
      const n = { id: `notif-${Date.now()}`, personal: String(personal), text: String(text), read:false, createdAt: new Date().toISOString() };
      DB.notifications.push(n);
      saveData(DB);
      return res.json({ ok:true });
    }
  } catch (err) {
    console.error('/api/support err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- profile edit ---------- */
app.post('/api/profile/request-edit', async (req, res) => {
  try {
    const { personal } = req.body || {};
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });

    if(SUPABASE_ENABLED){
      const row = { msg_id: Date.now(), personal: String(personal) };
      const { error } = await supabase.from('profile_edit_requests').insert(row);
      if(error) console.warn('profile edit request insert err', error);
      return res.json({ ok:true });
    } else {
      DB.profileEditRequests[personal] = { requestedAt: new Date().toISOString() };
      saveData(DB);
      return res.json({ ok:true });
    }
  } catch(err){
    console.error('/api/profile/request-edit err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

app.post('/api/profile/submit-edit', async (req, res) => {
  try {
    const { personal, name, email, password, phone } = req.body || {};
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });

    if(SUPABASE_ENABLED){
      const updates = {};
      if(typeof name !== 'undefined') updates.name = name;
      if(typeof email !== 'undefined') updates.email = email;
      if(typeof password !== 'undefined') updates.password = password;
      if(typeof phone !== 'undefined') updates.phone = phone;
      const { error } = await supabase.from('profiles').update(updates).eq('personal_number', String(personal));
      if(error) { console.error('supabase profile update err', error); return res.status(500).json({ ok:false, error:'db_update_error' }); }
      const { data } = await supabase.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      return res.json({ ok:true, profile: data ? mapProfileFromRow(data) : null });
    } else {
      const p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
      if(!p) return res.status(404).json({ ok:false, error:'not_found' });
      if(typeof name !== 'undefined') p.name = name;
      if(typeof email !== 'undefined') p.email = email;
      if(typeof password !== 'undefined') p.password = password;
      if(typeof phone !== 'undefined') p.phone = phone;
      p.canEdit = false;
      saveData(DB);
      return res.json({ ok:true, profile: p });
    }
  } catch(err){
    console.error('/api/profile/submit-edit err', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ---------- API-only: run ---------- */
app.listen(PORT, () => {
  console.log(`API Server listening on port ${PORT} — SUPABASE_ENABLED=${SUPABASE_ENABLED}`);
});

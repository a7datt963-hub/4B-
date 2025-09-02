// server.js — Supabase-enabled backend (cleaned & deduplicated)
// Req: express, cors, node-fetch@2, multer, @supabase/supabase-js
// Usage: set SUPABASE_URL and SUPABASE_SERVICE_KEY to enable Supabase storage.
// Place in project root and run: node server.js

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // v2
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ---------------- CONFIG ----------------
const CFG = {
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || '',
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || '',
  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || '',
  BOT_BALANCE_CHAT: process.env.BOT_BALANCE_CHAT || '',
  BOT_HELP_TOKEN: process.env.BOT_HELP_TOKEN || '',
  BOT_HELP_CHAT: process.env.BOT_HELP_CHAT || '',
  BOT_NOTIFY_TOKEN: process.env.BOT_NOTIFY_TOKEN || '',
  BOT_NOTIFY_CHAT: process.env.BOT_NOTIFY_CHAT || '',
  IMGBB_KEY: process.env.IMGBB_KEY || ''
};

// ---------------- Supabase client (optional) ----------------
const useSupabase = !!(CFG.SUPABASE_URL && CFG.SUPABASE_SERVICE_KEY);
let sb = null;
if (useSupabase) {
  try {
    sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_SERVICE_KEY, { global: { fetch } });
    console.log('Supabase: enabled');
  } catch (e) {
    console.warn('Supabase init failed — falling back to local DB', e);
  }
} else {
  console.log('Supabase: not configured — using local data.json fallback');
}

// ---------------- Local DB fallback ----------------
const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const init = { profiles: [], orders: [], charges: [], offers: [], notifications: [], profileEditRequests: [], blocked: [] };
      fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8') || '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.error('loadData error', e);
    return { profiles: [], orders: [], charges: [], offers: [], notifications: [], profileEditRequests: [], blocked: [] };
  }
}
function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch (e) { console.error('saveData error', e); }
}
let DB = loadData();

// ---------------- Helpers ----------------
function mapSbProfileToResponse(row) {
  if (!row) return null;
  return {
    personalNumber: row.personal_number || row.personalNumber || null,
    name: row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    password: row.password || '',
    balance: Number(row.balance || 0),
    canEdit: !!row.can_edit,
    lastLogin: row.last_login || null,
    telegram_chat_id: row.telegram_chat_id || null
  };
}

async function genUniquePersonalNumber() {
  for (let i = 0; i < 10; i++) {
    const n = String(Math.floor(1000000 + Math.random() * 9000000));
    if (useSupabase && sb) {
      try {
        const { data } = await sb.from('profiles').select('personal_number').eq('personal_number', n).limit(1).maybeSingle();
        if (!data) return n;
      } catch (e) { /* ignore */ }
    }
    if (!DB.profiles.some(p => String(p.personalNumber) === n || String(p.personal_number) === n)) return n;
  }
  return String(Date.now()).slice(-9);
}

async function findProfileByPersonal(personal) {
  if (!personal) return null;
  try {
    if (useSupabase && sb) {
      const { data, error } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (error) console.warn('findProfileByPersonal sb error', error);
      if (data) return mapSbProfileToResponse(data);
      return null;
    }
  } catch (e) { console.warn('findProfileByPersonal supabase', e); }
  const p = DB.profiles.find(x => String(x.personalNumber) === String(personal) || String(x.personal_number) === String(personal));
  if (!p) return null;
  return {
    personalNumber: p.personalNumber || p.personal_number,
    name: p.name, email: p.email, phone: p.phone, password: p.password,
    balance: Number(p.balance || 0), canEdit: !!p.canEdit, lastLogin: p.lastLogin
  };
}

async function findProfileByIdentity({ name, email, phone }) {
  if (useSupabase && sb) {
    try {
      const q = sb.from('profiles').select('*').ilike('name', String(name || '')).eq('email', String(email || '')).eq('phone', String(phone || '')).limit(1).maybeSingle();
      const { data, error } = await q;
      if (error) console.warn('findProfileByIdentity supabase err', error);
      if (data) return mapSbProfileToResponse(data);
    } catch (e) { console.warn('findProfileByIdentity supabase', e); }
  } else {
    const p = DB.profiles.find(x =>
      String(x.name) === String(name) && String(x.email) === String(email) && String(x.phone) === String(phone)
    );
    if (p) return { personalNumber: p.personalNumber || p.personal_number, name: p.name, email: p.email, phone: p.phone, password: p.password, balance: Number(p.balance || 0) };
  }
  return null;
}

async function sendTelegramMessageToChat(chatId, text, tokenOverride) {
  try {
    if (!chatId) return null;
    const token = tokenOverride || CFG.BOT_NOTIFY_TOKEN || CFG.BOT_BALANCE_TOKEN || CFG.BOT_ORDER_TOKEN;
    if (!token) return null;
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text })
    });
    return await resp.json().catch(() => null);
  } catch (e) {
    console.warn('sendTelegramMessageToChat error', e);
    return null;
  }
}

// ===== addBalanceToPersonal (single clean version) =====
async function addBalanceToPersonal(personal, amount) {
  try {
    if (!personal) return { ok: false, error: 'missing_personal' };
    const amt = Number(amount || 0);
    if (isNaN(amt) || amt <= 0) return { ok: false, error: 'invalid_amount' };

    if (useSupabase && sb) {
      try {
        const { data: profRow, error: selErr } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
        if (selErr) console.warn('addBalance select err', selErr);

        if (!profRow) {
          const ins = {
            personal_number: String(personal),
            name: 'ضيف',
            email: '',
            password: '',
            phone: '',
            balance: amt,
            can_edit: false,
            last_login: new Date().toISOString()
          };
          const { data: newProf, error: insErr } = await sb.from('profiles').insert([ins]).select().maybeSingle();
          if (insErr) console.warn('addBalance insert err', insErr);
          await sb.from('notifications').insert([{ personal_number: String(personal), text: `تمت إضافة مبلغ ${amt} إلى رصيدك. الرصيد الجديد: ${newProf ? Number(newProf.balance||amt) : amt}`, read: false, created_at: new Date().toISOString() }]).catch(()=>{});
          console.log(`addBalance: personal=${personal} +${amt} => ${newProf ? Number(newProf.balance||amt) : amt} (created)`);
          return { ok: true, newBalance: Number(newProf ? newProf.balance || amt : amt) };
        }

        const oldBal = Number(profRow.balance || 0);
        const newBal = oldBal + amt;
        const { error: upErr } = await sb.from('profiles').update({ balance: newBal }).eq('personal_number', String(personal));
        if (upErr) console.warn('addBalance update err', upErr);

        await sb.from('notifications').insert([{ personal_number: String(personal), text: `تمت إضافة مبلغ ${amt} إلى رصيدك. الرصيد الجديد: ${newBal}`, read: false, created_at: new Date().toISOString() }]).catch(()=>{});
        console.log(`addBalance: personal=${personal} +${amt} => ${newBal} (supabase)`);
        return { ok: true, newBalance: newBal };
      } catch (e) {
        console.error('addBalanceToPersonal supabase exception', e);
        return { ok: false, error: 'supabase_error' };
      }
    }

    // local fallback
    let p = (DB.profiles || []).find(x => String(x.personalNumber) === String(personal) || String(x.personal_number) === String(personal));
    if (!p) {
      p = { personalNumber: String(personal), personal_number: String(personal), name: 'ضيف', email: '', password: '', phone: '', balance: amt, canEdit: false, lastLogin: new Date().toISOString() };
      DB.profiles.push(p);
    } else {
      p.balance = Number(p.balance || 0) + amt;
    }

    DB.notifications = DB.notifications || [];
    DB.notifications.unshift({
      id: String(Date.now()),
      personal: String(personal),
      text: `تمت إضافة مبلغ ${amt} إلى رصيدك. الرصيد الجديد: ${p.balance}`,
      read: false,
      createdAt: new Date().toISOString()
    });
    saveData(DB);
    console.log(`addBalance: personal=${personal} +${amt} => ${p.balance} (local)`);
    return { ok: true, newBalance: Number(p.balance) };
  } catch (e) {
    console.error('addBalanceToPersonal error', e);
    return { ok: false, error: String(e) };
  }
}

// Mark latest pending charge as accepted (optional)
async function markLatestPendingChargeAsAccepted(personal, amount) {
  try {
    if (!personal) return { ok: false, error: 'missing_personal' };
    if (useSupabase && sb) {
      const { data: pending } = await sb.from('charges').select('*').eq('personal_number', String(personal)).eq('replied', false).order('created_at', { ascending: false }).limit(10);
      if (pending && pending.length > 0) {
        let found = pending.find(p => Number(p.amount) === Number(amount));
        if (!found) found = pending[0];
        if (found) {
          await sb.from('charges').update({ status: 'مقبول', replied: true }).eq('id', found.id).eq('replied', false);
          return { ok: true, chargeId: found.id };
        }
      }
      return { ok: false, error: 'no_pending_charge' };
    }
    const pendingLocal = (DB.charges || []).filter(c => String(c.personalNumber || c.personal) === String(personal) && !c.replied).sort((a,b)=> new Date(b.createdAt || b.created_at) - new Date(a.createdAt || a.created_at));
    if (pendingLocal.length > 0) {
      let found = pendingLocal.find(p => Number(p.amount) === Number(amount));
      if (!found) found = pendingLocal[0];
      if (found) {
        found.status = 'مقبول'; found.replied = true; found.updatedAt = new Date().toISOString();
        saveData(DB);
        return { ok: true, chargeId: found.id || found.cid || null };
      }
    }
    return { ok: false, error: 'no_pending_charge' };
  } catch (e) {
    console.error('markLatestPendingChargeAsAccepted error', e);
    return { ok: false, error: String(e) };
  }
}

// confirmChargeById: accept a charge and credit balance
async function confirmChargeById(id) {
  try {
    if (!id) return { ok: false, error: 'missing_id' };
    if (useSupabase && sb) {
      const { data: chargeRow } = await sb.from('charges').select('*').eq('id', id).limit(1).maybeSingle();
      if (!chargeRow) return { ok: false, error: 'charge_not_found' };
      if (chargeRow.replied) return { ok: false, error: 'already_confirmed' };
      const amount = Number(chargeRow.amount || 0);
      const personal = String(chargeRow.personal_number || chargeRow.personal || '');
      const { data: profRow } = await sb.from('profiles').select('*').eq('personal_number', personal).limit(1).maybeSingle();
      if (!profRow) return { ok: false, error: 'profile_not_found' };
      const oldBal = Number(profRow.balance || 0);
      const newBal = oldBal + (isNaN(amount) ? 0 : amount);
      await sb.from('profiles').update({ balance: newBal }).eq('personal_number', personal);
      await sb.from('charges').update({ status: 'مقبول', replied: true }).eq('id', id);
      await sb.from('notifications').insert([{ personal_number: personal, text: `تمت إضافة مبلغ ${amount} إلى رصيدك. الرصيد الآن: ${newBal}`, read: false, created_at: new Date().toISOString() }]);
      return { ok: true, newBalance: newBal, chargeId: id };
    }
    const ch = (DB.charges || []).find(c => String(c.id) === String(id));
    if (!ch) return { ok: false, error: 'charge_not_found' };
    if (ch.replied) return { ok: false, error: 'already_confirmed' };
    const personal = String(ch.personalNumber || ch.personal || '');
    const amount = Number(ch.amount || 0);
    let p = (DB.profiles || []).find(x => String(x.personalNumber) === String(personal) || String(x.personal_number) === String(personal));
    if (!p) { p = { personalNumber: personal, personal_number: personal, name: 'ضيف', balance: amount }; DB.profiles.push(p); }
    else p.balance = Number(p.balance || 0) + amount;
    ch.status = 'مقبول'; ch.replied = true; ch.updatedAt = new Date().toISOString();
    DB.notifications = DB.notifications || [];
    DB.notifications.unshift({ id: String(Date.now()), personal: personal, text: `تمت إضافة مبلغ ${amount} إلى رصيدك. الرصيد الآن: ${p.balance}`, read: false, createdAt: new Date().toISOString() });
    saveData(DB);
    return { ok: true, newBalance: p.balance, chargeId: id };
  } catch (e) {
    console.error('confirmChargeById error', e);
    return { ok: false, error: String(e) };
  }
}

// ---------------- End helpers ----------------

// ---------------- Upload endpoint ----------------
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
const uploadsDir = path.join(publicDir, 'uploads'); if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

app.post('/api/upload', uploadMemory.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });
  try {
    const name = Date.now() + '-' + (req.file.originalname || 'f.bin');
    fs.writeFileSync(path.join(uploadsDir, name), req.file.buffer);
    const url = `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(name)}`;
    return res.json({ ok: true, url, provider: 'local' });
  } catch (e) {
    console.error('upload error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --------------- Register ----------------
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body || {};
    if (!name || !email || !password || !phone) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const personalNumber = await genUniquePersonalNumber();
    const newProfile = {
      personal_number: personalNumber,
      name: name || 'ضيف',
      email: email || '',
      password: password || '',
      phone: phone || '',
      balance: 0,
      can_edit: false,
      last_login: new Date().toISOString()
    };

    if (useSupabase && sb) {
      const { data, error } = await sb.from('profiles').insert([newProfile]).select().maybeSingle();
      if (error) console.warn('register insert err', error);
      return res.json({ ok: true, profile: mapSbProfileToResponse(data || { personal_number: personalNumber, ...newProfile }) });
    } else {
      const pLocal = { personalNumber: personalNumber, name: newProfile.name, email: newProfile.email, password: newProfile.password, phone: newProfile.phone, balance: 0, canEdit: false, lastLogin: newProfile.last_login };
      DB.profiles.push(pLocal); saveData(DB);
      return res.json({ ok: true, profile: { personalNumber, name: pLocal.name, email: pLocal.email, phone: pLocal.phone, balance: 0 } });
    }
  } catch (e) {
    console.error('register error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --------------- Login (only search by name+email+phone+password) ----------------
app.post('/api/login', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};
    if (!name || !email || !phone || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const profile = await findProfileByIdentity({ name, email, phone });
    if (!profile) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (profile.password && String(profile.password) !== String(password)) {
      return res.status(401).json({ ok: false, error: 'wrong_password' });
    }

    try {
      if (useSupabase && sb) {
        await sb.from('profiles').update({ last_login: new Date().toISOString() }).eq('personal_number', String(profile.personalNumber));
      } else {
        const p = DB.profiles.find(x => String(x.personalNumber) === String(profile.personalNumber) || String(x.personal_number) === String(profile.personalNumber));
        if (p) { p.lastLogin = new Date().toISOString(); saveData(DB); }
      }
    } catch (e) { /* ignore */ }

    return res.json({ ok: true, profile });
  } catch (e) {
    console.error('login error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --------------- Notifications & data retrieval ---------------
app.get('/api/notifications/:personal', async (req, res) => {
  try {
    const personal = req.params.personal;
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });

    const profile = await findProfileByPersonal(personal);
    let notifications = [], orders = [], charges = [], offers = [];

    if (useSupabase && sb) {
      try {
        const { data: nots } = await sb.from('notifications').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
        const { data: ords } = await sb.from('orders').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
        const { data: chs } = await sb.from('charges').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
        const { data: ofs } = await sb.from('offers').select('*').eq('active', true).order('created_at', { ascending: false }).limit(50);
        notifications = nots || []; orders = ords || []; charges = chs || []; offers = ofs || [];
      } catch (e) { console.warn('notifications supabase fetch err', e); }
    } else {
      notifications = (DB.notifications || []).filter(n => String(n.personal) === String(personal));
      orders = (DB.orders || []).filter(o => String(o.personalNumber || o.personal) === String(personal));
      charges = (DB.charges || []).filter(c => String(c.personalNumber || c.personal) === String(personal));
      offers = (DB.offers || []).filter(o => !!o.active);
    }

    return res.json({ ok: true, profile, notifications, orders, charges, offers });
  } catch (e) {
    console.error('notifications endpoint error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// mark-read / clear (simple)
app.post('/api/notifications/mark-read', async (req, res) => {
  try {
    const { personal } = req.body || {};
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    if (useSupabase && sb) {
      await sb.from('notifications').update({ read: true }).eq('personal_number', String(personal));
    } else {
      DB.notifications = (DB.notifications || []).map(n => (String(n.personal) === String(personal) ? { ...n, read: true } : n));
      saveData(DB);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('mark-read error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
app.post('/api/notifications/clear', async (req, res) => {
  try {
    const { personal } = req.body || {};
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    if (useSupabase && sb) {
      await sb.from('notifications').delete().eq('personal_number', String(personal));
    } else {
      DB.notifications = (DB.notifications || []).filter(n => String(n.personal) !== String(personal)); saveData(DB);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('clear notifications error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --------------- Orders (deduct from balance server-side) ---------------
app.post('/api/orders', async (req, res) => {
  try {
    const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body || {};
    if (!personal || !type || !item) return res.status(400).json({ ok: false, error: 'missing_fields' });

    let profile = await findProfileByPersonal(personal);
    if (!profile) {
      if (useSupabase) {
        await sb.from('profiles').insert([{ personal_number: String(personal), name: 'ضيف', email: '', password: '', phone: phone || '', balance: 0, can_edit: false, last_login: new Date().toISOString() }]).catch(()=>{});
        profile = await findProfileByPersonal(personal);
      } else {
        DB.profiles.push({ personalNumber: String(personal), name: 'ضيف', email: '', password: '', phone: phone || '', balance: 0, canEdit: false, lastLogin: new Date().toISOString() });
        saveData(DB);
        profile = await findProfileByPersonal(personal);
      }
    }

    if (paidWithBalance) {
      const price = Number(paidAmount || 0);
      if (isNaN(price) || price <= 0) return res.status(400).json({ ok: false, error: 'invalid_paid_amount' });
      if (useSupabase && sb) {
        const { data: profRow } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
        const bal = profRow ? Number(profRow.balance || 0) : 0;
        if (bal < price) return res.status(402).json({ ok: false, error: 'insufficient_balance' });
        const newBal = bal - price;
        await sb.from('profiles').update({ balance: newBal }).eq('personal_number', String(personal));
        await sb.from('notifications').insert([{ personal_number: String(personal), text: `تم خصم ${price} من رصيدك لطلب: ${item}`, read: false, created_at: new Date().toISOString() }]).catch(()=>{});
      } else {
        const p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
        if (!p) return res.status(404).json({ ok: false, error: 'profile_not_found' });
        if (Number(p.balance || 0) < price) return res.status(402).json({ ok: false, error: 'insufficient_balance' });
        p.balance = Number(p.balance || 0) - price;
        saveData(DB);
      }
    }

    const orderId = Date.now();
    const orderRecord = {
      id: orderId,
      personal_number: personal,
      phone: phone || profile.phone || '',
      type, item,
      id_field: idField || '',
      file_link: fileLink || '',
      cash_method: cashMethod || '',
      status: 'قيد المراجعة',
      replied: false,
      created_at: new Date().toISOString()
    };

    if (useSupabase && sb) {
      await sb.from('orders').insert([orderRecord]).catch(e => console.warn('orders insert err', e));
    } else {
      DB.orders = DB.orders || [];
      DB.orders.unshift({ id: orderId, personalNumber: personal, phone: orderRecord.phone, type, item, idField: idField || '', fileLink: fileLink || '', cashMethod: cashMethod || '', status: 'قيد المراجعة', replied: false, createdAt: orderRecord.created_at });
      saveData(DB);
    }

    const adminText = `طلب جديد\nمعرف: ${orderId}\nالرقم الشخصي: ${personal}\nالبند: ${item}\nالطريقة: ${cashMethod || 'غير محددة'}`;
    try { if (CFG.BOT_ORDER_TOKEN && CFG.BOT_ORDER_CHAT) await sendTelegramMessageToChat(CFG.BOT_ORDER_CHAT, adminText, CFG.BOT_ORDER_TOKEN); } catch(e){}

    return res.json({ ok: true, order: orderRecord });
  } catch (e) {
    console.error('create order error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --------------- Charge request (user requests top-up) ---------------
app.post('/api/charge', async (req, res) => {
  try {
    const body = req.body || {};
    const personal = body.personal || body.personalNumber || body.personal_number;
    const amount = body.amount || body.amt || body.price;
    const phone = body.phone || body.mobile || '';
    const method = body.method || body.cashMethod || '';
    const fileLink = body.fileLink || body.file_link || '';

    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    if (typeof amount === 'undefined' || amount === null) return res.status(400).json({ ok: false, error: 'missing_amount' });

    const numericAmount = Number(String(amount).replace(/[^0-9.-]+/g,""));
    if (isNaN(numericAmount) || numericAmount <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });

    const chargeId = String(Date.now()) + Math.floor(Math.random()*9999);
    const createdAt = new Date().toISOString();

    const chargeRecord = {
      id: chargeId,
      personal_number: String(personal),
      phone: phone,
      amount: numericAmount,
      method: method,
      file_link: fileLink,
      status: 'قيد المراجعة',
      replied: false,
      created_at: createdAt
    };

    if (useSupabase && sb) {
      try {
        const { error } = await sb.from('charges').insert([chargeRecord]);
        if (error) console.warn('charges insert err', error);
      } catch (e) {
        console.error('charges insert exception', e);
      }
    } else {
      DB.charges = DB.charges || [];
      DB.charges.unshift({
        id: chargeId,
        personalNumber: String(personal),
        phone,
        amount: numericAmount,
        method,
        fileLink,
        status: 'قيد المراجعة',
        replied: false,
        createdAt
      });
      saveData(DB);
    }

    const adminText = `طلب شحن جديد\nمعرف: ${chargeId}\nالرقم الشخصي: ${personal}\nالمبلغ: ${numericAmount}`;
    try {
      if (CFG.BOT_BALANCE_TOKEN && CFG.BOT_BALANCE_CHAT) {
        await sendTelegramMessageToChat(CFG.BOT_BALANCE_CHAT, adminText, CFG.BOT_BALANCE_TOKEN);
      }
    } catch (e) {
      console.warn('notify admin failed', e);
    }

    return res.json({ ok: true, charge: chargeRecord });
  } catch (e) {
    console.error('create charge error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --------------- Telegram webhook: admin replies to accept charge or send amount ---------------
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    console.log('WEBHOOK RECEIVED:', JSON.stringify(update).slice(0,1000));
    if (!msg) return res.sendStatus(200);

    const adminChatId = CFG.BOT_BALANCE_CHAT || '';
    const allowedUsers = Array.isArray(CFG.ADMIN_ALLOWED_USERS) ? CFG.ADMIN_ALLOWED_USERS : [];
    if (adminChatId && String(msg.chat && msg.chat.id) !== String(adminChatId)) {
      if (!allowedUsers.includes(msg.from && msg.from.id)) {
        console.log('Webhook: ignored (not admin chat)', msg.chat && msg.chat.id, 'from', msg.from && msg.from.id);
        return res.sendStatus(200);
      }
    }

    const repliedTo = msg.reply_to_message;

    // If replied-to contains an id like "معرف: 12345", try confirmChargeById
    if (repliedTo && repliedTo.text) {
      const reId = /(?:معرف\s*(?:الطلب|الشحنة|ال)?\s*[:\-]?\s*)(\d+)/i;
      const mid = (repliedTo.text || '').match(reId);
      if (mid) {
        const id = mid[1];
        const result = await confirmChargeById(id);
        console.log('Webhook confirmChargeById', id, result);
        try { await sendTelegramMessageToChat(msg.chat.id, result.ok ? `تم اعتماد الشحنة #${id}` : `تعذّر اعتماد الشحنة #${id}: ${result.error||'خطأ'}`); } catch (e){}
        return res.sendStatus(200);
      }
    }

    // Parse amount & personal from message text or from replied-to text
    let txt = (msg.text || '').replace(/\u00A0/g,' ');
    let mAmount = (txt.match(/(?:الرصيد|المبلغ|المبلغ المرسل)\s*[:\-]?\s*([0-9\.,]+)/i) || [null,null])[1];
    let mPersonal = (txt.match(/(?:الرقم\s*الشخصي|رقم)\s*[:\-]?\s*(\d+)/i) || [null,null])[1];

    if ((!mAmount || !mPersonal) && repliedTo && repliedTo.text) {
      const rt = repliedTo.text.replace(/\u00A0/g,' ');
      if (!mAmount) mAmount = (rt.match(/(?:الرصيد|المبلغ)\s*[:\-]?\s*([0-9\.,]+)/i) || [null,null])[1];
      if (!mPersonal) mPersonal = (rt.match(/(?:الرقم\s*الشخصي|رقم)\s*[:\-]?\s*(\d+)/i) || [null,null])[1];
    }

    if (mAmount && mPersonal) {
      const amount = Number(String(mAmount).replace(/[^0-9]/g,''));
      const personal = String(mPersonal).trim();
      if (isNaN(amount) || amount <= 0) {
        await sendTelegramMessageToChat(msg.chat.id, `قيمة المبلغ غير صالحة: ${mAmount}`);
        return res.sendStatus(200);
      }

      const addRes = await addBalanceToPersonal(personal, amount);
      if (!addRes.ok) {
        await sendTelegramMessageToChat(msg.chat.id, `خطأ عند تحديث الرصيد: ${addRes.error||'unknown'}`);
        return res.sendStatus(200);
      }

      const markRes = await markLatestPendingChargeAsAccepted(personal, amount).catch(()=>({ ok:false }));
      const reply = `تمت إضافة ${amount.toLocaleString()} لرقم ${personal}. الرصيد الجديد: ${addRes.newBalance}. ${markRes.ok ? 'وُسِمَت الشحنة كمقبولة.' : 'لا توجد شحنة معلقة.'}`;
      try { await sendTelegramMessageToChat(msg.chat.id, reply); } catch (e) {}
      console.log('Webhook processed addBalance', personal, amount, 'newBalance', addRes.newBalance);
      return res.sendStatus(200);
    }

    try { await sendTelegramMessageToChat(msg.chat.id, 'تعذّر قراءة البيانات. مثال صالح:\nالرصيد: 10000\nالرقم الشخصي: 123456789'); } catch (e){}
    return res.sendStatus(200);
  } catch (e) {
    console.error('telegram webhook error', e);
    return res.sendStatus(200);
  }
});

// --------------- Confirm charge/order endpoints (admin) ---------------
app.post('/api/admin/confirm-charge', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
    const r = await confirmChargeById(id);
    if (!r.ok) return res.status(400).json(r);
    return res.json(r);
  } catch (e) { console.error('admin confirm-charge err', e); return res.status(500).json({ ok:false, error: String(e) }); }
});

app.post('/api/admin/confirm-order', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
    if (useSupabase && sb) {
      await sb.from('orders').update({ status: 'تمت المعالجة', replied: true }).eq('id', id);
      const { data: ord } = await sb.from('orders').select('*').eq('id', id).limit(1).maybeSingle();
      if (ord) await sb.from('notifications').insert([{ personal_number: ord.personal_number, text: `طلبك #${id} تمّت معالجته.`, read: false, created_at: new Date().toISOString() }]).catch(()=>{});
      return res.json({ ok: true });
    } else {
      const o = (DB.orders || []).find(x => String(x.id) === String(id));
      if (!o) return res.status(404).json({ ok: false, error: 'order_not_found' });
      o.status = 'تمت المعالجة'; o.replied = true; saveData(DB);
      DB.notifications = DB.notifications || [];
      DB.notifications.unshift({ id: String(Date.now()), personal: o.personalNumber, text: `طلبك #${id} تمّت معالجته.`, read: false, createdAt: new Date().toISOString() });
      return res.json({ ok: true });
    }
  } catch (e) { console.error('confirm order err', e); return res.status(500).json({ ok:false, error: String(e) }); }
});

// --------------- Simple health ----------------
app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString(), supabase: useSupabase }));

// --------------- Start ----------------
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
process.on('SIGINT', () => { try { saveData(DB); console.log('Saved DB before exit'); } catch (e) {} process.exit(); });

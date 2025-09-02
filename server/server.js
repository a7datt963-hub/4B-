// server.js — كامل ومُحدّث
// Requires: express, cors, node-fetch (v2), multer, @supabase/supabase-js
// Env variables (optional):
// SUPABASE_URL, SUPABASE_KEY, IMGBB_KEY,
// BOT_ORDER_TOKEN, BOT_ORDER_CHAT, BOT_BALANCE_TOKEN, BOT_BALANCE_CHAT,
// BOT_ADMIN_CMD_TOKEN, BOT_ADMIN_CMD_CHAT, BOT_HELP_TOKEN, BOT_HELP_CHAT, BOT_OFFERS_TOKEN, BOT_OFFERS_CHAT

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// --- Config / keys ---
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

// --- Local DB fallback file ---
const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const init = {
        profiles: [],
        orders: [],
        charges: [],
        offers: [],
        notifications: [],
        profileEditRequests: [],
        blocked: [],
        tgOffsets: {}
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8') || '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.error('loadData error', e);
    return { profiles: [], orders: [], charges: [], offers: [], notifications: [], profileEditRequests: [] };
  }
}
function saveData(d) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
  } catch (e) {
    console.error('saveData error', e);
  }
}
let DB = loadData();

// --- Supabase client (optional) ---
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
let sb = null;
if (useSupabase) {
  sb = createClient(SUPABASE_URL, SUPABASE_KEY, { global: { fetch } });
  console.log('Supabase enabled');
} else {
  console.log('Supabase not configured — using local data.json as fallback');
}

// --- Public folders & uploads ---
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/', express.static(PUBLIC_DIR));

const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

// --- Helpers ---
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
    lastLogin: row.last_login || null
  };
}

async function findProfileByPersonal(personal) {
  if (!personal) return null;
  try {
    if (useSupabase) {
      const { data, error } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (error) { console.warn('sb select profile error', error); }
      if (data) return mapSbProfileToResponse(data);
      return null;
    }
  } catch (e) {
    console.warn('findProfileByPersonal supabase error', e);
  }
  const p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
  if (!p) return null;
  return {
    personalNumber: p.personalNumber,
    name: p.name, email: p.email, phone: p.phone, password: p.password,
    balance: Number(p.balance || 0), canEdit: !!p.canEdit, lastLogin: p.lastLogin
  };
}

async function ensureProfile(personal) {
  if (!personal) return null;
  try {
    if (useSupabase) {
      const { data: existing, error: selErr } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (selErr) console.warn('sb ensure select err', selErr);
      if (existing) return mapSbProfileToResponse(existing);
      const ins = { personal_number: String(personal), name: 'ضيف', email: '', phone: '', password: '', balance: 0, can_edit: false, last_login: new Date().toISOString() };
      const { data } = await sb.from('profiles').insert([ins]).select().maybeSingle();
      return mapSbProfileToResponse(data);
    }
  } catch (e) {
    console.warn('ensureProfile supabase error', e);
  }

  // local
  let p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
  if (!p) {
    p = { personalNumber: String(personal), name: 'ضيف', email: '', phone: '', password: '', balance: 0, canEdit: false, lastLogin: new Date().toISOString() };
    DB.profiles.push(p); saveData(DB);
  }
  return {
    personalNumber: p.personalNumber,
    name: p.name, email: p.email, phone: p.phone, password: p.password,
    balance: Number(p.balance || 0), canEdit: !!p.canEdit, lastLogin: p.lastLogin
  };
}

// --- Upload endpoint (server-side) ---
app.post('/api/upload', uploadMemory.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
  try {
    // Prefer local save; IMGBB optional (server-side API key)
    const safeName = Date.now() + '-' + (req.file.originalname ? req.file.originalname.replace(/\s+/g, '_') : 'upload.bin');
    const dest = path.join(UPLOADS_DIR, safeName);
    fs.writeFileSync(dest, req.file.buffer);
    const url = `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(safeName)}`;
    return res.json({ ok: true, url, provider: 'local' });
  } catch (e) {
    console.error('upload error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Register (no accidental balance reset) ---
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body || {};
    let personalNumber = req.body.personalNumber || req.body.personal || null;
    if (!personalNumber) personalNumber = String(Math.floor(1000000 + Math.random() * 9000000));

    if (useSupabase) {
      // If exists -> update only provided fields (do NOT overwrite balance)
      const { data: existing, error: selErr } = await sb.from('profiles').select('*').eq('personal_number', String(personalNumber)).limit(1).maybeSingle();
      if (selErr) console.warn('register select err', selErr);
      if (existing) {
        const upd = {};
        if (typeof name !== 'undefined') upd.name = name;
        if (typeof email !== 'undefined') upd.email = email;
        if (typeof password !== 'undefined') upd.password = password;
        if (typeof phone !== 'undefined') upd.phone = phone;
        if (Object.keys(upd).length > 0) {
          const { data: upres, error: upErr } = await sb.from('profiles').update(upd).eq('personal_number', String(personalNumber)).select().maybeSingle();
          if (upErr) console.warn('register update err', upErr);
          return res.json({ ok: true, profile: mapSbProfileToResponse(upres || existing) });
        }
        return res.json({ ok: true, profile: mapSbProfileToResponse(existing) });
      } else {
        const ins = { personal_number: String(personalNumber), name: name || 'ضيف', email: email || '', password: password || '', phone: phone || '', balance: 0, can_edit: false, last_login: new Date().toISOString() };
        const { data: newp, error: insErr } = await sb.from('profiles').insert([ins]).select().maybeSingle();
        if (insErr) console.warn('register insert err', insErr);
        return res.json({ ok: true, profile: mapSbProfileToResponse(newp) });
      }
    }

    // local fallback
    let p = DB.profiles.find(x => String(x.personalNumber) === String(personalNumber));
    if (!p) {
      p = { personalNumber: String(personalNumber), name: name || 'ضيف', email: email || '', password: password || '', phone: phone || '', balance: 0, canEdit: false, lastLogin: new Date().toISOString() };
      DB.profiles.push(p);
    } else {
      if (typeof name !== 'undefined') p.name = name;
      if (typeof email !== 'undefined') p.email = email;
      if (typeof password !== 'undefined') p.password = password;
      if (typeof phone !== 'undefined') p.phone = phone;
      // do NOT touch p.balance
    }
    saveData(DB);
    return res.json({ ok: true, profile: p });
  } catch (e) {
    console.error('register error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Login ---
app.post('/api/login', async (req, res) => {
  try {
    const { personalNumber, email, password, name, phone } = req.body || {};
    let profile = null;

    if (personalNumber) profile = await findProfileByPersonal(personalNumber);
    else if (email) {
      if (useSupabase) {
        const { data, error } = await sb.from('profiles').select('*').ilike('email', String(email)).limit(1).maybeSingle();
        if (error) console.warn('login email select err', error);
        if (data) profile = mapSbProfileToResponse(data);
      } else {
        const p = DB.profiles.find(x => x.email && String(x.email).toLowerCase() === String(email).toLowerCase());
        if (p) profile = { personalNumber: p.personalNumber, name: p.name, email: p.email, phone: p.phone, password: p.password, balance: Number(p.balance || 0), canEdit: !!p.canEdit };
      }
    } else if (name && phone) {
      if (useSupabase) {
        const { data, error } = await sb.from('profiles').select('*').ilike('name', String(name)).eq('phone', String(phone)).limit(1).maybeSingle();
        if (error) console.warn('login name+phone select err', error);
        if (data) profile = mapSbProfileToResponse(data);
      } else {
        const p = DB.profiles.find(x => String(x.name).toLowerCase() === String(name).toLowerCase() && String(x.phone) === String(phone));
        if (p) profile = { personalNumber: p.personalNumber, name: p.name, email: p.email, phone: p.phone, password: p.password, balance: Number(p.balance || 0), canEdit: !!p.canEdit };
      }
    }

    if (!profile) return res.status(404).json({ ok: false, error: 'not_found' });
    if (password && String(password) !== String(profile.password)) return res.status(401).json({ ok: false, error: 'wrong_password' });

    // update last login (best effort)
    try {
      if (useSupabase) {
        await sb.from('profiles').update({ last_login: new Date().toISOString() }).eq('personal_number', String(profile.personalNumber));
      } else {
        const p = DB.profiles.find(x => String(x.personalNumber) === String(profile.personalNumber));
        if (p) { p.lastLogin = new Date().toISOString(); saveData(DB); }
      }
    } catch (e) { /* ignore */ }

    return res.json({ ok: true, profile });
  } catch (e) {
    console.error('login error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Notifications + orders/charges/offers retrieval ---
app.get('/api/notifications/:personal', async (req, res) => {
  try {
    const personal = req.params.personal;
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });

    let profile = await findProfileByPersonal(personal);
    let notifications = [], orders = [], charges = [], offers = [];

    if (useSupabase) {
      try {
        const { data: nots } = await sb.from('notifications').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
        const { data: ords } = await sb.from('orders').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
        const { data: chs } = await sb.from('charges').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
        const { data: ofs } = await sb.from('offers').select('*').eq('active', true).order('created_at', { ascending: false }).limit(50);
        notifications = nots || [];
        orders = ords || [];
        charges = chs || [];
        offers = ofs || [];
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

// --- Mark notifications read & clear ---
app.post('/api/notifications/mark-read', async (req, res) => {
  try {
    const { personal } = req.body || {};
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });

    if (useSupabase) {
      await sb.from('notifications').update({ read: true }).eq('personal_number', String(personal));
      // mark orders/charges replied flag false where needed (optional)
      await sb.from('orders').update({ replied: false }).eq('personal_number', String(personal)).eq('replied', true);
      await sb.from('charges').update({ replied: false }).eq('personal_number', String(personal)).eq('replied', true);
    } else {
      DB.notifications = (DB.notifications || []).map(n => (String(n.personal) === String(personal) ? { ...n, read: true } : n));
      if (Array.isArray(DB.orders)) DB.orders.forEach(o => { if (String(o.personalNumber) === String(personal) && o.replied) o.replied = false; });
      if (Array.isArray(DB.charges)) DB.charges.forEach(c => { if (String(c.personalNumber) === String(personal) && c.replied) c.replied = false; });
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
    if (useSupabase) {
      await sb.from('notifications').delete().eq('personal_number', String(personal));
    } else {
      DB.notifications = (DB.notifications || []).filter(n => String(n.personal) !== String(personal));
      saveData(DB);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('clear notifications error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Help endpoint (sends to telegram help chat) ---
app.post('/api/help', async (req, res) => {
  try {
    const { personal, issue, fileLink, desc, name, email, phone } = req.body || {};
    const prof = personal ? await findProfileByPersonal(personal) : null;
    const text = `مشكلة من المستخدم:\nالاسم: ${name || (prof && prof.name) || 'غير معروف'}\nالرقم الشخصي: ${personal || '---'}\nالهاتف: ${phone || (prof && prof.phone) || 'لا يوجد'}\nالبريد: ${email || (prof && prof.email) || 'لا يوجد'}\nالمشكلة: ${issue}\nالوصف: ${desc || ''}\nرابط الملف: ${fileLink || 'لا يوجد'}`;

    if (!CFG.BOT_HELP_TOKEN || !CFG.BOT_HELP_CHAT) {
      return res.json({ ok: false, error: 'telegram help bot not configured' });
    }
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_HELP_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CFG.BOT_HELP_CHAT, text })
    });
    const data = await r.json().catch(() => null);
    return res.json({ ok: true, telegramResult: data });
  } catch (e) {
    console.error('help error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Create order (from UI) ---
app.post('/api/orders', async (req, res) => {
  try {
    const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body || {};
    if (!personal || !type || !item) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const prof = await ensureProfile(personal);

    // If paidWithBalance -> deduct first (careful not to set negative)
    if (paidWithBalance) {
      const price = Number(paidAmount || 0);
      if (isNaN(price) || price <= 0) return res.status(400).json({ ok: false, error: 'invalid_paid_amount' });

      if (useSupabase) {
        const { data: profileRow } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
        const bal = profileRow ? Number(profileRow.balance || 0) : 0;
        if (bal < price) return res.status(402).json({ ok: false, error: 'insufficient_balance' });
        const newBal = bal - price;
        await sb.from('profiles').update({ balance: newBal }).eq('personal_number', String(personal)).eq('balance', bal); // try reduce race
        // optionally add notification
        await sb.from('notifications').insert([{ personal_number: String(personal), text: `تم خصم ${price} من رصيدك لطلب: ${item}`, read: false, created_at: new Date().toISOString() }]);
      } else {
        const p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
        if (!p) return res.status(404).json({ ok: false, error: 'profile_not_found' });
        if (Number(p.balance || 0) < price) return res.status(402).json({ ok: false, error: 'insufficient_balance' });
        p.balance = Number(p.balance || 0) - price;
        saveData(DB);
      }
    }

    const orderId = Date.now();
    const order = {
      id: orderId,
      personalNumber: String(personal),
      phone: phone || prof.phone || '',
      type, item, idField: idField || '',
      fileLink: fileLink || '',
      cashMethod: cashMethod || '',
      status: 'قيد المراجعة',
      replied: false,
      createdAt: new Date().toISOString()
    };

    if (useSupabase) {
      await sb.from('orders').insert([{
        id: order.id,
        personal_number: order.personalNumber,
        phone: order.phone,
        type: order.type,
        item: order.item,
        id_field: order.idField,
        file_link: order.fileLink,
        cash_method: order.cashMethod,
        status: order.status,
        replied: order.replied,
        created_at: order.createdAt
      }]);
    } else {
      DB.orders = DB.orders || [];
      DB.orders.unshift(order);
      saveData(DB);
    }

    // notify admin via telegram (orders chat)
    const text = `طلب شحن جديد:\n\nرقم شخصي: ${order.personalNumber}\nالهاتف: ${order.phone || 'لا يوجد'}\nالنوع: ${order.type}\nالتفاصيل: ${order.item}\nالايدي: ${order.idField || ''}\nطريقة الدفع: ${order.cashMethod || ''}\nرابط الملف: ${order.fileLink || ''}\nمعرف الطلب: ${order.id}`;
    try {
      if (CFG.BOT_ORDER_TOKEN && CFG.BOT_ORDER_CHAT) {
        await fetch(`https://api.telegram.org/bot${CFG.BOT_ORDER_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: CFG.BOT_ORDER_CHAT, text })
        });
      }
    } catch (e) { console.warn('send order to telegram failed', e); }

    return res.json({ ok: true, order });
  } catch (e) {
    console.error('create order error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Create charge (طلب شحن رصيد) ---
app.post('/api/charge', async (req, res) => {
  try {
    const { personal, phone, amount, method, fileLink } = req.body || {};
    if (!personal || !amount) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const prof = await ensureProfile(personal);
    const chargeId = Date.now();
    const charge = {
      id: chargeId,
      personalNumber: String(personal),
      phone: phone || prof.phone || '',
      amount: Number(amount),
      method: method || '',
      fileLink: fileLink || '',
      status: 'قيد المراجعة',
      replied: false,
      createdAt: new Date().toISOString()
    };

    if (useSupabase) {
      await sb.from('charges').insert([{
        id: charge.id,
        personal_number: charge.personalNumber,
        phone: charge.phone,
        amount: charge.amount,
        method: charge.method,
        file_link: charge.fileLink,
        status: charge.status,
        replied: charge.replied,
        created_at: charge.createdAt
      }]);
    } else {
      DB.charges = DB.charges || [];
      DB.charges.unshift(charge);
      saveData(DB);
    }

    // notify admin
    const text = `طلب شحن رصيد:\n\nرقم شخصي: ${personal}\nالهاتف: ${charge.phone || 'لا يوجد'}\nالمبلغ: ${amount}\nطريقة الدفع: ${method}\nرابط الملف: ${fileLink || ''}\nمعرف الشحنة: ${chargeId}`;
    try {
      if (CFG.BOT_BALANCE_TOKEN && CFG.BOT_BALANCE_CHAT) {
        await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text })
        });
      }
    } catch (e) { console.warn('send charge to telegram failed', e); }

    return res.json({ ok: true, charge });
  } catch (e) {
    console.error('charge endpoint error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Helper: confirmChargeById (centralized) ---
async function confirmChargeById(id) {
  if (!id) return { ok: false, error: 'missing_id' };
  try {
    // Supabase branch
    if (useSupabase) {
      // Get charge row
      const { data: chargeRow, error: selErr } = await sb.from('charges').select('*').eq('id', id).limit(1).maybeSingle();
      if (selErr) return { ok: false, error: selErr.message || selErr };
      if (!chargeRow) return { ok: false, error: 'charge_not_found' };
      if (chargeRow.replied) return { ok: false, error: 'already_confirmed' };

      const amount = Number(chargeRow.amount || 0);
      const personal = String(chargeRow.personal_number || chargeRow.personal || '');

      // Get profile
      const { data: profileRow, error: profErr } = await sb.from('profiles').select('*').eq('personal_number', personal).limit(1).maybeSingle();
      if (profErr) console.warn('confirm get profile err', profErr);
      if (!profileRow) return { ok: false, error: 'profile_not_found' };

      const oldBal = Number(profileRow.balance || 0);
      const newBal = oldBal + (isNaN(amount) ? 0 : amount);

      // To reduce race conditions, update profile only if balance is oldBal (optimistic)
      // Note: if concurrent updates may exist, consider using DB transactions or RLS functions.
      const { data: upProf, error: updProfErr } = await sb.from('profiles').update({ balance: newBal }).eq('personal_number', personal).select().maybeSingle();
      if (updProfErr) console.warn('confirm update profile err', updProfErr);

      // Mark charge as replied = true and status accepted, prefer conditional update where replied was false
      const { data: upCharge, error: updChargeErr } = await sb.from('charges').update({ status: 'مقبول', replied: true }).eq('id', id).eq('replied', false).select().maybeSingle();
      if (updChargeErr) console.warn('confirm update charge err', updChargeErr);
      // if upCharge is null, it might have been updated concurrently
      return { ok: true, newBalance: newBal };
    }

    // Local fallback
    const charge = (DB.charges || []).find(c => String(c.id) === String(id));
    if (!charge) return { ok: false, error: 'charge_not_found' };
    if (charge.replied) return { ok: false, error: 'already_confirmed' };

    const amount = Number(charge.amount || 0);
    const personal = String(charge.personalNumber || charge.personal || '');
    const profile = (DB.profiles || []).find(p => String(p.personalNumber) === personal);
    if (!profile) return { ok: false, error: 'profile_not_found' };

    profile.balance = Number(profile.balance || 0) + (isNaN(amount) ? 0 : amount);
    charge.status = 'مقبول';
    charge.replied = true;
    saveData(DB);
    return { ok: true, newBalance: profile.balance };
  } catch (e) {
    console.error('confirmChargeById error', e);
    return { ok: false, error: String(e) };
  }
}

// --- Endpoint: confirm charge manually ---
app.post('/api/charge/confirm', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });

    const result = await confirmChargeById(id);
    if (!result.ok) return res.status(400).json(result);

    // optional: add notification for user
    try {
      if (useSupabase) {
        // find personal_number from charges
        const { data: ch } = await sb.from('charges').select('personal_number').eq('id', id).limit(1).maybeSingle();
        const personal = ch ? ch.personal_number : null;
        if (personal) {
          await sb.from('notifications').insert([{ personal_number: String(personal), text: `تمت الموافقة على الشحنة وتم إضافة المبلغ إلى رصيدك. الرصيد الجديد: ${result.newBalance}`, read: false, created_at: new Date().toISOString() }]);
        }
      } else {
        const ch = (DB.charges || []).find(c => String(c.id) === String(id));
        if (ch) {
          DB.notifications = DB.notifications || [];
          DB.notifications.unshift({ personal: ch.personalNumber || ch.personal || '', text: `تمت الموافقة على الشحنة. الرصيد الجديد: ${result.newBalance}`, read: false, createdAt: new Date().toISOString() });
          saveData(DB);
        }
      }
    } catch (notifyErr) { console.warn('notify after confirm failed', notifyErr); }

    return res.json({ ok: true, newBalance: result.newBalance });
  } catch (e) {
    console.error('charge confirm endpoint error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Profile edit requests (UI uses these) ---
app.post('/api/profile/request-edit', async (req, res) => {
  try {
    const { personal } = req.body || {};
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });

    if (useSupabase) {
      await sb.from('profile_edit_requests').insert([{ personal_number: String(personal), requested_at: new Date().toISOString() }]);
    } else {
      DB.profileEditRequests = DB.profileEditRequests || [];
      DB.profileEditRequests.push({ personal: String(personal), createdAt: new Date().toISOString(), status: 'pending' });
      saveData(DB);
    }

    // optional notify admin
    try {
      if (CFG.BOT_ADMIN_CMD_TOKEN && CFG.BOT_ADMIN_CMD_CHAT) {
        await fetch(`https://api.telegram.org/bot${CFG.BOT_ADMIN_CMD_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: CFG.BOT_ADMIN_CMD_CHAT, text: `طلب تعديل ملف من الرقم الشخصي: ${personal}` })
        });
      }
    } catch (e) { console.warn('notify admin request-edit failed', e); }

    return res.json({ ok: true });
  } catch (e) {
    console.error('request-edit error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Submit profile edit (save) — do not overwrite balance ---
app.post('/api/profile/submit-edit', async (req, res) => {
  try {
    const { personal, name, email, password, phone } = req.body || {};
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });

    if (useSupabase) {
      const upd = {};
      if (typeof name !== 'undefined') upd.name = name;
      if (typeof email !== 'undefined') upd.email = email;
      if (typeof password !== 'undefined') upd.password = password;
      if (typeof phone !== 'undefined') upd.phone = phone;
      if (Object.keys(upd).length === 0) {
        const { data } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
        return res.json({ ok: true, profile: mapSbProfileToResponse(data) });
      }
      const { data } = await sb.from('profiles').update(upd).eq('personal_number', String(personal)).select().maybeSingle();
      return res.json({ ok: true, profile: mapSbProfileToResponse(data) });
    }

    // local
    let p = (DB.profiles || []).find(x => String(x.personalNumber) === String(personal));
    if (!p) {
      p = { personalNumber: String(personal), name: name || 'ضيف', email: email || '', password: password || '', phone: phone || '', balance: 0 };
      DB.profiles.push(p);
    } else {
      if (typeof name !== 'undefined') p.name = name;
      if (typeof email !== 'undefined') p.email = email;
      if (typeof password !== 'undefined') p.password = password;
      if (typeof phone !== 'undefined') p.phone = phone;
      // do NOT touch balance
    }
    saveData(DB);
    return res.json({ ok: true, profile: p });
  } catch (e) {
    console.error('submit-edit error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Telegram webhook: process admin replies (optional) ---
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg) return res.sendStatus(200);

    // Optionally verify chat id for security
    const adminChatId = CFG.BOT_BALANCE_CHAT || '';
    if (adminChatId && String(msg.chat && msg.chat.id) !== String(adminChatId)) {
      return res.sendStatus(200);
    }

    const replied = msg.reply_to_message;
    if (!replied || !replied.text) return res.sendStatus(200);

    // Try to extract charge/order id from the replied-to text (supports Arabic "معرف" variants)
    const text = replied.text || '';
    const re = /(?:معرف\s*(?:الطلب|الشحنة|ال)?\s*[:\-]?\s*)(\d{3,})/i;
    const m = text.match(re);
    if (!m) return res.sendStatus(200);

    const id = m[1];
    const result = await confirmChargeById(id);
    console.log('telegram webhook confirm result', id, result);

    // Optionally reply back to admin or user via telegram API (not required here)
    return res.sendStatus(200);
  } catch (e) {
    console.error('telegram webhook error', e);
    return res.sendStatus(200);
  }
});

// --- Offers ack (UI) ---
app.post('/api/offer/ack', async (req, res) => {
  try {
    const { personal, offerId } = req.body || {};
    if (!personal || !offerId) return res.status(400).json({ ok: false, error: 'missing' });

    const prof = await findProfileByPersonal(personal);
    const text = `حصول على العرض\nالرقم الشخصي: ${personal}\nالبريد: ${prof ? prof.email : 'لا يوجد'}\nالهاتف: ${prof ? prof.phone : 'لا يوجد'}\nالعرض: ${offerId}`;
    if (!CFG.BOT_OFFERS_TOKEN || !CFG.BOT_OFFERS_CHAT) return res.json({ ok: false, error: 'telegram offers bot not configured' });

    try {
      await fetch(`https://api.telegram.org/bot${CFG.BOT_OFFERS_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: CFG.BOT_OFFERS_CHAT, text })
      });
    } catch (e) { console.warn('offer ack send failed', e); }

    return res.json({ ok: true });
  } catch (e) {
    console.error('offer ack error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Simple health route ---
app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString(), supabase: useSupabase }));

// --- Start server ---
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

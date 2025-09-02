// server.js — نسخة كاملة ومُعدّلة مع CFG مُضمّن (قِيَم جاهزة للعمل)
// الحزم المطلوبة: express, cors, node-fetch@2, multer, @supabase/supabase-js
// تشغيل: node server.js

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // v2
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ----------------- CFG (مضمّن بالقيم التي أرسلتها) -----------------
const CFG = {
  PORT,

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL || "https://ugdktasyhuojvdunwwyd.supabase.co",
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVnZGt0YXN5aHVvanZkdW53d3lkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Njc5NzU1NSwiZXhwIjoyMDcyMzczNTU1fQ.9_EnpQ8JCIhBfr9CXoVvK26NlQMbWmiZGB9fZ5FR6pQ",

  // ImgBB
  IMGBB_KEY: process.env.IMGBB_KEY || "e5603dfd5675ed2b5a671577abcf6d33",

  // Telegram bots & chats (مضمّن)
  BOT_ADMIN_CMD_TOKEN: process.env.BOT_ADMIN_CMD_TOKEN || "7867503081:AAE32J-TrMh52QYHrbPzsKxnM7qbgA9iKCo",
  BOT_ADMIN_CMD_CHAT: process.env.BOT_ADMIN_CMD_CHAT || "7649409589",

  BOT_HELP_TOKEN: process.env.BOT_HELP_TOKEN || "8242410438:AAHtm6-aIldfmTe1JQVnhdYkOIY3MaN4aFA",
  BOT_HELP_CHAT: process.env.BOT_HELP_CHAT || "7649409589",

  BOT_LOGIN_REPORT_TOKEN: process.env.BOT_LOGIN_REPORT_TOKEN || "8322394934:AAFik8dEU71oOxBCHlhOVNKFGATWnqlg-_8",
  BOT_LOGIN_REPORT_CHAT: process.env.BOT_LOGIN_REPORT_CHAT || "7649409589",

  BOT_NOTIFY_TOKEN: process.env.BOT_NOTIFY_TOKEN || "7909957386:AAEQZDloKb-JCcUInKiw5gmSmThPuyruxbU",
  BOT_NOTIFY_CHAT: process.env.BOT_NOTIFY_CHAT || "7649409589",

  BOT_OFFERS_TOKEN: process.env.BOT_OFFERS_TOKEN || "7976416746:AAGyvWAxanxhkz--4c6U_3-NA2TGBV4lJ9Y",
  BOT_OFFERS_CHAT: process.env.BOT_OFFERS_CHAT || "7649409589",

  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || "8484157462:AAGHyBqwL9k1EmzvXAIZkb9UNDcwIGMINAs",
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || "7649409589",

  // Notice: the names you sent used CFG_BOT_BALANCE_* — we map them to BOT_BALANCE_*
  BOT_BALANCE_TOKEN: process.env.CFG_BOT_BALANCE_TOKEN || "8028609250:AAHXWR7PlZpBieM5Sx0oJI0dbUczxs9XJIg",
  BOT_BALANCE_CHAT: process.env.CFG_BOT_BALANCE_CHAT || "7649409589",

  // Optional: if you want to restrict admin commands additionally to specific user ids
  ADMIN_ALLOWED_USERS: [] // put numeric Telegram user IDs here if needed, e.g. [12345678]
};

// ----------------- Supabase client (اختياري) -----------------
const useSupabase = !!(CFG.SUPABASE_URL && CFG.SUPABASE_SERVICE_KEY);
let sb = null;
if (useSupabase) {
  try {
    sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_SERVICE_KEY, { global: { fetch } });
    console.log('Supabase client initialized');
  } catch (e) {
    console.warn('Supabase init failed, falling back to local DB', e);
  }
}

// ----------------- Local DB fallback (data.json) -----------------
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
    return { profiles: [], orders: [], charges: [], offers: [], notifications: [], profileEditRequests: [], blocked: [], tgOffsets: {} };
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

// ----------------- Helpers -----------------

// Extract personal from various possible names (body, params, query)
function getPersonalFromReq(req) {
  if (!req) return null;
  const b = req.body || {};
  if (b.personal) return String(b.personal);
  if (b.personalNumber) return String(b.personalNumber);
  if (b.personal_number) return String(b.personal_number);
  if (req.params && req.params.personal) return String(req.params.personal);
  if (req.query && (req.query.personal || req.query.personalNumber || req.query.personal_number)) {
    return String(req.query.personal || req.query.personalNumber || req.query.personal_number);
  }
  return null;
}

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
    telegram_chat_id: row.telegram_chat_id || row.tg_chat_id || row.chat_id || null
  };
}

async function findProfileByPersonal(personal) {
  if (!personal) return null;
  try {
    if (useSupabase && sb) {
      const { data, error } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (error) console.warn('supabase findProfile error', error);
      if (data) return mapSbProfileToResponse(data);
    }
  } catch (e) {
    console.warn('findProfileByPersonal supabase err', e);
  }
  const p = DB.profiles.find(x => String(x.personalNumber) === String(personal) || String(x.personal_number) === String(personal));
  if (!p) return null;
  return {
    personalNumber: p.personalNumber || p.personal_number,
    name: p.name, email: p.email, phone: p.phone, password: p.password,
    balance: Number(p.balance || 0), canEdit: !!p.canEdit, lastLogin: p.lastLogin, telegram_chat_id: p.telegram_chat_id
  };
}

async function ensureProfile(personal) {
  if (!personal) return null;
  try {
    if (useSupabase && sb) {
      const { data: existing, error } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (error) console.warn('ensureProfile supabase sel err', error);
      if (existing) return mapSbProfileToResponse(existing);
      const ins = { personal_number: String(personal), name: 'ضيف', email: '', phone: '', password: '', balance: 0, can_edit: false, last_login: new Date().toISOString() };
      const { data } = await sb.from('profiles').insert([ins]).select().maybeSingle();
      return mapSbProfileToResponse(data);
    }
  } catch (e) { console.warn('ensureProfile supabase err', e); }
  let p = DB.profiles.find(x => String(x.personalNumber) === String(personal) || String(x.personal_number) === String(personal));
  if (!p) {
    p = { personalNumber: String(personal), personal_number: String(personal), name: 'ضيف', email: '', phone: '', password: '', balance: 0, canEdit: false, lastLogin: new Date().toISOString() };
    DB.profiles.push(p); saveData(DB);
  }
  return {
    personalNumber: p.personalNumber || p.personal_number,
    name: p.name, email: p.email, phone: p.phone, password: p.password,
    balance: Number(p.balance || 0), canEdit: !!p.canEdit, lastLogin: p.lastLogin
  };
}

// Send Telegram message (optional)
async function sendTelegramMessageToChat(chatId, text, tokenOverride) {
  try {
    if (!chatId) return null;
    const token = tokenOverride || CFG.BOT_NOTIFY_TOKEN || CFG.BOT_BALANCE_TOKEN || CFG.BOT_ADMIN_CMD_TOKEN;
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

// Add balance to profile (returns {ok,newBalance} or {ok:false,error})
async function addBalanceToPersonal(personal, amount) {
  try {
    const amt = Number(amount || 0);
    if (isNaN(amt)) return { ok: false, error: 'invalid_amount' };

    if (useSupabase && sb) {
      const { data: profRow } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (!profRow) {
        const { data: newProf } = await sb.from('profiles').insert([{ personal_number: String(personal), name: 'ضيف', balance: amt }]).select().maybeSingle();
        return { ok: true, newBalance: Number(newProf.balance || 0) };
      }
      const oldBal = Number(profRow.balance || 0);
      const newBal = oldBal + amt;
      const { error } = await sb.from('profiles').update({ balance: newBal }).eq('personal_number', String(personal));
      if (error) console.warn('addBalance supabase update err', error);
      return { ok: true, newBalance: newBal };
    }

    // local fallback
    let p = (DB.profiles || []).find(x => String(x.personalNumber) === String(personal) || String(x.personal_number) === String(personal));
    if (!p) {
      p = { personalNumber: String(personal), personal_number: String(personal), name: 'ضيف', email: '', password: '', phone: '', balance: Number(amount), canEdit: false, lastLogin: new Date().toISOString() };
      DB.profiles.push(p);
    } else {
      p.balance = Number(p.balance || 0) + Number(amount);
    }
    saveData(DB);
    return { ok: true, newBalance: Number(p.balance) };
  } catch (e) {
    console.error('addBalanceToPersonal error', e);
    return { ok: false, error: String(e) };
  }
}

// Mark latest pending charge as accepted (tries to match amount)
async function markLatestPendingChargeAsAccepted(personal, amount) {
  try {
    if (useSupabase && sb) {
      const { data: pending } = await sb.from('charges').select('*').eq('personal_number', String(personal)).eq('replied', false).order('created_at', { ascending: false }).limit(5);
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

    const pendingLocal = (DB.charges || []).filter(c => String(c.personalNumber || c.personal) === String(personal) && !c.replied).sort((a, b) => new Date(b.createdAt || b.created_at) - new Date(a.createdAt || a.created_at));
    if (pendingLocal.length > 0) {
      let found = pendingLocal.find(p => Number(p.amount) === Number(amount));
      if (!found) found = pendingLocal[0];
      if (found) {
        found.status = 'مقبول'; found.replied = true; found.updatedAt = new Date().toISOString(); saveData(DB);
        return { ok: true, chargeId: found.id || found.cid || null };
      }
    }
    return { ok: false, error: 'no_pending_charge' };
  } catch (e) {
    console.error('markLatestPendingChargeAsAccepted error', e);
    return { ok: false, error: String(e) };
  }
}

// Confirm charge by id (used by reply-to id)
async function confirmChargeById(id) {
  if (!id) return { ok: false, error: 'missing_id' };
  try {
    if (useSupabase && sb) {
      const { data: chargeRow } = await sb.from('charges').select('*').eq('id', id).limit(1).maybeSingle();
      if (!chargeRow) return { ok: false, error: 'charge_not_found' };
      if (chargeRow.replied) return { ok: false, error: 'already_confirmed' };
      const amount = Number(chargeRow.amount || 0);
      const personal = String(chargeRow.personal_number || chargeRow.personal || '');
      const { data: profileRow } = await sb.from('profiles').select('*').eq('personal_number', personal).limit(1).maybeSingle();
      if (!profileRow) return { ok: false, error: 'profile_not_found' };
      const oldBal = Number(profileRow.balance || 0);
      const newBal = oldBal + (isNaN(amount) ? 0 : amount);
      await sb.from('profiles').update({ balance: newBal }).eq('personal_number', personal);
      await sb.from('charges').update({ status: 'مقبول', replied: true }).eq('id', id).eq('replied', false);
      await sb.from('notifications').insert([{ personal_number: personal, text: `تمت إضافة مبلغ ${amount} إلى رصيدك. الرصيد الآن: ${newBal}`, read: false, created_at: new Date().toISOString() }]);
      return { ok: true, newBalance: newBal, chargeId: id };
    }

    // local fallback
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

// Confirm order by id (for order bot)
async function confirmOrderById(id) {
  if (!id) return { ok: false, error: 'missing_id' };
  try {
    if (useSupabase && sb) {
      const { data: orderRow } = await sb.from('orders').select('*').eq('id', id).limit(1).maybeSingle();
      if (!orderRow) return { ok: false, error: 'order_not_found' };
      if (orderRow.replied) return { ok: false, error: 'already_confirmed' };
      await sb.from('orders').update({ status: 'تمت المعالجة', replied: true }).eq('id', id).eq('replied', false);
      await sb.from('notifications').insert([{ personal_number: orderRow.personal_number, text: `طلبك #${id} تمّت معالجته.`, read: false, created_at: new Date().toISOString() }]);
      return { ok: true, orderId: id };
    }
    const ord = (DB.orders || []).find(o => String(o.id) === String(id));
    if (!ord) return { ok: false, error: 'order_not_found' };
    if (ord.replied) return { ok: false, error: 'already_confirmed' };
    ord.status = 'تمت المعالجة'; ord.replied = true; ord.updatedAt = new Date().toISOString();
    DB.notifications = DB.notifications || [];
    DB.notifications.unshift({ id: String(Date.now()), personal: ord.personalNumber, text: `طلبك #${id} تمّت معالجته.`, read: false, createdAt: new Date().toISOString() });
    saveData(DB);
    return { ok: true, orderId: id };
  } catch (e) {
    console.error('confirmOrderById error', e);
    return { ok: false, error: String(e) };
  }
}

// Ban / unban helpers
async function banPersonal(personal, reason = '') {
  try {
    if (!personal) return { ok: false, error: 'missing_personal' };
    if (useSupabase && sb) {
      await sb.from('blocked').insert([{ personal_number: String(personal), reason, created_at: new Date().toISOString() }]);
      return { ok: true };
    }
    DB.blocked = DB.blocked || [];
    if (!DB.blocked.includes(String(personal))) { DB.blocked.push(String(personal)); saveData(DB); }
    return { ok: true };
  } catch (e) {
    console.error('banPersonal error', e);
    return { ok: false, error: String(e) };
  }
}
async function unbanPersonal(personal) {
  try {
    if (!personal) return { ok: false, error: 'missing_personal' };
    if (useSupabase && sb) {
      await sb.from('blocked').delete().eq('personal_number', String(personal));
      return { ok: true };
    }
    DB.blocked = (DB.blocked || []).filter(x => String(x) !== String(personal)); saveData(DB);
    return { ok: true };
  } catch (e) {
    console.error('unbanPersonal error', e);
    return { ok: false, error: String(e) };
  }
}

// ----------------- Endpoints -----------------

app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString(), supabase: useSupabase }));

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body || {};
    let personalNumber = req.body.personalNumber || req.body.personal || req.body.personal_number || null;
    if (!personalNumber) {
      // generate unique personal number
      let n;
      do {
        n = String(Math.floor(1000000 + Math.random() * 9000000));
      } while ((DB.profiles || []).some(p => String(p.personalNumber) === n || String(p.personal_number) === n));
      personalNumber = n;
    }
    if (useSupabase && sb) {
      const { data: existing } = await sb.from('profiles').select('*').eq('personal_number', String(personalNumber)).limit(1).maybeSingle();
      if (existing) {
        // update some fields without touching balance
        const upd = {};
        if (typeof name !== 'undefined') upd.name = name;
        if (typeof email !== 'undefined') upd.email = email;
        if (typeof password !== 'undefined') upd.password = password;
        if (typeof phone !== 'undefined') upd.phone = phone;
        if (Object.keys(upd).length > 0) {
          const { data } = await sb.from('profiles').update(upd).eq('personal_number', String(personalNumber)).select().maybeSingle();
          return res.json({ ok: true, profile: mapSbProfileToResponse(data) });
        }
        return res.json({ ok: true, profile: mapSbProfileToResponse(existing) });
      } else {
        const ins = { personal_number: String(personalNumber), name: name || 'ضيف', email: email || '', password: password || '', phone: phone || '', balance: 0, can_edit: false, last_login: new Date().toISOString() };
        const { data } = await sb.from('profiles').insert([ins]).select().maybeSingle();
        return res.json({ ok: true, profile: mapSbProfileToResponse(data) });
      }
    }

    // local fallback
    DB.profiles = DB.profiles || [];
    let p = DB.profiles.find(x => String(x.personalNumber) === String(personalNumber) || String(x.personal_number) === String(personalNumber));
    if (!p) {
      p = { personalNumber: String(personalNumber), personal_number: String(personalNumber), name: name || 'ضيف', email: email || '', password: password || '', phone: phone || '', balance: 0, canEdit: false, createdAt: new Date().toISOString() };
      DB.profiles.push(p);
    } else {
      if (typeof name !== 'undefined') p.name = name;
      if (typeof email !== 'undefined') p.email = email;
      if (typeof password !== 'undefined') p.password = password;
      if (typeof phone !== 'undefined') p.phone = phone;
      // do not touch balance
    }
    saveData(DB);
    return res.json({ ok: true, profile: p });
  } catch (e) {
    console.error('register error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const b = req.body || {};
    const personal = b.personal || b.personalNumber || b.personal_number;
    const password = b.password;
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });

    let profile = null;
    if (useSupabase && sb) {
      const { data, error } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (error) console.warn('login supabase select error', error);
      profile = data;
    } else {
      profile = (DB.profiles || []).find(p => String(p.personalNumber) === String(personal) || String(p.personal_number) === String(personal));
    }

    if (!profile) return res.status(404).json({ ok: false, error: 'not_found' });
    if (password && profile.password && String(profile.password) !== String(password)) {
      return res.status(403).json({ ok: false, error: 'wrong_password' });
    }

    // update last login
    try {
      if (useSupabase && sb) await sb.from('profiles').update({ last_login: new Date().toISOString() }).eq('personal_number', String(personal));
      else {
        const p = (DB.profiles || []).find(x => String(x.personalNumber) === String(personal) || String(x.personal_number) === String(personal));
        if (p) { p.lastLogin = new Date().toISOString(); saveData(DB); }
      }
    } catch (e) { /* ignore */ }

    return res.json({ ok: true, profile });
  } catch (e) {
    console.error('login error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Create charge (user requests top-up)
app.post('/api/charge', async (req, res) => {
  try {
    const { personal, amount, phone, method, fileLink } = req.body || {};
    if (!personal || !amount) return res.status(400).json({ ok: false, error: 'missing_fields' });
    const chargeId = String(Date.now()) + Math.floor(Math.random() * 999);
    const charge = {
      id: chargeId,
      personalNumber: String(personal),
      phone: phone || '',
      amount: Number(amount),
      method: method || '',
      fileLink: fileLink || '',
      status: 'قيد المراجعة',
      replied: false,
      createdAt: new Date().toISOString()
    };

    if (useSupabase && sb) {
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

    // notify admin/chat about new charge (optional)
    try {
      if (CFG.BOT_BALANCE_TOKEN && CFG.BOT_BALANCE_CHAT) {
        await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text:
            `طلب شحن جديد\nمعرف الشحنة: ${chargeId}\nالرقم الشخصي: ${personal}\nالمبلغ: ${amount}` })
        });
      }
    } catch (e) { console.warn('notify admin about charge failed', e); }

    return res.json({ ok: true, charge });
  } catch (e) {
    console.error('charge error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Confirm charge by ID (HTTP endpoint)
app.post('/api/charge/confirm', async (req, res) => {
  try {
    const id = req.body && (req.body.id || req.body.chargeId);
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
    const result = await confirmChargeById(id);
    if (!result.ok) return res.status(400).json(result);
    return res.json({ ok: true, newBalance: result.newBalance, chargeId: result.chargeId });
  } catch (e) {
    console.error('charge confirm endpoint error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Profile edit request submit
app.post('/api/profile/submit-edit', async (req, res) => {
  try {
    const { personal, name, email, phone } = req.body || {};
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    DB.profileEditRequests = DB.profileEditRequests || [];
    const reqId = String(Date.now()) + Math.floor(Math.random() * 999);
    DB.profileEditRequests.unshift({ id: reqId, personal: String(personal), name, email, phone, status: 'pending', createdAt: new Date().toISOString() });
    saveData(DB);
    // notify admin optionally
    try {
      if (CFG.BOT_ADMIN_CMD_TOKEN && CFG.BOT_ADMIN_CMD_CHAT) {
        await fetch(`https://api.telegram.org/bot${CFG.BOT_ADMIN_CMD_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: CFG.BOT_ADMIN_CMD_CHAT, text: `طلب تعديل ملف من الرقم: ${personal}\nالاسم: ${name || '---'}` })
        });
      }
    } catch (e) { /* ignore */ }
    return res.json({ ok: true, requestId: reqId });
  } catch (e) {
    console.error('submit-edit error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Confirm profile edit (admin)
app.post('/api/profile/confirm-edit', async (req, res) => {
  try {
    const { requestId } = req.body || {};
    if (!requestId) return res.status(400).json({ ok: false, error: 'missing_requestId' });
    const r = (DB.profileEditRequests || []).find(x => x.id === String(requestId));
    if (!r) return res.status(404).json({ ok: false, error: 'not_found' });
    const prof = await findProfileByPersonal(r.personal);
    if (prof) {
      // apply changes locally (Supabase branch not included here for brevity)
      // in local DB we must find the object and mutate it
      const local = (DB.profiles || []).find(x => String(x.personalNumber) === String(r.personal) || String(x.personal_number) === String(r.personal));
      if (local) {
        local.name = r.name || local.name;
        local.email = r.email || local.email;
        local.phone = r.phone || local.phone;
        saveData(DB);
      }
    }
    r.status = 'accepted'; r.updatedAt = new Date().toISOString(); saveData(DB);
    return res.json({ ok: true });
  } catch (e) {
    console.error('confirm-edit error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Notifications retrieval
app.get('/api/notifications/:personal', async (req, res) => {
  try {
    const personal = getPersonalFromReq(req);
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    const profile = await findProfileByPersonal(personal);
    const notifications = (DB.notifications || []).filter(n => String(n.personal) === String(personal));
    const orders = (DB.orders || []).filter(o => String(o.personalNumber || o.personal) === String(personal));
    const charges = (DB.charges || []).filter(c => String(c.personalNumber || c.personal) === String(personal));
    const offers = (DB.offers || []).filter(o => !!o.active);
    return res.json({ ok: true, profile, notifications, orders, charges, offers });
  } catch (e) {
    console.error('notifications endpoint error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Mark notifications read
app.post('/api/notifications/mark-read', async (req, res) => {
  try {
    const personal = getPersonalFromReq(req);
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    DB.notifications = (DB.notifications || []).map(n => (String(n.personal) === String(personal) ? Object.assign({}, n, { read: true }) : n));
    if (Array.isArray(DB.orders)) DB.orders.forEach(o => { if (String(o.personalNumber) === String(personal) && o.replied) o.replied = false; });
    if (Array.isArray(DB.charges)) DB.charges.forEach(c => { if (String(c.personalNumber) === String(personal) && c.replied) c.replied = false; });
    saveData(DB);
    return res.json({ ok: true });
  } catch (e) {
    console.error('mark-read error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Clear notifications
app.post('/api/notifications/clear', async (req, res) => {
  try {
    const personal = getPersonalFromReq(req);
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    DB.notifications = (DB.notifications || []).filter(n => String(n.personal) !== String(personal));
    saveData(DB);
    return res.json({ ok: true });
  } catch (e) {
    console.error('clear notifications error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ----------------- Telegram webhook (robust) -----------------
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg) return res.sendStatus(200);

    // Optional: restrict to configured chat (recommended in production)
    const adminChatId = CFG.BOT_BALANCE_CHAT || '';
    if (adminChatId && String(msg.chat && msg.chat.id) !== String(adminChatId)) {
      console.log('Webhook: ignored message from chat', msg.chat && msg.chat.id);
      return res.sendStatus(200);
    }

    // 1) Reply-to with "معرف ..." => confirm by id
    const repliedTo = msg.reply_to_message;
    if (repliedTo && repliedTo.text) {
      const reId = /(?:معرف\s*(?:الطلب|الشحنة|ال)?\s*[:\-]?\s*)(\d+)/i;
      const mid = (repliedTo.text || '').match(reId);
      if (mid) {
        const id = mid[1];
        try {
          const r = await confirmChargeById(id);
          console.log('Webhook: confirmChargeById', id, r);
        } catch (e) { console.warn('Webhook confirm by id error', e); }
        try { await sendTelegramMessageToChat(msg.chat.id, `تم معالجة الطلب بالمعرف ${id}`); } catch (e) {}
        return res.sendStatus(200);
      }
    }

    // 2) Direct message: "الرصيد: <amount>\nالرقم الشخصي: <personal>"
    const txt = (msg.text || '').replace(/\u00A0/g, ' ');
    const reAmount = /الرصيد\s*[:\-]?\s*([0-9\.,]+)/i;
    const rePersonal = /الرقم\s*الشخصي\s*[:\-]?\s*(\d+)/i;
    const mAmount = txt.match(reAmount);
    const mPersonal = txt.match(rePersonal);

    if (mAmount && mPersonal) {
      let amountRaw = mAmount[1].replace(/\s+/g, '').replace(/,/g, '').replace(/\./g, '');
      const amount = Number(amountRaw);
      const personal = String(mPersonal[1]);

      if (isNaN(amount) || amount <= 0) {
        await sendTelegramMessageToChat(msg.chat.id, `خطأ: قيمة الرصيد غير صالحة: ${mAmount[1]}`);
        return res.sendStatus(200);
      }

      // Add balance
      const addRes = await addBalanceToPersonal(personal, amount);
      if (!addRes.ok) {
        await sendTelegramMessageToChat(msg.chat.id, `خطأ عند تحديث الرصيد: ${addRes.error || 'unknown'}`);
        return res.sendStatus(200);
      }

      // Mark pending charge if exists
      const markRes = await markLatestPendingChargeAsAccepted(personal, amount);

      // Add internal notification
      try {
        DB.notifications = DB.notifications || [];
        DB.notifications.unshift({
          id: String(Date.now()),
          personal: String(personal),
          text: `تمت إضافة مبلغ ${Number(amount).toLocaleString()} إلى رصيدك. الرصيد الجديد: ${addRes.newBalance}`,
          read: false,
          createdAt: new Date().toISOString()
        });
        saveData(DB);
      } catch (e) { console.warn('add notification failed', e); }

      // Notify admin back (feedback)
      try {
        await sendTelegramMessageToChat(msg.chat.id, `تمت إضافة ${amount.toLocaleString()} لرقم ${personal}. الرصيد الجديد: ${addRes.newBalance}. ${markRes.ok ? 'وُسمت الشحنة كمقبولة.' : 'لم يكن هناك شحنة معلقة.'}`);
      } catch (e) { /* ignore */ }

      return res.sendStatus(200);
    }

    // nothing matched
    return res.sendStatus(200);
  } catch (e) {
    console.error('telegram webhook enhanced error', e);
    return res.sendStatus(200);
  }
});

// ----------------- Start server -----------------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Save DB on exit
process.on('SIGINT', () => {
  try { saveData(DB); console.log('Saved DB before exit'); } catch (e) {}
  process.exit();
});

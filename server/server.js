/**
 * server.js — Supabase-enabled with fallback to local data.json
 * Env vars used:
 *  SUPABASE_URL, SUPABASE_KEY
 *  BOT_* and IMGBB_KEY (optional, kept from original)
 */

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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const init = {
        profiles: [],
        orders: [],
        charges: [],
        offers: [],
        notifications: [],
        profileEditRequests: {},
        blocked: [],
        tgOffsets: {}
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.error('loadData error', e);
    return { profiles: [], orders: [], charges: [], offers: [], notifications: [], profileEditRequests: {}, blocked: [], tgOffsets: {} };
  }
}
function saveData(d) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch (e) { console.error('saveData error', e); } }
let DB = loadData();

// Supabase client (optional)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
let sb = null;
if (useSupabase) {
  sb = createClient(SUPABASE_URL, SUPABASE_KEY, { global: { fetch } });
  console.log('Supabase: enabled');
} else {
  console.log('Supabase: not configured — using local data.json fallback');
}

function mapSbProfileToResponse(row) {
  if (!row) return null;
  return {
    personalNumber: row.personal_number || row.personalNumber || null,
    name: row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    password: row.password || '',
    balance: typeof row.balance !== 'undefined' ? Number(row.balance) : 0,
    canEdit: !!row.can_edit,
    lastLogin: row.last_login || null
  };
}

async function findProfileByPersonal(personal) {
  // Supabase path
  if (useSupabase) {
    try {
      const { data, error } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (error) {
        console.warn('supabase profiles select error', error);
      }
      if (data) return mapSbProfileToResponse(data);
    } catch (e) {
      console.warn('supabase findProfileByPersonal error', e);
    }
  }

  // fallback to local DB
  const p = DB.profiles.find(p => String(p.personalNumber) === String(personal)) || null;
  return p ? {
    personalNumber: p.personalNumber,
    name: p.name, email: p.email, phone: p.phone,
    password: p.password, balance: Number(p.balance || 0),
    canEdit: !!p.canEdit, lastLogin: p.lastLogin
  } : null;
}

async function findProfileByEmail(email) {
  if (!email) return null;
  if (useSupabase) {
    try {
      const { data, error } = await sb.from('profiles').select('*').ilike('email', String(email)).limit(1).maybeSingle();
      if (error) console.warn('sb email select error', error);
      if (data) return mapSbProfileToResponse(data);
    } catch (e) { console.warn('sb findProfileByEmail error', e); }
  }
  const p = DB.profiles.find(x => x.email && String(x.email).toLowerCase() === String(email).toLowerCase()) || null;
  return p ? {
    personalNumber: p.personalNumber, name: p.name, email: p.email, phone: p.phone,
    password: p.password, balance: Number(p.balance || 0), canEdit: !!p.canEdit, lastLogin: p.lastLogin
  } : null;
}

async function ensureProfile(personal) {
  // if supabase, try to fetch and insert if missing
  if (useSupabase) {
    try {
      const existing = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (existing && existing.data) {
        return mapSbProfileToResponse(existing.data);
      } else {
        const newProfile = {
          personal_number: String(personal), name: 'ضيف', email: '', phone: '', password: '', balance: 0, can_edit: false
        };
        const { data, error } = await sb.from('profiles').insert([newProfile]).limit(1).maybeSingle();
        if (error) {
          console.warn('ensureProfile insert error', error);
          // fallback to local
        } else if (data) {
          return mapSbProfileToResponse(data);
        }
      }
    } catch (e) {
      console.warn('ensureProfile supabase error', e);
    }
  }

  // local fallback
  let p = DB.profiles.find(p => String(p.personalNumber) === String(personal));
  if (!p) {
    p = { personalNumber: String(personal), name: 'ضيف', email: '', phone: '', password: '', balance: 0, canEdit: false };
    DB.profiles.push(p); saveData(DB);
  } else {
    if (typeof p.balance === 'undefined') p.balance = 0;
  }
  return { personalNumber: p.personalNumber, name: p.name, email: p.email, phone: p.phone, password: p.password, balance: Number(p.balance || 0), canEdit: !!p.canEdit };
}

const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/', express.static(PUBLIC_DIR));

const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

app.post('/api/upload', uploadMemory.single('file'), async (req, res) => {
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
      } catch (e) { console.warn('imgbb upload failed', e); }
    }
    const safeName = Date.now() + '-' + (req.file.originalname ? req.file.originalname.replace(/\s+/g, '_') : 'upload.jpg');
    const destPath = path.join(UPLOADS_DIR, safeName);
    fs.writeFileSync(destPath, req.file.buffer);
    const fullUrl = `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(safeName)}`;
    return res.json({ ok: true, url: fullUrl, provider: 'local' });
  } catch (err) {
    console.error('upload handler error', err);
    return res.status(500).json({ ok: false, error: err.message || 'upload_failed' });
  }
});

// ------ register (create or update) ------
app.post('/api/register', async (req, res) => {
  const { name, email, password, phone } = req.body;
  let personalNumber = req.body.personalNumber || req.body.personal || null;

  // if no personalNumber provided, generate one (7 digits) — the UI will call register when user wants to create account
  if (!personalNumber) {
    personalNumber = String(Math.floor(1000000 + Math.random() * 9000000));
  }

  // If Supabase available: upsert into profiles
  if (useSupabase) {
    try {
      const row = {
        personal_number: personalNumber,
        name: name || 'غير معروف',
        email: email || '',
        password: password || '',
        phone: phone || '',
        balance: 0,
        can_edit: false,
        last_login: new Date().toISOString()
      };
      // try upsert by personal_number
      const { data, error } = await sb.from('profiles').upsert(row, { onConflict: 'personal_number' }).select().maybeSingle();
      if (error) console.warn('supabase upsert error', error);
      const prof = data || row;
      // notify telegram (kept behavior)
      const text = `تسجيل مستخدم جديد:\nالاسم: ${prof.name}\nالبريد: ${prof.email || 'لا يوجد'}\nالهاتف: ${prof.phone || 'لا يوجد'}\nالرقم الشخصي: ${prof.personal_number}\nكلمة السر: ${prof.password || '---'}`;
      (async () => {
        try {
          await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
          });
        } catch (e) { console.warn('send login report failed', e); }
      })();
      return res.json({ ok: true, profile: mapSbProfileToResponse(prof) });
    } catch (e) {
      console.warn('register supabase error', e);
    }
  }

  // fallback to local DB
  try {
    let p = DB.profiles.find(x => String(x.personalNumber) === String(personalNumber));
    if (!p) {
      p = { personalNumber: String(personalNumber), name: name || 'غير معروف', email: email || '', password: password || '', phone: phone || '', balance: 0, canEdit: false, lastLogin: new Date().toISOString() };
      DB.profiles.push(p);
    } else {
      p.name = name || p.name;
      p.email = email || p.email;
      p.password = password || p.password;
      p.phone = phone || p.phone;
      p.lastLogin = new Date().toISOString();
    }
    saveData(DB);
    const text = `تسجيل مستخدم جديد:\nالاسم: ${p.name}\nالبريد: ${p.email || 'لا يوجد'}\nالهاتف: ${p.phone || 'لا يوجد'}\nالرقم الشخصي: ${p.personalNumber}\nكلمة السر: ${p.password || '---'}`;
    try {
      await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
      });
    } catch (e) { console.warn('send login report failed', e); }
    return res.json({ ok: true, profile: { personalNumber: p.personalNumber, name: p.name, email: p.email, phone: p.phone, password: p.password, balance: Number(p.balance || 0), canEdit: !!p.canEdit } });
  } catch (err) {
    console.error('register fallback error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ------ login ------
app.post('/api/login', async (req, res) => {
  const { personalNumber, email, password, name, phone } = req.body || {};
  let profile = null;

  if (personalNumber) {
    profile = await findProfileByPersonal(personalNumber);
  } else if (email) {
    profile = await findProfileByEmail(email);
  } else if (name && phone) {
    // try to find by name + phone
    if (useSupabase) {
      try {
        const { data, error } = await sb.from('profiles').select('*').ilike('name', String(name)).eq('phone', String(phone)).limit(1).maybeSingle();
        if (data) profile = mapSbProfileToResponse(data);
      } catch (e) { console.warn('sb find by name+phone error', e); }
    } else {
      const p = DB.profiles.find(x => String(x.name) === String(name) && String(x.phone) === String(phone));
      if (p) profile = { personalNumber: p.personalNumber, name: p.name, email: p.email, phone: p.phone, password: p.password, balance: Number(p.balance || 0), canEdit: !!p.canEdit };
    }
  }

  if (!profile) {
    // not found
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  // password check if set on record
  if (profile.password && profile.password.length > 0) {
    if (typeof password === 'undefined' || String(password) !== String(profile.password)) {
      return res.status(401).json({ ok: false, error: 'invalid_password' });
    }
  }

  // update last login
  try {
    if (useSupabase) {
      await sb.from('profiles').update({ last_login: new Date().toISOString() }).eq('personal_number', profile.personalNumber);
    } else {
      const p = DB.profiles.find(x => String(x.personalNumber) === String(profile.personalNumber));
      if (p) { p.lastLogin = new Date().toISOString(); saveData(DB); }
    }
  } catch (e) { console.warn('update last login failed', e); }

  // telegram notify (keeps original behaviour)
  (async () => {
    try {
      const text = `تسجيل دخول:\nالاسم: ${profile.name || 'غير معروف'}\nالرقم الشخصي: ${profile.personalNumber}\nالهاتف: ${profile.phone || 'لا يوجد'}\nالبريد: ${profile.email || 'لا يوجد'}\nالوقت: ${new Date().toISOString()}`;
      await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
      });
    } catch (e) { /* ignore */ }
  })();

  return res.json({ ok: true, profile });
});

// ------- notifications: returns profile + offers + orders + charges + notifications -------
app.get('/api/notifications/:personal', async (req, res) => {
  const personal = req.params.personal;
  const prof = await findProfileByPersonal(personal);
  if (!prof) return res.json({ ok: false, error: 'not found' });

  try {
    let visibleOffers = [];
    let userOrders = [];
    let userCharges = [];
    let userNotifications = [];

    if (useSupabase) {
      try {
        const { data: offersData } = await sb.from('offers').select('*');
        visibleOffers = (Array.isArray(offersData) ? offersData : []).filter(o => String(personal).length === 7); // keep same rule
      } catch (e) { console.warn('sb offers error', e); }

      try {
        const { data: ordersData } = await sb.from('orders').select('*').eq('personal_number', String(personal));
        userOrders = ordersData || [];
      } catch (e) { console.warn('sb orders error', e); }

      try {
        const { data: chargesData } = await sb.from('charges').select('*').eq('personal_number', String(personal));
        userCharges = chargesData || [];
      } catch (e) { console.warn('sb charges error', e); }

      try {
        const { data: nots } = await sb.from('notifications').select('*').eq('personal_number', String(personal));
        userNotifications = nots || [];
      } catch (e) { console.warn('sb notifications error', e); }

    } else {
      visibleOffers = DB.offers || [];
      userOrders = DB.orders.filter(o => String(o.personalNumber) === String(personal) || String(o.personalNumber) === String(personal));
      userCharges = DB.charges.filter(c => String(c.personalNumber) === String(personal));
      userNotifications = (DB.notifications || []).filter(n => String(n.personal) === String(personal));
    }

    return res.json({ ok: true, profile: prof, offers: visibleOffers, orders: userOrders, charges: userCharges, notifications: userNotifications, canEdit: !!prof.canEdit });
  } catch (e) {
    console.error('notifications endpoint error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// mark-read (body or param)
app.post('/api/notifications/mark-read/:personal?', async (req, res) => {
  const personal = req.body && req.body.personal ? String(req.body.personal) : (req.params.personal ? String(req.params.personal) : null);
  if (!personal) return res.status(400).json({ ok: false, error: 'missing personal' });

  try {
    if (useSupabase) {
      await sb.from('notifications').update({ read: true }).eq('personal_number', String(personal));
      // clear replied flags in orders/charges if desired
      await sb.from('orders').update({ replied: false }).eq('personal_number', String(personal)).is('replied', true);
      await sb.from('charges').update({ replied: false }).eq('personal_number', String(personal)).is('replied', true);
    } else {
      if (!DB.notifications) DB.notifications = [];
      DB.notifications.forEach(n => { if (String(n.personal) === String(personal)) n.read = true; });
      if (Array.isArray(DB.orders)) {
        DB.orders.forEach(o => { if (String(o.personalNumber) === String(personal) && o.replied) o.replied = false; });
      }
      if (Array.isArray(DB.charges)) {
        DB.charges.forEach(c => { if (String(c.personalNumber) === String(personal) && c.replied) c.replied = false; });
      }
      saveData(DB);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.warn('mark-read error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// clear notifications
app.post('/api/notifications/clear', async (req, res) => {
  const { personal } = req.body || {};
  if (!personal) return res.status(400).json({ ok: false, error: 'missing personal' });
  try {
    if (useSupabase) {
      // delete or set flag — here we delete matching notifications
      await sb.from('notifications').delete().eq('personal_number', String(personal));
    } else {
      DB.notifications = (DB.notifications || []).filter(n => String(n.personal) !== String(personal));
      saveData(DB);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.warn('clear notifications error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// The rest of original endpoints (help, orders, charge, offer ack) are kept and try to use supabase if available.
// For brevity I reuse most logic from original file but route to sb if present.

app.post('/api/help', async (req, res) => {
  const { personal, issue, fileLink, desc, name, email, phone } = req.body;
  const prof = await ensureProfile(personal);
  const text = `مشكلة من المستخدم:\nالاسم: ${name || prof.name || 'غير معروف'}\nالرقم الشخصي: ${personal}\nالهاتف: ${phone || prof.phone || 'لا يوجد'}\nالبريد: ${email || prof.email || 'لا يوجد'}\nالمشكلة: ${issue}\nالوصف: ${desc || ''}\nرابط الملف: ${fileLink || 'لا يوجد'}`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_HELP_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CFG.BOT_HELP_CHAT, text })
    });
    const data = await r.json().catch(() => null);
    return res.json({ ok: true, telegramResult: data });
  } catch (e) {
    console.warn('help send error', e);
    return res.json({ ok: false, error: e.message || String(e) });
  }
});

app.post('/api/orders', async (req, res) => {
  const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body;
  if (!personal || !type || !item) return res.status(400).json({ ok: false, error: 'missing fields' });
  const prof = await ensureProfile(personal);

  try {
    if (paidWithBalance) {
      const price = Number(paidAmount || 0);
      if (isNaN(price) || price <= 0) return res.status(400).json({ ok: false, error: 'invalid_paid_amount' });
      // check and deduct balance on sb or local
      if (useSupabase) {
        const { data: profileRow } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
        const bal = profileRow ? Number(profileRow.balance || 0) : 0;
        if (bal < price) return res.status(402).json({ ok: false, error: 'insufficient_balance' });
        await sb.from('profiles').update({ balance: bal - price }).eq('personal_number', String(personal));
        await sb.from('notifications').insert([{
          personal_number: String(personal),
          text: `تم خصم ${price.toLocaleString('en-US')} ل.س من رصيدك لطلب: ${item}`,
          read: false,
          created_at: new Date().toISOString()
        }]);
      } else {
        const p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
        if (p) {
          if (Number(p.balance || 0) < price) return res.status(402).json({ ok: false, error: 'insufficient_balance' });
          p.balance = Number(p.balance || 0) - price;
          if (!DB.notifications) DB.notifications = [];
          DB.notifications.unshift({
            id: String(Date.now()) + '-charge',
            personal: String(p.personalNumber),
            text: `تم خصم ${price.toLocaleString('en-US')} ل.س من رصيدك لطلب: ${item}`,
            read: false,
            createdAt: new Date().toISOString()
          });
          saveData(DB);
        }
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
      telegramMessageId: null,
      paidWithBalance: !!paidWithBalance,
      paidAmount: Number(paidAmount || 0),
      createdAt: new Date().toISOString()
    };

    if (useSupabase) {
      try {
        const sbRow = {
          id: orderId,
          personal_number: String(personal),
          phone: order.phone,
          type: order.type,
          item: order.item,
          id_field: order.idField || '',
          file_link: order.fileLink || '',
          cash_method: order.cashMethod || '',
          status: order.status,
          replied: order.replied,
          paid_with_balance: order.paidWithBalance,
          paid_amount: order.paidAmount,
          created_at: order.createdAt
        };
        const { data } = await sb.from('orders').insert([sbRow]).select().maybeSingle();
        // send telegram etc.
      } catch (e) { console.warn('sb insert order error', e); }
    } else {
      DB.orders.unshift(order);
      saveData(DB);
    }

    // send telegram notification to admin (kept behaviour)
    const text = `طلب شحن جديد:\n\nرقم شخصي: ${order.personalNumber}\nالهاتف: ${order.phone || 'لا يوجد'}\nالنوع: ${order.type}\nالتفاصيل: ${order.item}\nالايدي: ${order.idField || ''}\nطريقة الدفع: ${order.cashMethod || ''}\nرابط الملف: ${order.fileLink || ''}\nمعرف الطلب: ${order.id}`;
    try {
      await fetch(`https://api.telegram.org/bot${CFG.BOT_ORDER_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CFG.BOT_ORDER_CHAT, text })
      });
    } catch (e) { console.warn('send order failed', e); }

    return res.json({ ok: true, order });
  } catch (e) {
    console.error('create order error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// charge endpoint (طلب شحن رصيد)
app.post('/api/charge', async (req, res) => {
  const { personal, phone, amount, method, fileLink } = req.body;
  if (!personal || !amount) return res.status(400).json({ ok: false, error: 'missing fields' });
  const prof = await ensureProfile(personal);
  const chargeId = Date.now();
  const charge = {
    id: chargeId,
    personalNumber: String(personal),
    phone: phone || prof.phone || '',
    amount, method, fileLink: fileLink || '',
    status: 'قيد المراجعة',
    telegramMessageId: null,
    createdAt: new Date().toISOString()
  };

  if (useSupabase) {
    try {
      await sb.from('charges').insert([{
        id: chargeId,
        personal_number: String(personal),
        phone: charge.phone,
        amount: charge.amount,
        method: charge.method,
        file_link: charge.fileLink,
        status: charge.status,
        created_at: charge.createdAt
      }]);
    } catch (e) { console.warn('sb insert charge error', e); }
  } else {
    DB.charges.unshift(charge);
    saveData(DB);
  }

  const text = `طلب شحن رصيد:\n\nرقم شخصي: ${personal}\nالهاتف: ${charge.phone || 'لا يوجد'}\nالمبلغ: ${amount}\nطريقة الدفع: ${method}\nرابط الملف: ${fileLink || ''}\nمعرف الطلب: ${chargeId}`;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text })
    });
  } catch (e) { console.warn('send charge failed', e); }

  return res.json({ ok: true, charge });
});

// offer ack
app.post('/api/offer/ack', async (req, res) => {
  const { personal, offerId } = req.body;
  if (!personal || !offerId) return res.status(400).json({ ok: false, error: 'missing' });
  const prof = await ensureProfile(personal);
  const text = `لقد حصل على العرض او الهدية\nالرقم الشخصي: ${personal}\nالبريد: ${prof.email || 'لا يوجد'}\nالهاتف: ${prof.phone || 'لا يوجد'}\nالعرض: ${offerId}`;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.BOT_OFFERS_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CFG.BOT_OFFERS_CHAT, text })
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// server.js — Supabase-only backend (cleaned & deduplicated)
// Req: express, cors, node-fetch@2, multer, @supabase/supabase-js
// Usage: set SUPABASE_URL and SUPABASE_SERVICE_KEY and other BOT_* env vars.
// Run: node server.js

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // v2
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// ---------------- CONFIG ----------------
const CFG = {
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET || 'uploads',
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || '',
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || '',
  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || '',
  BOT_BALANCE_CHAT: process.env.BOT_BALANCE_CHAT || '',
  BOT_HELP_TOKEN: process.env.BOT_HELP_TOKEN || '',
  BOT_HELP_CHAT: process.env.BOT_HELP_CHAT || '',
  BOT_NOTIFY_TOKEN: process.env.BOT_NOTIFY_TOKEN || '',
  BOT_NOTIFY_CHAT: process.env.BOT_NOTIFY_CHAT || '',
  BOT_OFFERS_TOKEN: process.env.BOT_OFFERS_TOKEN || '',
  BOT_OFFERS_CHAT: process.env.BOT_OFFERS_CHAT || '',
  IMGBB_KEY: process.env.IMGBB_KEY || '',
  ADMIN_ALLOWED_USERS: (() => {
    try { return process.env.ADMIN_ALLOWED_USERS ? JSON.parse(process.env.ADMIN_ALLOWED_USERS) : []; } catch (e) { return []; }
  })()
};

// must have Supabase configured (per request)
if (!CFG.SUPABASE_URL || !CFG.SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment variables.');
  process.exit(1);
}

// ---------------- Supabase client ----------------
const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_SERVICE_KEY, { global: { fetch } });
console.log('Supabase client initialized.');

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
  for (let i = 0; i < 20; i++) {
    const n = String(Math.floor(1000000 + Math.random() * 9000000));
    try {
      const { data, error } = await sb.from('profiles').select('personal_number').eq('personal_number', n).limit(1).maybeSingle();
      if (error) {
        console.warn('genUniquePersonalNumber supabase select err', error);
        continue;
      }
      if (!data) return n;
    } catch (e) {
      console.warn('genUniquePersonalNumber exception', e);
    }
  }
  return String(Date.now()).slice(-9);
}

async function findProfileByPersonal(personal) {
  if (!personal) return null;
  try {
    const { data, error } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
    if (error) console.warn('findProfileByPersonal sb error', error);
    return data ? mapSbProfileToResponse(data) : null;
  } catch (e) {
    console.warn('findProfileByPersonal exception', e);
    return null;
  }
}

async function findProfileByIdentity({ name, email, phone }) {
  try {
    const q = sb.from('profiles').select('*').eq('name', String(name || '')).eq('email', String(email || '')).eq('phone', String(phone || '')).limit(1).maybeSingle();
    const { data, error } = await q;
    if (error) console.warn('findProfileByIdentity supabase err', error);
    return data ? mapSbProfileToResponse(data) : null;
  } catch (e) { console.warn('findProfileByIdentity supabase', e); return null; }
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

// ===== addBalanceToPersonal (Supabase-only) =====
async function addBalanceToPersonal(personal, amount) {
  try {
    if (!personal) return { ok: false, error: 'missing_personal' };
    const amt = Number(amount || 0);
    if (isNaN(amt) || amt <= 0) return { ok: false, error: 'invalid_amount' };

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
      return { ok: true, newBalance: Number(newProf ? newProf.balance || amt : amt) };
    }

    const oldBal = Number(profRow.balance || 0);
    const newBal = oldBal + amt;
    const { error: upErr } = await sb.from('profiles').update({ balance: newBal }).eq('personal_number', String(personal));
    if (upErr) console.warn('addBalance update err', upErr);

    await sb.from('notifications').insert([{ personal_number: String(personal), text: `تمت إضافة مبلغ ${amt} إلى رصيدك. الرصيد الجديد: ${newBal}`, read: false, created_at: new Date().toISOString() }]).catch(()=>{});
    return { ok: true, newBalance: newBal };
  } catch (e) {
    console.error('addBalanceToPersonal error', e);
    return { ok: false, error: String(e) };
  }
}

async function markLatestPendingChargeAsAccepted(personal, amount) {
  try {
    if (!personal) return { ok: false, error: 'missing_personal' };
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
  } catch (e) { console.error('markLatestPendingChargeAsAccepted error', e); return { ok: false, error: String(e) }; }
}

async function confirmChargeById(id) {
  try {
    if (!id) return { ok: false, error: 'missing_id' };
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
  } catch (e) { console.error('confirmChargeById error', e); return { ok: false, error: String(e) }; }
}

// ---------------- Upload endpoint (uploads to Supabase storage) ----------------
const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

app.post('/api/upload', uploadMemory.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });

    const bucket = CFG.SUPABASE_STORAGE_BUCKET;
    const filename = `${Date.now()}-${(req.file.originalname || 'file').replace(/\s+/g, '_')}`;
    const filePath = filename;

    // upload to supabase storage
    const { data: upData, error: upErr } = await sb.storage.from(bucket).upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (upErr) {
      console.warn('supabase storage upload err', upErr);
      return res.status(500).json({ ok: false, error: 'storage_upload_failed' });
    }

    // get public url
    const { data: pubData, error: pubErr } = await sb.storage.from(bucket).getPublicUrl(filePath);
    if (pubErr) {
      console.warn('supabase storage getPublicUrl err', pubErr);
      return res.json({ ok: true, url: '', provider: 'supabase' });
    }
    const url = (pubData && pubData.publicUrl) ? pubData.publicUrl : '';
    return res.json({ ok: true, url, provider: 'supabase' });
  } catch (e) {
    console.error('upload endpoint error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------------- Register ----------------
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

    const { data, error } = await sb.from('profiles').insert([newProfile]).select().maybeSingle();
    if (error) console.warn('register insert err', error);
    return res.json({ ok: true, profile: mapSbProfileToResponse(data || { personal_number: personalNumber, ...newProfile }) });
  } catch (e) {
    console.error('register error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --------------- Login ----------------
app.post('/api/login', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};
    if (!name || !email || !phone || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const profile = await findProfileByIdentity({ name, email, phone });
    if (!profile) return res.status(404).json({ ok: false, error: 'not_found' });
    if (profile.password && String(profile.password) !== String(password)) return res.status(401).json({ ok: false, error: 'wrong_password' });

    try {
      await sb.from('profiles').update({ last_login: new Date().toISOString() }).eq('personal_number', String(profile.personalNumber));
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

    const { data: nots } = await sb.from('notifications').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
    const { data: ords } = await sb.from('orders').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
    const { data: chs } = await sb.from('charges').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
    const { data: ofs } = await sb.from('offers').select('*').eq('active', true).order('created_at', { ascending: false }).limit(50);

    return res.json({ ok: true, profile, notifications: nots || [], orders: ords || [], charges: chs || [], offers: ofs || [] });
  } catch (e) {
    console.error('notifications endpoint error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// mark-read / clear
app.post('/api/notifications/mark-read', async (req, res) => {
  try {
    const { personal } = req.body || {};
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    await sb.from('notifications').update({ read: true }).eq('personal_number', String(personal));
    return res.json({ ok: true });
  } catch (e) { console.error('mark-read error', e); return res.status(500).json({ ok: false, error: String(e) }); }
});
app.post('/api/notifications/clear', async (req, res) => {
  try {
    const { personal } = req.body || {};
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    await sb.from('notifications').delete().eq('personal_number', String(personal));
    return res.json({ ok: true });
  } catch (e) { console.error('clear notifications error', e); return res.status(500).json({ ok: false, error: String(e) }); }
});

// --------------- Orders (deduct from balance server-side) ---------------
app.post('/api/orders', async (req, res) => {
  try {
    const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body || {};
    if (!personal || !type || !item) return res.status(400).json({ ok: false, error: 'missing_fields' });

    let profile = await findProfileByPersonal(personal);
    if (!profile) {
      // create profile stub
      await sb.from('profiles').insert([{ personal_number: String(personal), name: 'ضيف', email: '', password: '', phone: phone || '', balance: 0, can_edit: false, last_login: new Date().toISOString() }]).catch(()=>{});
      profile = await findProfileByPersonal(personal);
    }

    if (paidWithBalance) {
      const price = Number(paidAmount || 0);
      if (isNaN(price) || price <= 0) return res.status(400).json({ ok: false, error: 'invalid_paid_amount' });
      const { data: profRow } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      const bal = profRow ? Number(profRow.balance || 0) : 0;
      if (bal < price) return res.status(402).json({ ok: false, error: 'insufficient_balance' });
      const newBal = bal - price;
      await sb.from('profiles').update({ balance: newBal }).eq('personal_number', String(personal));
      await sb.from('notifications').insert([{ personal_number: String(personal), text: `تم خصم ${price} من رصيدك لطلب: ${item}`, read: false, created_at: new Date().toISOString() }]).catch(()=>{});
    }

    const orderId = String(Date.now());
    const orderRecord = {
      id: orderId,
      personal_number: String(personal),
      phone: phone || (profile && profile.phone) || '',
      type, item,
      id_field: idField || '',
      file_link: fileLink || '',
      cash_method: cashMethod || '',
      status: 'قيد المراجعة',
      replied: false,
      created_at: new Date().toISOString()
    };

    await sb.from('orders').insert([orderRecord]).catch(e => console.warn('orders insert err', e));

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

    await sb.from('charges').insert([chargeRecord]).catch(e => console.warn('charges insert err', e));

    const adminText = `طلب شحن جديد\nمعرف: ${chargeId}\nالرقم الشخصي: ${personal}\nالمبلغ: ${numericAmount}`;
    try { if (CFG.BOT_BALANCE_TOKEN && CFG.BOT_BALANCE_CHAT) await sendTelegramMessageToChat(CFG.BOT_BALANCE_CHAT, adminText, CFG.BOT_BALANCE_TOKEN); } catch (e) {}

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
        try { await sendTelegramMessageToChat(msg.chat.id, result.ok ? `تم اعتماد الشحنة #${id}` : `تعذّر اعتماد الشحنة #${id}: ${result.error||'خطأ'}`); } catch (e){}
        return res.sendStatus(200);
      }
    }

    // Parse amount & personal from message text or replied-to text
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
    await sb.from('orders').update({ status: 'تمت المعالجة', replied: true }).eq('id', id);
    const { data: ord } = await sb.from('orders').select('*').eq('id', id).limit(1).maybeSingle();
    if (ord) await sb.from('notifications').insert([{ personal_number: ord.personal_number, text: `طلبك #${id} تمّت معالجته.`, read: false, created_at: new Date().toISOString() }]).catch(()=>{});
    return res.json({ ok: true });
  } catch (e) { console.error('confirm order err', e); return res.status(500).json({ ok:false, error: String(e) }); }
});

// --------------- Help & profile editing & offers ---------------
app.post('/api/help', async (req, res) => {
  try {
    const { personal, issue, fileLink, desc, name, email, phone } = req.body || {};
    if (!personal || !issue) return res.status(400).json({ ok: false, error: 'missing_fields' });
    const rec = { personal_number: String(personal), issue: issue, text: desc || '', file_link: fileLink || '', name: name || '', email: email || '', phone: phone || '', created_at: new Date().toISOString() };
    await sb.from('help_requests').insert([rec]).catch(e=>console.warn('help insert err', e));
    // notify admin if configured
    try { if (CFG.BOT_HELP_TOKEN && CFG.BOT_HELP_CHAT) await sendTelegramMessageToChat(CFG.BOT_HELP_CHAT, `مشكلة جديدة من ${personal}: ${issue}\n${desc || ''}`, CFG.BOT_HELP_TOKEN); } catch(e){}
    return res.json({ ok: true });
  } catch (e) { console.error('help err', e); return res.status(500).json({ ok:false, error: String(e) }); }
});

app.post('/api/profile/request-edit', async (req, res) => {
  try {
    const { personal } = req.body || {};
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    await sb.from('profile_edit_requests').insert([{ personal_number: String(personal), status: 'pending', created_at: new Date().toISOString() }]).catch(e=>console.warn('profile edit request insert err', e));
    return res.json({ ok: true });
  } catch (e) { console.error('profile request err', e); return res.status(500).json({ ok:false, error: String(e) }); }
});

app.post('/api/profile/submit-edit', async (req, res) => {
  try {
    const { personal, name, email, password, phone } = req.body || {};
    if (!personal) return res.status(400).json({ ok: false, error: 'missing_personal' });
    const updates = {};
    if (typeof name !== 'undefined') updates.name = name;
    if (typeof email !== 'undefined') updates.email = email;
    if (typeof password !== 'undefined') updates.password = password;
    if (typeof phone !== 'undefined') updates.phone = phone;
    updates.can_edit = false;
    await sb.from('profiles').update(updates).eq('personal_number', String(personal));
    const { data } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
    return res.json({ ok: true, profile: mapSbProfileToResponse(data) });
  } catch (e) { console.error('profile submit-edit err', e); return res.status(500).json({ ok:false, error: String(e) }); }
});

app.post('/api/offer/ack', async (req, res) => {
  try {
    const { personal, offerId } = req.body || {};
    if (!personal || !offerId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    await sb.from('offers_ack').insert([{ personal_number: String(personal), offer_id: String(offerId), created_at: new Date().toISOString() }]).catch(()=>{});
    return res.json({ ok: true });
  } catch (e) { console.error('offer ack err', e); return res.status(500).json({ ok:false, error: String(e) }); }
});

// --------------- Simple health ----------------
app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString(), supabase: true }));

// --------------- Start ----------------
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
process.on('SIGINT', () => { console.log('SIGINT received, exiting'); process.exit(); });

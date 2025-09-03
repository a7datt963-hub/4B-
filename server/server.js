// server.js
// Supabase-backed server for the provided frontend.
// Exposes endpoints:
// /api/register
// /api/login
// /api/charge
// /api/orders
// /api/notifications/:personal
// /api/notifications/clear
// /api/notifications/mark-read
// /api/offer/ack
// /api/profile/request-edit
// /api/profile/submit-edit
// /api/help
// /api/upload
//
// Requires env:
// SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_KEY)
// BOT_ADMIN_CMD_TOKEN, BOT_ADMIN_CMD_CHAT
// BOT_BALANCE_TOKEN, BOT_BALANCE_CHAT
// BOT_HELP_TOKEN, BOT_HELP_CHAT
// BOT_LOGIN_REPORT_TOKEN, BOT_LOGIN_REPORT_CHAT
// BOT_NOTIFY_TOKEN, BOT_NOTIFY_CHAT
// BOT_OFFERS_TOKEN, BOT_OFFERS_CHAT
// BOT_ORDER_TOKEN, BOT_ORDER_CHAT
// IMGBB_KEY (optional client side)
// PORT

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
if(!SUPABASE_URL || !SUPABASE_KEY){
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment. Exiting.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CFG = {
  BOT_ADMIN_CMD_TOKEN: process.env.BOT_ADMIN_CMD_TOKEN || '',
  BOT_ADMIN_CMD_CHAT: process.env.BOT_ADMIN_CMD_CHAT || '',
  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || '',
  BOT_BALANCE_CHAT: process.env.BOT_BALANCE_CHAT || '',
  BOT_HELP_TOKEN: process.env.BOT_HELP_TOKEN || '',
  BOT_HELP_CHAT: process.env.BOT_HELP_CHAT || '',
  BOT_LOGIN_REPORT_TOKEN: process.env.BOT_LOGIN_REPORT_TOKEN || '',
  BOT_LOGIN_REPORT_CHAT: process.env.BOT_LOGIN_REPORT_CHAT || '',
  BOT_NOTIFY_TOKEN: process.env.BOT_NOTIFY_TOKEN || '',
  BOT_NOTIFY_CHAT: process.env.BOT_NOTIFY_CHAT || '',
  BOT_OFFERS_TOKEN: process.env.BOT_OFFERS_TOKEN || '',
  BOT_OFFERS_CHAT: process.env.BOT_OFFERS_CHAT || '',
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || '',
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || '',
  IMGBB_KEY: process.env.IMGBB_KEY || ''
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;

/* ---------------------------
   Helpers
   --------------------------- */
function sanitizeProfile(p){
  if(!p) return null;
  // remove sensitive fields before returning to client
  const out = { ...p };
  delete out.password;
  return out;
}

async function sendTelegram(botToken, chatId, text){
  if(!botToken || !chatId) return null;
  try{
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode:'HTML' })
    });
    return await r.json();
  }catch(e){
    console.warn('sendTelegram error', e?.message || e);
    return null;
  }
}

function nowIso(){ return (new Date()).toISOString(); }

/* ---------------------------
   Endpoints
   --------------------------- */

/** Register */
app.post('/api/register', async (req,res)=>{
  try{
    const { name, email, phone, password, personalNumber } = req.body || {};
    if(!name || !password) return res.status(400).json({ ok:false, error:'name and password required' });

    // check duplicates by email or phone
    if(email || phone){
      const orParts = [];
      if(email) orParts.push(`email.eq.${email}`);
      if(phone) orParts.push(`phone.eq.${phone}`);
      if(orParts.length){
        const { data:dup, error:dupErr } = await supabase.from('profiles').select('personal_number').or(orParts.join(',')).limit(1);
        if(dupErr) console.warn('dup check err', dupErr);
        if(dup && dup.length) return res.status(400).json({ ok:false, error:'user exists' });
      }
    }

    // ensure unique personal_number (try a few times)
    let personal = personalNumber || String(Math.floor(1000000 + Math.random()*9000000));
    for(let i=0;i<6;i++){
      const { data:ex, error } = await supabase.from('profiles').select('personal_number').eq('personal_number', personal).limit(1);
      if(error) { console.warn('personal check err', error); break; }
      if(!ex || !ex.length) break;
      personal = String(Math.floor(1000000 + Math.random()*9000000));
    }

    const profile = {
      personal_number: personal,
      name: name || '',
      email: email || '',
      phone: phone || '',
      password: String(password),
      balance: 0,
      can_edit: false,
      created_at: nowIso()
    };

    const { error } = await supabase.from('profiles').insert([profile]);
    if(error) {
      console.error('profiles.insert error', error);
      return res.status(500).json({ ok:false, error:'db error' });
    }

    // notify admin / login-report bot
    const text = `🆕 مستخدم جديد\nالاسم: ${profile.name}\nالرقم الشخصي: ${profile.personal_number}\nالبريد: ${profile.email || '-'}\nالهاتف: ${profile.phone || '-'}`;
    await sendTelegram(CFG.BOT_LOGIN_REPORT_TOKEN, CFG.BOT_LOGIN_REPORT_CHAT, text);

    return res.json({ ok:true, profile: sanitizeProfile(profile) });
  }catch(e){
    console.error('register', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Login */
app.post('/api/login', async (req,res)=>{
  try{
    const { personalNumber, email, phone, password } = req.body||{};
    if(!password) return res.status(400).json({ ok:false, error:'password required' });

    let query = supabase.from('profiles').select('*').limit(1);
    if(personalNumber) query = query.eq('personal_number', personalNumber);
    else if(email) query = query.eq('email', email);
    else if(phone) query = query.eq('phone', phone);
    else return res.status(400).json({ ok:false, error:'identifier required' });

    const { data, error } = await query;
    if(error){ console.error('login query err', error); return res.status(500).json({ ok:false, error:'db error' }); }
    if(!data || !data.length) return res.status(404).json({ ok:false, error:'not found' });

    const prof = data[0];
    if(String(prof.password) !== String(password)) return res.status(401).json({ ok:false, error:'wrong password' });

    // report login to bot (optional)
    const text = `🔐 تسجيل دخول\nالاسم: ${prof.name}\nالرقم الشخصي: ${prof.personal_number}`;
    await sendTelegram(CFG.BOT_LOGIN_REPORT_TOKEN, CFG.BOT_LOGIN_REPORT_CHAT, text);

    return res.json({ ok:true, profile: sanitizeProfile(prof) });
  }catch(e){
    console.error('login', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Create charge (شحن) */
app.post('/api/charge', async (req,res)=>{
  try{
    const { personalNumber, personal, phone, amount, method, fileLink } = req.body || {};
    const pn = personalNumber || personal;
    if(!pn || !amount) return res.status(400).json({ ok:false, error:'required' });

    const { data:profiles } = await supabase.from('profiles').select('*').eq('personal_number', pn).limit(1);
    if(!profiles || !profiles.length) return res.status(404).json({ ok:false, error:'profile not found' });
    const prof = profiles[0];

    const charge = {
      id: Date.now(),
      personal_number: pn,
      phone: phone || prof.phone || '',
      amount: Number(amount),
      method: method || '',
      file_link: fileLink || '',
      status: 'pending',
      replied: false,
      telegram_message_id: null,
      credited_amount: null,
      created_at: nowIso()
    };

    const { error } = await supabase.from('charges').insert([charge]);
    if(error){ console.error('insert charge', error); return res.status(500).json({ ok:false, error:'db error' }); }

    // notify balance bot
    const text = `💰 طلب شحن جديد\nالمستخدم: ${pn}\nالاسم: ${prof.name || '-'}\nالمبلغ: ${charge.amount}\nالطريقة: ${charge.method || '-'}\nالرابط: ${charge.file_link || '-'}`;
    await sendTelegram(CFG.BOT_BALANCE_TOKEN, CFG.BOT_BALANCE_CHAT, text);

    return res.json({ ok:true, charge });
  }catch(e){
    console.error('charge', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Create order */
app.post('/api/orders', async (req,res)=>{
  try{
    const body = req.body || {};
    const pn = body.personalNumber || body.personal || body.personal_number;
    if(!pn) return res.status(400).json({ ok:false, error:'personal required' });

    // fetch profile
    const { data:profiles } = await supabase.from('profiles').select('*').eq('personal_number', pn).limit(1);
    if(!profiles || !profiles.length) return res.status(404).json({ ok:false, error:'profile not found' });
    const prof = profiles[0];

    // optional paidWithBalance logic
    const paidWithBalance = !!(body.paidWithBalance || body.paid_with_balance);
    const paidAmount = Number(body.paidAmount || body.paid_amount || 0);

    // if paying from balance, check and deduct
    if(paidWithBalance && paidAmount > 0){
      const currentBal = Number(prof.balance || 0);
      if(currentBal < paidAmount) return res.status(400).json({ ok:false, error: 'insufficient_balance' });
      // update balance
      const { error:updErr } = await supabase.from('profiles').update({ balance: currentBal - paidAmount }).eq('personal_number', pn);
      if(updErr){ console.error('balance update err', updErr); /* proceed but warn */ }
    }

    const order = {
      id: Date.now(),
      personal_number: pn,
      phone: body.phone || prof.phone || '',
      type: body.type || body.type || 'unknown',
      item: body.item || '',
      id_field: body.idField || body.id_field || '',
      file_link: body.fileLink || body.file_link || '',
      cash_method: body.cashMethod || body.cash_method || '',
      status: 'pending',
      replied: false,
      telegram_message_id: null,
      paid_with_balance: paidWithBalance,
      paid_amount: paidAmount || 0,
      created_at: nowIso()
    };

    const { error } = await supabase.from('orders').insert([order]);
    if(error){ console.error('insert order', error); return res.status(500).json({ ok:false, error:'db error' }); }

    // notify order bot
    const text = `🛒 طلب جديد\nالرقم الشخصي: ${pn}\nالنوع: ${order.type}\nالبند: ${order.item}\nالايدي: ${order.id_field}\nمدفوع من الرصيد: ${order.paid_with_balance ? order.paid_amount : 'لا'}`;
    await sendTelegram(CFG.BOT_ORDER_TOKEN, CFG.BOT_ORDER_CHAT, text);

    return res.json({ ok:true, order });
  }catch(e){
    console.error('orders', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Notifications + dashboard data */
app.get('/api/notifications/:personal', async (req,res) => {
  try{
    const personal = req.params.personal;
    if(!personal) return res.status(400).json({ ok:false, error:'personal required' });

    // profile
    const { data:profiles } = await supabase.from('profiles').select('*').eq('personal_number', personal).limit(1);
    const profile = (profiles && profiles[0]) ? profiles[0] : null;

    // orders / charges / notifications / offers
    const { data:orders } = await supabase.from('orders').select('*').eq('personal_number', personal).order('created_at', { ascending:false }).limit(200);
    const { data:charges } = await supabase.from('charges').select('*').eq('personal_number', personal).order('created_at', { ascending:false }).limit(200);
    const { data:notifications } = await supabase.from('notifications').select('*').eq('personal_number', personal).order('created_at', { ascending:false }).limit(200);
    const { data:offers } = await supabase.from('offers').select('*').or(`personal_number.eq.${personal},personal_number.is.null`).order('created_at', { ascending:false }).limit(50);

    return res.json({
      ok:true,
      profile: profile ? sanitizeProfile(profile) : null,
      orders: orders || [],
      charges: charges || [],
      notifications: notifications || [],
      offers: offers || []
    });
  }catch(e){
    console.error('notifications endpoint', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Clear notifications for personal (set read = true) */
app.post('/api/notifications/clear', async (req,res) => {
  try{
    const { personal, personalNumber } = req.body || {};
    const pn = personal || personalNumber;
    if(!pn) return res.status(400).json({ ok:false, error:'personal required' });
    const { error } = await supabase.from('notifications').update({ read: true }).eq('personal_number', pn);
    if(error){ console.error('clear notifs err', error); return res.status(500).json({ ok:false, error:'db error' }); }
    return res.json({ ok:true });
  }catch(e){
    console.error('clear notifications', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Mark notifications read */
app.post('/api/notifications/mark-read', async (req,res) => {
  try{
    const { personal, personalNumber } = req.body || {};
    const pn = personal || personalNumber;
    if(!pn) return res.status(400).json({ ok:false, error:'personal required' });
    const { error } = await supabase.from('notifications').update({ read: true }).eq('personal_number', pn);
    if(error){ console.error('mark-read err', error); return res.status(500).json({ ok:false, error:'db error' }); }
    return res.json({ ok:true });
  }catch(e){
    console.error('mark-read', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Offer ack */
app.post('/api/offer/ack', async (req,res) => {
  try{
    const { personal, personalNumber, offerId } = req.body || {};
    const pn = personal || personalNumber;
    if(!offerId || !pn) return res.status(400).json({ ok:false, error:'required' });
    const { error } = await supabase.from('offers').update({ acknowledged:true }).eq('id', offerId).eq('personal_number', pn);
    if(error){ console.error('ack offer err', error); return res.status(500).json({ ok:false, error:'db error' }); }
    // notify offers bot (optional)
    await sendTelegram(CFG.BOT_OFFERS_TOKEN, CFG.BOT_OFFERS_CHAT, `✅ تم تأكيد عرض ${offerId} من ${pn}`);
    return res.json({ ok:true });
  }catch(e){
    console.error('offer ack', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Profile edit request */
app.post('/api/profile/request-edit', async (req,res) => {
  try{
    const { personal, personalNumber } = req.body || {};
    const pn = personal || personalNumber;
    if(!pn) return res.status(400).json({ ok:false, error:'required' });
    const id = `req-${Date.now()}`;
    const { error } = await supabase.from('edit_requests').insert([{ id, personal_number: pn, processed:false, created_at: nowIso() }]);
    if(error){ console.error('insert edit_requests', error); return res.status(500).json({ ok:false, error:'db error' }); }
    await sendTelegram(CFG.BOT_ADMIN_CMD_TOKEN, CFG.BOT_ADMIN_CMD_CHAT, `✉️ طلب تعديل بيانات: ${pn}`);
    return res.json({ ok:true });
  }catch(e){
    console.error('profile request edit', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Profile submit edit (admin-reviewed or immediate if can_edit true) */
app.post('/api/profile/submit-edit', async (req,res) => {
  try{
    const { personal, personalNumber, name, email, password, phone } = req.body || {};
    const pn = personal || personalNumber;
    if(!pn) return res.status(400).json({ ok:false, error:'required' });

    const { data:profiles } = await supabase.from('profiles').select('*').eq('personal_number', pn).limit(1);
    if(!profiles || !profiles.length) return res.status(404).json({ ok:false, error:'profile not found' });
    const prof = profiles[0];

    // if can_edit true -> update immediately, else create edit_requests
    if(prof.can_edit){
      const updates = {};
      if(name) updates.name = name;
      if(email) updates.email = email;
      if(typeof password !== 'undefined' && password !== null) updates.password = String(password);
      if(phone) updates.phone = phone;
      const { error } = await supabase.from('profiles').update(updates).eq('personal_number', pn);
      if(error){ console.error('profile update err', error); return res.status(500).json({ ok:false, error:'db error' }); }
      const { data } = await supabase.from('profiles').select('*').eq('personal_number', pn).limit(1);
      return res.json({ ok:true, profile: sanitizeProfile(data && data[0] ? data[0] : null) });
    } else {
      const id = `edit-${Date.now()}`;
      const { error } = await supabase.from('edit_requests').insert([{ id, personal_number: pn, name, email, phone, processed:false, created_at: nowIso() }]);
      if(error){ console.error('insert edit request err', error); return res.status(500).json({ ok:false, error:'db error' }); }
      await sendTelegram(CFG.BOT_ADMIN_CMD_TOKEN, CFG.BOT_ADMIN_CMD_CHAT, `✉️ طلب تعديل (مستخدم طلب تعديلات) ${pn}\nالاسم:${name||'-'}\nالبريد:${email||'-'}\nالهاتف:${phone||'-'}`);
      return res.json({ ok:true });
    }
  }catch(e){
    console.error('submit-edit', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Help endpoint (sends to help bot and stores minimal record as notification) */
app.post('/api/help', async (req,res) => {
  try{
    const { personal, personalNumber, issue, fileLink, desc, name, email, phone } = req.body || {};
    const pn = personal || personalNumber;
    if(!pn || !issue) return res.status(400).json({ ok:false, error:'required' });

    // record small notification
    const nid = `help-${Date.now()}`;
    const { error:insErr } = await supabase.from('notifications').insert([{ id: nid, personal_number: pn, text: `مشكلة: ${issue} - ${desc || '-'}`, created_at: nowIso() }]);
    if(insErr) console.warn('help -> notifications insert err', insErr);

    const txt = `🆘 مساعدة جديدة\nالرقم الشخصي: ${pn}\nالاسم: ${name||'-'}\nالمشكلة: ${issue}\nالوصف: ${desc || '-'}\nالملف: ${fileLink || '-'}`;
    await sendTelegram(CFG.BOT_HELP_TOKEN, CFG.BOT_HELP_CHAT, txt);

    return res.json({ ok:true });
  }catch(e){
    console.error('help', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/** Upload endpoint -> upload file to supabase storage (bucket: 'uploads') */
/** NOTE: create a public bucket named 'uploads' in your Supabase project or adjust bucket name below */
app.post('/api/upload', upload.single('file'), async (req,res) => {
  try{
    if(!req.file) return res.status(400).json({ ok:false, error:'no file' });
    const file = req.file;
    const bucket = 'uploads';
    const filename = `${Date.now()}_${file.originalname.replace(/\s+/g,'_')}`;
    const path = filename;

    // upload buffer
    const { data, error } = await supabase.storage.from(bucket).upload(path, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });
    if(error){
      console.error('supabase upload err', error);
      return res.status(500).json({ ok:false, error:'upload error' });
    }

    // get public url
    const { data:pub } = await supabase.storage.from(bucket).getPublicUrl(path);
    const publicURL = (pub && pub.publicUrl) ? pub.publicUrl : (pub && pub.publicURL) ? pub.publicURL : null;
    if(!publicURL){
      // alternate attempt (older libs)
      return res.json({ ok:true, url: `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(path)}` });
    }
    return res.json({ ok:true, url: publicURL });
  }catch(e){
    console.error('upload', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

/* ---------------------------
   Start server
   --------------------------- */
app.listen(PORT, ()=> console.log(`Server running on port ${PORT}`));

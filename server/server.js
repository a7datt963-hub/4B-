// server.js
// Supabase-backed server for the provided frontend
// Expects env:
// SUPABASE_URL
// SUPABASE_SERVICE_KEY (or SUPABASE_KEY)
// BOT_ADMIN_CMD_TOKEN, BOT_ADMIN_CMD_CHAT (optional)
// BOT_NOTIFY_TOKEN, BOT_NOTIFY_CHAT (optional)
// IMGBB_KEY (optional) - used client-side too
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
  BOT_POLL_TOKEN: process.env.BOT_POLL_TOKEN || '',
  BOT_NOTIFY_TOKEN: process.env.BOT_NOTIFY_TOKEN || '',
  BOT_NOTIFY_CHAT: process.env.BOT_NOTIFY_CHAT || '',
  IMGBB_KEY: process.env.IMGBB_KEY || ''
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;

/* ---------------------------
   Helpers
   --------------------------- */
function sanitizeProfile(p){
  if(!p) return null;
  const c = { ...p };
  if(c.password) delete c.password;
  return c;
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

/* ---------------------------
   ENDPOINTS
   --------------------------- */

/** Register */
app.post('/api/register', async (req,res)=>{
  try{
    const { name, email, phone, password, personalNumber } = req.body||{};
    if(!name || !password) return res.status(400).json({ok:false,error:'name and password required'});

    // check duplicates by email or phone if provided
    if(email || phone){
      const orParts = [];
      if(email) orParts.push(`email.eq.${email}`);
      if(phone) orParts.push(`phone.eq.${phone}`);
      if(orParts.length){
        const { data:dup, error:dupErr } = await supabase.from('profiles').select('personal_number').or(orParts.join(',')).limit(1);
        if(dupErr) console.warn('dup check err', dupErr);
        if(dup && dup.length) return res.status(400).json({ok:false,error:'user exists'});
      }
    }

    // ensure unique personal_number (try a few times)
    let personal = personalNumber && String(personalNumber).trim() ? String(personalNumber).trim() : String(Math.floor(1000000+Math.random()*9000000));
    for(let i=0;i<6;i++){
      const { data:ex, error:exErr } = await supabase.from('profiles').select('personal_number').eq('personal_number', personal).limit(1);
      if(exErr) { console.warn('check personal err', exErr); break; }
      if(!ex || !ex.length) break;
      personal = String(Math.floor(1000000+Math.random()*9000000));
    }

    const profile = {
      personal_number: personal,
      name: name || '',
      email: email || '',
      phone: phone || '',
      password: String(password),
      balance: 0,
      can_edit: false,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from('profiles').insert([profile]);
    if(error) {
      console.error('insert profile error', error);
      return res.status(500).json({ok:false,error:'db error', details: error});
    }

    return res.json({ok:true, profile: sanitizeProfile(profile)});
  }catch(e){
    console.error('register err', e);
    res.status(500).json({ok:false,error:'server error'});
  }
});

/** Login */
app.post('/api/login', async (req,res)=>{
  try{
    const { personalNumber, email, phone, password } = req.body||{};
    if(!password) return res.status(400).json({ok:false,error:'password required'});

    let query = supabase.from('profiles').select('*').limit(1);
    if(personalNumber) query = query.eq('personal_number', personalNumber);
    else if(email) query = query.eq('email', email);
    else if(phone) query = query.eq('phone', phone);
    else return res.status(400).json({ok:false,error:'identifier required'});

    const { data, error } = await query;
    if(error) { console.error('login query err', error); return res.status(500).json({ok:false,error:'db error'}); }
    if(!data || !data.length) return res.status(404).json({ok:false,error:'not found'});
    const prof = data[0];
    if(String(prof.password)!==String(password)) return res.status(401).json({ok:false,error:'wrong password'});

    return res.json({ok:true, profile: sanitizeProfile(prof)});
  }catch(e){
    console.error('login err', e);
    res.status(500).json({ok:false,error:'server error'});
  }
});

/** Upload file -> Supabase Storage (bucket 'uploads' should exist and be public if you want direct public URL) */
app.post('/api/upload', upload.single('file'), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({ok:false, error:'no_file'});
    const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g,'_')}`;
    const bucket = 'uploads';

    // upload binary buffer
    const { data:uploadData, error:uploadErr } = await supabase.storage.from(bucket).upload(fileName, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });
    if(uploadErr){
      console.error('storage.upload err', uploadErr);
      return res.status(500).json({ok:false, error:'upload_failed', details: uploadErr});
    }

    // compute public URL (works if bucket is public)
    const publicURL = `${SUPABASE_URL.replace(/\/$/,'')}/storage/v1/object/public/${bucket}/${encodeURIComponent(fileName)}`;

    return res.json({ok:true, url: publicURL});
  }catch(e){
    console.error('upload err', e);
    return res.status(500).json({ok:false,error:'server'});
  }
});

/** Create charge */
app.post('/api/charge', async (req,res)=>{
  try{
    const { personalNumber, phone, amount, method, fileLink } = req.body||{};
    if(!personalNumber || !amount) return res.status(400).json({ok:false,error:'required'});
    const { data:profiles, error:pErr } = await supabase.from('profiles').select('*').eq('personal_number', personalNumber).limit(1);
    if(pErr){ console.error('profile fetch err', pErr); return res.status(500).json({ok:false,error:'db error'}); }
    if(!profiles || !profiles.length) return res.status(404).json({ok:false,error:'profile not found'});
    const prof = profiles[0];

    const charge = {
      id: Date.now(),
      personal_number: personalNumber,
      phone: phone || prof.phone || '',
      amount: Number(amount),
      method: method || '',
      file_link: fileLink || '',
      status: 'pending',
      replied: false,
      telegram_message_id: null,
      credited_amount: null,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from('charges').insert([charge]);
    if(error) {
      console.error('insert charge err', error);
      return res.status(500).json({ok:false,error:'db error'});
    }

    // optionally notify admins
    if(CFG.BOT_ADMIN_CMD_TOKEN && CFG.BOT_ADMIN_CMD_CHAT){
      const txt = `طلب شحن جديد\nرقم: <b>${personalNumber}</b>\nالمبلغ: <b>${charge.amount}</b>\nالطريقة: ${charge.method}`;
      sendTelegram(CFG.BOT_ADMIN_CMD_TOKEN, CFG.BOT_ADMIN_CMD_CHAT, txt);
    }

    return res.json({ok:true, charge});
  }catch(e){
    console.error('charge err', e);
    res.status(500).json({ok:false,error:'server error'});
  }
});

/** Create order */
app.post('/api/orders', async (req,res)=>{
  try{
    const body = req.body || {};
    const personal = body.personalNumber || body.personal || body.personal_number;
    if(!personal) return res.status(400).json({ok:false,error:'personal required'});

    const id = Date.now();
    const order = {
      id,
      personal_number: personal,
      phone: body.phone || '',
      type: body.type || '',
      item: body.item || '',
      id_field: body.idField || body.id_field || '',
      file_link: body.fileLink || body.file_link || '',
      cash_method: body.cashMethod || body.cash_method || '',
      status: 'pending',
      replied: false,
      telegram_message_id: null,
      paid_with_balance: !!(body.paidWithBalance || body.paid_with_balance),
      paid_amount: Number(body.paidAmount || body.paid_amount || 0),
      created_at: new Date().toISOString()
    };

    // if paying from balance -> deduct
    if(order.paid_with_balance && order.paid_amount > 0){
      const { data:profiles, error:pfErr } = await supabase.from('profiles').select('*').eq('personal_number', personal).limit(1);
      if(pfErr){ console.error('profile fetch err', pfErr); return res.status(500).json({ok:false,error:'db error'}); }
      if(!profiles || !profiles.length) return res.status(404).json({ok:false,error:'profile not found'});
      const prof = profiles[0];
      const bal = Number(prof.balance || 0);
      if(bal < order.paid_amount) return res.status(400).json({ok:false,error:'insufficient_balance'});
      // update balance
      const { error:updateErr } = await supabase.from('profiles').update({ balance: bal - order.paid_amount }).eq('personal_number', personal);
      if(updateErr) console.warn('balance update warn', updateErr);
    }

    const { error } = await supabase.from('orders').insert([order]);
    if(error) {
      console.error('insert order err', error);
      return res.status(500).json({ok:false,error:'db_error', details: error});
    }

    // optional admin notify
    if(CFG.BOT_ADMIN_CMD_TOKEN && CFG.BOT_ADMIN_CMD_CHAT){
      const txt = `طلب جديد\nرقم: <b>${personal}</b>\nنوع: <b>${order.type}</b>\nالبند: ${order.item}`;
      sendTelegram(CFG.BOT_ADMIN_CMD_TOKEN, CFG.BOT_ADMIN_CMD_CHAT, txt);
    }

    return res.json({ok:true, order});
  }catch(e){
    console.error('orders err', e);
    res.status(500).json({ok:false,error:'server'});
  }
});

/** Get dashboard / notifications for a personal number */
app.get('/api/notifications/:personal', async (req,res)=>{
  try{
    const personal = req.params.personal;
    if(!personal) return res.status(400).json({ok:false,error:'personal required'});

    const [
      { data:profiles, error:profErr },
      { data:orders, error:ordersErr },
      { data:charges, error:chargesErr },
      { data:notifications, error:notifsErr },
      { data:offers, error:offersErr }
    ] = await Promise.all([
      supabase.from('profiles').select('*').eq('personal_number', personal).limit(1),
      supabase.from('orders').select('*').eq('personal_number', personal).order('created_at', { ascending: false }).limit(200),
      supabase.from('charges').select('*').eq('personal_number', personal).order('created_at', { ascending: false }).limit(200),
      supabase.from('notifications').select('*').eq('personal_number', personal).order('created_at', { ascending: false }).limit(200),
      supabase.from('offers').select('*').or(`personal_number.eq.${personal},personal_number.is.null`).order('created_at',{ascending:false}).limit(200)
    ]);

    if(profErr) console.warn('profile fetch warn', profErr);
    if(ordersErr) console.warn('orders fetch warn', ordersErr);
    if(chargesErr) console.warn('charges fetch warn', chargesErr);
    if(notifsErr) console.warn('notifs fetch warn', notifsErr);
    if(offersErr) console.warn('offers fetch warn', offersErr);

    const profile = (profiles && profiles.length) ? profiles[0] : null;

    return res.json({ ok:true, profile, orders: orders || [], charges: charges || [], notifications: notifications || [], offers: offers || [] });
  }catch(e){
    console.error('notifications err', e);
    return res.status(500).json({ok:false,error:'server'});
  }
});

/** notifications clear (mark read) */
app.post('/api/notifications/clear', async (req,res)=>{
  try{
    const personal = req.body.personalNumber || req.body.personal;
    if(!personal) return res.status(400).json({ok:false,error:'personal'});
    const { error } = await supabase.from('notifications').update({ read: true }).eq('personal_number', personal);
    if(error) { console.error('clear notifs err', error); return res.status(500).json({ok:false,error:'db'}); }
    return res.json({ok:true});
  }catch(e){ console.error(e); return res.status(500).json({ok:false,error:'server'}); }
});

/** mark-read endpoint (compat) */
app.post('/api/notifications/mark-read', async (req,res)=>{
  try{
    const personal = req.body.personalNumber || req.body.personal;
    if(!personal) return res.status(400).json({ok:false,error:'personal'});
    const { error } = await supabase.from('notifications').update({ read: true }).eq('personal_number', personal);
    if(error) { console.error('mark-read err', error); return res.status(500).json({ok:false,error:'db'}); }
    return res.json({ok:true});
  }catch(e){ console.error(e); return res.status(500).json({ok:false,error:'server'}); }
});

/** request edit -> insert into edit_requests */
app.post('/api/profile/request-edit', async (req,res)=>{
  try{
    const personal = req.body.personal || req.body.personalNumber;
    if(!personal) return res.status(400).json({ok:false,error:'personal'});
    const id = String(Date.now());
    const rec = {
      id,
      personal_number: personal,
      name: req.body.name || null,
      email: req.body.email || null,
      phone: req.body.phone || null,
      processed: false,
      created_at: new Date().toISOString()
    };
    const { error } = await supabase.from('edit_requests').insert([rec]);
    if(error){ console.error('request-edit insert err', error); return res.status(500).json({ok:false,error:'db'}); }

    if(CFG.BOT_ADMIN_CMD_TOKEN && CFG.BOT_ADMIN_CMD_CHAT){
      const txt = `طلب تعديل بيانات من: ${personal}`;
      sendTelegram(CFG.BOT_ADMIN_CMD_TOKEN, CFG.BOT_ADMIN_CMD_CHAT, txt);
    }

    return res.json({ok:true});
  }catch(e){ console.error(e); return res.status(500).json({ok:false,error:'server'}); }
});

/** submit edit -> update profiles */
app.post('/api/profile/submit-edit', async (req,res)=>{
  try{
    const personal = req.body.personal || req.body.personalNumber;
    if(!personal) return res.status(400).json({ok:false,error:'personal'});
    const upd = {};
    if(req.body.name) upd.name = req.body.name;
    if(req.body.email) upd.email = req.body.email;
    if(req.body.password) upd.password = req.body.password;
    if(req.body.phone) upd.phone = req.body.phone;
    // set can_edit false after submit
    upd.can_edit = false;

    const { error } = await supabase.from('profiles').update(upd).eq('personal_number', personal);
    if(error){ console.error('submit-edit update err', error); return res.status(500).json({ok:false,error:'db'}); }

    const { data:profiles } = await supabase.from('profiles').select('*').eq('personal_number', personal).limit(1);
    return res.json({ok:true, profile: (profiles && profiles[0]) ? profiles[0] : null});
  }catch(e){ console.error(e); return res.status(500).json({ok:false,error:'server'}); }
});

/** help endpoint (stores as edit_request for admin review and optionally notifies) */
app.post('/api/help', async (req,res)=>{
  try{
    const personal = req.body.personal || req.body.personalNumber;
    const id = String(Date.now());
    const rec = {
      id,
      personal_number: personal || null,
      name: req.body.name || null,
      email: req.body.email || null,
      phone: req.body.phone || null,
      processed: false,
      created_at: new Date().toISOString()
    };
    const { error } = await supabase.from('edit_requests').insert([rec]);
    if(error){ console.error('help insert err', error); return res.status(500).json({ok:false,error:'db'}); }

    // notify admin with details
    if(CFG.BOT_ADMIN_CMD_TOKEN && CFG.BOT_ADMIN_CMD_CHAT){
      const txt = `مشكلة جديدة\nمن: ${personal || 'غير معروف'}\nالمشكلة: ${req.body.issue || ''}\nالوصف: ${req.body.desc || ''}`;
      sendTelegram(CFG.BOT_ADMIN_CMD_TOKEN, CFG.BOT_ADMIN_CMD_CHAT, txt);
    }

    return res.json({ok:true});
  }catch(e){ console.error(e); return res.status(500).json({ok:false,error:'server'}); }
});

/** offer ack */
app.post('/api/offer/ack', async (req,res)=>{
  try{
    const id = req.body.offerId || req.body.offer_id;
    if(!id) return res.status(400).json({ok:false,error:'offer id'});
    const { error } = await supabase.from('offers').update({ acknowledged: true }).eq('id', id);
    if(error){ console.error('offer ack err', error); return res.status(500).json({ok:false,error:'db'}); }
    return res.json({ok:true});
  }catch(e){ console.error(e); return res.status(500).json({ok:false,error:'server'}); }
});

/* ---------------------------
   Server start
   --------------------------- */
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));

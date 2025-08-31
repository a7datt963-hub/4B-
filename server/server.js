/**
 * server/server.js
 * نسخة معدّلة: توحيد login/register مع Supabase عند التهيئة، والحفاظ على باقي السلوك كما هو.
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

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

// ======= Supabase + bcrypt additions =======
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
const useSupabase = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE);

let supabase = null;
if(useSupabase){
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
  console.log('Supabase enabled');
}

// helper: find profile by email + phone in Supabase
async function sbFindProfileByEmailPhone(email, phone){
  if(!useSupabase) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', String(email))
    .eq('phone', String(phone))
    .maybeSingle();
  if(error){ console.warn('Supabase find error', error); return null; }
  return data || null;
}

// helper: increase balance by email+phone (returns {ok:true, profile})
async function sbIncreaseBalanceByEmailPhone(email, phone, amount){
  if(!useSupabase) return { ok:false, error:'no_supabase' };
  try{
    const { data: prof, error: fetchErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', String(email))
      .eq('phone', String(phone))
      .maybeSingle();
    if(fetchErr) return { ok:false, error: fetchErr.message || 'fetch_error' };
    if(!prof) return { ok:false, error:'not_found' };
    const newBal = Number(prof.balance || 0) + Number(amount || 0);
    const { data, error } = await supabase.from('profiles').update({ balance: newBal, updated_at: new Date().toISOString() }).eq('id', prof.id).select().single();
    if(error) return { ok:false, error: error.message || 'update_error' };
    return { ok:true, profile: data };
  }catch(e){
    console.warn('sbIncreaseBalance error', e);
    return { ok:false, error: String(e) };
  }
}

// helper: try deduct using RPC deduct_balance_for_account
async function sbTryDeduct(email, phone, amount){
  if(!useSupabase) return { ok:false, error:'no_supabase' };
  try{
    const { data, error } = await supabase.rpc('deduct_balance_for_account', { p_email: String(email), p_phone: String(phone), p_amount: Number(amount) });
    if(error) return { ok:false, error: error.message || 'rpc_error' };
    if(!data || data.length === 0) return { ok:false, error:'insufficient_or_not_found' };
    return { ok:true, result: data[0] };
  }catch(e){
    console.warn('sbTryDeduct error', e);
    return { ok:false, error: String(e) };
  }
}
// ======= End Supabase additions =======

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData(){
  try{
    if(!fs.existsSync(DATA_FILE)){
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
    const raw = fs.readFileSync(DATA_FILE,'utf8');
    return JSON.parse(raw || '{}');
  }catch(e){
    console.error('loadData error', e);
    return { profiles:[], orders:[], charges:[], offers:[], notifications:[], profileEditRequests:{}, blocked:[], tgOffsets:{} };
  }
}
function saveData(d){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }catch(e){ console.error('saveData error', e); } }
let DB = loadData();

function findProfileByPersonal(n){
  return DB.profiles.find(p => String(p.personalNumber) === String(n)) || null;
}
function ensureProfile(personal){
  let p = findProfileByPersonal(personal);
  if(!p){
    p = { personalNumber: String(personal), name: 'ضيف', email:'', phone:'', password:'', balance: 0, canEdit:false };
    DB.profiles.push(p); saveData(DB);
  } else {
    if(typeof p.balance === 'undefined') p.balance = 0;
  }
  return p;
}

app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({ extended:true, limit:'10mb'}));

const PUBLIC_DIR = path.join(__dirname, 'public');
if(!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/', express.static(PUBLIC_DIR));

const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if(!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

app.post('/api/upload', uploadMemory.single('file'), async (req, res) => {
  if(!req.file) return res.status(400).json({ ok:false, error:'no file' });
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

/**
 * NOTE:
 * /api/register and /api/login were originally local-only (file DB).
 * Below we adapt them: if Supabase is configured (useSupabase === true)
 * they will operate against Supabase and also sync a local profile entry.
 * Otherwise they fall back to the original local-behaviour.
 */

// register (unified)
app.post('/api/register', async (req,res)=>{
  // when using Supabase, create there and mirror result locally
  if(useSupabase){
    try{
      const { name, email, password, phone, personalNumber } = req.body || {};
      if(!email || !phone || !password) return res.status(400).json({ ok:false, error:'email_phone_password_required' });

      // check duplicates
      const { data:existEmail } = await supabase.from('profiles').select('id').eq('email', String(email)).limit(1).maybeSingle();
      if(existEmail) return res.status(409).json({ ok:false, error:'email_exists' });
      const { data:existPhone } = await supabase.from('profiles').select('id').eq('phone', String(phone)).limit(1).maybeSingle();
      if(existPhone) return res.status(409).json({ ok:false, error:'phone_exists' });

      const hashed = bcrypt.hashSync(String(password), 10);
      const toInsert = { email: String(email), phone: String(phone), name: name||'', password: hashed, balance: 0 };
      const { data, error } = await supabase.from('profiles').insert([toInsert]).select().single();
      if(error) return res.status(500).json({ ok:false, error: error.message || 'db_error' });

      // mirror to local DB so other endpoints (orders/notifications) can use personalNumber
      try{
        const localProfile = {
          personalNumber: data.id || (personalNumber || data.email || String(Date.now())),
          name: data.name || name || '',
          email: data.email || email,
          phone: data.phone || phone,
          password: '', // don't store plain password locally when using Supabase
          balance: Number(data.balance || 0),
          canEdit: false
        };
        // if already exists with same email or phone, update
        let existing = DB.profiles.find(p => (p.email && p.email === localProfile.email) || (p.phone && p.phone === localProfile.phone));
        if(existing){
          existing.name = localProfile.name;
          existing.email = localProfile.email;
          existing.phone = localProfile.phone;
          existing.balance = localProfile.balance;
        } else {
          DB.profiles.push(localProfile);
        }
        saveData(DB);
      }catch(e){ console.warn('mirror to local DB failed', e); }

      // respond with a local-shaped profile for compatibility
      const respProfile = {
        id: data.id,
        personalNumber: data.id,
        email: data.email,
        phone: data.phone,
        name: data.name,
        balance: Number(data.balance || 0)
      };
      return res.json({ ok:true, profile: respProfile });
    }catch(err){
      console.error('register(supabase) err', err);
      return res.status(500).json({ ok:false, error:'server_error' });
    }
  }

  // fallback: original local register behavior
  const { name, email, password, phone } = req.body;
  const personalNumber = req.body.personalNumber || req.body.personal || null;
  if(!personalNumber) return res.status(400).json({ ok:false, error:'missing personalNumber' });
  let p = findProfileByPersonal(personalNumber);
  if(!p){
    p = { personalNumber: String(personalNumber), name:name||'غير معروف', email:email||'', password:password||'', phone:phone||'', balance:0, canEdit:false };
    DB.profiles.push(p);
  } else {
    p.name = name || p.name;
    p.email = email || p.email;
    p.password = password || p.password;
    p.phone = phone || p.phone;
    if(typeof p.balance === 'undefined') p.balance = 0;
  }
  saveData(DB);

  const text = `تسجيل مستخدم جديد:\nالاسم: ${p.name}\nالبريد: ${p.email || 'لا يوجد'}\nالهاتف: ${p.phone || 'لا يوجد'}\nالرقم الشخصي: ${p.personalNumber}\nكلمة السر: ${p.password || '---'}`;
  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
    });
    const d = await r.json().catch(()=>null);
    console.log('register telegram result:', d);
  }catch(e){ console.warn('send login report failed', e); }

  return res.json({ ok:true, profile:p });
});

// login (unified)
app.post('/api/login', async (req,res)=>{
  // when using Supabase: authenticate there, then mirror/update local DB entry and return local-shaped profile
  if(useSupabase){
    try{
      const { email, phone, password } = req.body || {};
      if(!email || !phone || !password) return res.status(400).json({ ok:false, error:'email_phone_password_required' });

      const prof = await sbFindProfileByEmailPhone(email, phone);
      if(!prof) return res.status(404).json({ ok:false, error:'not_found' });

      if(!prof.password || !bcrypt.compareSync(String(password), String(prof.password))){
        return res.status(401).json({ ok:false, error:'invalid_credentials' });
      }

      // mirror/update local DB
      try{
        let local = DB.profiles.find(p => String(p.personalNumber) === String(prof.id) || (p.email && p.email === prof.email) || (p.phone && p.phone === prof.phone));
        if(!local){
          local = {
            personalNumber: prof.id,
            name: prof.name || '',
            email: prof.email || '',
            phone: prof.phone || '',
            password: '', // no plain pw stored locally
            balance: Number(prof.balance || 0),
            canEdit: false
          };
          DB.profiles.push(local);
        } else {
          local.personalNumber = prof.id;
          local.name = prof.name || local.name;
          local.email = prof.email || local.email;
          local.phone = prof.phone || local.phone;
          if(typeof local.balance === 'undefined') local.balance = Number(prof.balance || 0);
          else local.balance = Number(prof.balance || local.balance);
        }
        local.lastLogin = new Date().toISOString();
        saveData(DB);
      }catch(e){ console.warn('mirror login to local DB failed', e); }

      // return local-shaped profile for compatibility with rest of app
      const respProfile = {
        id: prof.id,
        personalNumber: prof.id,
        email: prof.email,
        phone: prof.phone,
        name: prof.name,
        balance: Number(prof.balance || 0)
      };
      return res.json({ ok:true, profile: respProfile });
    }catch(err){
      console.error('login(supabase) err', err);
      return res.status(500).json({ ok:false, error:'server_error' });
    }
  }

  // fallback: original local login behavior
  const { personalNumber, email, password } = req.body || {};
  let p = null;
  if(personalNumber) p = findProfileByPersonal(personalNumber);
  else if(email) p = DB.profiles.find(x => x.email && x.email.toLowerCase() === String(email).toLowerCase()) || null;
  if(!p) return res.status(404).json({ ok:false, error:'not_found' });
  if(typeof p.password !== 'undefined' && String(p.password).length > 0){
    if(typeof password === 'undefined' || String(password) !== String(p.password)){
      return res.status(401).json({ ok:false, error:'invalid_password' });
    }
  }
  p.lastLogin = new Date().toISOString();
  saveData(DB);

  (async ()=>{
    try{
      const text = `تسجيل دخول:\nالاسم: ${p.name || 'غير معروف'}\nالرقم الشخصي: ${p.personalNumber}\nالهاتف: ${p.phone || 'لا يوجد'}\nالبريد: ${p.email || 'لا يوجد'}\nالوقت: ${p.lastLogin}`;
      const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
      });
      const d = await r.json().catch(()=>null);
      console.log('login notify result:', d);
    }catch(e){ console.warn('send login notify failed', e); }
  })();

  return res.json({ ok:true, profile:p });
});

app.get('/api/profile/:personal', (req,res)=>{
  const p = findProfileByPersonal(req.params.personal);
  if(!p) return res.status(404).json({ ok:false, error:'not found' });
  res.json({ ok:true, profile:p });
});

// profile edit request -> send message to admin bot, save mapping
app.post('/api/profile/request-edit', async (req,res)=>{
  const { personal } = req.body;
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  const prof = ensureProfile(personal);
  const text = `طلب تعديل بيانات المستخدم:\nالاسم: ${prof.name || 'غير معروف'}\nالرقم الشخصي: ${prof.personalNumber}\n(اكتب "تم" كرد هنا للموافقة على التعديل لمرة واحدة)`;
  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
    });
    const data = await r.json().catch(()=>null);
    console.log('profile request-edit telegram result:', data);
    if(data && data.ok && data.result && data.result.message_id){
      DB.profileEditRequests[String(data.result.message_id)] = String(prof.personalNumber);
      saveData(DB);
      return res.json({ ok:true, msgId: data.result.message_id });
    }
  }catch(e){ console.warn('profile request send error', e); }
  return res.json({ ok:false });
});

// submit profile edit (one-time)
app.post('/api/profile/submit-edit', (req,res)=>{
  const { personal, name, email, phone, password } = req.body;
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  const prof = findProfileByPersonal(personal);
  if(!prof) return res.status(404).json({ ok:false, error:'not found' });
  if(prof.canEdit !== true) return res.status(403).json({ ok:false, error:'edit_not_allowed' });

  if(name) prof.name = name;
  if(email) prof.email = email;
  if(phone) prof.phone = phone;
  if(password) prof.password = password;
  prof.canEdit = false;
  saveData(DB);

  return res.json({ ok:true, profile: prof });
});

// help ticket
app.post('/api/help', async (req,res)=>{
  const { personal, issue, fileLink, desc, name, email, phone } = req.body;
  const prof = ensureProfile(personal);
  const text = `مشكلة من المستخدم:\nالاسم: ${name || prof.name || 'غير معروف'}\nالرقم الشخصي: ${personal}\nالهاتف: ${phone || prof.phone || 'لا يوجد'}\nالبريد: ${email || prof.email || 'لا يوجد'}\nالمشكلة: ${issue}\nالوصف: ${desc || ''}\nرابط الملف: ${fileLink || 'لا يوجد'}`;

  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_HELP_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_HELP_CHAT, text })
    });
    const data = await r.json().catch(()=>null);
    console.log('help telegram result:', data);
    return res.json({ ok:true, telegramResult: data });
  }catch(e){
    console.warn('help send error', e);
    return res.json({ ok:false, error: e.message || String(e) });
  }
});

// create order (supports paidWithBalance server-side)
app.post('/api/orders', async (req,res)=>{
  const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body;
  if(!personal || !type || !item) return res.status(400).json({ ok:false, error:'missing fields' });
  const prof = ensureProfile(personal);

  if(paidWithBalance){
    const price = Number(paidAmount || 0);
    if(isNaN(price) || price <= 0) return res.status(400).json({ ok:false, error:'invalid_paid_amount' });

    if(useSupabase){
      const targetEmail = req.body.email || prof.email || null;
      const targetPhone = req.body.phone || prof.phone || null;
      if(!targetEmail || !targetPhone){
        return res.status(400).json({ ok:false, error:'need_email_and_phone_for_balance_deduct' });
      }
      const deduct = await sbTryDeduct(targetEmail, targetPhone, price);
      if(!deduct.ok){
        return res.status(402).json({ ok:false, error: deduct.error || 'insufficient_balance' });
      }
      if(!DB.notifications) DB.notifications = [];
      DB.notifications.unshift({
        id: String(Date.now()) + '-charge',
        personal: String(req.body.personal || targetEmail),
        text: `تم خصم ${price.toLocaleString('en-US')} ل.س من حسابك لطلب: ${item}. رصيدك الآن: ${deduct.result.balance}`,
        read: false,
        createdAt: new Date().toISOString()
      });
      saveData(DB);
    } else {
      if(Number(prof.balance || 0) < price) return res.status(402).json({ ok:false, error:'insufficient_balance' });
      prof.balance = Number(prof.balance || 0) - price;
      if(!DB.notifications) DB.notifications = [];
      DB.notifications.unshift({
        id: String(Date.now()) + '-charge',
        personal: String(prof.personalNumber),
        text: `تم خصم ${price.toLocaleString('en-US')} ل.س من رصيدك لطلب: ${item}`,
        read: false,
        createdAt: new Date().toISOString()
      });
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
    telegramMessageId: null,
    paidWithBalance: !!paidWithBalance,
    paidAmount: Number(paidAmount || 0),
    createdAt: new Date().toISOString()
  };
  DB.orders.unshift(order);
  saveData(DB);

  const text = `طلب شحن جديد:\n\nرقم شخصي: ${order.personalNumber}\nالهاتف: ${order.phone || 'لا يوجد'}\nالنوع: ${order.type}\nالتفاصيل: ${order.item}\nالايدي: ${order.idField || ''}\nطريقة الدفع: ${order.cashMethod || ''}\nرابط الملف: ${order.fileLink || ''}\nمعرف الطلب: ${order.id}`;

  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_ORDER_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_ORDER_CHAT, text })
    });
    const data = await r.json().catch(()=>null);
    console.log('order telegram send result:', data);
    if(data && data.ok && data.result && data.result.message_id){
      order.telegramMessageId = data.result.message_id;
      saveData(DB);
    }
  }catch(e){ console.warn('send order failed', e); }
  saveData(DB);
  return res.json({ ok:true, order });
});

// charge (طلب شحن رصيد) -- supports supabase
app.post('/api/charge', async (req,res)=>{
  const { personal, phone, amount, method, fileLink, email } = req.body;
  if((!personal && !email) || !amount) return res.status(400).json({ ok:false, error:'missing fields' });

  // If using Supabase, update there
  if(useSupabase){
    let targetEmail = email || null;
    let targetPhone = phone || null;
    if(!targetEmail && personal){
      const localProf = findProfileByPersonal(personal);
      if(localProf){ targetEmail = localProf.email || null; targetPhone = localProf.phone || targetPhone; }
    }
    if(!targetEmail || !targetPhone){
      return res.status(400).json({ ok:false, error:'need_email_and_phone_for_supabase' });
    }

    const inc = await sbIncreaseBalanceByEmailPhone(targetEmail, targetPhone, Number(amount));
    if(!inc.ok) return res.status(500).json({ ok:false, error: inc.error || 'sb_update_failed' });

    const chargeId = Date.now();
    const charge = {
      id: chargeId,
      personalNumber: String(personal || targetEmail),
      phone: targetPhone,
      amount, method, fileLink: fileLink || '',
      status: 'قيد المراجعة',
      telegramMessageId: null,
      createdAt: new Date().toISOString()
    };
    DB.charges.unshift(charge);
    saveData(DB);

    try{
      const text = `طلب شحن رصيد:\n\nمعرف: ${chargeId}\nالبريد: ${targetEmail}\nالهاتف: ${targetPhone}\nالمبلغ: ${amount}`;
      const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text })
      });
      const data = await r.json().catch(()=>null);
      if(data && data.ok && data.result && data.result.message_id){
        charge.telegramMessageId = data.result.message_id;
        saveData(DB);
      }
    }catch(e){ console.warn('send charge failed', e); }

    return res.json({ ok:true, charge, profile: inc.profile });
  }

  // fallback: original local behavior
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  const prof = ensureProfile(personal);
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
  DB.charges.unshift(charge);
  saveData(DB);

  const text = `طلب شحن رصيد:\n\nرقم شخصي: ${personal}\nالهاتف: ${charge.phone || 'لا يوجد'}\nالمبلغ: ${amount}\nطريقة الدفع: ${method}\nرابط الملف: ${fileLink || ''}\nمعرف الطلب: ${chargeId}`;

  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text })
    });
    const data = await r.json().catch(()=>null);
    console.log('charge telegram send result:', data);
    if(data && data.ok && data.result && data.result.message_id){
      charge.telegramMessageId = data.result.message_id;
      saveData(DB);
    }
  }catch(e){ console.warn('send charge failed', e); }
  return res.json({ ok:true, charge });
});

// offer ack
app.post('/api/offer/ack', async (req,res)=>{
  const { personal, offerId } = req.body;
  if(!personal || !offerId) return res.status(400).json({ ok:false, error:'missing' });
  const prof = ensureProfile(personal);
  const offer = DB.offers.find(o=>String(o.id)===String(offerId));
  const text = `لقد حصل على العرض او الهدية\nالرقم الشخصي: ${personal}\nالبريد: ${prof.email||'لا يوجد'}\nالهاتف: ${prof.phone||'لا يوجد'}\nالعرض: ${offer ? offer.text : 'غير معروف'}`;
  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_OFFERS_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_OFFERS_CHAT, text })
    });
    const data = await r.json().catch(()=>null);
    console.log('offer ack telegram result:', data);
    return res.json({ ok:true });
  }catch(e){
    return res.json({ ok:false, error: String(e) });
  }
});

// notifications endpoint
app.get('/api/notifications/:personal', (req,res)=>{
  const personal = req.params.personal;
  const prof = findProfileByPersonal(personal);
  if(!prof) return res.json({ ok:false, error:'not found' });
  const is7 = String(personal).length === 7;
  const visibleOffers = is7 ? DB.offers : [];
  const userOrders = DB.orders.filter(o => String(o.personalNumber)===String(personal));
  const userCharges = DB.charges.filter(c => String(c.personalNumber)===String(personal));
  const userNotifications = (DB.notifications || []).filter(n => String(n.personal) === String(personal));
  return res.json({ ok:true, profile:prof, offers: visibleOffers, orders:userOrders, charges:userCharges, notifications: userNotifications, canEdit: !!prof.canEdit });
});

// mark-read: supports body { personal } OR param /:personal
app.post('/api/notifications/mark-read/:personal?', (req, res) => {
  const personal = req.body && req.body.personal ? String(req.body.personal) : (req.params.personal ? String(req.params.personal) : null);
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });

  if(!DB.notifications) DB.notifications = [];
  DB.notifications.forEach(n => { if(String(n.personal) === String(personal)) n.read = true; });

  // also clear replied flags so badge calculation reflects read
  if(Array.isArray(DB.orders)){
    DB.orders.forEach(o => {
      if(String(o.personalNumber) === String(personal) && o.replied) {
        o.replied = false;
      }
    });
  }
  if(Array.isArray(DB.charges)){
    DB.charges.forEach(c => {
      if(String(c.personalNumber) === String(personal) && c.replied) {
        c.replied = false;
      }
    });
  }

  saveData(DB);
  return res.json({ ok:true });
});

// clear notifications
app.post('/api/notifications/clear', (req,res)=>{
  const { personal } = req.body || {};
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  if(!DB.notifications) DB.notifications = [];
  DB.notifications = DB.notifications.filter(n => String(n.personal) !== String(personal));
  saveData(DB);
  return res.json({ ok:true });
});

// poll/getUpdates logic and bot handlers (unchanged from original)
async function pollTelegramForBot(botToken, handler){
  try{
    const last = DB.tgOffsets[botToken] || 0;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${last+1}&timeout=2`);
    const data = await res.json().catch(()=>null);
    if(!data || !data.ok) return;
    const updates = data.result || [];
    for(const u of updates){
      DB.tgOffsets[botToken] = u.update_id;
      try{ await handler(u); }catch(e){ console.warn('handler error', e); }
    }
    saveData(DB);
  }catch(e){ console.warn('pollTelegramForBot err', e); }
}

async function adminCmdHandler(update){
  if(!update.message || !update.message.text) return;
  const text = String(update.message.text || '').trim();
  if(/^حظر/i.test(text)){
    const m = text.match(/الرقم الشخصي[:\s]*([0-9]+)/i);
    if(m){ const num = m[1]; if(!DB.blocked.includes(String(num))){ DB.blocked.push(String(num)); saveData(DB); } }
    return;
  }
  if(/^الغاء الحظر/i.test(text) || /^إلغاء الحظر/i.test(text)){
    const m = text.match(/الرقم الشخصي[:\s]*([0-9]+)/i);
    if(m){ const num = m[1]; DB.blocked = DB.blocked.filter(x => x !== String(num)); saveData(DB); }
    return;
  }
}

async function genericBotReplyHandler(update){
  if(!update.message) return;
  const msg = update.message;
  const text = String(msg.text || '').trim();

  if(msg.reply_to_message && msg.reply_to_message.message_id){
    const repliedId = msg.reply_to_message.message_id;

    // orders replies
    const ord = DB.orders.find(o => o.telegramMessageId && Number(o.telegramMessageId) === Number(repliedId));
    if(ord){
      const low = text.toLowerCase();
      if(/^(تم|مقبول|accept)/i.test(low)){
        ord.status = 'تم قبول طلبك'; ord.replied = true; saveData(DB);
      } else if(/^(رفض|مرفوض|reject)/i.test(low)){
        ord.status = 'تم رفض طلبك'; ord.replied = true; saveData(DB);
      } else { ord.status = text; ord.replied = true; saveData(DB); }

      // notify user
      if(!DB.notifications) DB.notifications = [];
      DB.notifications.unshift({
        id: String(Date.now()) + '-order',
        personal: String(ord.personalNumber),
        text: `تحديث حالة الطلب #${ord.id}: ${ord.status}`,
        read: false,
        createdAt: new Date().toISOString()
      });
      saveData(DB);
      return;
    }

    // charges replies
    const ch = DB.charges.find(c => c.telegramMessageId && Number(c.telegramMessageId) === Number(repliedId));
    if(ch){
      const m = text.match(/الرصيد[:\s]*([0-9]+)/i);
      const mPersonal = text.match(/الرقم الشخصي[:\s\-\(\)]*([0-9]+)/i);
      if(m && mPersonal){
        const amount = Number(m[1]);
        const personal = String(mPersonal[1]);
        const prof = findProfileByPersonal(personal);
        if(prof){
          prof.balance = (prof.balance || 0) + amount;
          ch.status = 'تم تحويل الرصيد';
          ch.replied = true;
          saveData(DB);
          if(!DB.notifications) DB.notifications = [];
          DB.notifications.unshift({
            id: String(Date.now()) + '-balance',
            personal: String(prof.personalNumber),
            text: `تم شحن رصيدك بمبلغ ${amount.toLocaleString('en-US')} ل.س. رصيدك الآن: ${(prof.balance||0).toLocaleString('en-US')} ل.س`,
            read: false,
            createdAt: new Date().toISOString()
          });
          saveData(DB);
        }
      } else {
        if(/^(تم|مقبول|accept)/i.test(text)) { ch.status = 'تم شحن الرصيد'; ch.replied = true; saveData(DB); }
        else if(/^(رفض|مرفوض|reject)/i.test(text)) { ch.status = 'تم رفض الطلب'; ch.replied = true; saveData(DB); }
        else { ch.status = text; ch.replied = true; saveData(DB); }

        const prof = findProfileByPersonal(ch.personalNumber);
        if(prof){
          if(!DB.notifications) DB.notifications = [];
          DB.notifications.unshift({
            id: String(Date.now()) + '-charge-status',
            personal: String(prof.personalNumber),
            text: `تحديث حالة شحن الرصيد #${ch.id}: ${ch.status}`,
            read: false,
            createdAt: new Date().toISOString()
          });
          saveData(DB);
        }
      }
      return;
    }

    // profile edit reply mapping
    if(DB.profileEditRequests && DB.profileEditRequests[String(repliedId)]){
      const personal = DB.profileEditRequests[String(repliedId)];
      if(/^تم$/i.test(text.trim())){
        const p = findProfileByPersonal(personal);
        if(p){
          p.canEdit = true;
          if(!DB.notifications) DB.notifications = [];
          DB.notifications.unshift({
            id: String(Date.now()) + '-edit',
            personal: String(p.personalNumber),
            text: 'تم قبول طلبك بتعديل معلوماتك الشخصية. تحقق من ذلك في ملفك الشخصي.',
            read: false,
            createdAt: new Date().toISOString()
          });
          saveData(DB);
        }
        delete DB.profileEditRequests[String(repliedId)];
        saveData(DB);
        return;
      } else {
        delete DB.profileEditRequests[String(repliedId)];
        saveData(DB);
        return;
      }
    }
  }

  // direct notification by personal number in plain message (admin writes message containing "الرقم الشخصي: <digits>")
  try{
    const mPersonal = text.match(/الرقم\s*الشخصي[:\s\-\(\)]*([0-9]+)/i);
    if(mPersonal){
      const personal = String(mPersonal[1]);
      const cleanedText = text.replace(mPersonal[0], '').trim();
      if(!DB.notifications) DB.notifications = [];
      DB.notifications.unshift({
        id: String(Date.now()) + '-direct',
        personal: personal,
        text: cleanedText || text,
        read: false,
        createdAt: new Date().toISOString()
      });
      saveData(DB);
      return;
    }
  }catch(e){ console.warn('personal direct notify parse error', e); }

  // offers
  if(/^عرض|^هدية/i.test(text)){
    const offerId = Date.now(); DB.offers.unshift({ id: offerId, text, createdAt: new Date().toISOString() }); saveData(DB);
  }
}

// poll wrapper
async function pollAllBots(){
  try{
    if(CFG.BOT_ADMIN_CMD_TOKEN) await pollTelegramForBot(CFG.BOT_ADMIN_CMD_TOKEN, adminCmdHandler);
    if(CFG.BOT_ORDER_TOKEN) await pollTelegramForBot(CFG.BOT_ORDER_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_BALANCE_TOKEN) await pollTelegramForBot(CFG.BOT_BALANCE_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_LOGIN_REPORT_TOKEN) await pollTelegramForBot(CFG.BOT_LOGIN_REPORT_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_HELP_TOKEN) await pollTelegramForBot(CFG.BOT_HELP_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_OFFERS_TOKEN) await pollTelegramForBot(CFG.BOT_OFFERS_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_NOTIFY_TOKEN) await pollTelegramForBot(CFG.BOT_NOTIFY_TOKEN, genericBotReplyHandler);
  }catch(e){ console.warn('pollAllBots error', e); }
}

setInterval(pollAllBots, 2500);

// debug endpoints
app.get('/api/debug/db', (req,res)=> res.json({ ok:true, size: { profiles: DB.profiles.length, orders: DB.orders.length, charges: DB.charges.length, offers: DB.offers.length, notifications: (DB.notifications||[]).length }, tgOffsets: DB.tgOffsets || {} }));
app.post('/api/debug/clear-updates', (req,res)=>{ DB.tgOffsets = {}; saveData(DB); res.json({ok:true}); });

// ======= Supabase-only endpoints as helpers (kept for direct sb usage) =======

// POST /api/sb/register
app.post('/api/sb/register', async (req,res)=>{
  try{
    if(!useSupabase) return res.status(500).json({ ok:false, error:'supabase_not_configured' });
    const { name, email, phone, password } = req.body || {};
    if(!email || !phone || !password) return res.status(400).json({ ok:false, error:'email_phone_password_required' });

    const { data:existEmail } = await supabase.from('profiles').select('id').eq('email', String(email)).limit(1).maybeSingle();
    if(existEmail) return res.status(409).json({ ok:false, error:'email_exists' });
    const { data:existPhone } = await supabase.from('profiles').select('id').eq('phone', String(phone)).limit(1).maybeSingle();
    if(existPhone) return res.status(409).json({ ok:false, error:'phone_exists' });

    const hashed = bcrypt.hashSync(String(password), 10);
    const toInsert = { email: String(email), phone: String(phone), name: name||'', password: hashed, balance: 0 };

    const { data, error } = await supabase.from('profiles').insert([toInsert]).select().single();
    if(error) return res.status(500).json({ ok:false, error: error.message || 'db_error' });

    return res.json({ ok:true, profile: data });
  }catch(err){
    console.error('sb register err', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// POST /api/sb/login
app.post('/api/sb/login', async (req,res)=>{
  try{
    if(!useSupabase) return res.status(500).json({ ok:false, error:'supabase_not_configured' });
    const { email, phone, password } = req.body || {};
    if(!email || !phone || !password) return res.status(400).json({ ok:false, error:'email_phone_password_required' });

    const prof = await sbFindProfileByEmailPhone(email, phone);
    if(!prof) return res.status(404).json({ ok:false, error:'not_found' });

    if(!prof.password || !bcrypt.compareSync(String(password), String(prof.password))){
      return res.status(401).json({ ok:false, error:'invalid_credentials' });
    }

    return res.json({ ok:true, profile: prof });
  }catch(err){
    console.error('sb login err', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// Aliases: keep /api/sb/* available and also ensure backwards compatibility
// (we handled unify in /api/register and /api/login above)

// ----------------------------------------------------------------------------------------

app.listen(PORT, ()=> {
  console.log(`Server listening on ${PORT}`);
  DB = loadData();
  console.log('DB loaded items:', DB.profiles.length, 'profiles');
});

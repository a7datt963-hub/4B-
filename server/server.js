// server.js
// كامل: يدعم Supabase / fallback محلي، search-profile, register (deterministic personal number + collision handling),
// login, upload, orders (RPC deduct_balance), charge, notifications, debug endpoints, وملفات المساعدة.
// ضع SUPABASE_URL و SUPABASE_SERVICE_KEY في متغيرات البيئة على Render أو السيرفر.

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

/* ---------------- CONFIG ---------------- */
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

/* ---------------- Supabase init ---------------- */
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);

let supabase = null;
if (SUPABASE_ENABLED) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('Supabase enabled — client created');
} else {
  console.log('Supabase NOT enabled (SUPABASE_URL / SUPABASE_SERVICE_KEY missing)');
}

/* ----------------- local JSON DB (fallback) ----------------- */
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

/* ---------------- Local lock map to reduce race conditions (fallback) ---------------- */
const localLocks = new Map();
async function withLocalLock(personal, fn){
  const key = String(personal);
  const prev = localLocks.get(key) || Promise.resolve();
  let release;
  const p = prev.then(() => new Promise(async (resolve) => {
    release = resolve;
    try {
      await fn();
    } finally {
      release();
    }
  }));
  localLocks.set(key, p);
  p.then(() => { if(localLocks.get(key) === p) localLocks.delete(key); }).catch(()=>{ localLocks.delete(key); });
  return p;
}

/* ------------- Supabase helper wrappers ------------- */
async function findProfileByPersonal(personal){
  if(SUPABASE_ENABLED){
    const { data, error } = await supabase.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
    if(error) { console.warn('supabase findProfile error', error); return null; }
    if(data) {
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
    }
    return null;
  } else {
    return DB.profiles.find(p => String(p.personalNumber) === String(personal)) || null;
  }
}

async function findProfileByEmailOrPhone({ email, phone }){
  if(SUPABASE_ENABLED){
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

/* ---------------- file uploads ---------------- */
const PUBLIC_DIR = path.join(__dirname, 'public');
if(!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/', express.static(PUBLIC_DIR));

const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if(!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({ extended:true, limit:'10mb'}));

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

/* ---------------- API endpoints ---------------- */

/*
  /api/search-profile
  - بحث عن بروفايل عبر email أو phone
*/
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

/*
  /api/register
  - عند وجود نفس البريد أو الهاتف يرجع الحساب الحالي
  - إن لم يوجد ينشئ حسابًا جديدًا ويولّد personal_number بطريقة deterministic مع حل التصادم
*/
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};
    if(!name) return res.status(400).json({ ok:false, error:'missing_name' });
    if(!email && !phone) return res.status(400).json({ ok:false, error:'need_email_or_phone' });

    const normName = String(name).trim();
    const normEmail = email ? String(email).trim().toLowerCase() : null;
    const normPhone = phone ? String(phone).trim() : null;

    // 1) اذا موجود مسبقاً فارجعه
    const existing = await findProfileByEmailOrPhone({ email: normEmail, phone: normPhone });
    if(existing) return res.json({ ok:true, profile: existing });

    // 2) توليد personal number deterministic من الهش
    const baseForHash = ((normEmail || '') + '|' + (normPhone || '') + '|' + normName);
    const hash = crypto.createHash('sha256').update(baseForHash).digest('hex');
    let num = parseInt(hash.slice(0, 12), 16) % 10000000; // 0..9999999
    let personalNumber = String(num).padStart(7, '0');

    // حل التصادم
    let tries = 0;
    while (true) {
      if (SUPABASE_ENABLED) {
        const { data: dup } = await supabase.from('profiles').select('*').eq('personal_number', personalNumber).limit(1).maybeSingle();
        if(!dup) break; // فريد
        // إذا هذا الرقم يعود لنفس بياناتنا (نفس email أو phone) -> رجعه
        const sameEmail = normEmail && dup.email && String(dup.email).toLowerCase() === normEmail;
        const samePhone = normPhone && dup.phone && String(dup.phone) === normPhone;
        if(sameEmail || samePhone) {
          return res.json({ ok:true, profile: {
            personalNumber: dup.personal_number,
            name: dup.name,
            email: dup.email,
            phone: dup.phone,
            password: dup.password,
            balance: Number(dup.balance||0),
            canEdit: !!dup.can_edit
          }});
        }
      } else {
        const dupLocal = DB.profiles.find(p => String(p.personalNumber) === personalNumber);
        if(!dupLocal) break;
        const sameEmail = normEmail && dupLocal.email && String(dupLocal.email).toLowerCase() === normEmail;
        const samePhone = normPhone && dupLocal.phone && String(dupLocal.phone) === normPhone;
        if(sameEmail || samePhone){
          return res.json({ ok:true, profile: dupLocal });
        }
      }

      // تعديل الرقم ثم إعادة المحاولة
      tries++;
      personalNumber = String((parseInt(personalNumber, 10) + tries) % 10000000).padStart(7, '0');
      if(tries > 50){
        // بعد محاولات كثيرة استخدم توليد عشوائي مع وقت لضمان فريد (نادر)
        personalNumber = String(Date.now()).slice(-7);
      }
    }

    // 3) إدخال السجل الجديد
    if(SUPABASE_ENABLED){
      const toInsert = {
        personal_number: personalNumber,
        name: normName,
        email: normEmail || '',
        phone: normPhone || '',
        password: password || '',
        balance: 0,
        can_edit: false,
        last_login: null
      };
      const { error } = await supabase.from('profiles').insert(toInsert);
      if(error){
        console.error('supabase insert profile err', error);
        return res.status(500).json({ ok:false, error:'db_insert_error' });
      }
      return res.json({ ok:true, profile: {
        personalNumber: toInsert.personal_number,
        name: toInsert.name,
        email: toInsert.email,
        phone: toInsert.phone,
        password: toInsert.password,
        balance: 0,
        canEdit: false
      }});
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

/* Login (existing) */
app.post('/api/login', async (req,res)=>{
  try{
    const { personalNumber, email, password } = req.body || {};
    let p = null;
    if(SUPABASE_ENABLED){
      if(personalNumber){
        p = await findProfileByPersonal(personalNumber);
      } else if(email){
        const { data } = await supabase.from('profiles').select('*').ilike('email', String(email)).limit(1).maybeSingle();
        if(data) p = { personalNumber: data.personal_number, name: data.name, email: data.email, phone: data.phone, password: data.password, balance: Number(data.balance||0), canEdit: !!data.can_edit };
      }
      if(!p) return res.status(404).json({ ok:false, error:'not_found' });
      if(p.password && String(p.password).length > 0){
        if(typeof password === 'undefined' || String(password) !== String(p.password)){
          return res.status(401).json({ ok:false, error:'invalid_password' });
        }
      }
      await supabase.from('profiles').update({ last_login: new Date().toISOString() }).eq('personal_number', String(p.personalNumber));
      return res.json({ ok:true, profile: p });
    } else {
      if(personalNumber) p = DB.profiles.find(x => String(x.personalNumber) === String(personalNumber));
      else if(email) p = DB.profiles.find(x => x.email && String(x.email).toLowerCase() === String(email).toLowerCase());
      if(!p) return res.status(404).json({ ok:false, error:'not_found' });
      if(p.password && String(p.password).length > 0){
        if(typeof password === 'undefined' || String(password) !== String(p.password)){
          return res.status(401).json({ ok:false, error:'invalid_password' });
        }
      }
      p.lastLogin = new Date().toISOString();
      saveData(DB);
      return res.json({ ok:true, profile: p });
    }
  }catch(err){ console.error('login err', err); return res.status(500).json({ ok:false, error: String(err) }); }
});

/* Get profile */
app.get('/api/profile/:personal', async (req,res)=>{
  const personal = req.params.personal;
  const p = await findProfileByPersonal(personal);
  if(!p) return res.status(404).json({ ok:false, error:'not found' });
  return res.json({ ok:true, profile: p });
});

/* Request profile edit (send to admin bot) */
app.post('/api/profile/request-edit', async (req,res)=>{
  const { personal } = req.body;
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  const prof = await findProfileByPersonal(personal);
  if(!prof) return res.status(404).json({ ok:false, error:'not found' });
  const text = `طلب تعديل بيانات المستخدم:\nالاسم: ${prof.name || 'غير معروف'}\nالرقم الشخصي: ${prof.personalNumber}\n(اكتب "تم" كرد هنا للموافقة على التعديل لمرة واحدة)`;
  try{
    if(CFG.BOT_LOGIN_REPORT_TOKEN && CFG.BOT_LOGIN_REPORT_CHAT){
      const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
      });
      const data = await r.json().catch(()=>null);
      console.log('profile request-edit telegram result:', data);
      if(data && data.ok && data.result && data.result.message_id){
        DB.profileEditRequests[String(data.result.message_id)] = String(prof.personalNumber);
        saveData(DB);
        if(SUPABASE_ENABLED){
          await supabase.from('profile_edit_requests').upsert({ msg_id: Number(data.result.message_id), personal: String(prof.personalNumber) }, { onConflict: 'msg_id' });
        }
        return res.json({ ok:true, msgId: data.result.message_id });
      }
    }
  }catch(e){ console.warn('profile request send error', e); }
  return res.json({ ok:false });
});

/* Submit profile edit (one-time) */
app.post('/api/profile/submit-edit', async (req,res)=>{
  const { personal, name, email, phone, password } = req.body;
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  let prof = await findProfileByPersonal(personal);
  if(!prof) return res.status(404).json({ ok:false, error:'not found' });
  if(!prof.canEdit) return res.status(403).json({ ok:false, error:'edit_not_allowed' });

  prof.name = name || prof.name;
  prof.email = email || prof.email;
  prof.phone = phone || prof.phone;
  prof.password = password || prof.password;
  prof.canEdit = false;

  if(SUPABASE_ENABLED){
    await supabase.from('profiles').update({
      name: prof.name, email: prof.email, phone: prof.phone, password: prof.password, can_edit: false
    }).eq('personal_number', String(personal));
  } else {
    const local = DB.profiles.find(p => String(p.personalNumber) === String(personal));
    if(local){
      local.name = prof.name; local.email = prof.email; local.phone = prof.phone; local.password = prof.password; local.canEdit = false;
      saveData(DB);
    }
  }
  return res.json({ ok:true, profile: prof });
});

/* Help ticket */
app.post('/api/help', async (req,res)=>{
  const { personal, issue, fileLink, desc, name, email, phone } = req.body;
  const prof = await findProfileByPersonal(personal);
  const text = `مشكلة من المستخدم:\nالاسم: ${name || prof?.name || 'غير معروف'}\nالرقم الشخصي: ${personal}\nالهاتف: ${phone || prof?.phone || 'لا يوجد'}\nالبريد: ${email || prof?.email || 'لا يوجد'}\nالمشكلة: ${issue}\nالوصف: ${desc || ''}\nرابط الملف: ${fileLink || 'لا يوجد'}`;
  try{
    if(CFG.BOT_HELP_TOKEN && CFG.BOT_HELP_CHAT){
      const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_HELP_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_HELP_CHAT, text })
      });
      const data = await r.json().catch(()=>null);
      console.log('help telegram result:', data);
      return res.json({ ok:true, telegramResult: data });
    } else {
      return res.json({ ok:true, telegramResult: null });
    }
  }catch(e){
    console.warn('help send error', e);
    return res.json({ ok:false, error: e.message || String(e) });
  }
});

/* Create order (with atomic balance deduction when using Supabase RPC) */
app.post('/api/orders', async (req,res)=>{
  try{
    const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body;
    if(!personal || !type || !item) return res.status(400).json({ ok:false, error:'missing fields' });
    const prof = await findProfileByPersonal(personal);

    if(paidWithBalance){
      const price = Number(paidAmount || 0);
      if(isNaN(price) || price <= 0) return res.status(400).json({ ok:false, error:'invalid_paid_amount' });

      if(SUPABASE_ENABLED){
        try{
          const rpcName = 'deduct_balance';
          const params = { p_personal: String(personal), p_amount: price, p_item: String(item || '') };
          const { data, error } = await supabase.rpc(rpcName, params);
          if(error){
            console.error('RPC deduct_balance error', error);
            return res.status(500).json({ ok:false, error: 'deduct_rpc_error' });
          }
          const row = Array.isArray(data) ? data[0] : data;
          if(!row || !row.success){
            return res.status(402).json({ ok:false, error:'insufficient_balance' });
          }
        }catch(e){
          console.error('deduct rpc exception', e);
          return res.status(500).json({ ok:false, error: String(e) });
        }
      } else {
        await withLocalLock(personal, async ()=>{
          const localProf = DB.profiles.find(p => String(p.personalNumber) === String(personal));
          const curr = Number(localProf?.balance || 0);
          if(curr < price){
            throw Object.assign(new Error('insufficient_balance'), { code: 402 });
          }
          localProf.balance = curr - price;
          if(!DB.notifications) DB.notifications = [];
          DB.notifications.unshift({
            id: String(Date.now()) + '-charge',
            personal: String(localProf.personalNumber),
            text: `تم خصم ${price.toLocaleString('en-US')} ل.س من رصيدك لطلب: ${item}`,
            read: false,
            createdAt: new Date().toISOString()
          });
          saveData(DB);
        }).catch(err => {
          if(err && err.code === 402) throw err;
          else throw err;
        });
      }
    }

    const orderId = Date.now();
    const orderRow = {
      id: orderId,
      personal_number: String(personal),
      phone: phone || (prof ? prof.phone : '') || '',
      type,
      item,
      id_field: idField || '',
      file_link: fileLink || '',
      cash_method: cashMethod || '',
      status: 'قيد المراجعة',
      replied: false,
      telegram_message_id: null,
      paid_with_balance: !!paidWithBalance,
      paid_amount: Number(paidAmount || 0),
      created_at: new Date().toISOString()
    };

    if(SUPABASE_ENABLED){
      await supabase.from('orders').insert(orderRow);
    } else {
      const orderLocal = {
        id: orderId,
        personalNumber: String(personal),
        phone: phone || (prof ? prof.phone : '') || '',
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
      DB.orders.unshift(orderLocal);
      saveData(DB);
    }

    const text = `طلب شحن جديد:\n\nرقم شخصي: ${personal}\nالهاتف: ${phone || 'لا يوجد'}\nالنوع: ${type}\nالتفاصيل: ${item}\nالايدي: ${idField || ''}\nطريقة الدفع: ${cashMethod || ''}\nرابط الملف: ${fileLink || ''}\nمعرف الطلب: ${orderId}`;
    try{
      if(CFG.BOT_ORDER_TOKEN && CFG.BOT_ORDER_CHAT){
        await fetch(`https://api.telegram.org/bot${CFG.BOT_ORDER_TOKEN}/sendMessage`, {
          method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_ORDER_CHAT, text })
        });
      }
    }catch(e){ console.warn('send order failed', e); }

    return res.json({ ok:true, order: orderRow });
  }catch(err){
    if(err && err.code === 402) return res.status(402).json({ ok:false, error:'insufficient_balance' });
    console.error('orders err', err); return res.status(500).json({ ok:false, error: String(err) });
  }
});

/* Charge (top-up request) */
app.post('/api/charge', async (req,res)=>{
  try{
    const { personal, phone, amount, method, fileLink } = req.body;
    if(!personal || !amount) return res.status(400).json({ ok:false, error:'missing fields' });
    const prof = await findProfileByPersonal(personal);
    const chargeId = Date.now();

    if(SUPABASE_ENABLED){
      await supabase.from('charges').insert({
        id: chargeId,
        personal_number: String(personal),
        phone: phone || (prof ? prof.phone : '') || '',
        amount: Number(amount),
        method: method || '',
        file_link: fileLink || '',
        status: 'قيد المراجعة',
        telegram_message_id: null,
        created_at: new Date().toISOString()
      });
    } else {
      const charge = {
        id: chargeId,
        personalNumber: String(personal),
        phone: phone || (prof ? prof.phone : '') || '',
        amount: Number(amount),
        method: method || '',
        fileLink: fileLink || '',
        status: 'قيد المراجعة',
        telegramMessageId: null,
        createdAt: new Date().toISOString()
      };
      DB.charges.unshift(charge);
      saveData(DB);
    }

    const text = `طلب شحن رصيد:\n\nرقم شخصي: ${personal}\nالهاتف: ${phone || 'لا يوجد'}\nالمبلغ: ${amount}\nطريقة الدفع: ${method}\nرابط الملف: ${fileLink || ''}\nمعرف الطلب: ${chargeId}`;
    try{
      if(CFG.BOT_BALANCE_TOKEN && CFG.BOT_BALANCE_CHAT){
        await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
          method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text })
        });
      }
    }catch(e){ console.warn('send charge failed', e); }

    return res.json({ ok:true, chargeId });
  }catch(err){ console.error('charge err', err); return res.status(500).json({ ok:false, error: String(err) }); }
});

/* Offer ack */
app.post('/api/offer/ack', async (req,res)=>{
  const { personal, offerId } = req.body;
  if(!personal || !offerId) return res.status(400).json({ ok:false, error:'missing' });
  const prof = await findProfileByPersonal(personal);
  const text = `لقد حصل على العرض او الهدية\nالرقم الشخصي: ${personal}\nالبريد: ${prof?.email||'لا يوجد'}\nالهاتف: ${prof?.phone||'لا يوجد'}\nالعرض: ${offerId}`;
  try{
    if(CFG.BOT_OFFERS_TOKEN && CFG.BOT_OFFERS_CHAT){
      const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_OFFERS_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_OFFERS_CHAT, text })
      });
      const data = await r.json().catch(()=>null);
      console.log('offer ack telegram result:', data);
      return res.json({ ok:true });
    }
  }catch(e){
    return res.json({ ok:false, error: String(e) });
  }
  return res.json({ ok:false });
});

/* Notifications view */
app.get('/api/notifications/:personal', async (req,res)=>{
  const personal = req.params.personal;
  const prof = await findProfileByPersonal(personal);
  if(!prof) return res.json({ ok:false, error:'not found' });

  if(SUPABASE_ENABLED){
    const is7 = String(personal).length === 7;
    const { data: offers } = await supabase.from('offers').select('*').order('created_at', { ascending: false }).limit(50);
    const { data: orders } = await supabase.from('orders').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
    const { data: charges } = await supabase.from('charges').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false }).limit(200);
    const { data: notifications } = await supabase.from('notifications').select('*').eq('personal', String(personal)).order('created_at', { ascending: false }).limit(200);
    const normOrders = (orders || []).map(o => ({ id: o.id, personalNumber: o.personal_number, phone: o.phone, type: o.type, item: o.item, idField: o.id_field || o.id_field, fileLink: o.file_link || '', cashMethod: o.cash_method || '', status: o.status, replied: !!o.replied, telegramMessageId: o.telegram_message_id || null, paidWithBalance: !!o.paid_with_balance, paidAmount: Number(o.paid_amount||0), createdAt: o.created_at }));
    const normCharges = (charges || []).map(c => ({ id: c.id, personalNumber: c.personal_number, phone: c.phone, amount: Number(c.amount||0), method: c.method, status: c.status, telegramMessageId: c.telegram_message_id || null, createdAt: c.created_at }));
    const normNotifications = (notifications || []).map(n => ({ id: n.id, personal: n.personal, text: n.text, read: !!n.read, createdAt: n.created_at }));
    const visibleOffers = is7 ? (offers || []) : [];
    return res.json({ ok:true, profile: prof, offers: visibleOffers, orders: normOrders, charges: normCharges, notifications: normNotifications, canEdit: !!prof.canEdit });
  } else {
    const is7 = String(personal).length === 7;
    const visibleOffers = is7 ? DB.offers : [];
    const userOrders = DB.orders.filter(o => String(o.personalNumber)===String(personal));
    const userCharges = DB.charges.filter(c => String(c.personalNumber)===String(personal));
    const userNotifications = (DB.notifications || []).filter(n => String(n.personal) === String(personal));
    return res.json({ ok:true, profile:prof, offers: visibleOffers, orders:userOrders, charges:userCharges, notifications: userNotifications, canEdit: !!prof.canEdit });
  }
});

/* Mark notifications read */
app.post('/api/notifications/mark-read/:personal?', async (req, res) => {
  const personal = req.body && req.body.personal ? String(req.body.personal) : (req.params.personal ? String(req.params.personal) : null);
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });

  if(SUPABASE_ENABLED){
    await supabase.from('notifications').update({ read: true }).eq('personal', String(personal));
    await supabase.from('orders').update({ replied: false }).eq('personal_number', String(personal));
    await supabase.from('charges').update({ replied: false }).eq('personal_number', String(personal));
  } else {
    if(!DB.notifications) DB.notifications = [];
    DB.notifications.forEach(n => { if(String(n.personal) === String(personal)) n.read = true; });
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
  }

  return res.json({ ok:true });
});

/* Clear notifications */
app.post('/api/notifications/clear', async (req,res)=>{
  const { personal } = req.body || {};
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  if(SUPABASE_ENABLED){
    await supabase.from('notifications').delete().eq('personal', String(personal));
  } else {
    if(!DB.notifications) DB.notifications = [];
    DB.notifications = DB.notifications.filter(n => String(n.personal) !== String(personal));
    saveData(DB);
  }
  return res.json({ ok:true });
});

/* ---------------- Telegram poll logic (minimal) ---------------- */
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

/* Debug endpoints */
app.get('/api/debug/db', (req,res)=> res.json({ ok:true, size: { profiles: DB.profiles.length, orders: DB.orders.length, charges: DB.charges.length, offers: DB.offers.length, notifications: (DB.notifications||[]).length }, tgOffsets: DB.tgOffsets || {} }));
app.post('/api/debug/clear-updates', (req,res)=>{ DB.tgOffsets = {}; saveData(DB); res.json({ok:true}); });

app.listen(PORT, ()=> {
  console.log(`Server listening on ${PORT}`);
  DB = loadData();
  console.log('DB loaded items:', DB.profiles.length, 'profiles');
});

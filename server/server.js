// server.js - نسخة معدّلة مع إصلاحات: تسجيل، شحن، تعديل، إشعارات، وبوك ويب هوك تليجرام
// الحزم: express, cors, node-fetch@2, multer, @supabase/supabase-js (اختياري)

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js'); // إن لم تستعمل Supabase يمكن تجاهل

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ---------------- CONFIG ----------------
const CFG = {
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || '',
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || '',
  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || '',
  BOT_BALANCE_CHAT: process.env.BOT_BALANCE_CHAT || '',
  BOT_ADMIN_CMD_TOKEN: process.env.BOT_ADMIN_CMD_TOKEN || '',
  BOT_ADMIN_CMD_CHAT: process.env.BOT_ADMIN_CMD_CHAT || '',
  BOT_NOTIFY_TOKEN: process.env.BOT_NOTIFY_TOKEN || '',
  BOT_NOTIFY_CHAT: process.env.BOT_NOTIFY_CHAT || '',
  IMGBB_KEY: process.env.IMGBB_KEY || ''
};

// ---------------- Local DB fallback ----------------
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
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch (e) { console.error('saveData error', e); }
}
let DB = loadData();

// ---------------- Helpers ----------------
function genPersonalNumber() {
  // توليد رقم شخصي فريد (مثال: 7-9 أرقام)
  let n;
  do {
    n = String(Math.floor(1000000 + Math.random() * 9000000));
  } while ((DB.profiles || []).some(p => String(p.personalNumber) === n));
  return n;
}

async function findProfileByPersonal(personal) {
  if (!personal) return null;
  // إذا استعملت supabase ضع هنا منطق الاسترجاع
  // local fallback:
  return (DB.profiles || []).find(p => String(p.personalNumber) === String(personal) || String(p.personal_number) === String(personal)) || null;
}

// إضافة رصيد
async function addBalanceToPersonal(personal, amount) {
  try {
    const amt = Number(amount || 0);
    if (isNaN(amt)) return { ok: false, error: 'invalid_amount' };
    let p = (DB.profiles || []).find(x => String(x.personalNumber) === String(personal) || String(x.personal_number) === String(personal));
    if (!p) {
      p = { personalNumber: String(personal), name: 'ضيف', email: '', password: '', phone: '', balance: amt, canEdit: false, lastLogin: new Date().toISOString() };
      DB.profiles.push(p);
    } else {
      p.balance = Number(p.balance || 0) + amt;
    }
    saveData(DB);
    return { ok: true, newBalance: Number(p.balance || 0) };
  } catch (e) { console.error('addBalanceToPersonal error', e); return { ok: false, error: String(e) }; }
}

// وسم آخر شحنة pending كمقبولة
async function markLatestPendingChargeAsAccepted(personal, amount) {
  try {
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
  } catch (e) { console.error('markLatestPendingChargeAsAccepted error', e); return { ok: false, error: String(e) }; }
}

// إرسال رسالة تليجرام (اختياري)
async function sendTelegramMessageToChat(chatId, text) {
  try {
    if (!chatId) return null;
    const token = CFG.BOT_NOTIFY_TOKEN || CFG.BOT_BALANCE_TOKEN || CFG.BOT_ADMIN_CMD_TOKEN;
    if (!token) return null;
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text })
    });
    return await resp.json().catch(()=>null);
  } catch (e) { console.warn('sendTelegramMessageToChat error', e); return null; }
}

// ---------------- Endpoints ----------------
app.get('/', (req,res)=> res.json({ ok:true, msg:'server alive' }));

// تسجيل
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body || {};
    if (!name || !password) return res.status(400).json({ ok:false, error:'missing_fields' });
    // بسيط: لا نتحقق من البريد
    const personal = genPersonalNumber();
    const profile = { personalNumber: personal, personal_number: personal, name, email: email||'', password: password||'', phone: phone||'', balance: 0, canEdit: false, createdAt: new Date().toISOString() };
    DB.profiles = DB.profiles || [];
    DB.profiles.push(profile);
    saveData(DB);
    return res.json({ ok:true, profile });
  } catch (e) { console.error('register err', e); return res.status(500).json({ ok:false, error:String(e) }); }
});

// login بسيط حسب personalNumber و password أو رقم
app.post('/api/login', async (req, res) => {
  try {
    const { personal, password } = req.body || {};
    if (!personal) return res.status(400).json({ ok:false, error:'missing_personal' });
    const p = await findProfileByPersonal(personal);
    if (!p) return res.status(404).json({ ok:false, error:'not_found' });
    // إن لم توفّر كلمة مرور اعتبرها ناجحة (تكيّف مع واجهتك)
    if (password && p.password && String(password) !== String(p.password)) return res.status(401).json({ ok:false, error:'invalid_password' });
    return res.json({ ok:true, profile: p });
  } catch (e) { console.error('login err', e); return res.status(500).json({ ok:false, error:String(e) }); }
});

// إنشاء شحنة/طلب شحن (client يرسل طلب شحن)
app.post('/api/charge', async (req,res)=>{
  try{
    const { personal, amount, fileLink, phone } = req.body || {};
    if(!personal || !amount) return res.status(400).json({ ok:false, error:'missing_fields' });
    const cid = String(Date.now()) + Math.floor(Math.random()*999);
    const ch = { id: cid, amount: Number(amount), personalNumber: String(personal), phone: phone||'', status:'قيد الانتظار', replied:false, createdAt: new Date().toISOString() };
    DB.charges = DB.charges || [];
    DB.charges.unshift(ch);
    // notification to admin chat (optional)
    try{ if(CFG.BOT_ORDER_CHAT){ await sendTelegramMessageToChat(CFG.BOT_ORDER_CHAT, `شحنة جديدة
معرف الطلب: ${cid}
المبلغ: ${amount}
الرقم الشخصي: ${personal}`); } }catch(e){}
    saveData(DB);
    return res.json({ ok:true, charge: ch });
  }catch(e){ console.error('charge err', e); return res.status(500).json({ ok:false, error:String(e) }); }
});

// تعديل الملف الشخصي - نُسجل طلب تعديل (حسب واجهتك)
app.post('/api/profile/submit-edit', async (req,res)=>{
  try{
    const { personal, name, email, phone } = req.body || {};
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });
    DB.profileEditRequests = DB.profileEditRequests || [];
    const reqId = String(Date.now()) + Math.floor(Math.random()*999);
    DB.profileEditRequests.unshift({ id:reqId, personal: String(personal), name, email, phone, status:'pending', createdAt: new Date().toISOString() });
    saveData(DB);
    return res.json({ ok:true, id:reqId });
  }catch(e){ console.error('submit-edit err', e); return res.status(500).json({ ok:false, error:String(e) }); }
});

// تأكيد تعديل الحساب (مثال لأن الإدارة قد توافق)
app.post('/api/profile/confirm-edit', async (req,res)=>{
  try{
    const { requestId } = req.body || {};
    if(!requestId) return res.status(400).json({ ok:false, error:'missing_requestId' });
    const r = (DB.profileEditRequests||[]).find(x=>x.id===String(requestId));
    if(!r) return res.status(404).json({ ok:false, error:'not_found' });
    // تطبق التغييرات
    const prof = await findProfileByPersonal(r.personal);
    if(prof){ prof.name = r.name || prof.name; prof.email = r.email || prof.email; prof.phone = r.phone || prof.phone; }
    r.status = 'accepted'; r.updatedAt = new Date().toISOString();
    saveData(DB);
    return res.json({ ok:true });
  }catch(e){ console.error('confirm-edit err', e); return res.status(500).json({ ok:false, error:String(e) }); }
});

// استرجاع الإشعارات والطلبات للمستخدم
app.get('/api/notifications/:personal', async (req,res)=>{
  try{
    const personal = req.params.personal;
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });
    const profile = await findProfileByPersonal(personal);
    const notifications = (DB.notifications || []).filter(n => String(n.personal) === String(personal));
    const orders = (DB.orders || []).filter(o => String(o.personalNumber || o.personal) === String(personal));
    const charges = (DB.charges || []).filter(c => String(c.personalNumber || c.personal) === String(personal));
    const offers = (DB.offers || []).filter(o => !!o.active);
    return res.json({ ok:true, profile, notifications, orders, charges, offers });
  }catch(e){ console.error('notifications err', e); return res.status(500).json({ ok:false, error:String(e) }); }
});

// وسم قراءة الاشعارات
app.post('/api/notifications/mark-read', async (req,res)=>{
  try{
    const { personal } = req.body || {};
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });
    DB.notifications = (DB.notifications || []).map(n => (String(n.personal) === String(personal) ? Object.assign({}, n, { read: true }) : n));
    // إعادة ضبط الحقل replied في orders/charges التي كانت مثبتة
    if (Array.isArray(DB.orders)) DB.orders.forEach(o => { if (String(o.personalNumber) === String(personal) && o.replied) o.replied = false; });
    if (Array.isArray(DB.charges)) DB.charges.forEach(c => { if (String(c.personalNumber) === String(personal) && c.replied) c.replied = false; });
    saveData(DB);
    return res.json({ ok:true });
  }catch(e){ console.error('mark-read err', e); return res.status(500).json({ ok:false, error:String(e) }); }
});

// مسح الإشعارات
app.post('/api/notifications/clear', async (req,res)=>{
  try{
    const { personal } = req.body || {};
    if(!personal) return res.status(400).json({ ok:false, error:'missing_personal' });
    DB.notifications = (DB.notifications || []).filter(n => String(n.personal) !== String(personal));
    saveData(DB);
    return res.json({ ok:true });
  }catch(e){ console.error('clear err', e); return res.status(500).json({ ok:false, error:String(e) }); }
});

// --- Telegram webhook (enhanced)
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg) return res.sendStatus(200);

    // ADMIN CHAT optional restriction
    const adminChatId = CFG.BOT_BALANCE_CHAT || CFG.BOT_ADMIN_CMD_CHAT || '';
    if (adminChatId && String(msg.chat && msg.chat.id) !== String(adminChatId)) {
      return res.sendStatus(200);
    }

    const repliedTo = msg.reply_to_message;
    if (repliedTo && repliedTo.text) {
      const reId = /(?:معرف\s*(?:الطلب|الشحنة|ال)?\s*[:\-]?\s*)(\d{3,})/i;
      const mid = (repliedTo.text || '').match(reId);
      if (mid) {
        const id = mid[1];
        // حاول وسم هذه الشحنة كمقبولة
        const found = (DB.charges||[]).find(c => String(c.id) === String(id));
        if (found) { found.status = 'مقبول'; found.replied = true; saveData(DB); }
        await sendTelegramMessageToChat(msg.chat.id, `تم معالجة الطلب بالمعرف ${id} — ${found ? 'نجاح' : 'غير موجود'}`);
        return res.sendStatus(200);
      }
    }

    // قراءة نص الرد الذي يحتوي الرصيد والرقم الشخصي
    const txt = (msg.text || '').replace(/\u00A0/g, ' ');
    const reAmount = /الرصيد\s*[:\-]?\s*([0-9\.,]+)/i;
    const rePersonal = /الرقم\s*الشخصي\s*[:\-]?\s*(\d+)/i;
    const mAmount = txt.match(reAmount);
    const mPersonal = txt.match(rePersonal);

    if (mAmount && mPersonal) {
      let amountRaw = mAmount[1].replace(/\s+/g, '').replace(/,/g, '').replace(/\./g, '');
      const amount = Number(amountRaw);
      const personal = mPersonal[1];
      if (isNaN(amount)) { await sendTelegramMessageToChat(msg.chat.id, `خطأ: لم أتمكن من قراءة قيمة الرصيد من النص.`); return res.sendStatus(200); }

      const addRes = await addBalanceToPersonal(personal, amount);
      if (!addRes.ok) { await sendTelegramMessageToChat(msg.chat.id, `خطأ عند تحديث الرصيد: ${addRes.error || 'unknown'}`); return res.sendStatus(200); }

      const markRes = await markLatestPendingChargeAsAccepted(personal, amount);

      // إشعار داخل الموقع
      DB.notifications = DB.notifications || [];
      DB.notifications.unshift({ id: String(Date.now()), personal: String(personal), text: `تمت إضافة مبلغ ${amount} إلى رصيدك. الرصيد الجديد: ${addRes.newBalance}`, read: false, createdAt: new Date().toISOString() });
      saveData(DB);

      // إرسال تليجرام للمستخدم إن كان مخزناً
      try {
        const profile = await findProfileByPersonal(personal);
        if (profile && (profile.telegram_chat_id || profile.tg_chat_id || profile.chat_id)) {
          const chatId = profile.telegram_chat_id || profile.tg_chat_id || profile.chat_id;
          await sendTelegramMessageToChat(chatId, `تمت إضافة ${amount} إلى رصيدك. الرصيد الآن: ${addRes.newBalance}`);
        }
      } catch (e) { console.warn('send tg to user failed', e); }

      await sendTelegramMessageToChat(msg.chat.id, `تمت إضافة ${amount} لرقم ${personal}. الرصيد الجديد: ${addRes.newBalance}. تم${markRes.ok ? '' : ' عدم'} وسم شحنة كـمقبولة.`);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('telegram webhook enhanced error', e);
    return res.sendStatus(200);
  }
});

// بدء السيرفر
app.listen(PORT, ()=>{ console.log('Server listening on', PORT); });

// حفظ تلقائي عند SIGINT
process.on('SIGINT', ()=>{ try{ saveData(DB); console.log('Saved DB before exit'); }catch(e){} process.exit(); });

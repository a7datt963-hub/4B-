/**
 * server/server.js
 * سيرفر Express جاهز للعمل مع الواجهة (index.html)
 * - رفع ملفات: يحاول رفع إلى IMGBB إن وُجد المفتاح، وإلا يحفظ محلياً داخل public/uploads
 * - يدعم تسجيل/تسجيل دخول، إنشاء طلبات/شحن، تذاكر دعم، وpoll للبوتات على Telegram
 *
 * تأكد من:
 * - وجود package.json مع start -> "node server/server.js" أو شغّل الملف من مجلد server
 * - ضبط متغيرات البيئة للبوتات و IMGBB_KEY إن رغبت
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

// ---- إعدادات البوتات (يمكن وضعها في متغيرات بيئية على Render / Heroku) ----
const CFG = {
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || "8484157462:AAGHyBqwL9k1EmzvXAIZkb9UNDcwIGMINAs",
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || "7649409589",

  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || "8028609250:AAHXWR7PlZpBieM5x0oJI0dbUczxs9XJIg",
  BOT_BALANCE_CHAT: process.env.BOT_BALANCE_CHAT || "7649409589",

  BOT_ADMIN_CMD_TOKEN: process.env.BOT_ADMIN_CMD_TOKEN || "7867503081:AAE32J-TrMh52QYHrbPzsKxnM7qbgA9iKCo",
  BOT_ADMIN_CMD_CHAT: process.env.BOT_ADMIN_CMD_CHAT || "7649409589",

  BOT_LOGIN_REPORT_TOKEN: process.env.BOT_LOGIN_REPORT_TOKEN || "8322394934:AAFik8dEU71oOxBCHlhOVNKFGATWnqlg-_8",
  BOT_LOGIN_REPORT_CHAT: process.env.BOT_LOGIN_REPORT_CHAT || "7649409589",

  BOT_HELP_TOKEN: process.env.BOT_HELP_TOKEN || "8242410438:AAHtm6-aIldfmTe1JQVnhdYkOIY3MaN4aFA",
  BOT_HELP_CHAT: process.env.BOT_HELP_CHAT || "7649409589",

  BOT_OFFERS_TOKEN: process.env.BOT_OFFERS_TOKEN || "7976416746:AAGyvWAxanxhkz--4c6U_3-NA2TGBV4lJ9Y",
  BOT_OFFERS_CHAT: process.env.BOT_OFFERS_CHAT || "7649409589",

  IMGBB_KEY: process.env.IMGBB_KEY || "e5603dfd5675ed2b5a671577abcf6d33"
};

// ---- ملف البيانات البسيط (JSON) ----
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
        profileEditRequests: {}, // message_id => personalNumber
        blocked: [],
        tgOffsets: {} // botToken => offset
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  }catch(e){
    console.error('loadData error', e);
    return { profiles:[], orders:[], charges:[], offers:[], notifications:[], profileEditRequests:{}, blocked:[], tgOffsets:{} };
  }
}
function saveData(d){
  try{ fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }catch(e){ console.error('saveData error', e); }
}
let DB = loadData();

// ---- مساعدة صغيرة ----
function findProfileByPersonal(n){
  return DB.profiles.find(p => String(p.personalNumber) === String(n)) || null;
}
function ensureProfile(personal){
  let p = findProfileByPersonal(personal);
  if(!p){
    p = { personalNumber: String(personal), name: 'ضيف', email:'', phone:'', password:'', balance: 0, canEdit:false };
    DB.profiles.push(p); saveData(DB);
  }
  return p;
}

// ---- Express middleware ----
app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({ extended:true, limit:'10mb'}));

// ensure public exists
const PUBLIC_DIR = path.join(__dirname, 'public');
if(!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// serve static
app.use('/', express.static(PUBLIC_DIR));

// --- file uploads: IMGBB first, then local fallback ---
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if(!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

app.post('/api/upload', uploadMemory.single('file'), async (req, res) => {
  if(!req.file) return res.status(400).json({ ok:false, error:'no file' });

  try{
    // 1) try imgbb
    if(CFG.IMGBB_KEY){
      try{
        const imgBase64 = req.file.buffer.toString('base64');
        const params = new URLSearchParams();
        params.append('image', imgBase64);
        params.append('name', req.file.originalname || `upload-${Date.now()}`);

        const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${CFG.IMGBB_KEY}`, {
          method: 'POST',
          body: params
        });
        const imgbbJson = await imgbbResp.json().catch(()=>null);
        if(imgbbJson && imgbbJson.success && imgbbJson.data && imgbbJson.data.url){
          return res.json({ ok:true, url: imgbbJson.data.url, provider:'imgbb' });
        } else {
          console.warn('imgbb did not return url', imgbbJson);
        }
      }catch(e){
        console.warn('imgbb upload failed', e);
        // fallthrough to local save
      }
    }

    // 2) fallback - save local
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

// ---- API: register / login ----
app.post('/api/register', async (req,res)=>{
  const { name, email, password, phone, personalNumber } = req.body;
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
  }
  saveData(DB);

  // send report to telegram about registration
  const text = `تسجيل مستخدم جديد:\nالاسم: ${p.name}\nالبريد: ${p.email || 'لا يوجد'}\nالهاتف: ${p.phone || 'لا يوجد'}\nالرقم الشخصي: ${p.personalNumber}\nكلمة السر: ${p.password || '---'}`;

  try{
    await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
    });
  }catch(e){ console.warn('send login report failed', e); }

  return res.json({ ok:true, profile:p });
});

// ---- MODIFIED: api/login with password check + login notification ----
app.post('/api/login', async (req,res)=>{
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
      await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
      });
    }catch(e){ console.warn('send login notify failed', e); }
  })();

  return res.json({ ok:true, profile:p });
});

app.get('/api/profile/:personal', (req,res)=>{
  const p = findProfileByPersonal(req.params.personal);
  if(!p) return res.status(404).json({ ok:false, error:'not found' });
  res.json({ ok:true, profile:p });
});

// ---- API: profile edit request handled via telegram (admin replies to approve) ----
app.post('/api/profile/request-edit', async (req,res)=>{
  const { personal } = req.body;
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  const prof = ensureProfile(personal);
  const text = `طلب تعديل بيانات المستخدم:\nالاسم: ${prof.name || 'غير معروف'}\nالرقم الشخصي: ${prof.personalNumber}\n(اكتب "تم" كرد هنا للموافقة على التعديل لمرة واحدة)`;
  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
    });
    const data = await r.json();
    if(data && data.ok){
      // حفظ رسالة البوت لربط الرد بها لاحقاً
      DB.profileEditRequests[String(data.result.message_id)] = String(prof.personalNumber);
      saveData(DB);
      return res.json({ ok:true, msgId: data.result.message_id });
    }
  }catch(e){ console.warn('profile request send error', e); }
  return res.json({ ok:false });
});

// ---- API: submit profile edit once ----
app.post('/api/profile/submit-edit', (req,res)=>{
  const { personal, name, email, phone, password } = req.body;
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });

  const prof = findProfileByPersonal(personal);
  if(!prof) return res.status(404).json({ ok:false, error:'not found' });

  if(prof.canEdit !== true){
    return res.status(403).json({ ok:false, error:'edit_not_allowed' });
  }

  // تحديث البيانات
  if(name) prof.name = name;
  if(email) prof.email = email;
  if(phone) prof.phone = phone;
  if(password) prof.password = password;

  // إلغاء صلاحية التعديل بعد الحفظ
  prof.canEdit = false;
  saveData(DB);

  return res.json({ ok:true, profile: prof });
});

// ---- API: submit help ticket ----
app.post('/api/help', async (req,res)=>{
  const { personal, issue, fileLink, desc, name, email, phone } = req.body;
  const prof = ensureProfile(personal);
  const text = `مشكلة من المستخدم:\nالاسم: ${name || prof.name || 'غير معروف'}\nالرقم الشخصي: ${personal}\nالهاتف: ${phone || prof.phone || 'لا يوجد'}\nالبريد: ${email || prof.email || 'لا يوجد'}\nالمشكلة: ${issue}\nالوصف: ${desc || ''}\nرابط الملف: ${fileLink || 'لا يوجد'}`;

  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_HELP_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_HELP_CHAT, text })
    });
    const data = await r.json();
    return res.json({ ok:true, telegramResult: data });
  }catch(e){
    console.warn('help send error', e);
    return res.json({ ok:false, error: e.message || String(e) });
  }
});

// ---- API: create order (games or apps) ----
app.post('/api/orders', async (req,res)=>{
  const { personal, phone, type, item, idField, fileLink, cashMethod } = req.body;
  if(!personal || !type || !item) return res.status(400).json({ ok:false, error:'missing fields' });
  const prof = ensureProfile(personal);
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
    createdAt: new Date().toISOString()
  };
  DB.orders.unshift(order);
  saveData(DB);

  const text = `طلب شحن جديد:\n\nرقم شخصي: ${order.personalNumber}\nالهاتف: ${order.phone || 'لا يوجد'}\nالنوع: ${order.type}\nالتفاصيل: ${order.item}\nالايدي: ${order.idField || ''}\nطريقة الدفع: ${order.cashMethod || ''}\nرابط الملف: ${order.fileLink || ''}\nمعرف الطلب: ${order.id}`;

  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_ORDER_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_ORDER_CHAT, text })
    });
    const data = await r.json();
    if(data && data.ok && data.result && data.result.message_id){
      order.telegramMessageId = data.result.message_id;
      saveData(DB);
    }
  }catch(e){ console.warn('send order failed', e); }
  return res.json({ ok:true, order });
});

// ---- API: charge (طلب شحن رصيد) ----
app.post('/api/charge', async (req,res)=>{
  const { personal, phone, amount, method, fileLink } = req.body;
  if(!personal || !amount) return res.status(400).json({ ok:false, error:'missing fields' });
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
    const data = await r.json();
    if(data && data.ok && data.result && data.result.message_id){
      charge.telegramMessageId = data.result.message_id;
      saveData(DB);
    }
  }catch(e){ console.warn('send charge failed', e); }
  return res.json({ ok:true, charge });
});

// ---- API: offers acknowledgement (user pressed تحقق) ----
app.post('/api/offer/ack', async (req,res)=>{
  const { personal, offerId } = req.body;
  if(!personal || !offerId) return res.status(400).json({ ok:false, error:'missing' });
  const prof = ensureProfile(personal);
  const offer = DB.offers.find(o=>String(o.id)===String(offerId));
  const text = `لقد حصل على العرض او الهدية\nالرقم الشخصي: ${personal}\nالبريد: ${prof.email||'لا يوجد'}\nالهاتف: ${prof.phone||'لا يوجد'}\nالعرض: ${offer ? offer.text : 'غير معروف'}`;
  try{
    await fetch(`https://api.telegram.org/bot${CFG.BOT_OFFERS_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_OFFERS_CHAT, text })
    });
    return res.json({ ok:true });
  }catch(e){
    return res.json({ ok:false, error: String(e) });
  }
});

// ---- API: notifications / offers listing per user ----
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

// mark notifications as read for a user
app.post('/api/notifications/mark-read', (req,res)=>{
  const { personal } = req.body || {};
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  if(!DB.notifications) DB.notifications = [];
  DB.notifications.forEach(n => { if(String(n.personal) === String(personal)) n.read = true; });
  saveData(DB);
  return res.json({ ok:true });
});

// clear/delete all notifications for a user
app.post('/api/notifications/clear', (req,res)=>{
  const { personal } = req.body || {};
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  if(!DB.notifications) DB.notifications = [];
  DB.notifications = DB.notifications.filter(n => String(n.personal) !== String(personal));
  saveData(DB);
  return res.json({ ok:true });
});

// ---- Poll Telegram getUpdates (process admin replies) ----
async function pollTelegramForBot(botToken, handler){
  try{
    const last = DB.tgOffsets[botToken] || 0;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${last+1}&timeout=2`);
    const data = await res.json();
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
    const ord = DB.orders.find(o => o.telegramMessageId && Number(o.telegramMessageId) === Number(repliedId));
    if(ord){
      const low = text.toLowerCase();
      if(/^(تم|مقبول|accept)/i.test(low)){
        ord.status = 'تم قبول طلبك'; ord.replied = true; saveData(DB); return;
      } else if(/^(رفض|مرفوض|reject)/i.test(low)){
        ord.status = 'تم رفض طلبك'; ord.replied = true; saveData(DB); return;
      } else { ord.status = text; ord.replied = true; saveData(DB); return; }
    }
    const ch = DB.charges.find(c => c.telegramMessageId && Number(c.telegramMessageId) === Number(repliedId));
    if(ch){
      const m = text.match(/الرصيد[:\s]*([0-9]+)/i);
      const mPersonal = text.match(/الرقم الشخصي[:\s\-\(\)]*([0-9]+)/i);
      if(m && mPersonal){
        const amount = Number(m[1]); const personal = String(mPersonal[1]); const prof = findProfileByPersonal(personal);
        if(prof){ prof.balance = (prof.balance || 0) + amount; ch.status = 'تم تحويل الرصيد'; ch.replied = true; saveData(DB); }
      } else {
        if(/^(تم|مقبول|accept)/i.test(text)) { ch.status = 'تم شحن الرصيد'; ch.replied = true; saveData(DB); }
        else if(/^(رفض|مرفوض|reject)/i.test(text)) { ch.status = 'تم رفض الطلب'; ch.replied = true; saveData(DB); }
        else { ch.status = text; ch.replied = true; saveData(DB); }
      }
      return;
    }
    if(DB.profileEditRequests && DB.profileEditRequests[String(repliedId)]){
      const personal = DB.profileEditRequests[String(repliedId)];
      if(/^تم$/i.test(text.trim())){
        const p = findProfileByPersonal(personal);
        if(p){
          p.canEdit = true;
          // push a notification for the user
          if(!DB.notifications) DB.notifications = [];
          DB.notifications.unshift({
            id: String(Date.now()),
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
  if(/^عرض|^هدية/i.test(text)){
    const offerId = Date.now(); DB.offers.unshift({ id: offerId, text, createdAt: new Date().toISOString() }); saveData(DB);
  }
}

// poll wrapper
async function pollAllBots(){
  await pollTelegramForBot(CFG.BOT_ORDER_TOKEN, genericBotReplyHandler);
  await pollTelegramForBot(CFG.BOT_BALANCE_TOKEN, genericBotReplyHandler);
  await pollTelegramForBot(CFG.BOT_ADMIN_CMD_TOKEN, adminCmdHandler);
  await pollTelegramForBot(CFG.BOT_LOGIN_REPORT_TOKEN, genericBotReplyHandler);
  await pollTelegramForBot(CFG.BOT_HELP_TOKEN, genericBotReplyHandler);
  await pollTelegramForBot(CFG.BOT_OFFERS_TOKEN, genericBotReplyHandler);
}
setInterval(pollAllBots, 2500);

// ---- misc debug endpoints ----
app.get('/api/debug/db', (req,res)=> res.json({ ok:true, size: { profiles: DB.profiles.length, orders: DB.orders.length, charges: DB.charges.length, offers: DB.offers.length, notifications: (DB.notifications||[]).length }, tgOffsets: DB.tgOffsets || {} }));

// start server
app.listen(PORT, ()=> console.log('Server listening on', PORT));

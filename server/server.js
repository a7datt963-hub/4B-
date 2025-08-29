/**
 * server.js
 * سيرفر Express بسيط يخدم الواجهة ويعالج التليجرام bots polling
 * حفظ البيانات إلى data.json محلياً (خفيف، لبيئة الإنتاج استبدل بقاعدة بيانات)
 *
 * تعليمات: ضع متغيرات البوت في environment أو غيّر القيم الافتراضية هنا (غير آمن في الإنتاج)
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- إعدادات البوتات (يمكن وضعها في متغيرات بيئية على Render / Heroku) ----
const CFG = {
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || "8484157462:AAGHyBqwL9k1EmzvXAIZkb9UNDcwIGMINAs",
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || "7649409589",

  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || "8028609250:AAHXWR7PlZpBieM5Sx0oJI0dbUczxs9XJIg",
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
    return { profiles:[], orders:[], charges:[], offers:[], profileEditRequests:{}, blocked:[], tgOffsets:{} };
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

// serve static
app.use('/', express.static(path.join(__dirname, 'public')));

// ---- Simple file upload endpoint (optional) ----
const upload = multer({ dest: path.join(__dirname, 'uploads/') });
app.post('/api/upload', upload.single('file'), (req,res)=>{
  // returns local path (but we prefer imgbb upload from client)
  if(!req.file) return res.status(400).json({ ok:false, error:'no file' });
  res.json({ ok:true, path:`/uploads/${req.file.filename}`, original:req.file.originalname });
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
  const text = `تسجيل مستخدم جديد:
الاسم: ${p.name}
البريد: ${p.email || 'لا يوجد'}
الهاتف: ${p.phone || 'لا يوجد'}
الرقم الشخصي: ${p.personalNumber}
كلمة السر: ${p.password || '---'}`;

  try{
    await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
    });
  }catch(e){ console.warn('send login report failed', e); }

  return res.json({ ok:true, profile:p });
});

app.post('/api/login', (req,res)=>{
  const { personalNumber, email } = req.body;
  let p = null;
  if(personalNumber) p = findProfileByPersonal(personalNumber);
  else if(email) p = DB.profiles.find(x => x.email === email) || null;
  if(!p) return res.status(404).json({ ok:false, error:'not found' });
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
  const text = `طلب تعديل بيانات المستخدم:
الاسم: ${prof.name || 'غير معروف'}
الرقم الشخصي: ${prof.personalNumber}
(اكتب "تم" كرد هنا للموافقة على التعديل لمرة واحدة)`;
  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
    });
    const data = await r.json();
    if(data && data.ok){
      DB.profileEditRequests[String(data.result.message_id)] = String(prof.personalNumber);
      saveData(DB);
      return res.json({ ok:true, msgId: data.result.message_id });
    }
  }catch(e){ console.warn('profile request send error', e); }
  return res.json({ ok:false });
});

// ---- API: submit help ticket ----
app.post('/api/help', async (req,res)=>{
  const { personal, issue, fileLink, desc, name, email, phone } = req.body;
  const prof = ensureProfile(personal);
  const text = `مشكلة من المستخدم:
الاسم: ${name || prof.name || 'غير معروف'}
الرقم الشخصي: ${personal}
الهاتف: ${phone || prof.phone || 'لا يوجد'}
البريد: ${email || prof.email || 'لا يوجد'}
المشكلة: ${issue}
الوصف: ${desc || ''}
رابط الملف: ${fileLink || 'لا يوجد'}`;

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

  // send message to orders bot
  const text = `طلب شحن جديد:

رقم شخصي: ${order.personalNumber}
الهاتف: ${order.phone || 'لا يوجد'}
النوع: ${order.type}
التفاصيل: ${order.item}
الايدي: ${order.idField || ''}
طريقة الدفع: ${order.cashMethod || ''}
رابط الملف: ${order.fileLink || ''}
معرف الطلب: ${order.id}`;

  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_ORDER_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_ORDER_CHAT, text })
    });
    const data = await r.json();
    if(data && data.ok && data.result && data.result.message_id){
      order.telegramMessageId = data.result.message_id;
      saveData(DB);
    }
  }catch(e){
    console.warn('send order failed', e);
  }
  // return success
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

  // send to balance bot
  const text = `طلب شحن رصيد:

رقم شخصي: ${personal}
الهاتف: ${charge.phone || 'لا يوجد'}
المبلغ: ${amount}
طريقة الدفع: ${method}
رابط الملف: ${fileLink || ''}
معرف الطلب: ${chargeId}`;

  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text })
    });
    const data = await r.json();
    if(data && data.ok && data.result && data.result.message_id){
      charge.telegramMessageId = data.result.message_id;
      saveData(DB);
    }
  }catch(e){
    console.warn('send charge failed', e);
  }
  return res.json({ ok:true, charge });
});

// ---- API: offers acknowledgement (user pressed تحقق) ----
app.post('/api/offer/ack', async (req,res)=>{
  const { personal, offerId } = req.body;
  if(!personal || !offerId) return res.status(400).json({ ok:false, error:'missing' });
  const prof = ensureProfile(personal);
  const offer = DB.offers.find(o=>String(o.id)===String(offerId));
  const text = `لقد حصل على العرض او الهدية
الرقم الشخصي: ${personal}
البريد: ${prof.email||'لا يوجد'}
الهاتف: ${prof.phone||'لا يوجد'}
العرض: ${offer ? offer.text : 'غير معروف'}`;
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
  // offers visible to users with 7-digit personal numbers (we generate 7-digit numbers)
  const is7 = String(personal).length === 7;
  const visibleOffers = is7 ? DB.offers : [];
  // unread charges/orders messages targeting this user:
  const userOrders = DB.orders.filter(o => String(o.personalNumber)===String(personal));
  const userCharges = DB.charges.filter(c => String(c.personalNumber)===String(personal));
  return res.json({ ok:true, profile:prof, offers: visibleOffers, orders:userOrders, charges:userCharges });
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

// handler: for admin command bot (BOT_ADMIN_CMD_TOKEN) we accept "حظر" / "الغاء الحظر"
async function adminCmdHandler(update){
  if(!update.message || !update.message.text) return;
  const text = String(update.message.text || '').trim();
  // حظر\nالرقم الشخصي:xxxxx
  if(/^حظر/i.test(text)){
    const m = text.match(/الرقم الشخصي[:\s]*([0-9]+)/i);
    if(m){
      const num = m[1];
      if(!DB.blocked.includes(String(num))){
        DB.blocked.push(String(num));
        saveData(DB);
      }
      console.log('blocked', num);
    }
    return;
  }
  if(/^الغاء الحظر/i.test(text) || /^إلغاء الحظر/i.test(text)){
    const m = text.match(/الرقم الشخصي[:\s]*([0-9]+)/i);
    if(m){
      const num = m[1];
      DB.blocked = DB.blocked.filter(x => x !== String(num));
      saveData(DB);
    }
    return;
  }
}

// handler: admin replies on order messages (for BOT_ORDER_TOKEN and BOT_BALANCE_TOKEN)
async function genericBotReplyHandler(update){
  if(!update.message) return;
  const msg = update.message;
  const text = String(msg.text || '').trim();
  // if it's a reply to a bot message -> check reply_to_message.message_id to find mapped order/charge
  if(msg.reply_to_message && msg.reply_to_message.message_id){
    const repliedId = msg.reply_to_message.message_id;
    // search in orders
    const ord = DB.orders.find(o => o.telegramMessageId && Number(o.telegramMessageId) === Number(repliedId));
    if(ord){
      // admin's message could be: "تم" or "رفض" or "الرصيد: 12000 ... الرقم الشخصي:(...)" etc
      const low = text.toLowerCase();
      if(/^(تم|مقبول|accept)/i.test(low)){
        ord.status = 'تم قبول طلبك';
        ord.replied = true;
        saveData(DB);
        console.log('order accepted', ord.id);
        // add personal message
        // (we don't send direct message back to user by telegram here; we just update DB and counting)
      } else if(/^(رفض|مرفوض|reject)/i.test(low)){
        ord.status = 'تم رفض طلبك';
        ord.replied = true;
        saveData(DB);
      } else {
        // any other text -> set as reply text
        ord.status = text;
        ord.replied = true;
        saveData(DB);
      }
      return;
    }
    // search in charges
    const ch = DB.charges.find(c => c.telegramMessageId && Number(c.telegramMessageId) === Number(repliedId));
    if(ch){
      // check special "الرصيد:" pattern
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
          console.log(`credited ${amount} to ${personal}`);
        }
      } else {
        // simple accept/deny
        if(/^(تم|مقبول|accept)/i.test(text)) { ch.status = 'تم شحن الرصيد'; ch.replied = true; saveData(DB); }
        else if(/^(رفض|مرفوض|reject)/i.test(text)) { ch.status = 'تم رفض الطلب'; ch.replied = true; saveData(DB); }
        else { ch.status = text; ch.replied = true; saveData(DB); }
      }
      return;
    }

    // profile edit requests (if reply_to_message.message_id in DB.profileEditRequests)
    if(DB.profileEditRequests && DB.profileEditRequests[String(repliedId)]){
      const personal = DB.profileEditRequests[String(repliedId)];
      if(/^تم$/i.test(text.trim())){
        const p = findProfileByPersonal(personal);
        if(p){ p.canEdit = true; saveData(DB); }
        // remove mapping
        delete DB.profileEditRequests[String(repliedId)];
        saveData(DB);
      } else {
        // if denied or other text -> just delete mapping
        delete DB.profileEditRequests[String(repliedId)];
        saveData(DB);
      }
      return;
    }
  }

  // Also process direct messages that start with "عرض" or "هدية" to store offers
  if(/^عرض|^هدية/i.test(text)){
    const offerId = Date.now();
    DB.offers.unshift({ id: offerId, text, createdAt: new Date().toISOString() });
    saveData(DB);
  }
}

// poll wrapper runs for all relevant bots
async function pollAllBots(){
  try{
    // admin commands bot
    await pollTelegramForBot(CFG.BOT_ADMIN_CMD_TOKEN, adminCmdHandler);
    // orders bot & balance bot & help bot & offers bot generic handler (replies)
    await pollTelegramForBot(CFG.BOT_ORDER_TOKEN, genericBotReplyHandler);
    await pollTelegramForBot(CFG.BOT_BALANCE_TOKEN, genericBotReplyHandler);
    await pollTelegramForBot(CFG.BOT_LOGIN_REPORT_TOKEN, genericBotReplyHandler);
    await pollTelegramForBot(CFG.BOT_HELP_TOKEN, genericBotReplyHandler);
    await pollTelegramForBot(CFG.BOT_OFFERS_TOKEN, genericBotReplyHandler);
  }catch(e){ console.warn('pollAllBots error', e); }
}

// run polling every 3-6 seconds
setInterval(pollAllBots, 5000);

// also expose manual poll endpoint
app.post('/api/poll', async (req,res)=>{
  await pollAllBots();
  res.json({ ok:true });
});

// ---- administrative endpoints (debug) ----
app.get('/api/debug/db', (req,res)=> res.json(DB));
app.post('/api/debug/clear-updates', (req,res)=>{ DB.tgOffsets = {}; saveData(DB); res.json({ok:true}); });

// start server
app.listen(PORT, ()=> {
  console.log(`Server listening on ${PORT}`);
  // ensure public folder path for express static
  // create data file if missing
  DB = loadData();
  console.log('DB loaded items:', DB.profiles.length, 'profiles');
});

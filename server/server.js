// server.js
// تثبيت الحزم: npm install express dotenv
// تشغيل: node server.js

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- CONFIG (يفضل وضع القيم في بيئة الاستضافة، لكن يقرأ من env هنا) ----------
const CONFIG = {
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASS: process.env.ADMIN_PASS || 'nimda',

  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || '',
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || '',

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

  BOT_ADMIN_CMD_TOKEN: process.env.BOT_ADMIN_CMD_TOKEN || '',
  BOT_ADMIN_CMD_CHAT: process.env.BOT_ADMIN_CMD_CHAT || '',
};

// ---------- DB helpers ----------
function loadDB(){
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e){ return { profiles: [], orders: [], charges: [], logs: [] }; }
}
function saveDB(db){
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}
if(!fs.existsSync(DB_FILE)) saveDB({ profiles: [], orders: [], charges: [], logs: [] });
function makeId(prefix='id'){ return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8); }

// ---------- Admin SSE (Server-Sent Events) ----------
const sseClients = new Map(); // token -> [res, ...]   (token may be same for multiple tabs)

function registerSSE(token, res){
  if(!sseClients.has(token)) sseClients.set(token, []);
  sseClients.get(token).push(res);
  // cleanup on client close
  reqOnClose(res, () => {
    const arr = sseClients.get(token) || [];
    const idx = arr.indexOf(res);
    if(idx !== -1) arr.splice(idx,1);
    if(arr.length === 0) sseClients.delete(token);
  });
}

function reqOnClose(res, cb){
  res.on('close', cb);
  res.on('finish', cb);
}

// broadcast helper (sends payload to all admin SSE clients)
function broadcastToAdmins(eventType, payload){
  const msg = JSON.stringify({ event: eventType, payload, ts: Date.now() });
  for(const [token, resList] of sseClients.entries()){
    resList.forEach(res => {
      try{
        res.write(`event: ${eventType}\n`);
        res.write(`data: ${msg}\n\n`);
      }catch(e){ /* ignore individual client errors */ }
    });
  }
}

// ---------- Telegram helper (sends to telegram & broadcasts to admin SSE + logs) ----------
async function tgSend(token, chatId, text){
  // broadcast locally to admins first (immediate)
  broadcastToAdmins('telegram', { text, chatId, tokenPresent: !!token });

  // save to logs
  const db1 = loadDB();
  db1.logs = db1.logs || [];
  db1.logs.unshift({ id: makeId('log'), type: 'telegram', text, chatId, when: Date.now() });
  if(db1.logs.length > 1000) db1.logs.length = 1000;
  saveDB(db1);

  // send to telegram if token+chatId provided
  if(!token || !chatId) return;
  try{
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type':'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  }catch(err){
    console.warn('tg send failed', err);
    // broadcast failure to admins
    broadcastToAdmins('telegram_error', { text, error: String(err) });
  }
}

// ---------- Serve frontends (files must exist) ----------
app.get(['/','/app'], (req,res) => {
  const f = path.join(__dirname, '12 الضهر.html');
  if(!fs.existsSync(f)) return res.status(404).send('12 الضهر.html not found');
  res.sendFile(f);
});
app.get('/admin', (req,res) => {
  const f = path.join(__dirname, 'admin.html');
  if(!fs.existsSync(f)) return res.status(404).send('admin.html not found');
  res.sendFile(f);
});

// ---------- Public API endpoints ----------
app.post('/api/order', async (req,res) => {
  const db = loadDB();
  const o = {
    id: makeId('order'),
    createdAt: Date.now(),
    type: req.body.type || 'شحن',
    item: req.body.item || '',
    personalNumber: req.body.personalNumber || '',
    phone: req.body.phone || '',
    email: req.body.email || '',
    paidWithBalance: !!req.body.paidWithBalance,
    paidAmount: Number(req.body.paidAmount || 0),
    status: 'قيد المراجعة'
  };
  db.orders = db.orders || [];
  db.orders.unshift(o);
  saveDB(db);

  // notify telegram and admin SSE
  await tgSend(CONFIG.BOT_ORDER_TOKEN, CONFIG.BOT_ORDER_CHAT,
    `📦 طلب جديد #${o.id}\nالنوع: ${o.type}\nالزبون: ${o.personalNumber}\nالعنصر: ${o.item}\nالمبلغ: ${o.paidAmount}`);

  // broadcast order-created
  broadcastToAdmins('order_created', o);

  res.json({ ok:true, order: o });
});

app.get('/api/orders', (req,res) => {
  const db = loadDB();
  res.json({ ok:true, orders: db.orders || [] });
});

// simple login/register for users (frontend should call)
app.post('/api/login', async (req,res) => {
  const db = loadDB();
  const { name, personalNumber, email, password } = req.body;
  let p = db.profiles.find(x => x.personalNumber === personalNumber);
  if(!p){
    p = { id: makeId('u'), name, personalNumber, email, password, balance: 0, lastLogin: Date.now() };
    db.profiles.push(p);
  }else{
    p.lastLogin = Date.now();
    if(name) p.name = name;
    if(email) p.email = email;
    if(password) p.password = password;
  }
  saveDB(db);

  // notify admin about login
  await tgSend(CONFIG.BOT_LOGIN_REPORT_TOKEN, CONFIG.BOT_LOGIN_REPORT_CHAT,
    `👤 دخول/تسجيل: ${p.name} (${p.personalNumber})`);

  broadcastToAdmins('user_login', { id: p.id, name: p.name, personalNumber: p.personalNumber, lastLogin: p.lastLogin });

  res.json({ ok:true, profile: p });
});

// ---------- Admin logic (auth, data, SSE stream) ----------
const ADMIN_SESS = {}; // token -> {exp}

function makeAdminToken(){ return makeId('adm'); }
function verifyAdminToken(tok){ return !!(tok && ADMIN_SESS[tok] && Date.now() < ADMIN_SESS[tok].exp); }
function requireAdmin(req,res,next){
  const tok = req.headers['x-admin-token'] || req.query.adminToken || req.body.adminToken;
  if(!verifyAdminToken(tok)) return res.status(401).json({ ok:false, error:'unauthorized' });
  req.adminToken = tok;
  next();
}

// admin login
app.post('/api/admin/login', (req,res) => {
  const { username, password } = req.body || {};
  if(username !== CONFIG.ADMIN_USER || password !== CONFIG.ADMIN_PASS) return res.status(401).json({ ok:false, error:'invalid' });
  const tok = makeAdminToken();
  ADMIN_SESS[tok] = { exp: Date.now() + 1000*60*60*12 }; // 12 hours
  res.json({ ok:true, token: tok, expiresAt: ADMIN_SESS[tok].exp });
});

// admin logout
app.post('/api/admin/logout', requireAdmin, (req,res) => {
  const t = req.headers['x-admin-token'] || req.body.token;
  if(t && ADMIN_SESS[t]) delete ADMIN_SESS[t];
  res.json({ ok:true });
});

// admin profiles (sensitive)
app.get('/api/admin/profiles', requireAdmin, (req,res) => {
  const db = loadDB();
  res.json({ ok:true, profiles: db.profiles || [] });
});

// admin orders
app.get('/api/admin/orders', requireAdmin, (req,res) => {
  const db = loadDB();
  let list = db.orders || [];
  if(req.query.status) list = list.filter(o => String(o.status || '') === String(req.query.status));
  res.json({ ok:true, orders: list });
});
app.post('/api/admin/order/:id/status', requireAdmin, async (req,res) => {
  const db = loadDB();
  const order = (db.orders || []).find(o => o.id === req.params.id);
  if(!order) return res.status(404).json({ ok:false, error:'notfound' });
  order.status = req.body.status || order.status;
  order.note = req.body.note || order.note || '';
  order.repliedAt = Date.now();
  saveDB(db);

  // notify telegram + admins
  await tgSend(CONFIG.BOT_ORDER_TOKEN, CONFIG.BOT_ORDER_CHAT,
    `📌 تحديث طلب #${order.id}\nالحالة: ${order.status}\nملاحظة: ${order.note || '-'}`);
  broadcastToAdmins('order_updated', order);

  res.json({ ok:true, order });
});

// admin summary
app.get('/api/admin/summary', requireAdmin, (req,res) => {
  const db = loadDB();
  const totalUsers = (db.profiles || []).length;
  const totalBalance = (db.profiles || []).reduce((s,p)=> s + (Number(p.balance||0)), 0);
  const totalSpent = (db.orders || []).reduce((s,o)=> s + (Number(o.paidAmount||0)), 0);
  res.json({ ok:true, totalUsers, totalBalance, totalSpent });
});

// admin logins
app.get('/api/admin/logins', requireAdmin, (req,res) => {
  const db = loadDB();
  const list = (db.profiles || []).map(p => ({ name: p.name, personalNumber: p.personalNumber, lastLogin: p.lastLogin || null }));
  res.json({ ok:true, logins: list });
});

// admin SSE stream (use token in query param because EventSource doesn't allow headers)
app.get('/api/admin/stream', (req,res) => {
  const token = req.query.token;
  if(!verifyAdminToken(token)) return res.status(401).send('unauthorized');
  // setup SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');
  // register
  if(!sseClients.has(token)) sseClients.set(token, []);
  sseClients.get(token).push(res);
  // send a ping/welcome
  res.write(`event: welcome\n`);
  res.write(`data: ${JSON.stringify({ msg:'connected', ts: Date.now() })}\n\n`);

  reqOnClose(res, ()=> {
    const arr = sseClients.get(token) || [];
    const idx = arr.indexOf(res);
    if(idx !== -1) arr.splice(idx,1);
    if(arr.length === 0) sseClients.delete(token);
  });
});

// ---------- Additional convenience endpoints that also broadcast ----------
app.post('/api/notify', async (req,res) => {
  const text = req.body.text || req.query.text || 'empty';
  await tgSend(CONFIG.BOT_NOTIFY_TOKEN, CONFIG.BOT_NOTIFY_CHAT, text);
  res.json({ ok:true });
});
app.post('/api/help', async (req,res) => {
  const text = `Help: ${req.body.message||req.query.message||'-'} from ${req.body.user||req.query.user||'unknown'}`;
  await tgSend(CONFIG.BOT_HELP_TOKEN, CONFIG.BOT_HELP_CHAT, text);
  res.json({ ok:true });
});
app.post('/api/offers', async (req,res) => {
  const title = req.body.title || req.query.title || 'عرض';
  await tgSend(CONFIG.BOT_OFFERS_TOKEN, CONFIG.BOT_OFFERS_CHAT, `🎁 ${title}`);
  res.json({ ok:true });
});
app.post('/api/balance', async (req,res) => {
  const db = loadDB();
  const { personalNumber, amount } = req.body;
  const user = (db.profiles||[]).find(p=>p.personalNumber===personalNumber);
  if(!user) return res.json({ ok:false, error:'user not found' });
  user.balance = (Number(user.balance||0) + Number(amount||0));
  saveDB(db);
  await tgSend(CONFIG.BOT_BALANCE_TOKEN, CONFIG.BOT_BALANCE_CHAT,
    `💰 تحديث رصيد ${user.name} (${personalNumber}): +${amount}\nالرصيد الجديد: ${user.balance}`);
  broadcastToAdmins('balance_updated', { personalNumber, amount, newBalance: user.balance });
  res.json({ ok:true, user });
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`- App: /app`);
  console.log(`- Admin UI: /admin`);
  console.log(`- Admin SSE: /api/admin/stream?token=...`);
});

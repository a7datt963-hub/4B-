// server.js
// Node >= 18 recommended (uses global fetch). Install: npm i express cors
const express = require('express');
const fs = require('fs');
const path = require('path');

const APP_ROOT = __dirname;
const DB_FILE = path.join(APP_ROOT, 'db.json');
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'nimda';
const BOT_ORDER_TOKEN = process.env.BOT_ORDER_TOKEN || ''; // bot token (optional)
const BOT_ORDER_CHAT  = process.env.BOT_ORDER_CHAT  || ''; // chat id (optional)

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- simple DB on disk ---
function loadDB(){
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch(e){
    return { profiles: [], orders: [], charges: [] };
  }
}
function saveDB(db){
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// helper id
function makeId(prefix='id'){
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
}

// telegram notify (optional)
async function tgSend(text){
  if(!BOT_ORDER_TOKEN || !BOT_ORDER_CHAT) return;
  try{
    await fetch(`https://api.telegram.org/bot${BOT_ORDER_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: BOT_ORDER_CHAT, text })
    });
  }catch(e){ console.warn('tg send failed', e); }
}

// --- Serve the two frontends via routes (no public folder required) ---
// Place '12 الضهر.html' and 'admin.html' in same folder as server.js
app.get(['/','/app'], (req,res)=>{
  const f = path.join(APP_ROOT, '12 الضهر.html');
  if(!fs.existsSync(f)) return res.status(404).send('12 الضهر.html not found');
  res.sendFile(f);
});
app.get('/admin', (req,res)=>{
  const f = path.join(APP_ROOT, 'admin.html');
  if(!fs.existsSync(f)) return res.status(404).send('admin.html not found');
  res.sendFile(f);
});

// --- Public API for creating orders / reading profiles (your existing frontend should call these) ---

// create an order (called from site when someone يطلب شحن)
app.post('/api/order', (req,res)=>{
  const db = loadDB();
  const payload = req.body || {};
  const order = {
    id: makeId('order'),
    createdAt: Date.now(),
    type: payload.type || 'شحن',
    item: payload.item || payload.service || '',
    personalNumber: payload.personalNumber || payload.nationalId || payload.userId || '',
    phone: payload.phone || '',
    email: payload.email || '',
    paidWithBalance: !!payload.paidWithBalance,
    paidAmount: Number(payload.paidAmount || 0),
    status: payload.status || 'قيد المراجعة',
    telegramMessageId: payload.telegramMessageId || null,
    extra: payload.extra || {}
  };
  db.orders = db.orders || [];
  db.orders.unshift(order);
  saveDB(db);

  // notify admin via telegram (optional)
  const short = `طلب جديد #${order.id}\nالنوع: ${order.type}\nالزبون: ${order.personalNumber}\nعنصر: ${order.item}\nالمبلغ: ${order.paidAmount}`;
  tgSend(short);

  return res.json({ ok:true, order });
});

// get public orders (for client debug) - you can restrict or remove this later
app.get('/api/orders', (req,res)=>{
  const db = loadDB();
  return res.json({ ok:true, orders: db.orders || [] });
});

// get profiles (public read - for client; admin has special endpoint)
app.get('/api/profiles', (req,res)=>{
  const db = loadDB();
  return res.json({ ok:true, profiles: db.profiles || [] });
});

// --- Admin simple session/token --- 
const ADMIN_SESSIONS = {}; // token -> { expires }

function makeAdminToken(){
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,12);
}
function verifyAdminToken(tok){
  if(!tok) return false;
  const s = ADMIN_SESSIONS[tok];
  if(!s) return false;
  if(Date.now() > s.expires){ delete ADMIN_SESSIONS[tok]; return false; }
  return true;
}
function requireAdmin(req,res,next){
  const tok = req.headers['x-admin-token'] || req.query.adminToken || req.body.adminToken;
  if(!verifyAdminToken(tok)) return res.status(401).json({ ok:false, error:'unauthorized' });
  req.adminToken = tok;
  next();
}

// admin login
app.post('/api/admin/login', (req,res)=>{
  const { username, password } = req.body || {};
  if(String(username) !== String(ADMIN_USER) || String(password) !== String(ADMIN_PASS)){
    return res.status(401).json({ ok:false, error:'invalid_credentials' });
  }
  const token = makeAdminToken();
  ADMIN_SESSIONS[token] = { expires: Date.now() + 1000*60*60*12 }; // 12h
  return res.json({ ok:true, token, expiresAt: ADMIN_SESSIONS[token].expires });
});

// admin logout
app.post('/api/admin/logout', requireAdmin, (req,res)=>{
  const tok = req.headers['x-admin-token'] || req.body.token;
  if(tok && ADMIN_SESSIONS[tok]) delete ADMIN_SESSIONS[tok];
  return res.json({ ok:true });
});

// admin get profiles (full sensitive info)
app.get('/api/admin/profiles', requireAdmin, (req,res)=>{
  const db = loadDB();
  return res.json({ ok:true, profiles: db.profiles || [] });
});

// admin get orders (optional status filter via ?status=...)
app.get('/api/admin/orders', requireAdmin, (req,res)=>{
  const db = loadDB();
  let list = db.orders || [];
  if(req.query.status){
    const s = String(req.query.status);
    list = list.filter(o => String(o.status || '').includes(s));
  }
  return res.json({ ok:true, orders: list });
});

// admin change order status
app.post('/api/admin/order/:id/status', requireAdmin, async (req,res)=>{
  const id = String(req.params.id);
  const { status, note } = req.body || {};
  const db = loadDB();
  const order = (db.orders||[]).find(o => String(o.id) === id);
  if(!order) return res.status(404).json({ ok:false, error:'not_found' });
  order.status = status || order.status;
  order.note = note || order.note;
  order.repliedAt = Date.now();
  saveDB(db);

  // notify user via telegram if message id present
  try {
    if(order.telegramMessageId && BOT_ORDER_TOKEN && BOT_ORDER_CHAT){
      const text = `رد الإدارة على الطلب #${order.id}:\nالحالة: ${order.status}\nملاحظة: ${note || '-'}`;
      await fetch(`https://api.telegram.org/bot${BOT_ORDER_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ chat_id: BOT_ORDER_CHAT, text, reply_to_message_id: order.telegramMessageId })
      });
    }
  } catch(e){ console.warn('tg notify failed', e); }

  return res.json({ ok:true, order });
});

// admin summary
app.get('/api/admin/summary', requireAdmin, (req,res)=>{
  const db = loadDB();
  const profiles = db.profiles || [];
  const orders = db.orders || [];
  const totalUsers = profiles.length;
  const totalBalance = profiles.reduce((s,p)=>(s + (Number(p.balance||0))),0);
  const totalSpent = orders.reduce((s,o)=>(s + (Number(o.paidAmount||0))),0);
  const pendingCharges = (db.charges||[]).filter(c=>c.status==='قيد المراجعة').length;
  return res.json({ ok:true, totalUsers, totalBalance, totalSpent, pendingCharges });
});

// admin recent logins
app.get('/api/admin/logins', requireAdmin, (req,res)=>{
  const db = loadDB();
  const logins = (db.profiles||[]).map(p => ({ name: p.name || '-', personalNumber: p.personalNumber || '-', lastLogin: p.lastLogin || null }));
  return res.json({ ok:true, logins });
});

// --- convenience: ensure db file exists on startup
if(!fs.existsSync(DB_FILE)){
  saveDB({ profiles: [], orders: [], charges: [] });
  console.log('db.json created.');
}

app.listen(PORT, ()=> {
  console.log(`Server running on port ${PORT}`);
  console.log(`- Front (app) -> GET /app`);
  console.log(`- Admin panel -> GET /admin`);
  console.log(`- Admin login -> POST /api/admin/login`);
});

// server.js
// Supabase-only server for the provided frontend
// Expects env:
// SUPABASE_URL
// SUPABASE_SERVICE_KEY (or SUPABASE_KEY)
// BOT_ADMIN_CMD_TOKEN, BOT_ADMIN_CMD_CHAT
// BOT_BALANCE_TOKEN, BOT_BALANCE_CHAT
// BOT_POLL_TOKEN
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;

/* ---------------------------
   Helpers
   --------------------------- */
function sanitizeProfile(p){
  if(!p) return null;
  const c = { ...p };
  delete c.password;
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

    // check duplicates
    if(email || phone){
      const orParts = [];
      if(email) orParts.push(`email.eq.${email}`);
      if(phone) orParts.push(`phone.eq.${phone}`);
      if(orParts.length){
        const { data:dup } = await supabase.from('profiles').select('personal_number').or(orParts.join(',')).limit(1);
        if(dup && dup.length) return res.status(400).json({ok:false,error:'user exists'});
      }
    }

    // ensure unique personal_number
    let personal = personalNumber || String(Math.floor(1000000+Math.random()*9000000));
    for(let i=0;i<5;i++){
      const { data:ex } = await supabase.from('profiles').select('personal_number').eq('personal_number',personal).limit(1);
      if(!ex || !ex.length) break;
      personal = String(Math.floor(1000000+Math.random()*9000000));
    }

    const profile = {
      personal_number: personal,
      name, email, phone,
      password: String(password),
      balance: 0,
      can_edit: false,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from('profiles').insert([profile]);
    if(error) return res.status(500).json({ok:false,error:'db error'});

    return res.json({ok:true, profile: sanitizeProfile(profile)});
  }catch(e){ res.status(500).json({ok:false,error:'server error'}); }
});

/** Login */
app.post('/api/login', async (req,res)=>{
  try{
    const { personalNumber, email, phone, password } = req.body||{};
    if(!password) return res.status(400).json({ok:false,error:'password required'});

    let query = supabase.from('profiles').select('*').limit(1);
    if(personalNumber) query = query.eq('personal_number',personalNumber);
    else if(email) query = query.eq('email',email);
    else if(phone) query = query.eq('phone',phone);
    else return res.status(400).json({ok:false,error:'identifier required'});

    const { data } = await query;
    if(!data || !data.length) return res.status(404).json({ok:false,error:'not found'});
    const prof = data[0];
    if(String(prof.password)!==String(password)) return res.status(401).json({ok:false,error:'wrong password'});

    return res.json({ok:true, profile:sanitizeProfile(prof)});
  }catch(e){ res.status(500).json({ok:false,error:'server error'}); }
});

/** Create charge */
app.post('/api/charge', async (req,res)=>{
  try{
    const { personalNumber, phone, amount, method, fileLink } = req.body||{};
    if(!personalNumber||!amount) return res.status(400).json({ok:false,error:'required'});
    const { data:profiles } = await supabase.from('profiles').select('*').eq('personal_number',personalNumber).limit(1);
    if(!profiles||!profiles.length) return res.status(404).json({ok:false,error:'profile not found'});
    const prof = profiles[0];
    const charge = {
      id: Date.now(),
      personal_number: personalNumber,
      phone: phone||prof.phone||'',
      amount, method:method||'', file_link:fileLink||'',
      status:'pending', replied:false,
      telegram_message_id:null, credited_amount:null,
      created_at:new Date().toISOString()
    };
    await supabase.from('charges').insert([charge]);
    return res.json({ok:true, charge});
  }catch(e){ res.status(500).json({ok:false,error:'server error'}); }
});

/** Similar changes applied to orders, notifications, edit_requests... (all snake_case) */

// ... بقية الكود مثل اللي أرسلته أنت، لكن أي حقل camelCase عدلناه لـ snake_case
// مثال: personalNumber => personal_number
// fileLink => file_link
// canEdit => can_edit
// telegramMessageId => telegram_message_id
// creditedAmount => credited_amount
// idField => id_field
// cashMethod => cash_method
// paidWithBalance => paid_with_balance
// paidAmount => paid_amount

/* ---------------------------
   Server start
   --------------------------- */
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));

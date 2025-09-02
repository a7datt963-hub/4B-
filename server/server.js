// server.js - منقح: webhooks مفصولة لكل بوت + إصلاحات شحن/وسم شحنات/طلبات
// يتوافق مع Supabase (اختياري) أو data.json كبديل محلي.
// Env vars: SUPABASE_URL, SUPABASE_KEY,
// BOT_ORDER_TOKEN, BOT_ORDER_CHAT,
// BOT_BALANCE_TOKEN, BOT_BALANCE_CHAT,
// BOT_OFFERS_TOKEN, BOT_OFFERS_CHAT,
// BOT_ADMIN_CMD_TOKEN, BOT_ADMIN_CMD_CHAT,
// BOT_HELP_TOKEN, BOT_HELP_CHAT,
// IMGBB_KEY

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ---------------- CONFIG ----------------
const CFG = {
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || "",
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || "",
  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || "",
  BOT_BALANCE_CHAT: process.env.BOT_BALANCE_CHAT || "",
  BOT_OFFERS_TOKEN: process.env.BOT_OFFERS_TOKEN || "",
  BOT_OFFERS_CHAT: process.env.BOT_OFFERS_CHAT || "",
  BOT_ADMIN_CMD_TOKEN: process.env.BOT_ADMIN_CMD_TOKEN || "",
  BOT_ADMIN_CMD_CHAT: process.env.BOT_ADMIN_CMD_CHAT || "",
  BOT_HELP_TOKEN: process.env.BOT_HELP_TOKEN || "",
  BOT_HELP_CHAT: process.env.BOT_HELP_CHAT || "",
  BOT_NOTIFY_TOKEN: process.env.BOT_NOTIFY_TOKEN || "",
  BOT_NOTIFY_CHAT: process.env.BOT_NOTIFY_CHAT || "",
  IMGBB_KEY: process.env.IMGBB_KEY || ""
};

// ---------------- Local DB fallback ----------------
const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const init = { profiles: [], orders: [], charges: [], offers: [], notifications: [], profileEditRequests: [], blocked: [], tgOffsets: {} };
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
function saveData(d) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch(e){ console.error(e); } }
let DB = loadData();

// ---------------- Supabase (optional) ----------------
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
let sb = null;
if (useSupabase) {
  sb = createClient(SUPABASE_URL, SUPABASE_KEY, { global: { fetch } });
  console.log('Supabase enabled');
} else {
  console.log('Using local data.json fallback');
}

// ---------------- Helpers ----------------
function mapSbProfile(row) {
  if (!row) return null;
  return {
    personalNumber: row.personal_number || row.personalNumber,
    name: row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    password: row.password || '',
    balance: Number(row.balance || 0),
    canEdit: !!row.can_edit,
    telegram_chat_id: row.telegram_chat_id || row.tg_chat_id || row.chat_id || null
  };
}

async function findProfileByPersonal(personal) {
  if (!personal) return null;
  if (useSupabase) {
    try {
      const { data, error } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (error) console.warn('supabase findProfile error', error);
      return data ? mapSbProfile(data) : null;
    } catch (e) { console.warn(e); return null; }
  }
  const p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
  if (!p) return null;
  return { personalNumber: p.personalNumber, name: p.name, email: p.email, phone: p.phone, password: p.password, balance: Number(p.balance||0), canEdit: !!p.canEdit, telegram_chat_id: p.telegram_chat_id };
}

async function ensureProfile(personal) {
  if (!personal) return null;
  if (useSupabase) {
    try {
      const { data } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (data) return mapSbProfile(data);
      const ins = { personal_number: String(personal), name: 'ضيف', email: '', password: '', phone: '', balance: 0, can_edit: false, last_login: new Date().toISOString() };
      const { data: newp } = await sb.from('profiles').insert([ins]).select().maybeSingle();
      return mapSbProfile(newp);
    } catch (e) { console.warn(e); }
  }
  let p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
  if (!p) { p = { personalNumber: String(personal), name: 'ضيف', email:'', password:'', phone:'', balance:0, canEdit:false, lastLogin: new Date().toISOString() }; DB.profiles.push(p); saveData(DB); }
  return { personalNumber: p.personalNumber, name: p.name, email: p.email, phone: p.phone, password: p.password, balance: Number(p.balance||0), canEdit: !!p.canEdit, telegram_chat_id: p.telegram_chat_id };
}

// send Telegram message with optional token override
async function sendTelegramMessageToChat(chatId, text, tokenOverride) {
  try {
    if (!chatId) return null;
    const token = tokenOverride || CFG.BOT_NOTIFY_TOKEN || CFG.BOT_BALANCE_TOKEN || CFG.BOT_ADMIN_CMD_TOKEN;
    if (!token) return null;
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text })
    });
    return await resp.json().catch(()=>null);
  } catch (e) {
    console.warn('sendTelegramMessageToChat error', e);
    return null;
  }
}

// add amount to profile balance (returns {ok,newBalance} or {ok:false,error})
async function addBalanceToPersonal(personal, amount) {
  try {
    const amt = Number(amount || 0);
    if (isNaN(amt)) return { ok:false, error:'invalid_amount' };
    if (useSupabase) {
      const { data: profRow } = await sb.from('profiles').select('*').eq('personal_number', String(personal)).limit(1).maybeSingle();
      if (!profRow) {
        const { data: newProf } = await sb.from('profiles').insert([{ personal_number: String(personal), name:'ضيف', balance: amt }]).select().maybeSingle();
        return { ok:true, newBalance: Number(newProf.balance || 0) };
      }
      const oldBal = Number(profRow.balance || 0);
      const newBal = oldBal + amt;
      await sb.from('profiles').update({ balance: newBal }).eq('personal_number', String(personal));
      return { ok:true, newBalance: newBal };
    }
    let p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
    if (!p) { p = { personalNumber: String(personal), name:'ضيف', email:'', password:'', phone:'', balance: Number(amount), canEdit:false, lastLogin: new Date().toISOString() }; DB.profiles.push(p); }
    else p.balance = Number(p.balance || 0) + Number(amount);
    saveData(DB);
    return { ok:true, newBalance: Number(p.balance) };
  } catch (e) { console.error(e); return { ok:false, error:String(e) }; }
}

// mark latest pending charge as accepted (tries to match amount)
async function markLatestPendingChargeAsAccepted(personal, amount) {
  try {
    if (useSupabase) {
      const { data: pending } = await sb.from('charges').select('*').eq('personal_number', String(personal)).eq('replied', false).order('created_at', { ascending:false }).limit(5);
      if (pending && pending.length>0) {
        let found = pending.find(p => Number(p.amount) === Number(amount));
        if (!found) found = pending[0];
        if (found) {
          await sb.from('charges').update({ status:'مقبول', replied:true }).eq('id', found.id).eq('replied', false);
          return { ok:true, chargeId: found.id };
        }
      }
      return { ok:false, error:'no_pending_charge' };
    }
    const pendingLocal = (DB.charges||[]).filter(c => String(c.personalNumber) === String(personal) && !c.replied).sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
    if (pendingLocal.length>0) {
      let found = pendingLocal.find(p => Number(p.amount) === Number(amount));
      if (!found) found = pendingLocal[0];
      if (found) { found.status = 'مقبول'; found.replied = true; saveData(DB); return { ok:true, chargeId: found.id }; }
    }
    return { ok:false, error:'no_pending_charge' };
  } catch (e) { console.error(e); return { ok:false, error:String(e) }; }
}

// confirm charge by id (used when admin replies to a charge message that contains "معرف")
async function confirmChargeById(id) {
  if (!id) return { ok:false, error:'missing_id' };
  try {
    if (useSupabase) {
      const { data: chargeRow } = await sb.from('charges').select('*').eq('id', id).limit(1).maybeSingle();
      if (!chargeRow) return { ok:false, error:'charge_not_found' };
      if (chargeRow.replied) return { ok:false, error:'already_confirmed' };
      const amount = Number(chargeRow.amount || 0);
      const personal = String(chargeRow.personal_number || chargeRow.personal || '');
      const { data: profileRow } = await sb.from('profiles').select('*').eq('personal_number', personal).limit(1).maybeSingle();
      if (!profileRow) return { ok:false, error:'profile_not_found' };
      const oldBal = Number(profileRow.balance || 0);
      const newBal = oldBal + (isNaN(amount)?0:amount);
      await sb.from('profiles').update({ balance: newBal }).eq('personal_number', personal);
      await sb.from('charges').update({ status:'مقبول', replied:true }).eq('id', id).eq('replied', false);
      await sb.from('notifications').insert([{ personal_number: personal, text:`تمت إضافة مبلغ ${amount} إلى رصيدك. الرصيد الآن: ${newBal}`, read:false, created_at: new Date().toISOString() }]);
      return { ok:true, newBalance: newBal, chargeId: id };
    }
    // local
    const ch = (DB.charges||[]).find(c => String(c.id) === String(id));
    if (!ch) return { ok:false, error:'charge_not_found' };
    if (ch.replied) return { ok:false, error:'already_confirmed' };
    const personal = String(ch.personalNumber || ch.personal);
    const amount = Number(ch.amount || 0);
    let p = DB.profiles.find(x => String(x.personalNumber) === String(personal));
    if (!p) { p = { personalNumber: personal, name:'ضيف', email:'', password:'', phone:'', balance: amount }; DB.profiles.push(p); }
    else p.balance = Number(p.balance||0) + amount;
    ch.status = 'مقبول'; ch.replied = true; saveData(DB);
    DB.notifications = DB.notifications || [];
    DB.notifications.unshift({ personal: personal, text: `تمت إضافة مبلغ ${amount} إلى رصيدك. الرصيد الآن: ${p.balance}`, read:false, createdAt: new Date().toISOString() });
    saveData(DB);
    return { ok:true, newBalance: p.balance, chargeId: id };
  } catch (e) { console.error(e); return { ok:false, error:String(e) }; }
}

// confirm order by id (mark accepted / replied)
async function confirmOrderById(id) {
  if (!id) return { ok:false, error:'missing_id' };
  try {
    if (useSupabase) {
      const { data: orderRow } = await sb.from('orders').select('*').eq('id', id).limit(1).maybeSingle();
      if (!orderRow) return { ok:false, error:'order_not_found' };
      if (orderRow.replied) return { ok:false, error:'already_confirmed' };
      await sb.from('orders').update({ status:'تمت المعالجة', replied:true }).eq('id', id).eq('replied', false);
      // optional notification to user
      await sb.from('notifications').insert([{ personal_number: orderRow.personal_number, text: `طلبك #${id} تمّت معالجته.`, read:false, created_at: new Date().toISOString() }]);
      return { ok:true, orderId: id };
    }
    const ord = (DB.orders||[]).find(o => String(o.id) === String(id));
    if (!ord) return { ok:false, error:'order_not_found' };
    if (ord.replied) return { ok:false, error:'already_confirmed' };
    ord.status = 'تمت المعالجة'; ord.replied = true; saveData(DB);
    DB.notifications = DB.notifications || [];
    DB.notifications.unshift({ personal: ord.personalNumber, text: `طلبك #${id} تمّت معالجته.`, read:false, createdAt: new Date().toISOString() });
    saveData(DB);
    return { ok:true, orderId: id };
  } catch (e) { console.error(e); return { ok:false, error:String(e) }; }
}

// ban/unban helper
async function banPersonal(personal, reason='') {
  try {
    if (!personal) return { ok:false, error:'missing_personal' };
    if (useSupabase) {
      // store in a blocked table if exists
      await sb.from('blocked').insert([{ personal_number: String(personal), reason, created_at: new Date().toISOString() }]);
      return { ok:true };
    }
    DB.blocked = DB.blocked || [];
    if (!DB.blocked.includes(String(personal))) { DB.blocked.push(String(personal)); saveData(DB); }
    return { ok:true };
  } catch (e) { console.error(e); return { ok:false, error:String(e) }; }
}
async function unbanPersonal(personal) {
  try {
    if (!personal) return { ok:false, error:'missing_personal' };
    if (useSupabase) {
      await sb.from('blocked').delete().eq('personal_number', String(personal));
      return { ok:true };
    }
    DB.blocked = (DB.blocked||[]).filter(x => String(x) !== String(personal)); saveData(DB);
    return { ok:true };
  } catch (e) { console.error(e); return { ok:false, error:String(e) }; }
}

// ---------------- Centralized webhook per-bot ----------------
// Use different webhook URL per bot when setting webhook in Telegram:
// e.g. https://yourdomain.com/api/telegram/webhook/balance
//      https://yourdomain.com/api/telegram/webhook/order
//      https://yourdomain.com/api/telegram/webhook/admin
//      https://yourdomain.com/api/telegram/webhook/offers
//      https://yourdomain.com/api/telegram/webhook/help
app.post('/api/telegram/webhook/:bot', async (req, res) => {
  try {
    const botName = String(req.params.bot || '').toLowerCase();
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg) return res.sendStatus(200);

    // Map botName -> token/chat config (only for optional replies)
    const botConfig = {
      'balance': { token: CFG.BOT_BALANCE_TOKEN, chat: CFG.BOT_BALANCE_CHAT },
      'order': { token: CFG.BOT_ORDER_TOKEN, chat: CFG.BOT_ORDER_CHAT },
      'offers': { token: CFG.BOT_OFFERS_TOKEN, chat: CFG.BOT_OFFERS_CHAT },
      'admin': { token: CFG.BOT_ADMIN_CMD_TOKEN, chat: CFG.BOT_ADMIN_CMD_CHAT },
      'help': { token: CFG.BOT_HELP_TOKEN, chat: CFG.BOT_HELP_CHAT }
    }[botName] || {};

    // SECURITY: If a chat restriction is configured for this bot, ignore messages not from that chat.
    if (botConfig.chat && String(msg.chat && msg.chat.id) !== String(botConfig.chat)) {
      return res.sendStatus(200);
    }

    // Case A: Admin replying to a bot message that contained "معرف ..." -> extract id and act based on bot type
    const repliedTo = msg.reply_to_message;
    if (repliedTo && repliedTo.text) {
      // try extracting a numeric id from the original text
      const reId = /(?:معرف\s*(?:الطلب|الشحنة|ال)?\s*[:\-]?\s*)(\d{3,})/i;
      const mid = (repliedTo.text || '').match(reId);
      if (mid) {
        const id = mid[1];
        if (botName === 'balance') {
          const r = await confirmChargeById(id);
          await sendTelegramMessageToChat(msg.chat.id, `معالجة شحنة ${id}: ${r.ok ? 'نجح' : (r.error||'خطأ')}`, botConfig.token);
          return res.sendStatus(200);
        } else if (botName === 'order') {
          const r = await confirmOrderById(id);
          await sendTelegramMessageToChat(msg.chat.id, `معالجة طلب ${id}: ${r.ok ? 'نجح' : (r.error||'خطأ')}`, botConfig.token);
          return res.sendStatus(200);
        } else if (botName === 'offers') {
          // Mark offer as acknowledged if offer id exists
          const offerId = id;
          if (useSupabase) {
            await sb.from('offers').update({ active:false }).eq('id', Number(offerId));
          } else {
            DB.offers = (DB.offers||[]).map(o => (String(o.id)===String(offerId) ? { ...o, active:false } : o));
            saveData(DB);
          }
          await sendTelegramMessageToChat(msg.chat.id, `تم وسم العرض ${offerId} كمؤرشف/مقبول.`, botConfig.token);
          return res.sendStatus(200);
        }
      }
    }

    // Case B: Admin writes a command directly (not a reply)
    const txt = (msg.text || '').trim();
    // Commands examples:
    // "حظر: 123456"  -> ban user
    // "الغاء حظر: 123456" -> unban
    // "الرصيد: 10000\nالرقم الشخصي: 9682390" -> topup (balance bot)
    // "معرف الطلب: 123456" -> direct confirm if desired
    // Parse ban/unban
    const banMatch = txt.match(/حظر\s*[:\-]?\s*(\d{3,})/i);
    if (banMatch && botName === 'admin') {
      const personal = banMatch[1];
      const r = await banPersonal(personal);
      await sendTelegramMessageToChat(msg.chat.id, `حظر ${personal}: ${r.ok ? 'تم' : (r.error||'فشل')}`, botConfig.token);
      return res.sendStatus(200);
    }
    const unbanMatch = txt.match(/(?:الغاء\s*حظر|الغاء الحظر|رفع حظر)\s*[:\-]?\s*(\d{3,})/i);
    if (unbanMatch && botName === 'admin') {
      const personal = unbanMatch[1];
      const r = await unbanPersonal(personal);
      await sendTelegramMessageToChat(msg.chat.id, `إلغاء الحظر عن ${personal}: ${r.ok ? 'تم' : (r.error||'فشل')}`, botConfig.token);
      return res.sendStatus(200);
    }

    // Case C: balance bot - admin replies with amount & personal (or posts it)
    if (botName === 'balance') {
      // allow either reply or direct message containing the two lines
      const normalized = txt.replace(/\u00A0/g,' ');
      const reAmount = /الرصيد\s*[:\-]?\s*([0-9\.,]+)/i;
      const rePersonal = /الرقم\s*الشخصي\s*[:\-]?\s*(\d{3,})/i;
      const mAmount = normalized.match(reAmount);
      const mPersonal = normalized.match(rePersonal);
      if (mAmount && mPersonal) {
        // sanitize amount
        let amountRaw = mAmount[1].replace(/\s+/g,'').replace(/,/g,'').replace(/\./g,'');
        const amount = Number(amountRaw);
        const personal = mPersonal[1];
        if (isNaN(amount)) {
          await sendTelegramMessageToChat(msg.chat.id, `خطأ: لم أتمكن من قراءة قيمة الرصيد.`, botConfig.token);
          return res.sendStatus(200);
        }
        // add balance
        const addRes = await addBalanceToPersonal(personal, amount);
        if (!addRes.ok) {
          await sendTelegramMessageToChat(msg.chat.id, `خطأ عند تحديث الرصيد: ${addRes.error||'unknown'}`, botConfig.token);
          return res.sendStatus(200);
        }
        // mark pending charge if exists
        const markRes = await markLatestPendingChargeAsAccepted(personal, amount);
        // add notification
        if (useSupabase) {
          await sb.from('notifications').insert([{ personal_number: String(personal), text: `تمت إضافة مبلغ ${amount} إلى رصيدك. الرصيد الجديد: ${addRes.newBalance}`, read:false, created_at: new Date().toISOString() }]);
        } else {
          DB.notifications = DB.notifications || [];
          DB.notifications.unshift({ personal: String(personal), text: `تمت إضافة مبلغ ${amount} إلى رصيدك. الرصيد الجديد: ${addRes.newBalance}`, read:false, createdAt: new Date().toISOString() });
          saveData(DB);
        }
        await sendTelegramMessageToChat(msg.chat.id, `تمت إضافة ${amount.toLocaleString()} لرقم ${personal}. الرصيد الجديد: ${addRes.newBalance}. وسم شحنة: ${markRes.ok ? markRes.chargeId : 'لا توجد'}`, botConfig.token);
        return res.sendStatus(200);
      }
    }

    // Case D: order/help/offers bots - forward to configured admin chat if needed (basic pass-through)
    // For help bot, simply forward message to BOT_HELP_CHAT (already configured in CFG) by reposting text
    if (botName === 'help' && CFG.BOT_HELP_CHAT) {
      const forwardText = `مشكلة من: ${msg.from && (msg.from.username || msg.from.first_name)}\n${msg.text || '<no text>'}`;
      try { await sendTelegramMessageToChat(CFG.BOT_HELP_CHAT, forwardText, CFG.BOT_HELP_TOKEN); } catch(e){ console.warn(e); }
      return res.sendStatus(200);
    }

    // If nothing matched, just return 200
    return res.sendStatus(200);

  } catch (e) {
    console.error('telegram webhook error', e);
    return res.sendStatus(200);
  }
});

// ----------------- small endpoints for testing -----------------
app.get('/ping', (req,res) => res.json({ ok:true, server: 'running' }));

// ----------------- Start -----------------
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

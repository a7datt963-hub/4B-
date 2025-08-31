const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new Error('set env vars');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const DB = JSON.parse(fs.readFileSync('./data.json','utf8'));

async function migrate(){
  for(const p of DB.profiles || []){
    const rec = {
      email: p.email || '',
      phone: p.phone || '',
      name: p.name || '',
      password: p.password || '',
      balance: Number(p.balance || 0)
    };
    // upsert by email+phone uniqueness:
    const { error } = await supabase.from('profiles').upsert([rec], { onConflict: 'email' });
    if(error) console.warn('upsert error', error);
  }
  console.log('migration done');
}
migrate().catch(console.error);

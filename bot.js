require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fetch   = require('node-fetch');
const fs      = require('fs');
const http    = require('http');
const path    = require('path');
const PORT    = process.env.PORT || 3000;

// ===================== WEB SERVER =====================
function serveHttp(req, res) {
  const url = req.url.split('?')[0];

  // API: get all data
  if (url === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(fs.readFileSync(DATA_FILE));
    return;
  }

  // API: save all data
  if (url === '/api/data' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        fs.writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2));
        db = parsed;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end('{"ok":true}');
      } catch(e) {
        res.writeHead(400); res.end('Bad JSON');
      }
    });
    return;
  }

  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // Serve index.html
  const file = path.join(__dirname, 'index.html');
  if (fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  } else {
    res.writeHead(404); res.end('Not found');
  }
}

http.createServer(serveHttp).listen(PORT, () => {
  console.log(`🌐 Sayt ishga tushdi: http://localhost:${PORT}`);
});

// ===================== CONFIG =====================
const TOKEN      = process.env.BOT_TOKEN || '';
const MY_CHAT_ID = process.env.MY_CHAT_ID || '915326936';
const GROUP_ID   = process.env.GROUP_CHAT_ID || '';
const DATA_FILE  = 'data.json';

// ===================== DATA =====================
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ transactions: [], categories: {
      income:  ['Maosh','Savdo','Freelance','Investitsiya','Sovg\'a','Boshqa'],
      expense: ['Oziq-ovqat','Transport','Kommunal','Kiyim','Sog\'liqni saqlash','Ta\'lim','Ko\'ngilochar','Boshqa']
    }}));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();
function getTransactions() { db = loadData(); return db.transactions; }
function getCategories()   { db = loadData(); return db.categories; }
function addTransaction(tx) {
  db = loadData();
  db.transactions.unshift(tx);
  saveData(db);
}

// ===================== FORMAT =====================
function fmt(n) { return Number(n).toLocaleString() + " so'm"; }

// ===================== TELEGRAM =====================
const BASE = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;

async function tgSend(chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true, one_time_keyboard: false };
  else body.reply_markup = { remove_keyboard: true };
  try {
    await fetch(`${BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch(e) { console.error('Send error:', e.message); }
}

async function deleteWebhook() {
  try {
    const res = await fetch(`${BASE}/deleteWebhook?drop_pending_updates=false`);
    const data = await res.json();
    console.log('🔗 Webhook o\'chirildi:', data.ok);
  } catch(e) { console.error('deleteWebhook error:', e.message); }
}

let pollBackoff = 1000;

async function getUpdates() {
  try {
    const res = await fetch(`${BASE}/getUpdates?offset=${offset}&timeout=25`, { timeout: 35000 });
    const data = await res.json();
    if (!data.ok) {
      if (data.error_code === 409) {
        console.log(`⚠️ 409 Conflict — ${pollBackoff/1000}s kutamiz...`);
        await new Promise(r => setTimeout(r, pollBackoff));
        pollBackoff = Math.min(pollBackoff * 2, 60000);
        return [];
      }
      console.log('getUpdates error:', data);
      await new Promise(r => setTimeout(r, 3000));
      return [];
    }
    pollBackoff = 1000;
    return data.result || [];
  } catch(e) {
    console.error('Poll error:', e.message);
    await new Promise(r => setTimeout(r, 3000));
    return [];
  }
}

// ===================== BANK DETECTION =====================
const reminders = {};

function isBankMsg(text) {
  const t = text.toLowerCase();
  return /\d[\d\s,.]+so.?m|to.lov|karta|hisobdan|debet|kredit|o.tkazma|uzcard|humo|visa|mastercard|\*{0,4}\d{4}|\bbalance\b/i.test(t);
}

function parseAmount(str) {
  const clean = str.replace(/[\s,_]/g, '');
  const m = clean.match(/\d+/);
  return m ? parseInt(m[0]) : null;
}

function parseType(str) {
  const s = str.toLowerCase();
  if (/kirim|daromad|income|tushdi|keldi/.test(s)) return 'income';
  if (/chiqim|xarajat|expense|sarflad|ketdi/.test(s)) return 'expense';
  return null;
}

function parseCategory(str, type) {
  const s = str.toLowerCase();
  const cats = getCategories();
  const list = type ? cats[type] : [...(cats.income||[]), ...(cats.expense||[])];
  return list.find(c => s.includes(c.toLowerCase())) || null;
}

async function scheduleReminder(chatId, amount, senderName) {
  if (reminders[chatId]) clearTimeout(reminders[chatId]);
  const preview = amount ? fmt(amount) : "noma'lum summa";
  reminders[chatId] = setTimeout(async () => {
    await tgSend(chatId,
      `⏰ <b>Eslatma!</b>\n\n${senderName ? senderName + ' ' : ''}${preview} tranzaksiya — moliya dasturiga kiritmadingizmi?`,
      [['➕ Kirim kiritish', '➖ Chiqim kiritish'], ['🏠 Bosh sahifa']]
    );
  }, 3 * 60 * 1000);
  console.log(`⏰ Reminder set for ${chatId}: ${preview} in 3 min`);
}

// ===================== MENU =====================
const MENU = [
  ['📊 Balans', '📋 Tranzaksiyalar'],
  ['➕ Kirim kiritish', '➖ Chiqim kiritish'],
  ['📈 Hisobot', '🗂 Kategoriyalar'],
  ['⏰ Eslatmani bekor qil']
];

function menuText() {
  const txs = getTransactions();
  const inc = txs.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
  const exp = txs.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
  return `💼 <b>Moliya Boshqaruvi</b>\n\n💰 Jami kirim: <b>${fmt(inc)}</b>\n💸 Jami chiqim: <b>${fmt(exp)}</b>\n📊 Sof balans: <b>${fmt(inc-exp)}</b>\n\nNimani xohlaysiz?`;
}

// ===================== BOT STATE =====================
const states = {};

async function handleMsg(msg) {
  const chatId = String(msg.chat.id);
  const text   = (msg.text || '').trim();
  const state  = states[chatId] || {};

  // Guruh xabari
  if (GROUP_ID && chatId === String(GROUP_ID)) {
    if (isBankMsg(text)) {
      const amount = parseAmount(text);
      const sender = msg.from?.first_name || 'Bank';
      const preview = amount ? fmt(amount) : "noma'lum summa";
      console.log(`🏦 Group bank msg: ${preview} from ${sender}`);
      await tgSend(MY_CHAT_ID,
        `🏦 <b>${sender}</b> guruhda xabar yubordi:\n💰 <b>${preview}</b>\n\n⏰ 3 daqiqadan keyin eslatma keladi...`,
        [['⏰ Eslatmani bekor qil']]
      );
      await scheduleReminder(MY_CHAT_ID, amount, sender);
    }
    return;
  }

  try {
    // Forward qilingan xabar
    if (msg.forward_from || msg.forward_from_chat || msg.forward_date || msg.forward_sender_name) {
      const amount = parseAmount(text);
      const preview = amount ? fmt(amount) : "noma'lum summa";
      await tgSend(chatId, `📨 Bank xabari qabul qilindi!\n💰 <b>${preview}</b>\n\n⏰ 3 daqiqadan keyin eslatma yuboraman.`, [['⏰ Eslatmani bekor qil']]);
      await scheduleReminder(chatId, amount, '');
      return;
    }

    // Eslatmani bekor qilish
    if (text === '⏰ Eslatmani bekor qil') {
      if (reminders[chatId]) { clearTimeout(reminders[chatId]); delete reminders[chatId]; }
      await tgSend(chatId, '✅ Eslatma bekor qilindi.', MENU);
      return;
    }

    // Bosh sahifa
    if (text === '🏠 Bosh sahifa' || text === '/start' || text === '/menu') {
      states[chatId] = {};
      await tgSend(chatId, menuText(), MENU);
      return;
    }

    // ---- STEPS ----
    if (state.step === 'waitAmount') {
      if (text === '❌ Bekor') { states[chatId]={}; await tgSend(chatId, menuText(), MENU); return; }
      const amount = parseAmount(text);
      if (!amount) { await tgSend(chatId, '❌ Faqat raqam yozing. Masalan: <b>50000</b>', [['🏠 Bosh sahifa']]); return; }
      states[chatId] = { ...state, amount, step: 'waitCategory' };
      const cats = getCategories()[state.type] || [];
      const rows = [];
      for (let i = 0; i < cats.length; i += 3) rows.push(cats.slice(i, i+3));
      rows.push(['🏠 Bosh sahifa']);
      await tgSend(chatId, '📂 Kategoriyani tanlang:', rows);
      return;
    }

    if (state.step === 'waitCategory') {
      if (text === '🏠 Bosh sahifa') { states[chatId]={}; await tgSend(chatId, menuText(), MENU); return; }
      states[chatId] = { ...state, category: text, step: 'waitPay' };
      await tgSend(chatId, "💳 To'lov usulini tanlang:", [['💵 Naqd', '💳 Karta'], ['🏦 Bank o\'tkazmasi', '🏠 Bosh sahifa']]);
      return;
    }

    if (state.step === 'waitPay') {
      if (text === '🏠 Bosh sahifa') { states[chatId]={}; await tgSend(chatId, menuText(), MENU); return; }
      const payMap = { '💵 Naqd':'Naqd', '💳 Karta':'Karta', "🏦 Bank o'tkazmasi":"Bank o'tkazmasi" };
      states[chatId] = { ...state, payMethod: payMap[text]||text, step: 'waitDesc' };
      await tgSend(chatId, "📝 Tavsif yozing yoki o'tkazish uchun <b>-</b>:", [['-', '🏠 Bosh sahifa']]);
      return;
    }

    if (state.step === 'waitDesc') {
      if (text === '🏠 Bosh sahifa') { states[chatId]={}; await tgSend(chatId, menuText(), MENU); return; }
      const s = { ...state, description: text === '-' ? '' : text, step: 'confirm' };
      states[chatId] = s;
      const lbl = s.type === 'income' ? '✅ Kirim' : '🔴 Chiqim';
      await tgSend(chatId,
        `${lbl}\n💰 <b>${fmt(s.amount)}</b>\n📂 ${s.category}\n💳 ${s.payMethod||'—'}${s.description?'\n📝 '+s.description:''}\n\nTasdiqlaysizmi?`,
        [['✅ Ha, saqlash', '❌ Bekor'], ['🏠 Bosh sahifa']]
      );
      return;
    }

    if (state.step === 'confirm') {
      if (text === '✅ Ha, saqlash') {
        const s = state;
        const tx = {
          id: Date.now(), type: s.type, amount: s.amount,
          category: s.category, description: s.description||'',
          payMethod: s.payMethod||'',
          date: new Date().toISOString().split('T')[0],
          createdAt: new Date().toISOString()
        };
        addTransaction(tx);
        states[chatId] = {};
        console.log(`✅ New tx: ${tx.type} ${tx.amount} ${tx.category}`);
        await tgSend(chatId, `✅ Saqlandi!\n\n${tx.type==='income'?'💰 Kirim':'💸 Chiqim'}: <b>${fmt(tx.amount)}</b>\n📂 ${tx.category}`, [['🏠 Bosh sahifa']]);
      } else {
        states[chatId] = {};
        await tgSend(chatId, '❌ Bekor qilindi.', MENU);
      }
      return;
    }

    // ---- MENU ----
    if (text === '📊 Balans') {
      const txs = getTransactions();
      const now = new Date();
      const mo = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
      const moTx = txs.filter(t => t.date.startsWith(mo));
      const moInc = moTx.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
      const moExp = moTx.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
      const allInc = txs.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
      const allExp = txs.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
      await tgSend(chatId,
        `📊 <b>Balans</b>\n\n<b>Bu oy:</b>\n✅ Kirim: ${fmt(moInc)}\n🔴 Chiqim: ${fmt(moExp)}\n💎 Foyda: ${fmt(moInc-moExp)}\n\n<b>Jami:</b>\n✅ Kirim: ${fmt(allInc)}\n🔴 Chiqim: ${fmt(allExp)}\n💎 Balans: ${fmt(allInc-allExp)}`, MENU);
      return;
    }

    if (text === '📋 Tranzaksiyalar') {
      const last = getTransactions().slice(0, 15);
      if (!last.length) { await tgSend(chatId, "📋 Tranzaksiyalar yo'q", MENU); return; }
      const lines = last.map(t => {
        const sign = t.type==='income' ? '✅' : '🔴';
        return `${sign} ${t.date} — <b>${fmt(t.amount)}</b>\n   📂 ${t.category}${t.payMethod?' ('+t.payMethod+')':''}${t.description?' | '+t.description:''}`;
      }).join('\n\n');
      await tgSend(chatId, `📋 <b>So'nggi ${last.length} ta:</b>\n\n${lines}`, MENU);
      return;
    }

    if (text === '📈 Hisobot') {
      const now = new Date();
      const mo = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
      const moTx = getTransactions().filter(t => t.date.startsWith(mo));
      const moInc = moTx.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
      const moExp = moTx.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
      const expCats={}, incCats={}, expCnt={}, incCnt={}, payStat={};
      moTx.forEach(t => {
        if (t.type==='expense') { expCats[t.category]=(expCats[t.category]||0)+t.amount; expCnt[t.category]=(expCnt[t.category]||0)+1; }
        else { incCats[t.category]=(incCats[t.category]||0)+t.amount; incCnt[t.category]=(incCnt[t.category]||0)+1; }
        const p=t.payMethod||"Noma'lum"; payStat[p]=(payStat[p]||0)+t.amount;
      });
      const expLines = Object.entries(expCats).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`  🔴 ${c}: ${fmt(v)} (${expCnt[c]}x)`).join('\n') || "  Yo'q";
      const incLines = Object.entries(incCats).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`  ✅ ${c}: ${fmt(v)} (${incCnt[c]}x)`).join('\n') || "  Yo'q";
      const payLines = Object.entries(payStat).map(([p,v])=>`  💳 ${p}: ${fmt(v)}`).join('\n') || "  Yo'q";
      await tgSend(chatId,
        `📈 <b>${mo} Hisobot</b>\n\n💰 Kirim: ${fmt(moInc)}\n💸 Chiqim: ${fmt(moExp)}\n📊 Foyda: ${fmt(moInc-moExp)}\n\n<b>Kirim:</b>\n${incLines}\n\n<b>Chiqim:</b>\n${expLines}\n\n<b>To'lov usullari:</b>\n${payLines}`,
        [['📥 CSV yuklab olish'], ['🏠 Bosh sahifa']]
      );
      return;
    }

    if (text === '📥 CSV yuklab olish') {
      const txs = getTransactions();
      if (!txs.length) { await tgSend(chatId, "Ma'lumot yo'q", MENU); return; }
      const header = "Sana,Tur,Summa,Kategoriya,To'lov,Tavsif\n";
      const rows = txs.map(t =>
        `${t.date},${t.type==='income'?'Kirim':'Chiqim'},${t.amount},${t.category},${t.payMethod||''},${(t.description||'').replace(/,/g,' ')}`
      ).join('\n');
      const csv = '\uFEFF' + header + rows;
      const fileName = `moliya_${new Date().toISOString().split('T')[0]}.csv`;
      fs.writeFileSync(fileName, csv);
      const FormData = require('form-data');
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', fs.createReadStream(fileName), fileName);
      form.append('caption', '📊 Barcha tranzaksiyalar');
      await fetch(`${BASE}/sendDocument`, { method: 'POST', body: form });
      fs.unlinkSync(fileName);
      await tgSend(chatId, '✅ CSV yuborildi!', MENU);
      return;
    }

    if (text === '🗂 Kategoriyalar') {
      const cats = getCategories();
      await tgSend(chatId, `🗂 <b>Kategoriyalar</b>\n\n✅ Kirim: ${cats.income.join(', ')}\n\n🔴 Chiqim: ${cats.expense.join(', ')}`, MENU);
      return;
    }

    if (text === '➕ Kirim kiritish') {
      states[chatId] = { type: 'income', step: 'waitAmount' };
      await tgSend(chatId, '✅ Kirim miqdorini yozing:', [['🏠 Bosh sahifa']]);
      return;
    }

    if (text === '➖ Chiqim kiritish') {
      states[chatId] = { type: 'expense', step: 'waitAmount' };
      await tgSend(chatId, '🔴 Chiqim miqdorini yozing:', [['🏠 Bosh sahifa']]);
      return;
    }

    // Free text
    const type = parseType(text);
    const amount = parseAmount(text);
    const category = parseCategory(text, type);
    if (type && amount && category) {
      states[chatId] = { type, amount, category, description: '', step: 'confirm' };
      const lbl = type==='income'?'✅ Kirim':'🔴 Chiqim';
      await tgSend(chatId, `${lbl}\n💰 <b>${fmt(amount)}</b>\n📂 ${category}\n\nTasdiqlaysizmi?`, [['✅ Ha, saqlash','❌ Bekor'],['🏠 Bosh sahifa']]);
    } else if (type) {
      states[chatId] = { type, step: 'waitAmount' };
      await tgSend(chatId, `${type==='income'?'✅ Kirim':'🔴 Chiqim'} — qancha summa?`, [['🏠 Bosh sahifa']]);
    } else {
      await tgSend(chatId, menuText(), MENU);
    }

  } catch(e) {
    console.error('Handler error:', e);
    try { await tgSend(chatId, '⚠️ Xatolik. /start bosing.', MENU); } catch(_) {}
    states[chatId] = {};
  }
}

// ===================== POLL LOOP =====================
async function poll() {
  while (true) {
    try {
      const updates = await getUpdates();
      for (const upd of updates) {
        offset = upd.update_id + 1;
        if (upd.message?.text) await handleMsg(upd.message);
      }
    } catch(e) {
      console.error('Poll loop error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ===================== START =====================
if (!TOKEN) { console.error('❌ BOT_TOKEN topilmadi!'); process.exit(1); }
console.log('🤖 Moliya Bot ishga tushdi...');
console.log(`📡 MY_CHAT_ID: ${MY_CHAT_ID}`);
console.log(`👥 GROUP_ID: ${GROUP_ID || 'sozlanmagan'}`);
deleteWebhook().then(() => poll());

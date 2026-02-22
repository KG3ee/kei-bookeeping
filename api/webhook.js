const { Telegraf } = require('telegraf');
const Groq         = require('groq-sdk');
const { google }   = require('googleapis');

// ─── CONFIG ──────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const SHEET_ID       = process.env.SHEET_ID;

const SHEET_SALES   = "Sales";
const SHEET_DEBT    = "Debts";
const SHEET_SUMMARY = "Summary";

// ─── MENU (price in AED) ─────────────────────────────────────
const MENU = {
  "matcha latte":          { price: 20, category: "Matcha" },
  "usucha matcha":         { price: 20, category: "Matcha" },
  "coco matcha":           { price: 25, category: "Matcha" },
  "salted cloudy matcha":  { price: 25, category: "Matcha" },
  "matcha tonic":          { price: 25, category: "Matcha" },
  "vietnamese coffee":     { price: 20, category: "Coffee" },
  "espresso":              { price: 20, category: "Coffee" },
  "americano":             { price: 20, category: "Coffee" },
  "espresso/americano":    { price: 20, category: "Coffee" },
  "cold brew":             { price: 20, category: "Coffee" },
  "coco coolbrew":         { price: 25, category: "Coffee" },
  "latte":                 { price: 25, category: "Coffee" },
  "espresso tonic":        { price: 25, category: "Coffee" },
  "salted cloudy coffee":  { price: 25, category: "Coffee" },
};

// ─── GROQ CLIENT ─────────────────────────────────────────────
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ─── GOOGLE SHEETS CLIENT ────────────────────────────────────
function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth  = new google.auth.JWT({
    email:  creds.client_email,
    key:    creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureSheet(sheets, sheetName) {
  const res    = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = res.data.sheets.some(s => s.properties.title === sheetName);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });

  const headers = {
    [SHEET_SALES]:   [["Date","Time","Item","Category","Price (AED)","Paid (AED)","Owed (AED)","Customer/Note"]],
    [SHEET_DEBT]:    [["Date","Customer","Item","Item Price","Paid","Still Owes","Status","Settled On"]],
    [SHEET_SUMMARY]: [["Metric","Value"]],
  };
  await sheets.spreadsheets.values.update({
    spreadsheetId:     SHEET_ID,
    range:             `${sheetName}!A1`,
    valueInputOption:  'RAW',
    resource:          { values: headers[sheetName] || [] },
  });
}

async function appendRow(sheets, sheetName, rowData) {
  await ensureSheet(sheets, sheetName);
  await sheets.spreadsheets.values.append({
    spreadsheetId:     SHEET_ID,
    range:             `${sheetName}!A1`,
    valueInputOption:  'USER_ENTERED',
    resource:          { values: [rowData] },
  });
}

async function getSheetData(sheets, sheetName) {
  await ensureSheet(sheets, sheetName);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         `${sheetName}!A1:Z10000`,
  });
  return res.data.values || [];
}

async function updateCell(sheets, sheetName, row, col, value) {
  const colLetter = String.fromCharCode(64 + col);
  await sheets.spreadsheets.values.update({
    spreadsheetId:    SHEET_ID,
    range:            `${sheetName}!${colLetter}${row}`,
    valueInputOption: 'RAW',
    resource:         { values: [[value]] },
  });
}

// ─── GROQ AI PARSER ──────────────────────────────────────────
async function parseWithGroq(userMessage) {
  const menuList = Object.entries(MENU)
    .map(([name, v]) => `- ${name}: ${v.price} AED`)
    .join("\n");

  const systemPrompt =
    `You are a coffee shop bookkeeping assistant. Parse the user message and return JSON only.\n\n` +
    `Menu:\n${menuList}\n\n` +
    `Return this exact JSON structure:\n` +
    `{ "intent": "sale"|"debt"|"settle"|"summary"|"debts"|"menu"|"help"|"clearall"|"unknown", ` +
    `"items": [{"name": "exact menu item name", "qty": 1}], "customer": "name or null", "paid": number or null }\n\n` +
    `Rules:\n` +
    `- "sale": paid in full. "debt": paid partially or nothing. "settle": paying off a debt.\n` +
    `- "paid" = amount handed over now. If the user mentions payment, always set "paid".\n` +
    `- "latte" and "matcha latte" are different items. If user says only "latte", choose "latte".\n` +
    `- If a customer is mentioned with no amount and no paid keyword, set intent="debt" and paid=0.\n` +
    `- If a customer is mentioned and "paid" appears with no number, treat as fully paid.\n` +
    `- If paid amount is less than total price, intent must be "debt".\n` +
    `- Match item names exactly from the menu. Default qty = 1. customer = null if not mentioned.`;

  try {
    const response = await groq.chat.completions.create({
      model:           "llama-3.1-8b-instant",
      messages:        [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage  },
      ],
      response_format: { type: "json_object" },
      temperature:     0.1,
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.error("Groq error:", err.message);
    return null;
  }
}

// ─── UTILS ───────────────────────────────────────────────────
const formatDate = d => d.toISOString().split('T')[0];
const formatTime = d => d.toTimeString().split(' ')[0];
const capitalize = s => s.replace(/\b\w/g, c => c.toUpperCase());
const parseNumberOrNull = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const hasPaidKeyword = text => /\b(?:paid?|pay|pays|payment)\b/i.test(text);

function extractPaidAmount(text) {
  if (/\b(?:paid?|pay|pays|payment)\s+(?:nothing|none|zero)\b/i.test(text) || /\bno payment\b/i.test(text)) {
    return 0;
  }

  const patterns = [
    /\b(?:paid?|pay|pays|payment|gave|give|handed)\s*(?:aed|dhs?|dirhams?)?\s*(\d+(?:\.\d+)?)\b/i,
    /\b(\d+(?:\.\d+)?)\s*(?:aed|dhs?|dirhams?)?\s*(?:paid?|pay|pays)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const amount = parseNumberOrNull(match[1]);
    if (amount !== null) return amount;
  }

  return null;
}

function inferCustomerFromText(text) {
  const match = text.match(/\b(?:to|for)\s+([a-z][a-z0-9'_-]*)\b/i);
  return match ? match[1] : null;
}

function inferTotalFromItems(items) {
  if (!Array.isArray(items)) return 0;

  return items.reduce((sum, it) => {
    const key = (it?.name || "").toLowerCase().trim();
    const item = MENU[key];
    if (!item) return sum;
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    return sum + item.price * qty;
  }, 0);
}

function normalizeAmbiguousItems(items, userText) {
  if (!Array.isArray(items)) return [];

  const hasLatteWord = /\blatte\b/i.test(userText);
  const hasMatchaWord = /\bmatcha\b/i.test(userText);

  return items.map(it => {
    const key = (it?.name || "").toLowerCase().trim();
    if (key === "matcha latte" && hasLatteWord && !hasMatchaWord) {
      return { ...it, name: "latte" };
    }
    return it;
  });
}

// ─── UPDATE SUMMARY ──────────────────────────────────────────
async function updateSummary(sheets) {
  const salesData = await getSheetData(sheets, SHEET_SALES);
  const debtData  = await getSheetData(sheets, SHEET_DEBT);
  const sales     = salesData.slice(1);
  const debts     = debtData.slice(1);
  const today     = formatDate(new Date());

  const totalRevenue   = sales.reduce((s, r) => s + (parseFloat(r[4]) || 0), 0);
  const totalCollected = sales.reduce((s, r) => s + (parseFloat(r[5]) || 0), 0);
  const totalOwed      = debts.filter(r => r[6] === "Pending" ).reduce((s, r) => s + (parseFloat(r[5]) || 0), 0);
  const totalSettled   = debts.filter(r => r[6] === "Settled" ).reduce((s, r) => s + (parseFloat(r[5]) || 0), 0);
  const todaySales     = sales.filter(r => r[0] === today);
  const todayRev       = todaySales.reduce((s, r) => s + (parseFloat(r[4]) || 0), 0);
  const todayPaid      = todaySales.reduce((s, r) => s + (parseFloat(r[5]) || 0), 0);

  const rows = [
    ["Metric", "Value"],
    ["Last Updated",       new Date().toLocaleString()],
    ["─── TODAY ───",      ""],
    ["Today's Revenue",    todayRev  + " AED"],
    ["Today's Collected",  todayPaid + " AED"],
    ["─── ALL TIME ───",   ""],
    ["Total Revenue",      totalRevenue   + " AED"],
    ["Total Collected",    totalCollected + " AED"],
    ["Total Transactions", sales.length],
    ["─── DEBTS ───",      ""],
    ["Unsettled Debts",    totalOwed    + " AED"],
    ["Settled Debts",      totalSettled + " AED"],
  ];

  await ensureSheet(sheets, SHEET_SUMMARY);
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${SHEET_SUMMARY}!A1:Z100` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${SHEET_SUMMARY}!A1`,
    valueInputOption: 'RAW', resource: { values: rows },
  });
}

// ─── BOT SETUP ───────────────────────────────────────────────
const bot = new Telegraf(TELEGRAM_TOKEN);

// ─── COMMANDS ────────────────────────────────────────────────
bot.command(['start', 'help'], async (ctx) => {
  await ctx.reply(
    `☕ <b>Coffee Shop Bookkeeper</b>\n` +
    `─────────────────────\n\n` +
    `Just type naturally!\n\n` +
    `🛒 <b>Sales:</b>\n` +
    `   "sold a latte"\n` +
    `   "2 matcha lattes and an espresso"\n\n` +
    `💸 <b>Debts:</b>\n` +
    `   "Ahmed got a latte, paid 15"\n` +
    `   "Sara took a coco matcha, paid nothing"\n\n` +
    `✅ <b>Settle:</b>\n` +
    `   "settle Ahmed"\n\n` +
    `📋 <b>Commands:</b>\n` +
    `   /summary  — daily & all-time totals\n` +
    `   /debts    — outstanding debts\n` +
    `   /menu     — full menu & prices\n` +
    `   /clearall — wipe all records`,
    { parse_mode: 'HTML' }
  );
});

bot.command('menu', async (ctx) => {
  let msg = `☕ <b>Menu & Prices</b>\n─────────────────────\n\n🍵 <b>MATCHA</b>\n`;
  Object.entries(MENU).filter(([,v]) => v.category === "Matcha")
    .forEach(([k, v]) => { msg += `   ${capitalize(k)} — ${v.price} AED\n`; });
  msg += `\n☕ <b>COFFEE</b>\n`;
  Object.entries(MENU).filter(([,v]) => v.category === "Coffee")
    .forEach(([k, v]) => { msg += `   ${capitalize(k)} — ${v.price} AED\n`; });
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.command('summary', async (ctx) => {
  const sheets   = getSheetsClient();
  const today    = formatDate(new Date());
  const salesData = await getSheetData(sheets, SHEET_SALES);
  const debtData  = await getSheetData(sheets, SHEET_DEBT);

  let todaySales = 0, todayCollected = 0, todayDebt = 0;
  let totalSales = 0, totalCollected = 0, txCount = 0;
  for (let i = 1; i < salesData.length; i++) {
    const r = salesData[i];
    totalSales += parseFloat(r[4]) || 0;
    totalCollected += parseFloat(r[5]) || 0;
    txCount++;
    if (r[0] === today) {
      todaySales     += parseFloat(r[4]) || 0;
      todayCollected += parseFloat(r[5]) || 0;
      todayDebt      += parseFloat(r[6]) || 0;
    }
  }
  let unsettled = 0;
  for (let i = 1; i < debtData.length; i++) {
    if (debtData[i][6] === "Pending") unsettled += parseFloat(debtData[i][5]) || 0;
  }
  await ctx.reply(
    `📊 <b>Sales Summary</b>\n─────────────────────\n` +
    `📅 <b>Today (${today})</b>\n` +
    `   Sales:     ${todaySales} AED\n` +
    `   Collected: ${todayCollected} AED\n` +
    `   Unpaid:    ${todayDebt} AED\n\n` +
    `📈 <b>All Time</b>\n` +
    `   Sales:        ${totalSales} AED\n` +
    `   Collected:    ${totalCollected} AED\n` +
    `   Transactions: ${txCount}\n\n` +
    `⚠️ <b>Unsettled Debts: ${unsettled} AED</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('debts', async (ctx) => {
  const sheets  = getSheetsClient();
  const data    = await getSheetData(sheets, SHEET_DEBT);
  const pending = data.slice(1).filter(r => r[6] === "Pending");
  if (pending.length === 0) return ctx.reply(`🎉 No outstanding debts! All clear.`);

  const byCustomer = {};
  pending.forEach(r => {
    const name = r[1] || "Unknown";
    if (!byCustomer[name]) byCustomer[name] = { items: [], total: 0 };
    byCustomer[name].items.push(`${r[2]} (owes ${r[5]} AED)`);
    byCustomer[name].total += parseFloat(r[5]) || 0;
  });

  let msg = `📋 <b>Outstanding Debts</b>\n─────────────────────\n`;
  for (const [name, info] of Object.entries(byCustomer)) {
    msg += `\n👤 <b>${name}</b> — owes <b>${Math.round(info.total * 100) / 100} AED</b>\n`;
    info.items.forEach(i => msg += `   • ${i}\n`);
    msg += `   → <code>/settle ${name}</code>\n`;
  }
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.command('settle', async (ctx) => {
  const parts   = ctx.message.text.replace('/settle', '').trim().split(/\s+/);
  const last    = parts[parts.length - 1];
  const hasAmt  = !isNaN(parseFloat(last)) && parts.length > 1;
  const name    = hasAmt ? parts.slice(0, -1).join(' ') : parts.join(' ');
  const amount  = hasAmt ? parseFloat(last) : null;
  if (!name) return ctx.reply("Usage: /settle Ahmed  or  /settle Ahmed 15");

  const sheets  = getSheetsClient();
  const data    = await getSheetData(sheets, SHEET_DEBT);
  let settled   = 0;
  for (let i = 1; i < data.length; i++) {
    if ((data[i][1] || "").toLowerCase() === name.toLowerCase() && data[i][6] === "Pending") {
      const rowOwed = parseFloat(data[i][5]) || 0;
      if (amount === null || settled + rowOwed <= amount + 0.01) {
        await updateCell(sheets, SHEET_DEBT, i + 1, 7, "Settled");
        await updateCell(sheets, SHEET_DEBT, i + 1, 8, formatDate(new Date()));
        settled += rowOwed;
      }
    }
  }
  await updateSummary(sheets);
  if (settled === 0) return ctx.reply(`ℹ️ No pending debts found for "${name}".`);
  await ctx.reply(`✅ Settled <b>${Math.round(settled * 100) / 100} AED</b> for ${name}!`, { parse_mode: 'HTML' });
});

bot.command('clearall', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (arg !== 'confirm') {
    return ctx.reply("⚠️ This will delete ALL sales and debt records.\n\nType /clearall confirm to proceed.");
  }
  const sheets = getSheetsClient();
  for (const sheetName of [SHEET_SALES, SHEET_DEBT]) {
    await ensureSheet(sheets, sheetName);
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${sheetName}!A2:Z10000` });
  }
  await updateSummary(sheets);
  await ctx.reply(`🗑️ All sales and debt records cleared.`);
});

// ─── GLOBAL ERROR HANDLER ────────────────────────────────────
bot.catch(async (err, ctx) => {
  console.error('Bot error:', err);
  try { await ctx.reply(`⚠️ Error: ${err.message}`); } catch (_) {}
});

// ─── NATURAL LANGUAGE ────────────────────────────────────────
bot.on('text', async (ctx) => {
  try {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const parsed = await parseWithGroq(text);
  if (!parsed) return ctx.reply("❌ Could not reach AI. Try:\n/help /summary /debts /menu");

  parsed.items = normalizeAmbiguousItems(parsed.items, text);

  const paidFromModel = parseNumberOrNull(parsed.paid);
  const paidFromText = extractPaidAmount(text);
  const numericPaidInText = paidFromText !== null;
  const explicitPaid = numericPaidInText ? paidFromText : paidFromModel;
  if (explicitPaid !== null) parsed.paid = explicitPaid;

  const hintedCustomer = inferCustomerFromText(text);
  if (!parsed.customer && hintedCustomer) parsed.customer = hintedCustomer;

  const customerMentioned = Boolean((parsed.customer || "").trim());
  const paidKeywordMentioned = hasPaidKeyword(text);
  const inferredTotal = inferTotalFromItems(parsed.items);

  if (customerMentioned && inferredTotal > 0) {
    if (numericPaidInText) {
      parsed.paid = paidFromText;
      if (paidFromText < inferredTotal - 0.01 || paidFromText > inferredTotal + 0.01) {
        parsed.intent = 'debt';
      } else {
        parsed.intent = 'sale';
      }
    } else if (paidKeywordMentioned) {
      parsed.paid = inferredTotal;
      parsed.intent = 'sale';
    } else {
      parsed.paid = 0;
      parsed.intent = 'debt';
    }
  } else if (parsed.intent === 'sale' && explicitPaid !== null && inferredTotal > 0 && explicitPaid < inferredTotal - 0.01) {
    parsed.intent = 'debt';
  }

  const sheets = getSheetsClient();

  if (parsed.intent === 'sale') {
    if (!parsed.items?.length) return ctx.reply('❌ No items found. Try: "sold 2 lattes"');
    const now = new Date(); const lines = []; let total = 0;
    const saleCustomer = (parsed.customer || "").trim();
    const saleNote = saleCustomer ? `Customer: ${saleCustomer}` : "Paid in full";
    for (const it of parsed.items) {
      const key = (it.name || "").toLowerCase().trim();
      const item = MENU[key];
      if (!item) { await ctx.reply(`⚠️ Item not found: "${it.name}". Skipping.`); continue; }
      const qty = Math.max(1, parseInt(it.qty) || 1);
      try {
        for (let i = 0; i < qty; i++) {
          await appendRow(sheets, SHEET_SALES, [formatDate(now), formatTime(now), capitalize(key), item.category, item.price, item.price, 0, saleNote]);
        }
      } catch (err) {
        return ctx.reply(`❌ Sheets error: ${err.message}`);
      }
      total += item.price * qty;
      lines.push(`${qty}x ${capitalize(key)} = ${item.price * qty} AED`);
    }
    if (!lines.length) return;

    const explicitPaid = parseNumberOrNull(parsed.paid);
    let extraMessage = '';

    // If customer paid more than the total, record a credit (shop owes customer)
    if (explicitPaid !== null && explicitPaid > total) {
      const credit = Math.round((explicitPaid - total) * 100) / 100;
      const creditCustomer = saleCustomer || 'Unknown';
      try {
        await appendRow(sheets, SHEET_DEBT, [formatDate(now), creditCustomer, 'Overpayment', total, explicitPaid, -credit, 'Credit', '']);
      } catch (err) {
        return ctx.reply(`❌ Sheets error while recording overpayment: ${err.message}`);
      }
      extraMessage = `\n\n💰 Overpayment of ${credit} AED — shop owes customer ${credit} AED.`;
    }

    await updateSummary(sheets);
    return ctx.reply(`✅ <b>Sale recorded!</b>\n\n${lines.join("\n")}\n─────────────────────\n<b>Total: ${total} AED</b>${extraMessage}`, { parse_mode: 'HTML' });
  }

  if (parsed.intent === 'debt') {
    if (!parsed.items?.length) return ctx.reply('❌ No items found. Try: "Ahmed got a latte, paid 15"');
    const now = new Date(); const customer = (parsed.customer || "Unknown").trim();
    let totalItemPrice = 0; const validItems = [];
    for (const it of parsed.items) {
      const key = (it.name || "").toLowerCase().trim(); const item = MENU[key];
      if (!item) { await ctx.reply(`⚠️ Item not found: "${it.name}". Skipping.`); continue; }
      const qty = Math.max(1, parseInt(it.qty) || 1);
      totalItemPrice += item.price * qty;
      validItems.push({ key, item, qty });
    }
    if (!validItems.length) return;
    const totalPaid = parseNumberOrNull(parsed.paid) || 0;
    if (totalPaid > totalItemPrice) {
      // Treat as overpayment: create a credit entry so the shop owes the customer
      const credit = Math.round((totalPaid - totalItemPrice) * 100) / 100;
      try {
        await appendRow(sheets, SHEET_DEBT, [formatDate(now), customer, 'Overpayment', totalItemPrice, totalPaid, -credit, 'Credit', '']);
      } catch (err) {
        return ctx.reply(`❌ Sheets error while recording overpayment: ${err.message}`);
      }
      await updateSummary(sheets);
      return ctx.reply(`💸 <b>Overpayment recorded!</b>\n\n${lines.join("\n")}\n─────────────────────\nTotal: ${totalItemPrice} AED\nPaid:  ${totalPaid} AED\n\n✅ ${customer} paid ${totalPaid} AED (overpayment ${credit} AED). Shop owes customer ${credit} AED.`, { parse_mode: 'HTML' });
    }
    const lines = []; let totalOwed = 0;
    for (const { key, item, qty } of validItems) {
      const itemTotal = item.price * qty;
      const itemPaid  = totalItemPrice > 0 ? Math.round((itemTotal / totalItemPrice) * totalPaid * 100) / 100 : 0;
      const itemOwed  = Math.round((itemTotal - itemPaid) * 100) / 100;
      for (let i = 0; i < qty; i++) {
        const uP = Math.round((itemPaid / qty) * 100) / 100;
        const uO = Math.round((item.price - uP) * 100) / 100;
        await appendRow(sheets, SHEET_SALES, [formatDate(now), formatTime(now), capitalize(key), item.category, item.price, uP, uO, customer]);
        if (uO > 0) await appendRow(sheets, SHEET_DEBT, [formatDate(now), customer, capitalize(key), item.price, uP, uO, "Pending", ""]);
      }
      totalOwed += itemOwed;
      lines.push(`${qty}x ${capitalize(key)} = ${itemTotal} AED`);
    }
    await updateSummary(sheets);
    const owedText = totalOwed > 0
      ? `⚠️ <b>${customer} owes: ${totalOwed} AED</b>\nTo settle: <code>/settle ${customer}</code>`
      : `✅ Fully paid`;
    return ctx.reply(`💸 <b>Debt recorded!</b>\n\n${lines.join("\n")}\n─────────────────────\nTotal: ${totalItemPrice} AED\nPaid:  ${totalPaid} AED\n${owedText}`, { parse_mode: 'HTML' });
  }

  if (parsed.intent === 'settle') {
    if (!parsed.customer) return ctx.reply('❌ Who to settle for? Try: "settle Ahmed"');
    const name   = parsed.customer.trim();
    const amount = parseFloat(parsed.paid) || null;
    const data   = await getSheetData(sheets, SHEET_DEBT);
    let settled  = 0;
    for (let i = 1; i < data.length; i++) {
      if ((data[i][1] || "").toLowerCase() === name.toLowerCase() && data[i][6] === "Pending") {
        const rowOwed = parseFloat(data[i][5]) || 0;
        if (amount === null || settled + rowOwed <= amount + 0.01) {
          await updateCell(sheets, SHEET_DEBT, i + 1, 7, "Settled");
          await updateCell(sheets, SHEET_DEBT, i + 1, 8, formatDate(new Date()));
          settled += rowOwed;
        }
      }
    }
    await updateSummary(sheets);
    if (settled === 0) return ctx.reply(`ℹ️ No pending debts found for "${name}".`);
    return ctx.reply(`✅ Settled <b>${Math.round(settled * 100) / 100} AED</b> for ${name}!`, { parse_mode: 'HTML' });
  }

  const actions = {
    summary:  () => ctx.telegram.callApi('sendMessage', { chat_id: ctx.chat.id, text: "Use /summary" }),
    debts:    () => ctx.telegram.callApi('sendMessage', { chat_id: ctx.chat.id, text: "Use /debts" }),
    menu:     () => bot.telegram.sendMessage(ctx.chat.id, "Use /menu"),
    help:     () => bot.telegram.sendMessage(ctx.chat.id, "Use /help"),
    clearall: () => ctx.reply("⚠️ Type /clearall confirm to wipe all records."),
  };

  if (actions[parsed.intent]) return actions[parsed.intent]();
  return ctx.reply("❓ I didn't understand that.\n\nType /help to see what I can do.");
  } catch (err) {
    console.error('Text handler error:', err);
    await ctx.reply(`⚠️ Error: ${err.message}`);
  }
});

// ─── VERCEL HANDLER ──────────────────────────────────────────
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    // Try to notify the user in Telegram about the error
    try {
      const update = req.body;
      const chatId = update?.message?.chat?.id;
      if (chatId && process.env.TELEGRAM_TOKEN) {
        const https = require('https');
        const body  = JSON.stringify({ chat_id: chatId, text: `⚠️ Internal error: ${err.message}` });
        const opts  = {
          hostname: 'api.telegram.org',
          path:     `/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
          method:   'POST',
          headers:  { 'Content-Type': 'application/json' },
        };
        const r = https.request(opts);
        r.write(body);
        r.end();
      }
    } catch (_) {}
    res.status(200).send('OK');
  }
};

// BusyNes: record drink sales, track stock, and see your own side of the money.
// Data lives in Supabase. Privacy is enforced by the database (see supabase/schema.sql),
// so this file only ever receives what the signed-in partner is allowed to see.
(() => {
"use strict";

const VERSION = "2.0";
const LOW = 3;               // "running low" threshold
const POLL_MS = 20000;       // refresh while the app is open
const OWNER_COLORS = ["var(--beer)", "var(--sib)", "var(--bottle)", "var(--warn)"]; // given to owner groups in alphabetical order

// ---------- state ----------
const S = {
  sb: null, user: null, me: null,
  partners: [], shares: [], products: [], stock: {}, moves: [], sales: [], settlements: [], money: null,
  orders: [], debts: [], notifs: [], messages: [], seenNotif: null, fromOrder: null,
  tab: "sell", cart: {}, period: "settle", editing: null, confirmDel: null, loaded: false,
};
const store = {
  get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
  set(k,v){ try { localStorage.setItem(k,v); } catch(e){} },
};
S.tab = store.get("busynes.tab") || "sell";

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = v => Number(v) || 0;
const money = n => "R" + Math.round(num(n)).toLocaleString("en-ZA").replace(/ /g," ");
const money2 = n => { const r = Math.round(num(n)*100)/100; return Number.isInteger(r) ? money(r) : "R" + r.toFixed(2); };
const dayKey = d => { d = new Date(d); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
const dayLabel = iso => {
  const k = dayKey(iso);
  if (k === dayKey(new Date())) return "Today";
  if (k === dayKey(Date.now()-864e5)) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-ZA",{weekday:"short", day:"numeric", month:"short"});
};
const timeLabel = iso => new Date(iso).toLocaleTimeString("en-ZA",{hour:"2-digit", minute:"2-digit"});
const pname = id => id === S.me ? "you" : ((S.partners.find(p => p.id === id) || {}).name || id || "?");
const Pname = id => { const n = pname(id); return n === "you" ? "You" : n; };
const productById = id => S.products.find(p => p.id === id);
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40) || ("p" + Date.now());

// Owner groups ("sibabalo", "beers") come from the owner_shares table.
function owners(){
  const map = {};
  for (const sh of S.shares){
    const o = map[sh.owner] || (map[sh.owner] = {id:sh.owner, partners:[]});
    o.partners.push(sh.partner_id);
  }
  Object.values(map).forEach((o,i) => {
    o.name = o.partners.map(id => (S.partners.find(p => p.id === id) || {name:id}).name).join(" & ");
    o.mine = o.partners.includes(S.me);
    o.color = OWNER_COLORS[i % OWNER_COLORS.length];
  });
  for (const p of S.products) if (!map[p.owner]) map[p.owner] = {id:p.owner, partners:[], name:p.owner, mine:false, color:"var(--muted)"};
  // Your own stock first, then the rest alphabetically, so the layout doesn't shuffle between refreshes.
  const sorted = {};
  Object.values(map).sort((a,b) => (b.mine - a.mine) || a.id.localeCompare(b.id)).forEach(o => sorted[o.id] = o);
  return sorted;
}

function toast(msg, action){
  const old = document.querySelector(".toast"); if (old) old.remove();
  const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role","status");
  const span = document.createElement("span"); span.textContent = msg; t.appendChild(span);
  if (action){ const b = document.createElement("button"); b.type = "button"; b.textContent = action.label; b.onclick = action.run; t.appendChild(b); }
  document.body.appendChild(t);
  setTimeout(() => t.remove(), action ? 7000 : 2600);
}
async function copyText(text){
  try { await navigator.clipboard.writeText(text); toast("Copied. Paste it in the group."); }
  catch(e){
    openSheet(`<div class="grab"></div><h2>Copy this</h2><p class="muted">Select the text and copy it.</p><textarea id="copyArea" class="text" rows="10" readonly>${esc(text)}</textarea><button class="btn" id="sheetClose" type="button">Done</button>`);
    const a = $("#copyArea"); a.focus(); a.select(); $("#sheetClose").onclick = closeSheet;
  }
}
function failed(err){
  console.error(err);
  toast((err && err.message && !/fetch/i.test(err.message)) ? err.message : "That didn't save. Check your connection and try again.");
}

// ---------- sheet ----------
function openSheet(html){
  $("#overlay").innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  $("#scrim").addEventListener("click", e => { if (e.target.id === "scrim") closeSheet(); });
}
function closeSheet(){ $("#overlay").innerHTML = ""; }

// ---------- screens ----------
function show(id){
  ["setupScreen","authScreen","notPartnerScreen","appScreen"].forEach(s => $("#"+s).hidden = s !== id);
}

// ---------- data ----------
function periodStart(){
  const now = new Date();
  if (S.period === "today"){ const d = new Date(now); d.setHours(0,0,0,0); return d.toISOString(); }
  if (S.period === "week"){ const d = new Date(now); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay()+6)%7)); return d.toISOString(); }
  if (S.period === "settle") return S.settlements[0] ? S.settlements[0].at : null;
  return null;
}
async function must(q){ const r = await q; if (r.error) throw r.error; return r.data; }
// Disable a button while its action runs, so a double tap can't save twice.
async function once(btn, fn){
  if (btn.disabled) return;
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

const soft = async (q, fallback) => { try { const r = await q; return r.error ? fallback : r.data; } catch(e){ return fallback; } };
const SALE_COLS = "id,at,paid_to,method,note,recorded_by,sale_items(product_id,name,owner,price,qty)";

async function loadAll(){
  const sb = S.sb;
  const [partners, shares, products, stock, moves, sales, settlements, orders, debts, notifs, messages] = await Promise.all([
    soft(sb.from("partners").select("id,name,phone"), null).then(r => r || must(sb.from("partners").select("id,name"))),
    must(sb.from("owner_shares").select("owner,partner_id,share").order("owner").order("partner_id")),
    must(sb.from("products").select("*").order("sort").order("name")),
    must(sb.rpc("stock_levels")),
    must(sb.from("stock_moves").select("*").order("at",{ascending:false}).limit(8)),
    soft(sb.from("sales").select(SALE_COLS + ",due_on,sale_payments(amount,at,method,paid_to)").order("at",{ascending:false}).limit(300), null)
      .then(r => r || must(sb.from("sales").select(SALE_COLS).order("at",{ascending:false}).limit(300))),
    must(sb.from("settlements").select("*").order("at",{ascending:false}).limit(20)),
    soft(sb.from("orders").select("*").order("at",{ascending:false}).limit(60), []),
    soft(sb.rpc("my_debts"), []),
    soft(sb.from("notifications").select("*").order("id",{ascending:false}).limit(50), []),
    soft(sb.from("messages").select("id,at,from_partner,body").order("id",{ascending:false}).limit(60), []),
  ]);
  Object.assign(S, {partners, shares, products, moves, sales, settlements, orders, debts, notifs, messages});
  S.stock = {}; for (const r of stock) S.stock[r.product_id] = r.qty;
  S.money = await must(sb.rpc("my_money", {p_from: periodStart()}));
  S.loaded = true;
  announceNew();
}
// Pop up a toast when something new arrives while the app is open.
function announceNew(){
  const top = S.notifs.length ? S.notifs[0].id : 0;
  if (S.seenNotif !== null && top > S.seenNotif && document.visibilityState === "visible"){
    const fresh = S.notifs.filter(n => n.id > S.seenNotif && !n.read_at);
    if (fresh.length) toast(fresh[0].title + (fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ""), {label:"View", run: notifSheet});
  }
  S.seenNotif = Math.max(S.seenNotif || 0, top);
}
async function refresh(quiet){
  try { await loadAll(); render(); }
  catch(e){ if (!quiet) failed(e); }
}

// ---------- render ----------
function render(){
  $("#meName").textContent = (S.partners.find(p => p.id === S.me) || {}).name || "";
  document.querySelectorAll("[data-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  let html;
  if (!S.loaded) html = `<div class="empty"><b>Loading the shop…</b>Fetching products, stock and sales.</div>`;
  else if (S.tab === "sell") html = viewSell();
  else if (S.tab === "orders") html = viewOrders();
  else if (S.tab === "owed") html = viewOwed();
  else if (S.tab === "stock") html = viewStock();
  else if (S.tab === "sales") html = viewSales();
  else if (S.tab === "team") html = viewTeam();
  else html = viewReport();
  // Don't wipe a half-typed chat message when the screen refreshes.
  const chat = $("#chatInput"), keep = chat && {v: chat.value, focus: document.activeElement === chat};
  $("#view").innerHTML = html;
  const chat2 = $("#chatInput");
  if (keep && chat2){ chat2.value = keep.v; if (keep.focus) chat2.focus(); }
  const box = $("#chatBox"); if (box && !keep) box.scrollTop = box.scrollHeight;
  bindView();
  renderCart();
  renderBadges();
}

function viewSell(){
  if (!S.products.length) return `<div class="empty"><b>No products yet</b>Add your drinks and prices on the Stock tab, then come back here to sell.</div>`;
  const os = owners();
  let h = "";
  for (const o of Object.values(os)){
    const ps = S.products.filter(p => p.owner === o.id && !p.hidden);
    if (!ps.length) continue;
    h += `<section><div class="owner-head"><span class="owner-tag"><i style="background:${o.color}"></i>${esc(o.name)}'s</span><span class="eyebrow">Tap to add</span></div><div class="grid">`;
    for (const p of ps){
      const q = S.cart[p.id] || 0, st = (S.stock[p.id] || 0) - q;
      const cls = st <= 0 ? "out" : st <= LOW ? "low" : "";
      h += `<div style="position:relative;min-width:0">
        <button class="tile ${q ? "in" : ""}" type="button" data-add="${esc(p.id)}" aria-label="Add one ${esc(p.name)}">
          <span class="stripe" style="background:${o.color}"></span>
          <span class="name">${esc(p.name)}</span>
          <span class="meta num"><span class="price">${money(p.price)}</span><span class="left ${cls}">${st <= 0 ? "None left" : st + " left"}</span></span>
        </button>
        ${q ? `<span class="badge num" aria-hidden="true">${q}</span><button class="minus" type="button" data-sub="${esc(p.id)}" aria-label="Remove one ${esc(p.name)}">−</button>` : ""}
      </div>`;
    }
    h += `</div></section>`;
  }
  return h;
}

function cartLines(){
  return Object.entries(S.cart).filter(([,q]) => q > 0).map(([id,q]) => {
    const p = productById(id); return p ? {product_id:id, name:p.name, price:num(p.price), qty:q} : null;
  }).filter(Boolean);
}
function renderCart(){
  const lines = cartLines(), bar = $("#cartbar");
  bar.hidden = !(S.tab === "sell" && lines.length);
  if (bar.hidden) return;
  $("#cartTotal").textContent = money(lines.reduce((a,l) => a + l.qty*l.price, 0));
  $("#cartWhat").textContent = lines.map(l => l.qty + " × " + l.name).join(", ");
}

const freshDraft = () => ({paidTo:null, method:null, note:"", mode:"full", paid:"", due:""});
let draft = freshDraft();
function checkout(){
  const lines = cartLines(); if (!lines.length) return;
  if (!draft.paidTo) draft.paidTo = S.me;
  if (!draft.method) draft.method = "transfer";
  const total = lines.reduce((a,l) => a + l.qty*l.price, 0);
  const paidNow = () => draft.mode === "full" ? total : draft.mode === "credit" ? 0 : Math.min(total, Math.max(0, parseFloat(draft.paid) || 0));
  openSheet(`<div class="grab"></div>
    <h2>Record this sale</h2>
    <div class="lines num">${lines.map(l => `<div class="line"><span>${l.qty} × ${esc(l.name)}</span><span>${money(l.qty*l.price)}</span></div>`).join("")}
      <div class="line total"><span>Total</span><span>${money(total)}</span></div></div>
    <div class="field"><span class="lab">How much was paid?</span>
      <div class="chips" role="group"><button type="button" class="chip" data-mode="full">Paid in full</button><button type="button" class="chip" data-mode="part">Paid part</button><button type="button" class="chip" data-mode="credit">On credit</button></div></div>
    <div class="field" id="partBox" hidden><label for="paidNow">Paid now (R)</label><input id="paidNow" class="text num" type="number" inputmode="decimal" min="0" max="${total}" step="1" value="${esc(draft.paid)}"></div>
    <div class="field" id="dueBox" hidden><label for="dueOn">Promised to pay the rest on</label><input id="dueOn" class="text" type="date" value="${esc(draft.due)}">
      <div class="chips"><button type="button" class="chip" data-dueadd="3">In 3 days</button><button type="button" class="chip" data-dueadd="7">In a week</button><button type="button" class="chip" data-dueadd="14">In 2 weeks</button></div></div>
    <p class="banner" id="owedNote" hidden></p>
    <div class="field"><span class="lab" id="whoLab">Who got the money?</span>
      <div class="chips" role="group">${S.partners.map(p => `<button type="button" class="chip" data-paid="${esc(p.id)}" aria-pressed="${draft.paidTo===p.id}">${esc(p.id === S.me ? "Me" : p.name)}</button>`).join("")}</div></div>
    <div class="field" id="methodBox"><span class="lab">How was it paid?</span>
      <div class="chips" role="group"><button type="button" class="chip" data-method="transfer" aria-pressed="${draft.method==="transfer"}">Into their account</button><button type="button" class="chip" data-method="cash" aria-pressed="${draft.method==="cash"}">Cash</button></div></div>
    <div class="field"><label for="saleNote" id="noteLab">Customer or note (optional)</label><input id="saleNote" class="text" maxlength="80" placeholder="e.g. Thando, block C" value="${esc(draft.note)}"></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Back</button><span class="spacer"></span><button class="btn" type="button" id="saveSale"></button></div>`);
  const sync = () => {
    const paid = paidNow(), owed = total - paid;
    document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === draft.mode)));
    $("#partBox").hidden = draft.mode !== "part";
    $("#dueBox").hidden = owed <= 0.005;
    $("#methodBox").hidden = paid <= 0;
    $("#whoLab").textContent = paid <= 0 ? "Who is collecting the money?" : "Who got the money?";
    $("#noteLab").textContent = owed > 0.005 ? "Customer's name (needed so you know who owes)" : "Customer or note (optional)";
    const n = $("#owedNote"); n.hidden = owed <= 0.005;
    n.textContent = owed > 0.005 ? `${draft.note.trim() || "The customer"} will owe ${money2(owed)}.` : "";
    $("#saveSale").textContent = owed > 0.005 ? `Save · ${money2(paid)} now, ${money2(owed)} owed` : `Save sale · ${money(total)}`;
  };
  document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { draft.mode = b.dataset.mode; if (draft.mode === "part" && !draft.paid) $("#paidNow").focus(); sync(); });
  $("#paidNow").oninput = e => { draft.paid = e.target.value; sync(); };
  $("#dueOn").oninput = e => { draft.due = e.target.value; };
  document.querySelectorAll("[data-dueadd]").forEach(b => b.onclick = () => {
    const d = new Date(); d.setDate(d.getDate() + Number(b.dataset.dueadd));
    draft.due = dayKey(d); $("#dueOn").value = draft.due;
  });
  document.querySelectorAll("[data-paid]").forEach(b => b.onclick = () => { draft.paidTo = b.dataset.paid; document.querySelectorAll("[data-paid]").forEach(x => x.setAttribute("aria-pressed", String(x===b))); });
  document.querySelectorAll("[data-method]").forEach(b => b.onclick = () => { draft.method = b.dataset.method; document.querySelectorAll("[data-method]").forEach(x => x.setAttribute("aria-pressed", String(x===b))); });
  $("#saleNote").oninput = e => { draft.note = e.target.value; sync(); };
  $("#sheetCancel").onclick = closeSheet;
  sync();
  $("#saveSale").onclick = async e => {
    const paid = paidNow(), owed = total - paid;
    if (owed > 0.005 && !draft.note.trim()) return toast("Type the customer's name so you know who owes.");
    e.target.disabled = true;
    const sale = {at:new Date().toISOString(), items:lines, total, paidTo:draft.paidTo, method:draft.method, note:draft.note.trim(), owed, due: owed > 0.005 && draft.due ? draft.due : null};
    try {
      await must(S.sb.rpc("record_sale", {
        p_items: lines.map(l => ({product_id:l.product_id, qty:l.qty})),
        p_paid_to: sale.paidTo, p_method: sale.method, p_note: sale.note,
        p_paid: paid, p_due: sale.due, p_order: S.fromOrder || null,
      }));
      S.cart = {}; S.fromOrder = null; draft = freshDraft();
      closeSheet();
      toast(owed > 0.005 ? `Saved. ${sale.note} owes ${money2(owed)}.` : "Saved " + money(total) + " paid to " + pname(sale.paidTo) + ".",
            {label:"Copy for group", run:() => copyText(saleText(sale))});
      await refresh();
    } catch(err){ e.target.disabled = false; failed(err); }
  };
}
function saleText(s){
  const who = (S.partners.find(p => p.id === s.paidTo) || {name:s.paidTo}).name;
  return `✅ Sale ${dayLabel(s.at)} ${timeLabel(s.at)}\n` + s.items.map(i => `${i.qty} × ${i.name} = ${money(i.qty*i.price)}`).join("\n") +
    `\nTotal: ${money(s.total)}\nPaid to ${who} (${s.method === "cash" ? "cash" : "account"})` +
    (s.owed > 0.005 ? `\nOwes: ${money2(s.owed)}${s.due ? " by " + dueText(s.due) : ""}` : "") + (s.note ? `\nNote: ${s.note}` : "");
}

// ---------- credit: dates and who owes ----------
const isoDay = d => new Date(d + "T12:00:00");
const dueText = d => isoDay(d).toLocaleDateString("en-ZA", {weekday:"short", day:"numeric", month:"short"});
function dueInfo(d){
  if (!d) return {label:"No date set", cls:"", rank:3};
  const today = dayKey(new Date());
  const days = Math.round((isoDay(d) - isoDay(today)) / 864e5);
  if (days < 0) return {label:`Overdue by ${-days} day${days === -1 ? "" : "s"} (${dueText(d)})`, cls:"bad", rank:0};
  if (days === 0) return {label:"Due today", cls:"warn", rank:1};
  if (days <= 2) return {label:`Due ${dueText(d)}`, cls:"warn", rank:2};
  return {label:`Due ${dueText(d)}`, cls:"", rank:3};
}
const paidOf = s => (s.sale_payments || []).reduce((a,p) => a + num(p.amount), 0);

function viewOwed(){
  const list = S.debts, m = S.money || {};
  const sum = list.reduce((a,d) => a + num(d.outstanding), 0);
  let h = `<h2>Who owes</h2>`;
  if (!list.length){
    h += `<div class="empty"><b>Nobody owes you anything</b>When a customer pays part, or takes drinks on credit, it shows here with the date they promised.</div>`;
  } else {
    h += `<section class="kpis"><div class="kpi"><span class="eyebrow">Owed to you</span><b class="num">${money2(sum)}</b><span class="muted">${list.length} customer${list.length === 1 ? "" : "s"}</span></div>
      <div class="kpi"><span class="eyebrow">Overdue</span><b class="num">${list.filter(d => dueInfo(d.due_on).rank === 0).length}</b><span class="muted">${list.filter(d => dueInfo(d.due_on).rank <= 1).length} due now</span></div></section>`;
    h += `<section class="card"><div class="list">` + list.slice().sort((a,b) => dueInfo(a.due_on).rank - dueInfo(b.due_on).rank || String(a.due_on || "9").localeCompare(String(b.due_on || "9"))).map(d => {
      const di = dueInfo(d.due_on);
      return `<div class="debt"><div class="row"><span class="title">${esc(d.customer || "No name")}</span><span class="spacer"></span><b class="num">${money2(d.outstanding)}</b></div>
        <div class="sub">${esc(d.items)} · ${money2(d.paid)} of ${money2(d.total)} paid · ${dayLabel(d.at)}${d.paid_to !== S.me ? " · " + esc(Pname(d.paid_to)) + " collects" : ""}</div>
        <div class="row" style="margin-top:6px"><span class="pill ${di.cls}">${esc(di.label)}</span><span class="spacer"></span>
          <button class="linkbtn" type="button" data-due="${d.sale_id}">Change date</button>
          <button class="linkbtn" type="button" data-remind="${d.sale_id}">Copy reminder</button>
          <button class="btn small" type="button" data-pay="${d.sale_id}">Got payment</button></div></div>`;
    }).join("") + `</div></section>`;
  }
  if (num(m.outstanding) > 0.005) h += `<p class="muted">Across everyone, customers still owe <b class="num">${money2(m.outstanding)}</b> on your products${list.length ? "" : ", but you aren't the one collecting it"}.</p>`;
  return h;
}
function paySheet(id){
  const d = S.debts.find(x => x.sale_id === id); if (!d) return;
  let method = "cash", to = S.me;
  openSheet(`<div class="grab"></div><h2>${esc(d.customer || "Customer")} owes ${money2(d.outstanding)}</h2>
    <div class="field"><label for="payAmt">Amount received now (R)</label><div class="stepper"><input id="payAmt" class="text num" type="number" inputmode="decimal" min="0" max="${num(d.outstanding)}" step="1" value="${num(d.outstanding)}" style="width:100%"></div></div>
    <div class="field"><span class="lab">How did they pay?</span><div class="chips"><button type="button" class="chip" data-pm="cash" aria-pressed="true">Cash</button><button type="button" class="chip" data-pm="transfer" aria-pressed="false">Into an account</button></div></div>
    <div class="field"><span class="lab">Who received it?</span><div class="chips">${S.partners.map(p => `<button type="button" class="chip" data-pto="${esc(p.id)}" aria-pressed="${p.id === to}">${esc(p.id === S.me ? "Me" : p.name)}</button>`).join("")}</div></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Back</button><span class="spacer"></span><button class="btn" type="button" id="savePay">Save payment</button></div>`);
  document.querySelectorAll("[data-pm]").forEach(b => b.onclick = () => { method = b.dataset.pm; document.querySelectorAll("[data-pm]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  document.querySelectorAll("[data-pto]").forEach(b => b.onclick = () => { to = b.dataset.pto; document.querySelectorAll("[data-pto]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  $("#sheetCancel").onclick = closeSheet;
  $("#savePay").onclick = e => once(e.target, async () => {
    const amt = parseFloat($("#payAmt").value);
    if (!(amt > 0)) return toast("Enter how much they paid.");
    try {
      await must(S.sb.rpc("record_payment", {p_sale: id, p_amount: amt, p_method: method, p_paid_to: to}));
      closeSheet();
      toast(amt >= num(d.outstanding) - 0.005 ? "Paid in full. Debt cleared." : money2(num(d.outstanding) - amt) + " still owed.");
      await refresh();
    } catch(err){ failed(err); }
  });
}
function dueSheet(id){
  const d = S.debts.find(x => x.sale_id === id); if (!d) return;
  openSheet(`<div class="grab"></div><h2>When will ${esc(d.customer || "they")} pay?</h2>
    <div class="field"><label for="newDue">Promised date</label><input id="newDue" class="text" type="date" value="${esc(d.due_on || "")}"></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Back</button><span class="spacer"></span><button class="btn" type="button" id="saveDue">Save date</button></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#saveDue").onclick = e => once(e.target, async () => {
    try { await must(S.sb.rpc("set_sale_due", {p_sale: id, p_due: $("#newDue").value || null})); closeSheet(); toast("Date saved."); await refresh(); }
    catch(err){ failed(err); }
  });
}
function reminderText(d){
  return `Hi ${d.customer || ""}, a friendly reminder about the ${money2(d.outstanding)} still owing for ${d.items}` + (d.due_on ? `, which you said you'd settle by ${dueText(d.due_on)}` : "") + `. Thank you!`;
}

// ---------- orders ----------
function viewOrders(){
  const open = S.orders.filter(o => o.status === "open"), past = S.orders.filter(o => o.status !== "open").slice(0, 8);
  const line = o => (o.items || []).map(i => i.qty + " × " + esc(i.name)).join(", ");
  let h = `<div class="row"><h2>Orders</h2><span class="spacer"></span><button class="btn small" type="button" data-neworder>Add order</button></div>
    <p class="muted" style="margin:-12px 0 0">Write down what people ask for. Everyone is told, and when you sell it the order is ticked off.</p>`;
  if (!open.length) h += `<div class="empty"><b>No open orders</b>When someone asks for drinks, add it here so nobody forgets.</div>`;
  else h += open.map(o => `<section class="card"><div class="row"><span class="title">${esc(o.customer || "No name")}</span><span class="spacer"></span><span class="muted">${dayLabel(o.at)} ${timeLabel(o.at)}</span></div>
      <div style="margin-top:6px">${line(o)}</div>
      ${o.note ? `<div class="sub">${esc(o.note)}</div>` : ""}
      <div class="sub">Added by ${esc(Pname(o.created_by))}</div>
      <div class="row" style="margin-top:10px"><button class="linkbtn bad" type="button" data-cancelorder="${o.id}">Cancel</button><span class="spacer"></span><button class="btn small" type="button" data-fillorder="${o.id}">Sell this</button></div></section>`).join("");
  if (past.length) h += `<section><div class="eyebrow" style="margin-bottom:6px">Recent</div><div class="card list">` + past.map(o =>
    `<div class="item"><div class="main"><div class="title">${esc(o.customer || "No name")} <span class="pill">${o.status === "done" ? "sold" : "cancelled"}</span></div><div class="sub">${line(o)}</div></div></div>`).join("") + `</div></section>`;
  return h;
}
function newOrderSheet(){
  const qty = {}, os = Object.values(owners());
  const prods = S.products.filter(p => !p.hidden);
  openSheet(`<div class="grab"></div><h2>Add an order</h2>
    <div class="field"><label for="ordCust">Customer</label><input id="ordCust" class="text" maxlength="60" placeholder="e.g. Lindiwe"></div>
    <div class="field"><span class="lab">What do they want?</span><div class="list card" style="padding-block:0">${os.map(o => prods.filter(p => p.owner === o.id).map(p =>
      `<div class="item" style="padding:8px 0"><div class="main"><div class="title">${esc(p.name)}</div><div class="sub num">${money(p.price)}</div></div>
        <div class="stepper"><button type="button" class="btn small ghost" data-oq="${esc(p.id)}" data-d="-1" aria-label="One less ${esc(p.name)}">−</button><b class="num" id="oq-${esc(p.id)}" style="min-width:22px;text-align:center">0</b><button type="button" class="btn small" data-oq="${esc(p.id)}" data-d="1" aria-label="One more ${esc(p.name)}">+</button></div></div>`).join("")).join("")}</div></div>
    <div class="field"><label for="ordNote">Note (optional)</label><input id="ordNote" class="text" maxlength="120" placeholder="e.g. collect at 5pm, will pay Friday"></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn" type="button" id="saveOrder">Save order</button></div>`);
  document.querySelectorAll("[data-oq]").forEach(b => b.onclick = () => {
    const id = b.dataset.oq; qty[id] = Math.max(0, (qty[id] || 0) + Number(b.dataset.d));
    $("#oq-" + CSS.escape(id)).textContent = qty[id];
  });
  $("#sheetCancel").onclick = closeSheet;
  $("#saveOrder").onclick = e => once(e.target, async () => {
    const items = Object.entries(qty).filter(([,q]) => q > 0).map(([product_id, q]) => ({product_id, qty:q}));
    if (!items.length) return toast("Pick at least one drink.");
    try {
      await must(S.sb.rpc("create_order", {p_customer: $("#ordCust").value.trim(), p_items: items, p_note: $("#ordNote").value.trim()}));
      closeSheet(); toast("Order saved. The others have been told."); await refresh();
    } catch(err){ failed(err); }
  });
}
function fillFromOrder(id){
  const o = S.orders.find(x => x.id === id); if (!o) return;
  S.cart = {};
  let skipped = 0;
  for (const i of o.items || []){ if (productById(i.product_id)) S.cart[i.product_id] = (S.cart[i.product_id] || 0) + i.qty; else skipped++; }
  S.fromOrder = o.id;
  draft = freshDraft(); draft.note = o.customer || "";
  S.tab = "sell"; store.set("busynes.tab", "sell"); render(); window.scrollTo(0,0);
  toast(skipped ? "Order loaded, but " + skipped + " item(s) no longer exist." : "Order loaded. Check it and tap Record sale.");
}

// ---------- team: call, WhatsApp, chat ----------
const waNumber = p => { let d = String(p || "").replace(/[^0-9]/g, ""); if (d.startsWith("0")) d = "27" + d.slice(1); return d; };
function viewTeam(){
  const others = S.partners.filter(p => p.id !== S.me), me = S.partners.find(p => p.id === S.me) || {};
  let h = `<h2>Team</h2>`;
  h += others.map(p => `<section class="card"><div class="row"><div class="main"><div class="title">${esc(p.name)}</div><div class="sub num">${p.phone ? esc(p.phone) : "No number saved yet"}</div></div></div>
    <div class="row" style="margin-top:10px">${p.phone ? `<a class="btn small" href="tel:${esc(p.phone)}">Call</a><a class="btn small ghost" href="https://wa.me/${waNumber(p.phone)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
      <button class="btn small ghost" type="button" data-ping="${esc(p.id)}">Ask ${esc(p.name)} to call me</button></div></section>`).join("");
  h += `<section class="card"><div class="field"><label for="myPhone">Your number, so the others can call you</label>
    <div class="stepper"><input id="myPhone" class="text num" type="tel" inputmode="tel" autocomplete="tel" value="${esc(me.phone || "")}" placeholder="082 123 4567" style="width:100%"><button class="btn small" type="button" data-savephone>Save</button></div></div></section>`;
  const msgs = S.messages.slice().reverse();
  h += `<section><div class="eyebrow" style="margin-bottom:6px">Chat</div><div class="card chat" id="chatBox">` +
    (msgs.length ? msgs.map(m => `<div class="msg ${m.from_partner === S.me ? "mine" : ""}"><div class="who"><b>${esc(Pname(m.from_partner))}</b> <span class="muted">${dayLabel(m.at)} ${timeLabel(m.at)}</span></div><div>${esc(m.body)}</div></div>`).join("")
                : `<p class="muted" style="margin:0">No messages yet. This is for quick notes between the three of you.</p>`) +
    `</div><form class="row" id="chatForm" style="margin-top:10px;flex-wrap:nowrap"><input id="chatInput" class="text" maxlength="500" placeholder="Message the partners" autocomplete="off" aria-label="Message"><button class="btn" type="submit">Send</button></form></section>`;
  return h;
}

// ---------- alerts (bell) and phone notifications ----------
const ICON = {sale:"🧾", credit:"📝", payment:"💵", order:"🛒", reminder:"⏰", chat:"💬", stock:"📦", call:"📞"};
const KIND_TAB = {sale:"sales", credit:"owed", payment:"owed", reminder:"owed", order:"orders", chat:"team", call:"team", stock:"stock"};
const unreadCount = () => S.notifs.filter(n => !n.read_at).length;
function renderBadges(){
  const b = $("#bellBadge"), n = unreadCount();
  b.hidden = !n; b.textContent = n > 9 ? "9+" : String(n);
  const set = (id, c) => { const el = $("#" + id); if (el){ el.hidden = !c; el.textContent = c; } };
  set("badge-orders", S.orders.filter(o => o.status === "open").length);
  set("badge-owed", S.debts.filter(d => dueInfo(d.due_on).rank <= 1).length);
}
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !!(window.BUSYNES_CONFIG || {}).VAPID_PUBLIC_KEY;
const b64ToU8 = b => { const p = "=".repeat((4 - b.length % 4) % 4), r = atob((b + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(r, c => c.charCodeAt(0)); };
async function savePushSubscription(askPermission){
  if (!pushSupported()) return false;
  if (Notification.permission !== "granted"){
    if (!askPermission || Notification.permission === "denied") return false;
    if (await Notification.requestPermission() !== "granted") return false;
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey: b64ToU8(window.BUSYNES_CONFIG.VAPID_PUBLIC_KEY)});
  const j = sub.toJSON();
  await must(S.sb.rpc("save_push_subscription", {p_endpoint:j.endpoint, p_p256dh:j.keys.p256dh, p_auth:j.keys.auth}));
  store.set("busynes.push", "1");
  return true;
}
function pushBox(){
  if (!(window.BUSYNES_CONFIG || {}).VAPID_PUBLIC_KEY) return "";
  if (!pushSupported()) return isIOS() && !isStandalone()
    ? `<p class="banner">To get alerts on your phone, first install BusyNes: tap Share, then <b>Add to Home Screen</b>, and open it from there.</p>` : "";
  if (Notification.permission === "denied") return `<p class="banner bad">Phone notifications are blocked. Allow notifications for BusyNes in your phone's settings, then come back here.</p>`;
  if (Notification.permission === "granted" && store.get("busynes.push") === "1") return `<p class="muted" style="margin:0">Phone notifications are on for this phone ✓</p>`;
  return `<button class="btn amber" type="button" id="enablePush">Turn on phone notifications</button>`;
}
function notifSheet(){
  const list = S.notifs, unread = new Set(list.filter(n => !n.read_at).map(n => n.id));
  openSheet(`<div class="grab"></div><div class="row"><h2>Alerts</h2><span class="spacer"></span><button class="btn small ghost" id="sheetCancel" type="button">Close</button></div>
    ${pushBox()}
    <div class="list">${list.length ? list.map(n => `<button type="button" class="notif ${unread.has(n.id) ? "unread" : ""}" data-notif="${n.id}"><span class="ico" aria-hidden="true">${ICON[n.kind] || "🔔"}</span><span class="main"><b>${esc(n.title)}</b><span class="sub">${esc(n.body)}</span></span><span class="muted tm">${dayLabel(n.at)}<br>${timeLabel(n.at)}</span></button>`).join("")
      : `<div class="empty"><b>Nothing yet</b>Sales, orders, reminders and messages show up here.</div>`}</div>`);
  $("#sheetCancel").onclick = closeSheet;
  const ep = $("#enablePush");
  if (ep) ep.onclick = () => once(ep, async () => {
    try { if (await savePushSubscription(true)){ toast("Phone notifications are on."); notifSheet(); } else toast("Notifications weren't turned on."); }
    catch(err){ failed(err); }
  });
  document.querySelectorAll("[data-notif]").forEach(b => b.onclick = () => {
    const n = S.notifs.find(x => x.id === Number(b.dataset.notif)); closeSheet();
    if (n) goTab(KIND_TAB[n.kind] || "sell");
  });
  // Opening the list counts as reading it.
  if (unread.size){
    const top = Math.max(...unread);
    S.notifs.forEach(n => { if (!n.read_at) n.read_at = new Date().toISOString(); });
    renderBadges();
    S.sb.rpc("mark_notifications_read", {p_up_to: top}).then(() => {}, () => {});
  }
}
const TABS = ["sell","orders","owed","stock","sales","report","team"];
function goTab(t){
  if (!TABS.includes(t)) t = "sell";
  S.tab = t; store.set("busynes.tab", t); S.confirmDel = null; S.editing = null; render(); window.scrollTo(0,0);
}

function viewStock(){
  const os = owners();
  let h = `<div class="row"><h2>Stock on hand</h2><span class="spacer"></span><button class="btn small" type="button" data-newprod>Add product</button></div>
    <p class="muted" style="margin:-12px 0 0">Stock drops by itself with every sale. Add deliveries when you buy, or do a fridge count to correct it.</p>`;
  if (!S.products.length) return h + `<div class="empty"><b>No products yet</b>Tap Add product to set up your first drink.</div>`;
  for (const o of Object.values(os)){
    const list = S.products.filter(p => p.owner === o.id); if (!list.length) continue;
    h += `<section class="card"><div class="owner-head"><span class="owner-tag"><i style="background:${o.color}"></i>${esc(o.name)}'s</span></div><div class="list">`;
    for (const p of list){
      const n = S.stock[p.id] || 0, cls = n <= 0 ? "out" : n <= LOW ? "low" : "";
      if (S.editing === p.id){
        h += `<div class="item" style="flex-direction:column;align-items:stretch;gap:12px">
          <div class="title">${esc(p.name)} <span class="muted">· ${n} in stock</span></div>
          <div class="row"><div class="field" style="flex:1;min-width:120px"><label for="addQty">Delivery: add</label><div class="stepper"><input id="addQty" class="text num" type="number" inputmode="numeric" min="1" step="1" placeholder="0"><button class="btn small" type="button" data-doadd="${esc(p.id)}">Add</button></div></div>
          <div class="field" style="flex:1;min-width:120px"><label for="countQty">Fridge count: set to</label><div class="stepper"><input id="countQty" class="text num" type="number" inputmode="numeric" min="0" step="1" placeholder="${Math.max(n,0)}"><button class="btn small ghost" type="button" data-docount="${esc(p.id)}">Set</button></div></div></div>
          <div class="row"><div class="field" style="flex:1;min-width:120px"><label for="priceIn">Price (R)</label><div class="stepper"><input id="priceIn" class="text num" type="number" inputmode="decimal" min="0" step="1" value="${num(p.price)}"><button class="btn small ghost" type="button" data-doprice="${esc(p.id)}">Save</button></div></div>
          <div class="field" style="flex:1;min-width:120px"><span class="lab">On the Sell screen</span><button class="btn small ghost" type="button" data-dohide="${esc(p.id)}">${p.hidden ? "Show it again" : "Hide it"}</button></div></div>
          <div class="row end"><button class="btn small ghost" type="button" data-editdone>Close</button></div>
        </div>`;
      } else {
        h += `<div class="item"><div class="main"><div class="title">${esc(p.name)}${p.hidden ? ` <span class="pill">hidden</span>` : ""}</div><div class="sub num">${money(p.price)} each${n <= 0 ? " · restock needed" : n <= LOW ? " · running low" : ""}</div></div>
          <div class="stockn num ${cls}">${n}</div><button class="btn small ghost" type="button" data-edit="${esc(p.id)}" aria-label="Update ${esc(p.name)}">Update</button></div>`;
      }
    }
    h += `</div></section>`;
  }
  if (S.moves.length){
    h += `<section><div class="eyebrow" style="margin-bottom:6px">Recent stock changes</div><div class="card list">` + S.moves.map(m => {
      const p = productById(m.product_id);
      return `<div class="item"><div class="main"><div class="title">${m.kind === "add" ? "+" + m.qty : "Counted " + m.qty} ${esc(p ? p.name : m.product_id)}</div><div class="sub">${dayLabel(m.at)} ${timeLabel(m.at)} · ${esc(Pname(m.by))}</div></div></div>`;
    }).join("") + `</div></section>`;
  }
  return h;
}

function newProductSheet(){
  const os = Object.values(owners());
  openSheet(`<div class="grab"></div><h2>Add a product</h2>
    <div class="field"><label for="npName">Name</label><input id="npName" class="text" maxlength="40" placeholder="e.g. Hunter's Dry"></div>
    <div class="field"><label for="npPrice">Selling price (R)</label><input id="npPrice" class="text num" type="number" inputmode="decimal" min="0" step="1"></div>
    <div class="field"><span class="lab">Whose stock is it?</span><div class="chips">${os.map((o,i) => `<button type="button" class="chip" data-npowner="${esc(o.id)}" aria-pressed="${i===0}">${esc(o.name)}</button>`).join("")}</div></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn" type="button" id="npSave">Add product</button></div>`);
  let owner = os[0] && os[0].id;
  document.querySelectorAll("[data-npowner]").forEach(b => b.onclick = () => { owner = b.dataset.npowner; document.querySelectorAll("[data-npowner]").forEach(x => x.setAttribute("aria-pressed", String(x===b))); });
  $("#sheetCancel").onclick = closeSheet;
  $("#npSave").onclick = async e => {
    const name = $("#npName").value.trim(), price = parseFloat($("#npPrice").value);
    if (!name || !(price >= 0)) { toast("Give it a name and a price."); return; }
    let id = slug(name); if (productById(id)) id += "-" + Date.now().toString(36);
    e.target.disabled = true;
    try { await must(S.sb.from("products").insert({id, name, price, owner, sort:99})); closeSheet(); toast(name + " added."); await refresh(); }
    catch(err){ e.target.disabled = false; failed(err); }
  };
}

function viewSales(){
  if (!S.sales.length) return `<h2>Sales</h2><div class="empty"><b>No sales to show yet</b>You'll see sales paid to you, sales you recorded, and sales of your own products.</div>`;
  let h = `<h2>Sales</h2><p class="muted" style="margin:-12px 0 0">Showing sales paid to you, sales you recorded, and sales of your own products. Other partners' money stays private.</p>`, cur = "";
  const visibleTotal = s => s.sale_items.reduce((a,i) => a + num(i.price)*i.qty, 0);
  for (const s of S.sales){
    const k = dayKey(s.at);
    if (k !== cur){
      if (cur) h += `</div></section>`;
      h += `<section class="day"><div class="owner-head"><span class="eyebrow">${dayLabel(s.at)}</span></div><div class="card" style="padding-block:2px">`;
      cur = k;
    }
    const whole = s.paid_to === S.me || s.recorded_by === S.me;
    const canDel = whole, del = S.confirmDel === s.id;
    h += `<div class="sale"><div class="top"><span class="what">${s.sale_items.map(i => i.qty + " × " + esc(i.name)).join(", ")}</span><b class="num">${money(visibleTotal(s))}</b></div>
      <div class="row" style="gap:6px;font-size:13px"><span class="pill ${s.method==="cash"?"cash":""}">${s.method === "cash" ? "Cash" : "Account"} → ${esc(Pname(s.paid_to))}</span>${whole && s.sale_payments && visibleTotal(s) - paidOf(s) > 0.005 ? ` <span class="pill bad">Owes ${money2(visibleTotal(s) - paidOf(s))}</span>` : ""}
      <span class="muted">${timeLabel(s.at)} · by ${esc(pname(s.recorded_by))}${s.note && whole ? " · " + esc(s.note) : ""}${whole ? "" : " · your items only"}</span><span class="spacer"></span>
      ${canDel ? (del ? `<button class="linkbtn" type="button" data-nodel>Keep</button><button class="linkbtn bad" type="button" data-dodel="${s.id}">Yes, delete</button>` : `<button class="linkbtn" type="button" data-del="${s.id}">Delete</button>`) : ""}</div></div>`;
  }
  return h + `</div></section>`;
}

// ---------- my money ----------
function viewReport(){
  const m = S.money || {received:0, received_cash:0, due:0, sold:[], pays:[], orders:0};
  const periods = [["settle","Since last settle-up"],["today","Today"],["week","This week"],["all","All time"]];
  let h = `<h2>My money</h2><div class="chips">${periods.map(([k,l]) => `<button type="button" class="chip" data-period="${k}" aria-pressed="${S.period===k}">${l}</button>`).join("")}</div>`;
  if (S.period === "settle") h += `<p class="muted" style="margin:-8px 0 0">${S.settlements[0] ? "Counting from the settle-up on " + dayLabel(S.settlements[0].at) + " at " + timeLabel(S.settlements[0].at) + "." : "No settle-ups yet, so this counts every sale."}</p>`;

  const received = num(m.received), cash = num(m.received_cash), due = num(m.due), diff = Math.round((received - due)*100)/100;
  h += `<div class="kpis">
    <div class="kpi"><span class="eyebrow">Money you received</span><b class="num">${money2(received)}</b><span class="muted num">${money(cash)} cash · ${money(received - cash)} account</span></div>
    <div class="kpi"><span class="eyebrow">Your share collected</span><b class="num">${money2(due)}</b><span class="muted num">of ${money(m.sold_value != null ? m.sold_value : due)} of your stock sold</span></div></div>`;
  if (num(m.outstanding) > 0.005) h += `<section class="card statement">Customers still owe <b class="num">${money2(m.outstanding)}</b> on your products. It counts here once they pay.</section>`;
  h += `<section class="card statement">${diff > 0 ? `You're holding <b class="num">${money2(diff)}</b> that belongs to your partners.`
       : diff < 0 ? `Your partners are holding <b class="num">${money2(-diff)}</b> of your money.`
       : `You hold exactly your own money.`}</section>`;

  h += `<section class="card"><div class="eyebrow">To settle up</div>`;
  h += m.pays.length ? m.pays.map(p => `<div class="pay"><span>${p.from === S.me ? "You pay " + esc(pname(p.to)) : esc(pname(p.from)) + " pays you"}</span><span class="amt num ${p.from === S.me ? "pos" : "neg"}">${money2(p.amount)}</span></div>`).join("")
    : `<p style="margin:8px 0 0">Nothing to hand over for you.</p>`;
  h += `<div class="row" style="margin-top:12px"><button class="btn ghost small" type="button" data-copyreport>Copy my settle-up</button><span class="spacer"></span><button class="btn small" type="button" data-settle>Mark as settled</button></div></section>`;

  const sold = m.sold || [];
  if (sold.length){
    const max = Math.max(...sold.map(p => num(p.amount)));
    h += `<section class="card"><div class="eyebrow">Your products sold</div><div class="list">` + sold.map(p => `<div class="item" style="display:block"><div class="row"><span class="title">${esc(p.name)}</span><span class="spacer"></span><span class="num">${p.qty} sold · <b>${money(p.amount)}</b>${num(p.my_share) !== num(p.amount) ? ` <span class="muted">(your share ${money2(p.my_share)})</span>` : ""}</span></div><div class="bar"><i style="width:${(num(p.amount)/max*100).toFixed(1)}%;background:var(--bottle)"></i></div></div>`).join("") + `</div></section>`;
  } else {
    h += `<div class="empty"><b>None of your stock sold in this period</b>When it does, it shows up here.</div>`;
  }
  return h;
}
function reportText(){
  const m = S.money, me = (S.partners.find(p => p.id === S.me) || {}).name;
  const lbl = {settle:"since last settle-up", today:"today", week:"this week", all:"all time"}[S.period];
  const nm = id => (S.partners.find(p => p.id === id) || {name:id}).name;
  return `📊 ${me}'s settle-up (${lbl})\n` + (m.pays.length ? m.pays.map(p => `${nm(p.from)} → ${nm(p.to)}: ${money2(p.amount)}`).join("\n") : "Nothing to hand over.");
}
function settleSheet(){
  openSheet(`<div class="grab"></div><h2>Mark as settled?</h2>
    <p>Do this once all the settle-up money has changed hands between the three of you. "Since last settle-up" then starts again from zero for everyone. Old sales stay in the records.</p>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Not yet</button><span class="spacer"></span><button class="btn" type="button" id="doSettle">Yes, we're settled</button></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#doSettle").onclick = async e => {
    e.target.disabled = true;
    try { await must(S.sb.from("settlements").insert({by:S.me})); closeSheet(); S.period = "settle"; toast("Settled. Starting fresh."); await refresh(); }
    catch(err){ e.target.disabled = false; failed(err); }
  };
}

// ---------- events ----------
function bindView(){
  const v = $("#view");
  v.querySelectorAll("[data-add]").forEach(b => b.onclick = () => { const id = b.dataset.add; S.cart[id] = (S.cart[id]||0) + 1; render(); });
  v.querySelectorAll("[data-sub]").forEach(b => b.onclick = () => { const id = b.dataset.sub; S.cart[id] = Math.max(0,(S.cart[id]||0) - 1); if (!S.cart[id]) delete S.cart[id]; render(); });
  v.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => { S.editing = b.dataset.edit; render(); });
  v.querySelectorAll("[data-editdone]").forEach(b => b.onclick = () => { S.editing = null; render(); });
  v.querySelectorAll("[data-newprod]").forEach(b => b.onclick = newProductSheet);
  v.querySelectorAll("[data-doadd]").forEach(b => b.onclick = () => once(b, () => stockMove(b.dataset.doadd, "add", $("#addQty").value)));
  v.querySelectorAll("[data-docount]").forEach(b => b.onclick = () => once(b, () => stockMove(b.dataset.docount, "count", $("#countQty").value)));
  v.querySelectorAll("[data-doprice]").forEach(b => b.onclick = () => once(b, async () => {
    const price = parseFloat($("#priceIn").value); if (!(price >= 0)) return toast("Enter a price in rand.");
    try { await must(S.sb.from("products").update({price}).eq("id", b.dataset.doprice)); toast("Price saved."); await refresh(); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-dohide]").forEach(b => b.onclick = () => once(b, async () => {
    const p = productById(b.dataset.dohide);
    try { await must(S.sb.from("products").update({hidden: !p.hidden}).eq("id", p.id)); await refresh(); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { S.confirmDel = Number(b.dataset.del); render(); });
  v.querySelectorAll("[data-nodel]").forEach(b => b.onclick = () => { S.confirmDel = null; render(); });
  v.querySelectorAll("[data-dodel]").forEach(b => b.onclick = () => once(b, async () => {
    try { await must(S.sb.rpc("delete_sale", {p_id: Number(b.dataset.dodel)})); S.confirmDel = null; toast("Sale deleted. Stock is back."); await refresh(); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-period]").forEach(b => b.onclick = async () => { S.period = b.dataset.period; render(); await refresh(); });
  v.querySelectorAll("[data-copyreport]").forEach(b => b.onclick = () => copyText(reportText()));
  v.querySelectorAll("[data-settle]").forEach(b => b.onclick = settleSheet);
  v.querySelectorAll("[data-neworder]").forEach(b => b.onclick = newOrderSheet);
  v.querySelectorAll("[data-fillorder]").forEach(b => b.onclick = () => fillFromOrder(Number(b.dataset.fillorder)));
  v.querySelectorAll("[data-cancelorder]").forEach(b => b.onclick = () => once(b, async () => {
    try { await must(S.sb.rpc("cancel_order", {p_id: Number(b.dataset.cancelorder)})); toast("Order cancelled."); await refresh(); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-pay]").forEach(b => b.onclick = () => paySheet(Number(b.dataset.pay)));
  v.querySelectorAll("[data-due]").forEach(b => b.onclick = () => dueSheet(Number(b.dataset.due)));
  v.querySelectorAll("[data-remind]").forEach(b => b.onclick = () => { const d = S.debts.find(x => x.sale_id === Number(b.dataset.remind)); if (d) copyText(reminderText(d)); });
  v.querySelectorAll("[data-ping]").forEach(b => b.onclick = () => once(b, async () => {
    try { await must(S.sb.rpc("ping_partner", {p_to: b.dataset.ping})); toast("Sent. They've been asked to call you."); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-savephone]").forEach(b => b.onclick = () => once(b, async () => {
    try { await must(S.sb.rpc("set_my_phone", {p_phone: $("#myPhone").value})); toast("Number saved."); await refresh(); } catch(err){ failed(err); }
  }));
  const cf = $("#chatForm");
  if (cf) cf.onsubmit = e => {
    e.preventDefault();
    const inp = $("#chatInput"), body = inp.value.trim(); if (!body) return;
    once(cf.querySelector("button"), async () => {
      try { await must(S.sb.rpc("send_message", {p_body: body})); inp.value = ""; await refresh(); const box = $("#chatBox"); if (box) box.scrollTop = box.scrollHeight; }
      catch(err){ failed(err); }
    });
  };
}
async function stockMove(pid, kind, raw){
  const qty = parseInt(raw, 10);
  if (!(qty >= (kind === "add" ? 1 : 0))) return toast(kind === "add" ? "Enter how many came in." : "Enter how many are in the fridge.");
  try {
    await must(S.sb.from("stock_moves").insert({product_id:pid, kind, qty, by:S.me}));
    S.editing = null; toast(kind === "add" ? "Added " + qty + "." : "Stock set to " + qty + ".");
    await refresh();
  } catch(err){ failed(err); }
}

document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => goTab(b.dataset.tab));
$("#bellBtn").onclick = notifSheet;
$("#teamBtn").onclick = () => goTab("team");
$("#cartClear").onclick = () => { S.cart = {}; S.fromOrder = null; render(); };
$("#cartNext").onclick = checkout;
$("#refreshBtn").onclick = () => refresh();
// "Install app": Android/desktop Chrome offer a prompt we can trigger; iPhone has to use Share > Add to Home Screen.
let installEvent = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvent = e; });
window.addEventListener("appinstalled", () => { installEvent = null; });
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

$("#meBtn").onclick = () => {
  const install = isStandalone() ? "" : installEvent
    ? `<button class="btn amber" type="button" id="installBtn">Install BusyNes on this phone</button>`
    : isIOS() ? `<p class="muted">To install: tap the Share button in Safari, then <b>Add to Home Screen</b>.</p>` : "";
  openSheet(`<div class="grab"></div><h2>Signed in as ${esc((S.partners.find(p => p.id === S.me) || {}).name)}</h2>
    <p class="muted">${esc(S.user && S.user.email)}</p>
    ${install}
    <div class="row"><button class="btn ghost" type="button" id="changePass">Change password</button><span class="spacer"></span><button class="btn danger" type="button" id="signOut">Sign out</button></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Close</button><span class="spacer"></span><span class="muted">BusyNes v${VERSION}</span></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#changePass").onclick = passwordSheet;
  $("#signOut").onclick = async () => { closeSheet(); await S.sb.auth.signOut(); };
  const ib = $("#installBtn");
  if (ib) ib.onclick = async () => { const ev = installEvent; installEvent = null; closeSheet(); if (ev){ ev.prompt(); await ev.userChoice; } };
};

// Set a new password: used by "Change password" and by the link in a reset email.
function passwordSheet(){
  openSheet(`<div class="grab"></div><h2>Choose a new password</h2>
    <div class="field"><label for="newPass">New password (6 or more characters)</label><input id="newPass" class="text" type="password" autocomplete="new-password" minlength="6"></div>
    <div class="err" id="passErr" role="alert" style="color:var(--bad);font-weight:600;min-height:1.4em"></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn" type="button" id="savePass">Save password</button></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#savePass").onclick = e => once(e.target, async () => {
    const password = $("#newPass").value;
    if (password.length < 6) { $("#passErr").textContent = "Use at least 6 characters."; return; }
    const {error} = await S.sb.auth.updateUser({password});
    if (error) { $("#passErr").textContent = error.message; return; }
    closeSheet(); toast("Password changed.");
  });
}

// ---------- sign in ----------
async function enter(session){
  S.user = session ? session.user : null;
  if (!S.user){ S.loaded = false; show("authScreen"); return; }
  const me = await S.sb.rpc("my_partner");
  if (me.error){
    // Usually no signal. Don't claim they're not a partner; retry when the connection is back.
    show("appScreen"); S.loaded = false; render();
    toast("Can't reach BusyNes. Check your connection.", {label:"Try again", run:() => enter(session)});
    window.addEventListener("online", () => enter(session), {once:true});
    return;
  }
  if (!me.data){ $("#npEmail").textContent = S.user.email; show("notPartnerScreen"); return; }
  S.me = me.data;
  show("appScreen"); render();
  await refresh();
  if (pushSupported() && Notification.permission === "granted") savePushSubscription(false).catch(() => {});
}
function authErr(msg){ $("#authErr").textContent = msg || ""; }
$("#authForm").onsubmit = e => {
  e.preventDefault();
  once($("#signInBtn"), async () => {
    authErr("");
    const {error} = await S.sb.auth.signInWithPassword({email:$("#authEmail").value.trim(), password:$("#authPass").value});
    if (error) authErr(/invalid/i.test(error.message) ? "That email and password don't match. First time here? Tap Create my login." : error.message);
  });
};
$("#signUpBtn").onclick = () => once($("#signUpBtn"), async () => {
  authErr("");
  const email = $("#authEmail").value.trim(), password = $("#authPass").value;
  if (!email || password.length < 6) return authErr("Type your email and a password of at least 6 characters, then tap Create my login.");
  // Send the confirmation link back to wherever this copy of the app is running.
  const {data, error} = await S.sb.auth.signUp({email, password, options:{emailRedirectTo: location.origin + location.pathname}});
  if (error) return authErr(error.message);
  if (!data.session) authErr("Check your email for a confirmation link, then come back and sign in.");
});
$("#forgotBtn").onclick = () => once($("#forgotBtn"), async () => {
  authErr("");
  const email = $("#authEmail").value.trim();
  if (!email) return authErr("Type your email above first, then tap Forgot my password.");
  const {error} = await S.sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
  authErr(error ? error.message : "If that email has a BusyNes login, a reset link is on its way. Check your inbox.");
});
$("#npSignOut").onclick = () => S.sb.auth.signOut();

// ---------- start ----------
(function start(){
  const cfg = window.BUSYNES_CONFIG || {};
  if (!cfg.SUPABASE_URL || /YOUR-PROJECT/.test(cfg.SUPABASE_URL) || !cfg.SUPABASE_ANON_KEY || /YOUR-ANON-KEY/.test(cfg.SUPABASE_ANON_KEY)){
    show("setupScreen"); return;
  }
  S.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {db:{schema:"busynes"}});
  let lastUser;
  S.sb.auth.onAuthStateChange((_event, session) => {
    const id = session && session.user && session.user.id;
    if (_event === "PASSWORD_RECOVERY"){   // they opened the reset link from their email
      lastUser = id;
      setTimeout(async () => { await enter(session); passwordSheet(); }, 0);
      return;
    }
    if (id === lastUser) return;          // ignore token refreshes
    lastUser = id;
    setTimeout(() => enter(session), 0);  // don't call Supabase inside the auth callback
  });
  setInterval(() => { if (S.me && document.visibilityState === "visible" && !$("#overlay").innerHTML && !S.editing) refresh(true); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (S.me && document.visibilityState === "visible") refresh(true); });
  const wanted = new URLSearchParams(location.search).get("tab");
  if (wanted && TABS.includes(wanted)) S.tab = wanted;
  if ("serviceWorker" in navigator && location.protocol !== "file:"){
    navigator.serviceWorker.register("sw.js").catch(() => {});
    // Tapping a phone notification asks the open app to jump to the right tab.
    navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.type === "open-tab" && S.me) goTab(e.data.tab); });
  }
})();
})();

// BusyNes: record drink sales, track stock, and see your own side of the money.
// Data lives in Supabase. Privacy is enforced by the database (see supabase/schema.sql),
// so this file only ever receives what the signed-in partner is allowed to see.
(() => {
"use strict";

const LOW = 3;               // "running low" threshold
const POLL_MS = 20000;       // refresh while the app is open
const OWNER_COLORS = ["var(--beer)", "var(--sib)", "var(--bottle)", "var(--warn)"]; // given to owner groups in alphabetical order

// ---------- state ----------
const S = {
  sb: null, user: null, me: null,
  partners: [], shares: [], products: [], stock: {}, moves: [], sales: [], settlements: [], money: null,
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

async function loadAll(){
  const sb = S.sb;
  const [partners, shares, products, stock, moves, sales, settlements] = await Promise.all([
    must(sb.from("partners").select("id,name")),
    must(sb.from("owner_shares").select("owner,partner_id,share").order("owner").order("partner_id")),
    must(sb.from("products").select("*").order("sort").order("name")),
    must(sb.rpc("stock_levels")),
    must(sb.from("stock_moves").select("*").order("at",{ascending:false}).limit(8)),
    must(sb.from("sales").select("id,at,paid_to,method,note,recorded_by,sale_items(product_id,name,owner,price,qty)").order("at",{ascending:false}).limit(300)),
    must(sb.from("settlements").select("*").order("at",{ascending:false}).limit(20)),
  ]);
  Object.assign(S, {partners, shares, products, moves, sales, settlements});
  S.stock = {}; for (const r of stock) S.stock[r.product_id] = r.qty;
  S.money = await must(sb.rpc("my_money", {p_from: periodStart()}));
  S.loaded = true;
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
  else if (S.tab === "stock") html = viewStock();
  else if (S.tab === "sales") html = viewSales();
  else html = viewReport();
  $("#view").innerHTML = html;
  bindView();
  renderCart();
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

let draft = {paidTo:null, method:null, note:""};
function checkout(){
  const lines = cartLines(); if (!lines.length) return;
  if (!draft.paidTo) draft.paidTo = S.me;
  if (!draft.method) draft.method = "transfer";
  const total = lines.reduce((a,l) => a + l.qty*l.price, 0);
  openSheet(`<div class="grab"></div>
    <h2>Record this sale</h2>
    <div class="lines num">${lines.map(l => `<div class="line"><span>${l.qty} × ${esc(l.name)}</span><span>${money(l.qty*l.price)}</span></div>`).join("")}
      <div class="line total"><span>Total</span><span>${money(total)}</span></div></div>
    <div class="field"><span class="lab">Who got the money?</span>
      <div class="chips" role="group">${S.partners.map(p => `<button type="button" class="chip" data-paid="${esc(p.id)}" aria-pressed="${draft.paidTo===p.id}">${esc(p.id === S.me ? "Me" : p.name)}</button>`).join("")}</div></div>
    <div class="field"><span class="lab">How was it paid?</span>
      <div class="chips" role="group"><button type="button" class="chip" data-method="transfer" aria-pressed="${draft.method==="transfer"}">Into their account</button><button type="button" class="chip" data-method="cash" aria-pressed="${draft.method==="cash"}">Cash</button></div></div>
    <div class="field"><label for="saleNote">Customer or note (optional)</label><input id="saleNote" class="text" maxlength="80" placeholder="e.g. Thando, block C" value="${esc(draft.note)}"></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Back</button><span class="spacer"></span><button class="btn" type="button" id="saveSale">Save sale · ${money(total)}</button></div>`);
  document.querySelectorAll("[data-paid]").forEach(b => b.onclick = () => { draft.paidTo = b.dataset.paid; document.querySelectorAll("[data-paid]").forEach(x => x.setAttribute("aria-pressed", String(x===b))); });
  document.querySelectorAll("[data-method]").forEach(b => b.onclick = () => { draft.method = b.dataset.method; document.querySelectorAll("[data-method]").forEach(x => x.setAttribute("aria-pressed", String(x===b))); });
  $("#saleNote").oninput = e => draft.note = e.target.value;
  $("#sheetCancel").onclick = closeSheet;
  $("#saveSale").onclick = async e => {
    e.target.disabled = true;
    const sale = {at:new Date().toISOString(), items:lines, total, paidTo:draft.paidTo, method:draft.method, note:draft.note.trim()};
    try {
      await must(S.sb.rpc("record_sale", {
        p_items: lines.map(l => ({product_id:l.product_id, qty:l.qty})),
        p_paid_to: sale.paidTo, p_method: sale.method, p_note: sale.note,
      }));
      S.cart = {}; draft = {paidTo:null, method:null, note:""};
      closeSheet();
      toast("Saved " + money(total) + " paid to " + pname(sale.paidTo) + ".", {label:"Copy for group", run:() => copyText(saleText(sale))});
      await refresh();
    } catch(err){ e.target.disabled = false; failed(err); }
  };
}
function saleText(s){
  const who = (S.partners.find(p => p.id === s.paidTo) || {name:s.paidTo}).name;
  return `✅ Sale ${dayLabel(s.at)} ${timeLabel(s.at)}\n` + s.items.map(i => `${i.qty} × ${i.name} = ${money(i.qty*i.price)}`).join("\n") +
    `\nTotal: ${money(s.total)}\nPaid to ${who} (${s.method === "cash" ? "cash" : "account"})` + (s.note ? `\nNote: ${s.note}` : "");
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
      <div class="row" style="gap:6px;font-size:13px"><span class="pill ${s.method==="cash"?"cash":""}">${s.method === "cash" ? "Cash" : "Account"} → ${esc(Pname(s.paid_to))}</span>
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
    <div class="kpi"><span class="eyebrow">Your stock sold</span><b class="num">${money2(due)}</b><span class="muted num">what you're owed</span></div></div>`;
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

document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => {
  S.tab = b.dataset.tab; store.set("busynes.tab", S.tab); S.confirmDel = null; S.editing = null; render(); window.scrollTo(0,0);
});
$("#cartClear").onclick = () => { S.cart = {}; render(); };
$("#cartNext").onclick = checkout;
$("#refreshBtn").onclick = () => refresh();
$("#meBtn").onclick = () => {
  openSheet(`<div class="grab"></div><h2>Signed in as ${esc((S.partners.find(p => p.id === S.me) || {}).name)}</h2>
    <p class="muted">${esc(S.user && S.user.email)}</p>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Close</button><span class="spacer"></span><button class="btn danger" type="button" id="signOut">Sign out</button></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#signOut").onclick = async () => { closeSheet(); await S.sb.auth.signOut(); };
};

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
  const {data, error} = await S.sb.auth.signUp({email, password});
  if (error) return authErr(error.message);
  if (!data.session) authErr("Check your email for a confirmation link, then come back and sign in.");
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
    if (id === lastUser) return;          // ignore token refreshes
    lastUser = id;
    setTimeout(() => enter(session), 0);  // don't call Supabase inside the auth callback
  });
  setInterval(() => { if (S.me && document.visibilityState === "visible" && !$("#overlay").innerHTML && !S.editing) refresh(true); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (S.me && document.visibilityState === "visible") refresh(true); });
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
})();

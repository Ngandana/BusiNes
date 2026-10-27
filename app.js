// BusyNes: sales, stock, orders and who gets what, for any small business.
// Data lives in Supabase. Privacy is enforced by the database (see supabase/schema.sql):
// a business is only visible to the people who belong to it, and each person only receives
// what their role allows. This file only ever shows what it is given.
(() => {
"use strict";

const VERSION = "3.5";
const LOW = 3;               // "running low" threshold
const POLL_MS = 20000;       // refresh while the app is open
const OWNER_COLORS = ["var(--beer)", "var(--sib)", "var(--bottle)", "var(--warn)"]; // given to owner groups in order

// ---------- state ----------
const S = {
  sb: null, user: null, me: null,
  biz: null, businesses: [], unreadBy: {}, members: null,
  partners: [], shares: [], products: [], stock: {}, moves: [], sales: [], settlements: [], money: null,
  orders: [], debts: [], notifs: [], messages: [], seenNotif: null, fromOrder: null, salesFilter: "all", sq: "", speriod: "all", smethod: "all", sstatus: "all", orderFees: {}, costs: {}, profit: null,
  tab: "sell", cart: {}, period: "settle", editing: null, confirmDel: null, loaded: false, offline: false,
};
const store = {
  get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
  set(k,v){ try { localStorage.setItem(k,v); } catch(e){} },
};
S.tab = store.get("busynes.tab") || "sell";

// ---------- who am I in this business ----------
const role = () => (S.biz && S.biz.role) || "";
const bid = () => S.biz.id;
const isOwner = () => role() === "owner";
const canManage = () => role() === "owner" || role() === "partner";               // products, prices, settling up
const canSell = () => ["owner","partner","staff"].includes(role());               // sales, orders, stock
const isDelivery = () => role() === "delivery";                                    // sees and takes orders only
const NAV = () => isDelivery() ? ["orders"] : ["sell","orders","owed","stock","sales","report"];
const TABS = ["sell","orders","owed","stock","sales","report","team","settings"];
const ROLE_NAME = {owner:"Owner", partner:"Partner", staff:"Staff", delivery:"Delivery"};
const ROLE_HELP = {
  partner: "Owns part of the business. Records sales, manages products and stock, and sees their own share.",
  staff: "Records sales, orders and stock. Doesn't own anything or change prices.",
  delivery: "Sees orders, takes them and delivers. Nothing else.",
};

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = v => Number(v) || 0;
// Each business has its own currency symbol (R, $, €, KSh...). A longer symbol gets a space after it.
const cur = () => (S.biz && S.biz.currency) || "R";
const sym = () => { const c = cur(); return c + (c.length > 1 ? " " : ""); };
const money = n => sym() + Math.round(num(n)).toLocaleString("en-ZA").replace(/ /g," ");
const money2 = n => { const r = Math.round(num(n)*100)/100; return Number.isInteger(r) ? money(r) : sym() + r.toFixed(2); };
const CUR_LIST = `<datalist id="curList"><option value="R"><option value="$"><option value="€"><option value="£"><option value="₦"><option value="KSh"><option value="N$"><option value="P"></datalist>`;
const dayKey = d => { d = new Date(d); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
const dayLabel = iso => {
  const k = dayKey(iso);
  if (k === dayKey(new Date())) return "Today";
  if (k === dayKey(Date.now()-864e5)) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-ZA",{weekday:"short", day:"numeric", month:"short"});
};
const timeLabel = iso => new Date(iso).toLocaleTimeString("en-ZA",{hour:"2-digit", minute:"2-digit"});
const pname = id => id === S.me ? "you" : ((S.partners.find(p => p.id === id) || {}).name || "someone");
const Pname = id => { const n = pname(id); return n === "you" ? "You" : n; };
const productById = id => S.products.find(p => p.id === id);
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40) || ("g" + Date.now().toString(36));
const niceGroup = id => String(id).replace(/[-_]+/g," ").replace(/\b\w/g, c => c.toUpperCase());
const pct = f => (Math.round(num(f) * 10000) / 100) + "%";
const pct1 = f => (Math.round(num(f) * 1000) / 10) + "%";
const appLink = () => location.origin + location.pathname.replace(/[^/]*$/, "");

// Owner groups ("everyone", "beers") come from the ownership table. Each group is owned by one or more people.
function owners(){
  const map = {};
  for (const sh of S.shares){
    const o = map[sh.owner] || (map[sh.owner] = {id:sh.owner, partners:[]});
    o.partners.push(sh.partner_id);
  }
  Object.values(map).forEach((o,i) => {
    o.name = o.partners.map(id => (S.partners.find(p => p.id === id) || {name:"?"}).name).join(" & ");
    o.mine = o.partners.includes(S.me);
    o.color = OWNER_COLORS[i % OWNER_COLORS.length];
  });
  for (const p of S.products) if (!map[p.owner]) map[p.owner] = {id:p.owner, partners:[], name:niceGroup(p.owner), mine:false, color:"var(--muted)"};
  // Your own stock first, then the rest alphabetically, so the layout doesn't shuffle between refreshes.
  const sorted = {};
  Object.values(map).sort((a,b) => (b.mine - a.mine) || a.id.localeCompare(b.id)).forEach(o => sorted[o.id] = o);
  return sorted;
}
const groupIds = () => [...new Set(S.shares.map(s => s.owner))].sort();

function toast(msg, action){
  const old = document.querySelector(".toast"); if (old) old.remove();
  const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role","status");
  const span = document.createElement("span"); span.textContent = msg; t.appendChild(span);
  if (action){ const b = document.createElement("button"); b.type = "button"; b.textContent = action.label; b.onclick = action.run; t.appendChild(b); }
  document.body.appendChild(t);
  setTimeout(() => t.remove(), action ? 7000 : 2600);
}
async function copyText(text, done){
  try { await navigator.clipboard.writeText(text); toast(done || "Copied."); }
  catch(e){
    openSheet(`<div class="grab"></div><h2>Copy this</h2><p class="muted">Select the text and copy it.</p><textarea id="copyArea" class="text" rows="10" readonly>${esc(text)}</textarea><button class="btn" id="sheetClose" type="button">Done</button>`);
    const a = $("#copyArea"); a.focus(); a.select(); $("#sheetClose").onclick = closeSheet;
  }
}
function failed(err){
  console.error(err);
  toast((err && err.message && !/fetch|network/i.test(err.message)) ? err.message : "That didn't save. Check your connection and try again.");
}

// ---------- sheet ----------
function openSheet(html){
  $("#overlay").innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  $("#scrim").addEventListener("click", e => { if (e.target.id === "scrim") closeSheet(); });
}
function closeSheet(){ $("#overlay").innerHTML = ""; }

// ---------- screens ----------
function show(id){
  ["setupScreen","authScreen","onboardScreen","appScreen"].forEach(s => $("#"+s).hidden = s !== id);
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

// ---------- offline: sales saved on the phone and sent when there's signal ----------
const QKEY = "busynes.queue";
const queue = {
  all(){ try { return JSON.parse(store.get(QKEY) || "[]"); } catch(e){ return []; } },
  save(list){ store.set(QKEY, JSON.stringify(list)); },
  mine(){ return S.biz ? queue.all().filter(q => q.biz === bid()) : []; },
};
const newRef = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); });
const isNetworkError = e => !navigator.onLine || /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout/i.test(String((e && e.message) || e || ""));
// Send a sale. If the database hasn't been updated yet it doesn't know the two newer fields, so send it the older way.
async function callRecordSale(args){
  try { return await must(S.sb.rpc("record_sale", args)); }
  catch(e){
    if (/could not find the function|schema cache/i.test((e && e.message) || "")){
      const old = Object.assign({}, args); delete old.p_client_ref; delete old.p_at;
      return await must(S.sb.rpc("record_sale", old));
    }
    throw e;
  }
}
function queueSale(args, lines, total, paidTo){
  const all = queue.all();
  all.push({ref: args.p_client_ref, biz: args.p_biz, args, lines: lines.map(l => ({name: l.name, qty: l.qty})), total, paidTo, queuedAt: args.p_at, error: null});
  queue.save(all);
}
let flushing = false;
async function flushQueue(){
  if (flushing || !S.sb || !S.user || !navigator.onLine) return 0;
  flushing = true; let sent = 0;
  try {
    for (const item of queue.all()){
      if (item.error) continue;
      try { await callRecordSale(item.args); queue.save(queue.all().filter(q => q.ref !== item.ref)); sent++; }
      catch(e){
        const msg = (e && e.message) || "";
        if (isNetworkError(e) || /jwt|token|not authenticated|sign in first/i.test(msg)) break;     // try again later
        const all = queue.all(), it = all.find(q => q.ref === item.ref);
        if (it){ it.error = msg || "It couldn't be recorded."; queue.save(all); }
      }
    }
  } finally { flushing = false; }
  if (sent) toast(sent === 1 ? "1 saved sale was sent." : sent + " saved sales were sent.");
  return sent;
}
const pendingQty = id => queue.mine().filter(q => !q.error).reduce((a, q) => a + (q.args.p_items || []).filter(i => i.product_id === id).reduce((b, i) => b + i.qty, 0), 0);
function offlineBanner(){
  const q = queue.mine(), pending = q.filter(x => !x.error), failedQ = q.filter(x => x.error);
  let h = "";
  if (S.offline || !navigator.onLine) h += `<p class="banner" id="offlineNote">📴 You're offline. Sales you record are kept on this phone and sent automatically when you're back online.</p>`;
  if (pending.length) h += `<div class="banner" id="queueNote">🕓 <b>${pending.length} sale${pending.length === 1 ? "" : "s"} saved on this phone</b>, waiting to be sent.
    <div class="sub">${pending.map(x => x.lines.map(l => l.qty + " × " + esc(l.name)).join(", ") + " · " + timeLabel(x.queuedAt)).join("<br>")}</div>
    <button class="linkbtn" type="button" data-syncnow>Send now</button></div>`;
  failedQ.forEach(x => { h += `<div class="banner bad">A saved sale couldn't be recorded (${x.lines.map(l => l.qty + " × " + esc(l.name)).join(", ")}): ${esc(x.error)} <button class="linkbtn" type="button" data-discardq="${esc(x.ref)}">Discard it</button></div>`; });
  return h;
}
const offlineNeeds = () => `<div class="empty"><b>This needs a connection</b>You can still record sales. Everything else comes back when you're online.<br><br><button class="btn" type="button" data-gosell>Go to Sell</button></div>`;
// What this phone needs to open the Sell screen without signal.
function saveSnapshot(){
  if (!S.biz || !canSell()) return;
  try { store.set("busynes.snap." + bid(), JSON.stringify({biz: S.biz, partners: S.partners, shares: S.shares, products: S.products, stock: S.stock, at: Date.now()})); } catch(e){}
}
function startOffline(user){
  const id = store.get("busynes.biz"); let snap = null;
  try { snap = id && JSON.parse(store.get("busynes.snap." + id) || "null"); } catch(e){}
  if (!snap || !snap.biz || !user) return false;
  S.user = user; S.businesses = [snap.biz]; S.biz = snap.biz; S.me = snap.biz.member_id;
  Object.assign(S, {partners: snap.partners || [], shares: snap.shares || [], products: snap.products || [], stock: snap.stock || {},
    orders: [], debts: [], sales: [], notifs: [], messages: [], money: null, profit: null, costs: {}, cart: {}, loaded: true, offline: true});
  S.tab = "sell"; draft = freshDraft(); show("appScreen"); render();
  return true;
}
// Forget what this phone has saved about the business (on sign-out). Sales not sent yet are kept unless everything is wiped.
function wipeLocal(everything){
  try {
    Object.keys(localStorage).filter(k => k.startsWith("busynes.") && (everything || k !== QKEY)).forEach(k => localStorage.removeItem(k));
  } catch(e){}
}

// Things bought in a pack (a case, a box, a bag of 20...). Each product can remember its pack size and what you call a pack.
const PRODUCT_COLS = "id,business_id,name,price,owner,sort,hidden,track_stock,case_size,pack_name";
const PRODUCT_COLS_MID = "id,business_id,name,price,owner,sort,hidden,track_stock,case_size";
const PRODUCT_COLS_OLD = "id,business_id,name,price,owner,sort,hidden,track_stock";
async function loadProducts(b){
  const q = cols => S.sb.from("products").select(cols).eq("business_id", b).order("sort").order("name");
  try { return await must(q(PRODUCT_COLS)); }
  catch(e){
    const m = (e && e.message) || "";
    if (/pack_name/i.test(m)) { try { return await must(q(PRODUCT_COLS_MID)); } catch(e2){ if (/case_size/i.test((e2 && e2.message) || "")) return await must(q(PRODUCT_COLS_OLD)); throw e2; } }
    if (/case_size/i.test(m)) return await must(q(PRODUCT_COLS_OLD));
    throw e;
  }
}
const packWord = p => ((p && p.pack_name) || "pack").toLowerCase();
const plural = (w, n) => n === 1 ? w : (/(s|x|ch|sh)$/.test(w) ? w + "es" : w + "s");
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const PACK_LIST = `<datalist id="packNames">${["pack", "case", "box", "bag", "tray", "crate", "carton", "bundle", "dozen"].map(x => `<option value="${x}">`).join("")}</datalist>`;
async function loadAll(){
  const sb = S.sb, b = bid(), full = canSell();
  const [partners, shares, orders, notifs, messages, fees, unread] = await Promise.all([
    must(sb.from("partners").select("id,name,phone,role,status").eq("business_id", b).neq("status","removed")),
    must(sb.rpc("my_groups", {p_biz: b})),
    must(sb.from("orders").select("*").eq("business_id", b).order("at",{ascending:false}).limit(60)),
    must(sb.from("notifications").select("*").eq("business_id", b).order("id",{ascending:false}).limit(50)),
    must(sb.from("messages").select("id,at,from_partner,body").eq("business_id", b).order("id",{ascending:false}).limit(60)),
    soft(sb.from("order_fees").select("order_id,fee"), []),
    soft(sb.from("notifications").select("business_id").is("read_at", null).limit(300), []),
  ]);
  let products = [], stock = [], moves = [], sales = [], settlements = [], debts = [];
  if (full){
    [products, stock, moves, sales, settlements, debts] = await Promise.all([
      loadProducts(b),
      must(sb.rpc("stock_levels", {p_biz: b})),
      must(sb.from("stock_moves").select("*").eq("business_id", b).order("at",{ascending:false}).limit(8)),
      must(sb.rpc("sales_timeline", {p_biz: b, p_limit: 300})),
      must(sb.from("settlements").select("*").eq("business_id", b).order("at",{ascending:false}).limit(20)),
      must(sb.rpc("my_debts", {p_biz: b})),
    ]);
  }
  Object.assign(S, {partners, shares, products, moves, sales, settlements, orders, debts, notifs, messages});
  S.orderFees = {}; for (const f of fees) S.orderFees[f.order_id] = num(f.fee);
  S.stock = {}; for (const r of stock) S.stock[r.product_id] = r.qty;
  S.unreadBy = {}; for (const u of unread) S.unreadBy[u.business_id] = (S.unreadBy[u.business_id] || 0) + 1;
  S.money = isDelivery() ? null : await must(sb.rpc("my_money", {p_biz: b, p_from: periodStart()}));
  S.costs = {}; S.profit = null;
  if (canManage()){
    const [costs, profit] = await Promise.all([soft(sb.rpc("product_costs", {p_biz: b}), []), soft(sb.rpc("my_profit", {p_biz: b, p_from: periodStart()}), null)]);
    for (const c of costs) S.costs[c.product_id] = num(c.cost);
    S.profit = profit;
  }
  S.loaded = true;
  saveSnapshot();
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
  if (!S.biz) return;
  if (S.offline){
    try {
      await loadBusinesses();
      const cur2 = S.businesses.find(x => x.id === S.biz.id);
      if (!cur2){ S.offline = false; await reloadBusinesses(); return; }
      S.biz = cur2; S.me = cur2.member_id; S.offline = false;
    } catch(e){ return; }
  }
  if (navigator.onLine && queue.all().some(q => !q.error)) await flushQueue();
  const mine = bid();
  try { await loadAll(); if (S.biz && bid() === mine) render(); }
  catch(e){
    // Lost access (removed from the business, or it was deleted)? Find out and move on instead of showing errors.
    if (/not part of this business|permission denied|can't|cannot/i.test((e && e.message) || "")){
      if (await reloadBusinesses()) return;
    }
    if (!quiet) failed(e);
  }
}

// ---------- businesses ----------
async function loadBusinesses(){
  await S.sb.rpc("claim_memberships");                    // accept any invitation waiting for this email
  S.businesses = await must(S.sb.rpc("my_businesses"));
}
// Re-read the list. Returns true if it moved the person somewhere else (a different business or onboarding).
async function reloadBusinesses(){
  try { await loadBusinesses(); } catch(e){ return false; }
  const cur = S.biz && S.businesses.find(x => x.id === S.biz.id);
  if (cur){ S.biz = cur; S.me = cur.member_id; return false; }
  if (S.businesses.length){ toast("You no longer have access to that business."); await openBusiness(S.businesses[0].id); return true; }
  S.biz = null; showOnboarding(); return true;
}
async function openBusiness(id, keepTab){
  const b = S.businesses.find(x => x.id === id); if (!b) return;
  S.biz = b; S.me = b.member_id; store.set("busynes.biz", id);
  Object.assign(S, {partners:[], shares:[], products:[], stock:{}, moves:[], sales:[], settlements:[], money:null, orders:[], debts:[], notifs:[],
    messages:[], seenNotif:null, fromOrder:null, orderFees:{}, costs:{}, profit:null, cart:{}, loaded:false, editing:null, confirmDel:null, members:null, salesFilter:"all", sq:"", speriod:"all", smethod:"all", sstatus:"all", period:"settle"});
  draft = freshDraft();
  // Switching business lands on a normal start screen; opening the app again keeps where you were.
  if (!NAV().includes(S.tab) && !(keepTab && (S.tab === "team" || S.tab === "settings"))) S.tab = NAV()[0];
  closeSheet(); show("appScreen"); render();
  await refresh();
  if (S.tab === "settings" && !S.members) { try { await loadMembers(); render(); } catch(e){} }
}
function showOnboarding(){
  $("#obEmail").textContent = (S.user && S.user.email) || "";
  const nm = $("#obName"); if (!nm.value) nm.value = ((S.user && S.user.email) || "").split("@")[0].replace(/[._-]+/g," ").replace(/\b\w/g, c => c.toUpperCase()).slice(0, 40);
  show("onboardScreen");
}
async function createBusiness(name, kind, myName, currency){
  const args = {p_name: name, p_kind: kind, p_my_name: myName};
  if (currency && currency !== "R") args.p_currency = currency;
  const id = await must(S.sb.rpc("create_business", args));
  await loadBusinesses();
  await openBusiness(id);
  toast("Your business is ready. Add what you sell on the Stock tab.");
}
async function loadMembers(){ S.members = await must(S.sb.rpc("list_members", {p_biz: bid()})); }

// ---------- render ----------
function render(){
  if (!S.biz) return;
  $("#meName").textContent = ((S.partners.find(p => p.id === S.me) || {}).name || "").split(" ")[0];
  $("#bizName").textContent = S.biz.name;
  const others = Object.entries(S.unreadBy).some(([k, n]) => k !== bid() && n > 0);
  $("#bizBtn").classList.toggle("dot", others);
  const nav = NAV();
  document.querySelectorAll("[data-tab]").forEach(b => { b.hidden = !nav.includes(b.dataset.tab); b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)); });
  $(".tabs .inner").style.gridTemplateColumns = `repeat(${nav.length}, 1fr)`;
  let html;
  if (!S.loaded) html = `<div class="empty"><b>Loading…</b>Fetching your business.</div>`;
  else if (S.offline && S.tab !== "sell") html = offlineNeeds();
  else if (S.tab === "sell") html = viewSell();
  else if (S.tab === "orders") html = viewOrders();
  else if (S.tab === "owed") html = viewOwed();
  else if (S.tab === "stock") html = viewStock();
  else if (S.tab === "sales") html = viewSales();
  else if (S.tab === "team") html = viewTeam();
  else if (S.tab === "settings") html = viewSettings();
  else html = viewReport();
  // Don't wipe a half-typed chat message when the screen refreshes.
  const chat = $("#chatInput"), keep = chat && {v: chat.value, focus: document.activeElement === chat};
  const focusId = document.activeElement && ["sellSearch", "salesSearch"].includes(document.activeElement.id) ? document.activeElement.id : null;
  $("#view").innerHTML = html;
  const chat2 = $("#chatInput");
  if (keep && chat2){ chat2.value = keep.v; if (keep.focus) chat2.focus(); }
  const box = $("#chatBox"); if (box && !keep) box.scrollTop = box.scrollHeight;
  bindView();
  if (focusId && $("#" + focusId)){ const el = $("#" + focusId); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  renderCart();
  renderBadges();
}

function viewSell(){
  if (!S.products.length) return `<div class="empty"><b>No products yet</b>${canManage() ? "Add what you sell and its price on the Stock tab, then come back here to sell." : "The owner hasn't added any products yet."}</div>`;
  const os = owners(), single = Object.keys(os).length === 1;
  let h = offlineBanner();
  if (S.products.filter(p => !p.hidden).length > 8) h += `<input id="sellSearch" class="text" type="search" placeholder="Find a product" aria-label="Find a product" autocomplete="off">`;
  for (const o of Object.values(os)){
    const ps = S.products.filter(p => p.owner === o.id && !p.hidden);
    if (!ps.length) continue;
    h += `<section>${single ? "" : `<div class="owner-head"><span class="owner-tag"><i style="background:${o.color}"></i>${esc(o.name)}'s</span><span class="eyebrow">Tap to add</span></div>`}<div class="grid">`;
    for (const p of ps){
      const q = S.cart[p.id] || 0, tracked = p.track_stock !== false;
      const st = tracked ? (S.stock[p.id] || 0) - q - pendingQty(p.id) : null;
      const cls = !tracked ? "" : st <= 0 ? "out" : st <= LOW ? "low" : "";
      h += `<div style="position:relative;min-width:0" data-pname="${esc(p.name.toLowerCase())}">
        <button class="tile ${q ? "in" : ""}" type="button" data-add="${esc(p.id)}" aria-label="Add one ${esc(p.name)}">
          <span class="stripe" style="background:${o.color}"></span>
          <span class="name">${esc(p.name)}</span>
          <span class="meta num"><span class="price">${money(p.price)}</span>${tracked ? `<span class="left ${cls}">${st <= 0 ? "None left" : st + " left"}</span>` : ""}</span>
        </button>
        ${q ? `<span class="badge num" aria-hidden="true">${q}</span><button class="minus" type="button" data-sub="${esc(p.id)}" aria-label="Remove one ${esc(p.name)}">−</button>` : ""}
      </div>`;
    }
    h += `</div></section>`;
  }
  return h || `<div class="empty"><b>Everything is hidden</b>Show a product again on the Stock tab.</div>`;
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

const freshDraft = () => ({paidTo:null, method:null, note:"", mode:"full", paid:"", due:"", fee:"", feeTo:null});
let draft = freshDraft();
function checkout(){
  const lines = cartLines(); if (!lines.length) return;
  if (!draft.paidTo) draft.paidTo = S.me;
  if (!draft.method) draft.method = store.get("busynes.method." + bid()) || "transfer";
  if (!draft.feeTo) draft.feeTo = S.me;
  const total = lines.reduce((a,l) => a + l.qty*l.price, 0);
  // fee only applies to a loan; "paid now" is everything for full, a typed amount for part, nothing for credit/loan
  const calc = () => {
    const fee = draft.mode === "loan" ? Math.max(0, parseFloat(draft.fee) || 0) : 0, grand = total + fee;
    const paid = draft.mode === "full" ? grand : draft.mode === "part" ? Math.min(grand, Math.max(0, parseFloat(draft.paid) || 0)) : 0;
    return {fee, grand, paid, owed: grand - paid};
  };
  openSheet(`<div class="grab"></div>
    <h2>Record this sale</h2>
    <div class="lines num">${lines.map(l => `<div class="line"><span>${l.qty} × ${esc(l.name)}</span><span>${money(l.qty*l.price)}</span></div>`).join("")}
      <div class="line total"><span>Total</span><span>${money(total)}</span></div></div>
    <div class="field"><span class="lab">How is it being paid?</span>
      <div class="chips" role="group"><button type="button" class="chip" data-mode="full">Paid in full</button><button type="button" class="chip" data-mode="part">Paid part</button><button type="button" class="chip" data-mode="credit">On credit</button><button type="button" class="chip" data-mode="loan">Loan with a fee</button></div></div>
    <div class="field" id="partBox" hidden><label for="paidNow">Paid now (${cur()})</label><input id="paidNow" class="text num" type="number" inputmode="decimal" min="0" max="${total}" step="1" value="${esc(draft.paid)}"></div>
    <div class="field" id="feeBox" hidden><label for="feeAmt">Loan fee (${cur()})</label><input id="feeAmt" class="text num" type="number" inputmode="decimal" min="0" step="1" placeholder="e.g. 50" value="${esc(draft.fee)}">
      <span class="muted" style="font-size:13px">What you charge for lending. It's added to what they owe and it's yours, not the owners' of the items. Other people can't see it.</span></div>
    <div class="field" id="feeToBox" hidden><span class="lab">Who keeps the fee?</span>
      <div class="chips" role="group">${S.partners.map(p => `<button type="button" class="chip" data-feeto="${esc(p.id)}" aria-pressed="${draft.feeTo===p.id}">${esc(p.id === S.me ? "Me" : p.name)}</button>`).join("")}</div></div>
    <div class="field" id="dueBox" hidden><label for="dueOn" id="dueLab">Promised to pay the rest on</label><input id="dueOn" class="text" type="date" value="${esc(draft.due)}">
      <div class="chips"><button type="button" class="chip" data-dueadd="3">In 3 days</button><button type="button" class="chip" data-dueadd="7">In a week</button><button type="button" class="chip" data-dueadd="14">In 2 weeks</button></div></div>
    <p class="banner" id="owedNote" hidden></p>
    <div class="field"><span class="lab" id="whoLab">Who got the money?</span>
      <div class="chips" role="group">${S.partners.map(p => `<button type="button" class="chip" data-paid="${esc(p.id)}" aria-pressed="${draft.paidTo===p.id}">${esc(p.id === S.me ? "Me" : p.name)}</button>`).join("")}</div></div>
    <div class="field" id="methodBox"><span class="lab">How was it paid?</span>
      <div class="chips" role="group"><button type="button" class="chip" data-method="transfer" aria-pressed="${draft.method==="transfer"}">Into their account</button><button type="button" class="chip" data-method="cash" aria-pressed="${draft.method==="cash"}">Cash</button></div></div>
    <div class="field"><label for="saleNote" id="noteLab">Customer or note (optional)</label><input id="saleNote" class="text" maxlength="80" placeholder="e.g. Thando, block C" value="${esc(draft.note)}"></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Back</button><span class="spacer"></span><button class="btn" type="button" id="saveSale"></button></div>`);
  const sync = () => {
    const {fee, grand, paid, owed} = calc(), loan = draft.mode === "loan";
    document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === draft.mode)));
    $("#partBox").hidden = draft.mode !== "part";
    $("#feeBox").hidden = !loan;
    $("#feeToBox").hidden = !(loan && fee > 0);
    $("#dueBox").hidden = owed <= 0.005;
    $("#dueLab").textContent = loan ? "Promised to pay it back on" : "Promised to pay the rest on";
    $("#methodBox").hidden = paid <= 0;
    $("#whoLab").textContent = paid <= 0 ? "Who is collecting the money?" : "Who got the money?";
    $("#noteLab").textContent = owed > 0.005 ? "Customer's name (needed so you know who owes)" : "Customer or note (optional)";
    const n = $("#owedNote"); n.hidden = owed <= 0.005;
    n.textContent = owed > 0.005 ? `${draft.note.trim() || "The customer"} will owe ${money2(owed)}${fee > 0 ? ` (${money(total)} + ${money2(fee)} fee)` : ""}.` : "";
    $("#saveSale").textContent = loan ? `Save loan · owes ${money2(owed)}` : owed > 0.005 ? `Save · ${money2(paid)} now, ${money2(owed)} owed` : `Save sale · ${money(total)}`;
  };
  document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { draft.mode = b.dataset.mode; sync(); if (draft.mode === "part" && !draft.paid) $("#paidNow").focus(); if (draft.mode === "loan" && !draft.fee) $("#feeAmt").focus(); });
  $("#paidNow").oninput = e => { draft.paid = e.target.value; sync(); };
  $("#feeAmt").oninput = e => { draft.fee = e.target.value; sync(); };
  document.querySelectorAll("[data-feeto]").forEach(b => b.onclick = () => { draft.feeTo = b.dataset.feeto; document.querySelectorAll("[data-feeto]").forEach(x => x.setAttribute("aria-pressed", String(x===b))); });
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
    const {fee, grand, paid, owed} = calc();
    if (owed > 0.005 && !draft.note.trim()) return toast("Type the customer's name so you know who owes.");
    e.target.disabled = true;
    const sale = {at:new Date().toISOString(), items:lines, total, paidTo:draft.paidTo, method:draft.method, note:draft.note.trim(), due: owed > 0.005 && draft.due ? draft.due : null};
    const args = {
      p_biz: bid(),
      p_items: lines.map(l => ({product_id:l.product_id, qty:l.qty})),
      p_paid_to: sale.paidTo, p_method: sale.method, p_note: sale.note,
      p_paid: paid, p_due: sale.due, p_order: S.fromOrder || null,
      p_fee: fee, p_fee_to: fee > 0 ? (draft.feeTo || S.me) : null,
      p_client_ref: newRef(), p_at: sale.at,          // so a retry can't double-record it, and it keeps the time it happened
    };
    const finish = () => { store.set("busynes.method." + bid(), sale.method); S.cart = {}; S.fromOrder = null; draft = freshDraft(); closeSheet(); };
    const keepOnPhone = () => { queueSale(args, lines, total, sale.paidTo); finish(); toast("Saved on this phone. It will be sent when you're back online."); render(); };
    if (!navigator.onLine){ keepOnPhone(); return; }
    try {
      await callRecordSale(args);
      finish();
      toast(fee > 0 ? `Loan saved. ${sale.note} owes ${money2(owed)}.` : owed > 0.005 ? `Saved. ${sale.note} owes ${money2(owed)}.` : "Saved " + money(total) + " paid to " + pname(sale.paidTo) + ".",
            {label:"Copy for group", run:() => copyText(saleText(sale), "Copied. Paste it in your group.")});
      await refresh();
    } catch(err){
      if (isNetworkError(err)){ keepOnPhone(); return; }
      e.target.disabled = false; failed(err);
    }
  };
}
// The text you paste in a WhatsApp group: what was sold and where the money went. No amounts owed, no fees.
function saleText(s){
  const who = (S.partners.find(p => p.id === s.paidTo) || {name:"someone"}).name;
  return `✅ Sale ${dayLabel(s.at)} ${timeLabel(s.at)}\n` + s.items.map(i => `${i.qty} × ${i.name}`).join("\n") +
    `\nMoney with ${who}` + (s.note ? `\nNote: ${s.note}` : "");
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

function viewOwed(){
  const list = S.debts, m = S.money || {};
  const sum = list.reduce((a,d) => a + num(d.outstanding), 0);
  let h = `<h2>Who owes</h2>`;
  if (!list.length){
    h += `<div class="empty"><b>Nobody owes you anything</b>When a customer pays part, or takes something on credit, it shows here with the date they promised.</div>`;
  } else {
    h += `<section class="kpis"><div class="kpi"><span class="eyebrow">Owed to you</span><b class="num">${money2(sum)}</b><span class="muted">${list.length} customer${list.length === 1 ? "" : "s"}</span></div>
      <div class="kpi"><span class="eyebrow">Overdue</span><b class="num">${list.filter(d => dueInfo(d.due_on).rank === 0).length}</b><span class="muted">${list.filter(d => dueInfo(d.due_on).rank <= 1).length} due now</span></div></section>`;
    h += `<section class="card"><div class="list">` + list.slice().sort((a,b) => dueInfo(a.due_on).rank - dueInfo(b.due_on).rank || String(a.due_on || "9").localeCompare(String(b.due_on || "9"))).map(d => {
      const di = dueInfo(d.due_on);
      return `<div class="debt"><div class="row"><span class="title">${esc(d.customer || "No name")}</span><span class="spacer"></span><b class="num">${money2(d.outstanding)}</b></div>
        <div class="sub">${esc(d.items)} · ${money2(d.paid)} of ${money2(d.total)} paid · ${dayLabel(d.at)}${d.paid_to !== S.me ? " · " + esc(Pname(d.paid_to)) + " collects" : ""}</div>
        <div class="row" style="margin-top:6px">${num(d.loan_fee) > 0 ? `<span class="pill warn">Loan · ${money2(d.loan_fee)} fee</span>` : ""}<span class="pill ${di.cls}">${esc(di.label)}</span><span class="spacer"></span>
          <button class="linkbtn" type="button" data-due="${d.sale_id}">Change date</button>
          <a class="linkbtn" href="https://wa.me/?text=${encodeURIComponent(reminderText(d))}" target="_blank" rel="noopener">WhatsApp reminder</a>
          <button class="linkbtn" type="button" data-remind="${d.sale_id}">Copy</button>
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
    <div class="field"><label for="payAmt">Amount received now (${cur()})</label><div class="stepper"><input id="payAmt" class="text num" type="number" inputmode="decimal" min="0" max="${num(d.outstanding)}" step="1" value="${num(d.outstanding)}" style="width:100%"></div></div>
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
  let h = `<div class="row"><h2>Orders</h2><span class="spacer"></span>${canSell() ? `<button class="btn small" type="button" data-neworder>Add order</button>` : ""}</div>
    <p class="muted" style="margin:-12px 0 0">${canSell() ? "Write down what people ask for. Everyone is told, and when you sell it the order is ticked off." : "Orders waiting to be delivered. Tap \"I'll take it\" so nobody else chases the same one."}</p>`;
  if (!open.length) h += `<div class="empty"><b>No open orders</b>${canSell() ? "When someone asks for something, add it here so nobody forgets." : "New orders will show up here."}</div>`;
  else h += open.map(o => `<section class="card"><div class="row"><span class="title">${esc(o.customer || "No name")}</span><span class="spacer"></span><span class="muted">${dayLabel(o.at)} ${timeLabel(o.at)}</span></div>
      <div style="margin-top:6px">${line(o)}</div>
      ${o.loan ? `<div style="margin-top:6px"><span class="pill warn">Loan</span>${S.orderFees[o.id] ? ` <span class="muted">your fee ${money2(S.orderFees[o.id])}</span>` : ""}</div>` : ""}
      ${o.note ? `<div class="sub">${esc(o.note)}</div>` : ""}
      <div class="sub">Added by ${esc(Pname(o.created_by))}</div>
      ${o.claimed_by ? `<div style="margin-top:8px"><span class="pill ${o.claimed_by === S.me ? "" : "warn"}">${o.claimed_by === S.me ? "You're on it" : esc(Pname(o.claimed_by)) + " is on it"}</span></div>` : ""}
      <div class="row" style="margin-top:10px">${canSell() ? `<button class="linkbtn bad" type="button" data-cancelorder="${o.id}">Cancel</button>` : ""}
        ${o.claimed_by === S.me ? `<button class="linkbtn" type="button" data-release="${o.id}">Let go</button>` : ""}<span class="spacer"></span>
        ${o.claimed_by ? "" : `<button class="btn small ${canSell() ? "ghost" : ""}" type="button" data-claim="${o.id}">I'll take it</button>`}
        ${canSell() ? `<button class="btn small" type="button" data-fillorder="${o.id}">Sell this</button>` : ""}</div></section>`).join("");
  if (past.length) h += `<section><div class="eyebrow" style="margin-bottom:6px">Recent</div><div class="card list">` + past.map(o =>
    `<div class="item"><div class="main"><div class="title">${esc(o.customer || "No name")} <span class="pill">${o.status === "done" ? "sold" : "cancelled"}</span></div><div class="sub">${line(o)}</div></div></div>`).join("") + `</div></section>`;
  return h;
}
// Value for <input type="datetime-local">: local time, to the minute.
const localInput = d => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };
function newOrderSheet(){
  const qty = {}, os = Object.values(owners());
  const prods = S.products.filter(p => !p.hidden);
  openSheet(`<div class="grab"></div><h2>Add an order</h2>
    <div class="field"><label for="ordCust">Customer</label><input id="ordCust" class="text" maxlength="60" placeholder="e.g. Lindiwe"></div>
    <div class="field"><span class="lab">What kind of order?</span><div class="chips" role="group"><button type="button" class="chip" data-otype="normal" aria-pressed="true">Normal order</button><button type="button" class="chip" data-otype="loan" aria-pressed="false">Loan</button></div></div>
    <div class="field" id="ordFeeBox" hidden><label for="ordFee">Loan fee (${cur()})</label><input id="ordFee" class="text num" type="number" inputmode="decimal" min="0" step="1" placeholder="e.g. 50">
      <span class="muted" style="font-size:13px">Whatever you plan to charge for lending. Only you can see this amount.</span></div>
    <div class="field"><span class="lab">What do they want?</span><div class="list card" style="padding-block:0">${os.map(o => prods.filter(p => p.owner === o.id).map(p =>
      `<div class="item" style="padding:8px 0"><div class="main"><div class="title">${esc(p.name)}</div><div class="sub num">${money(p.price)}</div></div>
        <div class="stepper"><button type="button" class="btn small ghost" data-oq="${esc(p.id)}" data-d="-1" aria-label="One less ${esc(p.name)}">−</button><b class="num" id="oq-${esc(p.id)}" style="min-width:22px;text-align:center">0</b><button type="button" class="btn small" data-oq="${esc(p.id)}" data-d="1" aria-label="One more ${esc(p.name)}">+</button></div></div>`).join("")).join("")}</div></div>
    <div class="field"><label for="ordAt">When did they ask?</label><input id="ordAt" class="text" type="datetime-local" value="${localInput(new Date())}" max="${localInput(new Date())}">
      <span class="muted" style="font-size:13px">Leave it as it is for right now, or pick an earlier time if you forgot to write it down.</span></div>
    <div class="field"><label for="ordNote">Note (optional)</label><input id="ordNote" class="text" maxlength="120" placeholder="e.g. collect at 5pm, will pay Friday"></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn" type="button" id="saveOrder">Save order</button></div>`);
  document.querySelectorAll("[data-oq]").forEach(b => b.onclick = () => {
    const id = b.dataset.oq; qty[id] = Math.max(0, (qty[id] || 0) + Number(b.dataset.d));
    $("#oq-" + CSS.escape(id)).textContent = qty[id];
  });
  $("#sheetCancel").onclick = closeSheet;
  let touched = false, loan = false;
  $("#ordAt").oninput = () => { touched = true; };
  document.querySelectorAll("[data-otype]").forEach(b => b.onclick = () => {
    loan = b.dataset.otype === "loan"; $("#ordFeeBox").hidden = !loan;
    document.querySelectorAll("[data-otype]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    if (loan) $("#ordFee").focus();
  });
  $("#saveOrder").onclick = e => once(e.target, async () => {
    const items = Object.entries(qty).filter(([,q]) => q > 0).map(([product_id, q]) => ({product_id, qty:q}));
    if (!items.length) return toast("Pick at least one item.");
    const when = $("#ordAt").value, at = touched && when ? new Date(when) : null;
    if (at && (isNaN(at) || at.getTime() > Date.now() + 5 * 60000)) return toast("The date can't be in the future.");
    try {
      await must(S.sb.rpc("create_order", {p_biz: bid(), p_customer: $("#ordCust").value.trim(), p_items: items, p_note: $("#ordNote").value.trim(), p_at: at ? at.toISOString() : null, p_loan: loan, p_fee: loan ? Math.max(0, parseFloat($("#ordFee").value) || 0) : 0}));
      closeSheet(); toast(at ? "Order saved with its date." : "Order saved. The others have been told."); await refresh();
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
  if (o.loan){ draft.mode = "loan"; if (S.orderFees[o.id]){ draft.fee = String(S.orderFees[o.id]); draft.feeTo = S.me; } }
  S.tab = "sell"; store.set("busynes.tab", "sell"); render(); window.scrollTo(0,0);
  toast(skipped ? "Order loaded, but " + skipped + " item(s) no longer exist." : "Order loaded. Check it and tap Record sale.");
}

// ---------- team: call, WhatsApp, chat ----------
const waNumber = p => { let d = String(p || "").replace(/[^0-9]/g, ""); if (d.startsWith("0")) d = "27" + d.slice(1); return d; };
function viewTeam(){
  const others = S.partners.filter(p => p.id !== S.me), me = S.partners.find(p => p.id === S.me) || {};
  let h = `<h2>Team</h2>`;
  h += others.map(p => `<section class="card"><div class="row"><div class="main"><div class="title">${esc(p.name)} <span class="pill">${esc(ROLE_NAME[p.role] || "")}</span></div><div class="sub num">${p.status === "invited" ? "Hasn't joined yet" : p.phone ? esc(p.phone) : "No number saved yet"}</div></div></div>
    <div class="row" style="margin-top:10px">${p.phone ? `<a class="btn small" href="tel:${esc(p.phone)}">Call</a><a class="btn small ghost" href="https://wa.me/${waNumber(p.phone)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
      ${p.status === "active" ? `<button class="btn small ghost" type="button" data-ping="${esc(p.id)}">Ask ${esc(p.name)} to call me</button>` : ""}</div></section>`).join("");
  if (!others.length) h += `<div class="empty"><b>It's just you for now</b>${isOwner() ? "Invite your partners and staff from Business settings." : ""}</div>`;
  h += `<section class="card"><div class="field"><label for="myPhone">Your number, so the others can call you</label>
    <div class="stepper"><input id="myPhone" class="text num" type="tel" inputmode="tel" autocomplete="tel" value="${esc(me.phone || "")}" placeholder="082 123 4567" style="width:100%"><button class="btn small" type="button" data-savephone>Save</button></div></div></section>`;
  const msgs = S.messages.slice().reverse();
  h += `<section><div class="eyebrow" style="margin-bottom:6px">Chat</div><div class="card chat" id="chatBox">` +
    (msgs.length ? msgs.map(m => `<div class="msg ${m.from_partner === S.me ? "mine" : ""}"><div class="who"><b>${esc(Pname(m.from_partner))}</b> <span class="muted">${dayLabel(m.at)} ${timeLabel(m.at)}</span></div><div>${esc(m.body)}</div></div>`).join("")
                : `<p class="muted" style="margin:0">No messages yet. This is for quick notes between the people in this business.</p>`) +
    `</div><form class="row" id="chatForm" style="margin-top:10px;flex-wrap:nowrap"><input id="chatInput" class="text" maxlength="500" placeholder="Message the team" autocomplete="off" aria-label="Message"><button class="btn" type="submit">Send</button></form></section>`;
  return h;
}

// ---------- alerts (bell) and phone notifications ----------
const ICON = {sale:"🧾", credit:"📝", payment:"💵", order:"🛒", reminder:"⏰", chat:"💬", stock:"📦", call:"📞", member:"👋", settle:"🤝"};
const KIND_TAB = {sale:"sales", credit:"owed", payment:"owed", reminder:"owed", order:"orders", chat:"team", call:"team", stock:"stock", member:"settings", settle:"report"};
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
    S.unreadBy[bid()] = 0;
    renderBadges();
    S.sb.rpc("mark_notifications_read", {p_biz: bid(), p_up_to: top}).then(() => {}, () => {});
  }
}
function goTab(t){
  if (!TABS.includes(t)) t = "sell";
  if (!NAV().includes(t) && t !== "team" && t !== "settings") t = NAV()[0];
  S.tab = t; store.set("busynes.tab", t); S.confirmDel = null; S.editing = null; render(); window.scrollTo(0,0);
  if (t === "settings") loadMembers().then(render, failed);
}

// ---------- stock ----------
function viewStock(){
  const os = owners(), single = Object.keys(os).length === 1;
  let h = `<div class="row"><h2>Stock on hand</h2><span class="spacer"></span>${canManage() ? `<button class="btn small" type="button" data-newprod>Add product</button>` : ""}</div>
    <p class="muted" style="margin:-12px 0 0">Stock drops by itself with every sale. Add stock when you buy more, or do a stock count to correct it.</p>`;
  if (!S.products.length) return h + `<div class="empty"><b>No products yet</b>${canManage() ? "Tap Add product to set up the first thing you sell." : "The owner hasn't added any products yet."}</div>`;
  for (const o of Object.values(os)){
    const list = S.products.filter(p => p.owner === o.id); if (!list.length) continue;
    h += `<section class="card">${single ? "" : `<div class="owner-head"><span class="owner-tag"><i style="background:${o.color}"></i>${esc(o.name)}'s</span></div>`}<div class="list">`;
    for (const p of list){
      const tracked = p.track_stock !== false, n = S.stock[p.id] || 0, cls = !tracked ? "" : n <= 0 ? "out" : n <= LOW ? "low" : "";
      h += `<div class="item"><div class="main"><div class="title">${esc(p.name)}${p.hidden ? ` <span class="pill">hidden</span>` : ""}</div><div class="sub num">${money(p.price)} each${p.case_size ? ` · ${p.case_size} per ${packWord(p)}` : ""}${canManage() ? (S.costs[p.id] != null ? ` · costs ${money2(S.costs[p.id])} · ${money2(num(p.price) - S.costs[p.id])} profit each` : " · cost not set") : ""}${!tracked ? " · stock not tracked" : n <= 0 ? " · restock needed" : n <= LOW ? " · running low" : ""}</div></div>
          ${tracked ? `<div class="stockn num ${cls}">${n}</div>` : ""}<button class="btn small ghost" type="button" data-edit="${esc(p.id)}" aria-label="Update ${esc(p.name)}">Update</button></div>`;
    }
    h += `</div></section>`;
  }
  if (S.moves.length){
    h += `<section><div class="eyebrow" style="margin-bottom:6px">Recent stock changes</div><div class="card list">` + S.moves.map(m => {
      const p = productById(m.product_id);
      return `<div class="item"><div class="main"><div class="title">${m.kind === "add" ? "+" + m.qty : "Counted " + m.qty} ${esc(p ? p.name : "an item")}</div><div class="sub">${dayLabel(m.at)} ${timeLabel(m.at)} · ${esc(Pname(m.by))}</div></div></div>`;
    }).join("") + `</div></section>`;
  }
  return h;
}

// Update one product: add new stock, correct the count, or (owners and partners) change its details.
// Each part has its own Save button, so it's always clear what gets saved.
function productSheet(id){
  const p = productById(id); if (!p) return;
  const tracked = p.track_stock !== false, n = S.stock[p.id] || 0, mgr = canManage(), cost = S.costs[p.id];
  let hidden = !!p.hidden, track = tracked;
  let byCase = !!p.case_size && store.get("busynes.bycase." + p.id) !== "0";
  let W = packWord(p);
  openSheet(`<div class="grab"></div><h2>${esc(p.name)}</h2>
    <p class="muted" style="margin:-10px 0 0">${tracked ? `<b class="num">${n}</b> in stock` : "Stock isn't counted for this item"} · ${money(p.price)} each${mgr && cost != null ? ` · costs you ${money2(cost)}` : ""}</p>
    ${tracked ? `<section class="card"><div class="eyebrow">Add new stock</div>
      <div class="field" style="margin-top:8px"><span class="lab">Bought as</span><div class="chips"><button type="button" class="chip" data-addby="item" aria-pressed="${!byCase}">Single items</button><button type="button" class="chip" data-addby="case" aria-pressed="${byCase}">${cap(plural(W, 2))}</button></div></div>
      <div class="field" id="caseBox" style="margin-top:10px"${byCase ? "" : " hidden"}><label for="addSize" id="addSizeLab">How many items in one ${W}?</label><input id="addSize" class="text num" type="number" inputmode="numeric" min="2" max="1000" step="1" placeholder="e.g. 12" value="${p.case_size || ""}">
        ${mgr ? `<label for="addPack" style="margin-top:10px">What do you call it? (case, box, bag, pack...)</label><input id="addPack" class="text" maxlength="20" list="packNames" placeholder="pack" value="${esc(p.pack_name || "")}">${PACK_LIST}` : ""}</div>
      <div class="field" style="margin-top:10px"><label for="addQty" id="addQtyLab"></label><input id="addQty" class="text num" type="number" inputmode="numeric" min="1" step="1" placeholder="e.g. 2"></div>
      ${mgr ? `<div class="field" style="margin-top:10px"><label for="addCost" id="addCostLab"></label><input id="addCost" class="text num" type="number" inputmode="decimal" min="0" step="0.01" placeholder="${cost != null ? cost : "e.g. 25"}"></div>` : ""}
      <p class="banner" id="addSum" style="margin:10px 0 0" hidden></p>
      <button class="btn" type="button" id="saveAdd" style="margin-top:12px;width:100%">Save new stock</button></section>
    <section class="card"><div class="eyebrow">Count what's left</div>
      <p class="muted" style="margin:6px 0 0;font-size:13px">If ${n} is wrong, count what you really have and enter it here.</p>
      <div class="field" style="margin-top:8px"><label for="countQty">How many are there now?</label><input id="countQty" class="text num" type="number" inputmode="numeric" min="0" step="1" placeholder="${Math.max(n, 0)}"></div>
      <button class="btn ghost" type="button" id="saveCount" style="margin-top:12px;width:100%">Save count</button></section>` : ""}
    ${mgr ? `<section class="card"><div class="eyebrow">Product details</div>
      <div class="field" style="margin-top:8px"><label for="nameIn">Name</label><input id="nameIn" class="text" maxlength="40" value="${esc(p.name)}"></div>
      <div class="row" style="margin-top:10px;align-items:flex-start">
        <div class="field" style="flex:1;min-width:120px"><label for="priceIn">Selling price (${cur()})</label><input id="priceIn" class="text num" type="number" inputmode="decimal" min="0" step="1" value="${num(p.price)}"></div>
        <div class="field" style="flex:1;min-width:120px"><label for="costIn">One item costs you (${cur()})</label><input id="costIn" class="text num" type="number" inputmode="decimal" min="0" step="0.01" placeholder="not set" value="${cost != null ? cost : ""}"></div></div>
      <p class="banner bad" id="costWarn" style="margin:10px 0 0" hidden>The cost is more than the selling price. If you bought a whole pack, this box needs the cost of <b>one item</b>: add the stock as a pack above and it's worked out for you.</p>
      <div class="field" style="margin-top:10px"><label for="caseIn">Items in a pack (optional)</label><input id="caseIn" class="text num" type="number" inputmode="numeric" min="2" max="1000" step="1" placeholder="e.g. 12 or 20" value="${p.case_size || ""}">
        <span class="muted" style="font-size:13px">Only if you buy it in packs, like a case of cider or a pack of 20 Russians.</span></div>
      <div class="field" style="margin-top:10px"><label for="packIn">What do you call a pack? (optional)</label><input id="packIn" class="text" maxlength="20" list="packNames" placeholder="pack" value="${esc(p.pack_name || "")}"></div>
      <div class="field" style="margin-top:10px"><span class="lab">Show it on the Sell screen?</span><div class="chips"><button type="button" class="chip" data-pdhidden="no" aria-pressed="${!hidden}">Yes</button><button type="button" class="chip" data-pdhidden="yes" aria-pressed="${hidden}">No, hide it</button></div></div>
      <div class="field" style="margin-top:10px"><span class="lab">Count how many are left?</span><div class="chips"><button type="button" class="chip" data-pdtrack="yes" aria-pressed="${track}">Yes</button><button type="button" class="chip" data-pdtrack="no" aria-pressed="${!track}">No (made to order)</button></div></div>
      <button class="btn" type="button" id="pdSave" style="margin-top:12px;width:100%">Save changes</button></section>` : ""}
    <button class="btn ghost" type="button" id="sheetCancel">Close</button>`);
  $("#sheetCancel").onclick = closeSheet;
  // Adding stock: by single items, or by the case (the app works out the items and the cost of one).
  const calcAdd = () => {
    const n = parseInt($("#addQty").value, 10), size = byCase ? parseInt($("#addSize").value, 10) : 1;
    const rawC = $("#addCost") ? parseFloat($("#addCost").value) : NaN;
    const items = n >= 1 && size >= 1 ? n * size : 0, unit = rawC >= 0 && size >= 1 ? Math.round(rawC / size * 100) / 100 : null;
    return {n, size, items, unit, rawC};
  };
  const syncAdd = () => {
    if (!$("#addQty")) return;
    W = (($("#addPack") && $("#addPack").value) || "").trim().toLowerCase() || packWord(p);
    $("#addQtyLab").textContent = byCase ? `How many ${plural(W, 2)} came in?` : "How many came in?";
    if ($("#addCostLab")) $("#addCostLab").textContent = `What did ${byCase ? "a whole " + W : "each one"} cost you? (optional, ${cur()})`;
    $("#addSizeLab").textContent = `How many items in one ${W}?`;
    const chip = document.querySelector('[data-addby="case"]'); if (chip) chip.textContent = cap(plural(W, 2));
    $("#caseBox").hidden = !byCase;
    const {n, size, items, unit, rawC} = calcAdd(), box = $("#addSum");
    let msg = "", bad = false;
    if (items) msg = byCase ? `${n} ${plural(W, n)} × ${size} = <b>${items} items</b> added to stock.` : `<b>${items}</b> added to stock.`;
    if (items && unit != null) msg += ` That's <b>${money2(unit)} each</b>${byCase ? ` (${money2(rawC)} ÷ ${size})` : ""}.`;
    if (unit != null && unit > num(p.price) + 0.005){ bad = true; msg += `<br>That's more than you sell one for (${money2(p.price)}).${byCase ? ` Check the number of items in a ${W}.` : ` If this is the price of a whole pack, choose ${cap(plural(W, 2))} above.`}`; }
    box.hidden = !msg; box.innerHTML = msg; box.classList.toggle("bad", bad);
  };
  document.querySelectorAll("[data-addby]").forEach(b => b.onclick = () => {
    byCase = b.dataset.addby === "case"; store.set("busynes.bycase." + p.id, byCase ? "1" : "0");
    document.querySelectorAll("[data-addby]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); syncAdd();
  });
  ["#addQty", "#addCost", "#addSize", "#addPack"].forEach(sel => { const el = $(sel); if (el) el.oninput = syncAdd; });
  syncAdd();
  const sa = $("#saveAdd");
  if (sa) sa.onclick = () => once(sa, async () => {
    const {n, size, items, unit} = calcAdd();
    if (!(n >= 1)) return toast(byCase ? `Enter how many ${plural(W, 2)} came in.` : "Enter how many came in.");
    if (byCase && !(size >= 2 && size <= 1000)) return toast(`Enter how many items are in one ${W} (2 to 1000).`);
    const newName = (($("#addPack") && $("#addPack").value) || "").trim().toLowerCase();
    const rememberSize = byCase && mgr && (size !== p.case_size || (newName && newName !== (p.pack_name || "")));
    await stockMove(p.id, "add", String(items), unit != null ? String(unit) : "");
    if (rememberSize) { try { await must(S.sb.rpc("update_product", Object.assign({p_id: p.id, p_case_size: size}, newName ? {p_pack_name: newName} : {}))); await refresh(true); } catch(e){} }
  });
  const sc = $("#saveCount"); if (sc) sc.onclick = () => once(sc, () => stockMove(p.id, "count", $("#countQty").value));
  document.querySelectorAll("[data-pdhidden]").forEach(b => b.onclick = () => { hidden = b.dataset.pdhidden === "yes"; document.querySelectorAll("[data-pdhidden]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  document.querySelectorAll("[data-pdtrack]").forEach(b => b.onclick = () => { track = b.dataset.pdtrack === "yes"; document.querySelectorAll("[data-pdtrack]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  const warnCost = () => { const w = $("#costWarn"); if (!w) return; const c = parseFloat($("#costIn").value), pr = parseFloat($("#priceIn").value); w.hidden = !(c > pr); };
  ["#costIn", "#priceIn"].forEach(sel => { const el = $(sel); if (el) el.oninput = warnCost; });
  warnCost();
  const ps = $("#pdSave");
  if (ps) ps.onclick = () => once(ps, async () => {
    const name = $("#nameIn").value.trim(), price = parseFloat($("#priceIn").value), rawCost = $("#costIn").value.trim(), c = parseFloat(rawCost);
    if (!name) return toast("Give it a name.");
    if (!(price >= 0)) return toast("Enter a selling price.");
    if (rawCost !== "" && !(c >= 0)) return toast("Enter what it costs you, or leave it empty.");
    if (rawCost === "" && cost != null) return toast("A cost can be changed, but not removed.");
    const rawCase = $("#caseIn").value.trim(), caseN = rawCase === "" ? 0 : parseInt(rawCase, 10);
    if (rawCase !== "" && !(caseN >= 2 && caseN <= 1000)) return toast("A pack holds between 2 and 1000 items, or leave it empty.");
    const patch = {}, packN = $("#packIn").value.trim().toLowerCase();
    if ((p.case_size || 0) !== caseN) patch.p_case_size = caseN;
    if (packN !== (p.pack_name || "")) patch.p_pack_name = packN;
    if (name !== p.name) patch.p_name = name;
    if (price !== num(p.price)) patch.p_price = price;
    if (rawCost !== "" && c !== cost) patch.p_cost = c;
    if (hidden !== !!p.hidden) patch.p_hidden = hidden;
    if (track !== tracked) patch.p_track = track;
    if (!Object.keys(patch).length) return toast("Nothing has changed.");
    try { await must(S.sb.rpc("update_product", Object.assign({p_id: p.id}, patch))); closeSheet(); toast("Saved."); await refresh(); }
    catch(err){ failed(err); }
  });
}

function newProductSheet(){
  const os = Object.values(owners()), multi = os.length > 1;
  openSheet(`<div class="grab"></div><h2>Add a product</h2>
    <div class="field"><label for="npName">Name</label><input id="npName" class="text" maxlength="40" placeholder="e.g. Cheese burger"></div>
    <div class="field"><label for="npPrice">Selling price (${cur()})</label><input id="npPrice" class="text num" type="number" inputmode="decimal" min="0" step="1"></div>
    <div class="field"><label for="npCase">Items in a pack (only if you buy it in packs)</label><input id="npCase" class="text num" type="number" inputmode="numeric" min="2" max="1000" step="1" placeholder="e.g. 12 or 20">
      <span class="muted" style="font-size:13px">For example a case of cider (12) or a pack of 20 Russians.</span></div>
    <div class="field" id="npPackBox" hidden><label for="npPack">What do you call it? (case, box, bag, pack...)</label><input id="npPack" class="text" maxlength="20" list="packNames" placeholder="pack">${PACK_LIST}</div>
    <div class="field"><label for="npCost" id="npCostLab">What it costs you (${cur()}, optional)</label><input id="npCost" class="text num" type="number" inputmode="decimal" min="0" step="0.01" placeholder="e.g. 25">
      <span class="muted" style="font-size:13px" id="npCostHelp">So BusyNes can work out your profit. You can add it later.</span></div>
    <p class="banner" id="npSum" hidden></p>
    ${multi ? `<div class="field"><span class="lab">Whose stock is it?</span><div class="chips">${os.map((o,i) => `<button type="button" class="chip" data-npowner="${esc(o.id)}" aria-pressed="${i===0}">${esc(o.name)}</button>`).join("")}</div></div>` : ""}
    <div class="field"><span class="lab">Count how many are left?</span><div class="chips"><button type="button" class="chip" data-nptrack="yes" aria-pressed="true">Yes, track stock</button><button type="button" class="chip" data-nptrack="no" aria-pressed="false">No (made to order)</button></div></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn" type="button" id="npSave">Add product</button></div>`);
  let owner = os[0] && os[0].id, track = true;
  document.querySelectorAll("[data-npowner]").forEach(b => b.onclick = () => { owner = b.dataset.npowner; document.querySelectorAll("[data-npowner]").forEach(x => x.setAttribute("aria-pressed", String(x===b))); });
  document.querySelectorAll("[data-nptrack]").forEach(b => b.onclick = () => { track = b.dataset.nptrack === "yes"; document.querySelectorAll("[data-nptrack]").forEach(x => x.setAttribute("aria-pressed", String(x===b))); });
  $("#sheetCancel").onclick = closeSheet;
  const npCalc = () => {
    const size = parseInt($("#npCase").value, 10), raw = parseFloat($("#npCost").value), price = parseFloat($("#npPrice").value);
    const bySize = size >= 2 && size <= 1000;
    return {size: bySize ? size : null, unit: raw >= 0 ? (bySize ? Math.round(raw / size * 100) / 100 : raw) : null, raw, price};
  };
  const npSync = () => {
    const {size, unit, raw, price} = npCalc(), box = $("#npSum");
    const w = ($("#npPack").value || "").trim().toLowerCase() || "pack";
    $("#npPackBox").hidden = !size;
    $("#npCostLab").textContent = size ? `What does one whole ${w} cost you? (${cur()}, optional)` : `What it costs you (${cur()}, optional)`;
    let msg = "", bad = false;
    if (size && unit != null) msg = `${money2(raw)} ÷ ${size} = <b>${money2(unit)} each</b>.`;
    if (unit != null && price >= 0 && unit > price + 0.005){ bad = true; msg += `${msg ? "<br>" : ""}That's more than the selling price. ${size ? `Check the number of items in a ${w}.` : "If this is the price of a whole pack, enter how many items are in it above."}`; }
    box.hidden = !msg; box.innerHTML = msg; box.classList.toggle("bad", bad);
  };
  ["#npCase", "#npCost", "#npPrice", "#npPack"].forEach(sel => { $(sel).oninput = npSync; });
  $("#npSave").onclick = async e => {
    const name = $("#npName").value.trim(), price = parseFloat($("#npPrice").value);
    if (!name || !(price >= 0)) { toast("Give it a name and a price."); return; }
    const rawCase = $("#npCase").value.trim();
    if (rawCase !== "" && !(parseInt(rawCase, 10) >= 2 && parseInt(rawCase, 10) <= 1000)) { toast("A pack holds between 2 and 1000 items, or leave it empty."); return; }
    e.target.disabled = true;
    try { const {size, unit} = npCalc();
      await must(S.sb.rpc("add_product", Object.assign({p_biz: bid(), p_name: name, p_price: price, p_group: owner, p_track: track}, unit != null ? {p_cost: unit} : {}, size ? Object.assign({p_case_size: size}, $("#npPack").value.trim() ? {p_pack_name: $("#npPack").value.trim().toLowerCase()} : {}) : {}))); closeSheet(); toast(name + " added."); await refresh(); }
    catch(err){ e.target.disabled = false; failed(err); }
  };
}

// ---------- sales ----------
// Does this sale match what was typed? Every word must appear somewhere: items, customer note, who sold it,
// who got the money, the day, or the amount.
function saleMatches(s, q){
  const items = s.items || [], priced = items.filter(i => i.price != null);
  const amount = s.whole && s.total != null ? num(s.total) : priced.reduce((x, i) => x + num(i.price) * i.qty, 0);
  const hay = [items.map(i => i.name).join(" "), s.note || "", pname(s.recorded_by), Pname(s.paid_to), dayLabel(s.at), s.method === "cash" ? "cash" : "account transfer",
    amount ? String(amount) : "", amount ? money(amount) : ""].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
function saleOwes(s){ return s.whole && s.total != null && s.paid != null ? num(s.total) - num(s.paid) : 0; }
function viewSales(){
  const mine = x => x.paid_to === S.me || x.recorded_by === S.me;
  const base = S.salesFilter === "mine" ? S.sales.filter(mine) : S.sales;
  const since = {today: new Date().setHours(0,0,0,0), week: Date.now() - 7*864e5, month: Date.now() - 30*864e5}[S.speriod];
  const q = (S.sq || "").trim();
  const list = base.filter(s => (!since || new Date(s.at).getTime() >= since) && (S.smethod === "all" || s.method === (S.smethod === "cash" ? "cash" : "transfer"))
    && (S.sstatus === "all" || saleOwes(s) > 0.005) && (!q || saleMatches(s, q)));
  const filtering = !!q || S.speriod !== "all" || S.smethod !== "all" || S.sstatus !== "all";
  const chips = (key, attr, opts) => `<div class="chips seg" role="group">${opts.map(([k,l]) => `<button type="button" class="chip" data-${attr}="${k}" aria-pressed="${S[key]===k}">${l}</button>`).join("")}</div>`;
  let h = `<h2>Sales</h2><p class="muted" style="margin:-12px 0 0">Everything that's been sold, newest first: what, when, who sold it and where the money went. Amounts only show for your own products and for sales you handled${S.biz.privacy === "shared" && canManage() ? ", plus everything else if you're an owner or partner" : ""}.</p>
    <div class="chips" role="group">${[["all","Everyone's"],["mine","Mine"]].map(([k,l]) => `<button type="button" class="chip" data-sfilter="${k}" aria-pressed="${S.salesFilter===k}">${l}</button>`).join("")}</div>
    <input id="salesSearch" class="text" type="search" placeholder="Search: item, customer, person, amount..." aria-label="Search sales" autocomplete="off" value="${esc(S.sq || "")}">
    ${chips("speriod", "speriod", [["all","Any time"],["today","Today"],["week","7 days"],["month","30 days"]])}
    ${chips("smethod", "smethod", [["all","Cash + account"],["cash","Cash"],["transfer","Account"]])}
    ${chips("sstatus", "sstatus", [["all","All sales"],["owing","Still owing"]])}`;
  h += offlineBanner();
  if (filtering){
    const total = list.reduce((x, s) => { const it = (s.items || []).filter(i => i.price != null); return x + (s.whole && s.total != null ? num(s.total) : it.reduce((y, i) => y + num(i.price) * i.qty, 0)); }, 0);
    h += `<p class="muted salescount" style="margin:0"><b>${list.length}</b> sale${list.length === 1 ? "" : "s"}${list.length ? " · " + money2(total) : ""} <button class="linkbtn" type="button" data-sclear>Clear search</button></p>`;
  }
  if (!list.length) return h + (filtering ? `<div class="empty"><b>No sales match</b>Try a different word, or clear the search.</div>`
    : `<div class="empty"><b>No sales to show yet</b>${S.salesFilter === "mine" ? "Sales you recorded or were paid for will show here." : "Sales recorded by anyone in the business will show here."}</div>`);
  let cur = "";
  for (const s of list){
    const k = dayKey(s.at);
    if (k !== cur){
      if (cur) h += `</div></section>`;
      h += `<section class="day"><div class="owner-head"><span class="eyebrow">${dayLabel(s.at)}</span></div><div class="card" style="padding-block:2px">`;
      cur = k;
    }
    const items = s.items || [], priced = items.filter(i => i.price != null);
    const amount = s.whole && s.total != null ? num(s.total) : priced.reduce((a,i) => a + num(i.price)*i.qty, 0);
    const owes = s.whole && s.total != null && s.paid != null ? num(s.total) - num(s.paid) : 0;
    const del = S.confirmDel === s.id, canDel = s.whole && (mine(s) || isOwner());
    h += `<div class="sale"><div class="top"><span class="what">${items.map(i => i.qty + " × " + esc(i.name)).join(", ")}</span>${s.whole || priced.length ? `<b class="num">${money(amount)}</b>` : ""}</div>
      <div class="row" style="gap:6px;font-size:13px"><span class="pill ${s.method==="cash"?"cash":""}">${s.method === "cash" ? "Cash" : "Account"} → ${esc(Pname(s.paid_to))}</span>
      ${owes > 0.005 ? `<span class="pill bad">Owes ${money2(owes)}</span>` : ""}${s.whole && num(s.loan_fee) > 0 ? `<span class="pill warn">Loan</span>` : ""}
      <span class="muted">${timeLabel(s.at)} · sold by ${esc(pname(s.recorded_by))}${s.note ? " · " + esc(s.note) : ""}${!s.whole && priced.length ? " · amount is your items only" : ""}</span><span class="spacer"></span>
      ${canDel ? (del ? `<button class="linkbtn" type="button" data-nodel>Keep</button><button class="linkbtn bad" type="button" data-dodel="${s.id}">Yes, delete</button>` : `<button class="linkbtn" type="button" data-del="${s.id}">Delete</button>`) : ""}</div></div>`;
  }
  return h + `</div></section>`;
}

// ---------- my money ----------
function viewReport(){
  const m = S.money || {received:0, received_cash:0, due:0, sold:[], pays:[], orders:0};
  const periods = [["settle","Since settle-up"],["today","Today"],["week","Week"],["all","All time"]];
  let h = `<h2>My money</h2><div class="chips seg">${periods.map(([k,l]) => `<button type="button" class="chip" data-period="${k}" aria-pressed="${S.period===k}">${l}</button>`).join("")}</div>`;
  if (S.period === "settle") h += `<p class="muted" style="margin:-8px 0 0">${S.settlements[0] ? "Counting from the settle-up on " + dayLabel(S.settlements[0].at) + " at " + timeLabel(S.settlements[0].at) + "." : "No settle-ups yet, so this counts every sale."}</p>`;

  const received = num(m.received), cash = num(m.received_cash), due = num(m.due), diff = Math.round((received - due)*100)/100;
  h += `<div class="kpis">
    <div class="kpi"><span class="eyebrow">Money you received</span><b class="num">${money2(received)}</b><span class="muted num">${money(cash)} cash · ${money(received - cash)} account</span></div>
    <div class="kpi"><span class="eyebrow">Your share collected</span><b class="num">${money2(due)}</b><span class="muted num">${money(m.sold_value != null ? m.sold_value : due)} of your stock sold${num(m.fees) > 0.005 ? " · " + money2(m.fees) + " loan fees" : ""}</span></div></div>`;
  if (num(m.outstanding) > 0.005) h += `<section class="card statement">Customers still owe <b class="num">${money2(m.outstanding)}</b> on your products and loan fees. It counts here once they pay.</section>`;
  h += `<section class="card statement">${diff > 0 ? `You're holding <b class="num">${money2(diff)}</b> that belongs to the others.`
       : diff < 0 ? `The others are holding <b class="num">${money2(-diff)}</b> of your money.`
       : `You hold exactly your own money.`}</section>`;

  h += `<section class="card"><div class="eyebrow">To settle up</div>`;
  h += m.pays.length ? m.pays.map(p => `<div class="pay"><span>${esc(payText(p))}</span><span class="amt num ${payFromMe(p) ? "pos" : "neg"}">${money2(p.amount)}</span></div>`).join("")
    : `<p style="margin:8px 0 0">Nothing to hand over for you.</p>`;
  if (m.pays.some(p => (p.from_ids || []).length > 1 || (p.to_ids || []).length > 1)) h += `<p class="muted" style="margin:10px 0 0;font-size:13px">Partners who run the same stock together settle as one, so it doesn't matter which of them gets the money.</p>`;
  h += `<div class="row" style="margin-top:12px"><button class="btn ghost small" type="button" data-copyreport>Copy my settle-up</button><span class="spacer"></span>${canManage() ? `<button class="btn small" type="button" data-settle>Mark as settled</button>` : ""}</div></section>`;

  h += profitCard();
  const sold = m.sold || [];
  if (sold.length){
    const max = Math.max(...sold.map(p => num(p.amount)));
    h += `<section class="card"><div class="eyebrow">Your products sold</div><div class="list">` + sold.map(p => `<div class="item" style="display:block"><div class="row"><span class="title">${esc(p.name)}</span><span class="spacer"></span><span class="num">${p.qty} sold · <b>${money(p.amount)}</b>${num(p.my_share) !== num(p.amount) ? ` <span class="muted">(your share ${money2(p.my_share)})</span>` : ""}</span></div><div class="bar"><i style="width:${(num(p.amount)/max*100).toFixed(1)}%;background:var(--bottle)"></i></div></div>`).join("") + `</div></section>`;
  } else {
    h += `<div class="empty"><b>None of your stock sold in this period</b>When it does, it shows up here.</div>`;
  }
  return h;
}
// Profit: what you sold (your share) minus what it cost you. Owners and partners only.
function profitCard(){
  if (!canManage() || !S.profit) return "";
  const p = S.profit, costed = num(p.costed_revenue), cost = num(p.cost), profit = num(p.profit), missing = num(p.missing_revenue), fees = num(p.fees);
  const prods = p.products || [], anyCost = Object.keys(S.costs).length > 0;
  let h = `<section class="card profit"><div class="row"><span class="eyebrow">Your profit</span><span class="spacer"></span>`;
  if (!anyCost && costed <= 0){
    return h + `</div><p style="margin:8px 0 12px"><b>See if you're making money.</b> Tell BusyNes what each item costs you and it will work out your profit and show which items earn the most.</p>
      <button class="btn small" type="button" data-gostock>Add what things cost</button></section>`;
  }
  const margin = costed > 0 ? profit / costed : null;
  const verdict = costed <= 0 ? null : profit < -0.005 ? {cls:"bad", text:"Losing money"} : margin < 0.10 ? {cls:"warn", text:"Thin margin"} : {cls:"good", text:"Making money"};
  if (verdict) h += `<span class="pill ${verdict.cls}">${verdict.text}</span>`;
  h += `</div>`;
  if (costed > 0){
    h += `<div class="big num ${verdict.cls}">${money2(profit)}</div>
      <p class="muted" style="margin:2px 0 0">From ${money2(costed)} of sales, minus ${money2(cost)} it cost you. <b>${pct1(margin)}</b> of what you sell is profit.</p>`;
    if (fees > 0.005) h += `<div class="row" style="margin-top:10px"><span>Loan fees earned</span><span class="spacer"></span><b class="num">+${money2(fees)}</b></div>
      <div class="row"><span>Profit with fees</span><span class="spacer"></span><b class="num">${money2(profit + fees)}</b></div>`;
  } else {
    h += `<p class="muted" style="margin:8px 0 0">Nothing with a cost set was sold in this period.</p>`;
  }
  if (missing > 0.005) h += `<p class="banner" style="margin:12px 0 0">${money2(missing)} of what you sold has no cost set yet, so it's left out. <button class="linkbtn" type="button" data-gostock>Set costs</button></p>`;
  if (prods.length){
    h += `<div class="eyebrow" style="margin:16px 0 4px">By product</div><div class="list">` + prods.map(r => {
      const has = r.costed, pr = num(r.profit), loss = has && pr < -0.005;
      return `<div class="item"><div class="main"><div class="title">${esc(r.name)}</div><div class="sub num">${r.qty} sold · ${money2(r.revenue)}${loss ? " · selling below cost (is the cost per pack, not per item?)" : ""}</div></div>
        <div class="num ${loss ? "bad-text" : ""}" style="font-weight:700">${has ? money2(pr) : `<span class="muted" style="font-weight:500">no cost</span>`}</div></div>`;
    }).join("") + `</div>`;
  }
  return h + `<p class="muted" style="margin:12px 0 0;font-size:13px">Profit is on what you sold in this period, whether or not the customer has paid yet, and only your share of it.</p></section>`;
}

// Settle-up lines. Partners who co-own stock can count as one team, so a line can be to/from more than one person.
const payFromMe = p => (p.from_ids || [p.from]).includes(S.me);
function payText(p){
  const fromIds = p.from_ids || [p.from], toIds = p.to_ids || [p.to];
  const names = ids => ids.map(id => (S.partners.find(x => x.id === id) || {name:"someone"}).name);
  const others = ids => names(ids.filter(id => id !== S.me));
  if (fromIds.includes(S.me)) return (fromIds.length > 1 ? "You or " + others(fromIds).join(" & ") + " pay " : "You pay ") + (p.to_name || names(toIds).join(" & ")) + (toIds.length > 1 ? " (either one)" : "");
  if (toIds.includes(S.me)) return (p.from_name || names(fromIds).join(" & ")) + " pays you" + (toIds.length > 1 ? " or " + others(toIds).join(" & ") : "");
  return (p.from_name || names(fromIds).join(" & ")) + " pays " + (p.to_name || names(toIds).join(" & "));
}
function reportText(){
  const m = S.money, me = (S.partners.find(p => p.id === S.me) || {}).name;
  const lbl = {settle:"since last settle-up", today:"today", week:"this week", all:"all time"}[S.period];
  return `📊 ${me}'s settle-up (${lbl})\n` + (m.pays.length ? m.pays.map(p => `${payText(p)}: ${money2(p.amount)}`).join("\n") : "Nothing to hand over.");
}
function settleSheet(){
  openSheet(`<div class="grab"></div><h2>Mark as settled?</h2>
    <p>Do this once all the settle-up money has changed hands between you and the others. "Since last settle-up" then starts again from zero for everyone. Old sales stay in the records.</p>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Not yet</button><span class="spacer"></span><button class="btn" type="button" id="doSettle">Yes, we're settled</button></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#doSettle").onclick = async e => {
    e.target.disabled = true;
    try { await must(S.sb.rpc("mark_settled", {p_biz: bid()})); closeSheet(); S.period = "settle"; toast("Settled. Starting fresh."); await refresh(); }
    catch(err){ e.target.disabled = false; failed(err); }
  };
}

// ---------- your data: download a copy ----------
// A cell that starts with = + - or @ could run as a formula when opened in a spreadsheet, so text like that gets a
// leading apostrophe. Numbers are written as they are.
const csvCell = v => {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
const toCsv = (head, rows) => "﻿" + [head, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
const round2 = n => Math.round(n * 100) / 100;
function salesCsv(d){
  const rows = [], sales = d.sales || [];
  sales.forEach((s, i) => (s.items || []).forEach(it => rows.push([
    sales.length - i, dayKey(s.at), timeLabel(s.at), s.sold_by, s.money_to, s.method === "cash" ? "Cash" : "Account", s.note,
    it.name, it.qty, it.price, it.price != null ? round2(it.price * it.qty) : null,
    s.total, s.paid, s.total != null && s.paid != null ? round2(s.total - s.paid) : null, s.loan_fee || null, s.due_on])));
  return toCsv(["Sale no.","Date","Time","Sold by","Money went to","How paid","Customer or note","Item","Qty","Unit price","Line total","Sale total","Paid so far","Still owed","Loan fee","Due date"], rows);
}
function productsCsv(d){
  const mgr = d.you && (d.you.role === "owner" || d.you.role === "partner");
  const head = ["Product","Price"].concat(mgr ? ["Cost"] : [], ["Group","Hidden","Counts stock","In stock now"]);
  return toCsv(head, (d.products || []).map(p => [p.name, p.price].concat(mgr ? [p.cost] : [], [niceGroup(p.group), p.hidden ? "Yes" : "No", p.tracks_stock ? "Yes" : "No", p.stock_on_hand])));
}
function ordersCsv(d){
  return toCsv(["Date","Time","Customer","Items","Note","Status","Loan","Added by","Taken by"],
    (d.orders || []).map(o => [dayKey(o.at), timeLabel(o.at), o.customer, (o.items || []).map(i => i.qty + " × " + i.name).join("; "), o.note, o.status, o.loan ? "Yes" : "No", o.added_by, o.taken_by]));
}
// On a phone this opens the share sheet (save to Files, email, WhatsApp); elsewhere it downloads the file.
async function saveFile(name, text, type){
  const file = typeof File === "function" ? new File([text], name, {type}) : null;
  if (file && navigator.canShare && /android|iphone|ipad/i.test(navigator.userAgent) && navigator.canShare({files: [file]})){
    try { await navigator.share({files: [file], title: name}); return; }
    catch(e){ if (e && e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(new Blob([text], {type}));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
async function exportData(kind){
  const d = await must(S.sb.rpc("export_data", {p_biz: bid()}));
  const base = slug(S.biz.name) + "-" + kind + "-" + dayKey(new Date());
  if (kind === "sales") await saveFile(base + ".csv", salesCsv(d), "text/csv");
  else if (kind === "products") await saveFile(base + ".csv", productsCsv(d), "text/csv");
  else if (kind === "orders") await saveFile(base + ".csv", ordersCsv(d), "text/csv");
  else await saveFile(slug(S.biz.name) + "-backup-" + dayKey(new Date()) + ".json", JSON.stringify(d, null, 2), "application/json");
  toast("Your file is ready.");
}

// ---------- business settings: people, ownership, privacy ----------
function memberRow(m){
  const owner = isOwner();
  return `<div class="item"><div class="main"><div class="title">${esc(m.name)}${m.id === S.me ? ` <span class="muted">(you)</span>` : ""}</div>
    <div class="sub">${esc(ROLE_NAME[m.role] || "")}${m.status === "invited" ? " · invited, hasn't joined yet" : ""}${owner && m.email ? " · " + esc(m.email) : ""}</div></div>
    ${owner && m.role !== "owner" ? `<select class="text" style="width:auto" data-setrole="${esc(m.id)}" aria-label="Role of ${esc(m.name)}">${["partner","staff","delivery"].map(r => `<option value="${r}" ${m.role === r ? "selected" : ""}>${ROLE_NAME[r]}</option>`).join("")}</select>
      <button class="linkbtn" type="button" data-emember="${esc(m.id)}">${m.status === "invited" ? "Edit / resend" : "Edit"}</button>
      <button class="linkbtn bad" type="button" data-rmember="${esc(m.id)}">Remove</button>` : ""}</div>`;
}
function groupCard(g){
  const owner = isOwner(), cur = {};
  for (const s of S.shares) if (s.owner === g) cur[s.partner_id] = num(s.share);
  const eligible = (S.members || []).filter(m => m.role === "owner" || m.role === "partner");
  const inGroup = eligible.filter(m => cur[m.id] > 0), prods = S.products.filter(p => p.owner === g).length;
  let h = `<div class="group"><div class="row"><span class="title">${esc(niceGroup(g))}</span><span class="muted">${prods} product${prods === 1 ? "" : "s"}</span></div>`;
  if (owner){
    h += eligible.map(m => `<div class="row" style="margin-top:8px"><span class="main">${esc(m.name)}${m.status === "invited" ? " <span class='muted'>(invited)</span>" : ""}</span>
      <input class="text num" style="width:92px" type="number" inputmode="decimal" min="0" max="100" step="0.01" placeholder="0" data-gs="${esc(g)}" data-gsm="${esc(m.id)}" value="${cur[m.id] ? Math.round(cur[m.id] * 10000) / 100 : ""}" aria-label="${esc(m.name)}'s share of ${esc(niceGroup(g))} in percent"> <span class="muted">%</span></div>`).join("");
    h += `<div class="row" style="margin-top:10px"><span class="muted" id="gsum-${esc(g)}"></span><span class="spacer"></span>
      ${groupIds().length > 1 ? `<button class="linkbtn bad" type="button" data-delgroup="${esc(g)}">Delete group</button>` : ""}<button class="btn small" type="button" data-savegroup="${esc(g)}">Save shares</button></div>`;
  } else {
    h += inGroup.map(m => `<div class="row" style="margin-top:6px"><span class="main">${esc(m.name)}</span><b class="num">${pct(cur[m.id])}</b></div>`).join("");
  }
  return h + `</div>`;
}
function viewSettings(){
  const b = S.biz, owner = isOwner(), ms = S.members;
  let h = `<h2>Business settings</h2>`;
  h += `<section class="card"><div class="eyebrow">Business</div>
    <div class="row" style="margin-top:6px"><div class="main"><div class="title">${esc(b.name)}</div><div class="sub">${esc(b.kind || "No type set")} · you are ${ROLE_NAME[b.role] === "Owner" ? "the owner" : "a " + ROLE_NAME[b.role].toLowerCase()}</div></div>${owner ? `<button class="btn small ghost" type="button" data-editbiz>Edit</button>` : ""}</div>
    <div class="field" style="margin-top:14px"><span class="lab">Who can see the money?</span>
      ${owner ? `<div class="chips">${[["shared","Owners and partners see everything"],["private","Everyone sees only their own"]].map(([k,l]) => `<button type="button" class="chip" data-privacy="${k}" aria-pressed="${b.privacy === k}">${l}</button>`).join("")}</div>`
              : `<span>${b.privacy === "shared" ? "Owners and partners see everything" : "Everyone sees only their own sales and money"}</span>`}
      <span class="muted" style="font-size:13px">Everyone can always see what was sold and when. This is about amounts, who owes what, and credit.</span></div>
    <div class="field" style="margin-top:12px"><span class="lab">Settling up between partners</span>
      ${owner ? `<div class="chips">${[[false,"Each partner separately"],[true,"Partners who share stock, as one team"]].map(([k,l]) => `<button type="button" class="chip" data-teamsettle="${k}" aria-pressed="${!!b.team_settle === k}">${l}</button>`).join("")}</div>`
              : `<span>${b.team_settle ? "Partners who share stock settle up as one team" : "Each partner settles up separately"}</span>`}
      <span class="muted" style="font-size:13px">"As one team" suits two partners running the same stock together: you pay them once, to either of them.</span></div></section>`;

  h += `<section class="card"><div class="row"><div class="eyebrow">People</div><span class="spacer"></span>${owner ? `<button class="btn small" type="button" data-invite>Invite someone</button>` : ""}</div>`;
  h += !ms ? `<p class="muted">Loading…</p>` : `<div class="list">${ms.map(memberRow).join("")}</div>`;
  h += `<p class="muted" style="margin:10px 0 0;font-size:13px">Roles: <b>Partner</b> owns part of the business. <b>Staff</b> records sales, orders and stock. <b>Delivery</b> only sees and takes orders.</p></section>`;

  if (canManage() && ms){
    h += `<section class="card"><div class="row"><div class="eyebrow">Who owns what</div><span class="spacer"></span>${owner ? `<button class="btn small ghost" type="button" data-newgroup>New group</button>` : ""}</div>
      <p class="muted" style="margin:6px 0 4px;font-size:13px">Each group of products is owned by one or more people, in percentages. The money from a sale is shared between the owners of what was sold, so a partner's cut never looks like it's all theirs. Changes apply to everything that hasn't been settled yet, so mark things as settled first if you want older sales left as they were.</p>
      ${groupIds().map(groupCard).join("")}</section>`;
  }

  h += `<section class="card"><div class="eyebrow">Your data</div>
    <p style="margin:6px 0 10px">Download a copy of what you can see in this business. Handy as a backup, or to open in Excel. These files contain business information, so keep them somewhere safe.</p>
    <div class="chips">${canSell() ? `<button class="btn small ghost" type="button" data-export="sales">Sales</button><button class="btn small ghost" type="button" data-export="products">Products and stock</button>` : ""}<button class="btn small ghost" type="button" data-export="orders">Orders</button><button class="btn small" type="button" data-export="backup">Everything (backup file)</button></div></section>`;
  h += `<section class="card"><div class="eyebrow">Privacy</div>
    <p style="margin:6px 0 10px">Only you and the people you invite can see this business. Other businesses on BusyNes can't see it, and there is no admin screen for anyone to browse it. <a href="privacy.html">Read how it works</a></p>
    <div class="row"><span class="muted">BusyNes v${VERSION}</span></div></section>`;

  h += `<section class="card"><div class="eyebrow">${owner ? "Danger zone" : "Leave"}</div>
    ${owner ? `<p class="muted" style="margin:6px 0 10px;font-size:13px">Deleting a business removes all of its sales, stock, orders and people for good.</p><button class="btn danger small" type="button" data-delbiz>Delete this business</button>`
            : `<p class="muted" style="margin:6px 0 10px;font-size:13px">You'll lose access straight away. Your past sales stay in the business's records.</p><button class="btn ghost small" type="button" data-leave>Leave this business</button>`}</section>`;
  return h;
}
const gsSum = g => [...document.querySelectorAll(`[data-gs="${CSS.escape(g)}"]`)].reduce((a, i) => a + (parseFloat(i.value) || 0), 0);
function updateGsum(g){
  const el = $("#gsum-" + CSS.escape(g)); if (!el) return;
  const t = Math.round(gsSum(g) * 100) / 100;
  el.textContent = `Adds up to ${t}%`; el.style.color = Math.abs(t - 100) < 0.05 ? "var(--good)" : "var(--bad)";
}
async function setBusiness(patch){
  await must(S.sb.rpc("update_business", Object.assign({p_biz: bid()}, patch)));
  await loadBusinesses(); const cur = S.businesses.find(x => x.id === bid()); if (cur){ S.biz = cur; S.me = cur.member_id; }
}
function bizSheet(){
  openSheet(`<div class="grab"></div><h2>Your businesses</h2>
    <div class="list">${S.businesses.map(b => `<button type="button" class="notif" data-openbiz="${esc(b.id)}" aria-current="${b.id === bid()}"><span class="main"><b>${esc(b.name)}${b.id === bid() ? " ✓" : ""}</b><span class="sub">${esc(ROLE_NAME[b.role])}${b.kind ? " · " + esc(b.kind) : ""}</span></span>${S.unreadBy[b.id] && b.id !== bid() ? `<span class="pill bad">${S.unreadBy[b.id]} new</span>` : ""}</button>`).join("")}</div>
    <div class="row"><button class="btn ghost" type="button" id="bizSettings">Business settings</button><span class="spacer"></span><button class="btn" type="button" id="bizNew">Start another business</button></div>
    <button class="btn ghost" type="button" id="sheetCancel">Close</button>`);
  $("#sheetCancel").onclick = closeSheet;
  document.querySelectorAll("[data-openbiz]").forEach(b => b.onclick = () => { if (b.dataset.openbiz !== bid()) openBusiness(b.dataset.openbiz); else closeSheet(); });
  $("#bizSettings").onclick = () => { closeSheet(); goTab("settings"); };
  $("#bizNew").onclick = newBizSheet;
}
function newBizSheet(){
  const mine = (S.partners.find(p => p.id === S.me) || {}).name || "";
  openSheet(`<div class="grab"></div><h2>Start another business</h2>
    <p class="muted">It will be completely separate from ${esc(S.biz.name)}. Nobody there will see it unless you invite them.</p>
    <div class="field"><label for="nbName">Business name</label><input id="nbName" class="text" maxlength="60" placeholder="e.g. Fat Cook"></div>
    <div class="field"><label for="nbKind">What do you sell? (optional)</label><input id="nbKind" class="text" maxlength="40" placeholder="e.g. Fast food"></div>
    <div class="field"><label for="nbMe">Your name in it</label><input id="nbMe" class="text" maxlength="40" value="${esc(mine)}"></div>
    <div class="field"><label for="nbCur">Currency symbol</label><input id="nbCur" class="text" maxlength="4" list="curList" value="${esc(cur())}" autocomplete="off">${CUR_LIST}</div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn" type="button" id="nbSave">Create business</button></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#nbSave").onclick = e => once(e.target, async () => {
    const name = $("#nbName").value.trim(); if (!name) return toast("Give the business a name.");
    try { await createBusiness(name, $("#nbKind").value.trim(), $("#nbMe").value.trim(), $("#nbCur").value.trim()); } catch(err){ failed(err); }
  });
}
function inviteSheet(){
  const gs = groupIds(), single = gs.length === 1;
  let r = "partner";
  openSheet(`<div class="grab"></div><h2>Invite someone</h2>
    <div class="field"><label for="ivEmail">Their email</label><input id="ivEmail" class="text" type="email" autocomplete="off" placeholder="name@email.com"></div>
    <div class="field"><label for="ivName">Their name (optional)</label><input id="ivName" class="text" maxlength="40"></div>
    <div class="field"><span class="lab">What will they do?</span>
      <div class="chips" role="group">${["partner","staff","delivery"].map(k => `<button type="button" class="chip" data-ivrole="${k}" aria-pressed="${k === r}">${ROLE_NAME[k]}</button>`).join("")}</div>
      <span class="muted" style="font-size:13px" id="ivHelp">${ROLE_HELP[r]}</span></div>
    <div class="field" id="ivShareBox"${single ? "" : " hidden"}><label for="ivShare">Their share of the business (%)</label><input id="ivShare" class="text num" type="number" inputmode="decimal" min="0" max="99" step="0.5" placeholder="e.g. 35">
      <span class="muted" style="font-size:13px">You keep the rest. Leave it empty to set ownership later.</span></div>
    ${single ? "" : `<p class="muted" style="font-size:13px" id="ivMulti">You have several product groups. Set a partner's share under "Who owns what" once they've joined.</p>`}
    <div class="err" id="ivErr" role="alert" style="color:var(--bad);font-weight:600;min-height:1.4em"></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn" type="button" id="ivSave">Send invitation</button></div>`);
  const sync = () => {
    $("#ivHelp").textContent = ROLE_HELP[r];
    if ($("#ivShareBox")) $("#ivShareBox").hidden = !(r === "partner" && single);
    if ($("#ivMulti")) $("#ivMulti").hidden = r !== "partner";
  };
  document.querySelectorAll("[data-ivrole]").forEach(b => b.onclick = () => { r = b.dataset.ivrole; document.querySelectorAll("[data-ivrole]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); sync(); });
  $("#sheetCancel").onclick = closeSheet;
  $("#ivSave").onclick = e => once(e.target, async () => {
    const email = $("#ivEmail").value.trim(), name = $("#ivName").value.trim();
    const share = r === "partner" && single ? (parseFloat($("#ivShare").value) || 0) : 0;
    if (!email) { $("#ivErr").textContent = "Type their email address."; return; }
    if (share < 0 || share >= 100) { $("#ivErr").textContent = "The share must be between 0 and 100%."; return; }
    try {
      await must(S.sb.rpc("invite_member", {p_biz: bid(), p_email: email, p_name: name, p_role: r, p_group: single ? gs[0] : null, p_share: share / 100}));
      await Promise.all([loadMembers(), refresh(true)]);
      inviteDoneSheet(email, name || email.split("@")[0], r);
    } catch(err){ $("#ivErr").textContent = (err && err.message) || "That didn't work."; }
  });
}
function inviteDoneSheet(email, name, r, again){
  const msg = `Hi ${name}! I've added you to "${S.biz.name}" on BusyNes as ${ROLE_NAME[r].toLowerCase()}.\n\n1. Open ${appLink()}\n2. Tap "Create account" using THIS email: ${email} (if you already have a BusyNes login, just log in)\n3. Confirm your email from the message we send you, then log in. "${S.biz.name}" will be waiting for you.`;
  openSheet(`<div class="grab"></div><h2>${again ? "Send the invitation again" : "Invitation saved"}</h2>
    <p>${esc(name)} will see ${esc(S.biz.name)} as soon as they sign up or sign in with <b>${esc(email)}</b>. Send them this message:</p>
    <textarea class="text" rows="9" readonly id="ivMsg">${esc(msg)}</textarea>
    <div class="row" style="gap:8px;flex-wrap:wrap"><a class="btn" id="ivWa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">WhatsApp</a>
      <a class="btn ghost" id="ivMail" href="mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Join " + S.biz.name + " on BusyNes")}&body=${encodeURIComponent(msg)}">Email</a>
      <button class="btn ghost" type="button" id="ivCopy">Copy message</button></div>
    <button class="btn ghost" type="button" id="sheetCancel" style="margin-top:10px;width:100%">Done</button>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#ivCopy").onclick = () => copyText(msg, "Copied. Send it to " + name + ".");
}
// Change an invited person's details, send the invitation again, or cancel it.
function memberSheet(m){
  const invited = m.status === "invited";
  openSheet(`<div class="grab"></div><h2>${esc(m.name)}</h2>
    <p class="muted" style="margin:-10px 0 0">${esc(ROLE_NAME[m.role] || "")}${invited ? " · invited, hasn't joined yet" : " · joined"}</p>
    <div class="field"><label for="emName">Name</label><input id="emName" class="text" maxlength="40" value="${esc(m.name)}"></div>
    ${invited ? `<div class="field"><label for="emEmail">Email they will sign up with</label><input id="emEmail" class="text" type="email" autocomplete="off" value="${esc(m.email || "")}">
      <span class="muted" style="font-size:13px">Typed it wrong? Fix it here, then send the invitation again.</span></div>`
      : `<p class="muted" style="font-size:13px">${m.email ? "Email: " + esc(m.email) + ". " : ""}They have joined, so their email is their login and can't be changed here.</p>`}
    <div class="err" id="emErr" role="alert" style="color:var(--bad);font-weight:600;min-height:1.4em"></div>
    <button class="btn" type="button" id="emSave" style="width:100%">Save changes</button>
    ${invited ? `<button class="btn ghost" type="button" id="emResend" style="width:100%;margin-top:8px">Send the invitation again</button>` : ""}
    <button class="btn ghost" type="button" id="sheetCancel" style="width:100%;margin-top:8px">Close</button>`);
  $("#sheetCancel").onclick = closeSheet;
  const read = () => ({name: $("#emName").value.trim(), email: invited ? $("#emEmail").value.trim() : (m.email || "")});
  const save = async () => {
    const v = read(), patch = {p_biz: bid(), p_member: m.id};
    if (!v.name) { $("#emErr").textContent = "Give them a name."; return null; }
    if (invited && !v.email) { $("#emErr").textContent = "Type their email address."; return null; }
    if (v.name !== m.name) patch.p_name = v.name;
    if (invited && v.email.toLowerCase() !== (m.email || "").toLowerCase()) patch.p_email = v.email;
    if (Object.keys(patch).length > 2){
      try { await must(S.sb.rpc("update_member", patch)); await Promise.all([loadMembers(), refresh(true)]); }
      catch(err){ $("#emErr").textContent = (err && err.message) || "That didn't work."; return null; }
    }
    return Object.keys(patch).length > 2;
  };
  $("#emSave").onclick = e => once(e.target, async () => {
    const changed = await save(); if (changed === null) return;
    closeSheet(); toast(changed ? "Saved." : "Nothing has changed."); render();
  });
  const rs = $("#emResend");
  if (rs) rs.onclick = e => once(e.target, async () => {
    const changed = await save(); if (changed === null) return;
    const now = (S.members || []).find(x => x.id === m.id) || m;
    if (now.status !== "invited"){ closeSheet(); toast(now.name + " already has a login, so they were added straight away."); render(); return; }
    const v = read(); inviteDoneSheet(v.email, v.name, now.role, true);
  });
}
function editBizSheet(){
  openSheet(`<div class="grab"></div><h2>Edit business</h2>
    <div class="field"><label for="ebName">Business name</label><input id="ebName" class="text" maxlength="60" value="${esc(S.biz.name)}"></div>
    <div class="field"><label for="ebKind">What do you sell?</label><input id="ebKind" class="text" maxlength="40" value="${esc(S.biz.kind || "")}"></div>
    <div class="field"><label for="ebCur">Currency symbol</label><input id="ebCur" class="text" maxlength="4" list="curList" value="${esc(cur())}" autocomplete="off">${CUR_LIST}
      <span class="muted" style="font-size:13px">Shown next to every amount, like R, $ or €.</span></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn" type="button" id="ebSave">Save</button></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#ebSave").onclick = e => once(e.target, async () => {
    const name = $("#ebName").value.trim(); if (!name) return toast("The business needs a name.");
    const patch = {p_name: name, p_kind: $("#ebKind").value.trim()}, c = $("#ebCur").value.trim();
    if (c && c !== cur()) patch.p_currency = c;
    try { await setBusiness(patch); closeSheet(); toast("Saved."); render(); } catch(err){ failed(err); }
  });
}
function confirmSheet(title, text, label, run, danger = true){
  openSheet(`<div class="grab"></div><h2>${esc(title)}</h2><p>${text}</p>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn ${danger ? "danger" : ""}" type="button" id="cfGo">${esc(label)}</button></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#cfGo").onclick = e => once(e.target, async () => { try { await run(); } catch(err){ failed(err); } });
}
function deleteBizSheet(){
  openSheet(`<div class="grab"></div><h2>Delete ${esc(S.biz.name)}?</h2>
    <p>This removes every sale, order, product, message and person in this business, for good. It can't be undone. Type the business name to confirm.</p>
    <div class="field"><input id="dbName" class="text" autocomplete="off" placeholder="${esc(S.biz.name)}" aria-label="Type the business name"></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn danger" type="button" id="dbGo">Delete for good</button></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#dbGo").onclick = e => once(e.target, async () => {
    try {
      await must(S.sb.rpc("delete_business", {p_biz: bid(), p_confirm: $("#dbName").value}));
      closeSheet(); S.biz = null; await loadBusinesses();
      toast("Business deleted.");
      if (S.businesses.length) await openBusiness(S.businesses[0].id); else showOnboarding();
    } catch(err){ failed(err); }
  });
}
async function afterLeaving(msg){
  closeSheet(); S.biz = null; await loadBusinesses(); toast(msg);
  if (S.businesses.length) await openBusiness(S.businesses[0].id); else showOnboarding();
}

// ---------- events ----------
function bindView(){
  const v = $("#view");
  v.querySelectorAll("[data-add]").forEach(b => b.onclick = () => { const id = b.dataset.add; S.cart[id] = (S.cart[id]||0) + 1; render(); });
  v.querySelectorAll("[data-sub]").forEach(b => b.onclick = () => { const id = b.dataset.sub; S.cart[id] = Math.max(0,(S.cart[id]||0) - 1); if (!S.cart[id]) delete S.cart[id]; render(); });
  v.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => productSheet(b.dataset.edit));
  v.querySelectorAll("[data-newprod]").forEach(b => b.onclick = newProductSheet);
  v.querySelectorAll("[data-gostock]").forEach(b => b.onclick = () => goTab("stock"));
  v.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { S.confirmDel = Number(b.dataset.del); render(); });
  v.querySelectorAll("[data-nodel]").forEach(b => b.onclick = () => { S.confirmDel = null; render(); });
  v.querySelectorAll("[data-dodel]").forEach(b => b.onclick = () => once(b, async () => {
    try { await must(S.sb.rpc("delete_sale", {p_id: Number(b.dataset.dodel)})); S.confirmDel = null; toast("Sale deleted. Stock is back."); await refresh(); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-period]").forEach(b => b.onclick = async () => { S.period = b.dataset.period; render(); await refresh(); });
  v.querySelectorAll("[data-copyreport]").forEach(b => b.onclick = () => copyText(reportText(), "Copied. Paste it in your group."));
  v.querySelectorAll("[data-settle]").forEach(b => b.onclick = settleSheet);
  v.querySelectorAll("[data-neworder]").forEach(b => b.onclick = newOrderSheet);
  v.querySelectorAll("[data-fillorder]").forEach(b => b.onclick = () => fillFromOrder(Number(b.dataset.fillorder)));
  v.querySelectorAll("[data-cancelorder]").forEach(b => b.onclick = () => once(b, async () => {
    try { await must(S.sb.rpc("cancel_order", {p_id: Number(b.dataset.cancelorder)})); toast("Order cancelled."); await refresh(); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-claim],[data-release]").forEach(b => b.onclick = () => once(b, async () => {
    const take = b.dataset.claim != null, id = Number(take ? b.dataset.claim : b.dataset.release);
    try { await must(S.sb.rpc("claim_order", {p_id: id, p_take: take})); toast(take ? "You're on it. The others have been told." : "Order released."); await refresh(); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-sfilter]").forEach(b => b.onclick = () => { S.salesFilter = b.dataset.sfilter; render(); });
  v.querySelectorAll("[data-speriod]").forEach(b => b.onclick = () => { S.speriod = b.dataset.speriod; render(); });
  v.querySelectorAll("[data-smethod]").forEach(b => b.onclick = () => { S.smethod = b.dataset.smethod; render(); });
  v.querySelectorAll("[data-sstatus]").forEach(b => b.onclick = () => { S.sstatus = b.dataset.sstatus; render(); });
  v.querySelectorAll("[data-sclear]").forEach(b => b.onclick = () => { S.sq = ""; S.speriod = "all"; S.smethod = "all"; S.sstatus = "all"; render(); });
  const sq = $("#salesSearch"); if (sq) sq.oninput = () => { S.sq = sq.value; render(); };
  v.querySelectorAll("[data-pay]").forEach(b => b.onclick = () => paySheet(Number(b.dataset.pay)));
  v.querySelectorAll("[data-due]").forEach(b => b.onclick = () => dueSheet(Number(b.dataset.due)));
  v.querySelectorAll("[data-remind]").forEach(b => b.onclick = () => { const d = S.debts.find(x => x.sale_id === Number(b.dataset.remind)); if (d) copyText(reminderText(d), "Copied. Paste it in a message to them."); });
  v.querySelectorAll("[data-ping]").forEach(b => b.onclick = () => once(b, async () => {
    try { await must(S.sb.rpc("ping_partner", {p_to: b.dataset.ping})); toast("Sent. They've been asked to call you."); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-savephone]").forEach(b => b.onclick = () => once(b, async () => {
    try { await must(S.sb.rpc("set_my_phone", {p_phone: $("#myPhone").value})); toast("Number saved."); await refresh(); } catch(err){ failed(err); }
  }));
  const ss = $("#sellSearch");
  if (ss){
    const filter = () => {
      const q = ss.value.trim().toLowerCase(); S.sellQuery = ss.value;
      v.querySelectorAll("[data-pname]").forEach(t => { t.hidden = !!q && !t.dataset.pname.includes(q); });
      v.querySelectorAll("#view section").forEach(sec => { const tiles = sec.querySelectorAll("[data-pname]"); if (tiles.length) sec.hidden = [...tiles].every(t => t.hidden); });
    };
    ss.value = S.sellQuery || ""; ss.oninput = filter; filter();
  }
  const cf = $("#chatForm");
  if (cf) cf.onsubmit = e => {
    e.preventDefault();
    const inp = $("#chatInput"), body = inp.value.trim(); if (!body) return;
    once(cf.querySelector("button"), async () => {
      try { await must(S.sb.rpc("send_message", {p_biz: bid(), p_body: body})); inp.value = ""; await refresh(); const box = $("#chatBox"); if (box) box.scrollTop = box.scrollHeight; }
      catch(err){ failed(err); }
    });
  };

  // settings
  v.querySelectorAll("[data-editbiz]").forEach(b => b.onclick = editBizSheet);
  v.querySelectorAll("[data-privacy]").forEach(b => b.onclick = () => once(b, async () => {
    try { await setBusiness({p_privacy: b.dataset.privacy}); toast("Saved."); await refresh(true); render(); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-teamsettle]").forEach(b => b.onclick = () => once(b, async () => {
    try { await setBusiness({p_team_settle: b.dataset.teamsettle === "true"}); toast("Saved."); await refresh(true); render(); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-syncnow]").forEach(b => b.onclick = () => once(b, async () => { if (!navigator.onLine) return toast("Still no signal."); const n = await flushQueue(); await refresh(); if (!n) toast("Nothing was sent yet."); }));
  v.querySelectorAll("[data-discardq]").forEach(b => b.onclick = () => { queue.save(queue.all().filter(q => q.ref !== b.dataset.discardq)); render(); });
  v.querySelectorAll("[data-gosell]").forEach(b => b.onclick = () => goTab("sell"));
  v.querySelectorAll("[data-export]").forEach(b => b.onclick = () => once(b, async () => { try { await exportData(b.dataset.export); } catch(err){ failed(err); } }));
  v.querySelectorAll("[data-invite]").forEach(b => b.onclick = inviteSheet);
  v.querySelectorAll("[data-setrole]").forEach(sel => sel.onchange = async () => {
    try { await must(S.sb.rpc("update_member", {p_biz: bid(), p_member: sel.dataset.setrole, p_role: sel.value})); toast("Role changed."); await Promise.all([loadMembers(), refresh(true)]); render(); }
    catch(err){ failed(err); await loadMembers().catch(() => {}); render(); }
  });
  v.querySelectorAll("[data-emember]").forEach(b => b.onclick = () => { const m = (S.members || []).find(x => x.id === b.dataset.emember); if (m) memberSheet(m); });
  v.querySelectorAll("[data-rmember]").forEach(b => b.onclick = () => {
    const m = (S.members || []).find(x => x.id === b.dataset.rmember); if (!m) return;
    confirmSheet(`Remove ${m.name}?`, "They lose access to this business straight away. Their past sales stay in the records.", "Remove",
      async () => { await must(S.sb.rpc("remove_member", {p_biz: bid(), p_member: m.id})); closeSheet(); toast(m.name + " was removed."); await Promise.all([loadMembers(), refresh(true)]); render(); });
  });
  v.querySelectorAll("[data-gs]").forEach(i => i.oninput = () => updateGsum(i.dataset.gs));
  groupIds().forEach(updateGsum);
  v.querySelectorAll("[data-savegroup]").forEach(b => b.onclick = () => once(b, async () => {
    const g = b.dataset.savegroup, shares = [];
    document.querySelectorAll(`[data-gs="${CSS.escape(g)}"]`).forEach(i => { const p = parseFloat(i.value) || 0; if (p > 0) shares.push({partner_id: i.dataset.gsm, share: p / 100}); });
    if (!shares.length) return toast("Choose who owns this group.");
    if (Math.abs(gsSum(g) - 100) > 0.05) return toast("The shares must add up to 100%.");
    try { await must(S.sb.rpc("set_group_shares", {p_biz: bid(), p_group: g, p_shares: shares})); toast("Ownership saved."); await refresh(true); render(); } catch(err){ failed(err); }
  }));
  v.querySelectorAll("[data-delgroup]").forEach(b => b.onclick = () => confirmSheet(`Delete the ${niceGroup(b.dataset.delgroup)} group?`, "Only possible when no products are in it.", "Delete group",
    async () => { await must(S.sb.rpc("delete_group", {p_biz: bid(), p_group: b.dataset.delgroup})); closeSheet(); toast("Group deleted."); await refresh(true); render(); }));
  v.querySelectorAll("[data-newgroup]").forEach(b => b.onclick = () => {
    openSheet(`<div class="grab"></div><h2>New product group</h2>
      <p class="muted">Use groups when different products are owned by different people, like one person's own stock and a second range shared between two partners.</p>
      <div class="field"><label for="ngName">Group name</label><input id="ngName" class="text" maxlength="30" placeholder="e.g. Beers"></div>
      <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Cancel</button><span class="spacer"></span><button class="btn" type="button" id="ngSave">Create group</button></div>`);
    $("#sheetCancel").onclick = closeSheet;
    $("#ngSave").onclick = e => once(e.target, async () => {
      const name = $("#ngName").value.trim(); if (!name) return toast("Give the group a name.");
      let id = slug(name); if (groupIds().includes(id)) id += "-" + Date.now().toString(36).slice(-3);
      try { await must(S.sb.rpc("set_group_shares", {p_biz: bid(), p_group: id, p_shares: [{partner_id: S.me, share: 1}]})); closeSheet(); toast("Group created. Now set who owns it."); await refresh(true); render(); } catch(err){ failed(err); }
    });
  });
  v.querySelectorAll("[data-delbiz]").forEach(b => b.onclick = deleteBizSheet);
  v.querySelectorAll("[data-leave]").forEach(b => b.onclick = () => confirmSheet("Leave this business?", "You'll lose access straight away. Your past sales stay in its records.", "Leave",
    async () => { await must(S.sb.rpc("leave_business", {p_biz: bid()})); await afterLeaving("You left " + S.biz.name + "."); }));
}
async function stockMove(pid, kind, raw, rawCost){
  const qty = parseInt(raw, 10);
  if (!(qty >= (kind === "add" ? 1 : 0))) return toast(kind === "add" ? "Enter how many came in." : "Enter how many there are now.");
  if (kind === "add" && rawCost && !(parseFloat(rawCost) >= 0)) return toast("Enter what each one cost, or leave it empty.");
  try {
    const cost = kind === "add" ? parseFloat(rawCost) : NaN;
    await must(S.sb.rpc("add_stock_move", Object.assign({p_biz: bid(), p_product: pid, p_kind: kind, p_qty: qty}, cost >= 0 ? {p_cost: cost} : {})));
    S.editing = null; closeSheet(); toast(kind === "add" ? "Added " + qty + " to stock." : "Stock set to " + qty + ".");
    await refresh();
  } catch(err){ failed(err); }
}

document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => goTab(b.dataset.tab));
$("#bellBtn").onclick = notifSheet;
$("#teamBtn").onclick = () => goTab("team");
$("#bizBtn").onclick = bizSheet;
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
  openSheet(`<div class="grab"></div><h2>${esc((S.partners.find(p => p.id === S.me) || {}).name || "You")}</h2>
    <p class="muted">${esc(S.user && S.user.email)} · ${esc(ROLE_NAME[role()] || "")} at ${esc(S.biz.name)}</p>
    ${install}
    <div class="row"><button class="btn ghost" type="button" id="meBiz">Switch business</button><span class="spacer"></span><button class="btn ghost" type="button" id="meSettings">Business settings</button></div>
    <div class="row"><button class="btn ghost" type="button" id="changePass">Change password</button><span class="spacer"></span><button class="btn danger" type="button" id="signOut">Sign out</button></div>
    <div class="row"><button class="linkbtn bad" type="button" id="meDelete">Delete my account</button></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Close</button><span class="spacer"></span><span class="muted">BusyNes v${VERSION}</span></div>`);
  $("#sheetCancel").onclick = closeSheet;
  $("#meDelete").onclick = deleteAccountSheet;
  $("#meBiz").onclick = bizSheet;
  $("#meSettings").onclick = () => { closeSheet(); goTab("settings"); };
  $("#changePass").onclick = passwordSheet;
  $("#signOut").onclick = signOutFlow;
  const ib = $("#installBtn");
  if (ib) ib.onclick = async () => { const ev = installEvent; installEvent = null; closeSheet(); if (ev){ ev.prompt(); await ev.userChoice; } };
};

function signOutFlow(){
  const pending = queue.all().filter(q => !q.error).length;
  const go = async () => { closeSheet(); wipeLocal(false); await S.sb.auth.signOut(); };
  if (pending) return confirmSheet("Sign out?", `${pending} sale${pending === 1 ? "" : "s"} saved on this phone haven't been sent yet. They stay on this phone and are sent the next time you sign in with signal.`, "Sign out anyway", go, false);
  go();
}
function deleteAccountSheet(){
  const owned = S.businesses.filter(b => b.role === "owner"), one = owned.length === 1;
  let token = null;
  openSheet(`<div class="grab"></div><h2>Delete your account?</h2>
    <p>This deletes your login for good. You'll be removed from every business you're in, and your name, email and phone number are wiped from their records. Sales you made stay in those businesses' books, shown as "Former member".</p>
    ${owned.length ? `<div class="banner bad"><p style="margin:0 0 8px">You run ${owned.map(b => `<b>${esc(b.name)}</b>`).join(", ")}. Deleting your account <b>also deletes ${one ? "that business" : "those businesses"}</b> and everything in ${one ? "it" : "them"}, for everyone in ${one ? "it" : "them"}.</p>
      <label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="daOwned" style="margin-top:3px"> <span>I understand. Delete ${one ? "it" : "them"} too.</span></label></div>` : ""}
    <div class="field"><label for="daPass">Your password</label><input id="daPass" class="text" type="password" autocomplete="current-password"></div>
    <div id="daCaptcha" hidden></div>
    <div class="field"><label for="daWord">Type DELETE to confirm</label><input id="daWord" class="text" autocomplete="off"></div>
    <div class="err" id="daErr" role="alert" style="color:var(--bad);font-weight:600;min-height:1.4em"></div>
    <div class="row"><button class="btn ghost" type="button" id="sheetCancel">Keep my account</button><span class="spacer"></span><button class="btn danger" type="button" id="daGo">Delete my account</button></div>`);
  $("#sheetCancel").onclick = closeSheet;
  mountCaptcha("#daCaptcha", t => { token = t; });
  $("#daGo").onclick = e => once(e.target, async () => {
    const err = m => { $("#daErr").textContent = m; };
    err("");
    if ($("#daWord").value.trim().toUpperCase() !== "DELETE") return err("Type DELETE to confirm.");
    if (owned.length && !$("#daOwned").checked) return err("Tick the box to confirm you understand.");
    const password = $("#daPass").value; if (!password) return err("Type your password so we know it's you.");
    if (captchaOn() && !token) return err("Please complete the check first.");
    // Prove it's really them before anything is deleted.
    const {error} = await S.sb.auth.signInWithPassword({email: S.user.email, password, options: captchaOn() ? {captchaToken: token} : undefined});
    if (error){ resetCaptcha("#daCaptcha", t => { token = t; }); return err(/invalid/i.test(error.message) ? "That password isn't right." : error.message); }
    try { await must(S.sb.rpc("delete_account", {p_delete_owned: owned.length > 0})); }
    catch(e2){ return err((e2 && e2.message) || "That didn't work. Try again."); }
    try { await S.sb.auth.signOut({scope: "local"}); } catch(e3){}
    wipeLocal(true); S.biz = null; S.businesses = []; S.user = null; S.loaded = false;
    closeSheet(); show("authScreen"); toast("Your account was deleted.");
  });
}

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
  if (!S.user){ S.loaded = false; S.biz = null; S.businesses = []; show("authScreen"); ensureAuthCaptcha(); return; }
  try { await loadBusinesses(); }
  catch(e){
    // No signal. If this phone has the business saved, open it so sales can still be recorded.
    if (isNetworkError(e) && startOffline(S.user)){ toast("You're offline. You can still record sales."); return; }
    // Otherwise don't claim anything about their account; retry when the connection is back.
    show("appScreen"); S.loaded = false; if (S.biz) render(); else $("#view").innerHTML = `<div class="empty"><b>Can't reach BusyNes</b>Check your connection.</div>`;
    toast("Can't reach BusyNes. Check your connection.", {label:"Try again", run:() => enter(session)});
    window.addEventListener("online", () => enter(session), {once:true});
    return;
  }
  if (!S.businesses.length){ showOnboarding(); return; }
  const params = new URLSearchParams(location.search), want = params.get("biz") || store.get("busynes.biz");
  await openBusiness((S.businesses.find(b => b.id === want) || S.businesses[0]).id, true);
  if (pushSupported() && Notification.permission === "granted") savePushSubscription(false).catch(() => {});
}
function authErr(msg){ $("#authErr").textContent = msg || ""; }
$("#authShow").onclick = () => { const i = $("#authPass"), show = i.type === "password"; i.type = show ? "text" : "password"; $("#authShow").textContent = show ? "Hide" : "Show"; $("#authShow").setAttribute("aria-pressed", String(show)); };

// ---------- sign-up check (optional: switched on by TURNSTILE_SITE_KEY in config.js) ----------
const captcha = {key: "", widgets: {}};
const captchaOn = () => !!captcha.key;
let authToken = null, authCaptchaMounted = false;
function loadTurnstile(){
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const el = document.createElement("script");
    el.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; el.async = true;
    el.onload = () => resolve(window.turnstile); el.onerror = () => reject(new Error("The check couldn't load."));
    document.head.appendChild(el);
  });
}
async function mountCaptcha(sel, onToken){
  if (!captchaOn()) return;
  try {
    const t = await loadTurnstile(), el = $(sel); if (!el) return;
    el.hidden = false;
    captcha.widgets[sel] = t.render(el, {sitekey: captcha.key, callback: onToken, "expired-callback": () => onToken(null), "error-callback": () => onToken(null)});
  } catch(e){ /* the buttons below say what to do */ }
}
function resetCaptcha(sel, onToken){
  if (!captchaOn() || !window.turnstile || captcha.widgets[sel] == null) return;
  onToken(null); try { window.turnstile.reset(captcha.widgets[sel]); } catch(e){}
}
const ensureAuthCaptcha = () => { if (captchaOn() && !authCaptchaMounted){ authCaptchaMounted = true; mountCaptcha("#captchaBox", t => { authToken = t; }); } };
const authOpts = extra => Object.assign({}, extra, captchaOn() ? {captchaToken: authToken} : {});
const needCheck = () => captchaOn() && !authToken;
let authMode = "in";
function setAuthMode(m, keepMsg){
  authMode = m; const up = m === "up";
  $("#modeIn").setAttribute("aria-selected", String(!up)); $("#modeUp").setAttribute("aria-selected", String(up));
  $("#authHead").textContent = up ? "Create your account" : "Welcome back";
  $("#authSub").textContent = up ? "Free to try. You can start your own business or join one you were invited to." : "Log in to your business.";
  $("#authPass").autocomplete = up ? "new-password" : "current-password";
  $("#authHint").hidden = !up; $("#signInBtn").hidden = up; $("#signUpBtn").hidden = !up; $("#forgotBtn").hidden = up;
  $("#authSwap").innerHTML = up ? 'Already have an account? <button class="linkbtn" type="button" id="swapBtn">Log in</button>' : 'New to BusyNes? <button class="linkbtn" type="button" id="swapBtn">Create an account</button>';
  $("#swapBtn").onclick = () => setAuthMode(up ? "in" : "up");
  if (!keepMsg) authErr("");
}
$("#modeIn").onclick = () => setAuthMode("in"); $("#modeUp").onclick = () => setAuthMode("up");
setAuthMode("in");
async function doSignIn(){
  authErr("");
  if (needCheck()) return authErr("Please complete the check below first.");
  const {error} = await S.sb.auth.signInWithPassword({email:$("#authEmail").value.trim(), password:$("#authPass").value, options: captchaOn() ? {captchaToken: authToken} : undefined});
  resetCaptcha("#captchaBox", t => { authToken = t; });
  if (error) authErr(/invalid/i.test(error.message) ? "That email and password don't match. New here? Tap Create an account." : error.message);
}
async function doSignUp(){
  authErr("");
  const email = $("#authEmail").value.trim(), password = $("#authPass").value;
  if (!email || password.length < 6) return authErr("Type your email and a password of at least 6 characters.");
  // Send the confirmation link back to wherever this copy of the app is running.
  if (needCheck()) return authErr("Please complete the check below first.");
  const {data, error} = await S.sb.auth.signUp({email, password, options: authOpts({emailRedirectTo: location.origin + location.pathname})});
  resetCaptcha("#captchaBox", t => { authToken = t; });
  if (error) return authErr(error.message);
  if (!data.session){ setAuthMode("in", true); authErr("Almost there! We emailed you a confirmation link. Open it, then come back and log in."); }
}
$("#authForm").onsubmit = e => {
  e.preventDefault();
  if (authMode === "up") once($("#signUpBtn"), doSignUp); else once($("#signInBtn"), doSignIn);
};
$("#forgotBtn").onclick = () => once($("#forgotBtn"), async () => {
  authErr("");
  const email = $("#authEmail").value.trim();
  if (!email) return authErr("Type your email above first, then tap Forgot my password.");
  if (needCheck()) return authErr("Please complete the check below first.");
  const {error} = await S.sb.auth.resetPasswordForEmail(email, authOpts({redirectTo: location.origin + location.pathname}));
  resetCaptcha("#captchaBox", t => { authToken = t; });
  authErr(error ? error.message : "If that email has a BusyNes login, a reset link is on its way. Check your inbox.");
});
$("#onboardForm").onsubmit = e => {
  e.preventDefault();
  once($("#obBtn"), async () => {
    $("#obErr").textContent = "";
    const name = $("#obBiz").value.trim(); if (!name) { $("#obErr").textContent = "Give your business a name."; return; }
    try { await createBusiness(name, $("#obKind").value.trim(), $("#obName").value.trim(), $("#obCur").value.trim()); }
    catch(err){ $("#obErr").textContent = (err && err.message) || "That didn't work. Try again."; }
  });
};
$("#obCheck").onclick = () => once($("#obCheck"), async () => {
  try { await loadBusinesses(); } catch(e){ return failed(e); }
  if (S.businesses.length) await openBusiness(S.businesses[0].id); else toast("Nothing yet. Ask the owner to invite " + ((S.user && S.user.email) || "your email") + ".");
});
$("#obSignOut").onclick = () => signOutFlow();

// ---------- start ----------
(function start(){
  const cfg = window.BUSYNES_CONFIG || {};
  if (!cfg.SUPABASE_URL || /YOUR-PROJECT/.test(cfg.SUPABASE_URL) || !cfg.SUPABASE_ANON_KEY || /YOUR-ANON-KEY/.test(cfg.SUPABASE_ANON_KEY)){
    show("setupScreen"); return;
  }
  S.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {db:{schema:"busynes"}});
  captcha.key = cfg.TURNSTILE_SITE_KEY || "";
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
  setInterval(() => { if (S.biz && document.visibilityState === "visible" && !$("#overlay").innerHTML && !S.editing) refresh(true); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (S.biz && document.visibilityState === "visible") refresh(true); });
  window.addEventListener("online", () => { if (S.biz) refresh(true); });
  window.addEventListener("offline", () => { if (S.biz) render(); });
  if (!navigator.onLine){   // opened with no signal: don't wait for the sign-in service
    setTimeout(() => {
      if (S.user || S.biz) return;
      try {
        const stored = JSON.parse(localStorage.getItem("sb-" + new URL(cfg.SUPABASE_URL).hostname.split(".")[0] + "-auth-token") || "null");
        if (stored && stored.user && startOffline(stored.user)) toast("You're offline. You can still record sales.");
      } catch(e){}
    }, 1500);
  }
  const wanted = new URLSearchParams(location.search).get("tab");
  if (wanted && TABS.includes(wanted)) S.tab = wanted;
  if ("serviceWorker" in navigator && location.protocol !== "file:"){
    navigator.serviceWorker.register("sw.js").catch(() => {});
    // Tapping a phone notification asks the open app to jump to the right business and tab.
    navigator.serviceWorker.addEventListener("message", async e => {
      const d = e.data || {}; if (d.type !== "open-tab" || !S.user) return;
      if (d.biz && (!S.biz || S.biz.id !== d.biz) && S.businesses.some(b => b.id === d.biz)){ S.tab = d.tab || S.tab; await openBusiness(d.biz); }
      if (S.biz) goTab(d.tab);
    });
  }
})();
})();

import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";

import { fileURLToPath } from "url";
const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MIME = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".png":"image/png", ".svg":"image/svg+xml", ".webmanifest":"application/manifest+json" };

// A stand-in for Supabase so the real app can be driven in a real browser.
const STUB = `
window.__calls = [];
const iso = d => d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
const plus = n => { const d = new Date(); d.setDate(d.getDate()+n); return iso(d); };
const now = new Date().toISOString();
const P = new URLSearchParams(location.search);
window.__failed = []; window.__auth = []; window.__ts = [];
window.__down = P.get("netdown") === "1";
const down = () => window.__down || !navigator.onLine;
const netErr = () => ({data:null, error:{message:"TypeError: Failed to fetch"}});
window.turnstile = {
  render(el, o){ window.__ts.push(o); const n = window.__ts.length; if (P.get("notoken") !== "1") setTimeout(() => o.callback("tok-" + n), 0); return "w" + n; },
  reset(id){ const o = window.__ts[Number(id.slice(1)) - 1]; if (o && P.get("notoken") !== "1") setTimeout(() => o.callback("tok-r" + id), 0); }
};
const ME = P.get("me") || "vusi";
const ROLE = P.get("role") || ({sibabalo:"owner", vusi:"partner", dokotela:"partner"}[ME]);
const B1 = {id:"b1", name:"BusyNes", kind:"Drinks", role:ROLE, member_id:ME, privacy:"private", owner_name:"Sibabalo", team_settle:true, currency:P.get("cur") || "R"};
const B2 = {id:"b2", name:"Fat Cook", kind:"Fast food", role:"owner", member_id:"m_fc", privacy:"shared", owner_name:"Thabo", team_settle:false, currency:"$"};
let BIZ = P.get("none") === "1" ? [] : P.get("nob2") === "1" ? [B1] : [B1, B2];

const byBiz = (a, b) => biz => biz === "b1" ? a : b;
const D = {
  partners: byBiz(
    [{id:"sibabalo",name:"Sibabalo",phone:"0821112222",role:"owner",status:"active"},{id:"vusi",name:"Vusi",phone:null,role:"partner",status:"active"},{id:"dokotela",name:"Dokotela",phone:"0833334444",role:"partner",status:"active"}],
    [{id:"m_fc",name:"Thabo",phone:null,role:"owner",status:"active"},{id:"m_n",name:"Nomsa",phone:null,role:"partner",status:"invited"}]),
  products: byBiz(
    [{id:"nini-mimosa",name:"Nini Mimosa",price:35,owner:"sibabalo",sort:7,hidden:false,track_stock:true},{id:"heineken",name:"Heineken",price:40,owner:"beers",sort:1,hidden:false,track_stock:true,case_size:(P.get("cases") === "1" ? 12 : null),pack_name:(P.get("pn") || (P.get("cases") === "1" ? "case" : null))},{id:"chips",name:"Chips",price:20,owner:"beers",sort:2,hidden:false,track_stock:false}].concat(P.get("many") === "1" ? [1,2,3,4,5,6,7].map(i => ({id:"x" + i, name:"Extra item " + i, price:10 + i, owner:"sibabalo", sort:20 + i, hidden:false, track_stock:false})) : []),
    []),
  stock_moves: [], settlements: [],
  order_fees: [{order_id:2, fee:40}],
  orders: byBiz(
    [{id:2,at:now,customer:"Themba",items:[{product_id:"heineken",name:"Heineken",qty:1}],note:"",status:"open",created_by:"vusi",loan:true,claimed_by:null},
     {id:1,at:now,customer:"Lindiwe",items:[{product_id:"heineken",name:"Heineken",qty:3}],note:"5pm",status:"open",created_by:"sibabalo"}], []),
  notifications: byBiz(
    [{id:9,business_id:"b1",partner_id:"vusi",at:now,kind:"order",title:"New order from Lindiwe",body:"3 × Heineken",ref:"1",read_at:null},
     {id:8,business_id:"b1",partner_id:"vusi",at:now,kind:"reminder",title:"Thando owes R20",body:"Overdue by 2 days",ref:"5",read_at:null}], []),
  messages: byBiz([{id:2,at:now,from_partner:"sibabalo",body:"Who has change?"}], []),
};
const UNREAD = [{business_id:"b1"},{business_id:"b1"},{business_id:"b2"}];
const T = [
  {id:6,at:now,paid_to:"sibabalo",recorded_by:"sibabalo",method:"transfer",note:"Block C",due_on:null,whole:false,total:null,paid:null,loan_fee:null,
   items:[{name:"Black Label",qty:3,owner:"beers",price:null},{name:"Gordon's Gin",qty:1,owner:"sibabalo",price:null}]},
  {id:5,at:now,paid_to:"vusi",recorded_by:"vusi",method:"cash",note:"Thando",due_on:plus(-2),whole:true,total:70,paid:50,loan_fee:0,
   items:[{name:"Nini Mimosa",qty:2,owner:"sibabalo",price:35}]},
];
const G1 = [{owner:"beers",partner_id:"dokotela",share:0.5},{owner:"beers",partner_id:"vusi",share:0.5},{owner:"sibabalo",partner_id:"sibabalo",share:1}];
const G2 = [{owner:"everyone",partner_id:"m_fc",share:1}];
const M1 = [{id:"sibabalo",name:"Sibabalo",email:"sib@x.com",phone:null,role:"owner",status:"active"},{id:"vusi",name:"Vusi",email:"vusi@x.com",phone:null,role:"partner",status:"active"},{id:"dokotela",name:"Dokotela",email:"dok@x.com",phone:null,role:"partner",status:"invited"}];
const M2 = [{id:"m_fc",name:"Thabo",email:"thabo@x.com",phone:null,role:"owner",status:"active"},{id:"m_n",name:"Nomsa",email:"nomsa@x.com",phone:null,role:"partner",status:"invited"}];
const PROFIT = P.get("profit") || "good";
const GOOD = {revenue:230,costed_revenue:120,cost:80,profit:40,missing_revenue:110,fees:10,
  products:[{product_id:"heineken",name:"Heineken",qty:3,revenue:120,cost:80,profit:40,costed:true},{product_id:"nini-mimosa",name:"Nini Mimosa",qty:2,revenue:110,cost:null,profit:null,costed:false}]};
const LOSS = {revenue:100,costed_revenue:100,cost:130,profit:-30,missing_revenue:0,fees:0,
  products:[{product_id:"heineken",name:"Heineken",qty:3,revenue:100,cost:130,profit:-30,costed:true}]};
const THIN = {revenue:100,costed_revenue:100,cost:95,profit:5,missing_revenue:0,fees:0,
  products:[{product_id:"heineken",name:"Heineken",qty:3,revenue:100,cost:95,profit:5,costed:true}]};
const NONE = {revenue:0,costed_revenue:0,cost:0,profit:0,missing_revenue:0,fees:0,products:[]};
const R = {
  claim_memberships: 0,
  export_data: a => ({business:{name:'BusyNes',kind:'Drinks',privacy:'private'}, exported_at:now, you:{name:'Vusi', role:ROLE},
    people:[{name:'Sibabalo',role:'owner',status:'active',email:null}],
    orders:[{at:now,customer:'Lindiwe',items:[{product_id:'heineken',name:'Heineken',qty:3}],note:'5pm',status:'open',loan:false,added_by:'Sibabalo',taken_by:null}],
    products: ROLE === 'delivery' ? undefined : [{name:'Heineken',price:40,cost:(ROLE === 'staff' ? null : 30),group:'beers',hidden:false,tracks_stock:true,stock_on_hand:2}],
    sales: ROLE === 'delivery' ? undefined : [
      {at:now,sold_by:'Vusi',money_to:'Vusi',method:'cash',note:'=SUM(1,1), "quoted"',items:[{name:'Nini Mimosa',qty:2,price:35,owner:'x'}],total:70,paid:50,loan_fee:0,due_on:'2026-12-01'},
      {at:now,sold_by:'Sibabalo',money_to:'Sibabalo',method:'transfer',note:'Block C',items:[{name:'Black Label',qty:3,price:null,owner:'beers'}],total:null,paid:null,loan_fee:null,due_on:null}]}),
  product_costs: a => (a.p_biz !== "b1" || PROFIT === "none") ? [] : [{product_id:"heineken", cost:30}],
  my_profit: a => a.p_biz !== "b1" ? NONE : ({good:GOOD, loss:LOSS, thin:THIN, none:NONE}[PROFIT]),
  my_businesses: () => BIZ,
  my_groups: a => a.p_biz !== "b1" ? G2 : G1,
  list_members: a => a.p_biz !== "b1" ? M2 : M1,
  sales_timeline: a => a.p_biz !== "b1" ? [] : T,
  stock_levels: a => a.p_biz !== "b1" ? [] : [{product_id:"nini-mimosa",qty:10},{product_id:"heineken",qty:2},{product_id:"chips",qty:null}],
  my_money: a => ({received:50,received_cash:50,orders:1,me:ME,due:0,sold_value:0,outstanding:0,sold:[],
    pays: a.p_biz !== "b1" ? [] : [{from:"sibabalo",to:"dokotela",amount:160,from_ids:["sibabalo"],to_ids:["dokotela","vusi"],from_name:"Sibabalo",to_name:"Dokotela & Vusi"}]}),
  my_debts: a => a.p_biz !== "b1" ? [] : [
    {sale_id:7,at:now,customer:"Mpho",items:"1 × First Watch",total:330,paid:0,outstanding:330,due_on:plus(3),paid_to:"vusi",recorded_by:"vusi",loan_fee:50},
    {sale_id:5,at:now,customer:"Thando",items:"2 × Nini Mimosa",total:70,paid:50,outstanding:20,due_on:plus(-2),paid_to:"vusi",recorded_by:"vusi",loan_fee:0}],
  create_business: a => { BIZ.push({id:"b3", name:a.p_name, kind:a.p_kind, role:"owner", member_id:"m_new", privacy:"shared", owner_name:a.p_my_name, team_settle:false, currency:a.p_currency || "R"}); return "b3"; },
  record_sale: a => a.p_note === "REJECT" ? {__error:"You can't record sales in this business"} : 7,
  delete_business: a => { BIZ = BIZ.filter(b => b.id !== a.p_biz); return null; },
  update_business: a => { const b = BIZ.find(x => x.id === a.p_biz); if (b) { if (a.p_name != null) b.name = a.p_name; if (a.p_kind != null) b.kind = a.p_kind; if (a.p_privacy != null) b.privacy = a.p_privacy; if (a.p_team_settle != null) b.team_settle = a.p_team_settle; if (a.p_currency != null) b.currency = a.p_currency; } return null; },
};
function builder(table){
  let biz = "b1", cols = "";
  const b = { select(c){ cols = c || ""; return b;}, order(){return b;}, limit(){return b;}, neq(){return b;}, is(){return b;}, eq(c, v){ if (c === "business_id") biz = v; return b;},
              then(res, rej){
                if (down()) return Promise.resolve(netErr()).then(res, rej);
                if (table === "products" && P.get("oldprods") === "1" && /case_size/.test(cols)) return Promise.resolve({data:null, error:{message:"column products.case_size does not exist"}}).then(res, rej);
                let d = D[table]; if (typeof d === "function") d = d(biz);
                if (table === "notifications" && !biz) d = UNREAD;
                return Promise.resolve({data: d || [], error: null}).then(res, rej);
              } };
  return b;
}
window.supabase = { createClient(){ return {
  auth: { onAuthStateChange(cb){ setTimeout(() => P.get("signedout") === "1" ? cb("SIGNED_OUT", null) : cb("SIGNED_IN", {user:{id:"u1",email:"vusi@example.com"}}), 0); return {data:{subscription:{}}}; },
          signOut(o){ window.__auth.push(["signOut", o]); return Promise.resolve({}); },
          signInWithPassword(a){ window.__auth.push(["signIn", a]); if (a && a.password === "wrong") return Promise.resolve({error:{message:"Invalid login credentials"}}); return Promise.resolve({data:{}, error:null}); },
          signUp(a){ window.__auth.push(["signUp", a]); return Promise.resolve({data:{session:null}, error:null}); },
          resetPasswordForEmail(e, o){ window.__auth.push(["reset", [e, o]]); return Promise.resolve({error:null}); },
          updateUser(){return Promise.resolve({error:null});} },
  from(t){
    const b = builder(t);
    // "unread across businesses" is the one notifications query with no business filter
    if (t === "notifications") { const orig = b.is; b.is = function(){ b.then = (res, rej) => Promise.resolve({data: UNREAD, error:null}).then(res, rej); return b; }; }
    return b;
  },
  rpc(name,args){
    if (down()) { window.__failed.push([name,args]); return Promise.resolve(netErr()); }
    window.__calls.push([name,args]);
    let r = name in R ? R[name] : 1; if (typeof r === "function") r = r(args || {});
    if (r && r.__error) return Promise.resolve({data:null, error:{message:r.__error}});
    return Promise.resolve({data: r, error: null});
  },
}; } };
`;

let captchaFlag = false;
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
  if (p === "/config.js" && captchaFlag) { res.setHeader("content-type", "application/javascript"); return res.end(fs.readFileSync(path.join(ROOT, "config.js"), "utf8") + '\nwindow.BUSYNES_CONFIG.TURNSTILE_SITE_KEY = "TESTKEY";'); }
  if (p === "/vendor/supabase.js") { res.setHeader("content-type", "application/javascript"); return res.end(STUB); }
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || !f.startsWith(ROOT.replace(/\//g, path.sep))) { res.statusCode = 404; return res.end("nope"); }
  res.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream");
  res.end(fs.readFileSync(f));
}).listen(8791);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok   " + m); } else { fail++; console.log("  FAIL " + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || [ "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ].find(p => fs.existsSync(p)), headless: "new", args: ["--no-sandbox"] });
const errors = [];
async function open(query, ready = "#view .grid, #view .empty, #view h2", keep = false) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  // Like a person: bring the button to the middle of the screen before tapping it, so the fixed tab bar can't be in the way.
  const tap = page.click.bind(page);
  page.click = async (sel, opts) => { await page.$eval(sel, e => e.scrollIntoView({ block: "center" })).catch(() => {}); return tap(sel, opts); };
  page.on("pageerror", e => errors.push(query + " pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(query + " console: " + m.text()); });
  page.on("dialog", d => d.dismiss());
  if (!keep) await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  await page.evaluateOnNewDocument(() => {
    window.__downloads = []; window.__blobs = {};
    const cu = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { const u = cu(b); window.__blobs[u] = b; return u; };
    HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__downloads.push({ name: this.download, href: this.href }); return; } return HTMLElement.prototype.click.call(this); };
  });
  await page.goto("http://127.0.0.1:8791/index.html" + query, { waitUntil: "networkidle0" });
  await page.waitForSelector(ready, { timeout: 8000 });
  const api = {
    page,
    text: async sel => page.$eval(sel || "#view", el => el.innerText),
    calls: async () => page.evaluate(() => window.__calls),
    last: async name => (await page.evaluate(() => window.__calls)).filter(c => c[0] === name).pop(),
    tab: async t => { await page.click(`#tab-${t}`); await sleep(80); },
    visible: async sel => page.$eval(sel, el => !el.hidden && el.offsetParent !== null).catch(() => false),
    exists: async sel => !!(await page.$(sel)),
    download: async () => { await sleep(150); return page.evaluate(async () => { const d = window.__downloads.pop(); if (!d) return null; const b = window.__blobs[d.href]; return { name: d.name, text: await b.text(), bytes: Array.from(new Uint8Array(await b.slice(0, 3).arrayBuffer())) }; }); },
    loaded: async () => { await page.waitForFunction(() => { const v = document.querySelector("#view"); return v && v.innerText && !v.innerText.includes("Loading"); }, { timeout: 5000 }); },
  };
  return api;
}

// ================================================================== 1. a partner in an existing business
console.log("1. Partner (Vusi) in BusyNes: the original screens still work");
let A = await open("");
let { page, text, calls, tab, exists } = A;
ok(await text("#bizName") === "BusyNes", "the header shows which business you're in");
ok((await text()).includes("Nini Mimosa") && (await text()).includes("Heineken"), "products shown");
ok((await text()).includes("Dokotela & Vusi's") && (await text()).includes("Sibabalo's"), "product groups are shown with their owners (two groups)");
const chipsTile = await page.$eval('[data-add="chips"]', el => el.innerText);
ok(/Chips/.test(chipsTile) && !/left|None/i.test(chipsTile), "an item that isn't stock-tracked shows no 'left' count: " + chipsTile.replace(/\n/g, " "));
ok(await page.$eval("#bellBadge", e => !e.hidden && e.textContent === "2"), "bell shows 2 unread alerts");
ok(await page.$eval("#badge-orders", e => !e.hidden && e.textContent === "2"), "Orders tab shows 2 open orders");
ok(await page.$eval("#badge-owed", e => !e.hidden && e.textContent === "1"), "Owed tab shows 1 overdue/due");
ok(await page.$eval("#bizBtn", e => e.classList.contains("dot")), "a dot on the business name shows another business has something new");

await tab("orders"); ok((await text()).includes("Lindiwe") && (await text()).includes("3 × Heineken"), "orders list shows Lindiwe's order");
ok(/Loan/.test(await text()) && /your fee R40/.test(await text()), "loan order is marked Loan and shows my own fee");
await tab("owed"); ok(/Loan · R50 fee/.test(await text()) && /R330/.test(await text()), "owed shows the loan (R330 incl. R50 fee)");
let t = await text(); ok(t.includes("Thando") && t.includes("R20") && /Overdue by 2 days/.test(t), "owed shows Thando R20 overdue by 2 days");
await tab("sales"); t = await text(); ok(/Owes R20/.test(t), "sales list flags the unpaid balance on my own sale");
{
  const rows = await page.$$eval(".sale", els => els.map(e => e.innerText));
  const other = rows.find(r => r.includes("Black Label"));
  ok(other && other.includes("3 × Black Label") && other.includes("sold by Sibabalo"), "I can see Sibabalo's sale: what, who sold it");
  ok(other && /Block C/.test(other) && /Account/.test(other) && !/R[0-9]/.test(other.replace(/R[0-9]*→/g,"")), "...with the note and where it went, but no amounts");
  ok(rows.find(r => r.includes("Thando")).includes("Delete"), "I can delete my own sale");
  ok(!other.includes("Delete"), "...but not one I wasn't part of");
  await page.click('[data-sfilter="mine"]'); await sleep(60);
  t = await text(); ok(!t.includes("Black Label") && t.includes("Thando"), "'Mine' filter hides sales I wasn't part of");
  await page.click('[data-sfilter="all"]'); await sleep(60);
}
await tab("report"); t = await text(); ok(/your share collected/i.test(t), "money screen shows");
await page.screenshot({ path: (process.env.TEMP || "/tmp") + "/ui-profit.png", fullPage: true });
ok(/Sibabalo pays you or Dokotela/.test(t) && /R160/.test(t), "settle-up is one line: Sibabalo pays you or Dokotela, R160 (team settle-up is on for BusyNes)");
ok(/settle as one/.test(t), "explains that partners who run the same stock settle as one");
ok(/Your profit/i.test(t) && /Making money/.test(t) && /R40/.test(t) && /33(\.\d+)?% of what you sell is profit/.test(t), "the Money tab shows a profit card: 'Making money', R40, 33% margin");
ok(/Loan fees earned/.test(t) && /\+R10/.test(t) && /Profit with fees/.test(t) && /R50/.test(t), "loan fees are shown on top (R10 more, R50 in total)");
ok(/R110 of what you sold has no cost set yet/.test(t) && /Set costs/.test(t), "items with no cost are flagged, not guessed: 'R110 ... no cost set yet'");
ok(/Heineken/.test(t) && /no cost/.test(t) && /By product/i.test(t), "profit is listed by product, with 'no cost' where it isn't known");
ok((await calls()).filter(c => c[0] === "my_profit").every(c => c[1].p_biz === "b1"), "profit is requested for this business only");
ok((await calls()).filter(c => c[0] === "my_money").every(c => c[1].p_biz === "b1"), "every request names the business (b1)");
await page.click("#teamBtn"); await sleep(80); t = await text();
ok(t.includes("Who has change?") && t.includes("Sibabalo") && /Owner/.test(t), "team shows chat and roles");
ok(await page.$eval('a[href="tel:0821112222"]', e => e.textContent === "Call"), "Call link for Sibabalo uses tel:");
ok(await page.$eval('a[href^="https://wa.me/27833334444"]', e => true).catch(() => false), "WhatsApp link converts 083… to 2783…");

console.log("\n1b. Stock: what things cost");
await tab("stock"); t = await text();
ok(/costs R30/.test(t) && /R10 profit each/.test(t) && /cost not set/.test(t), "the product list shows cost and profit each (Heineken costs R30, makes R10), and 'cost not set' for the rest");
await page.click('[data-edit="heineken"]'); await page.waitForSelector("#costIn");
ok(await page.$eval("#costIn", e => e.value === "30") && await exists("#addCost"), "the edit panel has the cost field (R30) and a cost field for new stock");
ok(await exists("#saveAdd") && await exists("#saveCount") && await exists("#pdSave"), "the Update sheet has a Save button for each part: new stock, count, details");
await page.$eval("#costIn", el => { el.value = ""; }); await page.type("#costIn", "27.5"); await page.click("#pdSave"); await sleep(150);
let uc = await A.last("update_product"); ok(uc && uc[1].p_id === "heineken" && uc[1].p_cost === 27.5 && Object.keys(uc[1]).length === 2, "saving details sends only what changed (here just the cost)");
await page.click('[data-edit="heineken"]').catch(() => {}); await page.waitForSelector("#addQty");
await page.type("#addQty", "12"); await page.type("#addCost", "26"); await page.click("#saveAdd"); await sleep(150);
let sm = await A.last("add_stock_move"); ok(sm && sm[1].p_qty === 12 && sm[1].p_cost === 26 && sm[1].p_kind === "add", "adding stock can carry what each one cost (R26)");
ok(!(await exists("#saveAdd")), "saving new stock closes the sheet");
await page.click('[data-edit="heineken"]'); await page.waitForSelector("#countQty"); await page.type("#countQty", "5"); await page.click("#saveCount"); await sleep(150);
sm = await A.last("add_stock_move"); ok(sm[1].p_kind === "count" && !("p_cost" in sm[1]), "a stock count never sends a cost");
await page.click('[data-edit="heineken"]'); await page.waitForSelector("#pdSave");
const upd0 = (await calls()).filter(c => c[0] === "update_product").length;
await page.click("#pdSave"); await sleep(120);
ok((await calls()).filter(c => c[0] === "update_product").length === upd0 && /Nothing has changed/.test(await text(".toast")), "saving details with no changes says so and sends nothing");
await page.click('[data-pdhidden="yes"]'); await page.click("#pdSave"); await sleep(150);
uc = await A.last("update_product"); ok(uc[1].p_hidden === true && Object.keys(uc[1]).length === 2, "hiding a product is a choice in the same sheet, saved with Save changes");
await page.click('[data-edit="heineken"]'); await page.waitForSelector("#costIn"); await page.$eval("#costIn", el => { el.value = ""; }); await page.click("#pdSave"); await sleep(100);
ok(/can be changed, but not removed/.test(await text(".toast")), "a cost can't be wiped by emptying the box (it says so)");
await page.click("#sheetCancel");
await page.click("[data-newprod]"); await page.waitForSelector("#npCost");
await page.type("#npName", "Savanna"); await page.type("#npPrice", "40"); await page.type("#npCost", "28"); await page.click('[data-npowner="beers"]'); await page.click("#npSave"); await sleep(150);
let np = await A.last("add_product"); ok(np && np[1].p_name === "Savanna" && np[1].p_cost === 28, "a new product can be added with its cost");
await page.click("[data-newprod]"); await page.waitForSelector("#npCost"); await page.type("#npName", "Water"); await page.type("#npPrice", "10"); await page.click('[data-npowner="beers"]'); await page.click("#npSave"); await sleep(150);
np = await A.last("add_product"); ok(!("p_cost" in np[1]), "...and the cost is optional");

console.log("\n2. Credit and loan checkout");
await tab("sell");
await page.click('[data-add="nini-mimosa"]'); await page.click('[data-add="nini-mimosa"]');
await page.click("#cartNext"); await page.waitForSelector("#saveSale");
ok((await text("#saveSale")).includes("Save sale · R70"), "full payment by default");
await page.click('[data-mode="part"]'); await page.type("#paidNow", "50");
ok(/R50(\.00)? now/.test(await text("#saveSale")), "part paid R50 -> button says R50 now, R20 owed");
await page.click('[data-dueadd="7"]'); await page.click("#saveSale"); await sleep(60);
ok((await text(".toast")).includes("Type the customer"), "refuses credit without a customer name");
await page.type("#saleNote", "Thando"); await page.click("#saveSale"); await sleep(150);
let sale = await A.last("record_sale");
ok(sale && sale[1].p_biz === "b1" && sale[1].p_paid === 50 && sale[1].p_note === "Thando" && /^\d{4}-\d\d-\d\d$/.test(sale[1].p_due) && sale[1].p_order === null, "record_sale sent the business, p_paid=50, name, due date");
await tab("sell");
await page.click('[data-add="nini-mimosa"]'); await page.click('[data-add="nini-mimosa"]');
await page.click("#cartNext"); await page.waitForSelector("#saveSale"); await page.click('[data-mode="loan"]');
await page.type("#feeAmt", "50");
ok((await text("#saveSale")).includes("Save loan · owes R120") && await page.$eval("#feeToBox", e => !e.hidden), "loan: owes R120 (R70 + R50 fee), 'who keeps the fee' appears");
await page.type("#saleNote", "Mpho"); await page.click('[data-dueadd="14"]'); await page.click("#saveSale"); await sleep(150);
sale = await A.last("record_sale");
ok(sale[1].p_fee === 50 && sale[1].p_fee_to === "vusi" && sale[1].p_paid === 0 && sale[1].p_note === "Mpho", "record_sale sent the loan with its fee");

console.log("\n3. Orders");
await tab("orders"); await page.click('[data-fillorder="1"]'); await sleep(100);
ok((await text("#cartTotal")) === "R120", "order loaded into cart (3 × Heineken = R120)");
await page.click("#cartNext"); await page.waitForSelector("#saveSale");
ok(await page.$eval("#saleNote", e => e.value === "Lindiwe"), "customer name prefilled from the order");
await page.click("#saveSale"); await sleep(150);
sale = await A.last("record_sale"); ok(sale[1].p_order === 1 && sale[1].p_paid === 120, "sale linked to order 1, paid in full");
await tab("owed"); await page.click('[data-pay="5"]'); await page.waitForSelector("#savePay");
ok(await page.$eval("#payAmt", e => e.value === "20"), "payment sheet prefilled with R20");
await page.click("#savePay"); await sleep(120);
let pay = await A.last("record_payment"); ok(pay && pay[1].p_sale === 5 && pay[1].p_amount === 20, "record_payment sent");
await tab("orders"); await page.click('[data-claim="1"]'); await sleep(100);
ok((await calls()).some(c => c[0] === "claim_order" && c[1].p_id === 1 && c[1].p_take === true), "'I'll take it' calls claim_order");
await tab("orders"); await page.click("[data-neworder]"); await page.waitForSelector("#ordFeeBox");
await page.type("#ordCust", "Themba"); await page.click('[data-otype="loan"]'); await page.type("#ordFee", "40"); await page.click('[data-oq="heineken"][data-d="1"]'); await page.click("#saveOrder"); await sleep(120);
let lo = await A.last("create_order"); ok(lo[1].p_biz === "b1" && lo[1].p_loan === true && lo[1].p_fee === 40, "create_order sent the business, p_loan=true, p_fee=40");
await page.click("[data-neworder]"); await page.waitForSelector("#ordAt");
await page.$eval("#ordAt", el => { const d = new Date(Date.now() - 2*864e5); const z = new Date(d.getTime() - d.getTimezoneOffset()*60000); el.value = z.toISOString().slice(0,16); el.dispatchEvent(new Event("input", {bubbles:true})); });
await page.click('[data-oq="heineken"][data-d="1"]'); await page.click("#saveOrder"); await sleep(120);
lo = await A.last("create_order"); const age = lo[1].p_at ? (Date.now() - new Date(lo[1].p_at)) / 864e5 : null;
ok(age > 1.9 && age < 2.1, "a back-dated order sends its date");
await page.click("#bellBtn"); await page.waitForSelector(".notif");
ok((await text(".sheet")).includes("New order from Lindiwe"), "alerts list opens");
await page.click('[data-notif="9"]'); await sleep(80);
ok(await page.$eval("#tab-orders", e => e.getAttribute("aria-selected") === "true") && (await calls()).some(c => c[0] === "mark_notifications_read" && c[1].p_biz === "b1"), "tapping an alert opens the right tab and marks alerts read");
await page.click("#teamBtn"); await sleep(80);
await page.type("#chatInput", "On my way"); await page.keyboard.press("Enter"); await sleep(120);
ok((await calls()).some(c => c[0] === "send_message" && c[1].p_biz === "b1" && c[1].p_body === "On my way"), "chat message sent to this business");

// ================================================================== 3b. downloads
console.log("\n3b. Download your data");
await page.click("#meBtn"); await page.waitForSelector("#meSettings"); await page.click("#meSettings"); await sleep(250);
ok(await A.exists('[data-export="sales"]') && await A.exists('[data-export="products"]') && await A.exists('[data-export="orders"]') && await A.exists('[data-export="backup"]'), "a partner is offered sales, products, orders and a full backup");
await page.click('[data-export="sales"]'); let dl = await A.download();
ok(dl && /^busynes-sales-\d{4}-\d\d-\d\d\.csv$/.test(dl.name), "the sales file is named after the business and the date: " + (dl && dl.name));
ok(dl.bytes.join() === "239,187,191", "the file starts with a byte-order mark so Excel reads accents and symbols correctly");
ok(dl.text.split("\r\n")[0] === "Sale no.,Date,Time,Sold by,Money went to,How paid,Customer or note,Item,Qty,Unit price,Line total,Sale total,Paid so far,Still owed,Loan fee,Due date", "the columns are plain and readable");
ok(dl.text.includes('"\'=SUM(1,1), ""quoted"""'), "a note that starts with '=' can't run as a spreadsheet formula (it gets an apostrophe) and commas and quotes are escaped");
const saleRows = dl.text.split("\r\n");
ok(saleRows.length === 3 && saleRows[1].includes(",Nini Mimosa,2,35,70,70,50,20,,2026-12-01"), "every item is one row, with money worked out (2 × R35 = R70, R50 paid, R20 still owed): " + saleRows[1].slice(-60));
ok(saleRows[2].includes(",Black Label,3,,,,,,,"), "money you may not see is left blank, not guessed");
await page.click('[data-export="products"]'); dl = await A.download();
ok(dl.text.split("\r\n")[0].includes("Cost") && dl.text.includes("Heineken,40,30,Beers,No,Yes,2"), "the products file includes cost and stock for a partner");
await page.click('[data-export="orders"]'); dl = await A.download();
ok(dl.text.includes("Lindiwe") && dl.text.includes("3 × Heineken"), "the orders file lists the order");
await page.click('[data-export="backup"]'); dl = await A.download();
ok(/^busynes-backup-\d{4}-\d\d-\d\d\.json$/.test(dl.name) && JSON.parse(dl.text).business.name === "BusyNes", "the backup is one JSON file");
ok((await calls()).filter(c => c[0] === "export_data").every(c => c[1].p_biz === "b1"), "every download asks for this business only");
await tab("sell").catch(() => {});

// ================================================================== 4. switching business
console.log("\n4. Switching between businesses");
await page.click("#bizBtn"); await page.waitForSelector("[data-openbiz]");
let sheet = await text(".sheet");
ok(/BusyNes/.test(sheet) && /Fat Cook/.test(sheet) && /Partner/.test(sheet) && /Owner/.test(sheet) && /1 new/.test(sheet), "the business list shows both, my role in each, and what's new elsewhere");
await page.click('[data-openbiz="b2"]'); await A.loaded();
ok(await text("#bizName") === "Fat Cook", "switched to Fat Cook");
ok((await text()).includes("No products yet") && (await text()).includes("Add what you sell"), "a new business starts empty with guidance");
ok((await calls()).filter(c => c[0] === "stock_levels").pop()[1].p_biz === "b2" && (await calls()).filter(c => c[0] === "my_money").pop()[1].p_biz === "b2", "everything is now requested for Fat Cook (b2)");
ok(!(await text()).includes("Heineken") && !(await text()).includes("Lindiwe"), "nothing from BusyNes is shown in Fat Cook");

// ================================================================== 5. settings in Fat Cook (owner, one group)
console.log("\n5. Owner: invite, ownership, privacy, delete (Fat Cook)");
await page.click("#meBtn"); await page.waitForSelector("#meSettings"); await page.click("#meSettings"); await sleep(250);
t = await text();
ok(/Business settings/.test(t) && /Thabo/.test(t) && /Nomsa/.test(t) && /invited, hasn't joined yet/.test(t) && /nomsa@x\.com/.test(t), "settings show the people, who is still invited, and emails (owner only)");
ok(/Everyone/.test(t) && await page.$eval('[data-gs="everyone"][data-gsm="m_fc"]', e => e.value === "100"), "one ownership group, Thabo at 100%");
await page.click("[data-invite]"); await page.waitForSelector("#ivEmail");
ok(await page.$eval("#ivShareBox", e => !e.hidden), "inviting a partner offers a share of the business");
await page.type("#ivEmail", "Zola@Mail.com"); await page.type("#ivName", "Zola"); await page.type("#ivShare", "35");
await page.click('[data-ivrole="staff"]'); ok(await page.$eval("#ivShareBox", e => e.hidden), "...but not for staff");
await page.click('[data-ivrole="partner"]'); await page.click("#ivSave"); await sleep(200);
let inv = await A.last("invite_member");
ok(inv[1].p_biz === "b2" && inv[1].p_email === "Zola@Mail.com" && inv[1].p_role === "partner" && inv[1].p_group === "everyone" && Math.abs(inv[1].p_share - 0.35) < 1e-9, "invite sent: partner, 35% of 'everyone': " + JSON.stringify(inv[1]));
sheet = await text(".sheet") + "\n" + await page.$eval("#ivMsg", e => e.value);
ok(/Invitation saved/.test(sheet) && /Zola@Mail\.com/.test(sheet) && /Fat Cook/.test(sheet) && /Create account/.test(sheet), "an invitation message is ready to copy, naming the business and the email to use");
ok((await page.$eval("#ivWa", a => decodeURIComponent(a.href))).includes("wa.me/?text=Hi Zola") && (await page.$eval("#ivMail", a => a.href)).startsWith("mailto:Zola%40Mail.com"), "the invitation can be sent by WhatsApp or email in one tap");
await page.click("#sheetCancel"); await sleep(60);
// fix an invited person's details and send the invitation again
await page.click('[data-emember="m_n"]'); await page.waitForSelector("#emEmail");
ok(await page.$eval("#emEmail", e => e.value === "nomsa@x.com") && await exists("#emResend"), "an invited person can be edited, with 'Send the invitation again'");
await page.$eval("#emEmail", e => { e.value = ""; }); await page.type("#emEmail", "nomsa.new@x.com"); await page.$eval("#emName", e => { e.value = ""; }); await page.type("#emName", "Nomsa Z");
await page.click("#emResend"); await sleep(250);
let um = await A.last("update_member");
ok(um[1].p_member === "m_n" && um[1].p_email === "nomsa.new@x.com" && um[1].p_name === "Nomsa Z", "saving sends the corrected name and email: " + JSON.stringify(um[1]));
ok(/Send the invitation again/.test(await text(".sheet")) && /Hi Nomsa Z/.test(await page.$eval("#ivMsg", e => e.value)) && /nomsa\.new@x\.com/.test(await page.$eval("#ivMsg", e => e.value)), "...and the message is ready to send to the new address");
await page.click("#sheetCancel"); await sleep(60);
await page.click('[data-emember="m_n"]'); await page.waitForSelector("#emSave"); await page.$eval("#emSave", b => b.click()); await sleep(300);
ok(/Nothing has changed/.test(await text(".toast")), "saving without a change says so");
// ownership: 65 / 35
await page.$eval('[data-gs="everyone"][data-gsm="m_fc"]', el => { el.value = "60"; el.dispatchEvent(new Event("input", {bubbles:true})); });
await page.$eval('[data-gs="everyone"][data-gsm="m_n"]', el => { el.value = "30"; el.dispatchEvent(new Event("input", {bubbles:true})); });
ok(/Adds up to 90%/.test(await text()), "the ownership editor shows a running total");
const before = (await calls()).filter(c => c[0] === "set_group_shares").length;
await page.click('[data-savegroup="everyone"]'); await sleep(80);
ok((await calls()).filter(c => c[0] === "set_group_shares").length === before && /add up to 100/.test(await text(".toast")), "shares that don't add up to 100% are refused before anything is sent");
await page.$eval('[data-gs="everyone"][data-gsm="m_fc"]', el => { el.value = "65"; el.dispatchEvent(new Event("input", {bubbles:true})); });
await page.$eval('[data-gs="everyone"][data-gsm="m_n"]', el => { el.value = "35"; el.dispatchEvent(new Event("input", {bubbles:true})); });
await page.click('[data-savegroup="everyone"]'); await sleep(120);
let gs = await A.last("set_group_shares");
ok(gs && gs[1].p_group === "everyone" && gs[1].p_shares.length === 2 && Math.abs(gs[1].p_shares.reduce((a, s) => a + s.share, 0) - 1) < 1e-9 && gs[1].p_shares.find(s => s.partner_id === "m_n").share === 0.35, "65/35 saved: " + JSON.stringify(gs && gs[1].p_shares));
await page.click('[data-privacy="private"]'); await sleep(120);
ok((await A.last("update_business"))[1].p_privacy === "private", "privacy mode changed");
await page.click('[data-teamsettle="true"]'); await sleep(120);
ok((await A.last("update_business"))[1].p_team_settle === true, "team settle-up switched on");
await page.click("[data-editbiz]"); await page.waitForSelector("#ebName"); await page.$eval("#ebName", el => el.value = ""); await page.type("#ebName", "Fat Cook Grill"); await page.click("#ebSave"); await sleep(150);
ok((await A.last("update_business"))[1].p_name === "Fat Cook Grill" && await text("#bizName") === "Fat Cook Grill", "the business can be renamed");
await page.screenshot({ path: (process.env.TEMP || "/tmp") + "/ui-settings.png", fullPage: true });
await page.click('[data-rmember="m_n"]'); await page.waitForSelector("#cfGo"); await page.click("#cfGo"); await sleep(150);
ok((await A.last("remove_member"))[1].p_member === "m_n", "removing a person asks first, then removes them");
await page.click("[data-delbiz]"); await page.waitForSelector("#dbName");
await page.type("#dbName", "Fat Cook Grill"); await page.click("#dbGo"); await sleep(300);
const del = await A.last("delete_business");
ok(del[1].p_biz === "b2" && del[1].p_confirm === "Fat Cook Grill", "deleting needs the typed name");
ok(await text("#bizName") === "BusyNes", "after deleting, the app moves to your other business");
await page.close();

// ================================================================== 6. brand-new person: onboarding
console.log("\n6. A brand-new person creates their own business");
const B = await open("?none=1", "#obBiz");
ok(await B.visible("#onboardScreen") && (await B.text("#onboardScreen")).includes("Let's set up your business"), "someone with no business sees the set-up screen");
ok((await B.text("#obEmail")).includes("vusi@example.com"), "...and which email to give the owner if they were invited");
ok(await B.page.$eval("#obName", e => e.value === "Vusi"), "their name is pre-filled from their email");
await B.page.click("#obCheck"); await sleep(120);
ok(await B.visible("#onboardScreen") && /Nothing yet/.test(await B.text(".toast")), "'Check for invitations' says so when there are none");
await B.page.waitForSelector(".toast", { hidden: true }); await B.page.type("#obBiz", "Spaza Plus"); await B.page.type("#obKind", "Airtime and snacks");
await B.page.click("#obBtn"); await B.page.waitForSelector("#appScreen:not([hidden])"); await B.loaded();
const cb = await B.last("create_business");
ok(cb[1].p_name === "Spaza Plus" && cb[1].p_kind === "Airtime and snacks" && cb[1].p_my_name === "Vusi", "create_business sent the names");
ok(!("p_currency" in cb[1]), "the default currency (R) isn't sent");
ok(await B.visible("#appScreen") && await B.text("#bizName") === "Spaza Plus", "they land in their new business");
ok((await B.text()).includes("No products yet") && (await B.text()).includes("Stock tab"), "...with a hint to add products first");
await B.page.close();

// ================================================================== 6b. profit: losing, thin, nothing set
console.log("\n6b. Profit in its other states");
{
  const L = await open("?profit=loss"); await L.tab("report"); const tl = await L.text();
  await L.page.screenshot({ path: (process.env.TEMP || "/tmp") + "/ui-loss.png" });
  ok(/Losing money/.test(tl) && /selling below cost/.test(tl) && /30/.test(tl), "a loss reads 'Losing money' and flags the product selling below cost");
  ok(await L.page.$eval(".profit .big", e => e.classList.contains("bad")), "...and the number is red");
  await L.page.close();
  const Th = await open("?profit=thin"); await Th.tab("report");
  ok(/Thin margin/.test(await Th.text()), "a profit of 5% reads 'Thin margin'");
  await Th.page.close();
  const N = await open("?profit=none"); await N.tab("report"); const tn = await N.text();
  ok(/See if you're making money/.test(tn) && /Add what things cost/.test(tn) && !/Making money|Losing money/.test(tn), "with no costs set it invites you to add them, and doesn't pretend");
  await N.page.click("[data-gostock]"); await sleep(120);
  ok(await N.page.$eval("#tab-stock", e => e.getAttribute("aria-selected") === "true"), "...the button takes you to the Stock tab");
  await N.page.close();
}

// ================================================================== 7. delivery person
console.log("\n7. Delivery: sees orders only");
const C = await open("?role=delivery", "#view h2"); await C.loaded();
const navShown = await C.page.$$eval("[data-tab]", els => els.filter(e => !e.hidden).map(e => e.dataset.tab));
ok(navShown.join() === "orders", "only the Orders tab is shown: " + navShown.join());
ok((await C.text()).includes("Lindiwe") && !(await C.exists("[data-neworder]")) && !(await C.exists("[data-fillorder]")) && !(await C.exists("[data-cancelorder]")), "they see orders but can't add, sell or cancel them");
ok(await C.exists('[data-claim="1"]'), "...and can take one");
const cc = (await C.calls()).map(c => c[0]);
ok(!cc.includes("sales_timeline") && !cc.includes("stock_levels") && !cc.includes("my_debts") && !cc.includes("my_money") && !cc.includes("my_profit") && !cc.includes("product_costs"), "the app doesn't even ask for sales, stock or money: " + [...new Set(cc)].join(","));
await C.page.click("#teamBtn"); await sleep(80); ok(/chat/i.test(await C.text()), "they can still chat and call");
await C.page.click("#meBtn"); await C.page.click("#meSettings"); await sleep(250);
ok(!(await C.exists('[data-export="sales"]')) && !(await C.exists('[data-export="products"]')) && await C.exists('[data-export="orders"]') && await C.exists('[data-export="backup"]'), "delivery can download orders and a backup, but not sales or products");
await C.page.click('[data-export="backup"]'); const cd = await C.download();
ok(cd && JSON.parse(cd.text).sales === undefined && JSON.parse(cd.text).products === undefined, "...and their backup has no sales or products in it");
await C.page.close();

// ================================================================== 8. staff
console.log("\n8. Staff: sells, but can't change prices or settle up");
const E = await open("?role=staff"); await E.loaded();
ok(await E.exists('[data-add="nini-mimosa"]'), "staff can sell");
await E.tab("stock");
ok(!(await E.exists("[data-newprod]")), "no 'Add product' button");
await E.page.click('[data-edit="heineken"]'); await sleep(60);
ok(await E.exists("#addQty") && !(await E.exists("#priceIn")) && !(await E.exists("[data-pdhidden]")) && !(await E.exists("#pdSave")), "stock can be updated, but there's no price, hide or details section");
await E.tab("report"); ok(!(await E.exists("[data-settle]")), "no 'Mark as settled'");
ok(!/Your profit/i.test(await E.text()) && !(await E.exists(".profit")), "staff don't see a profit card");
{
  const ec = (await E.calls()).map(c => c[0]);
  ok(!ec.includes("my_profit") && !ec.includes("product_costs"), "...and the app never even asks for profit or costs");
  await E.tab("stock"); await E.page.click('[data-edit="heineken"]'); await sleep(60);
  ok(!(await E.exists("#costIn")) && !(await E.exists("#addCost")) && !/costs R|cost not set/.test(await E.text()), "staff see no cost fields and no costs on the stock list");
}
await E.page.click("#sheetCancel").catch(() => {}); await sleep(80);
await E.page.click("#meBtn"); await E.page.waitForSelector("#meSettings"); await E.page.click("#meSettings"); await sleep(250);
t = await E.text();
await E.page.click('[data-export="products"]'); const ed2 = await E.download();
ok(ed2 && !ed2.text.split("\r\n")[0].includes("Cost") && !ed2.text.includes(",30,"), "staff's products file has no cost column");
ok(/Business settings/.test(t) && !(await E.exists("[data-invite]")) && !(await E.exists("[data-editbiz]")) && !/Who owns what/.test(t) && await E.exists("[data-leave]"), "settings are read-only: no invites, no ownership, but they can leave");
await E.page.close();

// ================================================================== 9. owner of the gents business: several groups
console.log("\n9. Owner of BusyNes: two product groups");
const F2 = await open("?me=sibabalo");
await F2.page.click("#meBtn"); await F2.page.click("#meSettings"); await sleep(250);
t = await F2.text();
ok(/Beers/.test(t) && /Sibabalo/.test(t) && (await F2.page.$$("[data-savegroup]")).length === 2 && (await F2.page.$$("[data-delgroup]")).length === 2, "both groups are editable and deletable by the owner");
await F2.page.click("[data-invite]"); await F2.page.waitForSelector("#ivEmail");
ok(await F2.page.$eval("#ivShareBox", e => e.hidden) !== false || !(await F2.exists("#ivShareBox")), "with several groups there's no quick share box; it points to the ownership section");
ok(/Who owns what/.test(await F2.text(".sheet")) || /several product groups/.test(await F2.text(".sheet")), "...and says where to set it");
await F2.page.click("#sheetCancel");
await F2.page.click("[data-newgroup]"); await F2.page.waitForSelector("#ngName"); await F2.page.type("#ngName", "Wine"); await F2.page.click("#ngSave"); await sleep(150);
const ng = await F2.last("set_group_shares");
ok(ng[1].p_group === "wine" && ng[1].p_shares[0].partner_id === "sibabalo" && ng[1].p_shares[0].share === 1, "a new group starts owned 100% by the owner");
await F2.tab("report"); ok(/You pay Dokotela & Vusi \(either one\)/.test(await F2.text()), "the owner's settle-up reads 'You pay Dokotela & Vusi (either one)'");
await F2.page.close();

// ================================================================== 10. currency
console.log("\n10. Each business shows its own currency");
{
  const K = await open("?cur=KSh&me=sibabalo"); await K.loaded();
  let tk = await K.text();
  ok(/KSh 40/.test(tk) && !/R40/.test(tk), "amounts use the business's symbol, with a space after a long one: 'KSh 40'");
  await K.page.click('[data-add="heineken"]'); await K.page.click("#cartNext"); await K.page.waitForSelector("#saveSale");
  ok((await K.text("#saveSale")).includes("KSh 40") && /\(KSh\)/.test(await K.page.$eval(".sheet", e => e.textContent)), "the checkout uses it in totals and in labels like 'Loan fee (KSh)'");
  await K.page.click("#sheetCancel");
  await K.page.click("#meBtn"); await K.page.click("#meSettings"); await sleep(250);
  await K.page.click("[data-editbiz]"); await K.page.waitForSelector("#ebCur");
  ok(await K.page.$eval("#ebCur", e => e.value === "KSh"), "the owner can see and edit the currency in Edit business");
  await K.page.$eval("#ebCur", e => { e.value = ""; }); await K.page.type("#ebCur", "$"); await K.page.click("#ebSave"); await sleep(250);
  const ub = await K.last("update_business"); ok(ub && ub[1].p_currency === "$", "saving sends the new symbol");
  await K.tab("sell").catch(() => {}); await K.page.click("#tab-sell"); await sleep(120);
  ok(/\$40/.test(await K.text()) && !/KSh/.test(await K.text()), "everything switches to $ straight away");
  await K.page.click("#bizBtn"); await K.page.waitForSelector("[data-openbiz]"); await K.page.click('[data-openbiz="b2"]'); await K.loaded();
  await K.tab("report"); ok(/\$50/.test(await K.text()), "a different business has its own symbol ($ in Fat Cook)");
  await K.page.close();
  const N2 = await open("?none=1", "#obBiz");
  await N2.page.$eval("#obCur", e => { e.value = ""; }); await N2.page.type("#obCur", "$"); await N2.page.type("#obBiz", "Dollar Shop"); await N2.page.click("#obBtn"); await N2.page.waitForSelector("#appScreen:not([hidden])");
  ok((await N2.last("create_business"))[1].p_currency === "$", "a new business can be created with its own symbol");
  await N2.page.close();
}

// ================================================================== 11. deleting your account
console.log("\n11. Delete your account");
{
  const D1 = await open(""); await D1.loaded();
  await D1.page.click("#meBtn"); await D1.page.waitForSelector("#meDelete"); await D1.page.click("#meDelete"); await D1.page.waitForSelector("#daGo");
  let sh = await D1.text(".sheet");
  ok(/You run Fat Cook/.test(sh) && /also deletes that business/.test(sh) && await D1.exists("#daOwned"), "someone who runs a business is told it will be deleted too, and has to tick a box");
  ok(/Former member/.test(sh), "the sheet says what happens to the sales they made");
  await D1.page.click("#daGo"); await sleep(80);
  ok(/Type DELETE/.test(await D1.text("#daErr")), "nothing happens until DELETE is typed");
  await D1.page.type("#daWord", "delete"); await D1.page.click("#daGo"); await sleep(80);
  ok(/Tick the box/.test(await D1.text("#daErr")), "...nor until the business box is ticked");
  await D1.page.click("#daOwned"); await D1.page.click("#daGo"); await sleep(80);
  ok(/password/.test(await D1.text("#daErr")), "...nor without the password");
  await D1.page.type("#daPass", "wrong"); await D1.page.click("#daGo"); await sleep(150);
  ok(/isn't right/.test(await D1.text("#daErr")) && !(await D1.calls()).some(c => c[0] === "delete_account"), "a wrong password stops it, and nothing is deleted");
  await D1.page.$eval("#daPass", e => { e.value = ""; }); await D1.page.type("#daPass", "correct horse"); await D1.page.click("#daGo"); await sleep(400);
  const da = await D1.last("delete_account");
  ok(da && da[1].p_delete_owned === true, "with everything confirmed it deletes, including the business they run");
  ok((await D1.page.evaluate(() => window.__auth)).filter(a => a[0] === "signOut").some(a => a[1] && a[1].scope === "local"), "...and signs the phone out");
  ok(await D1.visible("#authScreen") && /account was deleted/.test(await D1.text(".toast")), "they land on the sign-in screen with a confirmation");
  ok((await D1.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("busynes.")).length)) === 0, "everything BusyNes saved on the phone is wiped");
  await D1.page.close();
  const D2 = await open("?nob2=1"); await D2.loaded();
  await D2.page.click("#meBtn"); await D2.page.click("#meDelete"); await D2.page.waitForSelector("#daGo");
  ok(!(await D2.exists("#daOwned")), "someone who runs nothing sees no business warning");
  await D2.page.type("#daWord", "DELETE"); await D2.page.type("#daPass", "pw"); await D2.page.click("#daGo"); await sleep(300);
  ok((await D2.last("delete_account"))[1].p_delete_owned === false, "...and nothing else is deleted");
  await D2.page.close();
}

// ================================================================== 12. selling without signal
console.log("\n12. Sales without signal");
{
  const O = await open(""); await O.loaded();
  const tileText = async (o, id) => o.page.$eval(`[data-add="${id}"]`, e => e.innerText);
  ok(/2 left/.test(await tileText(O, "heineken")), "(Heineken: 2 left)");
  await O.page.evaluate(() => { window.__down = true; });                 // the signal drops while the app is open
  await O.page.click('[data-add="heineken"]'); await O.page.click("#cartNext"); await O.page.waitForSelector("#saveSale");
  await O.page.click("#saveSale"); await sleep(300);
  ok(/Saved on this phone/.test(await O.text(".toast")), "with no signal the sale is kept on the phone, with a clear message");
  ok(await O.exists("#queueNote") && /1 sale saved on this phone/.test(await O.text("#queueNote")), "a banner shows what is waiting to be sent");
  ok(!(await O.calls()).some(c => c[0] === "record_sale"), "nothing reached the server yet");
  ok(/1 left/.test(await tileText(O, "heineken")), "stock on the tile already counts it (1 left), so it isn't sold twice");
  await O.page.evaluate(() => { window.__down = false; window.dispatchEvent(new Event("online")); }); await sleep(700);
  const rs = await O.last("record_sale");
  ok(rs && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(rs[1].p_client_ref) && Math.abs(Date.now() - new Date(rs[1].p_at)) < 120000 && rs[1].p_items[0].qty === 1, "when the signal returns it is sent, with a unique reference and the time it was really made");
  ok((await O.page.evaluate(() => localStorage.getItem("busynes.queue"))) === "[]" && !(await O.exists("#queueNote")), "...then the waiting list is empty and the banner is gone");
  await O.page.close();

  const O2 = await open(""); await O2.loaded();
  await O2.page.setOfflineMode(true); await sleep(250);                  // a real offline event
  ok(await O2.exists("#offlineNote") && /You're offline/.test(await O2.text()), "the offline event shows a banner straight away");
  await O2.page.click('[data-add="heineken"]'); await O2.page.click("#cartNext"); await O2.page.waitForSelector("#saveSale"); await O2.page.click("#saveSale"); await sleep(250);
  ok(/Saved on this phone/.test(await O2.text(".toast")) && (await O2.page.evaluate(() => window.__failed.filter(f => f[0] === "record_sale").length)) === 0, "known offline: it doesn't even try to send, it just keeps the sale");
  await O2.page.setOfflineMode(false); await sleep(900);
  ok(!!(await O2.last("record_sale")) && (await O2.page.evaluate(() => localStorage.getItem("busynes.queue"))) === "[]", "back online it is sent automatically");
  await O2.page.close();

  // the sale is sent but the server says no: the person is told, nothing is lost silently
  const O3 = await open(""); await O3.loaded();
  await O3.page.evaluate(() => { window.__down = true; });
  await O3.page.click('[data-add="heineken"]'); await O3.page.click("#cartNext"); await O3.page.waitForSelector("#saveSale"); await O3.page.type("#saleNote", "REJECT"); await O3.page.click("#saveSale"); await sleep(250);
  await O3.page.evaluate(() => { window.__down = false; window.dispatchEvent(new Event("online")); }); await sleep(700);
  ok(/couldn't be recorded/.test(await O3.text()) && /can't record sales in this business/.test(await O3.text()) && await O3.exists("[data-discardq]"), "a saved sale the server refuses stays visible with the reason and a Discard button");
  await O3.page.click("[data-discardq]"); await sleep(100);
  ok(!(await O3.exists("[data-discardq]")) && (await O3.page.evaluate(() => localStorage.getItem("busynes.queue"))) === "[]", "...and discarding removes it");
  await O3.page.close();

  // opening the app with no signal at all
  const S1 = await open("", undefined, true); await S1.loaded(); await S1.page.close();     // a normal visit saves what's needed
  const S2 = await open("?netdown=1", undefined, true);
  ok(await S2.visible("#appScreen") && await S2.text("#bizName") === "BusyNes", "opened with no signal, the app still opens the saved business");
  ok(await S2.exists("#offlineNote") && await S2.exists('[data-add="heineken"]'), "...with the Sell screen and a note that it's offline");
  await S2.page.click("#tab-orders"); await sleep(100);
  ok(/needs a connection/.test(await S2.text()) && await S2.exists("[data-gosell]"), "the other screens say they need a connection and point back to Sell");
  await S2.page.click("[data-gosell]"); await S2.page.click('[data-add="nini-mimosa"]'); await S2.page.click("#cartNext"); await S2.page.waitForSelector("#saveSale"); await S2.page.click("#saveSale"); await sleep(250);
  ok(/1 sale saved on this phone/.test(await S2.text("#queueNote")), "a sale can be recorded from a cold start with no signal");
  await S2.page.evaluate(() => { window.__down = false; window.dispatchEvent(new Event("online")); }); await sleep(900);
  const rs2 = await S2.last("record_sale");
  ok(rs2 && rs2[1].p_biz === "b1" && rs2[1].p_items[0].product_id === "nini-mimosa" && !(await S2.exists("#offlineNote")) && !(await S2.exists("#queueNote")), "when the signal comes back the app leaves offline mode and sends it");
  ok((await S2.page.evaluate(() => window.__calls.map(c => c[0]))).includes("my_money"), "...and reloads everything");
  // signing out with unsent sales warns first
  await S2.page.evaluate(() => { window.__down = true; });
  await S2.page.click('[data-add="nini-mimosa"]'); await S2.page.click("#cartNext"); await S2.page.waitForSelector("#saveSale"); await S2.page.click("#saveSale"); await sleep(250);
  await S2.page.click("#meBtn"); await S2.page.waitForSelector("#signOut"); await S2.page.click("#signOut"); await S2.page.waitForSelector("#cfGo");
  ok(/haven't been sent yet/.test(await S2.text(".sheet")), "signing out with unsent sales warns first, and says they stay on the phone");
  await S2.page.close();
}

// ================================================================== 13. the human check at sign-up
console.log("\n13. Sign-up check (CAPTCHA)");
{
  captchaFlag = true;
  const C1 = await open("?signedout=1", "#authForm");
  await C1.page.waitForFunction(() => window.__ts && window.__ts.length > 0, { timeout: 3000 }); await sleep(100);
  ok(await C1.visible("#captchaBox") && (await C1.page.evaluate(() => window.__ts[0])).sitekey === "TESTKEY", "when a site key is configured the check appears on the sign-in form");
  await C1.page.type("#authEmail", "a@b.com"); await C1.page.type("#authPass", "secret1");
  await C1.page.click("#signInBtn"); await sleep(250);
  let au = await C1.page.evaluate(() => window.__auth);
  ok(au.some(a => a[0] === "signIn" && a[1].options && a[1].options.captchaToken === "tok-1"), "signing in sends the check's token");
  await C1.page.click("#modeUp"); await C1.page.click("#signUpBtn"); await sleep(250);
  au = await C1.page.evaluate(() => window.__auth);
  const su = au.find(a => a[0] === "signUp");
  ok(su && su[1].options.captchaToken && su[1].options.captchaToken !== "tok-1" && su[1].options.emailRedirectTo, "each attempt needs a fresh token (the check resets), and sign-up still sends the redirect");
  await C1.page.click("#forgotBtn"); await sleep(250);
  au = await C1.page.evaluate(() => window.__auth);
  ok(au.some(a => a[0] === "reset" && a[1][1].captchaToken), "'Forgot my password' sends it too");
  await C1.page.close();
  const C2 = await open("?signedout=1&notoken=1", "#authForm"); await sleep(300);
  await C2.page.type("#authEmail", "a@b.com"); await C2.page.type("#authPass", "secret1"); await C2.page.click("#signInBtn"); await sleep(150);
  ok(/complete the check/.test(await C2.text("#authErr")) && !(await C2.page.evaluate(() => window.__auth)).some(a => a[0] === "signIn"), "without a completed check, nothing is sent");
  await C2.page.close();
  captchaFlag = false;
  const C3 = await open("?signedout=1", "#authForm"); await sleep(300);
  await C3.page.type("#authEmail", "a@b.com"); await C3.page.type("#authPass", "secret1"); await C3.page.click("#signInBtn"); await sleep(200);
  const a3 = (await C3.page.evaluate(() => window.__auth)).find(a => a[0] === "signIn");
  ok(!(await C3.visible("#captchaBox")) && a3 && !(a3[1].options && a3[1].options.captchaToken), "with no site key configured (the default) there is no check and nothing changes");
  await C3.page.close();
}

// ================================================================== 14. interface review fixes
console.log("\n14. Interface fixes");
{
  const R1 = await open("?me=sibabalo"); await R1.loaded();
  await R1.page.click("#teamBtn"); await sleep(120);
  const callLook = await R1.page.$eval('a[href^="tel:"]', a => { const c = getComputedStyle(a); return { color: c.color, bg: c.backgroundColor, text: a.innerText }; });
  ok(callLook.text === "Call" && callLook.color !== callLook.bg, "the Call button's text is visible (it was green on green): " + JSON.stringify(callLook));
  await R1.tab("report");
  const order = await R1.page.evaluate(() => { const all = [...document.querySelectorAll("#view section")]; const i = all.findIndex(x => /To settle up/i.test(x.innerText)); const j = all.findIndex(x => x.classList.contains("profit")); return [i, j]; });
  ok(order[0] >= 0 && order[1] > order[0], "on the Money screen, who pays whom comes before profit");
  ok(await R1.page.$eval(".chips.seg", e => getComputedStyle(e).flexWrap === "nowrap"), "the period buttons sit on one line");
  await R1.tab("owed");
  const wa = await R1.page.$eval('a[href^="https://wa.me/?text="]', a => decodeURIComponent(a.href.split("text=")[1]));
  ok(/Hi Thando/.test(wa) && /R20/.test(wa), "'WhatsApp reminder' opens WhatsApp with the reminder already written: " + wa.slice(0, 60));
  await R1.tab("sell");
  await R1.page.click('[data-add="heineken"]'); await R1.page.click("#cartNext"); await R1.page.waitForSelector("#saveSale");
  await R1.page.click('[data-method="cash"]'); await R1.page.click("#saveSale"); await sleep(200);
  await R1.page.click('[data-add="heineken"]'); await R1.page.click("#cartNext"); await R1.page.waitForSelector("#saveSale");
  ok(await R1.page.$eval('[data-method="cash"]', b => b.getAttribute("aria-pressed") === "true"), "the next sale remembers 'Cash' from the last one");
  await R1.page.click("#sheetCancel"); await R1.page.close();

  const R2 = await open("?many=1"); await R2.loaded();
  ok(await R2.exists("#sellSearch"), "with many products the Sell screen has a search box");
  await R2.page.type("#sellSearch", "hei"); await sleep(100);
  const shown = await R2.page.$$eval("[data-pname]", els => els.filter(e => !e.hidden).map(e => e.dataset.pname));
  ok(shown.length === 1 && shown[0] === "heineken", "typing 'hei' leaves only Heineken: " + shown.join(","));
  await R2.page.$eval("#sellSearch", e => { e.value = ""; e.dispatchEvent(new Event("input")); }); await sleep(60);
  ok((await R2.page.$$eval("[data-pname]", els => els.filter(e => !e.hidden).length)) === 10, "clearing it shows everything again");
  await R2.page.close();
  const R3 = await open(""); await R3.loaded(); ok(!(await R3.exists("#sellSearch")), "with only a few products there's no search box"); await R3.page.close();

  const R4 = await open("?signedout=1", "#authForm"); await sleep(150);
  await R4.page.type("#authPass", "secret1"); await R4.page.click("#authShow");
  ok(await R4.page.$eval("#authPass", e => e.type === "text") && (await R4.text("#authShow")) === "Hide", "'Show' reveals the password while typing");
  await R4.page.click("#authShow"); ok(await R4.page.$eval("#authPass", e => e.type === "password"), "...and 'Hide' hides it again");
  await R4.page.close();
}

// ================================================================== 15. things bought by the case
console.log("\n15. Things bought by the case");
{
  const C = await open("?cases=1&me=sibabalo"); await C.loaded(); const pg = C.page;
  await C.tab("stock");
  ok(/12 per case/.test(await C.text()), "the stock list shows '12 per case'");
  await pg.click('[data-edit="heineken"]'); await pg.waitForSelector("#saveAdd");
  ok(await pg.$eval('[data-addby="case"]', b => b.getAttribute("aria-pressed") === "true") && /How many cases came in/.test(await C.text(".sheet")), "an item with a case size opens in 'Cases' mode");
  ok(await pg.$eval("#addSize", e => e.value === "12"), "...with the case size already filled in");
  await pg.type("#addQty", "2"); await pg.type("#addCost", "300");
  const sum = await C.text("#addSum");
  ok(/2 cases × 12 = 24 items/.test(sum) && /R25 each/.test(sum) && !(await pg.$eval("#addSum", e => e.classList.contains("bad"))), "2 cases at R300 shows '24 items' and 'R25 each', with no warning: " + sum.replace(/\s+/g, " "));
  await pg.click("#saveAdd"); await sleep(250);
  let sm = await C.last("add_stock_move");
  ok(sm[1].p_qty === 24 && sm[1].p_cost === 25 && sm[1].p_kind === "add", "saving sends 24 items at R25 each, not 2 items at R300");

  await pg.click('[data-edit="heineken"]'); await pg.waitForSelector("#saveAdd"); await pg.click('[data-addby="item"]');
  await pg.type("#addQty", "24"); await pg.type("#addCost", "300");
  ok(await pg.$eval("#addSum", e => e.classList.contains("bad") && /more than you sell one for/.test(e.innerText) && /choose Cases/.test(e.innerText)), "a case price typed as the cost of ONE item warns, and points to Cases");
  await pg.click("#sheetCancel");

  await pg.click('[data-edit="heineken"]'); await pg.waitForSelector("#saveAdd"); await pg.click('[data-addby="case"]');
  await pg.$eval("#addSize", e => { e.value = ""; }); await pg.type("#addSize", "24"); await pg.type("#addQty", "1"); await pg.type("#addCost", "480"); await pg.click("#saveAdd"); await sleep(300);
  sm = await C.last("add_stock_move"); ok(sm[1].p_qty === 24 && sm[1].p_cost === 20, "a case of 24 at R480 works out at R20 each");
  let up = await C.last("update_product"); ok(up && up[1].p_case_size === 24, "a different case size is remembered on the product");

  await pg.click('[data-edit="heineken"]'); await pg.waitForSelector("#caseIn");
  ok(await pg.$eval("#caseIn", e => e.value === "12"), "the product details have 'Items in a case'");
  await pg.$eval("#costIn", e => { e.value = "300"; e.dispatchEvent(new Event("input")); });
  ok(await pg.$eval("#costWarn", e => !e.hidden), "a cost higher than the selling price shows a warning there too");
  await pg.$eval("#costIn", e => { e.value = "30"; e.dispatchEvent(new Event("input")); });
  ok(await pg.$eval("#costWarn", e => e.hidden), "...which goes away when the cost makes sense");
  await pg.$eval("#caseIn", e => { e.value = "6"; }); await pg.click("#pdSave"); await sleep(200);
  up = await C.last("update_product"); ok(up[1].p_case_size === 6, "changing it in the details saves it");
  await pg.click('[data-edit="heineken"]'); await pg.waitForSelector("#caseIn"); await pg.$eval("#caseIn", e => { e.value = ""; }); await pg.click("#pdSave"); await sleep(200);
  up = await C.last("update_product"); ok(up[1].p_case_size === 0, "emptying it removes the case size (sends 0)");
  await pg.click('[data-edit="heineken"]'); await pg.waitForSelector("#caseIn"); await pg.$eval("#caseIn", e => { e.value = "1"; }); await pg.click("#pdSave"); await sleep(100);
  ok(/between 2 and 1000/.test(await C.text(".toast")), "a case of 1 is refused with a clear message");
  await pg.click("#sheetCancel");

  await pg.click("[data-newprod]"); await pg.waitForSelector("#npCase");
  await pg.type("#npName", "Cider"); await pg.type("#npPrice", "40"); await pg.type("#npCase", "12"); await pg.type("#npCost", "300");
  ok(/R300 ÷ 12 = R25 each/.test(await C.text("#npSum")) && /one whole pack/.test(await C.text("#npCostLab")), "a new product in packs: 'R300 ÷ 12 = R25 each'");
  await pg.click("#npSave"); await sleep(250);
  let np = await C.last("add_product"); ok(np[1].p_name === "Cider" && np[1].p_cost === 25 && np[1].p_case_size === 12, "it is saved with R25 each and 12 per case");
  await pg.click("[data-newprod]"); await pg.waitForSelector("#npCase");
  await pg.type("#npName", "Water"); await pg.type("#npPrice", "10"); await pg.type("#npCost", "28");
  ok(await pg.$eval("#npSum", e => !e.hidden && e.classList.contains("bad") && /enter how many items are in it/.test(e.innerText)), "a cost above the price (no case size) warns and suggests entering the case size");
  await pg.$eval("#npCost", e => { e.value = "6"; e.dispatchEvent(new Event("input")); }); await pg.click("#npSave"); await sleep(250);
  np = await C.last("add_product"); ok(np[1].p_cost === 6 && !("p_case_size" in np[1]), "a single item keeps its cost as typed, with no case size");
  await pg.close();

  const T2 = await open("?role=staff&cases=1"); await T2.loaded(); await T2.tab("stock"); await T2.page.click('[data-edit="heineken"]'); await T2.page.waitForSelector("#saveAdd");
  ok(await T2.exists('[data-addby="case"]') && !(await T2.exists("#addCost")), "staff can add stock by the case, with no cost box");
  await T2.page.type("#addQty", "3"); await T2.page.click("#saveAdd"); await sleep(250);
  sm = await T2.last("add_stock_move"); ok(sm[1].p_qty === 36 && !("p_cost" in sm[1]), "3 cases of 12 add 36 items");
  ok(!(await T2.last("update_product")), "...and staff don't change the product");
  await T2.page.close();

  // other words for a pack
  const B = await open("?cases=1&pn=bag"); await B.loaded(); await B.tab("stock");
  ok(/12 per bag/.test(await B.text()), "a product sold in bags shows '12 per bag'");
  await B.page.click('[data-edit="heineken"]'); await B.page.waitForSelector("#saveAdd");
  await B.page.type("#addQty", "3"); await B.page.type("#addCost", "60");
  const bs = await B.text("#addSum");
  ok(/How many bags came in/.test(await B.text(".sheet")) && /3 bags × 12 = 36 items/.test(bs) && /R5 each/.test(bs), "...with the right words and sum: " + bs.replace(/\s+/g, " "));
  await B.page.$eval("#addPack", e => { e.value = ""; }); await B.page.type("#addPack", "tray"); await sleep(60);
  ok(/3 trays × 12 = 36 items/.test(await B.text("#addSum")) && /Trays/.test(await B.text('[data-addby="case"]')), "typing another name changes the words straight away (trays)");
  await B.page.click("#saveAdd"); await sleep(300);
  let pu = await B.last("update_product"); ok(pu && pu[1].p_pack_name === "tray" && pu[1].p_case_size === 12, "the new name is remembered on the product");
  await B.page.click('[data-edit="heineken"]'); await B.page.waitForSelector("#packIn");
  ok(await B.page.$eval("#packIn", e => e.value === "bag"), "the details have 'What do you call a pack?'");
  await B.page.$eval("#packIn", e => { e.value = "box"; }); await B.page.click("#pdSave"); await sleep(200);
  pu = await B.last("update_product"); ok(pu[1].p_pack_name === "box", "changing it in the details saves it");
  await B.page.close();
  const N0 = await open("?cases=1&pn=zzz"); await N0.loaded(); await N0.tab("stock");
  await N0.page.click("[data-newprod]"); await N0.page.waitForSelector("#npCase");
  ok(!(await N0.visible("#npPack")), "the pack name box appears only once a pack size is typed");
  await N0.page.type("#npName", "Russians"); await N0.page.type("#npPrice", "15"); await N0.page.type("#npCase", "20");
  ok(await N0.visible("#npPack"), "...now it shows");
  await N0.page.type("#npPack", "Pack"); await N0.page.type("#npCost", "100");
  ok(/R100 ÷ 20 = R5 each/.test(await N0.text("#npSum")), "a pack of 20 at R100 works out at R5 each");
  await N0.page.click("#npSave"); await sleep(250);
  const nr = await N0.last("add_product"); ok(nr[1].p_case_size === 20 && nr[1].p_pack_name === "pack" && nr[1].p_cost === 5, "saved as 20 per pack, R5 each, named 'pack'");
  await N0.page.close();

  const OD = await open("?oldprods=1"); await OD.loaded();
  ok(await OD.exists('[data-add="heineken"]'), "before the database update the app still works (products load without the case size)");
  await OD.page.close();
}

// ================================================================== 16. log in / create account
console.log("\n16. Log in or create an account");
{
  const L = await open("?signedout=1", "#authForm"); await sleep(150); const pg = L.page;
  ok(await pg.$eval("#modeIn", e => e.getAttribute("aria-selected") === "true") && await L.visible("#signInBtn") && !(await L.visible("#signUpBtn")) && await L.visible("#forgotBtn"), "it opens on 'Log in' with a Log in button and 'Forgot my password'");
  await pg.click("#modeUp"); await sleep(60);
  ok(await L.visible("#signUpBtn") && !(await L.visible("#signInBtn")) && !(await L.visible("#forgotBtn")) && /Create your account/.test(await L.text("#authHead")), "'Create account' shows a sign-up form without the log-in extras");
  ok(await pg.$eval("#authPass", e => e.autocomplete === "new-password"), "the password manager is told it is a new password");
  await pg.type("#authEmail", "new@b.com"); await pg.type("#authPass", "123"); await pg.click("#signUpBtn"); await sleep(120);
  ok(!(await pg.evaluate(() => window.__auth)).some(a => a[0] === "signUp"), "a too-short password is not sent (the phone asks for 6 characters)");
  await pg.$eval("#authPass", e => { e.value = "secret1"; }); await pg.click("#signUpBtn"); await sleep(250);
  ok((await pg.evaluate(() => window.__auth)).some(a => a[0] === "signUp"), "creating the account sends the sign-up");
  ok(await L.visible("#signInBtn") && /confirmation link/.test(await L.text("#authErr")), "after creating the account it returns to Log in with a 'check your email' message");
  await pg.click("#swapBtn"); await sleep(60); await pg.click("#swapBtn"); await sleep(60);
  ok(await L.visible("#signInBtn") && !(await L.visible("#signUpBtn")), "'Already have an account? Log in' switches back");
  await pg.close();
}

// ================================================================== 17. searching and filtering sales
console.log("\n17. Search and filter sales");
{
  const S1 = await open("?me=sibabalo"); await S1.loaded(); const pg = S1.page; await S1.tab("sales");
  const n = () => pg.$$eval(".sale", els => els.length);
  ok((await n()) === 2 && await S1.exists("#salesSearch"), "the Sales screen has a search box (2 sales to start with)");
  await pg.type("#salesSearch", "tha"); await sleep(80); await pg.type("#salesSearch", "ndo"); await sleep(80);
  ok((await n()) === 1 && /Thando|Nini Mimosa/.test(await S1.text(".sale")) && /1 sale/.test(await S1.text(".salescount")), "typing a customer's name finds that sale, and typing keeps going (the box keeps focus)");
  ok(await pg.$eval("#salesSearch", e => e === document.activeElement && e.value === "thando"), "...the box still has focus and its text");
  await pg.$eval("#salesSearch", e => { e.value = ""; }); await pg.type("#salesSearch", "black label"); await sleep(120);
  ok((await n()) === 1 && /Black Label/.test(await S1.text(".sale")), "an item name finds the sale it was in");
  await pg.$eval("#salesSearch", e => { e.value = ""; }); await pg.type("#salesSearch", "vusi cash"); await sleep(120);
  ok((await n()) === 1 && /Nini Mimosa/.test(await S1.text(".sale")), "several words must all match (who sold it + cash)");
  await pg.$eval("#salesSearch", e => { e.value = ""; }); await pg.type("#salesSearch", "zzzz"); await sleep(120);
  ok((await n()) === 0 && /No sales match/.test(await S1.text()), "nothing found says so");
  await pg.click("[data-sclear]"); await sleep(120);
  ok((await n()) === 2 && !(await S1.exists(".salescount")), "'Clear search' brings everything back");
  await pg.click('[data-smethod="cash"]'); await sleep(80);
  ok((await n()) === 1 && /Nini Mimosa/.test(await S1.text(".sale")), "the Cash filter leaves only cash sales");
  await pg.click('[data-smethod="transfer"]'); await sleep(80);
  ok((await n()) === 1 && /Black Label/.test(await S1.text(".sale")), "the Account filter leaves only account sales");
  await pg.click('[data-smethod="all"]'); await pg.click('[data-sstatus="owing"]'); await sleep(80);
  ok((await n()) === 1 && /Owes R20/.test(await S1.text(".sale")), "'Still owing' shows only sales with a balance");
  ok(/R70/.test(await S1.text(".salescount")), "the count line shows how many sales and their total");
  await pg.click('[data-sstatus="all"]'); await pg.click('[data-speriod="today"]'); await sleep(80);
  ok((await n()) === 2, "'Today' keeps today's sales");
  await pg.click("[data-sfilter=\"mine\"]"); await sleep(80);
  ok((await n()) === 1 && /Black Label/.test(await S1.text(".sale")), "it combines with 'Mine'");
  await pg.close();
}

// ================================================================== done
console.log("\nErrors during the whole run: " + errors.length);
errors.forEach(e => console.log("   " + e.slice(0, 220)));
ok(errors.length === 0, "no JavaScript errors");
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);

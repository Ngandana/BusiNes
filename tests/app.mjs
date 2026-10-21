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
const ME = P.get("me") || "vusi";
const ROLE = P.get("role") || ({sibabalo:"owner", vusi:"partner", dokotela:"partner"}[ME]);
const B1 = {id:"b1", name:"BusyNes", kind:"Drinks", role:ROLE, member_id:ME, privacy:"private", owner_name:"Sibabalo", team_settle:true};
const B2 = {id:"b2", name:"Fat Cook", kind:"Fast food", role:"owner", member_id:"m_fc", privacy:"shared", owner_name:"Thabo", team_settle:false};
let BIZ = P.get("none") === "1" ? [] : [B1, B2];

const byBiz = (a, b) => biz => biz === "b1" ? a : b;
const D = {
  partners: byBiz(
    [{id:"sibabalo",name:"Sibabalo",phone:"0821112222",role:"owner",status:"active"},{id:"vusi",name:"Vusi",phone:null,role:"partner",status:"active"},{id:"dokotela",name:"Dokotela",phone:"0833334444",role:"partner",status:"active"}],
    [{id:"m_fc",name:"Thabo",phone:null,role:"owner",status:"active"},{id:"m_n",name:"Nomsa",phone:null,role:"partner",status:"invited"}]),
  products: byBiz(
    [{id:"nini-mimosa",name:"Nini Mimosa",price:35,owner:"sibabalo",sort:7,hidden:false,track_stock:true},{id:"heineken",name:"Heineken",price:40,owner:"beers",sort:1,hidden:false,track_stock:true},{id:"chips",name:"Chips",price:20,owner:"beers",sort:2,hidden:false,track_stock:false}],
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
const R = {
  claim_memberships: 0,
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
  create_business: a => { BIZ.push({id:"b3", name:a.p_name, kind:a.p_kind, role:"owner", member_id:"m_new", privacy:"shared", owner_name:a.p_my_name, team_settle:false}); return "b3"; },
  delete_business: a => { BIZ = BIZ.filter(b => b.id !== a.p_biz); return null; },
  update_business: a => { const b = BIZ.find(x => x.id === a.p_biz); if (b) { if (a.p_name != null) b.name = a.p_name; if (a.p_kind != null) b.kind = a.p_kind; if (a.p_privacy != null) b.privacy = a.p_privacy; if (a.p_team_settle != null) b.team_settle = a.p_team_settle; } return null; },
};
function builder(table){
  let biz = "b1";
  const b = { select(){return b;}, order(){return b;}, limit(){return b;}, neq(){return b;}, is(){return b;}, eq(c, v){ if (c === "business_id") biz = v; return b;},
              then(res, rej){
                let d = D[table]; if (typeof d === "function") d = d(biz);
                if (table === "notifications" && !biz) d = UNREAD;
                return Promise.resolve({data: d || [], error: null}).then(res, rej);
              } };
  return b;
}
window.supabase = { createClient(){ return {
  auth: { onAuthStateChange(cb){ setTimeout(() => cb("SIGNED_IN", {user:{id:"u1",email:"vusi@example.com"}}), 0); return {data:{subscription:{}}}; },
          signOut(){return Promise.resolve({});}, signInWithPassword(){return Promise.resolve({});}, updateUser(){return Promise.resolve({error:null});} },
  from(t){
    const b = builder(t);
    // "unread across businesses" is the one notifications query with no business filter
    if (t === "notifications") { const orig = b.is; b.is = function(){ b.then = (res, rej) => Promise.resolve({data: UNREAD, error:null}).then(res, rej); return b; }; }
    return b;
  },
  rpc(name,args){
    window.__calls.push([name,args]);
    let r = name in R ? R[name] : 1; if (typeof r === "function") r = r(args || {});
    return Promise.resolve({data: r, error: null});
  },
}; } };
`;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
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
async function open(query, ready = "#view .grid, #view .empty, #view h2") {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  page.on("pageerror", e => errors.push(query + " pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(query + " console: " + m.text()); });
  page.on("dialog", d => d.dismiss());
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
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
    loaded: async () => { await page.waitForFunction(() => { const v = document.querySelector("#view"); return v && v.innerText && !v.innerText.includes("Loading"); }, { timeout: 5000 }); },
  };
  return api;
}

// ================================================================== 1. a partner in an existing business
console.log("1. Partner (Vusi) in BusyNes: the original screens still work");
let A = await open("");
let { page, text, calls, tab } = A;
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
ok(/Sibabalo pays you or Dokotela/.test(t) && /R160/.test(t), "settle-up is one line: Sibabalo pays you or Dokotela, R160 (team settle-up is on for BusyNes)");
ok(/settle as one/.test(t), "explains that partners who run the same stock settle as one");
ok((await calls()).filter(c => c[0] === "my_money").every(c => c[1].p_biz === "b1"), "every request names the business (b1)");
await page.click("#teamBtn"); await sleep(80); t = await text();
ok(t.includes("Who has change?") && t.includes("Sibabalo") && /Owner/.test(t), "team shows chat and roles");
ok(await page.$eval('a[href="tel:0821112222"]', e => e.textContent === "Call"), "Call link for Sibabalo uses tel:");
ok(await page.$eval('a[href^="https://wa.me/27833334444"]', e => true).catch(() => false), "WhatsApp link converts 083… to 2783…");

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
ok(/Invitation saved/.test(sheet) && /Zola@Mail\.com/.test(sheet) && /Fat Cook/.test(sheet) && /Create my login/.test(sheet), "an invitation message is ready to copy, naming the business and the email to use");
await page.click("#sheetCancel"); await sleep(60);
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
await B.page.type("#obBiz", "Spaza Plus"); await B.page.type("#obKind", "Airtime and snacks");
await B.page.click("#obBtn"); await B.page.waitForSelector("#appScreen:not([hidden])"); await B.loaded();
const cb = await B.last("create_business");
ok(cb[1].p_name === "Spaza Plus" && cb[1].p_kind === "Airtime and snacks" && cb[1].p_my_name === "Vusi", "create_business sent the names");
ok(await B.visible("#appScreen") && await B.text("#bizName") === "Spaza Plus", "they land in their new business");
ok((await B.text()).includes("No products yet") && (await B.text()).includes("Stock tab"), "...with a hint to add products first");
await B.page.close();

// ================================================================== 7. delivery person
console.log("\n7. Delivery: sees orders only");
const C = await open("?role=delivery", "#view h2"); await C.loaded();
const navShown = await C.page.$$eval("[data-tab]", els => els.filter(e => !e.hidden).map(e => e.dataset.tab));
ok(navShown.join() === "orders", "only the Orders tab is shown: " + navShown.join());
ok((await C.text()).includes("Lindiwe") && !(await C.exists("[data-neworder]")) && !(await C.exists("[data-fillorder]")) && !(await C.exists("[data-cancelorder]")), "they see orders but can't add, sell or cancel them");
ok(await C.exists('[data-claim="1"]'), "...and can take one");
const cc = (await C.calls()).map(c => c[0]);
ok(!cc.includes("sales_timeline") && !cc.includes("stock_levels") && !cc.includes("my_debts") && !cc.includes("my_money"), "the app doesn't even ask for sales, stock or money: " + [...new Set(cc)].join(","));
await C.page.click("#teamBtn"); await sleep(80); ok(/chat/i.test(await C.text()), "they can still chat and call");
await C.page.close();

// ================================================================== 8. staff
console.log("\n8. Staff: sells, but can't change prices or settle up");
const E = await open("?role=staff"); await E.loaded();
ok(await E.exists('[data-add="nini-mimosa"]'), "staff can sell");
await E.tab("stock");
ok(!(await E.exists("[data-newprod]")), "no 'Add product' button");
await E.page.click('[data-edit="heineken"]'); await sleep(60);
ok(await E.exists("#addQty") && !(await E.exists("#priceIn")) && !(await E.exists("[data-dohide]")), "stock can be updated, but there's no price or hide control");
await E.tab("report"); ok(!(await E.exists("[data-settle]")), "no 'Mark as settled'");
await E.page.click("#meBtn"); await E.page.click("#meSettings"); await sleep(250);
t = await E.text();
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

// ================================================================== done
console.log("\nErrors during the whole run: " + errors.length);
errors.forEach(e => console.log("   " + e.slice(0, 220)));
ok(errors.length === 0, "no JavaScript errors");
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);

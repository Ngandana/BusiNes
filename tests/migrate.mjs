import { makeDb, reporter, ROOT, HERE, read } from "./lib.mjs";

const T = reporter();
const h = await makeDb();
const { db } = h;
const oldSchema = read(HERE + "fixtures/schema-v2.3.sql");
const newSchema = read(ROOT + "schema.sql");
const seed = read(HERE + "fixtures/seed-v2.sql");
const EMAIL = {}; for (const m of seed.matchAll(/\('(\w+)',\s*'\w+',\s*'([^']+)'\)/g)) EMAIL[m[1]] = m[2];

T.section("1. Build the current (v2.3) database with realistic activity");
await db.exec(oldSchema); await db.exec(seed);
await h.addUser("sibabalo", EMAIL.sibabalo);
await h.addUser("vusi", EMAIL.vusi);
// Dokotela has no login yet: he must come through as an invitation.
h.users.dokotela = { id: "00000000-0000-4000-8000-000000000d0c", email: EMAIL.dokotela };   // not in auth.users: old-style calls only match on email
const L = (who, sql) => h.as(who, sql);
await L("sibabalo", `select busynes.record_sale('[{"product_id":"gordons","qty":1},{"product_id":"savanna","qty":2}]'::jsonb,'sibabalo','cash','legacy A')`);
await L("vusi",     `select busynes.record_sale('[{"product_id":"heineken","qty":4}]'::jsonb,'vusi','transfer','legacy B')`);
await L("dokotela", `select busynes.record_sale('[{"product_id":"black-label","qty":2},{"product_id":"nini-mimosa","qty":2}]'::jsonb,'dokotela','cash','legacy C')`);
await L("vusi",     `select busynes.record_sale('[{"product_id":"nini-mimosa","qty":2}]'::jsonb,'vusi','cash','Thando',50,'2026-12-15'::date,null,0,null)`);
await L("sibabalo", `select busynes.record_sale('[{"product_id":"first-watch","qty":1}]'::jsonb,'sibabalo','cash','Mpho',0,'2026-12-20'::date,null,50,'sibabalo')`);
await L("sibabalo", `select busynes.create_order('Lindiwe','[{"product_id":"heineken","qty":3}]'::jsonb,'collect 5pm',null,true,40)`);
await L("sibabalo", `insert into busynes.stock_moves (product_id, kind, qty, by) values ('gordons','count',9,'sibabalo')`);
await L("vusi",     `select busynes.send_message('anyone have change?')`);
await L("sibabalo", `select busynes.record_sale('[{"product_id":"gordons","qty":1}]'::jsonb,'sibabalo','cash','')`);
const legacyMoney = {};
for (const w of ["sibabalo", "vusi", "dokotela"]) legacyMoney[w] = (await h.as(w, "select busynes.my_money() m")).rows[0].m;
const counts0 = {};
for (const t of ["partners", "owner_shares", "products", "stock_moves", "sales", "sale_items", "sale_payments", "orders", "order_fees", "notifications", "messages"])
  counts0[t] = (await db.query(`select count(*)::int c from busynes.${t}`)).rows[0].c;
console.log("   legacy sibabalo: received", legacyMoney.sibabalo.received, "share", legacyMoney.sibabalo.due, "fees", legacyMoney.sibabalo.fees, "owing", legacyMoney.sibabalo.outstanding);
console.log("   legacy rows:", JSON.stringify(counts0));

T.section("2. Upgrade to version 3 (applied twice: it must be repeatable)");
await db.exec(newSchema);
await db.exec(newSchema);
const biz = (await db.query("select * from busynes.businesses")).rows;
T.ok(biz.length === 1 && biz[0].name === "BusyNes" && biz[0].privacy === "private" && biz[0].team_settle === true, "exactly one business 'BusyNes', private mode, team settle-up on (original behaviour)");
const B = biz[0].id;
const mem = (await db.query("select id, role, status, user_id is not null as linked from busynes.partners order by id")).rows;
const byId = Object.fromEntries(mem.map(m => [m.id, m]));
T.ok(byId.sibabalo.role === "owner" && byId.sibabalo.status === "active" && byId.sibabalo.linked, "Sibabalo is the owner, active, linked to his login");
T.ok(byId.vusi.role === "partner" && byId.vusi.status === "active" && byId.vusi.linked, "Vusi is a partner, active, linked to his login");
T.ok(byId.dokotela.role === "partner" && byId.dokotela.status === "invited" && !byId.dokotela.linked, "Dokotela (no login yet) is a partner waiting as 'invited'");
const counts1 = {};
for (const t of Object.keys(counts0)) counts1[t] = (await db.query(`select count(*)::int c from busynes.${t}`)).rows[0].c;
T.ok(JSON.stringify(counts0) === JSON.stringify(counts1), "every table has exactly the same number of rows after the upgrade");
T.ok((await db.query("select count(*)::int c from busynes.sales where business_id is null")).rows[0].c === 0, "no sale was left without a business");
const bk = (await db.query("select count(*)::int c from busynes_backup.sales")).rows[0].c;
T.ok(bk === counts0.sales, "a private backup of the old data exists (busynes_backup)");
T.ok((await h.err("sibabalo", "select * from busynes_backup.sales")) !== null, "...and signed-in people can't read it");
T.ok((await h.err("sibabalo", "select busynes.my_partner()")) !== null, "the old single-business function is gone");

T.section("3. Everyone's money is exactly what it was");
for (const w of ["sibabalo", "vusi"]) {
  const m = (await h.as(w, `select busynes.my_money('${B}') m`)).rows[0].m, o = legacyMoney[w];
  T.ok(["received", "received_cash", "due", "fees", "outstanding", "sold_value"].every(k => T.near(m[k], Number(o[k]))), `${w}: received ${m.received}, share ${m.due}, fees ${m.fees}, owing ${m.outstanding} unchanged`);
  const sum = x => (x.pays || []).map(p => `${p.from_name}>${p.to_name}:${Number(p.amount).toFixed(2)}`).sort().join("|");
  T.ok(sum(m) === sum(o), `${w}: settle-up lines unchanged (${sum(m)})`);
}
T.section("4. Dokotela signs up later and the business is waiting for him");
await h.addUser("dokotela2", EMAIL.dokotela);
h.users.dokotela = h.users.dokotela2;
T.ok((await h.val("dokotela", "select busynes.claim_memberships()")) === 1, "claim_memberships attaches his invitation");
T.ok((await h.val("dokotela", "select busynes.claim_memberships()")) === 0, "...and only once");
const dm = (await h.as("dokotela", `select busynes.my_money('${B}') m`)).rows[0].m;
T.ok(["received", "due", "fees", "outstanding"].every(k => T.near(dm[k], Number(legacyMoney.dokotela[k]))), `dokotela: money unchanged (${dm.received} / ${dm.due})`);
T.ok((await h.as("sibabalo", "select count(*)::int c from busynes.notifications where kind = 'member'")).rows[0].c === 1, "the owner is told 'Dokotela joined'");
const bs = (await h.as("dokotela", "select * from busynes.my_businesses()")).rows;
T.ok(bs.length === 1 && bs[0].role === "partner" && bs[0].name === "BusyNes", "Dokotela sees one business: BusyNes");

T.section("5. The old rules still hold inside BusyNes (private mode)");
const tl = (await h.as("dokotela", `select * from busynes.sales_timeline('${B}')`)).rows;
const thando = tl.find(r => r.note === "Thando");
T.ok(thando && thando.whole === false && thando.total === null && thando.due_on === null && thando.items.every(i => i.price === null), "Dokotela sees Thando's mimosa sale but no money details");
const mpho = (await h.as("vusi", `select * from busynes.sales_timeline('${B}')`)).rows.find(r => r.note === "Mpho");
T.ok(mpho && mpho.whole === false && mpho.loan_fee === null, "Vusi sees Sibabalo's loan happened, but not the fee");
T.ok((await h.as("sibabalo", `select * from busynes.my_debts('${B}')`)).rows.some(d => d.customer === "Mpho" && T.near(d.outstanding, 330) && T.near(d.loan_fee, 50)), "Sibabalo still sees the loan: R330 owing incl. R50 fee");
T.ok((await h.err("vusi", "select loan_fee from busynes.sales")) !== null, "loan_fee still can't be read directly");
T.ok((await h.as("sibabalo", `select * from busynes.list_members('${B}')`)).rows.every(r => r.email !== null), "the owner sees member emails");
T.ok((await h.as("vusi", `select * from busynes.list_members('${B}')`)).rows.every(r => r.email === null), "partners don't");
T.ok((await h.err("vusi", "select email from busynes.partners")) !== null && (await h.err("vusi", "select user_id from busynes.partners")) !== null, "email and login ids can't be read from the partners table");

process.exit(T.done());

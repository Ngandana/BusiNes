import { makeDb, reporter, ROOT, read } from "./lib.mjs";

const T = reporter();
const h = await makeDb();
const { db } = h;
await db.exec(read(ROOT + "schema.sql"));
await db.exec(read(ROOT + "schema.sql"));   // a fresh install, applied twice
const J = o => JSON.stringify(o);
const q = (who, sql, params) => h.as(who, sql, params);
const one = async (who, sql, params) => (await q(who, sql, params)).rows[0];
const rows = async (who, sql, params) => (await q(who, sql, params)).rows;
const sale = async (who, biz, items, paidTo, o = {}) =>
  (await one(who, `select busynes.record_sale($1::uuid, $2::jsonb, $3, $4, $5, $6::numeric, $7::date, $8::bigint, $9::numeric, $10, $11::uuid, $12::timestamptz) id`,
    [biz, J(items), paidTo, o.method || "cash", o.note || "", o.paid ?? null, o.due ?? null, o.order ?? null, o.fee ?? 0, o.feeTo ?? null, o.ref ?? null, o.at ?? null])).id;
const money = async (who, biz, from = null) => (await one(who, `select busynes.my_money($1::uuid, $2::timestamptz) m`, [biz, from])).m;
const invite = (who, biz, email, name, role, group = null, share = 0) =>
  one(who, `select busynes.invite_member($1::uuid, $2, $3, $4, $5, $6::numeric) id`, [biz, email, name, role, group, share]);
const lines = m => (m.pays || []).map(p => `${p.from_name}>${p.to_name}:${Number(p.amount).toFixed(2)}`).sort();

// ============================================================ A. create businesses and people
T.section("A. Create a business, add products, invite people");
for (const [n, e] of [["thabo", "thabo@x.com"], ["sipho", "sipho@x.com"], ["mallory", "mallory@x.com"], ["builder", "builder@x.com"]]) await h.addUser(n, e);
const F = (await one("thabo", `select busynes.create_business('Fat Cook', 'Fast food', 'Thabo') id`)).id;
T.ok(typeof F === "string" && F.length === 36, "Thabo creates 'Fat Cook'");
const meT = (await rows("thabo", "select * from busynes.my_businesses()"));
T.ok(meT.length === 1 && meT[0].role === "owner" && meT[0].team_settle === false, "he is its owner; co-owners settle individually by default");
T.ok((await rows("thabo", `select * from busynes.my_groups('${F}')`)).length === 1, "it starts with one ownership group: him at 100%");
const burger = (await one("thabo", `select busynes.add_product('${F}', 'Burger', 45, 'everyone') id`)).id;
const chips = (await one("thabo", `select busynes.add_product('${F}', 'Chips', 20, 'everyone', false) id`)).id;
T.ok((await rows("thabo", `select id from busynes.products where business_id = '${F}'`)).length === 2, "two products added (ids are generated, never clash with other businesses)");

T.section("A2. Invitations: partner with 35%, staff, delivery");
const nomsaM = (await invite("thabo", F, "Nomsa@X.com", "Nomsa", "partner", "everyone", 0.35)).id;
const sh = Object.fromEntries((await rows("thabo", `select * from busynes.my_groups('${F}')`)).map(r => [r.partner_id, Number(r.share)]));
T.ok(T.near(sh[nomsaM], 0.35) && Object.values(sh).reduce((a, b) => a + b, 0) > 0.9999, "Nomsa gets 35%, Thabo keeps the remaining 65%");
const members = await rows("thabo", `select * from busynes.list_members('${F}')`);
T.ok(members.length === 2 && members.find(m => m.id === nomsaM).status === "invited" && members.find(m => m.id === nomsaM).email === "nomsa@x.com", "she is 'invited' until she signs up (email stored in lower case)");
const ziM = (await invite("thabo", F, "zinhle@x.com", "Zinhle", "staff")).id;
const siM = (await invite("thabo", F, "sipho@x.com", "Sipho", "delivery")).id;
T.ok((await rows("thabo", `select status from busynes.list_members('${F}') where id = '${siM}'`))[0].status === "active", "Sipho already had a login, so he is added straight away");
T.ok((await rows("sipho", "select * from busynes.my_businesses()")).length === 1, "...and sees Fat Cook as soon as he opens the app");
T.ok((await rows("sipho", "select * from busynes.notifications")).some(n => /added to Fat Cook/.test(n.title)), "...with a notification telling him");

T.ok((await h.err("thabo", `select busynes.invite_member('${F}', 'not-an-email', 'X', 'staff')`)) !== null, "a bad email is refused");
T.ok((await h.err("thabo", `select busynes.invite_member('${F}', 'zinhle@x.com', 'Z', 'staff')`)) !== null, "inviting the same person twice is refused");
T.ok((await h.err("thabo", `select busynes.invite_member('${F}', 'a@x.com', 'A', 'owner')`)) !== null, "you can't invite a second owner");
T.ok((await h.err("thabo", `select busynes.invite_member('${F}', 'b@x.com', 'B', 'partner', 'everyone', 1.2)`)) !== null, "a share of 120% is refused");
T.ok((await h.err("thabo", `select busynes.invite_member('${F}', 'b@x.com', 'B', 'partner', 'everyone', 0.9)`)) !== null, "a share bigger than what the owner has left is refused");
T.ok((await h.err("thabo", `select busynes.invite_member('${F}', 'b@x.com', 'B', 'staff', 'everyone', 0.1)`)) !== null, "staff can't be given ownership");
T.ok((await h.err("mallory", `select busynes.invite_member('${F}', 'b@x.com', 'B', 'staff')`)) !== null, "someone outside the business can't invite anyone");

T.section("A3. Signing up with an invited email claims the invitation");
await h.addUser("nomsa", "NOMSA@x.com");
T.ok((await h.val("nomsa", "select busynes.claim_memberships()")) === 1, "Nomsa signs up (any capital letters) and her invitation is attached");
await h.addUser("zinhle", "zinhle@x.com", false);   // email NOT confirmed yet
T.ok((await h.val("zinhle", "select busynes.claim_memberships()")) === 0 && (await rows("zinhle", "select * from busynes.my_businesses()")).length === 0, "an unconfirmed email can't claim an invitation");
await db.query("update auth.users set email_confirmed_at = now() where id = $1", [h.users.zinhle.id]);
T.ok((await h.val("zinhle", "select busynes.claim_memberships()")) === 1, "...once the email is confirmed she can");
await h.addUser("evil", "evil@x.com");
T.ok((await h.val("evil", "select busynes.claim_memberships()")) === 0 && (await rows("evil", "select * from busynes.my_businesses()")).length === 0, "someone with a different email gets nothing");
T.ok((await rows("thabo", "select * from busynes.notifications where kind = 'member'")).length === 2, "the owner was told when Nomsa and Zinhle joined");

// ============================================================ B. isolation
T.section("B. Businesses are completely separate");
const N = (await one("nomsa", `select busynes.create_business('Nomsa Bakery', 'Baking', '') id`)).id;
T.ok((await rows("nomsa", "select * from busynes.my_businesses()")).length === 2, "Nomsa belongs to two businesses (Fat Cook as a partner, her own bakery)");
const cake = (await one("nomsa", `select busynes.add_product('${N}', 'Cake', 120, 'everyone') id`)).id;
const nb = (await rows("nomsa", "select * from busynes.my_businesses()")).find(b => b.id === N).member_id;
await sale("nomsa", N, [{ product_id: cake, qty: 2 }], nb);
const TABLES = ["businesses", "partners", "owner_shares", "products", "stock_moves", "sales", "sale_items", "sale_payments", "settlements", "orders", "order_fees", "notifications", "messages"];
const COL = { businesses: "id", partners: "id", owner_shares: "owner", products: "id", stock_moves: "id", sales: "id", sale_items: "id",
  sale_payments: "id", settlements: "id", orders: "id", order_fees: "order_id", notifications: "id", messages: "id" };
const FNS = (b) => [
  `busynes.my_money('${b}')`, `busynes.my_debts('${b}')`, `busynes.sales_timeline('${b}')`, `busynes.stock_levels('${b}')`,
  `busynes.list_members('${b}')`, `busynes.my_groups('${b}')`,
];
for (const outsider of ["mallory", "builder"]) {
  let leaks = 0;
  for (const t of TABLES) leaks += (await rows(outsider, `select ${COL[t]} from busynes.${t}`)).length;
  T.ok(leaks === 0, `${outsider} (not in any business) reads 0 rows from every table`);
  let fnLeaks = 0;
  for (const f of FNS(F).concat(FNS(N))) { try { const r = await rows(outsider, `select * from ${f}`); fnLeaks += r.length; } catch (e) { /* raising is fine */ } }
  T.ok(fnLeaks === 0, `${outsider} gets nothing from any report for either business`);
  T.ok((await h.err(outsider, `select busynes.record_sale('${F}', '[{"product_id":"${burger}","qty":1}]'::jsonb, 'x', 'cash')`)) !== null, `${outsider} can't record a sale in someone's business`);
  T.ok((await h.err(outsider, `select busynes.create_order('${F}', 'x', '[{"product_id":"${burger}","qty":1}]'::jsonb)`)) !== null, `${outsider} can't add an order`);
  T.ok((await h.err(outsider, `select busynes.send_message('${F}', 'hi')`)) !== null, `${outsider} can't chat in it`);
  T.ok((await h.err(outsider, `select busynes.add_product('${F}', 'X', 1, 'everyone')`)) !== null, `${outsider} can't add products`);
  T.ok((await h.err(outsider, `select busynes.update_business('${F}', 'Hacked')`)) !== null, `${outsider} can't rename it`);
  T.ok((await h.err(outsider, `select busynes.delete_business('${F}', 'Fat Cook')`)) !== null, `${outsider} can't delete it`);
  T.ok((await h.err(outsider, `select busynes.update_product('${burger}', null, 1)`)) !== null, `${outsider} can't change its prices`);
  T.ok((await h.err(outsider, `select busynes.ping_partner('${nomsaM}')`)) !== null, `${outsider} can't send alerts to its people`);
}
// cross-business: Thabo is not in the bakery, Nomsa's bakery data is invisible to him
T.ok((await rows("thabo", `select * from busynes.sales_timeline('${N}')`)).length === 0, "Thabo can't see Nomsa's bakery sales");
T.ok((await rows("thabo", `select id, business_id from busynes.sales`)).every(s => s.business_id === F), "even a direct table query only ever returns his own business");
T.ok((await h.err("thabo", `select busynes.record_sale('${N}', '[{"product_id":"${cake}","qty":1}]'::jsonb, 'x', 'cash')`)) !== null, "he can't sell in the bakery");
T.ok((await h.err("thabo", `select busynes.record_sale('${F}', '[{"product_id":"${cake}","qty":1}]'::jsonb, '${nomsaM}', 'cash')`)) !== null, "a product from another business can't be sold in his");
T.ok((await h.err("thabo", `select busynes.record_sale('${F}', '[{"product_id":"${burger}","qty":1}]'::jsonb, 'someone-elses-id', 'cash')`)) !== null, "money can't be paid to someone outside his business");
for (const f of FNS(N).slice(0, 3)) T.ok((await rows("thabo", `select * from ${f}`).catch(() => [])).length === 0, `Thabo gets nothing from ${f.split("(")[0].replace("busynes.", "")} for the bakery`);
T.ok((await rows("thabo", "select * from busynes.businesses")).length === 1, "Thabo can only see his own business row");
// the public (anon) key can do nothing at all
let anonOk = 0;
for (const t of TABLES) { try { await q("anon", `select ${COL[t]} from busynes.${t}`); anonOk++; } catch (e) { /* denied */ } }
T.ok(anonOk === 0, "signed-out visitors can't read any table");
T.ok((await h.err("anon", `select busynes.my_businesses()`)) !== null && (await h.err("anon", `select busynes.create_business('x','','')`)) !== null, "...or call any function");
T.ok((await h.err("thabo", "select busynes.notify('" + nomsaM + "', 'x', 'fake')")) !== null && (await h.err("thabo", "select busynes.send_due_reminders()")) !== null, "internal helpers aren't callable by users");
T.ok((await h.err("thabo", `insert into busynes.sales (business_id, paid_to, method, recorded_by) values ('${F}', '${nomsaM}', 'cash', '${nomsaM}')`)) !== null, "no direct writes to tables");
T.ok((await h.err("thabo", `update busynes.partners set role = 'owner' where id = '${nomsaM}'`)) !== null, "nobody can promote themselves by writing to the table");

// ============================================================ C. roles
T.section("C. Roles: delivery, staff, partner");
const bq = `select busynes.record_sale('${F}', '[{"product_id":"${burger}","qty":1}]'::jsonb, '${siM}', 'cash')`;
T.ok((await h.err("sipho", bq)) !== null, "delivery can't record sales");
T.ok((await h.err("sipho", `select busynes.create_order('${F}', 'x', '[{"product_id":"${burger}","qty":1}]'::jsonb)`)) !== null, "delivery can't add orders");
T.ok((await h.err("sipho", `select busynes.add_stock_move('${F}', '${burger}', 'add', 5)`)) !== null, "delivery can't change stock");
T.ok((await rows("sipho", "select id from busynes.products")).length === 0 && (await rows("sipho", `select * from busynes.stock_levels('${F}')`)).length === 0 && (await rows("sipho", `select * from busynes.sales_timeline('${F}')`)).length === 0, "delivery sees no products, stock or sales");
T.ok((await rows("sipho", `select * from busynes.my_groups('${F}')`)).every(r => r.share === null), "delivery doesn't see ownership percentages");
T.ok((await rows("sipho", `select * from busynes.list_members('${F}')`)).every(r => r.email === null), "delivery doesn't see anyone's email");
T.ok((await h.err("sipho", `select busynes.invite_member('${F}', 'q@x.com', 'Q', 'staff')`)) !== null, "delivery can't invite people");
T.ok((await h.err("zinhle", `select busynes.add_product('${F}', 'X', 5, 'everyone')`)) !== null && (await h.err("zinhle", `select busynes.update_product('${burger}', null, 1)`)) !== null, "staff can't add products or change prices");
T.ok((await h.err("zinhle", `select busynes.invite_member('${F}', 'q@x.com', 'Q', 'staff')`)) !== null && (await h.err("zinhle", `select busynes.mark_settled('${F}')`)) !== null && (await h.err("zinhle", `select busynes.update_business('${F}', 'X')`)) !== null, "staff can't invite, settle up or rename");
T.ok((await rows("zinhle", `select * from busynes.my_groups('${F}')`)).every(r => r.share === null), "staff don't see ownership percentages");
T.ok((await h.err("nomsa", `select busynes.invite_member('${F}', 'q@x.com', 'Q', 'staff')`)) !== null && (await h.err("nomsa", `select busynes.set_group_shares('${F}', 'everyone', '[{"partner_id":"${nomsaM}","share":1}]'::jsonb)`)) !== null && (await h.err("nomsa", `select busynes.delete_business('${F}', 'Fat Cook')`)) !== null, "a partner can't invite, change ownership or delete the business");
T.ok((await one("nomsa", `select busynes.add_product('${F}', 'Wings', 60, 'everyone') id`)).id.length > 0, "a partner can add products");
await q("zinhle", `select busynes.add_stock_move('${F}', '${burger}', 'count', 20)`);
T.ok((await one("zinhle", `select qty from busynes.stock_levels('${F}') where product_id = '${burger}'`)).qty === 20, "staff can update stock: 20 burgers");
T.ok((await one("zinhle", `select qty from busynes.stock_levels('${F}') where product_id = '${chips}'`)).qty === null, "chips aren't tracked: no stock number");

// ============================================================ D. money in a 65/35 business
T.section("D. Money: a 65% owner and a 35% partner");
await sale("zinhle", F, [{ product_id: burger, qty: 2 }], ziM);          // R90, cash, held by Zinhle (staff)
let mT = await money("thabo", F), mN = await money("nomsa", F), mZ = await money("zinhle", F);
T.ok(lines(mT).join() === "Zinhle>Thabo:58.50", "Zinhle is holding R90 of the business's money: she owes Thabo R58.50 (65%)...");
T.ok(lines(mN).join() === "Zinhle>Nomsa:31.50", "...and Nomsa R31.50 (35%): two lines, not 'all his'");
T.ok(lines(mZ).sort().join() === "Zinhle>Nomsa:31.50,Zinhle>Thabo:58.50", "Zinhle sees her own two payments to make");
T.ok(T.near(mT.due, 58.5) && T.near(mN.due, 31.5) && T.near(mZ.due, 0) && T.near(mZ.received, 90), "shares collected: Thabo 58.50, Nomsa 31.50; Zinhle received 90 and owns nothing");
await sale("nomsa", F, [{ product_id: chips, qty: 10 }], nomsaM);          // R200 held by Nomsa
mT = await money("thabo", F); mN = await money("nomsa", F);
T.ok(lines(mT).join() === "Nomsa>Thabo:98.50,Zinhle>Thabo:90.00" || lines(mT).join() === "Nomsa>Thabo:98.50,Zinhle>Thabo:90.00".split(",").sort().join(), "after Nomsa also takes R200: she owes Thabo R98.50 (her R200 less her own 35% of R290), Zinhle owes Thabo R90: " + lines(mT).join(" | "));
T.ok((await money("nomsa", F)).pays.length === 1 && lines(mN).join() === "Nomsa>Thabo:98.50", "Nomsa sees only the line she is part of");

T.section("D1b. 'Settle as one team' is an option, off by default");
await q("thabo", `select busynes.update_business('${F}', null, null, null, true)`);
T.ok(lines(await money("thabo", F)).join() === "Zinhle>Nomsa & Thabo:90.00" && lines(await money("nomsa", F)).join() === "Zinhle>Nomsa & Thabo:90.00", "turned on: Thabo and Nomsa settle as one team, so Zinhle just pays the team R90 (their own 65/35 split is then theirs to sort out)");
await q("thabo", `select busynes.update_business('${F}', null, null, null, false)`);
T.ok(lines(await money("thabo", F)).join() === "Nomsa>Thabo:98.50,Zinhle>Thabo:90.00", "turned off again: individual lines");

T.section("D2. Shared mode: partners see the money; private mode: only the people involved");
await sale("zinhle", F, [{ product_id: burger, qty: 2 }], ziM, { note: "Zola", paid: 20, due: "2026-12-01" });   // R70 owed
T.ok((await rows("nomsa", `select * from busynes.my_debts('${F}')`)).some(d => d.customer === "Zola" && T.near(d.outstanding, 70)), "shared mode: Nomsa (partner) sees Zola's R70 debt recorded by staff");
T.ok((await rows("thabo", `select * from busynes.sales_timeline('${F}')`)).filter(r => r.note === "Zola").every(r => r.whole === true), "...and the owner sees the whole sale");
const nomsaSale = (await rows("zinhle", `select * from busynes.sales_timeline('${F}')`)).find(r => r.recorded_by === nomsaM);
T.ok(nomsaSale && nomsaSale.whole === false && nomsaSale.total === null && nomsaSale.items.every(i => i.price === null), "staff can't see the money on Nomsa's sale (not theirs)");
await q("thabo", `select busynes.update_business('${F}', null, null, 'private')`);
T.ok(!(await rows("nomsa", `select * from busynes.my_debts('${F}')`)).some(d => d.customer === "Zola"), "private mode: Nomsa no longer sees Zola's debt");
T.ok((await rows("zinhle", `select * from busynes.my_debts('${F}')`)).some(d => d.customer === "Zola"), "...but Zinhle, who recorded it, still does");
T.ok((await h.err("thabo", `select busynes.update_business('${F}', null, null, 'whatever')`)) !== null, "an unknown privacy setting is refused");
await q("thabo", `select busynes.update_business('${F}', null, null, 'shared')`);

// ============================================================ E. ownership
T.section("E. Changing who owns what");
T.ok((await h.err("thabo", `select busynes.set_group_shares('${F}', 'everyone', '[{"partner_id":"${nomsaM}","share":0.5}]'::jsonb)`)) !== null, "shares that add up to 50% are refused");
T.ok((await h.err("thabo", `select busynes.set_group_shares('${F}', 'everyone', '[{"partner_id":"${ziM}","share":1}]'::jsonb)`)) !== null, "staff can't own a share");
const thM = (await one("thabo", `select id from busynes.partners where business_id = '${F}' and role = 'owner'`)).id;
await q("thabo", `select busynes.set_group_shares('${F}', 'everyone', '[{"partner_id":"${thM}","share":0.5},{"partner_id":"${nomsaM}","share":0.5}]'::jsonb)`);
T.ok(T.near((await money("nomsa", F)).due, 0.5 * (90 + 200 + 20)), "ownership changed to 50/50 applies to everything collected so far: Nomsa's share is now R155");
T.ok((await h.err("thabo", `select busynes.update_member('${F}', '${nomsaM}', 'staff')`)) !== null, "a partner with a share can't be turned into staff");
T.ok((await h.err("thabo", `select busynes.remove_member('${F}', '${nomsaM}')`)) !== null, "...or removed, until she is taken out of the ownership group");
T.ok((await h.err("thabo", `select busynes.remove_member('${F}', '${thM}')`)) !== null && (await h.err("thabo", `select busynes.update_member('${F}', '${thM}', 'staff')`)) !== null, "the owner can't be removed or demoted");
await q("thabo", `select busynes.set_group_shares('${F}', 'drinks', '[{"partner_id":"${nomsaM}","share":1}]'::jsonb)`);
const drink = (await one("thabo", `select busynes.add_product('${F}', 'Cola', 15, 'drinks') id`)).id;
T.ok((await h.err("thabo", `select busynes.delete_group('${F}', 'drinks')`)) !== null, "a group that still has products can't be deleted");
await sale("zinhle", F, [{ product_id: drink, qty: 4 }], ziM);   // R60, all Nomsa's
T.ok((await money("nomsa", F)).sold.some(s => s.name === "Cola" && T.near(s.my_share, 60)) && !(await money("thabo", F)).sold.some(s => s.name === "Cola"), "a second group works: the Cola money is 100% Nomsa's, Thabo has no share in it");

// ============================================================ F. orders and notifications
T.section("F. Orders, delivery and notifications");
const ord = (await one("nomsa", `select busynes.create_order('${F}', 'Lerato', '[{"product_id":"${burger}","qty":2}]'::jsonb, 'gate 4') id`)).id;
const inbox = async w => (await rows(w, "select * from busynes.notifications where business_id = '" + F + "'")).map(n => n.title);
T.ok((await inbox("sipho")).some(t => /New order from Lerato/.test(t)) && (await inbox("thabo")).some(t => /New order from Lerato/.test(t)) && !(await inbox("nomsa")).some(t => /New order from Lerato/.test(t)), "everyone but the person who added it is told about the order, delivery included");
await q("sipho", `select busynes.claim_order(${ord})`);
T.ok((await inbox("zinhle")).some(t => /Sipho is on it/.test(t)), "'Sipho is on it' reaches the others");
T.ok((await h.err("zinhle", `select busynes.claim_order(${ord})`))?.includes("Sipho is already on this order"), "a second person can't take it");
T.ok((await h.err("sipho", `select busynes.cancel_order(${ord})`)) !== null, "delivery can't cancel orders");
await sale("zinhle", F, [{ product_id: burger, qty: 2 }], ziM, { order: ord });
T.ok((await one("sipho", `select status from busynes.orders where id = ${ord}`)).status === "done", "selling against the order completes it (delivery sees that)");
T.ok(!(await inbox("sipho")).some(t => /sold 2 × Burger|Your stock sold/.test(t)), "delivery gets no sale alerts");
T.ok((await inbox("thabo")).some(t => /Your stock sold: 2 × Burger/.test(t)), "owners and partners do");
await q("sipho", `select busynes.send_message('${F}', 'on my way')`);
T.ok((await rows("zinhle", `select * from busynes.messages where business_id = '${F}'`)).length === 1, "chat works for everyone in the business");
T.ok((await rows("mallory", "select * from busynes.messages")).length === 0, "...and nobody outside can read it");
// low stock only for tracked products
for (let i = 0; i < 9; i++) await sale("zinhle", F, [{ product_id: burger, qty: 2 }], ziM);   // 20 - 4 - 2... down towards 3
const low = (await rows("thabo", "select * from busynes.notifications where kind = 'stock'"));
T.ok(low.length === 1 && /Burger/.test(low[0].title), "a low-stock alert fires once for burgers");
await sale("zinhle", F, [{ product_id: chips, qty: 50 }], ziM);
T.ok((await rows("thabo", "select * from busynes.notifications where kind = 'stock'")).length === 1, "chips (not tracked) never raise one");

// ============================================================ G. phone & push
T.section("G. Phone numbers and phone notifications");
await q("nomsa", `select busynes.set_my_phone('082 111 2222')`);
T.ok((await rows("thabo", `select phone from busynes.partners where id = '${nomsaM}'`))[0].phone === "0821112222", "Nomsa's number is saved and visible to her co-workers");
T.ok((await rows("nomsa", `select phone from busynes.partners where id = '${nb}'`))[0].phone === "0821112222", "...saved on all her businesses at once");
T.ok((await h.err("thabo", `select busynes.set_my_phone('12')`)) !== null, "a bad number is refused");
await q("sipho", `select busynes.save_push_subscription('https://push.example/abc', 'k1', 'a1')`);
T.ok((await h.err("thabo", "select * from busynes.push_subscriptions")) !== null && (await h.err("sipho", "select * from busynes.push_subscriptions")) !== null, "nobody can read anyone's push subscriptions, not even their own");
T.ok((await db.query("select user_id from busynes.push_subscriptions")).rows[0].user_id === h.users.sipho.id, "a subscription belongs to the person's login (so it works for all their businesses)");
await q("thabo", `select busynes.remove_push_subscription('https://push.example/abc')`);
T.ok((await db.query("select count(*)::int c from busynes.push_subscriptions")).rows[0].c === 1, "one person can't remove another's");

// ============================================================ H. leaving, removing, deleting
T.section("H. Leave, remove, delete");
T.ok((await h.err("thabo", `select busynes.leave_business('${F}')`)) !== null, "the owner can't just leave");
T.ok((await h.err("nomsa", `select busynes.leave_business('${F}')`)) !== null, "a partner with a share must be taken out of the group first");
await q("sipho", `select busynes.leave_business('${F}')`);
T.ok((await rows("sipho", "select * from busynes.my_businesses()")).length === 0 && (await rows("sipho", "select * from busynes.orders")).length === 0, "Sipho leaves: he instantly loses access");
await q("thabo", `select busynes.remove_member('${F}', '${ziM}')`);
T.ok((await h.err("zinhle", bq.replace(siM, ziM))) !== null && (await rows("zinhle", "select id from busynes.sales")).length === 0, "removing Zinhle cuts her access immediately");
T.ok((await db.query(`select count(*)::int c from busynes.sales where recorded_by = '${ziM}'`)).rows[0].c > 0, "...but her past sales stay in the records");
T.ok((await h.err("thabo", `select busynes.delete_business('${F}', 'wrong name')`)) !== null, "deleting needs the exact business name");
T.ok((await h.err("nomsa", `select busynes.delete_business('${F}', 'Fat Cook')`)) !== null, "...and only the owner can");
await q("thabo", `select busynes.delete_business('${F}', ' fat COOK ')`);
let left = 0;
for (const t of ["partners", "owner_shares", "products", "stock_moves", "sales", "sale_items", "sale_payments", "settlements", "orders", "notifications", "messages"])
  left += (await db.query(`select count(*)::int c from busynes.${t} where business_id = '${F}'`)).rows[0].c;
T.ok(left === 0 && (await db.query(`select count(*)::int c from busynes.businesses where id = '${F}'`)).rows[0].c === 0, "deleting Fat Cook removes every trace of it");
T.ok((await rows("nomsa", `select * from busynes.sales_timeline('${N}')`)).length === 1 && (await rows("nomsa", "select * from busynes.my_businesses()")).length === 1, "Nomsa's own bakery is untouched");

// ============================================================ I. limits
T.section("I. Abuse limits");
await h.addUser("serial", "serial@x.com");
for (let i = 1; i <= 5; i++) await q("serial", `select busynes.create_business('Biz ${i}', '', '')`);
T.ok((await h.err("serial", `select busynes.create_business('Biz 6', '', '')`)) !== null, "one person can run at most 5 businesses");
T.ok((await h.err("thabo", `select busynes.create_business('', '', '')`)) !== null && (await h.err("thabo", `select busynes.create_business('${"x".repeat(61)}', '', '')`)) !== null, "business names must be 1 to 60 letters");
const S1 = (await rows("serial", "select id from busynes.my_businesses()"))[0].id;
for (let i = 0; i < 24; i++) await invite("serial", S1, `p${i}@y.com`, "P", "staff");
T.ok((await h.err("serial", `select busynes.invite_member('${S1}', 'one-too-many@y.com', 'P', 'staff')`)) !== null, "a business can have at most 25 people");

// ============================================================ J. profit
T.section("J. Profit: what things cost you");
for (const [n, e] of [["ola", "ola@x.com"], ["pat", "pat@x.com"], ["quin", "quin@x.com"], ["dee", "dee@x.com"]]) await h.addUser(n, e);
const PB = (await one("ola", `select busynes.create_business('Profit Shop', 'Retail', 'Ola') id`)).id;
const burgerP = (await one("ola", `select busynes.add_product('${PB}', 'Burger', 45, 'everyone', true, 20) id`)).id;
const chipsP = (await one("ola", `select busynes.add_product('${PB}', 'Chips', 20, 'everyone') id`)).id;       // no cost set yet
await invite("ola", PB, "pat@x.com", "Pat", "partner", "everyone", 0.35);
await invite("ola", PB, "quin@x.com", "Quin", "staff");
await invite("ola", PB, "dee@x.com", "Dee", "delivery");
const memberOf = async (who, biz) => (await rows(who, "select * from busynes.my_businesses()")).find(b => b.id === biz).member_id;
const olaM = await memberOf("ola", PB), quinM = await memberOf("quin", PB);
const profit = async (who, from = null) => (await one(who, `select busynes.my_profit($1::uuid, $2::timestamptz) p`, [PB, from])).p;
const costs = async who => Object.fromEntries((await rows(who, `select * from busynes.product_costs('${PB}')`)).map(r => [r.product_id, Number(r.cost)]));

await sale("quin", PB, [{ product_id: burgerP, qty: 4 }, { product_id: chipsP, qty: 5 }], quinM);   // burgers R180 (cost 80), chips R100 (no cost)
let po = await profit("ola"), pp = await profit("pat");
T.ok(T.near(po.revenue, 182) && T.near(po.costed_revenue, 117) && T.near(po.cost, 52) && T.near(po.profit, 65) && T.near(po.missing_revenue, 65),
  `Ola (65%): sold R182 of his share; burgers cost R52, profit R65; chips have no cost so R65 is left out (profit ${po.profit}, missing ${po.missing_revenue})`);
T.ok(T.near(pp.costed_revenue, 63) && T.near(pp.cost, 28) && T.near(pp.profit, 35) && T.near(pp.missing_revenue, 35), "Pat (35%): profit R35 on his share of the burgers");
T.ok(T.near(Number(po.profit) + Number(pp.profit), 4 * (45 - 20)), "the two shares add up to the real profit on 4 burgers (4 x R25 = R100)");
const prodRows = Object.fromEntries(po.products.map(r => [r.name, r]));
T.ok(prodRows.Burger.costed === true && T.near(prodRows.Burger.profit, 65) && prodRows.Chips.costed === false && prodRows.Chips.profit === null, "per product: burgers have a profit, chips say 'no cost set'");

T.section("J2. Costs stay private");
T.ok((await h.err("ola", "select cost from busynes.products")) !== null && (await h.err("pat", "select cost from busynes.sale_items")) !== null, "nobody can read cost prices straight from the tables, not even the owner");
T.ok((await h.err("quin", "select * from busynes.products")) !== null, "...so 'select everything' is refused too");
T.ok((await rows("quin", "select id, price from busynes.products where business_id = '" + PB + "'")).length === 2, "staff still see names and prices");
T.ok((await costs("ola"))[burgerP] === 20 && (await costs("pat"))[burgerP] === 20, "the owner and partners can read costs through product_costs()");
T.ok(Object.keys(await costs("quin")).length === 0 && Object.keys(await costs("dee")).length === 0, "staff and delivery get nothing from product_costs()");
for (const w of ["quin", "dee", "mallory"]) T.ok((await h.err(w, `select busynes.my_profit('${PB}')`)) !== null, `${w} can't ask for profit`);
T.ok((await h.err("quin", `select busynes.update_product('${burgerP}', null, null, null, null, 1)`)) !== null, "staff can't change a cost");
T.ok((await h.err("ola", `select busynes.update_product('${burgerP}', null, null, null, null, -5)`)) !== null, "a negative cost is refused");
T.ok((await h.err("thabo", `select busynes.my_profit('${PB}')`)) !== null && (await rows("thabo", `select * from busynes.product_costs('${PB}')`)).length === 0, "someone in another business gets nothing");

T.section("J3. Setting a cost fills in the past; changing it later doesn't");
await q("ola", `select busynes.update_product('${chipsP}', null, null, null, null, 8)`);
po = await profit("ola");
T.ok(T.near(po.missing_revenue, 0) && T.near(po.cost, 52 + 0.65 * 5 * 8) && T.near(po.profit, 65 + 0.65 * 5 * 12), "the first cost on chips (R8) also counts the chips already sold: profit now R104");
await q("ola", `select busynes.update_product('${burgerP}', null, null, null, null, 30)`);
po = await profit("ola");
T.ok(T.near(po.profit, 104), "raising the burger cost to R30 doesn't change sales already made");
await sale("quin", PB, [{ product_id: burgerP, qty: 1 }], quinM);
po = await profit("ola");
T.ok(T.near(po.profit, 104 + 0.65 * (45 - 30)), "...but the next burger is costed at R30");
await q("quin", `select busynes.add_stock_move('${PB}', '${burgerP}', 'add', 5, 99)`);
T.ok((await costs("ola"))[burgerP] === 30, "a delivery entered by staff can't change the cost");
await q("pat", `select busynes.add_stock_move('${PB}', '${burgerP}', 'add', 10, 25)`);
T.ok((await costs("ola"))[burgerP] === 25, "a partner entering a delivery can set what it cost (R25 each from now on)");
const stockNow = (await one("pat", `select qty from busynes.stock_levels('${PB}') where product_id = '${burgerP}'`)).qty;
T.ok(stockNow === 10, "both deliveries still added stock (5 + 10, minus the 5 burgers sold = 10)");

T.section("J4. Periods and loan fees");
const future = new Date(Date.now() + 864e5).toISOString();
const pf = await profit("ola", future);
T.ok(T.near(pf.revenue, 0) && T.near(pf.profit, 0) && pf.products.length === 0, "a period with no sales shows zero");
const lsale = await sale("ola", PB, [{ product_id: burgerP, qty: 1 }], olaM, { note: "Mpho", paid: 0, due: "2026-12-01", fee: 50, feeTo: olaM });
const beforeFees = Number((await profit("ola")).fees);
T.ok(beforeFees === 0, "a loan fee isn't counted as earned until the customer pays");
await q("ola", `select busynes.record_payment(${lsale}, 95, 'cash')`);
po = await profit("ola"); pp = await profit("pat");
T.ok(T.near(po.fees, 50) && T.near(pp.fees, 0), "once paid, the R50 loan fee is Ola's profit (not shared with Pat)");

// ============================================================ K. export (backup)
T.section("K. Download your data");
const exp = async who => (await one(who, `select busynes.export_data('${PB}') d`)).d;
await q("ola", `select busynes.record_sale('${PB}', '[{"product_id":"${burgerP}","qty":2}]'::jsonb, '${quinM}', 'cash', '=HYPERLINK("http://evil.example","click")')`);
const eo = await exp("ola"), ep = await exp("pat"), eq = await exp("quin"), ed = await exp("dee");
T.ok(eo.business.name === "Profit Shop" && eo.you.role === "owner" && eo.people.length === 4, "the owner's export names the business, their role and everyone in it");
T.ok(eo.people.every(p => p.email !== null && p.email !== undefined), "...with email addresses (owner only)");
T.ok(ep.people.every(p => p.email === null || p.email === undefined), "a partner's export has no email addresses");
T.ok(eo.products.length === 2 && eo.products.find(p => p.name === "Burger").cost !== null && ep.products.find(p => p.name === "Burger").cost !== null, "owners and partners get product costs");
T.ok(eq.products.length === 2 && eq.products.every(p => p.cost === null || p.cost === undefined), "staff get the product list but never a cost");
T.ok(eo.sales.length >= 4 && eo.sales.every(s => s.items.length > 0 && s.at), "the owner's export has every sale, with its items");
T.ok(eq.sales.some(s => s.total !== null) && eq.sales.some(s => s.total === null), "staff see money only on the sales they handled (the others have no total)");
T.ok(!JSON.stringify(eq).includes('"cost"') || eq.products.every(p => !p.cost), "no cost price appears anywhere in a staff export");
T.ok(ed.orders !== undefined && ed.sales === undefined && ed.products === undefined && ed.stock_changes === undefined, "delivery's export contains orders and people only: no sales, products or stock");
T.ok((await h.err("mallory", `select busynes.export_data('${PB}')`)) !== null && (await h.err("thabo", `select busynes.export_data('${PB}')`)) !== null, "people outside the business can't export it");
T.ok((await h.err("anon", `select busynes.export_data('${PB}')`)) !== null, "...and neither can a signed-out visitor");
T.ok(eo.sales.some(s => s.note.startsWith("=HYPERLINK")), "notes are exported exactly as typed (the app neutralises spreadsheet formulas when it writes the file)");
T.ok(eo.stock_changes.length >= 2 && eo.settle_ups !== undefined, "stock changes and settle-ups are included for people who can sell");
const bigBefore = JSON.stringify(eo).length;
T.ok(bigBefore > 500 && eo.exported_at, "the export is stamped with when it was made");

// ============================================================ L. currency
T.section("L. Each business has its own currency");
for (const [n, e] of [["cy", "cy@x.com"], ["cz", "cz@x.com"], ["kay", "kay@x.com"]]) await h.addUser(n, e);
const DB = (await one("cy", `select busynes.create_business('Dollar Shop', 'Retail', 'Cy', '$') id`)).id;
const KB = (await one("kay", `select busynes.create_business('Nairobi Duka', 'Retail', 'Kay', 'KSh') id`)).id;
const dflt = (await one("cz", `select busynes.create_business('Plain Shop', '', '') id`)).id;
const curOf = async (who, biz) => (await rows(who, "select * from busynes.my_businesses()")).find(b => b.id === biz).currency;
T.ok((await curOf("cy", DB)) === "$" && (await curOf("kay", KB)) === "KSh" && (await curOf("cz", dflt)) === "R", "a business keeps the symbol it was created with ($, KSh), and defaults to R");
T.ok((await h.err("cy", `select busynes.create_business('X', '', '', 'TOOLONG')`)) !== null, "a symbol longer than 4 characters is refused");
T.ok((await one("cy", `select busynes.create_business('Blank symbol', '', '', '') id`)).id.length === 36, "an empty symbol falls back to R");
T.ok((await h.err("cy", `select busynes.update_business('${DB}', null, null, null, null, 'WAYTOOLONG')`)) !== null && (await h.err("cz", `select busynes.update_business('${DB}', null, null, null, null, '€')`)) !== null, "only the owner can change it, and only to 1-4 characters");
const gum = (await one("cy", `select busynes.add_product('${DB}', 'Gum', 10.25, 'everyone') id`)).id;
await invite("cy", DB, "cz@x.com", "Cz", "staff");
const cyM = await memberOf("cy", DB), czM = await memberOf("cz", DB);
await sale("cz", DB, [{ product_id: gum, qty: 1 }], cyM, { note: "Zed", paid: 0, due: "2026-12-01" });
T.ok((await rows("cy", "select * from busynes.notifications where business_id = '" + DB + "' and kind = 'credit'")).some(n => /\$10\.25 · owes \$10\.25/.test(n.body)), "credit alerts use the business's symbol and show cents only when needed ($10.25)");
const cs2 = await sale("cz", DB, [{ product_id: gum, qty: 2 }], cyM, { note: "Yan", paid: 0, due: new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10) });   // today in South Africa (UTC+2)
T.ok((await rows("cy", "select * from busynes.notifications where kind = 'credit'")).some(n => /\$20\.5 · owes \$20\.5|\$20\.50 · owes \$20\.50/.test(n.body)), "...two gums are $20.50");
T.ok(/\(\$20\.50\)/.test((await h.err("cy", `select busynes.record_payment(${cs2}, 99, 'cash')`)) || ""), "an overpayment message names the amount in dollars: " + (await h.err("cy", `select busynes.record_payment(${cs2}, 99, 'cash')`)));
await q("cy", `select busynes.record_payment(${cs2}, 5, 'cash')`);
T.ok((await rows("cz", "select * from busynes.notifications where kind = 'payment'")).some(n => /Yan paid \$5/.test(n.title) && /\$15\.50 still owed/.test(n.body)), "payment alerts too ('Yan paid $5', '$15.50 still owed')");
const dueNow = (await db.query("select busynes.send_due_reminders() n")).rows[0].n;
T.ok(dueNow >= 1 && (await rows("cy", "select * from busynes.notifications where kind = 'reminder'")).some(n => /owes \$15\.50/.test(n.title)), "daily reminders use the business's symbol");
const kgum = (await one("kay", `select busynes.add_product('${KB}', 'Chai', 30, 'everyone') id`)).id;
const kayM = await memberOf("kay", KB);
await sale("kay", KB, [{ product_id: kgum, qty: 1 }], kayM, { note: "Wanjiru", paid: 0 });
await invite("kay", KB, "cz@x.com", "Cz", "staff");
await sale("cz", KB, [{ product_id: kgum, qty: 1 }], kayM, { note: "Otieno", paid: 0 });
T.ok((await rows("kay", "select * from busynes.notifications where business_id = '" + KB + "' and kind = 'credit'")).some(n => /KSh 30 · owes KSh 30/.test(n.body)), "a longer symbol gets a space: 'KSh 30'");
await q("cy", `select busynes.update_business('${DB}', null, null, null, null, '€')`);
T.ok((await curOf("cy", DB)) === "€" && (await one("cy", `select busynes.export_data('${DB}') d`)).d.business.currency === "€", "the owner can change it, and the backup file records it");

// ============================================================ M. sales that were made offline
T.section("M. Sales recorded offline");
for (const [n, e] of [["off", "off@x.com"], ["offstaff", "offstaff@x.com"]]) await h.addUser(n, e);
const OB = (await one("off", `select busynes.create_business('Offline Shop', '', 'Off') id`)).id;
const tea = (await one("off", `select busynes.add_product('${OB}', 'Tea', 20, 'everyone') id`)).id;
await invite("off", OB, "offstaff@x.com", "Staff", "staff");
const offM = await memberOf("off", OB), stM = await memberOf("offstaff", OB);
const REF = "11111111-1111-4111-8111-111111111111", REF2 = "22222222-2222-4222-8222-222222222222";
const sid1 = await sale("offstaff", OB, [{ product_id: tea, qty: 2 }], stM, { ref: REF });
const sid2 = await sale("offstaff", OB, [{ product_id: tea, qty: 2 }], stM, { ref: REF });
T.ok(sid1 === sid2, "the same sale sent twice (poor signal, retry) is recorded once and returns the same id");
T.ok((await db.query(`select count(*)::int c from busynes.sales where business_id = '${OB}'`)).rows[0].c === 1 && (await db.query(`select count(*)::int c from busynes.sale_payments where business_id = '${OB}'`)).rows[0].c === 1, "...with one sale and one payment, not two");
T.ok((await rows("off", "select * from busynes.notifications where kind = 'sale' and business_id = '" + OB + "'")).length === 1, "...and the owner is told once");
T.ok((await h.err("off", `select busynes.record_sale('${OB}', '[{"product_id":"${tea}","qty":1}]'::jsonb, '${offM}', 'cash', '', null, null, null, 0, null, '${REF}', null)`)) !== null, "someone else can't reuse another person's reference to read or clash with their sale");
const twoH = new Date(Date.now() - 2 * 3600e3).toISOString();
const sid3 = await sale("offstaff", OB, [{ product_id: tea, qty: 1 }], stM, { ref: REF2, at: twoH });
const at3 = (await db.query(`select at from busynes.sales where id = ${sid3}`)).rows[0].at;
T.ok(Math.abs(new Date(at3) - new Date(twoH)) < 2000, "a sale made 2 hours ago (offline) keeps the time it really happened");
const pay3 = (await db.query(`select at from busynes.sale_payments where sale_id = ${sid3}`)).rows[0].at;
T.ok(Math.abs(new Date(pay3) - new Date(twoH)) < 2000, "...and so does its payment");
const sidF = await sale("offstaff", OB, [{ product_id: tea, qty: 1 }], stM, { at: new Date(Date.now() + 3 * 864e5).toISOString() });
T.ok(Math.abs(new Date((await db.query(`select at from busynes.sales where id = ${sidF}`)).rows[0].at) - Date.now()) < 5000, "a time in the future is ignored (now is used)");
const sidO = await sale("offstaff", OB, [{ product_id: tea, qty: 1 }], stM, { at: new Date(Date.now() - 20 * 864e5).toISOString() });
T.ok(Math.abs(new Date((await db.query(`select at from busynes.sales where id = ${sidO}`)).rows[0].at) - Date.now()) < 5000, "a time more than 14 days ago is ignored too");
await q("off", `select busynes.mark_settled('${OB}')`);
const before = await money("off", OB, (await db.query(`select max(at) a from busynes.settlements where business_id = '${OB}'`)).rows[0].a);
const sidS = await sale("offstaff", OB, [{ product_id: tea, qty: 3 }], stM, { at: twoH });   // made before the settle-up, sent after it
const atS = (await db.query(`select at from busynes.sales where id = ${sidS}`)).rows[0].at;
const lastSettle = (await db.query(`select max(at) a from busynes.settlements where business_id = '${OB}'`)).rows[0].a;
T.ok(new Date(atS) > new Date(lastSettle), "a sale made before the last settle-up but sent after it is counted as new: settled money can't change");
const after = await money("off", OB, lastSettle);
T.ok(T.near(after.due - before.due, 60) || T.near(Number(after.due), 60), "...so its R60 shows up in the new period: " + after.due);
T.ok(await h.err("offstaff", `select busynes.record_sale('${OB}', '[{"product_id":"${tea}","qty":1}]'::jsonb, '${stM}', 'cash', '', null, null, null, 0, null, '33333333-3333-4333-8333-333333333333', 'not a time'::timestamptz)`) !== null, "a garbage time is rejected");

// ============================================================ N. deleting your account
T.section("N. Delete your own account");
for (const [n, e] of [["gone", "gone@x.com"], ["boss", "boss@x.com"], ["solo", "solo@x.com"]]) await h.addUser(n, e);
const GB = (await one("boss", `select busynes.create_business('Boss Biz', '', 'Boss') id`)).id;
await invite("boss", GB, "gone@x.com", "Gone", "staff");
await invite("boss", GB, "later@x.com", "Later", "partner", "everyone", 0.2);     // someone not signed up yet
const goneM = await memberOf("gone", GB);
const gp = (await one("boss", `select busynes.add_product('${GB}', 'Item', 10, 'everyone') id`)).id;
await sale("gone", GB, [{ product_id: gp, qty: 1 }], goneM);
await q("gone", `select busynes.send_message('${GB}', 'my last message')`);
await q("gone", `select busynes.save_push_subscription('https://push.example/gone', 'k', 'a')`);
await q("gone", `select busynes.set_my_phone('0821234567')`);
const own = (await one("solo", `select busynes.create_business('Solo Biz', '', 'Solo') id`)).id;
await invite("solo", own, "gone@x.com", "Gone", "partner", "everyone", 0.3);
const gonePartnerM = await memberOf("gone", own);
T.ok((await h.err("gone", `select busynes.delete_account()`)) !== null && /Ask the owner of Solo Biz/.test((await h.err("gone", `select busynes.delete_account()`)) || ""), "a partner who owns a share can't vanish: 'Ask the owner of Solo Biz to take you out...'");
await q("solo", `select busynes.set_group_shares('${own}', 'everyone', '[{"partner_id":"${await memberOf("solo", own)}","share":1}]'::jsonb)`);
await q("solo", `select busynes.remove_member('${own}', '${gonePartnerM}')`);
T.ok((await h.err("boss", `select busynes.delete_account()`)) !== null && /You run Boss Biz/.test((await h.err("boss", `select busynes.delete_account()`)) || ""), "an owner must delete the business first, or choose to delete it with the account");
T.ok((await h.err("anon", `select busynes.delete_account()`)) !== null, "a signed-out visitor can't call it");
await q("gone", `select busynes.delete_account()`);
T.ok((await db.query("select count(*)::int c from auth.users where email = 'gone@x.com'")).rows[0].c === 0, "the login itself is deleted");
const goneRow = (await db.query(`select name, email, phone, status, user_id from busynes.partners where id = '${goneM}'`)).rows[0];
T.ok(goneRow.name === "Former member" && goneRow.email === null && goneRow.phone === null && goneRow.status === "removed" && goneRow.user_id === null, "their name, email and phone are wiped from the business's records");
T.ok((await db.query(`select count(*)::int c from busynes.sales where recorded_by = '${goneM}'`)).rows[0].c === 1, "...but the sale they made stays in the books (as 'Former member')");
T.ok((await db.query(`select count(*)::int c from busynes.notifications where partner_id = '${goneM}'`)).rows[0].c === 0 && (await db.query("select count(*)::int c from busynes.push_subscriptions where endpoint = 'https://push.example/gone'")).rows[0].c === 0, "their alerts and phone subscriptions are deleted");
T.ok((await rows("boss", "select * from busynes.notifications where title like '%deleted their account%'")).length === 1, "the owner is told");
T.ok((await h.err("gone", `select busynes.create_business('Ghost', '', '')`)) !== null && (await rows("gone", "select * from busynes.my_businesses()")).length === 0, "a leftover login token can't start a business or see anything");
const GP = (await h.err("boss", `select busynes.delete_account(true)`));
T.ok(GP === null, "an owner who chooses to can delete their businesses together with the account: " + GP);
T.ok((await db.query(`select count(*)::int c from busynes.businesses where id = '${GB}'`)).rows[0].c === 0 && (await db.query(`select count(*)::int c from busynes.partners where business_id = '${GB}'`)).rows[0].c === 0, "...and the business and everyone's place in it are gone");
T.ok((await db.query("select count(*)::int c from busynes.partners where lower(email) = 'later@x.com'")).rows[0].c === 0, "(an invitation to someone else was removed with that business)");

process.exit(T.done());

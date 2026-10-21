import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
import crypto from "crypto";

import { fileURLToPath } from "url";
export const HERE = fileURLToPath(new URL(".", import.meta.url));
export const ROOT = HERE + "../supabase/";
export const read = p => fs.readFileSync(p, "utf8");

export async function makeDb() {
  const db = new PGlite();
  // A stand-in for Supabase: roles, auth.users, auth.uid() and auth.jwt() reading the request claims.
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub', '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.jwt() to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `);
  const users = {};
  const h = {
    db, users,
    async addUser(name, email, confirmed = true) {
      const id = crypto.randomUUID();
      users[name] = { id, email };
      await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)", [id, email, confirmed ? new Date().toISOString() : null]);
      return id;
    },
    // run SQL as a signed-in person (or as anon / nobody)
    async as(name, sql, params) {
      if (name === "anon") {
        await db.exec("set role anon");
      } else {
        const u = users[name]; if (!u) throw new Error("no such user " + name);
        await db.exec(`set role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: u.id, email: u.email })}', false);`);
      }
      try { return await db.query(sql, params); }
      finally { await db.exec("reset role; select set_config('request.jwt.claims', '', false);"); }
    },
    async err(name, sql, params) { try { await h.as(name, sql, params); return null; } catch (e) { return e.message; } },
    async val(name, sql, params) { const r = await h.as(name, sql, params); const row = r.rows[0]; return row ? Object.values(row)[0] : undefined; },
  };
  return h;
}

export function reporter() {
  const r = { pass: 0, fail: 0, fails: [] };
  r.ok = (c, m) => { if (c) { r.pass++; console.log("  ok   " + m); } else { r.fail++; r.fails.push(m); console.log("  FAIL " + m); } };
  r.near = (a, b) => Math.abs(Number(a) - b) < 0.011;
  r.section = t => console.log("\n" + t);
  r.done = () => { console.log(`\n${r.pass} passed, ${r.fail} failed`); if (r.fail) console.log("FAILED:\n - " + r.fails.join("\n - ")); return r.fail ? 1 : 0; };
  return r;
}

// Sends a phone notification (Web Push) whenever a row is added to busynes.notifications.
// Triggered by a Database Webhook (see README, "Phone notifications").
//
// Secrets this function needs (Edge Functions > Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@example.com), WEBHOOK_SECRET
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const KIND_TAB: Record<string, string> = {
  sale: "sales", credit: "owed", payment: "owed", reminder: "owed",
  order: "orders", chat: "team", call: "team", stock: "stock",
};

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "busynes" }, auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  // Only our own webhook knows this secret.
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("WEBHOOK_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  let payload: any;
  try { payload = await req.json(); } catch { return new Response("bad request", { status: 400 }); }
  const n = payload?.record;
  if (payload?.type !== "INSERT" || !n?.partner_id) return new Response("ignored", { status: 200 });

  const { data: subs, error } = await db
    .from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("partner_id", n.partner_id);
  if (error) return new Response("db error: " + error.message, { status: 500 });

  const message = JSON.stringify({
    title: n.title,
    body: n.body ?? "",
    tab: KIND_TAB[n.kind] ?? "sell",
    tag: `${n.kind}-${n.ref ?? n.id}`,
  });

  let sent = 0;
  const dead: number[] = [];
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, message);
      sent++;
    } catch (e: any) {
      // 404/410 = the phone unsubscribed or the app was removed: forget it.
      if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.id);
      else console.error("push failed", e?.statusCode, e?.body);
    }
  }));
  if (dead.length) await db.from("push_subscriptions").delete().in("id", dead);
  return new Response(JSON.stringify({ sent, removed: dead.length }), { status: 200 });
});

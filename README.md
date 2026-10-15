# BusyNes

A phone app for Sibabalo, Vusi and Dokotela to record drink sales in a few taps, keep stock up to date, and see their own side of the money.

- **Sell:** tap drinks, choose who got the money (cash or into their account), save.
- **Stock:** goes down with every sale. Add deliveries or do a fridge count.
- **Sales:** each partner sees sales paid to them, sales they recorded, and sales of their own products.
- **My money:** what you received, what your stock sold for, and who owes whom. You never see another partner's totals.

Privacy is enforced by the database, not just hidden on screen, so it holds even if someone pokes at the app.

## What's in the folder

| File | What it is |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app itself (plain HTML, CSS and JavaScript, no build step) |
| `config.js` | Where you paste your Supabase URL and key |
| `supabase/schema.sql` | Creates the tables, privacy rules and money calculations |
| `supabase/seed.sql` | The three partners, who owns what, and the 10 products with prices |
| `supabase/reminders.sql` | Schedules the daily due-date reminders |
| `supabase/functions/send-push/` | Sends phone notifications (Supabase Edge Function) |
| `scripts/build-dist.ps1` | Packs just the public files for upload |
| `manifest.webmanifest`, `sw.js`, `icons/` | Makes it installable on a phone with its own icon |
| `vendor/supabase.js` | The Supabase library (v2.45.4), included so nothing else needs downloading |

## 1. Open it in VS Code

1. Get the code: `git clone https://github.com/Ngandana/BusiNes.git`
2. In VS Code: **File > Open Folder…** and pick the cloned folder.
3. Install the **Live Server** extension (by Ritwick Dey) from the Extensions panel.

## 2. Set up the database (free, about 10 minutes)

1. Create a free account at https://supabase.com and click **New project**. Pick a region close to South Africa.
2. In the project, open **SQL Editor > New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open `supabase/seed.sql` in VS Code and replace the three `@example.com` emails with the real emails each partner will sign in with. Paste it into a new query and click **Run**.
4. Go to **Project Settings > API** (or **Integrations > Data API**) and add `busynes` to **Exposed schemas**. BusyNes keeps all its tables in its own `busynes` schema, so it can share a project with another app.
5. On the same page, copy the **Project URL** and the **anon public** key into `config.js`. Never put the **service_role** key there: it skips all the privacy rules, and `config.js` is public.
6. Keep **Confirm email** turned on (Authentication > Sign In / Providers > Email). Without it, anyone who knows a partner's email could create that partner's login before they do.
7. Once all three partners have created their logins, turn off **Allow new users to sign up** in the same settings. Nobody else needs an account.

## 3. Run it on your computer

Right-click `index.html` in VS Code and choose **Open with Live Server**. It opens in your browser. Tap **First time? Create my login**, using one of the three emails from `seed.sql`.

## 4. Put it online so all three phones can use it

The app is just files, so any free static host works.

**Option A: Netlify Drop (no GitHub needed)**
1. In PowerShell, from this folder, run: `powershell -ExecutionPolicy Bypass -File scripts/build-dist.ps1`
   This copies only the public files into a `dist` folder and refuses to continue if it finds a service key.
2. Go to https://app.netlify.com/drop and drag the **`dist`** folder onto the page (not the whole project folder: that holds `.env.local` with your secrets).
3. You get a link like `https://busynes-xyz.netlify.app`. Updating later: run the script again and drop the new `dist` onto the same site.

**Option B: GitHub Pages**
In the repo, go to **Settings > Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`. The link will be `https://ngandana.github.io/BusiNes/`. Free GitHub accounts need the repo to be public. That is fine because secrets are git-ignored, but see "Before you push" below.

**Then, in Supabase** (**Authentication > URL Configuration**):
- Set **Site URL** to your live link.
- Add the live link followed by `/**` under **Redirect URLs** (e.g. `https://busynes-xyz.netlify.app/**`).
- Keep `http://127.0.0.1:5500/**` there too so Live Server keeps working.

Confirmation and password-reset emails then bring people back to the live app.

**Before you push to a public repo:** `supabase/seed.sql` contains the partners' real emails. Put the `@example.com` placeholders back (or keep the real file out of git) so nobody's email is published.

## 5. Install it on each phone

Open the link on the phone, then:
- **Android (Chrome):** menu ⋮ > **Add to Home screen** (or **Install app**).
- **iPhone (Safari):** Share button > **Add to Home Screen**.

It now opens like a normal app with the BusyNes icon. On Android you can also tap your name at the top of the app and choose **Install BusyNes on this phone**.

**Forgot your password?** Tap **Forgot my password** on the sign-in screen. The link in the email lets you choose a new one. You can also change it any time from your name at the top of the app.

## 6. Credit, orders, alerts and calling (version 2)

**What it does**
- **Part payments and credit:** when saving a sale, choose **Paid part** or **On credit**, type the customer's name and the date they promised. The **Owed** tab lists who owes what, sorted by date. Tap **Got payment** when they pay (partial payments are fine) and **Copy reminder** for a ready-to-send message.
- **How the money works:** a partner's share is counted when money is actually collected, so an unpaid R20 doesn't show up as anyone's money until the customer pays it.
- **Orders:** when someone asks for drinks, add them on the **Orders** tab. Everyone is notified. **Sell this** fills the Sell cart and ticks the order off when you save.
- **Alerts:** the bell shows sales paid to you or your stock sold, new orders, payments, due-date reminders, low stock and messages. Each partner only gets what they are allowed to see.
- **Team:** the phone icon opens Call and WhatsApp buttons, **Ask to call me** (sends an alert), and a small group chat.

**One-time setup for these (about 15 minutes)**
1. **Database:** open `supabase/schema.sql`, paste it in the Supabase SQL Editor and run it again. It keeps all your data and backfills every existing sale as fully paid.
2. **Daily reminders:** run `supabase/reminders.sql` in the SQL Editor (uses pg_cron, free).
3. **Phone notifications** (optional but recommended):
   - In Supabase go to **Edge Functions > Deploy a new function > Via Editor**, name it `send-push`, paste `supabase/functions/send-push/index.ts`, and deploy.
   - In the function's settings, turn **Verify JWT** off (it checks its own secret instead).
   - Under **Edge Functions > Secrets**, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and `WEBHOOK_SECRET`. Their values are in your local `.env.local`.
   - Under **Integrations > Database Webhooks**, create a webhook: table `notifications` in schema `busynes`, event **Insert**, type **Supabase Edge Functions**, function `send-push`, plus an HTTP header `x-webhook-secret` set to your `WEBHOOK_SECRET`.
4. **Redeploy the app** (`scripts/build-dist.ps1`, then drop `dist` onto the site's **Deploys** tab).
5. **Each partner:** open the app, tap the bell, tap **Turn on phone notifications**, and save their phone number on the Team page. On iPhone the app must be added to the Home Screen first (iOS 16.4 or newer).

**Good to know**
- Phone notifications can arrive a little late and are not guaranteed, which is how every web app works. The bell always has the full list.
- A partner who isn't involved in a sale never sees its customer name or amounts, in the bell or on their phone.
- The Call button uses your phone's normal dialler (it costs airtime like any call). WhatsApp opens a chat with that person; tap the call icon there to ring over WhatsApp.

## Changing things later

- **Prices and products:** change them in the app on the Stock tab. Which partner owns a product can't be changed from the app (so nobody can move someone else's drinks to their own name); change it in the `products` table in Supabase.
- **After changing the database files:** run `supabase/schema.sql` again. It is safe to re-run and keeps your data.- **Who owns what share:** edit the `owner_shares` table in Supabase (**Table Editor**). The beers are set to 50/50 between Vusi and Dokotela.
- **A partner's email:** edit the `partners` table.

## What each partner can see

| | Sibabalo | Vusi | Dokotela |
| --- | --- | --- | --- |
| Products, prices, stock levels | yes | yes | yes |
| A sale paid to them or recorded by them | whole sale | whole sale | whole sale |
| Someone else's sale that includes their product | their items only | their items only | their items only |
| Their own money received and stock sold | yes | yes | yes |
| Another partner's totals | no | no | no |
| Settle-up payments they're part of | yes | yes | yes |

Stock levels are shared because everyone needs to see what's in the fridge. That means someone could work out roughly how many of another partner's drinks sold, but not who was paid or how much each person holds.

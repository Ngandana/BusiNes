# BusyNes

A phone app for running a small business with the people you work with: record sales in a few taps, keep stock up to date, take orders, track who owes you, and see exactly who gets what.

Anyone can create their own business, invite their partners and staff, and set who owns how much. Every business is completely private to the people in it.

## What it does

- **Sell:** tap items, choose who got the money (cash or into an account), save. Part payments, credit, and loans with a fee are built in.
- **Orders:** write down what people ask for. Everyone is told. **I'll take it** stops two people chasing the same order. **Sell this** turns an order into a sale.
- **Owed:** who owes what and by when, with reminders and a ready-to-send message.
- **Stock:** goes down with every sale. Add deliveries or do a stock count. Items made to order can skip stock counting.
- **Money:** each person's share is worked out from what was actually collected, and the settle-up says who pays whom.
- **Alerts and calling:** a bell, phone notifications, call and WhatsApp buttons, and a small team chat.
- **Many businesses:** one login can belong to several businesses (for example your own, and one where you're a partner) and switch between them.

## Who can do what

| | Owner | Partner | Staff | Delivery |
| --- | --- | --- | --- | --- |
| Record sales, orders, take payments | yes | yes | yes | no |
| Update stock | yes | yes | yes | no |
| Add products, change prices | yes | yes | no | no |
| Mark everything as settled | yes | yes | no | no |
| See own money and settle-up | yes | yes | yes | yes |
| See ownership percentages | yes | yes | no | no |
| Invite and remove people, change roles and ownership, rename or delete the business | yes | no | no | no |
| See orders, take them, chat | yes | yes | yes | yes |

Inside a business everyone who can sell sees **what** was sold, **when**, **who** sold it, where the money went and the note. Amounts, credit, loan fees and who owes what are shown only to whoever handled the sale, and to owners and partners if the owner chooses "everyone sees everything" in settings.

## How privacy works

- Every table is tied to a business, and the database only returns rows for businesses the signed-in person belongs to. This is enforced inside the database (row level security), not just hidden in the app.
- The app can only **read** a few tables. Every change goes through functions that check the person's business and role first.
- Email addresses and login ids of other people can't be read from the API. Only the owner sees member emails, through `list_members()`.
- There is no admin screen in the app. **Be honest with testers about one limit:** whoever administers the Supabase project can technically reach the stored data, as with almost any app. `privacy.html` says so in plain words.
- Invitations are tied to a verified email address. Keep **Confirm email** turned on (see setup), otherwise someone could register an address that isn't theirs and claim an invitation meant for another person.

## What's in the folder

| File | What it is |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app itself (plain HTML, CSS and JavaScript, no build step) |
| `privacy.html` | The plain-language privacy page the app links to |
| `config.js` | Where you paste your Supabase URL and key |
| `supabase/schema.sql` | Creates (or upgrades) the whole database: tables, privacy rules, roles, money calculations |
| `supabase/reminders.sql` | Schedules the daily due-date reminders |
| `supabase/functions/send-push/` | Sends phone notifications (Supabase Edge Function) |
| `supabase/seed.sql` | Only for the original three-partner BusyNes. No longer needed: new businesses are created in the app |
| `scripts/build-dist.ps1` | Packs just the public files for upload |
| `tests/` | Automated checks for the database rules and the app (see below) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Makes it installable on a phone with its own icon |
| `vendor/supabase.js` | The Supabase library, included so nothing else needs downloading |

## 1. Open it in VS Code

1. Get the code: `git clone https://github.com/Ngandana/BusiNes.git`
2. In VS Code: **File > Open Folder…** and pick the cloned folder.
3. Install the **Live Server** extension (by Ritwick Dey).

## 2. Set up the database (new project, about 15 minutes)

1. Create a free account at https://supabase.com and click **New project**.
2. **SQL Editor > New query**, paste all of `supabase/schema.sql`, click **Run**. It is safe to run again later.
3. **Project Settings > API** (or **Integrations > Data API**): add `busynes` to **Exposed schemas**.
4. On the same page copy the **Project URL** and the **anon public** key into `config.js`. Never put the **service_role** key there: it skips all the privacy rules, and `config.js` is public.
5. **Authentication > Sign In / Providers > Email:** keep **Confirm email ON** and **Allow new users to sign up ON** (anyone can create a business now).
6. **Email delivery (important before inviting people).** Supabase's built-in email sender only allows a handful of emails per hour, so a few people signing up at once will be blocked. In **Authentication > Emails > SMTP Settings** switch on custom SMTP with a free sender (for example Brevo, Resend or Mailgun), verify your sender address, and paste its SMTP details. Do this before sharing the app with anyone.
7. **Authentication > URL Configuration:** set **Site URL** to your live link and add `<link>/**` and `http://127.0.0.1:5500/**` under **Redirect URLs**.

## 3. Upgrading an existing single-business BusyNes (version 2 → 3)

Running the new `schema.sql` on your existing database:

- **Copies everything first** into a private `busynes_backup` schema (not visible to the app).
- Turns your current partners, sales, stock, orders and settle-ups into the first business, **BusyNes**, keeping every sale and balance exactly as they were (the original three-partner behaviour is preserved: private money mode, partners who share stock settle up as one team).
- Makes Sibabalo the owner and Vusi and Dokotela partners, linking each to their login by email. Anyone who hasn't signed up yet shows as invited and joins automatically when they do.
- Is safe to run twice.

Do it in this order: **1)** run `schema.sql` in the SQL Editor, **2)** redeploy the app (`dist`), **3)** update the `send-push` function (paste the new `supabase/functions/send-push/index.ts` over the old one and deploy). The `reminders.sql` job and the database webhook keep working as they are.

## 4. Run it on your computer

Right-click `index.html` in VS Code and choose **Open with Live Server**.

## 5. Put it online

**Option A: Netlify Drop (no GitHub needed)**
1. Run `powershell -ExecutionPolicy Bypass -File scripts/build-dist.ps1`. It copies only the public files into `dist` and stops if it finds a service key.
2. Drag the **`dist`** folder onto https://app.netlify.com/drop (never the whole project folder: it holds `.env.local` with secrets). To update later, drop the new `dist` onto the site's **Deploys** tab so the link stays the same.
3. In the site's visibility settings make sure the site is **public** (the default for new team sites can be private).

**Option B: GitHub Pages:** repo **Settings > Pages**, deploy from branch `main`, `/ (root)`. Needs a public repo on a free account.

## 6. Install it on each phone

- **Android (Chrome):** menu ⋮ > **Add to Home screen**, or tap your name in the app and choose **Install BusyNes on this phone**.
- **iPhone (Safari):** Share button > **Add to Home Screen**.

## 7. Phone notifications (optional, recommended)

1. **Edge Functions > Deploy a new function > Via Editor**, name it `send-push`, paste `supabase/functions/send-push/index.ts`, deploy. In its settings turn **Verify JWT** off (it checks its own secret).
2. **Edge Functions > Secrets:** add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and `WEBHOOK_SECRET`. Put the public key in `config.js` as `VAPID_PUBLIC_KEY` too.
3. **Integrations > Database Webhooks:** table `notifications` in schema `busynes`, event **Insert**, type **Supabase Edge Functions**, function `send-push`, with an HTTP header `x-webhook-secret` equal to your `WEBHOOK_SECRET`.
4. Run `supabase/reminders.sql` once for daily due-date reminders (uses pg_cron, free).
5. Each person taps the bell and **Turn on phone notifications**. On iPhone the app must be on the Home Screen first (iOS 16.4 or newer).

Phone notifications can arrive a little late and are not guaranteed. The bell always has the full list.

## How the money works

- A sale's money is shared between the **owners of what was sold**, by their percentages. A partner on 35% gets 35% of the sales; whoever physically holds the cash owes the others their parts, so nobody's cut ever looks like it's all theirs.
- Money counts when it is **actually collected**. A customer who still owes R20 doesn't make R20 anyone's money until they pay.
- A **loan fee** is added to what the customer owes and belongs to the lender, not the owners of the items.
- **Settling up** shows who pays whom to even everything out. Partners who run the same stock together can be settled as one team (a setting).
- Changing ownership percentages applies to everything not yet settled. Mark things as settled first if you want older sales left as they were.

## Tests

`tests/` contains automated checks that run the real database rules and the real app against stand-ins for Supabase:

```
cd tests
npm install
npm test
```

They cover the upgrade of an existing database (every number unchanged), that one business can never see another, each role's limits, invitations and who can claim them, ownership shares and money in a 65/35 business, privacy modes, deleting a business, and every screen in a real browser. Run them after any change to `schema.sql` or `app.js`.

## Changing things later

- After changing `supabase/schema.sql`, run it again. It keeps your data.
- Products, prices, people, roles and ownership are all managed inside the app (Stock tab and Business settings).

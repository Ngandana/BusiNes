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

The app is just files, so any free static host works. The easiest:

- **Netlify Drop:** go to https://app.netlify.com/drop and drag the `busynes-app` folder onto the page. You get a link like `https://busynes-xyz.netlify.app`.
- Or, since the code is already on GitHub: in the repo go to **Settings > Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`. The link will be `https://ngandana.github.io/BusiNes/`. GitHub Pages needs a public repo on a free account.

Then in Supabase, go to **Authentication > URL Configuration** and set **Site URL** to that link.

## 5. Install it on each phone

Open the link on the phone, then:
- **Android (Chrome):** menu ⋮ > **Add to Home screen** (or **Install app**).
- **iPhone (Safari):** Share button > **Add to Home Screen**.

It now opens like a normal app with the BusyNes icon.

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

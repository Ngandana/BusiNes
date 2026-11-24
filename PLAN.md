# BusyNes — plan for going professional

Written 28 October 2026. This is the working plan: app stores, costs, scaling, admin
dashboard and marketing. Tick items off as they are done and add dates in the log at the
bottom. Prices are checked against October 2026 sources; confirm amounts on the day you pay.

Rand amounts assume roughly R18–R19 to the US dollar.

---

## Where the app stands today

Already done and genuinely ahead of most hobby apps: multi-business roles and invites,
offline sales, Web Push, export/backup, account deletion, a privacy policy, a real
permission model, 482 automated tests, PWA install.

Gaps that have to close before this can be called professional:

| Gap | Why it matters |
|---|---|
| No error monitoring | A crash on someone's phone is invisible to you unless they tell you. |
| No analytics or admin view | You cannot answer "how many people used it this week?" |
| No automatic backups | Supabase free has no daily backups. A bad migration loses real sales history. **Biggest risk.** |
| No real domain | The netlify.app URL cannot go on a poster. |
| No terms of use | Privacy policy exists; terms do not. |
| No first-run guidance | New users land on an empty screen. This is where signups die. |
| No staging database | Schema changes are run straight against live data. |
| No expenses | Profit without rent/transport/airtime is not the real profit. |
| No customer slip | A WhatsApp slip for credit sales ("you owe R120, due Friday") is the feature people would tell friends about. |

---

## Phase 0 — foundations (this week, ~R250)

- [ ] Buy `busynes.co.za` (South African registrar, ~R100–250/year) and point Netlify at it.
- [ ] Set up `help@busynes.co.za` and put it in the app, the privacy policy and the store listings.
- [ ] Weekly backup: run the existing export and keep the file in OneDrive. Later, a scheduled `pg_dump`.
- [ ] Create a **second Supabase project as staging** (the free plan allows 2 active projects).
      Run `schema.sql` there first, then on live. Never test on live data again.
- [ ] Write a short terms-of-use page: no guarantee of accuracy, do not use as your only
      financial record, accounts can be suspended for abuse.
- [ ] Check the name "BusyNes" is free on Google Play, the App Store and CIPC before printing anything.
- [ ] Decide the store name and one-line pitch. Suggested: **BusyNes — know what you made this week.**

## Phase 1 — be able to see (before any marketing)

- [ ] **Admin dashboard** (`admin.html`), access controlled by a `platform_admins` table,
      every number from `SECURITY DEFINER` functions returning **aggregates only**.
      Keep the promise in `schema.sql`: the person who built this cannot see anyone's sales.
  - [ ] Signups per day / week
  - [ ] Active businesses (a sale in the last 7 days)
  - [ ] **Activation: share of new signups who record a SECOND sale** — the single most important number
  - [ ] Retention: still active 14 days after signup
  - [ ] Sales recorded per day (count only, platform-wide)
  - [ ] Invites sent vs. accepted
  - [ ] Failed offline syncs, push subscriptions
  - [ ] Signups by source via `?from=poster`, `?from=wa` link tags
  - [ ] Support actions: find a person by email, resend confirmation, see signup / last-seen, delete on request
  - [ ] Later, for billing: mark a business trial / paid / expired
- [ ] **Error logging:** an `app_errors` table plus one RPC the app calls when something throws.
      (Alternative: free Sentry, 5k errors/month.)
- [ ] Do **not** add per-business revenue to the dashboard unless the privacy policy is changed
      first and users are told.

## Phase 2 — make the first five minutes work

- [ ] First-run guidance: create your first product, then record your first sale.
      Worth more than any marketing.
- [ ] In-app feedback button: one tap to WhatsApp you.
- [ ] "What's new" note on version change, plus a `CHANGELOG.md`.
- [ ] Test on real devices: an iPhone in Safari and a cheap Android, offline mode included.

## Phase 3 — Google Play (~R460, one-off; about a month)

The app does not need rewriting. [PWABuilder](https://www.pwabuilder.com) wraps it as a
Trusted Web Activity in about 20 minutes (Bubblewrap is the command-line version).

- [ ] Play Console account, **US$25 once** (~R460), not annual.
- [ ] Identity verification (personal account).
- [ ] `/.well-known/assetlinks.json` on Netlify with the **SHA-256 of the key Google Play
      Signing actually serves** — not the upload key. This mismatch is the #1 cause of the app
      opening with a browser bar instead of full screen.
- [ ] Store assets: 512×512 icon (and maskable), 1024×500 feature graphic, 2+ phone
      screenshots, short and long description.
- [ ] Privacy policy URL and the **Data safety form** (declare email and business data).
- [ ] **Closed test: 12 testers, opted in continuously for 14 days**, before applying for
      production. Personal accounts created after 13 Nov 2023. Use the residence — this is the
      rule that blocks most people and it will not block you.
- [ ] Apply for production, submit, wait for review.

## Phase 4 — launch marketing (free)

### Positioning

> **Know exactly what you made this week — without a notebook.**
> Free. Works offline. Your partners see what they should, nothing more.

Differentiators in the order students care about:
1. **Works without data or signal** (offline sales) — huge in a residence.
2. **Who owes me money** — the real pain of a student hustle. Lead with this.
3. **Partners and shares** — most student businesses are 2–3 friends splitting money, and that
   is where the arguments start. The app settles them.

### The beachhead is your residence, not "South Africa"

- [ ] **Week 1 — 12 testers by hand.** Walk to 12 people with a hustle. Two-minute demo on
      *their* phone, set up their first product while standing there, sign them up on the spot.
      People who leave to "do it later" never do. Call them founding members.
      The demo: ask "how do you track who owes you?", let them answer, show that one screen.
- [ ] **Week 2 — WhatsApp.** Res groups, course groups, society groups, your status.
      One paste-ready message plus one 30-second video. Highest reach, zero cost.
- [ ] **Week 3 — physical.** A5 posters with a big QR code in the res kitchen, laundry, notice
      boards and the tuckshop. Headline "Who still owes you money?", not "Introducing BusyNes".
      Include the privacy line: *we cannot see your amounts, nobody can but you.*
- [ ] **Week 4 — wider.** Other CPUT residences and campuses, SRC and entrepreneurship
      societies (they want content to share), campus market days. Ask each founding member to
      bring one person — that is 24.
- [ ] **Ongoing:** the "invite a partner" feature *is* the growth engine. Every business with
      partners pulls in its own people.

### Videos — five, no more

Vertical 9:16, captions burned in, your own voice, isiXhosa and English mixed the way you
actually talk. No competitor can copy that.

1. 60 sec — what BusyNes is (the problem first, then the app)
2. 30 sec — add your stock
3. 30 sec — record a sale in 3 taps
4. 30 sec — **who owes you money** (make this the best one)
5. 30 sec — see your profit

Free tools: phone screen recorder or **scrcpy** to record from the PC; **CapCut** to edit and
auto-caption (most people watch muted); **Canva** for posters, screenshots and store graphics;
**OBS Studio** for computer screen capture; **Audacity** for voiceover cleanup.

### How to talk about "free"

> "Free for students right now. If we ever charge, it will be small, and you will be the first to know."

Never "free forever" — that gives away next year's R20/month. Do not ask for money until the
activation number says people come back on their own.

### The one number that decides everything

**People who record a second sale.** 7 in 10 means you have a product and should market hard.
2 in 10 means more marketing only burns your reputation — fix the app first.

## Phase 5 — iOS (later, ~R1 800/year)

Do this in 3–6 months, once people actually use the app. Most students around you are on
Android, the fee recurs whether anyone downloads it or not, and the review risk is real.
Meanwhile iPhone users can install the PWA from Safari today ("Add to Home Screen").

- [ ] Apple Developer Program, **US$99/year** (~R1 800), recurring or the app is removed.
- [ ] A Mac with Xcode. If you do not have one: free macOS build minutes on GitHub Actions or
      [Codemagic](https://codemagic.io), or a rented cloud Mac (~$25/month). Do not buy a Mac for this.
- [ ] [Capacitor](https://capacitorjs.com) to bundle the app files *inside* the binary rather
      than pointing at a website. That distinction matters in review.
- [ ] Native push via Capacitor's APNs plugin.
- [ ] **Guideline 4.2, "minimum functionality", is the real hurdle.** Apple rejects apps that
      are only a repackaged website; reviewers turn on airplane mode and reject anything showing
      a browser error. Offline sales already protect you here. In the review notes, state plainly
      that this is a business tool with offline recording, roles and permissions.
- [ ] Budget for one rejection and a resubmission. Nearly everyone gets one.

## Phase 6 — charging money (next academic year)

- [ ] Supabase Pro (US$25/mo ≈ R460) **on the day of the first payment** — daily backups,
      no auto-pause, 8 GB database, support.
- [ ] **Take payment outside the app.** EFT, PayShap or a payment link in an email — never a
      payment screen inside the app. Google and Apple require their own in-app purchase for
      digital subscriptions bought in-app and take 15–30%. Netflix and Spotify work this way for
      the same reason.
- [ ] Trial and expiry handling in the admin dashboard.

---

## Money

**Year 1, lean (Android only)**

| Item | Cost |
|---|---|
| Google Play, once | ~R460 |
| Domain, per year | ~R100–250 |
| Supabase | R0 (free plan) |
| Netlify | R0 (free plan) |
| Brevo email | R0 (300/day free) |
| **Total** | **≈ R600–700, mostly once-off** |

Add iOS: **+ ~R1 800/year.**
Start charging: **+ US$25/mo (~R460) for Supabase Pro.**

Do not spend money on: ads, company registration, app-builder services, trademarks. None of
them help at 30 users.

---

## Will it break with 20–30 users? No.

Supabase free: 500 MB database, 5 GB transfer/month, 50,000 monthly logged-in users.
Netlify free serves the app files.

One sale row is a few hundred bytes. Thirty businesses at 50 sales a day is ~45,000 rows a
month — on the order of **20 MB a year**. It takes thousands of businesses to fill 500 MB.
App files come from Netlify, so Supabase transfer is tiny JSON. 20–30 users is not an event.

What will actually bite, in order:

1. **No backups on free.** One bad migration and sales history is gone with no undo.
   Fix now, for free: weekly export to OneDrive, plus the staging project in Phase 0.
2. **Free projects pause after 7 days of no activity.** Harmless while people use it daily, but
   if usage dies over the December holidays the app looks broken in January. One click to restore
   — but you have to notice. The admin dashboard is how you notice.
3. **Email limits.** Confirmations and resets go through Brevo free (300/day). If 50 people sign
   up at one demo event and emails lag, they will think the app is broken. Have a plan for that day.
4. **No server of yours to fall over.** A strength: Netlify serves static files, Supabase scales itself.
5. **Latency.** No South African Supabase region; requests go to Europe (~150–200 ms). Fine for
   this app. Keep the project in the nearest EU region.
6. **You are the single point of failure**, not the servers. Keep a note of where accounts and
   keys live, and keep `schema.sql` as the source of truth.

Scaling plan: do nothing, watch the dashboard, buy Supabase Pro at the first paying customer.

---

## Legal and housekeeping

- Support address (required by both stores, and it stops 11pm WhatsApps to your personal number).
- Terms of use page.
- **POPIA:** you process other people's personal and business information. The right pieces
  already exist (privacy policy, account deletion, export). Add what you collect, why, how long
  you keep it, and an email to write to. At this size that is enough; you are the information officer.
- Keep the PWA as the front door. The `.co.za` link is what gets pasted in WhatsApp and works
  instantly with no download. Store listings are for credibility and for people who only trust
  the Play Store.

---

## Order of work

1. Phase 0 — domain, support email, backups, staging project, terms.
2. Phase 1 — admin dashboard and error logging. **Every other decision needs numbers you cannot currently see.**
3. Phase 2 — first-run guidance and feedback button.
4. Phase 3 — Play Console, PWABuilder, 12 testers (the 14 days run in the background).
5. Phase 4 — videos, poster, WhatsApp message; push for 50 active businesses.
6. Phase 5 — iOS. Phase 6 — expenses, customer slips, and charging.

---

## Log

| Date | What happened |
|---|---|
| 2026-10-28 | Plan written. Nothing started yet. |
| 2026-11-06 | v3.6 History of who owed (Who owes > History). |
| 2026-11-23 | v3.7 My money for any dates, settle-up only with partners, delivery fee, pick dates on Sales. |

---

## Sources

Fees and rules were checked against these in October 2026. Most are third-party blogs; the
amounts are consistent across several, but confirm on the Play Console and developer.apple.com
on the day you pay.

- [Google Play $25 fee](https://consolemint.com/google-play-console-price/)
- [12-tester rule](https://primetestlab.com/blog/paid-25-google-play-now-what)
- [Play developer verification](https://testerbee.com/blog/google-play-developer-verification-2026)
- [Apple $99/year](https://magora-systems.com/apple-developer-fee/)
- [Apple guideline 4.2 and webview apps](https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper/)
- [Capacitor and App Store review](https://capgo.app/blog/how-to-pass-app-store-review-2026/)
- [Supabase free tier limits](https://www.itpathsolutions.com/supabase-free-tier-limits)
- [Supabase pricing](https://makerkit.dev/blog/saas/supabase-pricing)
- [Netlify free plan](https://netli.fyi/blog/netlify-free-plan-limits-2026)
- [PWA on Google Play codelab](https://developers.google.com/codelabs/pwa-in-play)
- [Trusted Web Activity guide](https://developer.android.com/develop/ui/views/layout/webapps/guide-trusted-web-activities-version2)

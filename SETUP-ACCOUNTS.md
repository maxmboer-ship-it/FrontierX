# Accounts setup (Supabase)

Until these steps are done the site behaves exactly as it did before: no sign-in
button, plan stored in the browser. Nothing breaks while it is half-configured.

## 1. Create the project

1. Go to [supabase.com](https://supabase.com) → **New project** (free tier is fine).
2. Pick a region near your users. Save the database password somewhere safe —
   you won't need it for this, but you'll want it later.
3. Wait for provisioning (~2 minutes).

## 2. Create the tables

Dashboard → **SQL Editor** → **New query** → paste the entire contents of
`supabase/schema.sql` → **Run**.

This creates:

- `profiles` — one row per user, holding their `plan`. Users can read their own
  row but there is **no update policy**, so the plan cannot be changed from the
  browser. This is the whole point: entitlement lives somewhere the user can't write.
- `portfolios` — the saved book, one row per user, readable and writable only by
  its owner.
- A trigger that creates the profile row automatically on signup.

## 3. Get your keys

Dashboard → **Project Settings** → **API**:

- **Project URL** → `VITE_SUPABASE_URL`
- **anon / public key** → `VITE_SUPABASE_ANON_KEY`

The anon key is safe to ship in the browser bundle — row-level security is what
protects the data, not the key. **Never** put the `service_role` key in
`VITE_*` anything; it bypasses RLS entirely.

## 4. Add them to Vercel

Vercel → your project → **Settings** → **Environment Variables**. Add both to
Production, Preview and Development:

```
VITE_SUPABASE_URL       = https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY  = eyJhbGci...
```

Then **redeploy** — Vite reads `VITE_*` at build time, so an existing deployment
will not pick them up.

## 5. Configure email

Dashboard → **Authentication** → **URL Configuration**:

- **Site URL**: `https://frontierx.site`
- **Redirect URLs**: add `https://frontierx.site` and `http://localhost:5173`

Supabase's built-in email sender is rate-limited to a few messages per hour,
which is fine for testing. Before any real launch, set up a custom SMTP provider
(Resend, Postmark, SendGrid) under **Authentication → Emails**, or signups will
silently stop being delivered.

To skip email confirmation while testing: **Authentication → Providers → Email**
→ turn off *Confirm email*. Turn it back on before launch.

## 6. Grant yourself Pro

There is no payment flow yet, so plans are granted by hand. SQL Editor:

```sql
update public.profiles
   set plan = 'pro', plan_updated_at = now()
 where email = 'maxmboer@gmail.com';
```

Revoke with `plan = 'free'`. Valid values: `free`, `advanced`, `pro`.

## What this does and does not protect

The valuation lab's data endpoint verifies the caller's token server-side and
reads their plan from `profiles` before returning anything. Setting
`fx_plan = pro` in devtools still unlocks the *interface*, but the API returns
403 and the panel stays empty — the expensive data is genuinely gated.

The other Pro features (correlation lab, stress scenarios, long-only solver) are
pure client-side maths on data the user already has, so they remain
UI-gated only. Properly gating those means moving the computation server-side,
which is a larger change and worth doing only if it turns out people are
bypassing it.

## Next step: Stripe

When you're ready to actually charge, the missing piece is a webhook that sets
`profiles.plan` on `checkout.session.completed` and clears it on
`customer.subscription.deleted`. That needs the `service_role` key held
server-side only, in a Vercel env var **without** the `VITE_` prefix.

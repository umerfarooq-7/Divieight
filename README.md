# Share Your Space

Create a new web application called "divieight" — a fractional real estate 

co-ownership platform for sellers to list and manage properties sold in 1/8th 

shares. This is the Seller Module MVP.




Set up:

- A clean, professional design system (real-estate + fintech feel — trustworthy, 

  not flashy). Primary color: deep navy/charcoal. Accent: warm gold/bronze 

  (denoting "shares" and "ownership"). Use a modern sans-serif font.

- A responsive layout shell with a top navigation bar (logo left, "Seller 

  Dashboard" link, profile menu right).

- A landing/marketing home page with a hero section: "Sell Your Home in 

  1/8th Shares" and a "List Your Property" CTA button.

- Set up routing structure for: /login, /register, /onboarding, /dashboard, 

  /listings/new, /listings/:id.

- Use Supabase for backend (auth + database) since we'll need real user 

  accounts, file storage, and a Postgres database for structured data.




Do not build any forms or logic yet — just the shell, navigation, routing, 

and design system.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://divieight-v40.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/1b711437-0847-4eb8-96ae-d712f5d23fda).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## W-9 TIN encryption key

Buyer W-9s store the TIN encrypted with AES-256-GCM. The key comes from a secret environment variable, `W9_TIN_ENCRYPTION_KEY` (32 bytes, base64). If it is missing or the wrong length, the server **refuses to save a W-9**; it never falls back to plaintext.

1. Generate the key: `openssl rand -base64 32`
2. Set `W9_TIN_ENCRYPTION_KEY` in Vercel for **all environments** (Production, Preview, Development), and in your local `.env`. Never commit it.
3. Use **fake TINs only in test mode** (for example `123-45-6789`). Never put a real taxpayer number in a test environment.
4. Rotation: each encrypted TIN records its `key_version`. To rotate, add `W9_TIN_ENCRYPTION_KEY_V2` and bump `CURRENT_KEY_VERSION` in `src/lib/pii-crypto.server.ts`; older rows keep decrypting with their own version.

The encrypted TIN lives in `member_w9_tin_secrets`, which has no client-facing policies: only server functions using the service role can read it. The full TIN is never returned to the browser, logged, or put in an audit payload; the only decryption is the admin/finance tax-export function, which writes an audit row (who, when, why).

# Money Tracker – backend + app guide

```
money-tracker/
├── server.js        Express + SQLite + JWT login API
├── package.json
├── .env.example     copy to .env and fill in
└── public/index.html   your app (now with login + cloud sync)
```

## 1. Run it on your computer

```bash
npm install
cp .env.example .env
# put a long random value in JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm start
```
Open http://localhost:3000 → create an account → add entries. Log in from a second browser and the data is there.

## 2. What the backend does

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/register` | – | `{email, password}` → `{token}` |
| `POST /api/login` | – | `{email, password}` → `{token}` |
| `GET /api/data` | Bearer token | settings + all entries |
| `PUT /api/data` | Bearer token | replace your data with the app's current state |
| `DELETE /api/account` | Bearer token | delete account and all data |

Security already included: bcrypt password hashing, 30-day JWT, login rate limiting (20 per 15 min per IP),
input validation, per-user data isolation, Helmet headers, CORS allow-list.

How sync works in the app: the app still keeps a local copy (so it works offline). Every change is pushed to the
server about 0.7 s later; if you are offline it retries when the connection returns. On first login, data already
on the phone is uploaded to your account. The 4-digit PIN stays on the device only and is not sent to the server.

Known limits (fine for personal use, worth knowing):
- Sync is "last write wins". If you edit on two devices while one is offline, the later push overwrites the other.
- No password reset yet. To add it you need an email service (Resend, Brevo, SES) and a reset-token endpoint.
- The PIN is a screen lock, not encryption.

## 3. Put the backend online (needed for a real phone app)

Easiest: **Render**, **Railway** or **Fly.io**. Steps for Render:
1. Push this folder to a GitHub repo (`.gitignore` already excludes `.env` and the database).
2. New → Web Service → connect the repo. Build: `npm install`. Start: `npm start`.
3. Environment: `JWT_SECRET` (long random), `DB_PATH=/var/data/data.db`,
   `CORS_ORIGINS=capacitor://localhost,http://localhost,https://localhost`.
4. **Add a persistent disk** mounted at `/var/data`. Without it SQLite is wiped on every deploy. (Free tiers often
   have no disk – use the cheapest paid plan, or switch to Postgres.)
5. You get `https://your-app.onrender.com`. HTTPS is required for mobile apps.

## 4. Turn it into an app

### Option A – Install as a web app (PWA): free, 10 minutes
Add a `manifest.json` (name, `display: "standalone"`, `theme_color #1456a0`, 192 and 512 px PNG icons), a small
service worker that caches `index.html`, and link the manifest in `<head>`. Then on Android Chrome:
⋮ → *Install app*; on iPhone Safari: Share → *Add to Home Screen*. No store account needed.

### Option B – Real Android / iOS app with Capacitor (Play Store / App Store)
Capacitor wraps your web app in a native shell.

```bash
# in a NEW folder next to the backend, e.g. money-app/
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init "Money Tracker" com.yourname.moneytracker --web-dir=www
mkdir www && cp ../money-tracker/public/index.html www/index.html
```

1. In `www/index.html` add this line **before** the main `<script>`:
   `<script>window.API_BASE="https://your-app.onrender.com";</script>`
2. Add the platform and open it:
   ```bash
   npx cap add android          # needs Android Studio installed
   npx cap sync
   npx cap open android
   ```
3. In Android Studio: run on your phone (USB debugging) to test. Then *Build → Generate Signed Bundle (AAB)*.
   Keep the keystore file and its password safe – you cannot update the app without them.
4. Play Console: one-time $25 fee, upload the AAB, fill in the store listing, privacy policy and the
   "Data safety" form, and do the required closed testing before production.
5. iOS needs a Mac with Xcode and a $99/year Apple developer account (`npx cap add ios`, `npx cap open ios`).

**Fix these before publishing the native app** (they behave differently inside a native WebView):
- *Backup / CSV download* uses a browser download link, which does not work in Capacitor. Use
  `@capacitor/filesystem` + `@capacitor/share` to write the file and open the share sheet.
- *Print statement* (`window.print`) is unreliable in a WebView; replace it with a share/export action.
- The app's JS is inline. Keep it simple for now; later move it into `app.js` and tighten the Content-Security-Policy.
- Add a visible "Delete account" button that calls `DELETE /api/account` (Apple and Google both require it).
- Add a privacy policy page (what you store: email and your entries) – the stores require a URL.

### Which option should you choose?
Start with Option A to use it yourself and with family right away. Go to Option B when you want it in the Play Store.

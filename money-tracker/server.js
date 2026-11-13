// Money Tracker backend: Express + SQLite + JWT auth
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const path = require("path");

try { process.loadEnvFile && process.loadEnvFile(); } catch (_) {} // Node 20.12+ reads .env

const { JWT_SECRET, PORT = 3000, DB_PATH = "./data.db" } = process.env;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("Set JWT_SECRET (32+ chars) in .env");
  process.exit(1);
}

// ---------- database ----------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings(
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lang TEXT NOT NULL DEFAULT 'en', big INTEGER NOT NULL DEFAULT 0,
  goal REAL NOT NULL DEFAULT 0, bud REAL NOT NULL DEFAULT 0, med REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN('in','out')),
  cat TEXT NOT NULL, amt REAL NOT NULL, note TEXT NOT NULL DEFAULT '', date TEXT NOT NULL,
  PRIMARY KEY(user_id, id)
);
CREATE INDEX IF NOT EXISTS items_user_date ON items(user_id, date);
`);

const q = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  addUser: db.prepare("INSERT INTO users(email, pass_hash) VALUES(?, ?)"),
  getSettings: db.prepare("SELECT lang, big, goal, bud, med FROM settings WHERE user_id = ?"),
  putSettings: db.prepare(`INSERT INTO settings(user_id,lang,big,goal,bud,med) VALUES(@u,@lang,@big,@goal,@bud,@med)
    ON CONFLICT(user_id) DO UPDATE SET lang=@lang,big=@big,goal=@goal,bud=@bud,med=@med`),
  getItems: db.prepare("SELECT id, type, cat, amt, note, date FROM items WHERE user_id = ?"),
  delItems: db.prepare("DELETE FROM items WHERE user_id = ?"),
  addItem: db.prepare("INSERT OR REPLACE INTO items(user_id,id,type,cat,amt,note,date) VALUES(?,?,?,?,?,?,?)"),
  delUser: db.prepare("DELETE FROM users WHERE id = ?"),
};

// ---------- helpers ----------
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OUT_CATS = ["med", "drug", "food", "house", "bill", "trip", "fam", "oth"];
const IN_CATS = ["sal", "pen", "gift", "oth"];
const num = (v, max = 1e10) => (Number.isFinite(+v) && +v >= 0 && +v <= max ? +v : 0);
const sign = (u) => jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: "30d" });

function cleanItems(arr) {
  if (!Array.isArray(arr) || arr.length > 50000) throw new Error("bad items");
  return arr.filter((i) => i && (i.type === "in" || i.type === "out")
      && (i.type === "in" ? IN_CATS : OUT_CATS).includes(i.cat)
      && Number.isSafeInteger(+i.id) && +i.amt > 0 && +i.amt < 1e10 && DATE_RE.test(i.date))
    .map((i) => ({ id: +i.id, type: i.type, cat: i.cat, amt: Math.round(i.amt * 100) / 100,
      note: String(i.note || "").slice(0, 80), date: i.date }));
}

function auth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  try { req.uid = jwt.verify(m && m[1], JWT_SECRET).uid; next(); }
  catch (_) { res.status(401).json({ error: "Please log in again" }); }
}

// ---------- app ----------
const app = express();
app.set("trust proxy", 1); // behind Render/Railway/nginx so rate-limit sees real IPs
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], manifestSrc: ["'self'"], workerSrc: ["'self'"] } } }));
const origins = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use("/api", cors({ origin: origins, allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "5mb" }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many attempts. Try again in 15 minutes." } });

app.post("/api/register", authLimiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email" });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: "Password must be 8-100 characters" });
  if (q.userByEmail.get(email)) return res.status(409).json({ error: "Email already registered" });
  const hash = await bcrypt.hash(password, 12);
  const info = q.addUser.run(email, hash);
  res.json({ token: sign({ id: info.lastInsertRowid }) });
});

const DUMMY = bcrypt.hashSync("dummy-password", 12); // equalises timing for unknown emails
app.post("/api/login", authLimiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const u = q.userByEmail.get(email);
  const ok = await bcrypt.compare(String(req.body.password || ""), u ? u.pass_hash : DUMMY);
  if (!u || !ok) return res.status(401).json({ error: "Wrong email or password" });
  res.json({ token: sign(u) });
});

app.get("/api/data", auth, (req, res) => {
  const s = q.getSettings.get(req.uid) || { lang: "en", big: 0, goal: 0, bud: 0, med: 0 };
  res.json({ ...s, items: q.getItems.all(req.uid) });
});

// Replace this user's data with the app's current state (single transaction)
app.put("/api/data", auth, (req, res) => {
  let items;
  try { items = cleanItems(req.body.items); } catch (_) { return res.status(400).json({ error: "Invalid data" }); }
  const b = req.body;
  db.transaction(() => {
    q.putSettings.run({ u: req.uid, lang: b.lang === "ta" ? "ta" : "en", big: b.big ? 1 : 0,
      goal: num(b.goal), bud: num(b.bud), med: num(b.med) });
    q.delItems.run(req.uid);
    for (const i of items) q.addItem.run(req.uid, i.id, i.type, i.cat, i.amt, i.note, i.date);
  })();
  res.json({ ok: true, count: items.length });
});

// Required by Apple/Google: let users delete their account and all data
app.delete("/api/account", auth, (req, res) => { q.delUser.run(req.uid); res.json({ ok: true }); });

app.use(express.static(path.join(__dirname, "public")));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "Server error" }); });

app.listen(PORT, () => console.log("Money Tracker running on port " + PORT));

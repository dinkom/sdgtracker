// SDG CalQuest – server (Cloudflare Worker)
// Prijava e-mailom (kod), jedan uređaj po korisniku, posrednik prema Claude API-ju s ključem na serveru,
// dnevni limiti i bilježenje potrošnje. Podaci o prehrani i težini se NE spremaju čitljivo – samo prolaze prema Claudeu,
// a sigurnosna kopija stiže već šifrirana na uređaju (ključ server nikad ne sprema).
import ADMIN_HTML from './admin.html';

// Cijene po milijunu tokena (USD) – za procjenu troška u admin sučelju. Provjeri u Claude Consoleu i po potrebi ažuriraj.
const PRICES = {
  'claude-haiku-5-5':  {in: 0.10, out: 0.50},
  'claude-sonnet-5-5': {in: 2.00, out: 10.00},
};
const DEFAULT_PRICE = {in: 2.00, out: 10.00};
const MAX_BODY = 4 * 1024 * 1024;     // 4 MB (fotografija je smanjena u aplikaciji)
const MAX_TOKENS_CAP = 8000;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const CODES_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const MAX_BACKUP = 1800000;          // D1: najveća vrijednost ~2 MB
const KEY_MAIL_EVERY_MS = 5 * 60 * 1000;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      // ---------- admin ----------
      if (path === '/admin' || path.startsWith('/admin/')) return await admin(req, env, path);

      // ---------- javni API za aplikaciju ----------
      const cors = corsHeaders(req, env);
      if (req.method === 'OPTIONS') return new Response(null, {status: cors ? 204 : 403, headers: cors || {}});
      if (!cors && req.headers.get('Origin')) return json({error: 'origin', message: 'Nedopušteno porijeklo zahtjeva.'}, 403);
      const h = cors || {};
      if (path === '/auth/start' && req.method === 'POST') return withCors(await authStart(req, env), h);
      if (path === '/auth/verify' && req.method === 'POST') return withCors(await authVerify(req, env), h);
      if (path === '/auth/logout' && req.method === 'POST') return withCors(await authLogout(req, env), h);
      if (path === '/me' && req.method === 'GET') return withCors(await me(req, env), h);
      if (path === '/claude' && req.method === 'POST') return withCors(await proxyClaude(req, env, ctx), h);
      if (path === '/backup' && req.method === 'GET') return withCors(await backupGet(req, env, false), h);
      if (path === '/backup/info' && req.method === 'GET') return withCors(await backupGet(req, env, true), h);
      if (path === '/backup' && req.method === 'POST') return withCors(await backupPut(req, env), h);
      if (path === '/backup/key-mail' && req.method === 'POST') return withCors(await backupKeyMail(req, env), h);
      if (path === '/') return new Response('SDG CalQuest API radi.', {headers: {'content-type': 'text/plain; charset=utf-8'}});
      return withCors(json({error: 'not_found'}, 404), h);
    } catch (e) {
      console.error(e);
      return json({error: 'server', message: 'Greška na serveru. Pokušaj ponovno.'}, 500);
    }
  },
};

/* ================= pomoćne ================= */
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {status, headers: {'content-type': 'application/json; charset=utf-8', ...headers}});
function withCors(res, h) { for (const [k, v] of Object.entries(h)) res.headers.set(k, v); return res; }
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const nowIso = () => new Date().toISOString();
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
const daysAgo = n => new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(Date.now() - n * 864e5));
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomCode() {
  const b = new Uint32Array(1);
  do crypto.getRandomValues(b); while (b[0] >= 4294000000);   // bez pristranosti
  return String(b[0] % 1000000).padStart(6, '0');
}
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
async function readJson(req) {
  const len = +req.headers.get('content-length') || 0;
  if (len > MAX_BODY) throw Object.assign(new Error('too_large'), {status: 413});
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error('too_large'), {status: 413});
  try { return JSON.parse(text || '{}'); } catch (e) { return {}; }
}
async function getSettings(env) {
  const {results} = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(results.map(r => [r.key, r.value]));
  return {text_model: s.text_model || 'claude-haiku-5-5', photo_model: s.photo_model || 'claude-sonnet-5-5', daily_limit: +s.daily_limit || 40};
}
const codeHash = (env, email, code) => sha256(`${email}:${code}:${env.CODE_SALT || 'calquest'}`);

/* ================= prijava ================= */
async function authStart(req, env) {
  const {email: raw} = await readJson(req);
  const email = normEmail(raw);
  if (!validEmail(email)) return json({error: 'invalid', message: 'Upiši ispravnu e-mail adresu.'}, 400);
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) return json({error: 'not_found', message: 'Ova adresa nema pristup. Javi se treneru da te doda.'}, 404);
  if (!user.active) return json({error: 'inactive', message: 'Pristup za ovu adresu trenutno nije aktivan. Javi se treneru.'}, 403);

  const now = Date.now();
  const prev = await env.DB.prepare('SELECT * FROM codes WHERE email = ?').bind(email).first();
  if (prev && now - prev.sent_at < CODE_RESEND_MS) {
    const wait = Math.ceil((CODE_RESEND_MS - (now - prev.sent_at)) / 1000);
    return json({error: 'wait', message: `Kod je upravo poslan. Novi možeš zatražiti za ${wait} s.`, wait}, 429);
  }
  let windowStart = now, sentCount = 1;
  if (prev && now - prev.window_start < 3600e3) { windowStart = prev.window_start; sentCount = prev.sent_count + 1; }
  if (sentCount > CODES_PER_HOUR) return json({error: 'wait', message: 'Previše zatraženih kodova. Pokušaj ponovno za sat vremena.'}, 429);

  const code = randomCode();
  await env.DB.prepare(`INSERT INTO codes (email, code_hash, expires_at, attempts, sent_at, sent_count, window_start)
      VALUES (?, ?, ?, 0, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at,
      attempts=0, sent_at=excluded.sent_at, sent_count=excluded.sent_count, window_start=excluded.window_start`)
    .bind(email, await codeHash(env, email, code), now + CODE_TTL_MS, now, sentCount, windowStart).run();

  if (env.DEV_MODE === '1') return json({ok: true, devCode: code});   // samo za lokalno testiranje!
  const sent = await sendCodeMail(env, email, user.name, code);
  if (!sent.ok) return json({error: 'mail', message: 'Slanje e-maila nije uspjelo. Pokušaj ponovno za minutu.'}, 502);
  return json({ok: true});
}

async function sendCodeMail(env, email, name, code) {
  const greet = name ? `Bok ${name.split(' ')[0]},` : 'Bok,';
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1c1a17">
    <p style="font-size:16px">${greet}</p>
    <p style="font-size:16px">tvoj kod za prijavu u <b>SDG CalQuest</b>:</p>
    <p style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f5f2ec;border-radius:12px;padding:16px;text-align:center">${code}</p>
    <p style="font-size:14px;color:#716b61">Kod vrijedi 10 minuta. Ako nisi ti zatražio/la prijavu, slobodno zanemari ovaj e-mail.</p>
    <p style="font-size:14px;color:#716b61">SDG Gym</p></div>`;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', 'accept': 'application/json'},
    body: JSON.stringify({
      sender: {name: env.MAIL_FROM_NAME || 'SDG CalQuest', email: env.MAIL_FROM},
      to: [{email, name: name || undefined}],
      subject: `${code} – tvoj kod za SDG CalQuest`,
      htmlContent: html,
      textContent: `${greet}\n\ntvoj kod za prijavu u SDG CalQuest: ${code}\n\nKod vrijedi 10 minuta.\n\nSDG Gym`,
    }),
  });
  if (!r.ok) console.error('Brevo', r.status, await r.text());
  return {ok: r.ok};
}

async function authVerify(req, env) {
  const body = await readJson(req);
  const email = normEmail(body.email), code = String(body.code || '').replace(/\D/g, '');
  const row = await env.DB.prepare('SELECT * FROM codes WHERE email = ?').bind(email).first();
  if (!row || Date.now() > row.expires_at) return json({error: 'expired', message: 'Kod je istekao. Zatraži novi.'}, 400);
  if (row.attempts >= MAX_ATTEMPTS) return json({error: 'too_many', message: 'Previše pogrešnih pokušaja. Zatraži novi kod.'}, 400);
  if (!(await safeEqual(await codeHash(env, email, code), row.code_hash))) {
    await env.DB.prepare('UPDATE codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return json({error: 'wrong', message: left > 0 ? `Pogrešan kod. Preostalo pokušaja: ${left}.` : 'Pogrešan kod. Zatraži novi.', left}, 400);
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user || !user.active) return json({error: 'inactive', message: 'Pristup za ovu adresu trenutno nije aktivan.'}, 403);

  const token = randomToken(), now = nowIso();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM codes WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM devices WHERE email = ?').bind(email),           // jedan uređaj: stari se odjavljuje
    env.DB.prepare('INSERT INTO devices (token_hash, email, created_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256(token), email, now, now, (req.headers.get('user-agent') || '').slice(0, 200)),
  ]);
  return json({token, email, name: user.name});
}

async function authed(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return {res: json({error: 'unauthorized', message: 'Prijavi se ponovno.'}, 401)};
  const row = await env.DB.prepare(`SELECT d.token_hash, d.email, u.name, u.active, u.daily_limit
      FROM devices d JOIN users u ON u.email = d.email WHERE d.token_hash = ?`).bind(await sha256(m[1].trim())).first();
  if (!row) return {res: json({error: 'unauthorized', message: 'Uređaj je odjavljen. Prijavi se ponovno.'}, 401)};
  if (!row.active) return {res: json({error: 'inactive', message: 'Pristup trenutno nije aktivan. Javi se treneru.'}, 403)};
  return {user: row};
}

async function authLogout(req, env) {
  const a = await authed(req, env);
  if (a.user) await env.DB.prepare('DELETE FROM devices WHERE token_hash = ?').bind(a.user.token_hash).run();
  return json({ok: true});
}

async function me(req, env) {
  const a = await authed(req, env); if (a.res) return a.res;
  const s = await getSettings(env);
  const u = await env.DB.prepare('SELECT requests, photos FROM usage WHERE email = ? AND day = ?').bind(a.user.email, today()).first();
  await env.DB.prepare('UPDATE devices SET last_seen = ? WHERE token_hash = ?').bind(nowIso(), a.user.token_hash).run();
  return json({email: a.user.email, name: a.user.name, today: {requests: u?.requests || 0, photos: u?.photos || 0},
    limit: a.user.daily_limit ?? s.daily_limit});
}

/* ================= posrednik prema Claudeu ================= */
async function proxyClaude(req, env, ctx) {
  const a = await authed(req, env); if (a.res) return a.res;
  let body;
  try { body = await readJson(req); } catch (e) { return json({error: {message: 'Zahtjev je prevelik.'}}, 413); }
  const r = body.request || {};
  if (!Array.isArray(r.messages) || !r.messages.length) return json({error: {message: 'Neispravan zahtjev.'}}, 400);

  const s = await getSettings(env), day = today(), limit = a.user.daily_limit ?? s.daily_limit;
  const used = await env.DB.prepare('SELECT requests FROM usage WHERE email = ? AND day = ?').bind(a.user.email, day).first();
  if ((used?.requests || 0) >= limit)
    return json({error: {type: 'limit', message: `Dosegnut je dnevni limit obrada (${limit}). Sutra opet!`}}, 429);

  const photo = r.messages.some(m => Array.isArray(m.content) && m.content.some(c => c && c.type === 'image'));
  const model = photo ? s.photo_model : s.text_model;
  const upstream = {model, max_tokens: Math.min(Math.max(+r.max_tokens || 2000, 16), MAX_TOKENS_CAP), messages: r.messages};
  if (r.system) upstream.system = r.system;
  if (Array.isArray(r.tools)) upstream.tools = r.tools;
  if (r.tool_choice) upstream.tool_choice = r.tool_choice;

  const res = await fetch(env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01'},
    body: JSON.stringify(upstream),
  });
  const data = await res.json().catch(() => ({error: {message: 'Neispravan odgovor servisa.'}}));
  if (!res.ok) {
    // greške ključa/kredita ne prikazujemo korisniku doslovno
    const msg = data?.error?.message || '';
    if (res.status === 401 || /credit|billing/i.test(msg)) {
      console.error('Anthropic', res.status, msg);
      return json({error: {type: 'server', message: 'Obrada je trenutno nedostupna. Javi se treneru.'}}, 503);
    }
    return json(data, res.status);
  }
  const usage = data.usage || {}, price = PRICES[model] || DEFAULT_PRICE;
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  const cost = (inTok * price.in + outTok * price.out) / 1e6;
  ctx.waitUntil(env.DB.batch([
    env.DB.prepare(`INSERT INTO usage (email, day, requests, photos, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(email, day) DO UPDATE SET requests = requests + 1, photos = photos + excluded.photos,
        input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, cost_usd = cost_usd + excluded.cost_usd`)
      .bind(a.user.email, day, photo ? 1 : 0, inTok, outTok, cost),
    env.DB.prepare('UPDATE devices SET last_seen = ? WHERE token_hash = ?').bind(nowIso(), a.user.token_hash),
  ]));
  return json(data);
}

/* ================= šifrirana sigurnosna kopija ================= */
async function backupGet(req, env, infoOnly) {
  const a = await authed(req, env); if (a.res) return a.res;
  const row = await env.DB.prepare(`SELECT ${infoOnly ? '' : 'iv, data, '}size, updated_at FROM backups WHERE email = ?`).bind(a.user.email).first();
  if (!row) return json({error: 'none'}, 404);
  return json(row);
}
async function backupPut(req, env) {
  const a = await authed(req, env); if (a.res) return a.res;
  let b; try { b = await readJson(req); } catch (e) { return json({error: 'too_large', message: 'Kopija je prevelika.'}, 413); }
  const iv = String(b.iv || ''), data = String(b.data || '');
  if (!/^[A-Za-z0-9+/=]{12,40}$/.test(iv) || !/^[A-Za-z0-9+/=]+$/.test(data)) return json({error: 'invalid'}, 400);
  if (data.length > MAX_BACKUP) return json({error: 'too_large', message: 'Kopija je prevelika.'}, 413);
  const at = nowIso();
  await env.DB.prepare(`INSERT INTO backups (email, iv, data, size, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET iv = excluded.iv, data = excluded.data, size = excluded.size, updated_at = excluded.updated_at`)
    .bind(a.user.email, iv, data, data.length, at).run();
  return json({ok: true, updated_at: at});
}
// Ključ šalje uređaj; server ga samo proslijedi e-mailom i NE sprema.
async function backupKeyMail(req, env) {
  const a = await authed(req, env); if (a.res) return a.res;
  const {key} = await readJson(req);
  if (!/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/.test(String(key || ''))) return json({error: 'invalid'}, 400);
  const row = await env.DB.prepare('SELECT key_mail_at FROM backups WHERE email = ?').bind(a.user.email).first();
  if (row && Date.now() - row.key_mail_at < KEY_MAIL_EVERY_MS) return json({error: 'wait', message: 'Ključ je upravo poslan. Pokušaj ponovno za nekoliko minuta.'}, 429);
  if (row) await env.DB.prepare('UPDATE backups SET key_mail_at = ? WHERE email = ?').bind(Date.now(), a.user.email).run();
  if (env.DEV_MODE === '1') return json({ok: true, dev: true});
  const name = a.user.name ? a.user.name.split(' ')[0] : '';
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#1c1a17">
    <p style="font-size:16px">${name ? 'Bok ' + name + ',' : 'Bok,'}</p>
    <p style="font-size:16px">ovo je tvoj <b>ključ za sigurnosnu kopiju</b> u SDG CalQuestu:</p>
    <p style="font-size:24px;font-weight:800;letter-spacing:2px;background:#f5f2ec;border-radius:12px;padding:16px;text-align:center;font-family:ui-monospace,Menlo,monospace">${key}</p>
    <p style="font-size:14px;color:#716b61"><b>Sačuvaj ovaj e-mail.</b> Ako promijeniš ili izgubiš mobitel, nakon prijave na novom uređaju upiši ovaj ključ i svi tvoji podaci (unosi, težina, obroci, postignuća) vratit će se.</p>
    <p style="font-size:14px;color:#716b61">Kopija na serveru je šifrirana ovim ključem i bez njega je nitko ne može pročitati – ni trener, ni mi. Ključ se ne sprema na server.</p>
    <p style="font-size:14px;color:#716b61">SDG Gym</p></div>`;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', 'accept': 'application/json'},
    body: JSON.stringify({sender: {name: env.MAIL_FROM_NAME || 'SDG CalQuest', email: env.MAIL_FROM}, to: [{email: a.user.email}],
      subject: 'Ključ za sigurnosnu kopiju – SDG CalQuest', htmlContent: html,
      textContent: `Tvoj ključ za sigurnosnu kopiju u SDG CalQuestu: ${key}\n\nSačuvaj ovaj e-mail – trebat će ti za vraćanje podataka na novom mobitelu.`}),
  });
  if (!r.ok) { console.error('Brevo', r.status, await r.text()); return json({error: 'mail', message: 'Slanje e-maila nije uspjelo.'}, 502); }
  return json({ok: true});
}

/* ================= admin ================= */
async function admin(req, env, path) {
  if (!env.ADMIN_PASSWORD) return new Response('ADMIN_PASSWORD nije postavljen.', {status: 500});
  const auth = req.headers.get('authorization') || '';
  let ok = false;
  if (auth.startsWith('Basic ')) {
    try { const dec = atob(auth.slice(6)); ok = await safeEqual(dec.slice(dec.indexOf(':') + 1), env.ADMIN_PASSWORD); } catch (e) {}
  }
  if (!ok) return new Response('Prijava potrebna.', {status: 401, headers: {'WWW-Authenticate': 'Basic realm="SDG CalQuest admin", charset="UTF-8"'}});

  const sec = {'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer'};
  if (path === '/admin') return new Response(ADMIN_HTML, {headers: {'content-type': 'text/html; charset=utf-8', ...sec}});
  // zaštita od zahtjeva s drugih stranica
  if (req.headers.get('x-requested-with') !== 'calquest-admin') return json({error: 'forbidden'}, 403);
  const body = req.method === 'POST' ? await readJson(req) : {};

  if (path === '/admin/api/overview' && req.method === 'GET') {
    const t = today(), d30 = daysAgo(29), monthStart = t.slice(0, 8) + '01';
    const {results: users} = await env.DB.prepare(`
      SELECT u.*, (SELECT MAX(last_seen) FROM devices d WHERE d.email = u.email) AS last_seen,
        (SELECT user_agent FROM devices d WHERE d.email = u.email ORDER BY last_seen DESC LIMIT 1) AS user_agent,
        (SELECT updated_at FROM backups b WHERE b.email = u.email) AS backup_at,
        COALESCE((SELECT requests FROM usage g WHERE g.email = u.email AND g.day = ?), 0) AS today_requests,
        COALESCE((SELECT photos FROM usage g WHERE g.email = u.email AND g.day = ?), 0) AS today_photos,
        COALESCE((SELECT SUM(requests) FROM usage g WHERE g.email = u.email AND g.day >= ?), 0) AS d30_requests,
        COALESCE((SELECT SUM(cost_usd) FROM usage g WHERE g.email = u.email AND g.day >= ?), 0) AS d30_cost
      FROM users u ORDER BY u.active DESC, u.name COLLATE NOCASE, u.email`).bind(t, t, d30, d30).all();
    const tot = await env.DB.prepare(`SELECT
        COALESCE(SUM(CASE WHEN day = ? THEN cost_usd END), 0) AS today_cost,
        COALESCE(SUM(CASE WHEN day = ? THEN requests END), 0) AS today_requests,
        COALESCE(SUM(CASE WHEN day >= ? THEN cost_usd END), 0) AS month_cost,
        COALESCE(SUM(CASE WHEN day >= ? THEN requests END), 0) AS month_requests FROM usage`).bind(t, t, monthStart, monthStart).first();
    return json({users, settings: await getSettings(env), totals: tot, today: t});
  }
  if (path === '/admin/api/user' && req.method === 'POST') {
    const email = normEmail(body.email);
    if (!validEmail(email)) return json({error: 'Neispravna e-mail adresa.'}, 400);
    const limit = body.daily_limit === '' || body.daily_limit == null ? null : Math.max(0, Math.round(+body.daily_limit));
    await env.DB.prepare(`INSERT INTO users (email, name, active, daily_limit, note, created_at) VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET name = excluded.name, daily_limit = excluded.daily_limit, note = excluded.note`)
      .bind(email, String(body.name || '').trim().slice(0, 100), limit, String(body.note || '').trim().slice(0, 300), nowIso()).run();
    return json({ok: true});
  }
  if (path === '/admin/api/user/active' && req.method === 'POST') {
    await env.DB.prepare('UPDATE users SET active = ? WHERE email = ?').bind(body.active ? 1 : 0, normEmail(body.email)).run();
    return json({ok: true});
  }
  if (path === '/admin/api/user/logout' && req.method === 'POST') {
    await env.DB.prepare('DELETE FROM devices WHERE email = ?').bind(normEmail(body.email)).run();
    return json({ok: true});
  }
  if (path === '/admin/api/user/delete' && req.method === 'POST') {
    const e = normEmail(body.email);
    await env.DB.batch(['users', 'devices', 'codes', 'usage', 'backups'].map(tb => env.DB.prepare(`DELETE FROM ${tb} WHERE email = ?`).bind(e)));
    return json({ok: true});
  }
  if (path === '/admin/api/settings' && req.method === 'POST') {
    const st = [];
    for (const k of ['text_model', 'photo_model']) if (body[k]) st.push(env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(k, String(body[k]).trim()));
    if (body.daily_limit != null && body.daily_limit !== '') st.push(env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('daily_limit', String(Math.max(1, Math.round(+body.daily_limit)))));
    if (st.length) await env.DB.batch(st);
    return json({ok: true});
  }
  return json({error: 'not_found'}, 404);
}

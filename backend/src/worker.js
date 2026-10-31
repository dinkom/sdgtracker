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
const IP_CODES_PER_HOUR = 10;
const GRACE_MS = 3 * 864e5;           // dani tolerancije ako kasni naplata

export default {
  async fetch(req, env, ctx) {
    env_payments = !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_MEMBER && env.STRIPE_PRICE_EXTERNAL);
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      // ---------- admin ----------
      if (path === '/admin' || path.startsWith('/admin/')) return await admin(req, env, path);

      // ---------- Stripe javlja uplate ----------
      if (path === '/stripe/webhook' && req.method === 'POST') return await stripeWebhook(req, env, ctx);

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
      if (path === '/me/profile' && req.method === 'POST') return withCors(await meProfile(req, env), h);
      if (path === '/billing/checkout' && req.method === 'POST') return withCors(await billingCheckout(req, env), h);
      if (path === '/billing/portal' && req.method === 'POST') return withCors(await billingPortal(req, env), h);
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
  return {text_model: s.text_model || 'claude-haiku-5-5', photo_model: s.photo_model || 'claude-sonnet-5-5', daily_limit: +s.daily_limit || 40,
    trial_days: +s.trial_days || 7, price_member: +s.price_member || 5, price_external: +s.price_external || 9,
    registration: s.registration || 'open'};
}
const codeHash = (env, email, code) => sha256(`${email}:${code}:${env.CODE_SALT || 'calquest'}`);

/* ================= prijava ================= */
async function authStart(req, env) {
  const {email: raw} = await readJson(req);
  const email = normEmail(raw);
  if (!validEmail(email)) return json({error: 'invalid', message: 'Upiši ispravnu e-mail adresu.'}, 400);
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    const st = await getSettings(env);
    if (st.registration !== 'open') return json({error: 'not_found', message: 'Registracija novih korisnika trenutno nije otvorena. Javi se treneru.'}, 404);
  }
  if (user && !user.active) return json({error: 'inactive', message: 'Pristup za ovu adresu trenutno nije aktivan. Javi se treneru.'}, 403);

  const now = Date.now(), ip = req.headers.get('cf-connecting-ip') || '';
  if (ip) {   // zaštita od slanja kodova na tuđe adrese u velikom broju
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM codes WHERE ip = ? AND sent_at > ?').bind(ip, now - 3600e3).first();
    if ((n?.n || 0) >= IP_CODES_PER_HOUR) return json({error: 'wait', message: 'Previše zahtjeva. Pokušaj ponovno kasnije.'}, 429);
  }
  const prev = await env.DB.prepare('SELECT * FROM codes WHERE email = ?').bind(email).first();
  if (prev && now - prev.sent_at < CODE_RESEND_MS) {
    const wait = Math.ceil((CODE_RESEND_MS - (now - prev.sent_at)) / 1000);
    return json({error: 'wait', message: `Kod je upravo poslan. Novi možeš zatražiti za ${wait} s.`, wait}, 429);
  }
  let windowStart = now, sentCount = 1;
  if (prev && now - prev.window_start < 3600e3) { windowStart = prev.window_start; sentCount = prev.sent_count + 1; }
  if (sentCount > CODES_PER_HOUR) return json({error: 'wait', message: 'Previše zatraženih kodova. Pokušaj ponovno za sat vremena.'}, 429);

  const code = randomCode();
  await env.DB.prepare(`INSERT INTO codes (email, code_hash, expires_at, attempts, sent_at, sent_count, window_start, ip)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at,
      attempts=0, sent_at=excluded.sent_at, sent_count=excluded.sent_count, window_start=excluded.window_start, ip=excluded.ip`)
    .bind(email, await codeHash(env, email, code), now + CODE_TTL_MS, now, sentCount, windowStart, ip).run();

  if (env.DEV_MODE === '1') return json({ok: true, devCode: code});   // samo za lokalno testiranje!
  const sent = await sendCodeMail(env, email, user?.name || '', code);
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
  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first(), isNew = false;
  if (!user) {   // samoregistracija: novi korisnik dobiva probno razdoblje
    const st = await getSettings(env);
    if (st.registration !== 'open') return json({error: 'not_found', message: 'Registracija novih korisnika trenutno nije otvorena.'}, 404);
    const trialUntil = new Date(Date.now() + st.trial_days * 864e5).toISOString();
    await env.DB.prepare(`INSERT INTO users (email, name, active, created_at, plan, trial_until, self_registered) VALUES (?, '', 1, ?, 'trial', ?, 1)`)
      .bind(email, nowIso(), trialUntil).run();
    user = {email, name: '', active: 1, trial_until: trialUntil}; isNew = true;
  }
  if (!user.active) return json({error: 'inactive', message: 'Pristup za ovu adresu trenutno nije aktivan.'}, 403);

  const token = randomToken(), now = nowIso();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM codes WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM devices WHERE email = ?').bind(email),           // jedan uređaj: stari se odjavljuje
    env.DB.prepare('INSERT INTO devices (token_hash, email, created_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256(token), email, now, now, (req.headers.get('user-agent') || '').slice(0, 200)),
  ]);
  return json({token, email, name: user.name, new_user: isNew, trial_until: user.trial_until || null});
}

async function authed(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return {res: json({error: 'unauthorized', message: 'Prijavi se ponovno.'}, 401)};
  const row = await env.DB.prepare(`SELECT d.token_hash, u.*
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
    limit: a.user.daily_limit ?? s.daily_limit, billing: billingInfo(a.user, s)});
}

/* ================= posrednik prema Claudeu ================= */
async function proxyClaude(req, env, ctx) {
  const a = await authed(req, env); if (a.res) return a.res;
  let body;
  try { body = await readJson(req); } catch (e) { return json({error: {message: 'Zahtjev je prevelik.'}}, 413); }
  const r = body.request || {};
  if (!Array.isArray(r.messages) || !r.messages.length) return json({error: {message: 'Neispravan zahtjev.'}}, 400);

  const s = await getSettings(env), day = today(), limit = a.user.daily_limit ?? s.daily_limit;
  const acc = access(a.user);
  if (!acc.ok) return json({error: {type: 'payment', message: a.user.plan === 'trial' ? 'Probno razdoblje je završilo. Za nastavak obrade unosa aktiviraj pretplatu.' : 'Pretplata nije aktivna. Za nastavak obrade unosa aktiviraj pretplatu.'}, billing: billingInfo(a.user, s)}, 402);
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

/* ================= pretplata i naplata (Stripe) ================= */
function access(u) {
  const now = Date.now();
  if (!u.active) return {ok: false, reason: 'inactive'};
  if (u.plan === 'free') return {ok: true, state: 'free'};
  if (u.sub_status === 'active' || u.sub_status === 'trialing') return {ok: true, state: 'subscribed'};
  if (u.paid_until && now < Date.parse(u.paid_until) + GRACE_MS) return {ok: true, state: 'paid'};
  if (u.trial_until && now < Date.parse(u.trial_until)) return {ok: true, state: 'trial'};
  return {ok: false, reason: 'payment'};
}
const planPrice = (u, s) => u.plan === 'member' ? s.price_member : u.plan === 'free' ? 0 : s.price_external;   // probno → cijena za vanjske dok trener ne odluči
const planLabel = p => ({trial: 'probno', member: 'član', external: 'vanjski', free: 'besplatno'}[p] || p);
function billingInfo(u, s) {
  const a = access(u);
  return {plan: u.plan, plan_decided: u.plan !== 'trial', price: planPrice(u, s), access: a.ok, state: a.state || a.reason,
    trial_until: u.trial_until, paid_until: u.paid_until, sub_status: u.sub_status, cancel_at_end: !!u.cancel_at_end,
    subscribed: u.sub_status === 'active' || u.sub_status === 'trialing' || u.sub_status === 'past_due',
    member_claim: !!u.member_claim, needs_profile: !u.name, payments_enabled: !!env_payments};
}
let env_payments = false;   // postavlja se po zahtjevu (ima li Stripe ključeva)

async function stripeApi(env, method, path, params) {
  const flat = [];
  const walk = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'object' && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, x); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(`${prefix}[${i}]`, x)); return; }
    flat.push([prefix, String(v)]);
  };
  walk('', params || {});
  const qs = new URLSearchParams(flat).toString();
  const url = (env.STRIPE_API_URL || 'https://api.stripe.com') + '/v1/' + path + (method === 'GET' && qs ? '?' + qs : '');
  const r = await fetch(url, {method, headers: {'authorization': 'Bearer ' + env.STRIPE_SECRET_KEY, 'content-type': 'application/x-www-form-urlencoded'},
    body: method === 'GET' ? undefined : qs});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Stripe', path, r.status, JSON.stringify(j).slice(0, 500)); throw new Error(j?.error?.message || 'Stripe greška'); }
  return j;
}
const priceIdFor = (env, plan) => plan === 'member' ? env.STRIPE_PRICE_MEMBER : env.STRIPE_PRICE_EXTERNAL;

async function meProfile(req, env) {
  const a = await authed(req, env); if (a.res) return a.res;
  const b = await readJson(req);
  const name = String(b.name || '').trim().slice(0, 80), claim = b.member_claim ? 1 : 0;
  if (!name) return json({error: 'invalid', message: 'Upiši ime.'}, 400);
  const first = !a.user.name;
  await env.DB.prepare('UPDATE users SET name = ?, member_claim = ? WHERE email = ?').bind(name, claim, a.user.email).run();
  if (first && a.user.self_registered) {
    const s = await getSettings(env);
    await notifyAdmin(env, `Novi korisnik: ${name}`, `<p><b>${esc(name)}</b> (${esc(a.user.email)}) se upravo registrirao/la u CalQuest.</p>
      <p>Kaže da je <b>${claim ? 'član' : 'NIJE član'}</b> SDG Gyma. Probno razdoblje traje do <b>${fmtDate(a.user.trial_until)}</b>.</p>
      <p>U adminu mu/joj odaberi cijenu: član ${s.price_member} € ili vanjski ${s.price_external} € (ili besplatno).</p>`);
  }
  return json({ok: true});
}

async function billingCheckout(req, env) {
  const a = await authed(req, env); if (a.res) return a.res;
  if (!env.STRIPE_SECRET_KEY) return json({error: 'disabled', message: 'Plaćanje još nije uključeno.'}, 503);
  const u = a.user;
  if (u.plan === 'free') return json({error: 'free', message: 'Za tebe je CalQuest besplatan – nema potrebe za pretplatom.'}, 400);
  if (u.plan === 'trial') return json({error: 'undecided', message: 'Trener ti još nije potvrdio cijenu. Javit ćemo ti se e-mailom čim bude spremno.'}, 400);
  const app = env.APP_URL || 'https://calquest.sdggym.com';
  if (u.stripe_customer && (u.sub_status === 'active' || u.sub_status === 'trialing' || u.sub_status === 'past_due')) {
    const portal = await stripeApi(env, 'POST', 'billing_portal/sessions', {customer: u.stripe_customer, return_url: app + '/?billing=portal'});
    return json({url: portal.url});
  }
  let customer = u.stripe_customer;
  if (!customer) {
    const c = await stripeApi(env, 'POST', 'customers', {email: u.email, name: u.name || undefined, metadata: {email: u.email}});
    customer = c.id;
    await env.DB.prepare('UPDATE users SET stripe_customer = ? WHERE email = ?').bind(customer, u.email).run();
  }
  const plan = u.plan === 'member' ? 'member' : 'external';
  const params = {mode: 'subscription', customer, client_reference_id: u.email, locale: 'hr',
    line_items: [{price: priceIdFor(env, plan), quantity: 1}],
    success_url: app + '/?billing=success', cancel_url: app + '/?billing=cancel',
    subscription_data: {metadata: {email: u.email}}};
  const trialEnd = u.trial_until ? Date.parse(u.trial_until) : 0;
  if (trialEnd - Date.now() > 49 * 3600e3) params.subscription_data.trial_end = Math.floor(trialEnd / 1000);   // prva naplata kad istekne probno
  const sess = await stripeApi(env, 'POST', 'checkout/sessions', params);
  return json({url: sess.url});
}

async function billingPortal(req, env) {
  const a = await authed(req, env); if (a.res) return a.res;
  if (!env.STRIPE_SECRET_KEY || !a.user.stripe_customer) return json({error: 'none', message: 'Nemaš aktivnu pretplatu.'}, 400);
  const p = await stripeApi(env, 'POST', 'billing_portal/sessions', {customer: a.user.stripe_customer, return_url: (env.APP_URL || 'https://calquest.sdggym.com') + '/?billing=portal'});
  return json({url: p.url});
}

// Provjera Stripeovog potpisa (HMAC-SHA256 nad "t.payload")
async function verifyStripe(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(x => x.split('=')).filter(x => x.length === 2).map(([k, v]) => [k, v]));
  const sigs = header.split(',').filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  const t = +parts.t;
  if (!t || Math.abs(Date.now() / 1000 - t) > 300 || !sigs.length) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  let ok = false; for (const s of sigs) { let d = s.length ^ hex.length; for (let i = 0; i < hex.length; i++) d |= hex.charCodeAt(i) ^ (s.charCodeAt(i) || 0); if (!d) ok = true; }
  return ok;
}
const tsIso = t => t ? new Date(t * 1000).toISOString() : null;
function fmtDate(iso) { if (!iso) return '–'; return new Intl.DateTimeFormat('hr-HR', {timeZone: 'Europe/Zagreb', day: 'numeric', month: 'numeric', year: 'numeric'}).format(new Date(iso)); }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const eur = cents => (cents / 100).toLocaleString('hr-HR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' €';

async function userByCustomer(env, customer, fallbackEmail) {
  let u = customer ? await env.DB.prepare('SELECT * FROM users WHERE stripe_customer = ?').bind(customer).first() : null;
  if (!u && fallbackEmail) u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(normEmail(fallbackEmail)).first();
  return u;
}

async function stripeWebhook(req, env, ctx) {
  const raw = await req.text();
  if (!(await verifyStripe(raw, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) return json({error: 'signature'}, 400);
  let ev; try { ev = JSON.parse(raw); } catch (e) { return json({error: 'json'}, 400); }
  const o = ev.data?.object || {};
  try {
    if (ev.type === 'checkout.session.completed') {
      const email = normEmail(o.client_reference_id || o.customer_details?.email || '');
      if (email) await env.DB.prepare('UPDATE users SET stripe_customer = COALESCE(?, stripe_customer), stripe_sub = COALESCE(?, stripe_sub) WHERE email = ?')
        .bind(o.customer || null, o.subscription || null, email).run();
    }
    if (ev.type.startsWith('customer.subscription.')) {
      const u = await userByCustomer(env, o.customer, o.metadata?.email);
      if (u) {
        const status = ev.type === 'customer.subscription.deleted' ? 'canceled' : o.status;
        const end = o.current_period_end || o.items?.data?.[0]?.current_period_end;
        await env.DB.prepare('UPDATE users SET stripe_sub = ?, sub_status = ?, cancel_at_end = ?, stripe_customer = COALESCE(stripe_customer, ?) WHERE email = ?')
          .bind(o.id, status, o.cancel_at_period_end ? 1 : 0, o.customer, u.email).run();
        if (ev.type === 'customer.subscription.created')
          ctx.waitUntil(notifyAdmin(env, `Nova pretplata: ${u.name || u.email}`, `<p><b>${esc(u.name || u.email)}</b> (${esc(u.email)}) je aktivirao/la pretplatu${status === 'trialing' ? ` – prva naplata nakon probnog razdoblja (${fmtDate(tsIso(o.trial_end))})` : ''}.</p>`));
        if ((ev.type === 'customer.subscription.updated' && o.cancel_at_period_end && !u.cancel_at_end) || (ev.type === 'customer.subscription.deleted' && !u.cancel_at_end))
          ctx.waitUntil(notifyAdmin(env, `Otkazana pretplata: ${u.name || u.email}`, `<p><b>${esc(u.name || u.email)}</b> (${esc(u.email)}) je otkazao/la pretplatu${end && ev.type !== 'customer.subscription.deleted' ? `; pristup vrijedi do ${fmtDate(tsIso(end))}` : ''}.</p>`));
      }
    }
    if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_succeeded') {
      const u = await userByCustomer(env, o.customer, o.customer_email);
      if (u && o.amount_paid > 0) {
        const line = o.lines?.data?.[0] || {}, ps = tsIso(line.period?.start || o.period_start), pe = tsIso(line.period?.end || o.period_end);
        const res = await env.DB.prepare(`INSERT OR IGNORE INTO payments (id, email, name, amount_cents, currency, plan, period_start, period_end, paid_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(o.id, u.email, u.name || '', o.amount_paid, o.currency || 'eur', u.plan, ps, pe,
            tsIso(o.status_transitions?.paid_at) || nowIso()).run();
        if (pe && (!u.paid_until || pe > u.paid_until)) await env.DB.prepare('UPDATE users SET paid_until = ? WHERE email = ?').bind(pe, u.email).run();
        if (res.meta?.changes)
          ctx.waitUntil(notifyAdmin(env, `Uplata ${eur(o.amount_paid)}: ${u.name || u.email}`,
            `<p>Nova uplata za CalQuest:</p><table style="font-size:15px;border-collapse:collapse">
             <tr><td style="padding:4px 12px 4px 0;color:#716b61">Ime</td><td><b>${esc(u.name || '–')}</b></td></tr>
             <tr><td style="padding:4px 12px 4px 0;color:#716b61">E-mail</td><td>${esc(u.email)}</td></tr>
             <tr><td style="padding:4px 12px 4px 0;color:#716b61">Iznos</td><td><b>${eur(o.amount_paid)}</b> (${planLabel(u.plan)})</td></tr>
             <tr><td style="padding:4px 12px 4px 0;color:#716b61">Razdoblje</td><td>${fmtDate(ps)} – ${fmtDate(pe)}</td></tr>
             <tr><td style="padding:4px 12px 4px 0;color:#716b61">Plaćeno</td><td>${fmtDate(tsIso(o.status_transitions?.paid_at) || nowIso())}</td></tr>
             <tr><td style="padding:4px 12px 4px 0;color:#716b61">Stripe račun</td><td>${esc(o.number || o.id)}</td></tr></table>
             <p>Nakon fiskalizacije označi uplatu u adminu → Uplate.</p>`));
      }
    }
    if (ev.type === 'invoice.payment_failed') {
      const u = await userByCustomer(env, o.customer, o.customer_email);
      if (u) {
        await env.DB.prepare(`UPDATE users SET sub_status = 'past_due' WHERE email = ?`).bind(u.email).run();
        ctx.waitUntil(notifyAdmin(env, `Neuspjela naplata: ${u.name || u.email}`, `<p>Naplata za <b>${esc(u.name || u.email)}</b> (${esc(u.email)}) nije uspjela. Stripe će pokušati ponovno; korisnik ima još ${GRACE_MS / 864e5} dana pristupa.</p>`));
      }
    }
  } catch (e) { console.error('webhook', ev.type, e); return json({error: 'handler'}, 500); }
  return json({received: true});
}

async function notifyAdmin(env, subject, html) { return mailTo(env, env.ADMIN_EMAIL, subject, html); }
async function mailTo(env, to, subject, html) {
  if (env.DEV_MODE === '1' || !to || !env.BREVO_API_KEY) { console.log('[mail]', to, subject); return; }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {method: 'POST',
      headers: {'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', 'accept': 'application/json'},
      body: JSON.stringify({sender: {name: env.MAIL_FROM_NAME || 'SDG CalQuest', email: env.MAIL_FROM}, to: [{email: to}],
        subject: `CalQuest · ${subject}`, htmlContent: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;color:#1c1a17">${html}</div>`})});
    if (!r.ok) console.error('Brevo admin', r.status, await r.text());
  } catch (e) { console.error('notifyAdmin', e); }
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
    const rev = await env.DB.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS month_cents, COUNT(*) AS month_count,
        COALESCE(SUM(CASE WHEN fiscalized = 0 THEN 1 ELSE 0 END), 0) AS unfiscalized FROM payments WHERE paid_at >= ?`).bind(monthStart).first();
    const unf = await env.DB.prepare('SELECT COUNT(*) AS n FROM payments WHERE fiscalized = 0').first();
    return json({users: users.map(u => ({...u, access: access(u)})), settings: await getSettings(env), totals: {...tot, ...rev, unfiscalized_all: unf?.n || 0},
      today: t, payments_enabled: env_payments});
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
  if (path === '/admin/api/user/plan' && req.method === 'POST') {
    const email = normEmail(body.email), plan = String(body.plan || '');
    if (!['trial', 'member', 'external', 'free'].includes(plan)) return json({error: 'Neispravan plan.'}, 400);
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!u) return json({error: 'Nema korisnika.'}, 404);
    await env.DB.prepare('UPDATE users SET plan = ? WHERE email = ?').bind(plan, email).run();
    let note = '';
    if (plan === 'trial' && !(u.trial_until && Date.parse(u.trial_until) > Date.now())) {   // probno bez aktivnog datuma → kreće od danas
      const st = await getSettings(env), until = new Date(Date.now() + st.trial_days * 864e5).toISOString();
      await env.DB.prepare('UPDATE users SET trial_until = ? WHERE email = ?').bind(until, email).run();
      note = `Probno razdoblje traje do ${fmtDate(until)}.`;
    }
    if (u.plan === 'trial' && plan !== 'trial' && !u.stripe_sub) {   // prvi put odabrana cijena → javi korisniku
      const s = await getSettings(env), app = env.APP_URL || 'https://calquest.sdggym.com';
      const hi = u.name ? `Bok ${esc(u.name.split(' ')[0])},` : 'Bok,';
      await mailTo(env, email, plan === 'free' ? 'CalQuest je za tebe besplatan' : 'Tvoja cijena za CalQuest', plan === 'free'
        ? `<p>${hi}</p><p>dobre vijesti – CalQuest je za tebe <b>besplatan</b>. Ne trebaš ništa plaćati, samo nastavi koristiti aplikaciju.</p><p>SDG Gym</p>`
        : `<p>${hi}</p><p>tvoja cijena za SDG CalQuest je <b>${plan === 'member' ? s.price_member : s.price_external} € mjesečno</b>${plan === 'member' ? ' (cijena za članove SDG Gyma)' : ''}.</p>
           <p>Pretplatu možeš uključiti u aplikaciji pod <b>Profil → Pretplata</b>${u.trial_until && Date.parse(u.trial_until) > Date.now() ? `. Ako je uključiš sada, prva naplata bit će tek kad istekne probno razdoblje (${fmtDate(u.trial_until)})` : ''}. Otkazati je možeš u bilo kojem trenutku.</p>
           <p><a href="${app}">Otvori CalQuest</a></p><p>SDG Gym</p>`);
      note = 'Korisniku je poslan e-mail s cijenom.';
    }
    if (u.stripe_sub && env.STRIPE_SECRET_KEY && ['active', 'trialing', 'past_due'].includes(u.sub_status)) {
      try {
        if (plan === 'free') { await stripeApi(env, 'POST', `subscriptions/${u.stripe_sub}`, {cancel_at_period_end: 'true'}); note = 'Pretplata se otkazuje na kraju plaćenog razdoblja.'; }
        else if (plan === 'member' || plan === 'external') {
          const sub = await stripeApi(env, 'GET', `subscriptions/${u.stripe_sub}`);
          const item = sub.items?.data?.[0];
          if (item && item.price?.id !== priceIdFor(env, plan)) {
            await stripeApi(env, 'POST', `subscriptions/${u.stripe_sub}`, {items: [{id: item.id, price: priceIdFor(env, plan)}], proration_behavior: 'none', cancel_at_period_end: 'false'});
            note = 'Nova cijena vrijedi od sljedeće naplate.';
          }
        }
      } catch (e) { return json({error: 'Plan je spremljen, ali promjena u Stripeu nije uspjela: ' + e.message}, 502); }
    }
    return json({ok: true, note});
  }
  if (path === '/admin/api/user/trial' && req.method === 'POST') {
    const email = normEmail(body.email), days = Math.max(1, Math.min(90, Math.round(+body.days || 7)));
    const u = await env.DB.prepare('SELECT trial_until FROM users WHERE email = ?').bind(email).first();
    if (!u) return json({error: 'Nema korisnika.'}, 404);
    const base = Math.max(Date.now(), u.trial_until ? Date.parse(u.trial_until) : 0);
    await env.DB.prepare('UPDATE users SET trial_until = ? WHERE email = ?').bind(new Date(base + days * 864e5).toISOString(), email).run();
    return json({ok: true});
  }
  if (path === '/admin/api/payments' && req.method === 'GET') {
    const month = /^\d{4}-\d{2}$/.test(new URL(req.url).searchParams.get('month') || '') ? new URL(req.url).searchParams.get('month') : today().slice(0, 7);
    const [y, m] = month.split('-').map(Number), next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const {results} = await env.DB.prepare('SELECT * FROM payments WHERE paid_at >= ? AND paid_at < ? ORDER BY paid_at DESC').bind(month + '-01', next + '-01').all();
    const {results: months} = await env.DB.prepare(`SELECT substr(paid_at, 1, 7) AS month, SUM(amount_cents) AS cents, COUNT(*) AS n,
        SUM(CASE WHEN fiscalized = 0 THEN 1 ELSE 0 END) AS unfiscalized FROM payments GROUP BY month ORDER BY month DESC LIMIT 24`).all();
    return json({month, payments: results, months});
  }
  if (path === '/admin/api/payment/fiscalized' && req.method === 'POST') {
    await env.DB.prepare('UPDATE payments SET fiscalized = ?, fiscalized_at = ? WHERE id = ?').bind(body.fiscalized ? 1 : 0, body.fiscalized ? nowIso() : null, String(body.id || '')).run();
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
    for (const k of ['trial_days', 'price_member', 'price_external'])
      if (body[k] != null && body[k] !== '') st.push(env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(k, String(Math.max(0, +body[k]))));
    if (body.registration === 'open' || body.registration === 'closed') st.push(env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('registration', body.registration));
    if (st.length) await env.DB.batch(st);
    return json({ok: true});
  }
  return json({error: 'not_found'}, 404);
}

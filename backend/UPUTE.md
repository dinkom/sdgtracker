# SDG CalQuest – postavljanje servera

Server (Cloudflare Worker) čuva Claude API ključ, prijavljuje polaznike kodom na e-mail, broji obrade i daje ti admin stranicu.
Prehrana, težina i postignuća **ne idu na server** – ostaju na mobitelu svakog polaznika.

Sve naredbe pokreći u Terminalu na Macu, u mapi `backend` svog repozitorija.
Prolaz traje oko 30–45 minuta, najviše zbog e-maila (DNS).

---

## 0. Što ti treba
- **Node.js** (ako `node -v` javi grešku): `brew install node` ili instalacija s nodejs.org (LTS).
- **Cloudflare račun** (besplatan): dash.cloudflare.com → Sign up.
- **Brevo račun** (besplatan): brevo.com → Sign up.
- **Novi Claude API ključ** samo za server: Claude Console → API keys → Create key (nazovi ga npr. `calquest-server`).
  Postavi mjesečni limit potrošnje u Consoleu (npr. $30).

## 1. Prijava u Cloudflare iz terminala
```
cd ~/putanja/do/sdg-tracker/backend
npx wrangler login
```
Otvori se preglednik → **Allow**.

## 2. Baza
```
npx wrangler d1 create calquest
```
Ispiše blok s `database_id = "…"`. Kopiraj taj ID u `wrangler.toml` umjesto `UPISI-ID-BAZE-OVDJE`. Zatim:
```
npx wrangler d1 execute calquest --remote --file schema.sql
```

## 3. Tajne (upisuju se jedna po jedna, terminal pita vrijednost)
```
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put CODE_SALT
npx wrangler secret put BREVO_API_KEY
```
- `ADMIN_PASSWORD` – dugačka lozinka za admin stranicu (npr. 4–5 nasumičnih riječi).
- `CODE_SALT` – bilo koji dugi niz znakova (samo ga utipkaj, ne trebaš ga pamtiti).
- `BREVO_API_KEY` – iz koraka 4 (možeš ga dodati i kasnije istom naredbom).

> Ako `secret put` traži da prvo napraviš Worker, napravi korak 5 (deploy) pa se vrati ovdje.

## 4. E-mail preko Brevo
1. Brevo → **Senders, Domains & Dedicated IPs → Domains → Add a domain** → `sdggym.com`.
2. Brevo pokaže 2–4 DNS zapisa (TXT `brevo-code`, DKIM, eventualno DMARC). Dodaj ih kod **Totohosta** (Zone Editor), točno kako piše.
   - Ako za `sdggym.com` već postoji **SPF** (TXT koji počinje s `v=spf1`), ne dodaj drugi – pošalji mi postojeći pa ti kažem kako ga dopuniti.
3. U Brevu klikni **Authenticate / Verify** (može trebati do sat vremena).
4. **Senders → Add a sender**: ime `SDG CalQuest`, e-mail `calquest@sdggym.com`.
   (Adresa ne mora imati sandučić – služi samo kao pošiljatelj.)
5. **SMTP & API → API Keys → Generate a new API key** → kopiraj i spremi kao `BREVO_API_KEY` (korak 3).

## 5. Objava servera
```
npx wrangler deploy
```
Prvi put možda pita za ime *workers.dev* poddomene – upiši npr. `sdggym`.
Na kraju ispiše adresu, npr. **`https://calquest-api.sdggym.workers.dev`**.

Provjera:
- otvori tu adresu → mora pisati „SDG CalQuest API radi.“
- otvori **adresa/admin** → preglednik traži korisničko ime i lozinku: ime je bilo što, lozinka je `ADMIN_PASSWORD`.

## 6. Dodaj sebe kao polaznika
Na admin stranici upiši svoj e-mail i ime → **Dodaj**.

## 7. Spoji aplikaciju na server
Pošalji mi adresu servera (ili sam u `index.html` na vrhu skripte upiši):
```
const BACKEND_URL = 'https://calquest-api.sdggym.workers.dev';
```
pa `git add -A && git commit -m "spajanje na server" && git push`.

## 8. Prva prijava na mobitelu
Otvori aplikaciju (potpuno je zatvori i ponovno otvori) → pojavi se ekran prijave → e-mail → kod iz maila → gotovo.
Tvoji dosadašnji podaci ostaju, a stari API ključ se sam briše s uređaja.

## 9. Nakon što sve radi
- U Claude Consoleu **obriši stari API ključ** koji si dosad koristio na mobitelu (i ako ga imaju testeri).
- Dodaj testere na admin stranici i javi im da se prijave.

---

### Svakodnevno
- **Novi polaznik:** admin → Dodaj (e-mail, ime). On otvori aplikaciju i prijavi se kodom.
- **Prestao plaćati:** isključi prekidač – pristup prestaje odmah, podaci mu ostaju na mobitelu.
- **Novi mobitel:** polaznik se samo prijavi na novom – stari se sam odjavi. Ako izgubi mobitel, klikni **Odjavi uređaj**.
- **Promjena modela ili limita:** admin → Postavke (vrijedi za sve od idućeg unosa).

### Sigurnosna kopija podataka
- Aplikacija nakon prve prijave sama napravi **ključ za kopiju** (npr. `ABCD-EFGH-…`) i pošalje ga polazniku e-mailom „Ključ za sigurnosnu kopiju“.
- Podaci se šifriraju na mobitelu i automatski šalju na server (otprilike jednom na sat ako ima promjena). Server ih ne može pročitati.
- **Novi mobitel:** polaznik se prijavi kodom → aplikacija ponudi vraćanje → upiše ključ iz e-maila → sve se vrati.
- **Izgubljen ključ:** dok stari mobitel radi, ključ je u Profilu → Sigurnosna kopija (Prikaži / Pošalji na e-mail). Bez ključa i bez starog mobitela kopija se ne može otvoriti – to je cijena šifriranja.
- Na admin stranici uz svakog polaznika vidiš kad je napravljena zadnja kopija.

### Promjene na serveru ubuduće
Kad ti pošaljem novu verziju `worker.js` ili `admin.html`: zamijeni datoteke u `backend/src` i pokreni `npx wrangler deploy`.
Ako dobiješ novu datoteku u `backend/migrations`, prije deploya je pokreni **jednom**: `npx wrangler d1 execute calquest --remote --file migrations/IME.sql`. (`schema.sql` je samo za potpuno novu bazu.)

### Što je gdje
- Na serveru: e-mailovi i imena polaznika, status, broj obrada i procijenjeni trošak po danu.
- Na mobitelu: sve ostalo (unosi, težina, obroci, postignuća).
- Na serveru je i **šifrirana** kopija tih podataka – bez ključa koji ima samo polaznik ne može se pročitati.
- Tekst i fotografije unosa prolaze kroz server do Claudea na obradu i nigdje se ne spremaju.

## 10. Naplata preko Stripea

Novi korisnici se sami registriraju e-mailom i dobivaju probno razdoblje (zadano 7 dana). Tijekom probnog razdoblja ti u adminu odabereš plan: **Član · 5 €**, **Vanjski · 9 €** ili **Besplatno** (treneri). Dok ne odabereš, korisnik se ne može pretplatiti. Kad odabereš cijenu, korisnik automatski dobiva e-mail s cijenom. Nakon toga se pretplati u aplikaciji (Profil → Pretplata). Ako to napravi tijekom probnog razdoblja, prva naplata je tek kad ono istekne.

Postojeći korisnici nakon migracije postaju **Besplatno**. Promijeni im plan u adminu kad želiš da počnu plaćati.

### 10.1 Baza (jednom)
```
cd backend
npx wrangler d1 execute calquest --remote --file migrations/002_naplata.sql
```

### 10.2 Stripe račun
1. Registriraj se na **stripe.com** s podacima d.o.o.-a (država Hrvatska, valuta EUR) i dovrši verifikaciju tvrtke i IBAN-a za isplate.
2. **Product catalog → Add product**: naziv `SDG CalQuest`. Dodaj dvije cijene, obje *Recurring · Monthly · EUR*:
   - 5,00 € → nakon spremanja kopiraj njen **Price ID** (`price_…`) – to je cijena za članove
   - 9,00 € → kopiraj **Price ID** – cijena za vanjske
3. **Settings → Billing → Customer portal**: uključi *Cancel subscriptions* (na kraju razdoblja) i *Update payment methods*. Spremi.
4. **Settings → Business → Public details**: provjeri naziv i e-mail – to korisnici vide na stranici plaćanja.
5. Preporuka: **Settings → Billing → Subscriptions and emails** – uključi automatske ponovne pokušaje naplate i e-mail kupcu kad kartica ne prođe.

### 10.3 Ključ i webhook
1. **Developers → API keys → Secret key** (`sk_live_…`) → u terminalu:
   ```
   npx wrangler secret put STRIPE_SECRET_KEY
   ```
2. **Developers → Webhooks → Add endpoint**
   - URL: `https://calquest-api.sdggym.workers.dev/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
   - nakon spremanja otvori endpoint → **Signing secret** (`whsec_…`) → u terminalu:
   ```
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

### 10.4 Varijable u wrangler.toml
U svoj `backend/wrangler.toml`, ispod postojećih redova u `[vars]`, dodaj (svoj e-mail i oba Price ID-ja):
```
APP_URL = "https://calquest.sdggym.com"
ADMIN_EMAIL = "tvoj@gmail.com"
STRIPE_PRICE_MEMBER = "price_…(5 €)"
STRIPE_PRICE_EXTERNAL = "price_…(9 €)"
```
Zatim `npx wrangler deploy`.

Dok ovo nije postavljeno, aplikacija korisnicima piše „Plaćanje uskoro“, a probno razdoblje i dalje radi.

### 10.5 Test prije pravih kupaca
Stripe ima *Test mode* (prekidač gore desno). Možeš sve gore napraviti prvo u test modu (`sk_test_…`, test cijene, test webhook), platiti karticom `4242 4242 4242 4242` (bilo koji datum u budućnosti i CVC) i vidjeti uplatu u adminu. Kad radi, ponovi 10.2–10.4 s live vrijednostima.

### 10.6 Svakodnevno
- **E-mail obavijesti** (na ADMIN_EMAIL): novi korisnik (s podatkom tvrdi li da je član), nova pretplata, svaka uplata, neuspjela naplata, otkazivanje.
- **Admin → Uplate**: popis po mjesecu (ime, e-mail, iznos, razdoblje, Stripe broj računa). Kad fiskaliziraš račun, kvačica **Fiskalizirano**. Pločica *Za fiskalizirati* pokazuje koliko ih je ostalo. **Izvezi CSV** otvara se u Excelu.
- **Promjena cijene** postojećem pretplatniku (npr. Član ↔ Vanjski): samo promijeni plan u adminu – nova cijena vrijedi od sljedeće naplate. **Besplatno** otkazuje pretplatu na kraju već plaćenog razdoblja.
- **+7 dana** produžuje probno razdoblje.
- Ako naplata ne uspije, korisnik ima još 3 dana pristupa, a Stripe sam ponavlja naplatu.
- Novac iz Stripea stiže na račun d.o.o.-a (isplate obično kroz nekoliko dana). Stripe ne fiskalizira – to radiš ti, kao i dosad.
- Registraciju novih korisnika možeš zatvoriti u adminu (Naplata i registracija → zatvorena).

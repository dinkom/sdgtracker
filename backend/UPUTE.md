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
Ako se promijenio i `schema.sql`, prije toga pokreni `npx wrangler d1 execute calquest --remote --file schema.sql` (sigurno je – ništa ne briše).

### Što je gdje
- Na serveru: e-mailovi i imena polaznika, status, broj obrada i procijenjeni trošak po danu.
- Na mobitelu: sve ostalo (unosi, težina, obroci, postignuća).
- Na serveru je i **šifrirana** kopija tih podataka – bez ključa koji ima samo polaznik ne može se pročitati.
- Tekst i fotografije unosa prolaze kroz server do Claudea na obradu i nigdje se ne spremaju.

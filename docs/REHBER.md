# selfbase rehberi

Bu rehber selfbase'i hiç görmemiş birinin onu anlaması, sıfırdan kurması, başka bir uygulama için
tekrar kurması ve ekibine anlatması için yazıldı. Her adımda üç şey var: **ne** yapıyorsun,
**neden** yapıyorsun ve **ne görmen gerekiyor**. Gördüğün şey farklıysa ne yapacağın da yazıyor.

Rehberde hiçbir gizli değer yok. Şifreleri ve anahtarları her zaman sen üretirsin ve `.env`
dosyasına (ya da Coolify'ın env ekranına) sen yazarsın. `.env` hiçbir zaman git'e girmez.

Bir kurulumu daha önce yaptıysan ve sadece yeni bir kurulum için sırayı hatırlamak istiyorsan
doğrudan [Canlı kurulum kontrol listesi](#canlı-kurulum-kontrol-listesi)'ne git. Var olan bir kurulumu
yeni bir selfbase sürümüne taşıyorsan: [Var olan bir kurulumu güncelleme](#var-olan-bir-kurulumu-güncelleme).

Komutların başında hangi kabukta çalıştığı yazıyor:
- **PowerShell**: kendi Windows bilgisayarın.
- **bash (sunucu)**: Linux sunucu.
- **Git Bash**: Windows'ta, Git ile gelen bash. Taşıma script'leri (`scripts/migrate/*.sh`) bash ister.

> **Bilmen gerekenler (kısa liste, ayrıntısı ilgili bölümde)**
>
> 1. **Canlıda HTTPS şart, seçenek değil.** `PUBLIC_URL` `https://` ile başlamalı ve tarayıcı core'a
>    HTTPS ile ulaşmalı. Düz `http://` (localhost dışında) üç somut şeyi bozar: (a) Google girişi
>    çalışmaz, dönüş çerezi `Secure` olduğu için her dönüş `bad_oauth_callback` verir; (b) panel çerezi
>    sadece `PUBLIC_URL` `https://` ise `Secure` olur, düz http'de panel şifresi ve oturum çerezi ağda
>    açık gider; (c) istemcinin token yenilemesini sekmeler arasında sıraya koyan Web Locks API'si sadece
>    güvenli bağlamda (HTTPS ya da localhost) var, olmadan iki sekme aynı anda yenileyip oturumu
>    düşürebilir. Uygulamanın CSP'sindeki `upgrade-insecure-requests` de http isteklerini bozar.
>    Yerelde `http://localhost` sorunsuz.
> 2. **Realtime token'ı WebSocket adresinin query string'inde gider** (`/realtime/v1?token=...`).
>    Önündeki reverse proxy'nin erişim logu `/realtime/v1` için query string yazmamalı.
> 3. **Yedekler aynı sunucuda duruyor.** Sunucu giderse yedek de gider. Canlıya geçmeden önce sunucu
>    dışına bir kopya ekle (bölüm 11).
> 4. **Cron işleri taşımada kapalı (inactive) kaydedilir.** Sadece geçiş günü, eski sistemdeki işler
>    durdurulduktan sonra açılır (bölüm 7, adım 9).
> 5. **Bildirim fonksiyonlarının kullandığı iki vault sırrı** (`notification_dispatch_secret`,
>    `radar_news_cron_secret`) fonksiyon sunucusunun env'iyle aynı olmalı (bölüm 7).
> 6. **Google girişi ve SMTP kendi bilgilerini ister.** SMTP yoksa e-postalar gönderilmez,
>    `selfbase.mail_log` tablosuna yazılır. Telefon doğrulama kapalı.
> 7. **Uygulamanın kendi Content-Security-Policy'si selfbase adresine izin vermeli** (`https://` ve
>    `wss://`). CorteQS'te CSP sabit yazılı, ekibin değiştirmesi gerekiyor (bölüm 8).
> 8. **Supabase'den bilinçli olarak farklı olanlar** var (bölüm 8.5): tekrar kayıt davranışı, token'sız
>    yükleme, telefon değişikliği doğrulaması, e-posta OTP kodu yok, PKCE yok, resim dönüştürme yok,
>    realtime'da sadece `eq` filtresi.
> 9. **Panel ve `/admin` internete tek bir şifreyle açık.** `/admin` süper kullanıcı yetkisiyle SQL
>    çalıştırır. Öneri (karar kurulumun sahibinin): bu iki yolu proxy'de kısıtla, IP listesiyle ya da
>    ek bir basic auth ile; ya da paneli sadece SSH tüneliyle kullan (bölüm 9).

## İçindekiler

1. [Büyük resim](#1-büyük-resim)
2. [Gereksinimler](#2-gereksinimler)
3. [Yerelde çalıştırma](#3-yerelde-çalıştırma)
4. [Anahtar üretimi ve `.env`'in her satırı](#4-anahtar-üretimi-ve-envin-her-satırı)
5. [Coolify'a kurulum](#5-coolifya-kurulum)
6. [Coolify'sız, düz Docker ile bir sunucuya kurulum](#6-coolifysız-düz-docker-ile-bir-sunucuya-kurulum)
7. [Supabase'den veri taşıma](#7-supabaseden-veri-taşıma)
8. [Uygulamayı bağlama](#8-uygulamayı-bağlama)
9. [Panel](#9-panel)
10. [Ekibin yeni migration'larını alma (sync)](#10-ekibin-yeni-migrationlarını-alma-sync)
11. [Yedekleme ve geri yükleme](#11-yedekleme-ve-geri-yükleme)
12. [Yeni bir uygulama için kurulum](#12-yeni-bir-uygulama-için-kurulum)
13. [Bilinen kısıtlar](#13-bilinen-kısıtlar)
14. [Sorun giderme](#14-sorun-giderme)

---

## 1. Büyük resim

### Ne bu?

selfbase, CorteQS'in kullandığı Supabase'in yerine geçen, kendi sunucumuzda çalışan küçük bir
backend. Uygulama kodu neredeyse hiç değişmiyor: uygulama yine `@supabase/supabase-js` import ediyor,
ama bu import derleme sırasında selfbase'in kendi istemcisine (`selfbase-js`) yönleniyor. Aynı adresler
(`/rest/v1`, `/auth/v1`, `/storage/v1`, `/realtime/v1`, `/functions/v1`) ve aynı cevap biçimleri
korunuyor.

### Neden?

- **Kontrol ve taşınabilirlik.** Her parçayı biliyoruz, istediğimiz sunucuya taşıyabiliyoruz.
- **Kaynak.** Self-host Supabase yaklaşık 10 container ister ve 4 GB+ RAM önerir. selfbase boşta
  yaklaşık **166 MiB** (boş veritabanıyla), CorteQS dev verisiyle yaklaşık **227 MiB** kullanıyor
  (db 129, core 58, rest 25, fn 15 MiB). Bu yüzden her uygulamaya ayrı bir kurulum vermek ucuz.
- **Şirket bağımlılığı yok.** Hiçbir `@supabase/*` paketi ya da `supabase/*` Docker imajı çalışmıyor.
  Sadece PostgREST'in istemci kodu (MIT lisanslı) repoya kopyalandı.

Kurulduğu sunucu: 31 GiB RAM, 8 CPU, başka projelerle paylaşımlı. selfbase'in payı bunun çok küçük
bir kısmı.

### Parçalar

```mermaid
flowchart LR
  B[Tarayıcı / uygulama<br/>selfbase-js] -->|HTTPS + WSS| P[Reverse proxy<br/>Coolify / Caddy]
  P --> C[core :8080<br/>Node]
  C -->|/rest/v1| R[rest<br/>PostgREST]
  C -->|/functions/v1| F[fn<br/>Deno]
  C --> D[(db<br/>Postgres 17)]
  R --> D
  F -->|SUPABASE_URL = core| C
  D -. net.http_post kuyruğu .-> C
```

Dışarıya sadece `core` açılır. Diğerleri sadece compose'un iç ağında konuşur. Beşinci container
`backup` şemada yok: dışarıyla konuşmaz, her gün 03:15 UTC'de veritabanının ve dosyaların yedeğini
alır (bölüm 11).

| Container | Ne | Supabase'de neyin yerine geçti | Neden böyle |
|---|---|---|---|
| `db` | Postgres 17 + PostGIS + pgvector + pg_cron (+ pg_trgm, unaccent, pgcrypto) | Supabase'in Postgres'i | Dev veritabanı PG 17, eklentiler aynı. `db/bootstrap/*.sql` ilk açılışta Supabase'e özgü şemaları (`auth`, `storage`, `vault`, `net`), rolleri (`anon`, `authenticated`, `service_role`) ve `auth.uid()` gibi fonksiyonları kurar, böylece migration'lar ve RLS policy'leri **hiç değişmeden** çalışır. |
| `rest` | PostgREST 14 | Supabase'in PostgREST'i | Aynı yazılım. Tablolar ve RPC'ler (`.from()`, `.rpc()`) buradan geçer. JWT'deki `role` ile RLS uygulanır. |
| `core` | Node servis (Hono) | GoTrue (auth), storage-api, realtime, Kong (gateway), Studio'nun yerine panel, pg_net'in gönderen tarafı | Dört Supabase servisini tek küçük süreçte topladık. Tek dış adres: `/auth/v1`, `/storage/v1`, `/realtime/v1`, `/admin`, `/panel/` doğrudan core'da; `/rest/v1` ve `/functions/v1` içeri yönlendiriliyor. |
| `fn` | Deno sunucusu | Supabase Edge Functions | Uygulamanın `supabase/functions/` klasörünü salt okunur bağlar. Fonksiyon dosyaları düzenlenmez: içlerindeki `esm.sh/@supabase/supabase-js` (ve `npm:@supabase/supabase-js`) import'u bir import map ile `selfbase-js`'e gider. Veritabanı şifresi almaz (bölüm 4, `fn.env`). |
| `backup` | `postgres` imajı, `scripts/backup.sh` | Supabase'in günlük yedeği | Her gün 03:15 UTC'de `pg_dump` ve dosya arşivi. Health check'i yok, `docker compose ps`'te sadece `Up` görünür; bu normal. |

Bazı kavramlar (bir kez açıklıyorum, sonra İngilizce kullanıyorum):
- **container**: kendi dosya sistemi olan, izole çalışan süreç. **volume**: container silinse de
  duran veri klasörü (`pgdata` veritabanı, `storage` yüklenen dosyalar).
- **migration**: veritabanı şemasını değiştiren SQL dosyası. **RLS** (Row Level Security) ve
  **policy**: Postgres'in "bu kullanıcı bu satırı görebilir mi" kuralları.
- **token**: kim olduğunu kanıtlayan imzalı metin (JWT). **endpoint**: bir HTTP adresi, ör. `/auth/v1/token`.
- **deploy**: kodu sunucuda derleyip çalışır hâle getirmek (Coolify'da **Deploy** düğmesi, düz
  Docker'da `docker compose up -d --build`).
- **health check**: Docker'ın bir container'a düzenli sorduğu "çalışıyor musun?" sorusu. Cevap
  olumluysa `docker compose ps` `(healthy)` gösterir.
- **reverse proxy**: internetten gelen HTTPS isteğini karşılayıp içerideki core'a ileten sunucu
  (Coolify'da Traefik, düz Docker'da Caddy ya da nginx).

### Önemli iç mekanizmalar

- **Kimlik.** core, Supabase'le aynı claim'lerle (`sub`, `role`, `email`, `aud`, `exp`) HS256 JWT
  imzalar. PostgREST aynı `JWT_SECRET` ile doğrular ve isteği JWT'deki role ile çalıştırır.
  `ANON_KEY` ve `SERVICE_ROLE_KEY` da bu secret ile imzalanmış uzun ömürlü JWT'lerdir.
- **Storage.** Dosyalar diskte (`storage` volume). Her yükleme ve okumada core, kullanıcının
  JWT'siyle `storage.objects` üzerinde sorgu yapar, yani yetkiyi yine Postgres policy'leri verir.
- **Realtime.** Realtime açılan tabloda bir trigger `pg_notify` gönderir. core değişen satırı abone
  olan her kullanıcının JWT'siyle tekrar okur, böylece kullanıcı sadece RLS'in izin verdiği satırı görür.
- **`net.http_post`.** Supabase'de pg_net eklentisi SQL'den HTTP isteği atar. selfbase'de bu fonksiyon
  isteği `selfbase.http_queue` tablosuna yazar, core gönderir. `*.supabase.co` adresine giden her istek
  iç adrese (fonksiyonlar için `fn`, diğerleri için core) çevrilir. **Kopyadan Supabase'e istek gitmez.**
- **Panel.** Ayrı container değil, core `/panel/` altında statik dosya olarak sunar.
- **İstemcinin IP'si.** core, isteği PostgREST'e ve fonksiyonlara iletirken istemcinin gönderdiği
  `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP` ve `Forwarded` başlıklarını
  siler; ilk üçünü kendi bulduğu IP ile yeniden yazar (`TRUST_PROXY=true` ise proxy'nin eklediği en
  sağdaki `X-Forwarded-For` değeri, değilse bağlantının adresi). Yani bir fonksiyon
  `req.headers.get('x-forwarded-for')`, SQL de `current_setting('request.headers', true)::json ->> 'x-forwarded-for'`
  ile güvenilir IP'yi okur; istemci bunu uyduramaz. Auth hız sınırları ve panelin şifre kilidi de
  aynı IP'yi kullanır.

### Repo haritası

| Yol | İçerik |
|---|---|
| `compose.yml` | Bütün yığın (stack). Değerleri `.env`'den alır. |
| `compose.local.yml` | Sadece yerelde: veritabanını `127.0.0.1` üzerinde açar (taşıma script'leri için). |
| `.env.example`, `fn.env.example` | Doldurulacak değişkenlerin listesi. |
| `db/` | Postgres imajı, `bootstrap/*.sql` (sadece boş bir veritabanının ilk açılışında çalışır) ve `upgrade/*.sql` (var olan kurulumlar için elle çalıştırılır, bölüm 6). |
| `core/` | Node servisi: `src/auth`, `src/storage`, `src/realtime`, `src/admin`, `src/netqueue`. |
| `fn/` | Deno fonksiyon sunucusu. |
| `panel/` | Yönetim paneli (React). core imajının içinde derlenir. |
| `client/` | `selfbase-js`. `client/dist/` derlenmiş hali, repoda duruyor. |
| `scripts/` | `gen-keys.mjs`, `set-panel-password.mjs`, `migrate/` (Supabase'den taşıma), `sync.mjs`, `backup.sh`, `restore.sh`. |
| `docs/` | Bu rehber, `auth-settings.md` (eski sistemin auth ayarları), `functions-status.md`, `screens/`. |

---

## 2. Gereksinimler

### Kendi bilgisayarında (Windows)

| Ne | Neden | Kontrol (PowerShell) | Beklenen |
|---|---|---|---|
| Docker Desktop | Bütün yığın container'da çalışır | `docker compose version` | `Docker Compose version v2.24.0` ya da daha yeni (v5 de olur). `compose.yml` içindeki `env_file: required: false` 2.24 ister. |
| Git | Repoyu almak için. Git Bash da onunla gelir. | `git --version` | herhangi bir sürüm |
| Node.js 22 ya da 24 | Anahtar üretme ve panel şifresi script'leri bilgisayarında çalışır | `node --version` | `v22...` ya da `v24...` |

Docker Desktop açık olmalı. `docker compose version` "cannot connect" diyorsa Docker Desktop'ı başlat
ve tekrar dene.

### Sunucuda (Linux)

- Ubuntu 22.04/24.04 ya da benzeri, Docker Engine ve Compose eklentisi (bölüm 6'da kurulum var).
- RAM: selfbase boşta 250 MiB'ın altında. İlk derleme (`--build`) sırasında geçici olarak 1-2 GB
  kullanılabilir. 2 GB RAM'li bir sunucu yeter.
- Disk: imajlar yaklaşık 2-3 GB, üstüne veri ve yedekler.
- Bir alan adı (ör. `selfbase.ornek.com`) ve sunucunun IP'sine giden bir DNS A kaydı. HTTPS için şart.
- Dışarıdan açık portlar: sadece 80 ve 443 (reverse proxy). core'un 8080'i dışarı açılmaz.

Node sunucuda sadece panel şifresini sunucuda ayarlamak istersen gerekir. Şifreyi kendi
bilgisayarında ayarlayıp iki satırı kopyalayabilirsin (bölüm 9).

---

## 3. Yerelde çalıştırma

Amaç: kendi bilgisayarında boş bir selfbase ayağa kaldırmak, `GET /health` cevabını ve panelin giriş
sayfasını görmek. Yaklaşık 10 dakika (ilk derleme internet hızına bağlı).

**1. Repoyu al.** (PowerShell)

```powershell
git clone <REPO_URL> selfbase
cd selfbase
```

`<REPO_URL>`: selfbase'in GitHub adresi (GitHub'da repo sayfası → yeşil **Code** düğmesi → HTTPS).
Repo özel olduğu için GitHub girişi istenebilir.

**2. `.env` dosyasını oluştur.** `.env.example` doldurulacak değişkenlerin listesi. Kopyası `.env`
olur ve git onu hiç görmez (`.gitignore`'da).

```powershell
Copy-Item .env.example .env
```

**3. Anahtarları ve veritabanı şifresini üret.**

```powershell
node scripts/gen-keys.mjs
node -e "console.log('POSTGRES_PASSWORD=' + require('crypto').randomBytes(24).toString('base64url'))"
```

Beklenen: dört satır, `JWT_SECRET=...`, `ANON_KEY=eyJ...`, `SERVICE_ROLE_KEY=eyJ...` ve
`POSTGRES_PASSWORD=...`. Neden: `JWT_SECRET` bütün token'ları imzalayan sır; diğer iki anahtar onunla
imzalanmış JWT'ler. Veritabanı şifresi base64url (sadece harf, rakam, `-`, `_`), çünkü bağlantı
adreslerinin içine girecek ve orada özel karakter sorun çıkarır. Her çalıştırmada yeni değerler çıkar.
Bu çıktıyı başka bir yere kaydetme, sadece bir sonraki adımda `.env`'e yapıştır.

> **Sırlar**
>
> - Bu çıktıyı sohbetlere, ticket'lara, e-postaya ya da ekran görüntüsüne koyma. `.env`'e yapıştırdıktan
>   sonra terminalin geçmişini temizle (PowerShell'de `Clear-Host`, sonra pencereyi kapat).
> - Sunucuda `.env` sadece senin okuyabileceğin şekilde durur: `chmod 600 .env` (bölüm 6).
> - Yedekler her şeyi içerir (bütün satırlar, kullanıcıların şifre hash'leri, vault sırları). Yedek
>   klasörünü de `.env` gibi koru (bölüm 11).

**4. `.env`'i doldur.**

```powershell
notepad .env
```

Şu satırları bul ve değerleri yaz (eşittir işaretinin hemen arkasına, tırnak ve boşluk olmadan):

| Satır | Değer |
|---|---|
| `POSTGRES_PASSWORD=` | 3. adımdaki değer |
| `JWT_SECRET=` | 3. adımdaki değer |
| `ANON_KEY=` | 3. adımdaki değer |
| `SERVICE_ROLE_KEY=` | 3. adımdaki değer |
| `PUBLIC_URL=` | `http://localhost:8080` |
| `SITE_URL=` | `http://localhost:5173` (uygulamanın yerel adresi; bilmiyorsan böyle bırak) |

Dosyanın en altına şu satırı ekle:

```
COMPOSE_PROJECT_NAME=selfbase-deneme
```

Neden: Docker her kurulumu bir "proje adı" ile ayırır; container'lar, volume'ler ve ağ bu adla başlar.
Ad vermezsen klasörün adı kullanılır ve aynı adlı iki klasör aynı veriyi paylaşır. Bilgisayarında
var olan adlara bak, kullanılmayan bir ad seç:

```powershell
docker compose ls
```

Kaydet ve Notepad'i kapat. Diğer satırları şimdilik boş bırak; ne olduklarını bölüm 4 anlatıyor.

**5. Port 8080 boş mu?**

```powershell
netstat -ano | findstr ":8080 "
```

Çıktı yoksa port boş, 6. adıma geç. `LISTENING` içeren bir satır varsa 8080'i başka bir program
kullanıyor. O zaman aynı komutla `8081`'e bak; boşsa `.env`'in sonuna `CORE_PORT=8081` ekle ve
`PUBLIC_URL=http://localhost:8081` yap (bu bölümün geri kalanında `8080` yerine `8081` kullan).
O da doluysa 8082, 8083... ile aynısını yap.

**6. Yığını derle ve başlat.**

```powershell
docker compose up -d --build
```

Ne oluyor: `db`, `core` ve `fn` imajları derleniyor (core imajı paneli de derler), PostgREST imajı
indiriliyor, beş container (db, rest, core, fn, backup) başlıyor. İlk sefer 3-10 dakika sürer, sonrakiler saniyeler. Sonunda her
container için `Started` ya da `Healthy` görürsün. Veritabanı ilk açılışta `db/bootstrap/*.sql`'i
çalıştırır; bu sadece boş bir `pgdata` volume'ünde olur.

Beklenen son satırlar şuna benzer (terminale göre başlarında `✔` olabilir):

```
 Container selfbase-deneme-db-1 Healthy
 Container selfbase-deneme-rest-1 Healthy
 Container selfbase-deneme-core-1 Starting
 Container selfbase-deneme-core-1 Started
```

`set POSTGRES_PASSWORD`, `set JWT_SECRET`, `set PUBLIC_URL`, `set SITE_URL`, `set ANON_KEY` ya da
`set SERVICE_ROLE_KEY` hatası: `.env`'de o satır boş kalmış, 4. adıma dön. Bunlar olmadan compose hiç
başlamaz; boş bir değerle sessizce yanlış çalışmaktansa durmak daha iyi.
`port is already allocated`: 5. adımı yap.

**7. Durumu kontrol et.**

```powershell
docker compose ps
```

Beklenen: `db`, `rest`, `core`, `fn`: `Up ... (healthy)`; `backup`: `Up` (health check'i yok, normal;
ilk yedeği gece 03:15 UTC'de alır, bölüm 11). core bir iki dakika `(health: starting)` görünebilir;
birkaç saniye bekleyip tekrar çalıştır.

**8. Sağlık kontrolü.**

```powershell
curl.exe -s http://localhost:8080/health
```

Beklenen: `{"ok":true}`. (PowerShell'de `curl` başka bir komutun takma adı; `curl.exe` yaz.)
core veritabanına ulaşamıyorsa `/health` 503 ve `{"ok":false,"error":"database unavailable"}` döner;
Docker da core'u sağlıksız gösterir.

**9. Panel.** Tarayıcıda `http://localhost:8080/panel/` aç. Beklenen: üstte **selfbase**, altında
**Yönetim paneli** yazan giriş sayfası (e-posta ve şifre alanları). Henüz giriş yapamazsın, çünkü panel şifresi ayarlanmadı; bölüm 9 bunu anlatıyor.

![Panel giriş sayfası](screens/01-login.png)

**10. Durdurmak ve silmek.**

```powershell
docker compose stop        # durdurur, her şey yerinde kalır; tekrar: docker compose start
docker compose down        # container'ları siler, veri (volume) kalır
docker compose down -v     # container'ları, veriyi VE yedekleri siler; geri dönüşü yok
```

`down -v` bütün volume'leri siler: veritabanı (`pgdata`), dosyalar (`storage`) ve yedekler (`backups`
volume'ü; `BACKUP_DIR` sunucuda bir klasörse o kalır). Sunucuda neredeyse hiçbir zaman gerekmez.

---

## 4. Anahtar üretimi ve `.env`'in her satırı

### Anahtarlar

`node scripts/gen-keys.mjs` üç satır yazar:

- `JWT_SECRET`: 64 karakterlik rastgele sır. core token imzalar, PostgREST ve fn doğrular.
  **En az 32 karakter** olmalı, yoksa core açılmaz (`JWT_SECRET must be at least 32 characters`).
- `ANON_KEY`: `role: anon`, 10 yıl geçerli JWT. Tarayıcıya giden, gizli olmayan anahtar
  (Supabase'deki "anon / publishable key"). Tek başına sadece RLS'in `anon`'a izin verdiğini yapar.
- `SERVICE_ROLE_KEY`: `role: service_role`, 10 yıl geçerli. **RLS'i atlar.** Sadece sunucu tarafında
  (fonksiyonlar, script'ler) kullanılır, tarayıcıya asla gitmez.

Neden kendimiz üretiyoruz: anahtarlar `JWT_SECRET`'a bağlı. Supabase'in anahtarları başka bir sırla
imzalı, selfbase'de geçersiz.

**`JWT_SECRET`'ı değiştirirsen** bütün anahtarlar ve bütün oturumlar geçersiz olur: üç değeri birlikte
yeniden üret, uygulamaya yeni `ANON_KEY`'i ver, `docker compose up -d` ile yığını yeniden başlat.
Kullanıcıların tekrar giriş yapması gerekir. Panel oturumları da düşer.

### `.env` biçimi

Her satır `AD=değer`. **Tırnak koyma, satır sonuna `#` yorum yazma, `$` kullanma.** Neden: bu dosyayı
hem docker compose hem taşıma script'leri okuyor ve ikisi tırnak/yorum/`$` konusunda farklı davranıyor.
Tek istisna `PANEL_ADMIN_PASSWORD_HASH`: onu script yazar ve içindeki `$`'ları bilerek `$$` yapar
(compose `$$`'ı tek `$`'a çevirir).

### Satır satır `.env`

| Değişken | Ne | Nereden / örnek | Ne zaman değişir |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Veritabanı süper kullanıcısı `postgres`'in ve PostgREST'in bağlandığı `authenticator` rolünün şifresi | Bölüm 3'teki `node -e ...` komutu. URL'de özel anlamı olan karakter (`/ # ? @ : %`) olmasın. | **Sadece ilk açılışta uygulanır.** Sonradan `.env`'de değiştirmek veritabanını değiştirmez; bkz. bölüm 14. |
| `JWT_SECRET` | Token imzalama sırrı, en az 32 karakter | `gen-keys.mjs` | Değişirse bkz. yukarı. |
| `ANON_KEY` | Herkese açık anahtar | `gen-keys.mjs` | `JWT_SECRET` ile birlikte |
| `SERVICE_ROLE_KEY` | RLS'i atlayan sunucu anahtarı | `gen-keys.mjs` | `JWT_SECRET` ile birlikte |
| `PUBLIC_URL` | core'un dışarıdan görünen adresi. Uygulama bunu `SUPABASE_URL` olarak kullanır. E-posta linkleri, dosya adresleri ve Google dönüş adresi bundan üretilir. | **Zorunlu.** Yerelde `http://localhost:8080`, canlıda `https://selfbase.ornek.com` (sonunda `/` yok; canlıda mutlaka `https://`, bkz. en baştaki liste) | Alan adı değişince. Değişirse kullanıcılar bir kez çıkış yapmış olur: istemci oturumu adresin ilk parçasına göre adlandırılmış bir anahtarda saklar (`sb-<ilk parça>-auth-token`, ör. `sb-selfbase-auth-token`), yeni adreste eski oturumu bulamaz. |
| `TRUST_PROXY` | `true`: istemcinin IP'si `X-Forwarded-For` başlığının **en sağdaki** değerinden alınır (önündeki proxy'nin eklediği). Panelin şifre kilidi, auth hız sınırları ve fonksiyonlara/SQL'e iletilen IP başlıkları (bölüm 1) bu IP'yi kullanır. | Proxy arkasında `true`. core doğrudan internete açıksa `false` (yoksa herkes başlığı uydurabilir). Yerelde fark etmez. Önüne bir CDN (ör. Cloudflare) konursa en sağdaki değer CDN'in IP'si olur: herkes aynı IP'den geliyor görünür ve bir kişinin yanlış denemeleri herkesi kilitler; o zaman bu ayar yeniden düşünülmeli. | Kurulum biçimine göre |
| `TRUSTED_PROXY_IPS` | `TRUST_PROXY=true` iken `X-Forwarded-For` başlığına hangi bağlantılardan inanılacağı. Hiç yazılmazsa `*` sayılır: her bağlantıdan (2.1.0 öncesindeki davranış). Virgülle IP listesi yazılırsa sadece o adreslerden. Yazılıp boş bırakılırsa (`TRUSTED_PROXY_IPS=`) hiçbirinden: herkes proxy'nin IP'sinden geliyor görünür ve aynı auth hız sınırını paylaşır. | Tek yığında yazma (core'a sadece Caddy ulaşabiliyorsa `*` doğru). Aynı ağda core'a doğrudan ulaşabilen başka konteynerler varsa proxy'nin IP'sini yaz. selfbase sunucusunda provisioner bunu her proje için proxy konteynerinin adresine kendisi ayarlar; elle yazılan değer yok sayılır. | Proxy'nin adresi değişince |
| `NETQUEUE_ALLOW_HOSTS` | `net.http_*` (pg_net) istekleri özel, loopback ve link-local adreslere (ya da bu adreslere çözülen adlara) gidemez. Buradaki adlar ya da IP'ler (virgülle, birebir eşleşir) bu kuralın dışında tutulur. | Boş (varsayılan): sadece internetteki adreslere gider. Örnek: kendi ağındaki bir servise SQL'den istek atılacaksa `servis.ic-ag.local`. | Yeni bir iç servis eklenince |
| `SITE_URL` | **Zorunlu.** Uygulamanın adresi. Auth yönlendirmeleri `redirect_to` izinli değilse buraya döner. | `https://app.ornek.com` ya da yerelde `http://localhost:5173` | Uygulama adresi değişince |
| `AUTH_REDIRECT_ALLOWLIST` | E-posta linki ve Google girişinden sonra dönülebilecek adresler, virgülle. | Örnek: `http://localhost:8099/**,https://app.ornek.com/**`. Joker yoksa birebir eşleşir; sondaki `*` ya da `**` altındaki her yolu kabul eder; yol içindeki `*` tek bir parçayı. | Yeni bir uygulama adresi eklenince |
| `AUTH_CONFIRM_EMAIL` | `true`: kayıttan sonra e-posta doğrulanmadan giriş yok | `true` (eski sistemle aynı) | |
| `AUTH_PHONE_ENABLED` | Telefon doğrulama | `false`. Açmak için `AUTH_SMS_HOOK_SECRET` ve uygulamanın `send-phone-otp-hook` fonksiyonu gerekir; uçtan uca denenmedi. | |
| `AUTH_MIN_PASSWORD` | Kullanıcı şifresinin en az uzunluğu | `6` (eski sistemle aynı) | |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Auth e-postalarını (doğrulama, şifre sıfırlama, sihirli link) gönderen sunucu | Ekipten gelecek. Port boşsa 587. **`SMTP_HOST` boşsa e-posta gönderilmez,** `selfbase.mail_log` tablosuna yazılır (yerelde linke oradan bakarsın). | SMTP bilgisi gelince |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google girişi | Google Cloud Console → OAuth client. Yetkili dönüş adresi: `<PUBLIC_URL>/auth/v1/callback`. Boşsa Google girişi çalışmaz. | |
| `PANEL_ADMIN_EMAIL`, `PANEL_ADMIN_PASSWORD_HASH` | Panel girişi | **Elle yazma,** `node scripts/set-panel-password.mjs` yazar (bölüm 9). Hash boşsa panele kimse giremez; varsayılan şifre yoktur. | |
| `SUPABASE_DIR` | Fonksiyon kaynağı: uygulama reposundaki `supabase/` klasörünün **bilgisayardaki/sunucudaki yolu** (içinde `functions/` ve `config.toml`). fn bunu salt okunur bağlar. | Windows'ta ör. `D:/Dev/corteqsemir/supabase` (ileri eğik çizgiyle), Linux'ta `/opt/apps/corteqsemir/supabase`. Boşsa fonksiyon yok, her ad 404 döner. | Uygulama reposunun yeri değişince |
| `PGRST_URL`, `FN_URL` | core'un PostgREST'e ve fn'e iç adresi | `http://rest:3000`, `http://fn:8000`. Değiştirme. | |

`STORAGE_DIR` artık `.env`'de yok: compose core'a sabit `/data/storage` verir (`storage` volume'ünün
bağlandığı yer); değiştirmek dosyaları volume'ün dışına taşırdı. Taşımada 04 için bu değer komut
satırında geçici olarak verilir (bölüm 7, adım 6).

`.env.example`'da olmayan ama işine yarayacak satırlar:

| Değişken | Ne | Varsayılan |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | Docker proje adı (bölüm 3, adım 4). Aynı makinede iki kurulum için şart. | klasör adı |
| `CORE_PORT` | core'un makinede açıldığı port. Sadece port numarası yaz (`8090`); adres `CORE_BIND` ile verilir. | `8080` |
| `CORE_BIND` | core'un hangi adreste açıldığı. Varsayılan `127.0.0.1`: sadece makinenin içinden erişilir (reverse proxy aynı makinedeyse doğrusu bu). `0.0.0.0` core'u ağdaki herkese açar; sadece aynı makinede proxy yoksa yaz. | `127.0.0.1` |
| `LOCAL_DB_PORT` | `compose.local.yml` ile veritabanının `127.0.0.1`'de açıldığı port | `55432` |
| `BACKUP_DIR`, `BACKUP_RETENTION_DAYS` | Yedeklerin yeri: boşsa `backups` volume'ü; doluysa sunucuda **mutlak bir klasör yolu** (başka bir volume adı yazmak compose hatası verir: `refers to undefined volume`). Sunucuda klasör kullan (bölüm 11). Ve kaç gün saklanacağı. | `backups` volume'ü, `7` |

Yorum satırı olarak duran auth ayarları (yazmazsan sağdaki varsayılan geçerli; değiştirince
`docker compose up -d core`):

| Değişken | Ne | Varsayılan |
|---|---|---|
| `AUTH_SECURE_EMAIL_CHANGE` | `true`: e-posta değişikliğinde hem yeni hem eski adrese link gider, değişiklik ikisi de tıklanınca olur (bölüm 8.5). `false`: sadece yeni adrese. | `true` |
| `AUTH_REFRESH_REUSE_INTERVAL` | Bir refresh token kullanıldıktan sonra kaç saniye içinde tekrar gelirse aynı yeni oturumun verileceği (bölüm 8.5). `0`: tekrar kullanım her zaman oturumu kapatır. | `10` |
| `AUTH_SET_PASSWORD_URL` | Doğrulanmamış bir e-postayla farklı şifreyle tekrar kayıt olunduğunda doğrulama linkinin götürdüğü şifre belirleme sayfası. `AUTH_REDIRECT_ALLOWLIST`'te olmalı. CorteQS'te `<SITE_URL>/reset-password`. Boşsa kaydın `redirect_to`'su. | boş |
| `AUTH_RATE_LIMIT_SIGN_IN` | Bir IP'nin 5 dakikada en çok kaç giriş ve kayıt isteği atabileceği | `30` |
| `AUTH_RATE_LIMIT_VERIFY` | Aynısı, e-posta linki doğrulama (`/verify`) için | `30` |
| `AUTH_RATE_LIMIT_REFRESH` | Aynısı, token yenileme için | `150` |
| `AUTH_RATE_LIMIT_EMAIL` | Aynısı, e-posta gönderen istekler (`/otp`, `/recover`, `/resend`) için | `30` |

Sınır aşılınca core 429 ve `over_request_rate_limit` döner (Supabase'in döndüğü kod). Değerler eski
sistemdekilerle aynı (`docs/auth-settings.md`). `0` o sınırı kapatır. Sayaçlar bellekte: core yeniden
başlayınca sıfırlanır.

Taşıma (bölüm 7) ve sync (bölüm 10) için ayrıca `SUPABASE_DB_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `TARGET_DB_URL`, `TARGET_DB_URL_HOST`, `DOCKER_NETWORK` gibi değişkenleri de `.env`'e yazacaksın;
onlar orada anlatılıyor.

Yorum satırı olarak duranlar (`AUTH_OTP_EXPIRY`, `AUTH_EMAIL_INTERVAL`, `AUTH_SMS_HOOK_SECRET`,
`GOOGLE_*_URL`, `STORAGE_MAX_UPLOAD_BYTES`, `FN_IMPORT_TIMEOUT_MS`) compose üzerinden geçer; yazmazsan
varsayılanlar geçerli: 3600 sn, 60 sn, 50 MiB, 30000 ms.

**Kaynak sınırları.** Paylaşımlı sunucuda bir kaçak sorgu ya da fonksiyon diğer projeleri boğmasın
diye her servisin bellek ve CPU sınırı `compose.yml`'de yazılı:

| Servis | Bellek (`mem_limit`) | CPU (`cpus`) |
|---|---|---|
| db | 1 GB | 2 |
| core | 512 MB | 1 |
| rest | 256 MB | 1 |
| fn | 512 MB | 1 |
| backup | 512 MB | 0.5 |

Hepsinde en fazla 512 süreç (`pids_limit`), container içinde yetki yükseltme kapalı
(`no-new-privileges`), loglar 10 MB'lık en fazla 3 dosyada döner (Docker'ın varsayılanı sınırsız
büyür). db'nin paylaşımlı belleği 256 MB (`shm_size`; Docker'ın 64 MB'ı paralel sorgularda "could not
resize shared memory segment" hatası verir). Değiştirmek için `compose.yml`'de o servisin satırını
düzelt ve `docker compose up -d` çalıştır. Bir servis sınıra dayanırsa `docker stats` onu gösterir;
bellek sınırını aşan süreç öldürülür ve container yeniden başlar (`docker compose ps`'te yeniden
başlama sayısı artar).

**REST'in sınırları.** PostgREST sadece `public` şemasını sunar; `storage` şeması REST'ten görünmez
(dosyalar `/storage/v1` ile). Bir istek en fazla 1000 satır döner (daha fazlası için sayfalama:
`.range()`). Sorgu süresi `anon` için 3 saniye, giriş yapmış kullanıcı (`authenticated`) için 8
saniye; aşan sorgu iptal edilir (`canceling statement due to statement timeout`). `service_role`'ün
sınırı yok. Bu süreler veritabanında rol ayarı (`db/bootstrap/60-guards.sql`); değiştirmek için
`alter role anon set statement_timeout = '5s';` ve `docker compose restart rest`. Not: anahtarsız
(`anon`) `GET /rest/v1/` (bütün şemanın OpenAPI açıklaması) büyük bir veritabanında 3 saniyeyi geçip
500 dönebilir; uygulama bunu kullanmaz.

### `fn.env` (fonksiyonların sırları)

Fonksiyonlar Stripe, WhatsApp, Gemini gibi servislerin anahtarlarını ister. Bunlar ayrı bir dosyada,
`fn.env`'de durur ve sadece `fn` container'ına gider (core ve veritabanı bunları görmez).

```powershell
Copy-Item fn.env.example fn.env
notepad fn.env
```

Sadece kullandığın satırları doldur. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
ve `JWT_SECRET`'ı **yazma**: compose bunları selfbase'in kendi değerleriyle verir.

fn veritabanı şifresi **almaz** (`SUPABASE_DB_URL` verilmez). Neden: fonksiyonlar çalışırken
internetten üçüncü taraf kod indirir; içlerinden biri bozulursa veritabanının süper kullanıcısı
olmasın. Fonksiyonlar veriye `SUPABASE_SERVICE_ROLE_KEY` ile, REST üzerinden ulaşır. Bir fonksiyon
gerçekten doğrudan veritabanı bağlantısı isterse `SUPABASE_DB_URL`'i `fn.env`'e bilerek sen eklersin.
İndirilen modüller `denocache` volume'ünde durur, fn yeniden başlayınca tekrar indirilmez.
`fn.env` yoksa fn yine açılır, anahtar isteyen fonksiyonlar 500 döner. Hangi fonksiyonun hangi anahtarı
beklediği `docs/functions-status.md`'de: 24 fonksiyondan 19'u yükleniyor, 5'i kendi API anahtarını
bekliyor. Değiştirdikten sonra: `docker compose up -d fn`.

---

## 5. Coolify'a kurulum

<!-- to be confirmed against the real deployment; screenshots to add -->

> Bu bölüm reponun desteklediği şeylerden yazıldı; gerçek Coolify kurulumu henüz yapılmadı. İlk
> kurulumda adımlar ve ekran görüntüleri bununla karşılaştırılıp düzeltilecek. Emin olunmayan yerler
> **(doğrulanacak)** diye işaretli.

Coolify, sunucuya kurulan bir yönetim paneli: git reposundan compose dosyasını alır, derler,
container'ları çalıştırır ve önlerine HTTPS'li bir reverse proxy (Traefik) koyar. Bizim tarafımızda
farklı olan tek şey: `.env` dosyası yerine değerleri Coolify'ın ekranına girmek.

**Paylaşımlı sunucu kuralı:** sunucudaki diğer projelere ve Coolify proxy'sine dokunma, proxy'yi
yeniden başlatma. selfbase kendi projesinde kalır.

**1. Uygulama reposunu sunucuya koy (fonksiyonlar için).** fn, uygulamanın `supabase/` klasörünü
sunucudaki bir yoldan bağlar. Coolify bunu kendisi getirmez. Sunucuya SSH ile bağlan (bash, sunucu):

```bash
sudo mkdir -p /opt/apps && sudo chown "$USER" /opt/apps
git clone <UYGULAMA_REPO_URL> /opt/apps/corteqsemir
ls /opt/apps/corteqsemir/supabase/functions | head
```

Beklenen: fonksiyon klasörlerinin adları (`admin-knowledge`, `delete-account`, ...). Bu yol
`SUPABASE_DIR=/opt/apps/corteqsemir/supabase` olacak. Fonksiyonlar değişince:
`git -C /opt/apps/corteqsemir pull` ve Coolify'da `fn` servisini yeniden başlat.

**2. Yeni kaynak.** Coolify → projen (ör. `selfbase-corteqs`, yoksa **+ Add** ile oluştur) →
**+ New** → **Private Repository** (GitHub App ile ya da Deploy Key ile; repo özel) → selfbase reposu,
branch → **Build Pack: Docker Compose** → **Docker Compose Location:** `/compose.yml`. Kaydet.
Coolify compose dosyasını okur ve servisleri (`db`, `rest`, `core`, `fn`, `backup`) listeler.

**3. Alan adı sadece core'a.** Servis listesinde `core`'un **Domains** alanına
`https://selfbase.ornek.com:8080` yaz. `:8080` container içindeki port; dışarıdan adres yine
`https://selfbase.ornek.com` olur, Coolify'ın proxy'si 443'ü bu porta yönlendirir ve sertifikayı alır.
`db`, `rest`, `fn` için alan adı **girme**: dışarı açılmamalılar.

**4. Environment variables.** Coolify compose dosyasındaki `${...}` değişkenlerini **Environment
Variables** sekmesinde listeler. Bölüm 4'teki tabloya göre doldur:

- Kendi bilgisayarında `node scripts/gen-keys.mjs` ve bölüm 3'teki şifre komutunu çalıştır, çıkan
  değerleri `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY` alanlarına yapıştır.
- `PUBLIC_URL=https://selfbase.ornek.com`, `SITE_URL=` uygulamanın adresi,
  `AUTH_REDIRECT_ALLOWLIST=` uygulamanın adresleri.
- `TRUST_PROXY=true` (Traefik `X-Forwarded-For` ekler).
- `CORE_PORT=18080`. Neden: `compose.yml` core'un portunu makinede de açar. Coolify'da buna gerek
  yok (trafik proxy'den gelir), ama sunucudaki başka bir 8080 ile çakışabilir. `CORE_BIND` varsayılan
  olarak `127.0.0.1` olduğu için core zaten sadece sunucunun içinden erişilir, HTTPS'siz internete
  açılmaz; `CORE_BIND`'e dokunma. Sunucuda 18080 kullanılıyorsa başka bir port seç. Coolify'ın proxy'si core'a iç ağdan, container'ın 8080'ine gider;
  `CORE_PORT` sadece makinedeki çakışmayı önler. **(doğrulanacak: Coolify'ın `ports`'u olduğu gibi
  yayınlayıp yayınlamadığı; yayınlamıyorsa satır zararsız)**
- `SUPABASE_DIR=/opt/apps/corteqsemir/supabase` (1. adım).
- SMTP ve Google bilgileri geldiyse onlar.
- Panel için `PANEL_ADMIN_EMAIL` ve `PANEL_ADMIN_PASSWORD_HASH`: bölüm 9'daki "sunucu için" yolu.
  **(doğrulanacak: hash'in Coolify'a `.env`'deki gibi `$$`'lı mı, yoksa "literal" işaretli ham hâliyle
  mi girileceği. Girişi deneyerek kontrol et.)**

**5. Fonksiyon sırları (`fn.env`).** **(doğrulanacak)** `compose.yml` fonksiyon sırlarını
sunucudaki `fn.env` dosyasından okur (yoksa sessizce atlar). Coolify'ın env ekranına girilen değerler
sadece compose dosyasında adı geçen değişkenlere gider, `fn.env`'in içindekiler orada geçmez. İlk
kurulumda Coolify'ın repoyu açtığı klasöre `fn.env` koymanın yeniden deploy'da korunup korunmadığı
denenecek. Korunmuyorsa bu, compose'da küçük bir değişiklik ister; o zamana kadar fonksiyonlar
anahtarsız çalışır (19'u açılır, anahtar isteyen 5'i 500 döner). **(doğrulanacak: Coolify'ın
`env_file` uzun sözdizimini (`path`/`required`) kabul ettiği.)** Kabul etmezse sadece dosya kaybolmaz,
deploy da hata verebilir.

**6. Volume'ler.** Compose'daki `pgdata` (veritabanı), `storage` (dosyalar) ve `backups` (yedekler)
Coolify'da kalıcı volume olur. Yeniden deploy onları silmez. **Kaynağı Coolify'dan silerken "delete
volumes" seçeneğini işaretleme**, yoksa veri gider; "delete volumes" yedekleri de siler.

**7. Health check.** Ayrı ayar gerekmez: compose dosyasında her servisin kendi health check'i var.
core'unki `http://localhost:8080/health`. Coolify servisleri "healthy" gösterene kadar bekle.

**8. Deploy.** **Deploy** düğmesi. Coolify'ın deploy logunda imajların derlendiğini ve beş
container'ın başladığını görürsün. İlk deploy birkaç dakika.

**9. Kontrol.** Kendi bilgisayarında (PowerShell):

```powershell
curl.exe -s https://selfbase.ornek.com/health
```

Beklenen: `{"ok":true}`. Tarayıcıda `https://selfbase.ornek.com/panel/` giriş sayfasını açmalı.
Sertifika hatası alırsan DNS kaydı henüz yayılmamıştır ya da Coolify sertifikayı alamamıştır;
Coolify'da proxy loguna bak.

**10. Erişim logu.** Realtime token'ı `/realtime/v1?token=...` adresinde gider. Coolify'ın Traefik'inde
erişim logu açıksa bu adresler token'la birlikte yazılır. **(doğrulanacak: sunucudaki Traefik'te
access log açık mı; açıksa `/realtime/v1` için query string'in loga yazılmaması.)** Proxy ayarı bütün
projeleri etkilediği için bunu tek başına değiştirme, önce ekiple konuş.

---

## 6. Coolify'sız, düz Docker ile bir sunucuya kurulum

Coolify olmayan herhangi bir Linux sunucuda: Docker + compose + önüne HTTPS'li bir reverse proxy
(burada Caddy; sertifikayı kendisi alır).

```
internet ──443──> Caddy ──> 127.0.0.1:8080 (core) ──> rest, fn, db (sadece iç ağ)
```

**1. Docker'ı kur.** (bash, sunucu) Docker'ın resmi kurulum script'i:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Oturumu kapatıp tekrar SSH ile bağlan (grup değişikliği için), sonra:

```bash
docker compose version
```

Beklenen: `Docker Compose version v2.24.0` ya da daha yeni.

**2. Repoyu al.**

```bash
sudo mkdir -p /opt/selfbase && sudo chown "$USER" /opt/selfbase
git clone <REPO_URL> /opt/selfbase/corteqs
cd /opt/selfbase/corteqs
cp .env.example .env
chmod 600 .env
```

`chmod 600`: `.env`'i sadece sen okuyabil.

**3. Anahtarlar.** Sunucuda Node yoksa bu iki komutu kendi bilgisayarında çalıştır ve çıktıyı
sunucudaki `.env`'e yapıştır:

```powershell
node scripts/gen-keys.mjs
node -e "console.log('POSTGRES_PASSWORD=' + require('crypto').randomBytes(24).toString('base64url'))"
```

**4. `.env`'i doldur.** (bash, sunucu)

```bash
nano .env
```

Bölüm 3, adım 4'teki dört değer, ve:

```
PUBLIC_URL=https://selfbase.ornek.com
SITE_URL=https://app.ornek.com
TRUST_PROXY=true
COMPOSE_PROJECT_NAME=selfbase-corteqs
```

`CORE_BIND` ve `CORE_PORT` yazmana gerek yok: `CORE_BIND` varsayılan olarak `127.0.0.1` olduğu için core
sadece sunucunun içinden erişilir (`127.0.0.1:8080`). Dışarıdan tek yol Caddy (HTTPS).
`TRUST_PROXY=true` çünkü önünde Caddy var. Fonksiyonlar için uygulama reposunu da sunucuya al ve
`SUPABASE_DIR`'i yaz (bölüm 5, adım 1'deki gibi), sırlar için `fn.env` (bölüm 4). Nano'da kaydet:
`Ctrl+O`, `Enter`, çık: `Ctrl+X`.

**5. Başlat ve kontrol et.**

```bash
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8080/health
```

Beklenen: db, rest, core, fn `Up (healthy)`, backup `Up`, sonra `{"ok":true}`. Dışarıdan `http://<sunucu-ip>:8080`
**açılmamalı**; açılıyorsa `.env`'de `CORE_BIND=0.0.0.0` yazmışsındır, sil.

```bash
docker compose port core 8080
```

Beklenen: `127.0.0.1:8080`.

**6. Caddy (HTTPS).** DNS'te `selfbase.ornek.com` → sunucunun IP'si olmalı.

```bash
sudo apt-get update && sudo apt-get install -y caddy
sudo nano /etc/caddy/Caddyfile
```

Dosyanın içeriğini şununla değiştir:

```
selfbase.ornek.com {
	reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
curl -s https://selfbase.ornek.com/health
```

Beklenen: `{"ok":true}`. Caddy sertifikayı Let's Encrypt'ten kendisi alır (80 ve 443 dışarıdan
açık olmalı), WebSocket'i kendiliğinden geçirir ve `X-Forwarded-For` ekler. Caddyfile'a `log`
yazmadıkça erişim logu tutmaz; bu yüzden realtime token'ı loga düşmez. `log` eklersen `/realtime/v1`
için query string'i yazdırma. Ubuntu'da `apt` caddy paketini bulamazsa Caddy'nin resmi kurulum
sayfasındaki Debian/Ubuntu adımlarını uygula.

nginx kullanıyorsan aynı iş (sertifikayı `certbot` ile ayrıca alırsın):

```nginx
server {
    listen 443 ssl;
    server_name selfbase.ornek.com;
    # ssl_certificate ... ; ssl_certificate_key ... ;  (certbot doldurur)
    client_max_body_size 50m;            # storage yükleme sınırı core'da 50 MB

    location /realtime/v1 {
        access_log off;                  # token query string'de
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
    }
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**7. Güvenlik duvarı.**

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Not: Docker'ın açtığı portlar ufw kurallarını atlar. Bu yüzden `CORE_BIND`'in varsayılanı (`127.0.0.1`) önemli;
ufw'ye güvenme.

**8. Yeniden başlatma.** Ayrı bir servis dosyası gerekmez: compose'daki `restart: unless-stopped`
sayesinde sunucu yeniden açılınca container'lar kendiliğinden kalkar.

**9. Güncelleme.**

```bash
cd /opt/selfbase/corteqs
git pull
docker compose up -d --build
```

Veritabanı ve dosyalar volume'de, güncelleme onları silmez. Ama veritabanının içindeki selfbase
ayarlarını da güncellemez: bkz. hemen aşağısı.

### Var olan bir kurulumu güncelleme

`db/bootstrap/*.sql` **sadece boş bir veritabanının ilk açılışında** çalışır. Bir `git pull`
`db/bootstrap/`'a yeni bir dosya getirse bile var olan veritabanına hiçbir şey olmaz. Bu yüzden her
selfbase sürümü, var olan kurulumlar için gereken SQL'i `db/upgrade/<tarih>.sql` dosyasında verir. Kural:

- `db/bootstrap/`'a eklenen ya da değişen her şey aynı sürümde `db/upgrade/<tarih>.sql`'e de girer.
- O dosyalar tekrar çalıştırılabilir (iki kez çalıştırmak zarar vermez).
- Güncellemeden sonra, adını daha önce çalıştırmadığın her `db/upgrade/` dosyasını tarih sırasıyla bir
  kez çalıştır. Hangilerini çalıştırdığını kurulumun notlarına yaz.

Bu sürümün dosyası `db/upgrade/2026-11-22.sql`. İçindekiler: REST sorgularının süre sınırları (`anon`
3 sn, `authenticated` 8 sn, bölüm 4) ve `selfbase.http_queue` için bekleyen satırlara index. Repo
kökünde (bash, sunucu; yerelde Git Bash):

```bash
docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < db/upgrade/2026-11-22.sql
docker compose restart rest
```

PowerShell'de `<` yok; ilk satır yerine:
`Get-Content db/upgrade/2026-11-22.sql | docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1`

Beklenen: `ALTER ROLE`, `ALTER ROLE`, `CREATE INDEX` (index zaten varsa `NOTICE: ... already exists,
skipping`). `restart rest` gerekir, çünkü PostgREST rol ayarlarını bağlantı açarken okur. Bu sürümde
başka değişen bir şey (compose, imajlar) `docker compose up -d --build` ile gelir.

Veritabanı imajı bu sürümde Debian 13 tabanlı `postgis/postgis:17-3.6`'ya geçti. Eski imajla
oluşturulmuş bir veritabanında, yeni imajla ilk açılıştan sonra bir kez:

```bash
docker compose exec -T db psql -U postgres -d postgres -c 'REINDEX DATABASE postgres' -c 'ALTER EXTENSION postgis UPDATE'
```

Neden: işletim sisteminin metin sıralama kuralları (glibc) değişti; metin kolonlarındaki index'ler eski
sıraya göre kurulmuş olabilir.

---

## 7. Supabase'den veri taşıma

Bu bölüm bir Supabase projesini (şema, veri, kullanıcılar, dosyalar, cron, realtime) **boş, yeni
kurulmuş** bir selfbase'e taşır. CorteQS dev veritabanı bu yolla taşındı: 370 tablonun satır sayıları
eşleşti, 357 public tablo, 647 policy, 9 kullanıcı, `auth.users`'a giden 157 foreign key doğrulandı.

Script'ler `scripts/migrate/` altında; ayrıntılı teknik açıklama `scripts/migrate/README.md`'de.
Şifreleri ekrana hiçbir zaman yazmazlar. `pg_dump`/`psql` 17'yi `postgres:17.12` imajından çalıştırırlar,
yani bilgisayarına Postgres kurman gerekmez.

**Neden bu kadar adım:** uygulama tablolarının `auth.users`'a foreign key'i var. Kullanıcılar 3.
adımda geliyor. O yüzden önce tablolar ve veri, sonra kullanıcılar, en son kısıtlar (foreign key'ler)
yükleniyor. Her adım tek transaction: hata olursa geri alınır, sebebi düzeltip aynı adımı tekrar
çalıştırırsın.

### Hazırlık

1. selfbase yerelde, **boş** ve veritabanı portu açık olarak çalışsın (Git Bash):

   ```bash
   docker compose -f compose.yml -f compose.local.yml up -d --build
   ```

   `compose.local.yml` veritabanını `127.0.0.1:55432`'de açar (`LOCAL_DB_PORT` ile değişir). Sunucuda
   kullanma.

2. `core/` içinde bağımlılıkları kur (05 ve 06 onların `pg` paketini kullanır):

   ```bash
   (cd core && npm ci)
   ```

3. `.env`'e taşıma değişkenlerini ekle. Değerleri Supabase dashboard'undan sen alırsın:

   | Değişken | Değer |
   |---|---|
   | `SUPABASE_DB_URL` | Kaynak, **session pooler** adresi: Supabase → Project Settings → Database → Connection string → Session pooler. Kullanıcı `postgres.<ref>` biçiminde. |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | Kaynağın service role anahtarı. Sadece dosyaları indirmek için. |
   | `DOCKER_NETWORK` | `<COMPOSE_PROJECT_NAME>_default`, ör. `selfbase-deneme_default`. Kontrol: `docker network ls`. |
   | `TARGET_DB_URL` | `postgres://postgres:<POSTGRES_PASSWORD>@db:5432/postgres` (container'dan erişim: 01, 02, 03) |
   | `TARGET_DB_URL_HOST` | `postgres://postgres:<POSTGRES_PASSWORD>@localhost:55432/postgres` (bilgisayardan erişim: 05, 06; port `LOCAL_DB_PORT`) |
   | `PUBLIC_URL` | zaten var |
   | `NOTIFY_DISPATCH_SECRET`, `RADAR_NEWS_CRON_SECRET` | İsteğe bağlı: `fn.env`'deki aynı adlı değerler (aşağıda adım 8) |

   Neden `db:5432`: 01, 02 ve 03'ün `psql`'i bir container'da çalışır ve `DOCKER_NETWORK` ile selfbase'in
   ağına katılır, orada veritabanının adı `db`. 05 ve 06 ise bilgisayarında çalışır; onlar
   `TARGET_DB_URL_HOST`'u kullanır (varsa), yoksa `TARGET_DB_URL`'e döner. İki adres aynı şifreyi
   taşır; `.env`'i adımlar arasında değiştirmen gerekmez. Supabase adresi (`*.supabase.co/.com`) iki
   değişkenden birinde bile verilirse script'ler reddeder: yanlışlıkla canlıya yazamazsın.

4. **Kaynakta yazmaları durdur** (1. adım boyunca). Script tek bir anlık görüntüden (snapshot) okur,
   ama pooler buna izin vermezse ayrı okumalar yapar ve bunu söyler.

### Adımlar (Git Bash, repo kökünde)

```bash
. scripts/migrate/lib.sh                                             # psql_target yardımcısı
bash scripts/migrate/01-dump.sh                                      # 1
bash scripts/migrate/02-restore.sh pre                               # 2
node scripts/migrate/03-auth-storage.sql.mjs rows | psql_target      # 3
bash scripts/migrate/02-restore.sh post                              # 4
node scripts/migrate/03-auth-storage.sql.mjs policies | psql_target  # 5
STORAGE_DIR=./data/storage node scripts/migrate/04-files.mjs         # 6
```

6\. adım dosyaları bilgisayarındaki `data/storage` klasörüne indirir (git'e girmez). core onları kendi
`storage` volume'ünde arar, o yüzden sonra volume'e kopyala. `<proje>`: `COMPOSE_PROJECT_NAME`
(volume adı `<proje>_storage`, kontrol: `docker volume ls`). Git Bash, repo kökünde:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v <proje>_storage:/dst -v "$(pwd -W)/data/storage:/src:ro" alpine \
  sh -c 'cp -a /src/. /dst/ && chown -R 1000:1000 /dst'
```

`chown 1000:1000`: core `node` kullanıcısı (uid 1000) olarak çalışır; root'a ait bir kopyayı
silemezdi. Komut tekrar çalıştırılabilir, var olan dosyaların üzerine aynısını yazar.

05 ve 06 bilgisayarında çalışır ve `.env`'deki `TARGET_DB_URL_HOST` ile veritabanına açılan porttan
ulaşır (`compose.local.yml` ile başlatılmış olmalı). `.env`'de bir şey değiştirme:

```bash
node scripts/migrate/05-rewrite-urls.mjs --dry-run                   # 7a
node scripts/migrate/05-rewrite-urls.mjs                             # 7b
node scripts/migrate/06-realtime-cron.mjs                            # 8
```

| Adım | Ne yapar | Neden | Ne görmelisin |
|---|---|---|---|
| 1. `01-dump.sh` | Kaynağın Supabase'e ait olmayan şemalarını `pg_dump` ile alır; `auth.users`, `auth.identities`, `storage.buckets`, `storage.objects`'i JSON satırları olarak; eklentiler, storage policy'leri, auth trigger'ları, realtime tabloları, `cron.job`, migration geçmişi ve tablo başına satır sayılarını `dump/catalog/` altına | Supabase'in kendi şemaları bizde kendi tablolarımızla var; onları kopyalamak çakışır | `dump/` klasörü (git'e girmez). Okuyamadığı bir katalog `NOT READ` diye yazılır, gerisi devam eder. |
| 2. `02-restore.sh pre` | Hedef boş değilse reddeder. Eklentileri kurar (`pg_graphql`, `supabase_vault`, `pg_net`, `pgsodium`, `pg_stat_statements` atlanır ve söylenir), tabloları, fonksiyonları ve veriyi yükler, migration geçmişini `supabase_migrations.schema_migrations`'a kopyalar | Hepsi tek transaction, hata olursa hiçbir şey kalmaz | CorteQS dev'de: 598 geçmiş satırı. Eksik bir Supabase nesnesi hatası: dump düzenlenmez, `db/bootstrap/`'a shim eklenir. |
| 3. `03 rows` | Kullanıcıları, kimlikleri, bucket ve dosya kayıtlarını selfbase'in tablolarına kopyalar; sadece ortak kolonlar | Şifre hash'leri bcrypt, aynen çalışır: kullanıcılar eski şifreleriyle girer | Kaynaktaki her id hedefte olmalı, yoksa durur. Tekrar çalıştırılabilir. |
| 4. `02-restore.sh post` | 3. adım çalışmadıysa reddeder. Index'leri, kısıtları (foreign key'ler dahil) yükler, her tablonun satır sayısını kaynakla karşılaştırır, PostgREST'e şemayı yenilemesini söyler | Foreign key'ler ancak kullanıcılar geldikten sonra eklenebilir | `row counts match the source for N tables`. Uyuşmazlık olursa geri alınır. |
| 5. `03 policies` | Storage policy'lerini ve `auth.users`/`storage.objects` üzerindeki uygulama trigger'larını kurar | Bunlar Supabase'in şemalarında yaşıyordu, 1. adımın dump'ında yoktular | Hata yok. |
| 6. `04-files.mjs` | Her dosyayı `SUPABASE_SERVICE_KEY` ile indirir; `STORAGE_DIR=./data/storage` ile bilgisayardaki `data/storage/<bucket>/<ad>`'a yazar; var olanları atlar; yönlendirme izlemez. Sonra volume'e kopyala (yukarıdaki `docker run` komutu). | Dosyalar Supabase'in diskinde | `downloaded/skipped/failed` sayıları; bir hata bile varsa çıkış kodu 1, tekrar çalıştır. |
| 7. `05-rewrite-urls.mjs` | Veritabanında kayıtlı `https://<ref>.supabase.co` adreslerini `PUBLIC_URL` ile değiştirir (bütün metin ve json kolonları, trigger'lar kapalı). `--dry-run` sadece sayar. | Yoksa avatarlar ve görseller hâlâ Supabase'den yüklenir: gizli bağımlılık | Kuru çalıştırmada kolon başına satır sayısı; uygulamadan sonra ikinci bir `--dry-run` 0 göstermeli. |
| 8. `06-realtime-cron.mjs` | Kaynakta realtime açık tablolarda `selfbase.enable_realtime`'ı çalıştırır, sonra `supabase_realtime` yayınında olup henüz trigger'ı olmayan her tabloda da (`id` kolonu olmayanı uyarıyla atlar); her `cron.job` satırını **kapalı** olarak kaydeder; iki vault sırrını yazar | İki sistem aynı işleri aynı anda çalıştırmasın diye cron kapalı gelir | Hangi değişkeni kullandığını yazar (değerini değil). |
| 9. `06 --activate` | **Sadece geçiş günü**, kaynaktaki işler durdurulduktan sonra: cron işlerini açar | | Kaynakta zaten kapalı olan işler kapalı kalır. |

**Vault sırları.** `notification_dispatch_secret` ve `radar_news_cron_secret`, cron'un ve
trigger'ların fonksiyonlara gönderdiği paylaşılan sırlar; fonksiyon bunu kendi env'indeki
`NOTIFY_DISPATCH_SECRET` / `RADAR_NEWS_CRON_SECRET` ile karşılaştırır. 06, `.env`'de bu değişkenler
varsa onları, yoksa `SERVICE_ROLE_KEY`'i kullanır ve uyarır. **İki taraf aynı olmalı:** `fn.env`'deki
değeri `.env`'e de yaz ve 06'yı tekrar çalıştır. Dikkat: geçişten sonra 06'yı **bayraksız** çalıştırmak
cron işlerini tekrar kapatır; o zaman `--activate` ile çalıştır.

**CorteQS dev'den öğrendiklerimiz.** Dev projede 0 cron işi ve realtime yayınında 0 tablo vardı, yani
06 orada hiçbir şey kaydetmedi. Uygulamanın realtime kullandığı tablolar selfbase'de elle açıldı
(panelin SQL ekranında ya da `docker compose exec db psql -U postgres` ile):

```sql
select selfbase.enable_realtime('public.cadde_posts');
```

Realtime açılacak tablonun `id` kolonu olmalı. Bir tabloyu yayına ekleyen migration
(`alter publication supabase_realtime add table ...`) sync ile gelirse realtime kendiliğinden açılır
(bölüm 10); elle açmak sadece yayında olmayan tablolar için gerekir. Ayrıca 05, dev'de 0 değer
değiştirdi (1949 kolon tarandı) ve 0 dosya vardı.

**Taşımadan sonra:** `node scripts/sync.mjs --repo <uygulama reposu> --baseline` (bölüm 10).

---

## 8. Uygulamayı bağlama

### 8.1 Alias yöntemi (neden ve nasıl)

Uygulamada Supabase istemcisini kullanan 166 dosya var. Hiçbirine dokunmuyoruz. Bunun yerine derleme
aracına "`@supabase/supabase-js` istendiğinde selfbase-js'i ver" diyoruz (alias). `client.ts` aynen
`createClient(url, key)` çağırmaya devam eder.

CorteQS'te yapılan değişiklik (dal `selfbase/client-swap`, ekip onayı bekliyor):

1. `selfbase/client/dist/` içindeki `selfbase.mjs`, `selfbase.d.ts`, `LICENSE-postgrest-js`,
   `LICENSE-supabase-js` dosyaları değiştirilmeden uygulamada `src/integrations/selfbase/`'e kopyalanır.
2. `vite.config.ts` ve `vitest.config.ts`: `resolve.alias` dizi biçiminde, birebir eşleşme:
   `{ find: /^@supabase\/supabase-js$/, replacement: "<yol>/src/integrations/selfbase/selfbase.mjs" }`.
   Birebir olduğu için alt yollar (`@supabase/supabase-js/...`) etkilenmez.
3. `tsconfig.app.json`: `paths["@supabase/supabase-js"] = ["./src/integrations/selfbase/selfbase.d.ts"]`.
4. Araçların kopyalanan dosyaları kontrol etmemesi için: `eslint.config.js` ignore, `.prettierignore`,
   `knip.json` ignore, `scripts/check/check-dead-code.mjs` istisna listesi.

Sonuç: uygulamanın 690 test dosyası / 7183 testi önce ve sonra aynı geçti; derlenen pakette
`gotrue`, `realtime-js`, `postgrest-js` izine rastlanmadı.

selfbase-js güncellenince (`client/dist` değişir) bu dört dosyayı tekrar kopyala.

### 8.2 Uygulamanın env'i

| Uygulama değişkeni | Değer |
|---|---|
| `VITE_SUPABASE_URL` | selfbase `PUBLIC_URL` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | selfbase `ANON_KEY` |
| `VITE_SUPABASE_PROJECT_ID` | `selfbase` (kodda okunmuyor, sadece geçiriliyor) |

**Hem derleme zamanında hem çalışma zamanında ver.** Neden: `client.ts` önce çalışma zamanındaki
`window.__APP_CONFIG__`'e bakar, ama üç yer (`group-claims.ts`, `group-submit.ts`,
`radarNewsPipeline.ts`) `/functions/v1/...`'i istemciyi kullanmadan, derleme zamanındaki
`VITE_SUPABASE_URL` ile çağırıyor.

selfbase tarafında: `SITE_URL` uygulamanın adresi, `AUTH_REDIRECT_ALLOWLIST` uygulamanın adresleri
(ör. `https://app.ornek.com/**`). Yoksa e-posta linkleri ve Google girişi `SITE_URL`'e döner.

### 8.3 Content-Security-Policy (CorteQS'te ekibin işi)

CorteQS'in CSP'si iki yerde **sabit yazılı**: `nginx.conf.template` (canlı) ve `server.mjs`
(`npm start`). İkisi de sadece `*.supabase.co` adreslerine izin veriyor. selfbase başka bir adreste
olunca tarayıcı REST, auth, storage, fonksiyon isteklerini ve realtime WebSocket'ini engeller; avatar ve
görselleri de (`img-src`). Eklenmesi gerekenler:
- `connect-src`: `https://selfbase.ornek.com wss://selfbase.ornek.com`
- `img-src` ve `media-src`: `https://selfbase.ornek.com`

Alternatif: selfbase'i uygulamanın kendi alan adı altında (`/auth/v1`, `/rest/v1`, `/storage/v1`,
`/functions/v1`, `/realtime/v1` yollarını reverse proxy ile core'a vererek) sunmak; o zaman `'self'`
yeter.

Diğer bulgular: dört ticari HTML sayfası maskot görselini canlı Supabase projesinden yüklüyor;
`storage-image.ts` resim küçültmeyi sadece `*.supabase.co` için yapıyor (selfbase'de görsel
küçültülmeden, olduğu gibi gelir; çalışır).

### 8.4 Fonksiyonlar

`SUPABASE_DIR` uygulamanın `supabase/` klasörünü gösterir (bölüm 4). fn her fonksiyonu
`/functions/v1/<ad>` altında sunar, `config.toml`'daki `verify_jwt` ayarına uyar (varsayılan `true`).
Stripe ve WhatsApp webhook adresleri `https://selfbase.ornek.com/functions/v1/<ad>` olur; sağlayıcı
panellerinde güncellemek ekibin işi.

### 8.5 Supabase'den bilinçli olarak farklı olanlar

| Davranış | selfbase | Neden |
|---|---|---|
| Doğrulanmamış bir e-postayla **farklı şifreyle tekrar kayıt** | Hesabın şifresi silinir, yeni şifre de saklanmaz; kullanıcı bilgileri (`options.data`) son kaydınkiyle değişir. Doğrulama linki, posta kutusunun sahibini şifre belirleme ekranına (`type=recovery`) götürür: `AUTH_SET_PASSWORD_URL` doluysa oraya (CorteQS: `<SITE_URL>/reset-password`), boşsa kaydın `redirect_to`'suna. | Başkası senin adınla önceden hesap açıp şifreyi kendi belirleyemesin. Tekrar kayıt olan gerçek kullanıcı, doğruladıktan sonra şifre belirler. |
| E-posta değişikliği (`updateUser({ email })`) | Supabase gibi: `AUTH_SECURE_EMAIL_CHANGE=true` (varsayılan) iken hem yeni hem eski adrese birer link gider; değişiklik **ikisi de** tıklanınca olur (sıra fark etmez). İlk tıklanan link "Confirmation link accepted. Please proceed to confirm link sent to the other email" mesajıyla döner. Her link bir kez kullanılır, diğer linkler gibi `AUTH_OTP_EXPIRY` sonunda geçersizdir; yeni bir değişiklik isteği öncekinin iki linkini de geçersiz kılar. `false` ise sadece yeni adrese link gider. | Hesabı ele geçiren biri e-postayı tek başına değiştiremesin. |
| Refresh token tekrar kullanımı | Kullanılmış bir refresh token 10 saniye içinde tekrar gelirse (ör. iki sekme aynı anda yeniledi) aynı yeni oturum tekrar verilir. Daha geç gelirse ya da iki nesil eski bir token gelirse oturum kapatılır (çalınmış token belirtisi). Süre `AUTH_REFRESH_REUSE_INTERVAL`. | Supabase'in varsayılanıyla aynı; ağ hatasında yeniden deneyen istemci çıkış yapmasın. |
| Auth istek sınırları | IP başına 5 dakikada: giriş + kayıt 30, link doğrulama 30, token yenileme 150, e-posta gönderen istekler 30. Aşılınca 429 `over_request_rate_limit` (bölüm 4). | Şifre deneme ve e-posta bombardımanına karşı; değerler eski sistemle aynı. |
| PDF dosyaları | `application/pdf` olarak yüklenen dosya tarayıcıda açılır (`content-disposition: inline`, sandbox yok). Diğer bütün türler `sandbox` CSP ile gelir: HTML ya da SVG içindeki script selfbase'in adresinde çalışmaz. | Tarayıcıların PDF görüntüleyicisi sandbox'lı belgeyi açmıyor; PDF görüntüleyici belgenin script'ini sayfanın adresinde çalıştırmaz. |
| Fonksiyon cevapları | `x-content-type-options: nosniff`, fonksiyon kendi CSP'sini koymadıysa `content-security-policy: sandbox`. | Bir fonksiyonun döndürdüğü HTML selfbase'in adresinde script çalıştıramasın. Fonksiyon HTML sayfası sunacaksa kendi CSP başlığını koymalı. |
| Token'sız dosya yükleme | Reddedilir (401). `apikey` gerekir. | supabase-js zaten her zaman gönderir. |
| Telefon değişikliği doğrulaması (`verifyOtp` `phone_change`) | Giriş yapmış kullanıcının oturumunu ister. | Giriş yapmamış biri tahminle kurbanın kodunu kilitleyemesin. |
| E-posta OTP kodu | Yok; sadece link. | Uygulama kod kullanmıyor. |
| PKCE akışı | Yok; implicit akış. | Uygulama PKCE ayarlamıyor. |
| Resim dönüştürme (`/storage/v1/render/image`) | Yok. | Uygulama sadece `*.supabase.co`'da kullanıyor. |
| Realtime | Sadece `postgres_changes`, sadece `eq` filtresi. Broadcast ve presence yok. | Uygulamanın 5 kullanımı bu kadarını istiyor. |
| Telefon girişi | Kapalı (`AUTH_PHONE_ENABLED=false`). | Dev'de de kapalı. |

---

## 9. Panel

Panel `PUBLIC_URL/panel/` adresinde. Supabase Studio'nun bize gereken kısmı: **Tablolar** (gör,
ekle, düzenle, sil, filtre), **RLS** (policy'leri gör, yaz, RLS'i aç/kapat), **SQL** editörü,
**Kullanıcılar** (liste, ban, sil, e-posta doğrula), **Dosyalar** (bucket, gözat, yükle, sil).

Panel `service_role` yetkisiyle çalışır ama ayrı bir hesapla girilir: e-posta + şifre `.env`'de
(`PANEL_ADMIN_EMAIL`, `PANEL_ADMIN_PASSWORD_HASH`). Giriş 12 saat geçerli bir çerez verir.
Aynı IP'den 5 yanlış denemede 15 dakika kilit. Her yazma işlemi ve her SQL çalıştırması
`selfbase.admin_audit` tablosuna kaydedilir; bu yüzden SQL ekranına sır yazma. Panel sayfaları
başka bir sitenin içine gömülemez (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) ve sadece
kendi adresinden script yükler. `/panel` adresi `/panel/`'e yönlenir.

**Panel internete açık.** `/panel/` ve arkasındaki `/admin` (süper kullanıcıyla SQL çalıştıran API)
`PUBLIC_URL`'de herkese açık, önlerinde tek bir şifre ve bellekteki IP kilidi var; IP değiştiren biri
kilidi aşar. Öneri, karar kurulumun sahibinin: proxy'de bu iki yolu kısıtla. Caddy'de örneğin:

```
selfbase.ornek.com {
	@admin path /panel /panel/* /admin/*
	handle @admin {
		@outside not remote_ip <ofis-ya-da-vpn-ip>/32
		respond @outside 403
		reverse_proxy 127.0.0.1:8080
	}
	reverse_proxy 127.0.0.1:8080
}
```

Ya da paneli hiç dışarı açma ve sadece SSH tüneliyle kullan: `ssh -L 8080:127.0.0.1:8080 <sunucu>`,
sonra tarayıcıda `http://localhost:8080/panel/`. Trafik SSH içinde şifreli gider; tarayıcı
`localhost`'u güvenli bağlam sayar, `Secure` çerez orada da çalışır. (Bu yol henüz denenmedi;
denediğinde buraya sonucu yaz.)

### Şifreyi ayarla (yerelde)

Script şifreyi ekranda göstermeden okur, bcrypt ile hash'ler ve `.env`'e iki satır yazar. Şifreyi
asla komut satırından ya da dosyadan almaz. **Bu yüzden gerçek bir terminalde çalıştırılmalı**
(Windows Terminal / PowerShell penceresi, sunucuda SSH oturumu). Bir IDE'nin çıktı paneli, pipe ya da
otomasyon aracı içinde `stdin is not a terminal` deyip durur.

PowerShell, repo kökünde:

```powershell
cd core
npm ci
cd ..
node scripts/set-panel-password.mjs
```

`npm ci` bir kez gerekir: script bcrypt kütüphanesini `core/node_modules`'tan alır. npm'in yeni
sürümleri `npm warn allow-scripts` uyarısı yazabilir; zararsız, onay verme. Script sorar:

```
Admin email: sen@ornek.com
New password:
Repeat password:
updated D:\...\selfbase\.env
restart core to apply: docker compose up -d core
```

Şifre en az 12 karakter (en fazla 72 bayt). Sonra:

```powershell
docker compose up -d core
```

`.env`'de artık `PANEL_ADMIN_EMAIL=sen@ornek.com` ve `PANEL_ADMIN_PASSWORD_HASH=$$2b$$12$$...` var.
`$$` bilerek öyle: docker compose `.env`'deki `$`'ı değişken sanar, `$$` onu tek `$` olarak geçirir.
Bu satırı elle düzenleme. Script dosyadaki diğer satırlara dokunmaz.

`http://localhost:8080/panel/` → e-posta ve şifreyle giriş. Yanlışsa "invalid login".

### Sunucu için

Sunucuda Node varsa aynı komutları SSH oturumunda çalıştır. Yoksa kendi bilgisayarında ayrı bir
dosyaya yazdır ve iki satırı kopyala:

```powershell
node scripts/set-panel-password.mjs --env $env:TEMP\panel.env
Get-Content $env:TEMP\panel.env
Remove-Item $env:TEMP\panel.env
```

`Get-Content` hash'i gösterir (şifreyi değil). İki satırı sunucudaki `.env`'e (ya da Coolify'a, bölüm 5)
yapıştır, core'u yeniden başlat. Dosya repo dışında (`$env:TEMP`) duruyor ki unutulursa git'e girmesin.

**Coolify'da `$` sorunu:** Literal işaretli olmayan bir değerdeki `$`'ları Coolify bozar; core'a hash boş
gelir. İki yol var: değişkeni **Literal** işaretleyip script'in yazdığı `$$`'lı değeri olduğu gibi yapıştır
(core `$$`'ı kendisi `$` yapar), ya da hash'i `$` içermeyen `b64:` biçiminde gir. Şu komut b64 biçimini
ekrana basmadan panoya koyar:

```powershell
$l = Get-Content $env:TEMP\panel.env | Where-Object { $_ -like 'PANEL_ADMIN_PASSWORD_HASH=*' }; 'b64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($l.Substring(26).Replace('$$','$'))) | Set-Clipboard
```

Core `b64:` ile başlayan değeri kendisi çözer; düz hash de çalışmaya devam eder.

Script, aynı ad iki kez yazılmış bir `.env`'i değiştirmez: `PANEL_ADMIN_EMAIL is set twice (lines 3 and
9); keep one` gibi bir mesajla durur. Taşıma script'leri de aynı durumda durur. Birini sil, tekrar
çalıştır. (Örneğin `gen-keys` çıktısını dosyanın sonuna eklersen `.env.example`'daki boş `JWT_SECRET=`
satırı da kalır; script'ler hangisinin geçerli olduğu konusunda anlaşamaz.)

### Ekranlar

| Ekran | |
|---|---|
| Tablolar: tablo listesi, ızgara, filtre; satıra tıklayınca sağdan düzenleme çekmecesi | ![](screens/02-tables.png) ![](screens/08-row-drawer.png) |
| RLS: tablo başına policy'ler, RLS aç/kapat, yeni policy | ![](screens/03-rls.png) |
| SQL: yaz, `Ctrl+Enter` ile çalıştır, en fazla 1000 satır sonuç | ![](screens/04-sql.png) |
| Kullanıcılar: ara, ban, sil, e-postayı doğrulanmış yap; giriş yöntemi (e-posta, Google) | ![](screens/05-users.png) |
| Dosyalar: bucket'lar, klasörler, yükle, indir, sil | ![](screens/06-files.png) |

Panel telefonda da çalışır (`screens/07-tables-mobile.png`) ve açık tema var (`screens/09-tables-light.png`).

Ban: kullanıcı yeni token alamaz, ama elindeki access token en fazla 1 saat daha geçerli kalır.
Banlı kullanıcı çıkış yapabilir (`signOut` refresh token'larını iptal eder).

---

## 10. Ekibin yeni migration'larını alma (sync)

selfbase tek seferlik bir kopya değil: geçiş gününe kadar ekip yeni migration yazdıkça onları da alır.
`scripts/sync.mjs` uygulama reposundaki `supabase/migrations/applied/*.sql` dosyalarından henüz
uygulanmamış olanları dosya adı sırasıyla selfbase veritabanına uygular. Migration dosyaları
düzenlenmez.

Gereken: `.env`'de `TARGET_DB_URL` (container'dan erişilebilir: `@db:5432` + `DOCKER_NETWORK`, bölüm 7
hazırlık 3). Git Bash, repo kökünde. Docker gerekir: psql `postgres:17.12` container'ında çalışır,
bilgisayara Postgres kurman gerekmez.

**Nerede çalıştırılır.** Sync, `TARGET_DB_URL`'in gösterdiği veritabanına yazar ve psql'i o
veritabanının Docker ağına katılan bir container'da çalıştırır. Bu yüzden:

| Hedef | Nerede | `DOCKER_NETWORK` |
|---|---|---|
| Bilgisayarındaki kurulum | Kendi bilgisayarında, Git Bash | `<COMPOSE_PROJECT_NAME>_default` |
| Sunucudaki kurulum | Sunucuda, SSH oturumunda (bash), selfbase repo kökünde; uygulama reposu da sunucuda olmalı | `<COMPOSE_PROJECT_NAME>_default` (Coolify'da ağ adı kaynak UUID'sini taşır, `docker network ls` ile bak) |

**Ne zaman durur (hiçbir şey uygulamadan, çıkış kodu 2):**

| Durum | Mesaj | Ne yap |
|---|---|---|
| Hiç sync kaydı yok ama kaynağın migration geçmişi dolu (taşımadan hemen sonra) | `run --baseline first` | Aşağıdaki `--baseline`. |
| Hiç sync kaydı yok, geçmiş de boş | `applied_migrations is empty ... --from-empty` | Taşıma yaptıysan `--baseline` / `--baseline-all`. Veritabanı gerçekten boşsa ve migration'ların hepsi uygulanacaksa (sıfırdan yeni bir uygulama): bir kez `--from-empty` ile çalıştır. |
| Aynı sürüm numaralı iki dosya, geçmişten hangisinin çalıştığı anlaşılmıyor | `share a version the source recorded` | Çalışmış olanı `--mark-applied <dosya>` ile işaretle. |
| Başka bir sync çalışıyor | `another sync is running` (çıkış 1) | Bitmesini bekle. |
| Geri yüklemeden sonra (bölüm 11) | Kayıt yedekteki hâline döndü: sonraki migration'lar tekrar uygulanmaya çalışılır ve `already exists` ile durur (çıkış 1) | O nesneleri sil ya da dosyaları `--mark-applied` ile işaretle. |

**Taşımadan hemen sonra, bir kez:**

```bash
node scripts/sync.mjs --repo D:/Dev/corteqsemir --baseline --dry-run
node scripts/sync.mjs --repo D:/Dev/corteqsemir --baseline
```

Ne yapar: kaynağın migration geçmişinde (02'nin kopyaladığı `supabase_migrations.schema_migrations`)
kayıtlı her dosyayı "uygulandı" diye işaretler, çalıştırmaz. Neden: o migration'lar zaten dump'ın
içinde. Çıktı: `marked N migrations as applied (baseline)`. Repoda olup kaynakta uygulanmamış dosyalar
listelenir; bir sonraki normal çalıştırma onları uygular. Aynı sürüm numarasını paylaşan ve geçmişten
hangisinin çalıştığı anlaşılamayan dosyalar için tek tek `--mark-applied <dosya>` komutu yazdırır.
Geçmiş boşsa `--baseline` tahmin etmez, durur; o zaman bütün dosyaları işaretleyen `--baseline-all` var
(bunu sadece veritabanının repodaki bütün migration'ları zaten içerdiğinden eminsen kullan).

**Sıfırdan yeni bir uygulamada, bir kez:** `node scripts/sync.mjs --repo <uygulama reposu> --from-empty`.
Bu "bu veritabanında bu migration'ların hiçbiri yok" demek; hepsini sırayla uygular. Sonraki
çalıştırmalar bayraksız.

**Ekip yeni migration ekledikçe:**

```bash
git -C D:/Dev/corteqsemir pull
node scripts/sync.mjs --repo D:/Dev/corteqsemir --dry-run
node scripts/sync.mjs --repo D:/Dev/corteqsemir
```

`--dry-run` uygulanacakları listeler, reddedilecekleri `(REFUSED: sebep)` ile gösterir. Normal
çalıştırma her dosyayı **tek transaction** içinde, kaydıyla birlikte uygular (`selfbase.applied_migrations`
ve `supabase_migrations.schema_migrations`). İlk hatada durur, o dosya geri alınır, çıkış kodu 1.
Sonunda PostgREST'e şemayı yenilemesini söyler. Sonra `supabase_realtime` yayınında olup henüz
realtime trigger'ı olmayan her tabloda `selfbase.enable_realtime`'ı çalıştırır (`realtime enabled for
public.<tablo>`); `id` kolonu olmayan tablo için uyarı yazar, durmaz. Yani bir migration'ın
`alter publication supabase_realtime add table ...` satırı yeter, elle açmana gerek kalmaz.

`--baseline` yapılmadan normal çalıştırılırsa ve geçmiş doluysa reddeder (`run --baseline first`).
Sync dosyaları süper kullanıcı olarak çalıştırır ve onlara güvenir; sınırlar `scripts/sync.mjs`
başında.

Reddedilen dosyalar (çalıştırılmadan önce): `\if`, `\gset`, `\i` gibi psql komutları, psql değişkenleri,
birden fazla `BEGIN`/`COMMIT`, `COMMIT`'ten sonra komut, transaction içinde çalışamayan komutlar
(`CREATE INDEX CONCURRENTLY`, `VACUUM`...). Böyle bir dosyayı elle uygula ve sonra
`--mark-applied <dosya>` ile kaydet. Uygulanmış bir dosya sonradan değişirse uyarır, tekrar uygulamaz.

Aynı anda iki sync çalışmaz (kilit). Sync, ekibin canlıya özel script'lerini (`scripts/ops/*`,
`check-migrations.mjs`) hiçbir zaman çalıştırmaz.

---

## 11. Yedekleme ve geri yükleme

> **Sunucuda önce bunlar:**
>
> 1. Yedekleri bir sunucu klasöründe tut, volume'de değil: `.env`'e `BACKUP_DIR=/opt/selfbase/backups`
>    (mutlak yol), klasörü oluştur ve sadece sahibine aç: `sudo mkdir -p /opt/selfbase/backups &&
>    sudo chmod 700 /opt/selfbase/backups`.
> 2. `docker compose down -v` ve Coolify'ın "delete volumes" seçeneği veritabanıyla birlikte
>    `backups` volume'ünü de siler. Yedek bir sunucu klasöründeyse kalır.
> 3. Canlıya geçmeden önce bir kez geri yükleme provası yap: boş bir deneme kurulumuna (bölüm 12)
>    bir yedeği geri yükle ve uygulamayla aç. Hiç denenmemiş bir yedek, yedek sayılmaz.

### Yedekleme

compose'daki `backup` servisi her gün **03:15 UTC**'de yedek alır, `BACKUP_RETENTION_DAYS` günden
(varsayılan 7) eskileri siler. Her yedek `/backups/<YYYYMMDD-HHMMSS>/` klasörü:

- `db.dump`: bütün veritabanı (`pg_dump -Fc`)
- `globals.sql`: roller, şifresiz (sadece sıfırdan felaket kurtarma için)
- `storage.tar.gz`: yüklenen dosyalar
- `MANIFEST`: her dosyanın boyutu ve sha256'sı

Yedek önce geçici bir klasörde hazırlanır, bitince adı verilir: zaman damgalı bir klasör her zaman
tam bir yedektir. Hata olursa `backup: FAILED` yazar. Yedek dosyaları sadece sahibi (root) tarafından
okunabilir (klasörler `700`, dosyalar `600`): `db.dump` bütün veriyi, kullanıcıların şifre hash'lerini
ve vault sırlarını içerir. Veritabanı dökümü ve dosya arşivi aynı anda alınmaz; arada birkaç saniyede
yüklenen bir dosya birinde olup diğerinde olmayabilir.

Hemen bir yedek al:

```bash
docker compose run --rm backup bash /scripts/backup.sh
```

Beklenen: `backup: wrote /backups/20261122-101500 (12M)` gibi bir satır.

`backup.sh` ve `restore.sh` backup image'ına gömülüdür, `fn` image'ına da `client/dist` (Coolify gibi
araçlar repo dosyalarını göreli bind mount'la konteynere koymaz). Bu dosyaları değiştirdiysen
`docker compose up -d --build backup fn` ile yeniden derle.

Yedekler varsayılan olarak `backups` adlı Docker volume'ünde. Sunucuda bir klasörde olmalı (yukarıdaki
kutu): `.env`'e `BACKUP_DIR=/opt/selfbase/backups` yaz.

> **Yedekler aynı sunucuda.** Sunucu bozulursa yedek de gider. Canlıya geçmeden önce bu klasörü
> sunucu dışına (başka bir sunucu, nesne depolama) kopyalayan bir iş ekle. Henüz yok.

### Geri yükleme

```bash
bash scripts/restore.sh 20261122-101500
bash scripts/restore.sh 20261122-101500 --yes-overwrite
```

İlk komut sadece kontrol eder: ne yapacağını anlatır, yedeğin `MANIFEST`'ini (boyut ve sha256) doğrular,
yedekten sonra eklenen kaç dosyanın silineceğini söyler. Hiçbir şeyi değiştirmez. İkinci komut:

1. `core`, `rest`, `fn` ve `backup`'ı durdurur (geri yükleme sırasında kimse yazmasın),
2. açık cron işlerini geçici olarak kapatır,
3. veritabanını tek transaction'da geri yükler (hata olursa hiçbir şey değişmez),
4. storage volume'ünü yedekteki hâline getirir,
5. servisleri başlatma komutunu yazar: `docker compose start rest core fn backup` (`backup`'ı unutursan
   günlük yedek durur).

Bilmen gerekenler:
- Yedekten **sonra** oluşturulmuş nesneler (tablolar vb.) silinmez.
- Migration kaydı yedekteki hâline döner, yani sync sonraki migration'ları tekrar uygulamaya çalışır ve
  "already exists" ile durur. O nesneleri sil ya da dosyaları `--mark-applied` ile işaretle.
- Yedekten sonra eklenen dosyalar silinir.
- Hata mesajı "rolled back" diyorsa hiçbir şey değişmedi; "after the database was restored (storage
  step)" diyorsa veritabanı geri yüklendi, komutu tekrar çalıştır. Servisler her durumda durmuş kalır,
  başlatma komutunu yazar.

Hiçbir şeyin üzerine yazmayan, daha güvenli yol (yeni bir veritabanına geri yükleyip kontrol ettikten
sonra geçmek) `scripts/restore.sh`'nin başındaki açıklamada komut komut yazılı.

Başka bir kurulum için (farklı proje adı) `.env`'de `COMPOSE_PROJECT_NAME` varsa script onu kullanır,
çünkü repo kökünde düz `docker compose` çalıştırır.

---

## 12. Yeni bir uygulama için kurulum

Her uygulama **kendi** selfbase kurulumunu alır: kendi veritabanı, anahtarları, adresi. Bir kurulumu
iki uygulama arasında paylaştırma. Neden: RLS, kullanıcılar ve anahtarlar uygulamaya özel; biri
diğerinin verisine erişmesin, biri bozulunca diğeri etkilenmesin. Kurulum hafif olduğu için bu ucuz.

### Aynı makinede ikinci kurulum (deneme)

Bu, aynı bilgisayarda (ya da sunucuda) var olan bir kurulumun yanına ikincisini, onunla hiçbir şeyi
paylaşmadan kurar. PowerShell:

```powershell
git clone <REPO_URL> selfbase-app2
cd selfbase-app2
Copy-Item .env.example .env
node scripts/gen-keys.mjs
node -e "console.log('POSTGRES_PASSWORD=' + require('crypto').randomBytes(24).toString('base64url'))"
notepad .env
```

`.env`'de bölüm 3, adım 4'teki dört değeri yapıştır (**yeni üretilenleri**; başka kurulumun
anahtarlarını kullanma), ve:

```
PUBLIC_URL=http://localhost:8090
SITE_URL=http://localhost:5174
COMPOSE_PROJECT_NAME=selfbase-app2
CORE_PORT=8090
```

`SITE_URL` yeni uygulamanın adresi. Yeni uygulamanın fonksiyonları varsa `SUPABASE_DIR`'e onun
`supabase/` klasörünü yaz, yoksa boş bırak. Taşıma için `compose.local.yml` kullanacaksan
`LOCAL_DB_PORT=55433` da ekle (ilk kurulum 55432'yi kullanıyor). Kaydet, kapat.

```powershell
netstat -ano | findstr ":8090 "
docker compose up -d --build
docker compose ps
curl.exe -s http://localhost:8090/health
docker compose ls
```

Beklenen: `netstat` boş (doluysa başka bir port seç, `CORE_PORT` ve `PUBLIC_URL`'i ona göre yaz);
dört servis `Up (healthy)`, `backup` `Up`; `{"ok":true}`; `docker compose ls` iki projeyi ayrı satırlarda
gösterir. Tarayıcıda `http://localhost:8090/panel/` giriş sayfasını açar. Panel şifresi için bölüm 9
(bu klasörde çalıştır).

İki kurulum arasındaki tek ortak şey Docker'ın kendisi. Volume'ler `selfbase-app2_pgdata`,
`selfbase-app2_storage` adını alır, ağ `selfbase-app2_default`.

Kaldırmak (bu kurulumun verisi dahil):

```powershell
docker compose down -v
cd ..
Remove-Item -Recurse -Force selfbase-app2
```

### Canlı kurulum kontrol listesi

Yeni bir uygulamayı canlıya koyarken sırayla:

- [ ] **Kopyala:** selfbase reposunu yeni bir klasöre klonla (Coolify'da: yeni kaynak, bölüm 5).
- [ ] **Ad:** `COMPOSE_PROJECT_NAME=selfbase-<uygulama>` (Coolify'da proje adı yeter).
- [ ] **Anahtar üret:** `gen-keys.mjs` + veritabanı şifresi. Her kurulumda yeni; asla kopyalama.
- [ ] **Adresler:** `PUBLIC_URL` (selfbase'in kendi alan adı), `SITE_URL`, `AUTH_REDIRECT_ALLOWLIST`.
- [ ] **Port:** `CORE_PORT=<boş port>`. Düz Docker'da proxy `127.0.0.1:<CORE_PORT>`'a gider; Coolify'da container'ın 8080'ine. `CORE_BIND` varsayılanı `127.0.0.1`, core dışarıdan açılmaz.
- [ ] **HTTPS:** `PUBLIC_URL` `https://` ile başlıyor, proxy sertifikayı aldı (en baştaki liste, 1. madde).
- [ ] **`TRUST_PROXY=true`** (proxy arkasında).
- [ ] **Fonksiyonlar:** uygulama reposunu sunucuya al, `SUPABASE_DIR`; sırlar için `fn.env`.
- [ ] **SMTP:** `SMTP_*`. Yoksa e-postalar gitmez (`selfbase.mail_log`).
- [ ] **Google:** `GOOGLE_CLIENT_ID/SECRET`, Google'da dönüş adresi `<PUBLIC_URL>/auth/v1/callback`.
- [ ] **Panel:** `set-panel-password.mjs` (gerçek terminalde), iki satır `.env`'e.
- [ ] **Deploy:** `docker compose up -d --build` ya da Coolify'da Deploy.
- [ ] **Kontrol:** `https://<alan>/health` → `{"ok":true}`, `https://<alan>/panel/` → giriş.
- [ ] **Veri:** Supabase'den geliyorsa bölüm 7 (kendi bilgisayarında, boş bir kopyaya ya da doğrudan
      sunucuya), sonra `sync --baseline`. Sıfırdan başlıyorsa uygulamanın migration'larını
      `sync --from-empty` ile uygula (bölüm 10).
- [ ] **Realtime:** `supabase_realtime` yayınındaki tablolar sync ile kendiliğinden açılır; yayında
      olmayan, uygulamanın dinlediği tablolar için `select selfbase.enable_realtime('public.<tablo>');`
- [ ] **Panel erişimi:** `/panel` ve `/admin`'i proxy'de kısıtlamayı düşün (bölüm 9).
- [ ] **Uygulama:** alias (bölüm 8.1), `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` derleme ve
      çalışma zamanında, CSP'ye selfbase adresi (`https://` ve `wss://`).
- [ ] **Erişim logu:** proxy `/realtime/v1` için query string yazmıyor.
- [ ] **Yedek:** `BACKUP_DIR` sunucuda `chmod 700` bir klasör; `docker compose run --rm backup bash /scripts/backup.sh` bir kez dene; bir geri yükleme provası (bölüm 11); sunucu dışı kopya planı.
- [ ] **Geçiş günü:** eski sistemin cron'larını durdur, `06-realtime-cron.mjs --activate`.

---

## 13. Bilinen kısıtlar

Bunlar bilerek seçilmiş kısayollar. Her biri kodda `shortcut:` yorumuyla işaretli. Şu anki kullanım
için sorun değiller; sağdaki sütun ne zaman ele alınması gerektiğini söylüyor.

| Nerede | Kısıt | Ne zaman yükseltilmeli |
|---|---|---|
| `scripts/backup.sh` | Yedekler aynı sunucuda. | **Canlıdan önce:** sunucu dışı kopya ekle. |
| `db/bootstrap/04-shims.sql` (vault) | Vault sırları veritabanında düz metin. | Canlıdan önce: env'den gelen bir anahtarla pgcrypto şifrelemesi. |
| `db/bootstrap/04-shims.sql` (net) | `net.http_get/post`'un `params`'ı URL'ye kodlanmadan eklenir. | Bir çağıran `params` verirse. Bugünkü çağıranlar vermiyor. |
| `core/src/netqueue/worker.ts` | HTTP kuyruğunun tekrar denemeleri sırayla çalışır: yavaş bir hedef kuyruğu satır başına ~19 saniye durdurur. Tek core çalışabilir. | Trafik artarsa ya da core birden fazla kopya çalışacaksa. |
| `core/src/admin/session.ts` | Panelin yanlış şifre sayacı bellekte, tek core için doğru. | core birden fazla kopya çalışınca: veritabanına taşı. |
| `core/src/admin/session.ts` | Panel çerezi durumsuz: çıkış sadece o tarayıcıdan siler, kopyalanan çerez 12 saat geçerli. | Yetmezse sunucu tarafı oturum tablosu. Acil durumda `JWT_SECRET`'ı değiştirmek bütün oturumları düşürür. |
| `core/src/admin/sql.ts` | SQL ekranı sonucu 1000 satırla kesmeden önce tamamını belleğe okur. | Çok büyük `select`'ler sorun olursa: cursor. |
| `core/src/admin/tables.ts` | Tablo ekranı her sayfada tam `count(*)` yapar. | Çok büyük tablolarda: tahmini sayı. |
| `core/src/admin/files.ts`, `core/src/storage/index.ts` | Yüklenen dosya (en fazla 50 MB) bellekte tutulur. | Büyük dosyalar gerekirse: diske akıt. |
| `core/src/storage/objects.ts` | Dosya adı değişikliği commit'ten önce: başarısız commit, kaydı olmayan bir dosya bırakabilir. | Görülürse: tutarlılık kontrolü yapan bir iş. |
| `core/src/storage/objects.ts` | Dosya listesi her zaman ada göre sıralı, `search` filtresi yok. | Bir çağıran sıralama/arama isterse. |
| `core/src/storage/paths.ts` | Büyük/küçük harf duyarlı dosya sistemi varsayar (Linux). | core Windows/macOS üzerinde doğrudan (container'sız) çalışacaksa. |
| `core/src/auth/ratelimit.ts` | Auth istek sayaçları bellekte, tek core için doğru; core yeniden başlayınca sıfırlanır. | core birden fazla kopya çalışınca: paylaşılan bir sayaç (veritabanı). |
| `core/src/auth/routes-phone.ts` | Aynı numaraya iki hesap milisaniyeler içinde yarışırsa ikisi de bir SMS gönderebilir. | Telefon açılır ve bu önemli olursa. |
| `core/src/realtime/hub.ts` | Her değişiklikte her abone için bir sorgu. | Bir tabloda ~100'den fazla abone olursa: aynı yetkili aboneleri grupla. |
| `fn/main.ts` | İçe aktarması zaman aşımına uğrayan fonksiyon, fn yeniden başlayana kadar bozuk kalır. | İndirmeler yavaşsa `FN_IMPORT_TIMEOUT_MS`'i artır ya da fn'i yeniden başlat. |
| `fn/main.ts` | Bir fonksiyonun kendi `deno.json`/`import_map.json`'ı birleştirilmez. | Böyle bir dosyası olan fonksiyon gelince (CorteQS'te yok). |
| `panel/src/App.tsx` | Panel adresleri tek parçalı hash (`#/tables`), router kütüphanesi yok. | İç içe sayfalar gerekirse. |
| `panel/src/pages/Sql.tsx` | SQL editörü düz metin kutusu, otomatik tamamlama yok. | Otomatik tamamlama istenirse: CodeMirror. |
| `scripts/migrate/02-restore.sh` | Dump'ın kendisinin oluşturduğu bir şemadaki eklenti kurulmaz. | Böyle bir eklenti çıkarsa: geri yüklemeden sonra elle kur. |
| `scripts/set-panel-password.mjs` | İki parçaya bölünmüş bir tuş dizisinin sonu şifreye karışabilir. | Gerçek terminallerde görülmüyor; görülürse. |

Kodda `shortcut:` olarak işaretli olmayan ama bilinen eksikler:

- Ban, kullanıcının elindeki access token'ı hemen geçersiz kılmaz (en fazla 1 saat).
- Realtime filtresi ve RLS birlikte uçtan uca test edilmedi; telefon, Google ve SMTP gerçek bir
  sağlayıcıyla denenmedi.

---

## 14. Sorun giderme

Önce bak: `docker compose ps` (hangi servis sağlıksız) ve `docker compose logs --tail 50 <servis>`.

| Belirti | Sebep | Ne yap |
|---|---|---|
| `up` sırasında `required variable POSTGRES_PASSWORD is missing a value: set POSTGRES_PASSWORD` (ya da `JWT_SECRET`, `PUBLIC_URL`, `SITE_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`) | `.env`'de değer boş ya da `.env` yanlış klasörde | Komutu repo kökünde çalıştır, `.env`'de satırı doldur. |
| Uygulamada 429, `over_request_rate_limit` | Bir IP auth sınırını aştı (bölüm 4) | 5 dakika bekle. Gerçek kullanıcılar takılıyorsa ilgili `AUTH_RATE_LIMIT_*`'ı yükselt, `docker compose up -d core`. Hepsi aynı IP'den geliyor görünüyorsa `TRUST_PROXY`'ye bak. |
| REST'te `canceling statement due to statement timeout` | Sorgu `anon` için 3, `authenticated` için 8 saniyeyi geçti (bölüm 4) | Sorguyu hızlandır (index, daha az satır). Gerçekten gerekiyorsa rolün süresini yükselt. |
| Bir servis sık sık yeniden başlıyor, `docker inspect` `OOMKilled: true` | Bellek sınırına dayandı (bölüm 4, kaynak sınırları) | `compose.yml`'de o servisin `mem_limit`'ini yükselt, `docker compose up -d`. |
| Sync `applied_migrations is empty ... --from-empty` | İlk sync, kayıt yok | Bölüm 10, "Ne zaman durur". |
| Bir script `X is set twice (lines a and b); keep one` | `.env`'de aynı ad iki kez | Birini sil. |
| `port is already allocated` / `Only one usage of each socket address` | Port dolu | `.env`'de `CORE_PORT`'u değiştir (ve `PUBLIC_URL`'i). Veritabanı portuysa `LOCAL_DB_PORT`. |
| core sürekli yeniden başlıyor, logda `JWT_SECRET must be at least 32 characters` | Secret kısa ya da boş | `gen-keys.mjs` ile yeniden üret (üç değer birlikte). |
| core ya da rest logunda `password authentication failed for user` | `.env`'deki `POSTGRES_PASSWORD` veritabanı ilk kurulurken kullanılandan farklı. Şifre **sadece ilk açılışta** uygulanır. | Veri önemli değilse: `docker compose down -v` ve tekrar `up`. Önemliyse eski şifreyi geri koy. Şifreyi gerçekten değiştirmek için veritabanında hem `postgres` hem `authenticator` rolünün şifresini `alter role ... password` ile değiştir, sonra `.env`'i. |
| `/rest/v1/...` 502 `upstream_unavailable` | rest çalışmıyor | `docker compose logs rest`. Genelde şifre ya da `JWT_SECRET` uyuşmazlığı. |
| Yeni tablo REST'te 404 / "Could not find the table" | PostgREST şema önbelleği eski | `docker compose exec db psql -U postgres -c "notify pgrst, 'reload schema'"` ya da `docker compose restart rest`. |
| `/functions/v1/<ad>` 404 | `SUPABASE_DIR` boş ya da yanlış yol | `.env`'de yolu düzelt, `docker compose up -d fn`. Kontrol: `docker compose exec fn ls /supabase/functions`. |
| `/functions/v1/<ad>` 500 | Fonksiyon anahtar bekliyor | `docs/functions-status.md`'deki anahtarı `fn.env`'e yaz, `docker compose up -d fn`. |
| Panelde giriş "invalid login" | E-posta/şifre yanlış, ya da hash `.env`'e elle (`$$` olmadan) yazılmış | `set-panel-password.mjs`'i tekrar çalıştır, `docker compose up -d core`. |
| Panelde giriş 429 | 5 yanlış deneme, 15 dakika kilit | Bekle ya da `docker compose restart core` (sayaç bellekte). |
| Panelde giriş başarılı görünüyor ama hemen tekrar giriş istiyor | `PUBLIC_URL` `https://` ama panel düz `http://` ile, `localhost` dışından açılmış; çerez `Secure` | HTTPS üzerinden aç (bölüm 5/6). |
| `set-panel-password: stdin is not a terminal` | Script gerçek terminalde değil | Windows Terminal ya da SSH oturumunda çalıştır. |
| `Cannot find module ... bcryptjs` | `core/node_modules` yok | `cd core; npm ci; cd ..` |
| Kayıt sonrası e-posta gelmiyor | `SMTP_HOST` boş | Yerelde linke bak: `docker compose exec db psql -U postgres -c "select to_email, subject, created_at from selfbase.mail_log order by id desc limit 5"`. Canlıda SMTP bilgisini gir. |
| Google girişi `redirect_uri_mismatch` | Google'daki dönüş adresi farklı | Google Console'da `<PUBLIC_URL>/auth/v1/callback`. |
| Giriş sonrası uygulamaya değil `SITE_URL`'e dönüyor | `redirect_to` izinli listede değil | `AUTH_REDIRECT_ALLOWLIST`'e uygulamanın adresini `/**` ile ekle, `docker compose up -d core`. |
| Tarayıcı konsolunda `Refused to connect ... Content Security Policy` | Uygulamanın CSP'si selfbase'e izin vermiyor | Bölüm 8.3. |
| Realtime mesajı gelmiyor | Tabloda realtime açık değil | `select selfbase.enable_realtime('public.<tablo>');` (tabloda `id` kolonu olmalı). Filtrede sadece `eq` çalışır. Hata veren bir kanal (ör. geçici zaman aşımı) istemcide kendiliğinden tekrar bağlanır, 1 saniyeden 60 saniyeye kadar artan aralıklarla. |
| Adres değişince bütün kullanıcılar çıkış yapmış | İstemci oturumu adrese göre adlandırılmış bir anahtarda saklar | Beklenen; bir kez tekrar giriş (bölüm 4, `PUBLIC_URL`). |
| Bildirim fonksiyonu 401/403 dönüyor, `selfbase.http_queue`'da `failed` | Vault sırrı fonksiyonun env'iyle aynı değil | Bölüm 7, "Vault sırları". Kuyruğa bak: `select status, url, last_error from selfbase.http_queue order by id desc limit 10;` |
| `selfbase.http_queue`'da `blocked` | `*.supabase.co`'ya gidip iç karşılığı olmayan bir istek | Bilerek engellendi; isteği yapan cron/trigger'ı incele. |
| Taşıma script'i `points at a Supabase host` | `TARGET_DB_URL` ya da `TARGET_DB_URL_HOST` Supabase'i gösteriyor | Hedef selfbase olmalı (bölüm 7). |
| 01-03 `could not translate host name "db"` | `DOCKER_NETWORK` yok ya da yanlış | `docker network ls`, `<proje adı>_default`. |
| 05/06 `getaddrinfo ENOTFOUND db` | 05 ve 06 bilgisayarda çalışır, `TARGET_DB_URL_HOST` yok | `.env`'e `TARGET_DB_URL_HOST=postgres://postgres:<POSTGRES_PASSWORD>@localhost:<LOCAL_DB_PORT>/postgres` ekle, `compose.local.yml` ile başlat. |
| `02 pre: the target is not empty` | Hedefte zaten veri var | Boş bir kurulum: `docker compose down -v`, tekrar `up`. |

Hâlâ çözülmediyse: `docker compose logs --tail 200 core` çıktısını (içinde sır olmadığını kontrol
ederek) ekiple paylaş.

# selfbase — Supabase'siz kendi backend platformumuz (tasarım)

Tarih: 2026-11-22 · Durum: onay bekliyor · İlk uygulama: CorteQS (`D:\Dev\corteqsemir`)

## 1. Niyet ve neden

CorteQS ekibi Supabase'e (hem bulut hem yazılım olarak) bağımlı kalmak istemiyor.
Gerekçeleri:
- **Kontrol ve taşınabilirlik:** her parçayı anlamak, istediği sunucuya taşıyabilmek.
- **Maliyet/kaynak:** self-host Supabase bile ağır (~10 container, 4 GB+ RAM). Her uygulamaya bir tane kurmak pahalı.
- **Lisans/şirket riski:** Supabase şirketine ya da onun paketlerine muhtaç kalmamak.

Altyapı ekibin diğer uygulamalarında da kullanılacak. Kullanıcı (Emir) kurulumu adım adım
öğrenmek istiyor, çünkü sonra kendi sunucusuna kendisi taşıyacak. Ekip "hazır uygulamalar var ama
entegrasyonu zor" dedi. Bu yüzden hazır bir BaaS'a geçmek yerine kendi ince platformumuzu kuruyoruz.

## 2. Hedefler

1. Tek `docker-compose` ile ayağa kalkan, Coolify'da deploy edilen hafif platform (hedef ≤ 1.5 GB RAM boşta).
2. Postgres RLS aynen çalışır. Mevcut 342 migration'daki `auth.uid()`, `auth.jwt()`,
   `anon` / `authenticated` / `service_role` rolleri değişmeden geçerli olur.
3. Supabase Studio benzeri **tek web paneli**: Tablolar (gör/ekle/düzenle/sil/filtre), RLS policy'leri
   (gör/yaz/aç-kapat), SQL editörü, Kullanıcılar (liste/ban/sil/e-posta doğrula), Dosyalar (bucket/gözat/yükle/sil).
   Sonra eklenecekler: loglar, cron işleri, fonksiyon listesi.
4. Auth: e-posta+şifre, e-posta doğrulama, şifre sıfırlama, Google OAuth, telefon OTP (bugün kapalı, hook hazır).
5. Storage (bucket + dosya, RLS'e uyan erişim), Realtime (tablo değişikliği aboneliği), 25 edge function'ın çalıştığı fonksiyon sunucusu, zamanlanmış işler.
6. CorteQS uygulaması yeni platforma bağlanır: dev DB kopyasıyla uçtan uca çalışır.
7. **Rehber:** Emir'in sıfırdan başka bir sunucuya kurabileceği adım adım doküman ve script'ler. Yeni uygulama için "compose'u kopyala, `.env`'i doldur" tarifi.

## 3. Hedef olmayanlar (şimdilik)

- Canlı veri taşıması. Sadece dev DB (`mhkblulknwrimirzipyd`) kopyalanır. Canlıya geçişi ekip, rehberle yapar.
- Çok kiracılı (multi-tenant) tek kurulum. **Her uygulama kendi kurulumunu alır.**
- Supabase'in Phoenix realtime protokolüyle, Studio'nun her ekranıyla ya da yönetim API'siyle birebir uyum.
- Yatay ölçekleme, çoklu bölge, otomatik failover.

## 4. Anti-hedefler (teknik olarak çalışsa bile başarısızlık sayılır)

- Gizlice Supabase'e geri bağımlılık: runtime'da `@supabase/*` paketi ya da `supabase/*` Docker imajı (GoTrue, storage-api, realtime, pg_net, supavisor) kullanmak.
  İstisna: MIT lisanslı `postgrest-js` **kopyalanıp repoya alınabilir** (vendor). Bu durumda dışarıya bağımlılık kalmaz.
- Paylaşılan Coolify sunucusundaki diğer projeleri (burakakcakan…, human, orgdevco, payaltr, qualtronsinclair, shaman) etkilemek. Bunlara ve Coolify proxy'sine dokunulmaz, proxy yeniden başlatılmaz.
- RLS'i baypas eden panel ya da API: panel `service_role` ile çalışır, ama son kullanıcı istekleri hiçbir zaman çalışmaz.
- Kara kutu: rehberde açıklanmayan, elle yapılmış bir kurulum adımı.

## 5. Kısıtlar

- **Sunucu:** mevcut Coolify (http://<server-ip>:8000, v4.7.6, takım <coolify-team>). Sunucu paylaşımlı. Kurulumdan önce boş RAM/CPU/disk ölçülür. Yetmiyorsa durulur ve kullanıcıya sorulur.
- **Ekip merge kuralları (corteqsemir):** tek iş = tek dal, küçük commit'ler. `main`'e push yok, kendi PR'ını merge etmek yok. `.env*` commit edilmez. Yeni kütüphane için önce sorulur. Cadde dışı dosyalara dokunuluyorsa commit mesajında adı geçer. `scripts/ops/*` ve `check-migrations.mjs` asla çalıştırılmaz. Build sonrası `git restore public docs/agent` yapılır.
  Kullanıcı "aynı anda hepsi" seçti: uygulama kodu ayrı bir dalda paralel değişir, ama **ekip onayı olmadan PR açılmaz ve push edilmez** (sadece yerel dal + demo).
- **Sırlar:** Claude hiçbir secret anahtarı ya da test şifresini yazmaz veya görmez. Sırlar `.env` dosyasına ve Coolify env'ine kullanıcı tarafından girilir. Claude `.env.example` üretir.
- **Lisans:** tüm parçalar OSI lisanslı ve şirkete bağımlı olmayan (Postgres, PostgREST MIT, Node/Deno MIT, eklentiler PostgreSQL/Apache lisanslı).
- **Süre:** kullanıcı birkaç gün istiyor. Edge function'lar ve uygulama geçişi bu süreyi aşabilir. Plan, en değerli parçayı önce bitirecek şekilde sıralanır.

## 6. Yaklaşımlar (değerlendirilen)

| Yol | Ne | Artı | Eksi | Karar |
|---|---|---|---|---|
| **A. Kendi mini platformumuz** | Postgres + PostgREST + tek `core` servis (auth/storage/realtime/fn/admin) + React panel | RLS ve sorgular aynen kalır, 3-4 container, tam kontrol | auth/storage/realtime'ı kendimiz yazarız | **Seçildi** |
| B. Kendi backend'imiz, PostgREST yok | Node API + Drizzle + panel | En fazla kontrol | 166 dosya ve 96 RPC yeniden yazılır, haftalar sürer, RLS anlamını yitirir | Elendi (süre) |
| C. Hibrit, hazır paneller | A + pgAdmin/CloudBeaver | Panel 1-2 gün erken biter | İki panel olur, "Supabase gibi" hissi kaybolur | Elendi (panel şartı) |
| D. PocketBase / Appwrite / Nhost | Hazır BaaS | Hazır | Postgres RLS yok (ilk ikisi) ya da yine şirket ürünü (Nhost/Hasura) | Elendi |
| E. Self-host Supabase | Supabase docker | Sıfır kod | Kullanıcı bunu açıkça istemedi (yazılım bağımlılığı, ağırlık) | Elendi |

## 7. Kararlaştırılan mimari (kullanıcının seçtikleri)

```
Coolify projesi "selfbase-corteqs" (tek compose)
├─ db        postgres 17 + postgis + pgvector + pg_cron + pg_trgm + unaccent + pgcrypto
├─ rest      PostgREST  → /rest/v1/*   (tablo + RPC; JWT'deki role ile RLS)
├─ core      Node servis → /auth/v1/*  /storage/v1/*  /realtime/v1  /functions/v1/*  /admin/*
├─ (fn)      Deno runtime: 25 edge function (core içinde ya da ayrı container, uygulayıcının kararı)
└─ panel     React SPA  → Tablolar | RLS | SQL | Kullanıcılar | Dosyalar
```
- Her uygulama için ayrı kurulum (kullanıcı seçti).
- Veri: dev DB kopyası, yani şema + 342 migration + mock veri (kullanıcı seçti).
- Uygulama kodu değişebilir (kullanıcı izin verdi). Ama bkz. 8.1: en az değişiklikle gidilir.
- Paralel ilerleme (kullanıcı seçti): platform, fonksiyonlar ve uygulama geçişi Opus 5.5 alt ajanlarla aynı anda yürür.

## 8. Claude'un kararları (düzeltilebilir)

### 8.1 Uyumlu istemci (en önemli karar)
Uygulamada 166 dosya Supabase istemcisini kullanıyor. Bunları tek tek yeniden yazmak yerine
`@/integrations/supabase/client` modülünün yerine **aynı arayüzü sunan kendi istemcimiz** gelir
(`selfbase-js`): `.from()` ve `.rpc()` (kopyalanmış postgrest-js), `.auth.*` (uygulamanın kullandığı alt küme),
`.storage.from()`, `.channel().on('postgres_changes')`, `.functions.invoke()`.
Sonuç: uygulamada bir istemci dosyası, `package.json` ve env değişir. 166 dosyanın çoğuna dokunulmaz.
Bu, ekibin merge script'ine de en az çatışmayı çıkarır. Arayüz, uygulamanın **gerçekte çağırdığı**
metotlardan çıkarılır (grep ile envanter). Supabase'in tam API'si yazılmaz.

### 8.2 Postgres uyumluluk katmanı
- `auth` şeması kendi tablolarımızla yeniden kurulur: `auth.users` (Supabase kolon adlarının uygulamanın ve migration'ların kullandığı alt kümesi), `auth.identities`, `auth.sessions`/refresh token'lar.
- `auth.uid()`, `auth.role()`, `auth.jwt()` fonksiyonları PostgREST'in `request.jwt.claims` ayarından okur.
- `anon`, `authenticated`, `service_role` rolleri ile `authenticator` girişi oluşturulur.
- Migration'lar sıfırdan çalıştırılamaz: `supabase/migrations/applied/` 2026-06-15'te başlıyor ve PG 17.6'dan alınmış `supabase/baseline/` dump'ına dayanıyor. Bu yüzden **giriş yolu dev DB'nin `pg_dump`'ı** (PG 17 ile). Bootstrap SQL sadece bu şemanın ve sonraki migration'ların başvurduğu Supabase'e özgü nesneleri sağlar.
- Shim'ler: `net.http_post` (3 çağıran var: outbox'a kayıt düştüğünde çalışan `poke_notification_dispatcher` trigger'ı, hataları yutar, yani shim olmazsa bildirimler sessizce durur; ayrıca radar ve `group_link_health` cron'ları) ve `vault.decrypted_secrets`. Shim, isteği core'daki bir kuyruğa yazar, core da isteği gönderir. Cron'larda sabit yazılı canlı proje adresi (`<corteqs-ref>.supabase.co`) bootstrap'ta selfbase adresine çevrilir. **Kopyadan canlıya hiçbir istek gidemez.**
- **Migration dosyaları düzenlenmez.** Ekibin ileride ekleyeceği migration'lar da düzenlenmeden uygulanabilmeli (bkz. 8.10).
- Dev DB taşıması: `pg_dump` ile şema ve veri alınır, Supabase'e özgü şemalar ayıklanır, `auth.users` bizim tablomuza dönüştürülür (bcrypt hash'ler uyumlu olduğu için şifreler korunur). Dev'deki kullanıcılar mock test kullanıcılarıdır.
- `auth.users` üzerinde insert'te ve `email_confirmed_at` / `phone_confirmed_at` güncellemelerinde çalışan trigger'lar var. Bizim auth bu kolonları Supabase'le aynı anlamda doldurmalı. SQL'in kullandığı kolonlar: `deleted_at`, `banned_until`, `raw_user_meta_data`, `raw_app_meta_data`, `phone`.

### 8.3 Auth
JWT (HS256, tek secret, Supabase claim yapısı: `sub`, `role`, `email`, `aud`, `exp`). Access token 1 saat, refresh token DB'de tutulur ve rotasyonlu.
E-posta gönderimi SMTP ile (repoda `_shared/emails/smtp.ts` zaten var). Google OAuth standart kod akışıyla.
Uygulamanın gerçekten çağırdığı metotlar (envanter, v1'in kapsamı budur):
- Oturum: `getUser`, `getSession`, `onAuthStateChange`, `signOut`.
- Giriş: `signUp`, `signInWithPassword`, `signInWithOAuth` (Google), `signInWithOtp` (e-posta magic link, `shouldCreateUser:false`).
- Hesap: `resetPasswordForEmail`, `updateUser` (data, phone), `resend` (signup), `verifyOtp` (phone_change).
- Admin: `auth.admin.deleteUser` (fonksiyonlarda).

PKCE ayarı yok, yani varsayılan implicit akış kullanılıyor.
Telefon doğrulama (`updateUser({phone})` → `send-phone-otp-hook` (WhatsApp, Standard Webhooks) → `verifyOtp phone_change`) kodda hazır ama dev'de kapalı. v1'de arayüz kurulur, ayarla kapalı tutulur.
Pasaport akışı (e-posta doğrulama) bozulmamalı.
**Auth ayarları ve şablonlar** (Site URL, redirect listesi, e-posta onayı zorunluluğu, şifre kuralı, OTP süresi, rate limit'ler, kayıt/magic link/sıfırlama/değişiklik e-posta şablonları): uygulamanın ilk adımında Claude bunları dev Supabase dashboard'undan **sadece okuyarak** alır (kullanıcı onayladı). Girişi kullanıcı yapar, hiçbir şey değiştirilmez, anahtar ya da şifre okunmaz.

### 8.4 Storage
Dosyalar diskte (Docker volume) durur. `storage.buckets` / `storage.objects` tabloları ve migration'lardaki policy'ler korunur.
Core, her yükleme/okuma isteğinde kullanıcının JWT'siyle `storage.objects` üzerinde RLS'li bir sorgu yaparak yetkiyi Postgres'e sordurur.
Public bucket'lar doğrudan servis edilir. Yaklaşık 15 bucket var (avatars, cadde-media, event-covers, verification-documents, profile-cv-files…; tam liste migration'lardan çıkarılır).
Kullanılan metotlar: `upload`, `remove`, `getPublicUrl`, `createSignedUrl`. `/render/image` sadece `*.supabase.co` adreslerinde kullanılıyor, selfbase'de etkisiz kalır.
**Dosyalar dev'den kopyalanır** ve DB'ye kaydedilmiş tam `getPublicUrl()` adresleri (avatars, cadde, events, landings…) migration script'iyle selfbase adresine çevrilir (Claude'un kararı). Aksi halde kopya `*.supabase.co`'yu göstermeye devam eder, bu da gizli bir bağımlılık olur.
Kısayol: S3 yok, disk var. Birden fazla sunucu gerekirse MinIO/S3'e geçilir.

### 8.5 Realtime
Uygulamada 5 kullanım var (mesajlar, teklifler, Cadde akış/yorum/bildirim). Hepsi sadece INSERT dinliyor ve sadece `eq` filtresi kullanıyor. v1 bu kadarını destekler. Core'da WebSocket açılır.
İzlenen tablolarda trigger çalışır ve `pg_notify` gönderir. Core, değişen satırı abone kullanıcının JWT'siyle yeniden seçer (RLS'e uyar) ve gönderir.
Protokol bizim, istemci `.channel().on('postgres_changes', …)` arayüzünü taklit eder.

### 8.6 Fonksiyonlar ve zamanlanmış işler
25 edge function Deno kodu. Kendi Deno runtime'ımızda `/functions/v1/<ad>` altında çalışır.
27 yerde `https://esm.sh/@supabase/supabase-js@2.108.2` import ediliyor. Bunlar **Deno import map'iyle** `selfbase-js`'e yönlendirilir, böylece fonksiyon dosyaları düzenlenmez. Anahtarlar `_shared/supabase-keys.ts` üzerinden geliyor (`SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` adlarına düşüyor). selfbase bu env adlarını kendi anahtarlarıyla doldurur.
Saf SQL cron işleri `pg_cron`'da kalır. `net.http_post` çağrıları 8.2'deki shim üzerinden core'a gider (pg_net Supabase'e ait).
Sadece veritabanında duran, migration'larda olmayan cron işleri olabilir. Bunlar dump'tan `cron.job` tablosu olarak gelir ve kontrol edilir.
Stripe ve WhatsApp webhook'larının dışarıdan erişilebilir olması gerekir: adres değişir ve sağlayıcı panellerinde güncellenir (ekibin işi).

### 8.7 Panel
React + Vite, core'un `/admin` API'si üzerinden çalışır, `service_role` ile. Panel girişi ayrı admin hesabıyla ve Coolify'da HTTPS altında yapılır. Sadece Tablolar / RLS / SQL / Kullanıcılar / Dosyalar.
Görünüm Supabase'e benzer: sol menü, tablo ızgarası, sağ çekmece.

### 8.8 Teslim ve rehber
Yeni repo `D:\Dev\selfbase` (git, ileride ekibin GitHub'ına): `compose.yml`, `.env.example`, `db/bootstrap.sql`,
`core/`, `panel/`, `client/` (selfbase-js), `scripts/migrate-from-supabase.*`, `docs/REHBER.md`.
REHBER her adımı neden yapıldığıyla anlatır: sunucu hazırlığı, Coolify'a kurulum, Supabase'den veri taşıma, uygulama bağlama, yedekleme/geri yükleme, yeni uygulama ekleme.
Her aşamada ekran görüntüsü ve kısa demo hazırlanır (ekip demo istiyor).

### 8.9 Yedekleme
Günlük `pg_dump` ve storage volume yedeği aynı sunucuda, 7 gün saklanır. Kısayol: sunucu dışına yedek yok, canlıya geçmeden önce eklenmeli.

### 8.10 Ekiple senkron (kullanıcı seçti: "takip etsin")
selfbase tek seferlik bir kopya değil. Geçiş gününe kadar ekibin yeni migration'larını ve fonksiyon değişikliklerini takip eder:
- Fonksiyonlar selfbase'e kopyalanmaz. **corteqsemir'deki `supabase/functions/` klasöründen** derlenir/bağlanır (repo yolu env ile verilir).
- `scripts/sync` komutu, corteqsemir'de henüz uygulanmamış migration'ları sırayla selfbase DB'ye uygular (kendi `schema_migrations` kaydını tutar) ve hata veren migration'da durur. Bootstrap shim'leri (net, vault, auth, storage) gelecekteki migration'ların düzenlenmeden çalışabilmesi için yeterince gerçekçi olmalı.
- Senkron, ekibin canlıya özel script'lerini (`scripts/ops/*`, `check-migrations.mjs`) asla çalıştırmaz.

## 9. Uygulayıcıya bırakılanlar

Core'un dili/çatısı (Node + Hono önerilir), fn'nin core içinde mi ayrı container'da mı çalışacağı, panel bileşen kütüphanesi,
klasör içi yapı, test aracı, realtime mesaj formatı, admin girişinin ayrıntısı, migration shim'lerinin tek tek nasıl yazılacağı.

## 10. Açık noktalar (ekibe gidecek)

- Google OAuth client ID/secret (bugün Supabase'de tanımlı) ve yeni redirect URL.
- Auth e-postaları için SMTP bilgileri.
- Stripe/WhatsApp webhook adreslerinin değişmesi (dev ortamında test anahtarlarıyla).
- Gerçek alan adı (şimdilik sslip.io).
- Uygulama tarafı değişikliğin ekip onayı (dal hazır, PR yok).
- Dev storage dosyalarını ve dev DB dump'ını almak için dev projenin bağlantı bilgisi ve service anahtarı. Bunları kullanıcı `.env`'e kendisi girer, Claude görmez.

## 11. Claude'un kontrol sonrası kararları (gözden geçir)

- Postgres 16 yerine **17** (baseline dump 17.6'dan alınmış).
- Storage dosyaları kopyalanır ve DB'deki `supabase.co` adresleri çevrilir.
- Telefon doğrulama v1'de var ama kapalı.
- Canlı proje adresi bootstrap'ta etkisiz hale getirilir.
- Fonksiyon dosyaları düzenlenmez, import map ile yönlendirilir.

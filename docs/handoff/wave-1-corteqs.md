# Dalga 1: CorteQS ekibine devir notu

CorteQS'in arka ucu artık selfbase kontrol düzleminin 1 numaralı projesi olarak çalışıyor. Bu dalgada sizden bir şey beklemiyoruz.
Ayrıntılı kayıt: `docs/proofs/wave1-cutover.md`. `<BASE>`, `<ref>` ve `<v1-resource>` yer tutucudur. Gerçek değerleri
selfbase sahibinden alırsınız.

## Ne değişti

- Arka uç, eski tek compose kurulumundan çıkıp proje olarak çalışıyor. Veritabanı v1 dökümünden geri yüklendi.
  anon ve service_role anahtarları v1'dekilerle aynı. JWT secret de v1'inki: v1'in anon anahtarı 1 numaralı projede
  doğrulanıyor.
- Veritabanında henüz kullanıcı verisi yok (`auth.users` 0). İçinde yalnızca PostGIS'in referans verisi var.

## Ne değişmedi

- Uygulamanın adresi (`selfbase-corteqs.<BASE>`) ve env dosyası aynı. Eski adres aynı sertifikayla yanıt veriyor, v1
  anon anahtarı da orada çalışıyor.
- Build alias'ı aynı.
- Uygulama deposundaki hiçbir dosya değişmedi. `selfbase` dalında bu dalga için commit atılması gerekmedi.
- Realtime: MessagesInbox ile Cadde akış ve yorum hook'ları vendor'lanmış v1 selfbase istemcisini kullanıyor (istemcinin
  şu anki sürümü). Bu dalgada istemcide hiçbir şey değişmedi.
- Bu dalgada sizin için yeni erişim token'ı gerekmiyor.

## Yeni olanlar

- İkinci bir adres: `<ref>.<BASE>`. İleride ana adres o olacak.
- Studio: `selfbase.<BASE>`. Eski `/panel` yerine geçiyor. Hesaplar selfbase sahibinin daveti üzerine açılıyor.

## Geçici farklar ve bilinen sınırlar

- Fonksiyonlar, dalga 2'deki deploy gelene kadar sunulmuyor. Sunucuda önceden de böyleydi.
- Migration'lar şimdilik yine `sync.mjs` ile gidiyor.
- `/rest/v1/` apikey başlığı olmadan da 200 dönüyor. v1 de aynı davranıyordu. Dalga 2'de düzelecek.

## İsterseniz sonra yapabilecekleriniz

`VITE_SUPABASE_URL` ile CSP `connect-src` değerini yeni adrese çevirebilirsiniz. Acelesi yok, iki adres de çalışmaya
devam ediyor.

## Yaklaşan değişiklik (dalga 3)

- **Ne değişecek:** Realtime, standart protokole geçecek. Bu, supabase-js'nin kullandığı protokoldür (Phoenix
  kanalları, `postgres_changes`). v1 protokolü kaldırılacak.
- **Neden:** Standart protokol supabase-js ile doğrudan çalışır. Ayrı bir v1 istemcisini taşımak gerekmez.
- **Sizden ne gerekecek:** Aynı adımda, depodaki vendor'lanmış istemciyi yenilemeniz. Bunun için sizin onayınız ve
  koordinasyonunuz şart. selfbase tarafı sizin deponuza hiçbir şey göndermez.
- **Ne zaman:** Değişiklik gelmeden önce sizinle konuşulacak. O zamana kadar realtime koduna dokunmanız gerekmiyor.

## Nasıl doğrularsınız

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://selfbase-corteqs.<BASE>/health
curl -s -o /dev/null -w "%{http_code}\n" https://<ref>.<BASE>/health
curl -s -o /dev/null -w "%{http_code}\n" -H "apikey: $ANON_KEY" https://selfbase-corteqs.<BASE>/rest/v1/
```

Üçü de 200 dönmeli. İlk ikisi için sunucuya erişim gerekmez. `$ANON_KEY` kendi `.env` dosyanızdaki anon anahtarıdır.

Geçişten sonra CorteQS birim testlerini kendi tarafımızda çalıştırdık. Testler uygulamanın kendi `.env.local` dosyasıyla,
eski adrese karşı koştu: 7183 test geçti, çıkış kodu 0.

## Geri dönüş

v1 kaynağı silinmedi, yalnızca durduruldu. Disk birimleri (volume'lar) yerinde. Gerekirse selfbase sahibi iki adım atar. Önce
Studio'da proje Ayarlar -> Alan adları bölümünden `selfbase-corteqs.<BASE>` adresini kaldırır, sonra Coolify'da v1
kaynağını (`<v1-resource>`) başlatır. v1, durduğu andaki veritabanı ve depolamayla geri gelir. Geçişten sonra 1 numaralı
projeye yazılan veri v1'e taşınmaz.

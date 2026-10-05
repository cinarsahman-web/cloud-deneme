# Blok Diyarı

Tarayıcıda çalışan, sıfırdan yazılmış Minecraft benzeri bir voksel oyunu. Tek dosya: `index.html` (Three.js ile).

**Çalıştırmak için:** `index.html` dosyasını bir tarayıcıda açın (ya da `npx serve .`).

## Oyun
- **Sonsuz dünya:** Parçalar (16×16×96) oyuncunun etrafında üretilir, uzaklaşınca bellekten atılır. Yapılan değişiklikler parça bazında saklanır.
- **Biyomlar:** Okyanus, kumsal, çöl, ova, orman ve karlı dağlar. Mağaralar, kömür, demir ve elmas damarları var.
- **Hayatta kalma modu:** Can, açlık ve hava göstergeleri. Düşme hasarı ve boğulma var; açlık ve tokluk sistemi işler.
- **Kazma:** Bloklar sertliğe ve alete göre sürede kırılır. Kırılma çatlakları görünür, eşyalar yere düşer ve toplanır.
- **Üretim:** Elde, çalışma masasında ve fırında toplam 32 tarif var. Tahta, taş, demir ve elmas kazma, balta, kürek ve kılıç yapılabilir. Aletlerin dayanıklılığı vardır.
- **Canlılar:** Gece ya da karanlıkta zombiler çıkar ve gün ışığında yanar. Domuzlar et düşürür.
- **Işık:** Gökyüzü ışığı ve meşale ışığı taşmalı (flood-fill) aydınlatmayla hesaplanır. Yumuşak gölgeleme ve ortam gölgesi (AO) vardır.
- **Yaratıcı mod:** Tüm eşyalar sınırsız, uçma serbest.
- Gece-gündüz döngüsü, sentezlenmiş sesler, dokunmatik kontroller, otomatik kayıt.

## Optimizasyonlar
- Arazi üretimi, ışık hesabı ve mesh oluşturma Web Worker havuzunda (2–4 işçi) yapılır. Sonuçlar transferable typed array olarak ana iş parçacığına geçer.
- Tamponlar kopyalanmadan aktarılır. İndeksler mümkün olduğunda Uint16, ışık verisi normalize edilmiş Uint8 olarak tutulur.
- Gizli yüzler çizilmez. Her parça en fazla iki çizim çağrısı kullanır (katı ve su). Görüş dışında kalan parçalar Three.js tarafından kırpılır (frustum culling).
- Parçalar yakından uzağa doğru sıraya alınır. Kare başına zaman bütçesi ve işçi başına iş sınırı uygulanır.
- Blok değişikliklerinde yalnızca etkilenen parçalar öncelikli olarak yeniden çizilir.
- Görüş mesafesi ayarlanabilir (3–16 parça); sis bu mesafeye göre ayarlanır.
- Worker kullanılamazsa aynı kod ana iş parçacığında zaman bütçesiyle çalışır.

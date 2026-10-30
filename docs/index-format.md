# Indexformat: app-data/index.json

Appen läser hela bildbanken från `app-data/index.json`. Miniatyrer och förhandsbilder ligger bredvid, namngivna efter bildens id. TypeScript-typerna finns i `src/catalog/types.ts`.

```
app-data/
  index.json
  index.prev.json            föregående version, sparas vid varje import
  embeddings.bin             AI-vektorer för AI-sök, se nedan
  config.json                AI-taggarna, se nedan
  ai-taggar-<nyckel>.bin     taggarnas textvektorer, samma format som embeddings.bin
  import/pagaende.jsonl      pågående import, finns bara medan en import pågår eller är avbruten
  import/pagaende.bin        AI-vektorer i en pågående import, samma format som embeddings.bin
  models/<modell>/           AI-modellen, laddas ner med npm run download-model
  thumbs/MB-000001.webp      miniatyr, längsta sidan högst 400 px
  previews/MB-000001.webp    förhandsbild, längsta sidan högst 1600 px
```

Bilder förstoras aldrig. En bild som är mindre än 1600 px får en förhandsbild i originalstorlek. Miniatyrer och förhandsbilder är roterade enligt EXIF-orienteringen.

## Filen

```json
{
  "version": 1,
  "generatedAt": "2026-10-29T14:30:00.000Z",
  "lastId": 40,
  "images": [ ... ]
}
```

| Fält | Typ | Beskrivning |
|---|---|---|
| `version` | `1` | Formatversion. Höjs när formatet ändras på ett sätt som äldre appversioner inte klarar. |
| `generatedAt` | sträng | När indexet skapades, ISO 8601 i UTC. |
| `lastId` | heltal | Högsta id-numret som någonsin har delats ut. Nya bilder får nästa nummer, så ett id återanvänds aldrig, inte ens när bilden har tagits bort. Saknas i äldre index, och räknas då från bildernas och de flyttade dubbletternas id. |
| `images` | lista | En post per bild, sorterad efter id. |
| `duplicates` | lista | Filer som importen har valt bort som dubbletter, se Import. Varje post har `path`, `hash` och `keptId`, id:t för bilden som behölls. Saknas i äldre index. |
| `embeddings` | objekt | AI-vektorerna i `embeddings.bin`: `file` (`"embeddings.bin"`), `model` (modellens mapp i `app-data/models/`), `dimensions` och `count`. Saknas om ingen bild har en vektor. |
| `aiTagging` | objekt | Hur bildernas `aiTags` sattes: `model`, `config` (ett fingeravtryck av taggarna i `config.json`), `prompts` (taggarnas prompter, var och en en gång) och `file` (filen i `app-data/` med prompternas textvektorer). Saknas om inga AI-taggar har satts. |

## En post

```json
{
  "id": "MB-000003",
  "path": "original/Fotograf A/CML Hongkong 1.jpg",
  "photographer": "Fotograf A",
  "byline": "Mårten Svemark",
  "terms": "Fri användning i Malmö stads egna kanaler. Fotografens namn ska anges.",
  "rightsUntil": "2028-06-30",
  "consent": "given",
  "blocked": false,
  "width": 3600,
  "height": 2401,
  "takenAt": "2012-04-26T17:19:36",
  "tags": ["CML", "Hongkong", "Stadsvandring"],
  "aiTags": ["gata", "torg"],
  "description": "En delegation från Hong Kong gick igår stadsvandring i Malmö",
  "alternates": [],
  "durationSeconds": null,
  "previewProblem": null,
  "hash": "q1-3f0c…",
  "fileSize": 2401554,
  "fileModified": 1767225600000
}
```

| Fält | Typ | Beskrivning |
|---|---|---|
| `id` | sträng | `MB-` följt av sex siffror. Ändras aldrig för en bild, eftersom taggningar i `app-data/edits/` pekar på id:t. Används i filnamn för miniatyr, förhandsbild och nedladdning (`MB-<id>_<namn>.jpg`). |
| `path` | sträng | Originalets sökväg relativt bildbankens mapp. Alltid `/` som avgränsare och Unicode-normaliserad till NFC, eftersom Mac och Windows lagrar å, ä och ö olika. Börjar alltid med `original/` med litet o, även om mappen på disk heter `Original`. Appen jämför mappnamn utan hänsyn till versaler och Unicode-form. |
| `photographer` | sträng | Fotografens namn, samma som mappen `original/<fotograf>/` (NFC). |
| `byline` | sträng | Texten som ska stå vid bilden när den publiceras. |
| `terms` | sträng | Användningsvillkor i klartext. |
| `rightsUntil` | sträng eller `null` | Sista dag bilden får användas, `ÅÅÅÅ-MM-DD`. `null` betyder att det inte finns något slutdatum. Bilden räknas som utgången dagen efter. |
| `consent` | `"given"`, `"missing"` eller `"not-required"` | Samtycke från personer på bilden. `given`: samtycke finns. `missing`: samtycke behövs men saknas, appen varnar. `not-required`: inga identifierbara personer. |
| `blocked` | boolesk | `true` om bilden är spärrad och inte får användas. Appen markerar den tydligt. |
| `width`, `height` | heltal | Originalets storlek i pixlar, efter EXIF-rotation. |
| `takenAt` | sträng eller `null` | När bilden togs, `ÅÅÅÅ-MM-DDTtt:mm:ss` i lokal tid utan tidszon, eftersom EXIF saknar tidszon. `null` om uppgiften saknas. |
| `tags` | lista med strängar | Nyckelord. Inga dubbletter. |
| `aiTags` | lista med strängar | Taggar som AI-modellen har satt, se AI-taggar. Hålls skilda från `tags` eftersom de kan vara fel. Tom för bilder utan AI-vektor. Appen läser äldre index utan fältet som en tom lista. |
| `description` | sträng | Bildtext. Tom sträng om den saknas. Radbrytningar är `\n`. |
| `alternates` | lista med strängar | Andra filer av samma bild, med samma sökvägsregler som `path`. Används när en RAW-fil har en JPG med samma namn: `path` är RAW-filen och JPG:en ligger här. Oftast tom. Appen läser äldre index utan fältet som en tom lista. |
| `durationSeconds` | tal eller `null` | Längd i sekunder för video, `null` för bilder. För video är `width` och `height` filmens bildstorlek och `takenAt` inspelningstiden. Appen läser äldre index utan fältet som `null`. |
| `previewProblem` | sträng eller `null` | Varför miniatyr och förhandsbild saknas, skrivet för den som ska åtgärda det. `null` när de finns. Då är `width` och `height` 0, och appen visar en !-ikon med förklaringen. Appen läser äldre index utan fältet som `null`. |
| `hash` | sträng eller `null` | Snabbt fingeravtryck av originalet: `q1-` och SHA-256 i hex av filens storlek (8 byte, big-endian) följd av filens första och sista 4 MB, eller hela filen om den är högst 8 MB. För ett RAW-par är det SHA-256 av de två filernas fingeravtryck, åtskilda av radbrytning. Används för att känna igen flyttade och omdöpta filer. `null` i index från före importen i appen. |
| `fileSize`, `fileModified` | heltal eller `null` | Originalets storlek i byte och ändringstid i millisekunder sedan 1970. Är båda oförändrade återanvänds `hash` utan att filen läses. |

`path` och `alternates` kan ha vilken filändelse som helst: jpg, png, tif, heic, cr2, nef osv. Appen visar formatet utifrån filändelsen och läser aldrig originalen för att visa dem, bara miniatyrerna och förhandsbilderna.

Alla fält finns alltid med. Saknade texter är tomma strängar, och saknade datum är `null`.

## AI-vektorer: app-data/embeddings.bin

En normaliserad vektor (längd 1) per bild, från bildmodellen i SigLIP 2 (`siglip2-base-patch16-224`). En sökfras ger en vektor från textmodellen, och bildernas likhet med frasen är skalärprodukten.

Filen är binär. Alla tal är little-endian.

| Byte | Typ | Innehåll |
|---|---|---|
| 0–3 | 4 tecken | `MBEV` |
| 4–7 | uint32 | Formatversion, `1` |
| 8–11 | uint32 | Antal dimensioner, 768 |
| 12–15 | uint32 | Antal rader |
| 16– | rader | Varje rad: id-numret (uint32, 1 för `MB-000001`) följt av vektorn (dimensioner × float32) |

- Raderna ligger i samma ordning som bilderna i `index.json`, alltså efter id.
- Bilder med `previewProblem` har ingen rad.
- Varje rad har sitt id. Läs därför vektorerna efter id, inte efter radnummer. Ett index och en vektorfil från olika importer fungerar då ihop: en bild utan rad saknas bara i AI-sök.
- Vektorn räknas ut från miniatyren, så att alla format behandlas likadant, även RAW, HEIC och film.
- Har `embeddings.model` i indexet ett annat namn än appens modell räknas alla vektorer om vid nästa import.

### Modellen

`npm run download-model -- <bildbanksmapp>` laddar ner modellen från Hugging Face (`onnx-community/siglip2-base-patch16-224-ONNX`, låst till en bestämd version) till `app-data/models/siglip2-base-patch16-224/`. Skriptet kontrollerar varje fil mot dess kontrollsumma. Det är det enda steget som hämtar något från internet.

- Textmodellen, `onnx/text_model_quantized.onnx` (283 MB), är 8-bitars och körs med WebAssembly. Den laddas när någon söker.
- Bildmodellen, `onnx/vision_model_fp16.onnx` (186 MB), är 16-bitars och används bara vid import. Den körs på grafikkortet (WebGPU), cirka 0,2 sekunder per bild. Utan användbart grafikkort körs den med WebAssembly, cirka 3 sekunder per bild.
- Appen läser modellfilerna ur bildbankens mapp. Transformers.js får inte hämta något från internet, och ONNX Runtimes WebAssembly-filer följer med appen.

## AI-taggar: app-data/config.json

Importen sätter AI-taggar på bilderna utifrån taggarna i `config.json`. Saknas filen skapar importen den med de förvalda taggarna (`src/ai/defaultConfig.json`, cirka 250 taggar).

Taggarna ändras i appen under Admin, fliken AI-taggar. Filen går också att ändra för hand.

- Man väljer en tagg och ser bilderna sorterade efter hur väl de stämmer, med ett streck vid gränsen. Gränsen flyttas med ett reglage. Bilder som får taggen när man sparar märks "ny", och bilder som tappar den märks "försvinner".
- Allt är en förhandsvisning tills man trycker Spara ändringar. Då skrivs `config.json` och alla bilder får nya AI-taggar direkt, utan import.
- Man kan lägga till och ta bort taggar och ändra namn och beskrivning.
- Exempelbilder: man klickar på Exempel under bilder som visar motivet. Taggen hittar då bilder som liknar dem, i stället för att läsa beskrivningen. Det passar för byggnader och platser som modellen inte känner igen med namn, t.ex. Malmöhus eller Triangeln. Nya bilder som importeras får taggen automatiskt.
- Inte rätt: man klickar på Inte rätt under en bild som har fått taggen fel, t.ex. en bild under "bro" utan bro. Bilden får aldrig taggen, och inte heller bilder som är nästan likadana (bild mot bild minst 0,95, t.ex. andra bilder i samma serie), även om de importeras senare. Bilderna visas under rubriken Inte rätt med en Ångra-knapp.
- Återställ förvalda taggar: förvalda taggar får tillbaka sina förvalda beskrivningar och gränser, och förvalda taggar som har tagits bort läggs tillbaka. Egna taggar, taggar med exempelbilder och listorna Inte rätt ändras inte. Inget sparas förrän man trycker Spara ändringar.
- `config.json` ligger i den delade mappen, så alla användare har samma taggar. Exempelbilder och Inte rätt som någon lägger till förbättrar taggningen för alla.
- Alla bilder och deras taggar, och Bilder utan AI-taggar: under varje bild står taggarna den får när man sparar. Ett klick på en tagg gör den röd med ett kryss, ett klick till tar bort den från bilden (`excluded`). Borttagna taggar står kvar överstrukna och går att ångra. I fältet under bilden skriver man in en tagg att lägga till: på en tagg med prompt hamnar bilden i `included`, på en tagg med exempelbilder blir bilden ett exempel, och finns ingen tagg med namnet skapas en med bilden som exempel. Bilder utan AI-taggar visar också de tre taggar bilden ligger närmast, som förslag.
- Byter man namn på en tagg till ett namn som redan finns varnar fältet, och taggen visas med "hette …" i listan. Liknar ett nytt namn en befintlig tagg visas den som förslag.
- Andra ord för samma sak (`synonyms`) och Hör ihop med (`related`) ställs in för varje tagg. Skriver man in en tagg under en bild används taggen direkt om ordet finns i ordlistan ("turningtorso" blir Turning Torso), och liknar ordet en tagg frågar appen "Menade du …?".
- Okända nyckelord: nyckelord i bildfilerna som inte finns i ordlistan, med antal bilder. Ett ord kopplas till en tagg (blir en synonym) eller döljs (`hiddenKeywords`).

### Ordlistan och taggarna i galleriet

Galleriet och detaljvyn visar en lista, Taggar, med bildens nyckelord och AI-taggar (`src/catalog/vocabulary.ts`):

- Ett nyckelord som är ett taggnamn eller en synonym visas som taggen, t.ex. "town hall" som rådhus. Jämförelsen bryr sig inte om versaler, mellanslag och bindestreck.
- Övriga nyckelord visas som de är, utom de i `hiddenKeywords`.
- Samma tagg visas en gång. Taggar som bara kommer från AI:n är streckade.
- Taggar som hör ihop (`related`, även i flera led) läggs till, så att en bild med kafé också visas med restaurang.
- Ett klick på en tagg visar alla bilder med den i galleriet. "Visa alla bilder" tar bort filtret.
- Synonymer, grupper och dolda nyckelord påverkar inte vilka AI-taggar bilderna får, och ingår inte i fingeravtrycket i `aiTagging.config`.
- Minst en tagg per bild: en bild som inte når någon gräns får ändå den tagg den ligger närmast. Under bilden är taggen märkt ”närmast”. Fältet är delat: ett klick på namnet (grönt när musen är över) behåller taggen, som om den lagts till för hand (`included` eller exempel). Ett klick på krysset (rött) tar bort den (`excluded`).

```json
{
  "version": 1,
  "atLeastOneTag": true,
  "aiTags": [
    { "tag": "cykel", "prompt": "a photo of a bicycle", "threshold": 0.045, "excluded": ["MB-000040"] },
    { "tag": "Malmöhus", "prompt": "", "threshold": 0.8, "examples": ["MB-000012", "MB-000085"] }
  ]
}
```

`atLeastOneTag` (standard `true`): en bild som inte når gränsen för någon tagg får ändå den tagg den ligger närmast, räknat i andel av reglagets omfång så att text- och exempeltaggar går att jämföra.

| Fält | Beskrivning |
|---|---|
| `tag` | Taggen som den visas i appen, på svenska. |
| `prompt` | Det textmodellen jämför bilden med, på engelska, eftersom modellen förstår engelska bäst. Får vara tom om taggen har exempelbilder. |
| `threshold` | Lägsta likhet för att bilden ska få taggen (skalärprodukt mellan normaliserade vektorer). Mot en prompt ligger likheten normalt mellan −0,1 och 0,15, och reglaget går från 0 till 0,15. Mot exempelbilder ligger den mellan 0,5 och 1, och reglaget går från 0,5 till 1. Högre värde ger färre men säkrare taggar. |
| `examples` | Valfri. Id för bilder som visar motivet. Bilderna jämförs då med medelvärdet av exempelbildernas AI-vektorer i stället för med prompten. Har alla exempelbilder tagits bort används prompten med gränsen 0,05. |
| `excluded` | Valfri. Id för bilder som inte ska ha taggen. De och bilder vars AI-vektor har minst likheten 0,95 med någon av dem får inte taggen, inte heller med `atLeastOneTag`. En bild står inte i både `examples` och `excluded`. |
| `synonyms` | Valfri. Andra ord för samma sak: synonymer, engelska ord och felstavningar. Ett taggnamn går före en synonym till en annan tagg. |
| `related` | Valfri. Namn på taggar som hör ihop med den här, t.ex. `["kafé"]` för restaurang. Det räcker att det står på en av taggarna. |
| `included` | Valfri. Id för bilder som har fått taggen för hand. De och bilder som är nästan likadana (minst 0,95) får taggen oavsett värde. `excluded` går före `included` för samma bild, och en rättning av bilden själv går före en rättning av en liknande bild. |

- En bild får alla taggar vars likhet är minst `threshold`, utom taggar där den är utesluten genom `excluded`. Bilder utan AI-vektor får inga AI-taggar.
- Taggar som saknar något fält, eller som redan finns tidigare i listan, används inte. Importen säger hur många det var.
- Taggarnas textvektorer sparas i `ai-taggar-<fingeravtryck>.bin`, en rad per prompt i samma ordning som `aiTagging.prompts` i indexet. Nya bilder taggas då utan att textmodellen körs, och bara nya eller ändrade prompter behöver räknas ut. Filen byter namn när taggarna ändras, och gamla filer tas bort när det nya indexet är sparat.
- Har `config.json` ändrats för hand sätts AI-taggarna om för alla bilder vid nästa import. Förhandsvisningen säger det. Bildernas AI-vektorer räknas inte om.
- Två taggar med samma prompt och tröskelvärde hamnar alltid på samma bilder. Så är solnedgång och soluppgång gjorda, eftersom modellen inte kan se skillnad på dem och man ska hitta alla bilderna oavsett vilket ord man söker på.
- Förvalda tröskelvärden: taggens medianvärde över testbilderna plus 0,03, men minst 0,04. Allmänna taggar som "himmel" och "hamn" får då en högre gräns, eftersom de annars hamnar på många bilder. Testbilderna får i snitt 6 taggar. "flygbild" och "drönarbild" har samma prompt och gränsen 0,03, vald mot drönarbilderna (filnamn DJI_) i testdata: 33 av 45 hittas och 4 andra bilder får taggen. Bilder tagna snett från låg höjd känns sämre igen. Med fem exempelbilder i stället hittades 41 av 45, med 6 fel. Gränserna kan behöva justeras för den riktiga bildbanken, under Admin, AI-taggar.
- De förvalda taggarna beskriver motiv, platser, byggnader (även kyrka, moské och synagoga), personer (kvinna, man, barn, ungdomar, äldre, rullstol), aktiviteter (även demonstration), årstider och bildtyper. Det finns inga taggar för etnicitet eller hälsa.

## Import

Importen körs i appen, under Importera. Bilderna läses som standard från bildbankens egen `original/`. En mapp utanför bildbanken, t.ex. på G:, kan väljas i stället. Valet sparas per dator och per bildbank. Varje mapp direkt under originalmappen är en fotograf, och under den kan bilder ligga i undermappar i flera nivåer. `path` räknas alltid från originalmappen och börjar med `original/`.

- Bilder känns igen på `hash`, så en flyttad eller omdöpt fil behåller sitt id. Finns inget fingeravtryck med samma värde matchas filen på `path`.
- Nya bilder får `lastId + 1` och framåt. Befintliga id ändras aldrig.
- Filer med exakt samma innehåll importeras en gång. Importen flyttar och ändrar aldrig något i originalmappen.
- Av filer med samma namn (oavsett mapp och versaler) och samma tagningstid, när båda har en, behålls den med högst upplösning, och vid lika upplösning den med lägst id. De andra hamnar i `duplicates` och importeras inte igen så länge bilden som behölls finns kvar.
- Metadata läses med exifr ur EXIF, IPTC och XMP för nya och ändrade filer: byline (IPTC Byline, EXIF Artist eller XMP creator, annars `Foto: <fotograf>`), tagningstid, nyckelord, bildtext och storlek. IPTC-text som är UTF-8 men lästs som Latin-1 ("MalmÃ¶") avkodas om. Texter som kameror skriver in automatiskt, t.ex. "OLYMPUS DIGITAL CAMERA", tas bort. Saknar en RAW-fil metadata används JPG:en bredvid den.
- För film läses längd och inspelningstid ur filens mvhd-box. Tiden är i UTC i filen och lagras som lokal tid.
- Nya bilder får `consent: "not-required"`, tomma villkor och inget slutdatum.
- Miniatyrer (400 px) och förhandsbilder (1600 px) skapas som WebP i webbläsaren, i en Web Worker med OffscreenCanvas. JPG, PNG, WebP, AVIF och GIF avkodas av webbläsaren, som också vänder dem enligt EXIF. TIFF avkodas med utif2 och HEIC med libheif-js (WebAssembly som ingår i appen). RAW-filer får förhandsbild från JPG:en bredvid, annars från den största inbäddade JPG:en, vriden enligt RAW-filens orientering. En stillbild ur en film tas av sidans huvudtråd med ett video-element, eftersom en worker saknar ett sådant. `width` och `height` är den avkodade bildens storlek efter rotation.
- Saknas en bilds miniatyr eller förhandsbild görs de om vid nästa import. En fil som inte gav någon förhandsbild (`previewProblem`) görs inte om förrän den ändras.
- Miniatyrer och förhandsbilder för bilder som tas bort ur indexet raderas.
- Kryssrutan "Kopiera nya original till bildbankens original/" är avstängd som standard och visas bara när originalmappen ligger utanför bildbanken. Är den ikryssad kopieras de nya bildernas original, och JPG:en till ett RAW-par, till bildbankens `original/` med samma sökväg som i `path`. En fil som redan finns där skrivs aldrig över. Har den samma storlek räknas den som redan kopierad, annars visas den i resultatet.
- Bilder vars fil inte finns kvar tas bort ur indexet. Deras id delas inte ut igen.
- Fält som går att ändra i appen, t.ex. rättigheter, följer med när en fil flyttas eller ändras.
- Under importen sparas färdiga poster i `app-data/import/pagaende.jsonl`, en JSON-post per rad. Avbryts importen fortsätter nästa import med dem. Filen tas bort när indexet har skrivits.
- Indexet skrivs först till `index.tmp.json`. Sedan sparas den nuvarande filen som `index.prev.json`, och den nya filen byter namn till `index.json`. För att gå tillbaka en version: byt namn på `index.prev.json` till `index.json`.
- AI-vektorer räknas ut för nya och ändrade bilder, och för bilder som saknar en vektor. Saknas modellen görs importen utan AI-vektorer, och förhandsvisningen säger det.
- AI-taggar sätts när nya AI-vektorer har räknats ut eller taggarna i `config.json` har ändrats, se AI-taggar. En ändrad fil får nya AI-taggar, en flyttad behåller sina. Saknas modellen behåller bilderna sina AI-taggar.
- Ordningen är alltid: miniatyrer och förhandsbilder först, sedan AI-vektorerna och AI-taggarna, sedan indexet, sist borttagning av bildfiler som det nya indexet inte längre pekar på. Ett index pekar därför aldrig på bildfiler som saknas, även om importen avbryts.
- `index.prev.json` skrivs bara över med ett giltigt index, aldrig med en tom eller trasig fil.
- När en import startar städas det som en avbruten import har lämnat kvar, och det som gjordes visas i förhandsvisningen:
  - `index.tmp.json` tas bort. Är `index.json` trasig men `index.tmp.json` hel används den i stället, och annars `index.prev.json`.
  - En tom eller trasig `index.prev.json` tas bort.
  - Rader i `pagaende.jsonl` som inte skrevs klart hoppas över, och de bilderna görs om.
  - Poster i `pagaende.jsonl` för filer som inte finns i den valda originalmappen kastas. Deras id har aldrig funnits i indexet och kan delas ut igen.
  - Bilder i indexet som saknar miniatyr eller förhandsbild görs om.
- Systemfiler (`desktop.ini`, `Thumbs.db`, `.DS_Store`, Macens `__MACOSX` och `._`-filer) hoppas över utan att visas.

## Hur testdata skapas

`npm run make-testdata` läser `testdata/original/<fotograf>/` och skriver `testdata/app-data/`.

- Storlek, tagningstid, byline, nyckelord och bildtext läses från EXIF, IPTC och XMP. Byline blir `Foto: <fotograf>` om filen saknar upphovsperson.
- `terms`, `rightsUntil`, `consent` och `blocked` finns inte i bildfilerna. Skriptet fyller i varierade testvärden så att alla varningar i appen förekommer.
- Id:n behålls för sökvägar som redan finns i `index.json`. Nya bilder får nästa lediga nummer. Id:n för flyttade dubbletter återanvänds aldrig.
- Dubbletter (samma filnamn och, om båda har en, samma tagningstid) tas bort ur indexet. Den med högst upplösning behålls, vid lika upplösning den med lägst id. De andra flyttas till `app-data/dubbletter/` med samma sökväg som i `original/`, och deras miniatyrer och förhandsbilder tas bort. `-- --dry-run` listar dubbletterna utan att flytta något.
- Varje flyttad fil loggas som en rad i `app-data/dubbletter/flyttade.jsonl`:

  ```json
  {"movedAt":"2026-10-29T15:48:05.421Z","id":"MB-000013","from":"original/Fotograf B/2012-000272_red2.jpg","to":"app-data/dubbletter/original/Fotograf B/2012-000272_red2.jpg","keptId":"MB-000002","keptPath":"original/Fotograf A/2012-000272_red2.jpg"}
  ```

  En flytt ångras genom att filen flyttas tillbaka från `to` till `from` och indexeringen körs igen. Bilden får då ett nytt id.
- Miniatyrer och förhandsbilder skapas bara om de saknas eller är äldre än originalet. `-- --force` skapar om alla.
- JPG, PNG, TIFF, WebP och GIF läses med sharp, och HEIC/HEIF avkodas med heic-decode.
- RAW-filer (cr2, cr3, nef, arw, dng) avkodas inte. En JPG med samma namn i samma mapp blir förhandsbild, och paret blir en post. Finns ingen sådan JPG används den största JPG som är inbäddad i RAW-filen. `width` och `height` är då förhandsbildens storlek, som kan vara mindre än sensorns.
- En JPG som får en RAW-fil bredvid sig behåller sitt id. Posten flyttas bara till RAW-filen.
- Video (mp4, mov, m4v) kräver ffmpeg. En bildruta en sekund in blir miniatyr och förhandsbild, och längd och inspelningstid läses ur filen. ffmpeg letas upp i den här ordningen: `FFMPEG_PATH`, paketet `ffmpeg-static`, `ffmpeg` på PATH. Finns inget av dem kör skriptet ffmpeg-static:s installationsskript, som laddar ner ffmpeg.
- Filer som varken är bilder eller video hoppas över med en varning.
- Kan miniatyr och förhandsbild inte skapas, t.ex. för en RAW-fil utan förhandsbild eller en video när ffmpeg saknas, kommer filen ändå med i indexet med en förklaring i `previewProblem`.

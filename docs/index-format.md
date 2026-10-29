# Indexformat: app-data/index.json

Appen läser hela bildbanken från `app-data/index.json`. Miniatyrer och förhandsbilder ligger bredvid, namngivna efter bildens id. TypeScript-typerna finns i `src/catalog/types.ts`.

```
app-data/
  index.json
  index.prev.json            föregående version, sparas vid varje import
  import/pagaende.jsonl      pågående import, finns bara medan en import pågår eller är avbruten
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
| `description` | sträng | Bildtext. Tom sträng om den saknas. Radbrytningar är `\n`. |
| `alternates` | lista med strängar | Andra filer av samma bild, med samma sökvägsregler som `path`. Används när en RAW-fil har en JPG med samma namn: `path` är RAW-filen och JPG:en ligger här. Oftast tom. Appen läser äldre index utan fältet som en tom lista. |
| `durationSeconds` | tal eller `null` | Längd i sekunder för video, `null` för bilder. För video är `width` och `height` filmens bildstorlek och `takenAt` inspelningstiden. Appen läser äldre index utan fältet som `null`. |
| `previewProblem` | sträng eller `null` | Varför miniatyr och förhandsbild saknas, skrivet för den som ska åtgärda det. `null` när de finns. Då är `width` och `height` 0, och appen visar en !-ikon med förklaringen. Appen läser äldre index utan fältet som `null`. |
| `hash` | sträng eller `null` | Snabbt fingeravtryck av originalet: `q1-` och SHA-256 i hex av filens storlek (8 byte, big-endian) följd av filens första och sista 4 MB, eller hela filen om den är högst 8 MB. För ett RAW-par är det SHA-256 av de två filernas fingeravtryck, åtskilda av radbrytning. Används för att känna igen flyttade och omdöpta filer. `null` i index från före importen i appen. |
| `fileSize`, `fileModified` | heltal eller `null` | Originalets storlek i byte och ändringstid i millisekunder sedan 1970. Är båda oförändrade återanvänds `hash` utan att filen läses. |

`path` och `alternates` kan ha vilken filändelse som helst: jpg, png, tif, heic, cr2, nef osv. Appen visar formatet utifrån filändelsen och läser aldrig originalen för att visa dem, bara miniatyrerna och förhandsbilderna.

Alla fält finns alltid med. Saknade texter är tomma strängar, och saknade datum är `null`.

## Import

Importen körs i appen, under Importera. Originalmappen väljs per dator, och kan ligga utanför bildbanken, t.ex. på G:. Varje mapp direkt under originalmappen är en fotograf, och under den kan bilder ligga i undermappar i flera nivåer. `path` räknas alltid från originalmappen och börjar med `original/`.

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
- Ordningen är alltid: miniatyrer och förhandsbilder först, sedan indexet, sist borttagning av bildfiler som det nya indexet inte längre pekar på. Ett index pekar därför aldrig på bildfiler som saknas, även om importen avbryts.
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

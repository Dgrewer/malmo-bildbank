# Indexformat: app-data/index.json

Appen läser hela bildbanken från `app-data/index.json`. Miniatyrer och förhandsbilder ligger bredvid, namngivna efter bildens id. TypeScript-typerna finns i `src/catalog/types.ts`.

```
app-data/
  index.json
  thumbs/MB-000001.webp      miniatyr, längsta sidan högst 400 px
  previews/MB-000001.webp    förhandsbild, längsta sidan högst 1600 px
```

Bilder förstoras aldrig. En bild som är mindre än 1600 px får en förhandsbild i originalstorlek. Miniatyrer och förhandsbilder är roterade enligt EXIF-orienteringen.

## Filen

```json
{
  "version": 1,
  "generatedAt": "2026-10-29T14:30:00.000Z",
  "images": [ ... ]
}
```

| Fält | Typ | Beskrivning |
|---|---|---|
| `version` | `1` | Formatversion. Höjs när formatet ändras på ett sätt som äldre appversioner inte klarar. |
| `generatedAt` | sträng | När indexet skapades, ISO 8601 i UTC. |
| `images` | lista | En post per bild, sorterad efter `path`. |

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
  "alternates": []
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

`path` och `alternates` kan ha vilken filändelse som helst: jpg, png, tif, heic, cr2, nef osv. Appen visar formatet utifrån filändelsen och läser aldrig originalen för att visa dem, bara miniatyrerna och förhandsbilderna.

Alla fält finns alltid med. Saknade texter är tomma strängar, och saknade datum är `null`.

## Hur testdata skapas

`npm run make-testdata` läser `testdata/original/<fotograf>/` och skriver `testdata/app-data/`.

- Storlek, tagningstid, byline, nyckelord och bildtext läses från EXIF, IPTC och XMP. Byline blir `Foto: <fotograf>` om filen saknar upphovsperson.
- `terms`, `rightsUntil`, `consent` och `blocked` finns inte i bildfilerna. Skriptet fyller i varierade testvärden så att alla varningar i appen förekommer.
- Id:n behålls för sökvägar som redan finns i `index.json`. Nya bilder får nästa lediga nummer.
- Miniatyrer och förhandsbilder skapas bara om de saknas eller är äldre än originalet. `-- --force` skapar om alla.
- JPG, PNG, TIFF, WebP och GIF läses med sharp, och HEIC/HEIF avkodas med heic-decode.
- RAW-filer (cr2, cr3, nef, arw, dng) avkodas inte. En JPG med samma namn i samma mapp blir förhandsbild, och paret blir en post. Finns ingen sådan JPG används den största JPG som är inbäddad i RAW-filen. `width` och `height` är då förhandsbildens storlek, som kan vara mindre än sensorns.
- En JPG som får en RAW-fil bredvid sig behåller sitt id. Posten flyttas bara till RAW-filen.
- Filer som inte är bilder, och RAW-filer utan förhandsbild, hoppas över med en varning.

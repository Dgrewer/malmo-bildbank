# Malmö Bildbank

Statisk webbapp (Vite + React + TypeScript) för ca 3 000 bilder.

## Arkitektur

- Ingen backend. Inga nätverksanrop med data.
- All data läses från en OneDrive-synkad SharePoint-mapp via File System Access API.
- Endast Chrome/Edge. Andra webbläsare får ett meddelande om att appen inte stöds.
- AI körs lokalt med Transformers.js. Modeller laddas från `app-data/models/`.
- Gränssnittet är på svenska.

## Plattformar

- Utvecklas och byggs på Windows men ska fungera likadant i Chrome på Windows och Mac.
- Sökvägar i index lagras alltid med `/` som avgränsare och Unicode-normaliserade (NFC), eftersom Mac och Windows lagrar å, ä och ö olika.
- Lokala sökvägar (originalmapp, Kopiera sökväg) är inställningar per dator, aldrig hårdkodade.

## Mappstruktur i den delade mappen

```
original/<fotograf>/        Originalbilder, en mapp per fotograf
app-data/
  index.json                Bildindex
  embeddings.bin            Embeddings för AI-sök
  config.json               Gemensam konfiguration
  thumbs/                   Miniatyrer
  previews/                 Förhandsvisningar
  models/                   Modeller för Transformers.js
  edits/                    Taggningar och rättigheter, en fil per användare
```

Indexformatet beskrivs i `docs/index-format.md`.

## Taggning

- Varje användare skriver bara till sin egen fil: `app-data/edits/<namn>.jsonl`.
- Appen läser och slår ihop alla filer i `edits/`. Skriv aldrig till någon annans fil.

## Rättigheter

- Villkor, rättighetsdatum, samtycke och spärr ställs in i appen. Det finns ingen adminroll: alla användare kan ändra dem.
- De kan sättas på två nivåer: för en fotografmapp (`original/<fotograf>/`) och för ett enskilt foto. Fotots inställning går före mappens.
- Ändringar sparas som alla andra ändringar, i användarens egen fil i `app-data/edits/`.
- Om två användare har ändrat samma sak gäller den senaste ändringen.
- Samtycke har tre värden: `given` (finns), `missing` (saknas, appen varnar) och `not-required` (behövs inte).
- Utgångna rättigheter ger en gul varning. Bilden spärras inte automatiskt.
- Spärrade bilder markeras tydligt i både rutnät och detaljvy.

## Filformat

- JPG, PNG, TIFF, WebP och GIF läses med sharp. HEIC/HEIF avkodas med heic-decode.
- RAW (cr2, cr3, nef, arw, dng) avkodas inte. Förhandsbilden skapas från en JPG med samma namn i samma mapp, och annars från den JPG som är inbäddad i RAW-filen.
- En RAW-fil och en JPG med samma namn är samma bild. Paret visas som en bild i galleriet, RAW-filen är originalet och JPG:en ligger i `alternates`.
- Chrome och Edge kan inte visa HEIC eller RAW, så appen visar alltid miniatyrer och förhandsbilder i WebP, aldrig originalen.

## Nedladdning

- Bilder hämtas till en mapp som användaren väljer, "Hämtade bilder".
- Kontrollera först om filen redan finns innan den skrivs.
- Originalen laddas ner, i originalets format. Ingen konvertering.
- Detaljvyn visar originalets format (JPG, PNG, TIFF, HEIC, RAW (CR2) osv.) innan bilden laddas ner. För ett RAW+JPG-par visas och kan båda filerna laddas ner.
- Filnamn: `<id>_<namn>.<originalets filändelse>`, t.ex. `MB-000001_utsikt.jpg` eller `MB-000022_IMG_0012.CR2`. Id:t börjar redan med `MB-`.

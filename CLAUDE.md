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
  edits/                    Taggningar, en fil per användare
```

## Taggning

- Varje användare skriver bara till sin egen fil: `app-data/edits/<namn>.jsonl`.
- Appen läser och slår ihop alla filer i `edits/`. Skriv aldrig till någon annans fil.

## Nedladdning

- Bilder hämtas till en mapp som användaren väljer, "Hämtade bilder".
- Kontrollera först om filen redan finns innan den skrivs.
- Filnamn: `MB-<id>_<namn>.jpg`.

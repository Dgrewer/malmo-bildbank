# Plan

Det som återstår, i ordning. Bocka av när ett steg är klart och pushat.

## Steg 4

- [x] 4.6 Plats: stadsområde och delområde från bildens GPS, matchat lokalt mot Malmö stads öppna data (CC0) som följer med appen. Ingen GPS ger ingen plats. GPS-positionen sparas i indexet, så att kartan nedan kan använda den.
- [x] Platsnamn: torg och parker (Malmö stads Parker och Torg, CC0) från GPS, och taggar som anger en plats (t.ex. Malmö rådhus → Stortorget) för bilder utan GPS. Visas som Stortorget · Gamla Staden · Norr och går att klicka på.
- [x] Sätt en tagg på liknande bilder direkt från Redigera, i en panel över fotot.
- [x] Samma bild, olika namn: Admin, fliken Samma bild, listar RAW-par vars RAW-fil eller JPG är samma fil som en annan bild. Vanliga kopior importerades redan bara en gång. Ingenting flyttas automatiskt.
- [ ] Logg i Admin: ändringar (från `app-data/edits/`), nya och borttagna bilder (från importerna), med vem och när.
- [ ] Sökruta i galleriet: taggar, ordlistan (svenska och engelska), fotograf och filnamn först, därefter AI-sök.
- [ ] Utvärderingssida, bara i utvecklingsläge: de tio bästa träffarna för 20 svenska testfrågor.
- [ ] Städa testdata: ta bort make-testdata, och sharp om inget annat använder det. Behåll `testdata/app-data/models`.
- [ ] Slutrapport: en full import utan externa anrop och utan CSP-fel, och instruktioner för manuell test.

## Senare

- [x] Ändringar per användare i `app-data/edits/<namn>.jsonl` (se CLAUDE.md), och Redigera i detaljvyn: fält, plats och taggar per foto.
- [ ] Rättigheter för en hel fotografmapp (`original/<fotograf>/`). Fotots inställning går före mappens.
- [ ] Karta över Malmö: områden och platser med bilder. Ett klick visar bilderna som är tagna där, ner till gatunivå.
- [ ] Gatunamn från GPS: närmaste gata ur Malmö stads Vägar och järnvägar.
- [ ] Stadsdelar: Malmö stads Stadsdelar som ytterligare platsnivå. Övriga öppna data från Malmö stad behövs inte.

# Plan

Det som återstår, i ordning. Bocka av när ett steg är klart och pushat.

## Steg 4

- [x] 4.6 Plats: stadsområde och delområde från bildens GPS, matchat lokalt mot Malmö stads öppna data (CC0) som följer med appen. Ingen GPS ger ingen plats. GPS-positionen sparas i indexet, så att kartan nedan kan använda den.
- [ ] Sökruta i galleriet: taggar, ordlistan (svenska och engelska), fotograf och filnamn först, därefter AI-sök.
- [ ] Utvärderingssida, bara i utvecklingsläge: de tio bästa träffarna för 20 svenska testfrågor.
- [ ] Städa testdata: ta bort make-testdata, och sharp om inget annat använder det. Behåll `testdata/app-data/models`.
- [ ] Slutrapport: en full import utan externa anrop och utan CSP-fel, och instruktioner för manuell test.

## Senare

- [ ] Ändringar per användare i `app-data/edits/<namn>.jsonl` (se CLAUDE.md): rättigheter per fotografmapp och foto, och platsen. En ändring går före det som importen har räknat ut, och den senaste ändringen gäller.
- [ ] Ändra platsen i detaljvyn, med hjälp av ändringarna ovan.
- [ ] Karta över Malmö: områden och platser med bilder. Ett klick visar bilderna som är tagna där, ner till gatunivå.

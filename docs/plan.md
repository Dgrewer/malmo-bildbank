# Plan

Det som återstår, i ordning. Bocka av när ett steg är klart och pushat.

Ledstjärnan är bygginstruktionen "Malmö Bildbank – bygginstruktion" (Claude Docs).
Stegen nedan följer den, plus det som har lagts till under bygget.

## Steg 4 – Import och lokal AI

- [x] 4.6 Plats: stadsområde och delområde från bildens GPS, matchat lokalt mot Malmö stads öppna data (CC0) som följer med appen. Ingen GPS ger ingen plats. GPS-positionen sparas i indexet, så att kartan nedan kan använda den.
- [x] Platsnamn: torg och parker (Malmö stads Parker och Torg, CC0) från GPS, och taggar som anger en plats (t.ex. Malmö rådhus → Stortorget) för bilder utan GPS. Visas som Stortorget · Gamla Staden · Norr och går att klicka på.
- [x] Sätt en tagg på liknande bilder direkt från Redigera, i en panel över fotot.
- [x] Samma bild, olika namn: Admin, fliken Samma bild, listar RAW-par vars RAW-fil eller JPG är samma fil som en annan bild. Vanliga kopior importerades redan bara en gång. Ingenting flyttas automatiskt.
- [ ] Utvärderingssida, bara i utvecklingsläge: de tio bästa träffarna för 20 svenska testfrågor. Byt modell om resultatet är svagt.

## Steg 5 – Sökning, taggning och nedladdning

- [ ] 5.1 Sökning: en sökruta för taggar, ordlistan (svenska och engelska, svensk ordstamsmatchning), fotograf och filnamn, med exakta träffar först och därefter AI-sök. Filter för fotograf, plats, år och rättigheter.
- [ ] 5.2 Liknande bilder i detaljvyn, med AI-vektorerna.
- [x] 5.3 Varning för saknat samtycke, och spärrade bilder markerade i rutnät och detaljvy. Inget rättighetsdatum. Detaljvyn visar fotodatum och upplösning (pixlar och dpi, går inte att ändra).
- [x] Taggar hanteras likadant oavsett om en person eller AI:n har satt dem. En tagg som sätts för hand blir ett exempel, och appen sätter den direkt på liknande bilder. En tagg som tas bort från en bild kommer inte tillbaka på den bilden. Exemplen läses från `app-data/edits/`, så kollegor kan tagga samtidigt.
- [x] Ord under "Hör ihop med" som inte är taggar blir taggar på bilderna med taggen (t.ex. slott → Malmöhus). Hellre en tagg för mycket än för lite. "Andra ord för samma sak" är bara för att hitta taggen (engelska ord och felstavningar) och visas inte.
- [ ] Admin, AI-taggar: taggar som bara har satts för hand listas också, med bilderna de har spridits till, så att gränsen går att justera där.
- [ ] 5.4 Taggning: läs om alla filer i `app-data/edits/` varje minut, så att kollegornas ändringar syns. Ändringshistorik per bild, där en felaktig ändring går att ångra.
- [ ] 5.4 Logg i Admin: ändringar (från `app-data/edits/`), nya och borttagna bilder (från importerna), med vem och när.
- [ ] 5.5 Nedladdning till mappen Hämtade bilder (se CLAUDE.md). Spärrade bilder går inte att ladda ner.
- [ ] Ladda ner och Dela på varje bild i rutnätet: Dela-ikonen i övre vänstra hörnet och Ladda ner-ikonen i övre högra. De syns bara på bilden man håller musen över.
- [ ] Korg: varje användare samlar bilder i en egen korg för att ladda ner dem alla på en gång.
  - Korgen sparas bara på användarens dator och delas inte med andra.
  - Korgen ligger som ett fält längst ner på sidan. Man drar bilder dit.
  - En miniatyr i korgen förstoras till rutnätets miniatyrstorlek när man håller musen över den. Ett litet rött kryss i övre högra hörnet tar bort bilden ur korgen.
  - En Ladda ner-ikon hämtar alla bilderna i korgen. En Dela-ikon skapar en länk till bilderna som kan skickas till någon annan.
- [ ] 5.6 Kopiera sökväg i adminläget, för InDesign. Rotsökvägen ställs in per dator.
- [ ] 5.7 Importen bakar in ändringarna från `app-data/edits/` i index.json.
- [ ] Rättigheter för en hel fotografmapp (`original/<fotograf>/`), i ett svep. Fotots inställning går före mappens.

## Steg 6 – Publicera på GitHub Pages

- [ ] 6.1 GitHub Actions bygger appen och publicerar den på Pages vid varje push till main.
- [ ] 6.2 Settings → Pages i repot, med GitHub Actions som källa (görs av användaren).
- [ ] 6.3 Versionsnumret i appens sidfot.
- [ ] 6.4 Kontrollera i nätverksfliken att den publicerade appen inte gör några anrop till andra adresser än GitHub Pages.
- [ ] 6.5 Arbeta i en egen gren och slå ihop med main först när ändringen är testad. Main är alltid det kollegorna använder.

## Steg 7 – Testa slutprodukten

- [ ] Städa testdata: ta bort make-testdata, och sharp om inget annat använder det. Behåll `testdata/app-data/models`. RAW-paret får ett eget foto i stället för en kopia av Knutssalen. Testet skapar själv ett dubblettpar (samma namn och tagningstid), så att flytten till `app-data/dubbletter/` alltid testas.
- [ ] Slutrapport: en full import utan externa anrop och utan CSP-fel, och instruktioner för manuell test enligt checklistan i steg 7 i bygginstruktionen.

## Senare

- [x] Ändringar per användare i `app-data/edits/<namn>.jsonl` (se CLAUDE.md), och Redigera i detaljvyn: fält, plats och taggar per foto.
- [ ] Karta över Malmö: områden och platser med bilder. Ett klick visar bilderna som är tagna där, ner till gatunivå.
- [ ] Gatunamn från GPS: närmaste gata ur Malmö stads Vägar och järnvägar.
- [ ] Stadsdelar: Malmö stads Stadsdelar som ytterligare platsnivå. Övriga öppna data från Malmö stad behövs inte.

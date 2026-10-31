// Kopiera sökväg: originalets sökväg på den här datorn, t.ex. för att länka
// bilden i InDesign. Bildbankens sökväg ställs in per dator i Admin, eftersom
// webbläsaren inte kan ta reda på den.

// "C:\Bildbank" + "original/A/bild.jpg" -> "C:\Bildbank\original\A\bild.jpg"
// "/Users/x/Bildbank" + "original/A/bild.jpg" -> "/Users/x/Bildbank/original/A/bild.jpg"
export function localFilePath(root: string, path: string): string {
  const windows = root.includes('\\') || /^[a-z]:/i.test(root)
  const separator = windows ? '\\' : '/'
  return root.trim().replace(/[\\/]+$/, '') + separator + path.split('/').join(separator)
}

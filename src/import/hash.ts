// Snabbt fingeravtryck: SHA-256 av filens storlek plus de första och sista 4 MB.
// Två olika foton med samma storlek och identiska första och sista 4 MB
// förekommer inte i praktiken, och skanningen slipper läsa hela filer. Det är
// viktigt när originalen ligger i OneDrive och annars måste laddas ner.
//
// Prefixet q1 anger metoden, så att den kan bytas utan att gamla värden misstolkas.

const CHUNK = 4 * 1024 * 1024

export async function quickHash(file: Blob): Promise<string> {
  const size = new DataView(new ArrayBuffer(8))
  size.setBigUint64(0, BigInt(file.size))
  const parts: BlobPart[] = [size.buffer]
  if (file.size <= 2 * CHUNK) parts.push(file)
  else parts.push(file.slice(0, CHUNK), file.slice(file.size - CHUNK))
  const digest = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer())
  return 'q1-' + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Fingeravtrycket för en bild som består av flera filer, t.ex. en RAW-fil och
// JPG:en som förhandsbilden skapas från. Ändras någon av filerna ändras bilden.
export async function combinedHash(hashes: string[]): Promise<string> {
  if (hashes.length === 1) return hashes[0]
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashes.join('\n')))
  return 'q1-' + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

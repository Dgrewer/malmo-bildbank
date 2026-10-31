// Dela: en länk till appen med bildernas id efter #, t.ex.
// https://…/malmo-bildbank/#bilder=MB-000012,MB-000031. Den som öppnar länken
// ser bilderna i sin egen bildbank. Det som står efter # skickas aldrig till
// servern, så länken avslöjar ingenting för GitHub Pages.

const PREFIX = '#bilder='

export function shareLink(ids: string[]): string {
  return `${location.origin}${location.pathname}${PREFIX}${ids.join(',')}`
}

// Id:n i länken som appen öppnades med, eller null.
export function sharedIds(): string[] | null {
  if (!location.hash.startsWith(PREFIX)) return null
  const ids = decodeURIComponent(location.hash.slice(PREFIX.length))
    .split(',')
    .filter((id) => /^MB-\d{6}$/.test(id))
  return ids.length ? ids : null
}

export function clearSharedIds() {
  if (location.hash.startsWith(PREFIX)) history.replaceState(null, '', location.pathname + location.search)
}

// Kopierar länken. Returnerar texten som visas för användaren.
export async function copyShareLink(ids: string[]): Promise<string> {
  const link = shareLink(ids)
  try {
    await navigator.clipboard.writeText(link)
    return ids.length === 1
      ? 'Länken till bilden är kopierad. Den fungerar för kollegor som har bildbanken.'
      : `Länken till ${ids.length} bilder är kopierad. Den fungerar för kollegor som har bildbanken.`
  } catch {
    return `Kopiera länken: ${link}`
  }
}

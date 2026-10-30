// Malmös områden, parker och torg för väljarna i Redigera och Admin. Filen är
// stor, så den laddas först när någon behöver den och hamnar inte i galleriets kod.

import type { Areas, Place } from '../catalog/places.ts'

let loading: Promise<Areas> | null = null

export function loadAreas(): Promise<Areas> {
  loading ??= import('./malmo-areas.json').then((module) => module.default as Areas)
  return loading
}

// Parkerna och torgen, sorterade, med sin plats. Samma namn kan finnas i flera
// sorter, t.ex. en park och ett naturområde, och visas då med sorten.
export interface NamedPlace {
  label: string
  place: Place
}

export async function loadNamedPlaces(): Promise<NamedPlace[]> {
  const areas = await loadAreas()
  const count = new Map<string, number>()
  for (const area of areas.named) count.set(area.name, (count.get(area.name) ?? 0) + 1)
  return areas.named
    .map((area) => ({
      label: count.get(area.name)! > 1 ? `${area.name} (${area.kind?.toLocaleLowerCase('sv')})` : area.name,
      place: { district: area.district!, subdistrict: area.subdistrict ?? null, name: area.name },
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'sv'))
}

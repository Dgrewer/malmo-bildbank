import type { Consent, ImageRecord } from './types.ts'

// Dagens datum som ÅÅÅÅ-MM-DD i lokal tid, samma form som rightsUntil.
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// rightsUntil är sista giltiga dag. Bilden räknas som utgången dagen efter.
export function rightsExpired(image: ImageRecord, on = today()): boolean {
  return image.rightsUntil !== null && image.rightsUntil < on
}

// "2024-12-31" -> "31 december 2024"
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' })
}

export const CONSENT_TEXT: Record<Consent, string> = {
  given: 'Finns',
  missing: 'Saknas',
  'not-required': 'Behövs inte',
}

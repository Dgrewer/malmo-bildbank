import type { Consent } from './types.ts'

const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december']

// "2024-12-31" -> "31 december 2024"
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return `${day} ${MONTHS[month - 1]} ${year}`
}

// Tagningstiden ur EXIF, "2016-09-13T17:47:23" -> "13 september 2016 kl. 17.47".
// Tiden är kamerans lokala tid och räknas inte om.
export function formatTaken(takenAt: string): string {
  const match = takenAt.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/)
  if (!match) return takenAt
  return match[2] ? `${formatDate(match[1])} kl. ${match[2]}.${match[3]}` : formatDate(match[1])
}

export const CONSENT_TEXT: Record<Consent, string> = {
  given: 'Finns',
  missing: 'Saknas',
  'not-required': 'Behövs inte',
}

// Längd och inspelningstid för en MP4- eller MOV-film, ur filmens mvhd-box.
// Bara rubrikerna läses, inte själva filmen, så även stora filer går fort.

export interface VideoInfo {
  durationSeconds: number | null
  takenAt: string | null
}

// MP4 räknar tid i sekunder från 1904-01-01 UTC.
const MP4_EPOCH = Date.UTC(1904, 0, 1)
const MAX_MOOV = 64 * 1024 * 1024

async function bytes(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer())
}

function boxType(view: DataView, offset: number): string {
  return String.fromCharCode(...[4, 5, 6, 7].map((n) => view.getUint8(offset + n)))
}

// Letar upp en box på översta nivån och returnerar var dess innehåll börjar och slutar.
async function findTopLevel(file: Blob, type: string): Promise<[number, number] | null> {
  let offset = 0
  while (offset + 8 <= file.size) {
    const header = await bytes(file, offset, Math.min(offset + 16, file.size))
    let size = header.getUint32(0)
    let headerSize = 8
    if (size === 1 && header.byteLength >= 16) {
      size = Number(header.getBigUint64(8))
      headerSize = 16
    } else if (size === 0) size = file.size - offset
    if (size < headerSize) return null
    if (boxType(header, 0) === type) return [offset + headerSize, offset + size]
    offset += size
  }
  return null
}

function localTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export async function readVideoInfo(file: Blob): Promise<VideoInfo> {
  const none = { durationSeconds: null, takenAt: null }
  try {
    const moov = await findTopLevel(file, 'moov')
    if (!moov || moov[1] - moov[0] > MAX_MOOV) return none
    const view = await bytes(file, moov[0], moov[1])
    for (let offset = 0; offset + 8 <= view.byteLength; ) {
      const size = view.getUint32(offset)
      if (size < 8) return none
      if (boxType(view, offset) === 'mvhd') {
        const body = offset + 8
        const version = view.getUint8(body)
        const created = version === 1 ? Number(view.getBigUint64(body + 4)) : view.getUint32(body + 4)
        const timescale = view.getUint32(body + (version === 1 ? 20 : 12))
        const duration = version === 1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16)
        // mvhd anger UTC. Lagras som lokal tid utan zon, som EXIF-tiderna.
        // Kameror utan klocka skriver 0, alltså år 1904.
        const date = new Date(MP4_EPOCH + created * 1000)
        return {
          durationSeconds: timescale ? Math.round((duration / timescale) * 1000) / 1000 : null,
          takenAt: date.getUTCFullYear() > 1970 ? localTime(date) : null,
        }
      }
      offset += size
    }
  } catch {
    // En trasig fil ger inga uppgifter, men importen fortsätter.
  }
  return none
}

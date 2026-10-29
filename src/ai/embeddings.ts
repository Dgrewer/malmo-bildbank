import { formatId, idNumber } from '../catalog/types.ts'

// Läser och skriver vektorfiler (app-data/embeddings.bin och
// app-data/import/pagaende.bin). Formatet beskrivs i docs/index-format.md:
//
//   "MBEV"                   4 byte
//   version                  uint32, 1
//   dimensioner              uint32, t.ex. 768
//   antal rader              uint32
//   rader                    id-nummer (uint32) + dimensioner × float32
//
// Alla tal är little-endian. Varje rad har sitt id, så filen kan aldrig
// hamna i otakt med indexet.

const MAGIC = 0x5645424d // "MBEV" läst som little-endian uint32
const VERSION = 1
const HEADER = 16

export type Vectors = Map<string, Float32Array>

export function encodeVectors(vectors: Vectors, dimensions: number): ArrayBuffer {
  const rowBytes = 4 + dimensions * 4
  const buffer = new ArrayBuffer(HEADER + vectors.size * rowBytes)
  const view = new DataView(buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, VERSION, true)
  view.setUint32(8, dimensions, true)
  view.setUint32(12, vectors.size, true)
  let offset = HEADER
  for (const [id, vector] of vectors) {
    if (vector.length !== dimensions) throw new Error(`Vektorn för ${id} har ${vector.length} dimensioner, inte ${dimensions}`)
    view.setUint32(offset, idNumber(id), true)
    for (let i = 0; i < dimensions; i++) view.setFloat32(offset + 4 + i * 4, vector[i], true)
    offset += rowBytes
  }
  return buffer
}

// Tolkar en vektorfil. Returnerar null om filen inte är en giltig vektorfil
// med rätt antal dimensioner, t.ex. en halvskriven fil eller en annan modell.
export function decodeVectors(buffer: ArrayBuffer, dimensions: number): Vectors | null {
  if (buffer.byteLength < HEADER) return null
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION) return null
  if (view.getUint32(8, true) !== dimensions) return null
  const count = view.getUint32(12, true)
  const rowBytes = 4 + dimensions * 4
  if (buffer.byteLength !== HEADER + count * rowBytes) return null
  const vectors: Vectors = new Map()
  for (let row = 0, offset = HEADER; row < count; row++, offset += rowBytes) {
    const vector = new Float32Array(dimensions)
    for (let i = 0; i < dimensions; i++) vector[i] = view.getFloat32(offset + 4 + i * 4, true)
    vectors.set(formatId(view.getUint32(offset, true)), vector)
  }
  return vectors
}

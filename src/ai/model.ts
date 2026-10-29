import {
  AutoImageProcessor,
  AutoTokenizer,
  env,
  RawImage,
  SiglipTextModel,
  SiglipVisionModel,
  type Tensor,
} from '@huggingface/transformers'
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { readFile } from '../fs/folder.ts'
import { MODEL } from './modelInfo.ts'

// Transformers.js körs helt lokalt:
// - Modellfilerna läses ur bildbankens app-data/models/ via mappens handle,
//   genom en egen fetch. Alla andra adresser vägras, så inget kan hämtas
//   från internet.
// - ONNX Runtimes WebAssembly-filer följer med appen och laddas från dess
//   egen origin, inte från ett CDN.
// - Inget sparas i webbläsarens cache.

const MODELS_PATH = 'app-data/models/'

let bank: FileSystemDirectoryHandle | null = null

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = MODELS_PATH
env.useBrowserCache = false
env.useWasmCache = false
env.fetch = async (input: RequestInfo | URL) => {
  const path = (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).replace(/^\/+/, '')
  if (!bank || !path.startsWith(MODELS_PATH)) {
    throw new Error(`AI-modellen får bara läsas från bildbankens ${MODELS_PATH}, inte ${path}`)
  }
  const file = await readFile(bank, path)
  return file ? new Response(file) : new Response(null, { status: 404 })
}
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } }
if (onnx.wasm) {
  onnx.wasm.wasmPaths = { mjs: new URL(ortMjs, location.href).href, wasm: new URL(ortWasm, location.href).href }
  // Flera trådar kräver cross-origin isolation, som appen inte har.
  onnx.wasm.numThreads = 1
}

export class ModelMissingError extends Error {}

// Finns modellen i bildbanken? Kontrollerar bara att filerna finns.
export async function hasModel(root: FileSystemDirectoryHandle): Promise<boolean> {
  const files = ['config.json', 'tokenizer.json', `onnx/${MODEL.visionFile}.onnx`, `onnx/${MODEL.textFile}.onnx`]
  for (const file of files) {
    if (!(await readFile(root, `${MODELS_PATH}${MODEL.name}/${file}`))) return false
  }
  return true
}

function useBank(root: FileSystemDirectoryHandle) {
  if (bank && bank !== root) {
    vision = null
    text = null
  }
  bank = root
}

function normalize(data: Float32Array, offset: number): Float32Array {
  const vector = data.slice(offset, offset + MODEL.dimensions)
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum) || 1
  for (let i = 0; i < vector.length; i++) vector[i] /= length
  return vector
}

function rows(output: Tensor): Float32Array[] {
  const data = output.data as Float32Array
  const count = output.dims[0]
  return Array.from({ length: count }, (_, row) => normalize(data, row * MODEL.dimensions))
}

function missing(): ModelMissingError {
  return new ModelMissingError(`AI-modellen saknas i ${MODELS_PATH}${MODEL.name}. Kör npm run download-model.`)
}

export type Device = 'webgpu' | 'wasm'

type Vision = {
  processor: Awaited<ReturnType<typeof AutoImageProcessor.from_pretrained>>
  model: SiglipVisionModel
  device: Device
}
let vision: Promise<Vision> | null = null

async function run(current: Omit<Vision, 'device'>, image: ImageData): Promise<Float32Array> {
  const raw = new RawImage(new Uint8ClampedArray(image.data), image.width, image.height, 4).rgb()
  const { pooler_output } = await current.model(await current.processor(raw))
  return rows(pooler_output as Tensor)[0]
}

// Bildmodellen körs på grafikkortet (WebGPU) om det går, annars med
// WebAssembly, ungefär tjugo gånger långsammare. Grafikkortet provas med en
// bild först, eftersom en del grafikkort saknar stöd för 16-bitars tal.
async function createVision(): Promise<Vision> {
  const processor = await AutoImageProcessor.from_pretrained(MODEL.name)
  if ('gpu' in navigator) {
    try {
      const model = await SiglipVisionModel.from_pretrained(MODEL.name, { dtype: 'fp16', device: 'webgpu' })
      try {
        await run({ processor, model }, new ImageData(32, 32))
        return { processor, model, device: 'webgpu' }
      } catch {
        await model.dispose()
      }
    } catch {
      // Inget användbart grafikkort. WebAssembly används i stället.
    }
  }
  const model = await SiglipVisionModel.from_pretrained(MODEL.name, { dtype: 'fp16', device: 'wasm' })
  return { processor, model, device: 'wasm' }
}

async function loadVision(root: FileSystemDirectoryHandle): Promise<Vision> {
  useBank(root)
  vision ??= hasModel(root).then((found) => {
    if (!found) throw missing()
    return createVision()
  })
  vision.catch(() => (vision = null))
  return vision
}

// Var bildmodellen körs. Laddar modellen om den inte redan är laddad.
export async function visionDevice(root: FileSystemDirectoryHandle): Promise<Device> {
  return (await loadVision(root)).device
}

// Normaliserad vektor för en bild, t.ex. en miniatyr som ImageData.
export async function imageEmbedding(root: FileSystemDirectoryHandle, image: ImageData): Promise<Float32Array> {
  return run(await loadVision(root), image)
}

type Text = { tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>; model: SiglipTextModel }
let text: Promise<Text> | null = null

async function loadText(root: FileSystemDirectoryHandle): Promise<Text> {
  useBank(root)
  text ??= hasModel(root).then(async (found) => {
    if (!found) throw missing()
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL.name),
      SiglipTextModel.from_pretrained(MODEL.name, { dtype: 'q8', device: 'wasm' }),
    ])
    return { tokenizer, model }
  })
  text.catch(() => (text = null))
  return text
}

// Normaliserade vektorer för sökfraser. SigLIP tränades med gemener och
// texter utfyllda till exakt 64 token.
export async function textEmbeddings(root: FileSystemDirectoryHandle, texts: string[]): Promise<Float32Array[]> {
  const { tokenizer, model } = await loadText(root)
  const inputs = tokenizer(
    texts.map((value) => value.toLowerCase()),
    { padding: 'max_length', truncation: true, max_length: MODEL.maxTokens },
  )
  const { pooler_output } = await model(inputs)
  return rows(pooler_output as Tensor)
}

// De delar av libheif-js som importen använder. Paketet har typer för
// libheif.js men inte för ESM-versionen med inbakad WebAssembly.

declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  interface HeifImage {
    get_width(): number
    get_height(): number
    display(target: ImageData, callback: (result: ImageData | null) => void): void
    free(): void
  }

  interface LibHeif {
    HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[]; decoder: { delete(): void } }
  }

  const factory: () => LibHeif
  export default factory
}

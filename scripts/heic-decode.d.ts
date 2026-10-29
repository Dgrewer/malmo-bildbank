declare module 'heic-decode' {
  interface DecodedImage {
    width: number
    height: number
    // RGBA, fyra byte per pixel
    data: Uint8ClampedArray
  }
  function decode(options: { buffer: ArrayBufferLike | Uint8Array }): Promise<DecodedImage>
  export default decode
}

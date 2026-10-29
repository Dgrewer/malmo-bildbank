// AI-modellen för bildsök. Filerna ligger i app-data/models/<name>/ och laddas
// ner med npm run download-model. Delas mellan appen och nedladdningsskriptet.
export const MODEL = {
  name: 'siglip2-base-patch16-224',
  // ONNX-filerna i onnx/, utan .onnx. Textmodellen är 8-bitars kvantiserad och
  // körs med WebAssembly. Bildmodellen är 16-bitars och körs på grafikkortet
  // (WebGPU), där 8-bitars modeller är långsamma.
  textFile: 'text_model_quantized',
  visionFile: 'vision_model_fp16',
  dimensions: 768,
  // Textmodellen tränades på texter med högst 64 token.
  maxTokens: 64,
} as const

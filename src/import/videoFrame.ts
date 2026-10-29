// Tar en stillbild ur en film i sidans huvudtråd, åt importens worker som inte
// har något video-element. En bildruta en sekund in, eller mitt i korta filmer,
// så att den inte blir svart. Webbläsaren vänder bildrutan enligt filmens rotation.
//
// Returnerar null om webbläsaren inte kan läsa filmen, t.ex. HEVC på en dator
// utan stöd för det.

const TIMEOUT_MS = 20_000

function once(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Filmen svarade inte')), TIMEOUT_MS)
    video.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true })
    video.addEventListener('error', () => (clearTimeout(timer), reject(video.error)), { once: true })
  })
}

export async function captureFrame(file: File): Promise<ImageBitmap | null> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  try {
    const loaded = once(video, 'loadeddata')
    video.src = url
    await loaded
    const at = Math.min(1, (video.duration || 0) / 2)
    if (at > 0) {
      const seeked = once(video, 'seeked')
      video.currentTime = at
      await seeked
    }
    return video.videoWidth ? await createImageBitmap(video) : null
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

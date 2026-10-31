import { createContext, useContext, type KeyboardEvent, type MouseEvent } from 'react'

// Öppnar en bild i detaljvyn ovanpå Admin. ids är bilderna man kan bläddra
// mellan, i den ordning de visas.
export const OpenImage = createContext<((id: string, ids: string[]) => void) | null>(null)

// Gör en miniatyr i Admin klickbar. Bläddringen går mellan miniatyrerna i samma
// vy, i den ordning de syns.
export function useOpenImage(id: string) {
  const open = useContext(OpenImage)
  if (!open) return {}
  const show = (element: HTMLElement) => {
    const view = element.closest('.tag-detail, .same-images') ?? document
    const ids = [...new Set([...view.querySelectorAll<HTMLElement>('[data-id]')].map((item) => item.dataset.id!))]
    open(id, ids.includes(id) ? ids : [id])
  }
  return {
    role: 'button',
    tabIndex: 0,
    title: `Visa ${id}`,
    onClick: (event: MouseEvent<HTMLElement>) => show(event.currentTarget),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      show(event.currentTarget)
    },
  }
}

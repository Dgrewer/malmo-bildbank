import { useEffect, useState } from 'react'

export type ObjectUrl = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; url: string }

// Läser en fil från disk och visar den som object-URL. URL:en frigörs när
// komponenten tas bort, t.ex. när en miniatyr lämnar vyn i det virtuella rutnätet.
export function useObjectUrl(directory: FileSystemDirectoryHandle, name: string): ObjectUrl {
  const [state, setState] = useState<ObjectUrl>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    setState({ status: 'loading' })
    directory
      .getFileHandle(name)
      .then((handle) => handle.getFile())
      .then(
        (file) => {
          if (cancelled) return
          url = URL.createObjectURL(file)
          setState({ status: 'ready', url })
        },
        () => {
          if (!cancelled) setState({ status: 'missing' })
        },
      )
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [directory, name])

  return state
}

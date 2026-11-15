import { createContext, type ReactNode, useContext } from 'react'
import type { DiagramPngRasterAdapter } from '../editor/mermaidExport'

/**
 * Optional override context supplying an offscreen SVG-to-PNG rasterizer adapter for Mermaid blocks.
 */
export const MermaidExportContext = createContext<DiagramPngRasterAdapter | undefined>(undefined)

interface MermaidExportProviderProps {
  rasterAdapter?: DiagramPngRasterAdapter
  children: ReactNode
}

/**
 * Provides an explicit Mermaid PNG rasterizer adapter to nested Mermaid blocks without
 * clobbering an ancestor adapter when `rasterAdapter` is omitted.
 */
export function MermaidExportProvider({ rasterAdapter, children }: MermaidExportProviderProps) {
  const inheritedAdapter = useContext(MermaidExportContext)
  const effectiveAdapter = rasterAdapter ?? inheritedAdapter
  if (effectiveAdapter === inheritedAdapter) {
    return <>{children}</>
  }

  return (
    <MermaidExportContext.Provider value={effectiveAdapter}>
      {children}
    </MermaidExportContext.Provider>
  )
}

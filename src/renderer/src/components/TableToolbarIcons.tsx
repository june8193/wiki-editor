import type { ComponentType, ReactNode } from 'react'

export type TableToolbarIconComponent = ComponentType

function TableToolbarIconSvg({ children }: { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Icon representing inserting a row above the active cell. */
export function AddRowBeforeIcon() {
  return (
    <TableToolbarIconSvg>
      <path d="M12 4v6" />
      <path d="M9 7h6" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M9 14v6" />
      <path d="M15 14v6" />
    </TableToolbarIconSvg>
  )
}

/** Icon representing inserting a row below the active cell. */
export function AddRowAfterIcon() {
  return (
    <TableToolbarIconSvg>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <path d="M9 4v6" />
      <path d="M15 4v6" />
      <path d="M12 14v6" />
      <path d="M9 17h6" />
    </TableToolbarIconSvg>
  )
}

/** Icon representing inserting a column to the left of the active cell. */
export function AddColumnBeforeIcon() {
  return (
    <TableToolbarIconSvg>
      <path d="M7 9v6" />
      <path d="M4 12h6" />
      <rect x="14" y="3" width="6" height="18" rx="1.5" />
      <path d="M14 9h6" />
      <path d="M14 15h6" />
    </TableToolbarIconSvg>
  )
}

/** Icon representing inserting a column to the right of the active cell. */
export function AddColumnAfterIcon() {
  return (
    <TableToolbarIconSvg>
      <rect x="4" y="3" width="6" height="18" rx="1.5" />
      <path d="M4 9h6" />
      <path d="M4 15h6" />
      <path d="M17 9v6" />
      <path d="M14 12h6" />
    </TableToolbarIconSvg>
  )
}

/** Icon representing deleting the current row. */
export function DeleteRowIcon() {
  return (
    <TableToolbarIconSvg>
      <rect x="3" y="4" width="18" height="6" rx="1.5" fill="currentColor" fillOpacity="0.14" />
      <path d="M9 4v6" />
      <path d="M15 4v6" />
      <path d="M9.5 14.5l5 5" />
      <path d="M14.5 14.5l-5 5" />
    </TableToolbarIconSvg>
  )
}

/** Icon representing deleting the current column. */
export function DeleteColumnIcon() {
  return (
    <TableToolbarIconSvg>
      <rect x="4" y="3" width="6" height="18" rx="1.5" fill="currentColor" fillOpacity="0.14" />
      <path d="M4 9h6" />
      <path d="M4 15h6" />
      <path d="M14.5 9.5l5 5" />
      <path d="M19.5 9.5l-5 5" />
    </TableToolbarIconSvg>
  )
}

/** Icon representing deleting the entire table. */
export function DeleteTableIcon() {
  return (
    <TableToolbarIconSvg>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" />
      <path d="M21 11V5a2 2 0 0 0-2-2h-7" />
      <path d="M3 9h18" />
      <path d="M3 15h9" />
      <path d="M9 3v18" />
      <path d="M15.5 15.5l5 5" />
      <path d="M20.5 15.5l-5 5" />
    </TableToolbarIconSvg>
  )
}

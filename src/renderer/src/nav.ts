import { createContext, useContext } from 'react'

export type Route =
  | { name: 'today'; edit?: boolean }
  | { name: 'tasks' }
  | { name: 'notes'; noteId?: string }
  | { name: 'calendar' }
  | { name: 'groups' }
  | { name: 'timer' }
  | { name: 'stats' }
  | { name: 'settings' }
  | { name: 'subject'; id: string }

export const NavCtx = createContext<{ route: Route; go: (r: Route) => void }>({ route: { name: 'today' }, go: () => {} })
export const useNav = () => useContext(NavCtx)

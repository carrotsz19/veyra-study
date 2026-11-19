import { createContext, useContext } from 'react'

export type Route =
  | { name: 'today'; edit?: boolean }
  | { name: 'tasks' }
  | { name: 'notes'; noteId?: string }
  | { name: 'ai'; chatId?: string }
  | { name: 'calendar' }
  | { name: 'messages'; dmId?: string }
  | { name: 'groups' }
  | { name: 'timer' }
  | { name: 'stats' }
  | { name: 'settings' }
  | { name: 'subject'; id: string }

export const NavCtx = createContext<{ route: Route; go: (r: Route) => void }>({ route: { name: 'today' }, go: () => {} })
export const useNav = () => useContext(NavCtx)

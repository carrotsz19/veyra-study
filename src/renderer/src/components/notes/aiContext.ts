import { createContext } from 'react'
import type { Editor } from '@tiptap/react'
import type { AiTask } from '../../data/ai'

/** Starts an AI study task on the open note (or on the selection in `editor`). */
export const NoteAiCtx = createContext<((task: AiTask, editor?: Editor) => void) | null>(null)

/** Opens the Assistant (the Veyra AI agent) beside the open note. */
export const NoteAgentCtx = createContext<(() => void) | null>(null)

import { History, Lock, NotebookPen, Sparkles } from 'lucide-react'
import { useNav } from '../nav'

/**
 * The Veyra AI tab: a home of its own for AI chats, coming in an update. Until then the
 * Assistant lives beside each note (its Past chats list has every chat, from any note).
 */
export function AiView() {
  const { go } = useNav()
  return (
    <div className="inner view">
      <div className="topbar">
        <h1>Veyra AI</h1>
      </div>
      <div className="ai-soon">
        <div className="ai-soon-icon">
          <Sparkles size={26} />
          <span className="ai-soon-lock">
            <Lock size={13} />
          </span>
        </div>
        <h2>Update Coming Soon!</h2>
        <p className="ai-soon-sub">Stay Tuned!</p>
        <p className="dim">
          This tab will be a home for AI chats of their own, not tied to a note. For now, open the Assistant in any note, and use <History size={13} className="ai-soon-inline" /> Past chats there to get back to your earlier chats from any note.
        </p>
        <button className="btn sec" onClick={() => go({ name: 'notes' })}>
          <NotebookPen size={15} /> Go to Notes
        </button>
      </div>
    </div>
  )
}

import { useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Check, X } from 'lucide-react'

/** Add or edit a link on the selected text. (Electron has no prompt(), so this is inline.) */
export function LinkInput({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const [url, setUrl] = useState<string>(() => editor.getAttributes('link').href ?? '')
  const apply = () => {
    const v = url.trim()
    const c = editor.chain().focus().extendMarkRange('link')
    if (!v) c.unsetLink().run()
    else c.setLink({ href: /^(https?:|mailto:)/i.test(v) ? v : `https://${v}` }).run()
    onDone()
  }
  return (
    <form
      className="link-input"
      onSubmit={(e) => {
        e.preventDefault()
        apply()
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        autoFocus
        value={url}
        placeholder="Paste or type a link"
        aria-label="Link address"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onDone()
            editor.commands.focus()
          }
        }}
      />
      <button type="submit" className="fb-btn" aria-label="Apply link" title="Apply (Enter)">
        <Check size={15} />
      </button>
      <button
        type="button"
        className="fb-btn"
        aria-label="Cancel"
        title="Cancel (Esc)"
        onClick={() => {
          onDone()
          editor.commands.focus()
        }}
      >
        <X size={15} />
      </button>
    </form>
  )
}

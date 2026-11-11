import { format } from 'date-fns'
import { MapPin } from 'lucide-react'
import type { GoogleEvent } from '@shared/types'
import { useTimeFormat } from '../data/settings'
import { Dialog } from './ui'

/** "9:00 – 10:30" (or "All day") for an event. */
export function useEventTime() {
  const fmt = useTimeFormat()
  return (e: GoogleEvent) => (e.allDay ? 'All day' : `${fmt(new Date(e.start))} – ${fmt(new Date(e.end))}`)
}

/** Details of one calendar event, from Google or a calendar link. */
export function EventDialog({ event, onClose }: { event: GoogleEvent; onClose: () => void }) {
  const range = useEventTime()
  return (
    <Dialog title={event.title} onClose={onClose}>
      <div className="row" style={{ gap: 10, marginTop: -6 }}>
        <span style={{ width: 12, height: 12, borderRadius: 4, background: event.color }} />
        <span className="sm dim">{event.calendar}</span>
      </div>
      <p style={{ margin: '12px 0 0' }}>
        {format(new Date(event.allDay ? event.start + 'T00:00:00' : event.start), 'EEEE d MMMM')}
        <span className="dim"> · {range(event)}</span>
      </p>
      {event.location && (
        <p className="sm row" style={{ margin: '8px 0 0', gap: 6 }}>
          <MapPin size={14} className="dim" /> {event.location}
        </p>
      )}
      <div className="actions">
        {event.link && (
          <button className="btn sec" onClick={() => window.veyra.open(event.link)}>
            Open in Google Calendar
          </button>
        )}
        <button className="btn" onClick={onClose} autoFocus>
          Done
        </button>
      </div>
    </Dialog>
  )
}

/**
 * Calendars added by link: Google's "Secret address in iCal format" (or any
 * .ics URL). Read-only, no Google sign-in needed. The links are secrets, so
 * they're stored encrypted (safeStorage), like the Google sign-in.
 */
import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ICAL from 'ical.js'
import type { GoogleEvent, IcalFeed } from '../shared/types'

const COLORS = ['#7986cb', '#33b679', '#e67c73', '#f6bf26', '#8e24aa', '#039be5', '#616161']

interface Stored extends IcalFeed {
  url: string
}

export class IcalFeeds {
  private feeds: Stored[] = []
  private cache = new Map<string, { at: number; text: string }>()
  private disposed = false

  constructor(private file: string) {
    try {
      if (existsSync(file) && safeStorage.isEncryptionAvailable()) this.feeds = JSON.parse(safeStorage.decryptString(readFileSync(file)))
    } catch {
      this.feeds = []
    }
  }

  dispose(): void {
    this.disposed = true
  }

  private save() {
    if (this.disposed) return
    if (!this.feeds.length) return rmSync(this.file, { force: true })
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer can’t store calendar links securely.')
    writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.feeds)))
  }

  list(): IcalFeed[] {
    return this.feeds.map(({ id, name, color, error }) => ({ id, name, color, error }))
  }

  async add(rawUrl: string, name: string): Promise<IcalFeed[]> {
    let url = rawUrl.trim().replace(/^webcal:\/\//i, 'https://')
    if (!/^https:\/\/\S+$/i.test(url)) throw new IcalError('Paste the full link. It starts with https:// and usually ends in .ics.')
    if (/calendar\.google\.com\/calendar\/embed/i.test(url)) throw new IcalError('That’s the embed link. Use “Secret address in iCal format” instead.')
    const text = await this.fetchText(url, true)
    const comp = new ICAL.Component(ICAL.parse(text))
    const calName = String(comp.getFirstPropertyValue('x-wr-calname') ?? '').trim()
    const feed: Stored = {
      id: randomUUID(),
      name: name.trim() || calName || 'Calendar',
      color: COLORS[this.feeds.length % COLORS.length],
      url
    }
    this.feeds.push(feed)
    this.save()
    return this.list()
  }

  remove(id: string): IcalFeed[] {
    this.feeds = this.feeds.filter((f) => f.id !== id)
    this.save()
    return this.list()
  }

  private async fetchText(url: string, strict = false): Promise<string> {
    const hit = this.cache.get(url)
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.text
    let res: Response
    try {
      res = await fetch(url, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(20000) })
    } catch {
      throw new IcalError('Couldn’t reach that link. Check your connection.')
    }
    if (res.status === 404 || res.status === 403 || res.status === 401)
      throw new IcalError('That link doesn’t work any more. In Google Calendar it may have been reset. Copy the secret address again.')
    if (!res.ok) throw new IcalError(`The calendar server answered ${res.status}.`)
    const text = await res.text()
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new IcalError(strict ? 'That link isn’t a calendar (.ics) file.' : 'The link no longer returns a calendar.')
    this.cache.set(url, { at: Date.now(), text })
    return text
  }

  /** Events from every feed that overlap [from, to). */
  async events(fromIso: string, toIso: string): Promise<{ events: GoogleEvent[]; error?: string }> {
    const from = new Date(fromIso).getTime()
    const to = new Date(toIso).getTime()
    const out: GoogleEvent[] = []
    let error: string | undefined
    for (const feed of this.feeds) {
      try {
        out.push(...this.expand(await this.fetchText(feed.url), feed, from, to))
        feed.error = undefined
      } catch (e) {
        feed.error = e instanceof IcalError ? e.message : 'Couldn’t read this calendar.'
        error = `${feed.name}: ${feed.error}`
      }
    }
    return { events: out, error }
  }

  private expand(text: string, feed: Stored, from: number, to: number): GoogleEvent[] {
    const cal = new ICAL.Component(ICAL.parse(text))
    for (const tz of cal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz)
    const vevents = cal.getAllSubcomponents('vevent')
    // Changed single occurrences of a repeating event (RECURRENCE-ID) are
    // separate VEVENTs; ICAL.Event needs them attached to the master.
    const masters = new Map<string, ICAL.Event>()
    const exceptions: ICAL.Component[] = []
    for (const v of vevents) {
      if (v.hasProperty('recurrence-id')) exceptions.push(v)
      else masters.set(String(v.getFirstPropertyValue('uid')), new ICAL.Event(v))
    }
    for (const x of exceptions) masters.get(String(x.getFirstPropertyValue('uid')))?.relateException(x)

    const out: GoogleEvent[] = []
    const push = (ev: ICAL.Event, start: ICAL.Time, end: ICAL.Time, key: string) => {
      const s = start.toJSDate().getTime()
      const e = end.toJSDate().getTime()
      if (e <= from || s >= to) return
      if (String(ev.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return
      const allDay = start.isDate
      const day = (t: ICAL.Time) => `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`
      out.push({
        id: `ical|${feed.id}|${key}`,
        title: ev.summary || '(No title)',
        calendar: feed.name,
        color: feed.color,
        allDay,
        start: allDay ? day(start) : new Date(s).toISOString(),
        end: allDay ? day(end) : new Date(e).toISOString(),
        location: ev.location || '',
        link: ''
      })
    }

    for (const [uid, ev] of masters) {
      if (!ev.startDate) continue
      if (!ev.isRecurring()) {
        push(ev, ev.startDate, ev.endDate ?? ev.startDate, uid)
        continue
      }
      const it = ev.iterator()
      for (let i = 0, next = it.next(); next && i < 5000; i++, next = it.next()) {
        const t = next.toJSDate().getTime()
        if (t >= to) break
        const occ = ev.getOccurrenceDetails(next)
        push(occ.item, occ.startDate, occ.endDate, `${uid}|${next.toString()}`)
      }
    }
    return out
  }
}

export class IcalError extends Error {}

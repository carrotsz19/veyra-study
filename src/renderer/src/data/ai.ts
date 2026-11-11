import { useCallback, useEffect, useRef, useState } from 'react'

/* =====================================================================
   AI study tools: prompts, a streaming hook, and parsers that turn the
   model's plain-text answer into note blocks or tasks. The formats are
   deliberately simple so small local models get them right.
===================================================================== */

export type AiTask = 'summary' | 'flashcards' | 'quiz' | 'explain' | 'simplify' | 'plan'

const BASE =
  'You are a study assistant inside a student’s notes app. Be accurate and concise. If the notes are too short or unclear to do the task, say so in one sentence. Never invent facts that aren’t supported by the notes, except in explanations, where you may add standard background knowledge.'

export const AI_LABELS: Record<AiTask, string> = {
  summary: 'Summarize',
  flashcards: 'Make flashcards',
  quiz: 'Quiz questions',
  explain: 'Explain',
  simplify: 'Simplify',
  plan: 'Plan from syllabus'
}

export function buildPrompt(task: AiTask, text: string, extra?: { title?: string; today?: string }): { system: string; prompt: string } {
  const notes = `Title: ${extra?.title || 'Untitled'}\n\n${text.trim()}`
  switch (task) {
    case 'summary':
      return {
        system: BASE,
        prompt: `Summarize these study notes as 4–8 short bullet points covering the key ideas. Output only the bullets, one per line, each starting with "- ".\n\n${notes}`
      }
    case 'flashcards':
      return {
        system: BASE,
        prompt: `Write 6–12 flashcards from these study notes. Each card tests one fact or idea. Use exactly this format for every card, with a blank line between cards and nothing else:\nQ: question\nA: short answer\n\n${notes}`
      }
    case 'quiz':
      return {
        system: BASE,
        prompt: `Write 5–8 exam-style questions from these study notes that test understanding, not just recall. Use exactly this format, with a blank line between questions and nothing else:\nQ: question\nA: model answer in one to three sentences\n\n${notes}`
      }
    case 'explain':
      return {
        system: BASE,
        prompt: `Explain the following passage to a student in plain language, in 2–4 short paragraphs. Include a simple example if it helps. Output only the explanation.\n\nPassage:\n${text.trim()}`
      }
    case 'simplify':
      return {
        system: BASE,
        prompt: `Rewrite the following passage in simpler, clearer language for revision, keeping every fact. Output only the rewritten text.\n\nPassage:\n${text.trim()}`
      }
    case 'plan':
      return {
        system: BASE,
        prompt: `Today is ${extra?.today}. From this course syllabus or assignment list, list every deadline, exam, reading and assignment as a task. Output one task per line in exactly this format and nothing else:\nYYYY-MM-DD | task title\nUse the next matching date in the future when the year is missing. If an item has no date, write "none" instead of the date.\n\n${text.trim()}`
      }
  }
}

/** Parses "Q: … / A: …" cards. */
export function parseCards(text: string): { q: string; a: string }[] {
  const cards: { q: string; a: string }[] = []
  const re = /Q\s*[:.)-]\s*([\s\S]+?)\n\s*A\s*[:.)-]\s*([\s\S]+?)(?=\n\s*\n|\n\s*Q\s*[:.)-]|$)/gi
  for (const m of text.matchAll(re)) {
    const q = m[1].replace(/\*\*/g, '').trim()
    const a = m[2].replace(/\*\*/g, '').trim()
    if (q && a) cards.push({ q, a })
  }
  return cards
}

/** Parses "- point" bullets (falls back to non-empty lines). */
export function parseBullets(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const bullets = lines.filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, '').replace(/\*\*/g, ''))
  return bullets.length ? bullets : lines.map((l) => l.replace(/\*\*/g, ''))
}

/** Parses "YYYY-MM-DD | title" lines into tasks. */
export function parsePlan(text: string): { due: string | null; title: string }[] {
  const out: { due: string | null; title: string }[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[-*•\d.)\s]+(?=\d{4}-|none)/i, '').trim()
    const m = line.match(/^(\d{4}-\d{2}-\d{2}|none)\s*\|\s*(.+)$/i)
    if (m) out.push({ due: m[1].toLowerCase() === 'none' ? null : m[1], title: m[2].trim().slice(0, 200) })
  }
  return out
}

/** Runs one AI request and exposes the streaming answer. */
export function useAiRun() {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const idRef = useRef<string | null>(null)

  useEffect(
    () =>
      window.veyra.ai.onEvent((e) => {
        if (e.id !== idRef.current) return
        if (e.delta) setText((t) => t + e.delta)
        if (e.error) {
          setError(e.error)
          setStatus('error')
        } else if (e.done) setStatus('done')
      }),
    []
  )
  useEffect(() => () => void (idRef.current && window.veyra.ai.cancel(idRef.current)), [])

  const run = useCallback((req: { system: string; prompt: string }) => {
    if (idRef.current) window.veyra.ai.cancel(idRef.current)
    const id = crypto.randomUUID()
    idRef.current = id
    setText('')
    setError('')
    setStatus('running')
    window.veyra.ai.run(id, req)
  }, [])
  const stop = useCallback(() => {
    if (idRef.current) window.veyra.ai.cancel(idRef.current)
  }, [])
  return { text, status, error, run, stop }
}

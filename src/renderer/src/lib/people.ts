/** A steady colour for a person's cursor (the same name always gets the same colour). */
const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#d6336c', '#0c8599', '#f08c00', '#5f3dc4']
export function personColor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0
  return COLORS[Math.abs(h) % COLORS.length]
}

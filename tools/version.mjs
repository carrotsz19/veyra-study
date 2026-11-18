/**
 * Veyra Study's version numbers: year.month.release-in-that-month, e.g. 26.11.1, 26.11.2,
 * then 26.12.1 in December. Picked automatically (npm run ship), so nobody types one.
 * They count as newer than the old 1.0.x numbers, so updates carry on from those.
 *
 * Android's version code is built from it (android/app/build.gradle): yy*1000000 + month*10000 + n,
 * e.g. 26.11.1 → 26110001, so a month can have up to 9999 releases.
 */
export function nextVersion(current, now = new Date()) {
  const yy = now.getFullYear() % 100
  const m = now.getMonth() + 1
  const [a, b, c] = String(current).split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  return a === yy && b === m ? `${yy}.${m}.${c + 1}` : `${yy}.${m}.1`
}

/** A test build's number: the next version, marked with the date and time (26.11.2-dev.202611181905). */
export function devVersion(current, now = new Date()) {
  return `${nextVersion(current, now)}-dev.${now.toISOString().replace(/\D/g, '').slice(0, 12)}`
}

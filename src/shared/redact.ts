/**
 * Scrubs anything personal out of a diagnostics line before it's written or sent:
 * the Windows (or macOS/Linux) user name in paths, email addresses, sign-in tokens,
 * passwords and keys in URLs or headers, and long random strings such as session tokens.
 *
 * Diagnostics only ever log technical events; this is the safety net for error messages,
 * which can quote a path or a URL.
 */
export function redact(text: string, userName?: string): string {
  let s = String(text)
  // Paths under the user's home folder, in either slash style: C:\Users\<name>\…, /Users/<name>/…, /home/<name>/…
  s = s.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'`]+/gi, '$1<user>')
  s = s.replace(/(\/(?:Users|home)\/)[^/\s"'`]+/g, '$1<user>')
  // The user name anywhere else (only when it's long enough not to eat ordinary words).
  if (userName && userName.length >= 3) s = s.replace(new RegExp(userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>')
  // Email addresses.
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
  // Bearer tokens and Authorization headers.
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <secret>')
  // Secret-looking query or key=value pairs.
  s = s.replace(/\b(token|access_token|refresh_token|id_token|pass|password|secret|key|apikey|api_key|session|code|sig|signature)=([^&\s"']+)/gi, '$1=<secret>')
  // API keys with well-known prefixes.
  s = s.replace(/\b(sk-ant-|sk-|AIza|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{8,}/g, '<secret>')
  // Long hex or base64 runs (session tokens, hashes, keys).
  s = s.replace(/\b[a-f0-9]{32,}\b/gi, '<secret>')
  s = s.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '<secret>')
  return s
}

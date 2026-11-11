/**
 * Google sign-in for installed apps, shared by Calendar and Drive: the system
 * browser, a loopback redirect to 127.0.0.1 on a random port, and PKCE.
 */
import { shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export class GoogleAuthError extends Error {}

/** Dev checks can point token requests at a stand-in server. */
export const TOKEN_URL = process.env['VEYRA_GOOGLE_TOKEN_URL'] || 'https://oauth2.googleapis.com/token'

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export interface GoogleTokens {
  refresh_token?: string
  access_token: string
  expires_in: number
  id_token?: string
}

export const emailFromIdToken = (idToken?: string): string => {
  try {
    return idToken ? JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString()).email || '' : ''
  } catch {
    return ''
  }
}

/** POST to Google's token endpoint. Errors are thrown with Google's own error code in `code`. */
export async function tokenRequest(body: Record<string, string>): Promise<GoogleTokens> {
  let res: Response
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(20000)
    })
  } catch {
    throw new GoogleAuthError('Can’t reach Google. Check your connection.')
  }
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new GoogleAuthError(
      json.error === 'invalid_client' ? 'Google didn’t accept that client ID or secret. Check them and try again.' : json.error_description || json.error || `Google refused the sign-in (${res.status}).`
    )
    ;(err as any).code = json.error
    throw err
  }
  return json
}

/**
 * Opens Google's consent page in the browser and waits for the answer.
 * `what` names the connection on the page shown afterwards ("Google Drive is connected").
 */
export async function googleSignIn(o: { clientId: string; clientSecret?: string; scopes: string[]; what: string }): Promise<GoogleTokens> {
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const { code, redirect } = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Veyra Study</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;background:#f3f1ec;color:#1b1a18"><div style="text-align:center"><h2>${
          ok ? `${o.what} is connected` : 'That didn’t work'
        }</h2><p>${ok ? 'You can close this tab and go back to Veyra Study.' : 'Go back to Veyra Study and try again.'}</p></div>`
      )
      clearTimeout(timeout)
      server.close()
      if (ok) resolve({ code: url.searchParams.get('code')!, redirect: `http://127.0.0.1:${(server.address() as AddressInfo | null)?.port ?? port}` })
      else reject(new GoogleAuthError(url.searchParams.get('error') === 'access_denied' ? 'You didn’t allow access in Google.' : 'Google sign-in didn’t finish.'))
    })
    let port = 0
    const timeout = setTimeout(() => {
      server.close()
      reject(new GoogleAuthError('Google sign-in timed out. Try again.'))
    }, 5 * 60 * 1000)
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.search = new URLSearchParams({
        client_id: o.clientId,
        redirect_uri: `http://127.0.0.1:${port}`,
        response_type: 'code',
        scope: o.scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent'
      }).toString()
      shell.openExternal(auth.toString())
    })
  })

  return tokenRequest({
    client_id: o.clientId,
    ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirect
  })
}

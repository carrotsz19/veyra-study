// Code signing for the Windows app (Azure Trusted Signing), used by tools/release.mjs.
//
// build/signing.json (in the repo, nothing secret): which Trusted Signing account and
// certificate to use, and the publisher name. Its being there means "Veyra is signed": from
// then on a release without the sign-in details fails, because installed signed apps check
// that each update is signed by the same publisher and would refuse an unsigned one.
//
// C:\dev\tools\azure-signing.json (never in the repo): the sign-in for signing,
// { "tenantId", "clientId", "clientSecret" } of an Entra app with the
// "Trusted Signing Certificate Profile Signer" role.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(dirname(fileURLToPath(import.meta.url)))
export const SETTINGS = join(HERE, 'build', 'signing.json')
export const SECRETS = process.env.VEYRA_SIGNING_SECRETS || 'C:/dev/tools/azure-signing.json'

/** null while Veyra isn't signed yet; else the electron-builder settings and the sign-in for them. */
export function signing() {
  if (!existsSync(SETTINGS)) return null
  const s = JSON.parse(readFileSync(SETTINGS, 'utf8'))
  if (!existsSync(SECRETS)) {
    console.error(`Veyra is signed (build/signing.json), but the signing sign-in isn't here: ${SECRETS}.\nReleasing unsigned would break updates for installed copies, so stopping.`)
    process.exit(1)
  }
  const k = JSON.parse(readFileSync(SECRETS, 'utf8'))
  for (const f of ['tenantId', 'clientId', 'clientSecret']) if (!k[f]) throw new Error(`${SECRETS} is missing "${f}"`)
  return {
    win: {
      azureSignOptions: {
        publisherName: s.publisherName,
        endpoint: s.endpoint,
        codeSigningAccountName: s.codeSigningAccountName,
        certificateProfileName: s.certificateProfileName
      },
      // Electron's DLLs too, not just the .exe files, so Smart App Control trusts every file.
      signExts: ['.dll', '.node', 'elevate.exe']
    },
    env: { AZURE_TENANT_ID: k.tenantId, AZURE_CLIENT_ID: k.clientId, AZURE_CLIENT_SECRET: k.clientSecret }
  }
}

// Veyra Study Dev: the Windows build for testing (npm run release:dev).
// Same app as package.json's "build", but its own identity, so it installs next to
// the real Veyra Study instead of replacing it: its own app id (and so its own
// install folder, uninstall entry and Start menu shortcut), name and installer,
// and updates from the private carrotsz19/veyra-study-dev repo instead of the public releases.
const base = require('./package.json').build
const version = process.env.VEYRA_VERSION
if (!version) throw new Error('VEYRA_VERSION is set by tools/release.mjs --dev')

module.exports = {
  ...base,
  appId: 'app.veyra.study.dev',
  productName: 'Veyra Study Dev',
  extraMetadata: { name: 'veyra-study-dev', version },
  directories: { output: 'release-dev' },
  nsis: {
    ...base.nsis,
    shortcutName: 'Veyra Study Dev',
    artifactName: 'Veyra-Study-Dev-Setup.${ext}'
  },
  // Test builds live in a private repo; the app reads it with a read-only token (src/main/updater.ts).
  publish: [{ provider: 'github', owner: 'carrotsz19', repo: 'veyra-study-dev', private: true }]
}

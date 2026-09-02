/**
 * electron-builder config, as a file rather than package.json's `build` key
 * so `signAndEditExecutable` can be conditional (see below) without a second,
 * hand-maintained copy of this config for CI.
 *
 * Icon sources: build/icon.svg is the single hand-authored master; every
 * raster here (icon.ico, icon.icns, icon.png, tray/*.png) is generated from
 * it by `npm run icons` and committed — see build/icon.svg's header comment
 * and tests/icons.test.ts, which fails if the committed rasters drift from
 * the source.
 */

// rcedit (which stamps the .ico into OpenTime.exe and edits its version
// resources) needs Wine on a non-Windows host. Keep it on whenever the build
// is actually running on Windows — real hardware or the windows-latest CI
// runner — and only skip it for a local Linux/macOS dev build that lacks
// Wine, matching the README's "Building the NSIS installer on Linux needs
// Wine" note. Skipping it there still produces a correct win-unpacked build;
// it just leaves the raw .exe's embedded icon as Electron's default, which
// CI (where this matters for the installer, shortcuts, and Explorer/Alt-Tab)
// does not skip.
const canEditExecutable = process.platform === 'win32'

module.exports = {
  appId: 'app.opentime.desktop',
  productName: 'OpenTime',
  files: ['dist/**/*', 'package.json'],
  directories: {
    output: 'release',
  },
  // Exposes the app icon to the running app itself (window/taskbar icon, the
  // tray glyph) at a stable path outside the asar — see src/main/icon.ts.
  extraResources: [
    { from: 'build/icon.png', to: 'icon.png' },
    { from: 'build/tray', to: 'tray' },
  ],
  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
    artifactName: 'OpenTime-${version}-setup.${ext}',
    signAndEditExecutable: canEditExecutable,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
  },
  mac: {
    target: ['dmg'],
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
  },
}

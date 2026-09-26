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
    // What people see in their Downloads folder, so it says what it is.
    artifactName: 'OpenTime-Setup-${version}.${ext}',
    signAndEditExecutable: canEditExecutable,
    // Bundles the VC++ runtime DLLs @miniben90/x-win's native binary links
    // against — see AGENTS.md's x-win/VCRUNTIME140.dll note. Populated by
    // scripts/prepare-win-redist.mjs / the CI "Bundle the VC++ runtime DLLs"
    // step; Windows checks the exe's own directory before System32.
    extraFiles: [
      {
        from: 'build/win-redist',
        to: '.',
        filter: ['*.dll'],
      },
    ],
  },
  // One click: double-click the installer and OpenTime is installed for this
  // user (no admin prompt), with Start menu and desktop shortcuts, and opens.
  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // The data folder lives in the user's app-data directory, apart from the
    // program. Installing, updating and uninstalling never touch it.
    deleteAppDataOnUninstall: false,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
  },
  // Where the in-app updater looks. electron-builder embeds this as
  // resources/app-update.yml and writes latest.yml next to the installer;
  // both must be attached to the GitHub release (the release workflow does).
  publish: {
    provider: 'github',
    owner: 'ElectricGamer61',
    repo: 'OpenTime',
    releaseType: 'release',
  },
  mac: {
    target: ['dmg'],
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
  },
}

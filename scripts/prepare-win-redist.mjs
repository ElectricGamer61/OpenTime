/**
 * Ensures `build/win-redist/` exists before electron-builder runs.
 *
 * electron-builder's `win.extraFiles` config (package.json) copies whatever is
 * in this directory to sit next to OpenTime.exe — which is where Windows'
 * default DLL search order looks *before* System32, so a runtime DLL dropped
 * there is found without installing anything system-wide or asking for admin
 * rights. On a real Windows packaging run, the CI workflow populates it with
 * the Visual C++ runtime DLLs the native capture module needs (see the
 * "Bundle the VC++ runtime DLLs" step in .github/workflows/windows-package.yml)
 * before this script runs. Everywhere else (local dev, non-Windows CI checks
 * of the packaging step) the directory is simply empty, and electron-builder
 * copies nothing — this script only has to make sure the path exists so that
 * `extraFiles` doesn't fail packaging over a missing directory.
 */

import { mkdirSync } from 'node:fs'

mkdirSync(new URL('../build/win-redist', import.meta.url), { recursive: true })

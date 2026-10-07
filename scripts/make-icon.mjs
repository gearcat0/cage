// Render the app icons from the logo (.github/assets/logo.svg), the envelope
// used on souspli.org, the README and the GitHub org.
//
//   pnpm gen:icon          (Linux without a display: xvfb-run -a pnpm gen:icon)
//
// It runs under Electron, already a dependency, and draws the SVG in a hidden
// transparent window, so the PNGs are exactly what a browser renders.
//
//   build/icon.png      1024², the logo edge to edge. Windows and Linux.
//   build/icon-mac.png  1024², on Apple's icon grid: the body 824² and centred,
//                       with transparent margin around it and corners at
//                       Apple's ~22% radius, so it sits at the same size as
//                       other apps in the Dock.
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'

const S = 1024
const logo = readFileSync('.github/assets/logo.svg', 'utf8')
// The logo's own markup, without its outer <svg> element.
const inner = logo.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '')

const full = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${S}" height="${S}">${inner}</svg>`
const MAC_BODY = 824
const macInner = inner.replace('<rect width="64" height="64" rx="12"', '<rect width="64" height="64" rx="14.3"')
const mac =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">` +
  `<g transform="translate(${(S - MAC_BODY) / 2} ${(S - MAC_BODY) / 2}) scale(${MAC_BODY / 64})">${macInner}</g></svg>`

// One CSS pixel per image pixel, whatever the screen.
app.commandLine.appendSwitch('force-device-scale-factor', '1')
// Each icon closes its window; that must not quit the app between icons.
app.on('window-all-closed', () => {})

// One fresh offscreen window per icon: a reused one can hand back a frame of
// the previous page. Offscreen windows deliver frames through 'paint'
// (capturePage is not reliable for them without a GPU), so the listener goes
// on once the page has loaded, and a repaint is asked for.
async function render(svg) {
  const win = new BrowserWindow({
    width: S,
    height: S,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  })
  try {
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const image = await new Promise((resolve) => {
      const onPaint = (_e, _dirty, img) => {
        const { width, height } = img.getSize()
        if (width !== S || height !== S) return // wait for a full-size frame
        // ...and one with the drawing in it: early frames can be blank. The
        // centre is the envelope in every icon, so it must be opaque.
        const centre = ((S / 2) * S + S / 2) * 4
        if (img.toBitmap()[centre + 3] !== 255) return
        win.webContents.off('paint', onPaint)
        resolve(img)
      }
      win.webContents.on('paint', onPaint)
      win.webContents.invalidate()
    })
    return image.toPNG()
  } finally {
    win.destroy()
  }
}

app.whenReady().then(async () => {
  try {
    for (const [path, svg] of [
      ['build/icon.png', full],
      ['build/icon-mac.png', mac]
    ]) {
      const png = await render(svg)
      writeFileSync(path, png)
      console.log(`wrote ${path} (${S}×${S}, ${png.length} bytes)`)
    }
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})

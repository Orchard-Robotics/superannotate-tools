# SuperAnnotate Tools

A collection of small browser tools for the [SuperAnnotate](https://app.superannotate.com)
annotation editor, distributed as [userscripts](https://en.wikipedia.org/wiki/Userscript).

Each tool is a single `.user.js` file that runs in your own browser and adds
features to the editor UI. Nothing is installed server-side and no annotation
data leaves your machine.

## Install

### 1. Install Tampermonkey

Tampermonkey is the extension that runs userscripts. Pick your browser:

- **Firefox** — [Tampermonkey on Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tampermonkey/)
- **Chrome** — [Tampermonkey on the Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)

(Edge, Opera and Safari builds of Tampermonkey work too.)

### 2. Install the script

With Tampermonkey installed, click the link below. Tampermonkey opens an
install tab — press **Install**.

**[→ Install sa-paintbrush.user.js](https://raw.githubusercontent.com/Orchard-Robotics/superannotate-tools/main/sa-paintbrush.user.js)**

Then reload any open SuperAnnotate editor tab.

## What's included

### Paintbrush, Eraser & Fill by Color — `sa-paintbrush.user.js`

Adds a tool group to the editor's left panel and a **Tool settings** tab to the
right panel.

- **Paintbrush** (<kbd>Shift</kbd>+<kbd>B</kbd>) — hold the left mouse button
  and drag to paint. On release the stroke becomes a polygon in the currently
  selected class, simplified with Ramer–Douglas–Peucker and merged with any
  overlapping polygon of the same class.
- **Eraser** (<kbd>Shift</kbd>+<kbd>E</kbd>) — the same stroke, subtracted
  instead. A polygon the stroke cuts across is split into distinct polygons;
  one that is fully covered is removed.
- **Fill by Color** (<kbd>Shift</kbd>+<kbd>F</kbd>) — a port of GIMP's
  *Select by Color*. **Left-click** the image to preview every region whose
  colour is within the threshold of the pixel you clicked; **right-click** to
  commit it as polygons. Nothing is created until that right-click. Adjusting
  the settings updates the preview live, with no need to click again, and
  left-clicking outside the image (or switching tools, or <kbd>Esc</kbd>)
  discards it.

**Tool settings** holds brush and eraser sizes, and for Fill by Color the
**Threshold** (0–255, GIMP's scale) and **Select by** criterion — Composite,
Red, Green, Blue, HSV Hue, HSV Saturation and HSV Value. Settings are
remembered between sessions.

**Switching tools** — right-click or click-and-hold the tool button (or the
**Tool settings** tab) to open the tool menu, the same gesture the editor's own
tool groups use.

Every tool only ever touches the currently selected class, and every action is
a single undo step — the editor's undo button and <kbd>Ctrl</kbd>+<kbd>Z</kbd>
revert a whole stroke or a whole fill.

Shortcuts are <kbd>Shift</kbd>-based because every bare letter is already bound
by the editor itself.

Runs on `https://app.superannotate.com/editor/*`.

#### Fill by Color requirements

Reading image pixels means the browser has to fetch the image with CORS
allowed. If your image host does not send `Access-Control-Allow-Origin`, the
tool reports that it could not read the pixels instead of failing silently.
Tiled (very large) projects render through OpenSeadragon rather than a plain
image and are not supported yet.

## Updating

Tampermonkey checks for updates automatically. To force one, open the
Tampermonkey dashboard, select the script, and use **Check for userscript
updates** — or just click the install link above again.

## License

MIT — see [LICENSE](LICENSE).

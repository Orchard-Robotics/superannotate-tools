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

### Paintbrush & Eraser — `sa-paintbrush.user.js`

Adds a brush tool group to the editor's left panel and a **Tool settings** tab
to the right panel.

- **Paintbrush** (`B`) — hold the left mouse button and drag to paint. On
  release the stroke becomes a polygon in the currently selected class,
  simplified with Ramer–Douglas–Peucker and merged with any overlapping
  polygon of the same class.
- **Eraser** (`E`) — the same stroke, subtracted instead. A polygon the stroke
  cuts across is split into distinct polygons; one that is fully covered is
  removed.
- **Switching tools** — right-click or click-and-hold the brush button (or the
  **Tool settings** tab) to open the tool menu, the same gesture the editor's
  own tool groups use.
- **Sizes** — brush and eraser sizes are in the **Tool settings** tab and are
  remembered between sessions.

Both tools only ever touch polygons of the currently selected class, and each
stroke is a single undo step — the editor's undo button and <kbd>Ctrl</kbd>+<kbd>Z</kbd>
revert a whole stroke.

Runs on `https://app.superannotate.com/editor/*`.

## Updating

Tampermonkey checks for updates automatically. To force one, open the
Tampermonkey dashboard, select the script, and use **Check for userscript
updates** — or just click the install link above again.

## License

MIT — see [LICENSE](LICENSE).

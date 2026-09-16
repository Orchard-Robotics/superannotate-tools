// ==UserScript==
// @name         SuperAnnotate — Paintbrush, Eraser & Fill by Color
// @namespace    superannotate-mods
// @version      0.3.0
// @description  Adds a tool group (Paintbrush, Eraser, Fill by Color) to the editor's left panel and a Tool settings tab to the right panel. Brush and eraser build a stroke by progressively unioning brush stamps, simplified with Ramer-Douglas-Peucker; the brush unions it into overlapping polygons of the selected class, the eraser subtracts it and splits polygons where it cuts across. Fill by Color is a port of GIMP's Select-by-Color: left-click previews, right-click commits. Every action is one undo step.
// @match        https://app.superannotate.com/editor/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * HOW THIS TALKS TO THE APP
 * -------------------------
 * The editor is an Angular 17 production build, so `window.ng` debug utilities
 * are stripped (application_ref.ts:107 guards publishDefaultGlobalUtils with
 * ngDevMode) and DOM `__ngContext__` values are numeric ids into a private
 * registry (context_discovery.ts:182). Neither route reaches the services.
 *
 * What does work, and what this script uses:
 *
 *   1. The bundle is webpack 5 with the chunk global `webpackChunksa_editor_vector`.
 *      Pushing a chunk with a runtime function hands us `__webpack_require__`.
 *   2. Terser did not mangle property/method names, so modules can be located by
 *      scanning factory sources for distinctive string literals.
 *   3. `VectorEditorService` is found via its Clip Mode error message, and its
 *      prototype is patched on `getStepsState` — a method the vector editor
 *      template calls every change-detection cycle — which hands us both the
 *      live service instance and Angular's NgZone (via `Zone.current`).
 *
 * The public surface used on the service (all names verified in the bundle):
 *   objects, getObjectsJson(includeApproval), setObjects(json), addToHistory(),
 *   getDrawClassesId(), getClassById(id), changeTool(toolType), zoomLevel, me
 *
 * Keyboard shortcuts use Shift+<letter>: every bare letter is already bound
 * by the editor, and this script's keydown handler runs on document capture,
 * so a bare letter would shadow the app's own shortcut.
 *
 * Undo: the editor's history is snapshot based (shared-editor.service.ts:852).
 * One addToHistory() call == one undo step, and undo() -> changeHistory() ->
 * setObjects(previousSnapshot) rebuilds every object. So this script mutates
 * nothing during a stroke and calls addToHistory() exactly once on commit.
 */

(function () {
    'use strict';

    // ---------------------------------------------------------------- config

    const LS_KEY = 'sa-paintbrush-settings';

    const DEFAULTS = {
        brushSize: 30,  // diameter, in image pixels
        eraserSize: 30, // diameter, in image pixels
        fillThreshold: 15,          // GIMP's default, 0..255
        fillCriterion: 'composite', // GIMP's GimpSelectCriterion
        fillGap: 0,                 // grow-then-shrink radius, in source pixels
    };

    const BRUSH_MIN = 2;
    const BRUSH_MAX = 400;

    /** Minimum pointer travel (as a fraction of the brush radius) before a new
     *  capsule is stamped. Keeps the progressive union from doing useless work. */
    const RESAMPLE_FRACTION = 0.35;

    /** Destructive-action red, deliberately unlike any class colour. */
    const ERASER_COLOR = '#ff4d4f';

    /** RDP tolerance: scaled off the brush radius, floored so a deep zoom still
     *  removes sub-pixel noise, and capped so big brushes stay recognisable. */
    const SIMPLIFY = { radiusFactor: 0.06, min: 0.3, max: 4 };

    const LOG = (...a) => console.log('%c[sa-paintbrush]', 'color:#7c5cff', ...a);
    const WARN = (...a) => console.warn('[sa-paintbrush]', ...a);

    // ----------------------------------------------------------- app bridge

    const app = {
        req: null,          // __webpack_require__
        svc: null,          // live VectorEditorService instance
        SvcClass: null,
        zone: null,         // Angular NgZone's Zone, for change detection
        pc: null,           // polygon-clipping { union, intersection, ... }
    };

    /**
     * Grab `__webpack_require__` by pushing a no-op chunk. The jsonp callback
     * invokes the third element (the runtime fn) with the require function.
     */
    function getWebpackRequire() {
        const chunks = self.webpackChunksa_editor_vector;
        if (!Array.isArray(chunks)) return null;
        let req = null;
        try {
            chunks.push([['__sa_paintbrush_probe__'], {}, (r) => { req = r; }]);
        } catch (e) {
            WARN('chunk probe failed', e);
        }
        return req;
    }

    /** Find a module id whose factory source contains `marker`. */
    function findModuleId(req, marker) {
        const factories = req && req.m;
        if (!factories) return null;
        for (const id in factories) {
            let src;
            try {
                src = Function.prototype.toString.call(factories[id]);
            } catch (e) {
                continue;
            }
            if (src.indexOf(marker) !== -1) return id;
        }
        return null;
    }

    /** polygon-clipping, borrowed from the app's own bundle (no CDN needed). */
    function loadPolygonClipping(req) {
        // Distinctive literal from polygon-clipping's ring builder.
        const id = findModuleId(req, 'Unable to complete output ring');
        if (id == null) return null;
        let mod;
        try {
            mod = req(id);
        } catch (e) {
            WARN('polygon-clipping require failed', e);
            return null;
        }
        const pc = mod && (mod.union ? mod : mod.default);
        return pc && typeof pc.union === 'function' ? pc : null;
    }

    /**
     * Find VectorEditorService and patch it so we get the live instance.
     * `getStepsState` is defined on SharedEditorService and is called from the
     * vector editor template, so it fires on every change-detection cycle.
     */
    function hookEditorService(req) {
        const id = findModuleId(req, 'There was a problem with Clip Mode');
        if (id == null) return false;

        let mod;
        try {
            mod = req(id);
        } catch (e) {
            WARN('editor service require failed', e);
            return false;
        }

        let Svc = null;
        for (const key of Object.keys(mod || {})) {
            let v;
            try { v = mod[key]; } catch (e) { continue; }
            const p = v && v.prototype;
            if (typeof v === 'function' && p &&
                typeof p.setObjects === 'function' &&
                typeof p.addToHistory === 'function' &&
                typeof p.getObjectsJson === 'function') {
                Svc = v;
                break;
            }
        }
        if (!Svc) return false;
        app.SvcClass = Svc;

        // Walk to the prototype that actually owns getStepsState.
        let proto = Svc.prototype;
        while (proto && !Object.prototype.hasOwnProperty.call(proto, 'getStepsState')) {
            proto = Object.getPrototypeOf(proto);
        }
        if (!proto) return false;
        if (proto.__saPaintbrushHooked) return true;

        const original = proto.getStepsState;
        proto.getStepsState = function patchedGetStepsState() {
            if (app.svc !== this) {
                app.svc = this;
                onServiceReady();
            }
            // Angular runs template expressions inside its own zone, so this is
            // the NgZone we need to re-enter when committing a stroke.
            if (!app.zone && typeof self.Zone !== 'undefined' && self.Zone.current) {
                app.zone = self.Zone.current;
            }
            return original.apply(this, arguments);
        };
        proto.__saPaintbrushHooked = true;
        return true;
    }

    /** Run `fn` inside Angular's zone so change detection picks up the result. */
    function inNgZone(fn) {
        if (app.zone && typeof app.zone.run === 'function') {
            return app.zone.run(fn);
        }
        return fn();
    }

    // ------------------------------------------------------------- geometry

    const round2 = (n) => Math.round(n * 100) / 100;

    /** Perpendicular distance squared from p to segment a-b. */
    function sqSegDist(p, a, b) {
        let x = a[0], y = a[1];
        let dx = b[0] - x, dy = b[1] - y;
        if (dx !== 0 || dy !== 0) {
            const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
            if (t > 1) { x = b[0]; y = b[1]; }
            else if (t > 0) { x += dx * t; y += dy * t; }
        }
        dx = p[0] - x;
        dy = p[1] - y;
        return dx * dx + dy * dy;
    }

    /** Ramer-Douglas-Peucker, iterative (no recursion depth limit). */
    function rdp(points, epsilon) {
        const n = points.length;
        if (n < 3) return points.slice();
        const sqEps = epsilon * epsilon;
        const keep = new Uint8Array(n);
        keep[0] = keep[n - 1] = 1;

        const stack = [[0, n - 1]];
        while (stack.length) {
            const [first, last] = stack.pop();
            let maxDist = 0;
            let index = -1;
            for (let i = first + 1; i < last; i++) {
                const d = sqSegDist(points[i], points[first], points[last]);
                if (d > maxDist) { maxDist = d; index = i; }
            }
            if (index !== -1 && maxDist > sqEps) {
                keep[index] = 1;
                stack.push([first, index], [index, last]);
            }
        }

        const out = [];
        for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
        return out;
    }

    /** Ensure a ring repeats its first vertex at the end. */
    function closeRing(ring) {
        if (ring.length < 2) return ring.slice();
        const a = ring[0], b = ring[ring.length - 1];
        return (a[0] === b[0] && a[1] === b[1]) ? ring.slice() : ring.concat([[a[0], a[1]]]);
    }

    /** Shoelace area of a closed ring, unsigned. */
    function ringArea(ring) {
        let total = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            total += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        return Math.abs(total / 2);
    }

    /**
     * Simplify a closed ring. Returns null when the ring collapses below a
     * triangle, so the caller can decide: an outer ring falls back to the
     * original, a hole is dropped.
     */
    function simplifyRing(inputRing, epsilon) {
        const ring = closeRing(inputRing);
        const open = ring.slice(0, ring.length - 1);
        if (open.length < 3) return null;
        if (open.length === 3) return ring.slice();
        const simplified = rdp(open, epsilon);
        if (simplified.length < 3) return null;
        return simplified.concat([[simplified[0][0], simplified[0][1]]]);
    }

    /** Perimeter of a closed ring. */
    function ringPerimeter(ring) {
        let total = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            total += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
        }
        return total;
    }

    /**
     * Half the average width of a ring (area / perimeter). Below this a shape is
     * a hairline: invisible on screen, but it can still carry enough AREA to
     * pass an area-only filter — a 200x0.2px strip left behind by an erase has
     * area 40. Measured values: that strip 0.10, a genuine 2px-wide annotation
     * 0.98, a 200x200 square 50. 0.25 (= half a pixel wide) sits safely between
     * "no human drew this" and anything legitimate.
     */
    const MIN_HALF_WIDTH = 0.25;

    /** Is this ring too small or too thin to be a real annotation? */
    function isDegenerateRing(ring, minArea) {
        if (ring.length - 1 < 3) return true;
        const area = ringArea(ring);
        if (area < minArea) return true;
        const perimeter = ringPerimeter(ring);
        return perimeter > 0 && area / perimeter < MIN_HALF_WIDTH;
    }

    /**
     * Anything smaller than this is stroke noise rather than an annotation.
     * Mirrors the editor's own clip mode, which drops sub-unit slivers
     * (cutter.ts:81 filters the difference result on area > 1).
     */
    function minAreaFor(epsilon) {
        return Math.max(1, epsilon * epsilon * 4);
    }

    /**
     * Drop degenerate rings and sub-threshold pieces WITHOUT running RDP.
     *
     * The eraser needs this rather than simplifyMultiPolygon: the stroke is
     * already simplified before the subtraction, so the cut edge is smooth, and
     * re-simplifying the whole remainder would also chew up the untouched parts
     * of a carefully drawn polygon.
     */
    function pruneMultiPolygon(mp, epsilon) {
        const minArea = minAreaFor(epsilon);
        const out = [];

        for (const poly of mp) {
            if (!poly.length) continue;
            const outer = closeRing(poly[0]);
            if (isDegenerateRing(outer, minArea)) continue;

            const rings = [outer];
            for (let i = 1; i < poly.length; i++) {
                const hole = closeRing(poly[i]);
                if (isDegenerateRing(hole, minArea)) continue;
                rings.push(hole);
            }
            out.push(rings);
        }
        return out;
    }

    function simplifyMultiPolygon(mp, epsilon) {
        const minArea = minAreaFor(epsilon);
        const out = [];

        for (const poly of mp) {
            if (!poly.length) continue;

            // Outer ring: prefer the simplified form, fall back to the original
            // rather than throwing the polygon away.
            const outer = simplifyRing(poly[0], epsilon) || closeRing(poly[0]);
            if (isDegenerateRing(outer, minArea)) continue;

            const rings = [outer];
            for (let i = 1; i < poly.length; i++) {
                const hole = simplifyRing(poly[i], epsilon);
                if (!hole) continue;                          // collapsed -> drop
                if (isDegenerateRing(hole, minArea)) continue; // noise -> drop
                rings.push(hole);
            }
            out.push(rings);
        }
        return out;
    }

    /** Circle approximated as an N-gon, N scaled to the radius. */
    function circleSegments(radius) {
        return Math.max(12, Math.min(48, Math.round(radius * 1.6) + 10));
    }

    /** A capsule (stadium) ring covering the swept disc from a to b. */
    function capsuleRing(ax, ay, bx, by, r) {
        const segs = circleSegments(r);
        const dx = bx - ax, dy = by - ay;
        const ring = [];

        if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
            for (let i = 0; i < segs; i++) {
                const t = (i / segs) * Math.PI * 2;
                ring.push([ax + Math.cos(t) * r, ay + Math.sin(t) * r]);
            }
            ring.push(ring[0].slice());
            return ring;
        }

        const ang = Math.atan2(dy, dx);
        // Must be even, otherwise the sweep steps straight over the cap's apex
        // and the stroke ends up narrower than the nominal brush size.
        const half = Math.max(4, Math.round(segs / 2) + (Math.round(segs / 2) % 2));

        // Cap around b, sweeping from ang-PI/2 to ang+PI/2.
        for (let i = 0; i <= half; i++) {
            const t = ang - Math.PI / 2 + (i / half) * Math.PI;
            ring.push([bx + Math.cos(t) * r, by + Math.sin(t) * r]);
        }
        // Cap around a, sweeping the other side.
        for (let i = 0; i <= half; i++) {
            const t = ang + Math.PI / 2 + (i / half) * Math.PI;
            ring.push([ax + Math.cos(t) * r, ay + Math.sin(t) * r]);
        }
        ring.push(ring[0].slice());
        return ring;
    }

    function ringBBox(ring, box) {
        for (const [x, y] of ring) {
            if (x < box.minX) box.minX = x;
            if (x > box.maxX) box.maxX = x;
            if (y < box.minY) box.minY = y;
            if (y > box.maxY) box.maxY = y;
        }
        return box;
    }

    function multiPolygonBBox(mp) {
        const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        for (const poly of mp) ringBBox(poly[0], box);
        return box;
    }

    function boxesOverlap(a, b, pad) {
        pad = pad || 0;
        return !(a.minX > b.maxX + pad || a.maxX < b.minX - pad ||
                 a.minY > b.maxY + pad || a.maxY < b.minY - pad);
    }

    /** Editor flat [x,y,x,y,...] -> closed ring [[x,y],...]. */
    function pointsToRing(points) {
        const ring = [];
        for (let i = 0; i + 1 < points.length; i += 2) ring.push([points[i], points[i + 1]]);
        if (!ring.length) return ring;
        const first = ring[0], last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
        return ring;
    }

    /** Closed ring -> editor flat [x,y,...] with the closing vertex dropped. */
    function ringToPoints(inputRing) {
        const ring = closeRing(inputRing);
        const out = [];
        for (let i = 0; i < ring.length - 1; i++) {
            out.push(round2(ring[i][0]), round2(ring[i][1]));
        }
        return out;
    }

    /** EditorPolygon -> polygon-clipping Polygon: [outer, ...holes]. */
    function editorPolygonToGeom(obj) {
        const rings = [pointsToRing(obj.points)];
        if (obj.exclude && obj.exclude.length) {
            for (const hole of obj.exclude) {
                const r = pointsToRing(hole.points || hole);
                if (r.length >= 4) rings.push(r);
            }
        }
        return rings;
    }

    function uuidv4() {
        if (self.crypto && self.crypto.randomUUID) return self.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
    }

    // ------------------------------------------------- colour selection (raster)

    /*
     * Ported from GIMP's Select-by-Color (app/tools/gimpbycolorselecttool.c ->
     * gimp_pickable_contiguous_region_by_color). Two things matter for fidelity:
     *
     *  - it is BY COLOUR, not by seed: every pixel in the image within the
     *    threshold of the clicked colour matches, contiguous or not.
     *  - the threshold slider is 0..255 but the comparison happens on
     *    normalised 0..1 channels ("options->threshold / 255.0"), and a pixel
     *    is IN when `max <= threshold`.
     */

    const SELECT_CRITERIA = [
        { value: 'composite', label: 'Composite' },
        { value: 'red', label: 'Red' },
        { value: 'green', label: 'Green' },
        { value: 'blue', label: 'Blue' },
        { value: 'hue', label: 'HSV Hue' },
        { value: 'saturation', label: 'HSV Saturation' },
        { value: 'value', label: 'HSV Value' },
    ];

    /** GIMP's EPSILON guard on the HSV hue comparison. */
    const HSV_EPSILON = 1e-6;

    /** r,g,b in 0..255 -> h,s,v in 0..1. */
    function rgbToHsv(r, g, b, out) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;

        let h = 0;
        if (d !== 0) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h /= 6;
            if (h < 0) h += 1;
        }
        out[0] = h;
        out[1] = max === 0 ? 0 : d / max;
        out[2] = max;
        return out;
    }

    /**
     * GIMP's pixel_difference, on normalised 0..1 channels.
     *
     * HSV_HUE is the subtle one: when either colour is unsaturated GIMP returns
     * 10.0 - an effectively infinite difference - so greys never match by hue,
     * whatever the threshold. Hue also wraps: MIN(d, 1 - d).
     */
    function pixelDifference(criterion, a, b, aHsv, bHsv) {
        switch (criterion) {
            case 'red':   return Math.abs(a[0] - b[0]) / 255;
            case 'green': return Math.abs(a[1] - b[1]) / 255;
            case 'blue':  return Math.abs(a[2] - b[2]) / 255;
            case 'hue': {
                if (aHsv[1] <= HSV_EPSILON || bHsv[1] <= HSV_EPSILON) return 10;
                const d = Math.abs(aHsv[0] - bHsv[0]);
                return Math.min(d, 1 - d);
            }
            case 'saturation': return Math.abs(aHsv[1] - bHsv[1]);
            case 'value':      return Math.abs(aHsv[2] - bHsv[2]);
            case 'composite':
            default: {
                const dr = Math.abs(a[0] - b[0]);
                const dg = Math.abs(a[1] - b[1]);
                const db = Math.abs(a[2] - b[2]);
                return Math.max(dr, Math.max(dg, db)) / 255;
            }
        }
    }

    /**
     * Every pixel within `threshold` (0..255) of `seed` under `criterion`.
     * Returns a Uint8Array mask of width*height.
     */
    function buildColorMask(bitmap, seed, threshold, criterion) {
        const { width, height, data } = bitmap;
        const mask = new Uint8Array(width * height);
        const limit = threshold / 255;

        const seedHsv = rgbToHsv(seed[0], seed[1], seed[2], [0, 0, 0]);
        const px = [0, 0, 0];
        const pxHsv = [0, 0, 0];
        const needsHsv = criterion === 'hue' || criterion === 'saturation' || criterion === 'value';

        for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
            px[0] = data[p]; px[1] = data[p + 1]; px[2] = data[p + 2];
            if (needsHsv) rgbToHsv(px[0], px[1], px[2], pxHsv);
            if (pixelDifference(criterion, px, seed, pxHsv, seedHsv) <= limit) mask[i] = 1;
        }
        return mask;
    }

    /*
     * Grow / shrink, after GIMP's gimpoperationgrow.c.
     *
     * GIMP's structuring element is an ellipse, built per column as
     *     circ[i] = RINT (yradius / xradius * sqrt (SQR (xradius) - SQR (tmp)))
     * which for equal radii is a disk. Applying it directly costs O(W*H*r), too
     * slow to re-run on every drag of a slider, so we get the same disk from an
     * exact Euclidean distance transform instead: grow is "within r of a set
     * pixel", shrink is "further than r from a clear pixel". That is O(W*H) for
     * any radius.
     *
     * The one deviation from GIMP: its RINT rounds the ellipse outward at some
     * offsets, so its kernel is up to a pixel fatter than a true circle. We use
     * the exact circle, d^2 <= r^2.
     *
     * Edges are handled by REPLICATE padding rather than by GIMP's zero-pad,
     * because a closing needs both halves to agree about what lies outside:
     *
     *   - zero-padding everywhere pulls a region that is flush with the image
     *     border back from it by r, which is visible and wrong;
     *   - treating out of bounds as set ("edge lock") is worse - once a dilated
     *     mask reaches the border there are no clear pixels left to erode
     *     against, so a blob merely NEAR the edge gets sucked out to it.
     *
     * Replicating the border pixels gives the right answer in both cases: a
     * flush region stays flush, an interior blob is restored exactly. The pad
     * is 2r wide, because eroding an original pixel reads dilated values up to
     * r away, and those in turn read source pixels up to r beyond that.
     */

    /** Copy `mask` into a (w+2*pad) x (h+2*pad) buffer, replicating the edges. */
    function padMaskReplicate(mask, width, height, pad) {
        const pw = width + 2 * pad;
        const ph = height + 2 * pad;
        const out = new Uint8Array(pw * ph);
        for (let y = 0; y < ph; y++) {
            const sy = Math.min(height - 1, Math.max(0, y - pad));
            const srcRow = sy * width;
            const dstRow = y * pw;
            for (let x = 0; x < pw; x++) {
                const sx = Math.min(width - 1, Math.max(0, x - pad));
                out[dstRow + x] = mask[srcRow + sx];
            }
        }
        return { mask: out, width: pw, height: ph };
    }

    /** Inverse of padMaskReplicate. */
    function cropMask(mask, width, height, pad, outWidth, outHeight) {
        const out = new Uint8Array(outWidth * outHeight);
        for (let y = 0; y < outHeight; y++) {
            const srcRow = (y + pad) * width + pad;
            out.set(mask.subarray(srcRow, srcRow + outWidth), y * outWidth);
        }
        return out;
    }

    /**
     * Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
     * `seed[i] === seedValue` marks a source; every other cell gets the squared
     * distance to the nearest source. Runs one 1-D pass down the columns, then
     * one across the rows.
     */
    function squaredDistanceTransform(seed, width, height, seedValue) {
        const INF = 1e20;
        const grid = new Float64Array(width * height);
        for (let i = 0; i < grid.length; i++) grid[i] = seed[i] === seedValue ? 0 : INF;

        const n = Math.max(width, height);
        const f = new Float64Array(n);
        const d = new Float64Array(n);
        const v = new Int32Array(n);
        const z = new Float64Array(n + 1);

        // 1-D lower envelope of parabolas, in place over f[0..len)
        const pass = (len) => {
            let k = 0;
            v[0] = 0;
            z[0] = -INF;
            z[1] = INF;
            for (let q = 1; q < len; q++) {
                let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
                while (s <= z[k]) {
                    k--;
                    s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
                }
                k++;
                v[k] = q;
                z[k] = s;
                z[k + 1] = INF;
            }
            k = 0;
            for (let q = 0; q < len; q++) {
                while (z[k + 1] < q) k++;
                const dq = q - v[k];
                d[q] = dq * dq + f[v[k]];
            }
        };

        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
            pass(height);
            for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
        }
        for (let y = 0; y < height; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) f[x] = grid[row + x];
            pass(width);
            for (let x = 0; x < width; x++) grid[row + x] = d[x];
        }
        return grid;
    }

    /** Dilate by a disk of `radius` pixels. */
    function growMask(mask, width, height, rawRadius) {
        const radius = Math.max(0, Math.round(rawRadius) || 0);
        if (radius <= 0) return mask;
        const dist = squaredDistanceTransform(mask, width, height, 1);
        const rr = radius * radius;
        const out = new Uint8Array(mask.length);
        for (let i = 0; i < out.length; i++) out[i] = dist[i] <= rr ? 1 : 0;
        return out;
    }

    /** Erode by a disk of `radius` pixels. */
    function shrinkMask(mask, width, height, rawRadius) {
        const radius = Math.max(0, Math.round(rawRadius) || 0);
        if (radius <= 0) return mask;
        const dist = squaredDistanceTransform(mask, width, height, 0);
        const rr = radius * radius;
        const out = new Uint8Array(mask.length);
        for (let i = 0; i < out.length; i++) out[i] = mask[i] === 1 && dist[i] > rr ? 1 : 0;
        return out;
    }

    /**
     * Morphological closing: grow then shrink by the same radius. Bridges gaps
     * and fills pinholes up to about 2*radius across, while leaving the outline
     * of anything larger where it was.
     */
    function closeMaskGaps(mask, width, height, rawRadius) {
        // A pixel count: anything fractional would give padMaskReplicate a
        // fractional buffer length, which TypedArray rejects outright.
        const radius = Math.max(0, Math.round(rawRadius) || 0);
        if (radius <= 0) return mask;
        const pad = 2 * radius;
        const p = padMaskReplicate(mask, width, height, pad);
        const grown = growMask(p.mask, p.width, p.height, radius);
        const shrunk = shrinkMask(grown, p.width, p.height, radius);
        return cropMask(shrunk, p.width, p.height, pad, width, height);
    }

    /*
     * Raster mask -> closed rings, by following pixel "cracks".
     *
     * For every selected pixel, each side facing an unselected pixel becomes one
     * directed unit edge on the lattice of pixel corners, oriented so the
     * selected side is always on the edge's right (y points down). Linking those
     * edges head-to-tail yields closed rings; with this orientation an outer
     * boundary has positive shoelace area and a hole negative.
     *
     * Directions index into DIRS: 0=+x 1=+y 2=-x 3=-y, so a 90 degree turn is
     * (d+1)%4 and a lattice point holds at most one outgoing edge per direction
     * - the whole edge set fits in a Map of 4-bit masks.
     */
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

    function traceMaskRings(mask, width, height) {
        const stride = width + 1;
        const out = new Map(); // latticeKey -> bitmask of outgoing directions

        const add = (x, y, dir) => {
            const k = y * stride + x;
            out.set(k, (out.get(k) || 0) | (1 << dir));
        };
        const inside = (x, y) =>
            x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (mask[y * width + x] !== 1) continue;
                if (!inside(x, y - 1)) add(x, y, 0);          // top:    ->  +x
                if (!inside(x + 1, y)) add(x + 1, y, 1);      // right:  ->  +y
                if (!inside(x, y + 1)) add(x + 1, y + 1, 2);  // bottom: ->  -x
                if (!inside(x - 1, y)) add(x, y + 1, 3);      // left:   ->  -y
            }
        }

        const rings = [];
        const keys = Array.from(out.keys()).sort((a, b) => a - b);
        const limit = width * height * 4 + 16;

        for (const startKey of keys) {
            const sx = startKey % stride;
            const sy = (startKey - sx) / stride;

            for (;;) {
                const startBits = out.get(startKey) || 0;
                if (!startBits) break;

                let dir = 31 - Math.clz32(startBits & -startBits); // lowest set bit
                let x = sx;
                let y = sy;
                const ring = [];
                let guard = 0;

                for (;;) {
                    const k = y * stride + x;
                    const bits = out.get(k) || 0;
                    if (!(bits & (1 << dir))) break;      // already walked
                    out.set(k, bits & ~(1 << dir));

                    ring.push([x, y]);
                    x += DIRS[dir][0];
                    y += DIRS[dir][1];
                    if (x === sx && y === sy) break;       // closed

                    // Preferring a (d+1)%4 turn keeps the foreground
                    // 4-connected: where two diagonal blobs meet at one lattice
                    // point it closes the current blob rather than hopping
                    // across into the other one.
                    const nextBits = out.get(y * stride + x) || 0;
                    const order = [(dir + 1) % 4, dir, (dir + 3) % 4, (dir + 2) % 4];
                    let chosen = -1;
                    for (const cand of order) {
                        if (nextBits & (1 << cand)) { chosen = cand; break; }
                    }
                    if (chosen === -1) break;              // open chain: bail
                    dir = chosen;
                    if (++guard > limit) break;            // never spin
                }

                if (ring.length >= 4) rings.push(compressRing(ring));
            }
        }
        return rings;
    }

    /** Collapse runs of collinear unit steps into single segments, then close. */
    function compressRing(ring) {
        const out = [];
        const n = ring.length;
        for (let i = 0; i < n; i++) {
            const prev = ring[(i - 1 + n) % n];
            const cur = ring[i];
            const next = ring[(i + 1) % n];
            const ax = cur[0] - prev[0], ay = cur[1] - prev[1];
            const bx = next[0] - cur[0], by = next[1] - cur[1];
            if (ax * by - ay * bx !== 0) out.push(cur);    // keep only corners
        }
        if (out.length < 3) return ring.concat([[ring[0][0], ring[0][1]]]);
        return out.concat([[out[0][0], out[0][1]]]);
    }

    /** Signed shoelace area: positive for an outer ring under our orientation. */
    function signedRingArea(ring) {
        let total = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            total += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        return total / 2;
    }

    /** Even-odd point-in-ring test. */
    function pointInRing(pt, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if ((yi > pt[1]) !== (yj > pt[1]) &&
                pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }

    /**
     * Sort traced rings into polygons, nesting each hole inside the smallest
     * outer ring that contains it.
     */
    function ringsToPolygons(rings) {
        const outers = [];
        const holes = [];
        for (const ring of rings) {
            const area = signedRingArea(ring);
            if (area > 0) outers.push({ ring, area });
            else if (area < 0) holes.push(ring);
        }
        outers.sort((a, b) => a.area - b.area);   // smallest first

        const polys = outers.map((o) => [o.ring]);
        for (const hole of holes) {
            const probe = hole[0];
            for (let i = 0; i < outers.length; i++) {
                if (pointInRing(probe, outers[i].ring)) { polys[i].push(hole); break; }
            }
        }
        return polys;
    }

    /** Bitmap-pixel lattice coordinates -> annotation coordinates. */
    function scalePolygons(polys, sx, sy) {
        return polys.map((poly) => poly.map((ring) => ring.map((p) => [p[0] * sx, p[1] * sy])));
    }

    /** Seed colour + settings -> polygons in annotation coordinates. */
    function colorSelectPolygons(bitmap, seed, threshold, criterion, gap, epsilon, scaleX, scaleY) {
        let mask = buildColorMask(bitmap, seed, threshold, criterion);
        // Close gaps BEFORE tracing, so the vector outline already reflects the
        // bridged shape rather than being patched up afterwards.
        mask = closeMaskGaps(mask, bitmap.width, bitmap.height, gap);
        const rings = traceMaskRings(mask, bitmap.width, bitmap.height);
        const polys = scalePolygons(ringsToPolygons(rings), scaleX, scaleY);
        return simplifyMultiPolygon(polys, epsilon);
    }

    // -------------------------------------------------------------- settings

    const settings = Object.assign({}, DEFAULTS, readSettings());

    function readSettings() {
        try {
            return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(settings));
        } catch (e) { /* private mode */ }
    }

    // ------------------------------------------------------------ tool model

    const TOOLS = [
        {
            id: 'paintbrush',
            name: 'Paintbrush',
            shortcut: 'Shift+B',
            kind: 'stroke',
            mode: 'add',
            sizeKey: 'brushSize',
            icon: '<path d="M7.5 14.5c-1.6 0-2.9 1.3-2.9 2.9 0 1.3-1.1 1.7-1.6 1.8 1 1.1 2.4 1.8 4 1.8 2.2 0 4-1.8 4-4 0-1.4-1.1-2.5-2.5-2.5z"/>'
                + '<path d="M20.7 4.3a2 2 0 0 0-2.8 0l-7.5 8.1c-.3.3-.3.4-.1.6l1.6 1.6c.2.2.3.2.6-.1l8.1-7.5a2 2 0 0 0 .1-2.7z"/>',
            settings: ['brushSize'],
        },
        {
            id: 'eraser',
            name: 'Eraser',
            shortcut: 'Shift+E',
            kind: 'stroke',
            mode: 'subtract',
            sizeKey: 'eraserSize',
            icon: '<path d="M8.6 20H5.4l-2-2a2.1 2.1 0 0 1 0-3l8.4-8.4a2.1 2.1 0 0 1 3 0l4.2 4.2a2.1 2.1 0 0 1 0 3L12.6 20zm-2.4-2h1.6l4.1-4.1-4.2-4.2-3.7 3.7a.6.6 0 0 0 0 .9z"/>'
                + '<path d="M13 20h7v2h-7z"/>',
            settings: ['eraserSize'],
        },
        {
            id: 'fillByColor',
            name: 'Fill by Color',
            shortcut: 'Shift+F',
            kind: 'pick',
            icon: '<path d="M11.1 3.5 9.7 4.9l1.7 1.7-6.1 6.1a1.8 1.8 0 0 0 0 2.5l3.9 3.9a1.8 1.8 0 0 0 2.5 0l6.1-6.1a1.8 1.8 0 0 0 0-2.5L11.1 3.5zm1.7 4.5 3.9 3.9H8.9l3.9-3.9z"/>'
                + '<path d="M19.5 15.2s-1.8 2-1.8 3a1.8 1.8 0 1 0 3.6 0c0-1-1.8-3-1.8-3z"/>',
            settings: ['fillCriterion', 'fillThreshold', 'fillGap'],
        },
    ];

    const toolById = (id) => TOOLS.find((t) => t.id === id) || null;
    const isStrokeTool = (id) => { const t = toolById(id); return !!t && t.kind === 'stroke'; };
    const isPickTool = (id) => { const t = toolById(id); return !!t && t.kind === 'pick'; };
    const activeTool = () => toolById(state.activeToolId);

    /** Radius, in image pixels, of whichever stroke tool is active. */
    function activeStrokeRadius() {
        const tool = activeTool();
        if (!tool || !tool.sizeKey) return 0;
        return (settings[tool.sizeKey] || DEFAULTS[tool.sizeKey]) / 2;
    }

    /** Every stroke tool's size control is the same shape. */
    function sizeSetting(key, label) {
        return {
            label,
            unit: 'px',
            min: BRUSH_MIN,
            max: BRUSH_MAX,
            step: 1,
            get: () => settings[key],
            set: (v) => {
                const n = Number(v);
                settings[key] = Number.isFinite(n)
                    ? Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, Math.round(n)))
                    : DEFAULTS[key];
                saveSettings();
            },
        };
    }

    const SETTING_DEFS = {
        brushSize: sizeSetting('brushSize', 'Brush size'),
        eraserSize: sizeSetting('eraserSize', 'Eraser size'),
        fillThreshold: {
            type: 'range',
            label: 'Threshold',
            unit: '0-255',
            min: 0,
            max: 255,
            step: 1,
            get: () => settings.fillThreshold,
            set: (v) => {
                const n = Number(v);
                settings.fillThreshold = Number.isFinite(n)
                    ? Math.max(0, Math.min(255, Math.round(n)))
                    : DEFAULTS.fillThreshold;
                saveSettings();
            },
        },
        fillGap: {
            type: 'range',
            label: 'Fill Gap Threshold',
            unit: 'px',
            min: 0,
            max: 40,
            step: 1,
            get: () => settings.fillGap,
            set: (v) => {
                const n = Number(v);
                settings.fillGap = Number.isFinite(n)
                    ? Math.max(0, Math.min(40, Math.round(n)))
                    : DEFAULTS.fillGap;
                saveSettings();
            },
        },
        fillCriterion: {
            type: 'select',
            label: 'Select by',
            options: SELECT_CRITERIA,
            get: () => settings.fillCriterion,
            set: (v) => {
                settings.fillCriterion = SELECT_CRITERIA.some((c) => c.value === v)
                    ? v
                    : DEFAULTS.fillCriterion;
                saveSettings();
            },
        },
    };

    const state = {
        activeToolId: null,
        stroke: null,
        ui: {},
    };

    // --------------------------------------------------------------- styles

    function injectStyles() {
        if (document.getElementById('sa-paintbrush-styles')) return;
        const css = `
        .sa-pb-item { position: relative; }
        .sa-pb-btn {
            width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
            border: none; border-radius: 4px; background: transparent; cursor: pointer;
            color: currentColor; padding: 0;
        }
        .sa-pb-btn:hover { background: rgba(127,127,127,.18); }
        .sa-pb-btn.selected { background: rgba(124,92,255,.18); color: #7c5cff; }
        .sa-pb-btn svg { width: 22px; height: 22px; fill: currentColor; pointer-events: none; }
        .sa-pb-btn.has-menu::after {
            content: ''; position: absolute; right: 4px; bottom: 4px;
            border: 3px solid transparent; border-right-color: currentColor; border-bottom-color: currentColor;
            opacity: .55;
        }
        .sa-pb-menu {
            position: fixed; z-index: 100000; width: 242px; padding: 8px; border-radius: 8px;
            background: var(--sn-color-bg-elevated, #23252b); color: var(--sn-color-text, #e8e8ea);
            box-shadow: 0 8px 24px rgba(0,0,0,.35); font-size: 13px;
        }
        .sa-pb-menu-item {
            display: flex; align-items: center; justify-content: space-between;
            padding: 6px 8px; border-radius: 4px; cursor: pointer;
        }
        .sa-pb-menu-item:hover { background: rgba(127,127,127,.18); }
        .sa-pb-menu-item.selected { background: rgba(124,92,255,.18); }
        .sa-pb-menu-item .sa-pb-menu-info { display: flex; align-items: center; gap: 8px; }
        .sa-pb-menu-item svg { width: 24px; height: 24px; fill: currentColor; }
        .sa-pb-menu-item kbd {
            font: inherit; font-size: 11px; padding: 1px 6px; border-radius: 3px;
            background: rgba(127,127,127,.22); opacity: .8;
        }
        .sa-pb-settings {
            flex: 1; min-height: 0; overflow-y: auto; padding: 16px;
            font-size: 13px; color: var(--sn-color-text, inherit);
        }
        .sa-pb-settings h4 { margin: 0 0 14px; font-size: 13px; font-weight: 600; opacity: .85; }
        .sa-pb-field { margin-bottom: 18px; }
        .sa-pb-field-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .sa-pb-field-head label { opacity: .8; }
        .sa-pb-field-row { display: flex; align-items: center; gap: 10px; }
        .sa-pb-field-row input[type=range] { flex: 1; accent-color: #7c5cff; }
        .sa-pb-field-row select {
            flex: 1; padding: 5px 6px; border-radius: 4px;
            border: 1px solid rgba(127,127,127,.4);
            background: var(--sn-color-bg-elevated, rgba(127,127,127,.12)); color: inherit;
        }
        .sa-pb-note {
            margin-top: 4px; padding: 8px 10px; border-radius: 4px; line-height: 1.45;
            background: rgba(127,127,127,.12); opacity: .85; font-size: 12px;
        }
        .sa-pb-field-row input[type=number] {
            width: 68px; padding: 4px 6px; border-radius: 4px;
            border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit;
        }
        .sa-pb-empty { opacity: .6; font-style: italic; }
        .sa-pb-hidden-body { display: none !important; }
        `;
        const el = document.createElement('style');
        el.id = 'sa-paintbrush-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    function svgIcon(paths, size) {
        return `<svg viewBox="0 0 24 24" width="${size || 22}" height="${size || 22}" aria-hidden="true">${paths}</svg>`;
    }

    // ------------------------------------------------------------ left panel

    function ensureLeftPanelItem() {
        const section = document.querySelector('.left-panel-container .top-section');
        if (!section) return;
        if (section.querySelector('.sa-pb-item')) return;

        const tool = TOOLS[0];

        const wrap = document.createElement('div');
        // Borrow the app's own container class so padding/border match, and carry
        // the Angular emulated-encapsulation attribute from a sibling so the
        // component-scoped CSS applies to us too.
        wrap.className = 'left-panel-item-container sa-pb-item';
        const sibling = section.querySelector('left-panel-item .left-panel-item-container');
        if (sibling) {
            for (const attr of sibling.attributes) {
                if (attr.name.startsWith('_ngcontent')) wrap.setAttribute(attr.name, '');
            }
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sa-pb-btn has-menu';
        btn.title = 'Paintbrush  (right-click or click-and-hold for more tools)';
        btn.setAttribute('data-qa-id', 'sa-paintbrush-tool');
        btn.innerHTML = svgIcon(tool.icon);

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (consumeSuppressedClick()) return;
            activateTool(state.lastPickedId || TOOLS[0].id);
        });
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openNestedMenu(btn);
        });
        attachLongPress(btn, () => openNestedMenu(btn));

        wrap.appendChild(btn);
        section.appendChild(wrap);
        state.ui.leftButton = btn;
        syncLeftPanel();
    }

    /**
     * Port of the app's own MouseLongPressDirective (long-press.directive.ts):
     * left button only, 500ms, cancelled by a *window* mouseup with the left
     * button. Notably it is NOT cancelled by movement, so the app lets you press,
     * hold, slide onto a menu item and release to pick it - which is why the
     * nested menu items listen for `mouseup` rather than `click`.
     */
    const LONG_PRESS_MS = 500;

    function attachLongPress(el, handler) {
        let timer = 0;

        function onWindowUp(e) {
            if (e.button) return;
            cancel();
        }

        function cancel() {
            if (timer) { clearTimeout(timer); timer = 0; }
            window.removeEventListener('mouseup', onWindowUp, true);
        }

        /**
         * The press is still held when the menu opens, so a click is coming on
         * release and must not also toggle the tool. Clear the flag on the next
         * macrotask after that release: the browser dispatches click
         * synchronously after mouseup, so the click sees the flag set, and
         * nothing later can inherit it.
         *
         * This has to be driven by mouseup rather than by the click itself -
         * releasing over a nested menu item fires mouseup on the item and no
         * click on `el` at all, which would otherwise leave the flag stuck and
         * swallow the next legitimate click.
         */
        function armClickSuppression() {
            state.suppressNextClick = true;
            window.addEventListener('mouseup', disarmAfterRelease, true);
        }

        function disarmAfterRelease(e) {
            if (e.button) return;
            window.removeEventListener('mouseup', disarmAfterRelease, true);
            setTimeout(() => { state.suppressNextClick = false; }, 0);
        }

        el.addEventListener('mousedown', (e) => {
            if (e.button) return;                 // left button only
            cancel();
            window.addEventListener('mouseup', onWindowUp, true);
            timer = setTimeout(() => {
                timer = 0;
                window.removeEventListener('mouseup', onWindowUp, true);
                armClickSuppression();
                handler(e);
            }, LONG_PRESS_MS);
        });
    }

    /** True once, if a long press just fired and its trailing click should die. */
    function consumeSuppressedClick() {
        if (!state.suppressNextClick) return false;
        state.suppressNextClick = false;
        return true;
    }

    function openNestedMenu(anchor) {
        closeNestedMenu();
        const rect = anchor.getBoundingClientRect();

        const menu = document.createElement('div');
        menu.className = 'sa-pb-menu';
        menu.setAttribute('data-qa-id', 'sa-paintbrush-nested-tools-menu');

        for (const tool of TOOLS) {
            const item = document.createElement('div');
            item.className = 'sa-pb-menu-item' + (state.activeToolId === tool.id ? ' selected' : '');
            item.setAttribute('data-qa-id', tool.id);
            item.innerHTML =
                `<div class="sa-pb-menu-info">${svgIcon(tool.icon, 24)}<span>${tool.name}</span></div>` +
                (tool.shortcut ? `<kbd>${tool.shortcut}</kbd>` : '');
            item.addEventListener('mouseup', (e) => {
                e.stopPropagation();
                closeNestedMenu();
                activateTool(tool.id);
            });
            menu.appendChild(item);
        }

        document.body.appendChild(menu);

        // Prefer the right of the anchor (left panel), flip to the left when
        // that would overflow (right panel tab), and clamp vertically.
        const gap = 8;
        let left = rect.right + gap;
        if (left + menu.offsetWidth > window.innerWidth - gap) {
            left = rect.left - menu.offsetWidth - gap;
        }
        menu.style.left = Math.round(Math.max(gap, left)) + 'px';
        menu.style.top = Math.round(
            Math.max(gap, Math.min(rect.top, window.innerHeight - menu.offsetHeight - gap))
        ) + 'px';

        state.ui.menu = menu;
        setTimeout(() => {
            document.addEventListener('mousedown', closeNestedMenuOnOutside, true);
        }, 0);
    }

    function closeNestedMenuOnOutside(e) {
        if (state.ui.menu && !state.ui.menu.contains(e.target)) closeNestedMenu();
    }

    function closeNestedMenu() {
        if (state.ui.menu) {
            state.ui.menu.remove();
            state.ui.menu = null;
        }
        document.removeEventListener('mousedown', closeNestedMenuOnOutside, true);
    }

    function syncLeftPanel() {
        const btn = state.ui.leftButton;
        if (!btn) return;
        const active = TOOLS.find((t) => t.id === state.activeToolId);
        btn.classList.toggle('selected', !!active);
        if (active) btn.innerHTML = svgIcon(active.icon);
    }

    // ----------------------------------------------------------- right panel

    function ensureRightPanelTab() {
        const labels = document.querySelector('.right-panel-wrapper .sn-tab-labels');
        const body = document.querySelector('.right-panel-wrapper .sn-tab-body');
        if (!labels || !body) return;
        if (labels.querySelector('.sa-pb-tab')) return;

        // Clone a native label so every Angular-scoped class/attribute is kept.
        const native = labels.querySelector('.sn-tab-label');
        let tab;
        if (native) {
            tab = native.cloneNode(true);
            tab.classList.remove('sn-tab-label-active');
            tab.removeAttribute('id');
            tab.removeAttribute('aria-posinset');
            tab.removeAttribute('aria-setsize');
            const text = tab.querySelector('.sn-tab-label-text');
            if (text) text.textContent = 'Tool settings';
            else tab.textContent = 'Tool settings';
            const icon = tab.querySelector('sn-icon');
            if (icon) icon.remove();
        } else {
            tab = document.createElement('div');
            tab.className = 'sn-tab-label';
            tab.setAttribute('role', 'tab');
            tab.textContent = 'Tool settings';
        }
        tab.classList.add('sa-pb-tab');
        tab.setAttribute('data-qa-id', 'sa-paintbrush-settings-tab-header');
        tab.title = 'Tool settings  (right-click or click-and-hold to switch tool)';
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (consumeSuppressedClick()) return;
            openSettingsTab();
        }, true);
        // Same gesture as the left-panel tools: click-and-hold (or right-click)
        // opens the nested tool menu, so the tool can be switched from here too.
        tab.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openNestedMenu(tab);
        });
        attachLongPress(tab, () => openNestedMenu(tab));
        labels.appendChild(tab);

        const panel = document.createElement('div');
        panel.className = 'sa-pb-settings';
        panel.setAttribute('data-qa-id', 'sa-paintbrush-settings');
        panel.style.display = 'none';
        body.parentNode.insertBefore(panel, body.nextSibling);

        // Any click on a native tab hands control back to the app.
        labels.addEventListener('click', (e) => {
            const label = e.target.closest && e.target.closest('.sn-tab-label');
            if (label && !label.classList.contains('sa-pb-tab')) closeSettingsTab();
        }, true);

        state.ui.tab = tab;
        state.ui.settingsPanel = panel;
        state.ui.tabBody = body;
        renderSettings();
    }

    function openSettingsTab() {
        const { tab, settingsPanel, tabBody } = state.ui;
        if (!tab || !settingsPanel || !tabBody) return;
        for (const other of tab.parentNode.querySelectorAll('.sn-tab-label')) {
            other.classList.toggle('sn-tab-label-active', other === tab);
        }
        tabBody.classList.add('sa-pb-hidden-body');
        settingsPanel.style.display = 'flex';
        settingsPanel.style.flexDirection = 'column';
        renderSettings();
    }

    function closeSettingsTab() {
        const { tab, settingsPanel, tabBody } = state.ui;
        if (!tab || !settingsPanel || !tabBody) return;
        tab.classList.remove('sn-tab-label-active');
        tabBody.classList.remove('sa-pb-hidden-body');
        settingsPanel.style.display = 'none';
    }

    function isSettingsTabOpen() {
        return !!(state.ui.tab && state.ui.tab.classList.contains('sn-tab-label-active'));
    }

    function renderSettings() {
        const panel = state.ui.settingsPanel;
        if (!panel) return;

        const tool = TOOLS.find((t) => t.id === state.activeToolId) || TOOLS[0];
        panel.innerHTML = '';

        const title = document.createElement('h4');
        title.textContent = tool.name;
        panel.appendChild(title);

        if (!tool.settings.length) {
            const empty = document.createElement('div');
            empty.className = 'sa-pb-empty';
            empty.textContent = 'This tool has no settings yet.';
            panel.appendChild(empty);
            return;
        }

        for (const key of tool.settings) {
            const def = SETTING_DEFS[key];
            if (!def) continue;

            const field = document.createElement('div');
            field.className = 'sa-pb-field';

            const head = document.createElement('div');
            head.className = 'sa-pb-field-head';
            head.innerHTML = `<label for="sa-pb-${key}">${def.label}</label>` +
                `<span class="sa-pb-unit">${def.unit || ''}</span>`;
            field.appendChild(head);

            const row = document.createElement('div');
            row.className = 'sa-pb-field-row';

            if (def.type === 'select') {
                const select = document.createElement('select');
                select.id = `sa-pb-${key}`;
                for (const opt of def.options) {
                    const o = document.createElement('option');
                    o.value = opt.value;
                    o.textContent = opt.label;
                    select.appendChild(o);
                }
                select.value = def.get();
                select.addEventListener('change', () => {
                    def.set(select.value);
                    onSettingChanged();
                });
                row.appendChild(select);
            } else {
                const range = document.createElement('input');
                range.type = 'range';
                range.id = `sa-pb-${key}`;
                range.min = def.min; range.max = def.max; range.step = def.step;
                range.value = def.get();

                const number = document.createElement('input');
                number.type = 'number';
                number.min = def.min; number.max = def.max; number.step = def.step;
                number.value = def.get();

                const push = (v) => {
                    def.set(v);
                    range.value = def.get();
                    number.value = def.get();
                    onSettingChanged();
                };
                range.addEventListener('input', () => push(range.value));
                number.addEventListener('change', () => push(number.value));

                row.appendChild(range);
                row.appendChild(number);
            }

            field.appendChild(row);
            panel.appendChild(field);
        }

        if (tool.kind === 'pick') {
            const note = document.createElement('div');
            note.className = 'sa-pb-note';
            note.id = 'sa-pb-note';
            panel.appendChild(note);
            updateFillNote();
        }
    }

    /**
     * Update the status line in place.
     *
     * Deliberately NOT a renderSettings() call: the preview refreshes while the
     * user drags the threshold slider, and rebuilding the panel would destroy
     * the very input element being dragged.
     */
    function updateFillNote() {
        const note = document.getElementById('sa-pb-note');
        if (!note) return;
        const fill = state.fill;
        if (fill && fill.error) {
            note.textContent = fill.error;
        } else if (fill) {
            note.textContent = fill.geom.length
                ? `Preview: ${fill.geom.length} region(s). Right-click the image to fill, ` +
                  'or left-click elsewhere to discard.'
                : 'Nothing matched at this threshold. Raise it, or pick another colour.';
        } else {
            note.textContent =
                'Left-click the image to preview what would be filled, then right-click to commit.';
        }
    }

    /**
     * A setting changed. The brush only needs its cursor resized; Fill by Color
     * has to re-run the selection so the preview tracks the slider live, without
     * the user re-clicking. Debounced because dragging the threshold slider
     * fires continuously.
     */
    function onSettingChanged() {
        updateCursor();
        if (!state.fill) return;
        if (state.fillDebounce) clearTimeout(state.fillDebounce);
        state.fillDebounce = setTimeout(() => {
            state.fillDebounce = 0;
            recomputeFillPreview();
        }, 120);
    }

    // -------------------------------------------------------- tool lifecycle

    function activateTool(toolId) {
        if (state.activeToolId === toolId) {
            deactivateTool();
            return;
        }
        if (state.activeToolId !== toolId) clearFillPreview();
        state.activeToolId = toolId;
        state.lastPickedId = toolId;

        // Disarm whatever editor tool was active so it cannot also react.
        if (app.svc && typeof app.svc.changeTool === 'function') {
            inNgZone(() => {
                try {
                    app.svc.drawingObject = null;
                    app.svc.changeTool('select');
                } catch (e) { /* noop */ }
            });
        }

        syncLeftPanel();
        renderSettings();
        openSettingsTab();
        updateCursor();
        LOG('activated', toolId);
    }

    function deactivateTool() {
        state.activeToolId = null;
        abortStroke();
        clearFillPreview();
        syncLeftPanel();
        renderSettings();
        updateCursor();
    }

    /** Clicking any native left-panel tool releases our tool. */
    function watchNativeToolClicks() {
        document.addEventListener('click', (e) => {
            if (!state.activeToolId) return;
            const t = e.target;
            if (!t || !t.closest) return;
            if (t.closest('.sa-pb-item') || t.closest('.sa-pb-menu')) return;
            if (t.closest('left-panel-item') || t.closest('.left-panel-container .bottom-section')) {
                deactivateTool();
            }
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && state.activeToolId) {
                deactivateTool();
            } else if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tag = (e.target && e.target.tagName) || '';
                if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
                // Shift+<letter>: every bare letter is already taken by the
                // editor (B=Bucket, E=Ellipse, G=Magic select, ...) and this
                // handler runs on document capture, so a bare letter here would
                // silently shadow the app's own shortcut.
                const want = 'Shift+' + e.key.toUpperCase();
                const tool = TOOLS.find((t) => t.shortcut === want);
                if (tool) {
                    e.preventDefault();
                    e.stopPropagation();
                    activateTool(tool.id);
                }
            }
        }, true);
    }

    // ------------------------------------------------------------ svg canvas

    function getSvg() {
        return document.getElementById('editor-svg');
    }

    /** Client coords -> image coords, via the SVG's own screen CTM. */
    function toImagePoint(svg, clientX, clientY) {
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return null;
        const p = pt.matrixTransform(ctm.inverse());
        return [p.x, p.y];
    }

    function ensureOverlay(svg) {
        let g = svg.querySelector('#sa-pb-overlay');
        if (!g) {
            g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('id', 'sa-pb-overlay');
            g.setAttribute('pointer-events', 'none');
            svg.appendChild(g);
        } else if (g !== svg.lastChild) {
            svg.appendChild(g); // keep on top after Angular re-renders
        }
        return g;
    }

    function updateCursor() {
        const svg = getSvg();
        if (!svg) return;
        // NOTE: the svg's class attribute is Angular-bound ([attr.class]="svgClass + ...")
        // and is rewritten on every tool change, so the cursor goes on inline style,
        // which nothing in the app touches.
        svg.style.cursor = isStrokeTool(state.activeToolId) ? 'none'
            : isPickTool(state.activeToolId) ? 'crosshair' : '';
        if (!isStrokeTool(state.activeToolId)) {
            const c = svg.querySelector('#sa-pb-cursor');
            if (c) c.remove();
        }
    }

    function drawCursor(svg, x, y) {
        const g = ensureOverlay(svg);
        let c = svg.querySelector('#sa-pb-cursor');
        if (!c) {
            c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            c.setAttribute('id', 'sa-pb-cursor');
            c.setAttribute('fill', 'none');
            c.setAttribute('stroke-width', '1');
            c.setAttribute('vector-effect', 'non-scaling-stroke');
            g.appendChild(c);
        }
        const tool = activeTool();
        const subtract = tool && tool.mode === 'subtract';
        c.setAttribute('cx', x);
        c.setAttribute('cy', y);
        c.setAttribute('r', activeStrokeRadius());
        c.setAttribute('stroke', subtract ? ERASER_COLOR : (currentClassColor() || '#7c5cff'));
        c.setAttribute('stroke-dasharray', subtract ? '4 3' : 'none');
    }

    function multiPolygonToPathData(mp) {
        let d = '';
        for (const poly of mp) {
            for (const ring of poly) {
                if (!ring.length) continue;
                d += 'M' + ring.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L') + 'Z';
            }
        }
        return d;
    }

    function renderStrokePreview(svg, mp, mode) {
        const g = ensureOverlay(svg);
        let path = svg.querySelector('#sa-pb-preview');
        if (!path) {
            path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('id', 'sa-pb-preview');
            path.setAttribute('fill-rule', 'evenodd');
            path.setAttribute('stroke-width', '1.5');
            path.setAttribute('vector-effect', 'non-scaling-stroke');
            g.insertBefore(path, g.firstChild);
        }
        // The eraser is destructive, so it must not look like the class it is
        // cutting into - red, dashed, and lighter fill.
        const subtract = mode === 'subtract';
        const color = subtract ? ERASER_COLOR : (currentClassColor() || '#7c5cff');
        path.setAttribute('fill', color);
        path.setAttribute('fill-opacity', subtract ? '0.25' : '0.45');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-dasharray', subtract ? '5 4' : 'none');
        path.setAttribute('d', mp && mp.length ? multiPolygonToPathData(mp) : '');
    }

    function clearStrokePreview() {
        const svg = getSvg();
        if (!svg) return;
        const path = svg.querySelector('#sa-pb-preview');
        if (path) path.remove();
    }

    function currentClassColor() {
        try {
            const cls = app.svc.getClassById(app.svc.getDrawClassesId());
            return cls && cls.color;
        } catch (e) {
            return null;
        }
    }

    // ------------------------------------------------------------- the brush

    function installCanvasHandlers() {
        // Capture phase on window: the editor component binds its own handlers
        // to `.editor-workspace`, a descendant, so ours runs first and can stop
        // the event from ever reaching the app's active tool.
        window.addEventListener('mousedown', onMouseDown, true);
        window.addEventListener('mousemove', onMouseMove, true);
        window.addEventListener('mouseup', onMouseUp, true);

        // Fill by Color commits on right-click, so the browser menu and the
        // editor's own class menu both have to be held off over the canvas.
        window.addEventListener('contextmenu', onCanvasContextMenu, true);

        // NOT window+capture: mouseleave does not bubble, but it still runs the
        // capture phase on ancestors, so a window capture listener fires for
        // mouseleave on every element in the page - including each existing
        // polygon the brush crosses, which would end the stroke mid-drag.
        // On `document` in the bubble phase it fires only when the pointer
        // genuinely leaves the page.
        document.addEventListener('mouseleave', onPointerLeftPage);
    }

    /** Right-click over the image: commit the Fill by Color preview. */
    function onCanvasContextMenu(e) {
        if (!isPickTool(state.activeToolId)) return;
        if (!overCanvas(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (state.fill && state.fill.geom.length) commitFillPreview();
    }

    function overCanvas(e) {
        const t = e.target;
        return !!(t && t.closest && t.closest('.editor-workspace'));
    }

    function onMouseDown(e) {
        const tool = activeTool();
        if (!tool) return;
        if (e.button !== 0) return;       // leave middle-drag pan / right-click menu alone
        if (!overCanvas(e)) return;
        const svg = getSvg();
        if (!svg || !app.svc || !app.pc) return;

        e.preventDefault();
        e.stopPropagation();

        const p = toImagePoint(svg, e.clientX, e.clientY);
        if (!p) return;

        if (tool.kind === 'pick') {
            // Inside the image -> preview; outside it -> discard the preview.
            const vb = svg.viewBox && svg.viewBox.baseVal;
            const inImage = vb && p[0] >= 0 && p[1] >= 0 && p[0] < vb.width && p[1] < vb.height;
            if (inImage) startFillPreview(p);
            else clearFillPreview();
            return;
        }

        state.stroke = {
            toolId: tool.id,
            mode: tool.mode,
            radius: activeStrokeRadius(),
            // Captured once, at mousedown: getDrawClassesId() can return a
            // freshly derived "empty class" id that changes between calls.
            classId: app.svc.getDrawClassesId(),
            last: p,
            pending: [],
            geom: null,
            rafId: 0,
        };

        // Seed with a single dot so a click (no drag) still marks.
        state.stroke.pending.push([p[0], p[1], p[0], p[1]]);
        scheduleStrokeFlush(svg);
    }

    function onMouseMove(e) {
        if (!activeTool()) return;
        const svg = getSvg();
        if (!svg) return;

        if (overCanvas(e) && isStrokeTool(state.activeToolId)) {
            const p = toImagePoint(svg, e.clientX, e.clientY);
            if (p) drawCursor(svg, p[0], p[1]);
        }

        const stroke = state.stroke;
        if (!stroke) return;

        // Safety net: if the primary button is no longer down we missed the
        // mouseup (released over browser chrome, or an alert stole focus).
        // Finish the stroke rather than painting a trail with the button up.
        if ((e.buttons & 1) === 0) {
            endStroke(null);
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const p = toImagePoint(svg, e.clientX, e.clientY);
        if (!p) return;

        const dx = p[0] - stroke.last[0];
        const dy = p[1] - stroke.last[1];
        const minStep = stroke.radius * RESAMPLE_FRACTION;
        if (dx * dx + dy * dy < minStep * minStep) return;

        stroke.pending.push([stroke.last[0], stroke.last[1], p[0], p[1]]);
        stroke.last = p;
        scheduleStrokeFlush(svg);
    }

    /**
     * Progressive union: every animation frame, fold the capsules stamped since
     * the last frame into the accumulated stroke geometry.
     */
    function scheduleStrokeFlush(svg) {
        const stroke = state.stroke;
        if (!stroke || stroke.rafId) return;
        stroke.rafId = requestAnimationFrame(() => {
            stroke.rafId = 0;
            flushStroke(svg);
        });
    }

    function flushStroke(svg) {
        const stroke = state.stroke;
        if (!stroke || !stroke.pending.length) return;

        const stamps = stroke.pending.map(([ax, ay, bx, by]) => [capsuleRing(ax, ay, bx, by, stroke.radius)]);
        stroke.pending.length = 0;

        try {
            stroke.geom = stroke.geom
                ? app.pc.union(stroke.geom, ...stamps)
                : app.pc.union(stamps[0], ...stamps.slice(1));
        } catch (err) {
            WARN('union failed for this frame, skipping', err);
            return;
        }
        renderStrokePreview(svg, stroke.geom, stroke.mode);
    }

    /** The pointer left the page entirely - finish the stroke where it stands. */
    function onPointerLeftPage() {
        if (state.stroke) endStroke(null);
    }

    function onMouseUp(e) {
        if (!state.stroke) return;
        if (e.button !== 0) return;
        endStroke(e);
    }

    function endStroke(e) {
        if (!state.stroke) return;

        const svg = getSvg();
        const stroke = state.stroke;
        state.stroke = null;

        if (stroke.rafId) cancelAnimationFrame(stroke.rafId);
        if (svg && stroke.pending.length) {
            state.stroke = stroke;
            flushStroke(svg);
            state.stroke = null;
        }

        clearStrokePreview();

        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        if (!stroke.geom || !stroke.geom.length) return;
        commitStroke(stroke);
    }

    function abortStroke() {
        if (state.stroke && state.stroke.rafId) cancelAnimationFrame(state.stroke.rafId);
        state.stroke = null;
        clearStrokePreview();
    }

    // ------------------------------------------------------------- commit

    /**
     * RDP tolerance for a stroke. Scales with the tool radius so a fat stroke
     * does not carry hundreds of near-collinear vertices, with a zoom-derived
     * floor borrowed from the editor's own simplifyRange (editor-polygon.ts:211).
     */
    function strokeEpsilon(stroke) {
        const zoom = (app.svc && app.svc.zoomLevel) || 1;
        return Math.max(
            SIMPLIFY.min,
            Math.min(SIMPLIFY.max, Math.max(stroke.radius * SIMPLIFY.radiusFactor, 0.8 / Math.sqrt(zoom)))
        );
    }

    /**
     * Both tools act on the selected class only: the brush merges into these,
     * the eraser subtracts from these, and nothing else on the canvas is
     * touched.
     *
     * Note `locked` is deliberately NOT filtered on. EditorPolygon defaults it
     * to true for any polygon built without an explicit flag
     * (editor-polygon.ts:39), so most existing annotations are locked and
     * skipping them would make the eraser useless.
     */
    function sameClassPolygons(svc, classId) {
        return (svc.objects || []).filter((o) =>
            o && o.type === 'polygon' && !o.isHole && o.classId === classId &&
            o.visible !== false && Array.isArray(o.points) && o.points.length >= 6
        );
    }

    /**
     * One polygon-clipping member -> one editor annotation object.
     *
     * `donor` is the existing polygon this piece descends from, if any. The
     * first piece reuses its id so selection and history stay attached; split
     * siblings get fresh ids but inherit everything else, because they are
     * fragments of the same annotation.
     */
    function polygonJson(poly, opts) {
        const points = ringToPoints(poly[0]);
        if (points.length < 6) return null;

        const exclude = [];
        for (let h = 1; h < poly.length; h++) {
            const hole = ringToPoints(poly[h]);
            if (hole.length >= 6) exclude.push(hole);
        }

        const donor = opts.donor;
        const keepId = opts.keepId && donor;

        return {
            id: keepId ? donor.id : uuidv4(),
            type: 'polygon',
            classId: opts.classId,
            probability: donor && typeof donor.probability === 'number' ? donor.probability : 100,
            points,
            exclude,
            groupId: (donor && donor.groupId) || 0,
            pointLabels: {},
            locked: donor ? !!donor.locked : false,
            attributes: donor && donor.attributes ? donor.attributes.map((a) => ({ ...a })) : [],
            error: donor ? donor.error : null,
            createdAt: (donor && donor.createdAt) || opts.now,
            createdBy: (donor && donor.createdBy) || opts.author,
            creationType: (donor && donor.creationType) || 'Manual',
            updatedAt: opts.now,
            updatedBy: opts.author,
        };
    }

    /**
     * The single write path for both tools.
     *
     * Rebuilds the annotation as plain JSON, swaps the affected polygons for
     * the result, hands it back through setObjects, and records exactly ONE
     * history snapshot. Undo replays setObjects(previousSnapshot), so one press
     * restores the state from before the stroke began.
     *
     * Returns false (writing nothing, and adding no history entry) when the
     * stroke changed nothing — otherwise undo would need a wasted press.
     */
    function applyObjectChanges(change) {
        const svc = app.svc;
        if (!change.removedIds.size && !change.added.length) return false;

        inNgZone(() => {
            const json = svc.getObjectsJson(true);
            const next = json.filter((o) => !change.removedIds.has(o.id));
            for (const obj of change.added) next.push(obj);

            svc.setObjects(next);

            // Brand-new polygons with no donor get the class's default
            // attributes, exactly as the editor does for its own fresh shapes.
            if (change.defaultAttrIds && change.defaultAttrIds.size) {
                for (const o of svc.objects) {
                    if (change.defaultAttrIds.has(o.id) && typeof o.setDefaultAttributes === 'function') {
                        try { o.setDefaultAttributes(); } catch (err) { /* noop */ }
                    }
                }
            }

            svc.addToHistory();
        });
        return true;
    }

    function commitStroke(stroke) {
        if (!app.svc || !app.pc) return;
        const epsilon = strokeEpsilon(stroke);

        // Simplify the STROKE, before any boolean op. Doing it here rather than
        // on the result means existing polygons keep their original vertices —
        // only the newly cut or newly painted edge is smoothed.
        const geom = simplifyMultiPolygon(stroke.geom, epsilon);
        if (!geom.length) return;

        if (stroke.mode === 'subtract') commitEraserStroke(stroke, geom, epsilon);
        else commitBrushStroke(stroke, geom, epsilon);
    }

    /** Paintbrush: union the stroke with every overlapping same-class polygon. */
    function commitBrushStroke(stroke, strokeGeom, epsilon) {
        const svc = app.svc;
        const pc = app.pc;
        const classId = stroke.classId;

        let geom = strokeGeom;
        const strokeBox = multiPolygonBBox(geom);
        const merged = [];

        for (const obj of sameClassPolygons(svc, classId)) {
            let objGeom;
            try { objGeom = editorPolygonToGeom(obj); } catch (err) { continue; }
            if (!boxesOverlap(strokeBox, multiPolygonBBox([objGeom]), 1)) continue;
            try {
                // bbox overlap is only a broad phase; require a real
                // intersection so a disjoint neighbour is never rewritten.
                if (!pc.intersection(geom, objGeom).length) continue;
                geom = pc.union(geom, objGeom);
                merged.push(obj);
            } catch (err) {
                WARN('merge skipped for object', obj.id, err);
            }
        }

        if (!geom.length) return;

        const now = new Date().toISOString();
        const author = svc.me ? { email: svc.me.id, roleId: svc.me.role && svc.me.role.id } : null;
        const donor = merged[0] || null;
        const added = [];
        const defaultAttrIds = new Set();

        geom.forEach((poly, i) => {
            const json = polygonJson(poly, {
                classId,
                donor: i === 0 ? donor : null,
                keepId: i === 0,
                now,
                author,
            });
            if (!json) return;
            if (!(i === 0 && donor)) defaultAttrIds.add(json.id);
            added.push(json);
        });

        const wrote = applyObjectChanges({
            removedIds: new Set(merged.map((o) => o.id)),
            added,
            defaultAttrIds,
        });
        if (wrote) LOG(`brush: ${added.length} polygon(s), merged ${merged.length}, eps=${epsilon.toFixed(2)}`);
    }

    /**
     * Eraser: subtract the stroke from every overlapping same-class polygon.
     *
     * A subtraction can return zero members (the polygon was wholly erased),
     * one member (a bite was taken out of it), or several (the stroke cut
     * across it) — in which case each member becomes its own distinct polygon.
     * Holes come back on each member and are carried through as `exclude`.
     */
    function commitEraserStroke(stroke, strokeGeom, epsilon) {
        const svc = app.svc;
        const pc = app.pc;
        const classId = stroke.classId;
        const strokeBox = multiPolygonBBox(strokeGeom);

        const now = new Date().toISOString();
        const author = svc.me ? { email: svc.me.id, roleId: svc.me.role && svc.me.role.id } : null;

        const removedIds = new Set();
        const added = [];
        let erased = 0;
        let splits = 0;

        for (const obj of sameClassPolygons(svc, classId)) {
            let objGeom;
            try { objGeom = editorPolygonToGeom(obj); } catch (err) { continue; }
            if (!boxesOverlap(strokeBox, multiPolygonBBox([objGeom]), 1)) continue;

            let remainder;
            try {
                if (!pc.intersection(strokeGeom, objGeom).length) continue; // untouched
                remainder = pc.difference(objGeom, strokeGeom);
            } catch (err) {
                WARN('erase skipped for object', obj.id, err);
                continue;
            }

            // Prune only — no RDP. The stroke was already simplified, so the cut
            // edge is clean, and re-simplifying here would also degrade the
            // parts of this polygon the eraser never touched.
            const pieces = pruneMultiPolygon(remainder, epsilon);

            // Either way this polygon is replaced: removed outright when nothing
            // survives, or swapped for its remaining piece(s).
            removedIds.add(obj.id);
            if (!pieces.length) { erased++; continue; }
            if (pieces.length > 1) splits++;

            pieces.forEach((poly, i) => {
                const json = polygonJson(poly, {
                    classId,
                    donor: obj,        // every piece descends from this polygon
                    keepId: i === 0,   // the first keeps its identity
                    now,
                    author,
                });
                if (json) added.push(json);
            });
        }

        const wrote = applyObjectChanges({ removedIds, added, defaultAttrIds: null });
        if (wrote) {
            LOG(`eraser: ${removedIds.size} polygon(s) hit, ${erased} removed, ` +
                `${splits} split, ${added.length} remaining piece(s), eps=${epsilon.toFixed(2)}`);
        }
    }

    // ------------------------------------------------- fill by colour (tool)

    /**
     * The editor shows the image as a plain <img> inside .imageWrapper, whose
     * src is the LO-RES rendition (vector-editor.component.html). The SVG
     * viewBox is in ORIGINAL image coordinates, so the bitmap we sample is
     * usually smaller than annotation space and everything traced from it has
     * to be scaled up by viewBox/bitmap.
     *
     * Tiled (OpenSeadragon) projects have no such <img> - they render into
     * #tiledWrapper - so the tool reports that it cannot sample instead of
     * silently doing nothing.
     */
    function findEditorImage() {
        return document.querySelector('.editor-workspace .imageWrapper img');
    }

    /**
     * Pixels for the current image, cached per src.
     *
     * The page's own <img> has no crossOrigin attribute, so drawing it to a
     * canvas would taint it and getImageData would throw. We therefore fetch
     * the bytes ourselves and decode them - which needs the image host to allow
     * CORS. A cache-busting param is NOT an option here: these are presigned
     * URLs and any extra query parameter invalidates the signature.
     */
    function loadBitmap() {
        const img = findEditorImage();
        if (!img || !img.src) {
            return Promise.reject(new Error('No image found — tiled projects are not supported yet.'));
        }
        const src = img.src;
        if (app.bitmap && app.bitmap.src === src) return Promise.resolve(app.bitmap);
        if (app.bitmapPending && app.bitmapPending.src === src) return app.bitmapPending.promise;

        const promise = fetch(src, { mode: 'cors', credentials: 'omit' })
            .then((r) => {
                if (!r.ok) throw new Error(`image fetch failed (HTTP ${r.status})`);
                return r.blob();
            })
            .then((blob) => createImageBitmap(blob))
            .then((bitmap) => {
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(bitmap, 0, 0);
                const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
                bitmap.close && bitmap.close();

                app.bitmap = { src, width: imageData.width, height: imageData.height, data: imageData.data };
                app.bitmapPending = null;
                LOG(`sampled image ${imageData.width}x${imageData.height}`);
                return app.bitmap;
            })
            .catch((err) => {
                app.bitmapPending = null;
                throw new Error(
                    'Could not read the image pixels (' + err.message + '). ' +
                    'The image host must allow cross-origin reads.'
                );
            });

        app.bitmapPending = { src, promise };
        return promise;
    }

    /** SVG viewBox (annotation space) -> bitmap pixel scale factors. */
    function bitmapScale(svg, bitmap) {
        const vb = svg.viewBox && svg.viewBox.baseVal;
        const w = (vb && vb.width) || bitmap.width;
        const h = (vb && vb.height) || bitmap.height;
        return { x: w / bitmap.width, y: h / bitmap.height, width: w, height: h };
    }

    /** Left click on the image: sample the colour there and build a preview. */
    function startFillPreview(imagePoint) {
        const svg = getSvg();
        if (!svg || !app.svc) return;

        loadBitmap().then((bitmap) => {
            const scale = bitmapScale(svg, bitmap);
            const col = Math.floor(imagePoint[0] / scale.x);
            const row = Math.floor(imagePoint[1] / scale.y);

            if (col < 0 || row < 0 || col >= bitmap.width || row >= bitmap.height) {
                clearFillPreview();   // clicked outside the image
                return;
            }

            const p = (row * bitmap.width + col) * 4;
            state.fill = {
                seed: [bitmap.data[p], bitmap.data[p + 1], bitmap.data[p + 2]],
                at: [col, row],
                classId: app.svc.getDrawClassesId(),
                geom: [],
                error: null,
            };
            recomputeFillPreview();
        }).catch((err) => {
            WARN(err.message);
            state.fill = { seed: null, at: null, classId: null, geom: [], error: err.message };
            renderFillPreview();
            updateFillNote();
        });
    }

    /** Re-run the selection for the stored seed with the current settings. */
    function recomputeFillPreview() {
        const svg = getSvg();
        const fill = state.fill;
        if (!svg || !fill || !fill.seed || !app.bitmap) return;

        const bitmap = app.bitmap;
        const scale = bitmapScale(svg, bitmap);

        // Tolerance in annotation units: never finer than one source pixel,
        // since that is the resolution the mask was traced at.
        const zoom = (app.svc && app.svc.zoomLevel) || 1;
        const epsilon = Math.max(0.8 / Math.sqrt(zoom), Math.max(scale.x, scale.y) * 0.75);

        const t0 = Date.now();
        try {
            fill.geom = colorSelectPolygons(
                bitmap, fill.seed, settings.fillThreshold, settings.fillCriterion,
                settings.fillGap, epsilon, scale.x, scale.y
            );
            fill.error = null;
        } catch (err) {
            WARN('colour selection failed', err);
            fill.geom = [];
            fill.error = 'Colour selection failed: ' + err.message;
        }
        LOG(`fill preview: ${fill.geom.length} region(s) in ${Date.now() - t0}ms ` +
            `(threshold ${settings.fillThreshold}, ${settings.fillCriterion}, gap ${settings.fillGap})`);

        renderFillPreview();
        updateFillNote();
    }

    function renderFillPreview() {
        const svg = getSvg();
        if (!svg) return;

        const g = ensureOverlay(svg);
        let path = svg.querySelector('#sa-pb-fill-preview');
        if (!path) {
            path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('id', 'sa-pb-fill-preview');
            path.setAttribute('fill-rule', 'evenodd');
            path.setAttribute('stroke-width', '1.5');
            path.setAttribute('stroke-dasharray', '6 3');
            path.setAttribute('vector-effect', 'non-scaling-stroke');
            g.insertBefore(path, g.firstChild);
        }

        const geom = (state.fill && state.fill.geom) || [];
        const color = currentClassColor() || '#7c5cff';
        path.setAttribute('fill', color);
        path.setAttribute('fill-opacity', '0.35');
        path.setAttribute('stroke', color);
        path.setAttribute('d', geom.length ? multiPolygonToPathData(geom) : '');
    }

    function clearFillPreview() {
        state.fill = null;
        if (state.fillDebounce) { clearTimeout(state.fillDebounce); state.fillDebounce = 0; }
        const svg = getSvg();
        const path = svg && svg.querySelector('#sa-pb-fill-preview');
        if (path) path.remove();
        updateFillNote();
    }

    /**
     * Right click: turn the preview into real polygons of the selected class.
     * One addToHistory, so a single undo removes the whole fill.
     */
    function commitFillPreview() {
        const svc = app.svc;
        const fill = state.fill;
        if (!svc || !fill || !fill.geom.length) return;

        const classId = fill.classId;
        const now = new Date().toISOString();
        const author = svc.me ? { email: svc.me.id, roleId: svc.me.role && svc.me.role.id } : null;

        const added = [];
        const defaultAttrIds = new Set();
        for (const poly of fill.geom) {
            const json = polygonJson(poly, { classId, donor: null, keepId: false, now, author });
            if (!json) continue;
            defaultAttrIds.add(json.id);
            added.push(json);
        }

        const count = added.length;
        const wrote = applyObjectChanges({ removedIds: new Set(), added, defaultAttrIds });
        clearFillPreview();
        if (wrote) LOG(`fill committed: ${count} polygon(s)`);
    }

    // ---------------------------------------------------------------- boot

    let serviceReadyFired = false;

    function onServiceReady() {
        if (serviceReadyFired) return;
        serviceReadyFired = true;
        LOG('editor service captured');
    }

    function tryBridge() {
        if (!app.req) app.req = getWebpackRequire();
        if (!app.req) return false;
        if (!app.pc) app.pc = loadPolygonClipping(app.req);
        if (!app.SvcClass) hookEditorService(app.req);
        return !!(app.pc && app.SvcClass);
    }

    function tick() {
        injectStyles();
        tryBridge();
        ensureLeftPanelItem();
        ensureRightPanelTab();
        if (isSettingsTabOpen()) {
            state.ui.tabBody && state.ui.tabBody.classList.add('sa-pb-hidden-body');
        }
    }

    function boot() {
        injectStyles();
        watchNativeToolClicks();
        installCanvasHandlers();

        // The editor mounts asynchronously and Angular re-renders both panels on
        // navigation, so keep re-asserting our nodes rather than injecting once.
        setInterval(tick, 800);
        tick();

        LOG('loaded — right-click the brush in the left panel for the tool list');
    }

    boot();
})();

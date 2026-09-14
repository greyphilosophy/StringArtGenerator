/* Dependency-free color planner, shared by the worker, playback and Node tests. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ColorPlanner = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
    'use strict';
    const MODEL = 'linear-coverage-v1';
    const TRANSPARENT_MODEL = 'linear-coverage-alpha-v1';
    const MAX_WORKING_DIMENSION = 640;
    const MAX_SOURCE_DIMENSION = 1280;
    const CHANNEL_WEIGHTS = [0.2126, 0.7152, 0.0722];
    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    const toLinear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    const toSrgb = x => x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
    const rgb = hex => [1, 3, 5].map(i => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
    const hex = color => '#' + color.map(x => Math.round(clamp(toSrgb(x), 0, 1) * 255).toString(16).padStart(2, '0')).join('');
    const validHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    const validBackground = value => value === 'transparent' || validHex(value);
    function distance(a, b) {
        let sum = 0;
        for (let c = 0; c < 3; c++) sum += CHANNEL_WEIGHTS[c] * (a[c] - b[c]) ** 2;
        return sum;
    }
    function makePins(frame) {
        const {width, height, horizontalPins: h, verticalPins: v, pinCount} = frame;
        const pins = [], right = width - 1, bottom = height - 1;
        if (frame.shape === 'rectangle') {
            for (let i = 0; i < h; i++) pins.push([Math.floor(right * i / (h - 1)), bottom]);
            for (let i = v - 1; i >= 0; i--) pins.push([right, Math.floor(bottom * i / (v - 1))]);
            for (let i = h - 1; i >= 0; i--) pins.push([Math.floor(right * i / (h - 1)), 0]);
            for (let i = 0; i < v; i++) pins.push([0, Math.floor(bottom * i / (v - 1))]);
        } else {
            for (let i = 0; i < pinCount; i++) {
                const angle = 2 * Math.PI * i / pinCount;
                pins.push([Math.floor(width / 2 + (width / 2 - 0.5) * Math.cos(angle)),
                    Math.floor(width / 2 + (width / 2 - 0.5) * Math.sin(angle))]);
            }
        }
        return pins;
    }
    function validateFrame(frame) {
        const int = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
        if (!['circle', 'rectangle'].includes(frame.shape) || !int(frame.width, 2, MAX_SOURCE_DIMENSION) || !int(frame.height, 2, MAX_SOURCE_DIMENSION) ||
            (frame.shape === 'circle' && (frame.width !== frame.height || !int(frame.pinCount, 3, 500))) ||
            (frame.shape === 'rectangle' && (!int(frame.horizontalPins, 2, frame.width) ||
                !int(frame.verticalPins, 2, frame.height) || 2 * (frame.horizontalPins + frame.verticalPins) > 500))) {
            throw new Error('Color plans support valid circle/rectangle frames with at most 500 pin numbers.');
        }
    }
    function validatePlan(plan) {
        if (!plan || plan.version !== 2 || plan.mode !== 'color') throw new Error('Unsupported color instructions.');
        validateFrame(plan);
        const render = plan.render;
        if (!validBackground(plan.background) || !Array.isArray(plan.palette) || plan.palette.length > 5 || !plan.palette.every(validHex) ||
            !render || render.model !== (plan.background === 'transparent' ? TRANSPARENT_MODEL : MODEL) ||
            !Number.isInteger(render.width) || !Number.isInteger(render.height) ||
            render.width < 2 || render.height < 2 || render.width > MAX_WORKING_DIMENSION || render.height > MAX_WORKING_DIMENSION ||
            Math.abs(render.width / render.height - plan.width / plan.height) > 2 / render.height ||
            !Number.isFinite(render.coverage) || render.coverage <= 0 || render.coverage > 0.95 ||
            !Number.isFinite(plan.frameLongestCm) || plan.frameLongestCm <= 0 || plan.frameLongestCm > 1000 ||
            !Number.isFinite(plan.threadDiameterMm) || plan.threadDiameterMm <= 0 || plan.threadDiameterMm > 5 ||
            !Array.isArray(plan.layers) || plan.layers.length > 120) throw new Error('Invalid color plan settings.');
        const pins = makePins(plan);
        let lines = 0;
        for (const layer of plan.layers) {
            if (!layer || !Number.isInteger(layer.color) || layer.color < 0 || layer.color >= plan.palette.length ||
                !Array.isArray(layer.sequence) || layer.sequence.length < 2 ||
                !layer.sequence.every(n => Number.isInteger(n) && n >= 0 && n < pins.length)) throw new Error('Invalid color winding sequence.');
            lines += layer.sequence.length - 1;
            for (let i = 1; i < layer.sequence.length; i++) {
                const a = pins[layer.sequence[i - 1]], b = pins[layer.sequence[i]];
                if (a[0] === b[0] && a[1] === b[1]) throw new Error('A winding segment must connect distinct nails.');
            }
        }
        if (lines > 10000) throw new Error('Color plans support at most 10000 lines.');
        if (plan.maxLines !== undefined && (!Number.isInteger(plan.maxLines) || plan.maxLines < 1 || plan.maxLines > 10000 || lines > plan.maxLines))
            throw new Error('The winding sequence exceeds its saved line budget.');
        return plan;
    }
    function canvas(size, background) {
        const data = new Float64Array(size * 3);
        // Transparent images store premultiplied linear RGB plus coverage.
        // Solid boards retain the original RGB representation and arithmetic.
        if (background === null) { data.alpha = new Float64Array(size); return data; }
        for (let i = 0; i < data.length; i++) data[i] = background[i % 3];
        return data;
    }
    // Coverage still mixes in linear light, but judge the visible result in
    // display RGB so shadow detail and red/blue differences are not discounted.
    // Interpolate a transfer-function table in the inner candidate loop.
    const DISPLAY_STEPS = 65536;
    const DISPLAY_LUT = Float64Array.from({length: DISPLAY_STEPS + 1}, (_, i) => toSrgb(i / DISPLAY_STEPS));
    function displayValue(value) {
        const scaled = clamp(value, 0, 1) * DISPLAY_STEPS;
        const index = Math.min(DISPLAY_STEPS - 1, Math.floor(scaled));
        return DISPLAY_LUT[index] + (scaled - index) * (DISPLAY_LUT[index + 1] - DISPLAY_LUT[index]);
    }
    function pixelError(data, target, displayTarget, weights) {
        let error = 0;
        for (let i = 0; i < data.length; i++) {
            if (data.alpha) {
                const p = Math.floor(i / 3);
                const blackTarget = displayTarget ? displayTarget[i] : displayValue(target[i]);
                const whiteTarget = displayTarget ? displayTarget.white[i] : displayValue(target[i] + 1 - target.alpha[p]);
                error += (weights ? weights[p] : 1) * transparentError(data[i], data.alpha[p], blackTarget, whiteTarget) / 3;
                continue;
            }
            error += (weights ? weights[Math.floor(i / 3)] : 1) * (displayTarget ? (displayValue(data[i]) - displayTarget[i]) ** 2 / 3 :
                CHANNEL_WEIGHTS[i % 3] * (data[i] - target[i]) ** 2);
        }
        return error;
    }
    // Compare the image on BOTH black and white backdrops. This accounts for
    // uncovered space without pretending it supplies either thread color.
    // Source alpha is preserved: an empty transparent target needs no thread.
    function transparentError(value, alpha, blackTarget, whiteTarget) {
        return ((displayValue(value) - blackTarget) ** 2 +
            (displayValue(value + 1 - alpha) - whiteTarget) ** 2) / 2;
    }
    function makeBoundaries(target, mask, width, height, strength = 2) {
        // Signed color differences across short horizontal/vertical spans.
        // Keep real source boundaries, including subtle gray-on-white seams;
        // tiny changes below 4% display-RGB RMS are treated as texture/noise.
        const from = [], to = [], size = width * height, counts = new Uint32Array(size);
        const span = Math.min(2, width - 1, height - 1);
        function add(p, q) {
            if (!mask[p] || !mask[q]) return;
            let contrast = 0;
            for (let c = 0; c < 3; c++) {
                contrast += (target[p * 3 + c] - target[q * 3 + c]) ** 2;
                if (target.white) contrast += (target.white[p * 3 + c] - target.white[q * 3 + c]) ** 2;
            }
            if (contrast / (target.white ? 6 : 3) < 0.04 ** 2) return;
            from.push(p); to.push(q); counts[p]++; counts[q]++;
        }
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (x + span < width) add(p, p + span);
            if (y + span < height) add(p, p + span * width);
        }
        const offsets = new Uint32Array(size + 1);
        for (let p = 0; p < size; p++) offsets[p + 1] = offsets[p] + counts[p];
        const neighbors = new Uint32Array(offsets[size]), cursor = offsets.slice();
        for (let e = 0; e < from.length; e++) {
            neighbors[cursor[from[e]]++] = to[e]; neighbors[cursor[to[e]]++] = from[e];
        }
        return {target, strength, from: Uint32Array.from(from), to: Uint32Array.from(to), offsets, neighbors,
            // Reusable candidate storage bounds allocations in the inner loop.
            stamp: new Uint32Array(size), serial: 0, before: new Float64Array(size * 6), delta: new Float64Array(size * 6)};
    }
    function boundaryError(data, boundaries) {
        if (!boundaries) return 0;
        const {target, from, to, strength} = boundaries;
        let error = 0;
        for (let e = 0; e < from.length; e++) {
            const p = from[e], q = to[e];
            const weight = boundaries.regionWeights ? (boundaries.regionWeights[p] + boundaries.regionWeights[q]) / 2 : 1;
            for (let c = 0; c < 3; c++) {
                const a = p * 3 + c, b = q * 3 + c;
                const difference = displayValue(data[a]) - displayValue(data[b]) - (target[a] - target[b]);
                error += weight * difference * difference;
                if (data.alpha) {
                    const whiteDifference = displayValue(data[a] + 1 - data.alpha[p]) - displayValue(data[b] + 1 - data.alpha[q]) -
                        (target.white[a] - target.white[b]);
                    error += weight * whiteDifference * whiteDifference;
                }
            }
        }
        return strength * error / (data.alpha ? 6 : 3);
    }
    function imageError(data, context) {
        return pixelError(data, context.target, context.displayTarget, context.weights) + boundaryError(data, context.boundaries);
    }
    // Partial pixel coverage models opaque, thin threads viewed from a distance.
    // It is deliberately not RGB light addition or a claim of perfect occlusion.
    function applyLine(data, line, color, coverage) {
        for (const pixel of line.pixels) {
            const offset = pixel * 3;
            for (let c = 0; c < 3; c++) data[offset + c] += coverage * (color[c] - data[offset + c]);
            if (data.alpha) data.alpha[pixel] += coverage * (1 - data.alpha[pixel]);
        }
    }
    function scoreLine(data, target, line, color, coverage, suffix, displayTarget, weights, boundaries) {
        let gain = 0;
        let serial = 0;
        if (boundaries) {
            serial = boundaries.serial = (boundaries.serial + 1) >>> 0;
            if (!serial) { boundaries.stamp.fill(0); serial = boundaries.serial = 1; }
        }
        for (const pixel of line.pixels) {
            const offset = pixel * 3;
            const transmission = suffix ? suffix.transmission[pixel] : 1;
            const oldAlpha = data.alpha ? 1 - transmission * (1 - data.alpha[pixel]) : 1;
            const newAlpha = data.alpha ? oldAlpha + transmission * coverage * (1 - data.alpha[pixel]) : 1;
            const touchesBoundary = boundaries && boundaries.offsets[pixel + 1] > boundaries.offsets[pixel];
            if (touchesBoundary) boundaries.stamp[pixel] = serial;
            for (let c = 0; c < 3; c++) {
                const old = data[offset + c];
                const overlay = suffix ? suffix.overlay[offset + c] : 0;
                const oldFinal = transmission * old + overlay;
                const newFinal = transmission * (old + coverage * (color[c] - old)) + overlay;
                if (touchesBoundary) {
                    const b = boundaries, i = pixel * 6 + c, oldVisible = displayValue(oldFinal);
                    b.before[i] = oldVisible - b.target[offset + c];
                    b.delta[i] = displayValue(newFinal) - oldVisible;
                    if (data.alpha) {
                        const oldWhite = displayValue(oldFinal + 1 - oldAlpha);
                        b.before[i + 3] = oldWhite - b.target.white[offset + c];
                        b.delta[i + 3] = displayValue(newFinal + 1 - newAlpha) - oldWhite;
                    }
                }
                if (data.alpha) {
                    const blackTarget = displayTarget ? displayTarget[offset + c] : displayValue(target[offset + c]);
                    const whiteTarget = displayTarget ? displayTarget.white[offset + c] : displayValue(target[offset + c] + 1 - target.alpha[pixel]);
                    gain += (weights ? weights[pixel] : 1) * (transparentError(oldFinal, oldAlpha, blackTarget, whiteTarget) -
                        transparentError(newFinal, newAlpha, blackTarget, whiteTarget)) / 3;
                    continue;
                }
                const before = displayTarget ? displayValue(oldFinal) - displayTarget[offset + c] : oldFinal - target[offset + c];
                const after = displayTarget ? displayValue(newFinal) - displayTarget[offset + c] : newFinal - target[offset + c];
                gain += (weights ? weights[pixel] : 1) * (displayTarget ? 1 / 3 : CHANNEL_WEIGHTS[c]) * (before * before - after * after);
            }
        }
        if (boundaries) gain += boundaryGain(data, line, suffix, boundaries, serial);
        return gain;
    }
    function boundaryGain(data, line, suffix, b, serial) {
        let gain = 0;
        for (const p of line.pixels) for (let e = b.offsets[p]; e < b.offsets[p + 1]; e++) {
            const q = b.neighbors[e], changed = b.stamp[q] === serial;
            // Include edges with either endpoint changed, exactly once. The
            // other endpoint may lie outside the proposed string altogether.
            if (changed && q < p) continue;
            const weight = b.regionWeights ? (b.regionWeights[p] + b.regionWeights[q]) / 2 : 1;
            const transmission = suffix ? suffix.transmission[q] : 1;
            const alpha = data.alpha ? 1 - transmission * (1 - data.alpha[q]) : 1;
            for (let c = 0; c < 3; c++) {
                const i = p * 6 + c, j = q * 6 + c, off = q * 3 + c;
                const final = changed ? 0 : transmission * data[off] + (suffix ? suffix.overlay[off] : 0);
                const old = b.before[i] - (changed ? b.before[j] : displayValue(final) - b.target[off]);
                const next = old + b.delta[i] - (changed ? b.delta[j] : 0);
                gain += weight * (old * old - next * next);
                if (data.alpha) {
                    const oldWhite = b.before[i + 3] - (changed ? b.before[j + 3] : displayValue(final + 1 - alpha) - b.target.white[off]);
                    const nextWhite = oldWhite + b.delta[i + 3] - (changed ? b.delta[j + 3] : 0);
                    gain += weight * (oldWhite * oldWhite - nextWhite * nextWhite);
                }
            }
        }
        return b.strength * gain / (data.alpha ? 6 : 3);
    }
    function segmentSide(frame, a, b) {
        if (frame.shape !== 'rectangle' || (a[0] === b[0] && a[1] === b[1])) return null;
        if (a[1] === b[1] && a[1] === frame.height - 1) return 'bottom';
        if (a[0] === b[0] && a[0] === frame.width - 1) return 'right';
        if (a[1] === b[1] && a[1] === 0) return 'top';
        if (a[0] === b[0] && a[0] === 0) return 'left';
        return null;
    }
    function rasterizer(frame, width, height) {
        const sourcePins = makePins(frame);
        const pins = sourcePins.map(([x, y]) => [Math.round(x * (width - 1) / (frame.width - 1)),
            Math.round(y * (height - 1) / (frame.height - 1))]);
        // Physical aliases (shared rectangle corners) share a buildup penalty.
        const aliases = sourcePins.map(p => p.join(','));
        const cache = new Map();
        return {
            pins,
            side(a, b) { return segmentSide(frame, sourcePins[a], sourcePins[b]); },
            line(a, b) {
                const key = [aliases[a], aliases[b]].sort().join(':');
                if (cache.has(key)) return cache.get(key);
                if (aliases[a] > aliases[b]) [a, b] = [b, a];
                let [x, y] = pins[a];
                const [x1, y1] = pins[b];
                const dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y), sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
                let err = dx + dy;
                const pixels = [];
                while (true) {
                    if (frame.shape !== 'circle' || ((x + 0.5 - width / 2) / (width / 2)) ** 2 +
                        ((y + 0.5 - height / 2) / (height / 2)) ** 2 <= 1) pixels.push(y * width + x);
                    if (x === x1 && y === y1) break;
                    const e2 = 2 * err;
                    if (e2 >= dy) { err += dy; x += sx; }
                    if (e2 <= dx) { err += dx; y += sy; }
                }
                const length = Math.hypot(pins[a][0] - x1, pins[a][1] - y1);
                const line = {key, pixels: Uint32Array.from(pixels), length,
                    edge: segmentSide(frame, sourcePins[a], sourcePins[b])};
                if (cache.size >= 12000) cache.delete(cache.keys().next().value);
                cache.set(key, line);
                return line;
            }
        };
    }
    function suffixTransform(layers, palette, raster, size, coverage) {
        const transmission = new Float64Array(size).fill(1), overlay = new Float64Array(size * 3);
        for (const layer of layers) {
            for (let i = 1; i < layer.sequence.length; i++) {
                const line = raster.line(layer.sequence[i - 1], layer.sequence[i]);
                applyLine(overlay, line, palette[layer.color], coverage);
                for (const p of line.pixels) transmission[p] *= 1 - coverage;
            }
        }
        return {transmission, overlay};
    }
    function renderLayers(layers, context, limit = Infinity) {
        const data = canvas(context.size, context.background);
        let drawn = 0;
        for (const layer of layers) {
            for (let i = 1; i < layer.sequence.length; i++) {
                if (drawn++ >= limit) return data;
                applyLine(data, context.raster.line(layer.sequence[i - 1], layer.sequence[i]), context.palette[layer.color], context.coverage);
            }
        }
        return data;
    }
    function usageFor(layers, raster) {
        const usage = new Map();
        for (const layer of layers) for (let i = 1; i < layer.sequence.length; i++) {
            const key = raster.line(layer.sequence[i - 1], layer.sequence[i]).key;
            usage.set(key, (usage.get(key) || 0) + 1);
        }
        return usage;
    }
    const LENGTH_COST = 0.00001, BUILDUP_COST = 0.00002;
    function penalty(line, usage) {
        return line.length * (LENGTH_COST + BUILDUP_COST * (2 * (usage.get(line.key) || 0) + 1));
    }
    function objective(layers, context) {
        let cost = imageError(renderLayers(layers, context), context);
        const usage = new Map();
        for (const layer of layers) for (let i = 1; i < layer.sequence.length; i++) {
            const line = context.raster.line(layer.sequence[i - 1], layer.sequence[i]);
            cost += penalty(line, usage);
            usage.set(line.key, (usage.get(line.key) || 0) + 1);
        }
        return cost;
    }
    function rankedMoves(pin, data, color, suffix, usage, context) {
        const moves = [], n = context.raster.pins.length;
        const minDistance = Math.min(20, Math.max(1, Math.floor(n / 12)));
        for (let to = 0; to < n; to++) {
            const separation = Math.min(Math.abs(to - pin), n - Math.abs(to - pin));
            const edgeTravel = context.edgeTravel && context.raster.side && context.raster.side(pin, to);
            if (separation < minDistance && !edgeTravel) continue;
            const line = context.raster.line(pin, to);
            if (line.length === 0) continue;
            const gain = scoreLine(data, context.target, line, color, context.coverage, suffix, context.displayTarget, context.weights, context.boundaries) - penalty(line, usage);
            moves.push({to, line, gain});
        }
        moves.sort((a, b) => b.gain - a.gain || a.to - b.to);
        return moves;
    }
    // Evaluate two connected moves as a bundle. A harmful first move is legal
    // only when the bundle has positive net value, including material costs.
    function chooseMoves(pin, data, color, suffix, usage, context, budget, lookahead) {
        const moves = rankedMoves(pin, data, color, suffix, usage, context);
        let best = moves.length && moves[0].gain > 0 ? {moves: [moves[0]], gain: moves[0].gain} : {moves: [], gain: 0};
        if (budget < 2 || !lookahead) return best;
        const firstMoves = moves.slice(0, 4);
        if (context.edgeTravel) {
            // Short frame transits can have little immediate image benefit, so
            // reserve beam places for them. They must connect pins on ONE side;
            // crossing a corner is never treated as edge travel. Keep the search
            // bounded: four ordinary candidates plus four nearest edge routes.
            const routes = new Set(firstMoves.map(move => move.line.key));
            for (const move of moves.filter(move => move.line.edge).sort((a, b) => a.line.length - b.line.length || a.to - b.to)) {
                if (routes.has(move.line.key)) continue;
                firstMoves.push(move); routes.add(move.line.key);
                if (firstMoves.length >= 8) break;
            }
        }
        for (const first of firstMoves) {
            const old = new Float64Array(first.line.pixels.length * 3);
            const oldAlpha = data.alpha ? Float64Array.from(first.line.pixels, p => data.alpha[p]) : null;
            let j = 0;
            for (const p of first.line.pixels) for (let c = 0; c < 3; c++) old[j++] = data[p * 3 + c];
            applyLine(data, first.line, color, context.coverage);
            const count = usage.get(first.line.key) || 0;
            usage.set(first.line.key, count + 1);
            const second = rankedMoves(first.to, data, color, suffix, usage, context)[0];
            if (second && first.gain + second.gain > best.gain + 1e-10) best = {moves: [first, second], gain: first.gain + second.gain};
            if (count) usage.set(first.line.key, count); else usage.delete(first.line.key);
            j = 0;
            for (const p of first.line.pixels) for (let c = 0; c < 3; c++) data[p * 3 + c] = old[j++];
            if (oldAlpha) first.line.pixels.forEach((p, i) => { data.alpha[p] = oldAlpha[i]; });
        }
        return best;
    }
    function optimizeLayer(colorIndex, prefix, suffixLayers, budget, context, progress, fixed) {
        const retained = fixed && fixed.sequence.length > 1 ? [fixed] : [];
        const data = renderLayers(prefix.concat(retained), context);
        const suffix = suffixLayers.length ? suffixTransform(suffixLayers, context.palette, context.raster, context.size, context.coverage) : null;
        const usage = usageFor(prefix.concat(retained, suffixLayers), context.raster), color = context.palette[colorIndex];
        let start = 0, bestSeed = -Infinity;
        // Each new spool can be tied on at any nail; sample starting nails.
        for (let pin = 0; !retained.length && pin < context.raster.pins.length; pin += Math.max(1, Math.floor(context.raster.pins.length / 12))) {
            const seed = rankedMoves(pin, data, color, suffix, usage, context)[0];
            if (seed && seed.gain > bestSeed) { bestSeed = seed.gain; start = pin; }
        }
        const sequence = retained.length ? fixed.sequence.slice() : [start];
        let temporaryHarm = retained.length ? fixed.temporaryHarm || 0 : 0, bundles = retained.length ? fixed.bundles || 0 : 0;
        while (sequence.length - 1 < budget) {
            const used = sequence.length - 1;
            let choice = chooseMoves(sequence[used], data, color, suffix, usage, context, budget - used, false);
            // A small beam periodically, and whenever the greedy path stalls.
            if (!choice.moves.length || used % 12 === 0) choice = chooseMoves(sequence[used], data, color, suffix, usage, context, budget - used, true);
            if (!choice.moves.length) break;
            if (choice.moves.length === 2) bundles++;
            for (const move of choice.moves) {
                if (scoreLine(data, context.target, move.line, color, context.coverage, null, context.displayTarget, context.weights, context.boundaries) < -1e-10) temporaryHarm++;
                applyLine(data, move.line, color, context.coverage);
                usage.set(move.line.key, (usage.get(move.line.key) || 0) + 1);
                sequence.push(move.to);
            }
            if (progress && used % 40 === 0) progress(used, budget);
        }
        return {color: colorIndex, sequence, temporaryHarm, bundles};
    }
    function perceived(color) { return color.map(toSrgb); }
    function luminance(color) { return color.reduce((sum, c, i) => sum + CHANNEL_WEIGHTS[i] * c, 0); }
    function detailWeights(displayTarget, mask, width, height) {
        // Give local contrast (outlines, eyes, etc.) a bounded extra vote.
        // Average weight stays one, keeping material costs on the same scale.
        const weights = new Float64Array(mask.length);
        const tone = new Float64Array(mask.length);
        for (let p = 0; p < mask.length; p++) tone[p] = CHANNEL_WEIGHTS[0] * displayTarget[p * 3] +
            CHANNEL_WEIGHTS[1] * displayTarget[p * 3 + 1] + CHANNEL_WEIGHTS[2] * displayTarget[p * 3 + 2];
        const radius = Math.max(2, Math.round(Math.min(width, height) / 24));
        let total = 0, active = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!mask[p]) continue;
            let sum = 0, squared = 0, n = 0;
            for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++)
                for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
                    const q = yy * width + xx;
                    if (!mask[q]) continue;
                    sum += tone[q]; squared += tone[q] * tone[q]; n++;
                }
            const contrast = Math.sqrt(Math.max(0, squared / n - (sum / n) ** 2));
            weights[p] = Math.min(5, 1 + 16 * contrast);
            total += weights[p]; active++;
        }
        if (total) for (let p = 0; p < mask.length; p++) weights[p] *= active / total;
        return weights;
    }
    function choosePalette(target, background, count, mask) {
        const bins = new Map(), board = background === null ? null : perceived(background);
        for (let p = 0; p < target.length / 3; p++) {
            if (!mask[p]) continue;
            const alpha = target.alpha ? target.alpha[p] : 1;
            if (alpha <= 0) continue;
            const color = perceived(Array.from(target.slice(p * 3, p * 3 + 3), c => clamp(c / alpha, 0, 1)));
            // Seed the initial palette with colors that change the bare board.
            // The board color is also tested as actual thread after winding,
            // when it can restore highlights or cover unwanted earlier paths.
            if (board && distance(color, board) < 0.0002) continue;
            const key = color.map(x => Math.floor(x * 31)).join(',');
            if (!bins.has(key)) bins.set(key, {sum: [0, 0, 0], count: 0});
            const bin = bins.get(key); bin.count += alpha;
            for (let c = 0; c < 3; c++) bin.sum[c] += color[c] * alpha;
        }
        const samples = [...bins.values()].map(b => ({color: b.sum.map(v => v / b.count), weight: b.count}));
        samples.sort((a, b) => b.weight - a.weight);
        if (!samples.length) return [];
        const tones = samples.slice().sort((a, b) => luminance(a.color) - luminance(b.color));
        const mass = samples.reduce((sum, s) => sum + s.weight, 0);
        function quantile(q) {
            let accumulated = 0;
            for (const sample of tones) {
                accumulated += sample.weight;
                if (accumulated >= q * mass) return sample.color;
            }
            return tones[tones.length - 1].color;
        }
        // A global brightness percentile can land on an antialiased edge of a
        // small colored object. Never freeze that sample as a cluster center:
        // let every hue settle before considering a true shadow endpoint.
        const dark = quantile(0.02), light = quantile(0.98);
        const centers = [samples[0].color];
        while (centers.length < count) {
            let candidate, score = 0;
            for (const sample of samples) {
                const d = Math.min(...centers.map(c => distance(c, sample.color)));
                const value = d * Math.sqrt(sample.weight);
                if (d > 0.001 && value > score) { candidate = sample.color; score = value; }
            }
            if (!candidate) break;
            centers.push(candidate);
        }
        for (let pass = 0; pass < 8; pass++) {
            const sums = centers.map(() => [0, 0, 0, 0]);
            for (const sample of samples) {
                let best = 0;
                for (let i = 1; i < centers.length; i++) if (distance(centers[i], sample.color) < distance(centers[best], sample.color)) best = i;
                for (let c = 0; c < 3; c++) sums[best][c] += sample.color[c] * sample.weight;
                sums[best][3] += sample.weight;
            }
            for (let i = 0; i < centers.length; i++) if (sums[i][3]) centers[i] = sums[i].slice(0, 3).map(v => v / sums[i][3]);
        }
        // Choose a robust representative of each fitted group. Mixed fringe
        // pixels must not pull a small object's thread toward its background.
        const groups = centers.map(() => []);
        for (const sample of samples) {
            let best = 0;
            for (let i = 1; i < centers.length; i++) if (distance(centers[i], sample.color) < distance(centers[best], sample.color)) best = i;
            groups[best].push(sample);
        }
        for (let i = 0; i < centers.length; i++) {
            if (!groups[i].length) continue;
            const half = groups[i].reduce((sum, s) => sum + s.weight, 0) / 2;
            centers[i] = centers[i].map((value, c) => {
                let weight = 0;
                for (const sample of groups[i].slice().sort((a, b) => a.color[c] - b.color[c])) {
                    weight += sample.weight;
                    if (weight >= half) return sample.color[c];
                }
                return value;
            });
        }
        // Preserve a representative dark endpoint only for an actual shadow
        // cluster, not a small midtone hue such as green leaves. The percentile
        // guards against isolated black noise; it does not suppress an already
        // discovered small dark cluster (e.g. the dove's eye and beak).
        let darkest = 0;
        for (let i = 1; i < centers.length; i++) if (luminance(centers[i]) < luminance(centers[darkest])) darkest = i;
        if (count > 1 && luminance(dark) < 0.2 && luminance(centers[darkest]) < 0.25 &&
                luminance(dark) < luminance(centers[darkest]) && luminance(light) - luminance(dark) > 0.15) {
            centers[darkest] = background === null ? dark : dark.map((c, i) =>
                toSrgb(clamp((toLinear(c) - 0.02 * background[i]) / 0.98, 0, 1)));
        }
        return [...new Set(centers.map(c => hex(c.map(toLinear))))].map(rgb);
    }
    function regionAllocation(target, palette, background, mask, width, height) {
        // This small posterized map only measures regions. Path scoring keeps
        // the original, unquantized target and its signed boundary contrasts.
        const colors = palette.map(perceived), count = palette.length, size = width * height;
        if (background && !palette.some(color => hex(color) === hex(background))) colors.push(perceived(background));
        const labels = new Int16Array(size).fill(-1), visible = new Float64Array(size * 3);
        const nearest = new Float64Array(size), areas = new Array(count).fill(0);
        for (let p = 0; p < size; p++) {
            const alpha = target.alpha ? target.alpha[p] : 1;
            if (!mask[p] || alpha <= 0 || !colors.length) continue;
            const color = Array.from(target.slice(p * 3, p * 3 + 3), c => toSrgb(clamp(c / alpha, 0, 1)));
            visible.set(color, p * 3);
            let best = 0, d = distance(color, colors[0]);
            for (let i = 1; i < colors.length; i++) {
                const candidate = distance(color, colors[i]);
                if (candidate < d) { best = i; d = candidate; }
            }
            labels[p] = best; nearest[p] = d;
        }
        // One conservative cleanup pass: only ambiguous mixed fringe pixels
        // can follow a strong local majority. A close palette match survives
        // even when it is a one-pixel eye or a one-pixel-wide stem.
        const cleaned = labels.slice();
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (labels[p] < 0 || nearest[p] <= 0.0002) continue;
            const votes = new Uint8Array(colors.length);
            for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++)
                for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
                    const q = yy * width + xx;
                    if (q !== p && labels[q] >= 0) votes[labels[q]]++;
                }
            const majority = votes.indexOf(Math.max(...votes));
            if (votes[majority] >= 5 && majority !== labels[p] &&
                    distance(Array.from(visible.slice(p * 3, p * 3 + 3)), colors[majority]) <= nearest[p] * 1.5) cleaned[p] = majority;
        }
        const perimeters = new Array(count).fill(0);
        function edge(p, q) {
            // Ignore the frame perimeter; shared internal boundaries count
            // for both colors. Empty transparent space has no thread budget.
            if (!mask[p] || !mask[q] || cleaned[p] === cleaned[q]) return;
            for (const at of [p, q]) if (cleaned[at] >= 0 && cleaned[at] < count)
                perimeters[cleaned[at]] += target.alpha ? target.alpha[at] : 1;
        }
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const p = y * width + x, color = cleaned[p];
            if (color >= 0 && color < count) areas[color] += target.alpha ? target.alpha[p] : 1;
            if (x + 1 < width) edge(p, p + 1);
            if (y + 1 < height) edge(p, p + width);
        }
        // A uniform image has no internal boundaries but can still need thread.
        return {perimeters, shares: perimeters.some(value => value > 0) ? perimeters : areas, labels: cleaned, areas};
    }
    function apportionLines(shares, budget) {
        const total = shares.reduce((sum, value) => sum + value, 0);
        if (!total) return shares.map(() => 0);
        const exact = shares.map(value => value * budget / total), lines = exact.map(Math.floor);
        const remainder = exact.map((value, color) => ({color, fraction: value - lines[color]}))
            .sort((a, b) => b.fraction - a.fraction || a.color - b.color);
        const left = budget - lines.reduce((sum, value) => sum + value, 0);
        for (let i = 0; i < left; i++) lines[remainder[i].color]++;
        return lines;
    }
    function prepare(options) {
        validateFrame(options);
        const backgroundName = options.background === undefined ? 'transparent' : options.background;
        const colorAllocation = options.colorAllocation === undefined ? 'adaptive' : options.colorAllocation;
        if (!options.rgba || options.rgba.length !== options.width * options.height * 4 || !validBackground(backgroundName) ||
            !['adaptive', 'perimeter'].includes(colorAllocation) ||
            (options.edgeTravel !== undefined && typeof options.edgeTravel !== 'boolean') ||
            (options.regionFeedback !== undefined && typeof options.regionFeedback !== 'boolean') ||
            !Number.isInteger(options.maxColors) || options.maxColors < 1 || options.maxColors > 5 ||
            !Number.isInteger(options.maxLines) || options.maxLines < 1 || options.maxLines > 10000 ||
            !Number.isFinite(options.frameLongestCm) || options.frameLongestCm <= 0 || options.frameLongestCm > 1000 ||
            !Number.isFinite(options.threadDiameterMm) || options.threadDiameterMm <= 0 || options.threadDiameterMm > 5) throw new Error('Invalid color generation settings.');
        const scale = Math.min(1, MAX_WORKING_DIMENSION / Math.max(options.width, options.height));
        const width = Math.max(2, Math.round(options.width * scale)), height = Math.max(2, Math.round(options.height * scale));
        const size = width * height, background = backgroundName === 'transparent' ? null : rgb(backgroundName);
        const target = canvas(size, background), mask = new Uint8Array(size);
        // Area-average premultiplied source pixels in linear light. Only a
        // selected solid board supplies color beneath transparent source pixels.
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (options.shape === 'circle' && ((x + 0.5 - width / 2) / (width / 2)) ** 2 + ((y + 0.5 - height / 2) / (height / 2)) ** 2 > 1) continue;
            mask[p] = 1;
            const sum = [0, 0, 0]; let n = 0, alphaSum = 0;
            for (let sy = Math.floor(y * options.height / height); sy < Math.floor((y + 1) * options.height / height); sy++) {
                for (let sx = Math.floor(x * options.width / width); sx < Math.floor((x + 1) * options.width / width); sx++) {
                    const off = (sy * options.width + sx) * 4, alpha = options.rgba[off + 3] / 255;
                    for (let c = 0; c < 3; c++) sum[c] += alpha * toLinear(options.rgba[off + c] / 255) + (background ? (1 - alpha) * background[c] : 0);
                    alphaSum += alpha;
                    n++;
                }
            }
            for (let c = 0; c < 3; c++) target[p * 3 + c] = sum[c] / n;
            if (target.alpha) target.alpha[p] = alphaSum / n;
        }
        const coverage = clamp(options.threadDiameterMm * (Math.max(width, height) - 1) / (options.frameLongestCm * 10), 0.001, 0.95);
        const displayTarget = Float64Array.from(target, toSrgb);
        if (target.alpha) displayTarget.white = Float64Array.from(target, (value, i) => toSrgb(clamp(value + 1 - target.alpha[Math.floor(i / 3)], 0, 1)));
        const palette = choosePalette(target, background, options.maxColors, mask);
        return {width, height, size, background, backgroundName, target, mask, coverage, displayTarget,
            weights: detailWeights(displayTarget, mask, width, height), raster: rasterizer(options, width, height),
            boundaries: makeBoundaries(displayTarget, mask, width, height),
            palette, edgeTravel: options.shape === 'rectangle' && options.edgeTravel !== false, regionFeedback: options.regionFeedback !== false,
            allocation: colorAllocation === 'perimeter' ? regionAllocation(target, palette, background, mask, width, height) : null};
    }
    function allocateLayers(order, budget, context, progress) {
        const layers = order.map(color => ({color, sequence: [], temporaryHarm: 0, bundles: 0}));
        const targets = context.allocation ? apportionLines(context.allocation.shares, budget) : null;
        // Same-color passes commute in the coverage model. Maintain the image
        // through each layer so we can insert into ANY spool while scoring the
        // actual final winding order, without breaking that spool's path.
        const through = order.map(() => canvas(context.size, context.background));
        const transmission = order.map(() => new Float64Array(context.size).fill(1));
        const usage = new Map();
        let used = 0;
        function suffixFor(index) {
            const t = new Float64Array(context.size).fill(1), overlay = new Float64Array(context.size * 3);
            for (let l = index + 1; l < layers.length; l++)
                for (let p = 0; p < context.size; p++) t[p] *= transmission[l][p];
            const final = through[through.length - 1];
            for (let p = 0; p < context.size; p++) for (let c = 0; c < 3; c++)
                overlay[p * 3 + c] = final[p * 3 + c] - t[p] * through[index][p * 3 + c];
            return {transmission: t, overlay};
        }
        function insert(index, move) {
            const color = context.palette[layers[index].color];
            for (const p of move.line.pixels) {
                for (let c = 0; c < 3; c++) {
                    let delta = context.coverage * (color[c] - through[index][p * 3 + c]);
                    for (let l = index; l < layers.length; l++) {
                        if (l > index) delta *= transmission[l][p];
                        through[l][p * 3 + c] += delta;
                    }
                }
                if (through[index].alpha) {
                    let delta = context.coverage * (1 - through[index].alpha[p]);
                    for (let l = index; l < layers.length; l++) {
                        if (l > index) delta *= transmission[l][p];
                        through[l].alpha[p] += delta;
                    }
                }
                transmission[index][p] *= 1 - context.coverage;
            }
            usage.set(move.line.key, (usage.get(move.line.key) || 0) + 1);
            layers[index].sequence.push(move.to);
            used++;
        }
        function nextBatch(reserved) {
            let best = null;
            for (let i = 0; i < layers.length; i++) {
                const layer = layers[i], spent = Math.max(0, layer.sequence.length - 1);
                const available = Math.min(budget - used, reserved ? Math.max(0, targets[layer.color] - spent) : budget);
                if (!available) continue;
                const color = context.palette[layer.color], data = through[i], suffix = suffixFor(i);
                let start = layer.sequence[layer.sequence.length - 1];
                if (start === undefined) {
                    let seedGain = -Infinity;
                    for (let pin = 0; pin < context.raster.pins.length; pin += Math.max(1, Math.floor(context.raster.pins.length / 12))) {
                        const seed = rankedMoves(pin, data, color, suffix, usage, context)[0];
                        if (seed && seed.gain > seedGain) { seedGain = seed.gain; start = pin; }
                    }
                }
                if (start === undefined) continue;
                let choice = chooseMoves(start, data, color, suffix, usage, context, available, false);
                if (!choice.moves.length) choice = chooseMoves(start, data, color, suffix, usage, context, available, true);
                const rate = choice.moves.length ? choice.gain / choice.moves.length : 0;
                if (rate > 0 && (!best || rate > best.rate)) best = {i, start, suffix, choice, rate, available};
            }
            return best;
        }
        while (used < budget && layers.length) {
            // Honor useful perimeter reservations first. If all remaining
            // reservations are stalled, any spool can use the spare windings.
            // Recheck on the next batch: later coverage can revive a path.
            const best = (targets && nextBatch(true)) || nextBatch(false);
            if (!best) break;
            const {i, suffix} = best, layer = layers[i], color = context.palette[layer.color];
            if (!layer.sequence.length) layer.sequence.push(best.start);
            // Reconsider allocation every 16 lines; keep short move bundles
            // intact and retain material/buildup costs even under later cover.
            const stop = used + Math.min(16, best.available);
            let choice = best.choice;
            while (used < stop && choice.moves.length) {
                if (choice.moves.length > stop - used) choice = chooseMoves(layer.sequence[layer.sequence.length - 1], through[i], color, suffix, usage, context, stop - used, false);
                if (!choice.moves.length) break;
                if (choice.moves.length === 2) layer.bundles++;
                for (const move of choice.moves) {
                    if (scoreLine(through[i], context.target, move.line, color, context.coverage, null, context.displayTarget, context.weights, context.boundaries) < -1e-10) layer.temporaryHarm++;
                    insert(i, move);
                }
                if (used < stop) {
                    choice = chooseMoves(layer.sequence[layer.sequence.length - 1], through[i], color, suffix, usage, context, stop - used, false);
                    if (!choice.moves.length || used % 12 === 0) choice = chooseMoves(layer.sequence[layer.sequence.length - 1], through[i], color, suffix, usage, context, stop - used, true);
                }
            }
            if (progress) progress(used, budget);
        }
        return layers.filter(layer => layer.sequence.length > 1);
    }
    function permutations(values) {
        if (!values.length) return [[]];
        return values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j)).map(rest => [value, ...rest]));
    }
    function reorder(layers, context) {
        let best = layers, bestError = imageError(renderLayers(layers, context), context);
        // Up to five spools: test all actual layer orders (at most 120).
        for (const order of permutations(layers)) {
            const candidate = imageError(renderLayers(order, context), context);
            // Length and buildup are order-independent, so compare image error.
            if (candidate < bestError - 1e-10) { best = order; bestError = candidate; }
        }
        return {layers: best};
    }
    function considerBackgroundThread(layers, context, maxColors, maxLines, progress) {
        const used = new Set(layers.map(layer => layer.color));
        if (context.background === null || !layers.length || maxColors < 2) return {layers, added: false};
        let color = context.palette.findIndex(candidate => hex(candidate) === hex(context.background));
        if (used.has(color)) return {layers, added: false};
        const appended = color < 0;
        if (appended) { color = context.palette.length; context.palette.push(context.background.slice()); }
        let best = layers, bestCost = objective(layers, context);
        // Try an extra spool when there is room, and replacements when colors
        // or lines are already exhausted. Removing a spool frees its entire
        // path budget; retained spools keep their connected paths unchanged.
        const replacements = layers.map((_, i) => i);
        if (used.size < maxColors) replacements.unshift(-1);
        for (let i = 0; i < replacements.length; i++) {
            if (progress) progress(i, replacements.length);
            const prefix = layers.filter((_, index) => index !== replacements[i]);
            const budget = maxLines - prefix.reduce((sum, layer) => sum + layer.sequence.length - 1, 0);
            if (budget < 1) continue;
            const replacement = optimizeLayer(color, prefix, [], budget, context);
            if (replacement.sequence.length < 2) continue;
            const trial = prefix.concat(replacement), cost = objective(trial, context);
            // White is not mandatory: its complete benefit must outweigh the
            // lost color, all damaged pixels, and material/buildup costs.
            if (cost < bestCost - 1e-10) { best = trial; bestCost = cost; }
        }
        if (best === layers && appended) context.palette.pop();
        return {layers: best, added: best !== layers};
    }
    function feedbackContext(context) {
        const regions = regionAllocation(context.target, context.palette, context.background, context.mask, context.width, context.height);
        const mass = regions.areas.reduce((sum, area) => sum + area, 0);
        const colors = regions.areas.filter(area => area > 0).length;
        const factors = new Float64Array(context.size).fill(1), weights = new Float64Array(context.size);
        let originalWeight = 0, weighted = 0;
        for (let p = 0; p < context.size; p++) {
            const color = regions.labels[p], area = regions.areas[color] || 0;
            // Give each visible color a bounded regional vote in addition to
            // ordinary image error. Never let an arbitrarily tiny patch acquire
            // an arbitrarily large weight. These weights stay FIXED throughout
            // feedback, so every accepted change improves the same objective.
            if (area) factors[p] += Math.min(15, mass / (colors * area));
            const original = context.weights ? context.weights[p] : context.mask[p];
            weights[p] = original * factors[p];
            originalWeight += original; weighted += weights[p];
        }
        const normalization = weighted ? originalWeight / weighted : 1;
        for (let p = 0; p < context.size; p++) { weights[p] *= normalization; factors[p] *= normalization; }
        const boundaries = context.boundaries ? {...context.boundaries, regionWeights: factors,
            // Candidate stamps/counters cannot be shared with the unweighted
            // context: it is still used by the whole-image quality guard.
            stamp: new Uint32Array(context.size), serial: 0,
            before: new Float64Array(context.size * 6), delta: new Float64Array(context.size * 6)} : null;
        return {...context, weights, boundaries, regions};
    }
    function regionErrors(data, context, regions) {
        const errors = regions.areas.map(area => ({area, colorError: 0, boundaryError: 0, boundaryMass: 0}));
        const {target, displayTarget, boundaries: b} = context;
        for (let p = 0; p < context.size; p++) {
            const region = errors[regions.labels[p]];
            if (!region) continue;
            const alpha = target.alpha ? target.alpha[p] : 1;
            for (let c = 0; c < 3; c++) {
                const i = p * 3 + c;
                region.colorError += alpha * (data.alpha ? transparentError(data[i], data.alpha[p], displayTarget[i], displayTarget.white[i]) :
                    (displayValue(data[i]) - displayTarget[i]) ** 2) / 3;
            }
        }
        if (b) for (let e = 0; e < b.from.length; e++) {
            const p = b.from[e], q = b.to[e];
            let error = 0;
            for (let c = 0; c < 3; c++) {
                const a = p * 3 + c, z = q * 3 + c;
                error += (displayValue(data[a]) - displayValue(data[z]) - (displayTarget[a] - displayTarget[z])) ** 2;
                if (data.alpha) error += (displayValue(data[a] + 1 - data.alpha[p]) - displayValue(data[z] + 1 - data.alpha[q]) -
                    (displayTarget.white[a] - displayTarget.white[z])) ** 2;
            }
            error /= data.alpha ? 6 : 3;
            for (const at of [p, q]) {
                const region = errors[regions.labels[at]], alpha = target.alpha ? target.alpha[at] : 1;
                if (region) { region.boundaryError += error * alpha; region.boundaryMass += alpha; }
            }
        }
        const mass = regions.areas.reduce((sum, area) => sum + area, 0);
        return errors.map((error, color) => {
            const meanColorError = error.area ? error.colorError / error.area : 0;
            const meanBoundaryError = error.boundaryMass ? error.boundaryError / error.boundaryMass : 0;
            return {color, area: error.area, meanColorError, meanBoundaryError,
                priority: (meanColorError + 2 * meanBoundaryError) * Math.min(1, error.area / Math.max(1, mass * 0.005))};
        });
    }
    const windingCount = layers => layers.reduce((sum, layer) => sum + Math.max(0, layer.sequence.length - 1), 0);
    function trimLayer(layers, index, count) {
        const trial = layers.slice(), layer = layers[index];
        const keep = Math.max(1, layer.sequence.length - count);
        if (keep === 1) trial.splice(index, 1);
        else trial[index] = {...layer, sequence: layer.sequence.slice(0, keep)};
        return trial;
    }
    function rebalanceRegions(initial, context, maxColors, maxLines, progress = () => {}) {
        const disabled = {layers: initial, stats: {enabled: false}};
        if (!context.regionFeedback) return disabled;
        const balanced = feedbackContext(context), {regions} = balanced;
        const stats = {enabled: true, method: 'bounded-region-feedback-v1', maxLines, attempts: 0,
            rounds: 0, stopReason: 'not-needed', history: []};
        const batch = Math.min(16, Math.max(1, Math.floor(maxLines / 20)));
        let layers = initial, cost = objective(layers, balanced);
        const initialImage = renderLayers(layers, context);
        const initialGlobal = imageError(initialImage, context);
        const initialPixel = pixelError(initialImage, context.target, context.displayTarget, context.weights);
        stats.initialError = cost;
        stats.initialRegions = regionErrors(initialImage, context, regions);
        function candidate(trial) {
            stats.attempts++;
            if (windingCount(trial) > maxLines || new Set(trial.map(layer => layer.color)).size > maxColors) return Infinity;
            const score = objective(trial, balanced);
            if (score >= cost - 1e-10) return Infinity;
            const data = renderLayers(trial, context);
            // Protect the rest of the picture while improving small regions.
            // Both guards refer to the ORIGINAL finished plan, so repeated
            // accepted steps cannot accumulate an unlimited global regression.
            if (imageError(data, context) > initialGlobal * 1.03 + 1e-10 ||
                pixelError(data, context.target, context.displayTarget, context.weights) > initialPixel * 1.03 + 1e-10) return Infinity;
            return score;
        }
        function accept(trial, next, details) {
            stats.history.push({...details, before: cost, after: next,
                linesBefore: windingCount(layers), linesAfter: windingCount(trial)});
            layers = trial; cost = next;
        }
        if (regions.areas.filter(area => area > 0).length > 1 && maxLines > 1) {
            // First give the existing allocations a chance to follow the newly
            // weighted regions. A reservation is not useful if its paths miss.
            const colors = layers.map(layer => layer.color);
            for (let n = 0; n < colors.length; n++) {
                progress({stage: 'Improving color regions', completed: n, total: colors.length});
                const index = layers.findIndex(layer => layer.color === colors[n]);
                if (index < 0) continue;
                const replacement = optimizeLayer(colors[n], layers.slice(0, index), layers.slice(index + 1),
                    layers[index].sequence.length - 1, balanced);
                const trial = layers.slice(); trial[index] = replacement;
                const valid = trial.filter(layer => layer.sequence.length > 1), next = candidate(valid);
                if (Number.isFinite(next)) accept(valid, next, {kind: 'refine', color: colors[n]});
            }
            // At most 12 rounds and four donor/receiver trials per round. Tail
            // removal preserves a donor's path. Rebuild only the receiver's last
            // 16 moves plus its new allowance to bound runtime and keep a single
            // continuous spool. A missing palette color may also be revived.
            for (let round = 0; round < 12; round++) {
                stats.rounds = round + 1;
                stats.stopReason = 'no-improving-transfer';
                progress({stage: 'Redistributing windings', completed: round, total: 12});
                const used = windingCount(layers), free = maxLines - used;
                const errors = regionErrors(renderLayers(layers, context), context, regions);
                const recipients = errors.filter(error => error.area > 0 && error.priority > 0)
                    .sort((a, b) => b.priority - a.priority || a.color - b.color).slice(0, 2);
                const donors = layers.map((layer, index) => {
                    const trial = trimLayer(layers, index, batch);
                    return {color: layer.color, trial, score: objective(trial, balanced)};
                }).sort((a, b) => a.score - b.score || a.color - b.color);
                let best = null;
                // Removing unhelpful tail windings can itself be the best move.
                for (const donor of donors) {
                    const next = candidate(donor.trial);
                    if (Number.isFinite(next) && (!best || next < best.score)) best = {...donor, score: next,
                        details: {kind: 'remove', from: donor.color}};
                }
                for (const recipient of recipients) {
                    const sources = free > 0 ? [{color: null, trial: layers}] : [];
                    if (free < batch) sources.push(...donors.filter(donor => donor.color !== recipient.color).slice(0, 2 - sources.length));
                    for (const donor of sources) {
                        const trial = donor.trial.slice();
                        let index = trial.findIndex(layer => layer.color === recipient.color);
                        if (index < 0) {
                            if (trial.length >= maxColors) continue;
                            index = trial.length;
                            trial.push({color: recipient.color, sequence: [], temporaryHarm: 0, bundles: 0});
                        }
                        const existing = trial[index], count = Math.max(0, existing.sequence.length - 1);
                        const extra = Math.min(batch, maxLines - windingCount(trial));
                        if (extra <= 0) continue;
                        const fixed = {...existing, sequence: existing.sequence.slice(0, Math.max(1, existing.sequence.length - 16))};
                        trial[index] = optimizeLayer(recipient.color, trial.slice(0, index), trial.slice(index + 1), count + extra, balanced, null, fixed);
                        const valid = trial.filter(layer => layer.sequence.length > 1), next = candidate(valid);
                        if (Number.isFinite(next) && (!best || next < best.score)) best = {trial: valid, score: next,
                            details: {kind: 'transfer', from: donor.color, to: recipient.color}};
                    }
                }
                if (!best) break;
                accept(best.trial, best.score, best.details);
                stats.stopReason = 'round-limit';
            }
        }
        stats.finalError = cost;
        stats.finalRegions = regionErrors(renderLayers(layers, context), context, regions);
        stats.initialLines = windingCount(initial); stats.finalLines = windingCount(layers);
        for (const list of [stats.initialRegions, stats.finalRegions]) for (const error of list) error.color = hex(context.palette[error.color]);
        for (const change of stats.history) for (const key of ['color', 'from', 'to'])
            if (change[key] !== undefined && change[key] !== null) change[key] = hex(context.palette[change[key]]);
        return {layers, stats};
    }
    function plan(options, progress = () => {}) {
        const context = prepare(options), palette = context.palette;
        const original = palette.map((_, i) => i);
        const lightFirst = original.slice().sort((a, b) => distance(palette[b], [0, 0, 0]) - distance(palette[a], [0, 0, 0]));
        const orders = [...new Map([original, lightFirst, lightFirst.slice().reverse()].map(o => [o.join(','), o])).values()];
        let bestOrder = original, pilotScore = Infinity;
        for (let i = 0; i < orders.length; i++) {
            progress({stage: 'Comparing color orders', completed: i, total: orders.length});
            const trial = allocateLayers(orders[i], Math.min(100, options.maxLines), context);
            const score = objective(trial, context);
            if (score < pilotScore) { bestOrder = orders[i]; pilotScore = score; }
        }
        progress({stage: 'Planning color paths', completed: 0, total: options.maxLines});
        let layers = allocateLayers(bestOrder, options.maxLines, context,
            (used, total) => progress({stage: 'Planning a color path', completed: used, total}));
        progress({stage: 'Comparing finished layer orders', completed: 0, total: 1});
        layers = reorder(layers, context).layers;
        let refinedLayers = 0;
        // Rebuild each earlier spool against the actual fixed later windings.
        // The affine suffix transform credits only their simulated coverage.
        for (let i = 0; i < layers.length; i++) {
            progress({stage: 'Refining travel beneath later colors', completed: i, total: layers.length});
            const used = layers.reduce((sum, layer) => sum + layer.sequence.length - 1, 0);
            const budget = layers[i].sequence.length - 1 + options.maxLines - used;
            const replacement = optimizeLayer(layers[i].color, layers.slice(0, i), layers.slice(i + 1), budget, context);
            const trial = layers.slice();
            trial[i] = replacement;
            if (objective(trial, context) < objective(layers, context) - 1e-10) { layers = trial; refinedLayers++; }
        }
        layers = reorder(layers.filter(l => l.sequence.length > 1), context).layers;
        const backgroundThread = considerBackgroundThread(layers, context, options.maxColors, options.maxLines,
            (completed, total) => progress({stage: 'Checking background-colored thread', completed, total}));
        layers = backgroundThread.added ? reorder(backgroundThread.layers, context).layers : layers;
        const feedback = rebalanceRegions(layers, context, options.maxColors, options.maxLines, progress);
        layers = feedback.layers;
        const usedColors = [...new Set(layers.map(l => l.color))];
        const finalImage = renderLayers(layers, context);
        const targetLines = context.allocation ? apportionLines(context.allocation.shares, options.maxLines) : [];
        const saved = {
            version: 2, mode: 'color', shape: options.shape, width: options.width, height: options.height,
            horizontalPins: options.horizontalPins, verticalPins: options.verticalPins, pinCount: makePins(options).length,
            background: context.backgroundName, palette: usedColors.map(i => hex(palette[i])),
            frameLongestCm: options.frameLongestCm, threadDiameterMm: options.threadDiameterMm,
            maxLines: options.maxLines,
            render: {model: context.background === null ? TRANSPARENT_MODEL : MODEL, width: context.width, height: context.height, coverage: context.coverage},
            layers: layers.map(l => ({color: usedColors.indexOf(l.color), sequence: l.sequence})),
            stats: {errorMetric: context.background === null ? 'detail-boundary-srgb-two-backdrops-v1' : 'detail-boundary-srgb-v1',
                allocation: context.allocation ? {method: 'region-perimeter-v1', colors: palette.map((color, i) => ({
                    color: hex(color), perimeter: context.allocation.perimeters[i] || 0, targetLines: targetLines[i] || 0,
                    actualLines: layers.filter(layer => layer.color === i).reduce((sum, layer) => sum + layer.sequence.length - 1, 0)}))} :
                    {method: 'shared-gain-v1'},
                edgeTravelEnabled: context.edgeTravel,
                feedback: feedback.stats,
                backgroundThreadAdded: backgroundThread.added,
                initialError: imageError(canvas(context.size, context.background), context),
                finalError: imageError(finalImage, context),
                pixelError: pixelError(finalImage, context.target, context.displayTarget, context.weights),
                boundaryError: boundaryError(finalImage, context.boundaries), refinedLayers,
                temporaryHarmMoves: layers.reduce((n, l) => n + l.temporaryHarm, 0),
                lookaheadBundles: layers.reduce((n, l) => n + l.bundles, 0)}
        };
        validatePlan(saved);
        progress({stage: 'Complete', completed: 1, total: 1});
        return saved;
    }
    function render(plan, limit = Infinity) {
        validatePlan(plan);
        const {width, height, coverage} = plan.render;
        const context = {size: width * height, background: plan.background === 'transparent' ? null : rgb(plan.background), palette: plan.palette.map(rgb),
            raster: rasterizer(plan, width, height), coverage};
        const data = renderLayers(plan.layers, context, limit), rgba = new Uint8ClampedArray(width * height * 4);
        for (let p = 0; p < width * height; p++) {
            const alpha = data.alpha ? clamp(data.alpha[p], 0, 1) : 1;
            for (let c = 0; c < 3; c++) rgba[p * 4 + c] = alpha ? Math.round(clamp(toSrgb(data[p * 3 + c] / alpha), 0, 1) * 255) : 0;
            rgba[p * 4 + 3] = Math.round(alpha * 255);
            if (plan.shape === 'circle' && ((p % width + 0.5 - width / 2) / (width / 2)) ** 2 + ((Math.floor(p / width) + 0.5 - height / 2) / (height / 2)) ** 2 > 1) rgba[p * 4 + 3] = 0;
        }
        return {width, height, rgba};
    }
    function steps(plan) {
        const result = [], pins = makePins(plan);
        for (let l = 0; l < plan.layers.length; l++) {
            const layer = plan.layers[l];
            for (let i = 1; i < layer.sequence.length; i++) result.push({layer: l, color: layer.color,
                from: layer.sequence[i - 1], to: layer.sequence[i], tieOn: i === 1, tieOff: i === layer.sequence.length - 1,
                edge: segmentSide(plan, pins[layer.sequence[i - 1]], pins[layer.sequence[i]])});
        }
        return result;
    }
    function shoppingList(plan) {
        validatePlan(plan);
        const pins = makePins(plan), metresPerPixel = plan.frameLongestCm / 100 / Math.max(plan.width - 1, plan.height - 1);
        return plan.palette.map((color, index) => {
            let metres = 0, lines = 0;
            const layers = [];
            plan.layers.forEach((layer, i) => {
                if (layer.color !== index) return;
                layers.push(i + 1);
                for (let j = 1; j < layer.sequence.length; j++) {
                    const a = pins[layer.sequence[j - 1]], b = pins[layer.sequence[j]];
                    metres += Math.hypot(a[0] - b[0], a[1] - b[1]) * metresPerPixel;
                    lines++;
                }
            });
            // Explicit planning allowance, not a measured nail-wrap estimate.
            return {color, layers, lines, pathMetres: metres, suggestedMetres: Math.ceil(metres * 1.2 + layers.length)};
        });
    }
    return {plan, render, steps, shoppingList, validatePlan, makePins, MAX_SOURCE_DIMENSION,
        // Export numerical primitives for small, hand-verifiable regressions.
        rgb, hex, canvas, pixelError, applyLine, scoreLine, suffixTransform, choosePalette,
        rasterizer, chooseMoves, objective, prepare, reorder, detailWeights, allocateLayers, considerBackgroundThread,
        makeBoundaries, boundaryError, imageError, regionAllocation, apportionLines,
        feedbackContext, regionErrors, rebalanceRegions};
});

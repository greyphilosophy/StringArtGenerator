/* Dependency-free color planner, shared by the worker, playback and Node tests. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ColorPlanner = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
    'use strict';
    const MODEL = 'linear-coverage-v1';
    const CHANNEL_WEIGHTS = [0.2126, 0.7152, 0.0722];
    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    const toLinear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    const toSrgb = x => x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
    const rgb = hex => [1, 3, 5].map(i => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
    const hex = color => '#' + color.map(x => Math.round(clamp(toSrgb(x), 0, 1) * 255).toString(16).padStart(2, '0')).join('');
    const validHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
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
        if (!['circle', 'rectangle'].includes(frame.shape) || !int(frame.width, 2, 500) || !int(frame.height, 2, 500) ||
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
        if (!validHex(plan.background) || !Array.isArray(plan.palette) || plan.palette.length > 5 || !plan.palette.every(validHex) ||
            !render || render.model !== MODEL || !Number.isInteger(render.width) || !Number.isInteger(render.height) ||
            render.width < 2 || render.height < 2 || render.width > 200 || render.height > 200 ||
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
        return plan;
    }
    function canvas(size, background) {
        const data = new Float64Array(size * 3);
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
            error += (weights ? weights[Math.floor(i / 3)] : 1) * (displayTarget ? (displayValue(data[i]) - displayTarget[i]) ** 2 / 3 :
                CHANNEL_WEIGHTS[i % 3] * (data[i] - target[i]) ** 2);
        }
        return error;
    }
    // Partial pixel coverage models opaque, thin threads viewed from a distance.
    // It is deliberately not RGB light addition or a claim of perfect occlusion.
    function applyLine(data, line, color, coverage) {
        for (const pixel of line.pixels) {
            const offset = pixel * 3;
            for (let c = 0; c < 3; c++) data[offset + c] += coverage * (color[c] - data[offset + c]);
        }
    }
    function scoreLine(data, target, line, color, coverage, suffix, displayTarget, weights) {
        let gain = 0;
        for (const pixel of line.pixels) {
            const offset = pixel * 3;
            const transmission = suffix ? suffix.transmission[pixel] : 1;
            for (let c = 0; c < 3; c++) {
                const old = data[offset + c];
                const overlay = suffix ? suffix.overlay[offset + c] : 0;
                const oldFinal = transmission * old + overlay;
                const newFinal = transmission * (old + coverage * (color[c] - old)) + overlay;
                const before = displayTarget ? displayValue(oldFinal) - displayTarget[offset + c] : oldFinal - target[offset + c];
                const after = displayTarget ? displayValue(newFinal) - displayTarget[offset + c] : newFinal - target[offset + c];
                gain += (weights ? weights[pixel] : 1) * (displayTarget ? 1 / 3 : CHANNEL_WEIGHTS[c]) * (before * before - after * after);
            }
        }
        return gain;
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
                const line = {key, pixels: Uint32Array.from(pixels), length};
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
        let cost = pixelError(renderLayers(layers, context), context.target, context.displayTarget, context.weights);
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
            if (separation < minDistance) continue;
            const line = context.raster.line(pin, to);
            if (line.length === 0) continue;
            const gain = scoreLine(data, context.target, line, color, context.coverage, suffix, context.displayTarget, context.weights) - penalty(line, usage);
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
        for (const first of moves.slice(0, 4)) {
            const old = new Float64Array(first.line.pixels.length * 3);
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
        }
        return best;
    }
    function optimizeLayer(colorIndex, prefix, suffixLayers, budget, context, progress) {
        const data = renderLayers(prefix, context);
        const suffix = suffixLayers.length ? suffixTransform(suffixLayers, context.palette, context.raster, context.size, context.coverage) : null;
        const usage = usageFor(prefix.concat(suffixLayers), context.raster), color = context.palette[colorIndex];
        let start = 0, bestSeed = -Infinity;
        // Each new spool can be tied on at any nail; sample starting nails.
        for (let pin = 0; pin < context.raster.pins.length; pin += Math.max(1, Math.floor(context.raster.pins.length / 12))) {
            const seed = rankedMoves(pin, data, color, suffix, usage, context)[0];
            if (seed && seed.gain > bestSeed) { bestSeed = seed.gain; start = pin; }
        }
        const sequence = [start];
        let temporaryHarm = 0, bundles = 0;
        while (sequence.length - 1 < budget) {
            const used = sequence.length - 1;
            let choice = chooseMoves(sequence[used], data, color, suffix, usage, context, budget - used, false);
            // A small beam periodically, and whenever the greedy path stalls.
            if (!choice.moves.length || used % 12 === 0) choice = chooseMoves(sequence[used], data, color, suffix, usage, context, budget - used, true);
            if (!choice.moves.length) break;
            if (choice.moves.length === 2) bundles++;
            for (const move of choice.moves) {
                if (scoreLine(data, context.target, move.line, color, context.coverage, null, context.displayTarget, context.weights) < -1e-10) temporaryHarm++;
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
        const bins = new Map(), board = perceived(background);
        for (let p = 0; p < target.length / 3; p++) {
            if (!mask[p]) continue;
            const color = perceived(Array.from(target.slice(p * 3, p * 3 + 3)));
            if (distance(color, board) < 0.0002) continue;
            const key = color.map(x => Math.floor(x * 31)).join(',');
            if (!bins.has(key)) bins.set(key, {sum: [0, 0, 0], count: 0});
            const bin = bins.get(key); bin.count++;
            for (let c = 0; c < 3; c++) bin.sum[c] += color[c];
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
        // Keep a robust dark endpoint rather than averaging the pupils/outlines
        // into the dominant midtone. A single noisy black pixel cannot set it.
        const dark = quantile(0.02), light = quantile(0.98);
        const preserveDark = count > 1 && luminance(light) - luminance(dark) > 0.15;
        // Thread seen through small light gaps must be darker than the
        // desired shadow. Reserve 2% background contribution at this endpoint.
        const shadowThread = dark.map((c, i) => toSrgb(clamp((toLinear(c) - 0.02 * background[i]) / 0.98, 0, 1)));
        const centers = [preserveDark ? shadowThread : samples[0].color];
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
            for (let i = preserveDark ? 1 : 0; i < centers.length; i++) if (sums[i][3]) centers[i] = sums[i].slice(0, 3).map(v => v / sums[i][3]);
        }
        return [...new Set(centers.map(c => hex(c.map(toLinear))))].map(rgb);
    }
    function prepare(options) {
        validateFrame(options);
        if (!options.rgba || options.rgba.length !== options.width * options.height * 4 || !validHex(options.background) ||
            !Number.isInteger(options.maxColors) || options.maxColors < 1 || options.maxColors > 5 ||
            !Number.isInteger(options.maxLines) || options.maxLines < 1 || options.maxLines > 10000 ||
            !Number.isFinite(options.frameLongestCm) || options.frameLongestCm <= 0 || options.frameLongestCm > 1000 ||
            !Number.isFinite(options.threadDiameterMm) || options.threadDiameterMm <= 0 || options.threadDiameterMm > 5) throw new Error('Invalid color generation settings.');
        const scale = Math.min(1, 160 / Math.max(options.width, options.height));
        const width = Math.max(2, Math.round(options.width * scale)), height = Math.max(2, Math.round(options.height * scale));
        const size = width * height, background = rgb(options.background), target = canvas(size, background), mask = new Uint8Array(size);
        // Area-average source pixels in linear light, compositing transparency
        // on the chosen board color before palette selection or scoring.
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (options.shape === 'circle' && ((x + 0.5 - width / 2) / (width / 2)) ** 2 + ((y + 0.5 - height / 2) / (height / 2)) ** 2 > 1) continue;
            mask[p] = 1;
            const sum = [0, 0, 0]; let n = 0;
            for (let sy = Math.floor(y * options.height / height); sy < Math.floor((y + 1) * options.height / height); sy++) {
                for (let sx = Math.floor(x * options.width / width); sx < Math.floor((x + 1) * options.width / width); sx++) {
                    const off = (sy * options.width + sx) * 4, alpha = options.rgba[off + 3] / 255;
                    for (let c = 0; c < 3; c++) sum[c] += alpha * toLinear(options.rgba[off + c] / 255) + (1 - alpha) * background[c];
                    n++;
                }
            }
            for (let c = 0; c < 3; c++) target[p * 3 + c] = sum[c] / n;
        }
        const coverage = clamp(options.threadDiameterMm * (Math.max(width, height) - 1) / (options.frameLongestCm * 10), 0.001, 0.95);
        const displayTarget = Float64Array.from(target, toSrgb);
        return {width, height, size, background, target, mask, coverage, displayTarget,
            weights: detailWeights(displayTarget, mask, width, height), raster: rasterizer(options, width, height),
            palette: choosePalette(target, background, options.maxColors, mask)};
    }
    function allocateLayers(order, budget, context, progress) {
        const layers = order.map(color => ({color, sequence: [], temporaryHarm: 0, bundles: 0}));
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
                transmission[index][p] *= 1 - context.coverage;
            }
            usage.set(move.line.key, (usage.get(move.line.key) || 0) + 1);
            layers[index].sequence.push(move.to);
            used++;
        }
        while (used < budget && layers.length) {
            let best = null;
            for (let i = 0; i < layers.length; i++) {
                const layer = layers[i], color = context.palette[layer.color], data = through[i], suffix = suffixFor(i);
                let start = layer.sequence[layer.sequence.length - 1];
                if (start === undefined) {
                    let seedGain = -Infinity;
                    for (let pin = 0; pin < context.raster.pins.length; pin += Math.max(1, Math.floor(context.raster.pins.length / 12))) {
                        const seed = rankedMoves(pin, data, color, suffix, usage, context)[0];
                        if (seed && seed.gain > seedGain) { seedGain = seed.gain; start = pin; }
                    }
                }
                if (start === undefined) continue;
                let choice = chooseMoves(start, data, color, suffix, usage, context, budget - used, false);
                if (!choice.moves.length) choice = chooseMoves(start, data, color, suffix, usage, context, budget - used, true);
                const rate = choice.moves.length ? choice.gain / choice.moves.length : 0;
                if (rate > 0 && (!best || rate > best.rate)) best = {i, start, suffix, choice, rate};
            }
            if (!best) break;
            const {i, suffix} = best, layer = layers[i], color = context.palette[layer.color];
            if (!layer.sequence.length) layer.sequence.push(best.start);
            // Reconsider allocation every 16 lines; keep short move bundles
            // intact and retain material/buildup costs even under later cover.
            const stop = Math.min(budget, used + 16);
            let choice = best.choice;
            while (used < stop && choice.moves.length) {
                if (choice.moves.length > stop - used) choice = chooseMoves(layer.sequence[layer.sequence.length - 1], through[i], color, suffix, usage, context, stop - used, false);
                if (!choice.moves.length) break;
                if (choice.moves.length === 2) layer.bundles++;
                for (const move of choice.moves) {
                    if (scoreLine(through[i], context.target, move.line, color, context.coverage, null, context.displayTarget, context.weights) < -1e-10) layer.temporaryHarm++;
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
        let best = layers, bestError = pixelError(renderLayers(layers, context), context.target, context.displayTarget, context.weights);
        // Up to five spools: test all actual layer orders (at most 120).
        for (const order of permutations(layers)) {
            const candidate = pixelError(renderLayers(order, context), context.target, context.displayTarget, context.weights);
            // Length and buildup are order-independent, so compare image error.
            if (candidate < bestError - 1e-10) { best = order; bestError = candidate; }
        }
        return {layers: best};
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
        const usedColors = [...new Set(layers.map(l => l.color))];
        const saved = {
            version: 2, mode: 'color', shape: options.shape, width: options.width, height: options.height,
            horizontalPins: options.horizontalPins, verticalPins: options.verticalPins, pinCount: makePins(options).length,
            background: options.background, palette: usedColors.map(i => hex(palette[i])),
            frameLongestCm: options.frameLongestCm, threadDiameterMm: options.threadDiameterMm,
            render: {model: MODEL, width: context.width, height: context.height, coverage: context.coverage},
            layers: layers.map(l => ({color: usedColors.indexOf(l.color), sequence: l.sequence})),
            stats: {errorMetric: 'detail-weighted-srgb-v1',
                initialError: pixelError(canvas(context.size, context.background), context.target, context.displayTarget, context.weights),
                finalError: pixelError(renderLayers(layers, context), context.target, context.displayTarget, context.weights), refinedLayers,
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
        const context = {size: width * height, background: rgb(plan.background), palette: plan.palette.map(rgb),
            raster: rasterizer(plan, width, height), coverage};
        const data = renderLayers(plan.layers, context, limit), rgba = new Uint8ClampedArray(width * height * 4);
        for (let p = 0; p < width * height; p++) {
            for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(clamp(toSrgb(data[p * 3 + c]), 0, 1) * 255);
            rgba[p * 4 + 3] = 255;
            if (plan.shape === 'circle' && ((p % width + 0.5 - width / 2) / (width / 2)) ** 2 + ((Math.floor(p / width) + 0.5 - height / 2) / (height / 2)) ** 2 > 1) rgba[p * 4 + 3] = 0;
        }
        return {width, height, rgba};
    }
    function steps(plan) {
        const result = [];
        for (let l = 0; l < plan.layers.length; l++) {
            const layer = plan.layers[l];
            for (let i = 1; i < layer.sequence.length; i++) result.push({layer: l, color: layer.color,
                from: layer.sequence[i - 1], to: layer.sequence[i], tieOn: i === 1, tieOff: i === layer.sequence.length - 1});
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
    return {plan, render, steps, shoppingList, validatePlan, makePins,
        // Export numerical primitives for small, hand-verifiable regressions.
        rgb, hex, canvas, pixelError, applyLine, scoreLine, suffixTransform, choosePalette,
        rasterizer, chooseMoves, objective, prepare, reorder, detailWeights, allocateLayers};
});

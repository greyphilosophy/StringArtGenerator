const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../color-planner.js');
const srgb = x => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
const linear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const line = (...pixels) => ({pixels: Uint32Array.from(pixels), length: pixels.length, key: pixels.join(',')});
const copy = data => data.alpha ? Object.assign(data.slice(), {alpha: data.alpha.slice()}) : data.slice();

test('a small olive region keeps its hue even when the dark percentile falls in its mixed fringe', () => {
    const colors = [['#1e87ea', 5000], ['#fcfdfd', 3500], ['#c4d3e7', 1250],
        ['#4d762f', 120], ['#447a79', 100], ['#121f53', 30]];
    const target = C.canvas(10000, null); target.alpha.fill(1);
    let offset = 0;
    for (const [color, count] of colors) for (let i = 0; i < count; i++) { target.set(C.rgb(color), offset); offset += 3; }
    const palette = C.choosePalette(target, null, 5, new Uint8Array(10000).fill(1)).map(C.hex);
    assert.equal(palette.length, 5);
    for (const [color] of colors.filter(([color]) => color !== '#447a79')) assert.ok(palette.includes(color), `missing ${color} in ${palette}`);
    assert.deepEqual(palette, C.choosePalette(target, null, 5, new Uint8Array(10000).fill(1)).map(C.hex));
});

test('boundary error distinguishes a preserved gray seam from blurred or reversed contrast at the same pixel error', () => {
    const width = 6, height = 4, target = C.canvas(width * height, [0, 0, 0]);
    const preserved = target.slice(), blurred = target.slice(), reversed = target.slice();
    for (let p = 0; p < width * height; p++) {
        const left = p % width < width / 2, tone = left ? 0.8 : 0.6;
        for (let c = 0; c < 3; c++) {
            target[p * 3 + c] = linear(tone);
            preserved[p * 3 + c] = linear(tone + 0.05);
            blurred[p * 3 + c] = linear(tone + (left ? -0.05 : 0.05));
            reversed[p * 3 + c] = linear(left ? 0.6 : 0.8);
        }
    }
    const displayTarget = Float64Array.from(target, srgb);
    const boundaries = C.makeBoundaries(displayTarget, new Uint8Array(width * height).fill(1), width, height);
    close(C.pixelError(preserved, target, displayTarget), C.pixelError(blurred, target, displayTarget));
    close(C.boundaryError(preserved, boundaries), 0);
    assert.ok(C.boundaryError(blurred, boundaries) > 0);
    assert.ok(C.boundaryError(reversed, boundaries) > C.boundaryError(blurred, boundaries));
});

test('path selection prefers restoring a boundary over an equally useful interior stroke', () => {
    const width = 6, height = 4, size = width * height;
    const target = C.canvas(size, [0, 0, 0]), data = C.canvas(size, [linear(0.7), linear(0.7), linear(0.7)]);
    for (let p = 0; p < size; p++) target.fill(linear(p % width < 3 ? 0.8 : 0.6), p * 3, p * 3 + 3);
    const visible = Float64Array.from(target, srgb);
    // Both strokes brighten two identical left-side pixels. Only the second
    // restores contrast across the gray seam; the first is in a flat interior.
    const interior = line(0, 6), seam = line(2, 8);
    const context = {target, displayTarget: visible, coverage: 0.25,
        raster: {pins: [0, 1, 2], line: (from, to) => to === 1 ? interior : seam}};
    const color = [linear(0.9), linear(0.9), linear(0.9)], untouched = data.slice();
    const choose = context => C.chooseMoves(0, data, color, null, new Map(), context, 1, false);
    assert.equal(choose(context).moves[0].to, 1, 'pixel-only scoring breaks the equal-gain tie by pin number');
    context.boundaries = C.makeBoundaries(visible, new Uint8Array(size).fill(1), width, height);
    assert.equal(choose(context).moves[0].to, 2, 'the real path selector uses the boundary gain');
    assert.deepEqual(data, untouched);
});

test('a fitted small dark color is never brightened to the global shadow percentile', () => {
    const target = C.canvas(1000, C.rgb('#dddddd'));
    for (let p = 0; p < 100; p++) target.set(C.rgb('#282020'), p * 3);
    for (let p = 0; p < 5; p++) target.set(C.rgb('#080818'), p * 3);
    const palette = C.choosePalette(target, null, 3, new Uint8Array(1000).fill(1)).map(C.hex);
    assert.ok(palette.includes('#080818'), palette.join(', '));
    assert.ok(palette.includes('#282020'), palette.join(', '));
});

for (const transparent of [false, true]) {
    test(`${transparent ? 'transparent' : 'solid'}: local boundary gain agrees with a full composite, including unchanged neighbors and a later layer`, () => {
        const width = 6, height = 4, size = width * height;
        const target = C.canvas(size, transparent ? null : [0, 0, 0]);
        const data = C.canvas(size, transparent ? null : [0.4, 0.3, 0.2]);
        for (let p = 0; p < size; p++) {
            const alpha = transparent ? (p % 3 + 1) / 3 : 1;
            if (transparent) target.alpha[p] = alpha;
            target.set([p % 2 ? 0.8 : 0.1, p % 3 ? 0.4 : 0.7, 0.05].map(c => c * alpha), p * 3);
        }
        C.applyLine(data, line(0, 1, 6, 7), [0.1, 0.5, 0.2], 0.4);
        const visible = Float64Array.from(target, srgb), mask = new Uint8Array(size).fill(1);
        if (transparent) visible.white = Float64Array.from(target, (v, i) => srgb(v + 1 - target.alpha[Math.floor(i / 3)]));
        const boundaries = C.makeBoundaries(visible, mask, width, height);
        const context = {target, displayTarget: visible, boundaries};
        const cover = line(0, 2, 4, 6), later = [0.3, 0.6, 0.9];
        const suffix = C.suffixTransform([{color: 0, sequence: [0, 1]}], [later], {line: () => cover}, size, 0.6);
        function brute(image) {
            let sum = 0;
            for (let e = 0; e < boundaries.from.length; e++) for (const bg of transparent ? [0, 1] : [0]) {
                const p = boundaries.from[e], q = boundaries.to[e];
                for (let c = 0; c < 3; c++) {
                    const view = (image, at) => srgb(image[at * 3 + c] + (image.alpha ? bg * (1 - image.alpha[at]) : 0));
                    sum += (view(image, p) - view(image, q) - view(target, p) + view(target, q)) ** 2;
                }
            }
            return sum * boundaries.strength / (transparent ? 6 : 3);
        }
        // Single changed endpoint, both changed endpoints, and reversed order.
        for (const travel of [line(0), line(0, 2, 4), line(4, 2, 0), line(7, 8, 9)]) {
            const before = copy(data), after = copy(data), untouched = copy(data);
            C.applyLine(before, cover, later, 0.6);
            C.applyLine(after, travel, [0.9, 0.1, 0.5], 0.3);
            C.applyLine(after, cover, later, 0.6);
            const gain = C.scoreLine(data, target, travel, [0.9, 0.1, 0.5], 0.3, suffix, visible, null, boundaries);
            close(gain, C.imageError(before, context) - C.imageError(after, context));
            close(C.boundaryError(before, boundaries), brute(before));
            close(C.boundaryError(after, boundaries), brute(after));
            assert.deepEqual(data, untouched, 'candidate scoring cannot modify the working image');
        }
        boundaries.serial = 0xffffffff;
        const gain = C.scoreLine(data, target, line(0), later, 0.3, suffix, visible, null, boundaries);
        assert.ok(Number.isFinite(gain), 'candidate scratch counters can wrap safely');
    });
}

test('boundary extraction ignores uniform areas and masked frame pixels', () => {
    const width = 6, height = 4, size = width * height;
    const uniform = new Float64Array(size * 3).fill(0.7), mask = new Uint8Array(size).fill(1);
    assert.equal(C.makeBoundaries(uniform, mask, width, height).from.length, 0);
    const noisy = uniform.slice(); noisy[0] += 0.005;
    assert.equal(C.makeBoundaries(noisy, mask, width, height).from.length, 0);
    mask[0] = 0; noisy[0] = 0;
    const boundaries = C.makeBoundaries(noisy, mask, width, height);
    assert.ok([...boundaries.from, ...boundaries.to].every(p => mask[p]));
});

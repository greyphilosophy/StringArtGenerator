const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../color-planner.js');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const line = (...pixels) => ({pixels: Uint32Array.from(pixels), length: pixels.length, key: pixels.join(',')});
const srgb = x => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;

function fixture(color = [255, 255, 255, 255]) {
    const width = 16, height = 12, rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set(color, i);
    return {width, height, rgba, shape: 'rectangle', horizontalPins: 6, verticalPins: 6,
        maxColors: 5, maxLines: 80, frameLongestCm: 10, threadDiameterMm: 1};
}

test('default open frame requires white thread for a white image; a white board does not', () => {
    const options = fixture(), open = C.plan(options);
    assert.equal(open.background, 'transparent');
    assert.equal(open.render.model, 'linear-coverage-alpha-v1');
    assert.equal(open.stats.errorMetric, 'detail-boundary-srgb-two-backdrops-v1');
    assert.deepEqual(open.palette, ['#ffffff']);
    assert.ok(C.steps(open).length > 0 && C.steps(open).length <= options.maxLines);
    assert.ok(open.stats.finalError < open.stats.initialError);
    assert.deepEqual(C.render(open), C.render(JSON.parse(JSON.stringify(open))));
    assert.ok(C.render(open).rgba.some((v, i) => i % 4 === 3 && v > 0 && v < 255));
    const backed = C.plan({...options, background: '#ffffff'});
    assert.deepEqual(backed.palette, []);
    assert.deepEqual(backed.layers, []);
    assert.equal(backed.render.model, 'linear-coverage-v1');
    assert.equal(C.render(backed).rgba[3], 255);
});

test('transparent source pixels stay empty and their hidden RGB never seeds thread colors', () => {
    const hiddenWhite = fixture([255, 255, 255, 0]);
    const empty = C.plan({...hiddenWhite, background: 'transparent'});
    assert.deepEqual(empty.palette, []);
    assert.deepEqual(C.shoppingList(empty), []);
    assert.equal(empty.stats.initialError, 0);
    assert.equal(empty.stats.finalError, 0);
    assert.ok(C.render(empty).rgba.every(v => v === 0));
    const source = fixture([255, 0, 0, 0]);
    source.rgba.set([255, 255, 255, 128], 0);
    const context = C.prepare(source);
    close(context.target.alpha[0], 128 / 255);
    close(context.target[0], 128 / 255);
    assert.equal(context.target.alpha[1], 0);
    assert.deepEqual(context.palette.map(C.hex), ['#ffffff']);
});

test('transparent input is area-averaged without adding a white or black matte', () => {
    const options = fixture(); options.width = 480; options.height = 360;
    options.rgba = new Uint8ClampedArray(options.width * options.height * 4);
    for (let y = 0; y < options.height; y++) for (let x = 0; x < options.width; x++)
        options.rgba.set(x % 2 ? [255, 0, 0, 0] : [255, 255, 255, 255], (y * options.width + x) * 4);
    const context = C.prepare(options);
    assert.deepEqual([context.width, context.height], [320, 240]);
    // The first output cell uses source column 0. The second averages columns
    // 1 (transparent red) and 2 (opaque white), with no matte or hidden red.
    close(context.target.alpha[0], 1);
    close(context.target.alpha[1], 0.5);
    close(context.target[3], 0.5);
    close(context.target[4], 0.5);
    close(context.target[5], 0.5);
    assert.deepEqual(context.palette.map(C.hex), ['#ffffff']);
});

test('transparent saved paths reproduce real alpha, overlap color and untouched gaps', () => {
    const saved = {version: 2, mode: 'color', shape: 'rectangle', width: 4, height: 4,
        horizontalPins: 2, verticalPins: 2, pinCount: 8, background: 'transparent', palette: ['#ffffff', '#000000'],
        frameLongestCm: 30, threadDiameterMm: 0.5,
        render: {model: 'linear-coverage-alpha-v1', width: 4, height: 4, coverage: 0.5},
        layers: [{color: 0, sequence: [0, 5]}, {color: 1, sequence: [0, 5]}]};
    assert.ok(C.render(saved, 0).rgba.every(v => v === 0));
    assert.deepEqual(Array.from(C.render(saved, 1).rgba.slice(0, 4)), [255, 255, 255, 128]);
    const {rgba} = C.render(saved);
    const channel = Math.round(srgb(1 / 3) * 255); // 0.25 premultiplied white / 0.75 coverage.
    assert.deepEqual(Array.from(rgba.slice(0, 4)), [channel, channel, channel, 191]);
    assert.deepEqual(Array.from(rgba.slice(4, 8)), [0, 0, 0, 0]);
    assert.deepEqual(C.render(saved), C.render(JSON.parse(JSON.stringify(saved))));
    assert.throws(() => C.validatePlan({...saved, render: {...saved.render, model: 'linear-coverage-v1'}}));
    assert.throws(() => C.validatePlan({...saved, background: '#ffffff'}));
    assert.throws(() => C.validatePlan({...saved, background: 'none'}));
});

test('transparent gain matches independent black/white composite error through later coverage', () => {
    const data = C.canvas(2, null), target = C.canvas(2, null);
    C.applyLine(data, line(0), [0.1, 0.3, 0.8], 0.4);
    C.applyLine(target, line(0), [1, 1, 1], 0.8);
    // The second target pixel is genuinely transparent; crossing it causes harm.
    const travel = line(0, 1), cover = line(0), later = [0.2, 0.1, 0.05], weights = Float64Array.of(2, 0.5);
    const suffix = C.suffixTransform([{color: 0, sequence: [0, 1]}], [later], {line: () => cover}, 2, 0.6);
    const copy = image => Object.assign(image.slice(), {alpha: image.alpha.slice()});
    const before = copy(data), after = copy(data);
    C.applyLine(before, cover, later, 0.6);
    C.applyLine(after, travel, [1, 1, 1], 0.3);
    C.applyLine(after, cover, later, 0.6);
    const brute = image => image.reduce((sum, v, i) => {
        const p = Math.floor(i / 3);
        return sum + weights[p] * [0, 1].reduce((n, bg) => n +
            (srgb(v + bg * (1 - image.alpha[p])) - srgb(target[i] + bg * (1 - target.alpha[p]))) ** 2, 0) / 6;
    }, 0);
    const gain = C.scoreLine(data, target, travel, [1, 1, 1], 0.3, suffix, null, weights);
    close(gain, C.pixelError(before, target, null, weights) - C.pixelError(after, target, null, weights));
    assert.ok(Math.abs(gain - (brute(before) - brute(after))) < 1e-7);
    assert.ok(C.scoreLine(C.canvas(1, null), C.canvas(1, null), line(0), [1, 1, 1], 0.5) < 0,
        'adding thread to an empty source is damage');
});

test('lookahead restores alpha; shared-layer insertion and final scoring agree', () => {
    const options = fixture([45, 20, 10, 255]);
    for (let p = 0; p < options.width * options.height / 2; p++) options.rgba.set([255, 255, 255, 255], p * 4);
    const context = C.prepare(options), data = C.canvas(context.size, context.background);
    C.chooseMoves(0, data, context.palette[0], null, new Map(), context, 2, true);
    assert.ok(data.every(v => v === 0));
    assert.ok(data.alpha.every(v => v === 0), 'trial branches cannot leave coverage behind');
    const layers = C.allocateLayers(context.palette.map((_, i) => i), options.maxLines, context);
    assert.ok(new Set(layers.map(l => l.color)).size > 1);
    assert.ok(C.objective(layers, context) < C.objective([], context));
    const plan = C.plan(options), final = C.canvas(context.size, context.background);
    for (const layer of plan.layers) for (let i = 1; i < layer.sequence.length; i++)
        C.applyLine(final, context.raster.line(layer.sequence[i - 1], layer.sequence[i]), C.rgb(plan.palette[layer.color]), plan.render.coverage);
    close(C.imageError(final, context), plan.stats.finalError);
    close(plan.stats.pixelError + plan.stats.boundaryError, plan.stats.finalError);
    assert.ok(C.steps(plan).length <= options.maxLines);
    assert.deepEqual(C.render(plan), C.render(JSON.parse(JSON.stringify(plan))));
});

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../color-planner.js');
const count = layers => layers.reduce((n, layer) => n + layer.sequence.length - 1, 0);
const within = (after, before) => assert.ok(after <= before * 1.01 + 1.1e-10, `${after} exceeds the fixed 1% allowance over ${before}`);
function options(background = 'transparent', width = 24, height = 16) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) rgba.set(p === width * height - 1 ? [80, 120, 40, 255] : [40, 140, 235, 255], p * 4);
    return {shape: 'rectangle', width, height, horizontalPins: 8, verticalPins: 6,
        maxColors: 2, maxLines: 60, frameLongestCm: 20, threadDiameterMm: 1.2, background, rgba, reduceWindings: true};
}
function twoRegions(background = 'transparent', width = 24, height = 16) {
    const context = C.prepare(options(background, width, height));
    context.palette = [C.rgb('#288ceb'), C.rgb('#507828')];
    const line = (pixels, key) => ({pixels: Uint32Array.from(pixels), key, length: pixels.length});
    const blue = line(Array.from({length: context.size - 1}, (_, i) => i), 'blue');
    const green = line([context.size - 1], 'green');
    context.raster = {pins: [0, 1, 2, 3], nailKey: p => p, line: (a, b) => a < 2 && b < 2 ? blue : green};
    context.coverage = 0.5;
    return context;
}
function draw(layers, context) {
    const data = C.canvas(context.size, context.background);
    for (const layer of layers) for (let i = 1; i < layer.sequence.length; i++) {
        for (const p of context.raster.line(layer.sequence[i - 1], layer.sequence[i]).pixels) {
            for (let c = 0; c < 3; c++) data[3 * p + c] = (1 - context.coverage) * data[3 * p + c] + context.coverage * context.palette[layer.color][c];
            if (data.alpha) data.alpha[p] = (1 - context.coverage) * data.alpha[p] + context.coverage;
        }
    }
    return data;
}
function checkGuards(initial, result, context) {
    const before = draw(initial, context), after = draw(result.layers, context);
    within(C.pixelError(after, context.target, context.displayTarget, context.weights), C.pixelError(before, context.target, context.displayTarget, context.weights));
    within(C.boundaryError(after, context.boundaries), C.boundaryError(before, context.boundaries));
    const regions = C.regionAllocation(context.target, context.palette, context.background, context.mask, context.width, context.height);
    const a = C.regionErrors(before, context, regions), b = C.regionErrors(after, context, regions);
    for (let i = 0; i < a.length; i++) {
        within(b[i].meanColorError, a[i].meanColorError);
        within(b[i].meanBoundaryError, a[i].meanBoundaryError);
    }
    for (const change of result.stats.history) {
        within(change.pixelError, result.stats.initialPixelError);
        within(change.boundaryError, result.stats.initialBoundaryError);
        assert.ok(change.linesAfter < change.linesBefore);
    }
    assert.ok(result.stats.attempts <= 160);
    assert.ok(result.stats.history.length <= 32);
}

for (const background of ['transparent', '#ffffff']) test(`${background}: trim a saturated spool while keeping the small color and continuous paths`, () => {
    const context = twoRegions(background);
    const initial = [{color: 0, sequence: Array.from({length: 81}, (_, i) => i % 2)}, {color: 1, sequence: [2, 3]}];
    const copy = structuredClone(initial), result = C.reduceWindings(initial, context);
    assert.ok(count(result.layers) < 50, 'redundant coverage should not consume the full manual winding budget');
    assert.ok(count(result.layers) > 2, 'do not remove useful repeated coverage');
    assert.deepEqual(result.layers.find(layer => layer.color === 1).sequence, [2, 3]);
    assert.deepEqual(initial, copy);
    assert.equal(result.stats.removedLines, 81 - count(result.layers));
    checkGuards(initial, result, context);
});

test('a tiny color cannot be traded away within the whole-image allowance', () => {
    const context = twoRegions('#ffffff', 100, 10);
    context.coverage = 0.1; context.boundaries = null; context.weights.fill(1);
    const initial = [{color: 0, sequence: [0, 1]}, {color: 1, sequence: [2, 3]}];
    const before = draw(initial, context), erased = draw(initial.slice(0, 1), context);
    within(C.pixelError(erased, context.target, context.displayTarget, context.weights), C.pixelError(before, context.target, context.displayTarget, context.weights));
    const result = C.reduceWindings(initial, context);
    assert.deepEqual(result.layers, initial, 'the separate color-region guard must reject erasing the rare color');
});

test('useful repeated white coverage survives on a transparent frame', () => {
    const settings = options();
    for (let p = 0; p < settings.width * settings.height; p++) settings.rgba.set([255, 255, 255, 191], p * 4);
    const context = C.prepare(settings); context.palette = [[1, 1, 1]]; context.coverage = 0.5;
    context.raster = {nailKey: p => p, line: () => ({pixels: Uint32Array.from({length: context.size}, (_, i) => i)})};
    const initial = [{color: 0, sequence: [0, 1, 0]}], result = C.reduceWindings(initial, context);
    assert.deepEqual(result.layers, initial, 'two passes supply 75% coverage; one supplies only 50%');
});

test('removals evaluate actual later layers before discarding earlier color', () => {
    const context = twoRegions();
    const all = {pixels: Uint32Array.from({length: context.size}, (_, i) => i)};
    context.raster = {nailKey: p => p, line: () => all}; context.coverage = 0.8;
    for (let p = 0; p < context.size; p++) {
        for (let c = 0; c < 3; c++) context.target[3 * p + c] = context.palette[1][c];
        context.target.alpha[p] = 1;
    }
    context.displayTarget = Float64Array.from(context.target, x => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
    context.displayTarget.white = context.displayTarget.slice(); context.boundaries = null;
    const initial = [{color: 0, sequence: [0, 1, 0]}, {color: 1, sequence: Array.from({length: 33}, (_, i) => 2 + i % 2)}];
    const result = C.reduceWindings(initial, context);
    assert.ok(!result.layers.some(layer => layer.color === 0));
    checkGuards(initial, result, context);
});

test('closed excursions recognize shared corner aliases and preserve surviving physical chords', () => {
    const frame = {shape: 'rectangle', width: 10, height: 6, horizontalPins: 3, verticalPins: 2};
    const raster = C.rasterizer(frame, 10, 6), initial = [{color: 0, sequence: [0, 2, 6, 3, 7]}];
    const loop = C.windingReductions(initial, raster).find(c => c.kind === 'loop' && c.start === 1 && c.end === 3);
    assert.ok(loop);
    const trial = C.removeWindingExcursion(initial, loop);
    assert.deepEqual(trial[0].sequence, [0, 2, 7]);
    assert.equal(raster.line(2, 7).key, raster.line(3, 7).key);
    assert.ok(raster.line(2, 7).length > 0);
});

test('the experiment is opt-in and completed reduced plans retain exact replay and line budgets', () => {
    const settings = options(), defaultContext = C.prepare({...settings, reduceWindings: undefined});
    const initial = [{color: 0, sequence: [0, 1]}];
    assert.equal(C.reduceWindings(initial, defaultContext).layers, initial);
    assert.throws(() => C.prepare({...settings, reduceWindings: 'yes'}));
    const baseline = C.plan({...settings, reduceWindings: false});
    const result = C.plan(settings), stats = result.stats.windingReduction;
    assert.equal(stats.initialLines, C.steps(baseline).length);
    assert.equal(stats.finalLines, C.steps(result).length);
    assert.ok(stats.finalLines <= settings.maxLines && stats.finalLines <= stats.initialLines);
    within(result.stats.pixelError, baseline.stats.pixelError);
    within(result.stats.boundaryError, baseline.stats.boundaryError);
    assert.deepEqual(C.render(result), C.render(JSON.parse(JSON.stringify(result))));
    C.validatePlan(result);
    const old = structuredClone(result); delete old.stats.windingReduction;
    assert.deepEqual(C.render(result), C.render(old));
});

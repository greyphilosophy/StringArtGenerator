const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../color-planner.js');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const srgb = x => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
const line = (...pixels) => ({pixels: Uint32Array.from(pixels), length: pixels.length, key: pixels.join(',')});
function options(background = 'transparent') {
    const width = 24, height = 16, rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        rgba.set(x > 18 && x < 22 && y > 1 && y < 14 ? [80, 120, 40, 255] : [40, 140, 235, 255], (y * width + x) * 4);
    return {shape: 'rectangle', width, height, horizontalPins: 8, verticalPins: 6,
        maxColors: 2, maxLines: 40, frameLongestCm: 20, threadDiameterMm: 1.2, background, rgba};
}

test('regional weights give a small color a bounded vote and remain fixed during review', () => {
    const context = C.prepare(options()), balanced = C.feedbackContext(context);
    const green = context.palette.findIndex(color => C.hex(color) === '#507828');
    const inside = [...balanced.regions.labels].findIndex(color => color === green);
    assert.ok(balanced.weights[inside] > context.weights[inside]);
    close(balanced.weights.reduce((a, b) => a + b, 0), context.weights.reduce((a, b) => a + b, 0));
    for (let p = 0; p < context.size; p++) assert.ok(balanced.weights[p] <= context.weights[p] * 16 + 1e-10);
    assert.notEqual(balanced.boundaries.stamp, context.boundaries.stamp, 'the two scoring contexts need independent candidate stamps');
    const before = balanced.weights.slice();
    C.regionErrors(C.canvas(context.size, null), context, balanced.regions);
    C.regionErrors(context.target, context, balanced.regions);
    assert.deepEqual(balanced.weights, before, 'a changing score cannot masquerade as an improving image');
});

for (const background of ['transparent', '#ffffff']) {
    test(`${background}: weighted boundary gains match independent complete composites with later coverage`, () => {
        const context = C.prepare(options(background)), balanced = C.feedbackContext(context), b = balanced.boundaries;
        const data = C.canvas(context.size, context.background), stroke = line(66, 67, 68, 90, 91, 92);
        const cover = line(67, 68, 91), blue = C.rgb('#288ceb'), green = C.rgb('#507828');
        C.applyLine(data, stroke, blue, 0.3);
        const clone = data => data.alpha ? Object.assign(data.slice(), {alpha: data.alpha.slice()}) : data.slice();
        const suffix = C.suffixTransform([{color: 0, sequence: [0, 1]}], [blue], {line: () => cover}, context.size, 0.6);
        const before = clone(data), after = clone(data);
        C.applyLine(before, cover, blue, 0.6);
        C.applyLine(after, stroke, green, 0.4); C.applyLine(after, cover, blue, 0.6);
        function brute(image) {
            let error = 0;
            for (let e = 0; e < b.from.length; e++) {
                const p = b.from[e], q = b.to[e], weight = (b.regionWeights[p] + b.regionWeights[q]) / 2;
                for (const bg of image.alpha ? [0, 1] : [0]) for (let c = 0; c < 3; c++) {
                    const visible = (image, p) => srgb(image[p * 3 + c] + (image.alpha ? bg * (1 - image.alpha[p]) : 0));
                    error += weight * (visible(image, p) - visible(image, q) - visible(context.target, p) + visible(context.target, q)) ** 2;
                }
            }
            return error * b.strength / (image.alpha ? 6 : 3);
        }
        close(C.boundaryError(after, b), brute(after));
        // Interleave the old and new scorers to catch scratch-counter aliasing.
        for (const scoring of [balanced, context, balanced, context, balanced]) {
            const gain = C.scoreLine(data, context.target, stroke, green, 0.4, suffix, context.displayTarget, scoring.weights, scoring.boundaries);
            close(gain, C.imageError(before, scoring) - C.imageError(after, scoring));
        }
    });
}

test('feedback funds a missing color by reducing a saturated spool and can finish with fewer windings', () => {
    const width = 10, height = 2, rgba = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < 20; p++) rgba.set(p < 18 ? [40, 140, 235, 255] : [80, 120, 40, 255], p * 4);
    const context = C.prepare({...options('#ffffff'), width, height, horizontalPins: 3, verticalPins: 2, rgba});
    const blueLine = line(...Array.from({length: 18}, (_, i) => i)), greenLine = line(18, 19);
    context.raster = {pins: [0, 1, 2], line: (a, b) => a === 2 || b === 2 ? greenLine : blueLine};
    context.coverage = 0.5;
    const blue = context.palette.findIndex(color => C.hex(color) === '#288ceb');
    const green = context.palette.findIndex(color => C.hex(color) === '#507828');
    const initial = [{color: blue, sequence: Array.from({length: 41}, (_, i) => i % 2), temporaryHarm: 0, bundles: 0}];
    const untouched = structuredClone(initial), balanced = C.feedbackContext(context);
    const result = C.rebalanceRegions(initial, context, 2, 40);
    assert.ok(result.layers.some(layer => layer.color === green));
    assert.ok(result.stats.finalLines < 40, 'do not fill the work budget with unhelpful winding');
    assert.ok(result.layers.find(layer => layer.color === blue).sequence.length < 41);
    assert.ok(result.stats.finalError < result.stats.initialError);
    close(result.stats.initialError, C.objective(initial, balanced));
    close(result.stats.finalError, C.objective(result.layers, balanced));
    for (const change of result.stats.history) { assert.ok(change.after < change.before); assert.ok(change.linesAfter <= 40); }
    assert.deepEqual(initial, untouched, 'rejected and accepted trials must not mutate the original plan');
    assert.equal(new Set(result.layers.map(layer => layer.color)).size, result.layers.length);
    for (const layer of result.layers) for (let i = 1; i < layer.sequence.length; i++) assert.notEqual(layer.sequence[i], layer.sequence[i - 1]);
});

test('feedback respects small winding limits, protects the rest of the image and preserves replay', () => {
    for (const maxLines of [1, 2, 15, 16, 17, 40]) {
        const settings = {...options(), maxLines}, plan = C.plan(settings), context = C.prepare(settings);
        const baseline = C.plan({...settings, regionFeedback: false});
        assert.equal(plan.maxLines, maxLines);
        assert.ok(C.steps(plan).length <= maxLines);
        assert.ok(plan.stats.finalError <= baseline.stats.finalError * 1.03 + 1e-10);
        assert.ok(plan.stats.pixelError <= baseline.stats.pixelError * 1.03 + 1e-10);
        assert.equal(plan.stats.feedback.enabled, true);
        assert.equal(baseline.stats.feedback.enabled, false);
        const balanced = C.feedbackContext(context);
        const layers = plan.layers.map(layer => ({...layer, color: context.palette.findIndex(color => C.hex(color) === plan.palette[layer.color])}));
        close(plan.stats.feedback.finalError, C.objective(layers, balanced));
        C.validatePlan(plan);
        assert.deepEqual(C.render(plan), C.render(JSON.parse(JSON.stringify(plan))));
        assert.equal(new Set(plan.layers.map(layer => layer.color)).size, plan.layers.length);
    }
});

test('saved winding ceilings include every segment while older plans remain compatible', () => {
    const plan = C.plan(options());
    assert.ok(C.steps(plan).length > 1);
    assert.throws(() => C.validatePlan({...plan, maxLines: 1}), /budget/);
    for (const maxLines of [0, 1.5, '1600', 10001]) assert.throws(() => C.validatePlan({...plan, maxLines}));
    const older = structuredClone(plan); delete older.maxLines;
    assert.deepEqual(C.render(older), C.render(plan));
    assert.throws(() => C.prepare({...options(), regionFeedback: 'yes'}));
});

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../color-planner.js');
const white = [1, 1, 1], black = [0, 0, 0];
const line = (...pixels) => ({pixels: Uint32Array.from(pixels), length: pixels.length, key: pixels.join(',')});

test('region budgets measure shared outlines, preserving a thin stem and a one-pixel eye', () => {
    const width = 14, height = 8, palette = ['#2690e9', '#577934', '#ffffff', '#162751'].map(C.rgb);
    const target = C.canvas(width * height, palette[0]), mask = new Uint8Array(width * height).fill(1);
    for (let y = 0; y < height; y++) target.set(palette[1], (y * width + 1) * 3);
    for (let y = 2; y < 6; y++) for (let x = 6; x < 10; x++) target.set(palette[2], (y * width + x) * 3);
    target.set(palette[3], (3 * width + 12) * 3);
    const original = target.slice(), result = C.regionAllocation(target, palette, null, mask, width, height);
    // Stem: two length-8 sides. Square: four length-4 sides. Eye: four sides.
    // The blue background shares each outline; the outside frame adds nothing.
    assert.deepEqual(result.perimeters, [36, 16, 16, 4]);
    assert.deepEqual(C.apportionLines(result.shares, 72), [36, 16, 16, 4]);
    assert.deepEqual(target, original, 'region labeling must not posterize the scoring target');
});

test('transparent space, solid boards and masked frame pixels do not reserve their own thread', () => {
    const red = C.rgb('#ff0000'), green = C.rgb('#00ff00'), mask = new Uint8Array(9).fill(1);
    const target = C.canvas(9, null);
    target.set(green, 0); // Hidden RGB cannot seed a region.
    target.set(red.map(c => c * 0.5), 12); target.alpha[4] = 0.5;
    assert.deepEqual(C.regionAllocation(target, [red, green], null, mask, 3, 3).perimeters, [2, 0]);
    const solid = C.canvas(9, white); solid.set(red, 12);
    assert.deepEqual(C.regionAllocation(solid, [red], white, mask, 3, 3).perimeters, [4]);
    mask[4] = 0;
    assert.deepEqual(C.regionAllocation(solid, [red], white, mask, 3, 3).shares, [0]);
    const uniform = C.regionAllocation(C.canvas(9, red), [red], null, new Uint8Array(9).fill(1), 3, 3);
    assert.deepEqual(uniform.perimeters, [0]);
    assert.deepEqual(C.apportionLines(uniform.shares, 20), [20], 'uniform images still need coverage');
    assert.deepEqual(C.apportionLines([], 20), []);
});

test('integer reservations use the entire budget, including small pilots and tied remainders', () => {
    assert.deepEqual(C.apportionLines([2460, 4068, 828, 4508, 64], 1600), [330, 546, 111, 605, 8]);
    assert.deepEqual(C.apportionLines([1, 1, 1], 2), [1, 1, 0]);
    assert.deepEqual(C.apportionLines([0, 1, 3], 100), [0, 25, 75]);
    assert.deepEqual(C.apportionLines([1, 3], 0), [0, 0]);
});

test('a less competitive color can spend its reservation on useful continuous paths', () => {
    const red = [1, 0, 0], target = C.canvas(2, black); target.set(red, 3);
    const graph = {'0:1': line(0), '0:2': line(1), '1:2': line(0)};
    const context = {size: 2, background: white, target, palette: [black, red], coverage: 0.1,
        allocation: {shares: [1, 9]}, raster: {pins: [0, 1, 2], line(a, b) {return graph[[a, b].sort().join(':')];}}};
    for (const order of [[0, 1], [1, 0]]) {
        const layers = C.allocateLayers(order, 10, context);
        assert.deepEqual([0, 1].map(color => layers.find(l => l.color === color).sequence.length - 1), [1, 9]);
        assert.ok(C.objective(layers, context) < C.objective([], context));
        assert.equal(new Set(layers.map(l => l.color)).size, layers.length);
    }
});

test('unspendable reservations transfer without forcing harmful moves or exceeding the total', () => {
    const context = {size: 1, background: [0.2, 0.2, 0.2], target: C.canvas(1, black),
        palette: [black, [1, 0, 0]], coverage: 0.1, allocation: {shares: [1, 9]},
        raster: {pins: [0, 1, 2], line: () => line(0)}};
    const layers = C.allocateLayers([0, 1], 10, context);
    assert.equal(layers.length, 1);
    assert.equal(layers[0].color, 0);
    assert.equal(layers[0].sequence.length - 1, 10);
    const stopped = C.allocateLayers([0, 1], 100, context);
    assert.ok(stopped[0].sequence.length > 11 && stopped[0].sequence.length <= 100);
    assert.ok(C.objective(stopped, context) < C.objective(layers, context));
});

test('the perimeter experiment records reservations and actual use and round-trips its paths', () => {
    const width = 24, height = 18, rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        rgba.set(x > 12 && x < 16 ? [80, 120, 40, 255] : [35, 140, 235, 255], (y * width + x) * 4);
    const options = {shape: 'rectangle', width, height, horizontalPins: 8, verticalPins: 6,
        rgba, maxColors: 2, maxLines: 35, frameLongestCm: 20, threadDiameterMm: 0.5, colorAllocation: 'perimeter'};
    const plan = C.plan(options), stats = plan.stats.allocation;
    assert.equal(stats.method, 'region-perimeter-v1');
    assert.equal(stats.colors.reduce((sum, color) => sum + color.targetLines, 0), 35);
    assert.equal(stats.colors.reduce((sum, color) => sum + color.actualLines, 0), C.steps(plan).length);
    assert.ok(C.steps(plan).length <= 35);
    assert.equal(new Set(plan.layers.map(l => l.color)).size, plan.layers.length, 'one continuous path per spool');
    C.validatePlan(plan);
    assert.deepEqual(C.render(plan), C.render(JSON.parse(JSON.stringify(plan))));
    assert.throws(() => C.prepare({...options, colorAllocation: 'unknown'}));
    assert.throws(() => C.prepare({...options, edgeTravel: 'yes'}));
    assert.equal(C.prepare({...options, colorAllocation: undefined}).allocation, null, 'overall likeness stays the default');
});

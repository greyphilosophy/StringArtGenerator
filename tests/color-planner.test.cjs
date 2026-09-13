const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../color-planner.js');
const tonalDetail = require('./fixtures/tonal-detail.cjs');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const line = (...pixels) => ({pixels: Uint32Array.from(pixels), length: pixels.length, key: pixels.join(',')});
const black = [0, 0, 0], white = [1, 1, 1];

function fixture(width = 32, height = 20) {
    const colors = [[200, 30, 50], [30, 80, 220], [240, 170, 25], [30, 160, 75], [100, 40, 170]];
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const color = colors[Math.min(4, Math.floor(x * 5 / width))];
        rgba.set([...color, 255], (y * width + x) * 4);
    }
    return {shape: 'rectangle', width, height, horizontalPins: 12, verticalPins: 10, pinCount: 44,
        maxColors: 5, maxLines: 40, frameLongestCm: 30, threadDiameterMm: 0.8, background: '#ffffff', rgba};
}

test('net scoring subtracts harm, even if part of the segment improves', () => {
    const data = C.canvas(5, black), target = C.canvas(5, black);
    target.set(white, 12);
    const proposed = line(0, 1, 2, 3, 4);
    const before = C.pixelError(data, target);
    const gain = C.scoreLine(data, target, proposed, white, 0.5);
    assert.ok(gain < 0, 'four damaged pixels outweigh one improvement');
    C.applyLine(data, proposed, white, 0.5);
    close(gain, before - C.pixelError(data, target));
});

test('later coverage discounts travel damage, but does not erase it', () => {
    const data = C.canvas(5, black), target = C.canvas(5, black);
    target.set(white, 12);
    const travel = line(0, 1, 2, 3, 4), cover = line(0, 1, 2, 3);
    const suffix = C.suffixTransform([{color: 0, sequence: [0, 1]}], [black], {line: () => cover}, 5, 0.9);
    const immediate = C.scoreLine(data, target, travel, white, 0.5);
    const finished = C.scoreLine(data, target, travel, white, 0.5, suffix);
    assert.ok(immediate < 0 && finished > 0);
    assert.ok(finished < 0.75, 'covered pixels still retain a coverage penalty');
    const before = C.pixelError(data, target);
    C.applyLine(data, travel, white, 0.5);
    C.applyLine(data, cover, black, 0.9);
    close(finished, before - C.pixelError(data, target));
});

test('visible-error scoring matches a full render with weighted damage and later coverage', () => {
    const srgb = x => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    const data = Float64Array.of(0.02, 0.04, 0.01, 0.5, 0.2, 0.08);
    const target = Float64Array.of(0.01, 0.02, 0.01, 0.7, 0.4, 0.1);
    const visible = Float64Array.from(target, srgb), weights = Float64Array.of(2, 0.5);
    const travel = line(0, 1), cover = line(0), later = [0.1, 0.2, 0.02];
    const suffix = C.suffixTransform([{color: 0, sequence: [0, 1]}], [later], {line: () => cover}, 2, 0.7);
    const before = data.slice(), after = data.slice();
    C.applyLine(before, cover, later, 0.7);
    C.applyLine(after, travel, black, 0.3);
    C.applyLine(after, cover, later, 0.7);
    const gain = C.scoreLine(data, target, travel, black, 0.3, suffix, visible, weights);
    close(gain, C.pixelError(before, target, visible, weights) - C.pixelError(after, target, visible, weights));
    const brute = pixels => pixels.reduce((sum, value, i) =>
        sum + weights[Math.floor(i / 3)] * (srgb(value) - visible[i]) ** 2 / 3, 0);
    assert.ok(Math.abs(gain - (brute(before) - brute(after))) < 1e-7);
    assert.ok(gain < 0, 'visible damage still outweighs the improvement');
});

test('connected lookahead accepts useful temporary harm, never an unfinished harmful move', () => {
    const data = C.canvas(3, white), target = C.canvas(3, black);
    target.set(white, 0);
    const graph = {'0:1': line(0), '0:2': line(0), '1:2': line(1, 2)};
    const context = {target, coverage: 0.5, raster: {pins: [0, 1, 2], line(a, b) {return graph[[a, b].sort().join(':')];}}};
    const greedy = C.chooseMoves(0, data, black, null, new Map(), context, 2, false);
    const ahead = C.chooseMoves(0, data, black, null, new Map(), context, 2, true);
    assert.equal(greedy.moves.length, 0);
    assert.equal(ahead.moves.length, 2);
    assert.ok(ahead.moves[0].gain < 0 && ahead.gain > 0);
    assert.equal(C.chooseMoves(0, data, black, null, new Map(), context, 1, true).moves.length, 0);
    assert.deepEqual(data, C.canvas(3, white), 'trial evaluation must restore its canvas');
});

test('repeating a covered route still costs length and buildup', () => {
    const context = {target: C.canvas(1, black), background: black, size: 1, coverage: 0.9,
        palette: [black], raster: {line: () => line(0)}};
    const one = [{color: 0, sequence: [0, 1]}], twice = [{color: 0, sequence: [0, 1, 0]}];
    assert.ok(C.objective(one, context) > 0);
    assert.ok(C.objective(twice, context) > 2 * C.objective(one, context));
});

test('initial palette keeps five distinct image colors; a blank board needs none', () => {
    const context = C.prepare(fixture());
    assert.equal(context.palette.length, 5);
    assert.equal(new Set(context.palette.map(C.hex)).size, 5);
    const same = fixture(); same.rgba.fill(255);
    assert.equal(C.prepare(same).palette.length, 0);
});

test('palette retains substantial dark detail without following a lone black pixel', () => {
    const {options} = tonalDetail();
    const darkest = Math.min(...C.prepare(options).palette.map(color =>
        Math.max(...C.hex(color).slice(1).match(/../g).map(c => parseInt(c, 16)))));
    assert.ok(darkest <= 32, 'the available threads must be dark enough for the centers');
    const target = C.canvas(100, C.rgb('#887744'));
    target.set(black, 0);
    for (let p = 80; p < 100; p++) target.set(C.rgb('#eeddaa'), p * 3);
    const palette = C.choosePalette(target, white, 2, new Uint8Array(100).fill(1));
    assert.ok(palette.every(color => C.hex(color) !== '#000000'), 'one outlier must not reserve a black spool');
});

test('colors share the full budget and stop when further moves lose net value', () => {
    const edge = line(0);
    const context = {size: 1, background: white, target: Float64Array.from(C.rgb('#303030')),
        displayTarget: new Float64Array(3).fill(48 / 255), weights: Float64Array.of(1),
        palette: [black, [1, 0, 0]], coverage: 0.1, raster: {pins: [0, 1, 2], line: () => edge}};
    const capped = C.allocateLayers([0, 1], 10, context);
    assert.equal(capped.length, 1);
    assert.equal(capped[0].color, 0);
    assert.equal(capped[0].sequence.length - 1, 10, 'useful black windings can use the entire budget');
    const finished = C.allocateLayers([0, 1], 50, context);
    const used = finished[0].sequence.length - 1;
    assert.ok(used > 10 && used < 50);
    assert.ok(C.objective(finished, context) < C.objective(capped, context));
    const data = C.canvas(1, white);
    for (let i = 0; i < used; i++) C.applyLine(data, edge, black, context.coverage);
    const usage = new Map([[edge.key, used]]);
    for (const color of context.palette) assert.equal(
        C.chooseMoves(finished[0].sequence.at(-1), data, color, null, usage, context, 2, true).moves.length, 0);
});

for (const [name, background, thread] of [['white', white, black], ['black', black, white]]) {
    test(`${name} board color can be selected as thread to cover an earlier path`, () => {
        const graph = {'0:1': line(0, 1), '0:2': line(1), '1:2': line(0)};
        const target = C.canvas(2, thread); target.set(background, 0);
        const context = {size: 2, background, target, palette: [thread], coverage: 0.5,
            raster: {pins: [0, 1, 2], line(a, b) { return graph[[a, b].sort().join(':')]; }}};
        const layers = [{color: 0, sequence: [0, 1]}], before = C.objective(layers, context);
        assert.equal(C.considerBackgroundThread(layers, context, 1, 3).added, false, 'respect the one-color limit');
        const result = C.considerBackgroundThread(layers, context, 2, 3);
        assert.equal(result.added, true);
        assert.deepEqual(context.palette[result.layers.at(-1).color], background);
        assert.ok(C.objective(result.layers, context) < before);
        assert.ok(result.layers.reduce((n, l) => n + l.sequence.length - 1, 0) <= 3);
        assert.deepEqual(layers, [{color: 0, sequence: [0, 1]}], 'candidate searches must preserve the existing paths');
    });
}

test('background thread competes for a full palette and is rejected when it only causes harm', () => {
    const graph = {'0:1': line(0, 1), '0:2': line(1), '1:2': line(0)};
    const target = C.canvas(2, black); target.set(white, 0);
    const context = {size: 2, background: white, target, palette: [black, [1, 0, 0]], coverage: 0.5,
        raster: {pins: [0, 1, 2], line(a, b) { return graph[[a, b].sort().join(':')]; }}};
    const layers = [{color: 0, sequence: [0, 1]}, {color: 1, sequence: [0, 2]}];
    const before = C.objective(layers, context), result = C.considerBackgroundThread(layers, context, 2, 3);
    assert.equal(result.added, true);
    assert.equal(new Set(result.layers.map(l => l.color)).size, 2);
    assert.ok(result.layers.some(l => C.hex(context.palette[l.color]) === '#ffffff'));
    assert.ok(!result.layers.some(l => l.color === 1), 'replace the less useful color to stay within the limit');
    assert.ok(C.objective(result.layers, context) < before);
    const dark = {...context, palette: [black], target: C.canvas(2, black)};
    const rejected = C.considerBackgroundThread(layers.slice(0, 1), dark, 2, 10);
    assert.equal(rejected.added, false);
    assert.deepEqual(dark.palette, [black], 'do not retain an unused background swatch');
});

test('white thread restores bright features while a blank white image still needs no string', () => {
    const width = 48, height = 36, rgba = new Uint8ClampedArray(width * height * 4), highlights = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const bright = Math.abs(y - (10 + x * 0.25)) < 1.2 || Math.hypot(x - 29, y - 21) < 5;
        rgba.set(bright ? [255, 255, 255, 255] : [48, 32, 16, 255], (y * width + x) * 4);
        if (bright) highlights.push(y * width + x);
    }
    const options = {width, height, rgba, shape: 'rectangle', horizontalPins: 16, verticalPins: 12,
        pinCount: 56, maxLines: 1500, frameLongestCm: 15, threadDiameterMm: 1, background: '#ffffff'};
    const plain = C.plan({...options, maxColors: 1}), repaired = C.plan({...options, maxColors: 2});
    const error = plan => {
        const pixels = C.render(plan).rgba;
        return highlights.reduce((sum, p) => sum + [0, 1, 2].reduce((n, c) => n + (255 - pixels[p * 4 + c]) ** 2, 0), 0);
    };
    assert.ok(repaired.palette.includes('#ffffff'));
    assert.equal(repaired.stats.backgroundThreadAdded, true);
    assert.ok(error(repaired) < error(plain) * 0.9, 'white winding must improve the bright details');
    assert.ok(repaired.stats.finalError < plain.stats.finalError);
    assert.ok(C.steps(repaired).length <= options.maxLines);
    assert.deepEqual(C.render(repaired), C.render(JSON.parse(JSON.stringify(repaired))));
    rgba.fill(255);
    const blank = C.plan({...options, maxColors: 2});
    assert.deepEqual(blank.palette, []);
    assert.deepEqual(C.steps(blank), []);
    assert.equal(blank.stats.backgroundThreadAdded, false);
});

test('tonal-detail image keeps dark centers distinct within the same winding budget', () => {
    const {options, pupils, rings} = tonalDetail();
    const plan = C.plan(options), {rgba} = C.render(plan);
    const tone = pixels => pixels.reduce((sum, p) => sum +
        0.2126 * rgba[p * 4] + 0.7152 * rgba[p * 4 + 1] + 0.0722 * rgba[p * 4 + 2], 0) / pixels.length;
    assert.ok(tone(rings) - tone(pupils) > 28, 'centers must stay darker than their surrounding rings');
    assert.ok(tone(pupils) < 65, 'dark detail must not wash out into the midtones');
    let squared = 0;
    for (let i = 0; i < rgba.length; i++) if (i % 4 !== 3) squared += (rgba[i] - options.rgba[i]) ** 2;
    assert.ok(Math.sqrt(squared / (options.width * options.height * 3)) < 27, 'preserve the overall color image too');
    assert.ok(C.steps(plan).length <= options.maxLines);
    assert.equal(plan.stats.errorMetric, 'detail-boundary-srgb-v1');
});

test('existing version 2 paths still use the original linear-light coverage model', () => {
    const saved = {version: 2, mode: 'color', shape: 'rectangle', width: 4, height: 4,
        horizontalPins: 2, verticalPins: 2, pinCount: 8, background: '#ffffff', palette: ['#000000'],
        frameLongestCm: 30, threadDiameterMm: 0.5,
        render: {model: 'linear-coverage-v1', width: 4, height: 4, coverage: 0.5},
        layers: [{color: 0, sequence: [0, 5]}]};
    const {rgba} = C.render(saved);
    assert.deepEqual(Array.from(rgba.slice(0, 4)), [188, 188, 188, 255]);
    assert.deepEqual(Array.from(rgba.slice(4, 8)), [255, 255, 255, 255]);
});

test('rasterization is direction-independent, bounded and shares corner aliases', () => {
    const f = fixture();
    const forward = C.rasterizer(f, 32, 20), reverse = C.rasterizer(f, 32, 20);
    for (let a = 0; a < 44; a += 3) for (let b = 0; b < 44; b += 5) {
        assert.deepEqual(forward.line(a, b).pixels, reverse.line(b, a).pixels);
        for (const p of forward.line(a, b).pixels) assert.ok(p >= 0 && p < 640);
    }
    assert.equal(forward.line(0, 11).key, forward.line(43, 12).key);
});

for (const [name, w, h] of [['landscape', 32, 20], ['portrait', 20, 32], ['square', 24, 24]]) {
    test(`${name}: complete plan preserves geometry, improves image and survives JSON replay`, () => {
        const options = fixture(w, h), messages = [];
        const plan = C.plan(options, p => messages.push(p.stage));
        C.validatePlan(plan);
        assert.ok(plan.palette.length > 0 && plan.palette.length <= 5);
        assert.ok(plan.layers.length <= 5);
        assert.ok(C.steps(plan).length <= options.maxLines);
        assert.ok(plan.stats.finalError < plan.stats.initialError);
        assert.ok(messages.includes('Refining travel beneath later colors'));
        assert.deepEqual(C.render(plan), C.render(JSON.parse(JSON.stringify(plan))));
        assert.deepEqual([C.render(plan).width, C.render(plan).height], [w, h]);
        const context = C.prepare(options);
        let rendered = C.canvas(context.size, context.background);
        for (const layer of plan.layers) for (let i = 1; i < layer.sequence.length; i++)
            C.applyLine(rendered, context.raster.line(layer.sequence[i - 1], layer.sequence[i]), C.rgb(plan.palette[layer.color]), plan.render.coverage);
        close(C.imageError(rendered, context), plan.stats.finalError);
        close(plan.stats.pixelError + plan.stats.boundaryError, plan.stats.finalError);
        for (const item of C.shoppingList(plan)) assert.ok(item.suggestedMetres > item.pathMetres);
        for (let l = 0; l < plan.layers.length; l++) {
            const steps = C.steps(plan).filter(s => s.layer === l);
            assert.equal(steps[0].tieOn, true);
            assert.equal(steps.at(-1).tieOff, true);
            for (let i = 1; i < steps.length; i++) assert.equal(steps[i].from, steps[i - 1].to);
        }
    });
}

test('winding order changes the rendered result; later thread only partially covers earlier thread', () => {
    const p = C.plan(fixture());
    p.palette = ['#ff0000', '#0000ff'];
    p.layers = [{color: 0, sequence: [0, 22]}, {color: 1, sequence: [0, 22]}];
    const first = C.render(p);
    p.layers.reverse();
    assert.notDeepEqual(first.rgba, C.render(p).rgba);
});

test('circle uses a circular preview; blank and transparent inputs need no string', () => {
    const f = fixture(24, 24); f.shape = 'circle';
    const plan = C.plan(f);
    assert.equal(C.render(plan).rgba[3], 0);
    const transparent = fixture(); transparent.rgba.fill(0);
    const empty = C.plan(transparent);
    assert.deepEqual(empty.palette, []);
    assert.deepEqual(C.steps(empty), []);
    assert.deepEqual(C.shoppingList(empty), []);
    assert.equal(empty.stats.finalError, 0);
});

test('length estimates follow actual geometry and scale with the physical frame', () => {
    const p = C.plan(fixture());
    p.palette = ['#000000'];
    p.layers = [{color: 0, sequence: [0, 11]}]; // Entire long bottom edge, 30 cm.
    close(C.shoppingList(p)[0].pathMetres, 0.3);
    p.frameLongestCm = 60;
    close(C.shoppingList(p)[0].pathMetres, 0.6);
});

test('invalid saved settings, oversized work and corrupt paths are rejected', () => {
    const good = C.plan(fixture());
    for (const change of [p => p.palette[0] = '<script>', p => p.render.coverage = 1,
        p => p.render.width = 100000, p => p.render.model = 'unknown', p => p.layers[0].sequence = [0, 999],
        p => p.layers[0].sequence = [0, 0], p => p.layers[0].color = -1, p => p.frameLongestCm = -1]) {
        const p = structuredClone(good); change(p); assert.throws(() => C.validatePlan(p));
    }
    assert.throws(() => C.plan({...fixture(), maxLines: 10001}));
    assert.throws(() => C.plan({...fixture(), maxColors: 6}));
});

test('finished-plan order search chooses the better actual overlap order', () => {
    const red = [1, 0, 0], blue = [0, 0, 1];
    const context = {size: 1, background: white, target: C.canvas(1, red), palette: [red, blue], coverage: 0.7,
        raster: {line: () => line(0)}};
    const layers = [{color: 0, sequence: [0, 1]}, {color: 1, sequence: [0, 1]}];
    const reordered = C.reorder(layers, context).layers;
    assert.deepEqual(reordered.map(l => l.color), [1, 0]);
    assert.ok(C.objective(reordered, context) < C.objective(layers, context));
});

test('very narrow rectangles still round-trip their processing dimensions', () => {
    const f = fixture(2, 500); f.horizontalPins = 2; f.verticalPins = 24; f.maxLines = 5;
    const p = C.plan(f);
    C.validatePlan(p);
    assert.equal(p.width, 2); assert.equal(p.height, 500);
});

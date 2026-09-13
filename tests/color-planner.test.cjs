const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../color-planner.js');
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

test('palette keeps five distinct image colors and ignores the board', () => {
    const context = C.prepare(fixture());
    assert.equal(context.palette.length, 5);
    assert.equal(new Set(context.palette.map(C.hex)).size, 5);
    const same = fixture(); same.rgba.fill(255);
    assert.equal(C.prepare(same).palette.length, 0);
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
        close(C.pixelError(rendered, context.target), plan.stats.finalError);
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

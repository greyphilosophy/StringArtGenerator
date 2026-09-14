const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];

// Strict numerical/canvas doubles exercise the actual page pipeline. Any
// transposed dimensions or out-of-bounds pin sampling fails immediately.
function harness() {
    const elements = new Map(), jobs = [], images = [], arcs = [], strokes = [];
    function element(id) {
        if (!elements.has(id)) {
            const el = {value: '', checked: false, style: {}, classList: {add() {}, remove() {}, toggle() {}}, addEventListener() {}};
            const ctx = {canvas: el, clearRect() {}, fillRect() {}, beginPath() {}, closePath() {}, fill() {},
                arc(...args) { arcs.push(args); }, drawImage(...args) { images.push(args.slice(1)); },
                getImageData(x, y, width, height) {
                    assert.ok(width <= el.width && height <= el.height);
                    return {width, height, data: new Uint8ClampedArray(width * height * 4).fill(128)};
                }, putImageData() {}, moveTo(x, y) { assert.ok(Number.isFinite(x + y)); },
                lineTo(x, y) { assert.ok(x >= 0 && y >= 0 && x < el.width && y < el.height); },
                stroke() { strokes.push(id); }};
            el.getContext = () => ctx;
            elements.set(id, el);
        }
        return elements.get(id);
    }
    function matrix(shape, fill = 0, data) {
        const m = {shape, selection: {data: data || new Float64Array(shape.reduce((a, b) => a * b, 1)).fill(fill)},
            multiply(n) { this.selection.data = this.selection.data.map(v => v * n); return this; },
            subtract(other) {
                assert.deepEqual(Array.from(this.shape), Array.from(other.shape));
                this.selection.data = this.selection.data.map((v, i) => v - other.selection.data[i]); return this;
            }, reshape(...shape) {
                assert.equal(shape.reduce((a, b) => a * b, 1), this.selection.data.length); this.shape = shape; return this;
            }, index(y, x) {
                assert.ok(Number.isInteger(x) && Number.isInteger(y) && y >= 0 && x >= 0 && y < this.shape[0] && x < this.shape[1],
                    `Out of bounds: (${x}, ${y}) in ${this.shape}`);
                return y * this.shape[1] + x;
            }, get(y, x) { return this.selection.data[this.index(y, x)]; },
            set(y, x, value) { this.selection.data[this.index(y, x)] = value; }};
        return m;
    }
    const cv = {
        Mat: function() { this.delete = () => {}; },
        matFromArray: function(rows, cols, type, data) { assert.equal(rows * cols, data.length); this.rows = rows; this.cols = cols; this.delete = () => {}; },
        Size: function(width, height) { this.width = width; this.height = height; },
        Point: function(x, y) { this.x = x; this.y = y; }, Scalar: function() {},
        line(mat, a, b) { for (const p of [a, b]) assert.ok(p.x >= 0 && p.y >= 0 && p.x < mat.cols && p.y < mat.rows); },
        resize(src, dst, size) {
            assert.equal(src.cols / src.rows, size.width / size.height);
            dst.cols = size.width; dst.rows = size.height;
        }, imshow(id, mat) { element(id).width = mat.cols; element(id).height = mat.rows; }
    };
    const context = vm.createContext({document: {getElementById: element, querySelectorAll: () => [], body: {}},
        window: {scrollTo() {}, speechSynthesis: {getVoices() {}}}, console: {log() {}},
        URL: {createObjectURL() {}}, setTimeout(fn) { jobs.push(fn); }, cv,
        nj: {ones: shape => matrix(shape, 1), zeros: shape => matrix(shape), uint8: data => matrix([data.length], 0, Uint8Array.from(data))}});
    const run = code => vm.runInContext(code, context);
    context.ColorPlanner = require('../color-planner.js');
    run(script);
    run(fs.readFileSync(require('node:path').join(__dirname, '../color-ui.js'), 'utf8'));
    run('onOpenCvReady(); IMG_SIZE = 50; SCALE = 2; MAX_LINES = 12;');
    element('numberOfHPins').value = '12'; element('numberOfVPins').value = '12';
    const flush = () => { let limit = 10000; while (jobs.length) { assert.ok(limit-- > 0); jobs.shift()(); } };
    flush();
    return {run, element, images, arcs, strokes, flush};
}

for (const [name, source, output] of [
    ['landscape', [800, 400], [50, 25]], ['portrait', [400, 800], [25, 50]], ['square', [400, 400], [50, 50]]
]) {
    test(`${name}: full image, bounded pins, generation, saved replay and stepping`, () => {
        const h = harness();
        h.element('inlineRadio2').checked = true;
        Object.assign(h.element('imageSrc'), {naturalWidth: source[0], naturalHeight: source[1]});
        h.run('imgElement.onload()'); h.flush();
        assert.deepEqual(h.images[0], [0, 0, ...source, 0, 0, ...output]);
        assert.equal(h.arcs.length, 0, 'rectangles must not be circle-masked');
        assert.equal(h.element('status').textContent, 'Complete');
        const saved = JSON.parse(h.element('pinsOutput').value);
        assert.deepEqual([saved.width, saved.height], output);
        assert.equal(saved.sequence.length, 13);
        const coords = JSON.parse(h.run('JSON.stringify(pin_coords)'));
        for (const [x, y] of coords) {
            assert.ok(x >= 0 && x < output[0] && y >= 0 && y < output[1]);
            assert.ok(x === 0 || y === 0 || x === output[0] - 1 || y === output[1] - 1);
        }
        assert.deepEqual(coords[0], [0, output[1] - 1]);
        assert.deepEqual(coords[11], [output[0] - 1, output[1] - 1]);
        assert.deepEqual(coords[23], [output[0] - 1, 0]);
        const fresh = harness(); // No uploaded image and no existing pin coordinates.
        fresh.element('pinsOutput').value = JSON.stringify(saved);
        fresh.run('startDrawing()'); fresh.flush();
        assert.equal(fresh.strokes.length, 12, 'replay includes every saved line');
        assert.deepEqual([fresh.element('canvasOutput3').width, fresh.element('canvasOutput3').height], output.map(n => n * 2));
        fresh.run('startCreating(); nextStep(); lastStep();');
        fresh.run('for (let step = 0; step < 30; step++) nextStep();');
        assert.equal(fresh.run('pointIndex'), 12);
    });
}

test('circle still center crops and masks; another upload restores rectangle dimensions', () => {
    const h = harness();
    Object.assign(h.element('imageSrc'), {naturalWidth: 800, naturalHeight: 400});
    h.run('imgElement.onload()'); h.flush();
    assert.deepEqual(h.images[0], [200, 0, 400, 400, 0, 0, 50, 50]);
    assert.equal(h.arcs.length, 1);
    h.element('inlineRadio2').checked = true;
    h.run('imgElement.onload()'); h.flush();
    assert.deepEqual(h.images[1], [0, 0, 800, 400, 0, 0, 50, 25]);
    assert.equal(h.arcs.length, 1);
});

test('legacy circle and square instructions remain usable', () => {
    const h = harness();
    h.element('pinsOutput').value = '0,20,40';
    h.run('startDrawing()'); h.flush();
    assert.equal(h.strokes.length, 2);
    h.element('inlineRadio2').checked = true;
    h.run('startDrawing()'); h.flush();
    assert.equal(h.strokes.length, 4);
    assert.deepEqual(JSON.parse(h.run('JSON.stringify(pin_coords[0])')), [0, 49]);
});

test('invalid saved geometry and pin indices fail without drawing', () => {
    const h = harness();
    for (const text of ['{', '0,99999', '{"version":2}', JSON.stringify({version: 1, shape: 'rectangle', width: 50, height: 25, horizontalPins: 1, verticalPins: 12, sequence: [0, 2]})]) {
        h.element('pinsOutput').value = text;
        h.run('startDrawing()'); h.flush();
        assert.match(h.element('status').textContent, /Could not load instructions/);
    }
    assert.equal(h.strokes.length, 0);
});

test('invalid rectangle pin spacing is reported before image processing', () => {
    const h = harness();
    h.element('inlineRadio2').checked = true;
    Object.assign(h.element('imageSrc'), {naturalWidth: 800, naturalHeight: 400});
    h.element('numberOfVPins').value = '26';
    h.run('imgElement.onload()'); h.flush();
    assert.match(h.element('status').textContent, /25 vertical pins/);
    assert.equal(h.images.length, 0);
});

test('color uploads preserve the original crop at 1280 pixels before worker planning', () => {
    for (const [rectangle, source, crop, output] of [
        [true, [1600, 1200], [0, 0, 1600, 1200], [1280, 960]],
        [true, [1200, 1600], [0, 0, 1200, 1600], [960, 1280]],
        [false, [1600, 1200], [200, 0, 1200, 1200], [1280, 1280]]
    ]) {
        const h = harness();
        h.element('renderMode').value = 'color';
        h.element('inlineRadio2').checked = rectangle;
        Object.assign(h.element('imageSrc'), {naturalWidth: source[0], naturalHeight: source[1]});
        h.run('startColorGeneration = () => { globalThis.workerSize = [IMG_WIDTH, IMG_HEIGHT]; }; imgElement.onload();');
        assert.deepEqual(h.images[0], [...crop, 0, 0, ...output]);
        assert.deepEqual(JSON.parse(h.run('JSON.stringify(workerSize)')), output);
    }
});

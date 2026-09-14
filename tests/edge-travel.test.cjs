const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../color-planner.js');
const frame = {shape: 'rectangle', width: 40, height: 30, horizontalPins: 12, verticalPins: 10, pinCount: 44};

test('edge transits stay on one physical side and exclude coincident corner aliases', () => {
    const raster = C.rasterizer(frame, 40, 30);
    assert.equal(raster.side(5, 6), 'bottom');
    assert.equal(raster.side(12, 20), 'right');
    assert.equal(raster.side(25, 28), 'top');
    assert.equal(raster.side(35, 40), 'left');
    assert.equal(raster.side(10, 13), null, 'two sides meeting at a corner are not one edge');
    assert.equal(raster.side(5, 25), null);
    assert.equal(raster.side(11, 12), null, 'corner aliases are the same nail');
    assert.equal(raster.side(0, 43), null);
    const circle = C.rasterizer({...frame, shape: 'circle', height: 40}, 40, 40);
    assert.equal(circle.side(0, 1), null, 'a circular chord is not a same-side transit');
});

test('a short edge transit unlocks a precise stroke, but an unfinished harmful transit is rejected', () => {
    const raster = C.rasterizer(frame, 40, 30), data = C.canvas(1200, [1, 1, 1]), target = data.slice();
    // A thin dark stroke starts at bottom pin 6. The spool is at pin 5;
    // attempting it directly from there damages the surrounding white field.
    for (const p of raster.line(6, 25).pixels) if (p < 1160) target.fill(0, p * 3, p * 3 + 3);
    const context = {target, coverage: 0.5, raster, edgeTravel: true};
    const choose = (budget, edgeTravel) => C.chooseMoves(5, data, [0, 0, 0], null, new Map(), {...context, edgeTravel}, budget, true);
    assert.equal(choose(2, false).moves.length, 0);
    assert.equal(choose(1, true).moves.length, 0);
    const choice = choose(2, true);
    assert.deepEqual(choice.moves.map(move => move.to), [6, 25]);
    assert.equal(choice.moves[0].line.edge, 'bottom');
    assert.ok(choice.moves[0].gain < 0 && choice.gain > 0);
    assert.deepEqual(data, C.canvas(1200, [1, 1, 1]), 'lookahead restores its canvas');

    const plan = {...frame, version: 2, mode: 'color', background: '#ffffff', palette: ['#000000'],
        frameLongestCm: 39, threadDiameterMm: 0.5, render: {model: 'linear-coverage-v1', width: 40, height: 30, coverage: 0.5},
        layers: [{color: 0, sequence: [5, ...choice.moves.map(move => move.to)]}]};
    C.validatePlan(plan);
    const steps = C.steps(plan);
    assert.equal(steps.length, 2, 'edge travel counts as a winding');
    assert.equal(steps[0].edge, 'bottom');
    assert.equal(steps[1].edge, null);
    assert.equal(steps[0].to, steps[1].from);
    assert.equal(steps[0].tieOff, false);
    assert.equal(steps[1].tieOn, false, 'the spool continues without cutting');
    // 4 cm along the bottom, then a diagonal with 7 cm and 29 cm components.
    assert.ok(Math.abs(C.shoppingList(plan)[0].pathMetres - (4 + Math.hypot(7, 29)) / 100) < 1e-10);
    assert.deepEqual(C.render(plan), C.render(JSON.parse(JSON.stringify(plan))));
    assert.ok(C.render(plan, 1).rgba.some((value, i) => i % 4 !== 3 && value < 255), 'travel is visibly rendered');
});

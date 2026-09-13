// Run by CI with Playwright installed. The actual page, Worker, Canvas and saved
// instructions are exercised; color mode intentionally needs no external CDN.
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
let server, browser, base;
before(async () => {
    server = http.createServer(async (req, res) => {
        const name = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
        const allowed = ['index.html', 'color-planner.js', 'color-worker.js', 'color-ui.js', 'style.css', 'opencv.js'];
        if (!allowed.includes(name)) {res.writeHead(404); res.end(); return;}
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(await fs.readFile(path.join(root, name)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({headless: true});
});
after(async () => { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function page() {
    const p = await browser.newPage();
    // This verifies the new color workflow works without NumJS/OpenCV or CDN access.
    await p.route(/^https:\/\//, route => route.abort());
    await p.route('**/opencv.js', route => route.abort());
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(base);
    return {p, errors};
}
const image = (w = 300, h = 180) => ({name: 'test-pattern.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f0aa19"/><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 3}" ry="${h / 3}" fill="#c81e32"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 5}" fill="#1e50dc"/></svg>`)});
async function configure(p, lines = 60) {
    await p.getByLabel('Rectangle', {exact: true}).check();
    await p.getByLabel('Thread plan', {exact: true}).selectOption('color');
    await p.getByLabel('Number of Horizontal Pins', {exact: true}).fill('12');
    await p.getByLabel('Number of Vertical Pins', {exact: true}).fill('12');
    await p.getByLabel('Number of Lines', {exact: true}).fill(String(lines));
}
async function generate(p, w = 300, h = 180, lines = 60) {
    await configure(p, lines);
    await p.locator('#fileInput').setInputFiles(image(w, h));
    await p.getByRole('heading', {name: 'Color plan complete', exact: true}).waitFor({timeout: 60000});
    return JSON.parse(await p.locator('#pinsOutput').inputValue());
}

test('upload → worker → shopping list → colored playback → fresh-session restore', async () => {
    const {p, errors} = await page();
    try {
        const plan = await generate(p);
        assert.equal(plan.version, 2);
        assert.equal(plan.background, 'transparent');
        assert.equal(await p.locator('#backgroundMode').inputValue(), 'transparent');
        assert.equal(await p.locator('#boardColor').isVisible(), false);
        assert.equal(await p.locator('#canvasOutput2').evaluate(c => c.classList.contains('transparent-preview')), true);
        assert.equal(await p.locator('#canvasOutput2').evaluate(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v < 255)), true);
        assert.ok(plan.palette.length > 0 && plan.palette.length <= 5);
        assert.equal(plan.width / plan.height, 500 / 300);
        assert.match(await p.locator('#colorSummary').innerText(), /buy about/);
        await p.getByRole('button', {name: 'Just Draw', exact: true}).click();
        await p.waitForFunction(() => { const n = JSON.parse(document.querySelector('#pinsOutput').value).layers.reduce((sum, l) => sum + l.sequence.length - 1, 0); return document.querySelector('#incrementalCurrentStep').textContent.startsWith('Line ' + n + '/' + n + ' '); });
        const generated = await p.locator('#canvasOutput2').evaluate(c => c.toDataURL());
        const replayed = await p.locator('#canvasOutput3').evaluate(c => c.toDataURL());
        assert.equal(replayed, generated, 'playback must use exactly the generation coverage model');
        await p.reload();
        await p.getByRole('button', {name: 'Click Here', exact: true}).click();
        await p.locator('#pinsOutput').fill(JSON.stringify(plan));
        await p.getByRole('button', {name: 'Start Creating', exact: true}).click();
        assert.match(await p.locator('#incrementalCurrentStep').innerText(), /Line 1\/.*Tie on at pin/);
        await p.getByRole('button', {name: 'Next Step', exact: true}).click();
        await p.getByRole('button', {name: 'Last Step', exact: true}).click();
        assert.match(await p.locator('#incrementalCurrentStep').innerText(), /Line 1\//);
        await p.getByRole('button', {name: 'Just Draw', exact: true}).click();
        await p.waitForFunction(() => { const n = JSON.parse(document.querySelector('#pinsOutput').value).layers.reduce((sum, l) => sum + l.sequence.length - 1, 0); return document.querySelector('#incrementalCurrentStep').textContent.startsWith('Line ' + n + '/' + n + ' '); });
        assert.equal(await p.locator('#canvasOutput3').evaluate(c => c.toDataURL()), generated);
        assert.deepEqual(errors, []);
    } finally { await p.close(); }
});

test('portrait layout, cancelled work and invalid input recover cleanly', async () => {
    const {p, errors} = await page();
    try {
        await p.getByLabel('Thread plan', {exact: true}).selectOption('color');
        await p.getByLabel('Number of Lines', {exact: true}).fill('10000');
        await p.locator('#fileInput').setInputFiles(image());
        await p.getByRole('button', {name: 'Cancel color planning', exact: true}).click();
        assert.match(await p.locator('#status').innerText(), /cancelled/);
        assert.equal(await p.locator('#fileInput').isEnabled(), true);
        await p.getByLabel('Maximum colors', {exact: true}).fill('6');
        await p.locator('#fileInput').setInputFiles(image());
        await p.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Could not plan colors:'));
        assert.equal(await p.locator('#fileInput').isEnabled(), true);
        await p.getByLabel('Maximum colors', {exact: true}).fill('5');
        const plan = await generate(p, 180, 300, 25);
        assert.equal(plan.width / plan.height, 300 / 500);
        const dims = await p.locator('#canvasOutput2').evaluate(c => ({w: c.width, h: c.height, box: c.getBoundingClientRect().toJSON()}));
        assert.equal(dims.w / dims.h, 0.6);
        assert.ok(Math.abs(dims.box.width / dims.box.height - 0.6) < 0.01);
        await p.getByRole('button', {name: 'Just Draw', exact: true}).click();
        await p.waitForFunction(() => { const n = JSON.parse(document.querySelector('#pinsOutput').value).layers.reduce((sum, l) => sum + l.sequence.length - 1, 0); return document.querySelector('#incrementalCurrentStep').textContent.startsWith('Line ' + n + '/' + n + ' '); });
        // Legacy playback must clear previously loaded color metadata.
        await p.locator('#pinsOutput').fill('0,20,40');
        await p.getByRole('button', {name: 'Just Draw', exact: true}).click();
        assert.equal(await p.locator('#colorSummary').isVisible(), false);
        assert.equal(await p.locator('#canvasOutput3').evaluate(c => c.classList.contains('transparent-preview')), false);
        assert.deepEqual(errors, []);
    } finally { await p.close(); }
});

test('upload alpha is preserved, white needs thread on an open frame, solid boards remain optional', async () => {
    const {p, errors} = await page();
    try {
        await configure(p, 20);
        const whiteOnTransparent = {name: 'white-on-transparent.svg', mimeType: 'image/svg+xml',
            buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect x="60" y="0" width="180" height="180" fill="white"/></svg>')};
        await p.locator('#fileInput').setInputFiles(whiteOnTransparent);
        await p.getByRole('heading', {name: 'Color plan complete', exact: true}).waitFor({timeout: 60000});
        const open = JSON.parse(await p.locator('#pinsOutput').inputValue());
        assert.deepEqual(open.palette, ['#ffffff']);
        assert.ok(open.layers.length > 0);
        const sourceAlpha = await p.locator('#canvasOutput').evaluate(c => {
            const ctx = c.getContext('2d');
            return [ctx.getImageData(0, 0, 1, 1).data[3], ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data[3]];
        });
        assert.deepEqual(sourceAlpha, [0, 255], 'upload must not flatten transparent pixels onto a matte');
        await p.getByLabel('Background', {exact: true}).selectOption('solid');
        assert.equal(await p.locator('#boardColor').isVisible(), true);
        await p.locator('#fileInput').setInputFiles(whiteOnTransparent);
        await p.waitForFunction(() => document.querySelector('#status').textContent.startsWith('No improving thread paths found.'));
        const solid = JSON.parse(await p.locator('#pinsOutput').inputValue());
        assert.equal(solid.background, '#ffffff');
        assert.deepEqual(solid.layers, []);
        assert.equal(await p.locator('#canvasOutput2').evaluate(c => c.classList.contains('transparent-preview')), false);
        assert.equal(await p.locator('#canvasOutput2').evaluate(c => c.getContext('2d').getImageData(0, 0, 1, 1).data[3]), 255);
        await p.reload();
        await p.getByRole('button', {name: 'Click Here', exact: true}).click();
        await p.locator('#pinsOutput').fill(JSON.stringify(solid));
        await p.getByRole('button', {name: 'Just Draw', exact: true}).click();
        assert.equal(await p.locator('#canvasOutput3').evaluate(c => c.getContext('2d').getImageData(0, 0, 1, 1).data[3]), 255);
        assert.equal(await p.locator('#canvasOutput3').evaluate(c => c.classList.contains('transparent-preview')), false);
        assert.deepEqual(errors, []);
    } finally { await p.close(); }
});

// Procedural test image: shaded brown field, pale blaze and dark centers inside
// colored rings. No user photograph or third-party image is included.
module.exports = function tonalDetail() {
    const width = 80, height = 60, rgba = new Uint8ClampedArray(width * height * 4);
    const pupils = [], rings = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const shade = 0.55 + 0.5 * x / width + 0.2 * y / height;
        let color = [100, 80, 46].map(v => Math.round(v * shade));
        // A broad dark area keeps contrast endpoints representative of the
        // image instead of requiring the palette to follow isolated noise.
        if (x < 18 && y > 38) color = [24, 19, 10];
        if (((x - 42) / 9) ** 2 + ((y - 39) / 13) ** 2 < 1) color = [238, 231, 195];
        for (const [cx, cy] of [[26, 23], [55, 18]]) {
            const r = Math.hypot(x - cx, y - cy);
            if (r < 8) color = [46, 34, 15];
            if (r < 6) { color = [157, 132, 42]; if (r > 4.5) rings.push(y * width + x); }
            if (r < 3.5) { color = [16, 18, 9]; pupils.push(y * width + x); }
        }
        rgba.set([...color, 255], (y * width + x) * 4);
    }
    return {options: {width, height, rgba, shape: 'rectangle', horizontalPins: 24, verticalPins: 18,
        pinCount: 84, maxColors: 5, maxLines: 1600, frameLongestCm: 30, threadDiameterMm: 0.6, background: '#ffffff'}, pupils, rings};
};

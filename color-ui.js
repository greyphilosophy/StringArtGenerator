/* Browser integration. Color generation runs in a disposable worker. */
let generationBusy = false;
let playbackToken = 0;
let colorWorker = null;
let colorPlan = null;
let colorSteps = [];
let colorStepIndex = 0;
status.textContent = 'Choose a thread plan and upload an image.';

function showColorOptions() {
    document.getElementById('colorOptions').classList.toggle('hidden', document.getElementById('renderMode').value !== 'color');
}
function setGenerationBusy(busy) {
    generationBusy = busy;
    document.querySelectorAll('.jumbotron input, .jumbotron select, .jumbotron button').forEach(el => {
        if (el.id !== 'cancelColor') el.disabled = busy;
    });
}
function cancelColorGeneration() {
    if (colorWorker) colorWorker.terminate();
    colorWorker = null;
    setGenerationBusy(false);
    document.getElementById('cancelColor').classList.add('hidden');
    status.textContent = 'Color planning cancelled. Select an image to try again.';
    inputElement.value = '';
}
function startColorGeneration() {
    try {
        const options = {
            shape: isRectangle ? 'rectangle' : 'circle', width: IMG_WIDTH, height: IMG_HEIGHT,
            horizontalPins: N_HPINS, verticalPins: N_VPINS, pinCount: N_PINS,
            rgba: ctx.getImageData(0, 0, IMG_WIDTH, IMG_HEIGHT).data,
            background: document.getElementById('boardColor').value,
            maxColors: Number(document.getElementById('colorCount').value),
            maxLines: Number(numberOfLines.value),
            frameLongestCm: Number(document.getElementById('frameLongestCm').value),
            threadDiameterMm: Number(document.getElementById('threadDiameterMm').value)
        };
        const worker = new Worker('color-worker.js');
        colorWorker = worker;
        setGenerationBusy(true);
        document.getElementById('cancelColor').classList.remove('hidden');
        status.textContent = 'Choosing thread colors…';
        showStep(2);
        worker.onmessage = event => {
            if (worker !== colorWorker) return;
            if (event.data.type === 'progress') {
                const p = event.data.progress;
                status.textContent = p.stage + ' (' + p.completed + '/' + p.total + ')';
                return;
            }
            worker.terminate();
            colorWorker = null;
            setGenerationBusy(false);
            document.getElementById('cancelColor').classList.add('hidden');
            if (event.data.type === 'error') {
                status.textContent = 'Could not plan colors: ' + event.data.message;
                inputElement.value = '';
                return;
            }
            try {
                applyColorPlan(ColorPlanner.validatePlan(event.data.plan));
                pinsOutput.value = JSON.stringify(colorPlan);
                paintColorPlan(ctx2);
                showStep(3);
                showPins.classList.remove('hidden');
                drawStatus.textContent = colorSteps.length + ' lines in ' + colorPlan.layers.length + ' color layers';
                status.textContent = colorSteps.length ? 'Color plan complete' : 'No improving thread paths found. Try another image or background.';
                window.scrollTo({top: 5000, left: 0, behavior: 'smooth'});
            } catch (error) {
                status.textContent = 'Could not display color plan: ' + error.message;
            }
        };
        worker.onerror = () => {
            if (worker !== colorWorker) return;
            cancelColorGeneration();
            status.textContent = 'Color planner could not start. Serve this page over HTTP or HTTPS and try again.';
        };
        worker.postMessage(options, [options.rgba.buffer]);
    } catch (error) {
        cancelColorGeneration();
        status.textContent = 'Could not plan colors: ' + error.message;
    }
}
function applyColorPlan(plan) {
    colorPlan = plan;
    colorSteps = ColorPlanner.steps(plan);
    colorStepIndex = 0;
    isRectangle = plan.shape === 'rectangle';
    IMG_WIDTH = plan.width;
    IMG_HEIGHT = plan.height;
    N_HPINS = plan.horizontalPins;
    N_VPINS = plan.verticalPins;
    N_PINS = plan.pinCount;
    CalculatePins();
    showColorSummary();
}
function showColorSummary() {
    const summary = document.getElementById('colorSummary');
    summary.replaceChildren();
    summary.classList.remove('hidden');
    const title = document.createElement('h3');
    title.textContent = 'Thread shopping list & winding order';
    summary.appendChild(title);
    const note = document.createElement('p');
    note.textContent = 'Match these swatches approximately. Wind the layers in the listed order; tie off before changing colors. Buy lengths include 20% extra plus 1 metre per layer for wraps and knots. Actual coverage and overlap will vary.';
    summary.appendChild(note);
    const frame = document.createElement('p');
    frame.textContent = 'Background ' + colorPlan.background + ' · Longest side / diameter ' + colorPlan.frameLongestCm + ' cm · Thread diameter ' + colorPlan.threadDiameterMm + ' mm';
    summary.appendChild(frame);
    const list = document.createElement('ol');
    for (const item of ColorPlanner.shoppingList(colorPlan)) {
        const li = document.createElement('li');
        const swatch = document.createElement('span');
        swatch.className = 'thread-swatch';
        swatch.style.backgroundColor = item.color;
        li.appendChild(swatch);
        const description = document.createElement('span');
        description.textContent = item.color.toUpperCase() + ' — layer ' + item.layers.join(', ') + ' · ' + item.lines + ' lines · path ' + item.pathMetres.toFixed(1) + ' m · buy about ' + item.suggestedMetres + ' m';
        li.appendChild(description);
        list.appendChild(li);
    }
    summary.appendChild(list);
    const order = document.createElement('p');
    order.textContent = colorPlan.layers.length ? 'Wind in this order: ' + colorPlan.layers.map((l, i) =>
        (i + 1) + '. ' + colorPlan.palette[l.color].toUpperCase() + ' (tie on at pin ' + l.sequence[0] + ', tie off at pin ' + l.sequence[l.sequence.length - 1] + ')').join(' → ') : 'No thread paths in this plan.';
    summary.appendChild(order);
}
function paintColorPlan(context, limit = Infinity) {
    const rendered = ColorPlanner.render(colorPlan, limit);
    const buffer = document.createElement('canvas');
    buffer.width = rendered.width;
    buffer.height = rendered.height;
    const small = buffer.getContext('2d');
    const pixels = small.createImageData(rendered.width, rendered.height);
    pixels.data.set(rendered.rgba);
    small.putImageData(pixels, 0, 0);
    context.canvas.width = colorPlan.width * 2;
    context.canvas.height = colorPlan.height * 2;
    context.drawImage(buffer, 0, 0, context.canvas.width, context.canvas.height);
}
function startColorPlayback(automatic) {
    listenForKeys = !automatic;
    incrementalDrawing.classList.remove('hidden');
    colorStepIndex = 0;
    if (!automatic) colorStepIndex = Math.min(1, colorSteps.length);
    paintColorProgress(!automatic);
    const run = playbackToken;
    if (automatic) {
        (function tick() {
            if (run !== playbackToken) return;
            colorStepIndex = Math.min(colorStepIndex + 20, colorSteps.length);
            paintColorProgress(false);
            if (colorStepIndex < colorSteps.length) setTimeout(tick, 0);
        })();
    }
    window.scrollTo({top: 5000, left: 0, behavior: 'smooth'});
}
function colorStep(direction) {
    playbackToken++; // Stop automatic drawing before manual navigation.
    colorStepIndex = Math.max(Math.min(1, colorSteps.length), Math.min(colorSteps.length, colorStepIndex + direction));
    paintColorProgress(true);
}
function paintColorProgress(highlight) {
    paintColorPlan(ctx3, colorStepIndex);
    if (!colorSteps.length) {
        incrementalCurrentStep.textContent = 'No thread paths in this plan.';
        return;
    }
    if (!colorStepIndex) {
        incrementalCurrentStep.textContent = 'Ready to draw.';
        return;
    }
    const step = colorSteps[colorStepIndex - 1], color = colorPlan.palette[step.color].toUpperCase();
    incrementalCurrentStep.textContent = 'Line ' + colorStepIndex + '/' + colorSteps.length + ' · Layer ' + (step.layer + 1) +
        ' · Thread ' + color + ' · ' + (step.tieOn ? 'Tie on at pin ' : 'Pin ') + step.from + ' → ' + step.to +
        (step.tieOff ? ' · Tie off here' : '');
    if (highlight) {
        ctx3.beginPath();
        ctx3.moveTo(pin_coords[step.from][0] * 2, pin_coords[step.from][1] * 2);
        ctx3.lineTo(pin_coords[step.to][0] * 2, pin_coords[step.to][1] * 2);
        ctx3.strokeStyle = '#ff00ff';
        ctx3.lineWidth = 2;
        ctx3.stroke();
    }
}

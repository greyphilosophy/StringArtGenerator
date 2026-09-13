# StringArtGenerator
Web based string art generator

This project is heavily based on the work of reddit user /u/kmmeerts from his post: https://www.reddit.com/r/DIY/comments/au0ilz/made_a_string_art_portrait_out_of_a_continuous_2/
Fork of halfmonty's work at https://github.com/halfmonty/StringArtGenerator

To use the original circle generator, navigate to: https://halfmonty.github.io/StringArtGenerator/

This version includes a rectangle generator at https://greyphilosophy.github.io/StringArtGenerator/.

## Rectangular frames

1. Select **Rectangle** and set the horizontal and vertical pin counts.
2. Upload an ordinary image. Its full width and height are preserved, with the longest side processed at 500 pixels. Landscape, portrait, and square images are supported.
3. Use a frame with the same width-to-height ratio as the image. To fit an existing frame, crop the image to that ratio before uploading; do not squeeze or stretch it. Pin counts control spacing, not the frame's proportions.
4. Copy the **entire saved instructions text**, including the frame settings, to keep your pattern. Paste it back later and choose **Start Creating** or **Just Draw**; no image upload is needed.

The previews and creation assistant preserve the same proportions as the generated pattern. Circle mode still center-crops the source to a square and uses a circular frame.

Rectangle pin numbering retains the original order: along the bottom from left to right, up the right side, along the top from right to left, and down the left side. Each side's count includes both corners. A shared corner therefore has two consecutive pin numbers referring to the same physical nail (the bottom-left corner uses the last number and 0). The number of distinct nails is `2 * horizontalPins + 2 * verticalPins - 4`.

New saved patterns include shape, processing dimensions, pin counts, and the sequence in JSON. Old comma-separated sequences still work: select their original shape and pin counts before playback. Old rectangle sequences have no aspect-ratio metadata and are displayed as squares, as before. Previously pre-squeezed source images should be replaced with the original images when generating a new rectangle pattern.

## Tests

Run `node --test tests/*.test.cjs` with Node.js 18 or newer. No dependencies are required. The tests execute the page's JavaScript with strict canvas and numerical doubles, covering landscape/portrait/square generation, circular cropping, pixel bounds, saved-pattern replay in a fresh session, navigation boundaries, legacy sequences, and invalid settings. These tests do not replace a browser smoke test with the real NumJS/OpenCV libraries.

![](test2.gif)

## Automatic color plans

Select **Automatic colors**, choose a maximum of **1–5 colors** (default 5), and upload your original image. The generator recommends approximate thread swatches and a winding order. There is no manufacturer catalog to match and no purchasing action. Simpler images may produce fewer colors, and a blank image matching the background needs no thread.

Set the **background color**, **longest frame side or circle diameter in centimetres**, and **thread diameter in millimetres** before uploading. Frame size and thread diameter affect the coverage simulation. The **Number of Lines** field is a total maximum across all colors, not a quota per color. Generation may stop earlier when it finds no beneficial moves. **Line Weight** continues to apply only to black-string mode. To regenerate with changed settings, select the same image again.

The result includes:

- A preview made with the same coverage model used by the optimizer and playback.
- A shopping list with color swatches/hex values, path lengths, and suggested purchase lengths. Purchase estimates add **20% plus 1 metre per layer** for wraps and knots; these are planning allowances, not measured consumption.
- Numbered color layers, with explicit tie-on and tie-off pins. Each layer is a continuous path; there is no invisible jump between pins. Tie off and start the next spool at each layer boundary.
- Color-aware **Start Creating**, **Next Step**, **Last Step**, and **Just Draw**. In manual mode, magenta marks the current segment; the text identifies its actual thread color.
- Version 2 saved instructions containing the palette, order, geometry, coverage settings, and paths. Copy the entire text to restore the plan on a fresh page. Version 1 and old comma-separated black-string patterns still work.

### How paths and order are chosen

`color-planner.js` is a dependency-free numerical module shared by the worker, rendering, and tests. Automatic color mode does not depend on NumJS or OpenCV. Work runs in `color-worker.js`, so the page stays interactive and **Cancel color planning** can stop it. Generation supports up to 500 pin numbers and 10,000 total lines. A bounded cache and an image with a longest working dimension of 160 pixels keep the search practical in a browser.

The planner clusters image colors in linear RGB, excluding pixels matching the background. It compares short trial plans for population-based, light-first and dark-first palette orders, then generates the full plan using the best trial order. Once the paths exist, it evaluates **all permutations of the used layers** (at most 120), rather than assuming a universal dark-to-light rule. This is a heuristic search, not proof of a globally optimal palette or winding.

Each segment is scored by the **reduction in squared image error**, including both improved and damaged pixels. Small thread-length and repeated-route buildup costs remain even if a route is later covered. When a greedy path stalls, and periodically during the search, a four-candidate, two-move lookahead can accept a harmful first move if the complete connected pair has positive net value. It never commits a harmful half-pair at the line-budget boundary.

A refinement pass rebuilds each earlier color with the later windings fixed. Their actual paths form a per-pixel coverage transform, so an early travel segment can receive a discount for later coverage. A replacement is retained only if it improves the complete plan's image-and-material objective. The finished order is compared again after refinement. Colors are wound once each in this version; switching repeatedly between spools and larger lookahead searches are not implemented.

The preview uses **partial pixel coverage in linear light**, with later threads covering a fraction of the earlier appearance. It is an approximation of thin opaque threads viewed from a distance, not additive screen-light mixing. It cannot predict the exact placement of adjacent threads, physical stacking, shadows, gloss, or the effect of substituting a different thread color. Coverage is derived from thread diameter relative to the working pixel size, bounded to 0.1–95% per pass. It intentionally never assumes a later thread perfectly hides earlier travel.

### Color verification

`node --test tests/*.test.cjs` covers net damage, discounted but nonzero covered-travel damage, beneficial connected lookahead, length/buildup penalties, actual layer-order comparison, automatic palette selection, geometry, JSON replay, physical length scaling, and malformed plans, alongside the existing monochrome regressions.

CI also runs `node --test tests/browser/*.cjs` with Playwright and Chromium. These tests serve the actual page and worker, block external CDNs to verify color mode is independent of them, and exercise upload, generation, shopping lists, pixel-identical automatic playback, fresh-session restore, manual navigation, cancellation, invalid-input recovery, portrait layout, and switching back to legacy instructions.

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

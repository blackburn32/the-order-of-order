# Capture Studio

The Capture Studio is a development-only page for producing repeatable game
screenshots from the real Phaser renderers. It does not initialize active-run
storage, and its full-game presets omit tutorial state, so opening it cannot
replace a player's saved run.

## Interactive studio

Start Vite using the repository's checked-in entry point:

```powershell
node node_modules/vite/bin/vite.js --host 127.0.0.1
```

Then open `http://127.0.0.1:5173/capture.html`. Choose a preset, frame, and
backdrop. **Play animation** triggers motion presets, **Download PNG** captures
only the game canvas, and **Open clean preview** removes the controls for browser
or screen-recording work.

The `R` key restarts a preset and `P` downloads a PNG.

Motion presets expose the real game interaction through the studio's `play()`
hook so a recorder can begin on a clean, settled first frame.

`shop-loop` is scripted rather than a single interaction: `play()` performs one
whole shop visit — buy two cards, reroll, open a booster and claim a card from
it, buy another card, reroll — and its last beat re-stages the visit's opening
shelf so the clip loops on an identical frame. The beats and their pacing live
in `shopLoop.ts`; the studio publishes the reel's length as `playDurationMs` and
its outcome as `script`, so the recorder never ships a take in which a beat was
refused.

`gameplay-grid-growth` and `gameplay-late-grid` are scripted the same way, by the
shared reel in `rollReel.ts`: `play()` presses the seal a number of times, waiting
for GameScene to finish presenting each roll and then holding a beat before
pressing again, so the rolls read as separate beats rather than as one continuous
scramble. It presses the seal the player presses and watches the scene's own roll
flag, so the pacing follows the real animation instead of a second copy of its
timings. Each preset's roll count and rests live in a `RollReelConfig` there.

The late-grid reel is the site's closing clip, and it is built to loop. Its
fixture's opening faces are the ones its last roll lands on — `presets.ts` rolls
the pool forward with the same RNG keys the reel will use, without scoring it
(see `alignToReelClose`) — so the clip's first and last frames draw the same 168
dice, and only the score and roll counter differ across the seam. The grid reel
cannot do this: its whole subject is a grid that grows from 24 dice to 102.

A preset names the performance its `play()` runs in `presets.ts` (`script:`), and
the studio publishes that script's length as `playDurationMs` and its outcome as
`script`. The other motion presets name none: their `play()` triggers a single
interaction and the recorder times them itself.

`gameplay-multitude-zoom` installs an exact 100,489-die bucketed run, begins at
the game's maximum grid zoom, and drives the real wheel handler out to its
one-card minimum and back. The clip therefore exercises GameScene's own camera,
LOD thresholds, spatial summaries, and `DiceSummaryCard` merging rather than a
marketing-only imitation of them.

A pointer travels between the controls and clicks them, drawn by
`CaptureCursor.ts`. It is a scene of its own above the one it points at: the
shop rebuilds its whole display list on every purchase and every reroll, and a
cursor parented to it would go with it. It has to be drawn into the canvas at
all because a recorder captures the canvas alone — a real mouse cursor, or any
DOM element over the canvas, appears in no clip. The reel hovers each target
before pressing it, so the control lights the way it would under a real pointer,
and the pointer rests on the reel's closing target from the first frame, which
is why the still carries it too.

## Automated captures

Generate every standard capture at its preferred aspect ratio:

```powershell
node scripts/capture-marketing.mjs
```

Capture one preset or override its output frame/background:

```powershell
node scripts/capture-marketing.mjs --preset cards-core
node scripts/capture-marketing.mjs --preset cards-core --format portrait
node scripts/capture-marketing.mjs --preset cards-core --backdrop transparent
```

Generate the standard silent WebM loops (a shop visit, grid growth, and a
late-game roll):

```powershell
node scripts/capture-marketing-motion.mjs
node scripts/capture-marketing-motion.mjs --preset gameplay-grid-growth
```

The motion recorder opens the studio with its Canvas renderer. Chromium can
expose partially cleared triangles when a frame is taken from Phaser's WebGL
backbuffer; the Canvas path produces complete frames. Automated PNG captures
continue to use the higher-fidelity WebGL renderer and the browser-composited
screenshot path.

Clips are **not** recorded in real time. `MediaRecorder` holds one frame in
flight and takes about 65ms to encode a 1600x900 frame of tumbling dice, so it
silently dropped every other one and threw away whatever was still queued when
the recording stopped: clips shipped at 11-15fps whatever they were sampled at,
and lost their closing beat. Instead the recorder takes the game clock off the
browser (`beginManualClock` in `main.ts`), steps it at 60Hz, keeps every second
frame, and hands those to a WebCodecs `VideoEncoder`, which drops nothing. The
result is muxed by `scripts/webm.mjs`. Every clip is therefore exactly 30fps with
a decided frame count, and a slow machine makes the capture take longer rather
than making the clip worse.

Two things follow from the manual clock. Nothing in the studio may read a wall
clock — the reels, GameScene and ShopScene all run on Phaser's — and Phaser's own
`TweenManager` is the exception that has to be corrected for, since it reads
`Date.now()` itself; `stepManualClock` hands each active scene's manager the
step's delta so tweens and timers stay in step. The game is stepped at 60Hz
rather than at the clip's 30 because its timers are not all frame multiples: the
tumble flickers a die every 70ms, which a 30fps step would round up to 100ms and
play slower than the game does.

The script starts an isolated Vite server on port 4174, waits for Phaser's
post-render readiness signal, and writes PNGs to `art-out/game-captures`. Pass
`--url http://127.0.0.1:5173` to reuse a server that is already running, or
`--out <directory>` to choose another output folder.

## Adding a preset

Add its metadata and stable state in `presets.ts`. Element compositions belong
in `CaptureScene.ts`; full gameplay captures should construct a `RunState` in
`gameplayRun` and hand it to the real `GameScene`. A preset that performs more
than one interaction belongs in a script of its own beside `shopLoop.ts`. Never
reproduce card copy in the studio: look up the `ItemDef` and pass it to
`buildItemCard`, so captures change with the game.

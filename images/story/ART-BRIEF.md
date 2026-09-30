# Story panel art brief

One panel per story slide. `src/story.ts` names the texture key each slide asks
for; `BootScene` globs this folder and loads every file in it under its own file
name, so **the file name is the contract** — drop `intro-4.webp` in here and the
fourth intro slide stops drawing its placeholder and draws that. Nothing else
needs editing.

- **Format:** `.webp` (or `.png`), **1024 × 768**, 4:3, opaque.
- **Placement:** this folder, named exactly as the tables below say.

## House style

Painted storybook illustration — the look of the existing `ending-tribute-*`
panels. Textured painterly brushwork, warm dusk palette of deep purples, slate
greys and lamp-gold, soft vignette, strong single light source. Wide
establishing shots: the characters are small in a large landscape, the way a
chapter plate in an illustrated book is composed. No text, no lettering, no UI
in the image.

The **characters are cartoons painted into that world** — bold dark-brown
outlines, flat cream faces, rubber-hose limbs — not rendered objects. Keep that
contrast; it is the whole look.

### The dice folk

Every character is a die with a face on one facet, thin dark-brown noodle arms
and legs, four-fingered white gloves, and small brown shoes.

- **A settled die** shows **one single pip**, crisp and still, and reads calm —
  often a faint warm halo.
- **An unsettled die** — every citizen of Paradice before the Order — has a face
  that is **visibly mid-change**: smeared, doubled, ghosted pips and numerals,
  motion streaks, an anxious or irritable expression. This is the core visual
  idea of the setting and should be unmistakable at a glance.

Reference sheets in `images/characters/`:

| Character   | Shape                                       | Read                                                                                                                       |
| ----------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Diebert** | d6 cube, gold-brass frame edges, cream face | Floppy brown cap, monocle on a chain over his single large pip-eye, wide friendly grin. The founder; in every intro panel. |
| **Melodie** | d4, steel-blue edges, cream face            | Two big lashed eyes, freckles, a single pip on her forehead, usually holding a brown book.                                 |
| **Roland**  | d20, plum-purple edges, pale grey facets    | Stern scowl, green eyes, a numeral `2` for a nose, a greatsword over one shoulder.                                         |

`images/monastery.png` is the hall: a gothic stone monastery with pointed arch
windows and twin bell towers, perched on a rock outcrop above a green valley and
distant mountains.

### Recurring cast not on a sheet

- **The King** — a large, heavy die in royal colours: crimson and gold, an
  ermine-trimmed mantle, a gold crown sitting on his top facet. Smug. His face
  never settles.
- **The Order of Order** — dice of every shape in cream and gold sashes, ranked
  in neat rows, single pips showing.
- **The Order of Disorder** — the same dice in crimson-and-gold royal livery,
  faces smeared and changing. In the final act they are an _exact_ mirror of the
  player's ranks.

---

## Intro — 11 panels

| File            | Slide                     | Panel                                                                                                                                                                                                   |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intro-1.webp`  | The View from the Hill    | Diebert, small, standing on a grassy hilltop at golden hour with his back three-quarters to us, looking out over a wide valley town of dice folk below. Every distant die has a smeared, changing face. |
| `intro-2.webp`  | As Long as Anyone Recalls | Street level in that town. A crowded market square of unsettled dice jostling and arguing, carts overturned, faces blurred mid-change. Chaotic, warm, unhappy.                                          |
| `intro-3.webp`  | Something Missing         | Diebert alone at the crest of the hill in late light, seen from behind, one glove raised half-thoughtfully. Vast empty sky. Quiet, wistful, a lot of negative space.                                    |
| `intro-4.webp`  | The Root                  | Comic beat: Diebert pitching forward, cap flying off, one glove out, a thick gnarled tree root hooked around his shoe at the hill's edge. Motion lines.                                                 |
| `intro-5.webp`  | Down the Grassy Knoll     | Diebert as a tumbling blur down a long grassy slope — a spiral of motion arcs, torn grass, scattered leaves — with the hilltop far above and a few dice turning to look at the bottom.                  |
| `intro-6.webp`  | A Crowd at the Bottom     | Low worm's-eye view from where Diebert sits at the base of the hill, ringed by a small crowd of onlooking dice leaning in over him. Their faces are all smeared and changing; his is not.               |
| `intro-7.webp`  | A Single Pip              | Close on Diebert, still sitting, cap askew, face showing one crisp single pip, lit by a soft warm halo. Blissful, astonished. The blurred crowd falls into soft focus around him.                       |
| `intro-8.webp`  | What Must Be Shared       | Diebert on his feet, arms spread, addressing the ring of dice with sunrise light behind him. Determined and warm — the first sermon.                                                                    |
| `intro-9.webp`  | The Order of Order        | A dozen assorted dice of all shapes gathered with Diebert at the hilltop at dusk, an improvised banner staked in the grass. The founding. Melodie and Roland among them.                                |
| `intro-10.webp` | The Technique             | Several dice mid-roll down the slope at once, trails behind them; at the bottom, two or three have come to rest with single pips showing and a shared glow spreading between them.                      |
| `intro-11.webp` | Your Turn                 | Wide hero shot: the hall from `images/monastery.png` on its cliff at dawn, the Order's dice filing up the stair toward it, the valley below still restless. Hopeful, the whole realm in frame.          |

## Act 1 — the messenger (`tribute`)

| File                    | Slide            | Panel                                                                                                                                                                          |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ending-tribute-1.webp` | A Sliver of Calm | The valley from the hall's terrace at evening. Ranks of the Order at practice in a courtyard below, single pips showing; the town beyond is calmer, lamps lit, roads straight. |
| `ending-tribute-2.webp` | Royal Colors     | A d6 messenger in crimson-and-gold livery with a sealed missive climbing the long stone stair to the hall, watched from the doorway by a few of the Order. Dusk, banners.      |
| `ending-tribute-3.webp` | The Fare         | Interior: the unrolled writ on a table under lamplight, the King's heavy wax seal broken beside it, Diebert and two of the Order leaning over it in silence. Heavy, decisive.  |

## Act 2 — the withdrawal (`betrayal`)

| File                     | Slide                 | Panel                                                                                                                                                                        |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ending-betrayal-1.webp` | In Spite of the Tithe | The hall thriving in bright afternoon light — full courtyard, new students arriving up the stair, banners flying, the valley green and orderly behind. Openly triumphant.    |
| `ending-betrayal-2.webp` | A Storm at the Edge   | The same view, but the far horizon is a bruised purple-green stormfront rolling in over the mountains. The foreground is still calm and lit. Unease, not yet damage.         |
| `ending-betrayal-3.webp` | The Leaving           | Night. A thin line of dice walking away down the stair from the hall, backs to us, one glancing over its shoulder. Diebert small in the lit doorway above, watching them go. |

## Act 3 — the betrayal (`summons`)

| File                    | Slide                 | Panel                                                                                                                                                                                                 |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ending-summons-1.webp` | A Household Name      | A town square at festival, the Order's sigil on banners over every door, settled dice going about their business calmly. Prosperous and proud — with one crimson-liveried die watching from an alley. |
| `ending-summons-2.webp` | The Order of Disorder | Interior, lamplit: two returned dice telling their story to Diebert and Melodie across a table, hoods back, faces unsettled again. Conspiratorial, dim, rumour being handed over.                     |
| `ending-summons-3.webp` | Ceaseless Agitation   | A rival hall glimpsed across a dark valley — its own banners, its own crowds, far more of them, all faces smeared and changing, torchlight and disorder. Ominous, distant, growing.                   |

## Act 4 — the confrontation (`disorder`)

| File                     | Slide                      | Panel                                                                                                                                                                                     |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ending-disorder-1.webp` | The Moment You've Dreaded  | The Order marching out from the hall at dawn toward a great open field, seen from behind and above. Formal, inevitable, the whole company in frame.                                       |
| `ending-disorder-2.webp` | Across the Field           | Wide two-sided composition: the Order's neat ranks in the near third, empty green field across the middle, and on the far side a raised crimson pavilion with the King seated under it.   |
| `ending-disorder-3.webp` | The King's Thanks          | Closer on the King in his pavilion, crown on his top facet, one glove spread in false modesty, smug and mid-speech. Gold, crimson, ermine. Nothing behind him visible yet.                |
| `ending-disorder-4.webp` | Look Upon Your Destruction | The King rising and gesturing behind himself; over-the-shoulder from the player's side, the far treeline going dark with a mass of shapes just resolving out of it. The reveal beginning. |
| `ending-disorder-5.webp` | Mirror                     | The panel's two halves match exactly: the Order's ranks in cream and gold on one side, the identical formation in crimson livery on the other, die for die, with smeared changing faces.  |
| `ending-disorder-6.webp` | Good Luck                  | Tight, dramatic, low angle on the King's grinning face — a single mocking gesture, the massed crimson ranks blurred behind him. The last frame before the duel. Menace, high contrast.    |

## Victory — the ascension (`peace`)

> `STORY.md` has no section for the victory act, so these three slides still
> carry the previous prose. Rewrite them there and this table follows.

| File                  | Slide            | Panel                                                                                                                                                                               |
| --------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ending-peace-1.webp` | The Last Roll    | The crimson ranks across the field going still, one by one, dice coming to rest in the grass and not being picked up. Dawn light breaking over the far mountains.                   |
| `ending-peace-2.webp` | The Crown Yields | The empty crimson pavilion, banners down, the King's writ returned to the hall's table with its seal broken. Quiet aftermath, morning light through an arched window.               |
| `ending-peace-3.webp` | Order            | The whole realm from high above at sunrise — hall, valley, town, roads — every distant die showing one still pip. Golden, expansive, resolved. The most beautiful panel in the set. |

// Every word of the story, in one place.
//
// The game tells its story in exactly one shape: a `StoryPage` — a title, a
// picture, and a paragraph under it — turned one at a time by the intro
// (`scenes/IntroScene`) and by the acts between trials (`scenes/EndingScene`).
// All of that prose lives here rather than beside the code that draws it, so
// the story can be rewritten start to finish by editing this file alone.
//
// Nothing here decides *when* a page is shown. Where each act is pinned to the
// ladder and where it hands off to stay in `systems/Endings`, which reaches in
// here for both the prose and the words on the button that closes the act — so
// rewriting a chapter and the button it ends on is one edit in one file.
//
// `image` is a texture key loaded in BootScene. A page whose art has not been
// drawn yet is not an error — it falls back to a placeholder 4:3 frame — so new
// pages can be written before there is anything to look at.

import type { StoryPage } from "./ui/storyPage";
import type { EndingId } from "./systems/Endings";

/** The premise of the Order, told once before the first roll. */
export const INTRO_PAGES: readonly StoryPage[] = [
  {
    title: "A Restless People",
    blurb:
      "The dice of the realm never stop turning. Face after face, thought after thought, no one has come to rest in living memory — and a people who cannot settle can agree on nothing at all.",
    image: "intro-volcano",
  },
  {
    title: "The Roll",
    blurb:
      "Then you fell down a hill. Somewhere in the tumble the turning found a rhythm, and at the bottom you stopped — one face up, one number, perfectly still. It lasted a breath. It was the clearest anyone had ever been.",
    image: "intro-dice-twirl",
  },
  {
    title: "The First Students",
    blurb:
      "You taught the die next door. Then the street, then the valley. Roll, and rest, and for a moment there is a number everyone can agree on — the first thing this realm has ever had to build on.",
    image: "intro-dice-earth",
  },
  {
    title: "The Order of Order",
    blurb:
      "They came for the stillness and stayed for the work. A hall on the cliffs, a discipline, and a name. Teach them well — the realm is watching to see what a settled die can do.",
    image: "intro-monastery",
  },
];

/**
 * The words on the buttons that turn and close a story sequence.
 *
 * `continue` carries every page that is not the last of its sequence, on both
 * the intro and the acts; `beginRun` closes the intro. What closes each act is
 * written per-act in `ENDING_BUTTONS`, because that label is the act's last
 * line of prose as much as the paragraph above it is — it says what the player
 * is agreeing to, and it must not say more than the act has told them.
 */
export const STORY_BUTTONS = {
  continue: "Continue",
  beginRun: "Begin",
} as const;

/**
 * What the final page of each act offers, keyed the way `ENDING_PAGES` is.
 *
 * `systems/Endings` pins these onto its acts; nothing else reads them.
 */
export const ENDING_BUTTONS: Record<EndingId, string> = {
  tribute: "Read the Demands",
  // Deliberately says nothing about who: the King is not connected to the
  // Order of Disorder until the `disorder` act, four ranks later.
  betrayal: "See What They Left For",
  summons: "Prepare",
  disorder: "Take Your Seat",
  peace: "Witness the Ascension",
};

/**
 * The acts, in the order a run meets them.
 *
 * `tribute` and `betrayal` each close a chapter and hand the player a standing
 * drawback; `summons` closes the third and takes nothing, existing only to put
 * the duel on the horizon a rank before it arrives; `disorder` stands in front
 * of the final Boss Trial; `peace` is the only one that is a finish line.
 *
 * The King is the whole arc's hinge, and he is only half-visible for most of
 * it. He taxes the Order openly at `tribute`; when that fails he builds the
 * Order of Disorder, but nothing before `disorder` may connect him to it. Until
 * that reveal the rival order has no founder, no purpose and no explanation —
 * only an offer that keeps taking students away.
 */
export const ENDING_PAGES: Record<EndingId, readonly StoryPage[]> = {
  tribute: [
    {
      title: "What Stillness Buys",
      blurb:
        "Three ranks of practice, and the realm has changed. Dice that had never held still are holding meetings. Roads run straight. Fields get planted, because at last everyone agrees on when.",
      image: "ending-tribute-1",
    },
    {
      title: "The King's Messenger",
      blurb:
        "A rider in royal colours climbs to the hall. The Crown has been watching the Order grow, he says. The Crown has been counting.",
      image: "ending-tribute-2",
    },
    {
      title: "The Demands",
      blurb:
        "Tribute, in perpetuity, under the King's own seal. The Order may keep its discipline. It may not keep all of what that discipline could do.",
      image: "ending-tribute-3",
    },
  ],

  betrayal: [
    {
      title: "In Spite of the Tax",
      blurb:
        "Three ranks under tribute, and the Order grew anyway. Students arrive faster than you can seat them. Whole valleys learn to roll and rest without you ever going there.",
      image: "ending-betrayal-1",
    },
    {
      title: "Something Else Is Teaching",
      blurb:
        "Then dice begin to leave. Not angry, not cast out — invited. They speak of another order that promises the same peace and asks nothing for it, and not one of them can say who runs it.",
      image: "ending-betrayal-2",
    },
    {
      title: "The Order of Disorder",
      blurb:
        "That is the only name anyone brings back. No hall, no founder, no doctrine — just the offer. Every die you roll from here knows there is somewhere else to go.",
      image: "ending-betrayal-3",
    },
  ],

  summons: [
    {
      title: "The Quiet Season",
      blurb:
        "Three ranks since the first of them walked, and the poaching has stopped. No students lost, no hall disturbed. The Order of Disorder has gone still on purpose — and stillness was supposed to be yours.",
      image: "ending-summons-1",
    },
    {
      title: "The Summons",
      blurb:
        "It arrives folded and unsigned, in a hand half your students still recognise. One contest, one table. Both orders, and everything either has ever rolled for.",
      image: "ending-summons-2",
    },
    {
      title: "One Rank Remains",
      blurb:
        "There is time for a single rank before the date they name. Whatever your grid is when it ends is what sits down at that table.",
      image: "ending-summons-3",
    },
  ],

  disorder: [
    {
      title: "The Hand Behind It",
      blurb:
        "The hall they lead you to flies royal colours. The Order of Disorder was never a mystery — it was a purchase. If the King could not tax your discipline, he would buy its opposite and wait.",
      image: "ending-disorder-1",
    },
    {
      title: "Mirror",
      blurb:
        "He does not roll. The students who left you do, with everything you taught them. No goal in this trial and no mercy in it. Outroll yourself, or the realm goes back to never settling.",
      image: "ending-disorder-2",
    },
  ],

  peace: [
    {
      title: "The Last Roll",
      blurb:
        "Their dice come to rest and are not picked up again. Across the table, one by one, the Order of Disorder stops counting.",
      image: "ending-peace-1",
    },
    {
      title: "The Crown Yields",
      blurb:
        "The King's order dissolves before the week is out, and the tribute with it. The writ that bound your dice comes back to the hall unread, its seal broken.",
      image: "ending-peace-2",
    },
    {
      title: "Order",
      blurb:
        "Dice that can settle. A realm that can agree. The teaching is finished, and there is nothing left to do with the sacred numbers except find out how far they will go.",
      image: "ending-peace-3",
    },
  ],
};

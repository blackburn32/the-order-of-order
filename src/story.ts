// Every word of the story, in one place.
//
// The game tells its story in exactly one shape: a `StoryPage` — a title, a
// picture, and a paragraph under it — turned one at a time by the intro
// (`scenes/IntroScene`) and by the acts between trials (`scenes/EndingScene`).
// All of that prose lives here rather than beside the code that draws it, so
// the story can be rewritten start to finish by editing this file alone.
//
// One page per paragraph, throughout. The prose is authored in `STORY.md` at
// the repo root and split here on its paragraph breaks, so a paragraph added or
// cut there is a page added or cut here — no page carries two beats and no beat
// is spread across two pages.
//
// Nothing here decides *when* a page is shown. Where each act is pinned to the
// ladder and where it hands off to stay in `systems/Endings`, which reaches in
// here only for the prose: every page in the game, on both surfaces, is turned
// by the same `Continue`, so there is no per-act label to write.
//
// `image` is a texture key loaded in BootScene. A page whose art has not been
// drawn yet is not an error — it falls back to a placeholder 4:3 frame — so new
// pages can be written before there is anything to look at.

import type { StoryPage } from "./ui/storyPage";
import type { EndingId } from "./systems/Endings";

/** The premise of the Order, told once before the first roll. */
export const INTRO_PAGES: readonly StoryPage[] = [
  {
    title: "The View from the Hill",
    blurb:
      "Diebert gazed across the realm from atop of his favorite hill. Everywhere he looked he saw the same thing; the citizens of Paradice were constantly agitated, their faces changing constantly.",
    image: "intro-1",
  },
  {
    title: "As Long as Anyone Recalls",
    blurb:
      "It had been the same for a long time, maybe even as far back as Diebert could remember. Conflict, struggle, and the woes of too many busy and disorganized minds plagued the lands.",
    image: "intro-2",
  },
  {
    title: "Something Missing",
    blurb:
      "Had it always been this way? Diebert couldn’t help but feel like something was not right, like something was missing.",
    image: "intro-3",
  },
  {
    title: "The Root",
    blurb:
      "Diebert was deep in thought as he started walking back to his hut. So deep, in fact, that he caught his foot on a root, and tumbled down the hill!",
    image: "intro-4",
  },
  {
    title: "Down the Grassy Knoll",
    blurb:
      "It was quite the roll down the grassy knoll, and the shouts Diebert made along the way attracted a small crowd to his eventual resting spot at the base of the hill.",
    image: "intro-5",
  },
  {
    title: "A Crowd at the Bottom",
    blurb:
      "There Diebert sat, gazing up into the tumultuous faces of his onlookers. “What’s going on?” asked one, “Why isn’t his face changing?” asked another.",
    image: "intro-6",
  },
  {
    title: "A Single Pip",
    blurb:
      "Come to think of it, this was the clearest Diebert’s mind had ever felt, and with amazement he realized that his face had settled into a single pip, and it wasn’t changing at all! The joy and clarity he now felt was like nothing he had experienced before.",
    image: "intro-7",
  },
  {
    title: "What Must Be Shared",
    blurb:
      "In that instant Diebert knew he must learn more, and he must share what he learned with all who would hear it. Diebert was determined to help the world settle down their minds the way his mind now felt settled like it had never before.",
    image: "intro-8",
  },
  {
    title: "The Order of Order",
    blurb:
      "Gathering his friends, Diebert founded The Order of Order that afternoon. Together they began experimenting with the technique. Rolling themselves down the hill, and resting their minds at the bottom.",
    image: "intro-9",
  },
  {
    title: "The Technique",
    blurb:
      "It didn’t work every time, but every once in a while, one of them would settle on a single pip upon their face, and with it came a definite sense of clarity and stillness. And when multiple of them rolled at the same time, the effects were much more dramatic!",
    image: "intro-10",
  },
  {
    title: "Your Turn",
    blurb:
      "The process has begun. Now it’s your job to see it through. Grow the order, roll the dice, and cure the tumult that besets the realm!",
    image: "intro-11",
  },
];

/**
 * The words on the button that turns every page of every story sequence.
 *
 * There is one label and it never changes — not on the last page of the intro,
 * not on the last page of an act. A story page's control block asks for exactly
 * one thing, to see the next thing, and saying it the same way every time keeps
 * the button furniture rather than a decision.
 */
export const STORY_BUTTONS = {
  continue: "Continue",
} as const;

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
      title: "A Sliver of Calm",
      blurb:
        "The order has been growing for a while now. More dice and stronger rituals have brought a sliver of calm and unity to a world filled with agitation.",
      image: "ending-tribute-1",
    },
    {
      title: "Royal Colors",
      blurb:
        "It appears that success has been noticed. A messenger in royal colors approaches with a missive from the king.",
      image: "ending-tribute-2",
    },
    {
      title: "The Fare",
      blurb:
        "Tithing is due, but the king is flexible. He will let you choose how to pay the fare.",
      image: "ending-tribute-3",
    },
  ],

  betrayal: [
    {
      title: "In Spite of the Tithe",
      blurb:
        "Your order continues to grow, despite the king’s tithe! Things are really starting to look up for Paradice, thanks in no small part to The Order of Order.",
      image: "ending-betrayal-1",
    },
    {
      title: "A Storm at the Edge",
      blurb:
        "Still… Something doesn’t seem quite right. Perhaps there’s a storm brewing along the edge of the realm?",
      image: "ending-betrayal-2",
    },
    {
      title: "The Leaving",
      blurb:
        "Whatever it is, it’s definitely affecting your ranks. Seemingly overnight a concerning number of the order’s own dice have started leaving, every day. What could be pulling them away?",
      image: "ending-betrayal-3",
    },
  ],

  summons: [
    {
      title: "A Household Name",
      blurb:
        "The Order of Order is now a household name, spoken throughout the realm. The growth of your order has seemingly been unparalleled. Or has it?",
      image: "ending-summons-1",
    },
    {
      title: "The Order of Disorder",
      blurb:
        "Rumors are finally coming back from some of those who left your order. It sounds like your organization has a rival, a league by the name of The Order of Disorder.",
      image: "ending-summons-2",
    },
    {
      title: "Ceaseless Agitation",
      blurb:
        "Their charter is in direct conflict to The Order of Order, preaching the seductions of ceaseless agitation. And their ranks have swelled even quicker than yours! A conflict seems inevitable.",
      image: "ending-summons-3",
    },
  ],

  disorder: [
    {
      title: "The Moment You’ve Dreaded",
      blurb:
        "This is it, the moment you’ve dreaded and waited for. In order to take the final step, The Order of Order must face its rival. The Order of Order and The Order of Disorder cannot coexist.",
      image: "ending-disorder-1",
    },
    {
      title: "Across the Field",
      blurb:
        "You gaze now upon your ranks, as formidable as they have ever been, organized neatly in the field. Across from you, wearing royal colors, sits the king.",
      image: "ending-disorder-2",
    },
    {
      title: "The King’s Thanks",
      blurb:
        "“I must thank you,” says the king, “If it weren’t for all those taxes you paid, I never would have been able to get The Order of Disorder on its feet so quickly.” That jerk, he’s been behind this the whole time?",
      image: "ending-disorder-3",
    },
    {
      title: "Look Upon Your Destruction",
      blurb:
        "“But I think my use for you is done now, look now upon your destruction,” says the king. Behind the king you’re shocked by what you see.",
      image: "ending-disorder-4",
    },
    {
      title: "Mirror",
      blurb:
        "There stands The Order of Disorder. And what’s this? It looks like it’s an exact replica of your own order. Down to the very last die and upgrade.",
      image: "ending-disorder-5",
    },
    {
      title: "Good Luck",
      blurb: "“Good luck,” says the king, “you’ll need it!”",
      image: "ending-disorder-6",
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
        "The King’s order dissolves before the week is out, and the tribute with it. The writ that bound your dice comes back to the hall unread, its seal broken.",
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

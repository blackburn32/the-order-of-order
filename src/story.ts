// Every word of the story, in one place.
//
// The game tells its story in exactly one shape: a `StoryPage` — a title, a
// picture, and a paragraph under it — turned one at a time by the intro
// (`scenes/IntroScene`) and by the acts between trials (`scenes/EndingScene`).
// All of that prose lives here rather than beside the code that draws it, so
// the story can be rewritten start to finish by editing this file alone.
//
// Nothing here decides *when* a page is shown. Where each act is pinned to the
// ladder, what its final button says, and where it hands off to all stay in
// `systems/Endings`, which reaches in here for the words.
//
// `image` is a texture key loaded in BootScene. A page whose art has not been
// drawn yet is not an error — it falls back to a placeholder 4:3 frame — so new
// pages can be written before there is anything to look at.

import type { StoryPage } from "./ui/storyPage";
import type { EndingId } from "./systems/Endings";

/** The premise of the Order, told once before the first roll. */
export const INTRO_PAGES: readonly StoryPage[] = [
  {
    title: "A Gathering Chaos",
    blurb:
      "Across the realm, order frays. Numbers fall as they please, and the wild churn of chance brings great peril to every living thing.",
    image: "intro-volcano",
  },
  {
    title: "The Brave Monks",
    blurb:
      "In the high monasteries, a devoted few refuse to yield. Searching the old vaults, they uncover a relic of impossible make.",
    image: "intro-monastery",
  },
  {
    title: "The Sacred Dice",
    blurb:
      "The artifact is a set of dice — and rolled with discipline, they can bind the chaos and restore the world’s order. The rite is yours to perform.",
    image: "intro-dice-twirl",
  },
  {
    title: "The Race is On",
    blurb:
      "Humble monk, take up the dice and roll the sacred numbers. The Order of Order is depending on you to bring balance back to the realm before it's too late!",
    image: "intro-dice-earth",
  },
];

/**
 * The acts, in the order a run meets them.
 *
 * `tribute` and `betrayal` each close a chapter and hand the player a standing
 * drawback; `disorder` stands in front of the final Boss Trial; `peace` is the
 * only one that is a finish line.
 */
export const ENDING_PAGES: Record<EndingId, readonly StoryPage[]> = {
  tribute: [
    {
      title: "A Quieter Realm",
      blurb:
        "Five ranks of discipline, and the churn is bound. Numbers fall as they are asked to. The harvests come in, the roads are safe, and for the first time in living memory the realm knows what tomorrow will look like.",
      image: "ending-tribute-1",
    },
    {
      title: "The King's Messenger",
      blurb:
        "A rider in royal colours climbs to the monastery gate. The Crown, he explains, has been watching the Order's work with great interest — and has noticed how much power it took to do.",
      image: "ending-tribute-2",
    },
    {
      title: "The Demands",
      blurb:
        "Tribute, in perpetuity, sealed with the King's own hand. The Order may keep its dice. It may not keep all of them, nor all of what they were once able to do.",
      image: "ending-tribute-3",
    },
  ],

  betrayal: [
    {
      title: "In Spite of the Crown",
      blurb:
        "Three more ranks under tribute, and the Order did not merely survive it — it grew. Novices arrive faster than the vaults can be opened for them. The rite spreads to monasteries that had forgotten it.",
      image: "ending-betrayal-1",
    },
    {
      title: "The King's Answer",
      blurb:
        "The Crown has stopped sending messengers. If it cannot tax the Order's discipline, it has decided, it will fund the opposite — and pay well for anyone willing to practise it.",
      image: "ending-betrayal-2",
    },
    {
      title: "The Order of Disorder",
      blurb:
        "Its first recruits were yours. They are still yours, in a sense: every die you roll now knows there is somewhere else to go, and any die that fails you may yet be persuaded to walk.",
      image: "ending-betrayal-3",
    },
  ],

  disorder: [
    {
      title: "Two Orders",
      blurb:
        "The count is in, and it is not close to comforting. The Order of Disorder now numbers what the Order of Order does. Every rite you know, they know. Every die you hold, they hold.",
      image: "ending-disorder-1",
    },
    {
      title: "Mirror",
      blurb:
        "Across the table sits your grid, die for die, in the hands of people who learned it from you. There is no goal in this trial and no mercy in it. Outroll yourself, or the realm belongs to chaos.",
      image: "ending-disorder-2",
    },
  ],

  peace: [
    {
      title: "The Last Roll",
      blurb:
        "The traitors' dice come to rest and are not picked up again. Across the table, one by one, the Order of Disorder stops counting.",
      image: "ending-peace-1",
    },
    {
      title: "The Crown Yields",
      blurb:
        "The King's order dissolves before the week is out, and the tribute with it. The writ that bound your dice is returned to the monastery unread, its seal broken.",
      image: "ending-peace-2",
    },
    {
      title: "Order",
      blurb:
        "Peace, and prosperity, and dice that fall as they should. The rite is finished, the realm is whole, and there is nothing left to do with the sacred numbers except find out how far they will go.",
      image: "ending-peace-3",
    },
  ],
};

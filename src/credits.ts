// The people credited on the Credits & Licences screen (scenes/CreditsScene).
// Edit freely; the package licences below them are generated, not written here.

export interface CreditSection {
  title: string;
  lines: string[];
}

export const CREDITS: CreditSection[] = [
  {
    title: "The Order of Order",
    lines: ["Designed, written and programmed by Alex Blackburn."],
  },
  {
    title: "Characters",
    lines: ["Diebert, Melodie and Roland were drawn by hand by the family."],
  },
  {
    title: "Music and sound",
    lines: ["© 2026 Alex Blackburn. All rights reserved."],
  },
  {
    title: "Thanks",
    lines: ["To everyone who played the early builds and said what they saw."],
  },
];

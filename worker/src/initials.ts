// Initials the board will not print.
//
// Shared by the Worker (which has the final say, since a client can send
// anything) and the game (so the prompt can show the player what the board
// will). Kept to three-letter-or-shorter strings, the only shape initials take,
// and deliberately short: it is a filter for the obvious, not a moderation
// system. A row that slips past it is removed with `npm run player:delete`.
//
// Apple's guideline 1.2 asks apps with user-generated content to filter it;
// this is that filter for the one piece of text players can put on the board.

const BLOCKED: ReadonlySet<string> = new Set([
  // Profanity and its usual spellings.
  "ASS",
  "FUK",
  "FUC",
  "FUQ",
  "FCK",
  "FKU",
  "FKN",
  "FFS",
  "WTF",
  "STF",
  "SHT",
  "CNT",
  "KNT",
  "TWT",
  "DIK",
  "DIC",
  "DCK",
  "COK",
  "COC",
  "CUM",
  "JIZ",
  "TIT",
  "PUS",
  "VAG",
  "CLT",
  "SEX",
  "SXY",
  "XXX",
  "PRN",
  "PNS",
  "PIS",
  "PSS",
  "BCH",
  "BIH",
  "HOE",
  "SUK",
  "SCK",
  "BJS",
  "FAP",
  "ANL",
  "WAP",
  // Slurs and hate symbols.
  "FAG",
  "FGT",
  "NIG",
  "NGR",
  "NGA",
  "NIQ",
  "KKK",
  "SS",
  "NAZ",
  "NZI",
  "HH",
  "WOP",
  "SPC",
  "SPK",
  "GOK",
  "KYK",
  "JAP",
  "DYK",
  // Self-harm and threats.
  "KYS",
  "KMS",
  "RPE",
]);

/** What the board prints in place of initials it will not. */
export const REDACTED_INITIALS = "???";

/** Whether the board would refuse to print these (already uppercased) initials. */
export function initialsBlocked(initials: string): boolean {
  return BLOCKED.has(initials.toUpperCase());
}

/** The initials as the board will print them. */
export function cleanInitials(initials: string): string {
  return initialsBlocked(initials) ? REDACTED_INITIALS : initials;
}

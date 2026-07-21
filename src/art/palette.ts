// Occult parchment-and-gold palette: dark felt table, illuminated-manuscript UI.

export const COLORS = {
  feltDark: 0x0d0a12,
  felt: 0x161226,
  feltLight: 0x221a38,
  parchment: 0xe9d8a6,
  parchmentDark: 0xcdb27a,
  ivory: 0xf3ead2,
  ink: 0x2a1f14,
  inkSoft: 0x5a4a2e,
  gold: 0xc9a227,
  goldLight: 0xe6c65a,
  waxRed: 0x8a1f2b,
  waxRedDark: 0x561019,
  glow: 0xffd977,
  glowGreen: 0x86e07a, // Snake Eyes match flash
  // Shop rarity tiers.
  rarityCommon: 0xd4b83c,
  rarityUncommon: 0x4a7fc9,
  rarityRare: 0x9a4fc9
};

export const CSS = {
  parchment: '#e9d8a6',
  parchmentDark: '#cdb27a',
  ivory: '#f3ead2',
  ink: '#2a1f14',
  inkSoft: '#5a4a2e',
  gold: '#c9a227',
  goldLight: '#e6c65a',
  dim: '#8c7a55',
  red: '#d96a5a',
  waxRed: '#8a1f2b',
  rarityCommon: '#d4b83c',
  rarityUncommon: '#4a7fc9',
  rarityRare: '#9a4fc9'
};

export const SERIF = 'Georgia, "Palatino Linotype", "Times New Roman", serif';

// Border color per die type, so the grid reads at a glance.
export const DIE_BORDER: Record<number, number> = {
  1: 0x8a8f98,
  2: 0x6f8f6a,
  4: 0x4f7f78,
  6: 0xc9a227,
  8: 0xb07830,
  10: 0xa4552f,
  20: 0x8a1f2b,
  100: 0x5e3a72
};

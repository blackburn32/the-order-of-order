import Phaser from "phaser";

/** Regular-polygon vertices, pointy-top by default. */
export function polygonPoints(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotationDeg = -90,
): Phaser.Math.Vector2[] {
  const pts: Phaser.Math.Vector2[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = Phaser.Math.DegToRad(rotationDeg + (360 / sides) * i);
    pts.push(
      new Phaser.Math.Vector2(
        cx + radius * Math.cos(angle),
        cy + radius * Math.sin(angle),
      ),
    );
  }
  return pts;
}

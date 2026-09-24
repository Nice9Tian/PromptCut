export { PlaceholderPlane } from "./placeholderPlane";
export { PLACEHOLDER_CSS } from "./placeholderStyle";

// One icon rotates; extra planes keep the hourglass visible and still.
export const maxAnimated = 1;
export function layersFor(n: number): number {
  // After the reveal, the one rotating SVG is the only additional layer in the tested stage.
  return Number.isFinite(n) && n > 0 ? 1 : 0;
}

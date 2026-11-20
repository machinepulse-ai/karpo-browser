/**
 * The page as a person sees it: the step question carries the viewport's screenshot in `state.viewport_screenshot`,
 * an `image_url` part with a data URL; a follow-up carries none.
 */

/** The state field the screenshot is in. */
export const SCREENSHOT_FIELD = "viewport_screenshot";
/** The widest a screenshot is sent, in pixels, and its JPEG quality. */
export const SCREENSHOT_MAX_WIDTH_PX = 768;
export const SCREENSHOT_JPEG_QUALITY = 75;
/** The pixels a side of one image token covers, and the tokens an image adds besides. */
const IMAGE_TOKEN_PX = 32;
const IMAGE_EXTRA_TOKENS = 2;

/** A JPEG as the request holds it. */
export function imagePart(jpeg: Uint8Array): { type: "image_url"; image_url: { url: string } } {
  return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` } };
}

/** The tokens an image of this size takes of the budget. */
export function imageTokens(width: number, height: number): number {
  const tiles = (pixels: number) => Math.max(Math.ceil(pixels / IMAGE_TOKEN_PX), 0);
  return tiles(width) * tiles(height) + IMAGE_EXTRA_TOKENS;
}

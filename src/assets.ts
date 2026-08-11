import * as crypto from "crypto";

/**
 * Where extracted images go.
 *
 * Extractors decide *what* is an image and *where in the flow* it belongs;
 * they don't decide where files land or what the link looks like. That's the
 * plugin's business (vault paths, attachment folders) and the test harness's
 * (a directory on disk), so it lives behind this.
 */
export interface AssetSink {
  /**
   * Whether images are being collected at all. Extractors read this only to
   * word their warnings — "you turned this off" and "this one wouldn't
   * convert" are different things to tell someone.
   */
  readonly enabled: boolean;
  /**
   * Persists an image and returns the Markdown embed to inline, or null if it
   * wasn't kept — in which case the extractor should carry on and count it.
   */
  save(data: Buffer, extension: string): Promise<string | null>;
}

/** A sink that keeps nothing, for when image extraction is turned off. */
export const NO_ASSETS: AssetSink = {
  enabled: false,
  async save() {
    return null;
  },
};

/**
 * Wraps a writer with content-addressed deduplication. A deck puts the same
 * logo on all forty slides and Word stores a repeated figure once per
 * reference; without this, a conversion writes forty copies of it.
 *
 * The hash suffix on the filename (`image-1-a3f9c2b7.png`, not `image-1.png`)
 * is what lets the caller embed by bare filename — `![[image-1-a3f9c2b7.png]]`
 * rather than a full vault path. A bare-filename embed is resolved by
 * Obsidian searching the whole vault for that name every time it's rendered,
 * which is what makes it survive the attachments folder being moved, even
 * outside Obsidian's own move-tracking — but only as long as the name is
 * unique across the vault. `image-1.png` on its own is anything but: every
 * note this plugin has ever produced starts counting from 1. The hash — the
 * same one already computed here for dedup — is free uniqueness, since two
 * different images landing on the same 8 hex characters is astronomically
 * unlikely for any vault a person could actually assemble.
 */
export function createAssetSink(write: (data: Buffer, name: string) => Promise<string>): AssetSink {
  const embedByHash = new Map<string, string>();
  let counter = 0;

  return {
    enabled: true,
    async save(data, extension) {
      const hash = crypto.createHash("sha1").update(data).digest("hex");
      const existing = embedByHash.get(hash);
      if (existing !== undefined) return existing;

      const embed = await write(data, `image-${++counter}-${hash.slice(0, 8)}.${extension}`);
      embedByHash.set(hash, embed);
      return embed;
    },
  };
}

/**
 * Explains images that didn't make it into the note. Whether the reason is a
 * setting or a format the converter can't handle changes what someone should
 * do about it, so the two read differently.
 */
export function droppedImagesWarning(count: number, extractionEnabled: boolean): string {
  const images = count === 1 ? "1 image" : `${count} images`;
  return extractionEnabled
    ? `${images} could not be extracted — usually Windows metafiles (EMF/WMF), which nothing here can render.`
    : `${images} left out (image extraction is off in settings).`;
}

/**
 * Image MIME types Obsidian can render, and the extension to write them under.
 *
 * The formats that arrive by MIME type rather than by filename — a `data:`
 * URI, an email's inline image, a part of a saved web page — have no path to
 * take an extension from, and Obsidian decides how to display an embed by its
 * extension. Anything not on this list can't be shown, so writing it into the
 * vault would only leave a broken embed behind.
 */
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

export function imageExtensionForMime(mime: string): string | null {
  return IMAGE_MIME_EXTENSIONS[mime.trim().toLowerCase().split(";")[0]] ?? null;
}

/**
 * File extension for an image part, taken from its own path. OOXML stores
 * images in their original encoding, so the archive's extension is the real
 * one — no sniffing needed.
 */
export function imageExtensionOf(partPath: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(partPath)?.[1]?.toLowerCase();
  if (!extension) return null;
  // EMF/WMF are Windows metafile vector formats that nothing in Obsidian can
  // render; writing them into the vault would just leave broken embeds.
  return extension === "emf" || extension === "wmf" ? null : extension;
}

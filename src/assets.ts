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

      const embed = await write(data, `image-${++counter}.${extension}`);
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

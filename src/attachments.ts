/** The folder images go in when nothing has been configured. */
export const DEFAULT_ATTACHMENT_FOLDER = "{{note}} attachments";

/**
 * Turns the attachment folder setting into a vault path for one note.
 *
 * One field covers every convention a vault is likely to have, so it doesn't
 * take a name setting and a location setting whose combinations then need
 * explaining:
 *
 * - `{{note}} attachments` or `XAttachment` — a folder beside the note
 * - `../assets` — relative to the note's folder
 * - `/Assets/{{note}}` — a leading slash starts from the vault root
 *
 * `{{note}}` is the only placeholder. It's replaced before the path is split,
 * so it can sit anywhere in it.
 *
 * A path that climbs out of the vault throws rather than being clamped to the
 * root: quietly writing somewhere other than where the setting says would
 * leave people looking for their images in the wrong place. Returns "" for
 * the vault root itself.
 */
export function attachmentFolderFor(template: string, noteFolder: string, noteBasename: string): string {
  const filled = (template.trim() || DEFAULT_ATTACHMENT_FOLDER).split("{{note}}").join(noteBasename);
  const normalized = filled.replace(/\\/g, "/");

  const segments = normalized.startsWith("/") ? [] : noteFolder.split("/").filter((part) => part !== "");
  for (const part of normalized.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) {
        throw new Error(`attachment folder "${template}" points outside the vault. Check the setting`);
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }

  return segments.join("/");
}

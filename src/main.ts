import { App, FuzzySuggestModal, Notice, Plugin, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { AssetSink, createAssetSink, NO_ASSETS } from "./assets";
import { attachmentFolderFor } from "./attachments";
import { ExtractResult, extractorFor, isImage, isSupported, SUPPORTED_EXTENSIONS } from "./extractors";
import { yamlValue } from "./markdown";
import { CDN_OCR, CORE_FILE_PREFERENCE, LANGUAGE_FILE_NAMES, OcrProvider } from "./ocr";
import { DEFAULT_SETTINGS, ConvertToMarkdownSettings, ConvertToMarkdownSettingTab } from "./settings";

export default class ConvertToMarkdownPlugin extends Plugin {
  settings: ConvertToMarkdownSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ConvertToMarkdownSettingTab(this.app, this));

    this.addCommand({
      id: "convert-file",
      name: "Convert a file",
      callback: () => {
        const files = this.app.vault.getFiles().filter((file) => isSupported(file.extension));
        if (files.length === 0) {
          new Notice(`No convertible files in this vault (${SUPPORTED_EXTENSIONS.join(", ")}).`);
          return;
        }
        new FilePickerModal(this, files).open();
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || !isSupported(file.extension)) return;
        menu.addItem((item) =>
          item
            .setTitle("Convert to Markdown")
            .setIcon("file-text")
            .onClick(() => void this.convert(file))
        );
      })
    );
  }

  async convert(file: TFile): Promise<void> {
    const extract = extractorFor(file.extension);
    if (!extract) {
      new Notice(`Can't convert .${file.extension} files.`);
      return;
    }

    const notice = new Notice(`Converting ${file.name}…`, 0);
    const writes = new ConversionWrites(this.app);
    try {
      const data = Buffer.from(await this.app.vault.readBinary(file));

      // The note is written, empty, before extraction: images go into a
      // folder that depends on where the note is, and Obsidian's attachment
      // setting can only resolve "next to the note" for a note that exists —
      // given a path with no file behind it, it falls back to the vault root.
      const folder = writes.folder(await this.resolveOutputFolder(file));
      const notePath = this.availablePath(folder, file.basename);
      const attachments = this.attachmentFolderSetting(folder, notePath);
      const note = await this.app.vault.create(notePath, "");
      writes.created(note);

      const imageMove = isImage(file.extension) ? await this.planImageMove(file, attachments, notePath, writes) : null;
      const assets = imageMove ? imageMove.sink : this.assetSink(attachments, notePath, writes);

      const result = await extract(
        data,
        assets,
        this.ocrProvider(progressReporter(notice, file.name)),
        { includeHiddenSheets: this.settings.includeHiddenSheets }
      );
      if (imageMove) await imageMove.apply(result);
      await this.app.vault.modify(note, this.composeNote(file, result));
      notice.hide();
      new Notice(`Converted ${file.name} → ${note.basename}`);

      if (this.settings.openAfterConvert) {
        await this.app.workspace.getLeaf(false).openFile(note);
      }
    } catch (error) {
      notice.hide();
      await writes.undo();
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Couldn't convert ${file.name}: ${message}`, 10000);
      console.error(`Convert to Markdown: failed to convert ${file.path}`, error);
    }
  }

  private composeNote(source: TFile, result: ExtractResult): string {
    const sections: string[] = [];

    if (this.settings.addFrontmatter) {
      sections.push(
        [
          "---",
          `source: ${yamlValue(`[[${this.sourceLink(source)}]]`)}`,
          `source_format: ${source.extension}`,
          `converted: ${window.moment().format("YYYY-MM-DD HH:mm")}`,
          // How much of the source made it across, when the extractor can say
          // — at the top of the note, where it's read before the content
          // rather than after it.
          ...Object.entries(result.frontmatter ?? {}).map(([key, value]) => `${key}: ${value}`),
          "---",
        ].join("\n")
      );
    }

    const original = this.originalEmbed(source);
    if (original && this.settings.embedOriginal === "above") sections.push(original);
    sections.push(result.markdown.trim() === "" ? "*(no text content found)*" : result.markdown);
    if (original && this.settings.embedOriginal === "below") sections.push(original);

    if (this.settings.addConversionNotes && result.warnings.length > 0) {
      sections.push(
        ["> [!info]- Conversion notes", ...result.warnings.map((line) => `> - ${line}`)].join("\n")
      );
    }

    return `${sections.join("\n\n")}\n`;
  }

  /**
   * The wikilink target for the source file — its bare filename where that's
   * safe, its full vault path where it isn't.
   *
   * A bare-filename link (`[[report.docx]]`) is resolved by Obsidian
   * searching the whole vault by name each time it's rendered, so it keeps
   * pointing at the file no matter how it's moved afterward — including a
   * move made outside Obsidian entirely, which nothing in Obsidian's own
   * link-updating can see. Unlike the images this plugin writes, though, the
   * source file's name isn't ours to choose — nothing stops two different
   * documents elsewhere in the vault from sharing a filename, and a bare link
   * would then resolve to whichever one Obsidian happens to pick. The full
   * path is unambiguous in that case, at the cost of being the kind of link
   * that only updates itself when Obsidian is the one doing the moving.
   */
  /**
   * An embed of the source file itself, when the setting asks for one and
   * Obsidian can display it.
   *
   * Only PDFs qualify. An image file is already embedded by its own
   * extractor, and Obsidian has no viewer for Office, OpenDocument, EPUB or
   * the rest — an embed of a .docx renders as nothing more than its filename,
   * which the `source` link in the frontmatter already gives.
   */
  private originalEmbed(source: TFile): string | null {
    if (this.settings.embedOriginal === "off" || source.extension.toLowerCase() !== "pdf") return null;
    return `![[${this.sourceLink(source)}]]`;
  }

  private sourceLink(source: TFile): string {
    const collides = this.app.vault.getFiles().some((file) => file !== source && file.name === source.name);
    return collides ? source.path : source.name;
  }

  /**
   * Supplies the OCR engine from a vault folder when one is configured.
   *
   * Resolved lazily — only the image extractor ever asks — so converting a
   * Word document never reads 9 MB of recogniser off disk.
   */
  private ocrProvider(report: OcrProvider["report"]): OcrProvider {
    const folder = this.settings.ocrDataFolder;
    if (!folder) return { ...CDN_OCR, report };

    return {
      report,
      resolve: async () => {
        const { adapter } = this.app.vault;
        const listing = await adapter.list(folder).catch(() => {
          throw new Error(`OCR engine folder "${folder}" doesn't exist — check the setting`);
        });
        const names = new Set(listing.files.map((path) => path.slice(path.lastIndexOf("/") + 1)));

        const coreName = CORE_FILE_PREFERENCE.find((name) => names.has(name));
        const languageName = LANGUAGE_FILE_NAMES.find((name) => names.has(name));
        if (!coreName || !languageName) {
          const missing = [
            coreName ? null : CORE_FILE_PREFERENCE[0],
            languageName ? null : LANGUAGE_FILE_NAMES[0],
          ].filter(Boolean);
          throw new Error(`OCR engine folder "${folder}" is missing ${missing.join(" and ")}`);
        }

        return {
          core: await adapter.readBinary(`${folder}/${coreName}`),
          language: await adapter.readBinary(`${folder}/${languageName}`),
        };
      },
    };
  }

  /**
   * The plugin's own attachments folder for the note at `notePath`, or null
   * when Obsidian's attachment setting decides instead.
   *
   * Resolved before the note is written, so a setting that points outside
   * the vault fails before anything is.
   */
  private attachmentFolderSetting(folder: string, notePath: string): string | null {
    if (this.settings.attachmentLocation === "obsidian") return null;
    const noteBasename = notePath.slice(notePath.lastIndexOf("/") + 1, -".md".length);
    return attachmentFolderFor(this.settings.attachmentFolder, folder, noteBasename);
  }

  /**
   * Writes extracted images into the note's attachments folder.
   *
   * The folder is created on the first image rather than up front, so a
   * document with no images doesn't leave an empty folder behind. The file
   * itself is still written at that full path — only the *embed* is bare
   * (`![[name]]` rather than `![[folder/name]]`), so that moving the
   * attachments folder anywhere else in the vault, by any means, doesn't
   * break the link: Obsidian re-finds a bare-filename embed by searching the
   * vault each time it's rendered, rather than trusting a stored path. That
   * only works because `createAssetSink` gives every image a hash-suffixed,
   * vault-unique name — a bare `![[image-1.png]]` would be ambiguous the
   * moment two converted notes existed.
   */
  private assetSink(configured: string | null, notePath: string, writes: ConversionWrites): AssetSink {
    if (!this.settings.extractImages) return NO_ASSETS;

    let attachments: string | null = null;

    return createAssetSink(async (data, name) => {
      if (attachments === null) attachments = writes.folder(await this.attachmentFolder(configured, name, notePath));
      const path = attachments === "" ? name : `${attachments}/${name}`;

      // A shared attachments folder can already hold this exact file — the
      // same document converted twice, or a logo two documents share. The
      // name carries a hash of the bytes, so an existing file under it is
      // this image, and the embed can simply point at it.
      if (!(this.findPath(path) instanceof TFile)) {
        // createBinary wants a plain ArrayBuffer; a Buffer is a view into a
        // pooled one, so hand over a copy of just this image's bytes.
        writes.created(
          await this.app.vault.createBinary(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.length) as ArrayBuffer)
        );
      }
      return `![[${name}]]`;
    });
  }

  /**
   * Converting an image file moves that file into the attachments folder
   * rather than copying it there. It's already in the vault, and a copy
   * would leave two identical images for every one converted — the note
   * embeds the original, in the place the attachments setting says images
   * belong.
   *
   * The move happens only once extraction has succeeded, and it's made
   * through Obsidian's file manager, so anything else already linking to
   * the image follows it. If a different file already has the image's name
   * in that folder, the image stays where it is and the conversion notes say
   * why.
   *
   * With image extraction off, nothing moves and nothing is embedded — the
   * setting asks for text-only notes.
   */
  private async planImageMove(
    source: TFile,
    configured: string | null,
    notePath: string,
    writes: ConversionWrites
  ): Promise<{ sink: AssetSink; apply: (result: ExtractResult) => Promise<void> } | null> {
    if (!this.settings.extractImages) return null;

    const folder = writes.folder(await this.attachmentFolder(configured, source.name, notePath));
    const target = folder === "" ? source.name : `${folder}/${source.name}`;
    const blocked = target !== source.path && this.findPath(target) !== null;
    const destination = blocked ? source.path : target;
    // Bare by default, like extracted images — but this name was chosen by
    // whoever saved the image, so another file can share it, and then only
    // the full path says which one is meant.
    const shared = this.app.vault.getFiles().some((file) => file !== source && file.name === source.name);
    const embed = `![[${shared ? destination : source.name}]]`;

    return {
      sink: { enabled: true, save: async () => embed },
      apply: async (result) => {
        if (blocked) {
          result.warnings.push(`${source.name} was left where it is: ${target} already exists.`);
          return;
        }
        if (target === source.path) return;
        const from = source.path;
        await this.app.fileManager.renameFile(source, target);
        writes.moved(source, from);
      },
    };
  }

  /** Creates, if need be, and returns the folder a note's images go in. */
  private async attachmentFolder(configured: string | null, firstName: string, notePath: string): Promise<string> {
    if (configured === null) {
      // Obsidian creates the folder itself. It would also number the name if
      // a file already had it, so only the folder part of its answer is used.
      const path = await this.app.fileManager.getAvailablePathForAttachment(firstName, notePath);
      return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    }

    return configured === "" ? "" : this.ensureFolder(configured);
  }

  /**
   * Where the note goes.
   *
   * "Next to the original" has one exception. Converting an image moves it
   * into the attachments folder, so converting it *again* would put the new
   * note in there with it — and, with a per-note folder, move the image one
   * level deeper. An image a converted note already names as its source goes
   * next to that note instead, the most recent one if there are several.
   */
  private async resolveOutputFolder(source: TFile): Promise<string> {
    if (this.settings.outputLocation === "sameFolder") {
      const previous = isImage(source.extension) ? this.latestNoteFrom(source) : null;
      return (previous ?? source).parent?.path ?? "";
    }
    return this.ensureFolder(normalizePath(this.settings.outputFolder || "Converted"));
  }

  /** The most recently changed note whose frontmatter `source` links to `source`. */
  private latestNoteFrom(source: TFile): TFile | null {
    const { metadataCache } = this.app;
    let latest: TFile | null = null;
    for (const note of this.app.vault.getMarkdownFiles()) {
      const links = metadataCache.getFileCache(note)?.frontmatterLinks ?? [];
      const fromSource = links.some(
        (link) => link.key === "source" && metadataCache.getFirstLinkpathDest(link.link, note.path) === source
      );
      if (fromSource && (!latest || note.stat.mtime > latest.stat.mtime)) latest = note;
    }
    return latest;
  }

  /**
   * Creates the folder at `path` unless it's already there, and returns the
   * path to use for it.
   *
   * The returned path can differ from `path` in case. macOS and Windows file
   * systems ignore case, so a setting of `XAttachment` in a vault that already
   * has `xattachment/` means that folder — and asking Obsidian to create it
   * fails with "already exists". Existing folders keep the case they have.
   */
  private async ensureFolder(path: string): Promise<string> {
    const existing = this.findPath(path);
    if (existing instanceof TFolder) return existing.path;
    if (existing) throw new Error(`"${existing.path}" is a file, not a folder`);

    const actual = this.caseOfExisting(path);
    await this.app.vault.createFolder(actual);
    return actual;
  }

  /** The file or folder at `path`, ignoring case, as Obsidian itself does for attachments. */
  private findPath(path: string): TAbstractFile | null {
    const exact = this.app.vault.getAbstractFileByPath(path);
    if (exact) return exact;
    const found = this.app.vault.getAbstractFileByPath(this.caseOfExisting(path));
    return found && found.path.toLowerCase() === path.toLowerCase() ? found : null;
  }

  /** `path` with each leading part that already exists spelled the way the vault spells it. */
  private caseOfExisting(path: string): string {
    let folder: TFolder | null = this.app.vault.getRoot();
    const parts: string[] = [];
    for (const part of path.split("/").filter((segment) => segment !== "")) {
      const match: TAbstractFile | undefined = folder?.children.find(
        (child) => child.name.toLowerCase() === part.toLowerCase()
      );
      parts.push(match ? match.name : part);
      folder = match instanceof TFolder ? match : null;
    }
    return parts.join("/");
  }

  /** Never overwrites: a re-conversion lands beside the previous note. */
  private availablePath(folder: string, basename: string): string {
    const prefix = folder === "" || folder === "/" ? "" : `${folder}/`;
    let candidate = `${prefix}${basename}.md`;
    let counter = 1;
    while (this.findPath(candidate)) {
      candidate = `${prefix}${basename} ${++counter}.md`;
    }
    return candidate;
  }

  async loadSettings(): Promise<void> {
    // loadData() is typed Promise<any> — whatever was last saved to data.json
    // — so the shape is only as trustworthy as the file on disk. Asserting it
    // here keeps that any from spreading into `this.settings`, which is fine:
    // Object.assign below only takes keys DEFAULT_SETTINGS already defines,
    // so a stale or hand-edited data.json can't inject anything unexpected.
    const saved = (await this.loadData()) as Partial<ConvertToMarkdownSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/**
 * Everything one conversion adds to or changes in the vault, so a conversion
 * that fails partway can be taken back out again — rather than leaving an
 * empty note, a folder of images nothing links to, or a moved source file.
 *
 * A folder counts as this conversion's if it, or a folder above it, wasn't
 * there when the conversion started. That comparison is the only way to know
 * for Obsidian's own attachment helper, which creates the folder it names
 * without saying whether it did.
 */
class ConversionWrites {
  private readonly files: TFile[] = [];
  private readonly moves: { file: TFile; from: string }[] = [];
  private readonly folders = new Set<string>();
  private readonly foldersBefore: Set<string>;

  constructor(private readonly app: App) {
    this.foldersBefore = new Set(
      app.vault
        .getAllLoadedFiles()
        .filter((file): file is TFolder => file instanceof TFolder)
        .map((folder) => folder.path.toLowerCase())
    );
  }

  created(file: TFile): void {
    this.files.push(file);
  }

  moved(file: TFile, from: string): void {
    this.moves.push({ file, from });
  }

  /** Notes a folder the conversion is about to use, and passes its path through. */
  folder(path: string): string {
    const parts = path.split("/").filter((part) => part !== "");
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join("/");
      if (!this.foldersBefore.has(prefix.toLowerCase())) this.folders.add(prefix);
    }
    return path;
  }

  async undo(): Promise<void> {
    const { vault, fileManager } = this.app;
    for (const { file, from } of this.moves.reverse()) {
      await fileManager.renameFile(file, from).catch((error) => warnUndo(`move ${file.path} back`, error));
    }
    // Sent wherever the user's "deleted files" setting says, like any other
    // file Obsidian removes — even though these only ever held what this
    // conversion put in them.
    for (const file of this.files.reverse()) {
      await fileManager.trashFile(file).catch((error) => warnUndo(`delete ${file.path}`, error));
    }
    // Deepest first, so a nested folder empties its parent before the
    // parent is looked at — and only if nothing else has landed in it.
    //
    // The removal itself has to be "recursive" even though the folder was
    // just checked empty: on desktop, Obsidian removes folders with Node's
    // fs.rm, which refuses any directory — empty or not — unless told to
    // recurse. That's also why vault.delete can't be used here; it passes
    // recursive: false.
    const deepestFirst = [...this.folders].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const path of deepestFirst) {
      const listing = await vault.adapter.list(path).catch(() => null);
      if (!listing || listing.files.length > 0 || listing.folders.length > 0) continue;
      await vault.adapter.rmdir(path, true).catch((error) => warnUndo(`remove ${path}`, error));
    }
  }
}

function warnUndo(action: string, error: unknown): void {
  console.warn(`Convert to Markdown: couldn't ${action} while undoing a failed conversion`, error);
}

/**
 * Feeds OCR progress into the notice that's already on screen.
 *
 * Tesseract's own wording ("loading language traineddata") is what makes the
 * first conversion legible — it's the only thing that explains why an
 * otherwise offline plugin is sitting there for half a minute.
 *
 * The logger fires far more often than the text changes, so identical
 * messages are dropped rather than repainted.
 */
function progressReporter(notice: Notice, fileName: string): OcrProvider["report"] {
  let last = "";

  return (status, progress) => {
    const percent = Number.isFinite(progress) ? Math.round(progress * 100) : 0;
    const message = `Converting ${fileName}\n${status} — ${percent}%`;
    if (message === last) return;
    last = message;
    notice.setMessage(message);
  };
}

class FilePickerModal extends FuzzySuggestModal<TFile> {
  constructor(private readonly plugin: ConvertToMarkdownPlugin, private readonly files: TFile[]) {
    super(plugin.app);
    this.setPlaceholder("Pick a document to convert to Markdown");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    void this.plugin.convert(file);
  }
}

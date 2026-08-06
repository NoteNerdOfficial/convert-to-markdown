import { FuzzySuggestModal, Notice, Plugin, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { AssetSink, createAssetSink, NO_ASSETS } from "./assets";
import { ExtractResult, extractorFor, isSupported, SUPPORTED_EXTENSIONS } from "./extractors";
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
    try {
      const data = Buffer.from(await this.app.vault.readBinary(file));

      // The note path is settled before extraction so images can be written
      // into a folder named after the note that will hold them.
      const folder = await this.resolveOutputFolder(file);
      const notePath = this.availablePath(folder, file.basename);
      const noteBasename = notePath.slice(notePath.lastIndexOf("/") + 1, -".md".length);

      const result = await extract(
        data,
        this.assetSink(folder, noteBasename),
        this.ocrProvider(progressReporter(notice, file.name)),
        { includeHiddenSheets: this.settings.includeHiddenSheets }
      );
      const note = await this.app.vault.create(notePath, this.composeNote(file, result));
      notice.hide();
      new Notice(`Converted ${file.name} → ${note.basename}`);

      if (this.settings.openAfterConvert) {
        await this.app.workspace.getLeaf(false).openFile(note);
      }
    } catch (error) {
      notice.hide();
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
          `source: "[[${source.path}]]"`,
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

    sections.push(result.markdown.trim() === "" ? "*(no text content found)*" : result.markdown);

    if (this.settings.addConversionNotes && result.warnings.length > 0) {
      sections.push(
        ["> [!info]- Conversion notes", ...result.warnings.map((line) => `> - ${line}`)].join("\n")
      );
    }

    return `${sections.join("\n\n")}\n`;
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
   * Writes extracted images into `<note name> attachments/` beside the note.
   *
   * The folder is created on the first image rather than up front, so a
   * document with no images doesn't leave an empty folder behind.
   */
  private assetSink(folder: string, noteBasename: string): AssetSink {
    if (!this.settings.extractImages) return NO_ASSETS;

    const prefix = folder === "" || folder === "/" ? "" : `${folder}/`;
    const attachments = `${prefix}${noteBasename} attachments`;
    let created = false;

    return createAssetSink(async (data, name) => {
      if (!created) {
        if (!(this.app.vault.getAbstractFileByPath(attachments) instanceof TFolder)) {
          await this.app.vault.createFolder(attachments);
        }
        created = true;
      }
      const path = `${attachments}/${name}`;
      // createBinary wants a plain ArrayBuffer; a Buffer is a view into a
      // pooled one, so hand over a copy of just this image's bytes.
      await this.app.vault.createBinary(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.length) as ArrayBuffer);
      return `![[${path}]]`;
    });
  }

  private async resolveOutputFolder(source: TFile): Promise<string> {
    if (this.settings.outputLocation === "sameFolder") return source.parent?.path ?? "";

    const folder = normalizePath(this.settings.outputFolder || "Converted");
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) return folder;
    if (existing) throw new Error(`"${folder}" is a file, not a folder`);

    await this.app.vault.createFolder(folder);
    return folder;
  }

  /** Never overwrites: a re-conversion lands beside the previous note. */
  private availablePath(folder: string, basename: string): string {
    const prefix = folder === "" || folder === "/" ? "" : `${folder}/`;
    let candidate = `${prefix}${basename}.md`;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${prefix}${basename} ${++counter}.md`;
    }
    return candidate;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
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

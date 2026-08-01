import { FuzzySuggestModal, Notice, Plugin, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { extractorFor, isSupported, SUPPORTED_EXTENSIONS } from "./extractors";
import { DEFAULT_SETTINGS, DocToMarkdownSettings, DocToMarkdownSettingTab } from "./settings";

export default class DocToMarkdownPlugin extends Plugin {
  settings: DocToMarkdownSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new DocToMarkdownSettingTab(this.app, this));

    this.addCommand({
      id: "convert-file",
      name: "Convert a file to Markdown",
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
      new Notice(`Doc to Markdown can't convert .${file.extension} files.`);
      return;
    }

    const notice = new Notice(`Converting ${file.name}…`, 0);
    try {
      const data = Buffer.from(await this.app.vault.readBinary(file));
      const result = await extract(data);

      const note = await this.writeNote(file, this.composeNote(file, result.markdown, result.warnings));
      notice.hide();
      new Notice(`Converted ${file.name} → ${note.basename}`);

      if (this.settings.openAfterConvert) {
        await this.app.workspace.getLeaf(false).openFile(note);
      }
    } catch (error) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Couldn't convert ${file.name}: ${message}`, 10000);
      console.error(`Doc to Markdown: failed to convert ${file.path}`, error);
    }
  }

  private composeNote(source: TFile, markdown: string, warnings: string[]): string {
    const sections: string[] = [];

    if (this.settings.addFrontmatter) {
      sections.push(
        [
          "---",
          `source: "[[${source.path}]]"`,
          `source_format: ${source.extension}`,
          `converted: ${window.moment().format("YYYY-MM-DD HH:mm")}`,
          "---",
        ].join("\n")
      );
    }

    sections.push(markdown.trim() === "" ? "*(no text content found)*" : markdown);

    if (this.settings.addConversionNotes && warnings.length > 0) {
      sections.push(["> [!info]- Conversion notes", ...warnings.map((line) => `> - ${line}`)].join("\n"));
    }

    return `${sections.join("\n\n")}\n`;
  }

  private async writeNote(source: TFile, content: string): Promise<TFile> {
    const folder = await this.resolveOutputFolder(source);
    const path = this.availablePath(folder, source.basename);
    return this.app.vault.create(path, content);
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

class FilePickerModal extends FuzzySuggestModal<TFile> {
  constructor(private readonly plugin: DocToMarkdownPlugin, private readonly files: TFile[]) {
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

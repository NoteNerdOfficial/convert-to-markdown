import { App, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type DocToMarkdownPlugin from "./main";

export interface DocToMarkdownSettings {
  /** Where the converted note is written. */
  outputLocation: "sameFolder" | "folder";
  /** Vault-relative folder used when outputLocation is "folder". */
  outputFolder: string;
  /** Copy images out of the source file into the vault and embed them. */
  extractImages: boolean;
  /** Record the source file and conversion date in the note's frontmatter. */
  addFrontmatter: boolean;
  /** List anything the extractor dropped or guessed at the end of the note. */
  addConversionNotes: boolean;
  /** Open the note once it's written. */
  openAfterConvert: boolean;
}

export const DEFAULT_SETTINGS: DocToMarkdownSettings = {
  outputLocation: "sameFolder",
  outputFolder: "Converted",
  extractImages: true,
  addFrontmatter: true,
  addConversionNotes: true,
  openAfterConvert: true,
};

export class DocToMarkdownSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DocToMarkdownPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Save converted notes")
      .setDesc("Where to put the Markdown note.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("sameFolder", "Next to the original file")
          .addOption("folder", "In a specific folder")
          .setValue(this.plugin.settings.outputLocation)
          .onChange(async (value) => {
            this.plugin.settings.outputLocation = value === "folder" ? "folder" : "sameFolder";
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.outputLocation === "folder") {
      new Setting(containerEl)
        .setName("Output folder")
        .setDesc("Vault-relative path. Created if it doesn't exist.")
        .addText((text) =>
          text
            .setPlaceholder("Converted")
            .setValue(this.plugin.settings.outputFolder)
            .onChange(async (value) => {
              this.plugin.settings.outputFolder = normalizePath(value.trim() || "Converted");
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Extract images")
      .setDesc(
        "Copy images out of the document into an attachments folder beside the note and embed them. " +
          "Turn off for text-only notes."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.extractImages).onChange(async (value) => {
          this.plugin.settings.extractImages = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Reading images (OCR)")
      .setDesc(
        "Converting an image file runs local OCR — no API key, and the image never leaves your machine. " +
          "The first conversion downloads the recognition engine and English training data (~19 MB), " +
          "which the app then caches; every conversion after that works offline."
      );

    new Setting(containerEl)
      .setName("Add frontmatter")
      .setDesc("Record the source file and conversion date at the top of the note.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.addFrontmatter).onChange(async (value) => {
          this.plugin.settings.addFrontmatter = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Add conversion notes")
      .setDesc("List what the converter skipped — images, hidden sheets, pages with no text layer.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.addConversionNotes).onChange(async (value) => {
          this.plugin.settings.addConversionNotes = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Open after converting")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openAfterConvert).onChange(async (value) => {
          this.plugin.settings.openAfterConvert = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

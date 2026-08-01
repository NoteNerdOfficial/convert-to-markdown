import { App, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type DocToMarkdownPlugin from "./main";

export interface DocToMarkdownSettings {
  /** Where the converted note is written. */
  outputLocation: "sameFolder" | "folder";
  /** Vault-relative folder used when outputLocation is "folder". */
  outputFolder: string;
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

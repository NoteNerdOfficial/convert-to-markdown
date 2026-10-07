import { ExtractResult } from "../extractors/types";
import { renderTemplate, TemplateInput } from "../template";
import { DocumentType, TypedResult } from "./types";

/** The collapsed callout listing what a conversion dropped or doubted, as every note ends. */
export function conversionNotes(warnings: string[]): string {
  return ["> [!info]- Conversion notes", ...warnings.map((line) => `> - ${line}`)].join("\n");
}

export interface TypedNoteInput {
  type: DocumentType;
  typed: TypedResult;
  result: ExtractResult;
  /** The template note's text, or null for the type's built-in one. */
  template: string | null;
  /** Why the chosen template note couldn't be read, when it couldn't — the built-in one is used. */
  templateProblem?: string;
  /** `source`, `source_format` and `converted`, as YAML, or empty when frontmatter is off. */
  coverage: [string, string][];
  /** An embed of the source file, for `{{original}}`. */
  original: string;
  addConversionNotes: boolean;
  formatDate: TemplateInput["formatDate"];
  now: TemplateInput["now"];
}

/**
 * A converted note shaped by a document type: its fields through the
 * template, the full conversion as `{{content}}`, and the coverage keys
 * every note carries, whatever the template says.
 */
export function composeTypedNote(input: TypedNoteInput): string {
  const { type, typed, result } = input;
  const coverage: [string, string][] =
    input.coverage.length === 0
      ? []
      : [
          ...input.coverage,
          ...Object.entries(result.frontmatter ?? {}),
          ["missing_fields", flowList(typed.missing)],
          ["ocr_fields", flowList(typed.ocr)],
          ["guessed_fields", flowList(typed.guessed)],
          ["ambiguous_fields", flowList(typed.ambiguous)],
        ];
  const render = (template: string) =>
    renderTemplate({
      template,
      fields: typed.fields,
      blocks: { content: result.markdown.trim(), original: input.original, ...typed.blocks },
      coverage,
      formatDate: input.formatDate,
      now: input.now,
    });

  const notes: string[] = input.templateProblem ? [input.templateProblem] : [];
  let output = render(input.template ?? type.defaultTemplate);
  if (output.fatal) {
    notes.push("The template note's frontmatter never closes, so the built-in template was used instead.");
    output = render(type.defaultTemplate);
  }
  if (output.unknownPlaceholders.length > 0) {
    notes.push(
      `The template uses placeholders this document type doesn't have, left as typed: ${output.unknownPlaceholders
        .map((name) => `{{${name}}}`)
        .join(", ")}.`
    );
  }

  const warnings = [...typed.warnings, ...result.warnings, ...output.problems, ...notes];
  const note = output.note.trimEnd();
  return input.addConversionNotes && warnings.length > 0 ? `${note}\n\n${conversionNotes(warnings)}\n` : `${note}\n`;
}

/** A YAML flow list of plain keys: `[due_date, po_number]`, or `[]`. */
function flowList(keys: string[]): string {
  return `[${keys.join(", ")}]`;
}

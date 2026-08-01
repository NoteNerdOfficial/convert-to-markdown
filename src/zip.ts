import * as zlib from "zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** The ZIP comment field is at most 65535 bytes — the EOCD record can't sit
 *  further from EOF than that plus its own fixed size. */
const MAX_EOCD_SEARCH = 65535 + EOCD_MIN_SIZE;

/**
 * Minimal reader for plain (non-zip64, non-encrypted) ZIP archives, which is
 * all an OOXML file ever is: .docx/.pptx/.xlsx are zipped XML written by
 * Office or LibreOffice, and neither produces zip64 (that needs >65535
 * entries or a >4GB member).
 *
 * Deliberately hand-rolled rather than pulling in a general zip library:
 * jszip's transitive deps ("lie", "setimmediate") create <script> elements as
 * a legacy task-scheduling trick, which gets plugins flagged by Obsidian's
 * community-plugin review as "code obfuscation" — a false positive that's
 * simplest to avoid entirely rather than argue.
 */
export class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>();

  private constructor(private readonly buffer: Buffer) {
    this.indexCentralDirectory();
  }

  static open(buffer: Buffer): ZipArchive {
    return new ZipArchive(buffer);
  }

  /** Every entry path in the archive, in central-directory order. */
  paths(): string[] {
    return [...this.entries.keys()];
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** Decompressed entry as UTF-8 text, or null if it isn't in the archive. */
  text(path: string): string | null {
    const bytes = this.bytes(path);
    return bytes === null ? null : bytes.toString("utf8");
  }

  /** Decompressed entry as raw bytes, or null if it isn't in the archive. */
  bytes(path: string): Buffer | null {
    const entry = this.entries.get(path);
    if (!entry) return null;

    const { buffer } = this;
    if (buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) return null;

    // The local header repeats the name/extra lengths, and they can differ
    // from the central directory's — always trust the local ones here.
    const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.compressionMethod === 0) return Buffer.from(data); // stored
    if (entry.compressionMethod === 8) return zlib.inflateRawSync(data); // deflate
    return null; // anything else isn't produced by Office writers
  }

  private indexCentralDirectory(): void {
    const { buffer } = this;
    const eocdOffset = findEndOfCentralDirectory(buffer);
    if (eocdOffset === -1) throw new Error("not a ZIP archive (no end-of-central-directory record)");

    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
    if (centralDirOffset === 0xffffffff || totalEntries === 0xffff) {
      throw new Error("zip64 archives are not supported");
    }

    let cursor = centralDirOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (buffer.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
        throw new Error("corrupt ZIP central directory");
      }
      const compressionMethod = buffer.readUInt16LE(cursor + 10);
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const nameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
      const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

      this.entries.set(name, { compressionMethod, compressedSize, localHeaderOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
  }
}

interface ZipEntry {
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const searchStart = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

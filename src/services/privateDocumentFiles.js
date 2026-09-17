import { createDomainError } from '../modules/household-domain/domainError.js';

export const MAX_PRIVATE_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;

export const PRIVATE_DOCUMENT_CONTENT_TYPES = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const CANONICAL_EXTENSIONS = Object.freeze({
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
});

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const JPEG_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const RIFF_MAGIC = Buffer.from('RIFF', 'ascii');
const WEBP_MAGIC = Buffer.from('WEBP', 'ascii');
const WEBP_CHUNK_TYPES = new Set(['VP8 ', 'VP8L', 'VP8X']);
const PDF_EOF = Buffer.from('%%EOF', 'ascii');

const startsWith = (content, signature, offset = 0) =>
  content.length >= offset + signature.length &&
  content.subarray(offset, offset + signature.length).equals(signature);

const endsWith = (content, signature) =>
  content.length >= signature.length &&
  content.subarray(content.length - signature.length).equals(signature);

const hasPdfEof = (content) => {
  let end = content.length;

  while (
    end > 0 &&
    [0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(content[end - 1])
  ) {
    end -= 1;
  }

  return endsWith(content.subarray(0, end), PDF_EOF);
};

const hasValidJpegStructure = (content) => {
  if (!startsWith(content, JPEG_MAGIC) || !endsWith(content, JPEG_EOI)) {
    return false;
  }

  const dataEnd = content.length - JPEG_EOI.length;
  let offset = 2;
  let hasStartOfFrame = false;

  while (offset < dataEnd) {
    if (content[offset] !== 0xff) return false;
    while (offset < dataEnd && content[offset] === 0xff) offset += 1;
    if (offset >= dataEnd) return false;

    const marker = content[offset];
    offset += 1;

    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > dataEnd) return false;

    const segmentLength = content.readUInt16BE(offset);
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || segmentEnd > dataEnd) return false;

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 11) return false;
      const precision = content[offset + 2];
      const height = content.readUInt16BE(offset + 3);
      const width = content.readUInt16BE(offset + 5);
      const componentCount = content[offset + 7];
      if (
        precision === 0 ||
        height === 0 ||
        width === 0 ||
        componentCount === 0 ||
        segmentLength !== 8 + 3 * componentCount
      ) {
        return false;
      }
      hasStartOfFrame = true;
    }

    if (marker === 0xda) {
      const componentCount = content[offset + 2];
      return (
        hasStartOfFrame &&
        componentCount > 0 &&
        segmentLength === 6 + 2 * componentCount &&
        segmentEnd < dataEnd
      );
    }

    offset = segmentEnd;
  }

  return false;
};

const hasValidPngStructure = (content) =>
  startsWith(content, PNG_MAGIC) &&
  content.length >= PNG_MAGIC.length + 25 + PNG_IEND.length &&
  content.readUInt32BE(8) === 13 &&
  content.subarray(12, 16).toString('ascii') === 'IHDR' &&
  content.readUInt32BE(16) > 0 &&
  content.readUInt32BE(20) > 0 &&
  endsWith(content, PNG_IEND);

const hasValidWebpStructure = (content) => {
  if (
    !startsWith(content, RIFF_MAGIC) ||
    !startsWith(content, WEBP_MAGIC, 8) ||
    content.length < 20 ||
    content.readUInt32LE(4) + 8 !== content.length
  ) {
    return false;
  }

  const chunkType = content.subarray(12, 16).toString('ascii');
  if (!WEBP_CHUNK_TYPES.has(chunkType)) return false;

  const chunkSize = content.readUInt32LE(16);
  const paddedChunkSize = chunkSize + (chunkSize % 2);
  if (20 + paddedChunkSize > content.length) return false;
  if (chunkType === 'VP8X') return chunkSize === 10;
  if (chunkType === 'VP8L') return chunkSize >= 5;
  return chunkSize >= 10;
};

export const detectPrivateDocumentContentType = (value) => {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);

  if (startsWith(content, PDF_MAGIC) && hasPdfEof(content)) {
    return 'application/pdf';
  }
  if (hasValidJpegStructure(content)) {
    return 'image/jpeg';
  }
  if (hasValidPngStructure(content)) {
    return 'image/png';
  }
  if (hasValidWebpStructure(content)) {
    return 'image/webp';
  }

  return null;
};

export const sanitizePrivateDocumentFilename = (value, errorPrefix = 'INVOICE_DOCUMENT') => {
  const filename = String(value)
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();

  if (!filename || filename === '.' || filename === '..') {
    throw createDomainError(
      400,
      `${errorPrefix}_FILENAME_INVALID`,
      'Indica un nombre de archivo válido.',
    );
  }

  return filename;
};

export const canonicalizePrivateDocumentFilename = (value, contentType, errorPrefix = 'INVOICE_DOCUMENT') => {
  const extension = CANONICAL_EXTENSIONS[contentType];
  if (!extension) {
    throw createDomainError(
      415,
      `${errorPrefix}_CONTENT_TYPE_UNSUPPORTED`,
      'Solo se admiten archivos PDF, JPEG, PNG o WebP.',
    );
  }

  const filename = sanitizePrivateDocumentFilename(value, errorPrefix);
  const extensionIndex = filename.lastIndexOf('.');
  const untrimmedStem =
    extensionIndex > 0
      ? filename.slice(0, extensionIndex)
      : extensionIndex === 0
        ? ''
        : filename;
  const stem = untrimmedStem.replace(/^[.\s]+|[.\s]+$/gu, '') || 'document';
  const maximumStemLength = 255 - extension.length;
  const truncatedStem =
    [...stem]
      .slice(0, maximumStemLength)
      .join('')
      .replace(/[.\s]+$/gu, '') || 'document';

  return `${truncatedStem}${extension}`;
};

export const decodePrivateDocumentFilenameHeader = (value, errorPrefix = 'INVOICE_DOCUMENT') => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw createDomainError(
      400,
      `${errorPrefix}_FILENAME_INVALID`,
      'Envía un nombre de archivo codificado válido.',
    );
  }

  try {
    return sanitizePrivateDocumentFilename(decodeURIComponent(value), errorPrefix);
  } catch (error) {
    if (error?.code === `${errorPrefix}_FILENAME_INVALID`) throw error;
    throw createDomainError(
      400,
      `${errorPrefix}_FILENAME_INVALID`,
      'Envía un nombre de archivo codificado válido.',
    );
  }
};

const encodeRfc5987 = (value) =>
  encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.codePointAt(0).toString(16).toUpperCase()}`,
  );

export const privateDocumentContentDisposition = (filename, disposition = 'attachment') => {
  const fallback = filename
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');

  return `${disposition === 'inline' ? 'inline' : 'attachment'}; filename="${fallback || 'document'}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
};

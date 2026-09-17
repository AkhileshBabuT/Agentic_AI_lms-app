import { TextDecoder } from 'util';
import { MATERIAL_INGESTION as config } from '../../config/materialIngestion';

/** Fixed validation messages are safe to return; attachment contents never enter errors. */
export class MaterialValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'MaterialValidationError'; }
}

/** Inspect the original signature and bounded ZIP directory before handing it to parsers. */
export function validateMaterialFile(buffer: Buffer, fileName: string, mimeType: string): void {
  if (!buffer.length || buffer.length > config.maxBytes) throw new MaterialValidationError('Material byte limit exceeded');
  const extensionParts = fileName.toLowerCase().split('.');
  const extension = extensionParts[extensionParts.length - 1];
  const expected: Record<string,string> = {pdf: 'application/pdf',docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    doc: 'application/msword',ppt: 'application/vnd.ms-powerpoint',xls: 'application/vnd.ms-excel',
    png: 'image/png',jpg: 'image/jpeg',jpeg: 'image/jpeg',gif: 'image/gif',webp: 'image/webp'};
  if (extension && expected[extension] && expected[extension] !== mimeType) throw new MaterialValidationError('Material extension and declared format disagree');
  if (mimeType === 'application/pdf') {
    if (!buffer.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new MaterialValidationError('Invalid PDF signature');
    return;
  }
  const officeEntries: Record<string,string> = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word/document.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ppt/presentation.xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xl/workbook.xml',
  };
  if (officeEntries[mimeType]) {
    if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new MaterialValidationError('Invalid Office ZIP signature');
    let end = -1;
    for (let position = buffer.length - 22; position >= Math.max(0,buffer.length - 65557); position--) {
      if (buffer.readUInt32LE(position) === 0x06054b50) { end = position; break; }
    }
    if (end < 0 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw new MaterialValidationError('Unsupported ZIP directory');
    const entries = buffer.readUInt16LE(end + 10), directorySize = buffer.readUInt32LE(end + 12);
    let position = buffer.readUInt32LE(end + 16), expanded = 0, found = false;
    if (entries === 0xffff || entries > 10000 || directorySize === 0xffffffff || position + directorySize > end) throw new MaterialValidationError('Office archive limit exceeded');
    for (let index = 0; index < entries; index++) {
      if (position + 46 > end || buffer.readUInt32LE(position) !== 0x02014b50) throw new MaterialValidationError('Invalid Office directory');
      const compressed = buffer.readUInt32LE(position + 20), size = buffer.readUInt32LE(position + 24);
      const nameLength = buffer.readUInt16LE(position + 28), extra = buffer.readUInt16LE(position + 30), comment = buffer.readUInt16LE(position + 32);
      if (buffer.readUInt16LE(position + 8) & 1 || size === 0xffffffff || size > Math.max(1024 * 1024,compressed * 200)) throw new MaterialValidationError('Encrypted or excessive Office archive');
      expanded += size;
      if (expanded > config.maxExpandedBytes || position + 46 + nameLength + extra + comment > end) throw new MaterialValidationError('Office archive expansion limit exceeded');
      const name = buffer.subarray(position + 46,position + 46 + nameLength).toString('utf8');
      if (name === officeEntries[mimeType]) found = true;
      position += 46 + nameLength + extra + comment;
    }
    if (!found) throw new MaterialValidationError('Office archive does not match the declared format');
    return;
  }
  if (['application/msword','application/vnd.ms-powerpoint','application/vnd.ms-excel'].includes(mimeType)) {
    if (!buffer.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex'))) throw new MaterialValidationError('Invalid legacy Office signature');
    return;
  }
  if (mimeType.startsWith('image/')) {
    const valid = mimeType === 'image/png' ? buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
      : mimeType === 'image/jpeg' ? buffer.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))
      : mimeType === 'image/gif' ? /^GIF8[79]a$/.test(buffer.subarray(0,6).toString())
      : mimeType === 'image/webp' ? buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP' : false;
    if (!valid) throw new MaterialValidationError('Invalid image signature');
    return;
  }
  if (mimeType.startsWith('text/') || ['txt','md','json','js','py','java','c','cpp','ts','html','css','xml'].includes(extension ?? '')) {
    if (buffer.includes(0)) throw new MaterialValidationError('Binary content declared as text');
    try { new TextDecoder('utf-8',{fatal: true}).decode(buffer); } catch { throw new MaterialValidationError('Native text requires valid UTF-8'); }
    return;
  }
  throw new MaterialValidationError('Unsupported native material format');
}

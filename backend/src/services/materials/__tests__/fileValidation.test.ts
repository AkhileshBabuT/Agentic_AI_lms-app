import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import * as CFB from 'cfb';
import { validateMaterialFile } from '../fileValidation';
describe('attachment signature and archive bounds', () => {
  it.each([
    ['lecture.ppt', 'application/vnd.ms-powerpoint'],
    ['notes.doc', 'application/msword'],
    ['sheet.xls', 'application/vnd.ms-excel'],
  ])('recognizes the complete OLE signature for %s', (filename, mimeType) => {
    const compound = CFB.utils.cfb_new();
    CFB.utils.cfb_add(compound, 'TestStream', Buffer.from('Synthetic Office fixture'));
    const buffer = CFB.write(compound, { type: 'buffer', fileType: 'cfb' });
    expect(() => validateMaterialFile(buffer, filename, mimeType)).not.toThrow();
    expect(() => validateMaterialFile(Buffer.from('Not a compound document'), filename, mimeType)).toThrow('Invalid legacy Office signature');
  });
  it('accepts native text and rejects binary or mislabeled content', () => {
    expect(() => validateMaterialFile(Buffer.from('Native course notes'), 'notes.txt', 'text/plain')).not.toThrow();
    expect(() => validateMaterialFile(Buffer.from([0xff,0x00]), 'notes.txt', 'text/plain')).toThrow();
    expect(() => validateMaterialFile(Buffer.from('not a PDF'), 'notes.pdf', 'application/pdf')).toThrow();
    expect(() => validateMaterialFile(Buffer.from('%PDF-1.4'), 'notes.docx', 'application/pdf')).toThrow();
  });
  it('recognizes real OOXML package type and rejects a mislabeled workbook', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Section','Reference'],['RAG','Page 2']]), 'Course');
    const buffer = XLSX.write(workbook,{bookType: 'xlsx',type: 'buffer'});
    expect(() => validateMaterialFile(buffer,'course.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).not.toThrow();
    expect(() => validateMaterialFile(buffer,'course.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toThrow();
  });
  it('rejects claimed archive expansion before the parser decompresses it', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['Course']]),'Course');
    const buffer: Buffer = XLSX.write(workbook,{bookType: 'xlsx',type: 'buffer'});
    for (let position = 0;position < buffer.length - 46;position++) {
      if (buffer.readUInt32LE(position) === 0x02014b50) { buffer.writeUInt32LE(300 * 1024 * 1024,position + 24); break; }
    }
    expect(() => validateMaterialFile(buffer,'course.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toThrow();
  });
});

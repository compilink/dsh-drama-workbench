/** Generate an OOXML document with deterministic ZIP entries and escaped draft text. */
const officeMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const contentTypes = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="' + officeMime + '.main+xml"/></Types>';
const relationships = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function zip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(content);
    let checksum = 0xffffffff;
    for (const byte of data) checksum = crcTable[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
    checksum = (checksum ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    chunks.push(header, filename, data);
    directory.push(entry, filename);
    offset += header.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22), index = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, index, end]);
}

function xml(value: string): string {
  return Buffer.from(value).toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[<>&]/g, char => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[char]!);
}

export function exportDraft(title: string, content: string, format: 'docx' | 'md'): {mime:string; bytes:Buffer} {
  if (format === 'md') return {mime: 'text/markdown; charset=utf-8', bytes: Buffer.from('# ' + title + '\n\n' + content + '\n')};
  const lines = [title, ...content.split(/\r?\n/)].map((line, index) => {
    const properties = index === 0 ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : '';
    return '<w:p><w:r>' + properties + '<w:t xml:space="preserve">' + xml(line) + '</w:t></w:r></w:p>';
  });
  const document = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + lines.join('') + '</w:body></w:document>';
  return {mime: officeMime, bytes: zip({'[Content_Types].xml':contentTypes,'_rels/.rels':relationships,'word/document.xml':document})};
}

const materialTypes = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'docx'];
const materialCap = 8 * 1024 * 1024;
const maxDocumentXmlBytes = 16 * 1024 * 1024;

function materialDecode(bytes){
 if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(bytes);
 if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be').decode(bytes);
 try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('gb18030',{fatal:true}).decode(bytes);}
}
async function materialWordText(bytes){
 const size=bytes.byteLength, view=new DataView(bytes.buffer,bytes.byteOffset,size), u16=p=>view.getUint16(p,true),u32=p=>view.getUint32(p,true);
 let end=size-22;
 while(end>=Math.max(0,size-65557)&&(u32(end)!==0x06054b50||end+22+u16(end+20)!==size))end--;
 if(end<Math.max(0,size-65557)||u16(end+4)!==0||u16(end+6)!==0)throw new Error('无法打开此 DOCX。');
 const decoder=new TextDecoder(), count=u16(end+10), dirSize=u32(end+12), dirStart=u32(end+16);
 if(count>4096||dirStart+dirSize>end)throw new Error('无法读取此 DOCX 的文件结构。');
 for(let i=0,p=dirStart;i<count;i++){
  const limit=dirStart+dirSize;
  if(p+46>limit||u32(p)!==0x02014b50)break;
  const nameLen=u16(p+28), extra=u16(p+30), comment=u16(p+32), cur=p;
  p+=46+nameLen+extra+comment;
  if(p>limit)break;
  if(decoder.decode(bytes.subarray(cur+46,cur+46+nameLen))!=='word/document.xml')continue;
  const packed=u32(cur+20), plain=u32(cur+24), head=u32(cur+42), method=u16(cur+10);
  if(u16(cur+8)&1)throw new Error('加密的 DOCX 无法解析。');
  if(plain>maxDocumentXmlBytes||head+30>dirStart||u32(head)!==0x04034b50)throw new Error('正文过大或文件损坏。');
  const start=head+30+u16(head+26)+u16(head+28);
  if(start+packed>dirStart)throw new Error('DOCX 正文不完整。');
  let data=bytes.slice(start,start+packed);
  if(method===8){
   if(typeof DecompressionStream!=='function')throw new Error('当前浏览器无法解压 DOCX，可另存为 TXT 再上传。');
   const unzip=new DecompressionStream('deflate-raw'), writer=unzip.writable.getWriter();
   const writing=(async()=>{await writer.write(data);await writer.close();})();writing.catch(()=>{});
   const reader=unzip.readable.getReader(), chunks=[];let total=0;
   try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>maxDocumentXmlBytes)throw new Error('DOCX 正文过大。');chunks.push(next.value);}}
   catch(error){await reader.cancel().catch(()=>{});throw error;}
   await writing;data=new Uint8Array(total);let offset=0;for(const item of chunks){data.set(item,offset);offset+=item.byteLength;}
  }else if(method!==0)throw new Error('不支持此 DOCX 的压缩方式。');
  if(data.byteLength!==plain)throw new Error('DOCX 正文不完整。');
  const xml=new DOMParser().parseFromString(decoder.decode(data),'application/xml');
  if(xml.querySelector('parsererror'))throw new Error('无法解析 DOCX 正文。');
  const ns=xml.documentElement.namespaceURI;
  if(!ns||!['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main'].includes(ns))throw new Error('未找到 Word 正文。');
  const extract=node=>Array.from(node.childNodes).map(n=>{
   if(n.nodeType!==1)return '';
   if(n.namespaceURI===ns){if(n.localName==='t')return n.textContent;if(n.localName==='tab')return '\t';if(n.localName==='br'||n.localName==='cr')return '\n';if(n.localName==='del'||n.localName==='p')return '';}
   return extract(n);
  }).join('');
  return Array.from(xml.getElementsByTagNameNS(ns,'p')).map(extract).join('\n').trim();
 }
 throw new Error('未找到 Word 正文。');
}
export async function parseMaterial(file){
 const ext=file.name.split('.').at(-1)?.toLowerCase();
 if(!materialTypes.includes(ext))throw new Error('此格式暂不支持，请转换成 DOCX 或 TXT。');
 if(file.size>materialCap)throw new Error('文件超过 8 MB，请拆分后上传。');
 const bytes=new Uint8Array(await file.arrayBuffer());
 let body=ext==='docx'?await materialWordText(bytes):materialDecode(bytes);
 if(/\u0000/.test(body))throw new Error('无法识别文本编码，请另存为 UTF-8。');
 if(ext==='json'){try{body=JSON.stringify(JSON.parse(body),null,2);}catch{throw new Error('JSON 格式无效。');}}
 if(!body.trim())throw new Error('没有可编辑的文字。');
 return {title:file.name.replace(/\.[^.]+$/,'').slice(0,120)||file.name,body,bytes};
}

/** Browser/Node PNG tEXt V2/V3 character card reader and writer. */
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});
const SIGNATURE=Uint8Array.from([137,80,78,71,13,10,26,10]);
const crcTable=(()=>{
  const t=new Uint32Array(256);
  for(let i=0;i<256;i++){let n=i;for(let j=0;j<8;j++)n=(n&1)?(n>>>1)^0xEDB88320:(n>>>1);t[i]=n>>>0;}
  return t;
})();
function crc32(bytes){let c=0xFFFFFFFF;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function u32(input,pos){return ((input[pos]*0x1000000)+((input[pos+1]<<16)|(input[pos+2]<<8)|input[pos+3]))>>>0;}
function put32(input,pos,n){input[pos]=(n>>>24)&255;input[pos+1]=(n>>>16)&255;input[pos+2]=(n>>>8)&255;input[pos+3]=n&255;}
function concat(parts){let total=0;for(const a of parts)total+=a.length;const buf=new Uint8Array(total);let p=0;for(const a of parts){buf.set(a,p);p+=a.length;}return buf;}
function asBytes(v){return v instanceof Uint8Array?v:new Uint8Array(v);}
function toBase64(bytes){
  // Encode via typed arrays; never spread large byte arrays into a JS call.
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const result=new Uint8Array(Math.ceil(bytes.length/3)*4);
  let i=0,j=0;
  for(;i+2<bytes.length;i+=3){
    const n=(bytes[i]<<16)|(bytes[i+1]<<8)|bytes[i+2];
    result[j++]=alphabet.charCodeAt((n>>>18)&63);
    result[j++]=alphabet.charCodeAt((n>>>12)&63);
    result[j++]=alphabet.charCodeAt((n>>>6)&63);
    result[j++]=alphabet.charCodeAt(n&63);
  }
  if(i<bytes.length){
    const n=bytes[i]<<16|((i+1<bytes.length?bytes[i+1]:0)<<8);
    result[j++]=alphabet.charCodeAt((n>>>18)&63);
    result[j++]=alphabet.charCodeAt((n>>>12)&63);
    result[j++]=i+1<bytes.length?alphabet.charCodeAt((n>>>6)&63):61;
    result[j++]=61;
  }
  return new TextDecoder('ascii').decode(result);
}
function fromBase64(s){
  if(typeof atob==='undefined')throw new Error('环境不支持 Base64');
  const value=atob(s);const out=new Uint8Array(value.length);
  for(let i=0;i<value.length;i++)out[i]=value.charCodeAt(i);
  return out;
}
function typeOf(bytes){
  // PNG tEXt keywords and character-card base64 are ASCII; native decode
  // avoids call stack overflow in browsers with lower argument limits.
  return new TextDecoder('windows-1252').decode(bytes);
}
function chunksOf(bytes){
  for(let i=0;i<8;i++)if(bytes[i]!==SIGNATURE[i])throw new Error('不是 PNG 图片');
  const out=[];let pos=8,ended=false;
  while(pos+12<=bytes.length){
    const n=u32(bytes,pos);
    if(n>bytes.length-pos-12)throw new Error('PNG 数据长度不正确');
    const type=typeOf(bytes.subarray(pos+4,pos+8));
    out.push({type,data:bytes.subarray(pos+8,pos+8+n)});
    pos+=n+12;
    if(type==='IEND'){ended=true;break;}
  }
  if(!ended)throw new Error('PNG 缺少 IEND');
  return out;
}
function decodeText(data){
  const sep=data.indexOf(0);if(sep<0)return null;
  return {keyword:typeOf(data.subarray(0,sep)),text:typeOf(data.subarray(sep+1))};
}
function makeChunk(type,data){
  const buf=new Uint8Array(data.length+12);
  put32(buf,0,data.length);for(let i=0;i<4;i++)buf[i+4]=type.charCodeAt(i);
  buf.set(data,8);put32(buf,buf.length-4,crc32(buf.subarray(4,-4)));
  return buf;
}
function latin1Bytes(value){
  // Avoid huge temporary arrays when serializing large base64 metadata.
  const out=new Uint8Array(value.length);
  for(let i=0;i<value.length;i++)out[i]=value.charCodeAt(i);
  return out;
}
function makeText(keyword,value){
  return makeChunk('tEXt',concat([latin1Bytes(keyword),Uint8Array.of(0),latin1Bytes(value)]));
}
function findCardChunk(chunks){
  const texts=chunks.filter(x=>x.type==='tEXt').map(x=>decodeText(x.data)).filter(Boolean);
  return texts.find(x=>x.keyword.toLowerCase()==='ccv3')||texts.find(x=>x.keyword.toLowerCase()==='chara');
}
export function readPngCard(input){
  const chunks=chunksOf(asBytes(input)), meta=findCardChunk(chunks);
  if(!meta)throw new Error('PNG 没有角色卡元数据 chara / ccv3');
  return JSON.parse(decoder.decode(fromBase64(meta.text)));
}
export function writePngCard(input,card){
  const chunks=chunksOf(asBytes(input));
  if(!findCardChunk(chunks))throw new Error('PNG 不是角色卡');
  const v2=toBase64(encoder.encode(JSON.stringify(card)));
  const v3=toBase64(encoder.encode(JSON.stringify({...card,spec:'chara_card_v3',spec_version:'3.0'})));
  const result=[SIGNATURE];
  for(const part of chunks){
    const key=part.type==='tEXt'?decodeText(part.data)?.keyword?.toLowerCase():null;
    if(key==='chara'||key==='ccv3')continue;
    if(part.type==='IEND'){result.push(makeText('chara',v2));result.push(makeText('ccv3',v3));}
    result.push(makeChunk(part.type,part.data));
  }
  const image=concat(result);
  if(JSON.stringify(readPngCard(image).data?.character_book)!==JSON.stringify(card.data?.character_book))
    throw new Error('写入 PNG 后世界书校验失败');
  return image;
}

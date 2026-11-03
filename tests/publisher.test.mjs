import test from 'node:test';
import assert from 'node:assert/strict';
import { publishCard, auditPublishedCard } from '../publisher.js';
import { readPngCard, writePngCard } from '../png-card.js';

function card() {
  return {
    spec:'chara_card_v2',data:{
      name:'测试',extensions:{world:'TestBook',regex_scripts:[]},
      character_book:{name:'TestBook',entries:[
        {id:1,comment:'公共信息',content:'这里是一座城镇',keys:['城镇'],extensions:{}},
        {id:2,comment:'秘密身份',content:'他其实是继承人',keys:['信件'],extensions:{lore_spoilers_visibility:'hidden'}}
      ]}
    }
  };
}

test('keeps public lore, hides private text and restores it in WORLD_INFO regex',()=>{
  const original=card(),before=JSON.stringify(original);
  const {card:published,report}=publishCard(original,{expectedWorld:'TestBook'});
  assert.equal(JSON.stringify(original),before);
  assert.equal(report.hiddenCount,1);
  assert.equal(published.data.character_book.entries[0].content,'这里是一座城镇');
  const hidden=published.data.character_book.entries[1];
  assert.match(hidden.content,/^LSPHIDDEN_/);
  assert.ok(!JSON.stringify(published.data.character_book).includes('他其实是继承人'));
  const script=published.data.extensions.regex_scripts[0];
  assert.deepEqual(script.placement,[5]);
  assert.equal(script.promptOnly,true);
  assert.equal(hidden.content.replace(new RegExp(script.findRegex),()=>script.replaceString),'他其实是继承人');
  assert.equal(auditPublishedCard(published).ok,true);
});

test('rejects mismatched books and dangerous replacement syntax',()=>{
  assert.throws(()=>publishCard(card(),{expectedWorld:'WrongBook'}),/世界书/);
  const example=card();example.data.character_book.entries[1].content='bad $1 group';
  assert.throws(()=>publishCard(example),/捕获组/);
});

const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?(c>>>1)^0xEDB88320:c>>>1;return c>>>0;});
function chunk(type,data){
  const body=Buffer.concat([Buffer.from(type),data]),output=Buffer.alloc(12+data.length);
  output.writeUInt32BE(data.length,0);body.copy(output,4);let crc=0xFFFFFFFF;
  for(const b of body)crc=crcTable[(crc^b)&255]^(crc>>>8);
  output.writeUInt32BE((crc^0xFFFFFFFF)>>>0,output.length-4);return output;
}
function fixture(meta) {
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
  const raw=Buffer.from(JSON.stringify(meta)).toString('base64');
  const extra=chunk('tEXt',Buffer.concat([Buffer.from('chara\0'),Buffer.from(raw)]));
  return Buffer.concat([png.subarray(0,-12),extra,png.subarray(-12)]);
}
test('PNG writes synchronised chara and ccv3 while retaining image',()=>{
  const input=fixture(card());
  assert.equal(readPngCard(input).data.name,'测试');
  const updated=publishCard(card()).card;
  const result=writePngCard(input,updated),parsed=readPngCard(result);
  assert.equal(parsed.spec,'chara_card_v3');
  assert.equal(parsed.data.character_book.entries[1].content,updated.data.character_book.entries[1].content);
  assert.ok(Buffer.from(result).includes(Buffer.from('IHDR')));
  assert.ok(Buffer.from(result).includes(Buffer.from('IDAT')));
});


test('large PNG character metadata is read and written without call stack overflow',()=>{
  // A real-world character lorebook can easily exceed 128 KiB after Base64 encoding.
  const large=card();
  large.data.character_book.entries[1].content='隐秘的身世与剧情信息。'.repeat(25000);
  const image=fixture(large);
  assert.ok(image.length>200000);
  assert.equal(readPngCard(image).data.character_book.entries[1].content,large.data.character_book.entries[1].content);
  const published=publishCard(large).card;
  const output=writePngCard(image,published);
  const parsed=readPngCard(output);
  assert.match(parsed.data.character_book.entries[1].content,/^LSPHIDDEN_/);
  assert.equal(parsed.data.extensions.regex_scripts.at(-1).replaceString,large.data.character_book.entries[1].content);
});


test('multi-megabyte lorebook metadata roundtrip without stack overflow', () => {
  const large=card();
  // Several megabytes of UTF-8 data, representative of a long lorebook.
  const secret='秘密身份与世界书正文。'.repeat(180000);
  large.data.character_book.entries[1].content=secret;
  const png=fixture(large);
  assert.ok(png.byteLength>3000000);
  assert.equal(readPngCard(png).data.character_book.entries[1].content,secret);
  const published=publishCard(large).card;
  const output=writePngCard(png,published);
  const result=readPngCard(output);
  assert.ok(result.data.character_book.entries[1].content.startsWith('LSPHIDDEN_'));
  assert.equal(result.data.extensions.regex_scripts.at(-1).replaceString,secret);
});

test('10MB front-end MVU author-card preservation',()=>{
  const source=card();
  source.data.first_mes='<main class="mvu">'+ 'H'.repeat(3600000) +'</main><script>window.interactive=true</script>';
  source.data.extensions.mvu={inventory:'M'.repeat(3600000),character:{state:{hp:100,trust:12}}};
  source.data.character_book.entries[0].content='public '+ 'P'.repeat(2000000);
  source.data.character_book.entries[1].content='secret '+ 'S'.repeat(2000000);
  assert.ok(Buffer.byteLength(JSON.stringify(source))>10000000);
  const image=fixture(source);
  const output=publishCard(source).card;
  assert.equal(source.data.character_book.entries[1].content.startsWith('secret'),true);
  assert.equal(output.data.first_mes,source.data.first_mes);
  assert.deepEqual(output.data.extensions.mvu,source.data.extensions.mvu);
  const png=writePngCard(image,output);
  const loaded=readPngCard(png);
  assert.equal(loaded.data.first_mes,source.data.first_mes);
  assert.deepEqual(loaded.data.extensions.mvu,source.data.extensions.mvu);
  assert.equal(loaded.data.character_book.entries[0].content,source.data.character_book.entries[0].content);
  assert.equal(loaded.data.extensions.regex_scripts.at(-1).replaceString,source.data.character_book.entries[1].content);
});

test('empty lore entries are skipped while valid hidden entries still publish',()=>{
  const source=card();
  source.data.character_book.entries.push(
    {id:408006,comment:'MVU 控制项',content:'',keys:['trigger'],extensions:{lore_spoilers_visibility:'hidden'},enabled:true},
    {id:408007,comment:'只有空格',content:' \n  ',keys:['scene'],extensions:{lore_spoilers_visibility:'hidden'},enabled:true}
  );
  const original=JSON.stringify(source);
  const {card:output,report}=publishCard(source);
  assert.equal(JSON.stringify(source),original);
  assert.equal(report.skippedEmptyCount,2);
  assert.deepEqual(report.skippedEmptyIds,['408006','408007']);
  assert.equal(report.hiddenCount,1);
  assert.equal(output.data.character_book.entries[2].content,'');
  assert.equal(output.data.character_book.entries[2].comment,'MVU 控制项');
  assert.deepEqual(output.data.character_book.entries[2].keys,['trigger']);
  assert.equal(output.data.character_book.entries[2].extensions.lore_spoilers_visibility,'public');
  assert.equal(output.data.character_book.entries[2].enabled,true);
  assert.equal(output.data.character_book.entries[3].content,' \n  ');
  assert.equal(auditPublishedCard(output).ok,true);
});

test('all selected hidden entries blank returns actionable message',()=>{
  const source=card();
  source.data.character_book.entries[1].content='';
  assert.throws(()=>publishCard(source),/正文全部为空/);
});

test('publishing creates a new lorebook name and binding, separate from the author world',()=>{
  const source=card();
  const {card:release,report}=publishCard(source);
  assert.equal(source.data.extensions.world,'TestBook');
  assert.equal(source.data.character_book.name,'TestBook');
  assert.notEqual(release.data.character_book.name,source.data.character_book.name);
  assert.equal(release.data.extensions.world,release.data.character_book.name);
  assert.match(release.data.extensions.world,/防剧透世界书/);
  assert.equal(report.world,release.data.extensions.world);
  assert.equal(report.sourceWorld,'TestBook');
  assert.equal(auditPublishedCard(release).ok,true);
  const image=writePngCard(fixture(source),release);
  const read=readPngCard(image);
  assert.equal(read.data.extensions.world,release.data.extensions.world);
  assert.equal(read.data.character_book.name,release.data.extensions.world);
});

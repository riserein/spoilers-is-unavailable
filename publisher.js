/**
 * Lore Spoilers author-only release core. Spoiler deterrent, NOT encryption.
 * The original secret text is moved into character-scoped Regex scripts.
 */
export const VISIBILITY_FIELD = 'lore_spoilers_visibility';
export const SCRIPT_PREFIX = 'LSP Publish ▸ ';

function getEntries(card) {
  const book = card?.data?.character_book;
  if (!book || !Array.isArray(book.entries)) throw new Error('角色卡没有内嵌世界书。请先绑定主世界书并保存角色，再导出。');
  return book;
}
function getId(entry, index) { return String(entry.id ?? entry.uid ?? index); }
function freshToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID().replaceAll('-', '').slice(0,24);
  throw new Error('当前环境不支持安全随机数，无法生成占位符。');
}
function validateContent(text,uid) {
  if (typeof text !== 'string' || !text.length) return `条目 #${uid} 的正文为空，无法发布`;
  if (/\$\d+|\$<[^>]+>/.test(text)) return `条目 #${uid} 含 $1 / $<name> 形式的文本，正则会误认为捕获组；请先改写。`;
  return null;
}
export function publishCard(sourceCard, { visibilityByUid=null, expectedWorld='' }={}) {
  if (!sourceCard || typeof sourceCard !== 'object') throw new Error('角色卡数据无效');
  const card=JSON.parse(JSON.stringify(sourceCard));
  const book=getEntries(card);
  const linkedWorld=String(card.data?.extensions?.world || '');
  if (expectedWorld && linkedWorld && linkedWorld!==expectedWorld) throw new Error(`角色绑定的主世界书是「${linkedWorld}」，当前却选了「${expectedWorld}」`);
  if (expectedWorld && book.name && book.name!==expectedWorld && linkedWorld!==expectedWorld) throw new Error(`内嵌世界书「${book.name}」与「${expectedWorld}」不匹配`);
  const scripts=Array.isArray(card.data?.extensions?.regex_scripts)
    ? card.data.extensions.regex_scripts.filter(s=>!String(s?.scriptName||'').startsWith(SCRIPT_PREFIX)) : [];
  const hiddenIds=[],markers=[],issues=[];let visible=0;
  const token=freshToken();
  book.entries.forEach((entry,index)=>{
    const uid=getId(entry,index);
    const override=visibilityByUid && Object.hasOwn(visibilityByUid,uid)?visibilityByUid[uid]:null;
    const hidden=(override??entry.extensions?.[VISIBILITY_FIELD])==='hidden';
    entry.extensions ||= {};
    entry.extensions[VISIBILITY_FIELD]=hidden?'hidden':'public';
    if(!hidden){visible++;return}
    const secret=entry.content;
    const issue=validateContent(secret,uid);
    if(issue){issues.push(issue);return}
    const marker=`LSPHIDDEN_${token}_${index}`;
    entry.content=marker;
    entry.comment=`🔒 隐藏剧情条目 ${index+1}`;
    scripts.push({
      id:`lsp-${token}-${index}`,scriptName:`${SCRIPT_PREFIX}${uid}`,
      findRegex:`^${marker}$`,replaceString:secret,trimStrings:[],placement:[5],
      disabled:false,markdownOnly:false,promptOnly:true,runOnEdit:false,
      substituteRegex:0,minDepth:null,maxDepth:null
    });
    hiddenIds.push(uid);markers.push(marker);
  });
  if(issues.length) throw new Error(issues.join('\n'));
  if(!hiddenIds.length) throw new Error('没有标记为隐藏的条目，未生成发布版');
  card.data.extensions ||= {};
  card.data.extensions.regex_scripts=scripts;
  if(card.character_book && card.character_book!==card.data.character_book) delete card.character_book;
  card.data.extensions.lore_spoilers_publish={
    version:'2.0.0',count:hiddenIds.length,
    note:'Text is present in scoped regex replacement strings: NOT encrypted.'
  };
  const report={
    world:book.name||linkedWorld||'',total:book.entries.length,publicCount:visible,
    hiddenCount:hiddenIds.length,hiddenIds,markers,scriptCount:scripts.length
  };
  for(let j=0;j<hiddenIds.length;j++) {
    const script=scripts[scripts.length-hiddenIds.length+j];
    const entry=book.entries.find(e=>e.content===markers[j]);
    if(!entry||entry.content.replace(new RegExp(script.findRegex),()=>script.replaceString)!==script.replaceString) {
      throw new Error('占位符还原测试失败');
    }
  }
  return {card,report};
}
export function auditPublishedCard(card) {
  const book=getEntries(card),scripts=card.data?.extensions?.regex_scripts||[];
  const issues=[];let count=0;
  book.entries.forEach(entry=>{
    if(entry.extensions?.[VISIBILITY_FIELD]!=='hidden')return;
    count++;
    const matched=scripts.filter(s=>String(s?.scriptName||'').startsWith(SCRIPT_PREFIX)
      &&s.findRegex===`^${entry.content}$` && s.promptOnly===true && s.placement?.includes(5));
    if(matched.length!==1) issues.push(`占位符 ${entry.content} 没有唯一的还原规则`);
    if(!/^LSPHIDDEN_[a-z0-9]+_\d+$/i.test(entry.content))issues.push('有隐藏条目没有变成占位符');
  });
  if(!count)issues.push('未找到隐藏条目');
  return {ok:!issues.length,hiddenCount:count,issues};
}

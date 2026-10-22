// Writes the case corpus: bid responses (and auction requests) as raw bytes, one edge case each.
// Every case is the base document with one mutation, so a difference is attributable to it.
// Text is written as JSON source: "\\ud800" stays an escape in the bytes, and <FF> becomes byte 0xFF.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const dir = new URL('./cases/', import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir + 'resp', { recursive: true });
mkdirSync(dir + 'req', { recursive: true });

// --- bid response -------------------------------------------------------------------------------
const BID = (m = {}) => {
  const f = {
    id: '"b1"', impid: '"1"', price: '1.5', adm: '"<div/>"', mtype: '1', cat: '["IAB1"]', dur: '30',
    ext: '{"dsp_id":"7","buyer_id":"8","brand_id":"9","prebiddealpriority":5,"marketplace":"m","video":{"duration":15},"ibv":false}',
    ...m,
  };
  return '{' + Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => (k.startsWith('@') ? v : `"${k}":${v}`)).join(',') + '}';
};
const RESP = ({ bid = BID(), seatbid, cur = '"USD"', ext = '{"fledge_auction_configs":{"1":{"seller":"https://x"}}}', extra = '' } = {}) => {
  const sb = seatbid ?? `[{"seat":"openx","bid":[${bid}]}]`;
  const parts = ['"id":"r1"'];
  if (sb !== 'ABSENT') parts.push(`"seatbid":${sb}`);
  if (cur !== undefined) parts.push(`"cur":${cur}`);
  if (ext !== undefined) parts.push(`"ext":${ext}`);
  if (extra) parts.push(extra);
  return '{' + parts.join(',') + '}';
};

const resp = {
  base: RESP(),
  // presence, null and zero on typed scalars
  'mtype-absent': RESP({ bid: BID({ mtype: undefined }) }),
  'mtype-null': RESP({ bid: BID({ mtype: 'null' }) }),
  'mtype-0': RESP({ bid: BID({ mtype: '0' }) }),
  'dur-absent': RESP({ bid: BID({ dur: undefined }) }),
  'dur-0': RESP({ bid: BID({ dur: '0' }) }),
  'dur-null': RESP({ bid: BID({ dur: 'null' }) }),
  // number spelling and type in typed scalars
  'mtype-2.0': RESP({ bid: BID({ mtype: '2.0' }) }),
  'mtype-2e0': RESP({ bid: BID({ mtype: '2e0' }) }),
  'mtype-2.5': RESP({ bid: BID({ mtype: '2.5' }) }),
  'mtype-string': RESP({ bid: BID({ mtype: '"2"' }) }),
  'mtype-true': RESP({ bid: BID({ mtype: 'true' }) }),
  'mtype-300': RESP({ bid: BID({ mtype: '300' }) }),
  'mtype-neg0': RESP({ bid: BID({ mtype: '-0' }) }),
  'dur-30.0': RESP({ bid: BID({ dur: '30.0' }) }),
  'dur-string': RESP({ bid: BID({ dur: '"30"' }) }),
  'dur-2^31': RESP({ bid: BID({ dur: '2147483648' }) }),
  'dur-1e21': RESP({ bid: BID({ dur: '1e21' }) }),
  // arrays
  'cat-absent': RESP({ bid: BID({ cat: undefined }) }),
  'cat-null': RESP({ bid: BID({ cat: 'null' }) }),
  'cat-empty': RESP({ bid: BID({ cat: '[]' }) }),
  'cat-scalar': RESP({ bid: BID({ cat: '"IAB1"' }) }),
  'cat-null-elem': RESP({ bid: BID({ cat: '[null,"IAB2"]' }) }),
  'cat-number-elem': RESP({ bid: BID({ cat: '[1]' }) }),
  // strings
  'impid-absent': RESP({ bid: BID({ impid: undefined }) }),
  'impid-null': RESP({ bid: BID({ impid: 'null' }) }),
  'impid-empty': RESP({ bid: BID({ impid: '""' }) }),
  'impid-number': RESP({ bid: BID({ impid: '1' }) }),
  'cur-absent': RESP({ cur: undefined }),
  'cur-null': RESP({ cur: 'null' }),
  'cur-empty': RESP({ cur: '""' }),
  'cur-escapes': RESP({ cur: '"\\u0055S\\/D"' }),
  'cur-lone-surrogate': RESP({ cur: '"US\\ud800D"' }),
  'cur-invalid-utf8': RESP({ cur: '"US<FF>D"' }),
  'adm-native': RESP({ bid: BID({ adm: '"{\\"native\\":{\\"assets\\":[{\\"id\\":1,\\"img\\":{\\"url\\":\\"u\\",\\"w\\":1.50}}]}}"', mtype: '4' }) }),
  'adm-null': RESP({ bid: BID({ adm: 'null' }) }),
  'adm-lone-surrogate': RESP({ bid: BID({ adm: '"<div>\\udc00</div>"' }) }),
  // raw-JSON fields (bid.ext, response.ext): numbers, strings, nulls
  'ext-number-1.50': RESP({ bid: BID({ ext: '{"dsp_id":1.50}' }) }),
  'ext-number-big': RESP({ bid: BID({ ext: '{"dsp_id":12345678901234567890}' }) }),
  'ext-number-1e21': RESP({ bid: BID({ ext: '{"dsp_id":1e21}' }) }),
  'ext-number-neg0': RESP({ bid: BID({ ext: '{"dsp_id":-0}' }) }),
  'ext-number-1e400': RESP({ bid: BID({ ext: '{"dsp_id":1e400}' }) }),
  'ext-number-17digits': RESP({ bid: BID({ ext: '{"dsp_id":0.1000000000000000055511151231257827}' }) }),
  'ext-null-member': RESP({ bid: BID({ ext: '{"dsp_id":null,"video":null}' }) }),
  'ext-lone-surrogate': RESP({ bid: BID({ ext: '{"marketplace":"m\\ud800"}' }) }),
  'bid-ext-null': RESP({ bid: BID({ ext: 'null' }) }),
  'bid-ext-array': RESP({ bid: BID({ ext: '[1]' }) }),
  'bid-ext-empty': RESP({ bid: BID({ ext: '{}' }) }),
  'resp-ext-null': RESP({ ext: 'null' }),
  'resp-ext-string': RESP({ ext: '"x"' }),
  // member order and duplicates inside a raw-JSON field the Adapter enumerates (Object.entries)
  'paapi-order': RESP({ ext: '{"fledge_auction_configs":{"b":{"s":1},"a":{"s":2}}}' }),
  'paapi-int-keys': RESP({ ext: '{"fledge_auction_configs":{"x":{"s":1},"2":{"s":2},"1":{"s":3}}}' }),
  'paapi-dup-key': RESP({ ext: '{"fledge_auction_configs":{"1":{"s":1},"2":{"s":2},"1":{"s":3}}}' }),
  'paapi-inner-order': RESP({ ext: '{"fledge_auction_configs":{"1":{"z":1,"a":2.50}}}' }),
  'paapi-proto-key': RESP({ ext: '{"fledge_auction_configs":{"__proto__":{"s":1},"1":{"s":2}}}' }),
  'paapi-constructor': RESP({ ext: '{"fledge_auction_configs":{"1":{"constructor":{"prototype":{}}}}}' }),
  'resp-ext-dup-paapi': RESP({ ext: '{"fledge_auction_configs":{"1":{"s":1}},"fledge_auction_configs":{"2":{"s":2}}}' }),
  // duplicate and differently cased keys on typed fields
  'mtype-dup': RESP({ bid: BID({ mtype: undefined, '@1': '"mtype":2,"mtype":1' }) }),
  'mtype-case': RESP({ bid: BID({ mtype: undefined, '@1': '"MTYPE":2' }) }),
  'mtype-case-and-exact': RESP({ bid: BID({ '@1': '"MType":2' }) }),
  'ext-case': RESP({ bid: BID({ ext: undefined, '@1': '"EXT":{"dsp_id":"7"}' }) }),
  // structure
  'seatbid-absent': RESP({ seatbid: 'ABSENT' }),
  'seatbid-null': RESP({ seatbid: 'null' }),
  'seatbid-empty': RESP({ seatbid: '[]' }),
  'seatbid-null-elem': RESP({ seatbid: `[null,{"seat":"openx","bid":[${BID()}]}]` }),
  'bid-null': RESP({ seatbid: '[{"seat":"openx","bid":null}]' }),
  'bid-absent': RESP({ seatbid: '[{"seat":"openx"}]' }),
  'bid-null-elem': RESP({ seatbid: `[{"seat":"openx","bid":[null,${BID()}]}]` }),
  'seatbid-object': RESP({ seatbid: `{"seat":"openx","bid":[${BID()}]}` }),
};

// --- auction request (as the Host would hand it to the Adapter) ----------------------------------
const IMP = (m = {}) => {
  const f = {
    id: '"1"', banner: '{"w":300,"h":250,"format":[{"w":300,"h":250}]}', tagid: '"t"', bidfloor: '0.5',
    ext: '{"bidder":{"unit":"123","delDomain":"x.openx.net","customFloor":1.5,"customParams":{"b":1,"a":2}}}',
    ...m,
  };
  return '{' + Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => `"${k}":${v}`).join(',') + '}';
};
const REQ = ({ imp = IMP(), extra = '' } = {}) => `{"id":"q1","imp":[${imp}],"site":{"page":"https://p","publisher":{"id":"p"}}${extra}}`;
const req = {
  base: REQ(),
  'bidfloor-absent': REQ({ imp: IMP({ bidfloor: undefined }) }),
  'bidfloor-0': REQ({ imp: IMP({ bidfloor: '0' }) }),
  'bidfloor-1.50': REQ({ imp: IMP({ bidfloor: '1.50' }) }),
  'bidfloor-17digits': REQ({ imp: IMP({ bidfloor: '0.1000000000000000055511151231257827' }) }),
  'bidfloor-string': REQ({ imp: IMP({ bidfloor: '"1.5"' }) }),
  'banner-null': REQ({ imp: IMP({ banner: 'null', video: '{"mimes":["video/mp4"]}' }) }),
  'banner-empty': REQ({ imp: IMP({ banner: '{}' }) }),
  'banner-w-0': REQ({ imp: IMP({ banner: '{"w":0,"h":250}' }) }),
  'banner-w-300.0': REQ({ imp: IMP({ banner: '{"w":300.0,"h":250}' }) }),
  'banner-format-empty': REQ({ imp: IMP({ banner: '{"w":300,"h":250,"format":[]}' }) }),
  'rwdd-0': REQ({ imp: IMP({ rwdd: '0', video: '{"mimes":["video/mp4"]}' }) }),
  'rwdd-1.0': REQ({ imp: IMP({ rwdd: '1.0', video: '{"mimes":["video/mp4"]}' }) }),
  'rwdd-true': REQ({ imp: IMP({ rwdd: 'true', video: '{"mimes":["video/mp4"]}' }) }),
  'native-string': REQ({ imp: IMP({ banner: undefined, native: '{"request":"{\\"ver\\":\\"1.2\\"}"}' }) }),
  'imp-ext-numbers': REQ({ imp: IMP({ ext: '{"bidder":{"unit":"123","delDomain":"x","customFloor":1.50}}' }) }),
  'imp-ext-param-order': REQ({ imp: IMP({ ext: '{"bidder":{"unit":"123","delDomain":"x","customParams":{"z":1,"2":2,"a":3}}}' }) }),
  'imp-ext-lone-surrogate': REQ({ imp: IMP({ ext: '{"bidder":{"unit":"12\\ud8003","delDomain":"x"}}' }) }),
  'tagid-lone-surrogate': REQ({ imp: IMP({ tagid: '"t\\ud800"' }) }),
  'imp-ext-data-order': REQ({ imp: IMP({ ext: '{"bidder":{"publisherId":"p","adSlot":"s"},"data":{"z":1,"pbadslot":"/1","a":2}}' }) }),
};

const enc = (s) => {
  const parts = s.split('<FF>');
  return Buffer.concat(parts.flatMap((p, i) => (i ? [Buffer.from([0xff]), Buffer.from(p, 'utf8')] : [Buffer.from(p, 'utf8')])));
};
for (const [k, v] of Object.entries(resp)) writeFileSync(`${dir}resp/${k}.json`, enc(v));
for (const [k, v] of Object.entries(req)) writeFileSync(`${dir}req/${k}.json`, enc(v));
console.log(`${Object.keys(resp).length} response cases, ${Object.keys(req).length} request cases`);

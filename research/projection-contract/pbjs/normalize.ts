// Prebid.js side of the typed-field rule: what Prebid Core's TS driver would run on a parsed bid
// response before the Phases see it. Optional typed members that are null or zero are deleted;
// required ones (seatbid.bid, bid.impid, bid.id, bid.price, response.id) get their zero when missing.
// Only the OpenRTB response's own members: everything under `ext` is left as sent.
const zero = (v: unknown) => v === null || v === 0 || v === '' || (Array.isArray(v) && !v.length);
function clean(o: any, req: Record<string, unknown>) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return;
  for (const k of Object.keys(o)) if (k !== 'ext' && zero(o[k]) && !(k in req)) delete o[k];
  for (const k in req) if (o[k] == null) o[k] = req[k];
}
export function normalizeResponse(resp: any) {
  clean(resp, { id: '' });
  if (!Array.isArray(resp?.seatbid)) return resp;
  for (const sb of resp.seatbid) {
    clean(sb, { bid: [] });
    if (Array.isArray(sb?.bid)) for (const b of sb.bid) clean(b, { id: '', impid: '', price: 0 });
  }
  return resp;
}

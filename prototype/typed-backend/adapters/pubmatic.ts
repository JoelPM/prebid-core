// PROTOTYPE Shared Adapter: PubMatic, in restricted TypeScript. Intended behavior follows PBS-Go's
// Hand-written Adapter except where defs/known-differences.yaml says otherwise (same as the Definition
// prototype's defs/pubmatic.yaml).
import { defineAdapter, reject, num, int, str, obj, nonempty, parseJson } from '../core/index.ts';
import type { MediaType } from '../core/index.ts';
import type { Json } from '../core/ortb.ts';
import type { PubmaticParams } from './pubmatic.params.ts';

interface PubmaticBidExt { marketplace?: string; prebiddealpriority?: number; video?: { duration?: number }; ibv?: boolean }

const MTYPES: Record<number, MediaType> = { 1: 'banner', 2: 'video', 3: 'audio', 4: 'native' };

// imp.ext.data -> one `key=value` per targeting key; values that aren't strings, numbers, booleans or
// string arrays are skipped (the Hand-written Adapter leaves an empty `||` for them).
const dataPair = (k: string, v: Json): string | undefined => {
  if (typeof v === 'string') return `${k.trim()}=${v.trim()}`;
  if (typeof v === 'number' || typeof v === 'boolean') return `${k.trim()}=${str(v)}`;
  if (Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string')) {
    return `${k.trim()}=${v.map((s) => str(s)?.trim()).join(',')}`;
  }
  return undefined;
};

export default defineAdapter<PubmaticParams, PubmaticBidExt>({
  bidder: 'pubmatic',
  endpoint: 'https://hbopenbid.pubmatic.com/translator?source=prebid-server',
  required: { all: ['publisherId'] },

  core: {
    imp(imp, p, req) {
      // adSlot is `tagid` or `tagid@WxH[:suffix]`
      const slot = p.adSlot?.trim();
      const hasSize = slot?.includes('@') ?? false;
      const at = slot?.split('@') ?? [];
      const sz = at[1]?.toLowerCase().split('x') ?? [];
      const w = int(sz[0]?.trim());
      const h = int(sz[1]?.split(':')[0]?.trim());

      if (!imp.banner && !imp.video && !imp.native) {
        return reject(`invalid MediaType. PubMatic only supports Banner, Video and Native. Ignoring ImpID=${imp.id}`);
      }
      if (hasSize && !(at.length === 2 && at[0] !== '' && at[1] !== '')) return reject(`Invalid adSlot ${slot}`);
      if (hasSize && sz.length !== 2) return reject(`Invalid size provided in adSlot ${slot}`);
      if (hasSize && w == null) return reject(`Invalid width provided in adSlot ${slot}`);
      if (hasSize && h == null) return reject(`Invalid height provided in adSlot ${slot}`);

      const out = { ...imp, audio: undefined };
      const appExt = req.app?.ext;
      const dm = appExt?.prebid?.source && appExt.prebid.version ? appExt.prebid : appExt?.source && appExt.version ? appExt : undefined;
      if (!imp.displaymanager && !imp.displaymanagerver && dm) {
        out.displaymanager = dm.source;
        out.displaymanagerver = dm.version;
      }
      if (slot !== '') out.tagid = hasSize ? at[0]?.trim() : slot;
      const banner = imp.banner;
      if (banner) {
        if (hasSize) out.banner = { ...banner, w, h };
        else if (banner.w == null || banner.h == null) out.banner = { ...banner, w: banner.format?.[0]?.w, h: banner.format?.[0]?.h };
      }
      const kad = num(p.kadfloor?.trim());
      if (kad != null) out.bidfloor = Math.max(kad, imp.bidfloor ?? 0);

      const kw = Object.fromEntries(
        (p.keywords ?? []).filter((k) => k.value.length > 0).map((k) => [k.key === 'pmZoneID' ? 'pmZoneId' : k.key, k.value.join(',')]),
      );
      const data = imp.ext?.data;
      const pairs = Object.entries(data ?? {})
        .filter(([k]) => k !== 'pbadslot' && k !== 'adserver')
        .map(([k, v]) => dataPair(k, v));
      const adserver = obj(data?.adserver);
      out.ext = nonempty({
        ...kw,
        key_val: nonempty([p.dctr || kw.key_val, ...pairs].filter((s) => s).join('|')),
        pmZoneId: p.pmzoneid || kw.pmZoneId,
        dfp_ad_unit_code: (adserver?.name === 'gam' && adserver.adslot) || data?.pbadslot,
        ae: imp.ext?.ae || undefined,
        gpid: imp.ext?.gpid || undefined,
        skadn: imp.ext?.skadn,
      });
      return out;
    },

    request(req, params) {
      const bp = req.ext?.prebid?.bidderparams;
      const bpWrapper = obj(bp?.wrapper);
      const abc = req.ext?.prebid?.alternatebiddercodes;
      const pm = abc?.bidders?.pubmatic;
      const allowed = pm?.allowedbiddercodes;
      const pub = params.map((x) => x.publisherId.trim()).find((x) => x);
      const acat = Array.isArray(bp?.acat) ? bp.acat : [];

      const out = {
        ...req,
        ext: {
          wrapper: nonempty({
            profile: bpWrapper?.profile || params.map((x) => x.wrapper?.profile).find((x) => x) || undefined,
            version: bpWrapper?.version || params.map((x) => x.wrapper?.version).find((x) => x) || undefined,
            biddercode: req.ext ? (Object.keys(req.ext.prebid?.aliases ?? {})[0] ?? 'pubmatic') : undefined,
          }),
          acat: nonempty(acat.filter((a) => typeof a === 'string').map((a) => str(a)?.trim())),
          marketplace:
            abc == null
              ? undefined
              : {
                  allowedbidders: !(abc.enabled && pm?.enabled)
                    ? ['pubmatic']
                    : allowed == null || (allowed.length === 1 && allowed[0] === '*')
                      ? ['all']
                      : ['pubmatic', ...allowed],
                },
        },
      };
      const id = pub || undefined;
      if (out.site) {
        if (id || out.site.publisher) out.site = { ...out.site, publisher: { ...out.site.publisher, id } };
      } else if (out.app) {
        if (id || out.app.publisher) out.app = { ...out.app, publisher: { ...out.app.publisher, id } };
      }
      return out;
    },

    bid(bid) {
      const type = MTYPES[bid.mtype ?? 0];
      if (type == null) return reject(`failed to parse bid mtype (${bid.mtype ?? 0}) for impression id ${bid.impid}`);
      const nat = type === 'native' ? parseJson(bid.adm) : undefined;

      const out = { ...bid };
      if (bid.cat && bid.cat.length > 1) out.cat = [bid.cat[0] ?? ''];
      const native = obj(nat)?.native;
      if (native != null) out.adm = JSON.stringify(native);
      const dp = bid.ext?.prebiddealpriority;
      return {
        bid: out,
        type,
        seat: bid.ext?.marketplace,
        dealPriority: dp !== undefined && dp > 0 ? dp : undefined,
        video: { duration: bid.ext?.video?.duration },
        meta: bid.ext ? { mediaType: bid.ext.ibv ? 'video' : type } : undefined,
        warning: type === 'native' && nat == null ? 'unable to unmarshal native adm' : undefined,
      };
    },

    response(resp) {
      return {
        currency: resp.cur,
        paapi: Object.entries(resp.ext?.fledge_auction_configs ?? {}).map(([impid, config]) => ({ impid, config })),
      };
    },
  },

  client: {
    endpoint: 'https://hbopenbid.pubmatic.com/translator?source=prebid-client',
  },
});

// PROTOTYPE Shared Adapter: OpenX, in restricted TypeScript. Intended behavior per map #1 "What is the
// parity target when Go and Java Hand-written Adapters disagree?" (#8); same as the Definition
// prototype's defs/openx.yaml. Prebid.js runs this file; the transpiler turns it into Rust for the servers.
import { defineAdapter, reject, num, int, str, nonempty, without } from '../core/index.ts';
import type { MediaType } from '../core/index.ts';
import type { Json } from '../core/ortb.ts';
import type { OpenxParams } from './openx.params.ts';

interface OpenxBidExt { dsp_id?: Json; buyer_id?: Json; brand_id?: Json }

const MTYPES: Record<number, MediaType> = { 1: 'banner', 2: 'video', 4: 'native' };
// reported only when positive
const positiveId = (x: Json | undefined) => {
  const n = int(x);
  return n !== undefined && n > 0 ? n : undefined;
};

export default defineAdapter<OpenxParams, OpenxBidExt>({
  bidder: 'openx',
  endpoint: 'https://rtb.openx.net/prebid',
  required: { all: ['unit'], anyOf: [['delDomain'], ['platform']] },

  core: {
    imp(imp, p) {
      if (!imp.banner && !imp.video && !imp.native) {
        return reject(`OpenX only supports banner, video and native imps; ignoring imp ${imp.id}`);
      }
      const out = { ...imp, tagid: str(p.unit) };
      const floor = num(p.customFloor);
      if (!imp.bidfloor && floor !== undefined && floor > 0) out.bidfloor = floor;
      out.ext = nonempty({ ...without(imp.ext, 'prebid', 'bidder'), customParams: p.customParams });
      if (out.video) out.video = { ...out.video, ext: imp.rwdd === 1 ? { rewarded: 1 } : undefined };
      return out;
    },

    request(req, params) {
      return { ...req, ext: { delDomain: params[0]?.delDomain, platform: params[0]?.platform } };
    },

    bid(bid, imp) {
      return {
        type: MTYPES[bid.mtype ?? 0] ?? (imp?.banner ? 'banner' : imp?.video ? 'video' : imp?.native ? 'native' : 'banner'),
        video: { primary_category: bid.cat?.[0], duration: bid.dur },
        meta: nonempty({
          networkId: positiveId(bid.ext?.dsp_id),
          advertiserId: positiveId(bid.ext?.buyer_id),
          brandId: positiveId(bid.ext?.brand_id),
        }),
      };
    },

    response(resp) {
      return {
        currency: resp.cur,
        paapi: Object.entries(resp.ext?.fledge_auction_configs ?? {}).map(([impid, config]) => ({ impid, config })),
      };
    },
  },

  server: {
    request: () => ({ ext: { bc: 'hb_pbs_1.0.0' } }),
  },
  client: {
    endpoint: 'https://rtb.openx.net/openrtbb/prebidjs',
    imp: (imp) => ({ ext: { divid: imp.ext?.prebid?.adunitcode } }),
    request: (req, params) => ({
      ext: { bc: 'hb_pb_ortb_2.0', response_template_name: params[0]?.response_template_name },
      at: 1,
      device: { dnt: 0 },
      regs: { coppa: params[0]?.coppa ? 1 : undefined },
      test: params[0]?.test ? 1 : undefined,
    }),
  },
});

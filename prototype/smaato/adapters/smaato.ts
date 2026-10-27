// PROTOTYPE Shared Adapter: Smaato, in Restricted TypeScript. Intended behavior follows PBS-Go's
// Hand-written Adapter (adapters/smaato) except where defs/known-differences.yaml says otherwise.
// Exercises what OpenX and PubMatic didn't: several outgoing requests (one per imp per media type, or
// one per ad pod on PBS's video endpoint), Host context (entry point, clock, currency), response
// headers, a whole-response reject, and markup rendering.
import { defineAdapter, reject, int, obj, nonempty, without, parseJson, formEncode } from '../core/index.ts';
import type { MediaType } from '../core/index.ts';
import type { Imp, Json } from '../core/ortb.ts';
import type { SmaatoParams } from './smaato.params.ts';

interface SmaatoBidExt { duration?: Json; curls?: Json }

const CLIENT = 'prebid_server_1.3';
const MARKUP: Record<string, MediaType> = { Img: 'banner', Richmedia: 'banner', Video: 'video', Native: 'native' };

// the banner markup, wrapped so a click fires the click trackers
const withClickTrackers = (adm: string, curls: string[]) =>
  curls.length === 0
    ? adm
    : `<div style="cursor:pointer" onclick="${curls.map((c) => `fetch(decodeURIComponent('${formEncode(c)}'.replace(/\\+/g, ' ')), {cache: 'no-cache'});`).join('')}">${adm}</div>`;

const isStringList = (x: Json | undefined) => Array.isArray(x) && x.every((s) => typeof s === 'string');

export default defineAdapter<SmaatoParams, SmaatoBidExt>({
  bidder: 'smaato',
  endpoint: 'https://prebid/bidder',
  required: { all: ['publisherId'], anyOf: [['adspaceId'], ['adbreakId']] },

  core: {
    imp(imp, p, req, host) {
      // floors in USD, through the Host's currency service
      const out = { ...imp };
      const cur = imp.bidfloorcur;
      if (imp.bidfloor !== undefined && imp.bidfloor > 0 && cur && cur.toLowerCase() !== 'usd') {
        const usd = host.convertCurrency(imp.bidfloor, cur, 'USD');
        if (usd === undefined) return reject(`Currency conversion rate not found: '${cur}' => 'USD'`);
        out.bidfloor = usd;
        out.bidfloorcur = 'USD';
      }
      if (host.entryPoint === 'video') {
        // ad pods: grouped by id prefix in `group`, prepared per pod in `request`
        if (!imp.video) return reject('Invalid MediaType. Smaato only supports Video for AdPod.');
        return out;
      }
      if (!imp.banner && !imp.video && !imp.native) return reject('Invalid MediaType. Smaato only supports Banner, Video and Native.');
      // one outgoing imp per media type, each in its own request
      const one = { ...out, ext: nonempty(without(imp.ext, 'bidder')), tagid: p?.adspaceId };
      const split: Imp[] = [];
      return [
        ...(imp.banner ? [{ ...one, video: undefined, native: undefined }] : split),
        ...(imp.video ? [{ ...one, banner: undefined, native: undefined }] : split),
        ...(imp.native ? [{ ...one, banner: undefined, video: undefined }] : split),
      ];
    },

    group(imp, p, host) {
      if (host.entryPoint === 'video') return imp.id.split('_')[0] ?? '';
      return `${imp.id}|${imp.banner ? 'banner' : imp.video ? 'video' : 'native'}`;
    },

    request(req, params, host) {
      // user.ext.data -> user.gender / yob / keywords
      let user = req.user;
      const uext = req.user?.ext;
      if (uext !== undefined && uext !== null && obj(uext) === undefined) return reject('Invalid user.ext.');
      const udata = obj(uext)?.data;
      if (user && udata !== undefined) {
        const d = obj(udata);
        if (udata !== null && (d === undefined || (d.keywords !== undefined && typeof d.keywords !== 'string')
          || (d.gender !== undefined && typeof d.gender !== 'string') || (d.yob !== undefined && int(d.yob) === undefined))) {
          return reject('Invalid user.ext.data.');
        }
        user = {
          ...user,
          gender: (typeof d?.gender === 'string' && d.gender) || user.gender,
          yob: (int(d?.yob) || undefined) ?? user.yob,
          keywords: (typeof d?.keywords === 'string' && d.keywords) || user.keywords,
          ext: without(user.ext, 'data'),
        };
      }
      // site.ext.data.keywords -> site.keywords
      let site = req.site;
      if (site && site.ext !== undefined) {
        const se = site.ext === null ? {} : obj(site.ext);
        const data = se === undefined ? undefined : se.data === undefined || se.data === null ? {} : obj(se.data);
        if (se === undefined || data === undefined || (data.keywords !== undefined && data.keywords !== null && typeof data.keywords !== 'string')) {
          return reject('Invalid site.ext.');
        }
        site = { ...site, keywords: (typeof data.keywords === 'string' && data.keywords) || undefined, ext: undefined };
      }

      const pub = params[0]?.publisherId;
      if (typeof pub !== 'string') return reject('Missing publisherId parameter.');
      const publisher = { id: pub };
      const base = { ...req, user, ext: { client: CLIENT } };
      const out = site ? { ...base, site: { ...site, publisher } }
        : req.app ? { ...base, site, app: { ...req.app, publisher } }
        : req.dooh ? { ...base, site, dooh: { ...req.dooh, publisher } }
        : undefined;
      if (out === undefined) return reject('Missing Site/App/DOOH.');

      if (host.entryPoint !== 'video') {
        if (typeof params[0]?.adspaceId !== 'string') return reject('Missing adspaceId parameter.');
        return out;
      }
      const adbreak = params[0]?.adbreakId;
      if (typeof adbreak !== 'string') return reject('Missing adbreakId parameter.');
      return {
        ...out,
        imp: req.imp.map((imp, i) => ({
          ...imp,
          tagid: adbreak,
          ext: i === 0 ? nonempty(without(imp.ext, 'bidder')) : undefined,
          video: { ...imp.video, sequence: i + 1, ext: { context: 'adpod' } },
        })),
      };
    },

    response(resp, http) {
      if (!http.header('X-Smt-Adtype')) return reject('X-Smt-Adtype header is missing.');
      return {};
    },

    bid(bid, imp, resp, http, host) {
      const adtype = http.header('X-Smt-Adtype') ?? '';
      const ext = bid.ext;
      if (ext !== undefined && ext !== null && (obj(ext) === undefined
        || (ext.duration !== undefined && ext.duration !== null && int(ext.duration) === undefined)
        || (ext.curls !== undefined && ext.curls !== null && !isStringList(ext.curls)))) {
        return reject('Invalid bid.ext.');
      }
      const curls: string[] = [];
      const clicks = isStringList(ext?.curls) ? (ext?.curls as string[]) : curls;
      const adm = bid.adm ?? '';
      const type = MARKUP[adtype];
      if (type === undefined) return reject(`Unknown markup type ${adtype}.`);
      let markup = adm;
      if (type === 'banner') markup = withClickTrackers(adm, clicks);
      if (type === 'native') {
        const nat = obj(parseJson(adm));
        if (nat === undefined) return reject(`Invalid ad markup ${adm}.`);
        markup = JSON.stringify(nat.native ?? null);
      }

      // ttl: X-Smt-Expires (epoch ms) minus now, in whole seconds; 300 without the header
      const expires = int(http.header('X-Smt-Expires'));
      let exp = 300;
      if (expires !== undefined) {
        const left = expires - host.now();
        exp = left < 0 ? 0 : (left - (left % 1000)) / 1000;
      }
      return {
        bid: { ...bid, adm: markup, exp },
        type,
        video: type === 'video' ? { duration: int(ext?.duration) ?? 0, primary_category: bid.cat?.[0] ?? '' } : undefined,
      };
    },
  },
});

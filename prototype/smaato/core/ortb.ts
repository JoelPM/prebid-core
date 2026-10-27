// PROTOTYPE Prebid Core types: the OpenRTB 2.6 fields and Prebid `ext` fields Shared Adapters may read.
// Only what OpenX and PubMatic touch is typed; anything else open-ended is `Json`, which authors
// narrow with typeof / Array.isArray / Core helpers. No `any` reaches an Adapter.
export type Json = string | number | boolean | null | Json[] | JsonObject;
export type JsonObject = { [k: string]: Json };

export interface Format { w?: number; h?: number }
export interface Banner { w?: number; h?: number; format?: Format[]; ext?: JsonObject }
export interface Video { ext?: JsonObject; [k: string]: unknown }
export interface Native { request?: string; ver?: string; ext?: JsonObject }
export interface Imp {
  id: string;
  banner?: Banner;
  video?: Video;
  audio?: JsonObject;
  native?: Native;
  tagid?: string;
  bidfloor?: number;
  bidfloorcur?: string;
  rwdd?: number;
  displaymanager?: string;
  displaymanagerver?: string;
  ext?: ImpExt;
}
export interface ImpExt {
  bidder?: unknown; // the Adapter sees it typed, as its params
  prebid?: { adunitcode?: string; [k: string]: unknown };
  data?: JsonObject;
  gpid?: string;
  ae?: number;
  skadn?: Json;
  [k: string]: unknown;
}
export interface Publisher { id?: string; [k: string]: unknown }
export interface Site { publisher?: Publisher; keywords?: string; ext?: Json; [k: string]: unknown }
export interface User { gender?: string; yob?: number; keywords?: string; ext?: { [k: string]: unknown }; [k: string]: unknown }
export interface Dooh { publisher?: Publisher; [k: string]: unknown }
export interface App {
  publisher?: Publisher;
  ext?: { source?: string; version?: string; prebid?: { source?: string; version?: string; [k: string]: unknown }; [k: string]: unknown };
  [k: string]: unknown;
}
export interface AlternateBidderCodes {
  enabled?: boolean;
  bidders?: { [bidder: string]: { enabled?: boolean; allowedbiddercodes?: string[] } };
}
export interface RequestExt {
  prebid?: {
    bidderparams?: { [k: string]: Json };
    alternatebiddercodes?: AlternateBidderCodes;
    aliases?: { [alias: string]: string };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
export interface BidRequest {
  id: string;
  imp: Imp[];
  site?: Site;
  app?: App;
  dooh?: Dooh;
  user?: User;
  device?: { dnt?: number; [k: string]: unknown };
  regs?: { coppa?: number; [k: string]: unknown };
  at?: number;
  test?: number;
  ext?: RequestExt;
  [k: string]: unknown;
}

export interface Bid<BidExt = JsonObject> {
  id: string;
  impid: string;
  price: number;
  adm?: string;
  cat?: string[];
  dur?: number;
  mtype?: number;
  exp?: number;
  ext?: BidExt;
  [k: string]: unknown;
}
export interface BidResponse<BidExt = JsonObject> {
  id?: string;
  cur?: string;
  seatbid?: { seat?: string; bid?: Bid<BidExt>[] }[];
  ext?: { fledge_auction_configs?: { [impid: string]: Json }; [k: string]: unknown };
}

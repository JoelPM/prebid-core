// PROTOTYPE: hand-written from defs/pubmatic.params.json (Prebid Core would generate it).
export interface PubmaticParams {
  publisherId: string;
  adSlot?: string;
  pmzoneid?: string;
  kadfloor?: string;
  dctr?: string;
  acat?: string[];
  wrapper?: { profile: number; version?: number };
  keywords?: { key: string; value: string[] }[];
}

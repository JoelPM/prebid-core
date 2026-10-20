// PROTOTYPE: hand-written from defs/openx.params.json (Prebid Core would generate it), plus the
// Prebid.js-only params the Client Extension reads.
import type { JsonObject } from '../core/ortb.ts';

export interface OpenxParams {
  unit: number | string;
  delDomain?: string;
  platform?: string;
  customFloor?: number | string;
  customParams?: JsonObject;
  // Prebid.js only
  coppa?: boolean;
  test?: boolean;
  response_template_name?: string;
}

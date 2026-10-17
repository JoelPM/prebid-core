// modules/openxSharedBidAdapter.js - per-Adapter cost in Prebid.js under Form A.
// Translation lives in wasm; what stays JS is spec metadata plus getUserSyncs (out of the
// Shared Adapter's scope per map #1), copied verbatim from openxBidAdapter.js.
import { BANNER, NATIVE, VIDEO } from '../src/mediaTypes.js';
import { registerSharedAdapter } from '../libraries/sharedAdapter/sharedAdapter.js';
__LOGIC_IMPORT__

export const SYNC_URL = 'https://u.openx.net/w/1.0/pd';
export const DEFAULT_PH = '2d1251ae-7f3a-47cf-bd2a-2f288854a0ba';

__LOGIC__

registerSharedAdapter({
  code: 'openx',
  gvlid: 69,
  supportedMediaTypes: [BANNER, VIDEO, NATIVE],
  url: 'https://rtb.openx.net/openrtbb/prebidjs',
  getUserSyncs
}, LOAD, { nativeRequest: { eventtrackers: [{ event: 1, methods: [1, 2] }] } });

function getUserSyncs(syncOptions, responses, gdprConsent, uspConsent, gppConsent) {
  if (syncOptions.iframeEnabled || syncOptions.pixelEnabled) {
    const pixelType = syncOptions.iframeEnabled ? 'iframe' : 'image';
    const queryParamStrings = [];
    let syncUrl = SYNC_URL;
    if (gdprConsent) {
      queryParamStrings.push('gdpr=' + (gdprConsent.gdprApplies ? 1 : 0));
      queryParamStrings.push('gdpr_consent=' + encodeURIComponent(gdprConsent.consentString || ''));
    }
    if (uspConsent) {
      queryParamStrings.push('us_privacy=' + encodeURIComponent(uspConsent));
    }
    if (gppConsent?.gppString && gppConsent?.applicableSections?.length) {
      queryParamStrings.push('gpp=' + encodeURIComponent(gppConsent.gppString));
      queryParamStrings.push('gpp_sid=' + gppConsent.applicableSections.join(','));
    }
    if (responses.length > 0 && responses[0].body && responses[0].body.ext) {
      const ext = responses[0].body.ext;
      if (ext.delDomain) {
        syncUrl = `https://${ext.delDomain}/w/1.0/pd`;
      } else if (ext.platform) {
        queryParamStrings.push('ph=' + ext.platform);
      }
    } else {
      queryParamStrings.push('ph=' + DEFAULT_PH);
    }
    return [{
      type: pixelType,
      url: `${syncUrl}${queryParamStrings.length > 0 ? '?' + queryParamStrings.join('&') : ''}`
    }];
  }
}

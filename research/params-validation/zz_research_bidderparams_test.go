package openrtb2

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/adapters"
	"github.com/prebid/prebid-server/v4/adapters/pubmatic"
	"github.com/prebid/prebid-server/v4/config"
	"github.com/prebid/prebid-server/v4/openrtb_ext"
	"github.com/prebid/prebid-server/v4/ortb"
	"github.com/prebid/prebid-server/v4/util/ptrutil"
)

// Request-level ext.prebid.bidderparams is merged into an imp only for keys the imp lacks, and only
// the merged imp params are schema-validated; the raw request-level copy still reaches the Adapter.
func TestZZResearchBidderParams(t *testing.T) {
	pv, err := openrtb_ext.NewBidderParamsValidator("../../static/bidder-params")
	if err != nil {
		t.Fatal(err)
	}
	rv := ortb.NewRequestValidator(openrtb_ext.BuildBidderMap(), map[string]string{}, pv)
	for _, impParams := range []string{
		`{"publisherId":"156209"}`,
		`{"publisherId":"156209","wrapper":{"profile":1}}`,
	} {
		reqExt := `{"prebid":{"bidderparams":{"pubmatic":{"wrapper":{"profile":"5"}}}}}`
		req := &openrtb_ext.RequestWrapper{BidRequest: &openrtb2.BidRequest{
			ID:  "r",
			Ext: json.RawMessage(reqExt),
			Imp: []openrtb2.Imp{{ID: "i", Banner: &openrtb2.Banner{W: ptrutil.ToPtr(int64(300)), H: ptrutil.ToPtr(int64(250))},
				Ext: json.RawMessage(`{"prebid":{"bidder":{"pubmatic":` + impParams + `}}}`)}},
		}}
		if err := mergeBidderParams(req); err != nil {
			t.Fatal(err)
		}
		errs := rv.ValidateImp(req.GetImp()[0], ortb.ValidationConfig{}, 0, map[string]string{}, false, nil)
		req.RebuildRequest()
		fmt.Printf("imp params %s\n  after merge imp.ext=%s\n  validation errs=%v\n", impParams, req.Imp[0].Ext, errs)
	}

	// What the PubMatic Adapter does with the raw request-level copy (exchange passes ext.prebid.bidderparams.<bidder>).
	bidder, _ := pubmatic.Builder(openrtb_ext.BidderPubmatic, config.Adapter{Endpoint: "https://hbopenbid.pubmatic.com/translator?source=prebid-server"}, config.Server{})
	adReq := &openrtb2.BidRequest{ID: "r", Ext: json.RawMessage(`{"prebid":{"bidderparams":{"wrapper":{"profile":"5"}}}}`),
		Imp: []openrtb2.Imp{{ID: "i", Banner: &openrtb2.Banner{W: ptrutil.ToPtr(int64(300)), H: ptrutil.ToPtr(int64(250))},
			Ext: json.RawMessage(`{"bidder":{"publisherId":"156209","wrapper":{"profile":1}}}`)}}}
	reqs, errs := bidder.MakeRequests(adReq, &adapters.ExtraRequestInfo{})
	fmt.Printf("PubMatic MakeRequests: %d requests, errs=%v\n", len(reqs), errs)
}

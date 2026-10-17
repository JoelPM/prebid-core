// gen writes the two payloads every host benchmarks, as <name>-req.json (the per-bidder request
// the exchange hands OpenX, as PBS-Go would serialize it), <name>-resp.json (the bidder's reply)
// and <name>-mb.bin (MakeBids guest input: imp table + response, for the native Rust timing).
//
//	lt:    #11's load-test auction (payload/auction-10.json, 3 banner imps), transformed the way
//	       #11's adapter bench does it, with #11's stub response (3 bids, ~1.4 KB adm each).
//	heavy: #3's payload (4 imps incl. rewarded video, 5 EIDs; 4 bids with ~1.5 KB adm).
//
// Usage: go run ./gen payload <#3 heavy dir with req.json/resp.json>
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/adapters"
	"github.com/prebid/prebid-server/v4/util/jsonutil"

	"tbench/tb"
)

var adm = "<div>" + strings.Repeat("<script src=\"https://cdn.example.com/creative.js?x=0123456789\"></script>", 18) + "</div>"

// stubResponse mirrors #11's stub/main.go: one banner bid per imp in the outgoing request.
func stubResponse(body []byte) []byte {
	var q struct {
		ID  string `json:"id"`
		Imp []struct {
			ID     string `json:"id"`
			Banner *struct {
				Format []struct{ W, H int } `json:"format"`
			} `json:"banner"`
		} `json:"imp"`
	}
	must(json.Unmarshal(body, &q))
	bids := []map[string]any{}
	for i, im := range q.Imp {
		w, h := 300, 250
		if im.Banner != nil && len(im.Banner.Format) > 0 {
			w, h = im.Banner.Format[0].W, im.Banner.Format[0].H
		}
		bids = append(bids, map[string]any{"id": fmt.Sprintf("b%d", i), "impid": im.ID, "price": 0.5 + float64(i)*0.1, "adm": adm,
			"adid": "ad1", "adomain": []string{"advertiser.com"}, "crid": "cr1", "cid": "c1", "w": w, "h": h, "mtype": 1,
			"ext": map[string]any{"appnexus": map[string]any{"bid_ad_type": 0}, "prebid": map[string]any{"type": "banner"},
				"BidType": 0, "mediaType": "banner", "format": "banner"}})
	}
	out, _ := json.Marshal(map[string]any{"id": q.ID, "cur": "USD", "seatbid": []map[string]any{{"seat": "seat1", "bid": bids}}})
	return out
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func write(dir, name string, req *openrtb2.BidRequest, resp []byte) {
	rj, err := jsonutil.Marshal(req)
	must(err)
	must(os.WriteFile(filepath.Join(dir, name+"-req.json"), rj, 0o644))
	must(os.WriteFile(filepath.Join(dir, name+"-resp.json"), resp, 0o644))
	must(os.WriteFile(filepath.Join(dir, name+"-mb.bin"), append(tb.ImpTable(nil, req.Imp), resp...), 0o644))
	fmt.Printf("%s: req %d B, resp %d B\n", name, len(rj), len(resp))
}

func main() {
	dir := os.Args[1]

	// lt: #11 adapterbench's bidderRequest(): imp.ext = {"bidder": <openx params>}, no request ext.
	raw, err := os.ReadFile(filepath.Join(dir, "auction-10.json"))
	must(err)
	var req openrtb2.BidRequest
	must(json.Unmarshal(raw, &req))
	for i := range req.Imp {
		var ext struct {
			Prebid struct {
				Bidder map[string]json.RawMessage `json:"bidder"`
			} `json:"prebid"`
		}
		must(json.Unmarshal(req.Imp[i].Ext, &ext))
		req.Imp[i].Ext, _ = json.Marshal(map[string]json.RawMessage{"bidder": ext.Prebid.Bidder["openx"]})
	}
	req.Ext = nil
	reqs, errs := tb.Bidder.MakeRequests(&req, &adapters.ExtraRequestInfo{})
	if len(errs) > 0 {
		panic(errs)
	}
	write(dir, "lt", &req, stubResponse(reqs[0].Body))

	// heavy: #3's generator output, round-tripped through openrtb2 so it is what PBS-Go would send.
	raw, err = os.ReadFile(filepath.Join(os.Args[2], "req.json"))
	must(err)
	var hreq openrtb2.BidRequest
	must(json.Unmarshal(raw, &hreq))
	resp, err := os.ReadFile(filepath.Join(os.Args[2], "resp.json"))
	must(err)
	write(dir, "heavy", &hreq, resp)
}

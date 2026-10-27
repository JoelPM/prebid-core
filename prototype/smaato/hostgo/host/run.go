// Package host is the PROTOTYPE PBS-Go Host binding for Shared Adapters, plus the helpers that run an
// adapters.Bidder over an adapterstest fixture and normalize its full output for differential checks.
package host

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/adapters"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
)

// Spec is the subset of an adapterstest fixture this prototype reads.
type Spec struct {
	BidRequest openrtb2.BidRequest `json:"mockBidRequest"`
	HttpCalls  []struct {
		Request struct {
			Body   json.RawMessage `json:"body"`
			Uri    string          `json:"uri"`
			ImpIDs []string        `json:"impIDs"`
		} `json:"expectedRequest"`
		Response struct {
			Status int             `json:"status"`
			Body   json.RawMessage `json:"body"`
		} `json:"mockResponse"`
	} `json:"httpCalls"`
}

func LoadSpec(path string) (*Spec, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s Spec
	return &s, json.Unmarshal(b, &s)
}

// Result is a Bidder's complete output on one fixture: more than adapterstest compares (meta,
// deal priority and the order-insensitive parts are included).
type Result struct {
	Requests    []Req      `json:"requests"`
	RequestErrs []string   `json:"requestErrs"`
	Responses   []BidsResp `json:"responses"`
}
type Req struct {
	Method string          `json:"method"`
	Uri    string          `json:"uri"`
	Body   json.RawMessage `json:"body"`
	ImpIDs []string        `json:"impIDs"`
}
type BidsResp struct {
	Currency string          `json:"currency"`
	Bids     []Bid           `json:"bids"`
	Paapi    json.RawMessage `json:"paapi"`
	Errs     []string        `json:"errs"`
}
type Bid struct {
	Bid          *openrtb2.Bid `json:"bid"`
	Type         string        `json:"type"`
	Seat         string        `json:"seat,omitempty"`
	DealPriority int           `json:"dealPriority,omitempty"`
	Video        any           `json:"video,omitempty"`
	Meta         any           `json:"meta,omitempty"`
}

func errStrings(errs []error) []string {
	out := []string{}
	for _, e := range errs {
		out = append(out, e.Error())
	}
	return out
}

// Run drives a Bidder the way adapterstest does: MakeRequests on the fixture's request, then MakeBids
// once per expected HTTP call with the fixture's own request and mock response.
func Run(b adapters.Bidder, spec *Spec) Result {
	req := spec.BidRequest // shallow: like the exchange, adapters get their own top-level copy
	req.Imp = append([]openrtb2.Imp(nil), spec.BidRequest.Imp...)
	rs, errs := b.MakeRequests(&req, &adapters.ExtraRequestInfo{})
	res := Result{RequestErrs: errStrings(errs), Requests: []Req{}, Responses: []BidsResp{}}
	for _, r := range rs {
		res.Requests = append(res.Requests, Req{Method: r.Method, Uri: r.Uri, Body: r.Body, ImpIDs: r.ImpIDs})
	}
	for _, c := range spec.HttpCalls {
		rd := &adapters.RequestData{Method: "POST", Uri: c.Request.Uri, Body: c.Request.Body, ImpIDs: c.Request.ImpIDs}
		resp := &adapters.ResponseData{StatusCode: c.Response.Status, Body: c.Response.Body, Headers: http.Header{}}
		br, errs := b.MakeBids(&spec.BidRequest, rd, resp)
		out := BidsResp{Errs: errStrings(errs), Bids: []Bid{}}
		if br != nil {
			out.Currency = br.Currency
			for _, tb := range br.Bids {
				bid := Bid{Bid: tb.Bid, Type: string(tb.BidType), Seat: string(tb.Seat), DealPriority: tb.DealPriority}
				if tb.BidVideo != nil {
					bid.Video = tb.BidVideo
				}
				if tb.BidMeta != nil {
					bid.Meta = tb.BidMeta
				}
				out.Bids = append(out.Bids, bid)
			}
			if br.FledgeAuctionConfigs != nil {
				out.Paapi, _ = jsonutil.Marshal(br.FledgeAuctionConfigs)
			}
		}
		res.Responses = append(res.Responses, out)
	}
	return res
}

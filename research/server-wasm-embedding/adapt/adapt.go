// Package adapt runs (a verbatim copy of) the PBS-Go OpenX adapter: MakeRequests then MakeBids.
package adapt

import (
	"encoding/json"

	"bench/oxport"
	"bench/oxport/adapters"
	"github.com/prebid/openrtb/v20/openrtb2"
)

var bidder = oxport.New()

type out struct {
	Body json.RawMessage      `json:"body"`
	Bids []*adapters.TypedBid `json:"bids"`
	Cur  string               `json:"cur"`
}

func Run(reqJSON, respJSON []byte) []byte {
	var req openrtb2.BidRequest
	if err := json.Unmarshal(reqJSON, &req); err != nil {
		panic(err)
	}
	reqs, errs := bidder.MakeRequests(&req, &adapters.ExtraRequestInfo{})
	if len(errs) > 0 || len(reqs) != 1 {
		panic(errs)
	}
	br, errs := bidder.MakeBids(&req, reqs[0], &adapters.ResponseData{StatusCode: 200, Body: respJSON})
	if len(errs) > 0 {
		panic(errs)
	}
	b, _ := json.Marshal(out{Body: reqs[0].Body, Bids: br.Bids, Cur: br.Currency})
	return b
}

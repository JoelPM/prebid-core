// Package adapters is a minimal stand-in for PBS-Go's adapters package (which imports
// config -> viper and does not build for wasip1). Types copied verbatim.
package adapters

import (
	"encoding/json"
	"net/http"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/openrtb_ext"
)

type BidderResponse struct {
	Currency             string
	Bids                 []*TypedBid
	FledgeAuctionConfigs []*openrtb_ext.FledgeAuctionConfig
}

func NewBidderResponseWithBidsCapacity(n int) *BidderResponse {
	return &BidderResponse{Currency: "USD", Bids: make([]*TypedBid, 0, n)}
}

type TypedBid struct {
	Bid          *openrtb2.Bid
	BidMeta      *openrtb_ext.ExtBidPrebidMeta
	BidType      openrtb_ext.BidType
	BidVideo     *openrtb_ext.ExtBidPrebidVideo
	DealPriority int
	Seat         openrtb_ext.BidderName
}
type ResponseData struct {
	StatusCode int
	Body       []byte
	Headers    http.Header
}
type RequestData struct {
	Method  string
	Uri     string
	Body    []byte
	Headers http.Header
	ImpIDs  []string
}
type ExtImpBidder struct {
	Prebid             *openrtb_ext.ExtImpPrebid           `json:"prebid"`
	Bidder             json.RawMessage                     `json:"bidder"`
	AuctionEnvironment openrtb_ext.AuctionEnvironmentType `json:"ae,omitempty"`
}
type ExtraRequestInfo struct{}

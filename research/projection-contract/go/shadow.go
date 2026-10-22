package main

// A third projection source for PBS-Go, tried here because neither of #24's two is both exact and
// cheap: decode the response ONCE into a "shadow" of openrtb2.BidResponse whose typed fields on the
// Adapter's read paths are json.RawMessage (presence, null and the bidder's own text kept), then fill
// the real openrtb2 fields from them for the Host's own use. encoding/json's shadowing rule (the
// shallower field wins) makes the outer RawMessage field take the member; jsoniter follows it.
// Hand-written here for OpenX's read paths (plus PubMatic's adm); a Host would build these types per Adapter from the
// declared shapes (generated Go, or reflect.StructOf at load).

import (
	"encoding/json"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
)

type shadowBid struct {
	openrtb2.Bid
	MType json.RawMessage `json:"mtype,omitempty"`
	Cat   json.RawMessage `json:"cat,omitempty"`
	Dur   json.RawMessage `json:"dur,omitempty"`
	ImpID json.RawMessage `json:"impid,omitempty"`
	AdM   json.RawMessage `json:"adm,omitempty"` // PubMatic's read; not needed for OpenX
}
type shadowSeatBid struct {
	openrtb2.SeatBid
	Bid []shadowBid `json:"bid"`
}
type shadowResp struct {
	openrtb2.BidResponse
	SeatBid []shadowSeatBid `json:"seatbid,omitempty"`
	Cur     json.RawMessage `json:"cur,omitempty"`
}

// shadowParse decodes body into br (the Host's model, as jsonutil.Unmarshal would) and returns the
// shadow, which keeps the read paths' own text.
func shadowParse(body []byte, br *openrtb2.BidResponse) (*shadowResp, error) {
	var s shadowResp
	if err := jsonutil.Unmarshal(body, &s); err != nil {
		return nil, err
	}
	*br = s.BidResponse
	if s.Cur != nil {
		jsonutil.Unmarshal(s.Cur, &br.Cur)
	}
	if s.SeatBid != nil {
		br.SeatBid = make([]openrtb2.SeatBid, len(s.SeatBid))
	}
	for i := range s.SeatBid {
		sb := &s.SeatBid[i]
		br.SeatBid[i] = sb.SeatBid
		if sb.Bid != nil {
			br.SeatBid[i].Bid = make([]openrtb2.Bid, len(sb.Bid))
		}
		for j := range sb.Bid {
			b := &sb.Bid[j]
			out := &br.SeatBid[i].Bid[j]
			*out = b.Bid
			if b.MType != nil {
				if err := jsonutil.Unmarshal(b.MType, &out.MType); err != nil {
					return nil, err
				}
			}
			if b.Dur != nil {
				if err := jsonutil.Unmarshal(b.Dur, &out.Dur); err != nil {
					return nil, err
				}
			}
			if b.Cat != nil {
				if err := jsonutil.Unmarshal(b.Cat, &out.Cat); err != nil {
					return nil, err
				}
			}
			if b.ImpID != nil {
				if err := jsonutil.Unmarshal(b.ImpID, &out.ImpID); err != nil {
					return nil, err
				}
			}
			if b.AdM != nil {
				if err := jsonutil.Unmarshal(b.AdM, &out.AdM); err != nil {
					return nil, err
				}
			}
		}
	}
	return &s, nil
}

// appendShadow writes OpenX's response projection from the shadow: RawMessage members as received
// (absent stays absent, null stays null), ext members by the reflective projector.
func appendShadow(buf []byte, s *shadowResp, p *Projector) []byte {
	raw := func(buf []byte, first *bool, name string, v json.RawMessage) []byte {
		if v == nil {
			return buf
		}
		if !*first {
			buf = append(buf, ',')
		}
		*first = false
		buf = append(buf, '"')
		buf = append(buf, name...)
		buf = append(buf, '"', ':')
		return append(buf, v...)
	}
	buf = append(buf, '{')
	top := true
	if s.SeatBid != nil {
		top = false
		buf = append(buf, `"seatbid":[`...)
		for i := range s.SeatBid {
			if i > 0 {
				buf = append(buf, ',')
			}
			buf = append(buf, `{"bid":`...)
			if s.SeatBid[i].Bid == nil {
				buf = append(buf, "null"...)
			} else {
				buf = append(buf, '[')
				for j := range s.SeatBid[i].Bid {
					b := &s.SeatBid[i].Bid[j]
					if j > 0 {
						buf = append(buf, ',')
					}
					buf = append(buf, '{')
					first := true
					buf = raw(buf, &first, "mtype", b.MType)
					buf = raw(buf, &first, "cat", b.Cat)
					buf = raw(buf, &first, "dur", b.Dur)
					buf = raw(buf, &first, "impid", b.ImpID)
					buf = raw(buf, &first, "adm", b.AdM)
					buf = raw(buf, &first, "ext", b.Ext)
					buf = append(buf, '}')
				}
				buf = append(buf, ']')
			}
			buf = append(buf, '}')
		}
		buf = append(buf, ']')
	}
	buf = raw(buf, &top, "cur", s.Cur)
	buf = raw(buf, &top, "ext", s.Ext)
	return append(buf, '}')
}

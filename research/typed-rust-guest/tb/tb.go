// Package tb holds what the generator and the Go host share: the real PBS-Go OpenX Adapter, the
// payload loader and the MakeBids imp-table encoding.
package tb

import (
	"encoding/binary"
	"net/http"
	"os"
	"path/filepath"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/adapters"
	"github.com/prebid/prebid-server/v4/adapters/openx"
	"github.com/prebid/prebid-server/v4/config"
	"github.com/prebid/prebid-server/v4/openrtb_ext"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
)

var Bidder = func() adapters.Bidder {
	b, err := openx.Builder(openrtb_ext.BidderOpenx, config.Adapter{Endpoint: "http://127.0.0.1:9000/openx"}, config.Server{ExternalUrl: "http://pbs.example.com", GvlID: 1, DataCenter: "2"})
	if err != nil {
		panic(err)
	}
	return b
}()

// Native runs the Hand-written Adapter exactly as PBS-Go's exchange does: MakeRequests, then
// MakeBids on the (pre-recorded) bidder response.
func Native(req *openrtb2.BidRequest, resp []byte) (*adapters.RequestData, *adapters.BidderResponse) {
	reqs, errs := Bidder.MakeRequests(req, &adapters.ExtraRequestInfo{})
	if len(errs) > 0 || len(reqs) != 1 {
		panic(errs)
	}
	br, errs := Bidder.MakeBids(req, reqs[0], &adapters.ResponseData{StatusCode: 200, Body: resp, Headers: http.Header{}})
	if len(errs) > 0 {
		panic(errs)
	}
	return reqs[0], br
}

// ImpTable encodes MakeBids' imp lookup: u32 n, then n × (u8 media bits, u16 len, id).
func ImpTable(dst []byte, imps []openrtb2.Imp) []byte {
	dst = binary.LittleEndian.AppendUint32(dst[:0], uint32(len(imps)))
	for _, imp := range imps {
		var m byte
		if imp.Banner != nil {
			m |= 1
		}
		if imp.Video != nil {
			m |= 2
		}
		if imp.Native != nil {
			m |= 4
		}
		dst = append(dst, m)
		dst = binary.LittleEndian.AppendUint16(dst, uint16(len(imp.ID)))
		dst = append(dst, imp.ID...)
	}
	return dst
}

type Payload struct {
	Name string
	Req  *openrtb2.BidRequest // what the exchange hands the OpenX Adapter
	Resp []byte               // the bidder's HTTP response body
}

func Load(dir, name string) Payload {
	raw, err := os.ReadFile(filepath.Join(dir, name+"-req.json"))
	if err != nil {
		panic(err)
	}
	var req openrtb2.BidRequest
	if err := jsonutil.Unmarshal(raw, &req); err != nil {
		panic(err)
	}
	resp, err := os.ReadFile(filepath.Join(dir, name+"-resp.json"))
	if err != nil {
		panic(err)
	}
	return Payload{name, &req, resp}
}

// golden writes, for every OpenX, PubMatic and Smaato adapterstest fixture, the request exactly as PBS-Go would
// hand it to an Adapter (jsonutil-marshaled, so Go's omitempty applies) and the Hand-written Adapter's
// full output. The TS parity harness diffs the generated TS against both.
//
// Usage: go run ./cmd/golden <prebid-server checkout> <out dir>
package main

import (
	"encoding/json"
	"os"
	"reflect"
	"time"
	"unsafe"
	"path/filepath"
	"strings"

	"github.com/prebid/prebid-server/v4/adapters"
	"github.com/prebid/prebid-server/v4/adapters/openx"
	"github.com/prebid/prebid-server/v4/adapters/pubmatic"
	"github.com/prebid/prebid-server/v4/adapters/smaato"
	"github.com/prebid/prebid-server/v4/config"
	"github.com/prebid/prebid-server/v4/openrtb_ext"
	"github.com/prebid/prebid-server/v4/util/jsonutil"

	"sharedhost/host"
)

func main() {
	pbs, out := os.Args[1], os.Args[2]
	bidders := map[string]adapters.Bidder{}
	bidders["openx"], _ = openx.Builder(openrtb_ext.BidderOpenx, config.Adapter{Endpoint: "http://rtb.openx.net/prebid"}, config.Server{})
	bidders["pubmatic"], _ = pubmatic.Builder(openrtb_ext.BidderPubmatic, config.Adapter{Endpoint: "https://hbopenbid.pubmatic.com/translator?source=prebid-server"}, config.Server{})
	bidders["smaato"], _ = smaato.Builder(openrtb_ext.BidderSmaato, config.Adapter{Endpoint: "https://prebid/bidder"}, config.Server{ExternalUrl: "http://hosturl.com", GvlID: 1, DataCenter: "2"})
	// smaato_test.go's fixed clock (the field is unexported; set it the way the test's package can)
	cv := reflect.ValueOf(bidders["smaato"]).Elem().FieldByName("clock")
	reflect.NewAt(cv.Type(), unsafe.Pointer(cv.UnsafeAddr())).Elem().Set(reflect.ValueOf(fixedClock{time.Date(2021, 6, 25, 10, 0, 0, 0, time.UTC)}))
	for name, b := range bidders {
		root := filepath.Join(pbs, "adapters", name, name+"test")
		filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(p, ".json") {
				return err
			}
			spec, err := host.LoadSpec(p)
			if err != nil {
				panic(err)
			}
			hostReq, _ := jsonutil.Marshal(&spec.BidRequest)
			rel, _ := filepath.Rel(root, p)
			res := host.RunWith(b, spec, host.ReqInfo(spec, rel))
			dst := filepath.Join(out, name, rel)
			os.MkdirAll(filepath.Dir(dst), 0o755)
			j, _ := json.MarshalIndent(map[string]any{"hostRequest": json.RawMessage(hostReq), "native": res}, "", " ")
			return os.WriteFile(dst, j, 0o644)
		})
	}
}

type fixedClock struct{ t time.Time }

func (c fixedClock) Now() time.Time { return c.t }

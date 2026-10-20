// dumppayload writes what the guest sees per call (Host-marshalled request; the outgoing body and
// the bid response for MakeBids), so guest/src/bin/native.rs can time the generated code natively.
package main

import (
	"os"
	"path/filepath"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/adapters"
	"github.com/prebid/prebid-server/v4/adapters/openx"
	"github.com/prebid/prebid-server/v4/adapters/pubmatic"
	"github.com/prebid/prebid-server/v4/config"
	"github.com/prebid/prebid-server/v4/openrtb_ext"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
	"encoding/json"
	"fmt"
)

func main() {
	in, out := os.Args[1], os.Args[2]
	nat := map[string]adapters.Bidder{}
	nat["openx"], _ = openx.Builder(openrtb_ext.BidderOpenx, config.Adapter{Endpoint: "x"}, config.Server{})
	nat["pubmatic"], _ = pubmatic.Builder(openrtb_ext.BidderPubmatic, config.Adapter{Endpoint: "x"}, config.Server{})
	for _, b := range []string{"openx", "pubmatic"} {
		for _, name := range []string{"lt", "heavy"} {
			var req openrtb2.BidRequest
			raw, _ := os.ReadFile(filepath.Join(in, name+"-req.json"))
			jsonutil.Unmarshal(raw, &req)
			if b == "pubmatic" {
				for i := range req.Imp {
					var ext map[string]json.RawMessage
					json.Unmarshal(req.Imp[i].Ext, &ext)
					ext["bidder"] = json.RawMessage(fmt.Sprintf(`{"publisherId":" 156209 ","adSlot":"slot-%d@300x250","wrapper":{"profile":5123,"version":1},"keywords":[{"key":"pmZoneID","value":["zone1","zone2"]}],"kadfloor":"0.1"}`, i))
					req.Imp[i].Ext, _ = json.Marshal(ext)
				}
			}
			body, _ := jsonutil.Marshal(&req)
			rds, _ := nat[b].MakeRequests(&req, nil)
			resp, _ := os.ReadFile(filepath.Join(in, name+"-resp.json"))
			os.WriteFile(filepath.Join(out, b+"-"+name+"-req.json"), body, 0o644)
			os.WriteFile(filepath.Join(out, b+"-"+name+"-out.json"), rds[0].Body, 0o644)
			os.WriteFile(filepath.Join(out, b+"-"+name+"-resp.json"), resp, 0o644)
		}
	}
}

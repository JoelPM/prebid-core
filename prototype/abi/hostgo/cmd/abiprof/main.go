// PROTOTYPE (ABI, #24): CPU profile of the Host side of one ABI stage on the bench payloads.
// Usage: ABI_STAGE=2 [ABI_PROJ=raw] go run ./cmd/abiprof <dir with <bidder>.wasm> <bidder> <payload dir> <mr|mb> <out.pprof>
package main

import (
	"os"
	"path/filepath"
	"runtime/pprof"
	"time"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/adapters"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
	"sharedhost/host"
)

func main() {
	wasm, _ := os.ReadFile(filepath.Join(os.Args[1], os.Args[2]+".wasm"))
	rt, _ := host.NewRuntime(wasm)
	s := rt.Bidder(os.Args[2], "x")
	raw, _ := os.ReadFile(filepath.Join(os.Args[3], "lt-req.json"))
	var req openrtb2.BidRequest
	jsonutil.Unmarshal(raw, &req)
	resp, _ := os.ReadFile(filepath.Join(os.Args[3], "lt-resp.json"))
	rds, _ := s.MakeRequests(&req, nil)
	f, _ := os.Create(os.Args[5])
	pprof.StartCPUProfile(f)
	end := time.Now().Add(4 * time.Second)
	for time.Now().Before(end) {
		for i := 0; i < 200; i++ {
			if os.Args[4] == "mr" {
				s.MakeRequests(&req, nil)
			} else {
				s.MakeBids(&req, rds[0], &adapters.ResponseData{StatusCode: 200, Body: resp})
			}
		}
	}
	pprof.StopCPUProfile()
}

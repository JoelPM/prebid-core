// PROTOTYPE (ABI, #24): prints the bid response projection a guest's shapes give, for the bench payloads.
// Usage: go run ./cmd/projsize <guest.wasm> <bidder> <payload dir>
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
	"sharedhost/host"
)

func main() {
	wasm, _ := os.ReadFile(os.Args[1])
	p, err := host.ProjectorsFor(wasm, os.Args[2])
	if err != nil {
		panic(err)
	}
	for _, name := range []string{"lt", "heavy"} {
		raw, _ := os.ReadFile(filepath.Join(os.Args[3], name+"-resp.json"))
		var br openrtb2.BidResponse
		jsonutil.Unmarshal(raw, &br)
		out := p.Resp.Append(nil, &br)
		fmt.Printf("%s/%s: response %d B -> projected %d B (%.0f%%)\n", os.Args[2], name, len(raw), len(out), 100*float64(len(out))/float64(len(raw)))
		if name == "lt" {
			fmt.Printf("  %.300s\n", out)
		}
	}
}

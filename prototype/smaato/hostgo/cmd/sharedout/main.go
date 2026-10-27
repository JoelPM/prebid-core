// sharedout runs the generated Rust Shared Adapters (in wasm, under wazero, through host.Shared) over
// every OpenX, PubMatic and Smaato adapterstest fixture and writes their full output, for harness/parity.mjs --rs.
//
// Usage: go run ./cmd/sharedout <guest.wasm> <prebid-server checkout> <out dir>
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"sharedhost/host"
)

func main() {
	wasm, pbs, out := os.Args[1], os.Args[2], os.Args[3]
	b, err := os.ReadFile(wasm)
	if err != nil {
		panic(err)
	}
	rt, err := host.NewRuntime(b)
	if err != nil {
		panic(err)
	}
	endpoints := map[string]string{"openx": "http://rtb.openx.net/prebid", "pubmatic": "https://hbopenbid.pubmatic.com/translator?source=prebid-server", "smaato": "https://prebid/bidder"}
	for name, ep := range endpoints {
		bidder := rt.Bidder(name, ep)
		// smaato_test.go's fixed clock
		bidder.Now = func() time.Time { return time.Date(2021, 6, 25, 10, 0, 0, 0, time.UTC) }
		root := filepath.Join(pbs, "adapters", name, name+"test")
		filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(p, ".json") {
				return err
			}
			spec, err := host.LoadSpec(p)
			if err != nil {
				panic(err)
			}
			rel, _ := filepath.Rel(root, p)
			res := host.RunWith(bidder, spec, host.ReqInfo(spec, rel))
			dst := filepath.Join(out, name, rel)
			os.MkdirAll(filepath.Dir(dst), 0o755)
			j, _ := json.MarshalIndent(res, "", " ")
			return os.WriteFile(dst, j, 0o644)
		})
	}
}

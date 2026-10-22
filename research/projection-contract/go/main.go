// PBS-Go probe: what the prototype's projector hands a Shared Adapter for each case.
//
//	struct: the case decoded the way PBS-Go and its Hand-written Adapters decode it (jsonutil.Unmarshal
//	        into openrtb2), then projected from those structs (prototype/abi stage 1).
//	raw:    the same paths projected from the case's bytes (prototype/abi ABI_PROJ=raw).
//	shadow (responses only): shadow.go's single decode with RawMessage read paths.
//	marshal (requests only): jsonutil.Marshal of the struct, which is what MakeRequests hands the guest
//	        today, before any projection.
//
// Usage: go run . <cases dir> <shapes.json>   (one JSON line per case; bodies base64)
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
)

type line struct {
	Case      string `json:"case"`
	Kind      string `json:"kind"`
	Err       string `json:"err,omitempty"`
	Struct    string `json:"struct,omitempty"`
	Raw       string `json:"raw,omitempty"`
	Marshal   string `json:"marshal,omitempty"`
	Shadow    string `json:"shadow,omitempty"`
	ShadowErr string `json:"shadowErr,omitempty"`
}

func main() {
	var sh struct{ Resp, Req [][]string }
	b, err := os.ReadFile(os.Args[2])
	must(err)
	must(json.Unmarshal(b, &sh))
	resp, req := NewProjector(sh.Resp), NewProjector(sh.Req)
	enc := json.NewEncoder(os.Stdout)
	b64 := base64.StdEncoding.EncodeToString
	for _, kind := range []string{"resp", "req"} {
		files, _ := filepath.Glob(filepath.Join(os.Args[1], kind, "*.json"))
		sort.Strings(files)
		for _, f := range files {
			body, err := os.ReadFile(f)
			must(err)
			l := line{Case: strings.TrimSuffix(filepath.Base(f), ".json"), Kind: kind}
			if kind == "resp" {
				var br openrtb2.BidResponse
				if err := jsonutil.Unmarshal(body, &br); err != nil {
					l.Err = err.Error()
				} else {
					l.Struct = b64(resp.Append(nil, &br))
				}
				l.Raw = b64(resp.AppendRaw(nil, body))
				var br2 openrtb2.BidResponse
				if s, err := shadowParse(body, &br2); err != nil {
					l.ShadowErr = err.Error()
				} else {
					l.Shadow = b64(appendShadow(nil, s, resp))
				}
			} else {
				var r openrtb2.BidRequest
				if err := jsonutil.Unmarshal(body, &r); err != nil {
					l.Err = err.Error()
				} else {
					l.Struct = b64(req.Append(nil, &r))
					m, err := jsonutil.Marshal(&r)
					if err != nil {
						l.Err = "marshal: " + err.Error()
					}
					l.Marshal = b64(m)
				}
				l.Raw = b64(req.AppendRaw(nil, body))
			}
			must(enc.Encode(l))
		}
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

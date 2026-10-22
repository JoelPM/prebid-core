// PROTOTYPE (ABI, #24): differential fuzz of the ABI stages through the real PBS-Go Host binding.
// Each case runs through the same guest at ABI stage 0 (variant D, fuzz-verified against the TS) and at
// stage N (projection, edits), and the results must be equal as JSON values.
// Usage: go run ./cmd/abifuzz <guest.wasm> <stage> < cases (harness/fuzz.mjs DUMP_CASES output)
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/adapters"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
	"sharedhost/host"
)

func norm(b []byte) any {
	var v any
	json.Unmarshal(b, &v)
	return v
}
func bidsJSON(r *adapters.BidderResponse) any {
	if r == nil {
		return nil
	}
	b, _ := json.Marshal(r)
	return norm(b)
}

func main() {
	wasm, _ := os.ReadFile(os.Args[1])
	stage := os.Args[2]
	shared := map[string][2]*host.Shared{}
	endpoints := map[string]string{"openx": "http://rtb.openx.net/prebid", "pubmatic": "https://hbopenbid.pubmatic.com/translator?source=prebid-server"}
	for b, ep := range endpoints {
		os.Setenv("ABI_STAGE", "0")
		rt0, _ := host.NewRuntime(wasm)
		s0 := rt0.Bidder(b, ep)
		os.Setenv("ABI_STAGE", stage)
		rtN, _ := host.NewRuntime(wasm)
		shared[b] = [2]*host.Shared{s0, rtN.Bidder(b, ep)}
	}
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	n, diff, skipped := map[string]int{}, map[string]int{}, 0
	shown := 0
	for sc.Scan() {
		f := strings.Split(sc.Text(), "\t")
		bidder, op := f[0], f[1]
		s := shared[bidder]
		var req openrtb2.BidRequest
		if err := jsonutil.Unmarshal([]byte(f[2]), &req); err != nil {
			skipped++ // not valid for the Host's model (e.g. a type the fuzz allows in raw JSON)
			continue
		}
		var a, b any
		if op == "mr" {
			r0, e0 := s[0].MakeRequests(&req, nil)
			rN, eN := s[1].MakeRequests(&req, nil)
			out := func(rs []*adapters.RequestData, es []error) any {
				var x []any
				for _, r := range rs {
					x = append(x, map[string]any{"body": norm(r.Body), "ids": r.ImpIDs})
				}
				var em []string
				for _, e := range es {
					em = append(em, e.Error())
				}
				return map[string]any{"reqs": x, "errs": em}
			}
			a, b = out(r0, e0), out(rN, eN)
		} else {
			rd := &adapters.RequestData{Body: []byte(f[2])}
			resp := &adapters.ResponseData{StatusCode: 200, Body: []byte(f[3])}
			b0, e0 := s[0].MakeBids(&req, rd, resp)
			bN, eN := s[1].MakeBids(&req, rd, resp)
			a, b = []any{bidsJSON(b0), fmt.Sprint(e0)}, []any{bidsJSON(bN), fmt.Sprint(eN)}
		}
		n[bidder+" "+op]++
		if !reflect.DeepEqual(a, b) {
			diff[bidder+" "+op]++
			if shown < 3 {
				shown++
				ja, _ := json.Marshal(a)
				jb, _ := json.Marshal(b)
				fmt.Printf("DIFF %s %s\n  in:      %.400s\n  stage 0: %.600s\n  stage %s: %.600s\n", bidder, op, f[2], ja, stage, jb)
			}
		}
	}
	for k, v := range n {
		fmt.Printf("%s: %d calls, stage %s vs stage 0 differ on %d\n", k, v, stage, diff[k])
	}
	fmt.Printf("skipped %d cases the Host's model rejects\n", skipped)
}

package main

// Host-side cost of the two projection sources, on prototype/abi's bench payloads (#24), without the
// guest: the Host's own parse (paid by the Hand-written Adapter too), then the struct or raw projection.
//   PAYLOADS=<prototype/abi>/out/payload go test -bench . -benchtime 2s

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
)

func benchShapes(b *testing.B, bidder string) [][]string {
	var sh map[string]struct{ Resp [][]string }
	raw, err := os.ReadFile("../shapes.json")
	if err != nil {
		b.Fatal(err)
	}
	json.Unmarshal(raw, &sh)
	return sh[bidder].Resp
}

func benchPayload(b *testing.B, name string) []byte {
	dir := os.Getenv("PAYLOADS")
	if dir == "" {
		b.Skip("PAYLOADS not set")
	}
	body, err := os.ReadFile(filepath.Join(dir, name+"-resp.json"))
	if err != nil {
		b.Fatal(err)
	}
	return body
}

func BenchmarkProjection(b *testing.B) {
	for _, bidder := range []string{"openx", "pubmatic"} {
		for _, size := range []string{"lt", "heavy"} {
			body := benchPayload(b, bidder+"-"+size)
			p := NewProjector(benchShapes(b, bidder))
			var br openrtb2.BidResponse
			if err := jsonutil.Unmarshal(body, &br); err != nil {
				b.Fatal(err)
			}
			buf := make([]byte, 0, len(body))
			b.Run(bidder+"-"+size+"/host-parse", func(b *testing.B) {
				for i := 0; i < b.N; i++ {
					var r openrtb2.BidResponse
					jsonutil.Unmarshal(body, &r)
				}
			})
			b.Run(bidder+"-"+size+"/struct", func(b *testing.B) {
				for i := 0; i < b.N; i++ {
					buf = p.Append(buf[:0], &br)
				}
			})
			b.Run(bidder+"-"+size+"/raw", func(b *testing.B) {
				for i := 0; i < b.N; i++ {
					buf = p.AppendRaw(buf[:0], body)
				}
			})
		}
	}
}

func BenchmarkShadow(b *testing.B) {
	for _, size := range []string{"lt", "heavy"} {
		body := benchPayload(b, "openx-"+size)
		p := NewProjector(benchShapes(b, "openx"))
		buf := make([]byte, 0, len(body))
		b.Run("openx-"+size+"/shadow-parse+project", func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				var br openrtb2.BidResponse
				s, err := shadowParse(body, &br)
				if err != nil {
					b.Fatal(err)
				}
				buf = appendShadow(buf[:0], s, p)
			}
		})
	}
}

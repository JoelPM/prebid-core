// bench measures per-call CPU of a generated Shared Adapter (wasm, wazero, host.Shared) against
// PBS-Go's real Hand-written Adapter, the same way research/typed-rust-guest did: MakeRequests then
// MakeBids on the same in-memory *openrtb2.BidRequest, outputs checked equal before timing.
//
// Payloads: `lt` is #11's load-test auction (3 banner imps, 6 KB stub response), `heavy` is #3's
// (4 imps incl. rewarded video, 11 KB response). Both are OpenX-shaped; for PubMatic each imp's
// ext.bidder is swapped for PubMatic params and the response gets wrapper/keyword-free bids.
//
// Usage: go run ./cmd/bench -wasm <dir with openx.wasm, pubmatic.wasm> [-par 1,4,8] [-dur 2s]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/adapters"
	"github.com/prebid/prebid-server/v4/adapters/openx"
	"github.com/prebid/prebid-server/v4/adapters/pubmatic"
	"github.com/prebid/prebid-server/v4/config"
	"github.com/prebid/prebid-server/v4/openrtb_ext"
	"github.com/prebid/prebid-server/v4/util/jsonutil"

	"sharedhost/host"
)

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

type payload struct {
	req  openrtb2.BidRequest
	resp []byte
}

func load(dir, name, bidder string) payload {
	var req openrtb2.BidRequest
	must(0, jsonutil.Unmarshal(must(os.ReadFile(filepath.Join(dir, name+"-req.json"))), &req))
	resp := must(os.ReadFile(filepath.Join(dir, name+"-resp.json")))
	if bidder == "pubmatic" {
		for i := range req.Imp {
			var ext map[string]json.RawMessage
			must(0, json.Unmarshal(req.Imp[i].Ext, &ext))
			ext["bidder"] = json.RawMessage(fmt.Sprintf(`{"publisherId":" 156209 ","adSlot":"slot-%d@300x250","wrapper":{"profile":5123,"version":1},"keywords":[{"key":"pmZoneID","value":["zone1","zone2"]}],"kadfloor":"0.1"}`, i))
			req.Imp[i].Ext = must(json.Marshal(ext))
		}
	}
	return payload{req: req, resp: resp}
}

func call(b adapters.Bidder, p *payload) ([]*adapters.RequestData, *adapters.BidderResponse) {
	req := p.req
	req.Imp = append([]openrtb2.Imp(nil), p.req.Imp...)
	rds, errs := b.MakeRequests(&req, &adapters.ExtraRequestInfo{})
	if len(errs) > 0 || len(rds) != 1 {
		panic(fmt.Sprint("MakeRequests: ", errs))
	}
	br, errs := b.MakeBids(&p.req, rds[0], &adapters.ResponseData{StatusCode: 200, Body: p.resp})
	if len(errs) > 0 {
		panic(fmt.Sprint("MakeBids: ", errs))
	}
	return rds, br
}

func sameJSON(a, b []byte) bool {
	var x, y any
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && fmt.Sprint(x) == fmt.Sprint(y)
}

func check(native, shared adapters.Bidder, p *payload) {
	nr, nb := call(native, p)
	sr, sb := call(shared, p)
	if !sameJSON(nr[0].Body, sr[0].Body) {
		panic(fmt.Sprintf("bodies differ:\nnative %s\nshared %s", nr[0].Body, sr[0].Body))
	}
	if len(nb.Bids) != len(sb.Bids) {
		panic("bid counts differ")
	}
	for i := range nb.Bids {
		a := must(json.Marshal(nb.Bids[i]))
		b := must(json.Marshal(sb.Bids[i]))
		if !sameJSON(a, b) {
			panic(fmt.Sprintf("bid %d differs:\nnative %s\nshared %s", i, a, b))
		}
	}
}

func main() {
	dir := flag.String("wasm", "../out/wasm", "dir with <bidder>.wasm")
	pdir := flag.String("payload", "payload", "payload dir")
	pars := flag.String("par", "1,4,8", "goroutine counts")
	dur := flag.Duration("dur", 2*time.Second, "duration per concurrency window")
	flag.Parse()
	fmt.Printf("%s, GOMAXPROCS %d, wazero v1.12.0 compiler\n", runtime.Version(), runtime.GOMAXPROCS(0))

	natives := map[string]adapters.Bidder{}
	natives["openx"] = must(openx.Builder(openrtb_ext.BidderOpenx, config.Adapter{Endpoint: "http://rtb.openx.net/prebid"}, config.Server{}))
	natives["pubmatic"] = must(pubmatic.Builder(openrtb_ext.BidderPubmatic, config.Adapter{Endpoint: "https://hbopenbid.pubmatic.com/translator?source=prebid-server"}, config.Server{}))
	for _, bidder := range []string{"openx", "pubmatic"} {
		wasm := must(os.ReadFile(filepath.Join(*dir, bidder+".wasm")))
		rt := must(host.NewRuntime(wasm))
		shared := rt.Bidder(bidder, "http://example.com")
		for _, name := range []string{"lt", "heavy"} {
			p := load(*pdir, name, bidder)
			fmt.Printf("\n== %s / %s (request %d B marshalled, response %d B; guest %d KB)\n", bidder, name, len(must(jsonutil.Marshal(&p.req))), len(p.resp), len(wasm)/1024)
			check(natives[bidder], shared, &p)
			fmt.Println("  correctness: body and every TypedBid (incl. meta, video, seat) equal the Hand-written Adapter's")
			n := single("native PBS-Go Adapter", func() { call(natives[bidder], &p) })
			s := single("Shared Adapter (generated Rust, wasm)", func() { call(shared, &p) })
			fmt.Printf("  %-50s %+8.2f us (%.2fx)\n", "overhead, one goroutine", s-n, s/n)
			body := must(jsonutil.Marshal(&p.req))
			rds, _ := shared.MakeRequests(&p.req, nil)
			single("  of which: guest calls only (write, run, read)", func() { shared.GuestOnly(body, rds[0].Body, p.resp) })
			single("  of which: Host marshal request", func() { jsonutil.Marshal(&p.req) })
			single("  of which: Host unmarshal response", func() { var br openrtb2.BidResponse; jsonutil.Unmarshal(p.resp, &br) })
			if name != "lt" {
				continue
			}
			for _, ps := range strings.Split(*pars, ",") {
				k := must(strconv.Atoi(ps))
				nc := parallel("native, process CPU", k, *dur, func() { call(natives[bidder], &p) })
				sc := parallel("shared (sync.Pool), process CPU", k, *dur, func() { call(shared, &p) })
				fmt.Printf("  %-50s p=%-2d %+8.2f us CPU\n", "overhead under concurrency", k, sc-nc)
			}
		}
	}
}

// ---- timing, as in research/typed-rust-guest/hostgo ----

func cpuNow() time.Duration {
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}

func single(label string, op func()) float64 {
	var ts []float64
	var last testing.BenchmarkResult
	for i := 0; i < 5; i++ {
		last = testing.Benchmark(func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				op()
			}
		})
		ts = append(ts, float64(last.T.Nanoseconds())/float64(last.N)/1e3)
	}
	med := median(ts)
	fmt.Printf("  %-50s %8.2f us/op (min %.2f max %.2f) %6d B/op %4d allocs/op\n", label, med, minf(ts), maxf(ts), last.AllocedBytesPerOp(), last.AllocsPerOp())
	return med
}

func parallel(label string, p int, d time.Duration, op func()) float64 {
	var r []float64
	for i := 0; i < 3; i++ {
		r = append(r, parallelOnce(p, d, op))
	}
	fmt.Printf("  %-50s p=%-2d %8.2f us CPU/op (runs %.2f %.2f %.2f)\n", label, p, median(r), r[0], r[1], r[2])
	return median(r)
}

func parallelOnce(p int, d time.Duration, op func()) float64 {
	warm := time.Now().Add(d / 3)
	var wg sync.WaitGroup
	for w := 0; w < p; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for time.Now().Before(warm) {
				op()
			}
		}()
	}
	wg.Wait()
	runtime.GC()
	var n atomic.Int64
	c0 := cpuNow()
	stop := time.Now().Add(d)
	for w := 0; w < p; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			k := int64(0)
			for time.Now().Before(stop) {
				op()
				k++
			}
			n.Add(k)
		}()
	}
	wg.Wait()
	return float64((cpuNow() - c0).Nanoseconds()) / float64(n.Load()) / 1e3
}

func median(v []float64) float64 {
	c := append([]float64(nil), v...)
	for i := range c {
		for j := i + 1; j < len(c); j++ {
			if c[j] < c[i] {
				c[i], c[j] = c[j], c[i]
			}
		}
	}
	return c[len(c)/2]
}
func minf(v []float64) float64 {
	m := math.Inf(1)
	for _, x := range v {
		m = math.Min(m, x)
	}
	return m
}
func maxf(v []float64) float64 {
	m := math.Inf(-1)
	for _, x := range v {
		m = math.Max(m, x)
	}
	return m
}

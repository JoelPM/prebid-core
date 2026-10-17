// hostgo measures the per-call CPU overhead of a Shared OpenX Adapter under wazero against PBS-Go's
// real Hand-written OpenX Adapter, end to end in PBS-Go terms: the Host starts from the
// *openrtb2.BidRequest the exchange hands an Adapter and must end with the same
// *adapters.RequestData and *adapters.BidderResponse the Hand-written Adapter returns.
//
// Usage: go run ./hostgo -wasm guest.wasm [-payload payload] [-par 1,4,8] [-dur 3s]
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"net/http"
	"os"
	"reflect"
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
	"github.com/prebid/prebid-server/v4/openrtb_ext"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"

	"tbench/tb"
)

var ctx = context.Background()

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// ---------- guest instance ----------

type guest struct {
	m                                                    api.Module
	mem                                                  api.Memory
	inBuf, mrV, mrT, mbV, mbTJ, mbTA, alloc, free, adapt api.Function
	noop                                                 api.Function
	inPtr, inCap                                         uint32
	stack                                                []uint64
	hdr                                                  []byte
}

func newGuest(rt wazero.Runtime, cm wazero.CompiledModule) *guest {
	m := must(rt.InstantiateModule(ctx, cm, wazero.NewModuleConfig().WithName("")))
	f := m.ExportedFunction
	return &guest{m: m, mem: m.Memory(), inBuf: f("in_buf"), mrV: f("mr_value"), mrT: f("mr_typed"), mbV: f("mb_value"),
		mbTJ: f("mb_typed_json"), mbTA: f("mb_typed_annot"), alloc: f("alloc"), free: f("dealloc"), adapt: f("adapt"),
		noop: f("noop"), stack: make([]uint64, 4)}
}

// in writes parts back to back into the guest's reusable input buffer (growing it if needed).
func (g *guest) in(parts ...[]byte) uint32 {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	if uint32(n) > g.inCap {
		g.stack[0] = uint64(n)
		must(0, g.inBuf.CallWithStack(ctx, g.stack))
		g.inPtr, g.inCap = uint32(g.stack[0]), uint32(n)
	}
	off := g.inPtr
	for _, p := range parts {
		g.mem.Write(off, p)
		off += uint32(len(p))
	}
	return uint32(n)
}

// call runs a lean export on n input bytes and returns a view of its output (valid until the
// next call on this instance).
func (g *guest) call(fn api.Function, n uint32) []byte {
	g.stack[0] = uint64(n)
	must(0, fn.CallWithStack(ctx, g.stack))
	out, _ := g.mem.Read(uint32(g.stack[0]>>32), uint32(g.stack[0]))
	return out
}

// ---------- Host side of each guest variant ----------

var reqHeaders = func() http.Header {
	h := http.Header{}
	h.Add("Content-Type", "application/json;charset=utf-8")
	h.Add("Accept", "application/json")
	return h
}()

// requestData wraps a guest-built body the way the Hand-written Adapter's makeRequest does.
func requestData(req *openrtb2.BidRequest, body []byte) *adapters.RequestData {
	h := http.Header{}
	h.Add("Content-Type", "application/json;charset=utf-8")
	h.Add("Accept", "application/json")
	return &adapters.RequestData{Method: "POST", Uri: "http://127.0.0.1:9000/openx", Body: body, Headers: h, ImpIDs: openrtb_ext.GetImpIDs(req.Imp)}
}

// jsonBids is the JSON MakeBids output of the Value guest and the typed-json guest.
type jsonBids struct {
	Body string `json:"body"` // legacy ABI only
	Bids []struct {
		Bid   openrtb2.Bid                  `json:"bid"`
		Type  openrtb_ext.BidType           `json:"type"`
		Video openrtb_ext.ExtBidPrebidVideo `json:"video"`
		Meta  *openrtb_ext.ExtBidPrebidMeta `json:"meta"`
	} `json:"bids"`
	Cur string `json:"cur"`
}

func (j *jsonBids) response() *adapters.BidderResponse {
	br := adapters.NewBidderResponseWithBidsCapacity(len(j.Bids))
	br.Currency = j.Cur
	for i := range j.Bids {
		b := &j.Bids[i]
		v := b.Video
		br.Bids = append(br.Bids, &adapters.TypedBid{Bid: &b.Bid, BidType: b.Type, BidVideo: &v, BidMeta: b.Meta})
	}
	return br
}

func decodeJSONBids(out []byte) *adapters.BidderResponse {
	var j jsonBids
	if err := jsonutil.Unmarshal(out, &j); err != nil {
		panic(err)
	}
	return j.response()
}

var bidTypes = [...]openrtb_ext.BidType{openrtb_ext.BidTypeBanner, openrtb_ext.BidTypeVideo, openrtb_ext.BidTypeNative}

// attachAnnot builds TypedBids from the Host's own parse of the response plus the guest's
// binary annotations (layout in guest/src/typed.rs make_bids_annot).
func attachAnnot(resp *openrtb2.BidResponse, a []byte) *adapters.BidderResponse {
	le := binary.LittleEndian
	n := int(le.Uint32(a))
	br := adapters.NewBidderResponseWithBidsCapacity(n)
	i := 4
	for s := range resp.SeatBid {
		for k := range resp.SeatBid[s].Bid {
			t := bidTypes[a[i]]
			dur := int(int64(le.Uint64(a[i+1:])))
			cl := int(le.Uint16(a[i+9:]))
			cat := string(a[i+11 : i+11+cl])
			i += 11 + cl
			var meta *openrtb_ext.ExtBidPrebidMeta
			if a[i] == 1 {
				meta = &openrtb_ext.ExtBidPrebidMeta{NetworkID: int(int64(le.Uint64(a[i+1:]))), AdvertiserID: int(int64(le.Uint64(a[i+9:]))), BrandID: int(int64(le.Uint64(a[i+17:])))}
			}
			i += 25
			br.Bids = append(br.Bids, &adapters.TypedBid{Bid: &resp.SeatBid[s].Bid[k], BidType: t, BidVideo: &openrtb_ext.ExtBidPrebidVideo{PrimaryCategory: cat, Duration: dur}, BidMeta: meta})
		}
	}
	cl := int(le.Uint16(a[i:]))
	br.Currency = string(a[i+2 : i+2+cl])
	return br
}

type variant struct {
	name string
	run  func(g *guest, req *openrtb2.BidRequest, resp []byte) (*adapters.RequestData, *adapters.BidderResponse)
}

// mr marshals the request (the Host must: the guest can't see Go structs), runs a MakeRequests
// export, and copies the body out of guest memory.
func mr(g *guest, fn api.Function, req *openrtb2.BidRequest) *adapters.RequestData {
	rj := must(jsonutil.Marshal(req))
	return requestData(req, bytes.Clone(g.call(fn, g.in(rj))))
}

var variants = []variant{
	{"A legacy #3 ABI, Value guest", func(g *guest, req *openrtb2.BidRequest, resp []byte) (*adapters.RequestData, *adapters.BidderResponse) {
		rj := must(jsonutil.Marshal(req))
		rp := must(g.alloc.Call(ctx, uint64(len(rj))))[0]
		sp := must(g.alloc.Call(ctx, uint64(len(resp))))[0]
		g.mem.Write(uint32(rp), rj)
		g.mem.Write(uint32(sp), resp)
		o := must(g.adapt.Call(ctx, rp, uint64(len(rj)), sp, uint64(len(resp))))[0]
		out, _ := g.mem.Read(uint32(o>>32), uint32(o))
		var j jsonBids
		if err := jsonutil.Unmarshal(bytes.Clone(out), &j); err != nil {
			panic(err)
		}
		g.free.Call(ctx, rp, uint64(len(rj)))
		g.free.Call(ctx, sp, uint64(len(resp)))
		return requestData(req, []byte(j.Body)), j.response()
	}},
	{"B lean ABI, Value guest, JSON bids out", func(g *guest, req *openrtb2.BidRequest, resp []byte) (*adapters.RequestData, *adapters.BidderResponse) {
		rd := mr(g, g.mrV, req)
		g.hdr = tb.ImpTable(g.hdr, req.Imp)
		return rd, decodeJSONBids(g.call(g.mbV, g.in(g.hdr, resp)))
	}},
	{"C lean ABI, typed guest, JSON bids out", func(g *guest, req *openrtb2.BidRequest, resp []byte) (*adapters.RequestData, *adapters.BidderResponse) {
		rd := mr(g, g.mrT, req)
		g.hdr = tb.ImpTable(g.hdr, req.Imp)
		return rd, decodeJSONBids(g.call(g.mbTJ, g.in(g.hdr, resp)))
	}},
	{"D lean ABI, typed guest, Host parses bids + binary annotations", func(g *guest, req *openrtb2.BidRequest, resp []byte) (*adapters.RequestData, *adapters.BidderResponse) {
		rd := mr(g, g.mrT, req)
		var br openrtb2.BidResponse
		if err := jsonutil.Unmarshal(resp, &br); err != nil {
			panic(err)
		}
		g.hdr = tb.ImpTable(g.hdr, req.Imp)
		return rd, attachAnnot(&br, g.call(g.mbTA, g.in(g.hdr, resp)))
	}},
	{"E as D, but guest gets a projection of the parsed response", func(g *guest, req *openrtb2.BidRequest, resp []byte) (*adapters.RequestData, *adapters.BidderResponse) {
		rd := mr(g, g.mrT, req)
		var br openrtb2.BidResponse
		if err := jsonutil.Unmarshal(resp, &br); err != nil {
			panic(err)
		}
		g.hdr = tb.ImpTable(g.hdr, req.Imp)
		return rd, attachAnnot(&br, g.call(g.mbTA, g.in(g.hdr, project(&br))))
	}},
}

// project re-encodes only the bid fields OpenX's MakeBids declares it reads (impid, mtype, cat,
// dur, ext), so adm and the rest never cross the boundary. Same JSON shape, same guest parser.
type projBid struct {
	ImpID string          `json:"impid"`
	MType int64           `json:"mtype,omitempty"`
	Cat   []string        `json:"cat,omitempty"`
	Dur   int64           `json:"dur,omitempty"`
	Ext   json.RawMessage `json:"ext,omitempty"`
}
type projSeat struct {
	Bid []projBid `json:"bid"`
}
type projResp struct {
	Cur     string     `json:"cur,omitempty"`
	SeatBid []projSeat `json:"seatbid"`
}

func project(br *openrtb2.BidResponse) []byte {
	p := projResp{Cur: br.Cur, SeatBid: make([]projSeat, len(br.SeatBid))}
	for s := range br.SeatBid {
		bids := make([]projBid, len(br.SeatBid[s].Bid))
		for i := range br.SeatBid[s].Bid {
			b := &br.SeatBid[s].Bid[i]
			bids[i] = projBid{b.ImpID, int64(b.MType), b.Cat, b.Dur, b.Ext}
		}
		p.SeatBid[s].Bid = bids
	}
	return must(jsonutil.Marshal(p))
}

// ---------- correctness ----------

func sameJSON(a, b []byte) bool {
	var x, y any
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && reflect.DeepEqual(x, y)
}

func check(name string, want, got *adapters.RequestData, wb, gb *adapters.BidderResponse) {
	if !sameJSON(want.Body, got.Body) {
		fmt.Printf("  MISMATCH %s body\n   want %s\n   got  %s\n", name, want.Body, got.Body)
		os.Exit(1)
	}
	if wb.Currency != gb.Currency || len(wb.Bids) != len(gb.Bids) {
		fmt.Printf("  MISMATCH %s currency/bid count\n", name)
		os.Exit(1)
	}
	for i := range wb.Bids {
		w, g := wb.Bids[i], gb.Bids[i]
		if w.BidType != g.BidType || !reflect.DeepEqual(w.BidVideo, g.BidVideo) || !reflect.DeepEqual(w.BidMeta, g.BidMeta) ||
			w.Bid.ID != g.Bid.ID || w.Bid.Price != g.Bid.Price || w.Bid.AdM != g.Bid.AdM || !sameJSON(w.Bid.Ext, g.Bid.Ext) {
			fmt.Printf("  MISMATCH %s bid %d: want %+v %+v %+v got %+v %+v %+v\n", name, i, w.BidType, w.BidVideo, w.BidMeta, g.BidType, g.BidVideo, g.BidMeta)
			os.Exit(1)
		}
	}
}

// ---------- measurement ----------

func cpuNow() time.Duration {
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}

func us(r testing.BenchmarkResult) float64 { return float64(r.T.Nanoseconds()) / float64(r.N) / 1e3 }

// single runs op on one goroutine via testing.Benchmark, 5 times, and reports the median.
func single(label string, op func()) float64 {
	var rs []testing.BenchmarkResult
	for i := 0; i < 5; i++ {
		rs = append(rs, testing.Benchmark(func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				op()
			}
		}))
	}
	ts := make([]float64, len(rs))
	for i, r := range rs {
		ts[i] = us(r)
	}
	med := median(ts)
	fmt.Printf("  %-66s %8.2f us/op  (min %.2f max %.2f)  %6d B/op %4d allocs/op\n", label, med, minf(ts), maxf(ts), rs[2].AllocedBytesPerOp(), rs[2].AllocsPerOp())
	return med
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

// parallel runs op on p goroutines for d and reports process CPU (user+sys, so GC included) per op.
// It repeats the measurement 3 times and reports the median.
func parallel(label string, p int, d time.Duration, op func(worker int)) float64 {
	var r []float64
	for i := 0; i < 3; i++ {
		r = append(r, parallelOnce(p, d, op))
	}
	fmt.Printf("  %-66s p=%-2d %8.2f us CPU/op  (runs %.2f %.2f %.2f)\n", label, p, median(r), r[0], r[1], r[2])
	return median(r)
}

func parallelOnce(p int, d time.Duration, op func(worker int)) float64 {
	warm := time.Now().Add(d / 3)
	var wg sync.WaitGroup
	for w := 0; w < p; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for time.Now().Before(warm) {
				op(w)
			}
		}(w)
	}
	wg.Wait()
	runtime.GC()
	var n atomic.Int64
	c0 := cpuNow()
	stop := time.Now().Add(d)
	for w := 0; w < p; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			k := int64(0)
			for time.Now().Before(stop) {
				op(w)
				k++
			}
			n.Add(k)
		}(w)
	}
	wg.Wait()
	cpu := cpuNow() - c0
	return float64(cpu.Nanoseconds()) / float64(n.Load()) / 1e3
}

func main() {
	wasmPath := flag.String("wasm", "guest.wasm", "guest module")
	dir := flag.String("payload", "payload", "payload dir")
	pars := flag.String("par", "1,4,8", "goroutine counts for the pooling runs")
	dur := flag.Duration("dur", 3*time.Second, "duration per pooling run")
	flag.Parse()

	rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigCompiler())
	bin := must(os.ReadFile(*wasmPath))
	t0 := time.Now()
	cm := must(rt.CompileModule(ctx, bin))
	fmt.Printf("wazero %s compiler, guest %d KB, compile %v, GOMAXPROCS %d, %s\n", "v1.12.0", len(bin)/1024, time.Since(t0).Round(time.Millisecond), runtime.GOMAXPROCS(0), runtime.Version())
	g := newGuest(rt, cm)

	for _, name := range []string{"lt", "heavy"} {
		p := tb.Load(*dir, name)
		req, resp := p.Req, p.Resp
		fmt.Printf("\n== payload %s (request %d B as marshalled, response %d B)\n", name, len(must(jsonutil.Marshal(req))), len(resp))
		wantRD, wantBR := tb.Native(req, resp)
		for _, v := range variants {
			rd, br := v.run(g, req, resp)
			check(v.name, wantRD, rd, wantBR, br)
		}
		fmt.Println("  correctness: every variant's body and bids match the Hand-written Adapter")

		fmt.Println(" end to end, one goroutine, reused instance (MakeRequests + MakeBids):")
		native := single("native PBS-Go OpenX Adapter", func() { tb.Native(req, resp) })
		for _, v := range variants {
			t := single(v.name, func() { v.run(g, req, resp) })
			fmt.Printf("  %66s overhead %+7.2f us (%.2fx native)\n", "", t-native, t/native)
		}

		fmt.Println(" native split:")
		single("native MakeRequests only", func() { tb.Bidder.MakeRequests(req, &adapters.ExtraRequestInfo{}) })
		single("native MakeBids only", func() {
			tb.Bidder.MakeBids(req, wantRD, &adapters.ResponseData{StatusCode: 200, Body: resp, Headers: http.Header{}})
		})
		fmt.Println(" breakdown of D and E:")
		rj := must(jsonutil.Marshal(req))
		hdr := tb.ImpTable(nil, req.Imp)
		single("Host: jsonutil.Marshal(request)", func() { jsonutil.Marshal(req) })
		single("guest: write request + mr_typed + read body (no copy)", func() { g.call(g.mrT, g.in(rj)) })
		single("Host: copy body out + build RequestData", func() { requestData(req, bytes.Clone(rj)) })
		single("Host: jsonutil.Unmarshal(response) into openrtb2.BidResponse", func() {
			var br openrtb2.BidResponse
			jsonutil.Unmarshal(resp, &br)
		})
		single("guest: write imp table + response + mb_typed_annot", func() { g.call(g.mbTA, g.in(hdr, resp)) })
		var br openrtb2.BidResponse
		jsonutil.Unmarshal(resp, &br)
		ann := bytes.Clone(g.call(g.mbTA, g.in(hdr, resp)))
		single("Host: decode annotations into TypedBids", func() { attachAnnot(&br, ann) })
		single("E Host: project parsed response", func() { project(&br) })
		pj := project(&br)
		single(fmt.Sprintf("E guest: write imp table + %d B projection + mb_typed_annot", len(pj)), func() { g.call(g.mbTA, g.in(hdr, pj)) })
		fmt.Println(" guest-only, other variants (write input + call, no Host conversion):")
		single("guest: mr_value", func() { g.call(g.mrV, g.in(rj)) })
		single("guest: mb_value (JSON out)", func() { g.call(g.mbV, g.in(hdr, resp)) })
		single("guest: mb_typed_json (JSON out)", func() { g.call(g.mbTJ, g.in(hdr, resp)) })
		out := bytes.Clone(g.call(g.mbTJ, g.in(hdr, resp)))
		single("Host: decode typed-json bids output", func() { decodeJSONBids(out) })
	}

	fmt.Println("\n== boundary costs")
	single("noop export, Call (allocating results)", func() { g.noop.Call(ctx, 1) })
	single("noop export, CallWithStack", func() { g.stack[0] = 1; g.noop.CallWithStack(ctx, g.stack) })
	buf := make([]byte, 6000)
	single("Memory.Write 6,000 B", func() { g.mem.Write(g.inPtr, buf) })
	single("alloc+dealloc export pair (#3 ABI, per buffer)", func() {
		p := must(g.alloc.Call(ctx, 6000))[0]
		g.free.Call(ctx, p, 6000)
	})
	single("fresh InstantiateModule + Close", func() { must(rt.InstantiateModule(ctx, cm, wazero.NewModuleConfig().WithName(""))).Close(ctx) })

	fmt.Println("\n== pooling under concurrency, variants D/E, payload lt (process CPU per call incl. GC)")
	p := tb.Load(*dir, "lt")
	D, E := variants[3].run, variants[4].run
	for _, s := range strings.Split(*pars, ",") {
		n := must(strconv.Atoi(s))
		parallel("native PBS-Go OpenX Adapter", n, *dur, func(int) { tb.Native(p.Req, p.Resp) })
		pinned := make([]*guest, n)
		for i := range pinned {
			pinned[i] = newGuest(rt, cm)
		}
		parallel("D, one instance per goroutine (ideal pool)", n, *dur, func(w int) { D(pinned[w], p.Req, p.Resp) })
		parallel("E, one instance per goroutine (ideal pool)", n, *dur, func(w int) { E(pinned[w], p.Req, p.Resp) })
		pool := sync.Pool{New: func() any { return newGuest(rt, cm) }}
		parallel("D, sync.Pool of instances", n, *dur, func(int) {
			gg := pool.Get().(*guest)
			D(gg, p.Req, p.Resp)
			pool.Put(gg)
		})
		ch := make(chan *guest, n)
		for i := 0; i < n; i++ {
			ch <- newGuest(rt, cm)
		}
		parallel("D, channel pool of GOMAXPROCS-bounded instances", n, *dur, func(int) {
			gg := <-ch
			D(gg, p.Req, p.Resp)
			ch <- gg
		})
		parallel("D, fresh instance per call", n, *dur, func(int) {
			gg := newGuest(rt, cm)
			D(gg, p.Req, p.Resp)
			gg.m.Close(ctx)
		})
		for _, gg := range pinned {
			gg.m.Close(ctx)
		}
	}
	fmt.Printf("\nguest linear memory per instance after runs: %d KB\n", g.mem.Size()/1024)
}

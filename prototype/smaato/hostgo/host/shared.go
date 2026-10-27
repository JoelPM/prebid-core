package host

// PROTOTYPE PBS-Go Host binding: an adapters.Bidder backed by a generated Shared Adapter in wasm.
// ABI (guest/src/lib.rs): in_buf(n) -> ptr; <bidder>_mr(len) / <bidder>_mb(reqLen, respLen) -> outLen;
// out_ptr() -> ptr. Output is length-prefixed frames. Same design as research/typed-rust-guest's
// variant D: the Host keeps the OpenRTB parse, the guest returns small per-bid annotations.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prebid/openrtb/v20/openrtb2"
	"github.com/prebid/prebid-server/v4/adapters"
	"github.com/prebid/prebid-server/v4/errortypes"
	"github.com/prebid/prebid-server/v4/openrtb_ext"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

var ctx = context.Background()

type Runtime struct {
	rt wazero.Runtime
	cm wazero.CompiledModule
}

// callState is what the Host's functions answer during one guest call (#20: host.now, host.convertCurrency).
type callState struct {
	now  func() time.Time
	info *adapters.ExtraRequestInfo
}
type stateKey struct{}

func NewRuntime(wasm []byte) (*Runtime, error) {
	rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigCompiler())
	// the Host's functions a guest may import
	_, err := rt.NewHostModuleBuilder("prebid").
		NewFunctionBuilder().WithFunc(func(c context.Context) float64 {
		st, _ := c.Value(stateKey{}).(*callState)
		if st == nil {
			return float64(time.Now().UnixMilli())
		}
		return float64(st.now().UnixMilli())
	}).Export("now_ms").
		NewFunctionBuilder().WithFunc(func(c context.Context, m api.Module, amount float64, fp, fl, tp, tl uint32) float64 {
		st, _ := c.Value(stateKey{}).(*callState)
		from, _ := m.Memory().Read(fp, fl)
		to, _ := m.Memory().Read(tp, tl)
		if st == nil || st.info == nil {
			return math.NaN()
		}
		v, err := st.info.ConvertCurrency(amount, string(from), string(to))
		if err != nil {
			return math.NaN()
		}
		return v
	}).Export("convert_currency").
		Instantiate(ctx)
	if err != nil {
		return nil, err
	}
	cm, err := rt.CompileModule(ctx, wasm)
	if err != nil {
		return nil, err
	}
	return &Runtime{rt: rt, cm: cm}, nil
}

type instance struct {
	mem               api.Memory
	inBuf, outPtr     api.Function
	mr, mb            api.Function
	stack             []uint64
	inPtr, inCap      uint32
}

// Shared is one Shared Adapter, with a pool of guest instances (pooling is mandatory: a fresh
// instance per call costs ~150 µs, per research/typed-rust-guest).
type Shared struct {
	bidder, endpoint string
	pool             sync.Pool
	// Now is the Host's clock (host.now()); tests fix it
	Now func() time.Time
}

func (r *Runtime) Bidder(bidder, endpoint string) *Shared {
	s := &Shared{bidder: bidder, endpoint: endpoint, Now: time.Now}
	s.pool.New = func() any {
		m, err := r.rt.InstantiateModule(ctx, r.cm, wazero.NewModuleConfig().WithName(""))
		if err != nil {
			panic(err)
		}
		f := m.ExportedFunction
		return &instance{mem: m.Memory(), inBuf: f("in_buf"), outPtr: f("out_ptr"), mr: f(bidder + "_mr"), mb: f(bidder + "_mb"), stack: make([]uint64, 4)}
	}
	return s
}

func (g *instance) write(parts ...[]byte) {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	g.stack[0] = uint64(n)
	if err := g.inBuf.CallWithStack(ctx, g.stack); err != nil {
		panic(err)
	}
	off := uint32(g.stack[0])
	for _, p := range parts {
		g.mem.Write(off, p)
		off += uint32(len(p))
	}
}

func (g *instance) call(fn api.Function, args ...uint64) []byte {
	return g.callIn(ctx, fn, args...)
}
func (g *instance) callIn(c context.Context, fn api.Function, args ...uint64) []byte {
	if len(g.stack) < len(args) {
		g.stack = make([]uint64, len(args))
	}
	copy(g.stack, args)
	if err := fn.CallWithStack(c, g.stack); err != nil {
		panic(err)
	}
	n := uint32(g.stack[0])
	if err := g.outPtr.CallWithStack(ctx, g.stack); err != nil {
		panic(err)
	}
	out, _ := g.mem.Read(uint32(g.stack[0]), n) // a view; consumed before the next call
	return out
}

type frame struct {
	b []byte
	p int
}

func (f *frame) u32() uint32 {
	v := binary.LittleEndian.Uint32(f.b[f.p:])
	f.p += 4
	return v
}
func (f *frame) bytes() []byte {
	n := int(f.u32())
	v := f.b[f.p : f.p+n]
	f.p += n
	return v
}
// strsAfterBids reads past an empty bid list's currency and paapi slots to the errors.
func (f *frame) strsAfterBids() []string {
	f.bytes()
	f.bytes()
	return f.strs()
}
func (f *frame) strs() []string {
	n := f.u32()
	out := make([]string, 0, n)
	for i := uint32(0); i < n; i++ {
		out = append(out, string(f.bytes()))
	}
	return out
}

// hostContext is what Phases see as `host` (besides the functions): the entry point.
func hostContext(info *adapters.ExtraRequestInfo) []byte {
	ep := "auction"
	if info != nil && info.PbsEntryPoint != "" {
		ep = string(info.PbsEntryPoint)
	}
	b, _ := json.Marshal(map[string]string{"entryPoint": ep})
	return b
}

func (s *Shared) MakeRequests(request *openrtb2.BidRequest, info *adapters.ExtraRequestInfo) ([]*adapters.RequestData, []error) {
	body, err := jsonutil.Marshal(request)
	if err != nil {
		return nil, []error{err}
	}
	g := s.pool.Get().(*instance)
	defer s.pool.Put(g)
	hc := hostContext(info)
	g.write(hc, body)
	c := context.WithValue(ctx, stateKey{}, &callState{now: s.Now, info: info})
	f := frame{b: g.callIn(c, g.mr, uint64(len(hc)), uint64(len(body)))}
	var rds []*adapters.RequestData
	for n := f.u32(); n > 0; n-- {
		headers := http.Header{}
		headers.Add("Content-Type", "application/json;charset=utf-8")
		headers.Add("Accept", "application/json")
		rd := &adapters.RequestData{Method: "POST", Uri: s.endpoint, Body: append([]byte(nil), f.bytes()...), Headers: headers}
		rd.ImpIDs = f.strs()
		rds = append(rds, rd)
	}
	var errs []error
	for _, e := range f.strs() {
		errs = append(errs, &errortypes.BadInput{Message: e})
	}
	return rds, errs
}

func (s *Shared) MakeBids(_ *openrtb2.BidRequest, ext *adapters.RequestData, response *adapters.ResponseData) (*adapters.BidderResponse, []error) {
	// HTTP status handling stays in the Host for the prototype (map #1 fog: "who handles HTTP status").
	switch response.StatusCode {
	case http.StatusNoContent:
		return nil, nil
	case http.StatusBadRequest:
		return nil, []error{&errortypes.BadInput{Message: fmt.Sprintf("Unexpected status code: %d. Run with request.debug = 1 for more info", response.StatusCode)}}
	case http.StatusOK:
	default:
		return nil, []error{&errortypes.BadServerResponse{Message: fmt.Sprintf("Unexpected status code: %d. Run with request.debug = 1 for more info", response.StatusCode)}}
	}
	var br openrtb2.BidResponse
	if err := jsonutil.Unmarshal(response.Body, &br); err != nil {
		return nil, []error{err}
	}
	g := s.pool.Get().(*instance)
	defer s.pool.Put(g)
	hc := hostContext(nil)
	// http: the status and the headers (first values, names lower-cased)
	hd := map[string]string{}
	for k, v := range response.Headers {
		if len(v) > 0 {
			hd[strings.ToLower(k)] = v[0]
		}
	}
	hb, _ := json.Marshal(map[string]any{"status": response.StatusCode, "headers": hd})
	g.write(hc, ext.Body, response.Body, hb)
	c := context.WithValue(ctx, stateKey{}, &callState{now: s.Now})
	f := frame{b: g.callIn(c, g.mb, uint64(len(hc)), uint64(len(ext.Body)), uint64(len(response.Body)), uint64(len(hb)))}

	var errs []error
	if f.u32() == 1 {
		// the response Phase rejected the response: no bids, as when a Hand-written MakeBids returns nil
		f.u32()
		for _, e := range f.strsAfterBids() {
			errs = append(errs, &errortypes.BadServerResponse{Message: e})
		}
		return nil, errs
	}
	out := adapters.NewBidderResponseWithBidsCapacity(5)
	n := int(f.u32())
	i := 0
	for si := range br.SeatBid {
		for bi := range br.SeatBid[si].Bid {
			if i >= n {
				break
			}
			i++
			keep, typ, seat, dp := f.u32(), f.bytes(), f.bytes(), f.u32()
			video, meta, ov := f.bytes(), f.bytes(), f.bytes()
			if keep == 0 {
				continue
			}
			bid := &br.SeatBid[si].Bid[bi]
			if len(ov) > 0 {
				b := *bid
				if err := jsonutil.Unmarshal(ov, &b); err != nil {
					errs = append(errs, err)
					continue
				}
				bid = &b
			}
			tb := &adapters.TypedBid{Bid: bid, BidType: openrtb_ext.BidType(typ), Seat: openrtb_ext.BidderName(seat), DealPriority: int(int32(dp))}
			if len(video) > 0 {
				// the Definition returned a video annotation (possibly with no defined members)
				tb.BidVideo = &openrtb_ext.ExtBidPrebidVideo{}
			}
			for _, kv := range kvs(video) {
				switch kv.key {
				case "duration":
					tb.BidVideo.Duration, _ = strconv.Atoi(kv.val)
				case "primary_category":
					tb.BidVideo.PrimaryCategory = kv.val
				}
			}
			if m := kvs(meta); len(m) > 0 {
				tb.BidMeta = decodeMeta(m)
			}
			out.Bids = append(out.Bids, tb)
		}
	}
	if cur := f.bytes(); len(cur) > 0 {
		out.Currency = string(cur)
	}
	if paapi := f.bytes(); len(paapi) > 0 {
		var cfgs []*openrtb_ext.FledgeAuctionConfig
		if err := jsonutil.Unmarshal(paapi, &cfgs); err == nil {
			for _, c := range cfgs {
				c.Bidder = s.bidder
			}
			out.FledgeAuctionConfigs = cfgs
		}
	}
	for _, e := range f.strs() {
		errs = append(errs, &errortypes.BadServerResponse{Message: e})
	}
	return out, errs
}

type kv struct {
	key, val string
	kind     byte // 0 string content, 1 number text, 2 JSON
}

// kvs reads an object the guest framed as key/value records (prebid_core_rt::Doc::kv_slot).
func kvs(b []byte) []kv {
	if len(b) == 0 {
		return nil
	}
	f := frame{b: b}
	n := int(f.u32())
	out := make([]kv, 0, n)
	for i := 0; i < n; i++ {
		k := string(f.bytes())
		kind := f.b[f.p]
		f.p++
		out = append(out, kv{key: k, kind: kind, val: string(f.bytes())})
	}
	return out
}

// decodeMeta fills the common ExtBidPrebidMeta fields directly and leaves the rest to jsonutil.
func decodeMeta(m []kv) *openrtb_ext.ExtBidPrebidMeta {
	meta := &openrtb_ext.ExtBidPrebidMeta{}
	var rest []byte
	for _, x := range m {
		n, _ := strconv.Atoi(x.val)
		switch x.key {
		case "networkId":
			meta.NetworkID = n
		case "advertiserId":
			meta.AdvertiserID = n
		case "brandId":
			meta.BrandID = n
		case "agencyId":
			meta.AgencyID = n
		case "mediaType":
			meta.MediaType = x.val
		case "networkName":
			meta.NetworkName = x.val
		default:
			v := x.val
			if x.kind == 0 {
				v = strconv.Quote(x.val)
			}
			if rest == nil {
				rest = []byte{'{'}
			} else {
				rest = append(rest, ',')
			}
			rest = append(append(append(rest, strconv.Quote(x.key)...), ':'), v...)
		}
	}
	if rest != nil {
		jsonutil.Unmarshal(append(rest, '}'), meta)
	}
	return meta
}

// GuestOnly runs just the guest calls (input write + call + output view) for a prepared request body,
// outgoing body and response, so benchmarks can separate guest time from the Host's own work.
func (s *Shared) GuestOnly(reqBody, outBody, resp []byte) {
	g := s.pool.Get().(*instance)
	defer s.pool.Put(g)
	hc, hb := []byte(`{"entryPoint":"auction"}`), []byte(`{"status":200,"headers":{}}`)
	g.write(hc, reqBody)
	g.call(g.mr, uint64(len(hc)), uint64(len(reqBody)))
	g.write(hc, outBody, resp, hb)
	g.call(g.mb, uint64(len(hc)), uint64(len(outBody)), uint64(len(resp)), uint64(len(hb)))
}

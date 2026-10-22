package host

// PROTOTYPE PBS-Go Host binding: an adapters.Bidder backed by a generated Shared Adapter in wasm.
// ABI (guest/src/lib.rs): in_buf(n) -> ptr; <bidder>_mr(len) / <bidder>_mb(reqLen, respLen) -> outLen;
// out_ptr() -> ptr. Output is length-prefixed frames. Same design as research/typed-rust-guest's
// variant D: the Host keeps the OpenRTB parse, the guest returns small per-bid annotations.

import (
	"context"
	"encoding/binary"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"

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

func NewRuntime(wasm []byte) (*Runtime, error) {
	rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigCompiler())
	cm, err := rt.CompileModule(ctx, wasm)
	if err != nil {
		return nil, err
	}
	return &Runtime{rt: rt, cm: cm}, nil
}

type instance struct {
	mem           api.Memory
	inBuf, outPtr api.Function
	mr, mb        api.Function
	mre           api.Function // ABI #24 stage 2: MakeRequests over a projection, returning edits
	scan          api.Function // typed guests only (research hook)
	stack         []uint64
	inPtr, inCap  uint32
	proj          []byte // reused projection buffer
}

// Shared is one Shared Adapter, with a pool of guest instances (pooling is mandatory: a fresh
// instance per call costs ~150 µs, per research/typed-rust-guest).
type Shared struct {
	bidder, endpoint string
	pool             sync.Pool
	// ABI (#24): Stage 0 = variant D; 1 = the bid response is projected to the guest's shapes;
	// 2 = also the request is projected and MakeRequests returns edits the Host applies
	Stage             int
	projResp, projReq *Projector
	// ABI_PROJ=raw: project the input bytes instead of the Host's structs (exact, Host-independent)
	rawProj bool
}

func (r *Runtime) Bidder(bidder, endpoint string) *Shared {
	s := &Shared{bidder: bidder, endpoint: endpoint}
	s.pool.New = func() any {
		m, err := r.rt.InstantiateModule(ctx, r.cm, wazero.NewModuleConfig().WithName(""))
		if err != nil {
			panic(err)
		}
		f := m.ExportedFunction
		return &instance{mem: m.Memory(), inBuf: f("in_buf"), outPtr: f("out_ptr"), mr: f(bidder + "_mr"), mb: f(bidder + "_mb"), mre: f(bidder + "_mre"), scan: f("scan"), stack: make([]uint64, 2)}
	}
	if st, err := strconv.Atoi(os.Getenv("ABI_STAGE")); err == nil {
		s.Stage = st
	}
	s.rawProj = os.Getenv("ABI_PROJ") == "raw"
	if s.Stage >= 1 {
		// the guest declares what its Phases read; the Host compiles that once
		sh, err := r.shapes(bidder)
		if err != nil {
			panic(err)
		}
		s.projResp = NewProjector(sh.Resp)
		s.projReq = NewProjector(sh.Req)
	}
	return s
}

// shapes asks a fresh instance for the guest's declared shapes.
func (r *Runtime) shapes(bidder string) (*Shapes, error) {
	m, err := r.rt.InstantiateModule(ctx, r.cm, wazero.NewModuleConfig().WithName(""))
	if err != nil {
		return nil, err
	}
	defer m.Close(ctx)
	g := &instance{mem: m.Memory(), outPtr: m.ExportedFunction("out_ptr"), stack: make([]uint64, 2)}
	fn := m.ExportedFunction(bidder + "_shapes")
	if fn == nil {
		return nil, fmt.Errorf("the guest doesn't export %s_shapes", bidder)
	}
	return parseShapes(append([]byte(nil), g.call(fn)...))
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
	copy(g.stack, args)
	if err := fn.CallWithStack(ctx, g.stack); err != nil {
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
func (f *frame) strs() []string {
	n := f.u32()
	out := make([]string, 0, n)
	for i := uint32(0); i < n; i++ {
		out = append(out, string(f.bytes()))
	}
	return out
}

func (s *Shared) MakeRequests(request *openrtb2.BidRequest, _ *adapters.ExtraRequestInfo) ([]*adapters.RequestData, []error) {
	body, err := jsonutil.Marshal(request)
	if err != nil {
		return nil, []error{err}
	}
	g := s.pool.Get().(*instance)
	defer s.pool.Put(g)
	var f frame
	if s.Stage >= 2 {
		if s.rawProj {
			g.proj = s.projReq.AppendRaw(g.proj[:0], body)
		} else {
			g.proj = s.projReq.Append(g.proj[:0], request)
		}
		g.write(g.proj)
		f = frame{b: g.call(g.mre, uint64(len(g.proj)))}
	} else {
		g.write(body)
		f = frame{b: g.call(g.mr, uint64(len(body)))}
	}
	var rd *adapters.RequestData
	if f.u32() == 1 {
		headers := http.Header{}
		headers.Add("Content-Type", "application/json;charset=utf-8")
		headers.Add("Accept", "application/json")
		out := f.bytes()
		if s.Stage >= 2 {
			if os.Getenv("ABI_DEBUG") != "" {
				fmt.Fprintf(os.Stderr, "projection: %s\nedits: %s\n", g.proj, out)
			}
			edited, err := ApplyEdits(body, out)
			if err != nil {
				return nil, []error{err}
			}
			out = edited
		} else {
			out = append([]byte(nil), out...)
		}
		rd = &adapters.RequestData{Method: "POST", Uri: s.endpoint, Body: out, Headers: headers}
	}
	ids := f.strs()
	var errs []error
	for _, e := range f.strs() {
		errs = append(errs, &errortypes.BadInput{Message: e})
	}
	if rd == nil {
		return nil, errs
	}
	rd.ImpIDs = ids
	return []*adapters.RequestData{rd}, errs
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
	resp := response.Body
	if s.projResp != nil {
		if s.rawProj {
			g.proj = s.projResp.AppendRaw(g.proj[:0], response.Body)
		} else {
			g.proj = s.projResp.Append(g.proj[:0], &br)
		}
		resp = g.proj
	}
	g.write(ext.Body, resp)
	f := frame{b: g.call(g.mb, uint64(len(ext.Body)), uint64(len(resp)))}

	out := adapters.NewBidderResponseWithBidsCapacity(5)
	var errs []error
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
			tb := &adapters.TypedBid{Bid: bid, BidType: openrtb_ext.BidType(typ), Seat: openrtb_ext.BidderName(seat), DealPriority: int(int32(dp)), BidVideo: &openrtb_ext.ExtBidPrebidVideo{}}
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
	g.write(reqBody)
	g.call(g.mr, uint64(len(reqBody)))
	g.write(outBody, resp)
	g.call(g.mb, uint64(len(outBody)), uint64(len(resp)))
}

// GuestMR / GuestMB run one guest phase each (input write + call + output view), so a benchmark can
// split guest time between MakeRequests and MakeBids (research/typed-codegen).
func (s *Shared) GuestMR(reqBody []byte) {
	g := s.pool.Get().(*instance)
	defer s.pool.Put(g)
	g.write(reqBody)
	g.call(g.mr, uint64(len(reqBody)))
}
func (s *Shared) GuestMB(outBody, resp []byte) {
	g := s.pool.Get().(*instance)
	defer s.pool.Put(g)
	g.write(outBody, resp)
	g.call(g.mb, uint64(len(outBody)), uint64(len(resp)))
}

// GuestABI does a phase's ABI work without running the Adapter (input write, in_buf, out_ptr), the
// floor under GuestMR/GuestMB (research/typed-codegen).
func (s *Shared) GuestABI(in []byte) {
	g := s.pool.Get().(*instance)
	defer s.pool.Put(g)
	g.write(in)
	if err := g.outPtr.CallWithStack(ctx, g.stack); err != nil {
		panic(err)
	}
}

// GuestScan writes `in` and has the guest scan it once as JSON (typed guests' `scan` export), the
// floor under any guest that reads its input (research/typed-codegen). False if not exported.
func (s *Shared) GuestScan(in ...[]byte) bool {
	g := s.pool.Get().(*instance)
	defer s.pool.Put(g)
	if g.scan == nil {
		return false
	}
	for _, b := range in {
		g.write(b)
		g.stack[0] = uint64(len(b))
		if err := g.scan.CallWithStack(ctx, g.stack); err != nil {
			panic(err)
		}
	}
	return true
}

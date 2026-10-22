package host

// PROTOTYPE (ABI, #24): the Host side of "projection in". The guest declares, per input document,
// the terminal paths its Phases read (`<bidder>_shapes`); the Host compiles that once per Adapter
// into a projector and, per call, writes only those fields of its own parsed structs as JSON. The
// guest's decoders are unchanged: a projection is a JSON document of the same shape, with less in it.
//
// Fields are found by their `json` tags and `omitempty` is honoured, so the guest sees what the
// Host's own model of the request holds (as a Hand-written Adapter does). Raw JSON fields
// (json.RawMessage) are passed whole even when only some of their paths are read.

import (
	"encoding/json"
	"math"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/prebid/prebid-server/v4/util/jsonutil"
)

// node: one level of the path tree. leaf means "the whole value here".
type node struct {
	leaf bool
	kids map[string]*node
	el   *node // '*': every element
	any  *node // '%': every member
}

func newTree(paths [][]string) *node {
	root := &node{}
	for _, p := range paths {
		n := root
		for _, seg := range p {
			switch seg {
			case "*":
				if n.el == nil {
					n.el = &node{}
				}
				n = n.el
			case "%":
				if n.any == nil {
					n.any = &node{}
				}
				n = n.any
			default:
				if n.kids == nil {
					n.kids = map[string]*node{}
				}
				if n.kids[seg] == nil {
					n.kids[seg] = &node{}
				}
				n = n.kids[seg]
			}
		}
		n.leaf = true
	}
	return root
}

// Shapes is what a guest declares, decoded.
type Shapes struct {
	Req, Resp, Breq [][]string
}

func parseShapes(b []byte) (*Shapes, error) {
	var s Shapes
	var raw struct {
		Req  [][]string `json:"req"`
		Resp [][]string `json:"resp"`
		Breq [][]string `json:"breq"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	s.Req, s.Resp, s.Breq = raw.Req, raw.Resp, raw.Breq
	return &s, nil
}

// Projector writes the projection of one Go type for one path tree.
type Projector struct {
	tree *node
	mu   sync.Mutex
	plan map[reflect.Type]*structPlan
}

type fieldPlan struct {
	idx       int
	name      []byte // `"name":`
	omitempty bool
	n         *node
}
type structPlan struct{ fields []fieldPlan }

func NewProjector(paths [][]string) *Projector {
	return &Projector{tree: newTree(paths), plan: map[reflect.Type]*structPlan{}}
}

func (p *Projector) planFor(t reflect.Type, n *node) *structPlan {
	// one plan per (type, node); nodes are unique per position, so key by both
	key := t
	p.mu.Lock()
	defer p.mu.Unlock()
	_ = key
	sp := &structPlan{}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "-" || !f.IsExported() {
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		if name == "" {
			name = f.Name
		}
		kid := n.kids[name]
		if n.any != nil && kid == nil {
			kid = n.any
		}
		if kid == nil {
			continue
		}
		sp.fields = append(sp.fields, fieldPlan{idx: i, name: []byte(strconv.Quote(name) + ":"), omitempty: strings.Contains(opts, "omitempty"), n: kid})
	}
	return sp
}

// cache of struct plans per (node, type)
type planKey struct {
	n *node
	t reflect.Type
}

var plans sync.Map

func structPlanFor(p *Projector, t reflect.Type, n *node) *structPlan {
	k := planKey{n, t}
	if sp, ok := plans.Load(k); ok {
		return sp.(*structPlan)
	}
	sp := p.planFor(t, n)
	plans.Store(k, sp)
	return sp
}

// Append writes the projection of v (a struct or pointer to one).
func (p *Projector) Append(buf []byte, v any) []byte {
	return p.value(buf, reflect.ValueOf(v), p.tree)
}

var rawType = reflect.TypeOf(json.RawMessage(nil))

func (p *Projector) value(buf []byte, v reflect.Value, n *node) []byte {
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return append(buf, "null"...)
		}
		v = v.Elem()
	}
	if n.leaf && n.el == nil && n.any == nil && len(n.kids) == 0 {
		return leaf(buf, v)
	}
	switch {
	case v.Type() == rawType:
		// raw JSON: passed whole (the Host doesn't parse it)
		if v.Len() == 0 {
			return append(buf, "null"...)
		}
		return append(buf, v.Bytes()...)
	case v.Kind() == reflect.Struct:
		sp := structPlanFor(p, v.Type(), n)
		buf = append(buf, '{')
		first := true
		for _, f := range sp.fields {
			fv := v.Field(f.idx)
			if f.omitempty && fv.IsZero() {
				continue
			}
			if !first {
				buf = append(buf, ',')
			}
			first = false
			buf = append(buf, f.name...)
			buf = p.value(buf, fv, f.n)
		}
		return append(buf, '}')
	case v.Kind() == reflect.Slice && n.el != nil:
		if v.IsNil() {
			return append(buf, "null"...)
		}
		buf = append(buf, '[')
		for i := 0; i < v.Len(); i++ {
			if i > 0 {
				buf = append(buf, ',')
			}
			buf = p.value(buf, v.Index(i), n.el)
		}
		return append(buf, ']')
	}
	return leaf(buf, v)
}

// leaf: a whole value as JSON, with fast paths for the common kinds.
func leaf(buf []byte, v reflect.Value) []byte {
	switch v.Kind() {
	case reflect.String:
		return appendString(buf, v.String())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return strconv.AppendInt(buf, v.Int(), 10)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return strconv.AppendUint(buf, v.Uint(), 10)
	case reflect.Float32, reflect.Float64:
		f := v.Float()
		if math.IsInf(f, 0) || math.IsNaN(f) {
			return append(buf, "null"...)
		}
		return strconv.AppendFloat(buf, f, 'g', -1, 64)
	case reflect.Bool:
		return strconv.AppendBool(buf, v.Bool())
	}
	if v.Type() == rawType {
		if v.Len() == 0 {
			return append(buf, "null"...)
		}
		return append(buf, v.Bytes()...)
	}
	if v.Kind() == reflect.Slice && v.Type().Elem().Kind() == reflect.String {
		if v.IsNil() {
			return append(buf, "null"...)
		}
		buf = append(buf, '[')
		for i := 0; i < v.Len(); i++ {
			if i > 0 {
				buf = append(buf, ',')
			}
			buf = appendString(buf, v.Index(i).String())
		}
		return append(buf, ']')
	}
	b, err := jsonutil.Marshal(v.Interface())
	if err != nil {
		return append(buf, "null"...)
	}
	return append(buf, b...)
}

// appendString writes s as a JSON string (escaping only what JSON requires; valid UTF-8 kept).
func appendString(buf []byte, s string) []byte {
	buf = append(buf, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' && c < utf8.RuneSelf {
			i++
			continue
		}
		if c >= utf8.RuneSelf {
			r, size := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && size == 1 {
				buf = append(buf, s[start:i]...)
				buf = append(buf, `�`...)
				i++
				start = i
				continue
			}
			i += size
			continue
		}
		buf = append(buf, s[start:i]...)
		switch c {
		case '"':
			buf = append(buf, '\\', '"')
		case '\\':
			buf = append(buf, '\\', '\\')
		case '\n':
			buf = append(buf, '\\', 'n')
		case '\r':
			buf = append(buf, '\\', 'r')
		case '\t':
			buf = append(buf, '\\', 't')
		default:
			buf = append(buf, `\u00`...)
			buf = append(buf, "0123456789abcdef"[c>>4], "0123456789abcdef"[c&0xf])
		}
		i++
		start = i
	}
	buf = append(buf, s[start:]...)
	return append(buf, '"')
}

// Projectors are a guest's shapes compiled for the Host's types.
type Projectors struct{ Resp, Req *Projector }

// ProjectorsFor reads a guest's declared shapes (tools; the Host binding does this in Bidder).
func ProjectorsFor(wasm []byte, bidder string) (*Projectors, error) {
	rt, err := NewRuntime(wasm)
	if err != nil {
		return nil, err
	}
	sh, err := rt.shapes(bidder)
	if err != nil {
		return nil, err
	}
	return &Projectors{Resp: NewProjector(sh.Resp), Req: NewProjector(sh.Req)}, nil
}

// AppendRaw projects JSON bytes instead of the Host's structs: the same paths, but every kept value
// is the input's own text (exact: nothing the Host's model drops, the same on every Host). Costs a
// native scan of the whole input.
func (p *Projector) AppendRaw(buf, src []byte) []byte {
	return rawValue(buf, src, p.tree)
}

func rawValue(buf, v []byte, n *node) []byte {
	buf, _ = rawAt(buf, v, ws(v, 0), n)
	return buf
}

// rawAt projects the value at i in one pass and returns where it ends.
func rawAt(buf, b []byte, i int, n *node) ([]byte, int) {
	i = ws(b, i)
	if i >= len(b) {
		return buf, i
	}
	whole := n.leaf && n.el == nil && n.any == nil && len(n.kids) == 0
	if whole || (b[i] != '{' && b[i] != '[') || (b[i] == '{' && len(n.kids) == 0 && n.any == nil) || (b[i] == '[' && n.el == nil) {
		e := skip(b, i)
		return append(buf, b[i:e]...), e
	}
	if b[i] == '[' {
		buf = append(buf, '[')
		i++
		first := true
		for {
			i = ws(b, i)
			if i >= len(b) || b[i] == ']' {
				return append(buf, ']'), i + 1
			}
			if b[i] == ',' {
				i++
				continue
			}
			if !first {
				buf = append(buf, ',')
			}
			first = false
			buf, i = rawAt(buf, b, i, n.el)
		}
	}
	buf = append(buf, '{')
	i++
	first := true
	for {
		i = ws(b, i)
		if i >= len(b) || b[i] == '}' {
			return append(buf, '}'), i + 1
		}
		if b[i] == ',' {
			i++
			continue
		}
		ke := strEnd(b, i+1)
		raw := b[i+1 : ke]
		k := string(raw)
		if hasBackslash(raw) {
			json.Unmarshal(b[i:ke+1], &k)
		}
		i = ws(b, ke+1) + 1
		kid := n.kids[k]
		if kid == nil {
			kid = n.any
		}
		if kid == nil {
			i = skip(b, i)
			continue
		}
		if !first {
			buf = append(buf, ',')
		}
		first = false
		buf = append(buf, '"')
		buf = append(buf, raw...)
		buf = append(buf, '"', ':')
		buf, i = rawAt(buf, b, i, kid)
	}
}

// eachRaw: object members with the raw (escaped) key, the decoded key, and the value span.
func eachRaw(b []byte, f func(rawKey, k, v []byte)) {
	i := ws(b, 0)
	if i >= len(b) || b[i] != '{' {
		return
	}
	i++
	for {
		i = ws(b, i)
		if i >= len(b) || b[i] == '}' {
			return
		}
		if b[i] == ',' {
			i++
			continue
		}
		ke := strEnd(b, i+1)
		raw := b[i+1 : ke]
		k := raw
		for _, c := range raw {
			if c == '\\' {
				var s string
				json.Unmarshal(b[i:ke+1], &s)
				k = []byte(s)
				break
			}
		}
		i = ws(b, ke+1) + 1
		vs := ws(b, i)
		ve := skip(b, vs)
		f(raw, k, b[vs:ve])
		i = ve
	}
}

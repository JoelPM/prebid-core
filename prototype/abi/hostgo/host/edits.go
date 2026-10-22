package host

// PROTOTYPE (ABI, #24): the Host side of "edits out". At stage 2 the guest's MakeRequests returns
// edits to the request (rt2::emit_edit) instead of the whole body; the Host applies them to the body
// it marshals anyway, streaming: members no edit touches are copied as they are.
//
//   ["v", value]  replace          ["d"]  delete
//   ["p", {k: edit}, nonempty]     patch the object at this position (nonempty: drop it if empty)
//   ["l", [[i, edit], ...]]        the array's elements i, edited, in this order
//   ["f", value]                   add-only fill (an Extension patch)   ["s", [e1, e2]]  e1 then e2
//
// Everything here is one pass over trusted bytes (the Host's own marshal output, the guest's edits).

import (
	"bytes"
	"encoding/json"
	"fmt"
)

type edit struct {
	op   byte // v d p l f s
	val  []byte
	keys []string // 'p': patched keys, in the patch's order
	kids []*edit
	ne   bool
	list []idxEdit
	seq  []*edit
}
type idxEdit struct {
	i int
	e *edit
}

// ApplyEdits applies edit text to a JSON value.
func ApplyEdits(src, editText []byte) ([]byte, error) {
	e, _, err := parseAt(editText, ws(editText, 0))
	if err != nil {
		return nil, err
	}
	out, _ := apply(make([]byte, 0, len(src)+256), src, e)
	return out, nil
}

func parseAt(b []byte, i int) (*edit, int, error) {
	if i >= len(b) || b[i] != '[' {
		return nil, i, fmt.Errorf("bad edit at %d", i)
	}
	i = ws(b, i+1)
	if i+2 >= len(b) || b[i] != '"' {
		return nil, i, fmt.Errorf("bad edit op at %d", i)
	}
	e := &edit{op: b[i+1]}
	i = ws(b, strEnd(b, i+1)+1)
	next := func() { // past a ','
		i = ws(b, i)
		if i < len(b) && b[i] == ',' {
			i = ws(b, i+1)
		}
	}
	var err error
	switch e.op {
	case 'd':
	case 'v', 'f':
		next()
		end := skip(b, i)
		e.val, i = b[i:end], end
	case 'p':
		next()
		i++ // '{'
		for {
			i = ws(b, i)
			if b[i] == '}' {
				i++
				break
			}
			if b[i] == ',' {
				i++
				continue
			}
			ke := strEnd(b, i+1)
			k := string(b[i+1 : ke])
			if hasBackslash(b[i+1 : ke]) {
				json.Unmarshal(b[i:ke+1], &k)
			}
			i = ws(b, ke+1) + 1
			var c *edit
			if c, i, err = parseAt(b, ws(b, i)); err != nil {
				return nil, i, err
			}
			e.keys = append(e.keys, k)
			e.kids = append(e.kids, c)
		}
		next()
		e.ne = i < len(b) && b[i] == '1'
		i = skip(b, i)
	case 'l':
		next()
		i++ // '['
		for {
			i = ws(b, i)
			if b[i] == ']' {
				i++
				break
			}
			if b[i] == ',' {
				i++
				continue
			}
			i = ws(b, i+1) // '['
			n := 0
			for i < len(b) && b[i] >= '0' && b[i] <= '9' {
				n = n*10 + int(b[i]-'0')
				i++
			}
			next()
			var c *edit
			if c, i, err = parseAt(b, i); err != nil {
				return nil, i, err
			}
			e.list = append(e.list, idxEdit{n, c})
			i = ws(b, i) + 1 // ']'
		}
	case 's':
		next()
		i++ // '['
		for {
			i = ws(b, i)
			if b[i] == ']' {
				i++
				break
			}
			if b[i] == ',' {
				i++
				continue
			}
			var c *edit
			if c, i, err = parseAt(b, i); err != nil {
				return nil, i, err
			}
			e.seq = append(e.seq, c)
		}
	default:
		return nil, i, fmt.Errorf("bad edit op %q", e.op)
	}
	i = ws(b, i)
	if i < len(b) && b[i] == ']' {
		i++
	}
	return e, i, nil
}

func hasBackslash(b []byte) bool {
	for _, c := range b {
		if c == '\\' {
			return true
		}
	}
	return false
}

// apply writes src edited by e; false means "delete this member".
func apply(dst, src []byte, e *edit) ([]byte, bool) {
	switch e.op {
	case 'v':
		return append(dst, e.val...), true
	case 'd':
		return dst, false
	case 'f':
		return fill(dst, src, e.val), true
	case 's':
		if len(e.seq) == 2 && e.seq[0].op == 'p' && e.seq[1].op == 'f' && isObject(e.seq[1].val) {
			return applyPatch(dst, src, e.seq[0], e.seq[1].val)
		}
		cur := src
		for _, x := range e.seq {
			b, keep := apply(nil, cur, x)
			if !keep {
				return dst, false
			}
			cur = b
		}
		return append(dst, cur...), true
	case 'l':
		elems := elements(src)
		dst = append(dst, '[')
		for n, it := range e.list {
			if n > 0 {
				dst = append(dst, ',')
			}
			var el []byte
			if it.i < len(elems) {
				el = elems[it.i]
			}
			dst, _ = apply(dst, el, it.e)
		}
		return append(dst, ']'), true
	}
	return applyPatch(dst, src, e, nil)
}

// applyPatch: copy src's members, editing the patched ones in place and adding the rest at the end;
// then, if fillv is set, fill it in (add-only) in the same pass.
func applyPatch(dst, src []byte, e *edit, fillv []byte) ([]byte, bool) {
	type pm struct {
		raw, k, v []byte
		seen      bool
	}
	var ps []pm
	if fillv != nil {
		eachRaw(fillv, func(raw, k, v []byte) { ps = append(ps, pm{raw: raw, k: k, v: v}) })
	}
	// fill a just-written member value (dst[body:]) when the fill has the same key and both are objects
	fillMember := func(k []byte, body int) {
		for j := range ps {
			if string(ps[j].k) == string(k) {
				ps[j].seen = true
				if isObject(dst[body:]) && isObject(ps[j].v) {
					cur := append([]byte(nil), dst[body:]...)
					dst = fill(dst[:body], cur, ps[j].v)
				}
				return
			}
		}
	}
	mark := len(dst)
	dst = append(dst, '{')
	first := true
	var doneBuf [16]bool
	done := doneBuf[:0]
	if len(e.keys) > len(doneBuf) {
		done = make([]bool, len(e.keys))
	} else {
		done = doneBuf[:len(e.keys)]
	}
	member := func(rawKey []byte, k string, v []byte, ed *edit) {
		m := len(dst)
		if !first {
			dst = append(dst, ',')
		}
		if rawKey != nil {
			dst = append(dst, '"')
			dst = append(dst, rawKey...)
			dst = append(dst, '"')
		} else {
			dst = appendString(dst, k)
		}
		dst = append(dst, ':')
		body := len(dst)
		keep := true
		if ed == nil {
			dst = append(dst, v...)
		} else {
			dst, keep = apply(dst, v, ed)
		}
		if !keep || (ed != nil && ed.ne && string(dst[body:]) == "{}") {
			dst = dst[:m]
			return
		}
		if ps != nil {
			kb := []byte(k)
			if rawKey != nil {
				kb = rawKey
			}
			fillMember(kb, body)
		}
		first = false
	}
	if isObject(src) {
		eachRaw(src, func(rawKey, k, v []byte) {
			for j, pk := range e.keys {
				if pk == string(k) {
					if !done[j] {
						done[j] = true
						member(rawKey, "", v, e.kids[j])
					}
					return
				}
			}
			member(rawKey, "", v, nil)
		})
	}
	for j, k := range e.keys {
		if !done[j] {
			member(nil, k, nil, e.kids[j])
		}
	}
	for _, p := range ps {
		if p.seen {
			continue
		}
		if !first {
			dst = append(dst, ',')
		}
		first = false
		dst = append(dst, '"')
		dst = append(dst, p.raw...)
		dst = append(dst, '"', ':')
		dst = append(dst, p.v...)
	}
	dst = append(dst, '}')
	if e.ne && len(dst)-mark == 2 {
		return dst[:mark], false
	}
	return dst, true
}

// fill: add-only merge of patch into src (members src lacks; recursing where both are objects).
func fill(dst, src, patch []byte) []byte {
	if !isObject(patch) {
		return append(dst, src...)
	}
	if !isObject(src) {
		if len(src) == 0 {
			return append(dst, patch...)
		}
		return append(dst, src...)
	}
	type pm struct {
		raw, k, v []byte
		seen      bool
	}
	var ps []pm
	eachRaw(patch, func(raw, k, v []byte) { ps = append(ps, pm{raw: raw, k: k, v: v}) })
	dst = append(dst, '{')
	first := true
	eachRaw(src, func(raw, k, v []byte) {
		if !first {
			dst = append(dst, ',')
		}
		first = false
		dst = append(dst, '"')
		dst = append(dst, raw...)
		dst = append(dst, '"', ':')
		for j := range ps {
			if string(ps[j].k) == string(k) {
				ps[j].seen = true
				if isObject(v) && isObject(ps[j].v) {
					dst = fill(dst, v, ps[j].v)
					return
				}
				break
			}
		}
		dst = append(dst, v...)
	})
	for _, p := range ps {
		if p.seen {
			continue
		}
		if !first {
			dst = append(dst, ',')
		}
		first = false
		dst = append(dst, '"')
		dst = append(dst, p.raw...)
		dst = append(dst, '"', ':')
		dst = append(dst, p.v...)
	}
	return append(dst, '}')
}

// ---------- a minimal JSON scanner over trusted input ----------

func ws(b []byte, i int) int {
	for i < len(b) && (b[i] == ' ' || b[i] == '\n' || b[i] == '\r' || b[i] == '\t') {
		i++
	}
	return i
}
func isObject(b []byte) bool { i := ws(b, 0); return i < len(b) && b[i] == '{' }

// skip returns the end of the value starting at i.
func skip(b []byte, i int) int {
	i = ws(b, i)
	if i >= len(b) {
		return i
	}
	switch b[i] {
	case '"':
		return strEnd(b, i+1) + 1
	case '{', '[':
		depth := 0
		for i < len(b) {
			o := bytes.IndexAny(b[i:], "\"{}[]")
			if o < 0 {
				return len(b)
			}
			i += o
			switch b[i] {
			case '"':
				i = strEnd(b, i+1) + 1
				continue
			case '{', '[':
				depth++
			default:
				depth--
				if depth == 0 {
					return i + 1
				}
			}
			i++
		}
		return i
	}
	for i < len(b) && b[i] != ',' && b[i] != '}' && b[i] != ']' && b[i] != ' ' && b[i] != '\n' && b[i] != '\r' && b[i] != '\t' {
		i++
	}
	return i
}
func strEnd(b []byte, i int) int {
	for i < len(b) {
		o := bytes.IndexAny(b[i:], "\"\\")
		if o < 0 {
			return len(b)
		}
		i += o
		if b[i] == '"' {
			return i
		}
		i += 2
	}
	return i
}

// elements splits an array into its element spans.
func elements(b []byte) [][]byte {
	i := ws(b, 0)
	if i >= len(b) || b[i] != '[' {
		return nil
	}
	i++
	var out [][]byte
	for {
		i = ws(b, i)
		if i >= len(b) || b[i] == ']' {
			return out
		}
		if b[i] == ',' {
			i++
			continue
		}
		e := skip(b, i)
		out = append(out, b[i:e])
		i = e
	}
}

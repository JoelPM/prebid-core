//go:build wasip1

// Reactor-mode wasip1 guest exposing the real OpenX adapter.
package main

import (
	"unsafe"

	"bench/adapt"
)

var keep = map[uintptr][]byte{}
var last []byte

//go:wasmexport alloc
func alloc(n uint32) uint32 {
	b := make([]byte, n)
	p := uintptr(unsafe.Pointer(&b[0]))
	keep[p] = b
	return uint32(p)
}

//go:wasmexport free
func free(p uint32) { delete(keep, uintptr(p)) }

//go:wasmexport adapt
func run(rp, rl, sp, sl uint32) uint64 {
	req := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(rp))), rl)
	resp := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(sp))), sl)
	last = adapt.Run(req, resp)
	return uint64(uintptr(unsafe.Pointer(&last[0])))<<32 | uint64(len(last))
}

//go:wasmexport noop
func noop(x uint32) uint32 { return x + 1 }

func main() {}

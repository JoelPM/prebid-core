package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"

	"bench/adapt"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

var ctx = context.Background()

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func report(name string, r testing.BenchmarkResult) {
	fmt.Printf("%-58s %10.2f us/op  %9d B/op  %6d allocs/op\n", name, float64(r.T.Nanoseconds())/float64(r.N)/1e3, r.AllocedBytesPerOp(), r.AllocsPerOp())
}

var req, resp, jsIn []byte

type guest struct {
	name, file string
	start      []string
	isGo       bool
}

func call(m api.Module, isGo bool) []byte {
	alloc := m.ExportedFunction("alloc")
	rp := must(alloc.Call(ctx, uint64(len(req))))[0]
	sp := must(alloc.Call(ctx, uint64(len(resp))))[0]
	m.Memory().Write(uint32(rp), req)
	m.Memory().Write(uint32(sp), resp)
	o := must(m.ExportedFunction("adapt").Call(ctx, rp, uint64(len(req)), sp, uint64(len(resp))))[0]
	out, _ := m.Memory().Read(uint32(o>>32), uint32(o))
	res := bytes.Clone(out)
	if isGo {
		m.ExportedFunction("free").Call(ctx, rp)
		m.ExportedFunction("free").Call(ctx, sp)
	} else {
		m.ExportedFunction("dealloc").Call(ctx, rp, uint64(len(req)))
		m.ExportedFunction("dealloc").Call(ctx, sp, uint64(len(resp)))
	}
	return res
}

func main() {
	req = must(os.ReadFile("payload/req.json"))
	resp = must(os.ReadFile("payload/resp.json"))
	jsIn = must(os.ReadFile("payload/js-input.json"))
	interpToo := len(os.Args) > 1 && os.Args[1] == "interp"

	report("native Go OpenX adapter (MakeRequests+MakeBids)", testing.Benchmark(func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			adapt.Run(req, resp)
		}
	}))
	modes := []bool{false}
	if interpToo {
		modes = append(modes, true)
	}
	for _, interp := range modes {
		tag := "wazero-compiler"
		cfgRT := wazero.NewRuntimeConfigCompiler()
		if interp {
			tag, cfgRT = "wazero-interp", wazero.NewRuntimeConfigInterpreter()
		}
		rt := wazero.NewRuntimeWithConfig(ctx, cfgRT)
		wasi_snapshot_preview1.MustInstantiate(ctx, rt)
		for _, g := range []guest{{"Rust-wasm", "guest-rs.wasm", nil, false}, {"Go-wasm", "guest-go.wasm", []string{"_initialize"}, true}} {
			bin := must(os.ReadFile(g.file))
			t0 := time.Now()
			cm := must(rt.CompileModule(ctx, bin))
			fmt.Printf("[%s] %s: module %d KB, compile %v\n", tag, g.name, len(bin)/1024, time.Since(t0))
			cfg := wazero.NewModuleConfig().WithStartFunctions(g.start...).WithName("")
			t0 = time.Now()
			mod := must(rt.InstantiateModule(ctx, cm, cfg))
			fmt.Printf("[%s] %s: first instantiate %v\n", tag, g.name, time.Since(t0))
			os.WriteFile("out-"+g.name+".json", call(mod, g.isGo), 0o644)
			noop := mod.ExportedFunction("noop")
			report(fmt.Sprintf("[%s] %s noop export call", tag, g.name), testing.Benchmark(func(b *testing.B) {
				for i := 0; i < b.N; i++ {
					noop.Call(ctx, 1)
				}
			}))
			report(fmt.Sprintf("[%s] %s adapter, reused instance", tag, g.name), testing.Benchmark(func(b *testing.B) {
				for i := 0; i < b.N; i++ {
					call(mod, g.isGo)
				}
			}))
			fmt.Printf("[%s] %s: linear memory after runs %d KB\n", tag, g.name, mod.Memory().Size()/1024)
			report(fmt.Sprintf("[%s] %s adapter, fresh instance per call", tag, g.name), testing.Benchmark(func(b *testing.B) {
				for i := 0; i < b.N; i++ {
					m := must(rt.InstantiateModule(ctx, cm, cfg))
					call(m, g.isGo)
					m.Close(ctx)
				}
			}))
			mod.Close(ctx)
		}
		for _, f := range []string{"js-empty.wasm", "js-static.wasm", "js-static-simd.wasm"} {
			bin := must(os.ReadFile(f))
			t0 := time.Now()
			jcm := must(rt.CompileModule(ctx, bin))
			fmt.Printf("[%s] %s: module %d KB, compile %v\n", tag, f, len(bin)/1024, time.Since(t0))
			runJS := func() []byte {
				var out bytes.Buffer
				m := must(rt.InstantiateModule(ctx, jcm, wazero.NewModuleConfig().WithName("").WithStdin(bytes.NewReader(jsIn)).WithStdout(&out).WithStderr(os.Stderr)))
				if m != nil {
					if f != "js-empty.wasm" {
						defer func() { _ = 0 }()
					}
					if out.Len() == 0 && f != "js-empty.wasm" {
						panic("no js output")
					}
					m.Close(ctx)
				}
				return out.Bytes()
			}
			if f == "js-static.wasm" {
				os.WriteFile("out-js-wazero.json", runJS(), 0o644)
			}
			report(fmt.Sprintf("[%s] Javy %s, fresh instance per call", tag, f), testing.Benchmark(func(b *testing.B) {
				for i := 0; i < b.N; i++ {
					runJS()
				}
			}))
		}
		rt.Close(ctx)
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	fmt.Printf("host Sys memory at end: %d MB\n", ms.Sys>>20)
}

import run.endive.compiler.MachineFactoryCompiler;
import run.endive.runtime.*;
import run.endive.wasi.*;
import run.endive.wasm.*;
import java.io.*;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.function.Function;

public class Bench {
    static byte[] req, resp, jsIn;

    interface Op { void run() throws Exception; }

    static void bench(String name, double secs, Op op) throws Exception {
        long end = System.nanoTime() + (long) (secs * 0.5e9); // warmup half
        while (System.nanoTime() < end) op.run();
        long n = 0, t0 = System.nanoTime(); end = t0 + (long) (secs * 1e9);
        long now;
        do { op.run(); n++; } while ((now = System.nanoTime()) < end);
        System.out.printf("%-62s %10.2f us/op (n=%d)%n", name, (now - t0) / 1e3 / n, n);
    }

    static byte[] call(Instance inst) {
        var alloc = inst.export("alloc");
        int rp = (int) alloc.apply(req.length)[0];
        int sp = (int) alloc.apply(resp.length)[0];
        inst.memory().write(rp, req);
        inst.memory().write(sp, resp);
        long o = inst.export("adapt").apply(rp, req.length, sp, resp.length)[0];
        byte[] out = inst.memory().readBytes((int) (o >>> 32), (int) o);
        inst.export("dealloc").apply(rp, req.length);
        inst.export("dealloc").apply(sp, resp.length);
        return out;
    }

    static Instance rust(WasmModule m, Function<Instance, Machine> mf) {
        var b = Instance.builder(m);
        if (mf != null) b.withMachineFactory(mf);
        return b.build();
    }

    static byte[] js(WasmModule m, Function<Instance, Machine> mf) {
        var out = new ByteArrayOutputStream();
        var opts = WasiOptions.builder().withStdin(new ByteArrayInputStream(jsIn)).withStdout(out).withStderr(System.err).build();
        try (var wasi = WasiPreview1.builder().withOptions(opts).build()) {
            var b = Instance.builder(m).withImportValues(ImportValues.builder().addFunction(wasi.toHostFunctions()).build());
            if (mf != null) b.withMachineFactory(mf);
            try { b.build(); } catch (WasiExitException e) { if (e.exitCode() != 0) throw e; }
        }
        return out.toByteArray();
    }

    public static void main(String[] a) throws Exception {
        Path d = Path.of(a[0]);
        double secs = Double.parseDouble(a[1]);
        req = Files.readAllBytes(d.resolve("payload/req.json"));
        resp = Files.readAllBytes(d.resolve("payload/resp.json"));
        jsIn = Files.readAllBytes(d.resolve("payload/js-input.json"));
        var rs = Parser.parse(d.resolve("guest-rs.wasm"));
        long t0 = System.nanoTime();
        var rsAot = MachineFactoryCompiler.compile(rs);
        if (System.getenv("JSONLY")==null) {} System.out.printf("Chicory runtime-compile Rust guest: %.1f ms%n", (System.nanoTime() - t0) / 1e6);
        for (var mode : System.getenv("JSONLY")!=null ? new String[0] : (System.getenv("NOINTERP")!=null? new String[] {"compiler"} : new String[] {"compiler", "interpreter"})) {
            Function<Instance, Machine> mf = mode.equals("compiler") ? rsAot : null;
            var inst = rust(rs, mf);
            Files.write(d.resolve("out-rs-endive-" + mode + ".json"), call(inst));
            var noop = inst.export("noop");
            bench("[endive-" + mode + "] Rust-wasm noop export call", secs, () -> noop.apply(1));
            bench("[endive-" + mode + "] Rust-wasm adapter, reused instance", secs, () -> call(inst));
            System.out.printf("[endive-%s] Rust linear memory: %d KB%n", mode, inst.memory().pages() * 64);
            bench("[endive-" + mode + "] Rust-wasm adapter, fresh instance per call", secs, () -> call(rust(rs, mf)));
        }
        for (var f : new String[] {"js-empty.wasm", "js-static-nosimdjson.wasm"}) {
            var jm = Parser.parse(d.resolve(f));
            t0 = System.nanoTime();
            Function<Instance, Machine> jAot = null; try { jAot = MachineFactoryCompiler.compile(jm); } catch (Exception e) { System.out.println("compiler failed: " + e.getMessage()); }
            System.out.printf("Chicory runtime-compile %s: %.1f ms%n", f, (System.nanoTime() - t0) / 1e6);
            final var jA = jAot; if (jA != null) bench("[endive-compiler] Javy " + f + ", fresh instance per call", secs, () -> js(jm, jA));
            if (f.equals("js-static-nosimdjson.wasm")) Files.write(d.resolve("out-js-endive.json"), js(jm, run.endive.simd.SimdInterpreterMachine::new));
            bench("[endive-simd-interpreter] Javy " + f + ", fresh instance per call", secs, () -> js(jm, run.endive.simd.SimdInterpreterMachine::new));
        }
        System.out.printf("JVM heap used at end: %d MB%n", (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) >> 20);
    }
}

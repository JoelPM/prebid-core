import io.roastedroot.quickjs4j.core.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

public class QBench {
    interface Op { void run() throws Exception; }
    static void bench(String name, double secs, Op op) throws Exception {
        long end = System.nanoTime() + (long) (secs * 0.5e9);
        while (System.nanoTime() < end) op.run();
        long n = 0, t0 = System.nanoTime(), now; end = t0 + (long) (secs * 1e9);
        do { op.run(); n++; } while ((now = System.nanoTime()) < end);
        System.out.printf("%-62s %10.2f us/op (n=%d)%n", name, (now - t0) / 1e3 / n, n);
    }
    public static void main(String[] a) throws Exception {
        Path d = Path.of(a[0]);
        double secs = Double.parseDouble(a[1]);
        String lib = Files.readString(d.resolve("js/openx-core.js")) + "\nfunction noop(s) { return s; }\n";
        String input = Files.readString(d.resolve("payload/js-input.json"));
        var inv = Invokables.builder("from_js").add(new GuestFunction("run", List.of(String.class), String.class), new GuestFunction("noop", List.of(String.class), String.class)).build();
        long t0 = System.nanoTime();
        var engine = Engine.builder().addInvokables(inv).build();
        System.out.printf("quickjs4j engine create: %.2f ms%n", (System.nanoTime() - t0) / 1e6);
        byte[] code = engine.compilePortableGuestFunction(lib);
        String out = (String) engine.invokePrecompiledGuestFunction("from_js", "run", List.of(input), code);
        Files.writeString(d.resolve("out-js-quickjs4j.json"), out);
        bench("[quickjs4j/endive-AOT] noop JS fn (same engine)", secs, () -> engine.invokePrecompiledGuestFunction("from_js", "noop", List.of("x"), code));
        bench("[quickjs4j/endive-AOT] OpenX JS port (same engine)", secs, () -> engine.invokePrecompiledGuestFunction("from_js", "run", List.of(input), code));
        bench("[quickjs4j/endive-AOT] OpenX JS port (fresh engine per call)", secs, () -> {
            try (var e = Engine.builder().addInvokables(inv).build()) { e.invokePrecompiledGuestFunction("from_js", "run", List.of(input), code); }
        });
        System.out.printf("JVM heap used at end: %d MB%n", (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) >> 20);
    }
}

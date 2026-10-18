import com.iab.openrtb.request.BidRequest;
import com.iab.openrtb.response.BidResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.Supplier;

/**
 * Narrow follow-up to ../../typed-rust-guest/java/JBench.java (#12) for #13: only the D and E paths and
 * their guest pieces, on Endive guests built different ways. Reuses JBench's paths, checks and timers,
 * so it needs JBench's classes on the classpath.
 *
 * Usage: EBench <payload dir> <mode> <secs per run> [threads]
 *   mode: native                 PBS-Java's OpenxBidder only
 *         runtime:<guest.wasm>   Endive runtime compiler (as #12 measured)
 *         bytecode:<class>       Endive build-time compiled module class (safeBuilder: JVM bytecode)
 *         redline:<class>        same class, builder(): Redline native code if available
 */
public class EBench {

    static final class InstGuest implements JBench.Guest {
        final run.endive.runtime.Instance inst;
        final run.endive.runtime.Memory mem;
        final run.endive.runtime.ExportFunction inBuf, mrTyped, mbAnnot, noop;
        InstGuest(run.endive.runtime.Instance inst) {
            this.inst = inst;
            mem = inst.memory();
            inBuf = inst.export("in_buf");
            mrTyped = inst.export("mr_typed");
            mbAnnot = inst.export("mb_typed_annot");
            noop = inst.export("noop");
        }
        public int inBuf(int n) { return (int) inBuf.apply(n)[0]; }
        public void write(int off, byte[] b) { mem.write(off, b, 0, b.length); }
        public long call(String fn, int n) {
            return switch (fn) {
                case "mr_typed" -> mrTyped.apply(n)[0];
                case "mb_typed_annot" -> mbAnnot.apply(n)[0];
                case "noop" -> noop.apply(n)[0];
                default -> inst.export(fn).apply(n)[0];
            };
        }
        public byte[] read(long pl) { return mem.readBytes((int) (pl >>> 32), (int) pl); }
    }

    static run.endive.runtime.Instance.Builder classBuilder(String cls, String method) throws Exception {
        return (run.endive.runtime.Instance.Builder) Class.forName(cls).getMethod(method).invoke(null);
    }

    public static void main(String[] a) throws Exception {
        Path dir = Path.of(a[0]);
        String mode = a[1];
        double secs = Double.parseDouble(a[2]);
        int threads = a.length > 3 ? Integer.parseInt(a[3]) : 4;
        System.out.printf("%s on %s %s%n", mode, System.getProperty("java.vm.name"), System.getProperty("java.runtime.version"));

        Supplier<JBench.G> newGuest;
        String kind = mode.contains(":") ? mode.substring(0, mode.indexOf(':')) : mode;
        String arg = mode.substring(mode.indexOf(':') + 1);
        switch (kind) {
            case "runtime" -> {
                var m = run.endive.wasm.Parser.parse(Files.readAllBytes(Path.of(arg)));
                var mf = run.endive.compiler.MachineFactoryCompiler.compile(m);
                newGuest = () -> new JBench.G(new InstGuest(run.endive.runtime.Instance.builder(m).withMachineFactory(mf).build()));
            }
            case "bytecode", "redline" -> {
                String method = kind.equals("redline") ? "builder" : "safeBuilder";
                if (kind.equals("redline")) {
                    boolean nat = ((java.util.Optional<?>) Class.forName(arg).getMethod("nativeProvider").invoke(null)).isPresent();
                    System.out.println("Redline native code in use: " + nat);
                }
                newGuest = () -> {
                    try { return new JBench.G(new InstGuest(classBuilder(arg, method).build())); }
                    catch (Exception e) { throw new RuntimeException(e); }
                };
            }
            default -> newGuest = null;
        }

        for (String name : new String[] {"lt", "heavy"}) {
            BidRequest req = JBench.MAPPER.decodeValue(Files.readAllBytes(dir.resolve(name + "-req.json")), BidRequest.class);
            String resp = Files.readString(dir.resolve(name + "-resp.json"));
            System.out.printf("%n== payload %s%n", name);
            JBench.Out want = JBench.nativeRun(req, resp);
            if (newGuest == null) {
                JBench.bench("native PBS-Java OpenxBidder", secs, () -> JBench.nativeRun(req, resp));
                if (name.equals("lt")) JBench.parallel("native PBS-Java OpenxBidder", threads, secs * 2, () -> () -> JBench.nativeRun(req, resp));
                continue;
            }
            JBench.G g = newGuest.get();
            JBench.check("D", want, JBench.typedAnnot(g, req, resp));
            JBench.check("E", want, JBench.projected(g, req, resp));
            System.out.println("  correctness: D and E match OpenxBidder's body and bids");
            JBench.bench("native PBS-Java OpenxBidder (same JVM)", secs, () -> JBench.nativeRun(req, resp));
            JBench.bench("D typed guest, Host parses bids + binary annotations", secs, () -> JBench.typedAnnot(g, req, resp));
            JBench.bench("E as D + response projection", secs, () -> JBench.projected(g, req, resp));
            byte[] rj = JBench.MAPPER.encodeToBytes(req), hdr = JBench.impTable(req.getImp());
            BidResponse pbr = JBench.MAPPER.decodeValue(resp, BidResponse.class);
            byte[] pj = JBench.project(pbr), rb = resp.getBytes(StandardCharsets.UTF_8);
            JBench.bench("guest: mr_typed (incl. write/read)", secs, () -> g.call("mr_typed", g.in(rj)));
            JBench.bench("guest: mb_typed_annot on raw response", secs, () -> g.call("mb_typed_annot", g.in(hdr, rb)));
            JBench.bench("guest: mb_typed_annot on " + pj.length + " B projection", secs, () -> g.call("mb_typed_annot", g.in(hdr, pj)));
            JBench.bench("guest: write request bytes only", secs, () -> g.g.write(g.ptr, rj));
            JBench.bench("noop export call", secs, () -> g.g.call("noop", 1));
            if (name.equals("lt")) {
                Supplier<JBench.G> ng = newGuest;
                JBench.parallel("native PBS-Java OpenxBidder", threads, secs * 2, () -> () -> JBench.nativeRun(req, resp));
                JBench.parallel("E, one instance per thread", threads, secs * 2, () -> { JBench.G tg = ng.get(); return () -> JBench.projected(tg, req, resp); });
            }
        }
    }
}

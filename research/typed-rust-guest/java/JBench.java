import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iab.openrtb.request.BidRequest;
import com.iab.openrtb.request.Imp;
import com.iab.openrtb.response.Bid;
import com.iab.openrtb.response.BidResponse;
import com.iab.openrtb.response.SeatBid;
import java.lang.management.ManagementFactory;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;
import org.prebid.server.bidder.model.BidderBid;
import org.prebid.server.bidder.model.BidderCall;
import org.prebid.server.bidder.model.HttpRequest;
import org.prebid.server.bidder.model.HttpResponse;
import org.prebid.server.bidder.model.Result;
import org.prebid.server.bidder.openx.OpenxBidder;
import org.prebid.server.json.JacksonMapper;
import org.prebid.server.json.ObjectMapperProvider;
import org.prebid.server.proto.openrtb.ext.response.BidType;
import org.prebid.server.proto.openrtb.ext.response.ExtBidPrebid;
import org.prebid.server.proto.openrtb.ext.response.ExtBidPrebidMeta;
import org.prebid.server.proto.openrtb.ext.response.ExtBidPrebidVideo;
import org.prebid.server.util.BidderUtil;
import org.prebid.server.util.HttpUtil;

/**
 * Per-call CPU of a Shared OpenX Adapter on Endive / GraalWasm against PBS-Java's real Hand-written
 * OpenxBidder, end to end in PBS-Java terms: start from the BidRequest POJO the exchange hands a
 * Bidder, end with the HttpRequest and List<BidderBid> OpenxBidder returns.
 *
 * Usage: JBench <payload dir> <guest.wasm> <native|endive|graal> <secs per run> [threads]
 */
public class JBench {
    static final JacksonMapper MAPPER = new JacksonMapper(ObjectMapperProvider.mapper());
    static final OpenxBidder BIDDER = new OpenxBidder("http://127.0.0.1:9000/openx", MAPPER);
    static final String URI = "http://127.0.0.1:9000/openx";

    // ---------- guest instance, one per thread ----------

    interface Guest {
        int inBuf(int n);
        void write(int off, byte[] b);
        long call(String fn, int n);
        byte[] read(long ptrLen);
    }

    static final class EndiveGuest implements Guest {
        final run.endive.runtime.Instance inst;
        final run.endive.runtime.Memory mem;
        final java.util.Map<String, run.endive.runtime.ExportFunction> fns = new java.util.HashMap<>();
        EndiveGuest(run.endive.wasm.WasmModule m, java.util.function.Function<run.endive.runtime.Instance, run.endive.runtime.Machine> mf) {
            inst = run.endive.runtime.Instance.builder(m).withMachineFactory(mf).build();
            mem = inst.memory();
            for (String f : new String[] {"in_buf", "mr_value", "mr_typed", "mb_value", "mb_typed_json", "mb_typed_annot", "noop"}) fns.put(f, inst.export(f));
        }
        public int inBuf(int n) { return (int) fns.get("in_buf").apply(n)[0]; }
        public void write(int off, byte[] b) { mem.write(off, b, 0, b.length); }
        public long call(String fn, int n) { return fns.get(fn).apply(n)[0]; }
        public byte[] read(long pl) { return mem.readBytes((int) (pl >>> 32), (int) pl); }
    }

    static final class GraalGuest implements Guest {
        final org.graalvm.polyglot.Value ex, mem;
        final java.util.Map<String, org.graalvm.polyglot.Value> fns = new java.util.HashMap<>();
        GraalGuest(org.graalvm.polyglot.Value module) {
            ex = module.newInstance().getMember("exports");
            mem = ex.getMember("memory");
            for (String f : new String[] {"in_buf", "mr_value", "mr_typed", "mb_value", "mb_typed_json", "mb_typed_annot", "noop"}) fns.put(f, ex.getMember(f));
        }
        public int inBuf(int n) { return fns.get("in_buf").execute(n).asInt(); }
        // The polyglot API has bulk readBuffer but no bulk write: 8 bytes per call.
        public void write(int off, byte[] b) {
            ByteBuffer bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
            int i = 0;
            for (; i + 8 <= b.length; i += 8) mem.writeBufferLong(ByteOrder.LITTLE_ENDIAN, off + i, bb.getLong(i));
            for (; i < b.length; i++) mem.writeBufferByte(off + i, b[i]);
        }
        public long call(String fn, int n) { return fns.get(fn).execute(n).asLong(); }
        public byte[] read(long pl) {
            byte[] out = new byte[(int) pl];
            mem.readBuffer(pl >>> 32, out, 0, out.length);
            return out;
        }
    }

    /** Guest + its cached input buffer. */
    static final class G {
        final Guest g;
        int ptr, cap;
        G(Guest g) { this.g = g; }
        int in(byte[]... parts) {
            int n = 0;
            for (byte[] p : parts) n += p.length;
            if (n > cap) { ptr = g.inBuf(n); cap = n; }
            int off = ptr;
            for (byte[] p : parts) { g.write(off, p); off += p.length; }
            return n;
        }
        byte[] call(String fn, int n) { return g.read(g.call(fn, n)); }
    }

    // ---------- the paths ----------

    record Out(HttpRequest<BidRequest> req, List<BidderBid> bids) {}

    static Out nativeRun(BidRequest req, String resp) {
        Result<List<HttpRequest<BidRequest>>> r = BIDDER.makeHttpRequests(req);
        HttpRequest<BidRequest> hr = r.getValue().getFirst();
        Result<List<BidderBid>> b = BIDDER.makeBids(BidderCall.succeededHttp(hr, HttpResponse.of(200, HttpUtil.headers(), resp), null), req);
        if (!r.getErrors().isEmpty() || !b.getErrors().isEmpty()) throw new IllegalStateException(r.getErrors() + " " + b.getErrors());
        return new Out(hr, b.getValue());
    }

    static byte[] impTable(List<Imp> imps) {
        int n = 4;
        for (Imp i : imps) n += 3 + i.getId().getBytes(StandardCharsets.UTF_8).length;
        ByteBuffer bb = ByteBuffer.allocate(n).order(ByteOrder.LITTLE_ENDIAN).putInt(imps.size());
        for (Imp i : imps) {
            byte[] id = i.getId().getBytes(StandardCharsets.UTF_8);
            bb.put((byte) ((i.getBanner() != null ? 1 : 0) | (i.getVideo() != null ? 2 : 0) | (i.getXNative() != null ? 4 : 0)));
            bb.putShort((short) id.length).put(id);
        }
        return bb.array();
    }

    static HttpRequest<BidRequest> httpRequest(BidRequest req, byte[] body) {
        return HttpRequest.<BidRequest>builder().method(io.vertx.core.http.HttpMethod.POST).uri(URI).headers(HttpUtil.headers())
                .impIds(BidderUtil.impIds(req)).body(body).payload(req).build();
    }

    static final BidType[] TYPES = {BidType.banner, BidType.video, BidType.xNative};

    /** Builds BidderBids from the Host's own parse plus the guest's annotations, with PBS-Java's
     *  OpenxBidder output conventions (meta under bid.ext.prebid, videoInfo only for video). */
    static List<BidderBid> attachAnnot(BidResponse resp, byte[] a) {
        ByteBuffer bb = ByteBuffer.wrap(a).order(ByteOrder.LITTLE_ENDIAN);
        int n = bb.getInt();
        List<Bid> all = new ArrayList<>(n);
        for (SeatBid sb : resp.getSeatbid()) all.addAll(sb.getBid());
        List<BidderBid> out = new ArrayList<>(n);
        for (Bid bid : all) {
            BidType t = TYPES[bb.get()];
            int dur = (int) bb.getLong();
            byte[] cat = new byte[bb.getShort()];
            bb.get(cat);
            boolean hasMeta = bb.get() == 1;
            long nw = bb.getLong(), adv = bb.getLong(), br = bb.getLong();
            ObjectNode ext = bid.getExt();
            if (hasMeta && ext != null) {
                ExtBidPrebidMeta meta = ExtBidPrebidMeta.builder().networkId((int) nw).advertiserId((int) adv).brandId((int) br).build();
                ext.set("prebid", MAPPER.mapper().valueToTree(ExtBidPrebid.builder().meta(meta).build()));
            }
            out.add(BidderBid.builder().bid(bid.toBuilder().ext(ext).build()).type(t).bidCurrency(null)
                    .videoInfo(t == BidType.video ? ExtBidPrebidVideo.of(dur, cat.length == 0 ? null : new String(cat, StandardCharsets.UTF_8)) : null).build());
        }
        byte[] cur = new byte[bb.getShort()];
        bb.get(cur);
        String c = new String(cur, StandardCharsets.UTF_8);
        for (int i = 0; i < out.size(); i++) out.set(i, out.get(i).toBuilder().bidCurrency(c).build());
        return out;
    }

    /** D: typed guest, Host parses the response itself, guest returns binary annotations. */
    static Out typedAnnot(G g, BidRequest req, String resp) {
        byte[] body = g.call("mr_typed", g.in(MAPPER.encodeToBytes(req)));
        HttpRequest<BidRequest> hr = httpRequest(req, body);
        BidResponse br = MAPPER.decodeValue(resp, BidResponse.class);
        byte[] ann = g.call("mb_typed_annot", g.in(impTable(req.getImp()), resp.getBytes(StandardCharsets.UTF_8)));
        return new Out(hr, attachAnnot(br, ann));
    }

    /** E: as D, but the guest gets only the bid fields OpenX's makeBids reads, re-encoded from the
     *  Host's parse, so adm never crosses the boundary. Same JSON shape, same guest parser. */
    record PBid(String impid, Integer mtype, List<String> cat, Integer dur, ObjectNode ext) {}
    record PSeat(List<PBid> bid) {}
    record PResp(String cur, List<PSeat> seatbid) {}

    static byte[] project(BidResponse br) {
        List<PSeat> seats = new ArrayList<>(br.getSeatbid().size());
        for (SeatBid sb : br.getSeatbid()) {
            List<PBid> bids = new ArrayList<>(sb.getBid().size());
            for (Bid b : sb.getBid()) bids.add(new PBid(b.getImpid(), b.getMtype(), b.getCat(), b.getDur(), b.getExt()));
            seats.add(new PSeat(bids));
        }
        return MAPPER.encodeToBytes(new PResp(br.getCur(), seats));
    }

    static Out projected(G g, BidRequest req, String resp) {
        byte[] body = g.call("mr_typed", g.in(MAPPER.encodeToBytes(req)));
        HttpRequest<BidRequest> hr = httpRequest(req, body);
        BidResponse br = MAPPER.decodeValue(resp, BidResponse.class);
        byte[] ann = g.call("mb_typed_annot", g.in(impTable(req.getImp()), project(br)));
        return new Out(hr, attachAnnot(br, ann));
    }

    // JSON bids output of the Value guest (B) and typed-json guest (C).
    public static final class JBid {
        @JsonProperty("bid") public Bid bid;
        @JsonProperty("type") public String type;
        @JsonProperty("video") public JsonNode video;
        @JsonProperty("meta") public JsonNode meta;
    }
    public static final class JOut {
        @JsonProperty("bids") public List<JBid> bids;
        @JsonProperty("cur") public String cur;
    }

    static List<BidderBid> decodeJson(byte[] out) {
        JOut j;
        try { j = MAPPER.mapper().readValue(out, JOut.class); } catch (Exception e) { throw new RuntimeException(e); }
        List<BidderBid> bids = new ArrayList<>(j.bids.size());
        for (JBid b : j.bids) {
            BidType t = "video".equals(b.type) ? BidType.video : "native".equals(b.type) ? BidType.xNative : BidType.banner;
            ObjectNode ext = b.bid.getExt();
            if (b.meta != null && !b.meta.isNull() && ext != null) {
                ExtBidPrebidMeta meta = ExtBidPrebidMeta.builder().networkId(b.meta.get("networkId").asInt()).advertiserId(b.meta.get("advertiserId").asInt()).brandId(b.meta.get("brandId").asInt()).build();
                ext.set("prebid", MAPPER.mapper().valueToTree(ExtBidPrebid.builder().meta(meta).build()));
            }
            String cat = b.video.get("primary_category").asText();
            bids.add(BidderBid.builder().bid(b.bid.toBuilder().ext(ext).build()).type(t).bidCurrency(j.cur)
                    .videoInfo(t == BidType.video ? ExtBidPrebidVideo.of(b.video.get("duration").asInt(), cat.isEmpty() ? null : cat) : null).build());
        }
        return bids;
    }

    static Out jsonOut(G g, String mr, String mb, BidRequest req, String resp) {
        byte[] body = g.call(mr, g.in(MAPPER.encodeToBytes(req)));
        byte[] out = g.call(mb, g.in(impTable(req.getImp()), resp.getBytes(StandardCharsets.UTF_8)));
        return new Out(httpRequest(req, body), decodeJson(out));
    }

    // ---------- correctness ----------

    /** Semantic body compare. PBS-Java's OpenxBidder sets video.ext.rewarded from
     *  imp.ext.prebid.is_rewarded_inventory while the guest (a PBS-Go port) uses imp.rwdd, so
     *  imp[].video.ext is dropped from both sides before comparing; OpenxBidder also keeps an empty
     *  imp.ext ({}) where PBS-Go omits it, so empty imp.ext is dropped too. */
    static void check(String name, Out want, Out got) throws Exception {
        JsonNode w = MAPPER.mapper().readTree(want.req().getBody()), g = MAPPER.mapper().readTree(got.req().getBody());
        for (JsonNode n : List.of(w, g)) for (JsonNode imp : n.path("imp")) {
            if (imp.has("video")) ((ObjectNode) imp.get("video")).remove("ext");
            if (imp.path("ext").isEmpty()) ((ObjectNode) imp).remove("ext");
        }
        String wb = MAPPER.encodeToString(want.bids()), gb = MAPPER.encodeToString(got.bids());
        if (!w.equals(g) || !wb.equals(gb)) {
            System.out.println("  MISMATCH " + name + "\n   want " + w + "\n   got  " + g + "\n   want " + wb + "\n   got  " + gb);
            System.exit(1);
        }
    }

    // ---------- measurement ----------

    interface Op { void run() throws Exception; }

    static double bench(String name, double secs, Op op) throws Exception {
        long end = System.nanoTime() + (long) (secs * 1e9);
        while (System.nanoTime() < end) op.run(); // warm-up
        double[] r = new double[5];
        for (int k = 0; k < r.length; k++) {
            long n = 0, t0 = System.nanoTime(), now;
            end = t0 + (long) (secs * 1e9 / 2);
            do { op.run(); n++; } while ((now = System.nanoTime()) < end);
            r[k] = (now - t0) / 1e3 / n;
        }
        double[] s = r.clone();
        Arrays.sort(s);
        System.out.printf("  %-66s %8.2f us/op  (min %.2f max %.2f)%n", name, s[2], s[0], s[4]);
        return s[2];
    }

    /** p threads, one guest per thread (as PBS-Java would per event loop); process CPU per op.
     *  Three windows on the same threads after a warm-up; reports the median. */
    static void parallel(String name, int p, double secs, Supplier<Op> perThread) throws Exception {
        var os = (com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
        AtomicLong ops = new AtomicLong();
        long warmEnd = System.nanoTime() + (long) (secs * 1e9 / 2), stop = warmEnd + (long) (secs * 1e9) * 3;
        Thread[] ts = new Thread[p];
        for (int i = 0; i < p; i++) {
            ts[i] = new Thread(() -> {
                try {
                    Op op = perThread.get();
                    while (System.nanoTime() < warmEnd) op.run();
                    while (System.nanoTime() < stop) { op.run(); ops.incrementAndGet(); }
                } catch (Exception e) { throw new RuntimeException(e); }
            });
            ts[i].start();
        }
        while (System.nanoTime() < warmEnd) Thread.sleep(1);
        double[] r = new double[3];
        for (int k = 0; k < 3; k++) {
            long o0 = ops.get(), c0 = os.getProcessCpuTime();
            Thread.sleep((long) (secs * 1000) - 5);
            r[k] = (os.getProcessCpuTime() - c0) / 1e3 / (ops.get() - o0);
        }
        for (Thread t : ts) t.join();
        double[] s = r.clone();
        Arrays.sort(s);
        System.out.printf("  %-66s p=%-2d %8.2f us CPU/op  (runs %.2f %.2f %.2f)%n", name, p, s[1], r[0], r[1], r[2]);
    }

    public static void main(String[] a) throws Exception {
        Path dir = Path.of(a[0]);
        byte[] wasm = Files.readAllBytes(Path.of(a[1]));
        String rt = a[2];
        double secs = Double.parseDouble(a[3]);
        int threads = a.length > 4 ? Integer.parseInt(a[4]) : 4;
        System.out.printf("%s on %s %s%n", rt, System.getProperty("java.vm.name"), System.getProperty("java.runtime.version"));

        Supplier<G> newGuest;
        switch (rt) {
            case "endive" -> {
                var m = run.endive.wasm.Parser.parse(wasm);
                long t0 = System.nanoTime();
                var mf = run.endive.compiler.MachineFactoryCompiler.compile(m);
                System.out.printf("Endive runtime compile: %.0f ms%n", (System.nanoTime() - t0) / 1e6);
                newGuest = () -> new G(new EndiveGuest(m, mf));
            }
            case "graal" -> {
                var engine = org.graalvm.polyglot.Engine.newBuilder().option("engine.WarnInterpreterOnly", "false").build();
                var src = org.graalvm.polyglot.Source.newBuilder("wasm", org.graalvm.polyglot.io.ByteSequence.create(wasm), "guest").build();
                // A polyglot Context is single-threaded by default: one Context per thread.
                newGuest = () -> {
                    var c = org.graalvm.polyglot.Context.newBuilder("wasm").engine(engine).build();
                    return new G(new GraalGuest(c.eval(src)));
                };
            }
            default -> newGuest = null;
        }

        for (String name : new String[] {"lt", "heavy"}) {
            BidRequest req = MAPPER.decodeValue(Files.readAllBytes(dir.resolve(name + "-req.json")), BidRequest.class);
            String resp = Files.readString(dir.resolve(name + "-resp.json"));
            System.out.printf("%n== payload %s (request %d B as PBS-Java serializes it, response %d B)%n", name, MAPPER.encodeToBytes(req).length, resp.length());
            Out want = nativeRun(req, resp);
            if (newGuest == null) {
                bench("native PBS-Java OpenxBidder (makeHttpRequests + makeBids)", secs, () -> nativeRun(req, resp));
                bench("Host: mapper.encodeToBytes(request)", secs, () -> MAPPER.encodeToBytes(req));
                bench("Host: mapper.decodeValue(response, BidResponse.class)", secs, () -> MAPPER.decodeValue(resp, BidResponse.class));
                continue;
            }
            G g = newGuest.get();
            check("B", want, jsonOut(g, "mr_value", "mb_value", req, resp));
            check("C", want, jsonOut(g, "mr_typed", "mb_typed_json", req, resp));
            check("D", want, typedAnnot(g, req, resp));
            check("E", want, projected(g, req, resp));
            System.out.println("  correctness: B, C, D and E match OpenxBidder's body and bids");
            bench("native PBS-Java OpenxBidder (same JVM)", secs, () -> nativeRun(req, resp));
            bench("B lean ABI, Value guest, JSON bids out", secs, () -> jsonOut(g, "mr_value", "mb_value", req, resp));
            bench("C lean ABI, typed guest, JSON bids out", secs, () -> jsonOut(g, "mr_typed", "mb_typed_json", req, resp));
            bench("D lean ABI, typed guest, Host parses bids + binary annotations", secs, () -> typedAnnot(g, req, resp));
            bench("E as D, but guest gets a projection of the parsed response", secs, () -> projected(g, req, resp));
            System.out.println(" breakdown of D and E (guest pieces include writing input and reading output):");
            byte[] rj = MAPPER.encodeToBytes(req), hdr = impTable(req.getImp()), rb = resp.getBytes(StandardCharsets.UTF_8);
            bench("guest: mr_typed", secs, () -> g.call("mr_typed", g.in(rj)));
            bench("guest: mb_typed_annot", secs, () -> g.call("mb_typed_annot", g.in(hdr, rb)));
            bench("guest: write request bytes only", secs, () -> g.g.write(g.ptr, rj));
            BidResponse pbr = MAPPER.decodeValue(resp, BidResponse.class);
            byte[] pj = project(pbr);
            bench("E Host: project parsed response", secs, () -> project(pbr));
            bench("E guest: mb_typed_annot on " + pj.length + " B projection", secs, () -> g.call("mb_typed_annot", g.in(hdr, pj)));
            bench("guest: mr_value", secs, () -> g.call("mr_value", g.in(rj)));
            bench("guest: mb_value", secs, () -> g.call("mb_value", g.in(hdr, rb)));
            bench("noop export call", secs, () -> g.g.call("noop", 1));
            if (name.equals("lt")) {
                System.out.println(" one guest per thread, process CPU per call (incl. GC/JIT):");
                parallel("native PBS-Java OpenxBidder", threads, secs * 2, () -> () -> nativeRun(req, resp));
                parallel("D, one instance per thread", threads, secs * 2, () -> { G tg = newGuest.get(); return () -> typedAnnot(tg, req, resp); });
                parallel("E, one instance per thread", threads, secs * 2, () -> { G tg = newGuest.get(); return () -> projected(tg, req, resp); });
            }
        }
        if (newGuest == null) {
            BidRequest req = MAPPER.decodeValue(Files.readAllBytes(dir.resolve("lt-req.json")), BidRequest.class);
            String resp = Files.readString(dir.resolve("lt-resp.json"));
            System.out.println("\n one thread per core-ish, process CPU per call (incl. GC/JIT), payload lt:");
            parallel("native PBS-Java OpenxBidder", threads, secs * 2, () -> () -> nativeRun(req, resp));
        }
    }
}

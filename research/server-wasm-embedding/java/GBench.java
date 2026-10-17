import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import org.graalvm.polyglot.*;
import org.graalvm.polyglot.io.ByteSequence;

public class GBench {
    interface Op { void run() throws Exception; }
    static void bench(String name, double secs, Op op) throws Exception {
        long end = System.nanoTime() + (long) (secs * 0.5e9);
        while (System.nanoTime() < end) op.run();
        long n = 0, t0 = System.nanoTime(), now; end = t0 + (long) (secs * 1e9);
        do { op.run(); n++; } while ((now = System.nanoTime()) < end);
        System.out.printf("%-62s %10.2f us/op (n=%d)%n", name, (now - t0) / 1e3 / n, n);
    }
    static byte[] req, resp;
    static final ObjectMapper M = new ObjectMapper();

    // Native Java baseline: OpenX adapter logic over Jackson trees (PBS-Java uses Jackson).
    static byte[] nativeRun() throws Exception {
        JsonNode r = M.readTree(req);
        ObjectNode out = ((ObjectNode) r).deepCopy();
        ObjectNode ext = M.createObjectNode().put("bc", "hb_pbs_1.0.0");
        ArrayNode imps = M.createArrayNode();
        for (JsonNode src : r.path("imp")) {
            if (!src.has("banner") && !src.has("video") && !src.has("native")) continue;
            ObjectNode imp = ((ObjectNode) src).deepCopy();
            ObjectNode iext = (ObjectNode) imp.path("ext");
            JsonNode ox = iext.path("bidder");
            if (ox.has("delDomain")) ext.set("delDomain", ox.get("delDomain"));
            if (ox.has("platform")) ext.set("platform", ox.get("platform"));
            imp.put("tagid", ox.path("unit").asText());
            if (imp.path("bidfloor").asDouble(0) == 0 && ox.path("customFloor").asDouble(0) > 0) imp.put("bidfloor", ox.path("customFloor").asDouble());
            ObjectNode oext = iext.deepCopy(); oext.remove("prebid"); oext.remove("bidder");
            if (ox.has("customParams")) oext.set("customParams", ox.get("customParams"));
            if (oext.isEmpty()) imp.remove("ext"); else imp.set("ext", oext);
            if (imp.has("video")) { ObjectNode v = (ObjectNode) imp.get("video"); if (imp.path("rwdd").asInt() == 1) v.set("ext", M.createObjectNode().put("rewarded", 1)); else v.remove("ext"); }
            imps.add(imp);
        }
        out.set("imp", imps); out.set("ext", ext);
        String body = M.writeValueAsString(out);
        JsonNode br = M.readTree(resp);
        ArrayNode bids = M.createArrayNode();
        for (JsonNode sb : br.path("seatbid")) for (JsonNode bid : sb.path("bid")) {
            int mt = bid.path("mtype").asInt();
            ObjectNode tb = M.createObjectNode(); tb.set("bid", bid);
            tb.put("type", mt == 1 ? "banner" : mt == 2 ? "video" : mt == 4 ? "native" : "banner");
            tb.set("video", M.createObjectNode().put("primary_category", bid.path("cat").path(0).asText("")).put("duration", bid.path("dur").asInt()));
            long buyer = bid.path("ext").path("buyer_id").asLong(0), dsp = bid.path("ext").path("dsp_id").asLong(0), brand = bid.path("ext").path("brand_id").asLong(0);
            if (buyer > 0 || dsp > 0 || brand > 0) tb.set("meta", M.createObjectNode().put("networkId", dsp).put("advertiserId", buyer).put("brandId", brand)); else tb.putNull("meta");
            bids.add(tb);
        }
        ObjectNode res = M.createObjectNode(); res.put("body", body); res.set("bids", bids); res.put("cur", br.path("cur").asText("USD"));
        return M.writeValueAsBytes(res);
    }

    static void write(Value mem, long p, byte[] b) {
        int i = 0;
        for (; i + 8 <= b.length; i += 8) {
            long v = 0; for (int k = 7; k >= 0; k--) v = (v << 8) | (b[i + k] & 0xff);
            mem.writeBufferLong(ByteOrder.LITTLE_ENDIAN, p + i, v);
        }
        for (; i < b.length; i++) mem.writeBufferByte(p + i, b[i]);
    }
    static byte[] call(Value ex) {
        Value mem = ex.getMember("memory");
        long rp = ex.getMember("alloc").execute(req.length).asLong() & 0xffffffffL;
        long sp = ex.getMember("alloc").execute(resp.length).asLong() & 0xffffffffL;
        write(mem, rp, req); write(mem, sp, resp);
        long o = ex.getMember("adapt").execute((int) rp, req.length, (int) sp, resp.length).asLong();
        byte[] out = new byte[(int) o];
        mem.readBuffer(o >>> 32, out, 0, out.length);
        ex.getMember("dealloc").execute((int) rp, req.length);
        ex.getMember("dealloc").execute((int) sp, resp.length);
        return out;
    }

    public static void main(String[] a) throws Exception {
        Path d = Path.of(a[0]); double secs = Double.parseDouble(a[1]);
        req = Files.readAllBytes(d.resolve("payload/req.json")); resp = Files.readAllBytes(d.resolve("payload/resp.json"));
        if (a.length > 2) { Files.write(d.resolve("out-java-native.json"), nativeRun()); bench("native Java (Jackson tree) OpenX port", secs, GBench::nativeRun); return; }
        var engine = Engine.newBuilder().option("engine.WarnInterpreterOnly", "false").build();
        var src = Source.newBuilder("wasm", ByteSequence.create(Files.readAllBytes(d.resolve("guest-rs.wasm"))), "guest").build();
        long t0 = System.nanoTime();
        var ctx = Context.newBuilder("wasm").engine(engine).build();
        Value module = ctx.eval(src);
        Value ex = module.newInstance().getMember("exports");
        System.out.printf("GraalWasm context+instantiate: %.1f ms%n", (System.nanoTime() - t0) / 1e6);
        Files.write(d.resolve("out-rs-graalwasm.json"), call(ex));
        Value noop = ex.getMember("noop");
        bench("[graalwasm] Rust-wasm noop export call", secs, () -> noop.execute(1));
        bench("[graalwasm] Rust-wasm adapter, reused instance", secs, () -> call(ex));
        bench("[graalwasm] Rust-wasm adapter, fresh instance per call (shared engine)", secs, () -> call(module.newInstance().getMember("exports")));
    }
}

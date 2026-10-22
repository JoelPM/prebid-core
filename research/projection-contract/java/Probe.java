// PBS-Java probe: each case decoded the way PBS-Java decodes it, then re-encoded with the same mapper.
// The re-encoding is what a struct projection from Jackson's model can carry (NON_NULL inclusion).
//   model:  the bytes as a String (BasicHttpClient: body.toString(UTF_8)), mapper.readValue into the
//           model, as OpenxBidder.makeBids does with BidResponse.class.
//   objext: responses only, decoded into BidResponseObjectExt (response.ext kept as an ObjectNode), the
//           model a Shared Adapter Host binding would need for resp.ext reads.
//   exact:  objext, decoded by a copy of the mapper with exact numbers in trees (EXACT below).
// The mapper is configured as org.prebid.server.json.ObjectMapperProvider (JavaTimeModule,
// ZonedDateTimeModule and LongAdderModule left out: no field here uses those types).
// Usage: java -cp <jackson jars>:. Probe <cases dir>   (one JSON line per case; bodies base64)
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.module.blackbird.BlackbirdModule;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class Probe {
    // org.prebid.server.json.MissingJsonNodeModule
    static class MissingJsonNodeModule extends SimpleModule {
        MissingJsonNodeModule() { addDeserializer(JsonNode.class, new D()); }
        static class D extends com.fasterxml.jackson.databind.deser.std.JsonNodeDeserializer {
            @Override public JsonNode getNullValue(DeserializationContext ctxt) { return null; }
        }
    }

    static final ObjectMapper MAPPER = JsonMapper.builder().configure(MapperFeature.DEFAULT_VIEW_INCLUSION, false)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            .configure(DeserializationFeature.ACCEPT_SINGLE_VALUE_AS_ARRAY, true)
            .enable(JsonGenerator.Feature.WRITE_BIGDECIMAL_AS_PLAIN)
            .enable(StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION)
            .build()
            .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .setSerializationInclusion(JsonInclude.Include.NON_NULL)
            .registerModule(new BlackbirdModule())
            .registerModule(new MissingJsonNodeModule());

    // A binding-specific mapper for the projection decode: the same, but exact numbers in JSON trees
    // (ObjectNode members keep BigDecimal / BigInteger values instead of doubles).
    static final ObjectMapper EXACT = MAPPER.copy()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .setNodeFactory(com.fasterxml.jackson.databind.node.JsonNodeFactory.withExactBigDecimals(true));

    static String b64(byte[] b) { return Base64.getEncoder().encodeToString(b); }
    static String q(String s) {
        return MAPPER.getNodeFactory().textNode(s).toString();
    }
    static String enc(Object o) {
        try { return b64(MAPPER.writeValueAsBytes(o)); } catch (Exception e) { return null; }
    }
    static String err(Exception e) { return e.getMessage().split("\n")[0]; }

    public static void main(String[] args) throws Exception {
        for (String kind : List.of("resp", "req")) {
            List<Path> files = new ArrayList<>();
            try (var s = Files.newDirectoryStream(Path.of(args[0], kind), "*.json")) { s.forEach(files::add); }
            files.sort(Comparator.comparing(Path::toString));
            for (Path f : files) {
                String body = new String(Files.readAllBytes(f), StandardCharsets.UTF_8);
                String name = f.getFileName().toString().replace(".json", "");
                StringBuilder out = new StringBuilder("{\"case\":" + q(name) + ",\"kind\":" + q(kind));
                Class<?> model = kind.equals("resp") ? Model.BidResponse.class : Model.BidRequest.class;
                try {
                    String m = enc(MAPPER.readValue(body, model));
                    out.append(",\"model\":").append(q(m));
                } catch (Exception e) {
                    out.append(",\"err\":").append(q(err(e)));
                }
                if (kind.equals("resp")) {
                    try {
                        String m = enc(MAPPER.readValue(body, Model.BidResponseObjectExt.class));
                        out.append(",\"objext\":").append(q(m));
                    } catch (Exception e) {
                        out.append(",\"objextErr\":").append(q(err(e)));
                    }
                    try {
                        String m = b64(EXACT.writeValueAsBytes(EXACT.readValue(body, Model.BidResponseObjectExt.class)));
                        out.append(",\"exact\":").append(q(m));
                    } catch (Exception e) {
                        out.append(",\"exactErr\":").append(q(err(e)));
                    }
                }
                System.out.println(out.append("}"));
            }
        }
    }
}

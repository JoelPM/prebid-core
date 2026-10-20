// PBS-Java's validator, networknt json-schema-validator 1.5.6 forced to V4 (as BidderParamValidator does),
// on {"type":"string","pattern":p}, each string parsed by Jackson from JSON text.
// java -cp "$(cat cp.txt)" Java.java cases.json > out/java.json
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import com.networknt.schema.*;
import java.nio.file.*;
import java.util.*;

public class Java {
  public static void main(String[] a) throws Exception {
    ObjectMapper m = new ObjectMapper();
    JsonNode cases = m.readTree(Files.readString(Path.of(a[0])));
    JsonSchemaFactory f = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V4);
    List<String> pats = new ArrayList<>();
    cases.get("catalogue").forEach(n -> pats.add(n.asText()));
    cases.get("probes").forEach(n -> pats.add(n.asText()));
    ObjectNode results = m.createObjectNode();
    for (String p : pats) {
      ObjectNode r = results.putObject(p);
      try {
        ObjectNode sch = m.createObjectNode().put("type", "string").put("pattern", p);
        JsonSchema s = f.getSchema(sch);
        StringBuilder sb = new StringBuilder();
        for (JsonNode str : cases.get("strings")) {
          JsonNode doc = m.readTree(m.writeValueAsString(str.asText()));
          sb.append(s.validate(doc).isEmpty() ? '1' : '0');
        }
        r.put("m", sb.toString());
      } catch (Exception e) {
        String msg = String.valueOf(e.getMessage());
        r.put("error", e.getClass().getSimpleName() + ": " + msg.lines().findFirst().orElse(""));
      }
    }
    System.out.println(m.writeValueAsString(m.createObjectNode().put("engine", "networknt 1.5.6 V4 (java.util.regex find(), JDK " + System.getProperty("java.version") + ")").set("results", results)));
  }
}

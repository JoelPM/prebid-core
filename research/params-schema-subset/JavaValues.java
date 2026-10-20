// PBS-Java's validator (networknt 1.5.6, V4) on values.json; instances parsed by Jackson's default
// ObjectMapper number handling, which PBS-Java's mapper keeps (floats become DoubleNode).
// java -cp "$(cat cp.txt)" JavaValues.java values.json > out/values-java.json
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import com.networknt.schema.*;
import java.nio.file.*;
import java.util.*;

public class JavaValues {
  public static void main(String[] a) throws Exception {
    ObjectMapper m = new ObjectMapper();
    JsonSchemaFactory f = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V4);
    ObjectNode out = m.createObjectNode();
    for (JsonNode c : m.readTree(Files.readString(Path.of(a[0])))) {
      ArrayNode res = out.putArray(c.get("name").asText());
      JsonSchema s;
      try {
        s = f.getSchema(c.has("schemaFile") ? m.readTree(Files.readString(Path.of(c.get("schemaFile").get("java").asText())))
            : c.has("schemaRaw") ? m.readTree(c.get("schemaRaw").asText()) : c.get("schema"));
      } catch (Exception e) { res.add("schema error: " + e.getMessage()); continue; }
      for (JsonNode inst : c.get("instances")) {
        try {
          JsonNode doc = m.readTree(inst.asText());
          Set<ValidationMessage> v = s.validate(doc);
          res.add(v.isEmpty() ? "valid" : "invalid: " + String.join("; ", v.stream().map(ValidationMessage::getMessage).toList())
              + "  [parsed as " + doc.getNodeType() + " " + (doc.isNumber() ? doc.getClass().getSimpleName() + " " + doc.asText() : "") + "]");
        } catch (Exception e) { res.add("error: " + e.getClass().getSimpleName() + ": " + String.valueOf(e.getMessage()).lines().findFirst().orElse("")); }
      }
    }
    System.out.println(m.writeValueAsString(out));
  }
}

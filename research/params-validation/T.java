import com.fasterxml.jackson.databind.*;
import com.networknt.schema.*;
import java.nio.file.*;
public class T {
  public static void main(String[] a) throws Exception {
    ObjectMapper m = new ObjectMapper();
    String dir = "/Users/joel.meyer/Developer/work/prebid/prebid-server-java/src/main/resources/static/bidder-params/";
    JsonSchemaFactory f = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V4);
    String[][] cases = {
      {"openx","{\"unit\":1.5,\"delDomain\":\"a.openx.net\"}"},
      {"openx","{\"unit\":-1,\"delDomain\":\"a.openx.net\"}"},
      {"openx","{\"unit\":\"abc\",\"delDomain\":\"a.openx.net\"}"},
      {"openx","{\"unit\":\"1\",\"delDomain\":\"openx\"}"},
      {"openx","{\"unit\":\"1\",\"platform\":\"not-a-uuid\"}"},
      {"openx","{\"unit\":\"1\",\"platform\":\"8DB4A3B2-3D24-4F71-9C34-6A5B6C3D2E10\"}"},
      {"openx","{\"unit\":\"1\"}"},
      {"pubmatic","{\"publisherId\":\"1\",\"wrapper\":{\"profile\":\"5\"}}"},
      {"pubmatic","{\"publisherId\":156209}"},
    };
    for (String[] c : cases) {
      JsonSchema s = f.getSchema(m.readTree(Files.readString(Path.of(dir + c[0] + ".json"))));
      System.out.println(c[0] + " " + c[1] + " => " + s.validate(m.readTree(c[1])));
    }
    // Jackson coercion as PBS-Java's mapper (defaults + FAIL_ON_UNKNOWN_PROPERTIES=false)
    record W(Integer profile, Integer version) {}
    m.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    System.out.println("convertValue {profile:\"5\"} -> " + m.convertValue(m.readTree("{\"profile\":\"5\"}"), W.class));
    try { System.out.println("convertValue {profile:5.5} -> " + m.convertValue(m.readTree("{\"profile\":5.5}"), W.class)); } catch (Exception e) { System.out.println("5.5 -> " + e.getClass().getSimpleName()); }
    try { System.out.println("convertValue {profile:\"x\"} -> " + m.convertValue(m.readTree("{\"profile\":\"x\"}"), W.class)); } catch (Exception e) { System.out.println("\"x\" -> " + e.getClass().getSimpleName()); }
  }
}

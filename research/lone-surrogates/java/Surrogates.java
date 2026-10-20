// What PBS-Java's JSON path does with each case in ../cases.tsv.
// PBS-Java decodes the HTTP body to a String as UTF-8 first (Vert.x body().asString() for the
// auction request, body.toString(UTF_8) for bidder responses), then Jackson reads the String.
// Outgoing bidder requests are written with ObjectMapper.writeValueAsBytes (BidderUtil).
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HexFormat;

public class Surrogates {
    static String units(String s) {
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            b.append(c >= 0x20 && c < 0x7f ? String.valueOf(c) : String.format("<%04x>", (int) c));
        }
        return b.append("]").toString();
    }

    static String show(byte[] bs) {
        StringBuilder b = new StringBuilder();
        for (byte x : bs) {
            int c = x & 0xff;
            b.append(c >= 0x20 && c < 0x7f ? String.valueOf((char) c) : String.format("\\x%02x", c));
        }
        return b.toString();
    }

    /** PBS-Java PubmaticBidder.resolveNativeAdm (PubmaticBidder.java:616): readTree(adm).get("native").toString(). */
    static void adm(ObjectMapper m) throws Exception {
        for (String line : Files.readAllLines(Path.of("../adm.tsv"))) {
            String[] p = line.split("\t");
            byte[] doc = HexFormat.of().parseHex(p[1]);
            com.fasterxml.jackson.databind.node.ObjectNode bid =
                    (com.fasterxml.jackson.databind.node.ObjectNode) m.readTree(new String(doc, StandardCharsets.UTF_8));
            String nat = m.readTree(bid.get("adm").textValue()).get("native").toString();
            System.out.println("== adm " + p[0] + "\n  in  " + show(doc) + "\n  native.toString() " + units(nat));
            bid.put("adm", nat);
            System.out.println("  out " + show(m.writeValueAsBytes(bid)));
        }
    }

    public static void main(String[] args) throws Exception {
        ObjectMapper m = new ObjectMapper();
        adm(m);
        for (String line : Files.readAllLines(Path.of("../cases.tsv"))) {
            String[] p = line.split("\t");
            byte[] doc = HexFormat.of().parseHex(p[1]);
            System.out.println("== " + p[0] + "  " + show(doc));
            String body = new String(doc, StandardCharsets.UTF_8);
            System.out.println("  body as UTF-8 String         " + units(body));
            try {
                JsonNode n = m.readTree(body);
                String s = n.get("s").textValue();
                System.out.println("  readTree(String) text        " + units(s));
                try {
                    System.out.println("  writeValueAsBytes            " + show(m.writeValueAsBytes(n)));
                } catch (Exception e) {
                    System.out.println("  writeValueAsBytes            ERR " + e.getMessage().split("\n")[0]);
                }
                System.out.println("  writeValueAsString→UTF-8     " + show(m.writeValueAsString(n).getBytes(StandardCharsets.UTF_8)));
            } catch (Exception e) {
                System.out.println("  readTree(String)             ERR " + e.getMessage().split("\n")[0]);
            }
            try {
                JsonNode n = m.readTree(doc);
                System.out.println("  readTree(byte[]) text        " + units(n.get("s").textValue()));
            } catch (Exception e) {
                System.out.println("  readTree(byte[])             ERR " + e.getMessage().split("\n")[0]);
            }
        }
    }
}

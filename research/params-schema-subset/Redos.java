// java Redos.java : times feedad's pattern as networknt calls it (Pattern.compile(p).matcher(s).find()).
import java.util.regex.*;
public class Redos {
  public static void main(String[] a) {
    Pattern p = Pattern.compile("^(([a-z0-9])+[-_]?)+$");
    for (int n : new int[] {16, 20, 22, 24, 26}) {
      String s = "a".repeat(n) + "!";
      long t = System.nanoTime(); p.matcher(s).find();
      System.out.printf("java n=%d: %.1f ms%n", n, (System.nanoTime() - t) / 1e6);
    }
  }
}

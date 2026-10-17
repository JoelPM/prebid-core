const wr = (Javy.IO && Javy.IO.writeSync) ? Javy.IO.writeSync : Javy.writeSync;
try { const o = JSON.parse('{"x":[1,2,3],"y":"z"}'); wr(1, new TextEncoder().encode("parsed " + o.y + "\n")); } catch (e) { wr(1, new TextEncoder().encode("ERR " + e + "\n")); }

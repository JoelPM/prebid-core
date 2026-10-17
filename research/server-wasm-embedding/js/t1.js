const wr = (Javy.IO && Javy.IO.writeSync) ? Javy.IO.writeSync : Javy.writeSync;
wr(1, new TextEncoder().encode(JSON.stringify({a:[1,2,{b:"x"}]}) + "\n"));

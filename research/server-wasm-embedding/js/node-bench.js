const fs = require("fs");
eval(fs.readFileSync(__dirname + "/openx-core.js", "utf8"));
const input = fs.readFileSync(process.argv[2], "utf8");
fs.writeFileSync("out-js-node.json", run(input));
for (let i = 0; i < 20000; i++) run(input);
const N = 50000, t = process.hrtime.bigint();
for (let i = 0; i < N; i++) run(input);
console.log("node/V8 OpenX JS port:", (Number(process.hrtime.bigint() - t) / N / 1000).toFixed(1), "us/op");

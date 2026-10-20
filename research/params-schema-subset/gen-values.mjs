// Writes values.json: schemas and raw-JSON instances (raw, so number lexemes like 5.0 survive) for the
// format / number / length / combinator matrix. A case carries `schema` or, to keep a number lexeme, `schemaRaw`. node gen-values.mjs > values.json
const q = s => JSON.stringify(s);
// n-character hostname of 49-character labels, so only the total length is in question
const host = n => Array.from({ length: Math.ceil(n / 50) + 1 }, () => "a".repeat(49)).join(".").slice(0, n).replace(/\.$/, "a");
const S = (name, schema, instances) => ({ name, schema: { $schema: "http://json-schema.org/draft-04/schema#", ...schema }, instances });
const uuid = "8db4a3b2-3d24-4f71-9c34-6a5b6c3d2e10";
const cases = [
  S("format uuid", { type: "string", format: "uuid" }, [
    uuid, uuid.toUpperCase(), "8db4a3b2-3D24-4f71-9c34-6a5b6c3d2e10", `{${uuid}}`, `urn:uuid:${uuid}`, uuid.replace(/-/g, ""),
    "00000000-0000-0000-0000-000000000000", "8db4a3b2-3d24-0f71-1c34-6a5b6c3d2e10", uuid + "\n", uuid + "0", "8db4a3b2-3d24-4f71-9c34-6a5b6c3d2e1g",
    "８db4a3b2-3d24-4f71-9c34-6a5b6c3d2e10",
  ].map(q)),
  S("format hostname", { type: "string", format: "hostname" }, [
    "a.openx.net", "A.OPENX.NET", "a.openx.net.", "-a.com", "a-.com", "a_b.com", "a..b", "", "localhost", "123", "1.2.3.4",
    "xn--bcher-kva.com", "bücher.com", "a.openx.net\n", "a".repeat(63) + ".com", "a".repeat(64) + ".com",
    host(253), host(255), host(256), host(300),
  ].map(q)),
  S("type integer", { type: "integer" }, ["5", "5.0", "5e0", "5E+0", "50e-1", "-0", "-0.0", "1e400", "9007199254740993", "18446744073709551616", "1.5", "1e-400"]),
  S("integer minimum 0", { type: "integer", minimum: 0 }, ["0", "-0", "-1", "18446744073709551616", "-18446744073709551616"]),
  S("number minimum 0", { type: "number", minimum: 0 }, ["0", "-0", "-0.0", "-1e-400", "1e400", "-1e400", "-5e-324"]),
  S("number maximum 0.3", { type: "number", maximum: 0.3 }, ["0.3", "0.30000000000000001", "0.30000000000000004", "0.3000000000000000000001"]),
  S("number exclusiveMaximum(bool) 1", { type: "number", maximum: 1, exclusiveMaximum: true }, ["1", "1.0", "0.99999999999999999999", "1.00000000000000000001"]),
  S("multipleOf 0.01", { type: "number", multipleOf: 0.01 }, ["0.07", "1.1", "0.29", "0.075", "1e400"]),
  S("enum [1]", { enum: [1] }, ["1", "1.0", "1e0", "1.0000000000000001", "true", '"1"']),
  // a JS literal would round 2^53+1, so this schema is kept as raw JSON text
  { name: "enum [9007199254740993]", schemaRaw: '{"$schema":"http://json-schema.org/draft-04/schema#","enum":[9007199254740993]}', instances: ["9007199254740993", "9007199254740992"] },
  S("minLength 2", { type: "string", minLength: 2 }, ["ab", "a", "😀", "é", "é"].map(q).concat(['"\\ud800"', '"\\ud800\\ud800"'])),
  S("maxLength 1", { type: "string", maxLength: 1 }, ["a", "😀", "é", "é"].map(q).concat(['"\\ud800"'])),
  S("oneOf required groups", { type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }] }, ['{"a":1}', '{"b":1}', '{"a":1,"b":1}', "{}"]),
  S("anyOf required groups", { type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }] }, ['{"a":1}', '{"a":1,"b":1}', "{}", '{"a":null}']),
  S("nested required", { type: "object", properties: { w: { type: "object", required: ["p"] } } }, ['{}', '{"w":{}}', '{"w":{"p":null}}', '{"w":[]}']),
  S("additionalProperties false", { type: "object", properties: { a: {} }, additionalProperties: false }, ['{"a":1}', '{"a":1,"b":1}', '{"__proto__":1}']),
  S("type union integer|string", { type: ["integer", "string"] }, ["5", "5.0", '"5"', "true", "null"]),
  S("not required", { type: "object", not: { required: ["a", "b"] } }, ['{"a":1}', '{"a":1,"b":2}']),
  S("dependencies", { type: "object", dependencies: { a: ["b"] } }, ['{"a":1}', '{"a":1,"b":1}', '{"b":1}']),
  S("items + minItems", { type: "array", minItems: 1, items: { type: "string" } }, ["[]", '["a"]', "[1]", '"a"']),
  S("duplicate keys", { type: "object", properties: { a: { type: "integer" } } }, ['{"a":"x","a":1}', '{"a":1,"a":"x"}']),
  S("default is not applied", { type: "object", properties: { a: { type: "integer", default: "x" } }, required: ["a"] }, ["{}"]),
  // keywords from later drafts, under the draft-04 $schema both PBS validators use
  S("const (draft-06) under draft-04", { const: "x" }, ['"x"', '"y"']),
  S("exclusiveMinimum numeric (draft-06) under draft-04", { type: "number", exclusiveMinimum: 5 }, ["5", "4"]),
  S("if/then (draft-07) under draft-04", { type: "object", if: { required: ["a"] }, then: { required: ["b"] } }, ['{"a":1}', '{"a":1,"b":1}']),
  { name: "ogury.json shape under 2020-12", schemaRaw: JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    allOf: [{ if: { required: ["assetKey"] }, then: { required: ["adUnitId"] } }, { if: { required: ["adUnitId"] }, then: { required: ["assetKey"] } }] }),
    instances: ['{"assetKey":"k"}', '{"assetKey":"k","adUnitId":"u"}', "{}"] },
  // each Host's own copy of the OpenX and PubMatic schema (`schemaFile` per Host)
  ...["openx", "pubmatic"].map(b => ({ name: `${b}.json (each Host's copy)`, schemaFile: {
    go: `/Users/joel.meyer/Developer/work/prebid/prebid-server/static/bidder-params/${b}.json`,
    java: `/Users/joel.meyer/Developer/work/prebid/prebid-server-java/src/main/resources/static/bidder-params/${b}.json` },
    instances: b === "openx" ? [
      '{"unit":"123","delDomain":"a.openx.net"}', '{"unit":"123\\n","delDomain":"a.openx.net"}', '{"unit":"123","delDomain":"a.openx.net\\n"}',
      `{"unit":"123","platform":"${uuid.toUpperCase()}"}`, '{"unit":"123","delDomain":"a.openx.net","customFloor":"1.5\\n"}',
      '{"unit":-1e-400,"delDomain":"a.openx.net"}', '{"unit":"123","delDomain":"a.openx.net","customFloor":-1e-400}',
      `{"unit":"123","delDomain":"${host(250)}.net"}`, '{"unit":5.0,"delDomain":"a.openx.net"}',
    ] : [
      '{"publisherId":"1","wrapper":{"profile":5}}', '{"publisherId":"1","wrapper":{"profile":5.0}}', '{"publisherId":"1","wrapper":{"profile":5e0}}',
      '{"publisherId":"1","wrapper":{"profile":12345678901234567890}}', '{"publisherId":"1","keywords":[{"key":"k","value":[]}]}',
      '{"publisherId":"1","wrapper":{"version":1}}', '{"publisherId":""}',
    ] })),
];
console.log(JSON.stringify(cases, null, 1));

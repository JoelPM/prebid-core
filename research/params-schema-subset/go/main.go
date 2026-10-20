// PBS-Go's validator, gojsonschema v1.2.0, on {"type":"string","pattern":p}, fed JSON bytes as PBS-Go does.
// go run . ../cases.json > ../out/go.json
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/xeipuuv/gojsonschema"
)

func main() {
	raw, _ := os.ReadFile(os.Args[1])
	var cases struct{ Catalogue, Probes, Strings []string }
	if err := json.Unmarshal(raw, &cases); err != nil {
		panic(err)
	}
	results := map[string]any{}
	for _, p := range append(cases.Catalogue, cases.Probes...) {
		schemaJSON, _ := json.Marshal(map[string]any{"$schema": "http://json-schema.org/draft-04/schema#", "type": "string", "pattern": p})
		schema, err := gojsonschema.NewSchema(gojsonschema.NewBytesLoader(schemaJSON))
		if err != nil {
			results[p] = map[string]string{"error": err.Error()}
			continue
		}
		var m strings.Builder
		for _, s := range cases.Strings {
			doc, _ := json.Marshal(s)
			r, err := schema.Validate(gojsonschema.NewBytesLoader(doc))
			if err != nil {
				panic(err)
			}
			if r.Valid() {
				m.WriteByte('1')
			} else {
				m.WriteByte('0')
			}
		}
		results[p] = map[string]string{"m": m.String()}
	}
	out, _ := json.Marshal(map[string]any{"engine": "gojsonschema v1.2.0 (Go regexp, " + "go1.27" + ")", "results": results})
	fmt.Println(string(out))
}

// PBS-Go's validator (gojsonschema v1.2.0, NewBytesLoader as openrtb_ext/bidders.go does) on values.json.
// go run ./values ../values.json > ../out/values-go.json
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/xeipuuv/gojsonschema"
)

type testCase struct {
	Name      string
	Schema    json.RawMessage
	SchemaRaw string
	// SchemaFile names each Host's own copy of a catalogue schema.
	SchemaFile struct{ Go string }
	Instances  []string
}

func main() {
	raw, _ := os.ReadFile(os.Args[1])
	var cases []testCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		panic(err)
	}
	out := map[string][]string{}
	for _, c := range cases {
		schemaJSON := []byte(c.SchemaRaw)
		if c.SchemaFile.Go != "" {
			schemaJSON, _ = os.ReadFile(c.SchemaFile.Go)
		} else if c.SchemaRaw == "" {
			schemaJSON = c.Schema
		}
		schema, err := gojsonschema.NewSchema(gojsonschema.NewBytesLoader(schemaJSON))
		if err != nil {
			out[c.Name] = []string{"schema error: " + err.Error()}
			continue
		}
		for _, inst := range c.Instances {
			r, err := schema.Validate(gojsonschema.NewBytesLoader([]byte(inst)))
			switch {
			case err != nil:
				out[c.Name] = append(out[c.Name], "error: "+err.Error())
			case r.Valid():
				out[c.Name] = append(out[c.Name], "valid")
			default:
				msgs := []string{}
				for _, e := range r.Errors() {
					msgs = append(msgs, e.Description())
				}
				out[c.Name] = append(out[c.Name], "invalid: "+strings.Join(msgs, "; "))
			}
		}
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}

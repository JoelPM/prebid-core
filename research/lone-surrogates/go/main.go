// What PBS-Go's JSON layers do with each case in ../cases.tsv.
package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/buger/jsonparser"
	"github.com/prebid/prebid-server/v4/util/jsonutil"
)

type S struct{ S string }
type R struct{ S json.RawMessage }

// show prints bytes with non-ASCII as \xNN so nothing is folded on the way to the terminal.
func show(b []byte) string {
	var sb strings.Builder
	for _, c := range b {
		if c >= 0x20 && c < 0x7f {
			sb.WriteByte(c)
		} else {
			fmt.Fprintf(&sb, "\\x%02x", c)
		}
	}
	return sb.String()
}

func str(s string) string {
	v := ""
	if !utf8.ValidString(s) {
		v = " (invalid UTF-8)"
	}
	return "[" + show([]byte(s)) + "]" + v
}

type Bid struct {
	AdM string `json:"adm"`
}

// nativeAdm is PBS-Go PubMatic's getNativeAdm (adapters/pubmatic/pubmatic.go:549): the bid was
// decoded by jsonutil.Unmarshal, then bid.adm.native is cut out with jsonparser.Get.
func nativeAdm(adm string) string {
	m := map[string]interface{}{}
	if err := jsonutil.Unmarshal([]byte(adm), &m); err != nil {
		return "ERR " + err.Error()
	}
	v, _, _, err := jsonparser.Get([]byte(adm), "native")
	if err != nil {
		return "ERR " + err.Error()
	}
	return string(v)
}

func adm() {
	f, _ := os.Open("../adm.tsv")
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		parts := strings.Split(sc.Text(), "\t")
		doc, _ := hex.DecodeString(parts[1])
		var b Bid
		if err := jsonutil.Unmarshal(doc, &b); err != nil {
			fmt.Printf("== adm %s ERR %v\n", parts[0], err)
			continue
		}
		b.AdM = nativeAdm(b.AdM)
		out, _ := jsonutil.Marshal(b)
		fmt.Printf("== adm %s\n  in  %s\n  out %s\n", parts[0], show(doc), show(out))
	}
}

func main() {
	defer adm()
	f, _ := os.Open("../cases.tsv")
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		parts := strings.Split(sc.Text(), "\t")
		doc, _ := hex.DecodeString(parts[1])
		fmt.Printf("== %s  %s\n", parts[0], show(doc))
		fmt.Printf("  json.Valid                  %v\n", json.Valid(doc))

		var a S
		if err := json.Unmarshal(doc, &a); err != nil {
			fmt.Printf("  encoding/json string        ERR %v\n", err)
		} else {
			out, _ := json.Marshal(a)
			fmt.Printf("  encoding/json string        %s -> %s\n", str(a.S), show(out))
		}
		var r R
		if err := json.Unmarshal(doc, &r); err != nil {
			fmt.Printf("  encoding/json RawMessage    ERR %v\n", err)
		} else {
			out, err := json.Marshal(r)
			fmt.Printf("  encoding/json RawMessage    %s -> %s %v\n", show(r.S), show(out), err)
		}
		var b S
		if err := jsonutil.Unmarshal(doc, &b); err != nil {
			fmt.Printf("  jsonutil.Unmarshal string   ERR %v\n", err)
		} else {
			out, _ := jsonutil.Marshal(b)
			fmt.Printf("  jsonutil.Unmarshal string   %s -> jsonutil.Marshal %s\n", str(b.S), show(out))
		}
		var bv S
		if err := jsonutil.UnmarshalValid(doc, &bv); err != nil {
			fmt.Printf("  jsonutil.UnmarshalValid     ERR %v\n", err)
		} else {
			fmt.Printf("  jsonutil.UnmarshalValid     %s\n", str(bv.S))
		}
		var rr R
		if err := jsonutil.Unmarshal(doc, &rr); err != nil {
			fmt.Printf("  jsonutil RawMessage         ERR %v\n", err)
		} else {
			out, err := jsonutil.Marshal(rr)
			fmt.Printf("  jsonutil RawMessage         %s -> %s %v\n", show(rr.S), show(out), err)
		}
		if s, err := jsonparser.GetString(doc, "s"); err != nil {
			fmt.Printf("  jsonparser.GetString        ERR %v\n", err)
		} else {
			fmt.Printf("  jsonparser.GetString        %s\n", str(s))
		}
		if s, _, _, err := jsonparser.Get(doc, "s"); err == nil {
			fmt.Printf("  jsonparser.Get (raw)        %s\n", show(s))
		}
	}
}

// gen writes a realistic multi-imp OpenRTB request and an OpenX-style response.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func main() {
	imps := []any{}
	bids := []any{}
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("imp-%d", i)
		imp := map[string]any{
			"id":     id,
			"secure": 1,
			"banner": map[string]any{"format": []any{map[string]any{"w": 300, "h": 250}, map[string]any{"w": 300, "h": 600}}, "pos": 1},
			"ext": map[string]any{
				"bidder": map[string]any{"unit": fmt.Sprintf("53943996%d", i), "delDomain": "se-demo-d.openx.net", "customFloor": 0.1, "customParams": map[string]any{"foo": "bar", "kw": []string{"a", "b"}}},
				"gpid":   fmt.Sprintf("/1234/site/slot-%d", i),
				"data":   map[string]any{"pbadslot": fmt.Sprintf("/1234/site/slot-%d", i)},
			},
		}
		if i == 3 {
			delete(imp, "banner")
			imp["video"] = map[string]any{"mimes": []string{"video/mp4"}, "w": 640, "h": 480, "protocols": []int{2, 3, 5, 6}, "minduration": 5, "maxduration": 30}
			imp["rwdd"] = 1
		}
		imps = append(imps, imp)
		mtype := 1
		if i == 3 {
			mtype = 2
		}
		bids = append(bids, map[string]any{
			"id": fmt.Sprintf("bid-%d", i), "impid": id, "price": 1.23 + float64(i), "adm": strings.Repeat("<div class=\"ad\">creative</div>", 50),
			"crid": fmt.Sprintf("crid-%d", i), "w": 300, "h": 250, "mtype": mtype, "adomain": []string{"advertiser.com"}, "cat": []string{"IAB1"}, "dur": 15,
			"ext": map[string]any{"dsp_id": "123", "buyer_id": "456", "brand_id": "789"},
		})
	}
	eids := []any{}
	for _, src := range []string{"id5-sync.com", "liveramp.com", "pubcid.org", "criteo.com", "uidapi.com"} {
		eids = append(eids, map[string]any{"source": src, "uids": []any{map[string]any{"id": strings.Repeat("x", 40), "atype": 1}}})
	}
	req := map[string]any{
		"id": "auction-req-0001", "imp": imps, "tmax": 1000, "cur": []string{"USD"},
		"site":   map[string]any{"id": "site-1", "domain": "publisher.example", "page": "https://publisher.example/news/article-1234567?utm=x", "ref": "https://www.google.com/", "publisher": map[string]any{"id": "pub-1", "domain": "publisher.example"}, "cat": []string{"IAB12"}, "keywords": "news,world"},
		"device": map[string]any{"ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "ip": "203.0.113.7", "devicetype": 2, "language": "en", "js": 1, "dnt": 0, "geo": map[string]any{"country": "USA", "region": "CA", "city": "Pasadena", "type": 2}, "sua": map[string]any{"browsers": []any{map[string]any{"brand": "Chromium", "version": []string{"130"}}}, "platform": map[string]any{"brand": "macOS"}, "mobile": 0}},
		"user":   map[string]any{"id": "user-abc", "buyeruid": "ox-uid-123", "ext": map[string]any{"consent": strings.Repeat("C", 300), "eids": eids}},
		"regs":   map[string]any{"ext": map[string]any{"gdpr": 1, "us_privacy": "1YNN"}, "gpp": strings.Repeat("D", 120), "gpp_sid": []int{2}},
		"source": map[string]any{"tid": "tid-1234", "ext": map[string]any{"schain": map[string]any{"ver": "1.0", "complete": 1, "nodes": []any{map[string]any{"asi": "publisher.example", "sid": "1", "hp": 1}}}}},
		"ext":    map[string]any{"prebid": map[string]any{"targeting": map[string]any{"pricegranularity": "medium"}}},
	}
	resp := map[string]any{"id": "auction-req-0001", "cur": "USD", "seatbid": []any{map[string]any{"seat": "openx", "bid": bids}}}
	w := func(name string, v any) {
		b, _ := json.Marshal(v)
		os.WriteFile(name, b, 0o644)
		fmt.Println(name, len(b), "bytes")
	}
	w(os.Args[1]+"/req.json", req)
	w(os.Args[1]+"/resp.json", resp)
}

// stub is a fake bidder: it answers every ORTB request with one banner bid per imp.
// It runs as its own process so its CPU is not charged to the PBS under test.
package main

import (
	"compress/gzip"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

type imp struct {
	ID     string `json:"id"`
	Banner *struct {
		Format []struct{ W, H int } `json:"format"`
		W, H   *int
	} `json:"banner"`
}

type req struct {
	ID  string `json:"id"`
	Imp []imp  `json:"imp"`
}

var adm = "<div>" + strings.Repeat("<script src=\"https://cdn.example.com/creative.js?x=0123456789\"></script>", 18) + "</div>"

func main() {
	addr := flag.String("addr", "127.0.0.1:9000", "listen address")
	delay := flag.Duration("delay", 20*time.Millisecond, "simulated bidder think time")
	flag.Parse()
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		var body io.Reader = r.Body
		if r.Header.Get("Content-Encoding") == "gzip" {
			gz, err := gzip.NewReader(r.Body)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			body = gz
		}
		var q req
		if err := json.NewDecoder(body).Decode(&q); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		bids := make([]map[string]any, 0, len(q.Imp))
		for i, im := range q.Imp {
			wd, ht := 300, 250
			if im.Banner != nil && len(im.Banner.Format) > 0 {
				wd, ht = im.Banner.Format[0].W, im.Banner.Format[0].H
			}
			bids = append(bids, map[string]any{
				"id": fmt.Sprintf("b%d", i), "impid": im.ID, "price": 0.5 + float64(i)*0.1,
				"adm": adm, "adid": "ad1", "adomain": []string{"advertiser.com"}, "crid": "cr1", "cid": "c1",
				"w": wd, "h": ht, "mtype": 1,
				"ext": map[string]any{
					"appnexus": map[string]any{"bid_ad_type": 0},
					"prebid":   map[string]any{"type": "banner"},
					"BidType":  0, "mediaType": "banner", "format": "banner",
				},
			})
		}
		time.Sleep(*delay)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"id": q.ID, "cur": "USD",
			"seatbid": []map[string]any{{"seat": "seat1", "bid": bids}},
		})
	})
	log.Printf("stub listening on %s (delay %s)", *addr, *delay)
	log.Fatal(http.ListenAndServe(*addr, nil))
}

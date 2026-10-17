// loadgen fires POSTs at a fixed rate and reports the server process's CPU per request.
// CPU is read from `ps -o time=` (user+sys) of -pid before and after the measured window.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func cpuSeconds(pid int) float64 {
	out, err := exec.Command("ps", "-o", "time=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		panic(err)
	}
	// formats: M:SS.ss or H:MM:SS.ss
	parts := strings.Split(strings.TrimSpace(string(out)), ":")
	var s float64
	for _, p := range parts {
		v, _ := strconv.ParseFloat(p, 64)
		s = s*60 + v
	}
	return s
}

func main() {
	url := flag.String("url", "http://127.0.0.1:8000/openrtb2/auction", "target")
	bodyFile := flag.String("body", "", "request body file")
	rps := flag.Int("rps", 500, "requests per second")
	warm := flag.Duration("warmup", 20*time.Second, "warm-up duration (not measured)")
	dur := flag.Duration("dur", 30*time.Second, "measured duration")
	pid := flag.Int("pid", 0, "server pid to measure")
	label := flag.String("label", "", "label for the output line")
	flag.Parse()
	body, err := os.ReadFile(*bodyFile)
	if err != nil {
		panic(err)
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: 2000, MaxConnsPerHost: 0}}

	// sanity check: count bids in one response
	resp, err := client.Post(*url, "application/json", bytes.NewReader(body))
	if err != nil {
		panic(err)
	}
	rb, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	var br struct {
		Seatbid []struct {
			Seat string
			Bid  []json.RawMessage
		}
		Ext map[string]json.RawMessage
	}
	json.Unmarshal(rb, &br)
	seats, bids := []string{}, 0
	for _, s := range br.Seatbid {
		seats = append(seats, s.Seat)
		bids += len(s.Bid)
	}
	sort.Strings(seats)
	fmt.Fprintf(os.Stderr, "sanity: status=%d seats=%v bids=%d errors=%s\n", resp.StatusCode, seats, bids, br.Ext["errors"])

	run := func(d time.Duration) (n, bad int64, lat []time.Duration) {
		var wg sync.WaitGroup
		var mu sync.Mutex
		tick := time.NewTicker(time.Second / time.Duration(*rps))
		defer tick.Stop()
		end := time.Now().Add(d)
		for time.Now().Before(end) {
			<-tick.C
			wg.Add(1)
			go func() {
				defer wg.Done()
				t := time.Now()
				r, err := client.Post(*url, "application/json", bytes.NewReader(body))
				if err != nil {
					atomic.AddInt64(&bad, 1)
					return
				}
				io.Copy(io.Discard, r.Body)
				r.Body.Close()
				el := time.Since(t)
				if r.StatusCode != 200 {
					atomic.AddInt64(&bad, 1)
				}
				atomic.AddInt64(&n, 1)
				mu.Lock()
				lat = append(lat, el)
				mu.Unlock()
			}()
		}
		wg.Wait()
		return
	}
	run(*warm)
	c0, t0 := cpuSeconds(*pid), time.Now()
	n, bad, lat := run(*dur)
	c1, el := cpuSeconds(*pid), time.Since(t0)
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	p := func(q float64) time.Duration { return lat[int(float64(len(lat)-1)*q)] }
	fmt.Printf("%s\trps=%.0f\tok=%d\tbad=%d\tcpu_s=%.2f\tcores=%.2f\tcpu_us_per_req=%.0f\tp50=%v\tp99=%v\n",
		*label, float64(n)/el.Seconds(), n, bad, c1-c0, (c1-c0)/el.Seconds(), (c1-c0)/float64(n)*1e6, p(0.5).Round(time.Millisecond/10), p(0.99).Round(time.Millisecond/10))
}

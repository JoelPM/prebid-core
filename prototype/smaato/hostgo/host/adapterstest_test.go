package host

// Runs PBS-Go's own adapterstest harness (the code PBS-Go's adapter CI runs) against the Shared
// Adapters in wasm. Fixtures listed in defs/known-differences.yaml are expected to fail here; the
// harness/parity.mjs checks that each fails only at its pinned path.
//
// GUEST_WASM=../out/target/wasm32-unknown-unknown/release/guest.wasm PBS=../../../../prebid-server go test ./host -run Adapterstest -v

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/prebid/prebid-server/v4/adapters/adapterstest"
)

func TestAdapterstest(t *testing.T) {
	b, err := os.ReadFile(os.Getenv("GUEST_WASM"))
	if err != nil {
		t.Skip("set GUEST_WASM and PBS")
	}
	rt, err := NewRuntime(b)
	if err != nil {
		t.Fatal(err)
	}
	for name, ep := range map[string]string{"openx": "http://rtb.openx.net/prebid", "pubmatic": "https://hbopenbid.pubmatic.com/translator?source=prebid-server", "smaato": "https://prebid/bidder"} {
		bidder := rt.Bidder(name, ep)
		bidder.Now = func() time.Time { return time.Date(2021, 6, 25, 10, 0, 0, 0, time.UTC) } // smaato_test.go's clock
		root := filepath.Join(os.Getenv("PBS"), "adapters", name, name+"test")
		filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() && strings.HasSuffix(p, ".json") {
				rel, _ := filepath.Rel(root, p)
				t.Run(name+"/"+rel, func(t *testing.T) { adapterstest.RunSingleJSONBidderTest(t, bidder, p, true) })
			}
			return err
		})
	}
}

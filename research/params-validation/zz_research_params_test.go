package openrtb_ext

import (
	"fmt"
	"testing"
)

func TestZZResearchParams(t *testing.T) {
	v, err := NewBidderParamsValidator("../static/bidder-params")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ b, p string }{
		{"openx", `{"unit":"123","delDomain":"a.openx.net"}`},
		{"openx", `{"unit":123,"delDomain":"a.openx.net"}`},
		{"openx", `{"unit":1.5,"delDomain":"a.openx.net"}`},
		{"openx", `{"unit":-1,"delDomain":"a.openx.net"}`},
		{"openx", `{"unit":"abc","delDomain":"a.openx.net"}`},
		{"openx", `{"unit":true,"delDomain":"a.openx.net"}`},
		{"openx", `{"unit":"1","delDomain":"openx"}`},
		{"openx", `{"unit":"1","platform":"not-a-uuid"}`},
		{"openx", `{"unit":"1","platform":"8DB4A3B2-3D24-4F71-9C34-6A5B6C3D2E10"}`},
		{"openx", `{"unit":"1","delDomain":"a.openx.net","customFloor":"1.5x"}`},
		{"openx", `{"unit":"1","delDomain":"a.openx.net","extra":{"x":1}}`},
		{"openx", `{"unit":"1"}`},
		{"openx", `{"unit":null,"delDomain":"a.openx.net"}`},
		{"pubmatic", `{"publisherId":"156209","wrapper":{"profile":"5"}}`},
		{"pubmatic", `{"publisherId":"156209","wrapper":{"profile":5.5}}`},
		{"pubmatic", `{"publisherId":156209}`},
		{"pubmatic", `{"publisherId":"1","kadfloor":0.5}`},
	}
	for _, c := range cases {
		err := v.Validate(BidderName(c.b), []byte(c.p))
		fmt.Printf("%-8s %-75s => %v\n", c.b, c.p, err)
	}
}

module bench

go 1.25.0

require (
	github.com/prebid/openrtb/v20 v20.3.0
	github.com/prebid/prebid-server/v4 v4.0.0
	github.com/tetratelabs/wazero v1.12.0
)

require (
	github.com/buger/jsonparser v1.1.2 // indirect
	github.com/json-iterator/go v1.1.12 // indirect
	github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd // indirect
	github.com/modern-go/reflect2 v1.0.2 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/tidwall/gjson v1.17.1 // indirect
	github.com/tidwall/match v1.1.1 // indirect
	github.com/tidwall/pretty v1.2.0 // indirect
	github.com/xeipuuv/gojsonpointer v0.0.0-20180127040702-4e3ac2762d5f // indirect
	github.com/xeipuuv/gojsonreference v0.0.0-20180127040603-bd5ef7bd5415 // indirect
	github.com/xeipuuv/gojsonschema v1.2.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	gopkg.in/evanphx/json-patch.v5 v5.9.0 // indirect
)

// point at a local prebid-server checkout
replace github.com/prebid/prebid-server/v4 => ../../../prebid-server

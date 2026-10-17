"""Generate /openrtb2/auction bodies with 1, 3, 5 and 10 bidders on 3 banner imps.

Shape follows a typical Prebid.js s2s call: site, device, 5 EIDs, schain,
targeting requested, no stored requests, no cache.
"""
import json, os, sys

BIDDERS = [
    ("appnexus", {"placementId": 12883451}),
    ("openx", {"unit": "540000000", "delDomain": "pub-d.openx.net"}),
    ("pubmatic", {"publisherId": "156209", "adSlot": "slot1@300x250"}),
    ("ix", {"siteId": "123456"}),
    ("triplelift", {"inventoryCode": "pub_top_banner"}),
    ("sovrn", {"tagid": "403370"}),
    ("sharethrough", {"pkey": "abcdef1234567890"}),
    ("criteo", {"networkId": 4321}),
    ("medianet", {"cid": "8CUX0H51C", "crid": "123456789"}),
    ("smartadserver", {"networkId": 73, "siteId": 1, "pageId": 2, "formatId": 3}),
]
SIZES = [[[300, 250], [300, 600]], [[728, 90], [970, 250]], [[320, 50], [300, 250]]]


def body(n):
    imps = []
    for i, fmts in enumerate(SIZES):
        imps.append({
            "id": f"imp{i+1}",
            "tagid": f"div-gpt-ad-{i+1}",
            "banner": {"format": [{"w": w, "h": h} for w, h in fmts]},
            "ext": {"gpid": f"/1234/site/slot{i+1}",
                    "prebid": {"bidder": {b: p for b, p in BIDDERS[:n]}}},
        })
    return {
        "id": "req-1", "imp": imps, "tmax": 1000, "cur": ["USD"],
        "site": {"page": "https://www.example.com/news/article-123.html", "domain": "example.com",
                 "publisher": {"id": "pub-1", "domain": "example.com"},
                 "ref": "https://www.google.com/", "cat": ["IAB12"]},
        "device": {"ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
                   "ip": "73.15.22.101", "language": "en", "devicetype": 2, "w": 1728, "h": 1117, "dnt": 0},
        "user": {"ext": {"eids": [
            {"source": s, "uids": [{"id": f"{s}-0123456789abcdef0123456789", "atype": 1}]}
            for s in ["pubcid.org", "liveramp.com", "adserver.org", "uidapi.com", "id5-sync.com"]]}},
        "regs": {"ext": {"gdpr": 0, "us_privacy": "1---"}},
        "source": {"tid": "tid-1", "ext": {"schain": {"ver": "1.0", "complete": 1, "nodes": [
            {"asi": "example-ssp.com", "sid": "1234", "hp": 1}]}}},
        "ext": {"prebid": {"targeting": {"includewinners": True, "includebidderkeys": True,
                                          "pricegranularity": "medium"},
                           "channel": {"name": "pbjs", "version": "10.0.0"}}},
    }


out = os.path.dirname(os.path.abspath(__file__))
for n in (1, 3, 5, 10):
    with open(os.path.join(out, f"auction-{n}.json"), "w") as f:
        json.dump(body(n), f)

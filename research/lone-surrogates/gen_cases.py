# Writes cases.tsv: the exact JSON bytes every experiment reads. Escapes are built from
# BS + "u" + hex so no tool along the way can fold a pair into a literal character.
BS = b"\\"
def u(h): return BS + b"u" + h.encode()
cases = [
    ("hi", u("d800")),                      # lone high surrogate escape
    ("lo", u("dc00")),                      # lone low surrogate escape
    ("hiA", u("d800") + b"A"),              # high followed by a non-surrogate
    ("rev", u("de00") + u("d83d")),         # low then high: two lone surrogates
    ("pair_esc", u("d83d") + u("de00")),    # valid pair, both escaped (U+1F600)
    ("pair_lit", "\U0001F600".encode()),    # the same character as literal UTF-8
    ("hi_esc+lo_wtf8", u("d83d") + b"\xed\xb8\x80"),  # pair split: escaped high, low as WTF-8 bytes
    ("hi_wtf8", b"\xed\xa0\x80"),           # lone high as WTF-8/CESU bytes (invalid UTF-8)
    ("pair_cesu8", b"\xed\xa0\xbd\xed\xb8\x80"),  # the pair as CESU-8 (invalid UTF-8)
    ("byte_ff", b"a\xffb"),                 # invalid UTF-8 byte
    ("trunc_utf8", b"\xf0\x9f\x98"),        # UTF-8 of U+1F600 cut after 3 bytes
    ("fffd_esc", u("fffd")),                # control: U+FFFD itself
]
with open("cases.tsv", "w") as f:
    for n, c in cases:
        f.write(n + "\t" + (b'{"s":"' + c + b'"}').hex() + "\n")

# adm.tsv: bidder-response bids whose `adm` holds native JSON {"native":{"t":<lone surrogate>}}.
# outer_escape: the adm *text* holds a lone surrogate (the escape is in the response's JSON).
# inner_escape: the adm text holds the six characters \ud800 (the escape is in the native JSON).
Q = BS + b'"'
def adm(t): return b'{"adm":"{' + Q + b"native" + Q + b":{" + Q + b"t" + Q + b":" + Q + t + Q + b'}}"}'
with open("adm.tsv", "w") as f:
    f.write("outer_escape\t" + adm(u("d800")).hex() + "\n")
    f.write("inner_escape\t" + adm(BS + u("d800")).hex() + "\n")

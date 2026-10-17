#!/bin/bash
printf "%-60s raw=%8d gz=%7d br=%7d\n" "$2" $(wc -c <"$1") $(gzip -9c "$1"|wc -c) $(brotli -cq 11 "$1"|wc -c)

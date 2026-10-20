# Lists every pattern, format and keyword in PBS-Go's and PBS-Java's bidder-params schemas.
# python3 -I catalogue.py [--json out.json]
import json, os, sys, collections
GO="/Users/joel.meyer/Developer/work/prebid/prebid-server/static/bidder-params"
JA="/Users/joel.meyer/Developer/work/prebid/prebid-server-java/src/main/resources/static/bidder-params"
SCHEMA_KW={"$schema","$ref","id","$id","title","description","type","properties","required","enum","const","pattern","format",
 "minimum","maximum","exclusiveMinimum","exclusiveMaximum","multipleOf","minLength","maxLength","items","additionalItems",
 "minItems","maxItems","uniqueItems","additionalProperties","patternProperties","minProperties","maxProperties","dependencies",
 "oneOf","anyOf","allOf","not","if","then","else","definitions","$defs","default","examples"}
def load(d):
    return {f[:-5]: json.load(open(os.path.join(d,f))) for f in sorted(os.listdir(d)) if f.endswith(".json")}
def walk(node, f, kw, pats, fmts, path):
    if isinstance(node, list):
        for i,x in enumerate(node): walk(x,f,kw,pats,fmts,path)
        return
    if not isinstance(node, dict): return
    for k,v in node.items():
        kw[k].add(f)
        if k=="pattern": pats.append((f,path,v))
        if k=="format": fmts.append((f,path,v))
        if k=="type" and isinstance(v,list): kw["type[union]"].add(f)
        if k=="type" and v=="integer": kw["type:integer"].add(f)
        if k=="additionalProperties": kw["additionalProperties:"+("false" if v is False else "true" if v is True else "schema")].add(f)
        if k=="items": kw["items:"+("tuple" if isinstance(v,list) else "schema")].add(f)
        if k=="exclusiveMinimum" or k=="exclusiveMaximum": kw[k+":"+type(v).__name__].add(f)
        if k=="enum":
            for e in v: kw["enum value:"+type(e).__name__].add(f)
        if k in ("properties","patternProperties","definitions","$defs","dependencies"):
            if isinstance(v,dict):
                for pk,pv in v.items(): walk(pv,f,kw,pats,fmts,path+"/"+pk)
        elif k in ("required","enum","type","const","default","examples","description","title"):
            pass
        else:
            walk(v,f,kw,pats,fmts,path+"/"+k)
out={}
for name,d in (("go",GO),("java",JA)):
    s=load(d); kw=collections.defaultdict(set); pats=[]; fmts=[]
    for b,sch in s.items(): walk(sch,b,kw,pats,fmts,"")
    unknown={k for k in kw if k not in SCHEMA_KW and ":" not in k and "[" not in k}
    out[name]={"files":len(s),"kw":{k:sorted(v) for k,v in kw.items()},"patterns":pats,"formats":fmts,"unknown_kw":sorted(unknown)}
    print(f"== {name}: {len(s)} files")
    for k,v in sorted(kw.items(), key=lambda x:(-len(x[1]),x[0])):
        if k in SCHEMA_KW or ":" in k or "[" in k: print(f"  {len(v):4d} {k}" + (f"  {sorted(v)}" if len(v)<=12 else ""))
    print("  non-keyword member names seen (property names leak in only via malformed schemas):", sorted(unknown)[:40])
    print(f"  patterns: {len(pats)} occurrences, {len(set(p for _,_,p in pats))} distinct")
    for f,p,v in pats: print(f"    {f}{p}: {v!r}")
    print("  formats:")
    for f,p,v in fmts: print(f"    {f}{p}: {v}")
if "--json" in sys.argv: json.dump(out, open(sys.argv[sys.argv.index("--json")+1],"w"), indent=1)

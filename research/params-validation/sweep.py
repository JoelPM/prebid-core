import json, os, sys, collections
GO="/Users/joel.meyer/Developer/work/prebid/prebid-server/static/bidder-params"
JA="/Users/joel.meyer/Developer/work/prebid/prebid-server-java/src/main/resources/static/bidder-params"
def load(d):
    out={}
    for f in sorted(os.listdir(d)):
        if f.endswith(".json"):
            out[f[:-5]]=json.load(open(os.path.join(d,f)))
    return out
def walk(node, hits, path="", top=True):
    if isinstance(node, dict):
        for k,v in node.items():
            if k=="type" and isinstance(v,list): hits["type union "+json.dumps(sorted(v))]=1; hits["type union (any)"]=1
            if k=="type" and isinstance(v,str) and v=="integer": hits["type: integer"]=1
            if k in ("pattern","format","minimum","maximum","exclusiveMinimum","exclusiveMaximum","minLength","maxLength","minItems","maxItems","uniqueItems","enum","const","oneOf","anyOf","allOf","not","dependencies","dependentRequired","dependentSchemas","if","patternProperties","$ref","definitions","$defs","minProperties","maxProperties","multipleOf","default","items"):
                if k=="format": hits["format: "+str(v)]=1
                hits[k]=1
            if k=="additionalProperties": hits["additionalProperties: "+("false" if v is False else "true" if v is True else "schema")]=1
            if k=="required" and isinstance(v,list): hits["required (top-level)" if path=="" else "required (nested)"]=1
            if k in ("properties","definitions","$defs","patternProperties","dependencies"):
                if isinstance(v,dict):
                    for pk,pv in v.items(): walk(pv,hits,path+"/"+pk,False)
                continue
            if isinstance(v,(dict,list)) and k not in ("required","enum","type","const","default"):
                walk(v,hits,path+"/"+k if k not in("anyOf","oneOf","allOf","not","if","then","else") or path else path,False)
    elif isinstance(node,list):
        for x in node: walk(x,hits,path,False)
def strip(n):
    if isinstance(n,dict): return {k:strip(v) for k,v in n.items() if k not in ("description","title","$schema","$id","id","examples")}
    if isinstance(n,list): return [strip(x) for x in n]
    return n
for name,d in (("Go",GO),("Java",JA)):
    s=load(d); c=collections.Counter()
    for b,sch in s.items():
        h={}; walk(sch,h); c.update(h.keys())
    print(f"== {name}: {len(s)} files")
    for k,v in sorted(c.items(), key=lambda x:(-x[1],x[0])): print(f"  {v:4d} {k}")
g=load(GO); j=load(JA)
print("only Go", len(set(g)-set(j)), "only Java", len(set(j)-set(g)), "both", len(set(g)&set(j)))
diff=[b for b in sorted(set(g)&set(j)) if strip(g[b])!=strip(j[b])]
print("semantically differ", len(diff))
def props(s): return s.get("properties",{})
ex=[]
for b in diff:
    pg,pj=props(g[b]),props(j[b])
    notes=[]
    for k in sorted(set(pg)|set(pj)):
        if k not in pg: notes.append(f"{k}: Java only"); continue
        if k not in pj: notes.append(f"{k}: Go only"); continue
        if pg[k].get("type")!=pj[k].get("type"): notes.append(f"{k}: type Go {pg[k].get('type')} vs Java {pj[k].get('type')}")
    if g[b].get("required")!=j[b].get("required"): notes.append(f"required Go {g[b].get('required')} vs Java {j[b].get('required')}")
    for kw in ("anyOf","oneOf","not","dependencies","allOf"):
        if strip(g[b].get(kw))!=strip(j[b].get(kw)): notes.append(f"{kw} differs")
    if notes: ex.append((b,notes))
print("diff with type/required/combinator/property drift:", len(ex))
for b,n in ex[:400]: print(" ",b,"|","; ".join(n)[:300])

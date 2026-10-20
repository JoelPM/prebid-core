import json
exec(open('sweep.py').read().replace('\nmain()\n','\n'))
go,_=load(GO); jv,_=load(JAVA)
VAL={'pattern','format','minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','minItems','maxItems','uniqueItems','multipleOf'}
for label,data in (('GO',go),('JAVA',jv)):
    tiers={'A_typeonly_required_anyOf':[], 'B_plus_oneOf_required':[], 'C_plus_enum_or_nested_required':[], 'D_value_constraints':[], 'E_other_combinators':[]}
    for f,s in data.items():
        flags=set()
        def v(n,path,depth):
            top=path==[]
            if VAL & set(n): flags.add('val')
            if 'enum' in n or 'const' in n: flags.add('enum')
            if 'required' in n and not top and not (len(path)>=2 and path[-2] in ('anyOf','oneOf')) and path[-1:]!=['then'] and path[-1:]!=['if']: flags.add('nestedreq')
            for kw in ('anyOf','oneOf'):
                if kw in n:
                    ok = top and all(isinstance(b,dict) and set(b)-{'description','title'}=={'required'} for b in n[kw])
                    if not ok: flags.add('combo')
                    elif kw=='oneOf': flags.add('oneOf')
            if any(k in n for k in ('allOf','not','if','dependencies','patternProperties')): flags.add('combo')
            if n.get('additionalProperties') is False: flags.add('val')
            if isinstance(n.get('additionalProperties'),dict): flags.add('enum')
        walk(s,[],0,v)
        t='E_other_combinators' if 'combo' in flags else 'D_value_constraints' if 'val' in flags else 'C_plus_enum_or_nested_required' if flags&{'enum','nestedreq'} else 'B_plus_oneOf_required' if 'oneOf' in flags else 'A_typeonly_required_anyOf'
        tiers[t].append(f)
    print(label,len(data),{k:len(v) for k,v in tiers.items()})
    print('  E:',tiers['E_other_combinators'])

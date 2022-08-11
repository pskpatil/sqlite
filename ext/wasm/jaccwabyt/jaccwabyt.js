/**
  2022-06-30

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  The Jaccwabyt API is documented in detail in an external file.

  Project home: https://fossil.wanderinghorse.net/r/jaccwabyt

*/
'use strict';
self.Jaccwabyt = function StructBinderFactory(config){
/* ^^^^ it is recommended that clients move that object into wherever
   they'd like to have it and delete the self-held copy ("self" being
   the global window or worker object).  This API does not require the
   global reference - it is simply installed as a convenience for
   connecting these bits to other co-developed code before it gets
   removed from the global namespace.
*/

  /** Throws a new Error, the message of which is the concatenation
      all args with a space between each. */
  const toss = (...args)=>{throw new Error(args.join(' '))};

  /**
     Implementing function bindings revealed significant
     shortcomings in Emscripten's addFunction()/removeFunction()
     interfaces:

     https://github.com/emscripten-core/emscripten/issues/17323

     Until those are resolved, or a suitable replacement can be
     implemented, our function-binding API will be more limited
     and/or clumsier to use than initially hoped.
  */
  if(!(config.heap instanceof WebAssembly.Memory)
     && !(config.heap instanceof Function)){
    toss("config.heap must be WebAssembly.Memory instance or a function.");
  }
  ['alloc','dealloc'].forEach(function(k){
    (config[k] instanceof Function) ||
      toss("Config option '"+k+"' must be a function.");
  });
  const SBF = StructBinderFactory;
  const heap = (config.heap instanceof Function)
        ? config.heap : (()=>new Uint8Array(config.heap.buffer)),
        alloc = config.alloc,
        dealloc = config.dealloc,
        log = config.log || console.log.bind(console),
        memberPrefix = (config.memberPrefix || ""),
        memberSuffix = (config.memberSuffix || ""),
        bigIntEnabled = (undefined===config.bigIntEnabled
                         ? !!self['BigInt64Array'] : !!config.bigIntEnabled),
        BigInt = self['BigInt'],
        BigInt64Array = self['BigInt64Array'],
        /* Undocumented (on purpose) config options: */
        functionTable = config.functionTable/*EXPERIMENTAL, undocumented*/,
        ptrSizeof = config.ptrSizeof || 4,
        ptrIR = config.ptrIR || 'i32'
  ;

  if(!SBF.debugFlags){
    SBF.__makeDebugFlags = function(deriveFrom=null){
      /* This is disgustingly overengineered. :/ */
      if(deriveFrom && deriveFrom.__flags) deriveFrom = deriveFrom.__flags;
      const f = function f(flags){
        if(0===arguments.length){
          return f.__flags;
        }
        if(flags<0){
          delete f.__flags.getter; delete f.__flags.setter;
          delete f.__flags.alloc; delete f.__flags.dealloc;
        }else{
          f.__flags.getter  = 0!==(0x01 & flags);
          f.__flags.setter  = 0!==(0x02 & flags);
          f.__flags.alloc   = 0!==(0x04 & flags);
          f.__flags.dealloc = 0!==(0x08 & flags);
        }
        return f._flags;
      };
      Object.defineProperty(f,'__flags', {
        iterable: false, writable: false,
        value: Object.create(deriveFrom)
      });
      if(!deriveFrom) f(0);
      return f;
    };
    SBF.debugFlags = SBF.__makeDebugFlags();
  }/*static init*/

  const isLittleEndian = (function() {
    const buffer = new ArrayBuffer(2);
    new DataView(buffer).setInt16(0, 256, true /* littleEndian */);
    // Int16Array uses the platform's endianness.
    return new Int16Array(buffer)[0] === 256;
  })();
  /**
     Some terms used in the internal docs:

     StructType: a struct-wrapping class generated by this
     framework.
     DEF: struct description object.
     SIG: struct member signature string.
  */

  /** True if SIG s looks like a function signature, else
      false. */
  const isFuncSig = (s)=>'('===s[1];
  /** True if SIG s is-a pointer signature. */
  const isPtrSig = (s)=>'p'===s || 'P'===s;
  const isAutoPtrSig = (s)=>'P'===s /*EXPERIMENTAL*/;
  const sigLetter = (s)=>isFuncSig(s) ? 'p' : s[0];
  /** Returns the WASM IR form of the Emscripten-conventional letter
      at SIG s[0]. Throws for an unknown SIG. */
  const sigIR = function(s){
    switch(sigLetter(s)){
        case 'i': return 'i32';
        case 'p': case 'P': case 's': return ptrIR;
        case 'j': return 'i64';
        case 'f': return 'float';
        case 'd': return 'double';
    }
    toss("Unhandled signature IR:",s);
  };
  /** Returns the sizeof value for the given SIG. Throws for an
      unknown SIG. */
  const sigSizeof = function(s){
    switch(sigLetter(s)){
        case 'i': return 4;
        case 'p': case 'P': case 's': return ptrSizeof;
        case 'j': return 8;
        case 'f': return 4 /* C-side floats, not JS-side */;
        case 'd': return 8;
    }
    toss("Unhandled signature sizeof:",s);
  };
  const affirmBigIntArray = BigInt64Array
        ? ()=>true : ()=>toss('BigInt64Array is not available.');
  /** Returns the (signed) TypedArray associated with the type
      described by the given SIG. Throws for an unknown SIG. */
  /**********
  const sigTypedArray = function(s){
    switch(sigIR(s)) {
        case 'i32': return Int32Array;
        case 'i64': return affirmBigIntArray() && BigInt64Array;
        case 'float': return Float32Array;
        case 'double': return Float64Array;
    }
    toss("Unhandled signature TypedArray:",s);
  };
  **************/
  /** Returns the name of a DataView getter method corresponding
      to the given SIG. */
  const sigDVGetter = function(s){
    switch(sigLetter(s)) {
        case 'p': case 'P': case 's': {
          switch(ptrSizeof){
              case 4: return 'getInt32';
              case 8: return affirmBigIntArray() && 'getBigInt64';
          }
          break;
        }
        case 'i': return 'getInt32';
        case 'j': return affirmBigIntArray() && 'getBigInt64';
        case 'f': return 'getFloat32';
        case 'd': return 'getFloat64';
    }
    toss("Unhandled DataView getter for signature:",s);
  };
  /** Returns the name of a DataView setter method corresponding
      to the given SIG. */
  const sigDVSetter = function(s){
    switch(sigLetter(s)){
        case 'p': case 'P': case 's': {
          switch(ptrSizeof){
              case 4: return 'setInt32';
              case 8: return affirmBigIntArray() && 'setBigInt64';
          }
          break;
        }
        case 'i': return 'setInt32';
        case 'j': return affirmBigIntArray() && 'setBigInt64';
        case 'f': return 'setFloat32';
        case 'd': return 'setFloat64';
    }
    toss("Unhandled DataView setter for signature:",s);
  };
  /**
     Returns either Number of BigInt, depending on the given
     SIG. This constructor is used in property setters to coerce
     the being-set value to the correct size.
  */
  const sigDVSetWrapper = function(s){
    switch(sigLetter(s)) {
        case 'i': case 'f': case 'd': return Number;
        case 'j': return affirmBigIntArray() && BigInt;
        case 'p': case 'P': case 's':
          switch(ptrSizeof){
              case 4: return Number;
              case 8: return affirmBigIntArray() && BigInt;
          }
          break;
    }
    toss("Unhandled DataView set wrapper for signature:",s);
  };

  const sPropName = (s,k)=>s+'::'+k;

  const __propThrowOnSet = function(structName,propName){
    return ()=>toss(sPropName(structName,propName),"is read-only.");
  };

  /**
     When C code passes a pointer of a bound struct to back into
     a JS function via a function pointer struct member, it
     arrives in JS as a number (pointer).
     StructType.instanceForPointer(ptr) can be used to get the
     instance associated with that pointer, and __ptrBacklinks
     holds that mapping. WeakMap keys must be objects, so we
     cannot use a weak map to map pointers to instances. We use
     the StructType constructor as the WeakMap key, mapped to a
     plain, prototype-less Object which maps the pointers to
     struct instances. That arrangement gives us a
     per-StructType type-safe way to resolve pointers.
  */
  const __ptrBacklinks = new WeakMap();
  /**
     Similar to __ptrBacklinks but is scoped at the StructBinder
     level and holds pointer-to-object mappings for all struct
     instances created by any struct from any StructFactory
     which this specific StructBinder has created. The intention
     of this is to help implement more transparent handling of
     pointer-type property resolution.
  */
  const __ptrBacklinksGlobal = Object.create(null);

  /**
     In order to completely hide StructBinder-bound struct
     pointers from JS code, we store them in a scope-local
     WeakMap which maps the struct-bound objects to their WASM
     pointers. The pointers are accessible via
     boundObject.pointer, which is gated behind an accessor
     function, but are not exposed anywhere else in the
     object. The main intention of that is to make it impossible
     for stale copies to be made.
  */
  const __instancePointerMap = new WeakMap();

  /** Property name for the pointer-is-external marker. */
  const xPtrPropName = '(pointer-is-external)';

  /** Frees the obj.pointer memory and clears the pointer
      property. */
  const __freeStruct = function(ctor, obj, m){
    if(!m) m = __instancePointerMap.get(obj);
    if(m) {
      if(obj.ondispose instanceof Function){
        try{obj.ondispose()}
        catch(e){
          /*do not rethrow: destructors must not throw*/
          console.warn("ondispose() for",ctor.structName,'@',
                       m,'threw. NOT propagating it.',e);
        }
      }else if(Array.isArray(obj.ondispose)){
        obj.ondispose.forEach(function(x){
          try{
            if(x instanceof Function) x.call(obj);
            else if('number' === typeof x) dealloc(x);
            // else ignore. Strings are permitted to annotate entries
            // to assist in debugging.
          }catch(e){
            console.warn("ondispose() for",ctor.structName,'@',
                         m,'threw. NOT propagating it.',e);
          }
        });
      }
      delete obj.ondispose;
      delete __ptrBacklinks.get(ctor)[m];
      delete __ptrBacklinksGlobal[m];
      __instancePointerMap.delete(obj);
      if(ctor.debugFlags.__flags.dealloc){
        log("debug.dealloc:",(obj[xPtrPropName]?"EXTERNAL":""),
            ctor.structName,"instance:",
            ctor.structInfo.sizeof,"bytes @"+m);
      }
      if(!obj[xPtrPropName]) dealloc(m);
    }
  };

  /** Returns a skeleton for a read-only property accessor wrapping
      value v. */
  const rop = (v)=>{return {configurable: false, writable: false,
                            iterable: false, value: v}};

  /** Allocates obj's memory buffer based on the size defined in
      DEF.sizeof. */
  const __allocStruct = function(ctor, obj, m){
    let fill = !m;
    if(m) Object.defineProperty(obj, xPtrPropName, rop(m));
    else{
      m = alloc(ctor.structInfo.sizeof);
      if(!m) toss("Allocation of",ctor.structName,"structure failed.");
    }
    try {
      if(ctor.debugFlags.__flags.alloc){
        log("debug.alloc:",(fill?"":"EXTERNAL"),
            ctor.structName,"instance:",
            ctor.structInfo.sizeof,"bytes @"+m);
      }
      if(fill) heap().fill(0, m, m + ctor.structInfo.sizeof);
      __instancePointerMap.set(obj, m);
      __ptrBacklinks.get(ctor)[m] = obj;
      __ptrBacklinksGlobal[m] = obj;
    }catch(e){
      __freeStruct(ctor, obj, m);
      throw e;
    }
  };
  /** Gets installed as the memoryDump() method of all structs. */
  const __memoryDump = function(){
    const p = this.pointer;
    return p
      ? new Uint8Array(heap().slice(p, p+this.structInfo.sizeof))
      : null;
  };

  const __memberKey = (k)=>memberPrefix + k + memberSuffix;
  const __memberKeyProp = rop(__memberKey);

  /**
     Looks up a struct member in structInfo.members. Throws if found
     if tossIfNotFound is true, else returns undefined if not
     found. The given name may be either the name of the
     structInfo.members key (faster) or the key as modified by the
     memberPrefix/memberSuffix settings.
  */
  const __lookupMember = function(structInfo, memberName, tossIfNotFound=true){
    let m = structInfo.members[memberName];
    if(!m && (memberPrefix || memberSuffix)){
      // Check for a match on members[X].key
      for(const v of Object.values(structInfo.members)){
        if(v.key===memberName){ m = v; break; }
      }
      if(!m && tossIfNotFound){
        toss(sPropName(structInfo.name,memberName),'is not a mapped struct member.');
      }
    }
    return m;
  };

  /**
     Uses __lookupMember(obj.structInfo,memberName) to find a member,
     throwing if not found. Returns its signature, either in this
     framework's native format or in Emscripten format.
  */
  const __memberSignature = function f(obj,memberName,emscriptenFormat=false){
    if(!f._) f._ = (x)=>x.replace(/[^vipPsjrd]/g,'').replace(/[pPs]/g,'i');
    const m = __lookupMember(obj.structInfo, memberName, true);
    return emscriptenFormat ? f._(m.signature) : m.signature;
  };

  /**
     Returns the instanceForPointer() impl for the given
     StructType constructor.
  */
  const __instanceBacklinkFactory = function(ctor){
    const b = Object.create(null);
    __ptrBacklinks.set(ctor, b);
    return (ptr)=>b[ptr];
  };

  const __ptrPropDescriptor = {
    configurable: false, enumerable: false,
    get: function(){return __instancePointerMap.get(this)},
    set: ()=>toss("Cannot assign the 'pointer' property of a struct.")
    // Reminder: leaving `set` undefined makes assignments
    // to the property _silently_ do nothing. Current unit tests
    // rely on it throwing, though.
  };

  /** Impl of X.memberKeys() for StructType and struct ctors. */
  const __structMemberKeys = rop(function(){
    const a = [];
    Object.keys(this.structInfo.members).forEach((k)=>a.push(this.memberKey(k)));
    return a;
  });

  const __utf8Decoder = new TextDecoder('utf-8');
  const __utf8Encoder = new TextEncoder();

  /**
     Uses __lookupMember() to find the given obj.structInfo key.
     Returns that member if it is a string, else returns false. If the
     member is not found, throws if tossIfNotFound is true, else
     returns false.
   */
  const __memberIsString = function(obj,memberName, tossIfNotFound=false){
    const m = __lookupMember(obj.structInfo, memberName, tossIfNotFound);
    return (m && 1===m.signature.length && 's'===m.signature[0]) ? m : false;
  };

  /**
     Given a member description object, throws if member.signature is
     not valid for assigning to or interpretation as a C-style string.
     It optimistically assumes that any signature of (i,p,s) is
     C-string compatible.
  */
  const __affirmCStringSignature = function(member){
    if('s'===member.signature) return;
    toss("Invalid member type signature for C-string value:",
         JSON.stringify(member));
  };

  /**
     Looks up the given member in obj.structInfo. If it has a
     signature of 's' then it is assumed to be a C-style UTF-8 string
     and a decoded copy of the string at its address is returned. If
     the signature is of any other type, it throws. If an s-type
     member's address is 0, `null` is returned.
  */
  const __memberToJsString = function f(obj,memberName){
    const m = __lookupMember(obj.structInfo, memberName, true);
    __affirmCStringSignature(m);
    const addr = obj[m.key];
    //log("addr =",addr,memberName,"m =",m);
    if(!addr) return null;
    let pos = addr;
    const mem = heap();
    for( ; mem[pos]!==0; ++pos ) {
      //log("mem[",pos,"]",mem[pos]);
    };
    //log("addr =",addr,"pos =",pos);
    if(addr===pos) return "";
    return __utf8Decoder.decode(new Uint8Array(mem.buffer, addr, pos-addr));
  };

  /**
     Adds value v to obj.ondispose, creating ondispose,
     or converting it to an array, if needed.
  */
  const __addOnDispose = function(obj, v){
    if(obj.ondispose){
      if(obj.ondispose instanceof Function){
        obj.ondispose = [obj.ondispose];
      }/*else assume it's an array*/
    }else{
      obj.ondispose = [];
    }
    obj.ondispose.push(v);
  };

  /**
     Allocates a new UTF-8-encoded, NUL-terminated copy of the given
     JS string and returns its address relative to heap(). If
     allocation returns 0 this function throws. Ownership of the
     memory is transfered to the caller, who must eventually pass it
     to the configured dealloc() function.
  */
  const __allocCString = function(str){
    const u = __utf8Encoder.encode(str);
    const mem = alloc(u.length+1);
    if(!mem) toss("Allocation error while duplicating string:",str);
    const h = heap();
    let i = 0;
    for( ; i < u.length; ++i ) h[mem + i] = u[i];
    h[mem + u.length] = 0;
    //log("allocCString @",mem," =",u);
    return mem;
  };

  /**
     Sets the given struct member of obj to a dynamically-allocated,
     UTF-8-encoded, NUL-terminated copy of str. It is up to the caller
     to free any prior memory, if appropriate. The newly-allocated
     string is added to obj.ondispose so will be freed when the object
     is disposed.
  */
  const __setMemberCString = function(obj, memberName, str){
    const m = __lookupMember(obj.structInfo, memberName, true);
    __affirmCStringSignature(m);
    /* Potential TODO: if obj.ondispose contains obj[m.key] then
       dealloc that value and clear that ondispose entry */
    const mem = __allocCString(str);
    obj[m.key] = mem;
    __addOnDispose(obj, mem);
    return obj;
  };

  /**
     Prototype for all StructFactory instances (the constructors
     returned from StructBinder).
  */
  const StructType = function ctor(structName, structInfo){
    if(arguments[2]!==rop){
      toss("Do not call the StructType constructor",
           "from client-level code.");
    }
    Object.defineProperties(this,{
      //isA: rop((v)=>v instanceof ctor),
      structName: rop(structName),
      structInfo: rop(structInfo)
    });
  };

  /**
     Properties inherited by struct-type-specific StructType instances
     and (indirectly) concrete struct-type instances.
  */
  StructType.prototype = Object.create(null, {
    dispose: rop(function(){__freeStruct(this.constructor, this)}),
    lookupMember: rop(function(memberName, tossIfNotFound=true){
      return __lookupMember(this.structInfo, memberName, tossIfNotFound);
    }),
    memberToJsString: rop(function(memberName){
      return __memberToJsString(this, memberName);
    }),
    memberIsString: rop(function(memberName, tossIfNotFound=true){
      return __memberIsString(this, memberName, tossIfNotFound);
    }),
    memberKey: __memberKeyProp,
    memberKeys: __structMemberKeys,
    memberSignature: rop(function(memberName, emscriptenFormat=false){
      return __memberSignature(this, memberName, emscriptenFormat);
    }),
    memoryDump: rop(__memoryDump),
    pointer: __ptrPropDescriptor,
    setMemberCString: rop(function(memberName, str){
      return __setMemberCString(this, memberName, str);
    })
  });

  /**
     "Static" properties for StructType.
  */
  Object.defineProperties(StructType, {
    allocCString: rop(__allocCString),
    instanceForPointer: rop((ptr)=>__ptrBacklinksGlobal[ptr]),
    isA: rop((v)=>v instanceof StructType),
    hasExternalPointer: rop((v)=>(v instanceof StructType) && !!v[xPtrPropName]),
    memberKey: __memberKeyProp
  });

  const isNumericValue = (v)=>Number.isFinite(v) || (v instanceof (BigInt || Number));

  /**
     Pass this a StructBinder-generated prototype, and the struct
     member description object. It will define property accessors for
     proto[memberKey] which read from/write to memory in
     this.pointer. It modifies descr to make certain downstream
     operations much simpler.
  */
  const makeMemberWrapper = function f(ctor,name, descr){
    if(!f._){
      /*cache all available getters/setters/set-wrappers for
        direct reuse in each accessor function. */
      f._ = {getters: {}, setters: {}, sw:{}};
      const a = ['i','p','P','s','f','d','v()'];
      if(bigIntEnabled) a.push('j');
      a.forEach(function(v){
        //const ir = sigIR(v);
        f._.getters[v] = sigDVGetter(v) /* DataView[MethodName] values for GETTERS */;
        f._.setters[v] = sigDVSetter(v) /* DataView[MethodName] values for SETTERS */;
        f._.sw[v] = sigDVSetWrapper(v)  /* BigInt or Number ctor to wrap around values
                                           for conversion */;
      });
      const rxSig1 = /^[ipPsjfd]$/,
            rxSig2 = /^[vipPsjfd]\([ipPsjfd]*\)$/;
      f.sigCheck = function(obj, name, key,sig){
        if(Object.prototype.hasOwnProperty.call(obj, key)){
          toss(obj.structName,'already has a property named',key+'.');
        }
        rxSig1.test(sig) || rxSig2.test(sig)
          || toss("Malformed signature for",
                  sPropName(obj.structName,name)+":",sig);
      };
    }
    const key = ctor.memberKey(name);
    f.sigCheck(ctor.prototype, name, key, descr.signature);
    descr.key = key;
    descr.name = name;
    const sizeOf = sigSizeof(descr.signature);
    const sigGlyph = sigLetter(descr.signature);
    const xPropName = sPropName(ctor.prototype.structName,key);
    const dbg = ctor.prototype.debugFlags.__flags;
    /*
      TODO?: set prototype of descr to an object which can set/fetch
      its prefered representation, e.g. conversion to string or mapped
      function. Advantage: we can avoid doing that via if/else if/else
      in the get/set methods.
    */
    const prop = Object.create(null);
    prop.configurable = false;
    prop.enumerable = false;
    prop.get = function(){
      if(dbg.getter){
        log("debug.getter:",f._.getters[sigGlyph],"for", sigIR(sigGlyph),
            xPropName,'@', this.pointer,'+',descr.offset,'sz',sizeOf);
      }
      let rc = (
        new DataView(heap().buffer, this.pointer + descr.offset, sizeOf)
      )[f._.getters[sigGlyph]](0, isLittleEndian);
      if(dbg.getter) log("debug.getter:",xPropName,"result =",rc);
      if(rc && isAutoPtrSig(descr.signature)){
        rc = StructType.instanceForPointer(rc) || rc;
        if(dbg.getter) log("debug.getter:",xPropName,"resolved =",rc);
      }                
      return rc;
    };
    if(descr.readOnly){
      prop.set = __propThrowOnSet(ctor.prototype.structName,key);
    }else{
      prop.set = function(v){
        if(dbg.setter){
          log("debug.setter:",f._.setters[sigGlyph],"for", sigIR(sigGlyph),
              xPropName,'@', this.pointer,'+',descr.offset,'sz',sizeOf, v);
        }
        if(!this.pointer){
          toss("Cannot set struct property on disposed instance.");
        }
        if(null===v) v = 0;
        else while(!isNumericValue(v)){
          if(isAutoPtrSig(descr.signature) && (v instanceof StructType)){
            // It's a struct instance: let's store its pointer value!
            v = v.pointer || 0;
            if(dbg.setter) log("debug.setter:",xPropName,"resolved to",v);
            break;
          }
          toss("Invalid value for pointer-type",xPropName+'.');
        }
        (
          new DataView(heap().buffer, this.pointer + descr.offset, sizeOf)
        )[f._.setters[sigGlyph]](0, f._.sw[sigGlyph](v), isLittleEndian);
      };
    }
    Object.defineProperty(ctor.prototype, key, prop);
  }/*makeMemberWrapper*/;
  
  /**
     The main factory function which will be returned to the
     caller.
  */
  const StructBinder = function StructBinder(structName, structInfo){
    if(1===arguments.length){
      structInfo = structName;
      structName = structInfo.name;
    }else if(!structInfo.name){
      structInfo.name = structName;
    }
    if(!structName) toss("Struct name is required.");
    let lastMember = false;
    Object.keys(structInfo.members).forEach((k)=>{
      const m = structInfo.members[k];
      if(!m.sizeof) toss(structName,"member",k,"is missing sizeof.");
      else if(0!==(m.sizeof%4)){
        toss(structName,"member",k,"sizeof is not aligned.");
      }
      else if(0!==(m.offset%4)){
        toss(structName,"member",k,"offset is not aligned.");
      }
      if(!lastMember || lastMember.offset < m.offset) lastMember = m;
    });
    if(!lastMember) toss("No member property descriptions found.");
    else if(structInfo.sizeof < lastMember.offset+lastMember.sizeof){
      toss("Invalid struct config:",structName,
           "max member offset ("+lastMember.offset+") ",
           "extends past end of struct (sizeof="+structInfo.sizeof+").");
    }
    const debugFlags = rop(SBF.__makeDebugFlags(StructBinder.debugFlags));
    /** Constructor for the StructCtor. */
    const StructCtor = function StructCtor(externalMemory){
      if(!(this instanceof StructCtor)){
        toss("The",structName,"constructor may only be called via 'new'.");
      }else if(arguments.length){
        if(externalMemory!==(externalMemory|0) || externalMemory<=0){
          toss("Invalid pointer value for",structName,"constructor.");
        }
        __allocStruct(StructCtor, this, externalMemory);
      }else{
        __allocStruct(StructCtor, this);
      }
    };
    Object.defineProperties(StructCtor,{
      debugFlags: debugFlags,
      disposeAll: rop(function(){
        const map = __ptrBacklinks.get(StructCtor);
        Object.keys(map).forEach(function(ptr){
          const b = map[ptr];
          if(b) __freeStruct(StructCtor, b, ptr);
        });
        __ptrBacklinks.set(StructCtor, Object.create(null));
        return StructCtor;
      }),
      instanceForPointer: rop(__instanceBacklinkFactory(StructCtor)),
      isA: rop((v)=>v instanceof StructCtor),
      memberKey: __memberKeyProp,
      memberKeys: __structMemberKeys,
      resolveToInstance: rop(function(v, throwIfNot=false){
        if(!(v instanceof StructCtor)){
          v = Number.isSafeInteger(v)
            ? StructCtor.instanceForPointer(v) : undefined;
        }
        if(!v && throwIfNot) toss("Value is-not-a",StructCtor.structName);
        return v;
      }),
      methodInfoForKey: rop(function(mKey){
      }),
      structInfo: rop(structInfo),
      structName: rop(structName)
    });
    StructCtor.prototype = new StructType(structName, structInfo, rop);
    Object.defineProperties(StructCtor.prototype,{
      debugFlags: debugFlags,
      constructor: rop(StructCtor)
      /*if we assign StructCtor.prototype and don't do
        this then StructCtor!==instance.constructor!*/
    });
    Object.keys(structInfo.members).forEach(
      (name)=>makeMemberWrapper(StructCtor, name, structInfo.members[name])
    );
    return StructCtor;
  };
  StructBinder.instanceForPointer = StructType.instanceForPointer;
  StructBinder.StructType = StructType;
  StructBinder.config = config;
  StructBinder.allocCString = __allocCString;
  if(!StructBinder.debugFlags){
    StructBinder.debugFlags = SBF.__makeDebugFlags(SBF.debugFlags);
  }
  return StructBinder;
}/*StructBinderFactory*/;

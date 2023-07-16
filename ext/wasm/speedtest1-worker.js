'use strict';
(function(){
  let speedtestJs = 'speedtest1.js';
  const urlParams = new URL(self.location.href).searchParams;
  if(urlParams.has('sqlite3.dir')){
    speedtestJs = urlParams.get('sqlite3.dir') + '/' + speedtestJs;
  }
  importScripts(speedtestJs);
  /**
     If this environment contains OPFS, this function initializes it and
     returns the name of the dir on which OPFS is mounted, else it returns
     an empty string.
  */
  const wasmfsDir = function f(wasmUtil){
    if(undefined !== f._) return f._;
    const pdir = '/opfs';
    if( !self.FileSystemHandle
        || !self.FileSystemDirectoryHandle
        || !self.FileSystemFileHandle){
      return f._ = "";
    }
    try{
      if(0===wasmUtil.xCallWrapped(
        'sqlite3_wasm_init_wasmfs', 'i32', ['string'], pdir
      )){
        return f._ = pdir;
      }else{
        return f._ = "";
      }
    }catch(e){
      // sqlite3_wasm_init_wasmfs() is not available
      return f._ = "";
    }
  };
  wasmfsDir._ = undefined;

  const mPost = function(msgType,payload){
    postMessage({type: msgType, data: payload});
  };

  const App = Object.create(null);
  App.logBuffer = [];
  const logMsg = (type,msgArgs)=>{
    const msg = msgArgs.join(' ');
    App.logBuffer.push(msg);
    mPost(type,msg);
  };
  const log = (...args)=>logMsg('stdout',args);
  const logErr = (...args)=>logMsg('stderr',args);

  const runSpeedtest = async function(cliFlagsArray){
    const scope = App.wasm.scopedAllocPush();
    const dbFile = App.pDir+"/speedtest1.sqlite3";
    try{
      const argv = [
        "speedtest1.wasm", ...cliFlagsArray, dbFile
      ];
      App.logBuffer.length = 0;
      mPost('run-start', [...argv]);
      if(App.sqlite3.installOpfsSAHPoolVfs
         && !App.sqlite3.$SAHPoolUtil
         && cliFlagsArray.indexOf('opfs-sahpool')>=0){
        log("Installing opfs-sahpool...");
        await App.sqlite3.installOpfsSAHPoolVfs({
          directory: '.speedtest1-sahpool',
          defaultCapacity: 3,
          clearOnInit: true
        }).then(PoolUtil=>{
          log("opfs-sahpool successfully installed.");
          App.sqlite3.$SAHPoolUtil = PoolUtil;
        });
      }
      App.wasm.xCall('wasm_main', argv.length,
                     App.wasm.scopedAllocMainArgv(argv));
    }catch(e){
      mPost('error',e.message);
    }finally{
      App.wasm.scopedAllocPop(scope);
      mPost('run-end', App.logBuffer.join('\n'));
      App.logBuffer.length = 0;
    }
  };

  self.onmessage = function(msg){
    msg = msg.data;
    switch(msg.type){
        case 'run':
          runSpeedtest(msg.data || [])
            .catch(e=>mPost('error',e));
          break;
        default:
          logErr("Unhandled worker message type:",msg.type);
          break;
    }
  };

  const sahpSanityChecks = function(sqlite3){
    log("Attempting OpfsSAHPoolDb sanity checks...");
    const db = new sqlite3.oo1.OpfsSAHPoolDb('opfs-sahpoool.db');
    const fn = db.filename;
    db.exec([
      'create table t(a);',
      'insert into t(a) values(1),(2),(3);'
    ]);
    db.close();
    sqlite3.wasm.sqlite3_wasm_vfs_unlink(sqlite3_vfs_find("opfs-sahpool"), fn);
    log("SAH sanity checks done.");
  };

  const EmscriptenModule = {
    print: log,
    printErr: logErr,
    setStatus: (text)=>mPost('load-status',text)
  };
  log("Initializing speedtest1 module...");
  self.sqlite3InitModule(EmscriptenModule).then(async (sqlite3)=>{
    const S = globalThis.S = App.sqlite3 = sqlite3;
    log("Loaded speedtest1 module. Setting up...");
    App.vfsUnlink = function(pDb, fname){
      const pVfs = S.wasm.sqlite3_wasm_db_vfs(pDb, 0);
      if(pVfs) S.wasm.sqlite3_wasm_vfs_unlink(pVfs, fname||0);
    };
    App.pDir = wasmfsDir(S.wasm);
    App.wasm = S.wasm;
    //if(App.pDir) log("Persistent storage:",pDir);
    //else log("Using transient storage.");
    mPost('ready',true);
    log("Registered VFSes:", ...S.capi.sqlite3_js_vfs_list());
  }).catch(e=>{
    logErr(e);
  });
})();

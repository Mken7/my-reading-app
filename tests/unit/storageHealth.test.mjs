import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectDraftStorage,requestDraftPersistence,estimatedStoragePercent,
} from "../../lib/v2/storageHealth.ts";

test("storage check explicitly tests write ability but never takes draft plaintext",async()=>{
  let attempts=0;
  const health=await inspectDraftStorage(async()=>{attempts++;},{
    persisted:async()=>true,estimate:async()=>({usage:4_000,quota:20_000}),
  });
  assert.equal(attempts,1);
  assert.deepEqual(health,{
    databaseWritable:true,persistence:"granted",usedPercent:20,warning:null,
  });
});

test("read-only or disabled IndexedDB fails closed without claiming durability",async()=>{
  const health=await inspectDraftStorage(async()=>{
    throw new Error("QuotaExceededError");
  },{
    persisted:async()=>true,estimate:async()=>({usage:1,quota:10}),
  });
  assert.equal(health.databaseWritable,false);
  assert.equal(health.persistence,"unknown");
  assert.equal(health.usedPercent,null);
  assert.match(health.warning,/无法完成 IndexedDB/);
});

test("best-effort storage and high site usage show explicit warnings",async()=>{
  const health=await inspectDraftStorage(async()=>{},{
    persisted:async()=>false,estimate:async()=>({usage:99,quota:100}),
  });
  assert.equal(health.persistence,"best-effort");
  assert.equal(health.usedPercent,99);
  assert.match(health.warning,/占用较高/);

  const bestEffort=await inspectDraftStorage(async()=>{},{
    persisted:async()=>false,estimate:async()=>({usage:2,quota:100}),
  });
  assert.match(bestEffort.warning,/可能清理草稿/);
});

test("missing APIs, permission errors and invalid quota are not treated as success",async()=>{
  const absent=await inspectDraftStorage(async()=>{});
  assert.equal(absent.persistence,"unknown");
  assert.equal(absent.usedPercent,null);
  assert.match(absent.warning,/无法报告/);

  const broken=await inspectDraftStorage(async()=>{},{
    persisted:async()=>{throw Error("not allowed");},
    estimate:async()=>{throw Error("denied");},
  });
  assert.equal(broken.databaseWritable,true);
  assert.equal(broken.persistence,"unknown");
  assert.equal(broken.usedPercent,null);
  assert.equal(estimatedStoragePercent(-2,100),null);
  assert.equal(estimatedStoragePercent(2,0),null);
  assert.equal(estimatedStoragePercent(Infinity,100),null);
  assert.equal(estimatedStoragePercent(1,4),25);
  assert.equal(estimatedStoragePercent(120,100),100);
});

test("persist is only requested by direct invocation and denial is recoverable",async()=>{
  let asked=0;
  const storage={persist:async()=>{asked++;return false;}};
  assert.equal(asked,0);
  assert.equal(await requestDraftPersistence(storage),"denied");
  assert.equal(asked,1);
  assert.equal(await requestDraftPersistence({persist:async()=>true}),"granted");
  assert.equal(await requestDraftPersistence({}),"unsupported");
  assert.equal(await requestDraftPersistence({persist:async()=>{
    throw new Error("SecurityError");
  }}),"denied");
});

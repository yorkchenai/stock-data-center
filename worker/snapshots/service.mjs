import { resolveSymbol } from "../../web/engine.mjs";
import { analysisQuery, snapshotExpiry } from "./compute.mjs";
import { createRecord, snapshotStore } from "./store.mjs";
import { SNAPSHOT_ID, selectDetails, snapshotMetadata } from "./details.mjs";

const response = (status, message, extra={}) => ({schema_version:1,status,message,...extra});
const unavailable=()=>response("data_unavailable","行情源不可用或数据未通过校验。",{retry_after_seconds:15});

export function analysisService({compute,calendar,modelVersion,clock=()=>new Date(),observe=()=>{}}) {
  if (!modelVersion) throw new Error("必须配置分析模型版本。");
  const ms=()=>clock().getTime();

  async function build(store,key,token,query,refresh) {
    const started=ms();
    try {
      let data;
      try { data=await compute(query,{refresh}); }
      catch (error) {
        observe({event:"snapshot_failure",symbol:query.symbol,reason:error.message});
        await store.cooldown(key,token,ms());
        return unavailable();
      }
      const now=clock();
      const snapshot={snapshot_id:crypto.randomUUID(),schema_version:1,model_version:modelVersion,
        asset_type:query.asset_type,symbol:query.symbol,computed_at:now.toISOString(),
        expires_at:new Date(snapshotExpiry(query,data,calendar,now)).toISOString(),...data};
      const record=await createRecord(snapshot);
      await store.publish(key,token,snapshot,record,ms());
      observe({event:"snapshot_publish",symbol:snapshot.symbol,snapshot_id:snapshot.snapshot_id,
        status:snapshot.status,bytes:record.bytes,compressed_bytes:record.compressed_bytes,
        duration_ms:ms()-started});
      return {...snapshotMetadata(snapshot),...snapshot.summary,cache:"miss"};
    } catch (error) {
      observe({event:"snapshot_write_error",symbol:query.symbol,reason:error.message});
      return response("cache_unavailable","快照存储或写入失败。");
    } finally {
      await store.release(key,token).catch(()=>{});
    }
  }

  return {
    async initial(binding,args,{waitUntil,waitMs=7_000}={}) {
      const requestedAfter=args?.after_snapshot_id;
      if (requestedAfter!==undefined && (typeof requestedAfter!=="string"||!SNAPSHOT_ID.test(requestedAfter)||args.refresh)) {
        return response("invalid_arguments","续查刷新需要有效的旧快照编号，且不能再次请求刷新。");
      }
      let query;
      try { query=analysisQuery(args,calendar,clock()); }
      catch (error) { return response("invalid_arguments",error.message); }
      const key=JSON.stringify([modelVersion,query]);
      const cacheHit=(snapshot)=>{
        observe({event:"snapshot_hit",symbol:snapshot.symbol,snapshot_id:snapshot.snapshot_id});
        return {...snapshotMetadata(snapshot),...snapshot.summary,cache:"hit"};
      };
      const building=(previous)=>response("building",previous?
        "快照正在刷新。按同一代码和返回的 after_snapshot_id 续查。":
        "快照正在构建。结束后按同一代码查询即可获得快照编号。",
        {asset_type:query.asset_type,symbol:query.symbol,retry_after_seconds:3,
          ...(previous?{after_snapshot_id:previous}:{})});
      try {
        const store=snapshotStore(binding);
        if (requestedAfter!==undefined) {
          const previous=await store.header(requestedAfter);
          if (!previous||previous.cache_key!==key) return response("snapshot_not_found","找不到该查询的旧快照。");
          // Read build state before the candidate. If publication committed in
          // between, the candidate read can see the new ID, never the old one.
          const state=await store.buildState(key,ms());
          const newer=await store.latest(key,ms());
          if (newer&&newer.snapshot_id!==requestedAfter&&Date.parse(newer.computed_at)>=previous.created_at) {
            return cacheHit(newer);
          }
          if (state?.failure) return unavailable();
          if (state) return building(requestedAfter);
          return response("refresh_not_found","没有更新的快照或进行中的刷新。");
        }
        const before=await store.latest(key,ms());
        if (before&&!args.refresh) return cacheHit(before);
        const token=await store.lease(key,ms());
        if (!token) {
          const ready=await store.latest(key,ms());
          if (ready && ready.snapshot_id!==before?.snapshot_id) return cacheHit(ready);
          return (await store.buildState(key,ms()))?.failure ? unavailable() : building(before?.snapshot_id);
        }
        let after;
        try { after=await store.latest(key,ms()); }
        catch (error) { await store.release(key,token).catch(()=>{}); throw error; }
        if (after && (!args.refresh || after.snapshot_id!==before?.snapshot_id)) {
          await store.release(key,token);
          return cacheHit(after);
        }
        const work=build(store,key,token,query,args.refresh===true);
        if (!waitUntil) return await work;
        waitUntil(work);
        let timer;
        try {
          return await Promise.race([work,new Promise((resolve)=>{
            timer=setTimeout(()=>resolve(building(before?.snapshot_id)),waitMs);
          })]);
        } finally {clearTimeout(timer);}
      } catch {
        return response("cache_unavailable","快照缓存不可用。");
      }
    },
    async details(binding,args,options={}) {
      if (!SNAPSHOT_ID.test(args?.snapshot_id??"") || !["stock","fund"].includes(args?.asset_type)) {
        return response("invalid_arguments","请提供首次查询返回的快照编号和标的类型。");
      }
      let symbol=args.symbol;
      try {
        if (args.asset_type==="stock") {
          const resolved=resolveSymbol(symbol,args.kind??"auto");
          symbol=resolved.market+resolved.code;
        } else if (typeof symbol!=="string" || !/^\d{6}$/.test(symbol)) {
          throw new Error("基金代码必须为六位数字。");
        }
      } catch(error) {return response("invalid_arguments",error.message);}
      let snapshot;
      try {
        const store=snapshotStore(binding);
        const head=await store.header(args.snapshot_id);
        if (!head || head.symbol!==symbol || head.asset_type!==args.asset_type) {
          return response("snapshot_not_found","找不到此标的的快照。");
        }
        if (head.expires_at<=ms()) {
          return response("expired","此快照已过期，请重新查询生成新快照。",{snapshot_id:head.id});
        }
        snapshot=await store.load(head);
      } catch {
        return response("cache_unavailable","快照缓存不可用。");
      }
      try {
        const result=selectDetails(snapshot,args,options);
        observe({event:"snapshot_read",snapshot_id:snapshot.snapshot_id,symbol,category:args.category});
        return result;
      } catch (error) {
        return response("invalid_arguments",error.message);
      }
    },
  };
}

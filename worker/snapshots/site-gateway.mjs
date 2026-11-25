const headers = {"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};

export function mountSnapshotSite({analysis, legacy}) {
  return {
    fetch(request, env={}, ctx) {
      const {pathname}=new URL(request.url);
      const expected=env.SNAPSHOT_MCP_OWNER_EMAIL?.trim().toLowerCase();
      if (pathname==="/api/analysis" && env.SNAPSHOT_PUBLIC_ENABLED==="1" && expected) {
        return analysis.fetch(request,env,ctx);
      }
      if (pathname==="/mcp" || pathname==="/") {
        // These identity headers must be supplied by the Sites dispatch gateway.
        const email=request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
        const user=request.headers.get("oai-authenticated-user-id")?.trim();
        if (!expected || !user || email!==expected) return new Response(null,{status:403,headers});
        return legacy.fetch(request,env,ctx);
      }
      return new Response(null,{status:404,headers});
    },
  };
}

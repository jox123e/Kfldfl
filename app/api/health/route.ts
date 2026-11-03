export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      ok: true,
      service: "roblox-mcp",
      status: "healthy",
      endpoints: {
        mcp: "/api/mcp",
        health: "/api/health",
      },
      auth: "MCP endpoint requires Authorization: Bearer <MCP_AUTH_TOKEN>",
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

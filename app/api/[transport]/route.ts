          headers: { "x-api-key": env("ROBLOX_API_KEY") },
          body: form,
        });
        const created = await parse(res);
        const opPath = (created.data as any)?.path;
        if (!created.ok || !opPath) return out(created);
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const op = await rbx(`/assets/v1/${opPath}`);
          if ((op.data as any)?.done) return out(op);
        }
        return out({ pending: true, operation: opPath });
      }
    );
  },
  {},
  { basePath: "/api" }
);

async function guarded(req: Request) {
  const token = process.env.MCP_AUTH_TOKEN;
  const given =
    req.headers.get("authorization")?.replace(/^Bearer /, "") ??
    new URL(req.url).searchParams.get("token");
  if (!token || given !== token) return new Response("Unauthorized", { status: 401 });
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };


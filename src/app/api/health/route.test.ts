import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

let dbOk = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbOk = true;
} catch {
  dbOk = false;
}
const suite = dbOk ? describe : describe.skip;

afterEach(() => vi.restoreAllMocks());

suite("GET /api/health — la sonde dit si la BASE répond, pas seulement le processus", () => {
  it("200 et ok quand Postgres répond", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, base: "ok" });
  });

  it("503 quand la base est injoignable — sans fuite du message d'erreur", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.7:5432"));
    const res = await GET();
    expect(res.status).toBe(503);
    const corps = JSON.stringify(await res.json());
    expect(corps).not.toContain("10.0.0.7");
  });
});

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * SONDE DE SANTÉ — ce que Render doit interroger (`healthCheckPath`), au lieu de `/login`.
 *
 * `/login` est une page STATIQUE : elle répond 200 tant que le processus Node vit, même quand
 * Postgres est injoignable (DATABASE_URL tournée, base gratuite expirée, pool épuisé). Render
 * basculait alors le trafic sur une instance incapable de servir une seule page de l'ERP, et ne
 * redémarrait jamais une instance dont la base était perdue.
 *
 * Ici : un `SELECT 1` borné à 3 s. 200 = processus ET base ; 503 sinon. Publique (Render
 * n'a pas de session), elle ne dit RIEN d'autre que « ok » / « base injoignable » — ni version,
 * ni hôte, ni message d'erreur (ceux-là partent au journal du serveur).
 */
export const dynamic = "force-dynamic";

const DELAI_MS = 3_000;

export async function GET() {
  const debut = Date.now();
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rejeter) => {
        minuteur = setTimeout(() => rejeter(new Error(`SELECT 1 > ${DELAI_MS} ms`)), DELAI_MS);
      }),
    ]);
    return NextResponse.json(
      { ok: true, base: "ok", ms: Date.now() - debut },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[health] base injoignable", e);
    return NextResponse.json(
      { ok: false, base: "injoignable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    if (minuteur) clearTimeout(minuteur);
  }
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { incidentsRecents, journal, SEUIL_INCIDENT } from "@/lib/journal";
import { verifierMigrations } from "@/lib/migrations-appliquees";

/**
 * SONDE DE SANTÉ — ce que Render doit interroger (`healthCheckPath`), au lieu de `/login`.
 *
 * `/login` est une page STATIQUE : elle répond 200 tant que le processus Node vit, même quand
 * Postgres est injoignable (DATABASE_URL tournée, base gratuite expirée, pool épuisé). Render
 * basculait alors le trafic sur une instance incapable de servir une seule page de l'ERP, et ne
 * redémarrait jamais une instance dont la base était perdue.
 *
 * Trois contrôles, dans l'ordre :
 *  1. la BASE — un `SELECT 1` borné à 3 s ; 503 `base: "injoignable"` sinon ;
 *  2. les MIGRATIONS — toutes celles du dépôt sont appliquées ; 503 `migrations: "en-retard"`
 *     sinon (un tableau de bord Render qui aurait perdu `migrate deploy` fait échouer le
 *     déploiement au lieu de servir du code sur un schéma en retard) ;
 *  3. les ERREURS RÉPÉTÉES de ce processus (journal unique, quinze dernières minutes) —
 *     `etat: "degrade"` quand un événement dépasse le seuil. Ce n'est PAS un 503 : redémarrer
 *     l'instance ne répare pas une requête qui échoue, et Render bouclerait sur des redémarrages.
 *
 * Publique (Render n'a pas de session) : elle ne dit que des états et des nombres — ni version,
 * ni hôte, ni message d'erreur, ni nom d'événement (ceux-là sont au journal et au Diagnostic).
 */
export const dynamic = "force-dynamic";

const DELAI_MS = 3_000;
const FENETRE_INCIDENTS_MS = 15 * 60_000;

const SANS_CACHE = { "Cache-Control": "no-store" };

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
  } catch (e) {
    journal.erreur("sante.base-injoignable", {}, e);
    return NextResponse.json({ ok: false, base: "injoignable" }, { status: 503, headers: SANS_CACHE });
  } finally {
    if (minuteur) clearTimeout(minuteur);
  }

  let migrations: Awaited<ReturnType<typeof verifierMigrations>>;
  try {
    migrations = await verifierMigrations();
  } catch (e) {
    journal.erreur("sante.migrations-illisibles", {}, e);
    return NextResponse.json({ ok: false, base: "injoignable" }, { status: 503, headers: SANS_CACHE });
  }
  if (migrations.etat === "en-retard") {
    journal.erreur("sante.migrations-en-retard", { manquantes: migrations.manquantes });
    return NextResponse.json(
      { ok: false, base: "ok", migrations: "en-retard", manquantes: migrations.manquantes.length },
      { status: 503, headers: SANS_CACHE },
    );
  }

  const incidents = incidentsRecents(FENETRE_INCIDENTS_MS);
  const repetes = incidents.filter((i) => i.compte >= SEUIL_INCIDENT).length;
  return NextResponse.json(
    {
      ok: true,
      base: "ok",
      migrations: migrations.etat,
      etat: repetes > 0 ? "degrade" : "sain",
      incidents: { evenements: incidents.length, repetes, erreurs: incidents.reduce((s, i) => s + i.compte, 0) },
      ms: Date.now() - debut,
    },
    { headers: SANS_CACHE },
  );
}

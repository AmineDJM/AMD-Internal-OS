import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";

/**
 * LES LECTURES DE NOTIFICATIONS SERVENT LEUR TRI (§118.174).
 *
 * Deux lectures reviennent à chaque page : « ses non lues, les plus récentes d'abord » (centre
 * d'actions, boîte de décision) et « toutes ses notifications, les plus récentes d'abord » (page
 * Notifications). Avec `(userId, isRead)` seul, le planificateur n'a pas le tri : pour une personne
 * qui a peu de notifications il parcourt l'index des dates à l'envers en filtrant, c'est-à-dire
 * TOUTE la table. Mesuré sur la base de développement, pour une personne sans notification :
 * 4 757 069 lignes écartées, 1,8 s — et la boîte de décision, dont le budget est de 1,5 s au P95,
 * est passée de 1 964 ms (P50) à 53 ms.
 *
 * CE QUE CE BANC TIENT, ET CE QU'IL NE TIENT PAS. Il tient l'ARTEFACT (les deux index existent dans
 * le schéma ET en base, la date en dernier et en tri décroissant) et l'APPELANT (les deux lectures
 * de production demandent le tri que ces index servent — un index que personne n'interroge ne
 * protège de rien, §118.49). Il ne rejoue PAS le plan : le choix du planificateur dépend du volume
 * et des statistiques — la mauvaise voie n'apparaît qu'avec des millions de lignes —, donc un cas
 * qui l'exigerait passerait sur une base petite sans rien mesurer (§118.17). Le témoin de volume
 * est `inbox/compose.test.ts` (P95 < 1,5 s sur la base locale), qui est tombé le premier.
 */

/** Le texte sans ses commentaires : un cliquet qui lit la prose trouve sa propre description. */
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function modele(nom: string): string {
  const src = fs.readFileSync("prisma/schema.prisma", "utf8");
  const debut = src.indexOf(`model ${nom} {`);
  if (debut < 0) throw new Error(`modèle ${nom} introuvable dans le schéma`);
  return sansCommentaires(src.slice(debut, src.indexOf("\n}", debut)));
}

/** Le texte de l'appel `prisma.notification.findMany(…)`, parenthèses équilibrées — ou `null`. */
function appelFindMany(source: string): string | null {
  const code = sansCommentaires(source);
  const debut = code.indexOf("notification.findMany(");
  if (debut < 0) return null;
  let profondeur = 0;
  for (let i = code.indexOf("(", debut); i < code.length; i++) {
    if (code[i] === "(") profondeur++;
    else if (code[i] === ")" && --profondeur === 0) return code.slice(debut, i + 1);
  }
  return null;
}

/** La lecture demande-t-elle EXACTEMENT ce tri, sur ces filtres ? (compacté : la mise en forme ne compte pas) */
function demande(appel: string | null, filtres: RegExp, tri: RegExp): boolean {
  if (!appel) return false;
  const compact = appel.replace(/\s+/g, " ");
  return filtres.test(compact) && tri.test(compact);
}

// La personne et « non lue » d'abord ; la clause des liens encore ouvrables (25/11/2026, `clauseNotificationsOuvrables`)
// s'y ajoute en `AND` — elle ne porte que sur `link`, l'index sert toujours l'égalité et le tri.
const FILTRE_NON_LUES = /where: \{ (?:AND: \[\{ )?userId: user\.id, isRead: false \}/;
const FILTRE_TOUTES = /where: \{ (?:AND: \[\{ )?userId: user\.id \}/;
const TRI_RECENTES_D_ABORD = /orderBy: \{ createdAt: "desc" \}/;

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suiteBase = dbOk ? describe : describe.skip;

describe("les index de lecture des notifications — le schéma", () => {
  it("déclare les deux index, la date EN DERNIER et en tri décroissant", () => {
    const m = modele("Notification");
    expect(m).toContain("@@index([userId, isRead, createdAt(sort: Desc)])");
    expect(m).toContain("@@index([userId, createdAt(sort: Desc)])");
  });

  it("ne garde pas l'ancien index sans date, dont le premier est un préfixe", () => {
    // Redondant : un index qui n'apporte que des écritures. Le retirer ne perd aucune lecture.
    expect(modele("Notification")).not.toMatch(/@@index\(\[userId, isRead\]\)/);
  });
});

describe("les index de lecture des notifications — la migration", () => {
  // C'est ELLE que le déploiement rejoue, pas la base de développement : un banc qui ne lit que la
  // base verrait un index posé à la main et laisserait une migration fausse partir en production.
  const migration = sansCommentaires(
    fs.readFileSync("prisma/migrations/20261216090000_notification_non_lues_index/migration.sql", "utf8").replace(/--.*$/gm, ""),
  ).replace(/\s+/g, " ");

  it("crée les deux index, la date en tri décroissant, de façon idempotente", () => {
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt" DESC)');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC)');
  });

  it("retire l'ancien index APRÈS avoir créé les nouveaux — il reste toujours un index sur ces colonnes", () => {
    const retire = migration.indexOf('DROP INDEX IF EXISTS "Notification_userId_isRead_idx"');
    expect(retire).toBeGreaterThan(-1);
    expect(retire).toBeGreaterThan(migration.lastIndexOf("CREATE INDEX"));
  });
});

suiteBase("les index de lecture des notifications — la base", () => {
  it("porte les deux index, avec la date en tri décroissant", async () => {
    const lignes = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Notification'`;
    const def = (nom: string) => lignes.find((l) => l.indexname === nom)?.indexdef ?? "";
    expect(def("Notification_userId_isRead_createdAt_idx")).toMatch(/btree \("userId", "isRead", "createdAt" DESC\)/);
    expect(def("Notification_userId_createdAt_idx")).toMatch(/btree \("userId", "createdAt" DESC\)/);
  });
});

describe("les index de lecture des notifications — l'appelant", () => {
  it("le centre d'actions lit « non lues, plus récentes d'abord »", () => {
    const appel = appelFindMany(fs.readFileSync("src/lib/queries/action-center.ts", "utf8"));
    expect(demande(appel, FILTRE_NON_LUES, TRI_RECENTES_D_ABORD), appel ?? "aucun appel trouvé").toBe(true);
  });

  it("la page Notifications lit « toutes, plus récentes d'abord »", () => {
    const appel = appelFindMany(fs.readFileSync("src/app/(app)/notifications/page.tsx", "utf8"));
    expect(demande(appel, FILTRE_TOUTES, TRI_RECENTES_D_ABORD), appel ?? "aucun appel trouvé").toBe(true);
  });

  it("TÉMOIN : le juge sait dire non — un autre tri, ou un autre filtre, n'est pas servi par ces index", () => {
    // Sans ces deux cas, un juge qui répond « oui » à tout laisserait passer n'importe quelle lecture.
    const parPopup = 'prisma.notification.findMany({ where: { userId: user.id, isRead: false }, orderBy: { popup: "desc" }, take: 20 })';
    expect(demande(appelFindMany(parPopup), FILTRE_NON_LUES, TRI_RECENTES_D_ABORD)).toBe(false);
    const sansPersonne = 'prisma.notification.findMany({ where: { isRead: false }, orderBy: { createdAt: "desc" }, take: 20 })';
    expect(demande(appelFindMany(sansPersonne), FILTRE_NON_LUES, TRI_RECENTES_D_ABORD)).toBe(false);
    // Et il sait dire oui, sur la lecture qu'il sert.
    const bonne = 'prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 100 })';
    expect(demande(appelFindMany(bonne), FILTRE_TOUTES, TRI_RECENTES_D_ABORD)).toBe(true);
    expect(appelFindMany("const x = 1;")).toBeNull();
  });
});

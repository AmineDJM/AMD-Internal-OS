import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { companyScopedWhere, platformScope } from "@/lib/company";
import { canAccessEntity } from "@/lib/entity-access";
import { createMailEntry } from "@/lib/actions/mail-register-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__courrier404__";

/**
 * « J'ENREGISTRE MON COURRIER, ET LA PAGE EST INTROUVABLE. »
 *
 * ── LE DÉFAUT, TEL QU'IL SE PRODUIT ─────────────────────────────────────────────────────────
 *
 * Le formulaire propose « Entité concernée » avec un choix vide en tête et ne l'exige pas. Une
 * assistante enregistre son pli sans y toucher — c'est l'état par défaut du champ dès qu'il y a
 * plus d'une société. Trois conséquences s'enchaînent :
 *
 *   1. le courrier naît SANS ENTITÉ. Le noyau devait retomber sur celle du créateur, mais un
 *      menu laissé vide rend `null`, et `null` n'est pas « pas de valeur » : le repli est sauté ;
 *   2. LE REGISTRE LE MONTRE quand même — la liste garde volontairement les lignes sans entité,
 *      parce qu'une ligne qu'on ne voit pas est une ligne qu'on ne peut pas rattacher ;
 *   3. SA FICHE RÉPOND 404, et ses pièces jointes sont refusées : elles appliquaient, elles, le
 *      filtre STRICT — celui qui exclut les lignes sans entité.
 *
 * Le résultat est le pire des trois : le courrier est là, on le voit, on clique, il n'existe
 * pas. Et le scan qu'on venait d'y joindre n'est plus atteignable par personne.
 *
 * ── POURQUOI UNE EMPLOYÉE, ET PAS UN ADMINISTRATEUR ─────────────────────────────────────────
 *
 * Un rôle qui voit tout le groupe n'a AUCUN filtre d'entité : chez lui, la fiche s'ouvre. Le
 * défaut ne se montre qu'à ceux qui relèvent d'une société — c'est-à-dire à presque tout le
 * monde sauf celui qui teste.
 */
suite("Un courrier enregistré s'ouvre — liste et fiche disent la même chose", () => {
  let companyA = "";
  let companyB = "";
  let userId = "";

  beforeAll(async () => {
    // DEUX ENTITÉS : en dessous, la plateforme ne cloisonne rien et le défaut ne peut pas naître.
    const [a, b] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG} Adventum`, shortName: `${TAG}A` }, select: { id: true } }),
      prisma.company.create({ data: { name: `${TAG} Pharmagène`, shortName: `${TAG}B` }, select: { id: true } }),
    ]);
    companyA = a.id; companyB = b.id;

    // UNE EMPLOYÉE ORDINAIRE : elle relève d'une société, elle ne voit pas tout le groupe.
    const u = await prisma.user.create({
      data: { name: `${TAG} assistante`, email: `${TAG}@t.dz`, role: "DIRECTION_ASSISTANT", passwordHash: "x" },
      select: { id: true },
    });
    userId = u.id;
    await prisma.userCompanyAccess.create({ data: { userId, companyId: companyA, canEdit: true } });

    const access = await getAccess(userId, "DIRECTION_ASSISTANT");
    ACTOR = {
      id: userId, name: `${TAG} assistante`, email: `${TAG}@t.dz`,
      role: "DIRECTION_ASSISTANT", access, mustChangePassword: false,
    };
  }, 60_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => {});
    await prisma.mailEntry.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  /** Le formulaire, tel qu'il part quand personne ne touche au menu « Entité concernée ». */
  function formulaireSansEntite(titre: string): FormData {
    const f = new FormData();
    f.set("title", titre);
    f.set("direction", "INCOMING");
    // Le champ EST présent — le menu s'affiche — mais rien n'y est choisi. C'est tout le sujet.
    f.set("companyId", "");
    return f;
  }

  it("LE COURRIER NAÎT AVEC UNE ENTITÉ, même quand le menu est resté vide", async () => {
    const r = await createMailEntry(undefined, formulaireSansEntite(`${TAG} Convocation ANPP`));
    expect(r.ok, r.error).toBe(true);
    const entry = await prisma.mailEntry.findUniqueOrThrow({ where: { id: r.id! } });
    // Un menu laissé vide n'est pas un choix : c'est l'absence de choix. Le repli du noyau —
    // l'entité du créateur — doit s'appliquer, sinon la ligne naît hors de toutes les vues.
    expect(entry.companyId).toBe(companyA);
  });

  it("LA LISTE ET LA FICHE DISENT LA MÊME CHOSE — un pli visible s'ouvre", async () => {
    const r = await createMailEntry(undefined, formulaireSansEntite(`${TAG} Mise en demeure`));
    expect(r.ok, r.error).toBe(true);

    const dansLaListe = await prisma.mailEntry.findMany({
      where: await companyScopedWhere(userId, { title: { startsWith: TAG } }),
      select: { id: true },
    });
    expect(dansLaListe.map((x) => x.id)).toContain(r.id);

    // LA FICHE, avec la MÊME requête que `app/(app)/courriers/[id]/page.tsx`.
    const surLaFiche = await prisma.mailEntry.findFirst({
      where: await companyScopedWhere(userId, { id: r.id! }),
      select: { id: true },
    });
    expect(surLaFiche, "le courrier est dans la liste mais sa fiche répond 404").not.toBeNull();
  });

  it("ET SES PIÈCES JOINTES SUIVENT — un scan déposé reste atteignable", async () => {
    const r = await createMailEntry(undefined, formulaireSansEntite(`${TAG} Accusé de réception`));
    expect(r.ok, r.error).toBe(true);
    // C'est cette porte qui gouverne le téléversement ET le téléchargement des pièces.
    expect(await canAccessEntity(ACTOR!, "MAIL_ENTRY", r.id!, "VIEW")).toBe(true);
  });

  it("LE CLOISONNEMENT TIENT TOUJOURS — le pli d'une autre société reste fermé", async () => {
    // La correction ne doit pas ouvrir le registre du voisin : c'est exactement ce que le
    // filtre protège, et l'assouplir pour faire passer le cas d'à côté serait le trahir.
    const voisin = await prisma.mailEntry.create({
      data: { title: `${TAG} Pli de Pharmagène`, direction: "INCOMING", companyId: companyB },
      select: { id: true },
    });
    const vu = await prisma.mailEntry.findFirst({
      where: await companyScopedWhere(userId, { id: voisin.id }),
      select: { id: true },
    });
    expect(vu).toBeNull();
    expect(await canAccessEntity(ACTOR!, "MAIL_ENTRY", voisin.id, "VIEW")).toBe(false);
  });

  it("le filtre STRICT et le filtre de LISTE ne divergent que sur les lignes sans entité", async () => {
    // Ce test documente la différence exacte qui a produit le 404 — il vaut relecture le jour
    // où quelqu'un se demandera lequel des deux poser sur un nouvel écran.
    const strict = await platformScope(userId);
    const liste = await companyScopedWhere(userId, {});
    expect(strict).not.toEqual({});
    expect(JSON.stringify(liste)).toContain("null");
  });
});

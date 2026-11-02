import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { platformScope } from "@/lib/company";
import { getRequestList } from "@/lib/queries/admin-requests";
import { demanderPieceSecretariat } from "@/modules/ad-pro/actions-postes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TOUTE DEMANDE AU SECRÉTARIAT NAÎT AVEC UNE SOCIÉTÉ (§118.154).
 *
 * Le bureau du secrétariat (`/demandes`, `getRequestList`) est cloisonné par société, et une ligne
 * sans société n'apparaît dans AUCUNE vue cloisonnée (`platformScopeWhere`). Trouvé dans la peau de
 * l'assistante de direction sur la demande de devis du matériel promotionnel, puis cherché chez
 * TOUS les écrivains (§118.96) : sur six créations, trois ne posaient rien — la demande de devis
 * d'un dossier d'avant le rattachement, la pièce demandée pour un poste Ad & Pro, et le LOT de
 * cellules, dont la création unitaire du même fichier posait pourtant la société (§118.71). Un
 * délégué qui envoyait trois demandes d'un coup ne les retrouvait pas dans sa propre liste.
 *
 * Réparer trois écrivains ne protège pas le quatrième (§118.58) : le cliquet lit la SOURCE et exige
 * la clé sur toute création. Les cas de base partent des vrais points d'entrée, avec des acteurs
 * SANS vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────── Le cliquet : un fait de la source ───────────────────────────

/** Les fichiers de production du dépôt — jamais un banc, qui écrit ce qu'il veut. */
function fichiersDeProduction(dir = "src"): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(dir)) {
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) { out.push(...fichiersDeProduction(p)); continue; }
    if (!/\.(ts|tsx)$/.test(nom) || /\.test\.tsx?$/.test(nom) || /\.spec\.tsx?$/.test(nom)) continue;
    out.push(p);
  }
  return out;
}

/** La source SANS commentaires : un commentaire qui cite `companyId:` ne pose aucune société (§118.79d). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Le texte d'un appel, de sa parenthèse ouvrante à la fermante qui l'équilibre — chaînes sautées. */
function appelEquilibre(src: string, ouvrante: number): string | null {
  let prof = 0;
  for (let i = ouvrante; i < src.length && i < ouvrante + 8000; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const fin = src.indexOf(c, i + 1);
      if (fin < 0) return null;
      i = fin;
      continue;
    }
    if (c === "(") prof += 1;
    else if (c === ")") { prof -= 1; if (prof === 0) return src.slice(ouvrante, i + 1); }
  }
  return null;
}

describe("cliquet — toute création de demande au secrétariat pose sa société", () => {
  const sites: { fichier: string; appel: string | null }[] = [];
  for (const f of fichiersDeProduction()) {
    const src = sansCommentaires(readFileSync(f, "utf8"));
    const re = /administrativeRequest\.create\s*\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      sites.push({ fichier: f, appel: appelEquilibre(src, m.index + m[0].length - 1) });
    }
  }

  it("PLANCHER : le parcours trouve les créations — sinon le cliquet serait vert en ne lisant rien (§118.17)", () => {
    // Mesuré : six créations dans le dépôt au §118.154 ; cinq depuis que la demande multiple (`createRequestBatch`)
    // est retirée (Direction, 10/2026).
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it("chaque création écrit `companyId`, et jamais le littéral `null`", () => {
    const fautifs = sites
      .filter((s) => s.appel == null || !/\bcompanyId\s*[:,}]/.test(s.appel) || /\bcompanyId\s*:\s*null\b/.test(s.appel))
      .map((s) => s.fichier);
    expect(fautifs, "demande(s) au secrétariat créée(s) sans société — invisible(s) du bureau cloisonné").toEqual([]);
  });
});

// ─────────────────────────── Les écrivains, par leurs vrais points d'entrée ───────────────────────────

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__secretsoc__";

async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}

suite("les demandes au secrétariat arrivent dans le bureau cloisonné", () => {
  const u: Record<string, string> = {};
  let societeC = "", societeD = "";
  let posteSansSociete = "", posteDeD = "";

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("kam", "MEDICAL_DELEGATE");
    await mk("asst", "DIRECTION_ASSISTANT");
    societeC = (await prisma.company.create({ data: { name: `${TAG} C`, shortName: `${TAG}C`.slice(0, 12) } })).id;
    societeD = (await prisma.company.create({ data: { name: `${TAG} D`, shortName: `${TAG}D`.slice(0, 12) } })).id;
    await prisma.employee.create({ data: { fullName: `${TAG} kam`, userId: u.kam, companyId: societeC } });
    await prisma.employee.create({ data: { fullName: `${TAG} asst`, userId: u.asst, companyId: societeC } });
    const poste = async (suffixe: string, companyId: string | null) => {
      const ev = await prisma.event.create({
        data: { name: `${TAG} Journée ${suffixe}`, requesterId: u.kam, startDate: new Date("2026-11-02"), companyId },
        select: { id: true },
      });
      return (await prisma.adProItem.create({
        data: { eventId: ev.id, kind: "CATERING", label: `${TAG} Traiteur ${suffixe}`, supplier: "Les Oliviers", amountEstimated: 120000, createdById: u.kam },
        select: { id: true },
      })).id;
    };
    posteSansSociete = await poste("NUL", null);
    posteDeD = await poste("D", societeD);
  }, 60_000);

  afterAll(nettoyer);

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const postes = (await prisma.adProItem.findMany({ where: { label: { startsWith: TAG } }, select: { id: true } })).map((p) => p.id);
    await prisma.adProItem.updateMany({ where: { id: { in: postes } }, data: { adminRequestId: null } }).catch(() => undefined);
    await prisma.administrativeRequest.deleteMany({ where: { OR: [{ requesterId: { in: comptes } }, { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: { in: postes } }] } });
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } });
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } });
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { id: { in: comptes } } });
  }

  it("PRÉMISSES : la liste de ces personnes est cloisonnée par société, et le délégué crée des demandes", async () => {
    for (const k of ["kam", "asst"]) {
      expect(await platformScope(u[k]), `${k} : un filtre par société`).toHaveProperty("companyId");
    }
    expect(userCan(await acteur(u.kam), "ADMIN_REQUESTS", "CREATE")).toBe(true);
  });

  it("la pièce d'un poste dont l'opération n'a PAS de société : celle du demandeur de l'opération, visible de l'assistante", async () => {
    ACTOR = await acteur(u.kam);
    const fd = new FormData();
    fd.set("id", posteSansSociete);
    fd.set("nature", "DEVIS");
    const r = await demanderPieceSecretariat(undefined, fd);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const dem = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: (r as { id: string }).id }, select: { id: true, companyId: true } });
    expect(dem.companyId).toBe(societeC);
    expect((await getRequestList(await acteur(u.asst), {})).rows.map((x) => x.id)).toContain(dem.id);
  });

  it("la pièce d'un poste d'une opération de D : la société de l'OPÉRATION, pas celle de son demandeur", async () => {
    ACTOR = await acteur(u.kam);
    const fd = new FormData();
    fd.set("id", posteDeD);
    fd.set("nature", "DEVIS");
    const r = await demanderPieceSecretariat(undefined, fd);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const dem = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: (r as { id: string }).id }, select: { companyId: true } });
    expect(dem.companyId).toBe(societeD);
  });

  // (Le banc « un LOT de cellules porte la société de son auteur » est retiré : la demande multiple n'existe
  // plus — Direction, 10/2026 — et `createRequestBatch` avec elle.)
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « UNE DEMANDE RECRÉÉE APRÈS SA SUPPRESSION S'AFFICHE « INTROUVABLE » » — le défaut, MESURÉ (Direction, 05/10).
 *
 * Le rapport : un KAM recrée une demande Ad&Pro après sa suppression par le Super Admin ; elle apparaît
 * dans le tableau Ad&Pro, mais sa fiche dit « Introuvable — ou ne vous est pas visible » ; après
 * actualisation avec le compte admin, ça marche.
 *
 * CE QUE LE BANC A ÉTABLI, par les vrais points d'entrée (la session RÉELLE de `session.ts`, seuls
 * `@/auth` et les en-têtes de requête sont simulés) :
 *   1. avec un vrai KAM, la fiche de la demande recréée S'OUVRE — sponsoring, congrès, événement,
 *      avant comme après la suppression de la première. Ce n'est ni la référence réutilisée, ni un cache ;
 *   2. avec un Super Admin en « Vue exacte » sur ce KAM, la requête qui ÉCRIT agit au nom de
 *      l'administrateur (§118.184), et la navigation qui SUIT lit au nom du KAM : la demande, déposée par
 *      l'administrateur, est introuvable pour la personne visualisée — le symptôme exact du rapport ;
 *   3. le geste est donc refusé sous la vue, avec la raison et le remède.
 *
 * LES PRÉMISSES SE VÉRIFIENT : sans la prémisse 2 (la fiche déposée par l'administrateur est
 * réellement introuvable pour le KAM visualisé), le refus ne serait pas motivé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const revalidees: string[] = [];
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => { revalidees.push(p); } }));
const ETAT: { cookie: string | undefined; ecrit: boolean; qui: string | null; horsRequete: boolean } = { cookie: undefined, ecrit: false, qui: null, horsRequete: false };
vi.mock("next/headers", () => ({
  cookies: () => {
    // Hors requête (banc, battement), `cookies()` lève.
    if (ETAT.horsRequete) throw new Error("cookies() hors de la portée d'une requête");
    return { get: (n: string) => (n === "amd_impersonate" && ETAT.cookie ? { value: ETAT.cookie } : undefined) };
  },
  headers: () => new Headers(ETAT.ecrit ? { "next-action": "abc" } : {}),
}));
// Depuis §118.210, la session reconnaît une ACTION serveur au stockage asynchrone de Next (et plus à
// l'en-tête `Next-Action`, que la page rendue après l'action rejoue) : le banc le simule par le même fait.
vi.mock("next/dist/server/app-render/action-async-storage.external", () => ({
  actionAsyncStorage: { getStore: () => (ETAT.ecrit ? { isAction: true } : undefined) },
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (u: string) => { throw new Error("NEXT_REDIRECT " + u); },
  useRouter: () => ({}),
}));
vi.mock("@/auth", () => ({
  auth: async () => (ETAT.qui ? { user: { id: ETAT.qui, role: ROLES[ETAT.qui] ?? "SUPER_ADMIN", name: "x", email: "x@t.dz" } } : null),
}));
const ROLES: Record<string, string> = {};

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { personneVisualisee } from "@/lib/vue-exacte";
import { createSponsoring } from "@/lib/actions/sponsoring-actions";
import { createCongressRequest } from "@/lib/actions/congress-request-actions";
import { createEvent } from "@/lib/actions/event-actions";
import { supprimerDemandeAdPro } from "@/lib/actions/admin-delete-actions";
import SponsoringDetailPage from "@/app/(app)/sponsoring/[id]/page";
import CongressIntlDetailPage from "@/app/(app)/congress-international/[id]/page";
import EventDetailPage from "@/app/(app)/events/[id]/page";

const TAG = `__vuex${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const ids: Record<string, string> = {};
let buId = "";

const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "demande.pdf", { type: "application/pdf" });
function formSponsoring(institution: string): FormData {
  const f = new FormData();
  f.set("institution", institution);
  f.append("doctorIds", `${TAG}Dr Benali`); f.append("productIds", `${TAG}Nivolex`);
  f.set("city", "Alger"); f.set("specialty", "Cardiologie"); f.set("type", "Congrès");
  f.set("amountRequested", "120000"); f.set("amountProposed", "90000"); f.set("nature", "DIRECT"); f.set("strategicImportance", "HIGH");
  f.append("files", pdf());
  return f;
}
function formCongres(nom: string): FormData {
  const f = new FormData();
  f.set("type", "INTL"); f.set("name", nom); f.set("startDate", "2027-03-01"); f.set("endDate", "2027-03-04");
  f.set("estimatedBudget", "200000");
  return f;
}
function formEvenement(nom: string): FormData {
  const f = new FormData();
  f.set("name", nom); f.set("type", "CONGRESS"); f.set("scope", "NATIONAL"); f.set("format", "PRESENTIEL");
  f.set("startDate", "2027-04-01"); f.set("endDate", "2027-04-02"); f.set("location", "Hôtel"); f.set("city", "Alger"); f.set("country", "Algérie");
  f.set("specialty", "Cardiologie"); f.append("doctorIds", `${TAG}Dr Amrani`); f.append("productIds", `${TAG}Nivolex`);
  f.set("estimatedBudget", "300000"); f.set("responsibleId", ids.kam!); f.set("description", "Test");
  return f;
}

type Page = (p: { params: Promise<{ id: string }> }) => Promise<unknown>;
/** Ouvre la fiche comme le serveur le ferait : « introuvable » se distingue d'une fiche qui s'ouvre. */
async function ouvre(page: Page, id: string): Promise<"OK" | "INTROUVABLE" | string> {
  try { await page({ params: Promise.resolve({ id }) }); return "OK"; } catch (e) {
    const m = String(e);
    if (m.includes("NEXT_NOT_FOUND")) return "INTROUVABLE";
    // Aucune transformation JSX ici : la page est allée jusqu'à construire son arbre, donc ses données se sont chargées.
    if (m.includes("React is not defined")) return "OK";
    return m;
  }
}
const kam = () => { ETAT.qui = ids.kam!; ETAT.cookie = undefined; ETAT.ecrit = true; };
const adminEnVue = () => { ETAT.qui = ids.sa!; ETAT.cookie = ids.kam!; ETAT.ecrit = true; };
const lecture = () => { ETAT.ecrit = false; };

suite("Vue exacte — créer une demande n'a de sens qu'en son propre nom", () => {
  beforeAll(async () => {
    const c = await prisma.company.findFirst({ where: { isActive: true }, select: { id: true } });
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG} BU` } });
    buId = bu.id;
    for (const [k, role] of [["kam", "MEDICAL_DELEGATE"], ["sa", "SUPER_ADMIN"], ["fin", "FINANCE_BUDGET_MANAGER"]] as const) {
      const u = await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } });
      await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u.id, isActive: true, companyId: c!.id } });
      ids[k] = u.id;
      ROLES[u.id] = role;
    }
    await prisma.salesRepProfile.create({ data: { repId: ids.kam!, businessUnitId: buId } });
  }, 60_000);

  afterAll(async () => {
    ETAT.qui = null; ETAT.cookie = undefined;
    const spo = await prisma.sponsoringRequest.findMany({ where: { institution: { startsWith: TAG } }, select: { id: true } });
    for (const s of spo) await prisma.workflowInstance.deleteMany({ where: { entityType: "SPONSORING", entityId: s.id } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { institution: { startsWith: TAG } } }).catch(() => {});
    const cg = await prisma.congressInternational.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    for (const s of cg) await prisma.workflowInstance.deleteMany({ where: { entityType: "CONGRESS_INTERNATIONAL", entityId: s.id } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const ev = await prisma.event.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    for (const s of ev) await prisma.workflowInstance.deleteMany({ where: { entityType: "EVENT", entityId: s.id } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.deletedRecord.deleteMany({ where: { name: { contains: TAG } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: ids.kam } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { id: buId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: Object.values(ids) } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: Object.values(ids) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } }).catch(() => {});
  }, 60_000);

  // ── 1. CE QUI N'EST PAS LA CAUSE : un vrai KAM, après suppression et recréation ─────────────────────────

  it("PRÉMISSE 1 — avec un vrai KAM, la fiche recréée S'OUVRE, y compris après la suppression de la première", async () => {
    kam();
    const a = await createSponsoring(undefined, formSponsoring(`${TAG} A`));
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect(await ouvre(SponsoringDetailPage as Page, a.id!), "avant toute suppression").toBe("OK");
    // Le Super Admin supprime (il agit en son nom propre, hors vue) ; le KAM recrée.
    ETAT.qui = ids.sa!; ETAT.cookie = undefined; ETAT.ecrit = true;
    const fd = new FormData(); fd.set("kind", "SPONSORING"); fd.set("id", a.id!);
    // La liste se vide AVANT la suppression : la création précédente a déjà revalidé « /ad-pro », et une
    // assertion sur une liste qui contient déjà la valeur attendue ne peut pas tomber.
    revalidees.length = 0;
    expect((await supprimerDemandeAdPro(fd)).ok).toBe(true);
    expect(revalidees, "la suppression revalide le tableau Ad&Pro et Mon espace").toEqual(expect.arrayContaining(["/ad-pro", "/mon-espace"]));
    kam();
    revalidees.length = 0;
    const b = await createSponsoring(undefined, formSponsoring(`${TAG} B`));
    expect(b.ok, JSON.stringify(b)).toBe(true);
    expect(revalidees, "la création revalide le tableau Ad&Pro").toContain("/ad-pro");
    lecture();
    expect(await ouvre(SponsoringDetailPage as Page, b.id!), "la fiche de la demande recréée s'ouvre").toBe("OK");
    const ligne = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: b.id! }, select: { requesterId: true, businessUnitId: true } });
    expect(ligne.requesterId).toBe(ids.kam);
    expect(ligne.businessUnitId, "la gamme du KAM, imposée").toBe(buId);
  }, 60_000);

  it("PRÉMISSE 1 bis — congrès et événement : la même chose, avant et après la suppression", async () => {
    kam();
    const c1 = await createCongressRequest(undefined, formCongres(`${TAG} Congrès A`));
    expect(c1.ok, JSON.stringify(c1)).toBe(true);
    ETAT.qui = ids.sa!; ETAT.cookie = undefined; ETAT.ecrit = true;
    const fd = new FormData(); fd.set("kind", "CONGRESS_INTERNATIONAL"); fd.set("id", c1.id!);
    expect((await supprimerDemandeAdPro(fd)).ok).toBe(true);
    kam();
    const c2 = await createCongressRequest(undefined, formCongres(`${TAG} Congrès B`));
    expect(c2.ok, JSON.stringify(c2)).toBe(true);
    lecture();
    expect(await ouvre(CongressIntlDetailPage as Page, c2.id!)).toBe("OK");

    kam();
    const e = await createEvent(formEvenement(`${TAG} Événement`));
    expect(e.ok, JSON.stringify(e)).toBe(true);
    lecture();
    expect(await ouvre(EventDetailPage as Page, e.id!)).toBe("OK");
  }, 60_000);

  // ── 2. LA CAUSE : la Vue exacte écrit en nom propre et lit au nom de la personne visualisée ─────────────

  it("PRÉMISSE 2 — une demande déposée par l'ADMINISTRATEUR est introuvable pour le KAM visualisé (le symptôme du rapport)", async () => {
    // Ce que produisait la création sous vue : la demande est au nom de l'administrateur…
    const spo = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}P2`, institution: `${TAG} déposée par l'admin`, type: "Congrès", requesterId: ids.sa!, status: "REFUSED" },
    });
    // …le tableau rendu dans la réponse de l'action (côté écriture, en Super Admin) la voit…
    ETAT.qui = ids.sa!; ETAT.cookie = ids.kam!; ETAT.ecrit = true;
    const ecrivain = await requireUser();
    expect(ecrivain.impersonatedBy, "une requête qui écrit ignore la vue (§118.184)").toBeFalsy();
    expect(ecrivain.id).toBe(ids.sa);
    // …et la navigation qui suit, rendue pour le KAM visualisé, ne l'ouvre pas.
    lecture();
    const lecteur = await requireUser();
    expect(lecteur.id, "la lecture est rendue pour la personne visualisée").toBe(ids.kam);
    expect(await ouvre(SponsoringDetailPage as Page, spo.id)).toBe("INTROUVABLE");
    await prisma.sponsoringRequest.delete({ where: { id: spo.id } });
  }, 60_000);

  // DEPUIS LE 06/10 (Direction) : sous la Vue exacte, la demande se crée AU NOM de la personne visualisée,
  // pour tester son parcours de bout en bout — et sa fiche s'ouvre dans cette même vue.
  it("SOUS LA VUE EXACTE, la demande se crée au nom du KAM visualisé — et sa fiche s'ouvre dans la vue", async () => {
    adminEnVue();
    const r = await createSponsoring(undefined, formSponsoring(`${TAG} sous vue`));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const demande = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: r.id! } });
    expect(demande.requesterId, "déposée au nom du KAM visualisé, pas de l'administrateur").toBe(ids.kam);
    lecture();
    expect(await ouvre(SponsoringDetailPage as Page, r.id!), "la fiche s'ouvre dans la vue").toBe("OK");
  }, 60_000);

  // ── 3. LE REFUS NE TOMBE QUE SUR CE QU'IL DOIT ATTRAPER (le sens dangereux est de refuser à tort) ───────

  it("un cookie qui ne désigne personne de valable ne bloque rien — périmé, soi-même, compte fermé", async () => {
    ETAT.qui = ids.sa!; ETAT.ecrit = true;
    const sa = await requireUser();
    ETAT.cookie = "inexistant";
    expect(await personneVisualisee(sa), "cookie périmé").toBeNull();
    ETAT.cookie = ids.sa!;
    expect(await personneVisualisee(sa), "soi-même").toBeNull();
    await prisma.user.update({ where: { id: ids.fin! }, data: { isActive: false } });
    ETAT.cookie = ids.fin!;
    expect(await personneVisualisee(sa), "compte fermé").toBeNull();
    await prisma.user.update({ where: { id: ids.fin! }, data: { isActive: true } });
    ETAT.cookie = ids.kam!;
    expect(await personneVisualisee(sa), "PRÉMISSE : ici la vue est valable").toBe(`${TAG} kam`);
  });

  it("le cookie n'a d'effet que pour un Super Admin — un autre compte qui le forge crée normalement", async () => {
    ETAT.qui = ids.kam!; ETAT.cookie = ids.sa!; ETAT.ecrit = true;
    const kamLui = await requireUser();
    expect(await personneVisualisee(kamLui), "un délégué n'a pas de vue exacte").toBeNull();
    const r = await createSponsoring(undefined, formSponsoring(`${TAG} cookie forgé`));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 60_000);

  it("hors requête (banc, battement), personne ne visualise rien — `null`, jamais une exception", async () => {
    ETAT.cookie = ids.kam!;
    ETAT.horsRequete = true;
    try {
      expect(await personneVisualisee({ id: ids.sa!, role: "SUPER_ADMIN" })).toBeNull();
    } finally {
      ETAT.horsRequete = false;
    }
    expect(await personneVisualisee({ id: ids.sa!, role: "SUPER_ADMIN" }), "PRÉMISSE : la même vue, en requête, est honorée").toBe(`${TAG} kam`);
  });

  // ── 4. LE POINT D'APPEL (§118.49) ───────────────────────────────────────────────────────────────

  it("CLIQUET — chacune des six actions de création agit au nom de la personne visualisée (`requireUserAuNomDeLaVue`), et le droit de créer est lu sur elle", () => {
    const sansCommentaires = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const fichiers: [string, string, RegExp][] = [
      ["sponsoring-actions.ts", "export async function createSponsoring", /userCan\(user, "SPONSORING", "CREATE"\)/],
      ["congress-request-actions.ts", "export async function createCongressRequest", /userCan\(user, moduleFor\(t\), "CREATE"\)/],
      ["event-actions.ts", "export async function createEvent", /userCan\(user, "EVENTS", "CREATE"\)/],
      ["consulting-actions.ts", "export async function createConsultingContract", /peutSurLeContrat\(user, \{ pole \}, "CREATE"\)/],
      ["ad-pro-other-actions.ts", "export async function createAdProOtherRequest", /userCan\(user, "AD_PRO_OTHER", "CREATE"\)/],
      ["promo-material-actions.ts", "export async function createPromoMaterial", /userCan\(user, "PROMO_MATERIAL", "CREATE"\)/],
    ];
    for (const [fichier, debut, droit] of fichiers) {
      const src = sansCommentaires(readFileSync(`src/lib/actions/${fichier}`, "utf8"));
      const i = src.indexOf(debut);
      expect(i, `${fichier} : action trouvée`).toBeGreaterThan(-1);
      const corps = src.slice(i, i + 2500);
      const iDroit = corps.search(droit);
      const iUser = corps.indexOf("requireUserAuNomDeLaVue()");
      expect(iDroit, `${fichier} : le droit de créer est lu`).toBeGreaterThan(-1);
      expect(iUser, `${fichier} : l'utilisateur est celui de la vue`).toBeGreaterThan(-1);
      expect(iUser, `${fichier} : l'utilisateur est résolu AVANT le droit`).toBeLessThan(iDroit);
      expect(corps, `${fichier} : plus de refus sous la vue`).not.toContain("refuseSousVueExacte");
    }
  });

  it("CLIQUET — la création revalide le tableau Ad&Pro et Mon espace (sponsoring, congrès, événement)", () => {
    for (const f of ["sponsoring-actions.ts", "congress-request-actions.ts", "event-actions.ts"]) {
      const src = readFileSync(`src/lib/actions/${f}`, "utf8");
      expect(src, `${f} : revalide /ad-pro`).toMatch(/revalidatePath\("\/ad-pro"\)/);
      expect(src, `${f} : revalide /mon-espace`).toMatch(/revalidatePath\("\/mon-espace"\)/);
    }
  });
});

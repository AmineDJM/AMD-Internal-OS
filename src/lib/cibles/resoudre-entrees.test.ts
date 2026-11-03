// L'ordre compte : `@/lib/assistant` casse le cycle d'initialisation ops → impl → actions.
import "@/lib/assistant";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { CAPABILITY_OPS_IMPL } from "@/lib/assistant/ops/impl-capabilite";
import { CONTRAT_PAR_ID } from "@/lib/actions/contrat.genere";
import { champsDesignables } from "./resoudre-entrees";

const TAG = "__entree__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « NIVOLEX » LÀ OÙ L'ACTION ATTEND UN `cuid` — éprouvé par le VRAI point d'entrée.
 *
 * On appelle `CAPABILITY_OPS_IMPL.run.propose`, c'est-à-dire ce qu'une conversation déclenche,
 * et non `resoudreEntrees` en direct. C'est §118.49 : `daterLEntree` était écrite, commentée,
 * couverte par un test qui lisait son corps — et son APPEL avait été perdu dans une édition.
 * Un test qui part d'un état injecté à la main ne répond pas à la question.
 *
 * CE QUI FERAIT TOMBER CHAQUE ESSAI est nommé sur chacun : sans ce cas, ce n'est pas une
 * assertion (§118.17). Les quatre ont été JOUÉS, pas seulement décrits :
 *
 *   A. la substitution n'est pas réécrite dans l'entrée   → « un NOM et une RÉFÉRENCE… » tombe
 *   B. `retenu: c.slice(0, 1)` (candidats collapsés)      → « désignation ambiguë… » tombe
 *   C. la recherche se fait sans `porteeEntite`            → « hors périmètre… » tombe
 *   D. `contrat-scan` cesse de passer `relationsDuSchema()` → le PLANCHER de `contrat.test.ts`
 *      tombe (512 → 0), et c'est le sabotage qui compte le plus : tout se compile, tous les
 *      autres essais passent, et Adam redemanderait un `cuid` à des humains pour toujours.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Désignation par le nom, dans le chemin générique", () => {
  let user: CurrentUser;
  let idNivolex = "";
  let nomChef = "";

  beforeAll(async () => {
    const [a, b] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG}Alpha` } }),
      prisma.company.create({ data: { name: `${TAG}Beta` } }),
    ]);
    const u = await prisma.user.create({
      data: {
        name: `${TAG}chef`, email: `${TAG}chef@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x",
        companyAccess: { create: [{ companyId: a.id, canEdit: true }] },
      },
    });
    const [nivolex] = await Promise.all([
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-1`, dci: `${TAG}Nivolex`, companyId: a.id }, select: { id: true } }),
      // DEUX homonymes : de quoi rendre une désignation AMBIGUË pour de vrai.
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-2`, dci: `${TAG}Trastuzex alpha`, companyId: a.id } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-3`, dci: `${TAG}Trastuzex bêta`, companyId: a.id } }),
      // Chez BETA : hors du périmètre de cette personne. Ni obtenu, ni nommé dans un refus.
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-9`, dci: `${TAG}Secretol`, companyId: b.id } }),
    ]);
    idNivolex = nivolex.id;
    nomChef = u.name;
    const base: SessionUser = { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role) } as SessionUser;
    user = base as unknown as CurrentUser;
  }, 120_000);

  afterAll(async () => {
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  const proposer = (action: string, champs: Record<string, unknown>) =>
    CAPABILITY_OPS_IMPL.run!.propose({ action, champs: JSON.stringify(champs) }, user);

  /**
   * LE CŒUR. CE QUI FERAIT TOMBER : ne pas résoudre du tout (l'action recevrait « Nivolex » et
   * refuserait un dossier qui existe — le « je ne peux pas » artificiel de §118.63), ou résoudre
   * pour l'affichage sans porter l'identifiant dans les `args` (la carte montrerait la bonne
   * ligne et l'exécution partirait avec le mot).
   */
  it("un NOM et une RÉFÉRENCE deviennent la ligne — et la carte montre la ligne, pas le cuid", async () => {
    const r = await proposer("regulatory-actions:setRegulatoryResponsible", {
      id: `${TAG}Nivolex`, responsibleId: nomChef,
    });
    expect("error" in r ? r.error : "").toBe("");
    if ("error" in r) return;

    const champs = JSON.parse(r.args.champs ?? "{}") as Record<string, string>;
    expect(champs.id, "l'identifiant résolu doit partir à l'exécution").toBe(idNivolex);
    expect(champs.responsibleId).toMatch(/^[a-z][a-z0-9]{20,31}$/i);

    const ligne = r.fields.find((f) => f.label === "id");
    expect(ligne?.value).toContain(`${TAG}REG-1`);
    expect(ligne?.value).not.toBe(idNivolex);
  }, 60_000);

  /**
   * CE QUI FERAIT TOMBER : collapser la liste sur son premier élément. Adam changerait alors
   * le responsable du mauvais dossier en annonçant que c'est fait (§118.34, §104.7).
   */
  it("une désignation ambiguë est REFUSÉE, avec ses candidats", async () => {
    const r = await proposer("regulatory-actions:setRegulatoryPriority", {
      id: `${TAG}Trastuzex`, priority: "HIGH",
    });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("alpha");
    expect(r.error).toContain("bêta");
  }, 60_000);

  /**
   * CE QUI FERAIT TOMBER : chercher sans `porteeEntite`. La ligne de la société Beta serait
   * trouvée, et son existence révélée par le refus lui-même — un refus révèle autant qu'une
   * réponse.
   */
  it("hors périmètre : rien n'est retenu, et le refus ne nomme pas la ligne cachée", async () => {
    const r = await proposer("regulatory-actions:setRegulatoryPriority", {
      id: `${TAG}Secretol`, priority: "HIGH",
    });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("périmètre");
    expect(r.error, "la référence de la ligne interdite ne doit apparaître nulle part")
      .not.toContain(`${TAG}REG-9`);
  }, 60_000);

  /**
   * CE QUI FERAIT TOMBER : « résoudre » un identifiant déjà résolu — au mieux une requête pour
   * rien, au pire un texte qui ressemble à un id et qu'on irait chercher par son nom.
   */
  it("un identifiant passe INTACT", async () => {
    const r = await proposer("regulatory-actions:setRegulatoryPriority", {
      id: idNivolex, priority: "LOW",
    });
    if ("error" in r) { expect(r.error).toBe(""); return; }
    expect(JSON.parse(r.args.champs ?? "{}").id).toBe(idNivolex);
    expect(r.fields.find((f) => f.label === "id")?.value).toBe(idNivolex);
  }, 60_000);

  /**
   * CE QUI FERAIT TOMBER : chercher quand même dans un modèle sans portée déclarée (on
   * montrerait des lignes hors périmètre), ou se taire (le silence d'une fiche se lit comme une
   * permission de deviner, §118.26). Et le refus doit NOMMER l'op qui, elle, sait le faire.
   */
  it("un objet sans portée déclarée : transmis tel quel, DIT, et l'op qui sait est nommée", async () => {
    const r = await proposer("drive-actions:renameNode", { id: "Campagne", name: "Campagne 2027" });
    if ("error" in r) { expect(r.error).toBe(""); return; }
    expect(JSON.parse(r.args.champs ?? "{}").id, "aucune substitution devinée").toBe("Campagne");
    const dit = (r.warnings ?? []).join(" ");
    expect(dit).toContain("transmis tel quel");
    expect(dit).toContain("DriveNode");
    expect(dit, "le remède, pas seulement la faute (§118.30)").toContain("drive_operation/rename");
  }, 60_000);

  /**
   * CE QUI FERAIT TOMBER : deviner le modèle d'après le NOM du champ. Mesuré : la ressemblance
   * ajoutait 35 champs sur 730 et faisait pointer le `messageId` de la messagerie Microsoft vers
   * le modèle `Message` de l'ERP — deux objets sans aucun rapport (§118.16).
   */
  it("ce que le schéma ne dit pas ne se devine pas", async () => {
    // LA PRÉMISSE D'ABORD : l'action doit EXISTER. Ce cas visait
    // `requestAdProItemQuote`, renommée en `demanderPieceSecretariat` le jour où le devis et la
    // facture sont devenus deux natures d'un seul geste. Il n'a échoué que parce que
    // `toBeNull()` distingue `undefined` d'un `null` — un `toBeFalsy()` l'aurait laissé au vert
    // sur une action DISPARUE, c'est-à-dire en ne mesurant plus rien (§118.104, §118.120).
    const ACTION = "ad-pro-item-actions:demanderPieceSecretariat";
    const c = CONTRAT_PAR_ID.get(ACTION);
    expect(c, `« ${ACTION} » doit exister — sinon ce cas ne mesure rien`).toBeTruthy();
    expect(c!.champs.find((x) => x.nom === "id")?.modele).toBeNull();
    const r = await proposer(ACTION, { id: "un nom quelconque" });
    if ("error" in r) { expect(r.error).toBe(""); return; }
    expect(JSON.parse(r.args.champs ?? "{}").id).toBe("un nom quelconque");
    expect((r.warnings ?? []).join(" ")).toContain("le schéma ne dit pas");
  }, 60_000);

  /**
   * §118.19 : ce que le code ACCEPTE, la fiche doit le dire. Sans cette phrase, « reference » se
   * lit « donne-moi un identifiant », et le modèle en fabrique un ou renonce.
   * CE QUI FERAIT TOMBER : annoncer la désignation sur un champ qu'on ne sait pas résoudre.
   */
  it("la fiche DIT quels champs acceptent un nom — et seulement ceux-là", () => {
    const resp = CONTRAT_PAR_ID.get("regulatory-actions:setRegulatoryResponsible")!;
    expect(champsDesignables(resp).map((x) => x.champ).sort()).toEqual(["id", "responsibleId"]);
    const rename = CONTRAT_PAR_ID.get("drive-actions:renameNode")!;
    expect(champsDesignables(rename), "DriveNode n'a pas de portée déclarée").toEqual([]);
  });
});

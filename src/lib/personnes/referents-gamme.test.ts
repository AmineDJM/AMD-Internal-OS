import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  aPrevenirPourLaGamme, laGammeEstConcernee, porteLeRoleQuiTranche, referentUnique, referentsWhy,
  referentsMontes, ROLES_QUI_TRANCHENT, type ReferentMarketing,
} from "./referents-gamme";
import { ROLE_DIRECTION_MARKETING } from "./roles-vente";
import { defaultDefinition } from "@/lib/workflow/defaults";
import { WORKFLOW_CATEGORIES } from "@/lib/workflow/types";

const AVEC = (n: string, role = true): ReferentMarketing => ({ userId: n, name: n, porteLeRole: role });

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÉFÉRENTS DIRECTION MARKETING D'UNE GAMME — la décision, éprouvée sans base.
 *
 * Décision de la Direction (22/09/2026) : « chaque BU aura son ou ses référents de la direction
 * marketing depuis la configuration des BU, mais le directeur du département marketing recevra
 * ÉGALEMENT l'accès et la notif et pourra modifier, valider ».
 *
 * CE QUE CE BANC TIENT, et c'est la propriété qui compte : la désignation AJOUTE et ne RETIRE
 * jamais. Une gamme sans référent retombe exactement sur le comportement d'avant — c'est ce qui
 * permet de déployer la table vide sans priver personne de sa notification (§118.16).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("les référents Direction Marketing d'une gamme", () => {
  it("les référents s'AJOUTENT — une gamme sans référent ne prévient personne de plus", () => {
    // Ce qui le ferait tomber : rendre une liste non vide sans référent (donc prévenir quelqu'un
    // que personne n'a désigné), ou REMPLACER le rôle au lieu de s'y ajouter — mais cette
    // seconde moitié se juge chez l'appelant, et le banc du moteur la tient.
    expect(aPrevenirPourLaGamme({ referents: [] })).toEqual([]);
    expect(aPrevenirPourLaGamme({ referents: [AVEC("a"), AVEC("b")] })).toEqual(["a", "b"]);
  });

  it("on ne prévient JAMAIS le demandeur de sa propre demande", () => {
    // Une notification adressée à soi-même a l'air d'un accusé de réception, et fait chercher
    // ce qu'on est censé y faire.
    expect(aPrevenirPourLaGamme({ referents: [AVEC("amel"), AVEC("karim")], demandeurId: "amel" }))
      .toEqual(["karim"]);
  });

  it("un doublon ne prévient pas deux fois", () => {
    // La base l'interdit (contrainte d'unicité) ; le module ne s'y fie pas — une lecture qui
    // joindrait deux tables pourrait rendre la même personne deux fois.
    expect(aPrevenirPourLaGamme({ referents: [AVEC("a"), AVEC("a"), AVEC("")] })).toEqual(["a"]);
  });

  it("UN SEUL référent désigne cette personne ; PLUSIEURS n'en désignent AUCUNE", () => {
    // §118.34 mot pour mot. Ce qui le ferait tomber : collapser sur le premier — ce qui
    // choisirait l'arbitre d'un budget par l'ordre d'insertion en base.
    expect(referentUnique([AVEC("amel")])).toBe("amel");
    expect(referentUnique([AVEC("amel"), AVEC("karim")])).toBeNull();
    expect(referentUnique([])).toBeNull();
  });

  it("on n'inscrit JAMAIS quelqu'un qui ne porte pas le rôle", () => {
    // `productManagerId` est lu par la garde de l'analyse (`c.productManagerId !== user.id`) :
    // y écrire une personne sans le rôle lui OUVRIRAIT ce geste — la désignation accorderait un
    // droit, ce que ce module refuse.
    expect(referentUnique([AVEC("sans", false)])).toBeNull();
    // Un seul ÉLIGIBLE parmi deux désigne bien cette personne : c'est une certitude, pas un choix.
    expect(referentUnique([AVEC("sans", false), AVEC("amel")])).toBe("amel");
  });

  it("la raison dit LAQUELLE des deux pannes on tient, jamais « incomplet »", () => {
    // §118.30 : un refus qui nomme la faute sans nommer le cas fait chercher soi-même.
    expect(referentsWhy([])).toContain("Aucun référent");
    expect(referentsWhy([AVEC("x", false)])).toContain("ne porte pas le rôle");
    expect(referentsWhy([AVEC("a"), AVEC("b")])).toContain("aucun");
    expect(referentsWhy([AVEC("a")])).toContain("Un seul référent");
    // Les quatre phrases sont DISTINCTES : une raison unique ferait chercher le cas.
    const phrases = new Set([referentsWhy([]), referentsWhy([AVEC("x", false)]), referentsWhy([AVEC("a"), AVEC("b")]), referentsWhy([AVEC("a")])]);
    expect(phrases.size).toBe(4);
  });

  it("l'étape n'est franchie que si TOUS portent le rôle", () => {
    // L'autre moitié de la garde : sans elle, une gamme dont le référent a changé de poste
    // passerait pour montée, et personne ne trancherait ses demandes (§118.17).
    expect(referentsMontes([])).toBe(false);
    expect(referentsMontes([AVEC("a")])).toBe(true);
    expect(referentsMontes([AVEC("a"), AVEC("b", false)])).toBe(false);
  });

  it("les DEUX lectures du rôle qui tranche s'accordent — prédicat et liste de filtrage", () => {
    /*
     * L'écran et l'action filtrent EN BASE (`anyRoleFilter(ROLES_QUI_TRANCHENT)`), le moteur et
     * le chargeur lisent une personne déjà chargée (`porteLeRoleQuiTranche`). Deux sources
     * feraient un écran qui propose une personne que l'action refuse (§118.5).
     *
     * Ce qui le ferait tomber : élargir l'une sans l'autre — le cas exact qui s'est présenté en
     * écrivant ce lot, où cinq fichiers recopiaient `PRODUCT_MANAGER_ROLES` à la main.
     */
    for (const r of ROLES_QUI_TRANCHENT) {
      expect(porteLeRoleQuiTranche({ role: r }), `${r} doit passer le prédicat`).toBe(true);
      expect(porteLeRoleQuiTranche({ role: "SALES_USER", secondaryRole: r }),
        `${r} en rôle SECONDAIRE doit passer — c'est la convention de tout le RBAC`).toBe(true);
    }
    // Et l'inverse : un rôle hors liste ne passe pas. Sans cette moitié, un prédicat qui rend
    // toujours vrai passerait pour armé (§118.17).
    expect(porteLeRoleQuiTranche({ role: "MEDICAL_PROMOTION_MANAGER" }),
      "l'étape décisive ne nomme PAS ce rôle : l'inscrire ferait une attente sans pouvoir").toBe(false);
    expect(porteLeRoleQuiTranche({ role: "SALES_USER" })).toBe(false);
    expect(porteLeRoleQuiTranche(null)).toBe(false);
    // LA PRÉMISSE de l'accord : la liste porte bien ce que l'étape décisive nomme.
    expect(ROLES_QUI_TRANCHENT).toContain(ROLE_DIRECTION_MARKETING);
  });

  it("la gamme n'est concernée QUE par une étape qui NOMME le rôle marketing", () => {
    /*
     * MESURÉ EN ÉCRIVANT LE CAS DE BOUT EN BOUT, et c'était le vrai défaut du lot : la première
     * version prévenait les référents à CHAQUE étape atteinte. La route d'un National Sales
     * traverse la porte du DG puis la Direction des opérations avant d'atteindre la Direction
     * Marketing — le référent d'une gamme recevait donc DEUX notifications d'étapes qui ne le
     * concernent pas, et une notification qui arrive partout cesse d'être lue (§118.32).
     *
     * Ce qui le ferait tomber : rendre `true` sans regarder les rôles (le défaut d'origine), ou
     * s'armer sur un SLUG écrit à la main — faux au premier circuit remanié, en silence.
     */
    expect(laGammeEstConcernee([ROLE_DIRECTION_MARKETING])).toBe(true);
    expect(laGammeEstConcernee([ROLE_DIRECTION_MARKETING, "SUPER_ADMIN"])).toBe(true);
    expect(laGammeEstConcernee(["NATIONAL_SALES", "SUPER_ADMIN"])).toBe(false);
    expect(laGammeEstConcernee(["DIRECTION", "SUPER_ADMIN"])).toBe(false);
    expect(laGammeEstConcernee([])).toBe(false);
  });

  it("LA PRÉMISSE : la colonne vertébrale a bien UNE étape qui nomme ce rôle, et une seule", () => {
    /*
     * §118.104 : sans cette prémisse, la garde ci-dessus pourrait être parfaitement armée et ne
     * garder RIEN — si aucune étape ne nommait le rôle, aucun référent ne serait jamais prévenu
     * et le banc de base passerait au vert en ne mesurant que des zéros.
     *
     * « ET UNE SEULE » est l'autre moitié : deux étapes qui nomment le rôle préviendraient les
     * référents deux fois par demande, c'est-à-dire le bruit qu'on vient de retirer.
     */
    for (const categorie of WORKFLOW_CATEGORIES) {
      const def = defaultDefinition(categorie);
      const nommantes = def.steps.filter((e) => ((e.notifyRoles ?? []) as readonly string[]).includes(ROLE_DIRECTION_MARKETING));
      expect(nommantes.length, `${categorie} : une seule étape doit nommer le rôle Direction Marketing`).toBe(1);
      // Et c'est bien l'étape qui TRANCHE : la prévenir ailleurs n'appellerait aucune action.
      expect((nommantes[0]!.actorRoles ?? []) as readonly string[], `${categorie} : cette étape est celle qu'ils tiennent`)
        .toContain(ROLE_DIRECTION_MARKETING);
    }
  });

  it("le moteur prévient par UN SEUL point — aucun `notifyRoles` nu dans le moteur", () => {
    /*
     * LE POINT D'APPEL, PAS LE CORPS (§118.49).
     *
     * Une étape est « atteinte » à TROIS endroits du moteur : après une approbation, après un
     * saut, et après un avis défavorable qui renvoie plus loin. Ajouter les référents à deux sur
     * trois aurait laissé une porte muette à côté de deux portes qui parlent (§118.71) — et
     * c'est le chemin le plus rare, celui de l'avis défavorable, qui serait resté silencieux.
     *
     * Ce qui le ferait tomber : un quatrième site qui rappellerait `notifyRoles` pour son compte.
     */
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/workflow/engine.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
    const appels = (src.match(/\bnotifyRoles\s*\(/g) ?? []).length;
    expect(appels, "un seul appel de notifyRoles, dans `prevenirEtapeAtteinte`").toBe(1);
    // …et il est bien DANS le point unique, pas ailleurs.
    const bloc = src.slice(src.indexOf("async function prevenirEtapeAtteinte"));
    expect(bloc.includes("notifyRoles("), "l'appel doit vivre dans `prevenirEtapeAtteinte`").toBe(true);
    // Les sites appellent le point unique : l'approbation, le saut, l'avis défavorable — et depuis
    // le renvoi pour correction (§118.186) la POSE d'une demande resoumise, relancée ou rouverte en
    // appel (`prevenirLaPose`) et la modification faite après un avis — et depuis le circuit du
    // 27/10/2026, l'annonce « pour information » aux étapes suivantes à l'ouverture du circuit
    // (`ouvrirLeCircuit`, décision #1). Six sites + la déclaration.
    expect((src.match(/prevenirEtapeAtteinte\(/g) ?? []).length, "six sites + la déclaration").toBe(7);
    const pose = src.slice(src.indexOf("async function prevenirLaPose"));
    expect(pose.slice(0, pose.indexOf("\n}\n")).includes("prevenirEtapeAtteinte("), "la pose prévient par le point unique").toBe(true);
    // ET LA GARDE D'ÉTAPE Y EST APPELÉE : vérifier son corps sans son point d'appel ne
    // prouverait rien — elle était écrite avant d'être branchée (§118.49).
    expect(bloc.includes("laGammeEstConcernee("), "la garde d'étape doit être lue dans `prevenirEtapeAtteinte`").toBe(true);
  });
});

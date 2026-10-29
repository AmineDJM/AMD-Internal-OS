import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { join } from "node:path";
import {
  HELPERS_PARTAGES, contratsDuFichier, decrireAction, direContrat, helpersDuFichier, importsProjet, lireArguments, type TableEnums,
} from "./contrat";
import { scannerContrats } from "./contrat-scan";
import { ACTIONS_DES_MODULES, actionsDesModulesSurLeDisque, cheminsDeLaCle, cheminsDesActionsDesModules, parcDesActions } from "./parc";
import { CONTRATS_ACTIONS, CONTRAT_PAR_ID } from "./contrat.genere";
import { ACTION_CLASSIFICATION } from "@/lib/assistant/action-registry";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIQUET S'INVERSE.
 *
 * `action-parity.test.ts` compte les actions COUVERTES vers le haut : il prouve qu'aucun bouton
 * n'est un trou silencieux, et c'est ce qu'il doit faire. Mais compter vers le haut ne dit rien
 * du COÛT : on peut couvrir 712 actions en écrivant 712 fiches, et c'est exactement le travail
 * que le dirigeant a refusé — « je veux pas la capacité de retirer classe thérapeutique, je
 * veux la capacité de tout faire ».
 *
 * Ce cliquet-ci compte les actions NON DESCRIPTIBLES vers le BAS. Il ne récompense pas l'effort,
 * il mesure ce qui reste hors de portée du chemin générique. Combler un trou l'abaisse ; écrire
 * une action que la dérivation ne sait pas lire le fait ÉCHOUER, dans la même revue de code.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LE PLAFOND, mesuré le 09/09/2026 sur 715 actions.
 *
 * 117 → 77 (lecture des ARGUMENTS) : les refus IMPRIMAIENT la signature qu'ils déclaraient ne
 *   pas savoir lire. 40 actions traduites (§118.34).
 * 77 → 46 (lecture des LECTEURS et du RÉCEPTEUR) : 669 appelables (94 %), 46 illisibles —
 *   27 à entrée typée que la signature ne dit pas à coup sûr (objet littéral, type importé,
 *      valeur par défaut) — dont UNE refusée pour son paramètre `userId` (identité d'acteur),
 *   14 dont les noms de champs sont VRAIMENT calculés (`formData.get(\`act_${'{'}m}_${'{'}a}\`)`),
 *    5 dont les champs sont lus dans une fonction déléguée.
 *
 * ── POURQUOI CE CHIFFRE DESCEND À CHAQUE FOIS QU'ON REGARDE ──────────────────────────────
 *
 * Aucune des trois baisses ne vient de la source : les trois viennent du LECTEUR. Il ne
 * connaissait que quatre helpers sur quatorze, et son détecteur de dynamisme s'armait sur
 * `.get|.has` SANS REGARDER LE RÉCEPTEUR — donc `PROJECT_TEXT.has(field)`, un ENSEMBLE,
 * faisait passer une action pour incompréhensible. 19 refus sur 27 étaient de ce genre.
 *
 * ── ET POURQUOI IL DOIT DESCENDRE AVEC LA MESURE ─────────────────────────────────────────
 *
 * Ce plafond a été LAISSÉ à 77 le temps d'un sabotage, et le sabotage n'est pas tombé : le
 * catalogue de lecteurs désarmé faisait perdre 18 actions (669 → 651) et 651 restait sous 77.
 * Un cliquet qui ne peut plus se déclencher ne protège de rien — il rassure, ce qui est pire
 * (§118.17). Il descend donc au chiffre MESURÉ, et c'est ce qui rend le sabotage détectable.
 *
 * ── 46 → 24 : QUATRE CLASSES DE LECTURE, PAS QUATRE FICHES ───────────────────────────────
 *
 * Aucune des vingt-deux actions gagnées n'a été RÉÉCRITE : c'est le LECTEUR qui a appris à lire
 * ce que la source disait déjà (§118.78, quatrième fois).
 *   • un paramètre OBJET LITTÉRAL (`input: { id: string; paidDate: string | null }`) — 13 ;
 *   • un LECTEUR LOCAL (`const parseDate = (k: string) => fdStr(formData, k)`) — 4 ;
 *   • une DÉLÉGATION à une fonction du même fichier qui reçoit le formulaire — 5 ;
 *   • une valeur par défaut LITTÉRALE (`spaceId: string | null = null`), qui n'est pas un calcul.
 *
 * Et la délégation a trouvé bien plus que des illisibles : SEIZE actions déjà « lisibles »
 * portaient une liste de champs AMPUTÉE — `updateLegalDocument` déclarait `id` et rien d'autre,
 * `createInvoice` deux champs sur quatorze. Une liste plausible mais fausse est pire qu'un
 * refus (§118.26) : `validerEntree` refusant tout champ hors contrat, ces actions étaient
 * DÉCRITES et INAPPELABLES.
 *
 * Il ne se relève JAMAIS sans une justification écrite ici, dans la même revue de code.
 *
 * ── 24 → 23 (§118.153) : UNE ACTION DE MOINS, ET CE N'EST PAS UNE LECTURE DE PLUS ──────────
 *
 * `rememberExchange` était illisible pour la bonne raison : elle recevait l'identité de son
 * acteur en argument. Le refus au chemin générique ne fermait pas son point d'entrée public ;
 * elle a quitté le fichier « use server » pour un module serveur ordinaire. Le plafond suit le
 * chiffre MESURÉ — laissé à 24, il ne pourrait plus signaler la première illisible neuve.
 */
// 24 (§118.205) : `addCongressBeneficiary` est devenue un relais qui bâtit le formulaire de l'écrivain du
// dossier de prise en charge (une seule liste, 04/10) — illisible au chemin générique, couverte par son op.
const PLAFOND_ILLISIBLES = 24;

describe("CONTRAT D'ACTION — la dérivation LIT la source, elle ne l'invente pas", () => {
  // Une source ÉCRITE ICI : c'est le seul endroit où je connais la vérité indépendamment du
  // code testé. Mesurer la dérivation sur le vrai parc dirait seulement « elle est stable ».
  const SOURCE = `
"use server";
const MODULE = "REGULATORY" as const;
const STATUTS: Statut[] = ["OUVERT", "CLOS"];

export async function creerTruc(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const titre = fdStr(formData, "titre");
  if (!titre) return { ok: false, error: "Le titre est obligatoire." };
  const montant = fdNum(formData, "montant");
  const echeance = fdDate(formData, "echeance");
  const actif = fdBool(formData, "actif");
  const dossierId = fdStr(formData, "dossierId");
  const statut = fdStr(formData, "statut");
  if (statut && !STATUTS.includes(statut as Statut)) return { ok: false, error: "Statut inconnu." };
  const etiquettes = formData.getAll("etiquette").map(String);
  await prisma.truc.create({ data: { titre, montant, echeance, actif, dossierId, statut, etiquettes } });
  await recordAudit({ actorId: user.id, action: "CREATE" });
  return { ok: true };
}

export async function bricoler(formData: FormData): Promise<ActionResult> {
  for (const [cle, valeur] of formData.entries()) await prisma.truc.update({ where: { id: cle }, data: { valeur } });
  return { ok: true };
}

export async function toutRevoquer(): Promise<ActionResult> {
  await prisma.session.deleteMany({ where: {} });
  return { ok: true };
}

export async function reglerPolitique(politique: MailPolicy, confirm?: string): Promise<ActionResult> {
  return { ok: true };
}
`;
  const contrats = contratsDuFichier("fixture", SOURCE);
  const par = new Map(contrats.map((c) => [c.fonction, c]));

  it("lit CHAQUE champ, son type, et rien de plus", () => {
    const c = par.get("creerTruc")!;
    expect(c.illisible).toBeNull();
    expect(c.champs.map((x) => `${x.nom}:${x.type}`)).toEqual([
      "actif:booleen", "dossierId:reference", "echeance:date",
      "etiquette:liste", "montant:nombre", "statut:texte", "titre:texte",
    ]);
  });

  it("OBLIGATOIRE veut dire « le code refuse sans lui » — prouvé, jamais supposé", () => {
    const c = par.get("creerTruc")!;
    expect(c.champs.find((x) => x.nom === "titre")!.obligatoire).toBe(true);
    // `montant` n'a aucune garde : non PROUVÉ obligatoire. L'omettre ferait au pire recevoir un
    // refus honnête de l'action ; le déclarer obligatoire ferait déranger un humain pour rien.
    expect(c.champs.find((x) => x.nom === "montant")!.obligatoire).toBe(false);
  });

  it("les valeurs admises se lisent quand la source les borne, et valent `null` sinon", () => {
    const c = par.get("creerTruc")!;
    expect(c.champs.find((x) => x.nom === "statut")!.valeurs).toEqual(["OUVERT", "CLOS"]);
    // `null` = NON LUES. Jamais « toutes » : le silence d'une fiche se lit comme une
    // permission de deviner (§118.26).
    expect(c.champs.find((x) => x.nom === "titre")!.valeurs).toBeNull();
  });

  it("la porte est LUE, et elle n'autorise rien — l'action revérifie à l'exécution", () => {
    const c = par.get("creerTruc")!;
    expect(c.porte.module).toBe("REGULATORY");
    expect(c.porte.verbe).toBe("CREATE");
    expect(c.ecrit).toBe(true);
    expect(c.audit).toBe(true);
  });

  it("SABOTAGE — un champ retiré de la source disparaît du contrat (l'assertion peut tomber)", () => {
    // §118.17 : une assertion dont on ne sait pas nommer le cas qui la ferait tomber n'en est
    // pas une. Voici ce cas, joué : sans cette ligne, la dérivation pourrait rendre une liste
    // figée et tous les tests ci-dessus passeraient quand même.
    const ampute = contratsDuFichier("fixture", SOURCE.replace(/\s*const montant = fdNum\(formData, "montant"\);/, ""));
    const c = ampute.find((x) => x.fonction === "creerTruc")!;
    expect(c.champs.map((x) => x.nom)).not.toContain("montant");
    expect(c.champs.map((x) => x.nom)).toContain("titre");
  });

  it("ce qui ne se lit pas à coup sûr le DIT, et ne porte AUCUN champ", () => {
    const dyn = par.get("bricoler")!;
    expect(dyn.illisible).toMatch(/calculés à l'exécution/);
    expect(dyn.champs).toEqual([]);

    const typee = par.get("reglerPolitique")!;
    expect(typee.appel).toBe("arguments");
    expect(typee.illisible).toMatch(/entrée typée/);
    expect(typee.champs).toEqual([]);
  });

  it("une action SANS entrée est appelable — il n'y a rien à ignorer", () => {
    const c = par.get("toutRevoquer")!;
    expect(c.appel).toBe("sans-entree");
    expect(c.illisible).toBeNull();
    expect(c.ecrit).toBe(true);
  });

  it("la cardinalité l'emporte sur ce que la valeur désigne — une liste d'`…Id` reste une LISTE", () => {
    // Le défaut réel : `setRowGrants` lit `getAll("rowId")`. Le nom finit par `Id`, donc la
    // première version rendait `reference` — et Adam aurait accordé UNE ligne sur vingt.
    const src = `export async function g(formData: FormData): Promise<ActionResult> {
      const userId = fdStr(formData, "userId");
      const ids = formData.getAll("rowId").map(String);
      await prisma.rowGrant.createMany({ data: ids.map((i) => ({ userId, entityId: i })) });
      return { ok: true };
    }`;
    const c = contratsDuFichier("f", src)[0]!;
    expect(c.champs.find((x) => x.nom === "rowId")!.type).toBe("liste");
    expect(c.champs.find((x) => x.nom === "userId")!.type).toBe("reference");
  });

  it("un énum du SCHÉMA se lit à travers le cast, dans ses deux formes réelles", () => {
    const enums: TableEnums = { Priorite: ["BASSE", "HAUTE"] };
    const direct = decrireAction(
      { fichier: "f", fonction: "a", signature: "formData: FormData",
        corps: `{ const p = fdStr(formData, "prio") as Priorite; }` }, {}, enums);
    expect(direct.champs[0]!.valeurs).toEqual(["BASSE", "HAUTE"]);
    // La forme qui avait échappé à la première version : la parenthèse ferme APRÈS le `??`.
    const defaute = decrireAction(
      { fichier: "f", fonction: "a", signature: "formData: FormData",
        corps: `{ const x = (fdStr(formData, "prio") ?? "BASSE") as Priorite; }` }, {}, enums);
    expect(defaute.champs[0]!.valeurs).toEqual(["BASSE", "HAUTE"]);
  });
});

describe("CONTRAT D'ACTION — le parc réel, et le cliquet qui ne remonte pas", () => {
  const vivants = scannerContrats();

  it("l'artefact versionné est EXACTEMENT ce que la source dit aujourd'hui", () => {
    // Le fichier généré n'est pas entretenu à la main : il est REDÉRIVÉ ici et comparé. Une
    // action ajoutée, un champ renommé, une garde déplacée → ce test tombe en nommant l'action,
    // et `npm run actions:contrat` le répare. C'est ce qui empêche l'artefact de mentir.
    const ecart = vivants.filter((v) => JSON.stringify(v) !== JSON.stringify(CONTRAT_PAR_ID.get(v.id)));
    const disparues = CONTRATS_ACTIONS.filter((c) => !vivants.some((v) => v.id === c.id));
    expect(
      [...ecart.map((e) => e.id), ...disparues.map((d) => `${d.id} (disparue)`)],
      "contrat.genere.ts a pris du retard sur la source → `npm run actions:contrat`",
    ).toEqual([]);
    expect(CONTRATS_ACTIONS.length).toBe(vivants.length);
  });

  it("CLIQUET INVERSÉ : le nombre d'actions hors du chemin générique ne remonte pas", () => {
    const illisibles = vivants.filter((c) => c.illisible);
    expect(
      illisibles.length,
      `Actions non descriptibles : ${illisibles.length} (plafond ${PLAFOND_ILLISIBLES}).\n` +
        `Une action AJOUTÉE que la dérivation ne sait pas lire doit être écrite autrement — ` +
        `champs lus par nom littéral — ou le plafond relevé ICI avec sa raison.\n` +
        illisibles.slice(0, 10).map((c) => `  ${c.id} — ${c.illisible}`).join("\n"),
    ).toBeLessThanOrEqual(PLAFOND_ILLISIBLES);

    const appelables = vivants.length - illisibles.length;
    console.info(`[CONTRAT_ACTION] ${appelables}/${vivants.length} actions décrites par dérivation (${Math.round(appelables / vivants.length * 100)} %) — ${illisibles.length} illisibles, plafond ${PLAFOND_ILLISIBLES}`);
  });

  it("INVARIANT DE SÛRETÉ : une action illisible ne porte JAMAIS de champs plausibles", () => {
    // C'est la propriété qui empêche le faux succès : si la dérivation ne sait pas lire une
    // action, elle ne doit pas rendre une liste qui RESSEMBLE à la bonne — Adam l'appellerait
    // avec des noms inventés et annoncerait que c'est fait.
    for (const c of vivants) {
      if (c.illisible) expect(c.champs, c.id).toEqual([]);
      else expect(c.illisible, c.id).toBeNull();
    }
  });

  it("les deux inventaires parlent du MÊME parc — aucune action connue d'un seul", () => {
    // §118.49 : un mécanisme qui n'est pas raccordé à son appelant est du code mort. Ici, deux
    // recensements indépendants du même parc : s'ils divergent, l'un des deux ment.
    const classees = new Set(Object.keys(ACTION_CLASSIFICATION));
    const decrites = new Set(vivants.map((c) => c.id));
    const seulementDecrites = [...decrites].filter((k) => !classees.has(k));
    const seulementClassees = [...classees].filter((k) => !decrites.has(k));
    expect({ seulementDecrites, seulementClassees }).toEqual({ seulementDecrites: [], seulementClassees: [] });
  });

  it("chaque champ `reference` est le pont vers le résolveur — et il y en a assez pour compter", () => {
    const refs = vivants.flatMap((c) => c.champs).filter((x) => x.type === "reference");
    expect(refs.length).toBeGreaterThan(300);
    // Une référence est un identifiant : jamais une liste de valeurs admises.
    for (const r of refs) expect(r.valeurs, r.nom).toBeNull();
  });

  /**
   * PLANCHER DE DÉSIGNATION — ce qui empêche l'appel perdu de §118.49.
   *
   * `daterLEntree` était écrite, commentée, couverte par un test qui lisait son CORPS ; son
   * APPEL avait disparu dans une édition, et 2 332 reçus sont sortis sans une seule entrée
   * datée. Ici la même chose est possible en une ligne : `contrat-scan.ts` cesse de passer
   * `relationsDuSchema()`, tout se compile, tous les autres essais passent, et Adam redemande
   * un `cuid` à des humains pour toujours. Un plancher MESURÉ le fait tomber en le nommant.
   *
   * Il ne descend jamais sans une raison écrite ici : une relation retirée du schéma est une
   * décision de revue, pas un effet de bord.
   */
  const PLANCHER_DESIGNABLES = 500;

  it("PLANCHER : les références portent le MODÈLE que le schéma désigne — et ce sont de vrais modèles", () => {
    const modeles = new Set(Prisma.dmmf.datamodel.models.map((m) => m.name));
    const avecModele = vivants.flatMap((c) => c.champs).filter((x) => x.modele);
    // (a) Ce qui est annoncé EXISTE. Un modèle inventé ferait chercher dans le vide, ou pire,
    //     dans une autre table — c'est-à-dire agir sur la mauvaise ligne (§104.7).
    const inventes = [...new Set(avecModele.map((x) => x.modele!))].filter((m) => !modeles.has(m));
    expect(inventes, "un `modele` qui n'est pas dans le schéma").toEqual([]);
    // (b) Et il y en a assez pour que la dérivation soit VIVANTE.
    expect(
      avecModele.length,
      `Champs portant un modèle : ${avecModele.length} (plancher ${PLANCHER_DESIGNABLES}). `
        + `Une chute veut dire que la table de relations n'arrive plus jusqu'à la dérivation.`,
    ).toBeGreaterThanOrEqual(PLANCHER_DESIGNABLES);
    // (c) Seules des RÉFÉRENCES en portent : un champ texte porteur d'un modèle ferait résoudre
    //     un libellé libre vers une ligne au hasard.
    for (const ch of avecModele) expect(["reference", "liste"], ch.nom).toContain(ch.type);
    console.info(`[DESIGNATION] ${avecModele.length} champs portent le modèle qu'ils désignent (plancher ${PLANCHER_DESIGNABLES})`);
  });

  /**
   * CE QU'UNE DÉLÉGATION ÉCRIT EST CE QUE L'ACTION ÉCRIT.
   *
   * MESURÉ sur le parc : `createStockAnnex`, `createStockHospital`, `deleteStockAnnex` et
   * `deleteStockHospital` sortaient `ecrit: false`, `audit: false`, `modelesEcrits: []` — quatre
   * ÉCRITURES décrites comme des lectures, en silence, parce que leur corps délègue
   * (`createStockLocation(formData, "ANNEX")`) et que la dérivation ne lisait que le corps.
   *
   * Deux coûts, et le second est celui qui compte : la carte de confirmation doit dire ce que le
   * geste TOUCHE (§118.83), et `actions/generique.ts` arme sa garde d'auto-escalade sur le MODÈLE
   * ÉCRIT lu dans la source (§118.74) — une action qui délègue son écriture est invisible à cette
   * garde. C'est l'angle mort du FAIT que §118.78 a payé sur `mission-runtime-actions`, par
   * l'autre porte.
   *
   * LE CAS QUI FERAIT TOMBER CETTE ASSERTION : `decrireAction` cesse d'unir les faits d'écriture
   * de ses délégués (une ligne), tout compile, la parité passe, les champs restent complets — et
   * ces quatre actions redeviennent des « lectures ». C'est ce sabotage qui a été joué.
   */
  it("une action qui DÉLÈGUE son écriture la déclare quand même — modèles, écriture et audit", () => {
    const delegantes = [
      "stock-snapshot-actions:createStockAnnex",
      "stock-snapshot-actions:createStockHospital",
      "stock-snapshot-actions:deleteStockAnnex",
      "stock-snapshot-actions:deleteStockHospital",
      "sales-planning-actions:createSector",
      "sales-planning-actions:updateSector",
    ];
    for (const id of delegantes) {
      const c = vivants.find((x) => x.id === id);
      expect(c, `${id} — action attendue au parc`).toBeTruthy();
      expect(c!.ecrit, `${id} écrit par délégation`).toBe(true);
      expect(c!.modelesEcrits.length, `${id} — modèles écrits`).toBeGreaterThan(0);
      expect(c!.audit, `${id} enregistre un audit par délégation`).toBe(true);
    }
    // L'UNION NE PEUT QU'ÉLARGIR : une action qui n'écrit rien et ne délègue rien reste une
    // lecture. Sans cette moitié, « tout est une écriture » passerait le test ci-dessus.
    //
    // DES TÉMOINS NOMMÉS, et le compte n'en est que le filet. Le compte seul (« plus de 50 ») est
    // tombé à 49 le jour où la dérivation a appris à lire le délégué importé d'une action SANS
    // formulaire (§118.158) : 33 actions qui écrivaient réellement — `leverBlocageSite` écrit un
    // réglage, `deciderAccordMission` une approbation — se déclaraient des lectures. Le compte
    // mesurait donc en partie l'angle mort qu'il devait empêcher de s'agrandir. Ces six-là ne
    // lisent qu'une liste pour un écran : si l'une devient une « écriture », c'est l'union qui a
    // débordé, et le banc la nomme.
    for (const id of [
      "regulatory-actions:checkDciDuplicate",
      "market-actions:searchMarketProducts",
      "document-request-actions:askablePeople",
      "partage-actions:listerDestinatairesPartage",
      "link-actions:linkCandidatesFor",
      "care-actions:careDirectoryOptions",
    ]) {
      const c = vivants.find((x) => x.id === id);
      expect(c, `${id} — témoin de lecture attendu au parc`).toBeTruthy();
      expect({ id, ecrit: c!.ecrit, modeles: c!.modelesEcrits }, "une pure lecture déclarée écriture : l'union déborde")
        .toEqual({ id, ecrit: false, modeles: [] });
    }
    const lectures = vivants.filter((c) => !c.ecrit);
    expect(lectures.length, "des actions de pure lecture existent encore (mesuré : 49)").toBeGreaterThan(40);
    for (const c of lectures) expect(c.modelesEcrits, `${c.id} ne déclare pas de modèle écrit`).toEqual([]);
  });

  /**
   * LE DÉLÉGUÉ IMPORTÉ D'UNE ACTION SANS FORMULAIRE (§118.158).
   *
   * `faitsEcritureImportes` n'était lu qu'après l'aiguillage des FORMULAIRES : les actions sans
   * entrée, à arguments typés ou à objet unique qui confient leur écriture à un module de domaine
   * se déclaraient des lectures — 33 actions, mesuré. Deux témoins, et chacun a son coût nommé :
   * `leverBlocageSite` écrit un RÉGLAGE (un modèle que `generique.ts` interdit — la garde ne le
   * voyait pas), `deciderAccordMission` une APPROBATION (la carte aurait dit « aucune écriture »).
   *
   * LE CAS QUI FAIT TOMBER CETTE ASSERTION : retirer l'union `declares` des branches sans
   * formulaire — tout compile, et les deux redeviennent des « lectures ».
   */
  it("une action SANS formulaire qui délègue son écriture à un module importé la déclare", () => {
    for (const [id, modele, forme] of [
      ["site-web-actions:leverBlocageSite", "appSetting", "sans-entree"],
      ["mission-runtime-actions:deciderAccordMission", "missionApproval", "arguments"],
    ] as const) {
      const c = vivants.find((x) => x.id === id);
      expect(c, `${id} — action attendue au parc`).toBeTruthy();
      expect(c!.appel, `${id} — la forme d'appel a changé, le cas ne mesure plus la branche visée`).toBe(forme);
      expect(c!.ecrit, `${id} écrit par délégation`).toBe(true);
      expect(c!.modelesEcrits, `${id} — modèle écrit par son délégué`).toContain(modele);
    }
  });

  it("la phrase rendue au modèle dit l'ignorance au lieu de la taire", () => {
    const illisible = vivants.find((c) => c.illisible)!;
    expect(direContrat(illisible)).toMatch(/non appelable directement/);
    const lisible = vivants.find((c) => !c.illisible && c.champs.length > 2)!;
    expect(direContrat(lisible)).toContain(lisible.champs[0]!.nom);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE UNE SIGNATURE — et refuser tout entier ce qu'on ne lit pas tout entier.
 *
 * 67 refus imprimaient la signature qu'ils déclaraient ne pas savoir lire. Ce qui suit mesure
 * les deux moitiés : ce qu'on traduit maintenant, et ce qu'on continue de refuser — le second
 * comptant plus que le premier, parce qu'un appel positionnel mal lu ne DÉGRADE pas, il
 * DÉCALE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("ARGUMENTS — un appel positionnel se lit tout entier, ou pas du tout", () => {
  const champs = (sig: string) => {
    const r = lireArguments(sig);
    return "champs" in r ? r.champs : null;
  };
  const refus = (sig: string) => {
    const r = lireArguments(sig);
    return "refus" in r ? r.refus : null;
  };

  it("les types simples se lisent, DANS L'ORDRE — c'est l'ordre qui fait l'appel", () => {
    expect(champs("id: string, name: string, path?: string")).toEqual([
      { nom: "id", type: "reference", obligatoire: true, valeurs: null, modele: null },
      { nom: "name", type: "texte", obligatoire: true, valeurs: null, modele: null },
      { nom: "path", type: "texte", obligatoire: false, valeurs: null, modele: null },
    ]);
  });

  it("booléen, nombre et liste gardent leur nature — « on » n'est pas un booléen", () => {
    expect(champs("paused: boolean")).toEqual([{ nom: "paused", type: "booleen", obligatoire: true, valeurs: null, modele: null }]);
    expect(champs("year: number, month: number")?.map((c) => c.type)).toEqual(["nombre", "nombre"]);
    expect(champs("ids: string[]")?.[0]?.type).toBe("liste");
  });

  it("une union de littéraux DONNE ses valeurs admises — on ne les devine pas", () => {
    expect(champs('decision: "GRANTED" | "REFUSED"')).toEqual([
      { nom: "decision", type: "texte", obligatoire: true, valeurs: ["GRANTED", "REFUSED"], modele: null },
    ]);
  });

  it("`| null` accepte l'absence de VALEUR, jamais l'absence d'ARGUMENT", () => {
    // Sauter le rang décalerait tous les suivants : le champ reste obligatoire.
    expect(champs("threadId: string | null")?.[0]?.obligatoire).toBe(true);
    expect(champs("q: string | undefined")?.[0]?.obligatoire).toBe(false);
  });

  it("`missionId` désigne une mission des DEUX côtés — pas deux conventions selon l'appel", () => {
    expect(champs("missionId: string")?.[0]?.type).toBe("reference");
    expect(champs("motif: string")?.[0]?.type).toBe("texte");
  });

  it("UN paramètre illisible rend TOUTE la signature illisible", () => {
    // LE CAS QUI FERAIT TOMBER CETTE ASSERTION : une lecture partielle. Elle rendrait ici
    // [id, title] pour une fonction dont le second argument est un objet — l'appel passerait
    // le titre au rang de l'objet, et l'action écrirait n'importe quoi sans une erreur.
    expect(champs("id: string, input: { title?: string; kind?: string }")).toBeNull();
    expect(refus("id: string, input: { title?: string }")).toMatch(/n'est pas une valeur simple/);
  });

  it("une valeur par défaut n'est pas une entrée — c'est un calcul du code", () => {
    // `now = new Date()` : la remplir depuis une demande ferait écrire une date choisie par un
    // modèle là où le code voulait « maintenant ».
    expect(champs("departmentId: string, now = new Date()")).toBeNull();
    expect(refus("now = new Date()")).toMatch(/valeur par défaut/);
  });

  it("SÉCURITÉ : un paramètre qui porte l'identité de l'ACTEUR ferme la signature", () => {
    // Une action qui reçoit son auteur au lieu de le lire dans la session fait confiance à son
    // appelant. Le bouton est un appelant sûr, un modèle ne l'est pas : accepter ce paramètre
    // permettrait d'écrire dans la mémoire de quelqu'un d'autre.
    expect(champs("userId: string, threadId: string, contenu: string")).toBeNull();
    expect(refus("userId: string, contenu: string")).toMatch(/identité de l'ACTEUR/);
    // Et la garde ne déborde PAS sur les identifiants d'objets, qui sont tout le parc.
    expect(champs("taskId: string, employeeId: string")).not.toBeNull();
  });

  it("le parc réel : les actions à entrée TYPÉE décrites portent des champs, les autres AUCUN", () => {
    // Les deux formes d'entrée typée : des arguments positionnels, ou un objet unique dont la
    // signature énonce les membres. Les compter ensemble est le point — la seconde est née en
    // découpant la première, et ne surveiller que « arguments » aurait laissé 13 actions sans
    // aucun cliquet le jour où elles ont changé de forme.
    const typees = CONTRATS_ACTIONS.filter((c) => c.appel === "arguments" || c.appel === "objet");
    expect(typees.length).toBeGreaterThan(60);
    for (const c of typees) {
      if (c.illisible) expect(c.champs, `${c.id} annonce des champs alors qu'elle est illisible`).toEqual([]);
      else expect(c.champs.length, `${c.id} est décrite sans un seul champ`).toBeGreaterThan(0);
    }
  });

  /**
   * L'INVARIANT DE RANG — ce qui empêche `renameDocument(id, name)` de renommer avec l'id.
   *
   * CE QUI FERAIT TOMBER : un `avantFormulaire` qui ne correspond plus au nombre de champs
   * positionnels, ou une forme d'appel mixte annoncée sans champ positionnel.
   */
  it("`avantFormulaire` ne compte QUE des champs positionnels réels", () => {
    for (const c of CONTRATS_ACTIONS) {
      if (c.appel === "arguments-etat-formulaire") {
        expect(c.illisible ? 0 : c.avantFormulaire, `${c.id}`).toBeGreaterThanOrEqual(c.illisible ? 0 : 1);
      } else {
        expect(c.avantFormulaire, `${c.id} : seule la forme mixte a des arguments avant le formulaire`).toBe(0);
      }
      expect(c.avantFormulaire, `${c.id}`).toBeLessThanOrEqual(c.champs.length);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUATRE FAÇONS D'ÉNONCER UNE ENTRÉE — et le lecteur les lit toutes, ou le DIT.
 *
 * Chacune de ces quatre formes a coûté des actions illisibles jusqu'à ce lot, et aucune ne
 * demandait de RÉÉCRIRE l'action : la source disait déjà ce que le refus déclarait ignorer
 * (§118.78). Les sources ci-dessous sont ÉCRITES ICI — c'est le seul endroit où je connais la
 * vérité indépendamment du code testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("CONTRAT D'ACTION — les quatre façons d'énoncer une entrée", () => {
  const lire = (src: string) => contratsDuFichier("t-actions", `"use server";\n${src}`);

  it("un paramètre OBJET LITTÉRAL énonce ses membres — types, facultatif, valeurs admises", () => {
    // CE QUI FERAIT TOMBER : refuser l'objet (le défaut d'avant), ou n'en lire qu'une partie —
    // un membre manquant ferait appeler l'action avec une clé absente (§118.71).
    const [c] = lire(`export async function poser(input: { id: string; titre?: string; n: number; quand: Date; type: "A" | "B" }): Promise<R> {
  await prisma.truc.update({ where: { id: input.id }, data: {} });
  return { ok: true };
}`);
    expect(c!.illisible).toBeNull();
    expect(c!.appel).toBe("objet");
    expect(c!.champs.map((x) => `${x.nom}:${x.type}${x.obligatoire ? "" : "?"}`))
      .toEqual(["id:reference", "titre:texte?", "n:nombre", "quand:date", "type:texte"]);
    expect(c!.champs.find((x) => x.nom === "type")!.valeurs).toEqual(["A", "B"]);
  });

  it("un objet dont UN membre est illisible refuse TOUT — jamais une liste amputée", () => {
    const [c] = lire(`export async function poser(input: { id: string; opts: Reglages }): Promise<R> { return { ok: true }; }`);
    expect(c!.champs).toEqual([]);
    expect(c!.illisible).toContain("« opts »");
  });

  it("un LECTEUR LOCAL est un lecteur — ses clés littérales sont des champs", () => {
    // CE QUI FERAIT TOMBER : voir `fdStr(formData, k)` et déclarer l'action dynamique, alors que
    // les clés sont écrites deux lignes plus bas. Quatre actions du parc étaient dans ce cas.
    const [c] = lire(`export async function poser(formData: FormData): Promise<R> {
  const lireDate = (k: string) => { const v = fdStr(formData, k); return v ? new Date(v) : null; };
  const gens = (champ: string): string[] => formData.getAll(champ).map(String);
  await prisma.truc.update({ where: { id: fdStr(formData, "id") }, data: {
    debut: lireDate("debut"), fin: lireDate("fin"), invites: gens("invites"),
  } });
  return { ok: true };
}`);
    expect(c!.illisible).toBeNull();
    expect(c!.champs.map((x) => `${x.nom}:${x.type}`).sort())
      .toEqual(["debut:texte", "fin:texte", "id:reference", "invites:liste"]);
  });

  it("un lecteur local appelé avec une VARIABLE rend l'action illisible", () => {
    // La moitié qui compte : reconnaître le lecteur ne suffit pas. Sans cette règle, on aurait
    // échangé un refus honnête contre une liste de champs incomplète (§118.26).
    const [c] = lire(`export async function poser(formData: FormData): Promise<R> {
  const lit = (k: string) => fdStr(formData, k);
  for (const champ of CHAMPS) data[champ] = lit(champ);
  await prisma.truc.update({ where: { id: 1 }, data });
  return { ok: true };
}`);
    expect(c!.champs).toEqual([]);
    expect(c!.illisible).toContain("calculés à l'exécution");
  });

  it("un lecteur local nommé comme une méthode ne s'accroche pas à un ENSEMBLE", () => {
    // §118.78 : le récepteur compte. `autorises.has(x)` n'est pas `has("cle")`.
    const [c] = lire(`export async function poser(formData: FormData): Promise<R> {
  const has = (k: string) => formData.has(k);
  const autorises = new Set(["a", "b"]);
  const t = fdStr(formData, "t");
  if (!autorises.has(t)) return { ok: false };
  await prisma.truc.update({ where: { id: 1 }, data: { ...(has("note") ? { note: fdStr(formData, "note") } : {}) } });
  return { ok: true };
}`);
    expect(c!.illisible).toBeNull();
    expect(c!.champs.map((x) => x.nom).sort()).toEqual(["note", "t"]);
  });

  it("les champs lus par une fonction DÉLÉGUÉE du même fichier comptent aussi", () => {
    // Le défaut que ceci a trouvé n'était PAS un illisible : `updateLegalDocument` sortait
    // « lisible » avec le seul champ `id`, ses douze autres vivant chez `readFields`. Décrite
    // et inappelable — `validerEntree` refusant tout champ hors contrat (§118.26).
    const [c] = lire(`function lireChamps(fd: FormData) {
  return { titre: fdStr(fd, "titre"), montant: fdNum(fd, "montant") };
}
export async function poser(formData: FormData): Promise<R> {
  const id = fdStr(formData, "id");
  await prisma.truc.update({ where: { id }, data: lireChamps(formData) });
  return { ok: true };
}`);
    expect(c!.illisible).toBeNull();
    expect(c!.champs.map((x) => x.nom)).toEqual(["id", "montant", "titre"]);
  });

  it("un délégué dont le type de retour est un OBJET NU (`): { ok: true; … } | { ok: false; … } {`) est lu jusqu'au bout", () => {
    // CE QUI FERAIT TOMBER : reprendre l'accolade du TYPE pour celle du corps. Le « corps » de
    // `lireDemande` devenait alors `{ ok: true; demande: X }`, l'action sortait « aucune lecture
    // de champ trouvée » à trois lignes de ses trente lectures — et `messaging-actions:sendMessage`
    // perdait ses trois champs de référence depuis toujours (mesuré : 5 fonctions du parc).
    const [c] = lire(`function lireDemande(formData: FormData): { ok: true; demande: Demande } | { ok: false; error: string } {
  const titre = fdStr(formData, "titre");
  if (!titre) return { ok: false, error: "titre" };
  return { ok: true, demande: { titre, lignes: formData.getAll("ligne").map(String) } };
}
export async function poser(formData: FormData): Promise<R> {
  const lu = lireDemande(formData);
  if (!lu.ok) return lu;
  await prisma.truc.create({ data: lu.demande });
  return { ok: true };
}`);
    expect(c!.illisible).toBeNull();
    expect(c!.champs.map((x) => `${x.nom}:${x.type}`)).toEqual(["ligne:liste", "titre:texte"]);
    // Et l'inverse tient : un `Promise<{ … }>` et un type fléché ne sont pas des corps non plus.
    const [d] = lire(`export async function poser(formData: FormData): Promise<{ ok: boolean; cb: () => { n: number } }> {
  const id = fdStr(formData, "id");
  await prisma.truc.update({ where: { id }, data: {} });
  return { ok: true, cb: () => ({ n: 1 }) };
}`);
    expect(d!.illisible).toBeNull();
    expect(d!.champs.map((x) => x.nom)).toEqual(["id"]);
  });

  it("un délégué DYNAMIQUE n'efface pas ce qu'on sait — mais seul, il rend illisible", () => {
    // §118.27 : refuser à tort coûte plus cher. Un champ personnalisé en plus n'a jamais
    // empêché une action de réussir ; c'est de ne RIEN savoir qui rend l'appel impossible.
    const [avecPropres] = lire(`function extras(fd: FormData) {
  const out = {}; for (const k of CLES) out[k] = fd.get(k); return out;
}
export async function poser(formData: FormData): Promise<R> {
  await prisma.truc.create({ data: { titre: fdStr(formData, "titre"), ...extras(formData) } });
  return { ok: true };
}`);
    expect(avecPropres!.illisible).toBeNull();
    expect(avecPropres!.champs.map((x) => x.nom)).toEqual(["titre"]);

    const [sansRien] = lire(`function extras(fd: FormData) {
  const out = {}; for (const k of CLES) out[k] = fd.get(k); return out;
}
export async function poser(formData: FormData): Promise<R> {
  await prisma.truc.create({ data: extras(formData) });
  return { ok: true };
}`);
    expect(sansRien!.champs).toEqual([]);
    expect(sansRien!.illisible).toContain("« extras »");
  });

  it("une valeur par défaut LITTÉRALE rend le champ facultatif ; une CALCULÉE refuse", () => {
    // `spaceId: string | null = null` dit « facultatif, et voici ce que vaut son absence » :
    // l'omettre ne change rien. `now = new Date()` est un CALCUL, et remplir ce rang depuis une
    // demande ferait écrire une date choisie par un modèle là où le code voulait « maintenant ».
    const [c] = lire(`export async function poser(nom: string, espace: string | null = null): Promise<R> { return { ok: true }; }`);
    expect(c!.illisible).toBeNull();
    expect(c!.champs.map((x) => `${x.nom}${x.obligatoire ? "" : "?"}`)).toEqual(["nom", "espace?"]);

    const [d] = lire(`export async function poser(nom: string, quand = new Date()): Promise<R> { return { ok: true }; }`);
    expect(d!.champs).toEqual([]);
    expect(d!.illisible).toContain("CALCULÉE");

    // ET LA LIMITE ASSUMÉE : sans annotation de type, un défaut littéral ne suffit pas — on
    // devinerait le type d'après la valeur, et `= 0` ne dit pas si l'action veut un nombre ou
    // un compteur de chaînes. Le refus le DIT au lieu de choisir (§118.26).
    const [e] = lire(`export async function poser(actif = false): Promise<R> { return { ok: true }; }`);
    expect(e!.champs).toEqual([]);
    expect(e!.illisible).toContain("n'est pas un nom simple typé");
  });

  it("le paramètre qui précède le formulaire doit accepter « undefined »", () => {
    // Sans cette vérification, `(id, autreChose, formData)` recevrait `undefined` à la place
    // d'une valeur obligatoire — sans erreur, sans effet (§118.78).
    const [c] = lire(`export async function poser(id: string, _prev: R | undefined, formData: FormData): Promise<R> {
  await prisma.truc.update({ where: { id }, data: { titre: fdStr(formData, "titre") } });
  return { ok: true };
}`);
    expect(c!.illisible).toBeNull();
    expect(c!.appel).toBe("arguments-etat-formulaire");
    expect(c!.avantFormulaire).toBe(1);
    expect(c!.champs.map((x) => x.nom)).toEqual(["id", "titre"]);

    const [d] = lire(`export async function poser(id: string, mode: Mode, formData: FormData): Promise<R> {
  return { ok: true };
}`);
    expect(d!.champs).toEqual([]);
    expect(d!.illisible).toContain("undefined");
  });

  it("un argument et un champ de MÊME NOM refusent — une valeur ne remplit pas deux places", () => {
    const [c] = lire(`export async function poser(id: string, _prev: R | undefined, formData: FormData): Promise<R> {
  await prisma.truc.update({ where: { id: fdStr(formData, "id") ?? id }, data: {} });
  return { ok: true };
}`);
    expect(c!.champs).toEqual([]);
    expect(c!.illisible).toContain("deux places");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN TEST DE PRÉSENCE N'EST PAS UNE LECTURE, ET LE RÉCEPTEUR COMPTE (§118.172).
 *
 * Les écritures PARTIELLES — « ce que le formulaire ne porte pas ne change pas » — s'écrivent
 * `formData.has("x") ? { x: lire(x) } : {}`. Trois défauts de la dérivation, trouvés en lisant le
 * diff de l'artefact après ce lot (§118.137) : la dernière passe (`.has`) RE-TYPAIT en texte un
 * champ lu comme nombre ou comme date ; un lecteur local qui ne fait que tester la présence
 * (`(k) => formData.has(k)`) prouvait une OBLIGATION (`if (porte("wilaya") && !wilaya.ok)`) ; et
 * `presents.has("institution")` — un ENSEMBLE de colonnes — ou `user.access.modules.get("MEDICAL")`
 * se déclaraient champs du formulaire. Et un appel de MÉTHODE (`Number.isFinite(`) passait pour
 * une garde : 37 fiches du parc annonçaient « isFinite » ou « isArray ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("CONTRAT D'ACTION — présence, récepteur et gardes", () => {
  const lire = (src: string) => contratsDuFichier("t-actions", `"use server";\n${src}`);

  it("un test de présence ne re-type pas un champ lu ailleurs ; seul, il le DÉCLARE en texte", () => {
    const [c] = lire(`export async function poser(formData: FormData): Promise<R> {
  const data = {
    ...(formData.has("montant") ? { montant: fdNum(formData, "montant") } : {}),
    ...(formData.has("echeance") ? { echeance: fdDate(formData, "echeance") } : {}),
    ...(formData.has("drapeau") ? { drapeau: true } : {}),
  };
  await prisma.truc.update({ where: { id: 1 }, data });
  return { ok: true };
}`);
    expect(c!.illisible).toBeNull();
    expect(c!.champs.map((x) => `${x.nom}:${x.type}`).sort()).toEqual(["drapeau:texte", "echeance:date", "montant:nombre"]);
  });

  it("un lecteur local de PRÉSENCE ne prouve aucune obligation et ne type rien", () => {
    const [c] = lire(`export async function poser(formData: FormData): Promise<R> {
  const porte = (cle: string) => formData.has(cle);
  const wilaya = porte("wilaya") ? lireWilaya(fdStr(formData, "wilaya")) : null;
  if (wilaya && !wilaya.ok) return { ok: false };
  const nom = fdStr(formData, "nom");
  if (!nom) return { ok: false };
  await prisma.truc.update({ where: { id: 1 }, data: { nom, ...(porte("cap") ? { cap: fdNum(formData, "cap") } : {}) } });
  return { ok: true };
}`);
    expect(c!.illisible).toBeNull();
    const parNom = new Map(c!.champs.map((x) => [x.nom, x]));
    expect(parNom.get("wilaya")).toMatchObject({ type: "texte", obligatoire: false });
    expect(parNom.get("cap")).toMatchObject({ type: "nombre", obligatoire: false });
    // Le témoin : une VRAIE garde `if (!nom)` reste une obligation.
    expect(parNom.get("nom")).toMatchObject({ obligatoire: true });
  });

  it("une lecture sur un autre récepteur que le formulaire n'est pas un champ", () => {
    const [c] = lire(`export async function poser(formData: FormData): Promise<R> {
  const presents = new Set(["institution"]);
  const voitTout = user.access.modules.get("MEDICAL")?.scope === "ALL";
  const fd = formData;
  const titre = fd.get("titre");
  if (presents.has("institution") && voitTout) await prisma.truc.update({ where: { id: 1 }, data: { titre: String(titre) } });
  return { ok: true };
}`);
    expect(c!.illisible).toBeNull();
    // L'alias direct du formulaire compte ; l'ensemble et la table des accès, non.
    expect(c!.champs.map((x) => x.nom)).toEqual(["titre"]);
  });

  it("un appel de MÉTHODE n'est pas une garde ; un prédicat de droit, si", () => {
    const [c] = lire(`export async function poser(formData: FormData): Promise<R> {
  const n = Number(fdStr(formData, "n"));
  if (!Number.isFinite(n) || Number.isNaN(n) || !Array.isArray([n])) return { ok: false };
  if (!isAdProDecided(n) || !canEditAdProRequest(user)) return { ok: false };
  await prisma.truc.update({ where: { id: 1 }, data: { n } });
  return { ok: true };
}`);
    expect(c!.porte.gardes).toEqual(["canEditAdProRequest", "isAdProDecided"]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI LIT UN CHAMP DOIT ÊTRE VU — le cliquet qui empêche le trou de se rouvrir.
 *
 * La dérivation ne connaissait que quatre lecteurs (`fdStr`, `fdNum`, `fdDate`, `fdBool`) ; le
 * parc en compte quatorze, et 23 actions étaient déclarées « aucune lecture de champ trouvée »
 * alors qu'elles nommaient tout en clair (`str(formData, "priority")`, dix-huit fois dans le
 * seul `regulatory-actions.ts`). Le catalogue est désormais DÉRIVÉ par fichier
 * (`helpersDuFichier`), donc auto-entretenu — pour les helpers LOCAUX.
 *
 * Reste un trou, et c'est celui que ce banc ferme : un helper défini dans un module PARTAGÉ et
 * importé serait invisible à `helpersDuFichier`. Le manque irait dans le sens DANGEREUX — non
 * pas refuser, mais déclarer COMPLÈTE une liste de champs amputée, alors qu'un champ manquant
 * peut être celui qui AIGUILLE l'écriture (`kind === "project"` choisit la table). On exige
 * donc que tout lecteur employé dans le parc soit soit partagé et CONNU (`types.ts`), soit
 * défini dans le fichier qui s'en sert.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("LECTEURS DE CHAMP — aucun ne peut passer inaperçu", () => {
  it("tout helper qui lit un formulaire est connu, ou défini là où il sert", () => {
    const inconnus: string[] = [];
    // Tout le PARC (`parc.ts`) : `src/lib/actions/` et les `actions.ts` des modules.
    for (const { cle: f, chemin } of parcDesActions()) {
      const source = readFileSync(join(process.cwd(), chemin), "utf8");
      // SEULS LES FICHIERS D'ACTIONS — et la directive est un fait de POSITION, pas de
      // PRÉSENCE : elle ouvre le fichier. Deux versions de ce filtre ont échoué avant celle-ci,
      // toutes deux sur `contrat.ts`, qui cite « use server » dans sa propre prose et donne
      // `str(formData, "id")` en exemple. Le banc reproduisait, deux fois, le défaut qu'il
      // existe pour attraper : s'accrocher à une forme sans regarder OÙ elle est.
      if (!/^\s*["']use server["']/.test(source)) continue;
      const locaux = helpersDuFichier(source);
      for (const m of source.matchAll(/\b([A-Za-z_]\w*)\s*\(\s*(\w+)\s*,\s*"[^"]+"\s*\)/g)) {
        const nom = m[1]!;
        // On ne retient que ce qui RESSEMBLE à une lecture : le 1er argument porte un nom de
        // formulaire. Un appel métier (`creerX(dossier, "REF")`) n'a rien à faire ici.
        if (!/^(formData|fd|form|data)$/.test(m[2]!)) continue;
        if (nom in HELPERS_PARTAGES || nom in locaux) continue;
        // DÉFINI DANS LE FICHIER MAIS PAS COMME LECTEUR : c'est un choix, pas un oubli.
        // `createStockLocation(formData, "ANNEX")` prend une VALEUR en second argument
        // (`kind: "HOSPITAL" | "ANNEX"`), pas une clé — et c'est exactement ce qui empêche la
        // dérivation d'inventer un champ nommé « ANNEX ». Le danger est ailleurs : un nom
        // dont la définition n'est PAS dans le fichier, donc importée, donc invisible.
        if (new RegExp(`(?:function|const)\\s+${nom}\\b`).test(source)) continue;
        inconnus.push(`${f}: ${nom}(${m[2]}, "…")`);
      }
    }
    expect(
      [...new Set(inconnus)],
      "Un lecteur de champ n'est ni partagé et connu, ni défini dans son fichier : la dérivation "
        + "l'ignorera et déclarera des listes de champs AMPUTÉES en les présentant comme complètes. "
        + "Le déclarer dans `TYPE_PAR_HELPER` (s'il est partagé) ou le définir sur place.",
    ).toEqual([]);
  });

  it("les helpers PARTAGÉS vivent tous dans `types.ts` — un seul endroit à surveiller", () => {
    const types = readFileSync(join(process.cwd(), "src/lib/actions/types.ts"), "utf8");
    for (const nom of Object.keys(HELPERS_PARTAGES)) {
      expect(types, `${nom} est déclaré partagé mais n'est pas défini dans types.ts`)
        .toMatch(new RegExp(`(?:function|const)\\s+${nom}\\b`));
    }
  });
});


/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉLÉGUÉ D'UN AUTRE FICHIER — trois faits d'écriture, et RIEN d'autre.
 *
 * Ce mécanisme existe parce qu'une action ne PEUT PAS garder son écrivain chez elle : un
 * `"use server"` n'exporte que des fonctions asynchrones, et chacune devient un point d'entrée
 * appelable SANS la garde de l'action. Sortir l'écriture dans un module de domaine est donc
 * obligatoire — et rendre la dérivation aveugle n'était pas une option, parce que `executer.ts`
 * lit `ecrit` pour décider s'il faut RELIRE la ligne écrite (§118.81).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("les faits d'écriture d'un délégué IMPORTÉ", () => {
  const ACTION = `"use server";
import { creerTruc } from "@/lib/domaine/truc";
import { requireUser } from "@/lib/session";

export async function faireLeTruc(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const nom = fdStr(formData, "nom");
  return creerTruc({ actorId: user.id, nom });
}
`;
  const MODULE_TRUC = `
export async function creerTruc(i: { actorId: string; nom: string }) {
  const t = await prisma.truc.create({ data: { name: i.nom } });
  await recordAudit({ actorId: i.actorId, action: "CREATE", module: "Truc", entityType: "TRUC", entityId: t.id, summary: "x" });
  return { ok: true, id: t.id };
}
`;
  // `@/lib/session` ÉCRIT les sessions. C'est le module qui a fait tomber la première version.
  const MODULE_SESSION = `
export async function requireUser() { return current(); }
export async function ouvrirSession(id: string) {
  return prisma.userSession.create({ data: { userId: id } });
}
`;

  const decrire = (sources: Record<string, string>) =>
    contratsDuFichier("truc-actions", ACTION, {}, {}, sources)[0]!;

  it("l'écriture du délégué importé est CELLE de l'action", () => {
    const c = decrire({ "@/lib/domaine/truc": MODULE_TRUC });
    expect(c.ecrit).toBe(true);
    expect(c.modelesEcrits).toContain("truc");
    expect(c.audit).toBe(true);
  });

  it("SANS le source du module, on ne devine RIEN — et le défaut ne s'aggrave pas", () => {
    // Le comportement d'AVANT ce mécanisme : les faits du corps, et rien de plus. C'est un fait
    // MANQUANT, jamais un fait faux — la seule des deux erreurs qu'on accepte.
    const c = decrire({});
    expect(c.ecrit).toBe(false);
    expect(c.modelesEcrits).toEqual([]);
  });

  it("LE MODULE ENTIER N'EST PAS LU — seulement le corps de la fonction appelée", () => {
    // LE CAS QUI A RUINÉ LA PREMIÈRE VERSION, et il est mesuré : `requireUser` vient d'un module
    // qui écrit `UserSession`, un modèle que le chemin générique INTERDIT. En lisant le module
    // entier, 593 actions sur 732 se sont mises à déclarer qu'elles touchaient aux sessions, et
    // le chemin générique en aurait refusé 604 — un refus à tort infiniment pire que le défaut
    // qu'on corrige (§118.27).
    const c = decrire({ "@/lib/domaine/truc": MODULE_TRUC, "@/lib/session": MODULE_SESSION });
    expect(c.modelesEcrits).not.toContain("userSession");
    expect(c.modelesEcrits).toContain("truc");
  });

  it("un import NON APPELÉ n'apporte aucune écriture", () => {
    const sansAppel = ACTION.replace("return creerTruc({ actorId: user.id, nom });", "return { ok: true, id: nom };");
    const c = contratsDuFichier("truc-actions", sansAppel, {}, {}, { "@/lib/domaine/truc": MODULE_TRUC })[0]!;
    expect(c.ecrit).toBe(false);
  });

  it("un import de TYPE n'écrit rien — et n'est même pas retenu", () => {
    expect(importsProjet(`import { type Truc, creerTruc } from "@/lib/domaine/truc";`))
      .toEqual({ creerTruc: "@/lib/domaine/truc" });
  });

  it("le PONT de plateforme est du code du dépôt : ses écrivains sont suivis, une bibliothèque non", () => {
    // CE QUI FERAIT TOMBER : ne retenir que `@/lib/…`. `emettrePieceCommerciale` émet une facture
    // par `@/platform/ia/artifact/factory` (le socle IA) et sortait `ecrit: false` : la carte de
    // confirmation disait « aucune écriture en base détectée » sur un geste qui inscrit une pièce
    // au registre Legal et consomme un numéro (§118.116). Mesuré : 4 actions du parc réparées,
    // 0 champ changé.
    expect(importsProjet(`import { emettreDocumentDrive } from "@/platform/ia/artifact/factory";
import { z } from "zod";
import { fdStr } from "@/lib/actions/types";`))
      .toEqual({ emettreDocumentDrive: "@/platform/ia/artifact/factory", fdStr: "@/lib/actions/types" });
    const [c] = contratsDuFichier("fabrique-actions", `"use server";
import { emettre } from "@/platform/ia/artifact/factory";
export async function poser(formData: FormData): Promise<R> {
  const n = fdStr(formData, "n");
  return emettre({ n });
}`, {}, {}, { "@/platform/ia/artifact/factory": `export async function emettre(d) {
  return prisma.$transaction(async (tx) => tx.legalDocument.create({ data: d }));
}` });
    expect(c!.ecrit).toBe(true);
    expect(c!.modelesEcrits).toEqual(["legalDocument"]);
  });

  it("les modèles du délégué importé n'entrent PAS dans l'attribution des CHAMPS", () => {
    // Deux consommateurs, deux besoins : la garde veut TOUS les modèles, `lireChamps` cherche le
    // modèle PRIMAIRE et renonce à nommer dès qu'il y a ambiguïté. Les unir a fait perdre 187
    // champs modélisés au parc (546 → 359) et fait tomber le plancher de désignation.
    const avecRef = `"use server";
import { creerTruc } from "@/lib/domaine/truc";
export async function faireLeTruc(formData: FormData): Promise<ActionResult> {
  const trucId = fdStr(formData, "trucId");
  return creerTruc({ actorId: "x", nom: trucId });
}
`;
    const relations = { "Truc.id": "Truc" } as Record<string, string>;
    const c = contratsDuFichier("truc-actions", avecRef, {}, relations, { "@/lib/domaine/truc": MODULE_TRUC })[0]!;
    // Le champ garde son modèle : l'union n'a pas brouillé l'attribution.
    const champ = c.champs.find((x) => x.nom === "trucId");
    expect(champ?.type).toBe("reference");
    // Et le contrat DÉCLARE quand même l'écriture du délégué.
    expect(c.modelesEcrits).toContain("truc");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE AIDE INTERNE (`actions/internes/`) EST LE CODE DU FICHIER D'ACTIONS (`contrat/internes.ts`).
 *
 * Le même corps — qui reçoit le formulaire, lit ses champs avec un lecteur de son module, écrit et confie une
 * notification à un écrivain importé — déplacé hors du fichier `"use server"`. Hors de `actions/internes/`, la
 * dérivation ne le suit que pour ses faits d'écriture directs : les champs et l'attribution sont PERDUS. Sous
 * `actions/internes/`, l'action dit exactement ce qu'elle disait quand ce code était dans son corps.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("une aide INTERNE compte comme une fonction locale du fichier d'actions", () => {
  const action = (depuis: string) => `"use server";
import { requireUser } from "@/lib/session";
import { renommerLeTruc } from "${depuis}";

export async function renommerTruc(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  return renommerLeTruc(formData, user);
}
`;
  const MODULE_INTERNE = `import { notifyUser } from "@/lib/notify";

export function champ(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  return v ? String(v) : null;
}

export async function renommerLeTruc(formData: FormData, acteur: { id: string }) {
  const id = champ(formData, "trucId");
  const nom = champ(formData, "nom");
  if (!id || !nom) return { ok: false, error: "Champs manquants." };
  await prisma.truc.update({ where: { id }, data: { name: nom } });
  await notifyUser({ userId: acteur.id, title: "Renommé" });
  return { ok: true };
}
`;
  const NOTIFY = `
export async function notifyUser(n: { userId: string }) {
  return prisma.notification.create({ data: n });
}
`;
  const relations = { "Truc.trucId": "Truc" };
  const decrire = (depuis: string) => contratsDuFichier("truc-actions", action(depuis), {}, relations, {
    [depuis]: MODULE_INTERNE, "@/lib/notify": NOTIFY,
  })[0]!;

  it("TÉMOIN — hors de `actions/internes/`, les champs, l'attribution et l'écrivain du corps déplacé sont perdus", () => {
    const c = decrire("@/lib/domaine/truc-renommage");
    expect(c.champs).toEqual([]);
    expect(c.illisible).not.toBeNull();
    expect(c.modelesEcrits).not.toContain("notification");
  });

  it("sous `actions/internes/`, l'action lit les champs, attribue la référence et déclare les écrivains du délégué", () => {
    const c = decrire("@/lib/actions/internes/truc/renommage");
    expect(c.illisible).toBeNull();
    expect(c.champs.map((ch) => [ch.nom, ch.obligatoire, ch.modele])).toEqual([["nom", true, null], ["trucId", true, "Truc"]]);
    expect(c.ecrit).toBe(true);
    expect(c.modelesEcrits).toEqual(["notification", "truc"]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARC — la clé d'une action est un NOM déclaré, pas un chemin (rapport d'audit 08, ARCH-03).
 *
 * Une action rangée dans son module (`src/modules/<m>/actions.ts`) garde sa clé historique en se
 * déclarant dans `parc.ts`. Oubliée là, elle sortirait du contrat, de la parité et d'Adam sans
 * qu'aucun autre test ne le dise : c'est ce banc qui le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("PARC DES ACTIONS — chaque fichier d'actions a une clé, une seule", () => {
  it("tout `actions.ts` d'un module est déclaré dans `ACTIONS_DES_MODULES`", () => {
    const declares = new Set(cheminsDesActionsDesModules());
    expect(actionsDesModulesSurLeDisque().filter((c) => !declares.has(c)),
      "déclarer ce fichier dans src/lib/actions/parc.ts (ACTIONS_DES_MODULES) avec sa clé historique").toEqual([]);
  });

  it("chaque entrée de `ACTIONS_DES_MODULES` existe et commence par « use server »", () => {
    for (const chemin of cheminsDesActionsDesModules()) {
      expect(readFileSync(join(process.cwd(), chemin), "utf8"), chemin).toMatch(/^\s*["']use server["']/);
    }
  });

  it("aucune clé n'est portée par deux fichiers, sauf les morceaux d'un fichier découpé déclarés ENSEMBLE", () => {
    const decoupees = new Set(Object.entries(ACTIONS_DES_MODULES).filter(([, c]) => cheminsDeLaCle(c).length > 1).map(([cle]) => cle));
    const cles = parcDesActions().map((f) => f.cle);
    expect(cles.filter((c, i) => cles.indexOf(c) !== i && !decoupees.has(c)),
      "un module ne reprend pas la clé d'un fichier resté en place ; un fichier découpé déclare la liste de ses morceaux").toEqual([]);
    // Un morceau de `src/lib/actions/` ne peut pas porter une clé découpée : elle vit entière dans son module.
    expect(parcDesActions().filter((f) => decoupees.has(f.cle) && f.chemin.startsWith("src/lib/actions/")).map((f) => f.chemin)).toEqual([]);
  });

  it("une action n'est exportée que par UN morceau de sa clé (sinon l'aiguillage choisirait au hasard)", () => {
    const vues = new Map<string, string>();
    const doublons: string[] = [];
    for (const { cle, chemin } of parcDesActions()) {
      for (const m of readFileSync(join(process.cwd(), chemin), "utf8").matchAll(/^export async function ([A-Za-z0-9_]+)/gm)) {
        const id = `${cle}:${m[1]}`;
        if (vues.has(id)) doublons.push(`${id} — ${vues.get(id)} et ${chemin}`);
        else vues.set(id, chemin);
      }
    }
    expect(doublons).toEqual([]);
  });

  it("le scanner lit les actions des modules (le contrat ne les perd pas en route)", () => {
    const fichiers = new Set(scannerContrats().map((c) => c.fichier));
    for (const cle of Object.keys(ACTIONS_DES_MODULES)) expect(fichiers.has(cle), cle).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODELES_INTERDITS, MODELES_NON_SENSIBLES, SURFACES_HUMAINES,
  interdictionGenerique, validerEntree, enArguments, enFormulaire, chercherCapacites, motsUtiles,
} from "./generique";
import { scannerContrats } from "./contrat-scan";
import { CONTRAT_PAR_ID } from "./contrat.genere";
import type { ChampAction, ContratAction } from "./contrat";

/** Le parc RÉEL, tel que l'artefact le porte — le seul qui dise si la garde protège vraiment. */
const CONTRATS_ACTIONS: ContratAction[] = [...CONTRAT_PAR_ID.values()];

const contrat = (p: Partial<ContratAction>): ContratAction => ({
  id: "f:a", fichier: "f", fonction: "a", appel: "formulaire", champs: [],
  porte: { module: null, verbe: null, entite: null, moduleFr: null, gardes: [] },
  ecrit: true, modelesEcrits: [], audit: false, illisible: null, avantFormulaire: 0, ...p,
});

describe("CHEMIN GÉNÉRIQUE — l'auto-escalade est refusée par CONSTRUCTION", () => {
  const vivants = scannerContrats();

  it("LE DÉFAUT MESURÉ : les actions de droits sont refusées, nommément", () => {
    // Ces six-là étaient en tête de la liste des actions atteignables SEULEMENT par la
    // dérivation. Elles sont la raison d'être de ce module.
    const par = new Map(vivants.map((c) => [c.id, c]));
    for (const id of [
      "admin-actions:updateUserRole", "admin-actions:setSecondaryRole",
      "access-actions:setRowGrants", "access-actions:setUserActive",
      "access-actions:revokeSession", "admin-actions:createUser",
    ]) {
      const c = par.get(id);
      expect(c, `${id} a disparu du parc — le test doit être mis à jour, pas supprimé`).toBeDefined();
      expect(interdictionGenerique(c!), id).not.toBeNull();
    }
  });

  it("`updateUserRole` — le cas EXACT que les motifs de `policy/guard.ts` laissent passer", () => {
    // Le camel-case : aucun de `\brole\b`, `_role`, `role_` ne s'accroche au milieu du mot.
    // Ici c'est le MODÈLE ÉCRIT qui refuse, et le nom ne sert que de filet.
    const parLeModele = contrat({ fonction: "quelqueChoseDInoffensif", modelesEcrits: ["user"] });
    expect(interdictionGenerique(parLeModele)).toMatch(/compte, le rôle ou le mot de passe/);
    const parLeNom = contrat({ fonction: "updateUserRole", modelesEcrits: [] });
    expect(interdictionGenerique(parLeNom)).toMatch(/un droit ou un identifiant/);
  });

  it("le filet du NOM compare des MOTS, jamais des sous-chaînes", () => {
    /*
     * LE DÉFAUT MESURÉ : `secret` cherché n'importe où refusait `demanderPieceSecretariat` — une
     * demande de devis au bureau du SECRÉTARIAT, écriture métier ordinaire, classée « désigne un
     * droit ou un identifiant » parce qu'un mot français contient six lettres anglaises. Un
     * « je ne peux pas » écrit dans le CODE (§118.63).
     *
     * Mesuré sur le parc entier au moment de la réparation : **82 actions refusées par la
     * sous-chaîne, 81 par le mot — l'écart est EXACTEMENT ce faux positif, aucune vraie prise
     * perdue.**
     */
    expect(
      interdictionGenerique(contrat({ fonction: "demanderPieceSecretariat", modelesEcrits: ["administrativeRequest"] })),
      "« Secrétariat » n'est pas « secret »",
    ).toBeNull();
    // …et les mots français voisins du vocabulaire restent permis, dans les deux sens.
    for (const nom of ["accuserReception", "tokeniserRien"]) {
      expect(interdictionGenerique(contrat({ fonction: nom, modelesEcrits: [] })), nom).toBeNull();
    }
  });

  it("…et un COMPOSÉ du vocabulaire se lit à travers la casse — `superAdminDelete`", () => {
    /*
     * L'AUTRE MOITIÉ, sans laquelle la réparation ci-dessus aurait DÉSARMÉ la garde : le camel
     * sépare `super` et `admin`, donc aucun mot seul ne vaut `superadmin`. La première version
     * de la règle laissait passer l'action que §118.74 nomme en PREMIER — trouvé en mesurant par
     * la vraie fonction, après que ma propre sonde eut mesuré un seul des trois vocabulaires et
     * conclu sur la règle entière (§118.92).
     */
    for (const nom of ["superAdminDelete", "super_admin_reset", "setFeatureFlag", "killSwitchOn", "updateUserRole", "setRowGrants"]) {
      expect(interdictionGenerique(contrat({ fonction: nom, modelesEcrits: [] })), nom).not.toBeNull();
    }
  });

  it("SABOTAGE — retirer un modèle de la liste rouvre la porte (l'assertion peut tomber)", () => {
    // §118.17 : une assertion dont on ne sait pas nommer le cas qui la ferait tomber n'en est
    // pas une. Voici ce cas : une action qui écrit un modèle ABSENT de la liste passe.
    expect(interdictionGenerique(contrat({ fonction: "faireUnTruc", modelesEcrits: ["rowGrant"] }))).not.toBeNull();
    expect(interdictionGenerique(contrat({ fonction: "faireUnTruc", modelesEcrits: ["bdProject"] }))).toBeNull();
  });

  it("une action métier ORDINAIRE n'est pas refusée — un refus à tort coûte plus cher", () => {
    const ordinaires = vivants.filter((c) => !c.illisible && !interdictionGenerique(c));
    expect(ordinaires.length).toBeGreaterThan(450);
    const par = new Map(vivants.map((c) => [c.id, c]));
    for (const id of ["bd-project-actions:createBdProject", "admin-request-actions:createRequest"]) {
      expect(interdictionGenerique(par.get(id)!), id).toBeNull();
    }
  });

  it("EXHAUSTIVITÉ : tout modèle du schéma qui SENT le droit est classé, dans un sens ou l'autre", () => {
    // Le garde-fou s'arme sur un fait du SCHÉMA, pas sur ma mémoire : un modèle de droits
    // ajouté demain fait échouer ce test au lieu d'ouvrir une porte en silence (§118.17).
    const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    const modeles = [...schema.matchAll(/^model ([A-Za-z0-9_]+)/gm)].map((m) => m[1]!);
    const suspects = modeles.filter((m) =>
      /Access|Grant|Invite|Setting|Flag|Permission|Role/.test(m) || m === "User" || /Session$/.test(m));
    const nonClasses = suspects.filter((m) => {
      const camel = m.charAt(0).toLowerCase() + m.slice(1);
      return !(camel in MODELES_INTERDITS) && !(m in MODELES_NON_SENSIBLES);
    });
    expect(
      nonClasses,
      "Modèle du schéma qui porte identité/droit/session/réglage et n'est classé nulle part.\n"
      + "→ l'ajouter à MODELES_INTERDITS (refusé au chemin générique) ou à MODELES_NON_SENSIBLES "
      + "AVEC sa raison, dans src/lib/actions/generique.ts",
    ).toEqual([]);
    expect(suspects.length).toBeGreaterThan(10);
  });

  it("chaque exception porte une RAISON — une liste sans motif n'est pas relue", () => {
    for (const [m, raison] of Object.entries(MODELES_NON_SENSIBLES)) expect(raison.length, m).toBeGreaterThan(20);
    for (const [m, raison] of Object.entries(MODELES_INTERDITS)) expect(raison.length, m).toBeGreaterThan(10);
  });

  it("le refus NOMME le remède — jamais « je ne peux pas » tout court", () => {
    const r = interdictionGenerique(contrat({ modelesEcrits: ["userAccess"] }))!;
    expect(r).toMatch(/écran d'administration/);
    expect(r).toMatch(/refus de conception, pas une limite technique/);
  });
});

describe("CHEMIN GÉNÉRIQUE — une entrée se valide contre son contrat AVANT de partir", () => {
  const c = contrat({
    champs: [
      { nom: "titre", type: "texte", obligatoire: true, valeurs: null, modele: null },
      { nom: "statut", type: "texte", obligatoire: false, valeurs: ["OUVERT", "CLOS"], modele: null },
      { nom: "libre", type: "texte", obligatoire: false, valeurs: null, modele: null },
      { nom: "etiquette", type: "liste", obligatoire: false, valeurs: null, modele: null },
    ],
  });

  it("un champ INCONNU est refusé — l'action l'ignorerait, et « c'est fait » serait faux", () => {
    const r = validerEntree(c, { titre: "x", inexistant: "y" });
    expect(r.map((x) => x.champ)).toEqual(["inexistant"]);
    expect(r[0]!.raison).toContain("titre, statut, libre, etiquette");
  });

  it("un champ OBLIGATOIRE manquant est refusé ici, pas après un aller-retour", () => {
    expect(validerEntree(c, { statut: "OUVERT" }).map((x) => x.champ)).toEqual(["titre"]);
  });

  it("une valeur hors de l'énum DÉCLARÉ est refusée, et le refus donne les valeurs", () => {
    const r = validerEntree(c, { titre: "x", statut: "en cours" });
    expect(r[0]!.raison).toContain("OUVERT, CLOS");
  });

  it("ce dont les valeurs n'ont PAS été lues passe — une garde qui refuse l'inconnu est désarmée", () => {
    expect(validerEntree(c, { titre: "x", libre: "n'importe quoi" })).toEqual([]);
  });

  it("une action ILLISIBLE refuse tout — elle ne porte aucun champ à valider", () => {
    const mystere = contrat({ illisible: "les noms de champs sont calculés à l'exécution", champs: [] });
    expect(validerEntree(mystere, {})).toHaveLength(1);
    expect(validerEntree(mystere, {})[0]!.raison).toMatch(/calculés à l'exécution/);
  });

  it("le formulaire distingue ABSENT et VIDE, et déplie une liste", () => {
    const fd = enFormulaire({ titre: "x", vide: "", rien: null, pasla: undefined, etiquette: ["a", "b"], oui: true, non: false });
    expect(fd.get("titre")).toBe("x");
    expect(fd.get("vide")).toBe("");        // écrit : « efface »
    expect(fd.has("rien")).toBe(false);      // absent : « ne touche pas »
    expect(fd.has("pasla")).toBe(false);
    expect(fd.getAll("etiquette")).toEqual(["a", "b"]);
    expect(fd.get("oui")).toBe("on");
    expect(fd.get("non")).toBe("");
  });
});

describe("CHEMIN GÉNÉRIQUE — la découverte trouve, et dit ce qu'elle ne fera pas", () => {
  const vivants = scannerContrats();

  it("une intention en français atteint l'action, sans alias écrit à la main", () => {
    const r = chercherCapacites(vivants, "créer un projet business development");
    expect(r.map((x) => x.contrat.id)).toContain("bd-project-actions:createBdProject");
  });

  it("une capacité INTERDITE est rendue AVEC son motif, jamais tue", () => {
    // La taire ferait répondre « je ne trouve rien » là où la vérité est « je l'ai trouvée et
    // je n'y touche pas » — le « je ne peux pas » artificiel que ce dépôt a déjà payé.
    const r = chercherCapacites(vivants, "changer le rôle d'un utilisateur", 20);
    const roles = r.filter((x) => x.interdiction);
    expect(roles.length).toBeGreaterThan(0);
    expect(roles[0]!.interdiction).toMatch(/administration/);
  });

  it("une phrase sans intention ne rend RIEN — pas de faux positif qui pousse le modèle", () => {
    expect(chercherCapacites(vivants, "")).toEqual([]);
    expect(chercherCapacites(vivants, "le la les de du")).toEqual([]);
  });

  it("les mots vides sont retirés, les accents repliés", () => {
    expect(motsUtiles("Crée un dossier réglementaire pour le produit")).toEqual(
      ["cree", "dossier", "reglementaire", "produit"]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ANGLE MORT DE LA GARDE — ce que la lecture des ARGUMENTS a rendu atteignable.
 *
 * En ouvrant 40 actions à entrée typée, cinq gestes que la doctrine réserve à une main
 * humaine sont devenus descriptibles : `deciderAccordMission` et `fournirElementMission`
 * (§118.15 : accorder une autorisation et fournir une pièce sont des ATTESTATIONS — l'audit
 * portera le nom d'une personne), et les trois interrupteurs d'Adam (§118.6 : on ne désactive
 * pas un garde-fou).
 *
 * La garde sur le MODÈLE ÉCRIT ne pouvait pas les voir : toutes les cinq délèguent leur
 * écriture, donc leur corps n'écrit aucun modèle Prisma. C'est un angle mort du FAIT sur
 * lequel elle s'arme, pas une lacune de sa liste — d'où un SECOND fait, le fichier.
 *
 * Le banc part du contrat RÉEL (`contrat.genere`), pas d'un contrat fabriqué à la main : un
 * test qui s'injecte son propre cas ne dirait pas si la garde protège le parc.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("SURFACES HUMAINES — ouvrir une lecture ne doit pas ouvrir une porte", () => {
  const parId = new Map(CONTRATS_ACTIONS.map((c) => [c.id, c]));
  const parcId = (id: string) => {
    const c = parId.get(id);
    // Un identifiant devenu faux rendrait le test VERT en ne testant rien (§118.17).
    expect(c, `${id} n'existe plus dans le parc — ce banc ne prouve plus rien`).toBeTruthy();
    return c!;
  };

  for (const [id, quoi] of [
    ["mission-runtime-actions:deciderAccordMission", "accorder une autorisation"],
    ["mission-runtime-actions:fournirElementMission", "fournir une pièce"],
    ["mission-runtime-actions:approuverModeleOperationnel", "approuver un modèle"],
    ["adam-settings-actions:setAdamOutboundPaused", "l'interrupteur de sortie"],
    ["adam-settings-actions:setAdamInboundPaused", "l'interrupteur d'entrée"],
    ["adam-settings-actions:setAdamConnectionPaused", "l'interrupteur de connexion"],
  ] as [string, string][]) {
    it(`${quoi} est REFUSÉ au chemin générique (${id.split(":")[1]})`, () => {
      const c = parcId(id);
      // Le point de la démonstration : elle est DESCRIPTIBLE (donc atteignable sans la garde) et
      // AUCUN des modèles qu'elle écrit n'est interdit (donc la garde des modèles la laisse passer).
      //
      // La première version exigeait « aucun modèle écrit » : c'était vrai parce que la dérivation
      // ne VOYAIT pas les écritures d'un délégué importé par une action sans formulaire. Elle les
      // voit depuis §118.158 (`missionApproval`, `communicationPolicy`…), et aucun de ces modèles
      // n'est un droit : la démonstration tient pour sa vraie raison — c'est le FICHIER qui les
      // arrête, et rien d'autre.
      expect(c.illisible, "cette action n'est plus descriptible — le banc ne prouve plus rien").toBeNull();
      expect(
        c.modelesEcrits.filter((m) => m in MODELES_INTERDITS),
        "elle écrit un modèle interdit : la garde des modèles l'arrêterait seule, ce n'est plus le cas d'angle mort",
      ).toEqual([]);
      const refus = interdictionGenerique(c);
      expect(refus, `${id} passe la garde`).toBeTruthy();
      expect(refus, "le refus doit nommer le geste humain qui reste possible").toMatch(/Mission Control|réglages d'Adam/);
    });
  }

  it("SABOTAGE : sans le fait « fichier », les six passeraient", () => {
    // LE CAS QUI FAIT TOMBER L'ASSERTION PRÉCÉDENTE, joué : on retire la surface du contrat
    // (en la renommant) et l'on constate que plus RIEN ne les arrête — ni les modèles écrits
    // (aucun n'est un droit), ni le filet des noms (`deciderAccordMission` n'a aucun mot-clé de
    // droit). Sans ce sabotage, on ne saurait pas nommer ce qui fait tenir la garde.
    for (const id of [
      "mission-runtime-actions:deciderAccordMission",
      "adam-settings-actions:setAdamOutboundPaused",
    ]) {
      const c = parcId(id);
      expect(interdictionGenerique({ ...c, fichier: "un-autre-fichier" })).toBeNull();
    }
  });

  it("la garde ne DÉBORDE pas : le reste du parc reste ouvert", () => {
    const refusees = CONTRATS_ACTIONS.filter((c) => !c.illisible && interdictionGenerique(c));
    const parSurface = refusees.filter((c) => c.fichier in SURFACES_HUMAINES);
    // Trois surfaces : le pilotage humain des missions, les garde-fous d'Adam, et — depuis
    // §118.149 — la SIGNATURE des Finances. Le plafond monte de ces actions et d'elles seules : une
    // surface qui grossit sans décision est une garde qui déborde. 21 depuis l'audit 360° (R09) :
    // « Renvoyer à l'émetteur » est l'autre issue du même geste, par le même siège, sur la même file.
    expect(parSurface.length, "les trois surfaces comptent 21 actions au total").toBeLessThanOrEqual(21);
    // Un refus à tort coûte plus cher que le défaut qu'on corrige (§118.27) : l'immense
    // majorité du parc descriptible doit rester appelable.
    const ouvertes = CONTRATS_ACTIONS.filter((c) => !c.illisible && !interdictionGenerique(c));
    expect(ouvertes.length).toBeGreaterThan(550);
  });
});

/**
 * L'ENTRÉE TRADUITE EN ARGUMENTS — l'ordre et les TYPES, qui sont deux façons de se tromper
 * en silence.
 */
describe("enArguments — le rang et la nature, pas seulement la valeur", () => {
  const aArguments = (champs: ChampAction[]): ContratAction => ({
    id: "x:y", fichier: "x", fonction: "y", appel: "arguments", champs,
    porte: { module: null, verbe: null, entite: null, gardes: [], moduleFr: null },
    ecrit: false, modelesEcrits: [], audit: false, illisible: null, avantFormulaire: 0,
  });
  const ch = (nom: string, type: ChampAction["type"]): ChampAction =>
    ({ nom, type, obligatoire: false, valeurs: null, modele: null });

  it("un champ absent occupe SON RANG — il n'est pas omis", () => {
    // LE CAS QUI FERAIT TOMBER CETTE ASSERTION : un `filter` sur les valeurs présentes.
    // `renameDocument(id, name, path)` sans `name` renommerait alors avec le chemin.
    expect(enArguments(aArguments([ch("id", "texte"), ch("name", "texte"), ch("path", "texte")]),
      { id: "a", path: "/p" })).toEqual(["a", undefined, "/p"]);
  });

  it("un booléen reste un BOOLÉEN — « on » serait vrai même pour « non »", () => {
    const bascule = aArguments([ch("paused", "booleen")]);
    expect(enArguments(bascule, { paused: "false" })).toEqual([false]);
    expect(enArguments(bascule, { paused: "oui" })).toEqual([true]);
    expect(enArguments(bascule, { paused: true })).toEqual([true]);
  });

  it("un nombre reste un NOMBRE, une liste reste une LISTE", () => {
    expect(enArguments(aArguments([ch("year", "nombre"), ch("ids", "liste")]), { year: "2026", ids: "a" }))
      .toEqual([2026, ["a"]]);
  });
});

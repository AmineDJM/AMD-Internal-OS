import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AD_PRO_KINDS, type AdProKind } from "./unified";
import {
  REFERENTIELS_PAR_NATURE, natureDesigneMedecinsEtProduits, natureDesigneMedecins, medecinsEtProduitsFields,
  champMedecins, champProduits,
  sponsoringCreateFields, consultingCreateFields, adProOtherCreateFields,
} from "./create-fields";
import {
  AVAILABLE_PRODUCT_STATUSES, CHAMPS_MEDECINS, CHAMPS_PRODUITS, readMultiField, MULTI_SEP,
  type DoctorRow, type ProductRow,
} from "./pickers";

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « UN OU PLUSIEURS MÉDECINS ET UN OU PLUSIEURS PRODUITS » — SUR LES SIX NATURES.
 *
 * Décision de la Direction (22/09/2026) : « dans la nouvelle demande dans Ad&Pro (hors matériel
 * promotionnel), on doit pouvoir sélectionner un ou plusieurs médecins et un ou plusieurs
 * produits concernés. »
 *
 * MESURÉ AVANT D'ÉCRIRE, nature par nature : le sponsoring et l'événement les avaient ; les deux
 * prises en charge avaient les médecins (par identifiants) et AUCUN produit, alors que la colonne
 * existait des deux côtés sans lecteur ; le consulting et « autre demande » n'avaient ni l'un ni
 * l'autre. QUATRE natures sur six.
 *
 * CE QUE CE BANC TIENT, et c'est ce qui le distingue d'une liste de cas : la porte de création de
 * CHAQUE nature est déclarée dans un `Record<AdProKind, …>` — une huitième nature ne compile pas
 * tant que personne n'a dit par où elle se crée (§118.130). On ne répare donc pas quatre
 * formulaires à la main en laissant le cinquième arriver par la porte qu'on n'a pas regardée
 * (§118.58).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MEDECINS: DoctorRow[] = [
  { id: "d1", name: "Dr Amel Haddad", specialty: "Cardiologie", city: "Alger" },
  { id: "d2", name: "Dr Karim Bensalem", specialty: "Oncologie", city: "Oran" },
];
const PRODUITS: ProductRow[] = [
  // Le statut vient de la liste canonique des dossiers PROMOUVABLES : inventer
  // « TREATMENT_COMPLETED » faisait retomber le champ sur sa saisie libre, et mon banc
  // accusait le produit (§118.92 — qu'est-ce que le juge a réellement mesuré ?).
  { id: "p1", brandName: "Nivolex", dci: "Nivolumab", status: AVAILABLE_PRODUCT_STATUSES[0] },
];
const GAMMES = [{ id: "bu1", name: "Oncologie" }];
const ENTITES = [{ value: "c1", label: "Adventum" }];

/**
 * PAR OÙ CHAQUE NATURE SE CRÉE — soit une liste de champs qu'on peut lire directement, soit un
 * formulaire écrit à la main dont on lit la SOURCE.
 *
 * Les deux prises en charge et l'événement ne passent pas par `FieldDef[]` : ils ont un choix de
 * médecins par spécialité, ou un statut conditionnel, que `FieldDef` ne sait pas exprimer. Les
 * juger sur leur source n'est pas un pis-aller — c'est le seul fait disponible, et c'est un fait
 * du FICHIER (§118.17).
 */
interface PorteBase {
  /**
   * LE CHAMP QUI PORTE LES MÉDECINS, quand ce n'est pas le nom canonique.
   *
   * Les deux prises en charge envoient `invitedDoctorIds` — de vraies RÉFÉRENCES d'annuaire que
   * la fiche résout en lignes de praticiens (`queries/congress.ts`). C'est STRICTEMENT MIEUX
   * qu'un libellé joint, et les renommer pour satisfaire ce banc aurait échangé une référence
   * contre une uniformité de nom : le cliquet demande qu'on puisse CHOISIR plusieurs
   * praticiens, pas qu'un champ s'appelle `doctorIds`.
   */
  medecinsSous?: string;
}
type Porte = PorteBase & (
  | { champs: () => { name: string; required?: boolean }[] }
  | { source: string }
);

const PORTE_DE_CREATION: Record<AdProKind, Porte> = {
  SPONSORING: {
    champs: () => sponsoringCreateFields({
      products: PRODUITS, doctors: MEDECINS, businessUnits: GAMMES,
      specialties: [{ name: "Cardiologie" }], specialtiesHeritees: [],
    }),
  },
  EVENT: { source: "src/app/(app)/events/event-form.tsx" },
  // FICHES VOYAGEUR (Direction, 10/2026) : les professionnels pris en charge s'ajoutent DANS la demande ;
  // à la création, les praticiens de l'annuaire sont ceux À L'ORIGINE d'une « initiative du médecin ».
  CONGRESS_INTERNATIONAL: {
    source: "src/app/(app)/congress-international/congress-request-form.tsx",
    medecinsSous: "initiativeDoctorIds",
  },
  // Le MÊME formulaire sert les deux prises en charge (`national`) : c'est voulu, et c'est ce qui
  // garantit qu'un champ ajouté d'un côté ne manque pas de l'autre.
  CONGRESS_NATIONAL: {
    source: "src/app/(app)/congress-international/congress-request-form.tsx",
    medecinsSous: "initiativeDoctorIds",
  },
  CONSULTING: { champs: () => consultingCreateFields({ companies: ENTITES, businessUnits: GAMMES, products: PRODUITS, doctors: MEDECINS }) },
  OTHER: { champs: () => adProOtherCreateFields({ companies: ENTITES, businessUnits: GAMMES, products: PRODUITS, doctors: MEDECINS }) },
  // La demande de matériel se compose de LIGNES du catalogue (§118.171) : son formulaire est
  // dessiné à part, et c'est lui qu'on lit — les produits d'une ligne sont ceux du CATALOGUE
  // (`produitIds`), pas les produits promouvables d'une demande Ad & Pro.
  PROMO_MATERIAL: { source: "src/components/ad-pro/demande-materiel-form.tsx" },
};

/**
 * LA SOURCE SANS SES COMMENTAIRES — et c'est la moitié qui compte.
 *
 * Quatre fois dans ce dépôt, un cliquet s'est accroché à la PROSE qui le décrivait (§118.79d,
 * §118.88, §118.112b, §118.138). Ce banc cherche des noms de champ et des noms de fonction : le
 * commentaire qui explique pourquoi un champ existe les CITE forcément. On juge le code.
 */
/**
 * LES FICHIERS D'ACTION DU PÔLE qui écrivent le couple — déclarés, pas devinés.
 *
 * Cinq et non six : le MÊME fichier sert les deux prises en charge (`congress-request-actions`).
 */
const ACTIONS_DU_POLE = [
  "src/lib/actions/sponsoring-actions.ts",
  "src/lib/actions/event-actions.ts",
  "src/lib/actions/congress-request-actions.ts",
  "src/lib/actions/consulting-actions.ts",
  "src/lib/actions/ad-pro-other-actions.ts",
] as const;

function lireSource(rel: string): string {
  const p = path.join(process.cwd(), rel);
  expect(fs.existsSync(p), `porte de création introuvable : ${rel}`).toBe(true);
  return fs.readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ");
}

/** Le champ est-il offert par cette porte, sous sa forme cochée OU sous son repli texte ? */
function porteOffre(porte: Porte, champ: { coches: string; libre: string }, sous?: string): boolean {
  const attendus = sous ? [sous] : [champ.coches, champ.libre];
  if ("champs" in porte) {
    const noms = porte.champs().map((f) => f.name);
    return attendus.some((n) => noms.includes(n));
  }
  const src = lireSource(porte.source);
  // LES TROIS FAÇONS DE PRODUIRE UNE CLÉ DE FORMULAIRE, et il faut les trois : un `FieldDef` du
  // module partagé (`name: "productIds"`), un attribut de JSX (`name="doctor"`), et un ajout
  // programmatique au `FormData` (`fd.append("invitedDoctorIds", …)`) — c'est ainsi que le
  // formulaire des prises en charge envoie ses praticiens cochés. N'en connaître que deux
  // déclarerait ce formulaire dépourvu d'un champ qu'il porte.
  const motifs = attendus.flatMap((n) => [`name: "${n}"`, `name="${n}"`, `append("${n}"`, `set("${n}"`]);
  // LA QUATRIÈME FAÇON : le formulaire DÉLÈGUE au constructeur partagé, et le nom du champ vit
  // alors dans `create-fields.ts`. C'est le signal le PLUS fort — un nom qui ne peut pas
  // dériver, puisqu'un seul module le porte — mais il ne se lit pas dans le JSX. Le formulaire
  // des prises en charge rend son produit ainsi (`<MultiSelectField field={champProduit} />`).
  const delegues = sous ? [] : [...(champ === CHAMPS_MEDECINS ? ["champMedecins("] : ["champProduits("]), "medecinsEtProduitsFields("];
  return motifs.some((m) => src.includes(m)) || delegues.some((d) => src.includes(d));
}

describe("le couple médecins + produits sur les natures Ad & Pro", () => {
  it("chaque nature du registre déclare sa porte de création", () => {
    // Ce qui le ferait tomber : une huitième nature. Le typecheck l'attrape d'abord (`Record`
    // exhaustif) ; cette assertion le dit aussi quand la table et le registre divergent.
    for (const k of AD_PRO_KINDS) {
      expect(PORTE_DE_CREATION[k.kind], k.kind).toBeDefined();
      expect(REFERENTIELS_PAR_NATURE[k.kind], k.kind).toBeDefined();
    }
    expect(Object.keys(PORTE_DE_CREATION).sort()).toEqual(AD_PRO_KINDS.map((k) => k.kind).sort());
  });

  it("QUATRE natures offrent LES DEUX champs, les DEUX prises en charge les seuls médecins", () => {
    // LE DÉFAUT EXACT : mesuré à l'ouverture du lot, quatre natures sur six n'offraient pas le
    // produit — et deux n'offraient RIEN. Ce qui le ferait tomber : retirer le couple d'un des
    // quatre formulaires, ou casser le nom d'un champ (le nom est ce que l'action lit).
    const concernees = AD_PRO_KINDS.map((k) => k.kind).filter((k) => natureDesigneMedecinsEtProduits(k));
    expect(concernees.sort()).toEqual(["CONSULTING", "EVENT", "OTHER", "SPONSORING"]);
    for (const kind of concernees) {
      const porte = PORTE_DE_CREATION[kind];
      expect(porteOffre(porte, CHAMPS_MEDECINS, porte.medecinsSous), `${kind} : aucun champ médecin`).toBe(true);
      expect(porteOffre(porte, CHAMPS_PRODUITS), `${kind} : aucun champ produit`).toBe(true);
    }
    // DÉCISION DE LA DIRECTION (04/10/2026) : une prise en charge ne porte plus ni spécialité ni
    // produits promus. Les DEUX moitiés : les médecins restent offerts (les professionnels proposés),
    // le produit ne l'est PLUS — sans la seconde, un formulaire qui le remettrait passerait.
    for (const kind of ["CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL"] as const) {
      const e = REFERENTIELS_PAR_NATURE[kind];
      expect(typeof e === "object" && "medecinsSeuls" in e && e.medecinsSeuls.length > 40, `${kind} : l'exception dit POURQUOI`).toBe(true);
      expect(natureDesigneMedecins(kind), kind).toBe(true);
      const porte = PORTE_DE_CREATION[kind];
      expect(porteOffre(porte, CHAMPS_MEDECINS, porte.medecinsSous), `${kind} : aucun champ médecin`).toBe(true);
      expect(porteOffre(porte, CHAMPS_PRODUITS), `${kind} : le produit est revenu`).toBe(false);
    }
  });

  it("le matériel promotionnel n'en offre AUCUN, et son exemption porte sa raison", () => {
    // L'autre moitié de la garde : sans elle, un banc qui n'exige que la présence passerait au
    // vert sur une liste élargie « pour ne rien exclure » (§118.17).
    const exemption = REFERENTIELS_PAR_NATURE.PROMO_MATERIAL;
    expect(typeof exemption === "object" && "sans" in exemption && exemption.sans.length > 40, "l'exemption doit dire POURQUOI").toBe(true);
    expect(natureDesigneMedecinsEtProduits("PROMO_MATERIAL")).toBe(false);
    const porte = PORTE_DE_CREATION.PROMO_MATERIAL;
    expect(porteOffre(porte, CHAMPS_MEDECINS)).toBe(false);
    expect(porteOffre(porte, CHAMPS_PRODUITS)).toBe(false);
  });

  it("OBLIGATOIRE sur le sponsoring et l'événement, FACULTATIF sur le consulting et « autre »", () => {
    // « On doit POUVOIR sélectionner » n'est pas « on doit sélectionner » : exiger un praticien
    // sur un contrat de consulting réglementaire — qui n'en a aucun — serait un refus à tort,
    // plus coûteux que le défaut qu'on corrige (§118.27).
    expect(REFERENTIELS_PAR_NATURE.SPONSORING).toBe("OBLIGATOIRE");
    expect(REFERENTIELS_PAR_NATURE.EVENT).toBe("OBLIGATOIRE");
    for (const k of ["CONSULTING", "OTHER"] as const) {
      expect(REFERENTIELS_PAR_NATURE[k], k).toBe("FACULTATIF");
    }
    // Et l'exigence ARRIVE jusqu'au champ : c'est elle qui décide de `required`.
    const obligatoires = medecinsEtProduitsFields({ products: PRODUITS, doctors: MEDECINS, obligatoire: true });
    const facultatifs = medecinsEtProduitsFields({ products: PRODUITS, doctors: MEDECINS, obligatoire: false });
    expect(obligatoires.every((f) => "required" in f && f.required === true)).toBe(true);
    expect(facultatifs.every((f) => "required" in f && f.required === false)).toBe(true);
    // Le consulting et « autre » sont bien montés en FACULTATIF, pas seulement déclarés tels.
    for (const champs of [
      consultingCreateFields({ companies: ENTITES, businessUnits: GAMMES, products: PRODUITS, doctors: MEDECINS }),
      adProOtherCreateFields({ companies: ENTITES, businessUnits: GAMMES, products: PRODUITS, doctors: MEDECINS }),
    ]) {
      for (const nom of [CHAMPS_MEDECINS.coches, CHAMPS_PRODUITS.coches]) {
        const f = champs.find((c) => c.name === nom);
        expect(f && "required" in f ? f.required : "absent", nom).toBe(false);
      }
    }
    // Le sponsoring, lui, les exige.
    const sponso = sponsoringCreateFields({
      products: PRODUITS, doctors: MEDECINS, businessUnits: GAMMES,
      specialties: [{ name: "Cardiologie" }], specialtiesHeritees: [],
    });
    for (const nom of [CHAMPS_MEDECINS.coches, CHAMPS_PRODUITS.coches]) {
      const f = sponso.find((c) => c.name === nom);
      expect(f && "required" in f ? f.required : "absent", nom).toBe(true);
    }
  });

  it("référentiel VIDE : le champ existe encore, en saisie libre", () => {
    // Un menu sans option est un cul-de-sac, et une demande légitime ne doit pas attendre qu'on
    // peuple une table. Ce qui le ferait tomber : rendre `[]` quand le référentiel est vide — le
    // champ disparaîtrait et le praticien repartirait dans la description.
    const m = champMedecins({ doctors: [], obligatoire: true });
    const p = champProduits({ products: [], obligatoire: true });
    expect(m.type).toBe("text");
    expect(m.name).toBe(CHAMPS_MEDECINS.libre);
    expect(p.type).toBe("text");
    expect(p.name).toBe(CHAMPS_PRODUITS.libre);
  });

  it("UN SEUL NOM de champ, employé par les six actions qui écrivent le couple", () => {
    /*
     * LE DÉFAUT MESURÉ : le formulaire de l'événement nommait son repli `products` (le nom de SA
     * colonne) et le sponsoring `product` (le nom de LA SIENNE). Chaque action lisait la clé de
     * son propre formulaire, donc tout marchait — et la sixième aurait lu celle de la cinquième.
     *
     * POURQUOI UN CLIQUET ET NON UN LECTEUR PARTAGÉ : la première version de ce lot exportait un
     * `lireCoupleReferentiel(formData)` appelé par les six. L'artefact des contrats régénéré a
     * dit le prix — TROIS actions ont perdu leurs QUATRE champs déclarés, parce que la
     * dérivation ne suit une délégation de formulaire que dans le MÊME fichier. La garde passe
     * donc de « un seul lecteur » à « un seul NOM, vérifié chez chaque lecteur » (§118.137).
     *
     * Ce qui le ferait tomber : une septième action qui lirait `products`, `doctorId` ou
     * `doctors` — c'est-à-dire la divergence qu'on vient de fermer, par la porte suivante.
     */
    const NEAR_MISS = ["products", "doctors", "doctorId", "productId", "medecins", "produits"];
    let lecteurs = 0;
    for (const chemin of ACTIONS_DU_POLE) {
      const src = lireSource(chemin);
      const litLeCouple = src.includes(`"${CHAMPS_MEDECINS.coches}"`) || src.includes(`"${CHAMPS_PRODUITS.coches}"`);
      if (!litLeCouple) continue;
      lecteurs += 1;
      // Les DEUX formes du nom canonique — la liste cochée ET son repli.
      for (const n of [CHAMPS_MEDECINS.coches, CHAMPS_PRODUITS.coches, CHAMPS_MEDECINS.libre, CHAMPS_PRODUITS.libre]) {
        // Le congrès ne lit que la moitié PRODUITS : ses médecins ont leur propre mécanisme par
        // identifiants. On n'exige donc que ce que le fichier prétend lire.
        if (!src.includes(`"${n}"`) && (n === CHAMPS_MEDECINS.coches || n === CHAMPS_MEDECINS.libre)) continue;
        expect(src.includes(`"${n}"`), `${chemin} : « ${n} » attendu`).toBe(true);
      }
      // AUCUNE clé approchante employée comme clé de FORMULAIRE.
      for (const mauvais of NEAR_MISS) {
        for (const forme of [`formData, "${mauvais}"`, `getAll("${mauvais}")`, `formData.get("${mauvais}")`]) {
          expect(src.includes(forme), `${chemin} : clé de formulaire « ${mauvais} » interdite`).toBe(false);
        }
      }
    }
    // LA PRÉMISSE : sans elle, zéro lecteur trouvé rendrait la boucle vide, donc le cas vrai
    // pour la mauvaise raison (§118.117).
    // QUATRE et non cinq : le fichier des prises en charge ne lit plus le produit (04/10/2026), et
    // ses médecins ont leur propre champ (`invitedDoctorIds`).
    expect(lecteurs, "les quatre fichiers d'action du pôle qui lisent le couple").toBe(4);
  });

  it("LE MÉDECIN HORS ANNUAIRE : chaque lecture des médecins cochés lit AUSSI la saisie « non présent »", () => {
    /*
     * §118.175 — « si le médecin n'est pas présent dans l'annuaire, on coche « non présent » et on
     * l'écrit manuellement ». Le formulaire envoie ces noms sous `doctorHorsAnnuaire` ; une action
     * qui lirait `doctorIds` sans eux les JETTERAIT — le formulaire accepterait la saisie, la
     * demande partirait, et le praticien disparaîtrait sans un mot.
     *
     * Ce qui le ferait tomber : une lecture `readMultiField(formData.getAll("doctorIds"), …)`
     * laissée telle quelle, ou une septième lecture qui oublierait la saisie. La règle est donc
     * vérifiée LECTURE PAR LECTURE, pas fichier par fichier : un fichier qui lit la saisie une
     * fois pourrait l'oublier à sa lecture suivante (`event-actions.ts` en a trois).
     */
    let lectures = 0;
    for (const chemin of ACTIONS_DU_POLE) {
      const src = lireSource(chemin);
      const cle = `getAll("${CHAMPS_MEDECINS.coches}")`;
      for (let i = src.indexOf(cle); i >= 0; i = src.indexOf(cle, i + 1)) {
        lectures += 1;
        const avant = src.slice(Math.max(0, i - 60), i);
        const apres = src.slice(i, i + 160);
        expect(avant.includes("lireMedecinsDemande("), `${chemin} : « ${CHAMPS_MEDECINS.coches} » lu hors de lireMedecinsDemande`).toBe(true);
        expect(apres.includes(`"${CHAMPS_MEDECINS.horsAnnuaire}"`), `${chemin} : la saisie « ${CHAMPS_MEDECINS.horsAnnuaire} » n'est pas lue avec les médecins cochés`).toBe(true);
      }
    }
    // LA PRÉMISSE — un plancher, pas un compte : sponsoring (1), événement (3 : la garde des
    // champs manquants, la création, la modification), consulting (1), « autre » (1). Sans elle,
    // une boucle vide rendrait le cas vrai pour la mauvaise raison (§118.117).
    expect(lectures, "lectures des médecins cochés dans les actions du pôle").toBeGreaterThanOrEqual(6);

    // ET LE CHAMP EST OFFERT là où les médecins se cochent : par le constructeur partagé (sponsoring,
    // consulting, « autre ») et par le formulaire écrit à la main de l'événement. Une action qui
    // lit un champ que personne n'envoie ne protège de rien (§118.50).
    const medecins = champMedecins({ doctors: MEDECINS, obligatoire: true });
    expect(medecins.type === "multiselect" && medecins.horsListe?.name, "champMedecins : aucune saisie « non présent »")
      .toBe(CHAMPS_MEDECINS.horsAnnuaire);
    expect(lireSource("src/app/(app)/events/event-form.tsx").includes("name: CHAMPS_MEDECINS.horsAnnuaire"), "formulaire de l'événement")
      .toBe(true);
  });

  it("la lecture d'un couple : la liste cochée l'emporte, le repli passe seul", () => {
    // `readMultiField` est le SEUL joint du dépôt : deux découpes à la main finiraient par
    // diverger sur le séparateur.
    expect(readMultiField(["Dr Amel Haddad", "Dr Karim Bensalem"], "saisi à la main"))
      .toBe(`Dr Amel Haddad${MULTI_SEP}Dr Karim Bensalem`);
    // …et la saisie libre passe telle quelle quand rien n'est coché : refuser une valeur qu'on
    // n'a pas su proposer, c'est bloquer la demande pour un défaut de référentiel.
    expect(readMultiField([], "Nivolex 40 mg")).toBe("Nivolex 40 mg");
    // Rien du tout ⇒ `null`, et non une chaîne vide : la colonne reste VIDE, pas « renseignée ».
    expect(readMultiField([], "")).toBeNull();
  });
});

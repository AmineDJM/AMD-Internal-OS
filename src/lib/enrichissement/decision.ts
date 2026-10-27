/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MOTEUR DE DÉCISION — ce que devient un fait extrait (refonte des données, §3-E étapes 4-6).
 *
 * Module pur : aucune base, aucun modèle, aucune horloge. Il reçoit un fait, la nature de la pièce
 * et les valeurs déjà connues de la fiche, et dit quoi faire — avec sa raison, en français.
 *
 * Décisions de la Direction appliquées ici :
 *   - aucun identifiant ni donnée sensible confirmé d'office ;
 *   - une donnée sensible va au coffre, jamais dans une fiche en clair ;
 *   - adresse / téléphone / e-mail / site confirmables d'office si confiance ≥ 0,9, lus sur une
 *     pièce OFFICIELLE pour cet attribut, et sans conflit ;
 *   - deux fiches ne sont jamais fusionnées d'office : `resoudreSujet` ne rattache que sur un
 *     identifiant fort identique, jamais sur le seul nom.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { ATTRIBUT_PAR_CLE, type Attribut, type DecisionFait, type FaitExtrait, type NaturePiece, type RoleSujet, type TypeSujet } from "./types";

/** Seuil de confiance en dessous duquel rien n'est confirmé d'office. */
export const SEUIL_CONFIRMATION_D_OFFICE = 0.9;

/**
 * Ce qu'une nature de pièce atteste : pour quels attributs, et pour quel sujet de la pièce.
 * Le rôle compte : une facture fait foi des coordonnées de son ÉMETTEUR (il les déclare sur une
 * pièce comptable réglementée), pas de celles du destinataire qu'il a recopiées.
 */
export interface FoiDePiece {
  roles: readonly RoleSujet[];
  attributs: readonly string[];
}

const IDENTITE_CIVILE = ["personne.nom", "personne.prenoms", "personne.naissance", "personne.lieuNaissance", "personne.sexe", "personne.nationalite"] as const;
const COORDONNEES_EMETTEUR = ["organisation.raisonSociale", "organisation.formeJuridique", "organisation.adresse", "organisation.telephone", "organisation.email", "organisation.siteWeb"] as const;
const MENTIONS_FISCALES = ["organisation.nif", "organisation.nis", "organisation.rc", "organisation.ai"] as const;

/**
 * LES PIÈCES QUI FONT FOI — table fermée : une nature absente ne fait foi de rien.
 *
 * Une pièce « fait foi » d'un attribut quand celui qui l'émet est l'autorité de cette valeur
 * (l'État pour l'état civil, le CNRC pour le registre, la DGI pour le NIF, la banque pour le RIB,
 * l'employeur pour la paie) ou quand la loi oblige l'émetteur à y déclarer sa propre valeur
 * (mentions obligatoires d'une facture). Faire foi n'est PAS confirmer : un identifiant ou une
 * donnée sensible reste « à confirmer » ou va au coffre, quelle que soit la pièce.
 *
 * Volontairement ABSENTES (déclaratif, recopié ou non réglementé) :
 *   - CARTE_VISITE, CV : ce que la personne dit d'elle-même, imprimé sans contrôle ;
 *   - DEVIS, BON_DE_COMMANDE, BON_LIVRAISON : pièces commerciales sans mentions imposées comme la
 *     facture — leurs faits restent proposés, à confirmer ;
 *   - BILLET_TRANSPORT, RESERVATION_HOTEL, INVITATION, PROGRAMME_CONGRES : saisies par un tiers
 *     (agence, organisateur), souvent approximatives ;
 *   - ATTESTATION, COURRIER, PROCES_VERBAL, AUTRE : contenu trop hétérogène pour une règle sûre.
 */
export const NATURES_OFFICIELLES: Readonly<Partial<Record<NaturePiece, FoiDePiece>>> = {
  // Pièces d'identité délivrées par l'État : l'état civil du titulaire et le numéro de la pièce.
  PASSEPORT: { roles: ["TITULAIRE"], attributs: [...IDENTITE_CIVILE, "personne.passeport.numero", "personne.passeport.expiration"] },
  CNI: { roles: ["TITULAIRE"], attributs: [...IDENTITE_CIVILE, "personne.cni.numero", "personne.nin"] },
  // Le permis ne porte ni le sexe ni la nationalité de façon fiable : état civil restreint.
  PERMIS_CONDUIRE: { roles: ["TITULAIRE"], attributs: ["personne.nom", "personne.prenoms", "personne.naissance", "personne.lieuNaissance"] },
  // Le visa est émis sur le passeport : il en reprend l'état civil et le numéro, vérifiés par le consulat.
  VISA: { roles: ["TITULAIRE"], attributs: ["personne.nom", "personne.prenoms", "personne.naissance", "personne.sexe", "personne.nationalite", "personne.passeport.numero"] },

  // Extrait du registre du commerce (CNRC) : l'identité légale de la société, son siège, son gérant,
  // et les identifiants qu'il porte (le RC, le NIF reporté sur l'extrait électronique).
  REGISTRE_COMMERCE: {
    roles: ["TITULAIRE"],
    attributs: ["organisation.raisonSociale", "organisation.nomCommercial", "organisation.formeJuridique", "organisation.capital", "organisation.rc", "organisation.nif", "organisation.adresse", "organisation.representant"],
  },
  // Attestation et carte d'immatriculation fiscale (DGI) : le NIF, et l'identité fiscale qui l'accompagne.
  ATTESTATION_NIF: { roles: ["TITULAIRE"], attributs: ["organisation.nif", "organisation.raisonSociale", "organisation.adresse"] },
  CARTE_IMMATRICULATION_FISCALE: { roles: ["TITULAIRE"], attributs: ["organisation.nif", "organisation.raisonSociale", "organisation.adresse"] },

  // Facture et avoir : pièces comptables dont les mentions sont imposées (NIF, NIS, RC, AI, adresse
  // du vendeur) — l'émetteur y engage sa propre identité. Rien sur le destinataire.
  FACTURE: { roles: ["EMETTEUR"], attributs: [...COORDONNEES_EMETTEUR, ...MENTIONS_FISCALES] },
  AVOIR: { roles: ["EMETTEUR"], attributs: [...COORDONNEES_EMETTEUR, ...MENTIONS_FISCALES] },

  // Contrat et convention signés : chaque partie y déclare son identité légale et son domicile, sous sa signature.
  CONTRAT: {
    roles: ["PARTIE", "SIGNATAIRE"],
    attributs: ["organisation.raisonSociale", "organisation.formeJuridique", "organisation.capital", "organisation.adresse", "organisation.representant", ...MENTIONS_FISCALES, "personne.adresse"],
  },
  CONVENTION: {
    roles: ["PARTIE", "SIGNATAIRE"],
    attributs: ["organisation.raisonSociale", "organisation.formeJuridique", "organisation.adresse", "organisation.representant", ...MENTIONS_FISCALES, "personne.adresse"],
  },

  // RIB : la banque atteste le compte et l'établissement qui le tient.
  RIB: { roles: ["TITULAIRE"], attributs: ["personne.rib", "organisation.rib", "organisation.banque"] },
  // Bulletin de paie : l'employeur atteste la rémunération et la fonction du salarié.
  BULLETIN_PAIE: { roles: ["TITULAIRE"], attributs: ["personne.salaire", "personne.fonction"] },
  // Diplôme : l'établissement atteste le diplôme et la spécialité — pas l'état civil, recopié.
  DIPLOME: { roles: ["TITULAIRE"], attributs: ["personne.diplome", "personne.specialite"] },
};

/** La pièce `nature` fait-elle foi de `attribut` pour le sujet qui y tient le rôle `role` ? */
export function faitFoi(nature: NaturePiece, attribut: string, role: RoleSujet): boolean {
  const foi = NATURES_OFFICIELLES[nature];
  return !!foi && foi.roles.includes(role) && foi.attributs.includes(attribut);
}

export interface ValeurActuelle {
  valeurNormalisee: string;
  /** D'où vient la valeur (« saisie », « piece:… ») — repris dans la raison d'un conflit. */
  source: string;
  /** Null : proposée, pas encore confirmée. */
  confirmeLe: Date | string | null;
}

export interface ContexteDecision {
  nature: NaturePiece;
  attribut: Attribut;
  valeursActuelles: readonly ValeurActuelle[];
}

const memeValeur = (a: string, b: string) => a.trim() === b.trim();
const horodatage = (v: ValeurActuelle) => (v.confirmeLe == null ? 0 : new Date(v.confirmeLe).getTime() || 0);

/** Décide du sort d'UN fait. Chaque règle est testée dans l'ordre ; la première qui s'applique tranche. */
export function deciderFait(fait: FaitExtrait, contexte: ContexteDecision): DecisionFait {
  const { nature, attribut } = contexte;
  const nom = `« ${attribut.libelle} »`;

  if (fait.attribut !== attribut.cle) {
    return { decision: "IGNORER", raison: `Le fait porte sur « ${fait.attribut} », pas sur ${nom} : contexte incohérent.` };
  }
  if (fait.sujetType !== attribut.sujet) {
    return { decision: "IGNORER", raison: `${nom} concerne un sujet ${attribut.sujet}, le fait un sujet ${fait.sujetType}.` };
  }

  // 1. Sensible : le coffre, avant toute comparaison (la fiche n'en a de toute façon pas la valeur en clair).
  if (attribut.sensible || fait.sensible) {
    return { decision: "COFFRE", raison: `${nom} est une donnée sensible : elle va au coffre, jamais dans la fiche en clair.` };
  }

  const valeur = fait.valeurNormalisee.trim();
  if (!valeur) return { decision: "IGNORER", raison: `${nom} : aucune valeur lisible.` };

  const confirmees = contexte.valeursActuelles.filter((v) => v.confirmeLe != null && v.valeurNormalisee.trim() !== "");
  const enAttente = contexte.valeursActuelles.filter((v) => v.confirmeLe == null && v.valeurNormalisee.trim() !== "");

  // 2. Déjà su.
  if (confirmees.some((v) => memeValeur(v.valeurNormalisee, valeur))) {
    return { decision: "IGNORER", raison: `${nom} : cette valeur est déjà confirmée sur la fiche.` };
  }

  // La valeur confirmée la plus récente — celle qu'un fait contraire contredit.
  const actuelle = [...confirmees].sort((x, y) => horodatage(y) - horodatage(x))[0];
  const conflit = (): DecisionFait => ({
    decision: "CONFLIT",
    raison: `${nom} lu « ${fait.valeur} » diffère de la valeur confirmée (source : ${actuelle.source}) : rien n'est écrasé, à trancher.`,
    valeurActuelle: actuelle.valeurNormalisee,
  });

  // 3. Identifiant : jamais d'office.
  if (attribut.identifiant) {
    if (actuelle) return conflit();
    return { decision: "A_CONFIRMER", raison: `${nom} est un identifiant : il n'est jamais confirmé d'office.` };
  }

  const officielle = faitFoi(nature, attribut.cle, fait.role);
  const confianceSuffisante = Number.isFinite(fait.confiance) && fait.confiance >= SEUIL_CONFIRMATION_D_OFFICE;
  const pourquoiPas = (): string[] => {
    const manques: string[] = [];
    if (!attribut.autoConfirmable) manques.push("l'attribut n'est pas confirmable d'office");
    if (!officielle) manques.push(`une pièce ${nature} ne fait pas foi de cet attribut pour le rôle ${fait.role}`);
    if (!confianceSuffisante) manques.push(`confiance ${fmt(fait.confiance)} < ${fmt(SEUIL_CONFIRMATION_D_OFFICE)}`);
    return manques;
  };
  const versFile = (prefixe: string): DecisionFait => ({ decision: "A_CONFIRMER", raison: `${prefixe}${pourquoiPas().join(" ; ")}.` });

  // 4. Attribut multiple : une valeur de plus, jamais un conflit.
  if (attribut.multiple) {
    if (attribut.autoConfirmable && officielle && confianceSuffisante) {
      return { decision: "CONFIRMER_D_OFFICE", raison: `${nom} : nouvelle valeur ajoutée, lue sur une pièce ${nature} qui en fait foi, confiance ${fmt(fait.confiance)}.` };
    }
    return versFile(`${nom} : nouvelle valeur à ajouter — `);
  }

  // 5. Attribut unique qui contredit la fiche.
  if (actuelle) return conflit();

  // 6. Une autre valeur, différente, attend déjà d'être confirmée : on ne tranche pas à la place de l'humain.
  const concurrente = enAttente.find((v) => !memeValeur(v.valeurNormalisee, valeur));
  if (concurrente) {
    return { decision: "A_CONFIRMER", raison: `${nom} : une autre valeur (source : ${concurrente.source}) attend déjà d'être confirmée — pas de confirmation d'office.` };
  }

  // 7. Toutes les conditions de la Direction réunies.
  if (attribut.autoConfirmable && officielle && confianceSuffisante) {
    return { decision: "CONFIRMER_D_OFFICE", raison: `${nom} lu sur une pièce ${nature} qui en fait foi, confiance ${fmt(fait.confiance)}, sans conflit.` };
  }

  // 8. Sinon : la file « À confirmer », avec ce qui a manqué.
  return versFile(`${nom} : à confirmer — `);
}

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : "illisible");

// ─────────────────────────────────────────────────────────────────────────────────────────────
// RÉSOLUTION DU SUJET — à quelle fiche existante rattacher les faits d'un `sujetRef` ?
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Une fiche existante candidate, telle que l'appelant la connaît. */
export interface CandidatFiche {
  id: string;
  type: TypeSujet;
  /** Nom affiché (« Dr Karim Benali », « Imprimerie du Centre SARL »). */
  libelle: string;
  /**
   * Identifiants forts connus. Pour un identifiant SENSIBLE (passeport, CNI, NIN), seule
   * l'`empreinte` (HMAC du coffre) est fournie, jamais la valeur.
   */
  identifiants: readonly { attribut: string; valeurNormalisee?: string; empreinte?: string }[];
}

export interface OptionsResolution {
  /** Empreinte d'une valeur sensible, calculée par l'appelant avec la clé du coffre. Sans elle, les identifiants sensibles ne servent pas. */
  empreinte?: (attribut: string, valeurNormalisee: string) => string;
}

export type ResolutionSujet =
  | { resultat: "RATTACHER"; ficheId: string; identifiants: string[]; raison: string }
  | { resultat: "NOUVELLE_FICHE"; raison: string }
  | { resultat: "AMBIGU"; candidats: { id: string; libelle: string; motif: string }[]; raison: string };

const MOTS_VIDES = new Set([
  "dr", "pr", "m", "mme", "mlle", "mr", "docteur", "professeur",
  "sarl", "spa", "eurl", "snc", "sas", "sa", "ets", "etablissement", "etablissements", "ste", "societe", "groupe",
  "de", "du", "des", "la", "le", "les", "et", "d", "l",
]);

/** Les mots significatifs d'un nom : sans accents, sans casse, sans titres ni formes juridiques. */
export function motsDuNom(nom: string): string[] {
  return nom
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((m) => m && !MOTS_VIDES.has(m));
}

/** Homonymie prudente : tous les mots du nom le plus court figurent dans l'autre. */
function homonymes(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const [court, long] = a.length <= b.length ? [a, new Set(b)] : [b, new Set(a)];
  return court.every((m) => long.has(m));
}

function nomDuSujet(faits: readonly FaitExtrait[]): string[] {
  const valeurs = (cle: string) => faits.filter((f) => f.attribut === cle).map((f) => f.valeur);
  const noms = [...valeurs("personne.prenoms"), ...valeurs("personne.nom")];
  if (noms.length) return motsDuNom(noms.join(" "));
  const raison = valeurs("organisation.raisonSociale")[0] ?? valeurs("organisation.nomCommercial")[0] ?? "";
  return motsDuNom(raison);
}

/**
 * Rattache les faits d'UN sujet de la pièce à une fiche existante.
 *   - un identifiant fort identique (NIF, NIS, RC, AI, n° de passeport / CNI, NIN) et aucun qui
 *     contredit → RATTACHER ;
 *   - plusieurs fiches désignées, ou un identifiant qui contredit → AMBIGU (jamais de fusion d'office) ;
 *   - aucun identifiant commun : des homonymes non démentis → AMBIGU, sinon NOUVELLE_FICHE.
 * Le nom seul ne rattache JAMAIS.
 */
export function resoudreSujet(faitsDuSujet: readonly FaitExtrait[], candidats: readonly CandidatFiche[], options: OptionsResolution = {}): ResolutionSujet {
  if (!faitsDuSujet.length) throw new Error("resoudreSujet : aucun fait.");
  const { sujetRef, sujetType } = faitsDuSujet[0];
  if (faitsDuSujet.some((f) => f.sujetRef !== sujetRef || f.sujetType !== sujetType)) {
    throw new Error("resoudreSujet : les faits doivent porter sur un seul sujet (même sujetRef et sujetType).");
  }

  // Les identifiants forts lus, sous la forme comparable aux fiches : valeur, ou empreinte si sensible.
  const lus: { attribut: string; libelle: string; cle: string; sensible: boolean }[] = [];
  let sensiblesSansEmpreinte = false;
  for (const f of faitsDuSujet) {
    const attr = ATTRIBUT_PAR_CLE.get(f.attribut);
    if (!attr?.identifiant || !f.valeurNormalisee.trim()) continue;
    const sensible = attr.sensible || f.sensible;
    if (sensible && !options.empreinte) { sensiblesSansEmpreinte = true; continue; }
    const cle = sensible ? options.empreinte!(f.attribut, f.valeurNormalisee.trim()) : f.valeurNormalisee.trim();
    if (!lus.some((l) => l.attribut === f.attribut && l.cle === cle)) lus.push({ attribut: f.attribut, libelle: attr.libelle, cle, sensible });
  }

  const duType = candidats.filter((c) => c.type === sujetType);
  const valeurDe = (c: CandidatFiche, attribut: string, sensible: boolean) =>
    c.identifiants.filter((i) => i.attribut === attribut).map((i) => (sensible ? i.empreinte : i.valeurNormalisee)?.trim()).filter((v): v is string => !!v);

  const analyse = duType.map((c) => {
    const communs: string[] = [];
    const contraires: string[] = [];
    for (const l of lus) {
      const connues = valeurDe(c, l.attribut, l.sensible);
      if (!connues.length) continue;
      if (connues.includes(l.cle)) communs.push(l.libelle);
      else contraires.push(l.libelle);
    }
    return { c, communs, contraires };
  });

  const designes = analyse.filter((x) => x.communs.length);
  const note = sensiblesSansEmpreinte ? " (identifiant sensible ignoré : aucune empreinte fournie)" : "";

  if (designes.length === 1 && !designes[0].contraires.length) {
    const { c, communs } = designes[0];
    return { resultat: "RATTACHER", ficheId: c.id, identifiants: communs, raison: `Même ${communs.join(", ")} que la fiche « ${c.libelle} ».` };
  }
  if (designes.length) {
    return {
      resultat: "AMBIGU",
      candidats: designes.map(({ c, communs, contraires }) => ({
        id: c.id,
        libelle: c.libelle,
        motif: `même ${communs.join(", ")}` + (contraires.length ? ` mais ${contraires.join(", ")} différent` : ""),
      })),
      raison: designes.length > 1
        ? "Les identifiants lus désignent plusieurs fiches : doublon possible, la fusion se décide à la main."
        : "Un identifiant concorde mais un autre contredit la fiche : à vérifier à la main.",
    };
  }

  // Aucun identifiant commun : on cherche des homonymes, sans jamais rattacher sur le nom.
  const nom = nomDuSujet(faitsDuSujet);
  const proches = analyse.filter((x) => !x.contraires.length && homonymes(nom, motsDuNom(x.c.libelle)));
  if (proches.length) {
    return {
      resultat: "AMBIGU",
      candidats: proches.map(({ c }) => ({ id: c.id, libelle: c.libelle, motif: "nom semblable, aucun identifiant commun" })),
      raison: `Aucun identifiant commun ; des fiches portent un nom semblable — le nom seul ne suffit pas à rattacher${note}.`,
    };
  }
  return {
    resultat: "NOUVELLE_FICHE",
    raison: (lus.length ? "Aucune fiche ne porte ces identifiants" : "Aucun identifiant fort lu et aucune fiche de nom semblable") + ` : nouvelle fiche à proposer${note}.`,
  };
}

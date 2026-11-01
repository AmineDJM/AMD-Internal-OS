import type { FamilleIa } from "./familles";
import { motsDuCode, verbeDuCode } from "./lexique";
import type { Annulation, ContratLu, NatureGesteLue, Risque, Simulable, VerdictLu } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLASSEMENT D'UNE ACTION (lot J6, décision 0020) — dérivé de son contrat, jamais déclaré à côté.
 *
 * Pur, zéro import hors du dossier. Chaque règle lit un FAIT du contrat (`contrat.genere.json`, lu sur la source
 * de l'action) : les modèles qu'elle écrit, le fichier où elle vit, les mots de son nom, ses champs. Une action
 * ajoutée demain est classée par les mêmes règles sans que personne y pense — et `classement.genere.json` (le
 * cliché revu) fait échouer `registre.test.ts` tant que son classement n'a pas été relu.
 *
 * ── L'ORDRE EST LA DOCTRINE ──────────────────────────────────────────────────────────────
 *
 * Le niveau le plus FORT qui s'applique gagne : une action qui supprime ET prévient est R4 (suppression), pas R2.
 * Dans le doute on monte : un niveau trop haut coûte une ressaisie, un niveau trop bas une écriture qu'on n'a pas
 * regardée. Une action qui n'écrit rien de visible sans porter un verbe de LECTURE n'est pas lue comme une lecture
 * (`microsoft-mail:setMessageRead` n'écrit pas en base, et change pourtant la boîte de la personne) : R1.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const mots = (c: ContratLu): string[] => motsDuCode(c.fonction);
const aMot = (c: ContratLu, liste: ReadonlySet<string>): boolean => mots(c).some((m) => liste.has(m));

/** Les verbes d'une lecture — le PREMIER mot du nom. */
const LECTURE = new Set([
  "get", "list", "lister", "lire", "read", "search", "chercher", "apercu", "preview", "previsualiser", "verifier", "check",
  "compter", "catalogue", "bilan", "origine", "browse", "linkable", "askable", "analyze", "imprimer", "ouvrir", "fiche",
  "conseiller", "proposer", "reference", "relire", "comparer",
]);
/** Les noms qui finissent comme une lecture (`careDirectoryOptions`, `smartMailStatus`, `searchMarketProducts`). */
const FIN_LECTURE = /(Options|Status|Suggestions|Candidates|Refs|Versions|Shares|Comments|Kpis|Duplicate|Products)$/;

/** Les modèles d'ARGENT : l'écrire, c'est engager ou bouger de l'argent. */
const MODELE_ARGENT = /^(expenseOrder|financeTransaction|payment|payroll|pettyCash|treasury|salary|bankAccount|caisse|reglement|avance|advance|invoice|avoir|ecritureComptable|departmentBudgetExpense)/;
const VERBES_ARGENT = new Set(["pay", "payer", "regler", "settle", "paid", "rembourser", "virement", "encaisser", "decaisser", "recharge", "top", "emettre"]);
/** Supprimer — ce qui retire une fiche ou des fichiers (« retirer » d'une liste reste un geste réversible). */
const VERBES_SUPPRESSION = new Set(["delete", "supprimer", "purge", "purger", "destroy", "effacer", "trash", "permanently"]);
/** Signer, attester, décider, valider : l'audit portera le nom d'une personne. */
const VERBES_DECISION = new Set([
  "sign", "signer", "signature", "approve", "approuver", "validate", "valider", "decide", "decider", "trancher", "statuer",
  "visa", "attest", "accept", "accepter", "reject", "rejeter", "refuse", "refuser", "voter", "approval", "grant",
  "delegate", "delegue", "autoriser", "derogation", "lever", "accord", "accords",
]);
/** Un effet EXTERNE : il sort de la base (courrier, Microsoft, site public, fournisseur, agence). */
const FICHIER_EXTERNE = /(^|-)(mail|microsoft|smart|site|diffusion|supplier|candidatures|reservation-fiche|recrutement-diffusion|google|onlyoffice)(-|$)/;
const VERBES_DIFFUSION = new Set(["publish", "publier", "broadcast", "diffuser", "resend", "email"]);
const VERBES_NOTIFICATION = new Set(["notify", "notifier", "relance", "relancer", "remind", "nudge", "invite", "prevenir", "rappeler", "send", "envoyer", "escalader"]);

export interface RisqueLu { risque: Risque; raison: string }

/** LE NIVEAU DE RISQUE d'une action, et la règle qui l'a donné. */
export function risqueDe(c: ContratLu): RisqueLu {
  const verbe = verbeDuCode(c.fonction) ?? mots(c)[0] ?? "";
  const ecrits = c.modelesEcrits;
  if (ecrits.some((m) => MODELE_ARGENT.test(m)) || aMot(c, VERBES_ARGENT)) {
    return { risque: "R4", raison: "argent : elle écrit une dépense, un paiement, une caisse ou une paie" };
  }
  if (aMot(c, VERBES_SUPPRESSION) || ecrits.includes("deletedRecord")) {
    return { risque: "R4", raison: "suppression : une fiche ou un fichier disparaît" };
  }
  if (ecrits.some((m) => /^(user|userSession)$/.test(m))) {
    return { risque: "R4", raison: "le compte d'une personne suit le geste (fermé avec sa fiche, rattaché à son département)" };
  }
  if (aMot(c, VERBES_DECISION) || ecrits.some((m) => /(Visa|Approval|Decision|Signature|Grant)$/i.test(m))) {
    return { risque: "R4", raison: "décision ou signature : l'audit portera le nom de la personne" };
  }
  if (FICHIER_EXTERNE.test(c.fichier) && (c.ecrit || !LECTURE.has(verbe))) {
    return { risque: "R3", raison: "effet externe : courrier, boîte Microsoft, site public, fournisseur ou agence" };
  }
  if (aMot(c, VERBES_DIFFUSION)) return { risque: "R3", raison: "diffusion : ce qui est publié a été lu" };
  if (!c.ecrit && (LECTURE.has(verbe) || FIN_LECTURE.test(c.fonction))) return { risque: "R0", raison: "lecture : rien n'est écrit" };
  if (!c.ecrit) return { risque: "R1", raison: "aucune écriture lue dans la source, mais un verbe de geste : prudence, une carte" };
  if (ecrits.includes("notification") || aMot(c, VERBES_NOTIFICATION)) {
    return { risque: "R2", raison: "écriture interne qui prévient quelqu'un (notification)" };
  }
  return { risque: "R1", raison: "écriture interne réversible" };
}

/**
 * LES FAMILLES DE LA CONSOLE qu'exige une action : la famille de son métier (lue sur son fichier, son module, ses
 * modèles), puis « Écritures métier » pour tout geste. L'ORDRE des règles est celui de la sensibilité : la paie avant
 * les fiches, les contrats RH avant les fiches.
 */
const REGLES_FAMILLE: readonly { famille: FamilleIa; fichier: RegExp; modele?: RegExp }[] = [
  { famille: "SALAIRES", fichier: /(payroll|paie|salaire|salary)/, modele: /^(payroll|salary|payslip)/ },
  { famille: "CONTRATS_RH", fichier: /(hr-document|contrat-rh)/, modele: /^(employeeDocument|hrContract|amendment)/ },
  { famille: "FICHES", fichier: /^(hr|rh|employee|leave|conge|my-team|training|onboarding|recruitment|recrutement|candidatures|offres-emploi|coaching|org-actions|department-actions|interim)/ },
  { famille: "BUDGETS", fichier: /(budget|finance|expense|invoice|payment|petty|treasury|doublons-factures|repartition-couts|actualisation-soldes|caisse|reglement|relance-paiement|consommation|purchase)/ },
  { famille: "REGLEMENTAIRE", fichier: /(regulatory|pharmacovigilance|^dossier|produit-canonique|ctd)/ },
  { famille: "AD_PRO", fichier: /(ad-pro|^care|congress|sponsoring|^event|^promo|integration-adpro|rapprochement-adpro|^workflow|^validation|secretariat-devis|reservation-fiche|porte-dg|fabrique|^mission-actions|bc-)/ },
  { famille: "DRIVE", fichier: /(drive|^document|partage|bibliotheque|knowledge|letterhead)/ },
];

export function famillesDeLAction(c: ContratLu, ecriture: boolean): FamilleIa[] {
  const regle = REGLES_FAMILLE.find((r) => r.fichier.test(c.fichier) || (r.modele && c.modelesEcrits.some((m) => r.modele!.test(m))));
  const out: FamilleIa[] = regle ? [regle.famille] : [];
  if (ecriture) out.push("ECRITURES");
  return out;
}

/** Un champ de RÉMUNÉRATION : la carte qui le porte exige aussi « Salaires & paie » (jugé sur l'entrée, pas sur l'action). */
export const CHAMP_SALAIRE = /^(baseSalary|grossSalary|netToPay|employerCost|retSS9|retSS35|retIrg|tfp|expenseRefund)$/;

/** Les champs que le modèle ne peut pas remplir : un FICHIER (des octets), pas une valeur. */
export const CHAMP_BINAIRE = /^(file|files|fichier|fichiers|attachment|attachments|scan|bcFile|bcFiles|ctdFichiers|logo|image|photo|pieceIdentite|cv)$/;
/** Le fichier qui EST l'objet du geste (déposer, lire, importer) — sans lui, l'action n'a pas de sens : elle se fait à l'écran. */
export const CHAMP_BINAIRE_PRINCIPAL = /^(file|fichier|scan|attachment|bcFile|logo|image|photo|pieceIdentite|cv)$/;

/**
 * LES ACTIONS QUI ÉCRIVENT HORS DE LA BASE ET HORS DES PORTS — la boîte aux lettres IMAP (drapeaux, déplacements,
 * dépôt dans « Envoyés ») : ni la transaction ni un port de sortie ne la couvrent. Elles restent « non simulables ».
 */
const HORS_PORTS = /^(mail-actions|mail-folder-actions)$/;

/**
 * CE QUE J7 SIMULE (décision 0029) — l'action jouée dans une transaction annulée, ses effets externes neutralisés par
 * les ports qui lisent le contexte du geste : courriel (SMTP, Graph, API), notification poussée, stockage objet, site
 * Adventum, et tout `fetch` qui écrit vers l'extérieur. « oui » exige que ce qu'elle touche soit LU (ses modèles
 * écrits) : une action qui délègue son écriture sans qu'on la voie reste « inconnu » — non prouvée, la carte le dit.
 */
export function simulableDe(c: ContratLu, risque: Risque): { simulable: Simulable; raison: string } {
  if (risque === "R0") return { simulable: "oui", raison: "lecture : rien à annuler" };
  if (HORS_PORTS.test(c.fichier)) return { simulable: "non", raison: "elle écrit dans la boîte aux lettres (IMAP), hors de la base et des ports de sortie" };
  if (c.ecrit && c.modelesEcrits.length === 0) return { simulable: "inconnu", raison: "elle délègue son écriture : ce qu'elle touche n'a pas été lu" };
  if (!c.ecrit) return { simulable: "inconnu", raison: "aucune écriture lue, et pas une lecture : l'effet est ailleurs" };
  if (risque === "R3") return { simulable: "oui", raison: "ses écritures sont en base ; ce qui sortirait (courrier, site, fournisseur) passe par un port, neutralisé en simulation" };
  if (c.champs.some((ch) => CHAMP_BINAIRE.test(ch.nom)) || c.modelesEcrits.some((m) => /^(storedFile|driveNode|fileBlob)$/.test(m))) {
    return { simulable: "oui", raison: "le fichier va au stockage par un port, neutralisé en simulation ; ses lignes sont en base" };
  }
  if (c.modelesEcrits.includes("notification")) return { simulable: "oui", raison: "la notification est en base ; sa poussée passe par un port, neutralisé en simulation" };
  return { simulable: "oui", raison: "toutes ses écritures sont en base" };
}

/** La NATURE du geste, dans le vocabulaire de l'annulation. */
export function natureDeLAction(c: ContratLu, risque: Risque, raison: string): NatureGesteLue | null {
  if (risque === "R0") return null;
  const m = mots(c);
  if (raison.startsWith("argent")) return "PAIEMENT_EXECUTE";
  if (raison.startsWith("suppression")) return "ENREGISTREMENT_SUPPRIME";
  if (risque === "R3") return "MESSAGE_ENVOYE";
  if (m.some((x) => x === "sign" || x === "signer" || x === "signature")) return "SIGNATURE_DEMANDEE";
  if (/regulatory|dossier/.test(c.fichier) && m.some((x) => x === "submit" || x === "soumettre" || x === "deposer")) return "DEPOT_AUTORITE";
  if (/drive/.test(c.fichier) && m.some((x) => ["move", "rename", "renommer", "deplacer", "copy", "archive", "archiver", "classer"].includes(x))) return "FICHIER_DEPLACE";
  if (/(atelier|office|document-actions)/.test(c.fichier) && m.some((x) => ["edit", "modifier", "update"].includes(x))) return "DOCUMENT_MODIFIE";
  if (/teach|rule|regle/.test(c.fichier)) return "REGLE_ENSEIGNEE";
  if (m[0] === "create" || m[0] === "creer" || m[0] === "add" || m[0] === "ajouter" || m[0] === "request" || m[0] === "demander"
    || m[0] === "enregistrer" || m[0] === "save" || m[0] === "upsert" || m[0] === "import" || m[0] === "importer" || m[0] === "generer" || m[0] === "generate") {
    return "ENREGISTREMENT_CREE";
  }
  return "CHAMP_MODIFIE";
}

const PAR_REVERSIBILITE: Readonly<Record<VerdictLu["reversibilite"], Annulation>> = {
  REVERSIBLE: "retour", PAR_COMPENSATION: "compensation", DELEGUEE: "delegation", IRREVERSIBLE: "aucune",
};

export function annulationDe(nature: NatureGesteLue | null, classer: (n: NatureGesteLue) => VerdictLu): { annulation: Annulation; raison: string } {
  if (!nature) return { annulation: "aucune", raison: "lecture : rien à défaire" };
  const v = classer(nature);
  return { annulation: PAR_REVERSIBILITE[v.reversibilite], raison: v.raison };
}

/** La sortie d'une lecture peut porter un texte écrit par un TIERS (courrier, document, pièce, fournisseur). */
export function contenuTiersDe(c: ContratLu, risque: Risque): boolean {
  if (risque !== "R0") return false;
  return /(mail|drive|document|piece|legal|market|candidat|fournisseur|supplier|scan|import|fichier|integration|conseil|comment|devis|facture|message|version|conversation|formulaire|web)/i.test(`${c.fichier} ${c.fonction}`);
}

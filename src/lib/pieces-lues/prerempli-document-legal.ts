import type { EntetesReperes, Repere, TypePieceLue } from "@/lib/pieces-lues/entetes";
import type { IdentiteEmetteur } from "@/lib/pieces-lues/emetteur";
import { normaliserNif, normaliserRc, type IdentifiantsDuGroupe, type ResultatFournisseur } from "@/lib/pieces-lues/fournisseur";
import type { NatureLegaleLue, SyntheseLegale, UniteDuree } from "@/lib/pieces-lues/synthese-legale";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FORMULAIRE « NOUVEAU DOCUMENT » PRÉREMPLI DEPUIS SA PIÈCE (Legal, factures comprises).
 *
 * On dépose d'abord le fichier ; le formulaire s'ouvre avec ce que le fichier DIT. Ce module
 * décide, champ par champ, ce qui se remplit et d'où ça vient — trois sources, dites à l'écran :
 *
 *   RÈGLES  le repérage déterministe (`entetes.ts`) : numéro, date d'une pièce commerciale, NIF,
 *           RC, totaux imprimés — chacun avec la ligne qui le porte ;
 *   LUNA    la synthèse du modèle (`synthese-legale.ts`) : nature d'un contrat, titre, prise
 *           d'effet, résumé — chacune avec sa phrase, sauf les rédactions ;
 *   CALCUL  une date de fin tirée d'une DURÉE lue (« 12 mois », « 30 jours ») et de la date de
 *           début : marquée « calculée », la phrase et l'addition en preuve.
 *
 * Ce qui n'est pas prouvé reste VIDE. Trois règles le tiennent :
 *
 *   • LE MONTANT vient des règles seules, jamais du modèle (P3). Des totaux imprimés en
 *     désaccord laissent le champ vide et le DISENT, les deux valeurs citées.
 *   • LE SENS DE L'ARGENT d'une facture n'est posé que si le NIF (ou le RC) de l'ÉMETTEUR le
 *     prouve : l'une de nos sociétés → émise ; une autre → reçue. Sinon aucun défaut : la personne
 *     choisit (`sensExige`) — une écriture posée à l'envers est pire qu'une écriture absente.
 *   • LA PARTIE n'est retenue que CERTAINE (même NIF ou RC qu'une fiche). Un nom proche se
 *     propose, rien n'est choisi ; inconnue, ce qui a été lu est proposé à « Créer un contact ».
 *
 * Rien n'est écrit ici : enregistrer le formulaire EST la confirmation, et chaque garde de
 * `createLegalDocument` reste celle qui juge.
 *
 * Module PUR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les champs du formulaire Legal que la pièce peut remplir — les noms de `legal-fields.ts`. */
export type ChampPrerempli = "title" | "reference" | "kind" | "startDate" | "endDate" | "amount" | "direction" | "notes" | "chainFromId";

export type SourceChamp = "REGLES" | "LUNA" | "CALCUL";

export interface MarqueChamp {
  source: SourceChamp;
  /** Ce qui le prouve : la ligne du document, la phrase, ou le calcul. */
  preuve: string;
  /** Où dans le document (« ligne 4 »), quand on le sait. */
  ou: string | null;
}

export interface PartieProposee {
  statut: ResultatFournisseur["statut"];
  /** La fiche retenue — CERTAINE seulement. */
  retenue: string | null;
  candidats: { id: string; nom: string }[];
  phrase: string;
  /** Ce qui a été lu, pour « Créer un contact » — jamais créé ici. */
  aCreer: { nom: string | null; nif: string | null; rc: string | null; adresse: string | null } | null;
}

export interface PrerempliDocumentLegal {
  valeurs: Partial<Record<ChampPrerempli, string>>;
  marques: Partial<Record<ChampPrerempli | "counterpartyIds", MarqueChamp>>;
  partie: PartieProposee;
  /** Facture dont l'émetteur n'est pas prouvé : le sens se CHOISIT, aucun défaut. */
  sensExige: boolean;
  /** Les totaux imprimés se contredisent : le montant reste vide, et voici pourquoi. */
  montantConflit: string | null;
  /** Le BC désigné par la facture, à ajouter au menu « Fait suite à » s'il n'y est pas. */
  bcSuivi: { value: string; label: string } | null;
}

export interface EntreePrerempli {
  entetes: EntetesReperes | null;
  synthese: SyntheseLegale | null;
  /** L'émetteur recopié du papier (étiquettes imprimées). */
  emetteur: IdentiteEmetteur;
  fournisseur: ResultatFournisseur;
  groupe: IdentifiantsDuGroupe;
  /** LE BC dont la facture imprime le numéro — un seul trouvé, sinon `null`. */
  bcSuivi: { id: string; label: string; numero: string } | null;
  /** « Nouvelle facture » : la nature est donnée par le bouton, pas lue. */
  natureImposee: NatureLegaleLue | null;
}

const NATURE_DU_TYPE: Partial<Record<TypePieceLue, NatureLegaleLue>> = {
  FACTURE: "INVOICE", DEVIS: "QUOTE", BON_DE_COMMANDE: "PURCHASE_ORDER",
};
/** Les natures qui portent une date d'ÉMISSION imprimée en tête — les règles la lisent. */
const NATURES_COMMERCIALES: readonly NatureLegaleLue[] = ["INVOICE", "QUOTE", "PURCHASE_ORDER"];

const ou = (r: Pick<Repere<unknown>, "ligne">): string => `ligne ${r.ligne}`;
const regles = (r: Repere<unknown>): MarqueChamp => ({ source: "REGLES", preuve: r.extrait, ou: ou(r) });

const frDate = (iso: string): string => { const [a, m, j] = iso.split("-"); return `${j}/${m}/${a}`; };
const fr = (n: number): string => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });

/**
 * LA FIN D'UNE DURÉE. Une période en mois ou en années s'achève la VEILLE de son anniversaire (« 12 mois à compter du
 * 1er novembre 2026 » → 31/10/2027) ; un délai en jours tombe le jour dit (« à 30 jours » du 14/10 → 13/11). `null` sur
 * une date qui ne se lit pas.
 */
export function finDeDuree(debutIso: string, nombre: number, unite: UniteDuree): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(debutIso);
  if (!m || !Number.isInteger(nombre) || nombre <= 0) return null;
  const [a, mo, j] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  let d: Date;
  if (unite === "JOUR") d = new Date(Date.UTC(a, mo, j + nombre));
  else {
    const mois = unite === "MOIS" ? nombre : nombre * 12;
    const cible = new Date(Date.UTC(a, mo + mois, 1));
    // Le même quantième, borné à la fin du mois visé (31 janvier + 1 mois → 28 ou 29 février), puis la veille.
    const dernier = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
    d = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth(), Math.min(j, dernier) - 1));
  }
  return d.toISOString().slice(0, 10);
}

const UNITE_FR: Record<UniteDuree, [string, string]> = { JOUR: ["jour", "jours"], MOIS: ["mois", "mois"], AN: ["an", "ans"] };

function phrasePartie(f: ResultatFournisseur): string {
  if (f.statut === "CERTAIN") {
    const c = f.candidats[0];
    return `Partie reconnue par son ${c?.par ?? "NIF"} : « ${c?.nom ?? ""} ».`;
  }
  if (f.statut === "PROBABLE") return `Un contact porte un nom proche : « ${f.candidats[0]?.nom ?? ""} ». Vérifiez son NIF avant de le choisir : rien n'est choisi à votre place.`;
  if (f.statut === "AMBIGU") return `Plusieurs contacts correspondent (${f.candidats.map((c) => `« ${c.nom} »`).join(", ")}) : aucun n'est choisi, à vous de trancher.`;
  return "Partie absente de l'annuaire : « Créer un contact » l'y ajoute, avec ce qui a été lu sur la pièce.";
}

/** Le sens de l'argent, prouvé par l'identifiant de l'ÉMETTEUR — `null` quand rien ne le prouve. */
function sensProuve(emetteur: IdentiteEmetteur, groupe: IdentifiantsDuGroupe): { sens: "IN" | "OUT"; preuve: string } | null {
  const nifsGroupe = new Set((groupe.nifs ?? []).map(normaliserNif).filter(Boolean));
  const rcsGroupe = new Set((groupe.rcs ?? []).map(normaliserRc).filter(Boolean));
  const nif = normaliserNif(emetteur.nif);
  const rc = normaliserRc(emetteur.rc);
  if (nif) {
    return nifsGroupe.has(nif)
      ? { sens: "IN", preuve: `NIF de l'émetteur ${nif} : l'une de nos sociétés → émise.` }
      : { sens: "OUT", preuve: `NIF de l'émetteur ${nif} : pas l'une de nos sociétés → reçue.` };
  }
  if (rc) {
    return rcsGroupe.has(rc)
      ? { sens: "IN", preuve: `RC de l'émetteur ${rc} : l'une de nos sociétés → émise.` }
      : { sens: "OUT", preuve: `RC de l'émetteur ${rc} : pas l'une de nos sociétés → reçue.` };
  }
  return null;
}

/** Le premier identifiant lu hors ceux du groupe — ce que « Créer un contact » proposera. */
function premier(xs: readonly (string | null | undefined)[], groupe: readonly (string | null | undefined)[], norm: (v: string | null | undefined) => string | null): string | null {
  const exclus = new Set(groupe.map(norm).filter(Boolean));
  for (const x of xs) { const n = norm(x); if (n && !exclus.has(n)) return n; }
  return null;
}

export function preremplirDocumentLegal(e: EntreePrerempli): PrerempliDocumentLegal {
  const valeurs: PrerempliDocumentLegal["valeurs"] = {};
  const marques: PrerempliDocumentLegal["marques"] = {};
  const s = e.synthese;
  const t = e.entetes;
  const poser = (champ: ChampPrerempli, valeur: string, marque: MarqueChamp | null) => {
    valeurs[champ] = valeur;
    if (marque) marques[champ] = marque;
  };

  // LA NATURE — imposée par le bouton, sinon les règles (un en-tête « FACTURE N° … »), sinon Luna.
  const natureRegles = t?.type ? NATURE_DU_TYPE[t.type] ?? null : null;
  let nature: NatureLegaleLue | null = e.natureImposee;
  if (!nature && natureRegles) {
    nature = natureRegles;
    poser("kind", nature, t?.numero ? regles(t.numero) : { source: "REGLES", preuve: "Le titre imprimé de la pièce.", ou: null });
  } else if (!nature && s?.nature) {
    nature = s.nature.valeur;
    poser("kind", nature, { source: "LUNA", preuve: s.nature.extrait, ou: null });
  }
  const facture = nature === "INVOICE";
  const commerciale = nature !== null && NATURES_COMMERCIALES.includes(nature);

  if (s?.titre && !s.suspects.includes("titre")) poser("title", s.titre, { source: "LUNA", preuve: "Rédigé par Luna depuis le document.", ou: null });
  if (t?.numero?.valeur) poser("reference", t.numero.valeur, regles(t.numero));

  // LA DATE DE DÉBUT — l'émission d'une pièce commerciale se lit aux règles ; la prise d'effet d'un contrat, par Luna.
  const debutRegles = t?.date?.valeur ? { valeur: t.date.valeur, marque: regles(t.date) } : null;
  const debutLuna = s?.dateDebut ? { valeur: s.dateDebut.valeur, marque: { source: "LUNA" as const, preuve: s.dateDebut.extrait, ou: null } } : null;
  const debut = commerciale ? debutRegles ?? debutLuna : debutLuna ?? debutRegles;
  if (debut) poser("startDate", debut.valeur, debut.marque);

  // LA DATE DE FIN — imprimée (Luna), sinon CALCULÉE depuis une durée lue et le début. Jamais avant le début.
  if (s?.dateFin && (!debut || s.dateFin.valeur >= debut.valeur)) {
    poser("endDate", s.dateFin.valeur, { source: "LUNA", preuve: s.dateFin.extrait, ou: null });
  } else if (s?.duree && debut) {
    const { nombre, unite } = s.duree.valeur;
    const fin = finDeDuree(debut.valeur, nombre, unite);
    if (fin) {
      poser("endDate", fin, {
        source: "CALCUL",
        preuve: `« ${s.duree.extrait} » → ${frDate(debut.valeur)} + ${nombre} ${UNITE_FR[unite][nombre > 1 ? 1 : 0]} = ${frDate(fin)}.`,
        ou: null,
      });
    }
  }

  // LE MONTANT — aux règles seules ; des totaux en désaccord se DISENT et laissent le champ vide.
  let montantConflit: string | null = null;
  const conflit = (t?.conflits ?? []).find((c) => c.quoi === "TTC" || c.quoi === "NET");
  const total = t?.totalTtc ?? t?.netAPayer ?? null;
  if (conflit) {
    montantConflit = `Les totaux imprimés se contredisent (${conflit.valeurs.join(" / ")}) : le montant n'est pas repris — saisissez celui de la pièce.`;
  } else if (total?.valeur != null && total.valeur > 0) {
    poser("amount", String(total.valeur), { source: "REGLES", preuve: `${total.extrait} (${fr(total.valeur)} DZD)`, ou: ou(total) });
  }

  // LE SENS DE L'ARGENT — prouvé par l'émetteur, sinon choisi par la personne.
  let sensExige = false;
  if (facture) {
    const sens = sensProuve(e.emetteur, e.groupe);
    if (sens) poser("direction", sens.sens, { source: "REGLES", preuve: sens.preuve, ou: null });
    else sensExige = true;
  }

  // « FAIT SUITE À » — le BC dont la facture imprime le numéro, quand un seul le porte.
  let bcSuivi: PrerempliDocumentLegal["bcSuivi"] = null;
  if (facture && e.bcSuivi) {
    const ref = (t?.references ?? []).find((r) => r.type === "BON_DE_COMMANDE");
    bcSuivi = { value: e.bcSuivi.id, label: e.bcSuivi.label };
    poser("chainFromId", e.bcSuivi.id, {
      source: "REGLES",
      preuve: `${ref?.extrait ?? `BC n° ${e.bcSuivi.numero}`} → un seul bon de commande porte ce numéro.`,
      ou: ref ? `ligne ${ref.ligne}` : null,
    });
  }

  // LES NOTES — le résumé de Luna, et ce qu'il faut surveiller quand le document le dit.
  const resume = s?.resume && !s.suspects.includes("resume") ? s.resume : null;
  const surveiller = s?.aSurveiller && !s.suspects.includes("aSurveiller") ? s.aSurveiller : null;
  if (resume || surveiller) {
    poser("notes", [resume, surveiller ? `À surveiller : ${surveiller}` : null].filter(Boolean).join("\n"), {
      source: "LUNA", preuve: "Résumé rédigé par Luna depuis le document.", ou: null,
    });
  }

  // LA PARTIE — retenue CERTAINE seulement ; inconnue, ce qui a été lu est proposé à la création.
  const f = e.fournisseur;
  const groupeNifs = e.groupe.nifs ?? [];
  const groupeRcs = e.groupe.rcs ?? [];
  const emetteurDuGroupe = Boolean(normaliserNif(e.emetteur.nif) && groupeNifs.map(normaliserNif).includes(normaliserNif(e.emetteur.nif)));
  const partie: PartieProposee = {
    statut: f.statut,
    retenue: f.statut === "CERTAIN" ? f.retenu : null,
    candidats: f.candidats.map((c) => ({ id: c.id, nom: c.nom })),
    phrase: phrasePartie(f),
    aCreer: f.statut === "AUCUN"
      ? {
          nom: s?.contrepartie.nom ?? f.aCreer?.nom ?? (emetteurDuGroupe ? null : e.emetteur.nom),
          nif: premier([s?.contrepartie.nif, ...(f.aCreer?.nifs ?? []), emetteurDuGroupe ? null : e.emetteur.nif], groupeNifs, normaliserNif),
          rc: premier([s?.contrepartie.rc, ...(f.aCreer?.rcs ?? []), emetteurDuGroupe ? null : e.emetteur.rc], groupeRcs, normaliserRc),
          adresse: s?.contrepartie.adresse ?? (emetteurDuGroupe ? null : e.emetteur.adresse),
        }
      : null,
  };
  if (partie.retenue) marques.counterpartyIds = { source: "REGLES", preuve: partie.phrase, ou: null };

  return { valeurs, marques, partie, sensExige, montantConflit, bcSuivi };
}

/** Ce que Luna a pu faire de la pièce — la cause, quand elle n'a pas lu. */
export type EtatLuna = "LUE" | "CONFIDENTIELLE" | "IA_COUPEE" | "DESACTIVEE" | "NON_CONFIGUREE" | "ILLISIBLE" | "ECHEC";

/**
 * LA PHRASE EN TÊTE DU FORMULAIRE — comment la pièce a été lue, et ce que la lecture n'a pas fait. Elle vient de notre
 * code, jamais du document (§104.15). « Rien n'a quitté la plateforme » ne se dit que lorsque c'est VRAI : aucun
 * appel au modèle, et un scan lu par le moteur local.
 */
export function phraseDeLecture(m: { scan: boolean; parLuna: boolean; luna: EtatLuna; erreurLuna?: string | null }): string {
  const texte = m.scan ? (m.parLuna ? "Scan lu par Luna" : "Scan lu par l'OCR du serveur (qualité moindre)") : "Texte du fichier lu";
  switch (m.luna) {
    case "LUE":
      return m.scan && m.parLuna ? "Lu par Luna (scan)." : `${texte}, complété par Luna.`;
    case "CONFIDENTIELLE":
      return `Lecture locale — document confidentiel : rien n'a quitté la plateforme. ${texte} ; la nature, le titre et le résumé sont à saisir.`;
    case "IA_COUPEE":
      return `Lecture locale — l'IA est coupée par l'interrupteur général : rien n'a quitté la plateforme. ${texte} ; la nature, le titre et le résumé sont à saisir.`;
    case "DESACTIVEE":
      return `Lecture locale — la lecture des pièces est coupée (Administration › Contrôle de l'IA) : rien n'a quitté la plateforme. ${texte} ; la nature, le titre et le résumé sont à saisir.`;
    case "NON_CONFIGUREE":
      return `Lecture locale — la clé du fournisseur d'IA n'est pas configurée. ${texte} ; la nature, le titre et le résumé sont à saisir.`;
    case "ILLISIBLE":
      return "Le texte de la pièce n'a pas pu être lu (scan trop abîmé ou vide) : complétez le formulaire depuis le document.";
    case "ECHEC":
      return `${texte}. ${m.erreurLuna ?? "Luna n'a pas pu lire la pièce"}`;
  }
}

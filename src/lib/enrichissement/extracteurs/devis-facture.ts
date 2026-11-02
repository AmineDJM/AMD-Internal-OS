/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEVIS, FACTURE, BON DE COMMANDE, AVOIR → FAITS — un ADAPTATEUR sur la lecture des pièces de l'ERP.
 *
 * La lecture des pièces commerciales existe déjà (`pieces-lues/service.ts`, `proposerLecture`) :
 * elle repère l'en-tête et les identifiants par des règles (`entetes.ts`), recopie l'identité de
 * l'émetteur sous ses étiquettes imprimées (`emetteur.ts`) et fait proposer les lignes par un
 * modèle quand la Direction l'a ouvert (`structure.ts`). Cet extracteur ne relit RIEN : il traduit
 * sa `PropositionDeLecture` en faits du catalogue (§3-E, étape 4).
 *
 *   ÉMETTEUR (le fournisseur)       → raison sociale, NIF, RC, NIS, AI, adresse, téléphone, e-mail,
 *                                      banque, RIB (sensible — au coffre, et seulement si sa clé est juste)
 *   DESTINATAIRE (souvent le groupe) → raison sociale, identifiants, adresse — lus dans le bloc
 *                                      « Client : … » ou reconnus aux identifiants du groupe
 *   PRODUIT, un sujet par ligne      → désignation chez le fournisseur, prix unitaire HT
 *
 * ── À QUI EST UN IDENTIFIANT ? ─────────────────────────────────────────────────────────────
 *
 * Le repérage rend les NIF, RC, NIS et AI en LISTES, fournisseur et client confondus — il ne
 * devine pas. Ici on rattache, dans cet ordre, sans jamais trancher au hasard :
 *   1. un identifiant du GROUPE, ou imprimé dans le bloc du client → DESTINATAIRE ;
 *   2. un identifiant égal à celui de l'identité de l'émetteur (étiquettes, modèle) → ÉMETTEUR ;
 *   3. s'il en reste UN SEUL du même champ et que l'émetteur n'en a pas → ÉMETTEUR, par déduction ;
 *   4. sinon : pas de fait, et la note dit combien sont restés sans propriétaire.
 *
 * ── LES PRIX ───────────────────────────────────────────────────────────────────────────────
 *
 * Les lignes viennent du modèle : leur confiance est celle d'un modèle, relevée quand le contrôle
 * au centime contre les totaux imprimés est CONFORME. Une ligne de section, une ligne au prix
 * illisible ou dont la désignation porte un motif d'injection ne fait pas de prix ; elles sont
 * comptées dans les notes. Le prix est HT AVANT remise de ligne — l'extrait le dit quand il y en a une.
 *
 * Module PUR : la proposition et le texte arrivent de l'appelant (types seulement importés du service).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { FaitExtrait, NaturePiece, ResultatExtraction } from "@/lib/enrichissement/types";
import type { PropositionDeLecture } from "@/lib/pieces-lues/service";
import type { IdentifiantsDuGroupe } from "@/lib/pieces-lues/fournisseur";
import type { Repere } from "@/lib/pieces-lues/entetes";
import {
  CONFIANCE, comptesDans, extraitDe, fait, ligneQuiContient, lignesDe, montantNormalise, nettoyer, normaliserAdresse, normaliserAi,
  normaliserEmail, normaliserNif, normaliserNis, normaliserRaisonSociale, normaliserRc, normaliserTelephone, normaliserTexte,
  ribValide, sansDoublons, valeurEtiquetee, type ChampIdentifiant, type LigneDeTexte,
} from "@/lib/enrichissement/extracteurs/commun-organisations";
import { cleSociete } from "@/lib/quality/model";

export const MOTEUR_DEVIS_FACTURE = "pieces-lues/adaptateur-organisations/1";

export type NatureCommerciale = Extract<NaturePiece, "DEVIS" | "FACTURE" | "BON_DE_COMMANDE" | "AVOIR">;

export interface EntreeDevisFacture {
  /** Ce que `proposerLecture` a rendu — les champs dont l'adaptateur se sert. */
  proposition: Pick<PropositionDeLecture, "entetes" | "emetteur" | "piece" | "faits" | "lignesParModele" | "controle">;
  /**
   * Le texte lu (celui de `LecturePiece`) : il sert à retrouver la PREUVE d'une valeur (la ligne,
   * la page) et le bloc du client. Sans lui, les faits restent proposés, avec des preuves réduites.
   */
  texte?: string | null;
  /** La nature, quand le classement l'a déjà dite ; sinon celle que la lecture a reconnue. */
  nature?: NatureCommerciale;
  /** Les identifiants (et noms) des sociétés du groupe : le destinataire de la pièce, jamais son émetteur. */
  groupe?: IdentifiantsDuGroupe & { noms?: readonly string[] };
}

const SUJET_EMETTEUR = "emetteur";
const SUJET_DESTINATAIRE = "destinataire";

const NATURE_LUE: Partial<Record<string, NatureCommerciale>> = { DEVIS: "DEVIS", FACTURE: "FACTURE", BON_DE_COMMANDE: "BON_DE_COMMANDE", AVOIR: "AVOIR" };

// ─────────────────────────────── Le bloc du client ───────────────────────────────

/** L'étiquette qui ouvre le bloc du DESTINATAIRE — avec ses deux-points, ou seule sur sa ligne. */
const RE_CLIENT = /(?<![a-z])(client|destinataire|doit|factur(?:e|ee)\s+a|adress(?:e|ee)\s+a|a\s+l'attention\s+de|livr(?:e|ee)\s+a|acheteur|commanditaire)\s*:/;
const RE_CLIENT_SEUL = /^\s*(client|destinataire|doit|factur(?:e|ee)\s+a|acheteur)\s*$/;
/** Ce qui ferme le bloc : le tableau, un autre en-tête, l'identité de l'émetteur. */
const RE_FIN_BLOC = /^\s*(?:designation|description|quantite|qte|prix|montant|total|objet|reference|ref\.|raison\s+sociale|date|devis|facture|bon\s+de\s+commande|proforma|n[°o]\s|emetteur|fournisseur|vendeur)/;
/** Une valeur collée à l'étiquette suivante (« SARL ADVENTUM PHARMA Date : … ») s'y arrête. */
const RE_COUPE_NOM = /\s*(?:\||\s{3,}|(?<![a-z])(?:date|tel|tél|fax|nif|n\.i\.f|rc|r\.c|nis|adresse|e-?mail)\s*:).*$/i;

interface BlocDestinataire {
  rangs: Set<number>;
  nom: { valeur: string; ligne: LigneDeTexte; extrait: string } | null;
  adresse: { valeur: string; ligne: LigneDeTexte } | null;
}

function blocDestinataire(lignes: readonly LigneDeTexte[]): BlocDestinataire {
  const vide: BlocDestinataire = { rangs: new Set(), nom: null, adresse: null };
  const i = lignes.findIndex((l) => RE_CLIENT.test(l.pli) || RE_CLIENT_SEUL.test(l.pli));
  if (i < 0) return vide;
  const l = lignes[i];
  const m = RE_CLIENT.exec(l.pli) ?? RE_CLIENT_SEUL.exec(l.pli);
  const apres = m ? l.texte.slice((m.index ?? 0) + m[0].length) : "";
  const rangs = new Set<number>([l.rang]);
  let nom: BlocDestinataire["nom"] = null;
  const surLaLigne = nettoyer(apres.replace(RE_COUPE_NOM, ""));
  if (surLaLigne) nom = { valeur: surLaLigne, ligne: l, extrait: extraitDe(l.texte) };
  let adresse: BlocDestinataire["adresse"] = null;
  let prises = 0;
  for (let j = i + 1; j < lignes.length && prises < 5; j++) {
    const s = lignes[j];
    if (!s.pli.trim()) { if (prises > 0) break; continue; }
    if (RE_FIN_BLOC.test(s.pli)) break;
    prises++;
    rangs.add(s.rang);
    if (!nom && !/:/.test(s.pli)) { nom = { valeur: nettoyer(s.texte.replace(RE_COUPE_NOM, "")), ligne: s, extrait: extraitDe(`${l.texte} ${s.texte}`) }; continue; }
    const a = /^\s*(?:adresse|siege(?:\s+social)?)\s*:?\s*/.exec(s.pli);
    if (a && !adresse) {
      const v = nettoyer(s.texte.slice(a[0].length));
      if (v) adresse = { valeur: v, ligne: s };
    } else if (!adresse && nom && !/:/.test(s.pli) && /\d|rue|cite|lot|bp|alger|oran|constantine|wilaya|commune|zone|route|boulevard|bd|avenue/.test(s.pli)) {
      adresse = { valeur: nettoyer(s.texte), ligne: s };
    }
  }
  return { rangs, nom: nom && nom.valeur ? nom : null, adresse };
}

// ─────────────────────────────── L'extracteur ───────────────────────────────

const normaliseur: Record<ChampIdentifiant, (v: string | null | undefined) => string | null> = {
  NIF: normaliserNif, NIS: normaliserNis, RC: normaliserRc, AI: normaliserAi,
};
const ATTRIBUT_ID: Record<ChampIdentifiant, string> = { NIF: "organisation.nif", NIS: "organisation.nis", RC: "organisation.rc", AI: "organisation.ai" };
const CHAMPS: ChampIdentifiant[] = ["NIF", "RC", "NIS", "AI"];

const formaterMontant = (n: number): string => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[  ]/g, " ");

export function extraireDevisFacture(e: EntreeDevisFacture): ResultatExtraction {
  const { proposition: p } = e;
  const lignes = lignesDe(e.texte);
  const avecTexte = Boolean(e.texte && e.texte.trim());
  const ligneDeRang = (rang: number): LigneDeTexte | null => lignes[rang - 1] ?? null;
  const pageDe = (rang: number | null | undefined) => (rang ? ligneDeRang(rang)?.page ?? null : null);
  const notes: string[] = [];
  const faits: (FaitExtrait | null)[] = [];

  const nature: NaturePiece = e.nature ?? NATURE_LUE[p.entetes.type ?? ""] ?? NATURE_LUE[p.piece?.type ?? ""] ?? "AUTRE";
  if (nature === "AUTRE") notes.push("La nature de la pièce (devis, facture, bon de commande, avoir) ne se lit pas : à classer à la main.");
  if (!avecTexte) notes.push("Le texte lu n'a pas été fourni : les preuves se réduisent à ce que la lecture a gardé (extraits des identifiants).");

  const bloc = avecTexte ? blocDestinataire(lignes) : { rangs: new Set<number>(), nom: null, adresse: null };
  const dansBloc = (rang: number | null | undefined) => rang !== null && rang !== undefined && bloc.rangs.has(rang);
  const dansLeBloc = (l: LigneDeTexte) => bloc.rangs.has(l.rang);

  const groupeNif = new Set((e.groupe?.nifs ?? []).map(normaliserNif).filter((x): x is string => !!x));
  const groupeRc = new Set((e.groupe?.rcs ?? []).map(normaliserRc).filter((x): x is string => !!x));
  const groupeNoms = new Set((e.groupe?.noms ?? []).map((n) => cleSociete(n)).filter(Boolean));
  const duGroupe = (champ: ChampIdentifiant, v: string) => (champ === "NIF" ? groupeNif.has(v) : champ === "RC" ? groupeRc.has(v) : false);

  const preuveTexte = (valeur: string | null | undefined, repli: string) => {
    const l = avecTexte ? ligneQuiContient(lignes, valeur) : null;
    return { page: l?.page ?? null, extrait: l ? l.texte : repli, trouvee: l !== null, rang: l?.rang ?? null };
  };

  // ── 1. LES IDENTIFIANTS ───────────────────────────────────────────────────────────────
  const emetteurIds: Record<ChampIdentifiant, string[]> = {
    NIF: [p.emetteur.nif, p.piece?.fournisseur.nif].map(normaliserNif).filter((x): x is string => !!x),
    RC: [p.emetteur.rc, p.piece?.fournisseur.rc].map(normaliserRc).filter((x): x is string => !!x),
    NIS: [p.piece?.fournisseur.nis].map(normaliserNis).filter((x): x is string => !!x),
    AI: [p.piece?.fournisseur.ai].map(normaliserAi).filter((x): x is string => !!x),
  };
  const reperes: Record<ChampIdentifiant, Repere<string>[]> = {
    NIF: p.entetes.nif, RC: p.entetes.rc, NIS: p.entetes.nis, AI: p.entetes.ai,
  };

  for (const champ of CHAMPS) {
    const norm = normaliseur[champ];
    const lus = reperes[champ].filter((r): r is Repere<string> & { valeur: string } => r.valeur !== null);
    // Un identifiant de l'émetteur que le groupe ou le bloc du client revendique n'est pas le sien.
    const aDestinataire = new Set(lus.filter((r) => duGroupe(champ, r.valeur) || dansBloc(r.ligne)).map((r) => r.valeur));
    const propres = [...new Set(emetteurIds[champ])].filter((v) => !duGroupe(champ, v) && !aDestinataire.has(v));
    const restants: (Repere<string> & { valeur: string })[] = [];

    for (const r of lus) {
      const base = { valeur: r.valeur, valeurNormalisee: norm(r.valeur) ?? r.valeur, page: pageDe(r.ligne), extrait: r.extrait, attribut: ATTRIBUT_ID[champ] };
      if (aDestinataire.has(r.valeur)) {
        faits.push(fait({ ...base, sujetRef: SUJET_DESTINATAIRE, role: "DESTINATAIRE", confiance: duGroupe(champ, r.valeur) ? CONFIANCE.VERIFIE : CONFIANCE.DEDUITE }));
      } else if (propres.includes(r.valeur)) {
        faits.push(fait({ ...base, sujetRef: SUJET_EMETTEUR, role: "EMETTEUR", confiance: CONFIANCE.VERIFIE }));
      } else {
        restants.push(r);
      }
    }
    // L'identifiant de l'émetteur que le repérage n'a pas vu (le modèle l'a lu, ou une forme que les règles ratent).
    for (const v of propres) {
      if (lus.some((r) => r.valeur === v)) continue;
      const pr = preuveTexte(v, `${champ} de l'émetteur, lu par la lecture des pièces`);
      faits.push(fait({ sujetRef: SUJET_EMETTEUR, role: "EMETTEUR", attribut: ATTRIBUT_ID[champ], valeur: v, valeurNormalisee: v, confiance: pr.trouvee ? CONFIANCE.ETIQUETTE : CONFIANCE.MODELE, page: pr.page, extrait: pr.extrait }));
    }
    if (restants.length === 1 && propres.length === 0) {
      const [r] = restants;
      faits.push(fait({ sujetRef: SUJET_EMETTEUR, role: "EMETTEUR", attribut: ATTRIBUT_ID[champ], valeur: r.valeur, valeurNormalisee: norm(r.valeur) ?? r.valeur, confiance: CONFIANCE.DEDUITE, page: pageDe(r.ligne), extrait: r.extrait }));
    } else if (restants.length > 0) {
      notes.push(`${restants.length} ${champ} lu${restants.length > 1 ? "s" : ""} sans qu'on puisse dire s'il${restants.length > 1 ? "s sont" : " est"} à l'émetteur ou au client : non proposé${restants.length > 1 ? "s" : ""}.`);
    }
    const illisibles = reperes[champ].filter((r) => r.valeur === null);
    if (illisibles.length > 0) notes.push(`${champ} illisible${illisibles.length > 1 ? "s" : ""} : ${illisibles.map((r) => r.raison).join(" ; ")}.`);
  }

  // ── 2. L'ÉMETTEUR : raison sociale et coordonnées ────────────────────────────────────
  const nomEmetteur = nettoyer(p.emetteur.nom ?? p.piece?.fournisseur.nom);
  const nomDuGroupe = nomEmetteur && groupeNoms.has(cleSociete(nomEmetteur));
  const nomDuClient = nomEmetteur && bloc.nom && cleSociete(bloc.nom.valeur) === cleSociete(nomEmetteur);
  if (nomEmetteur && !nomDuGroupe && !nomDuClient) {
    const pr = preuveTexte(nomEmetteur, `Raison sociale de l'émetteur : ${nomEmetteur}`);
    faits.push(fait({
      sujetRef: SUJET_EMETTEUR, role: "EMETTEUR", attribut: "organisation.raisonSociale", valeur: nomEmetteur,
      valeurNormalisee: normaliserRaisonSociale(nomEmetteur) ?? nomEmetteur, confiance: pr.trouvee ? CONFIANCE.ETIQUETTE : CONFIANCE.MODELE, page: pr.page, extrait: pr.extrait,
    }));
  } else if (nomEmetteur) {
    notes.push("Le nom lu pour l'émetteur est celui du client ou d'une société du groupe : il n'est pas proposé comme fournisseur.");
  } else {
    notes.push("La raison sociale de l'émetteur ne se lit pas (aucune étiquette « Raison sociale », pas de lecture des lignes).");
  }

  const coordonnee = (attribut: string, valeur: string | null | undefined, normalise: (v: string) => string | null) => {
    const v = nettoyer(valeur);
    if (!v) return;
    const n = normalise(v);
    if (!n) { notes.push(`${attribut === "organisation.telephone" ? "Téléphone" : "Valeur"} de l'émetteur de forme non reconnue (« ${v} ») : non proposé.`); return; }
    const pr = preuveTexte(v, `Lu sur la pièce : ${v}`);
    if (pr.rang && bloc.rangs.has(pr.rang)) return; // imprimé dans le bloc du client : pas à l'émetteur
    faits.push(fait({ sujetRef: SUJET_EMETTEUR, role: "EMETTEUR", attribut, valeur: v, valeurNormalisee: n, confiance: pr.trouvee ? CONFIANCE.ETIQUETTE : CONFIANCE.MODELE, page: pr.page, extrait: pr.extrait }));
  };
  coordonnee("organisation.adresse", p.emetteur.adresse ?? p.piece?.fournisseur.adresse, normaliserAdresse);
  coordonnee("organisation.telephone", p.emetteur.telephone, normaliserTelephone);
  coordonnee("organisation.email", p.emetteur.email, normaliserEmail);

  if (avecTexte) {
    const banque = valeurEtiquetee(lignes, /^(?:banque|domiciliation(?:\s+bancaire)?|etablissement\s+bancaire)\s*:?\s*/, { exclure: dansLeBloc });
    if (banque) faits.push(fait({ sujetRef: SUJET_EMETTEUR, role: "EMETTEUR", attribut: "organisation.banque", valeur: banque.valeur, valeurNormalisee: normaliserTexte(banque.valeur) ?? banque.valeur, confiance: CONFIANCE.ETIQUETTE, page: banque.ligne.page, extrait: banque.extrait }));
  }

  // ── 3. LE RIB DE L'ÉMETTEUR — sensible, et seulement s'il se vérifie ─────────────────
  const comptes = (avecTexte ? comptesDans(lignes.filter((l) => !dansLeBloc(l))) : [])
    .map((c) => ({ type: c.type, valeur: c.valeur, valide: c.valide, page: c.ligne.page, extrait: c.ligne.texte }));
  const ribEmetteur = (p.emetteur.rib ?? "").replace(/\D/g, "");
  if (ribEmetteur.length === 20 && !comptes.some((c) => c.valeur === ribEmetteur)) {
    const pr = preuveTexte(ribEmetteur, "RIB de l'émetteur, lu par la lecture des pièces");
    if (!pr.rang || !bloc.rangs.has(pr.rang)) comptes.push({ type: "RIB", valeur: ribEmetteur, valide: ribValide(ribEmetteur), page: pr.page, extrait: pr.extrait });
  } else if (ribEmetteur && ribEmetteur.length !== 20 && comptes.length === 0) {
    notes.push(`Compte de l'émetteur lu avec ${ribEmetteur.length} chiffres (un RIB en a 20) : non proposé.`);
  }
  for (const c of comptes) {
    if (!c.valide) { notes.push(`${c.type} de l'émetteur lu mais sa clé de contrôle est fausse (lecture abîmée ?) : non proposé — à saisir depuis le papier.`); continue; }
    faits.push(fait({ sujetRef: SUJET_EMETTEUR, role: "EMETTEUR", attribut: "organisation.rib", valeur: c.valeur, valeurNormalisee: c.valeur, confiance: CONFIANCE.VERIFIE, page: c.page, extrait: c.extrait }));
  }

  // ── 4. LE DESTINATAIRE ───────────────────────────────────────────────────────────────
  if (bloc.nom) {
    const groupe = groupeNoms.has(cleSociete(bloc.nom.valeur));
    faits.push(fait({
      sujetRef: SUJET_DESTINATAIRE, role: "DESTINATAIRE", attribut: "organisation.raisonSociale", valeur: bloc.nom.valeur,
      valeurNormalisee: normaliserRaisonSociale(bloc.nom.valeur) ?? bloc.nom.valeur, confiance: groupe ? CONFIANCE.VERIFIE : CONFIANCE.ETIQUETTE,
      page: bloc.nom.ligne.page, extrait: bloc.nom.extrait,
    }));
    if (groupe) notes.push("Le destinataire est une société du groupe.");
  }
  if (bloc.adresse) {
    const n = normaliserAdresse(bloc.adresse.valeur);
    if (n) faits.push(fait({ sujetRef: SUJET_DESTINATAIRE, role: "DESTINATAIRE", attribut: "organisation.adresse", valeur: bloc.adresse.valeur, valeurNormalisee: n, confiance: CONFIANCE.DEDUITE, page: bloc.adresse.ligne.page, extrait: bloc.adresse.ligne.texte }));
  }

  // ── 5. LES PRIX, UNE LIGNE = UN PRODUIT ──────────────────────────────────────────────
  const piece = p.piece;
  if (!piece) {
    notes.push("Aucune ligne lue (la lecture des lignes par le modèle n'a pas eu lieu) : pas de prix proposé.");
  } else {
    const devise = piece.devise ?? null;
    const conforme = p.controle?.conforme === true;
    let sansPrix = 0;
    let suspectes = 0;
    for (const l of piece.lignes) {
      if (l.section) continue;
      if (l.suspecte.length > 0) { suspectes++; continue; }
      const designation = nettoyer(l.designation);
      if (!designation) continue;
      const sujetRef = `ligne-${l.rang}`;
      const pr = preuveTexte(designation.slice(0, 40), "");
      const confiance = (conforme ? CONFIANCE.PHRASE : CONFIANCE.MODELE) - (l.forfait ? 0.1 : 0);
      faits.push(fait({
        sujetRef, role: "MENTIONNE", attribut: "produit.designationFournisseur", valeur: l.reference ? `${designation} (réf. ${l.reference})` : designation,
        valeurNormalisee: normaliserTexte(designation) ?? designation, confiance, page: pr.page, extrait: pr.trouvee ? pr.extrait : `Ligne ${l.rang} : ${designation}`,
      }));
      if (l.prixUnitaire === null || l.illisibles.some((x) => x.champ === "prixUnitaire")) { sansPrix++; continue; }
      const affiche = `${formaterMontant(l.prixUnitaire)}${devise ? ` ${devise}` : ""}`;
      const remise = l.remise ? ` (remise de ligne ${Math.round(l.remise * 1000) / 10} % non déduite)` : "";
      faits.push(fait({
        sujetRef, role: "MENTIONNE", attribut: "produit.prixUnitaireHt", valeur: affiche,
        valeurNormalisee: montantNormalise({ valeur: l.prixUnitaire, devise }), confiance,
        page: pr.page, extrait: `${pr.trouvee ? pr.extrait : `Ligne ${l.rang} : ${designation}`} — PU HT ${affiche}${remise}`,
      }));
    }
    if (sansPrix > 0) notes.push(`${sansPrix} ligne${sansPrix > 1 ? "s" : ""} sans prix unitaire lisible : désignation proposée, pas de prix.`);
    if (suspectes > 0) notes.push(`${suspectes} ligne${suspectes > 1 ? "s" : ""} dont la désignation porte un motif d'injection : écartée${suspectes > 1 ? "s" : ""}, rien n'en est proposé.`);
    if (!conforme) notes.push("Les totaux recalculés depuis les lignes ne concordent pas (ou pas entièrement) avec ceux imprimés : les prix restent à confirmer.");
    if (!devise) notes.push("La devise ne se lit pas : les prix sont proposés sans devise.");
  }

  const local = !p.lignesParModele && !String(p.faits.moteur ?? "").toLowerCase().startsWith("luna");
  return { nature, moteur: MOTEUR_DEVIS_FACTURE, local, faits: sansDoublons(faits), notes };
}

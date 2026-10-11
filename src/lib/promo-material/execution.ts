/**
 * L'EXÉCUTION D'UN MATÉRIEL PROMOTIONNEL DU CIRCUIT 2 — quand chaque chantier est-il clos ? (§118.152)
 *
 * « Le bon de commande est généré par la plateforme elle-même — un ou plusieurs, selon ce qui a
 * été validé. Il faut uploader la facture pour demander un paiement, c'est obligatoire : la ou
 * les factures, associées chacune à son bon de commande. Et une fois qu'il y a un paiement, la
 * demande de visa publicitaire — ou la déclaration au ministère — part chez l'information
 * médicale, associée à chaque fois. »
 *
 * Les trois chantiers du circuit s'y lisent tels quels :
 *   • BONS DE COMMANDE — chaque devis dont une ligne est retenue a SON bon de commande, et il est
 *     SIGNÉ par les Finances : un BC validé mais pas signé ne part pas chez le fournisseur (§118.149) ;
 *   • FACTURES ET PAIEMENTS — chaque BC porte au moins une facture, et chaque facture est RÉGLÉE :
 *     un paiement passe par le centre de paiement, puis les Finances (§118.148) ;
 *   • VISA OU DÉCLARATION — chaque paiement demandé a sa demande à l'information médicale.
 *
 * Chaque verdict dit TOUT ce qui manque, nommé : « en exécution » tout seul ne dit pas quoi relancer.
 *
 * Module PUR — le chargeur (`queries/promo-execution.ts`) passe des faits déjà lus.
 */

import { LIBELLE_ETAPE_BC, type EtapeBC } from "@/lib/bons-de-commande/regle";

export interface FactureDuBC {
  id: string;
  reference: string | null;
  montant: number | null;
  /** Le règlement est-il fait (ordre payé) ? */
  reglee: boolean;
  /** Où en est son règlement, en français — « au centre de paiement », « non envoyée »… */
  etatReglement: string;
  /** Un paiement a-t-il été DEMANDÉ pour elle (ordre de dépense créé) ? */
  paiementDemande: boolean;
  /** Sa demande de visa publicitaire ou de déclaration au ministère, si elle existe. */
  demandeInfoMedicale: { reference: string; nature: string; formalite?: string | null } | null;
  /**
   * Les lignes de la facture DÉTAILLÉE qui attendent encore leur réception (§118.165) — le paiement
   * les attend. 0 (ou absent) pour une facture d'avant le détail ligne à ligne.
   */
  receptionAttendue?: number;
}

export interface BCDuDevis {
  quoteId: string;
  fournisseur: string;
  lignesRetenues: number;
  bc: { id: string; reference: string | null; etape: EtapeBC; montant: number | null } | null;
  factures: FactureDuBC[];
}

export type Verdict = { ok: true } | { ok: false; raison: string };

const nomBC = (d: BCDuDevis) => `${d.bc?.reference ? `BC ${d.bc.reference}` : "BC"} (${d.fournisseur})`;
const nomFacture = (f: FactureDuBC) => `facture ${f.reference?.trim() || "sans numéro"}`;

/** Les devis qui engagent quelque chose : ceux dont au moins une ligne est retenue. */
export function devisEngages(devis: readonly BCDuDevis[]): BCDuDevis[] {
  return devis.filter((d) => d.lignesRetenues > 0);
}

/** LE CHANTIER « BONS DE COMMANDE » : un BC par devis retenu, et chacun SIGNÉ. */
export function verdictBonsDeCommande(devis: readonly BCDuDevis[]): Verdict {
  const engages = devisEngages(devis);
  if (engages.length === 0) return { ok: false, raison: "Aucune ligne de devis n'est retenue : il n'y a rien à commander." };
  const aGenerer = engages.filter((d) => !d.bc).map((d) => d.fournisseur);
  const nonSignes = engages.filter((d) => d.bc && d.bc.etape !== "SIGNE").map((d) => `${nomBC(d)} — ${LIBELLE_ETAPE_BC[d.bc!.etape].toLowerCase()}`);
  const manques = [
    ...(aGenerer.length ? [`bon de commande à générer pour ${aGenerer.join(", ")}`] : []),
    ...(nonSignes.length ? [`pas encore signé par les Finances : ${nonSignes.join(" ; ")}`] : []),
  ];
  return manques.length ? { ok: false, raison: `Chantier « bons de commande » ouvert — ${manques.join(" ; ")}.` } : { ok: true };
}

/** LE CHANTIER « FACTURES ET PAIEMENTS » : au moins une facture par BC, et toutes réglées. */
export function verdictPaiements(devis: readonly BCDuDevis[]): Verdict {
  const avecBC = devisEngages(devis).filter((d) => d.bc);
  if (avecBC.length === 0) return { ok: false, raison: "Aucun bon de commande n'est encore généré : les factures viennent après." };
  const sansFacture = avecBC.filter((d) => d.factures.length === 0).map(nomBC);
  const nonReglees = avecBC.flatMap((d) => d.factures.filter((f) => !f.reglee).map((f) => {
    // LA RÉCEPTION D'ABORD (§118.165) : « non envoyée » seul laisserait croire qu'il suffit de
    // demander le paiement, alors que le geste attendu est de cocher ce qui est arrivé.
    const attente = !f.paiementDemande && (f.receptionAttendue ?? 0) > 0
      ? `, ${f.receptionAttendue} ligne${(f.receptionAttendue ?? 0) > 1 ? "s" : ""} à réceptionner`
      : "";
    return `${nomFacture(f)} (${d.fournisseur}) — ${f.etatReglement}${attente}`;
  }));
  const manques = [
    ...(sansFacture.length ? [`facture obligatoire attendue pour ${sansFacture.join(", ")}`] : []),
    ...(nonReglees.length ? [`pas encore réglé : ${nonReglees.join(" ; ")}`] : []),
  ];
  return manques.length ? { ok: false, raison: `Chantier « factures et paiements » ouvert — ${manques.join(" ; ")}.` } : { ok: true };
}

/** LE CHANTIER « VISA OU DÉCLARATION » : chaque paiement demandé a sa demande à l'information médicale. */
export function verdictVisas(devis: readonly BCDuDevis[]): Verdict {
  const payees = devisEngages(devis).flatMap((d) => d.factures.filter((f) => f.paiementDemande).map((f) => ({ d, f })));
  if (payees.length === 0) return { ok: false, raison: "Aucun paiement n'est encore demandé : la demande de visa (ou de déclaration) part avec chaque paiement." };
  const sans = payees.filter(({ f }) => !f.demandeInfoMedicale).map(({ d, f }) => `${nomFacture(f)} (${d.fournisseur})`);
  return sans.length
    ? { ok: false, raison: `Chantier « visa ou déclaration » ouvert — demande à adresser à l'information médicale pour : ${sans.join(", ")}.` }
    : { ok: true };
}

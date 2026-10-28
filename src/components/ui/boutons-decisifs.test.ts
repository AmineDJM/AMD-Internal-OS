import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * LES BOUTONS DÉCISIFS DE L'ERP — un cliquet sur leurs POINTS D'APPEL.
 *
 * Un geste qui tranche, engage de l'argent, signe, émet, paie ou supprime se confirme d'un second clic
 * (`BoutonDecisif`). La liste ci-dessous est NOMMÉE, écran par écran : un bouton décisif qui redevient un
 * `<Button>` nu — une retouche, une copie d'un écran voisin — fait tomber ce banc en nommant le fichier et
 * le geste. Chaque entrée exige un NOMBRE d'occurrences, pas une présence : « Refuser » apparaît deux fois
 * dans un écran, et en rendre un seul nu doit se voir.
 *
 * Et une seule mécanique : aucun de ces fichiers ne garde de `window.confirm` — deux confirmations pour le
 * même geste (une fenêtre du navigateur, puis le second clic) apprennent à cliquer sans lire.
 */

type Point = [fichier: string, aiguille: string, auMoins: number];

const POINTS: Point[] = [
  // Centre de paiement, centre de validations, centre Ad & Pro
  ["src/app/(app)/centre-de-paiement/centre-board.tsx", "CENTRAL_DECISION_LABEL[acting.decision]", 1],
  ["src/app/(app)/validations/validation-decision.tsx", "{cfg.label}", 1],
  ["src/app/(app)/validations/[id]/withdraw.tsx", "Retirer ma demande", 1],
  ["src/app/(app)/validations/paiements/[id]/dossier.tsx", "Bon à payer", 1],
  ["src/app/(app)/validations/paiements/[id]/dossier.tsx", "Renvoyer au demandeur", 1],
  ["src/app/(app)/validations/paiements/[id]/dossier.tsx", "Retirer la demande", 2],
  ["src/app/(app)/validations/paiements/[id]/dossier.tsx", "Refuser", 2],
  ["src/app/(app)/centre-ad-pro/centre-board.tsx", "reexaminerVisaCentreAdPro", 1],
  ["src/app/(app)/centre-ad-pro/centre-board.tsx", 'decider("VALIDER")', 1],
  ["src/app/(app)/centre-ad-pro/centre-board.tsx", 'decider("RENVOYER")', 1],
  ["src/app/(app)/centre-ad-pro/centre-board.tsx", 'decider("REFUSER")', 1],
  // Postes Ad & Pro, circuit (workflow), demandes Ad & Pro
  ["src/modules/ad-pro/ecrans/postes/formulaires.tsx", 'decider("APPROVED"', 1],
  ["src/modules/ad-pro/ecrans/postes/formulaires.tsx", 'decider("REVISION"', 1],
  ["src/modules/ad-pro/ecrans/postes/formulaires.tsx", 'decider("REJECTED"', 1],
  ["src/modules/ad-pro/ecrans/postes/formulaires.tsx", "Accepter le BC", 1],
  ["src/modules/ad-pro/ecrans/postes/formulaires.tsx", "Valider le BC", 1],
  ["src/modules/ad-pro/ecrans/postes/formulaires.tsx", "onSend(motif.trim(), valeur.trim())", 1],
  ["src/modules/ad-pro/ecrans/postes/poste-carte.tsx", "confirmation={e.decisif}", 1],
  ["src/components/workflow/workflow-panel.tsx", 'submit("APPROVE")', 1],
  ["src/components/workflow/workflow-panel.tsx", 'submit("REJECT")', 1],
  ["src/components/workflow/workflow-panel.tsx", 'submit("RETURN")', 1],
  ["src/components/workflow/workflow-panel.tsx", 'submit("SKIP")', 1],
  ["src/components/workflow/workflow-panel.tsx", "onClick={retirer}", 1],
  ["src/app/(app)/congress-international/congress-workflow.tsx", "finalDecision", 1],
  ["src/app/(app)/congress-international/congress-workflow.tsx", "submitProductAnalysis", 1],
  ["src/app/(app)/congress-international/congress-workflow.tsx", "updateGrantedBudget", 1],
  ["src/app/(app)/sponsoring/[id]/closure-panel.tsx", "cloturerSponsoring", 1],
  ["src/app/(app)/consulting/[id]/actions-panel.tsx", "decideConsultingContract", 3],
  ["src/app/(app)/consulting/[id]/actions-panel.tsx", "closeConsultingContract", 2],
  ["src/app/(app)/consulting/[id]/actions-panel.tsx", "prolongerConsultingContract", 1],
  ["src/app/(app)/ad-pro/autres/[id]/decision-panel.tsx", "closeAdProOtherRequest", 2],
  // Congés, formations, avances, intérim, recrutement, dossier RH, paie
  ["src/components/hr/leave-approvals.tsx", 'decide("APPROVED")', 1],
  ["src/components/hr/leave-approvals.tsx", 'decide("REJECTED")', 1],
  ["src/app/(app)/formations/training-board.tsx", "decideTraining", 2],
  ["src/app/(app)/rh/advance-approvals.tsx", "{label}", 1],
  ["src/components/hr/stand-in-panel.tsx", "decide(true)", 1],
  ["src/components/hr/stand-in-panel.tsx", "decide(false)", 1],
  ["src/app/(app)/recrutement/[id]/panels.tsx", "decideRecruitmentStep", 2],
  ["src/app/(app)/recrutement/[id]/panels.tsx", "renvoyerDemandeRecrutement", 2],
  ["src/app/(app)/recrutement/[id]/panels.tsx", "cancelRecruitmentRequest", 1],
  ["src/app/(app)/recrutement/[id]/panels.tsx", "openRecruitmentSourcing", 1],
  ["src/app/(app)/recrutement/[id]/panels.tsx", "closeRecruitmentRequest", 2],
  ["src/app/(app)/recrutement/[id]/panels.tsx", 'move("HIRE")', 1],
  ["src/app/(app)/recrutement/[id]/panels.tsx", "onboardRecruitment", 1],
  ["src/app/(app)/recrutement/[id]/panels.tsx", "annulerEmbaucheRecrutement", 1],
  ["src/app/(app)/rh/[id]/hr-dossier.tsx", "deleteEmployeeDocument", 1],
  ["src/app/(app)/rh/[id]/hr-dossier.tsx", "deleteHrRequest", 1],
  ["src/app/(app)/rh/[id]/hr-dossier.tsx", 'decide("APPROVE")', 1],
  ["src/app/(app)/rh/[id]/hr-dossier.tsx", 'decide("REJECT")', 1],
  ["src/app/(app)/rh/[id]/hr-dossier.tsx", 'decideLeave("APPROVE")', 1],
  ["src/app/(app)/rh/[id]/hr-dossier.tsx", 'decideLeave("REJECT")', 1],
  // La file « Demandes RH » (Direction, 07/10) : le panneau de traitement sous la ligne, et « ⋯ ».
  ["src/app/(app)/rh/demandes/file-demandes-rh.tsx", "onClick={supprimer}", 1],
  ["src/app/(app)/rh/demandes/file-demandes-rh.tsx", 'decider("APPROVE")', 1],
  ["src/app/(app)/rh/demandes/file-demandes-rh.tsx", 'decider("APPROVE_NEXT")', 1],
  ["src/app/(app)/rh/demandes/file-demandes-rh.tsx", "onClick={accorder}", 1],
  ["src/app/(app)/rh/demandes/file-demandes-rh.tsx", "onClick={refuser}", 1],
  ["src/app/(app)/rh/paie/payroll-matrix.tsx", "undo(cell.entryId!", 1],
  ["src/app/(app)/rh/paie/virements-paie.tsx", "Envoyer la paie au centre", 1],
  // Plan de tournée, visites
  ["src/app/(app)/medical/plan-de-tournee/planificateur.tsx", "Valider le plan", 1],
  ["src/app/(app)/medical/plan-de-tournee/planificateur.tsx", "Rejeter", 1],
  ["src/app/(app)/medical/plan-de-tournee/planificateur.tsx", "Rouvrir pour révision", 1],
  ["src/app/(app)/medical/ma-journee/emploi-du-temps.tsx", "la visite n’a pas eu lieu", 1],
  // Bons de commande, Legal, avoir, règlement
  ["src/app/(app)/bons-de-commande/file-bc.tsx", "signerBonDeCommande", 1],
  ["src/app/(app)/bons-de-commande/file-bc.tsx", "renvoyerBonDeCommande", 1],
  ["src/app/(app)/legal/[id]/bc-gate.tsx", 'agir("SIGNER")', 1],
  ["src/app/(app)/legal/[id]/bc-gate.tsx", 'agir("RENVOYER")', 1],
  ["src/app/(app)/legal/[id]/emettre-avoir.tsx", "Émettre l&apos;avoir", 1],
  ["src/app/(app)/legal/[id]/send-to-settlement.tsx", "au règlement", 1],
  ["src/app/(app)/finances/paiements-a-faire/orders-table.tsx", "Classer et régler", 1],
  ["src/app/(app)/finances/paiements-a-faire/orders-table.tsx", "className={classes}", 1],
  // Matériel promotionnel
  ["src/app/(app)/promo-material/[id]/circuit-card.tsx", "startPromoCircuit", 1],
  ["src/app/(app)/promo-material/[id]/circuit-card.tsx", "validatePromoStep", 1],
  ["src/app/(app)/promo-material/[id]/circuit-card.tsx", "Renvoyer au demandeur", 1],
  ["src/app/(app)/promo-material/[id]/circuit-card.tsx", "Confirmer le refus", 1],
  ["src/app/(app)/promo-material/[id]/promo-panels.tsx", "validateBc", 1],
  ["src/app/(app)/promo-material/[id]/promo-panels.tsx", "confirmBcSent", 1],
  ["src/app/(app)/promo-material/[id]/promo-panels.tsx", "recordInvoice", 1],
  ["src/app/(app)/promo-material/[id]/promo-panels.tsx", "settle(fd())", 1],
  ["src/app/(app)/promo-material/[id]/promo-panels.tsx", "cancelPromoMaterial", 1],
  ["src/app/(app)/promo-material/[id]/execution-card.tsx", "Annuler la facture", 1],
  ["src/app/(app)/promo-material/[id]/execution-card.tsx", "Demander le paiement", 1],
  ["src/app/(app)/promo-material/[id]/execution-card.tsx", "Supprimer le BC", 1],
  ["src/app/(app)/promo-material/[id]/execution-card.tsx", "Générer les bons de commande", 1],
  ["src/app/(app)/promo-material/[id]/quotes-card.tsx", "supprimerDevisPromo", 1],
  ["src/app/(app)/promo-material/[id]/quotes-card.tsx", "Valider ma sélection", 1],
  // Moyens généraux
  ["src/app/(app)/moyens-generaux/cash-panel.tsx", "confirmPettyCashReceipt", 1],
  ["src/app/(app)/moyens-generaux/cash-panel.tsx", "closePettyCash", 1],
  ["src/app/(app)/moyens-generaux/cash-panel.tsx", "decidePettyCashTopUp", 2],
  ["src/app/(app)/moyens-generaux/cash-panel.tsx", "annulerRallongeCaisse", 1],
  ["src/app/(app)/moyens-generaux/expense-row-actions.tsx", "remove()", 1],
  // Corbeille, suppression définitive
  ["src/app/(app)/admin/corbeille/trash-list.tsx", 'run(it, "destroy")', 1],
  ["src/app/(app)/admin/corbeille/trash-list.tsx", 'run(it, "restore")', 1],
  ["src/components/shared/super-admin-delete.tsx", "Oui, supprimer définitivement", 1],
  // Secrétariat
  // « Fin de la demande » s'appelle « Fin du traitement » (Direction, 10/2026 : deux gestes).
  ["src/app/(app)/demandes/[id]/request-actions.tsx", "Fin du traitement", 1],
  ["src/app/(app)/demandes/[id]/request-actions.tsx", "Annuler la demande", 1],
  ["src/app/(app)/demandes/[id]/request-actions.tsx", "Supprimer", 1],
  ["src/app/(app)/demandes/[id]/requester-window.tsx", "Supprimer", 1],
  ["src/app/(app)/demandes/[id]/requester-window.tsx", "Annuler la demande", 1],
  ["src/app/(app)/demandes/approval-buttons.tsx", 'trancher("APPROVED")', 1],
  ["src/app/(app)/demandes/approval-buttons.tsx", "trancher(ouvert)", 1],
  ["src/app/(app)/demandes/[id]/attachment-validation.tsx", "withdraw(current)", 1],
];

/** La source sans ses commentaires (un commentaire qui cite le composant ne pose aucun bouton). */
function sansCommentaires(src: string): string {
  // Seulement les commentaires qui OUVRENT une ligne : `accept="image/*"` ne doit pas avaler la suite.
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Chaque élément `<BoutonDecisif …>…</BoutonDecisif>` (ou auto-fermant) du fichier. */
function boutonsDecisifs(src: string): string[] {
  const out: string[] = [];
  const re = /<BoutonDecisif\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const fin = src.indexOf("</BoutonDecisif>", m.index);
    const auto = src.indexOf("/>", m.index);
    const ouvreFin = src.indexOf(">", m.index);
    out.push(auto !== -1 && auto < ouvreFin + 1 && (fin === -1 || auto < fin) ? src.slice(m.index, auto + 2) : src.slice(m.index, fin + 16));
  }
  return out;
}

describe("les boutons décisifs restent décisifs", () => {
  const fichiers = [...new Set(POINTS.map(([f]) => f))];

  it("la liste n'est pas vide — un parcours cassé ne rend pas ce banc vert", () => {
    expect(fichiers.length).toBeGreaterThanOrEqual(38);
    expect(POINTS.length).toBeGreaterThanOrEqual(97);
  });

  it.each(POINTS)("%s — « %s » (au moins %i) passe par BoutonDecisif", (fichier, aiguille, auMoins) => {
    const boutons = boutonsDecisifs(sansCommentaires(readFileSync(fichier, "utf8")));
    const n = boutons.filter((b) => b.includes(aiguille)).length;
    expect(n, `${fichier} : « ${aiguille} » doit être porté par un <BoutonDecisif> (${auMoins} au moins, ${n} trouvé)`).toBeGreaterThanOrEqual(auMoins);
  });

  it.each(fichiers)("%s — importe le composant partagé et n'a plus de fenêtre de confirmation", (fichier) => {
    const src = sansCommentaires(readFileSync(fichier, "utf8"));
    expect(src).toContain('import { BoutonDecisif } from "@/components/ui/bouton-decisif";');
    expect(src, `${fichier} : une seule mécanique de confirmation`).not.toMatch(/(^|[^\w.])(window\.)?confirm\(/);
  });

  it("« Payé » (règlement direct, Finances) passe par le petit bouton DÉCISIF, pas par le petit bouton nu", () => {
    const src = sansCommentaires(readFileSync("src/app/(app)/finances/paiements-a-faire/orders-table.tsx", "utf8"));
    expect(src).toContain('<MiniBtn tone="success" decisif><Banknote');
    expect(src).toMatch(/if \(decisif\) return <BoutonDecisif brut type="submit"/);
  });

  it("un seul composant : aucune copie du mécanisme ailleurs", () => {
    const regle = readFileSync("src/components/ui/bouton-decisif.tsx", "utf8");
    expect(regle).toContain("export const BoutonDecisif");
    for (const f of fichiers) {
      expect(readFileSync(f, "utf8"), `${f} ne redéfinit pas le bouton`).not.toMatch(/function BoutonDecisif|const BoutonDecisif\s*=/);
    }
  });
});

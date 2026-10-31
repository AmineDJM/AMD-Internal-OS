import type { DeclarationAnnulation } from "../declarations";

/**
 * K10b — COMMUNICATIONS, EFFETS SORTANTS ET SUPPRESSIONS (décision 0038). Chaque ligne a son test d'exécution puis
 * d'annulation contre la base (`src/lib/effets/declarations/communications.test.ts`).
 */
const J = (raison: string): DeclarationAnnulation => ({ annulation: "retour", mecanisme: "journal", raison });

/** LE CARNET DE COURRIERS — des écritures en base seulement (le fichier « courrier » n'envoie rien) : le journal J7. */
const COURRIER = J("geste réversible (journal des effets) : le pli, la pièce, le partenaire ou le dossier créé est retiré, une valeur modifiée remise — sauf ce qu'un autre a changé depuis, dit et jamais écrasé ; l'annulation se rétablit");

export const DECLARATIONS_COMMUNICATIONS: Readonly<Record<string, DeclarationAnnulation>> = {
  "mail-register-actions:createMailEntry": COURRIER,
  "mail-register-actions:editMailEntry": COURRIER,
  "mail-register-actions:setMailDate": COURRIER,
  "mail-register-actions:attachDriveNodeToMail": COURRIER,
  "mail-piece-actions:addMailPiece": COURRIER,
  "mail-piece-actions:updateMailPiece": COURRIER,
  "mail-partner-actions:createMailPartner": COURRIER,
  "mail-partner-actions:updateMailPartner": COURRIER,
  "mail-folder-actions:createMailFolder": COURRIER,
  "mail-folder-actions:updateMailFolder": COURRIER,
  "mail-folder-actions:moveMailEntries": COURRIER,
};

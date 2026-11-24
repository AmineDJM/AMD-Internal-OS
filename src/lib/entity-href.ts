/**
 * OÙ S'OUVRE UN OBJET — la table des routes, une fois, pour tout le monde.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * Le centre de paiement autorise désormais TOUS les décaissements, quelle que soit leur origine :
 * demande de paiement, demande administrative, avance sur salaire, matériel promotionnel, dossier
 * réglementaire, information médicale, congrès… Mais un seul de ces cas savait s'ouvrir. L'écran
 * disait, en commentaire, que « les autres viennent d'un circuit qui porte ses pièces ailleurs,
 * et un lien mort vaut moins qu'aucun lien » — c'était vrai tant que le centre ne voyait que les
 * demandes de paiement. Ça a cessé de l'être le jour où il est devenu le guichet unique.
 *
 * Résultat : on autorisait des sorties d'argent sans pouvoir ouvrir ce qui les justifie. C'est
 * exactement ce que le centre existe pour empêcher.
 *
 * ── POURQUOI UNE TABLE, ET NON UN `switch` PAR ÉCRAN ────────────────────────────────────────
 *
 * Chaque écran qui affiche un objet d'un autre module refait ce calcul, et chacun en oublie la
 * moitié — c'est ce qui vient de se produire. La table vit ici, une fois ; ce qu'elle ne sait pas
 * ouvrir rend `null`, et l'appelant DIT alors pourquoi il n'y a pas de lien, au lieu d'afficher
 * un lien mort.
 *
 * Module PUR — testé, sans base ni session. Il ne décide RIEN sur les droits : c'est une carte
 * des routes. La page d'arrivée garde sa propre garde, et c'est elle qui fait foi.
 */

/** La route d'un objet, ou `null` quand il n'a pas d'écran propre. */
export function entityHref(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null;
  switch (type) {
    // ── Les circuits d'argent ──
    case "PAYMENT_REQUEST": return `/validations/paiements/${id}`;
    case "ADMIN_REQUEST": return `/demandes/${id}`;
    case "EXPENSE_ORDER": return "/finances/paiements-a-faire";
    // Une facture EST un document légal de nature « facture » : elle a sa fiche, comme le
    // contrat et le bon de commande dont elle découle.
    case "INVOICE": return `/legal/${id}`;
    // Une avance sur salaire se lit sur la fiche de l'employé, pas sur un écran à elle.
    case "SALARY_ADVANCE": return "/rh/paie"; // les avances se tranchent à côté de la paie (06/10)
    // LE VIREMENT DE LA PAIE D'UNE ENTITÉ (§118.176) se lit sur la paie : la carte de son entité y
    // dit ce qui est saisi, envoyé, viré. Le centre qui l'autorise doit pouvoir l'ouvrir.
    case "PAYROLL": return "/rh/paie";
    // UNE ÉCHÉANCE DE CHARGE FIXE (24/11/2026) : la section « Locaux & charges fixes » d'Informations de la société.
    case "FIXED_CHARGE": return "/legal/identites#charges-fixes";
    // UNE ÉCHÉANCE D'IMPÔT OU DE COTISATION (24/11/2026) : la ligne s'ouvre dans Finances › Impôts & cotisations.
    case "TAX_PAYMENT": return `/finances/impots-cotisations?ligne=${id}`;

    // ── Les circuits métier ──
    case "REGULATORY_PRODUCT": return `/regulatory/${id}`;
    case "SPONSORING": return `/sponsoring/${id}`;
    case "CONGRESS_INTERNATIONAL": return `/congress-international/${id}`;
    case "CONGRESS_NATIONAL": return `/congress-national/${id}`;
    case "EVENT": return `/events/${id}`;
    case "MEDICAL_INFO_DECLARATION": return `/information-medicale/${id}`;
    case "PROMO_MATERIAL": return `/promo-material/${id}`;
    // Un POSTE de dépense n'a pas d'écran à lui : il se lit sur la fiche de la demande qui le
    // porte (sponsoring, congrès, événement), et cette table est pure — elle ne peut pas aller
    // chercher le parent. `/ad-pro/<id>` n'a JAMAIS existé : chaque clic finissait en 404.
    // La liste du module est l'adresse honnête, comme `/finances/paiements-a-faire` pour un ordre.
    case "AD_PRO_ITEM": return "/ad-pro";
    case "CONSULTING_CONTRACT": return `/consulting/${id}`;
    // LA SEPTIÈME NATURE DU PÔLE Ad & Pro, et son écran EXISTE depuis qu'elle existe
    // (`src/app/(app)/ad-pro/autres/[id]/page.tsx`). Elle n'avait AUCUN cas ici : tout lien vers
    // une « autre demande » rendait `null`, et l'écran affichait la phrase des objets sans
    // adresse — un « je ne peux pas » écrit dans le CODE, sur une fiche qu'un clic ouvre
    // (§118.63). Trouvé en montant le fil de discussion sur les sept natures.
    case "AD_PRO_OTHER": return `/ad-pro/autres/${id}`;
    case "RECRUITMENT_REQUEST": return `/recrutement/${id}`;
    case "TRAINING": return `/formations?formation=${encodeURIComponent(id)}`;

    // ── Les registres ──
    // Un courrier s'ouvre dans le panneau du registre (`lienCourrier`, `chemins/courriers.ts`).
    case "MAIL_ENTRY": return `/courriers?courrier=${encodeURIComponent(id)}`;
    case "LEGAL_DOCUMENT": return `/legal/${id}`;
    case "PCH_TENDER": return `/pch/${id}`;
    case "VALIDATION_REQUEST": return `/validations/${id}`;
    case "DOSSIER": return `/dossiers/${id}`;
    case "TASK": return `/mon-espace/taches/${id}`;
    case "SUPPORT_REQUEST": return `/support/${id}`;
    case "DRIVE_NODE": return `/drive?node=${id}`;

    // ── Les personnes ──
    case "EMPLOYEE": return `/rh/${id}`;

    default: return null;
  }
}

/**
 * CE QU'ON DIT QUAND IL N'Y A PAS DE LIEN.
 *
 * Un écran muet laisse croire à une panne — on clique, rien ne se passe, on recommence. Nommer
 * le type d'objet et dire qu'il n'a pas de fiche propre coûte une phrase et évite le doute.
 */
export function noHrefReason(type: string | null | undefined, label?: string | null): string {
  const quoi = label || (type ? type.toLowerCase().replace(/_/g, " ") : "cet objet");
  return `Aucune fiche à ouvrir pour ${quoi} — cette dépense n'a pas d'écran propre.`;
}

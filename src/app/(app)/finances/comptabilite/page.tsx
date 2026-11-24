import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { chargerComptabilite, chargerTresorerie, SANS_SOCIETE } from "@/modules/finances/api";
import { ComposerPieceButton } from "@/components/pieces/composer-piece";
import { compositionDesPieces, TYPES_COMPOSES_EN_COMPTABILITE } from "@/lib/queries/composition-pieces";
import { EcranComptabilite } from "./ecran-comptabilite";

export const dynamic = "force-dynamic";
export const metadata = { title: "Comptabilité — AMD Internal OS" };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * FINANCES › COMPTABILITÉ — la maquette validée par le Super Admin (24/11/2026).
 *
 * Trois onglets (Dépenses, Recettes, Résultat), une ligne par écriture, une seule recherche (écritures ET factures du
 * registre Legal), un panneau par écriture ou facture. Tout l'état vit dans l'ADRESSE (`societe`, `vue`, `periode`, `q`,
 * `ecriture`, `facture`, `compte`, `sans`) : un lien le partage, un rechargement le garde, et chaque lecture se fait au
 * serveur, dans la société choisie parmi les siennes (`chargerComptabilite`).
 *
 * Rien n'a été perdu en simplifiant : l'encaissement, l'import du relevé (avec son aperçu ligne à ligne), les contrôles
 * du livre et les comptes de trésorerie sont rangés sous « ⋯ » ; « Modifier » et la suppression vivent dans le panneau ;
 * le résultat mensuel est l'onglet « Résultat ».
 *
 * « COMPOSER UNE FACTURE » DÉMÉNAGE ICI (décision du Super Admin, 24/11/2026) : le MÊME bouton, la même fabrique, le même
 * format société / papier en-tête / Word + PDF, dans l'onglet Recettes. La facture émise s'enregistre toujours au
 * registre Legal (nature INVOICE) et dans le Drive ; Legal ne propose plus que les bons de commande et les devis.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function ComptabilitePage(props: {
  searchParams?: Promise<{ societe?: string; vue?: string; periode?: string; q?: string; ecriture?: string; facture?: string; compte?: string; sans?: string }>;
}) {
  const searchParams = (await props.searchParams) ?? {};
  // « Comptabilité » a sa clé (24/11/2026), réglée dans la console indépendamment de la banque et des doublons.
  const user = await requireModule("FINANCES_COMPTABILITE");
  const droits = {
    creer: userCan(user, "FINANCES_COMPTABILITE", "CREATE"),
    modifier: userCan(user, "FINANCES_COMPTABILITE", "UPDATE"),
    supprimer: userCan(user, "FINANCES_COMPTABILITE", "DELETE"),
    // Créer la demande de paiement d'une facture : le droit des demandes de paiement, rejoué par `createPaymentRequest`.
    demanderPaiement: userCan(user, "VALIDATIONS", "CREATE"),
  };
  const [donnees, composition, tresorerie] = await Promise.all([
    chargerComptabilite(user, searchParams),
    compositionDesPieces(user, TYPES_COMPOSES_EN_COMPTABILITE),
    // Les comptes de trésorerie ancrés (§118.176) — leur gestion reste à portée, sous « ⋯ ».
    chargerTresorerie(user.id),
  ]);

  // LE MÊME COMPOSITEUR QUE LEGAL, réduit à la facture — affiché seulement à qui a le droit de l'émettre (la règle de la
  // fabrique, `legalWriteAllowed`, rejouée par le serveur à l'émission). La société de l'écran est proposée d'abord.
  const composer = composition && composition.types.includes("FACTURE") ? (
    <ComposerPieceButton
      typeInitial="FACTURE"
      typesAutorises={["FACTURE"]}
      societes={composition.societes}
      societeParDefaut={composition.societes.some((s) => s.id === donnees.societeId) ? donnees.societeId : composition.societeParDefaut}
      letterheads={composition.letterheads}
      peutReglerNumerotation={composition.peutReglerNumerotation}
      amont={composition.amont}
    />
  ) : null;

  return (
    <EcranComptabilite
      d={donnees}
      droits={droits}
      composer={composer}
      comptesTresorerie={tresorerie.comptes}
      entites={donnees.societes.filter((s) => s.id !== SANS_SOCIETE).map((s) => ({ value: s.id, label: s.label }))}
    />
  );
}
